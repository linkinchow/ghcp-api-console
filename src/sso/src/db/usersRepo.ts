import type {
  CopilotSeatOperation,
  CopilotSeatSnapshot,
  CopilotSeatStatus,
  EmuStatus,
  EnterpriseId,
  ManagementQuery,
  ManagementSummary,
  PageResponse,
  SsoUserDto,
} from '@ghcp/shared';
import { HttpApiError, LIKE_ESCAPE_CLAUSE, likeContains, nowIso, pageResponse } from '@ghcp/shared';
import type Database from 'better-sqlite3';
import { getDb } from './connection.js';
import { readMaxSsoUsers } from './runtimeSettingsRepo.js';

export interface SsoUserRecord extends SsoUserDto {
  passwordHash: string;
  salt: string;
}

interface UserRow {
  sso_user: string;
  password_hash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  gh_login?: string;
  gh_scim_id?: string;
  emu_status: EmuStatus;
  copilot_seat_status: CopilotSeatStatus;
  copilot_seat_pending_cancellation_date?: string | null;
  copilot_seat_last_operation?: CopilotSeatOperation;
  copilot_seat_last_error?: string;
  copilot_seat_updated_at?: string;
  created_at: string;
  updated_at: string;
}

export interface UserListQuery extends ManagementQuery { }

export interface NewSsoUser {
  ssoUser: string;
  passwordHash: string;
  salt: string;
  email: string;
  role?: 'user' | 'admin';
  poolManaged?: boolean;
}

export type UserPatch = Partial<Pick<SsoUserRecord, 'email' | 'role' | 'passwordHash' | 'salt'>>;

export type EmuPatch = { ghLogin?: string; ghScimId?: string; emuStatus: EmuStatus };

export type CopilotSeatPatch = (CopilotSeatSnapshot | {
  status: Exclude<CopilotSeatStatus, CopilotSeatSnapshot['status']>;
  pendingCancellationDate?: never;
}) & {
  lastOperation: CopilotSeatOperation;
  lastError?: string;
};

interface WhereClause {
  sql: string;
  args: unknown[];
}

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  ssoUser: 'sso_user',
  email: 'email',
  role: 'role',
  emuStatus: 'emu_status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const LIST_FILTERS = [
  ['status', 'emu_status', ['active', 'suspended', 'deleted', 'not_synced']],
  [
    'seatStatus',
    'copilot_seat_status',
    ['unknown', 'assigned', 'pending_cancellation', 'unassigned', 'assign_failed', 'remove_failed'],
  ],
  ['role', 'role', ['user', 'admin']],
] as const;

export class SsoUserLimitReachedError extends Error {
  constructor(
    readonly current: number,
    readonly limit: number,
  ) {
    super(`SSO user limit of ${limit} has been reached (${current} users currently exist).`);
    this.name = 'SsoUserLimitReachedError';
  }
}

export class PoolMemberManagedError extends Error {
  readonly code = 'pool_member_managed';

  constructor() {
    super('pool_member_managed: Manage this user through the user pool.');
    this.name = 'PoolMemberManagedError';
  }
}

// Kept separate from user records/DTOs: this is local ownership metadata only.
export function isPoolManagedSsoUser(enterpriseId: EnterpriseId, ssoUser: string): boolean {
  const row = getDb().prepare(`
    SELECT 1
    FROM sso_pool_managed_users
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).get(enterpriseId, ssoUser);
  return Boolean(row);
}

export function assertNotLocallyPoolManaged(enterpriseId: EnterpriseId, ssoUser: string): void {
  if (isPoolManagedSsoUser(enterpriseId, ssoUser)) throw new PoolMemberManagedError();
}

export function listUsers(
  enterpriseId: EnterpriseId,
  query: UserListQuery = {},
  database = getDb(),
): PageResponse<SsoUserDto> {
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const order = orderBy(query);
  const where = listWhere(enterpriseId, query);
  const total = countWhere(database, where);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.trunc(query.page ?? 1)), lastPage);
  const rows = database.prepare(`
    SELECT *
    FROM sso_users
    WHERE ${where.sql}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...where.args, pageSize, (page - 1) * pageSize) as UserRow[];
  return pageResponse(rows.map(mapRow).map(toDto), total, page, pageSize);
}

export function summarizeUsers(enterpriseId: EnterpriseId): ManagementSummary {
  const rows = getDb().prepare(`
    SELECT emu_status AS status, COUNT(*) AS count
    FROM sso_users
    WHERE enterprise_id = ?
    GROUP BY emu_status
  `).all(enterpriseId) as Array<{ status: string; count: number }>;
  return {
    total: rows.reduce((total, row) => total + row.count, 0),
    counts: Object.fromEntries(rows.map((row) => [row.status, row.count])),
    updatedAt: nowIso(),
  };
}

export function listAllUsers(enterpriseId: EnterpriseId): SsoUserRecord[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM sso_users
    WHERE enterprise_id = ?
    ORDER BY sso_user ASC
  `).all(enterpriseId) as UserRow[];
  return rows.map(mapRow);
}

export function countUsers(enterpriseId: EnterpriseId): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM sso_users
    WHERE enterprise_id = ?
  `).get(enterpriseId) as { count: number };
  return row.count;
}

export function getUser(enterpriseId: EnterpriseId, ssoUser: string): SsoUserRecord | undefined {
  const row = getDb().prepare(`
    SELECT *
    FROM sso_users
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).get(enterpriseId, ssoUser) as UserRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function getUserByGhLogin(enterpriseId: EnterpriseId, ghLogin: string): SsoUserRecord | undefined {
  const trimmed = ghLogin.trim();
  if (!trimmed) return undefined;
  const row = getDb().prepare(`
    SELECT *
    FROM sso_users
    WHERE enterprise_id = ?
      AND gh_login = ? COLLATE NOCASE
  `).get(enterpriseId, trimmed) as UserRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function createUser(enterpriseId: EnterpriseId, input: NewSsoUser): SsoUserRecord {
  const db = getDb();
  return db.transaction(() => {
    assertBelowUserLimit(db, enterpriseId);
    insertUser(db, enterpriseId, input);
    if (input.poolManaged === true) insertPoolMarker(db, enterpriseId, input.ssoUser);
    const created = getUser(enterpriseId, input.ssoUser);
    if (!created) throw new Error(`Failed to read newly created SSO user "${input.ssoUser}".`);
    return created;
  }).immediate();
}

export function updateUser(enterpriseId: EnterpriseId, ssoUser: string, patch: UserPatch): SsoUserRecord | undefined {
  const current = getUser(enterpriseId, ssoUser);
  if (!current) return undefined;
  assertNotLocallyPoolManaged(enterpriseId, current.ssoUser);
  getDb().prepare(`
    UPDATE sso_users
    SET email = ?, role = ?, password_hash = ?, salt = ?, updated_at = ?
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(
    patch.email ?? current.email,
    patch.role ?? current.role,
    patch.passwordHash ?? current.passwordHash,
    patch.salt ?? current.salt,
    nowIso(),
    enterpriseId,
    ssoUser,
  );
  return getUser(enterpriseId, ssoUser);
}

export function updateEmu(enterpriseId: EnterpriseId, ssoUser: string, patch: EmuPatch): SsoUserRecord {
  getDb().prepare(`
    UPDATE sso_users
    SET gh_login = ?, gh_scim_id = ?, emu_status = ?, updated_at = ?
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(patch.ghLogin, patch.ghScimId, patch.emuStatus, nowIso(), enterpriseId, ssoUser);
  return requireUser(enterpriseId, ssoUser);
}

export function updateCopilotSeat(enterpriseId: EnterpriseId, ssoUser: string, patch: CopilotSeatPatch): SsoUserRecord {
  const now = nowIso();
  const pendingDate = patch.status === 'pending_cancellation' ? patch.pendingCancellationDate : null;
  getDb().prepare(`
    UPDATE sso_users
    SET copilot_seat_status = ?, copilot_seat_last_operation = ?, copilot_seat_last_error = ?,
        copilot_seat_pending_cancellation_date = ?, copilot_seat_updated_at = ?, updated_at = ?
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(patch.status, patch.lastOperation, patch.lastError ?? null, pendingDate, now, now, enterpriseId, ssoUser);
  return requireUser(enterpriseId, ssoUser);
}

export function updateCopilotSeatFromGitHub(
  enterpriseId: EnterpriseId,
  ssoUser: string,
  seat: CopilotSeatSnapshot,
): SsoUserRecord {
  const now = nowIso();
  getDb().prepare(`
    UPDATE sso_users
    SET copilot_seat_status = ?, copilot_seat_last_operation = NULL, copilot_seat_last_error = NULL,
        copilot_seat_pending_cancellation_date = ?, copilot_seat_updated_at = ?, updated_at = ?
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(seat.status, seat.pendingCancellationDate ?? null, now, now, enterpriseId, ssoUser);
  return requireUser(enterpriseId, ssoUser);
}

export function recordCopilotSeatError(
  enterpriseId: EnterpriseId,
  ssoUser: string,
  operation: CopilotSeatOperation,
  message: string,
): void {
  const result = getDb().prepare(`
    UPDATE sso_users
    SET copilot_seat_last_operation = ?, copilot_seat_last_error = ?, updated_at = ?
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(operation, message, nowIso(), enterpriseId, ssoUser);
  if (!result.changes) throw new Error(`Unknown SSO user "${ssoUser}".`);
}

export function deleteUser(enterpriseId: EnterpriseId, ssoUser: string): boolean {
  assertNotLocallyPoolManaged(enterpriseId, ssoUser);
  const result = getDb().prepare(`
    DELETE FROM sso_users
    WHERE enterprise_id = ?
      AND lower(sso_user) = lower(?)
  `).run(enterpriseId, ssoUser);
  return result.changes > 0;
}

export function toDto(user: SsoUserRecord): SsoUserDto {
  return {
    ssoUser: user.ssoUser,
    email: user.email,
    role: user.role,
    ghLogin: user.ghLogin,
    ghScimId: user.ghScimId,
    emuStatus: user.emuStatus,
    copilotSeatStatus: user.copilotSeatStatus,
    copilotSeatPendingCancellationDate: user.copilotSeatPendingCancellationDate,
    copilotSeatLastOperation: user.copilotSeatLastOperation,
    copilotSeatLastError: user.copilotSeatLastError,
    copilotSeatUpdatedAt: user.copilotSeatUpdatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function requireUser(enterpriseId: EnterpriseId, ssoUser: string): SsoUserRecord {
  const user = getUser(enterpriseId, ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

function assertBelowUserLimit(db: Database.Database, enterpriseId: EnterpriseId): void {
  const current = countUsers(enterpriseId);
  const limit = readMaxSsoUsers(enterpriseId, db);
  if (limit !== null && current >= limit) throw new SsoUserLimitReachedError(current, limit);
}

function insertUser(db: Database.Database, enterpriseId: EnterpriseId, input: NewSsoUser): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO sso_users (
      enterprise_id, sso_user, password_hash, salt, email, role, emu_status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'not_synced', ?, ?)
  `).run(enterpriseId, input.ssoUser, input.passwordHash, input.salt, input.email, input.role ?? 'user', now, now);
}

function insertPoolMarker(db: Database.Database, enterpriseId: EnterpriseId, ssoUser: string): void {
  db.prepare(`
    INSERT INTO sso_pool_managed_users (enterprise_id, sso_user)
    VALUES (?, ?)
  `).run(enterpriseId, ssoUser);
}

function listWhere(enterpriseId: EnterpriseId, query: UserListQuery): WhereClause {
  const clauses = ['enterprise_id = ?'];
  const args: unknown[] = [enterpriseId];
  const add = (sql: string, ...values: unknown[]) => {
    clauses.push(sql);
    args.push(...values);
  };
  const q = query.q?.trim();
  if (q) add(searchClause(), likeContains(q), likeContains(q), likeContains(q));
  if (query.ids?.length) add(`sso_user IN (${placeholders(query.ids.length)})`, ...query.ids);
  for (const [key, column, allowed] of LIST_FILTERS) {
    const values = filterValues(query[key], key, allowed);
    if (values) add(`${column} IN (${placeholders(values.length)})`, ...values);
  }
  if (query.from) add('updated_at >= ?', query.from);
  if (query.to) add('updated_at < ?', query.to);
  return { sql: clauses.join(' AND '), args };
}

function searchClause(): string {
  const like = `LIKE ? ${LIKE_ESCAPE_CLAUSE}`;
  return `(sso_user ${like} OR email ${like} OR gh_login ${like})`;
}

function filterValues(raw: string | undefined, key: string, allowed: readonly string[]): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',');
  if (values.some((value) => !allowed.includes(value))) {
    throw new HttpApiError(400, 'invalid_filter', `Invalid ${key}.`);
  }
  return values;
}

function orderBy(query: UserListQuery): string {
  if (query.sort && !Object.hasOwn(SORT_COLUMNS, query.sort)) {
    throw new HttpApiError(400, 'invalid_sort', 'Unknown SSO user sort field.');
  }
  const column = SORT_COLUMNS[query.sort ?? 'ssoUser'] ?? 'sso_user';
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
  return `${column} ${dir}, sso_user ${dir}`;
}

function countWhere(database: Database.Database, where: WhereClause): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM sso_users
    WHERE ${where.sql}
  `).get(...where.args) as { count: number };
  return row.count;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function mapRow(row: UserRow): SsoUserRecord {
  return {
    ssoUser: row.sso_user,
    passwordHash: row.password_hash,
    salt: row.salt,
    email: row.email,
    role: row.role,
    ghLogin: row.gh_login,
    ghScimId: row.gh_scim_id,
    emuStatus: row.emu_status,
    copilotSeatStatus: row.copilot_seat_status ?? 'unknown',
    copilotSeatPendingCancellationDate: row.copilot_seat_pending_cancellation_date ?? undefined,
    copilotSeatLastOperation: row.copilot_seat_last_operation,
    copilotSeatLastError: row.copilot_seat_last_error,
    copilotSeatUpdatedAt: row.copilot_seat_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
