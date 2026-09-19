import type Database from 'better-sqlite3';
import { nowIso, parseAuthorizationBinding, type AuthorizationBinding } from '@ghcp/shared';
import { AccountScopeError, type AuthorizationAttempt, type AuthorizationResult, type VerifiedGithubSubject } from './storageTypes.js';
import { assertSameBinding, assertSubject, bindingValues, INSERT_ATTEMPT, mapAttempt, resultFingerprint, safeFailureReason, terminalResult, type AttemptRow } from './authorizationLedger.js';

export function getSqliteAttempt(db: Database.Database, enterpriseId: string, identity: string, attemptId: string): AuthorizationAttempt | undefined {
  const row = db.prepare(`SELECT * FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? AND oauth_attempt_id=?`)
    .get(enterpriseId, identity, attemptId) as AttemptRow | undefined;
  return row && mapAttempt(row);
}
function assertAccount(db: Database.Database, b: AuthorizationBinding, active: boolean): void {
  const row = db.prepare(`SELECT account_incarnation,gh_login,copilot_oauth_attempt_id FROM proxy_accounts WHERE enterprise_id=? AND identity=?`)
    .get(b.enterpriseId,b.identity) as { account_incarnation: string; gh_login: string | null; copilot_oauth_attempt_id: string | null } | undefined;
  if (!row || row.account_incarnation !== b.accountIncarnation || row.gh_login !== b.expectedGhLogin
    || active && row.copilot_oauth_attempt_id !== b.oauthAttemptId) throw new AccountScopeError('stale_authorization_binding');
}
export function beginSqliteAttempt(db: Database.Database, value: AuthorizationBinding): AuthorizationAttempt {
  const b = parseAuthorizationBinding(value);
  return db.transaction(() => {
    assertAccount(db,b,false);
    const existing = db.prepare('SELECT * FROM proxy_authorization_attempts WHERE oauth_attempt_id=?').get(b.oauthAttemptId) as AttemptRow | undefined;
    if (existing) {
      const attempt = mapAttempt(existing); assertSameBinding(attempt,b);
      if (attempt.status !== 'active') throw new AccountScopeError('authorization_outcome_conflict');
      assertAccount(db,b,true); return attempt;
    }
    const now = nowIso();
    db.prepare(`UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='superseded',updated_at=?
      WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND status='active'`).run(now,b.enterpriseId,b.identity,b.accountIncarnation);
    db.prepare(INSERT_ATTEMPT).run(...bindingValues(b),now,now);
    db.prepare(`UPDATE proxy_accounts SET copilot_oauth_status='refreshing',copilot_oauth_attempt_id=?,updated_at=?
      WHERE enterprise_id=? AND identity=? AND account_incarnation=?`).run(b.oauthAttemptId,now,b.enterpriseId,b.identity,b.accountIncarnation);
    return { binding:b, status:'active' as const };
  }).immediate();
}
export function finishSqliteAttempt(db: Database.Database, value: AuthorizationBinding,
  status: AuthorizationResult['status'], token?: string, subject?: VerifiedGithubSubject, reason?: string): AuthorizationResult {
  const b = parseAuthorizationBinding(value);
  if (status === 'succeeded') {
    if (!token || !subject) throw new AccountScopeError('invalid_oauth_token');
    assertSubject(b,subject);
  }
  const safeReason = status === 'failed' ? safeFailureReason(reason) : status === 'cancelled' ? 'authorization_cancelled' : null;
  const fingerprint = resultFingerprint(b,status,status === 'succeeded' ? [token,subject] : safeReason);
  return db.transaction(() => {
    const attempt = getSqliteAttempt(db,b.enterpriseId,b.identity,b.oauthAttemptId);
    assertSameBinding(attempt,b);
    // A terminal response is not an authorization to resurrect a deleted incarnation.
    assertAccount(db,b,attempt.status === 'active');
    const retry = terminalResult(attempt,b,status,fingerprint);
    if (retry) return retry;
    const now = nowIso();
    const changed = status === 'succeeded'
      ? db.prepare(`UPDATE proxy_accounts SET copilot_oauth_token=?,copilot_oauth_status='valid',copilot_oauth_updated_at=?,
          copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?`)
        .run(token,now,now,b.enterpriseId,b.identity,b.accountIncarnation,b.oauthAttemptId).changes
      : db.prepare(`UPDATE proxy_accounts SET copilot_oauth_status='failed',copilot_oauth_attempt_id=NULL,updated_at=?
          WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?`)
        .run(now,b.enterpriseId,b.identity,b.accountIncarnation,b.oauthAttemptId).changes;
    if (changed !== 1) throw new AccountScopeError('stale_authorization_binding');
    const consumed = db.prepare(`UPDATE proxy_authorization_attempts SET status=?,result_fingerprint=?,result_gh_login=?,result_github_user_id=?,
      failure_reason=?,updated_at=? WHERE oauth_attempt_id=? AND status='active'`)
      .run(status,fingerprint,subject?.login ?? null,subject?.id ?? null,safeReason,now,b.oauthAttemptId).changes;
    if (consumed !== 1) throw new AccountScopeError('stale_authorization_binding');
    return {binding:b,status,outcome:'applied' as const};
  }).immediate();
}
