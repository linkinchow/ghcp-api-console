import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { nowIso, parseAuthorizationBinding, type AuthorizationBinding } from '@ghcp/shared';
import { AccountScopeError, type AuthorizationAttempt, type AuthorizationResult, type VerifiedGithubSubject } from './storageTypes.js';
import { assertSameBinding, assertSubject, bindingValues, INSERT_ATTEMPT, mapAttempt, resultFingerprint, safeFailureReason, terminalResult, type AttemptRow } from './authorizationLedger.js';

type Connection = Pick<PoolConnection, 'execute'>;
export async function getMysqlAttempt(db: Connection, enterpriseId: string, identity: string, attemptId: string, lock=false): Promise<AuthorizationAttempt | undefined> {
  const [rows] = await db.execute<Array<RowDataPacket & AttemptRow>>(`SELECT * FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? AND oauth_attempt_id=?${lock?' FOR UPDATE':''}`,
    [enterpriseId,identity,attemptId]);
  return rows[0] && mapAttempt(rows[0]);
}
async function lockAccount(db: Connection, b: AuthorizationBinding): Promise<{copilot_oauth_attempt_id:string|null}> {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT account_incarnation,gh_login,copilot_oauth_attempt_id FROM proxy_accounts WHERE enterprise_id=? AND identity=? FOR UPDATE`,[b.enterpriseId,b.identity]);
  const row=rows[0];
  if (!row || row.account_incarnation!==b.accountIncarnation || row.gh_login!==b.expectedGhLogin) throw new AccountScopeError('stale_authorization_binding');
  return row as {copilot_oauth_attempt_id:string|null};
}
export async function beginMysqlAttempt(db: Connection,value: AuthorizationBinding): Promise<AuthorizationAttempt> {
  const b=parseAuthorizationBinding(value), account=await lockAccount(db,b);
  const [existing]=await db.execute<Array<RowDataPacket & AttemptRow>>('SELECT * FROM proxy_authorization_attempts WHERE oauth_attempt_id=? FOR UPDATE',[b.oauthAttemptId]);
  if (existing[0]) {
    const attempt=mapAttempt(existing[0]);assertSameBinding(attempt,b);
    if (attempt.status!=='active' || account.copilot_oauth_attempt_id!==b.oauthAttemptId) throw new AccountScopeError('authorization_outcome_conflict');
    return attempt;
  }
  const now=nowIso().slice(0,23).replace('T',' ');
  await db.execute(`UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='superseded',updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND status='active'`,[now,b.enterpriseId,b.identity,b.accountIncarnation]);
  await db.execute(INSERT_ATTEMPT,[...bindingValues(b),now,now]);
  await db.execute(`UPDATE proxy_accounts SET copilot_oauth_status='refreshing',copilot_oauth_attempt_id=?,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=?`,[b.oauthAttemptId,now,b.enterpriseId,b.identity,b.accountIncarnation]);
  return {binding:b,status:'active'};
}
export async function finishMysqlAttempt(db: Connection,value: AuthorizationBinding,status: AuthorizationResult['status'],token?: string,subject?: VerifiedGithubSubject,reason?: string): Promise<AuthorizationResult> {
  const b=parseAuthorizationBinding(value);
  if (status==='succeeded') { if (!token || !subject) throw new AccountScopeError('invalid_oauth_token'); assertSubject(b,subject); }
  const safeReason=status==='failed'?safeFailureReason(reason):status==='cancelled'?'authorization_cancelled':null;
  const fingerprint=resultFingerprint(b,status,status==='succeeded'?[token,subject]:safeReason);
  const account=await lockAccount(db,b),attempt=await getMysqlAttempt(db,b.enterpriseId,b.identity,b.oauthAttemptId,true);
  assertSameBinding(attempt,b);
  const retry=terminalResult(attempt,b,status,fingerprint);if (retry) return retry;
  if (account.copilot_oauth_attempt_id!==b.oauthAttemptId) throw new AccountScopeError('stale_authorization_binding');
  const now=nowIso().slice(0,23).replace('T',' ');
  const [changed]=status==='succeeded'
    ? await db.execute<ResultSetHeader>(`UPDATE proxy_accounts SET copilot_oauth_token=?,copilot_oauth_status='valid',copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?`,[token!,now,now,b.enterpriseId,b.identity,b.accountIncarnation,b.oauthAttemptId])
    : await db.execute<ResultSetHeader>(`UPDATE proxy_accounts SET copilot_oauth_status='failed',copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?`,[now,b.enterpriseId,b.identity,b.accountIncarnation,b.oauthAttemptId]);
  if (changed.affectedRows!==1) throw new AccountScopeError('stale_authorization_binding');
  const [consumed]=await db.execute<ResultSetHeader>(`UPDATE proxy_authorization_attempts SET status=?,result_fingerprint=?,result_gh_login=?,result_github_user_id=?,failure_reason=?,updated_at=? WHERE oauth_attempt_id=? AND status='active'`,[status,fingerprint,subject?.login??null,subject?.id??null,safeReason,now,b.oauthAttemptId]);
  if (consumed.affectedRows!==1) throw new AccountScopeError('stale_authorization_binding');
  return {binding:b,status,outcome:'applied'};
}
