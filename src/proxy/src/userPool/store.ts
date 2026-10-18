import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId } from '@ghcp/shared';
import { runPoolEnterpriseMigrations } from '../db/enterpriseMigrations.js';
import {
  correctInventoryCounts,
  getEnterpriseRecord,
  incrementInventory,
  listEnterpriseRecords,
  setEnterpriseCap,
} from '../db/enterpriseRepo.js';
import type { ProxyEnterpriseRecord } from '../db/storageTypes.js';
import type { PoolConfig } from './config.js';
import { normalizeCaller, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { poolPageSql, type PoolList, type PoolPage, type PoolPageQuery } from './paging.js';
import type { WorkerCredentialFence, WorkerCredentialMutation } from './storage.js';
import {
  admissionOrder,
  assertEnterpriseActive,
  eligibleEnterprises,
  LOGIN_CAPACITY_SQL,
  nextPolicy,
  nextSettings,
  PendingSelection,
  planReplenishment,
  POLICY_ENTERPRISE_SQL,
  poolSupplyQuery,
  SCHEDULING_ENTERPRISE_SQL,
  type PolicyEnterprise,
  type PolicyPatch,
  type PoolSupply,
  type SchedulingEnterprise,
} from './scheduling.js';
import { inferenceHoldTimeoutMs } from './inferenceTimeout.js';

export interface Inventory {
  identity: string;
  enterprise_id: string;
  ordinal: number;
  state: string;
  stage: string;
  attempt_id: string;
  /** OAuth callback correlation is independent from the worker retry fence. */
  oauth_attempt_id?: string | null;
  /** Persisted creation marker prevents adopting a deleted/recreated SSO user. */
  sso_created_at?: string | null;
  task_id: string | null;
  attempts: number;
  retry_at: number;
  last_error: string | null;
  updated_at: number;
  cooldown_until: number;
  verified_at: number | null;
  generation: number;
  reauth_count?: number;
  reauth_window_at?: number;
}

export interface Lease {
  caller_id: string;
  member_identity: string;
  /** The member's enterprise; a lease never changes enterprise. */
  enterprise_id: string;
  lease_id: string;
  phase: string;
  assigned_at: number;
  last_success_at: number | null;
  expires_at: number;
}

export interface HeldLease extends Lease {
  request_id: string;
  /** Catalog handles have no corresponding row in user_pool_leases. */
  kind?: 'lease' | 'catalog';
  /** Absolute request deadline. Runtime must abort upstream work by this time. */
  deadline_at?: number;
}

/** Global pool settings; each enterprise's cap lives in `proxy_enterprises` (design §5.8). */
export interface PoolSettings {
  version: number;
  idle_target: number;
  lease_seconds: number;
  paused: number;
}

/** A member chosen for a new binding, with the enterprise the binding then belongs to. */
interface PoolMember {
  identity: string;
  enterprise_id: string;
}

/** `WHERE`/`AND` filter on `p.enterprise_id`; empty for global reads. */
interface MemberScope {
  sql: string;
  values: string[];
}

export type InventoryFence = string | (Pick<Inventory, 'attempt_id' | 'generation'> & Partial<Pick<Inventory, 'stage'>>);

interface EventFields {
  action: string;
  identity?: string;
  caller?: string;
  leaseId?: string;
  detail?: string;
  /** Defaults to the member's enterprise; global events have none. */
  enterpriseId?: string;
}

interface HoldRow {
  request_id: string;
  lease_id: string;
  member_identity: string;
  caller_id: string;
  generation: number;
  deadline_at: number;
  expires_at: number;
}

const MANUAL_ERRORS = ['sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed'];
const HOLD_DRAIN_MS = 10000;
const REAUTH_WINDOW_MS = 60 * 60 * 1000;
const REAUTH_MAX_CYCLES = 3;
const INVENTORY_KEYS = [
  'state', 'stage', 'attempt_id', 'oauth_attempt_id', 'sso_created_at', 'task_id', 'attempts', 'retry_at',
  'last_error', 'cooldown_until', 'verified_at',
];

export class UserPoolStore {
  private readonly pendingSelection = new PendingSelection();

  constructor(private readonly db: Database.Database, private readonly options: PoolConfig) {
    const created = this.createTables();
    runPoolEnterpriseMigrations(db);
    db.transaction(() => this.initializeEnterprise(created)).immediate();
  }

  /** Creates or upgrades the pool tables; returns whether this call created the settings row. */
  private createTables(): boolean {
    const db = this.db;
    const options = this.options;
    return db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_pool_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL DEFAULT 1,
          idle_target INTEGER NOT NULL, max_accounts INTEGER NOT NULL, lease_seconds INTEGER NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0, next_ordinal INTEGER NOT NULL DEFAULT 0,
          account_domain TEXT NOT NULL, owner TEXT, owner_until INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS user_pool_accounts (
          identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity) ON DELETE RESTRICT,
          ordinal INTEGER UNIQUE NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new',
          attempt_id TEXT NOT NULL, oauth_attempt_id TEXT, sso_created_at TEXT,
          task_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
          cooldown_until INTEGER NOT NULL DEFAULT 0, verified_at INTEGER,
          generation INTEGER NOT NULL DEFAULT 0, enterprise_id TEXT,
          CHECK(state IN ('provisioning', 'ready', 'cooling', 'failed', 'disabled'))
        );
        CREATE TABLE IF NOT EXISTS user_pool_leases (
          caller_id TEXT PRIMARY KEY,
          member_identity TEXT UNIQUE NOT NULL REFERENCES user_pool_accounts(identity),
          lease_id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('provisional', 'active')),
          assigned_at INTEGER NOT NULL, last_success_at INTEGER, expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_pool_holds (
          request_id TEXT PRIMARY KEY,
          lease_id TEXT NOT NULL REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL DEFAULT 0,
          generation INTEGER NOT NULL DEFAULT -1
        );
        CREATE INDEX IF NOT EXISTS user_pool_holds_lease ON user_pool_holds(lease_id, expires_at);
        CREATE TABLE IF NOT EXISTS user_pool_catalog_holds (
          request_id TEXT PRIMARY KEY, lease_id TEXT UNIQUE NOT NULL, caller_id TEXT NOT NULL,
          member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity),
          assigned_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          deadline_at INTEGER NOT NULL, generation INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS user_pool_catalog_member
          ON user_pool_catalog_holds(member_identity, expires_at);
        CREATE INDEX IF NOT EXISTS user_pool_catalog_caller ON user_pool_catalog_holds(caller_id);
        CREATE TABLE IF NOT EXISTS user_pool_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL,
          identity TEXT, caller_id TEXT, lease_id TEXT, detail TEXT, enterprise_id TEXT
        );
      `);
      // Upgrade the initial pool schema without dropping inventory or live holds. Legacy
      // holds still pin their members until expiry, but cannot renew a lease without a fence.
      this.addColumn('user_pool_accounts', 'generation', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumn('user_pool_accounts', 'oauth_attempt_id', 'TEXT');
      this.addColumn('user_pool_accounts', 'sso_created_at', 'TEXT');
      this.addColumn('user_pool_accounts', 'reauth_count', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumn('user_pool_accounts', 'reauth_window_at', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumn('user_pool_holds', 'deadline_at', 'INTEGER NOT NULL DEFAULT 0');
      this.addColumn('user_pool_holds', 'generation', 'INTEGER NOT NULL DEFAULT -1');
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_pool_catalog_cooldowns (
        caller_id TEXT PRIMARY KEY,
        member_identity TEXT NOT NULL REFERENCES user_pool_accounts(identity),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_pool_catalog_cooldown_expiry ON user_pool_catalog_cooldowns(expires_at);
      CREATE TRIGGER IF NOT EXISTS user_pool_credential_fence
        AFTER UPDATE OF copilot_oauth_token, copilot_oauth_status, copilot_oauth_attempt_id,
          copilot_oauth_updated_at, sso_user, gh_login ON proxy_accounts
        WHEN OLD.copilot_oauth_token IS NOT NEW.copilot_oauth_token
          OR OLD.copilot_oauth_status IS NOT NEW.copilot_oauth_status
          OR OLD.copilot_oauth_attempt_id IS NOT NEW.copilot_oauth_attempt_id
          OR OLD.copilot_oauth_updated_at IS NOT NEW.copilot_oauth_updated_at
          OR OLD.sso_user IS NOT NEW.sso_user OR OLD.gh_login IS NOT NEW.gh_login
        BEGIN
          UPDATE user_pool_accounts SET generation = generation + 1, verified_at = NULL
          WHERE identity = NEW.identity;
        END;
      `);
      // The enterprise fingerprint covers the account domain now; this column is no longer compared.
      return db.prepare(`
        INSERT OR IGNORE INTO user_pool_settings
          (id, idle_target, max_accounts, lease_seconds, account_domain) VALUES (1, ?, ?, ?, ?)
      `).run(options.idleTarget, options.maxAccounts, options.leaseSeconds, options.accountDomain).changes === 1;
    }).immediate();
  }

  /**
   * The `default` enterprise owns the pool cap. A newly created pool takes its configured cap, as the
   * single-enterprise pool did; afterwards the persisted cap wins. N_e drift is corrected and recorded.
   */
  private initializeEnterprise(created: boolean): void {
    if (!getEnterpriseRecord(this.db, DEFAULT_ENTERPRISE_ID)) {
      throw new Error('The default enterprise is missing; run the Proxy migrations first.');
    }
    if (created) setEnterpriseCap(this.db, DEFAULT_ENTERPRISE_ID, this.options.maxAccounts);
    this.correctInventoryDrift();
  }

  /** Design §5.8: recounts N_e (GROUP BY), records each correction and returns how many enterprises drifted. */
  correctInventoryDrift(): number {
    return this.db.transaction(() => {
      const drifts = correctInventoryCounts(this.db);
      for (const drift of drifts) {
        this.recordEvent({
          action: 'enterprise_inventory_drift',
          enterpriseId: drift.enterpriseId,
          detail: `stored=${drift.stored} actual=${drift.actual}`,
        });
      }
      return drifts.length;
    }).immediate();
  }

  /** Every `proxy_enterprises` row, including enterprises that are no longer in the registry. */
  enterprisePolicies(): ProxyEnterpriseRecord[] {
    return listEnterpriseRecords(this.db);
  }

  /** Compare-and-set on `policy_version`; readiness for activation is the caller's check. */
  updateEnterprisePolicy(id: string, expectedVersion: number, patch: PolicyPatch): ProxyEnterpriseRecord {
    return this.db.transaction(() => {
      const rows = this.db.prepare(POLICY_ENTERPRISE_SQL).all() as PolicyEnterprise[];
      const current = rows.find((row) => row.id === id);
      if (!current) throw new UserPoolError(404, 'enterprise_not_found');
      const next = nextPolicy(current, rows, expectedVersion, patch);
      this.db.prepare(`
        UPDATE proxy_enterprises
        SET max_accounts = ?, state = ?, policy_version = policy_version + 1, updated_at = ?
        WHERE id = ?
          AND policy_version = ?
      `).run(next.maxAccounts, next.state, this.now(), id, expectedVersion);
      this.recordEvent({ action: 'enterprise_policy_updated', enterpriseId: id, detail: JSON.stringify(next) });
      return getEnterpriseRecord(this.db, id as EnterpriseId)!;
    }).immediate();
  }

  private schedulingEnterprises(): SchedulingEnterprise[] {
    return this.db.prepare(SCHEDULING_ENTERPRISE_SQL).all() as SchedulingEnterprise[];
  }

  private enterpriseState(id: string): string | undefined {
    const row = this.db.prepare(`
      SELECT state
      FROM proxy_enterprises
      WHERE id = ?
    `).get(id) as { state: string } | undefined;
    return row?.state;
  }

  private addColumn(table: string, name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }

  now(): number {
    return (this.db.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now")
      .get() as { now: number }).now;
  }

  settings(): PoolSettings {
    return this.db.prepare(`
      SELECT version, idle_target, lease_seconds, paused
      FROM user_pool_settings
      WHERE id = 1
    `).get() as PoolSettings;
  }

  /** Accepts idle_target, lease_seconds and paused; a `max_accounts` key is 409 use_enterprise_cap. */
  updateSettings(version: number, patch: Partial<PoolSettings>): PoolSettings {
    return this.db.transaction(() => {
      const next = nextSettings(version, this.settings(), patch);
      this.db.prepare(`
        UPDATE user_pool_settings
        SET idle_target = ?, lease_seconds = ?, paused = ?, version = version + 1
        WHERE id = 1
      `).run(next.idle_target, next.lease_seconds, next.paused);
      this.event('settings_updated');
      return this.settings();
    }).immediate();
  }

  mutateWorkerCredential(identity: string, fence: WorkerCredentialFence, owner: string, mutation: WorkerCredentialMutation): boolean {
    return this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || row.state !== 'provisioning' || row.stage !== fence.stage
        || !this.matchesFence(row, fence) || !this.matchesOwner(owner) || this.hasHolds(identity)) return false;
      const timestamp = new Date(this.now()).toISOString();
      if (mutation.type === 'link') {
        return this.db.prepare(`UPDATE proxy_accounts SET gh_login = ?, updated_at = ?
          WHERE identity = ? AND sso_user = ? AND (gh_login IS NULL OR gh_login = ?)`)
          .run(mutation.ghLogin, timestamp, identity, identity, mutation.ghLogin).changes === 1;
      }
      if (mutation.type === 'begin') {
        return this.db.prepare(`UPDATE proxy_accounts SET copilot_oauth_status = 'refreshing',
          copilot_oauth_attempt_id = ?, updated_at = ? WHERE identity = ? AND sso_user = ?`)
          .run(mutation.oauthAttemptId, timestamp, identity, identity).changes === 1;
      }
      return this.db.prepare(`UPDATE proxy_accounts SET copilot_oauth_token = NULL,
        copilot_oauth_status = 'expired', copilot_oauth_attempt_id = NULL,
        copilot_oauth_updated_at = ?, updated_at = ?
        WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'`)
        .run(timestamp, timestamp, identity, mutation.expectedToken).changes === 1;
    }).immediate();
  }

  claimLoginDispatch(identity: string, fence: WorkerCredentialFence, owner: string, limit: number): boolean {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserPoolError(400, 'invalid_login_limit');
    return this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || row.state !== 'provisioning' || row.stage !== 'oauth-starting' || !this.matchesFence(row, fence)
        || !this.matchesOwner(owner) || this.hasHolds(identity)) return false;
      const occupied = (this.db.prepare(`SELECT COUNT(*) n FROM user_pool_accounts
        WHERE stage IN ('oauth-dispatch', 'oauth-wait')`).get() as { n: number }).n;
      if (occupied >= limit) return false;
      return this.update(identity, { stage: 'oauth-dispatch' }, fence, owner);
    }).immediate();
  }

  listLoginReservations(): Inventory[] {
    return this.db.prepare(`SELECT * FROM user_pool_accounts WHERE stage IN ('oauth-dispatch', 'oauth-wait')
      AND (state = 'disabled' OR (state = 'failed' AND attempts >= 3)) ORDER BY ordinal LIMIT 100`).all() as Inventory[];
  }

  releaseLoginReservation(identity: string, fence: Inventory, owner: string, outcome: 'success' | 'failed'): boolean {
    return this.db.transaction(() => {
      const row = this.inventory(identity);
      const keys: (keyof Inventory)[] = ['attempt_id', 'generation', 'stage', 'state', 'attempts', 'task_id', 'oauth_attempt_id', 'sso_created_at'];
      if (!row || !['success', 'failed'].includes(outcome) || !['oauth-dispatch', 'oauth-wait'].includes(row.stage)
        || !(row.state === 'disabled' || row.state === 'failed' && row.attempts >= 3)
        || keys.some(key => (row[key] ?? null) !== (fence[key] ?? null))
        || !this.matchesOwner(owner) || this.settings().paused || this.hasHolds(identity)) return false;
      return this.db.prepare(`UPDATE user_pool_accounts SET stage=?, task_id=NULL, oauth_attempt_id=NULL,
        generation=generation+1 WHERE identity=?`).run(outcome === 'success' ? 'warmup' : 'synced', identity).changes === 1;
    }).immediate();
  }

  claimOwner(owner: string): boolean {
    const now = this.now();
    return this.db.prepare(`
      UPDATE user_pool_settings SET owner = ?, owner_until = ?
      WHERE id = 1 AND (owner = ? OR owner_until <= ?)
    `).run(owner, now + 30000, owner, now).changes === 1;
  }

  renewOwner(owner: string): boolean {
    const now = this.now();
    return this.db.prepare(`UPDATE user_pool_settings SET owner_until = ?
      WHERE id = 1 AND owner = ? AND owner_until > ?`).run(now + 30000, owner, now).changes === 1;
  }

  releaseOwner(owner: string): void {
    this.db.prepare('UPDATE user_pool_settings SET owner = NULL, owner_until = 0 WHERE id = 1 AND owner = ?')
      .run(owner);
  }

  event(action: string, identity?: string, caller?: string, leaseId?: string, detail?: string): void {
    this.recordEvent({ action, identity, caller, leaseId, detail });
  }

  private recordEvent(fields: EventFields): void {
    this.db.prepare(`
      INSERT INTO user_pool_events(at, action, identity, caller_id, lease_id, detail, enterprise_id)
      VALUES (@at, @action, @identity, @caller, @leaseId, @detail, COALESCE(
        @enterpriseId,
        (SELECT enterprise_id FROM user_pool_accounts WHERE identity = @identity)
      ))
    `).run({
      at: this.now(),
      action: fields.action,
      identity: fields.identity ?? null,
      caller: fields.caller ?? null,
      leaseId: fields.leaseId ?? null,
      detail: fields.detail ?? null,
      enterpriseId: fields.enterpriseId ?? null,
    });
    // An index lookup, not an aggregate: replenishment and admission write events too.
    this.db.prepare(`
      DELETE FROM user_pool_events
      WHERE id <= (
        SELECT id
        FROM user_pool_events
        ORDER BY id DESC
        LIMIT 1
      ) - 10000
    `).run();
  }

  page(kind: PoolList, query: PoolPageQuery): PoolPage {
    return this.db.transaction(() => {
      const sql = poolPageSql(kind, query, this.now());
      const total = (this.db.prepare(sql.countSql).get(...sql.values) as { total: number }).total;
      const items = this.db.prepare(sql.itemsSql).all(...sql.values, query.pageSize, (query.page - 1) * query.pageSize);
      return { items, total, page: query.page, pageSize: query.pageSize };
    })();
  }

  /** The enterprise's events; global events (settings, ownership) have no enterprise and are not listed. */
  events(enterpriseId: string): unknown[] {
    return this.db.prepare(`
      SELECT *
      FROM user_pool_events
      WHERE enterprise_id = ?
      ORDER BY id DESC
      LIMIT 200
    `).all(enterpriseId);
  }

  accounts(enterpriseId: string): unknown[] {
    return this.db.prepare(`
      SELECT p.*, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id = l.lease_id AND h.expires_at > @now)
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h
           WHERE h.member_identity = p.identity AND h.expires_at > @now) AS active_requests
      FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity = p.identity
      LEFT JOIN user_pool_leases l ON l.member_identity = p.identity
      WHERE p.enterprise_id = @enterpriseId
      ORDER BY p.ordinal
      LIMIT 1000
    `).all({ now: this.now(), enterpriseId });
  }

  leases(enterpriseId: string): Array<Lease & { active_requests: number }> {
    return this.db.prepare(`
      SELECT l.*, p.enterprise_id,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id = l.lease_id AND h.expires_at > @now)
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h
           WHERE h.member_identity = l.member_identity AND h.expires_at > @now) AS active_requests
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity = l.member_identity
      WHERE p.enterprise_id = @enterpriseId
      ORDER BY l.assigned_at DESC, l.lease_id
      LIMIT 1000
    `).all({ now: this.now(), enterpriseId }) as Array<Lease & { active_requests: number }>;
  }

  inventory(identity: string): Inventory | undefined {
    return this.db.prepare('SELECT * FROM user_pool_accounts WHERE identity = ?').get(identity) as Inventory | undefined;
  }

  /** `sso_user` is unique only within an enterprise (design §5.3). */
  managesSsoUser(enterpriseId: string, ssoUser: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity = p.identity
      WHERE p.enterprise_id = ?
        AND lower(a.sso_user) = lower(?)
      LIMIT 1
    `).get(enterpriseId, ssoUser));
  }

  /** One enterprise's counts, or the whole pool's when `enterpriseId` is undefined. */
  counts(enterpriseId?: string): Record<string, number> {
    return this.db.transaction(() => {
      this.reclaim();
      const result: Record<string, number> = {
        total: 0, ready_idle: 0, provisioning: 0, failed: 0, cooling: 0,
        disabled: 0, leased: 0, provisional: 0, catalog_requests: 0,
      };
      for (const row of this.stateCounts(memberScope(enterpriseId, 'WHERE'))) {
        result[row.state] = row.n;
        result.total += row.n;
      }
      for (const row of this.phaseCounts(memberScope(enterpriseId, 'WHERE'))) {
        result[row.phase === 'active' ? 'leased' : 'provisional'] = row.n;
      }
      result.ready_idle = this.readyIdleCount(memberScope(enterpriseId, 'AND'));
      result.catalog_requests = this.catalogCount(memberScope(enterpriseId, 'WHERE'));
      return result;
    }).immediate();
  }

  private stateCounts(scope: MemberScope): { state: string; n: number }[] {
    return this.db.prepare(`
      SELECT p.state, COUNT(*) n
      FROM user_pool_accounts p
      ${scope.sql}
      GROUP BY p.state
    `).all(...scope.values) as { state: string; n: number }[];
  }

  private phaseCounts(scope: MemberScope): { phase: string; n: number }[] {
    return this.db.prepare(`
      SELECT l.phase, COUNT(*) n
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity = l.member_identity
      ${scope.sql}
      GROUP BY l.phase
    `).all(...scope.values) as { phase: string; n: number }[];
  }

  private readyIdleCount(scope: MemberScope): number {
    return (this.db.prepare(`
      SELECT COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
      WHERE p.state = 'ready' AND p.verified_at IS NOT NULL AND a.copilot_oauth_status = 'valid'
        AND length(a.copilot_oauth_token) > 0
        AND NOT EXISTS (SELECT 1 FROM user_pool_leases l WHERE l.member_identity = p.identity)
        AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
        ${scope.sql}
    `).get(...scope.values) as { n: number }).n;
  }

  private catalogCount(scope: MemberScope): number {
    return (this.db.prepare(`
      SELECT COUNT(*) n
      FROM user_pool_catalog_holds h
      JOIN user_pool_accounts p ON p.identity = h.member_identity
      ${scope.sql}
    `).get(...scope.values) as { n: number }).n;
  }

  reclaim(): void {
    this.db.transaction(() => {
      const now = this.now();
      this.db.prepare('DELETE FROM user_pool_holds WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM user_pool_catalog_holds WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM user_pool_catalog_cooldowns WHERE expires_at <= ?').run(now);
      this.db.prepare(`
        UPDATE user_pool_accounts SET state = 'ready', cooldown_until = 0, updated_at = ?
        WHERE state = 'cooling' AND cooldown_until <= ?
      `).run(now, now);
      const invalid = this.db.prepare(`
        SELECT p.identity FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
        WHERE p.state IN ('ready', 'cooling')
          AND (a.copilot_oauth_status <> 'valid' OR COALESCE(length(a.copilot_oauth_token), 0) = 0)
      `).all() as { identity: string }[];
      for (const row of invalid) {
        this.update(row.identity, {
          state: 'failed', last_error: 'credential_not_valid', retry_at: now + 30000,
        });
      }
      const unverified = this.db.prepare(`
        SELECT identity FROM user_pool_accounts WHERE state = 'ready' AND verified_at IS NULL
      `).all() as { identity: string }[];
      for (const row of unverified) {
        this.update(row.identity, {
          state: 'failed', stage: 'warmup', last_error: 'credential_not_verified', retry_at: now,
        });
      }
      const expired = this.db.prepare(`
        SELECT l.*, p.enterprise_id FROM user_pool_leases l JOIN user_pool_accounts p ON p.identity = l.member_identity
        WHERE l.expires_at <= ? AND p.state <> 'cooling'
      `).all(now) as Lease[];
      for (const lease of expired) {
        if (this.hasHolds(lease.member_identity)) continue;
        this.db.prepare('DELETE FROM user_pool_leases WHERE lease_id = ?').run(lease.lease_id);
        this.event('lease_expired', lease.member_identity, lease.caller_id, lease.lease_id);
      }
    }).immediate();
  }

  acquire(caller: string, signal?: AbortSignal, requestTimeoutMs?: number): HeldLease {
    normalizeCaller(caller);
    const holdTimeoutMs = inferenceHoldTimeoutMs(requestTimeoutMs, this.options.requestTimeoutMs);
    signal?.throwIfAborted();
    return this.admit(() => {
      this.assertCallerNotCooling(caller);
      const now = this.now();
      // An existing lease keeps its member and enterprise, even while that enterprise drains.
      let lease = this.callerLease(caller);
      if (lease) {
        this.assertReady(lease.member_identity);
        // An expired lease stays pinned until its existing requests finish, but cannot
        // admit an endless chain of new requests that circumvents the provisional TTL.
        if (lease.expires_at <= now) throw new UserPoolError(503, 'lease_draining', 1);
      } else {
        const member = this.availableMember(caller);
        this.assertReady(member.identity);
        lease = this.insertLease(caller, member, now);
      }
      return this.hold(lease, 'lease', holdTimeoutMs);
    });
  }

  /** Discovery pins one member only for the request and never creates/renews a caller lease. */
  acquireCatalog(caller: string, signal?: AbortSignal): HeldLease {
    normalizeCaller(caller);
    signal?.throwIfAborted();
    return this.admit(() => {
      this.assertCallerNotCooling(caller);
      const existing = this.callerLease(caller);
      // A draining enterprise admits no new catalog hold, not even on an existing lease.
      if (existing) assertEnterpriseActive(this.enterpriseState(existing.enterprise_id));
      const member = existing ? leaseMember(existing) : this.availableMember(caller);
      this.assertReady(member.identity);
      if (existing && existing.expires_at <= this.now()) throw new UserPoolError(503, 'lease_draining', 1);
      const now = this.now();
      return this.hold({
        caller_id: caller, member_identity: member.identity, enterprise_id: member.enterprise_id,
        lease_id: randomUUID(), phase: 'provisional', assigned_at: now, last_success_at: null,
        expires_at: now + this.options.requestTimeoutMs,
      }, 'catalog');
    });
  }

  private callerLease(caller: string): Lease | undefined {
    return this.db.prepare(`
      SELECT l.*, p.enterprise_id
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity = l.member_identity
      WHERE l.caller_id = ?
    `).get(caller) as Lease | undefined;
  }

  private insertLease(caller: string, member: PoolMember, now: number): Lease {
    const lease: Lease = {
      caller_id: caller, member_identity: member.identity, enterprise_id: member.enterprise_id,
      lease_id: randomUUID(), phase: 'provisional', assigned_at: now, last_success_at: null,
      expires_at: now + this.options.provisionalSeconds * 1000,
    };
    this.db.prepare(`
      INSERT INTO user_pool_leases
        (caller_id, member_identity, lease_id, phase, assigned_at, last_success_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(caller, member.identity, lease.lease_id, lease.phase, now, lease.expires_at);
    this.event('lease_acquired', member.identity, caller, lease.lease_id);
    return lease;
  }

  private admit(acquire: () => HeldLease): HeldLease {
    const result = this.db.transaction((): HeldLease | UserPoolError => {
      this.reclaim();
      try {
        // Roll back only the admission on expected exhaustion/unavailability. Keep the
        // reclamation transaction, otherwise a rejected request undoes quarantine.
        return this.db.transaction(acquire)();
      } catch (error) {
        if (error instanceof UserPoolError) return error;
        throw error;
      }
    }).immediate();
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  private assertCallerNotCooling(caller: string): void {
    const row = this.db.prepare('SELECT expires_at FROM user_pool_catalog_cooldowns WHERE caller_id=? AND expires_at>?')
      .get(caller, this.now()) as { expires_at: number } | undefined;
    if (row) throw new UserPoolError(429, 'member_cooling', Math.max(1, Math.ceil((row.expires_at - this.now()) / 1000)));
  }

  /**
   * Design §5.8 admission: a catalog hold keeps its member (503 enterprise_draining when its enterprise is no longer
   * active); otherwise the caller's ranking of the active enterprises, then one indexed pick per enterprise.
   */
  private availableMember(caller: string): PoolMember {
    // Parallel discovery and inference for the same caller must converge on one member.
    const catalog = this.db.prepare(`
      SELECT h.member_identity AS identity, p.enterprise_id, e.state
      FROM user_pool_catalog_holds h
      JOIN user_pool_accounts p ON p.identity = h.member_identity
      JOIN proxy_enterprises e ON e.id = p.enterprise_id
      WHERE h.caller_id = ?
      ORDER BY h.assigned_at
      LIMIT 1
    `).get(caller) as (PoolMember & { state: string }) | undefined;
    if (catalog) {
      assertEnterpriseActive(catalog.state);
      return { identity: catalog.identity, enterprise_id: catalog.enterprise_id };
    }
    for (const enterpriseId of admissionOrder(this.schedulingEnterprises(), caller)) {
      const identity = this.idleMember(enterpriseId);
      if (identity) return { identity, enterprise_id: enterpriseId };
    }
    throw new UserPoolError(429, 'pool_exhausted', this.options.retryAfterSeconds);
  }

  /** The least recently used leasable member of one enterprise (idx_user_pool_accounts_enterprise_state). */
  private idleMember(enterpriseId: string): string | undefined {
    const row = this.db.prepare(`
      SELECT p.identity
      FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity = p.identity
      WHERE p.enterprise_id = ?
        AND p.state = 'ready'
        AND p.verified_at IS NOT NULL
        AND a.copilot_oauth_status = 'valid'
        AND length(a.copilot_oauth_token) > 0
        AND NOT EXISTS (SELECT 1 FROM user_pool_leases l WHERE l.member_identity = p.identity)
        AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
      ORDER BY p.updated_at, p.ordinal
      LIMIT 1
    `).get(enterpriseId) as { identity: string } | undefined;
    return row?.identity;
  }

  private assertReady(identity: string): void {
    const member = this.inventory(identity);
    if (member?.state === 'cooling') {
      throw new UserPoolError(429, 'member_cooling', Math.max(1, Math.ceil((member.cooldown_until - this.now()) / 1000)));
    }
    if (member?.state !== 'ready' || member.verified_at === null) throw new UserPoolError(503, 'member_unavailable');
    const valid = this.db.prepare(`
      SELECT 1 FROM proxy_accounts WHERE identity = ?
        AND copilot_oauth_status = 'valid' AND length(copilot_oauth_token) > 0
    `).get(identity);
    if (!valid) throw new UserPoolError(503, 'member_unavailable');
  }

  private hold(lease: Lease, kind: 'lease' | 'catalog', timeoutMs = this.options.requestTimeoutMs): HeldLease {
    const requestId = randomUUID();
    const deadline = this.now() + timeoutMs;
    const generation = this.inventory(lease.member_identity)!.generation;
    if (kind === 'catalog') {
      this.db.prepare(`
        INSERT INTO user_pool_catalog_holds
          (request_id, lease_id, caller_id, member_identity, assigned_at, expires_at, deadline_at, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(requestId, lease.lease_id, lease.caller_id, lease.member_identity, lease.assigned_at,
        deadline + HOLD_DRAIN_MS, deadline, generation);
    } else {
      this.db.prepare(`
        INSERT INTO user_pool_holds(request_id, lease_id, expires_at, deadline_at, generation)
        VALUES (?, ?, ?, ?, ?)
      `).run(requestId, lease.lease_id, deadline + HOLD_DRAIN_MS, deadline, generation);
    }
    return { ...lease, request_id: requestId, kind, deadline_at: deadline };
  }

  private heldRow(held: HeldLease): HoldRow | undefined {
    const row = (held.kind === 'catalog'
      ? this.db.prepare('SELECT * FROM user_pool_catalog_holds WHERE request_id = ? AND lease_id = ?')
      : this.db.prepare(`
          SELECT h.*, l.member_identity, l.caller_id FROM user_pool_holds h
          JOIN user_pool_leases l ON l.lease_id = h.lease_id WHERE h.request_id = ? AND h.lease_id = ?
        `)).get(held.request_id, held.lease_id) as HoldRow | undefined;
    return row?.member_identity === held.member_identity && row.caller_id === held.caller_id ? row : undefined;
  }

  private currentHold(held: HeldLease): HoldRow | undefined {
    const row = this.heldRow(held);
    if (!row || row.deadline_at <= this.now() || row.expires_at <= this.now()) return undefined;
    const member = this.inventory(row.member_identity);
    if (!member || member.generation !== row.generation || !['ready', 'cooling'].includes(member.state)) return undefined;
    const credential = this.db.prepare(`
      SELECT 1 FROM proxy_accounts WHERE identity = ?
        AND copilot_oauth_status = 'valid' AND length(copilot_oauth_token) > 0
    `).get(row.member_identity);
    return credential ? row : undefined;
  }

  /** False means the runtime must abort. Heartbeats never extend the absolute deadline. */
  heartbeat(held: HeldLease): boolean {
    return Boolean(this.currentHold(held));
  }

  recoverUnauthorized(held: HeldLease, expectedToken: string): boolean {
    return this.db.transaction(() => {
      if (!this.currentHold(held)) return false;
      const identity = held.member_identity;
      const member = this.inventory(identity)!;
      const now = this.now();
      const invalidated = this.db.prepare(`
        UPDATE proxy_accounts SET copilot_oauth_token = NULL, copilot_oauth_status = 'expired',
          copilot_oauth_attempt_id = NULL, copilot_oauth_updated_at = ?, updated_at = ?
        WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
      `).run(new Date(now).toISOString(), new Date(now).toISOString(), identity, expectedToken).changes;
      if (!invalidated) return false;
      const windowAt = member.reauth_window_at ?? 0;
      const resetWindow = windowAt === 0 || now - windowAt >= REAUTH_WINDOW_MS;
      const count = resetWindow ? 0 : member.reauth_count ?? 0;
      const exhausted = count >= REAUTH_MAX_CYCLES;
      this.update(identity, {
        state: 'failed', stage: 'synced', attempt_id: randomUUID(),
        oauth_attempt_id: null, task_id: null, verified_at: null,
        attempts: exhausted ? 3 : 0,
        last_error: exhausted ? 'oauth_reauth_limit_reached' : 'upstream_unauthorized',
        retry_at: now,
      });
      this.db.prepare('UPDATE user_pool_accounts SET reauth_count=?,reauth_window_at=? WHERE identity=?')
        .run(exhausted ? count : count + 1, resetWindow ? now : windowAt, identity);
      this.event(exhausted ? 'oauth_reauth_blocked' : 'oauth_reauth_scheduled', identity,
        held.caller_id, held.lease_id, exhausted ? 'oauth_reauth_limit_reached' : 'upstream_unauthorized');
      return true;
    }).immediate();
  }

  /** Optional held fence is required for request-originated quarantine/cooldown reports. */
  quarantine(identity: string, code: string, held?: HeldLease): boolean {
    return this.db.transaction(() => {
      if (held && (held.member_identity !== identity || !this.currentHold(held))) return false;
      const member = this.inventory(identity);
      if (!member || member.state === 'disabled') return false;
      this.update(identity, { state: 'failed', last_error: code, attempts: 3, retry_at: this.now() + 300000 });
      this.event('member_quarantined', identity, held?.caller_id, held?.lease_id, code);
      return true;
    }).immediate();
  }

  cool(identity: string, seconds: number, held?: HeldLease): boolean {
    return this.db.transaction(() => {
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UserPoolError(400, 'invalid_cooldown');
      if (held && (held.member_identity !== identity || !this.currentHold(held))) return false;
      const member = this.inventory(identity);
      if (!member || !['ready', 'cooling'].includes(member.state)) return false;
      const until = this.now() + Math.ceil(Math.min(seconds, 2592000)) * 1000;
      this.update(identity, { state: 'cooling', cooldown_until: Math.max(member.cooldown_until, until) });
      this.db.prepare(`INSERT INTO user_pool_catalog_cooldowns(caller_id,member_identity,expires_at)
        SELECT DISTINCT caller_id,member_identity,? FROM user_pool_catalog_holds WHERE member_identity=?
        ON CONFLICT(caller_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`)
        .run(Math.max(member.cooldown_until, until), identity);
      this.event('member_cooling', identity, held?.caller_id, held?.lease_id);
      return true;
    }).immediate();
  }

  finish(held: HeldLease, success: boolean): void {
    this.db.transaction(() => {
      const row = this.heldRow(held);
      if (!row) return; // Includes duplicate completions and completions from a prior lease.
      if (success && held.kind !== 'catalog' && this.currentHold(held)) {
        const now = this.now();
        const changed = this.db.prepare(`
          UPDATE user_pool_leases SET phase = 'active', last_success_at = ?, expires_at = ?
          WHERE lease_id = ? AND caller_id = ? AND member_identity = ?
            AND member_identity IN (SELECT identity FROM user_pool_accounts WHERE state = 'ready')
        `).run(now, now + this.settings().lease_seconds * 1000,
          held.lease_id, held.caller_id, held.member_identity).changes;
        if (changed) this.event('lease_renewed', held.member_identity, held.caller_id, held.lease_id);
      }
      const table = held.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds';
      this.db.prepare(`DELETE FROM ${table} WHERE request_id = ? AND lease_id = ?`)
        .run(held.request_id, held.lease_id);
      this.reclaim();
    }).immediate();
  }

  release(leaseId: string): void {
    this.db.transaction(() => {
      const lease = this.db.prepare('SELECT * FROM user_pool_leases WHERE lease_id = ?')
        .get(leaseId) as Lease | undefined;
      if (!lease) throw new UserPoolError(404, 'lease_not_found');
      if (this.hasHolds(lease.member_identity)) throw new UserPoolError(409, 'lease_in_use');
      this.db.prepare('DELETE FROM user_pool_leases WHERE lease_id = ?').run(leaseId);
      this.event('lease_released', lease.member_identity, lease.caller_id, lease.lease_id);
    }).immediate();
  }

  hasHolds(identity: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id = h.lease_id
      WHERE l.member_identity = @identity AND h.expires_at > @now
      UNION ALL SELECT 1 FROM user_pool_catalog_holds
      WHERE member_identity = @identity AND expires_at > @now LIMIT 1
    `).get({ identity, now: this.now() }));
  }

  releaseInactive(identity: string): void {
    this.db.transaction(() => {
      if (!this.hasHolds(identity)) {
        this.db.prepare('DELETE FROM user_pool_leases WHERE member_identity = ?').run(identity);
      }
    }).immediate();
  }

  /** Reserves at most one member, in the enterprise the shared ranking picks among `eligibleEnterpriseIds`. */
  reserve(eligibleEnterpriseIds: readonly string[]): Inventory | undefined {
    const eligible = eligibleEnterprises(eligibleEnterpriseIds);
    const result = this.db.transaction((): Inventory | UserPoolError | undefined => {
      const [enterpriseId] = this.planBatch(eligible, 1);
      return enterpriseId === undefined ? undefined : this.reserveCandidate(enterpriseId);
    }).immediate();
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  /**
   * One replenishment batch (design §5.8). `eligibleEnterpriseIds`: active enterprises that may grow now (ready);
   * every active enterprise still counts in the share denominators. Returns the number of members reserved.
   */
  reserveDeficit(owner: string, eligibleEnterpriseIds: readonly string[]): number {
    const eligible = eligibleEnterprises(eligibleEnterpriseIds);
    return this.db.transaction(() => {
      if (!this.matchesOwner(owner)) return 0;
      let reserved = 0;
      for (const enterpriseId of this.planBatch(eligible, NAME_CAPACITY)) {
        if (this.reserveCandidate(enterpriseId) instanceof UserPoolError) break;
        reserved++;
      }
      return reserved;
    }).immediate();
  }

  /**
   * Lock order settings → enterprises → members (the SQLite write lock covers all). The batch's only aggregate
   * yields I and P; the enterprises are then chosen with in-memory counters by the shared `planCreations`.
   */
  private planBatch(eligible: ReadonlySet<string>, limit: number): string[] {
    const enterprises = this.schedulingEnterprises();
    this.reclaim();
    const query = poolSupplyQuery(this.now());
    const supply = this.db.prepare(query.sql).get(...query.values) as PoolSupply;
    const ordinal = this.nextOrdinal();
    return planReplenishment(enterprises, eligible, { supply, settings: this.settings(), ordinal, limit });
  }

  private nextOrdinal(): number {
    const row = this.db.prepare(`
      SELECT next_ordinal AS n
      FROM user_pool_settings
      WHERE id = 1
    `).get() as { n: number };
    return row.n;
  }

  private reserveCandidate(enterpriseId: string): Inventory | UserPoolError {
    let ordinal = (this.db.prepare('SELECT next_ordinal n FROM user_pool_settings WHERE id = 1')
      .get() as { n: number }).n;
    while (ordinal < NAME_CAPACITY) {
      const identity = accountName(ordinal++);
      this.db.prepare('UPDATE user_pool_settings SET next_ordinal = ? WHERE id = 1').run(ordinal);
      const collision = this.db.prepare(`
        SELECT 1 FROM proxy_accounts WHERE lower(identity) = lower(?) OR lower(sso_user) = lower(?)
      `).get(identity, identity);
      if (collision) continue;
      this.insertMember(identity, ordinal - 1, enterpriseId);
      this.event('name_reserved', identity);
      return this.inventory(identity)!;
    }
    return new UserPoolError(503, 'name_catalog_exhausted');
  }

  /** The member, its Proxy account and N_e += 1 are one write; names and ordinals stay global. */
  private insertMember(identity: string, ordinal: number, enterpriseId: string): void {
    const now = this.now();
    const timestamp = new Date(now).toISOString();
    this.db.prepare(`
      INSERT INTO proxy_accounts(identity, enterprise_id, sso_user, copilot_oauth_status, created_at, updated_at)
      VALUES (?, ?, ?, 'missing', ?, ?)
    `).run(identity, enterpriseId, identity, timestamp, timestamp);
    this.db.prepare(`
      INSERT INTO user_pool_accounts(identity, enterprise_id, ordinal, state, attempt_id, updated_at, retry_at)
      VALUES (?, ?, ?, 'provisioning', ?, ?, ?)
    `).run(identity, enterpriseId, ordinal, randomUUID(), now, now);
    incrementInventory(this.db, enterpriseId as EnterpriseId);
  }

  pending(excluded: readonly string[] = []): Inventory | undefined {
    const row = this.db.transaction(() => {
      this.reclaim();
      if (this.settings().paused) return undefined;
      const exclusion = excluded.length ? `AND p.identity NOT IN (${excluded.map(() => '?').join(',')})` : '';
      return this.db.prepare(`
        SELECT p.* FROM user_pool_accounts p WHERE retry_at <= ? AND (
          state = 'provisioning' OR (state = 'failed' AND attempts < 3
            AND COALESCE(last_error, '') NOT IN ('sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed')))
          ${exclusion}
          AND NOT EXISTS (SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id = h.lease_id
            WHERE l.member_identity = p.identity)
          AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
          AND ${LOGIN_CAPACITY_SQL}
        ORDER BY ${this.pendingSelection.orderSql()} LIMIT 1
      `).get(this.now(), ...excluded, this.options.loginMaxPending ?? 5) as Inventory | undefined;
    }).immediate();
    if (row) this.pendingSelection.selected();
    return row;
  }

  private matchesFence(row: Inventory, fence?: InventoryFence): boolean {
    if (fence === undefined) return true;
    if (typeof fence === 'string') return row.attempt_id === fence;
    return row.attempt_id === fence.attempt_id && row.generation === fence.generation
      && (fence.stage === undefined || row.stage === fence.stage);
  }

  private matchesOwner(owner?: string): boolean {
    return owner === undefined || Boolean(this.db.prepare(`
      SELECT 1 FROM user_pool_settings WHERE id = 1 AND owner = ? AND owner_until > ?
    `).get(owner, this.now()));
  }

  /** Pass an inventory snapshot (or legacy attempt_id) and owner to fence asynchronous worker results. */
  update(identity: string, patch: Partial<Inventory>, expected?: InventoryFence, owner?: string): boolean {
    return this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || row.state === 'disabled' || !this.matchesFence(row, expected) || !this.matchesOwner(owner)) return false;
      const entries = Object.entries(patch).filter(([key]) => INVENTORY_KEYS.includes(key));
      if (!entries.length) return true;
      if (patch.state === 'provisioning' && this.hasHolds(identity)) return false;
      const invalidating = patch.state !== undefined && ['failed', 'disabled', 'provisioning'].includes(patch.state)
        && patch.state !== row.state;
      this.db.prepare(`
        UPDATE user_pool_accounts SET ${entries.map(([key]) => `${key} = ?`).join(', ')}, updated_at = ?
          ${invalidating ? ', generation = generation + 1' : ''} WHERE identity = ?
      `).run(...entries.map(([, value]) => value ?? null), this.now(), identity);
      if (invalidating) {
        this.db.prepare('UPDATE user_pool_leases SET expires_at = MIN(expires_at, ?) WHERE member_identity = ?')
          .run(this.now(), identity);
      }
      return true;
    }).immediate();
  }

  fail(identity: string, code: string, expected?: InventoryFence, owner?: string, terminal = false): void {
    this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || row.state === 'disabled' || !this.matchesFence(row, expected) || !this.matchesOwner(owner)) return;
      const attempts = terminal ? Math.max(3, row.attempts + 1) : row.attempts + 1;
      this.update(identity, {
        state: 'failed', attempts, last_error: code,
        retry_at: this.now() + Math.min(300, 30 * 2 ** (attempts - 1)) * 1000,
      });
      this.event('provision_failed', identity, undefined, undefined, code);
    }).immediate();
  }

  disable(identity: string): void {
    this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row) throw new UserPoolError(404, 'member_not_found');
      if (row.state === 'disabled') return;
      this.update(identity, { state: 'disabled', attempt_id: randomUUID() });
      this.releaseInactive(identity);
      this.event('member_disabled', identity);
    }).immediate();
  }

  retry(identity: string): void {
    this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row) throw new UserPoolError(404, 'member_not_found');
      if (this.hasHolds(identity) || !['failed', 'disabled'].includes(row.state)) {
        throw new UserPoolError(409, 'member_in_use');
      }
      if (MANUAL_ERRORS.includes(row.last_error ?? '')) {
        throw new UserPoolError(409, 'manual_reconciliation_required');
      }
      // Only explicit retry may leave the disabled state. Retain uncertain stages/tasks;
      // the provisioner must reconcile them rather than silently dispatching duplicates.
      this.releaseInactive(identity);
      this.db.prepare(`
        UPDATE user_pool_accounts SET state = 'provisioning', attempts = 0, retry_at = 0,
          last_error = NULL, cooldown_until = 0, verified_at = NULL, generation = generation + 1,
          attempt_id = ?, stage = ?, updated_at = ? WHERE identity = ?
      `).run(randomUUID(), row.stage === 'ready' ? 'warmup' : row.stage, this.now(), identity);
      this.event('member_retry', identity);
    }).immediate();
  }
}

function memberScope(enterpriseId: string | undefined, keyword: 'WHERE' | 'AND'): MemberScope {
  if (enterpriseId === undefined) return { sql: '', values: [] };
  return { sql: `${keyword} p.enterprise_id = ?`, values: [enterpriseId] };
}

function leaseMember(lease: Lease): PoolMember {
  return { identity: lease.member_identity, enterprise_id: lease.enterprise_id };
}
