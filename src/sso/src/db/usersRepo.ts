import { randomUUID } from 'node:crypto';
import type { CopilotSeatOperation, CopilotSeatStatus, EmuStatus, EnterpriseScope, PageResponse, SsoUserDto } from '@ghcp/shared';
import { EnterpriseContractError, nowIso, pageResponse, requireEnterprise } from '@ghcp/shared';
import { getDb } from './connection.js';
import { getScopeProfile } from '../enterprise.js';
import { readMaxSsoUsers } from './runtimeSettingsRepo.js';
import { assertUserOperationAvailable, type UserOperationLease } from '../users/operationFence.js';

export interface SsoUserRecord extends SsoUserDto {
  enterpriseId: string;
  userIncarnation: string;
  passwordHash: string;
  salt: string;
}

interface UserRow {
  enterprise_id: string;
  user_incarnation: string;
  sso_user: string;
  password_hash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  gh_login?: string;
  gh_scim_id?: string;
  emu_status: EmuStatus;
  copilot_seat_status: CopilotSeatStatus;
  copilot_seat_last_operation?: CopilotSeatOperation;
  copilot_seat_last_error?: string;
  copilot_seat_updated_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UserListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'ssoUser' | 'email' | 'role' | 'emuStatus' | 'createdAt';
  dir?: 'asc' | 'desc';
}

export class SsoUserLimitReachedError extends Error {
  constructor(readonly current: number, readonly limit: number) {
    super(`SSO user limit of ${limit} has been reached (${current} users currently exist).`);
    this.name = 'SsoUserLimitReachedError';
  }
}
export class PoolMemberManagedError extends Error {
  readonly code = 'pool_member_managed';
  constructor() { super('pool_member_managed: Manage this user through the user pool.'); this.name = 'PoolMemberManagedError'; }
}
export class UserIncarnationConflictError extends Error {
  readonly code = 'user_incarnation_conflict';
  constructor() { super('SSO user changed or was recreated; stale operation was not applied.'); this.name = 'UserIncarnationConflictError'; }
}

export function assertUserIncarnation(user: SsoUserRecord, scope: EnterpriseScope): void {
  requireEnterprise(user.enterpriseId, getScopeProfile(scope).id);
  if (!user.userIncarnation || !getDb().prepare('SELECT 1 FROM sso_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?')
    .get(scope.enterpriseId, user.ssoUser, user.userIncarnation)) throw new UserIncarnationConflictError();
}

export function isPoolManagedSsoUser(ssoUser: string, scope: EnterpriseScope): boolean {
  getScopeProfile(scope);
  return Boolean(getDb().prepare('SELECT 1 FROM sso_pool_managed_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE').get(scope.enterpriseId, ssoUser));
}
export function assertNotLocallyPoolManaged(ssoUser: string, scope: EnterpriseScope): void {
  if (isPoolManagedSsoUser(ssoUser, scope)) throw new PoolMemberManagedError();
}

export function listUsers(query: UserListQuery, scope: EnterpriseScope): PageResponse<SsoUserDto> {
  getScopeProfile(scope);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  const where = `WHERE enterprise_id = ?${q ? ' AND (sso_user LIKE ? OR email LIKE ? OR gh_login LIKE ?)' : ''}`;
  const args = q ? [scope.enterpriseId, `%${q}%`, `%${q}%`, `%${q}%`] : [scope.enterpriseId];
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM sso_users ${where}`).get(...args) as { count: number }).count;
  const rows = getDb().prepare(`SELECT * FROM sso_users ${where} ORDER BY ${sortColumn(query.sort)} ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as UserRow[];
  return pageResponse(rows.map(row => toDto(mapRow(row, scope))), total, page, pageSize);
}
export function listAllUsers(scope: EnterpriseScope): SsoUserRecord[] {
  getScopeProfile(scope);
  return (getDb().prepare('SELECT * FROM sso_users WHERE enterprise_id = ? ORDER BY sso_user ASC').all(scope.enterpriseId) as UserRow[]).map(row => mapRow(row, scope));
}
export function countUsers(scope: EnterpriseScope): number {
  getScopeProfile(scope);
  return (getDb().prepare('SELECT COUNT(*) AS count FROM sso_users WHERE enterprise_id = ?').get(scope.enterpriseId) as { count: number }).count;
}
export function getUser(ssoUser: string, scope: EnterpriseScope): SsoUserRecord | undefined {
  getScopeProfile(scope);
  const row = getDb().prepare('SELECT * FROM sso_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE').get(scope.enterpriseId, ssoUser) as UserRow | undefined;
  return row ? mapRow(row, scope) : undefined;
}
export function getUserByGhLogin(ghLogin: string, scope: EnterpriseScope): SsoUserRecord | undefined {
  getScopeProfile(scope);
  const trimmed = ghLogin.trim();
  if (!trimmed) return undefined;
  const rows = getDb().prepare('SELECT * FROM sso_users WHERE enterprise_id = ? AND gh_login = ? COLLATE NOCASE LIMIT 2').all(scope.enterpriseId, trimmed) as UserRow[];
  if (rows.length > 1) throw new EnterpriseContractError('sso_github_binding_ambiguous');
  return rows[0] ? mapRow(rows[0], scope) : undefined;
}

export function createUser(input: { ssoUser: string; passwordHash: string; salt: string; email: string; role?: 'user' | 'admin'; poolManaged?: boolean }, scope: EnterpriseScope): SsoUserRecord {
  getScopeProfile(scope);
  const db = getDb();
  return db.transaction(() => {
    assertUserOperationAvailable(input.ssoUser, undefined, scope);
    const current = countUsers(scope);
    const limit = readMaxSsoUsers(db, scope);
    if (limit !== null && current >= limit) throw new SsoUserLimitReachedError(current, limit);
    const now = nowIso();
    db.prepare(`INSERT INTO sso_users (enterprise_id, user_incarnation, sso_user, password_hash, salt, email, role, emu_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'not_synced', ?, ?)`)
      .run(scope.enterpriseId, randomUUID(), input.ssoUser, input.passwordHash, input.salt, input.email, input.role ?? 'user', now, now);
    if (input.poolManaged === true) db.prepare('INSERT INTO sso_pool_managed_users (enterprise_id, sso_user) VALUES (?, ?)').run(scope.enterpriseId, input.ssoUser);
    return getUser(input.ssoUser, scope)!;
  }).immediate();
}

export function updateUser(ssoUser: string, patch: Partial<Pick<SsoUserRecord, 'email' | 'role' | 'passwordHash' | 'salt'>>, scope: EnterpriseScope, expectedUserIncarnation?: string): SsoUserRecord | undefined {
  const current = getUser(ssoUser, scope);
  if (!current) return undefined;
  if (expectedUserIncarnation !== undefined && current.userIncarnation !== expectedUserIncarnation) throw new UserIncarnationConflictError();
  assertNotLocallyPoolManaged(current.ssoUser, scope);
  assertUserOperationAvailable(current.ssoUser, undefined, scope);
  const result = getDb().prepare(`UPDATE sso_users SET email = ?, role = ?, password_hash = ?, salt = ?, updated_at = ?
    WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?`)
    .run(patch.email ?? current.email, patch.role ?? current.role, patch.passwordHash ?? current.passwordHash, patch.salt ?? current.salt,
      nowIso(), scope.enterpriseId, ssoUser, current.userIncarnation);
  if (result.changes !== 1) throw new UserIncarnationConflictError();
  return getUser(ssoUser, scope);
}

// Long-running external work must supply the captured incarnation, never re-read a new one.
export function updateEmu(ssoUser: string, patch: { ghLogin?: string; ghScimId?: string; emuStatus: EmuStatus }, expectedIncarnation: string, scope: EnterpriseScope): SsoUserRecord {
  getScopeProfile(scope);
  const result = getDb().prepare(`UPDATE sso_users SET gh_login = ?, gh_scim_id = ?, emu_status = ?, updated_at = ?
    WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?`)
    .run(patch.ghLogin, patch.ghScimId, patch.emuStatus, nowIso(), scope.enterpriseId, ssoUser, expectedIncarnation);
  if (result.changes !== 1) throw new UserIncarnationConflictError();
  return getUser(ssoUser, scope)!;
}
export function updateCopilotSeat(ssoUser: string, patch: { status: CopilotSeatStatus; lastOperation: CopilotSeatOperation; lastError?: string }, expectedIncarnation: string, scope: EnterpriseScope): SsoUserRecord {
  getScopeProfile(scope);
  const now = nowIso();
  const result = getDb().prepare(`UPDATE sso_users SET copilot_seat_status = ?, copilot_seat_last_operation = ?, copilot_seat_last_error = ?, copilot_seat_updated_at = ?, updated_at = ?
    WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?`)
    .run(patch.status, patch.lastOperation, patch.lastError ?? null, now, now, scope.enterpriseId, ssoUser, expectedIncarnation);
  if (result.changes !== 1) throw new UserIncarnationConflictError();
  return getUser(ssoUser, scope)!;
}
export function updateCopilotSeatFromGitHub(ssoUser: string, status: 'assigned' | 'unassigned', expectedIncarnation: string, scope: EnterpriseScope): SsoUserRecord {
  getScopeProfile(scope);
  const now = nowIso();
  const result = getDb().prepare(`UPDATE sso_users SET copilot_seat_status = ?, copilot_seat_last_operation = NULL, copilot_seat_last_error = NULL, copilot_seat_updated_at = ?, updated_at = ?
    WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?`)
    .run(status, now, now, scope.enterpriseId, ssoUser, expectedIncarnation);
  if (result.changes !== 1) throw new UserIncarnationConflictError();
  return getUser(ssoUser, scope)!;
}
export function deleteUser(ssoUser: string, expectedIncarnation: string, lease: UserOperationLease | undefined, scope: EnterpriseScope): boolean {
  assertNotLocallyPoolManaged(ssoUser, scope);
  assertUserOperationAvailable(ssoUser, lease, scope);
  const result = getDb().prepare('DELETE FROM sso_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ?').run(scope.enterpriseId, ssoUser, expectedIncarnation);
  if (result.changes !== 1 && getUser(ssoUser, scope)) throw new UserIncarnationConflictError();
  return result.changes > 0;
}

export function toDto(user: SsoUserRecord): SsoUserDto {
  return { enterpriseId: user.enterpriseId, userIncarnation: user.userIncarnation, ssoUser: user.ssoUser, email: user.email, role: user.role,
    ghLogin: user.ghLogin, ghScimId: user.ghScimId, emuStatus: user.emuStatus, copilotSeatStatus: user.copilotSeatStatus,
    copilotSeatLastOperation: user.copilotSeatLastOperation, copilotSeatLastError: user.copilotSeatLastError,
    copilotSeatUpdatedAt: user.copilotSeatUpdatedAt, createdAt: user.createdAt, updatedAt: user.updatedAt };
}
function mapRow(row: UserRow, scope: EnterpriseScope): SsoUserRecord {
  return { enterpriseId: requireEnterprise(row.enterprise_id, scope.enterpriseId), userIncarnation: row.user_incarnation,
    ssoUser: row.sso_user, passwordHash: row.password_hash, salt: row.salt, email: row.email, role: row.role,
    ghLogin: row.gh_login, ghScimId: row.gh_scim_id, emuStatus: row.emu_status, copilotSeatStatus: row.copilot_seat_status ?? 'unknown',
    copilotSeatLastOperation: row.copilot_seat_last_operation, copilotSeatLastError: row.copilot_seat_last_error,
    copilotSeatUpdatedAt: row.copilot_seat_updated_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
function sortColumn(sort: UserListQuery['sort']): string {
  switch (sort) { case 'email': return 'email'; case 'role': return 'role'; case 'emuStatus': return 'emu_status'; case 'createdAt': return 'created_at'; default: return 'sso_user'; }
}
