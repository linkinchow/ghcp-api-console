import type {
  EnterpriseId,
  LoginAttemptDto,
  LoginTaskDto,
  LoginTaskStatus,
  ManagementQuery,
  ManagementSummary,
  PageResponse,
  SsoType,
} from '@ghcp/shared';
import { HttpApiError, LIKE_ESCAPE_CLAUSE, likeContains, newTaskId, nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';

/** A task always belongs to one enterprise; every lookup and change below is filtered by it (design §5.1). */
export interface LoginTaskRecord extends LoginTaskDto {
  enterpriseId: EnterpriseId;
  ssoType: SsoType;
}

export interface CreateTaskInput {
  identity: string;
  ssoUser: string;
  ghLogin: string;
  oauthAttemptId: string;
  ssoType: SsoType;
}

type FinishedStatus = 'success' | 'failed' | 'cancelled';

interface TaskRow {
  id: string;
  enterprise_id: EnterpriseId;
  identity: string;
  sso_user: string;
  gh_login: string | null;
  oauth_attempt_id: string | null;
  sso_type: SsoType;
  status: LoginTaskStatus;
  attempts: number;
  failure_reason?: string;
  log_path?: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  stage?: string;
  stage_updated_at?: string;
  queued_at?: string;
  failure_code?: string;
}

interface AttemptRow {
  id: string;
  attempt_number: number;
  status: LoginTaskStatus;
  stage?: string;
  stage_updated_at?: string;
  queued_at: string;
  started_at?: string;
  finished_at?: string;
  failure_reason?: string;
  failure_code?: string;
  log_path?: string;
  history_incomplete: number;
}

interface AttemptOwner {
  task_id: string;
  enterprise_id: EnterpriseId;
}

const ACTIVE_STATUSES = "('pending', 'running', 'cancelling')";
const FINISHED_STATUSES = "('success', 'failed', 'cancelled')";
const LEGACY_INTERRUPTED_REASON = 'Legacy task interrupted; start a new authorization from the account.';

/**
 * Creates the task of an authorization attempt, or returns it when the same attempt is submitted again with the
 * same mapping. An attempt already used by another mapping (including another enterprise's) is a conflict.
 */
export function createTask(enterpriseId: EnterpriseId, input: CreateTaskInput): LoginTaskRecord {
  const owner = attemptOwner(input.oauthAttemptId);
  if (owner) return existingTaskForAttempt(enterpriseId, owner, input);
  const id = newTaskId();
  getDb().transaction(() => {
    if (hasActiveTask(input.identity)) {
      throw new HttpApiError(409, 'task_already_active', 'This account already has an active login task.');
    }
    insertTask(enterpriseId, id, input, nowIso());
  })();
  return getTask(enterpriseId, id)!;
}

/** Identities are global (Proxy's account key), so at most one attempt runs per account across enterprises. */
export function hasActiveTask(identity: string): boolean {
  return getDb().prepare(`
    SELECT 1
    FROM login_tasks
    WHERE identity = ? AND status IN ${ACTIVE_STATUSES}
  `).get(identity) !== undefined;
}

export function getTask(enterpriseId: EnterpriseId, id: string): LoginTaskRecord | undefined {
  const row = getDb().prepare(`
    SELECT *
    FROM login_tasks
    WHERE enterprise_id = ? AND id = ?
  `).get(enterpriseId, id) as TaskRow | undefined;
  return row ? mapRow(row) : undefined;
}

/** The task as of that attempt; an attempt of another enterprise's task is not found. */
export function getTaskByAttempt(enterpriseId: EnterpriseId, attemptId: string): LoginTaskRecord | undefined {
  const owner = attemptOwner(attemptId);
  if (!owner || owner.enterprise_id !== enterpriseId) return undefined;
  const attempt = listAttempts(enterpriseId, owner.task_id).find((entry) => entry.id === attemptId);
  return attempt ? { ...attempt, id: attempt.taskId, enterpriseId } : undefined;
}

export function listTasks(enterpriseId: EnterpriseId, limit = 100): LoginTaskRecord[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM login_tasks
    WHERE enterprise_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(enterpriseId, limit) as TaskRow[];
  return rows.map(mapRow);
}

export function listTasksPage(
  enterpriseId: EnterpriseId,
  query: ManagementQuery = {},
  database = getDb(),
): PageResponse<LoginTaskRecord> {
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const requestedPage = Math.max(1, Math.trunc(query.page ?? 1));
  const where: string[] = ['enterprise_id = ?'];
  const args: unknown[] = [enterpriseId];
  if (query.ids?.length) { where.push(`id IN (${query.ids.map(() => '?').join(',')})`); args.push(...query.ids); }
  const q = query.q?.trim();
  if (q) {
    where.push(`(id LIKE ? ${LIKE_ESCAPE_CLAUSE} OR identity LIKE ? ${LIKE_ESCAPE_CLAUSE} OR sso_user LIKE ? ${LIKE_ESCAPE_CLAUSE} OR gh_login LIKE ? ${LIKE_ESCAPE_CLAUSE} OR failure_reason LIKE ? ${LIKE_ESCAPE_CLAUSE})`);
    args.push(...Array.from({ length: 5 }, () => likeContains(q)));
  }
  let statuses: string[] | undefined;
  if (query.status) {
    statuses = query.status.split(',');
    if (statuses.some((status) => !['pending', 'running', 'cancelling', 'success', 'failed', 'cancelled'].includes(status))) {
      throw new HttpApiError(400, 'invalid_status', 'Unknown login task status.');
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  }
  if (query.from) { where.push('created_at >= ?'); args.push(query.from); }
  if (query.to) { where.push('created_at < ?'); args.push(query.to); }
  if (query.identity) { where.push('identity = ?'); args.push(query.identity); }
  if (query.minAttempts !== undefined) { where.push('attempts >= ?'); args.push(query.minAttempts); }
  if (query.failureCode) { where.push('failure_code = ?'); args.push(query.failureCode); }
  if (query.finishedBefore) { where.push('finished_at < ?'); args.push(query.finishedBefore); }
  // Both age filters imply a status of their own, so combining them can only ever match nothing.
  // Say so instead of silently returning an empty page that looks like "no stuck tasks".
  if (query.minWaitSeconds !== undefined && query.minRunSeconds !== undefined) {
    throw new HttpApiError(400, 'invalid_query', 'minWaitSeconds and minRunSeconds cannot be combined: a task is either waiting in the queue or running.');
  }
  const requireStatus = (key: string, allowed: string[]) => {
    if (statuses && !statuses.some((status) => allowed.includes(status))) {
      throw new HttpApiError(400, 'invalid_query', `${key} only matches ${allowed.join('/')} tasks and cannot be combined with status=${statuses.join(',')}.`);
    }
  };
  if (query.minWaitSeconds !== undefined) {
    requireStatus('minWaitSeconds', ['pending']);
    where.push("status = 'pending' AND stage = 'queued' AND queued_at <= ?");
    args.push(new Date((query.asOf ? Date.parse(query.asOf) : Date.now()) - query.minWaitSeconds * 1000).toISOString());
  }
  if (query.minRunSeconds !== undefined) {
    requireStatus('minRunSeconds', ['running', 'cancelling']);
    where.push("status IN ('running', 'cancelling') AND started_at <= ?");
    args.push(new Date((query.asOf ? Date.parse(query.asOf) : Date.now()) - query.minRunSeconds * 1000).toISOString());
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = (database.prepare(`SELECT COUNT(*) AS count FROM login_tasks ${whereSql}`).get(...args) as { count: number }).count;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const sorts: Record<string, string> = { createdAt: 'created_at', queuedAt: 'queued_at', startedAt: 'started_at', finishedAt: 'finished_at', attempts: 'attempts', status: 'status' };
  const sortKey = query.sort ?? 'createdAt';
  const sort = Object.hasOwn(sorts, sortKey) ? sorts[sortKey] : undefined;
  if (!sort) throw new HttpApiError(400, 'invalid_sort', 'Unknown login task sort field.');
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = database
    .prepare(`SELECT * FROM login_tasks ${whereSql} ORDER BY ${sort} ${dir}, id ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as TaskRow[];
  return pageResponse(rows.map(mapRow), total, page, pageSize);
}

export function reserveRetry(enterpriseId: EnterpriseId, task: LoginTaskRecord, attemptId: string): LoginTaskRecord {
  return getDb().transaction(() => {
    if (hasActiveTask(task.identity)) {
      throw new HttpApiError(409, 'task_already_active', 'This account already has an active login task.');
    }
    const now = nowIso();
    const changed = getDb().prepare(`
      UPDATE login_tasks
      SET oauth_attempt_id = ?, status = 'pending', stage = 'preparing', stage_updated_at = ?, queued_at = ?,
        started_at = NULL, finished_at = NULL, failure_reason = NULL, failure_code = NULL, log_path = NULL
      WHERE enterprise_id = ? AND id = ? AND status = 'failed' AND oauth_attempt_id IS ?
        AND stage IS NOT 'deleting'
    `).run(attemptId, now, now, enterpriseId, task.id, task.oauthAttemptId ?? null).changes;
    if (!changed) {
      throw new HttpApiError(409, 'task_changed', 'The task changed or is not failed. Refresh before retrying.');
    }
    insertNextAttempt(task.id, attemptId, now);
    return getTask(enterpriseId, task.id)!;
  })();
}

export function setStage(enterpriseId: EnterpriseId, id: string, attemptId: string, stage: string): void {
  const now = nowIso();
  getDb().transaction(() => {
    const changed = getDb().prepare(`
      UPDATE login_tasks
      SET stage = ?, stage_updated_at = ?
      WHERE enterprise_id = ? AND id = ? AND oauth_attempt_id = ? AND status IN ${ACTIVE_STATUSES}
    `).run(stage, now, enterpriseId, id, attemptId).changes;
    if (!changed) return;
    getDb().prepare(`
      UPDATE login_task_attempts
      SET stage = ?, stage_updated_at = ?
      WHERE id = ?
    `).run(stage, now, attemptId);
  })();
}

export function markRunning(
  enterpriseId: EnterpriseId,
  id: string,
  logPath: string,
  attemptId = getTask(enterpriseId, id)?.oauthAttemptId,
): LoginTaskRecord | undefined {
  if (!attemptId) return undefined;
  return getDb().transaction(() => {
    const now = nowIso();
    const changed = getDb().prepare(`
      UPDATE login_tasks
      SET status = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL,
        failure_reason = NULL, log_path = ?
      WHERE enterprise_id = ? AND id = ? AND oauth_attempt_id = ? AND status = 'pending'
    `).run(now, logPath, enterpriseId, id, attemptId).changes;
    if (!changed) return undefined;
    getDb().prepare(`
      UPDATE login_task_attempts
      SET status = 'running', started_at = ?, log_path = ?
      WHERE id = ?
    `).run(now, logPath, attemptId);
    return getTask(enterpriseId, id)!;
  })();
}

export function markSuccess(
  enterpriseId: EnterpriseId,
  id: string,
  attemptId = getTask(enterpriseId, id)?.oauthAttemptId,
): LoginTaskRecord | undefined {
  return finishAttempt(enterpriseId, id, attemptId, 'success');
}

export function markFailed(
  enterpriseId: EnterpriseId,
  id: string,
  reason: string,
  attemptId = getTask(enterpriseId, id)?.oauthAttemptId,
  code = 'login_failed',
): LoginTaskRecord | undefined {
  return finishAttempt(enterpriseId, id, attemptId, 'failed', reason, code);
}

export function requestCancellation(enterpriseId: EnterpriseId, id: string): LoginTaskRecord | undefined {
  getDb().transaction(() => {
    getDb().prepare(`
      UPDATE login_tasks
      SET status = 'cancelling'
      WHERE enterprise_id = ? AND id = ? AND status IN ('pending', 'running')
    `).run(enterpriseId, id);
    const task = getTask(enterpriseId, id);
    if (task?.status !== 'cancelling' || !task.oauthAttemptId) return;
    getDb().prepare(`
      UPDATE login_task_attempts
      SET status = 'cancelling'
      WHERE id = ?
    `).run(task.oauthAttemptId);
  })();
  return getTask(enterpriseId, id);
}

export function markCancelled(
  enterpriseId: EnterpriseId,
  id: string,
  attemptId = getTask(enterpriseId, id)?.oauthAttemptId,
): LoginTaskRecord | undefined {
  return finishAttempt(enterpriseId, id, attemptId, 'cancelled', 'Cancelled by request.', 'cancelled');
}

export function listAttempts(enterpriseId: EnterpriseId, id: string): LoginAttemptDto[] {
  const task = getTask(enterpriseId, id);
  if (!task) return [];
  const rows = getDb().prepare(`
    SELECT *
    FROM login_task_attempts
    WHERE task_id = ?
    ORDER BY attempt_number DESC
  `).all(id) as AttemptRow[];
  return rows.map((row) => mapAttempt(task, row));
}

export function summarizeTasks(enterpriseId: EnterpriseId): ManagementSummary {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) AS count
    FROM login_tasks
    WHERE enterprise_id = ?
    GROUP BY status
  `).all(enterpriseId) as Array<{ status: string; count: number }>;
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    counts: Object.fromEntries(rows.map((row) => [row.status, row.count])),
    updatedAt: nowIso(),
  };
}

export function deleteTask(enterpriseId: EnterpriseId, id: string): 'deleted' | 'not_found' | 'not_allowed' {
  const task = getTask(enterpriseId, id);
  if (!task) return 'not_found';
  if (task.status === 'pending' || task.status === 'running' || task.status === 'cancelling') return 'not_allowed';
  const deleted = getDb().prepare(`
    DELETE FROM login_tasks
    WHERE enterprise_id = ? AND id = ? AND status IN ${FINISHED_STATUSES}
  `).run(enterpriseId, id).changes;
  return deleted ? 'deleted' : 'not_allowed';
}

export function claimTaskDeletion(enterpriseId: EnterpriseId, id: string): 'claimed' | 'not_found' | 'not_allowed' {
  if (!getTask(enterpriseId, id)) return 'not_found';
  // Remember the stage being overwritten: a failed delete must not erase the diagnostic stage that
  // tells an operator why the task ended up in this state.
  const changed = getDb().prepare(`
    UPDATE login_tasks
    SET prior_stage = stage, stage = 'deleting'
    WHERE enterprise_id = ? AND id = ? AND status IN ${FINISHED_STATUSES} AND stage IS NOT 'deleting'
  `).run(enterpriseId, id).changes;
  return changed ? 'claimed' : 'not_allowed';
}

/** Releases the deletion claim of one task, or of every task of the enterprise when `id` is omitted. */
export function releaseTaskDeletion(enterpriseId: EnterpriseId, id?: string): void {
  getDb().prepare(`
    UPDATE login_tasks
    SET stage = COALESCE(prior_stage, status), prior_stage = NULL
    WHERE enterprise_id = ? AND stage = 'deleting' AND status IN ${FINISHED_STATUSES}
      AND (? IS NULL OR id = ?)
  `).run(enterpriseId, id ?? null, id ?? null);
}

export function listUnfinishedTasks(enterpriseId: EnterpriseId): LoginTaskRecord[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM login_tasks
    WHERE enterprise_id = ? AND status IN ${ACTIVE_STATUSES}
  `).all(enterpriseId) as TaskRow[];
  return rows.map(mapRow);
}

export function failLegacyInterruptedTask(enterpriseId: EnterpriseId, id: string): void {
  getDb().transaction(() => {
    const now = nowIso();
    const changed = getDb().prepare(`
      UPDATE login_tasks
      SET status = 'failed', failure_code = 'service_interrupted', failure_reason = ?, finished_at = ?
      WHERE enterprise_id = ? AND id = ? AND oauth_attempt_id IS NULL AND status IN ${ACTIVE_STATUSES}
    `).run(LEGACY_INTERRUPTED_REASON, now, enterpriseId, id).changes;
    if (!changed) return;
    getDb().prepare(`
      UPDATE login_task_attempts
      SET status = 'failed', stage = 'failed', failure_code = 'service_interrupted', failure_reason = ?,
        finished_at = ?
      WHERE task_id = ? AND status IN ${ACTIVE_STATUSES}
    `).run(LEGACY_INTERRUPTED_REASON, now, id);
  })();
}

function attemptOwner(attemptId: string): AttemptOwner | undefined {
  return getDb().prepare(`
    SELECT attempts.task_id, tasks.enterprise_id
    FROM login_task_attempts AS attempts
    JOIN login_tasks AS tasks ON tasks.id = attempts.task_id
    WHERE attempts.id = ?
  `).get(attemptId) as AttemptOwner | undefined;
}

function existingTaskForAttempt(
  enterpriseId: EnterpriseId,
  owner: AttemptOwner,
  input: CreateTaskInput,
): LoginTaskRecord {
  const existing = owner.enterprise_id === enterpriseId
    ? getTaskByAttempt(enterpriseId, input.oauthAttemptId)
    : undefined;
  if (!existing || !isSameMapping(existing, input)) {
    const message = 'The authorization attempt belongs to a different account mapping.';
    throw new HttpApiError(409, 'attempt_conflict', message);
  }
  return existing;
}

function isSameMapping(task: LoginTaskRecord, input: CreateTaskInput): boolean {
  return task.oauthAttemptId === input.oauthAttemptId
    && task.identity === input.identity
    && task.ssoUser === input.ssoUser
    && task.ghLogin === input.ghLogin
    && task.ssoType === input.ssoType;
}

function insertTask(enterpriseId: EnterpriseId, id: string, input: CreateTaskInput, now: string): void {
  getDb().prepare(`
    INSERT INTO login_tasks (
      id, enterprise_id, identity, sso_user, gh_login, oauth_attempt_id, sso_type, status, attempts,
      created_at, queued_at, stage, stage_updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 'queued', ?)
  `).run(
    id,
    enterpriseId,
    input.identity,
    input.ssoUser,
    input.ghLogin,
    input.oauthAttemptId,
    input.ssoType,
    now,
    now,
    now,
  );
  getDb().prepare(`
    INSERT INTO login_task_attempts (id, task_id, attempt_number, status, stage, stage_updated_at, queued_at)
    VALUES (?, ?, 1, 'pending', 'queued', ?, ?)
  `).run(input.oauthAttemptId, id, now, now);
}

function insertNextAttempt(taskId: string, attemptId: string, now: string): void {
  getDb().prepare(`
    INSERT INTO login_task_attempts (id, task_id, attempt_number, status, stage, stage_updated_at, queued_at)
    SELECT ?, ?, COALESCE(MAX(attempt_number), 0) + 1, 'pending', 'preparing', ?, ?
    FROM login_task_attempts
    WHERE task_id = ?
  `).run(attemptId, taskId, now, now, taskId);
}

function finishAttempt(
  enterpriseId: EnterpriseId,
  id: string,
  attemptId: string | undefined,
  status: FinishedStatus,
  reason?: string,
  code?: string,
): LoginTaskRecord | undefined {
  if (!attemptId) return getTask(enterpriseId, id);
  getDb().transaction(() => {
    const now = nowIso();
    const changed = getDb().prepare(`
      UPDATE login_tasks
      SET status = ?, finished_at = ?, failure_reason = ?, failure_code = ?, stage = ?, stage_updated_at = ?
      WHERE enterprise_id = ? AND id = ? AND oauth_attempt_id = ? AND status IN ${ACTIVE_STATUSES}
    `).run(status, now, reason ?? null, code ?? null, status, now, enterpriseId, id, attemptId).changes;
    if (!changed) return;
    getDb().prepare(`
      UPDATE login_task_attempts
      SET status = ?, finished_at = ?, failure_reason = ?, failure_code = ?, stage = ?, stage_updated_at = ?
      WHERE id = ?
    `).run(status, now, reason ?? null, code ?? null, status, now, attemptId);
  })();
  return getTask(enterpriseId, id);
}

function mapAttempt(task: LoginTaskRecord, row: AttemptRow): LoginAttemptDto {
  const legacy = Boolean(row.history_incomplete) && row.id === `legacy-${task.id}`;
  return {
    ...task,
    id: row.id,
    taskId: task.id,
    oauthAttemptId: legacy ? undefined : row.id,
    attemptNumber: row.attempt_number,
    status: row.status,
    stage: row.stage ?? undefined,
    stageUpdatedAt: row.stage_updated_at ?? undefined,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    failureCode: row.failure_code ?? undefined,
    logPath: row.log_path ?? undefined,
    historyIncomplete: Boolean(row.history_incomplete),
  };
}

function mapRow(row: TaskRow): LoginTaskRecord {
  return {
    id: row.id,
    enterpriseId: row.enterprise_id,
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    oauthAttemptId: row.oauth_attempt_id ?? undefined,
    ssoType: row.sso_type,
    status: row.status,
    attempts: row.attempts,
    failureReason: row.failure_reason ?? undefined,
    logPath: row.log_path ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    stage: row.stage ?? undefined,
    stageUpdatedAt: row.stage_updated_at ?? undefined,
    queuedAt: row.queued_at ?? undefined,
    failureCode: row.failure_code ?? undefined,
  };
}
