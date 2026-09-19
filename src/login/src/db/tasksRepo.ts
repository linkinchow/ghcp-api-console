import type { AuthorizationBinding, AuthorizationOutcome, CreateLoginTaskV2, LoginTaskDto, LoginTaskStatus, PageResponse, SsoType } from '@ghcp/shared';
import { bindingKey, EnterpriseContractError, newTaskId, nowIso, pageResponse, parseAuthorizationBinding } from '@ghcp/shared';
import { getDb, getEnterpriseProfile } from './connection.js';
import { bindingFromInput, requireEnterpriseInput } from '../enterprise.js';

export type CloseAction = 'success' | 'fail' | 'cancel' | 'reconcile';
export interface LoginTaskRecord extends Omit<LoginTaskDto, 'enterpriseRevision'> {
  enterpriseId: string;
  enterpriseRevision?: number;
  bindingVersion: 1 | 2;
  accountIncarnation?: string;
  expectedGhLogin?: string;
  expectedGithubUserId?: string;
  authorityCloseState?: 'pending' | 'uncertain' | 'confirmed';
  authorityCloseAction?: CloseAction;
  ssoType: SsoType;
}
interface TaskRow {
  enterprise_id: string; enterprise_revision: number | null; binding_version: 1 | 2;
  account_incarnation: string | null; expected_gh_login: string | null; expected_github_user_id: string | null;
  id: string; identity: string; sso_user: string; gh_login: string | null; oauth_attempt_id: string | null;
  sso_type: SsoType; status: LoginTaskStatus; attempts: number; failure_reason: string | null;
  log_path: string | null; created_at: string; started_at: string | null; finished_at: string | null;
  authority_close_state: LoginTaskRecord['authorityCloseState'] | null;
  authority_close_action: CloseAction | null;
}
interface LedgerRow {
  enterprise_id: string; enterprise_revision: number; identity: string; account_incarnation: string;
  expected_gh_login: string; expected_github_user_id: string | null; oauth_attempt_id: string; task_id: string;
}
export const isTerminalTask = (task: LoginTaskRecord): boolean => ['success', 'failed', 'cancelled'].includes(task.status);

/** Called only after Proxy authority check. Ledger and task commit atomically; ledger outlives task deletion. */
export function createTask(input: CreateLoginTaskV2, authorityActive = true): { task: LoginTaskRecord; created: boolean } {
  requireEnterpriseInput(input);
  const binding = bindingFromInput(input);
  const db = getDb();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM login_legacy_nonce_tombstones WHERE oauth_attempt_id=?').get(binding.oauthAttemptId)
      || db.prepare('SELECT 1 FROM login_tasks WHERE binding_version=1 AND oauth_attempt_id=?').get(binding.oauthAttemptId)) {
      throw new EnterpriseContractError('authorization_nonce_consumed');
    }
    const old = db.prepare('SELECT * FROM login_nonce_ledger WHERE oauth_attempt_id = ?').get(binding.oauthAttemptId) as LedgerRow | undefined;
    if (old) {
      const original: AuthorizationBinding = {
        enterpriseId: old.enterprise_id, enterpriseRevision: old.enterprise_revision, identity: old.identity,
        accountIncarnation: old.account_incarnation, oauthAttemptId: old.oauth_attempt_id,
        expectedGhLogin: old.expected_gh_login, ...(old.expected_github_user_id ? { expectedGithubUserId: old.expected_github_user_id } : {}),
      };
      if (bindingKey(original) !== bindingKey(binding)) throw new EnterpriseContractError('authorization_nonce_conflict');
      const task = getTask(binding.enterpriseId, old.task_id);
      if (!task) throw new EnterpriseContractError('authorization_nonce_consumed');
      if (task.ssoUser !== input.ssoUser || task.ssoType !== input.ssoType) throw new EnterpriseContractError('authorization_nonce_conflict');
      return { task, created: false };
    }
    if (!authorityActive) throw new EnterpriseContractError('authorization_attempt_not_active');
    const id = newTaskId(), now = nowIso();
    db.prepare(`INSERT INTO login_nonce_ledger (enterprise_id,oauth_attempt_id,enterprise_revision,identity,
      account_incarnation,expected_gh_login,expected_github_user_id,task_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(binding.enterpriseId,binding.oauthAttemptId,binding.enterpriseRevision,binding.identity,binding.accountIncarnation,
        binding.expectedGhLogin,binding.expectedGithubUserId ?? null,id,now);
    db.prepare(`INSERT INTO login_tasks (enterprise_id,enterprise_revision,binding_version,account_incarnation,
      expected_gh_login,expected_github_user_id,id,identity,sso_user,gh_login,oauth_attempt_id,sso_type,status,attempts,created_at)
      VALUES (?,?,2,?,?,?,?,?,?,?,?,?,'pending',0,?)`).run(binding.enterpriseId,binding.enterpriseRevision,binding.accountIncarnation,
        binding.expectedGhLogin,binding.expectedGithubUserId ?? null,id,binding.identity,input.ssoUser,binding.expectedGhLogin,
        binding.oauthAttemptId,input.ssoType,now);
    return { task: getTask(binding.enterpriseId,id)!, created: true };
  }).immediate();
}

export function taskBinding(task: LoginTaskRecord): AuthorizationBinding {
  if (task.bindingVersion !== 2) throw new EnterpriseContractError('legacy_task_history_only');
  return parseAuthorizationBinding({ enterpriseId:task.enterpriseId,enterpriseRevision:task.enterpriseRevision,
    identity:task.identity,accountIncarnation:task.accountIncarnation,oauthAttemptId:task.oauthAttemptId,
    expectedGhLogin:task.expectedGhLogin,...(task.expectedGithubUserId ? {expectedGithubUserId:task.expectedGithubUserId} : {}) });
}

export function getTask(enterpriseId: string, id: string): LoginTaskRecord | undefined {
  getEnterpriseProfile(enterpriseId);
  const row = getDb().prepare('SELECT * FROM login_tasks WHERE enterprise_id = ? AND id = ?').get(enterpriseId,id) as TaskRow | undefined;
  return row ? mapRow(row) : undefined;
}
export function listTasks(enterpriseId: string, limit = 100): LoginTaskRecord[] {
  getEnterpriseProfile(enterpriseId);
  return (getDb().prepare('SELECT * FROM login_tasks WHERE enterprise_id = ? ORDER BY created_at DESC,id DESC LIMIT ?')
    .all(enterpriseId,Math.max(1,Math.min(Math.trunc(limit),100))) as TaskRow[]).map(mapRow);
}
export function listTasksPage(enterpriseId: string, query: { q?: string; status?: LoginTaskStatus; page?: number; pageSize?: number } = {}): PageResponse<LoginTaskRecord> {
  getEnterpriseProfile(enterpriseId);
  const pageSize = Math.max(1,Math.min(Math.trunc(query.pageSize ?? 25),100));
  const requestedPage = Math.max(1,Math.trunc(query.page ?? 1));
  const where = ['enterprise_id = ?'], args: unknown[] = [enterpriseId];
  if (query.q?.trim()) {
    where.push('(id LIKE ? OR identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?)');
    args.push(...Array.from({length:4},() => `%${query.q!.trim()}%`));
  }
  if (query.status) { where.push('status = ?'); args.push(query.status); }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM login_tasks ${whereSql}`).get(...args) as {count:number}).count;
  const page = Math.min(requestedPage,Math.max(1,Math.ceil(total / pageSize)));
  const rows = getDb().prepare(`SELECT * FROM login_tasks ${whereSql} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
    .all(...args,pageSize,(page-1)*pageSize) as TaskRow[];
  return pageResponse(rows.map(mapRow),total,page,pageSize);
}

/** Only the queue can claim a never-run pending task; terminal or callback tasks never reopen. */
export function claimTask(enterpriseId: string, id: string): LoginTaskRecord | undefined {
  const changed = getDb().prepare(`UPDATE login_tasks SET status='running',attempts=attempts+1,started_at=?
    WHERE enterprise_id=? AND id=? AND binding_version=2 AND status='pending' AND attempts=0`).run(nowIso(),enterpriseId,id);
  return changed.changes === 1 ? getTask(enterpriseId,id) : undefined;
}
export function setTaskLogPath(enterpriseId: string,id: string,logPath: string): void {
  getDb().prepare("UPDATE login_tasks SET log_path=? WHERE enterprise_id=? AND id=? AND status='running' AND binding_version=2")
    .run(logPath,enterpriseId,id);
}
export function markCallbackPending(enterpriseId: string,id: string,action: 'success' | 'fail', reason?: string): boolean {
  return getDb().prepare(`UPDATE login_tasks SET status='callback_pending',authority_close_state='pending',
    authority_close_action=?,failure_reason=? WHERE enterprise_id=? AND id=? AND binding_version=2 AND status='running'`)
    .run(action,reason ?? null,enterpriseId,id).changes === 1;
}
export function requestCancellation(enterpriseId: string,id: string): LoginTaskRecord | undefined {
  const task = getTask(enterpriseId,id);
  if (!task) return undefined;
  if (task.bindingVersion !== 2) throw new EnterpriseContractError('legacy_task_history_only');
  getDb().prepare(`UPDATE login_tasks SET status='cancel_requested',authority_close_state='pending',authority_close_action='cancel'
    WHERE enterprise_id=? AND id=? AND binding_version=2 AND status IN ('pending','running','callback_pending','uncertain')`)
    .run(enterpriseId,id);
  return getTask(enterpriseId,id);
}
export function markAuthorityUncertain(enterpriseId: string,id: string): void {
  getDb().prepare(`UPDATE login_tasks SET status='uncertain',authority_close_state='uncertain'
    WHERE enterprise_id=? AND id=? AND binding_version=2 AND status IN ('callback_pending','cancel_requested','uncertain')`)
    .run(enterpriseId,id);
}
/** A terminal state is immutable. In particular an acknowledged cancel cannot be overwritten by late success. */
export function resolveAuthority(enterpriseId: string,id: string,status: AuthorizationOutcome): LoginTaskRecord | undefined {
  if (status === 'active') return getTask(enterpriseId,id);
  const final = status === 'succeeded' ? 'success' : status;
  getDb().prepare(`UPDATE login_tasks SET status=?,authority_close_state='confirmed',finished_at=?,
    failure_reason=CASE WHEN ?='success' THEN NULL ELSE failure_reason END
    WHERE enterprise_id=? AND id=? AND binding_version=2 AND status IN ('callback_pending','cancel_requested','uncertain')`)
    .run(final,nowIso(),final,enterpriseId,id);
  return getTask(enterpriseId,id);
}
export function deleteTask(enterpriseId: string,id: string): 'deleted' | 'not_found' | 'not_allowed' {
  const task = getTask(enterpriseId,id);
  if (!task) return 'not_found';
  if (!isTerminalTask(task)) return 'not_allowed';
  return getDb().transaction(() => {
    if (task.bindingVersion === 1 && task.oauthAttemptId) {
      getDb().prepare('INSERT OR IGNORE INTO login_legacy_nonce_tombstones(oauth_attempt_id,task_id,enterprise_id) VALUES (?,?,?)')
        .run(task.oauthAttemptId,task.id,enterpriseId);
    }
    const result = getDb().prepare("DELETE FROM login_tasks WHERE enterprise_id=? AND id=? AND status IN ('success','failed','cancelled')").run(enterpriseId,id);
    return result.changes === 1 ? 'deleted' : 'not_allowed';
  }).immediate();
}
export function recoverInterruptedTasks(): number {
  // Passwords/tokens are intentionally absent on disk. Preserve the closure intent, never dispatch browsers on startup.
  return getDb().prepare(`UPDATE login_tasks SET status='uncertain',authority_close_state='uncertain',
    authority_close_action=COALESCE(authority_close_action,'cancel'),failure_reason=COALESCE(failure_reason,'login_service_restarted')
    WHERE binding_version=2 AND status IN ('pending','running','callback_pending','cancel_requested')`).run().changes;
}
export function listUncertainTasks(limit = 20): LoginTaskRecord[] {
  return (getDb().prepare(`SELECT * FROM login_tasks WHERE binding_version=2 AND status='uncertain'
    ORDER BY created_at,id LIMIT ?`).all(Math.max(1,Math.min(Math.trunc(limit),100))) as TaskRow[]).map(mapRow);
}
function mapRow(row: TaskRow): LoginTaskRecord {
  return {
    enterpriseId:row.enterprise_id,enterpriseRevision:row.enterprise_revision ?? undefined,bindingVersion:row.binding_version,
    accountIncarnation:row.account_incarnation ?? undefined,expectedGhLogin:row.expected_gh_login ?? undefined,
    expectedGithubUserId:row.expected_github_user_id ?? undefined,id:row.id,identity:row.identity,ssoUser:row.sso_user,
    ghLogin:row.gh_login ?? undefined,oauthAttemptId:row.oauth_attempt_id ?? undefined,ssoType:row.sso_type,
    status:row.status,attempts:row.attempts,failureReason:row.failure_reason ?? undefined,logPath:row.log_path ?? undefined,
    createdAt:row.created_at,startedAt:row.started_at ?? undefined,finishedAt:row.finished_at ?? undefined,
    authorityCloseState:row.authority_close_state ?? undefined,authorityCloseAction:row.authority_close_action ?? undefined,
  };
}
