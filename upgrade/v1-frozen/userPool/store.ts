import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PoolConfig } from './config.js';
import { normalizeCaller, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { poolPageSql, type PoolList, type PoolPage, type PoolPageQuery } from './paging.js';
import type { WorkerCredentialFence, WorkerCredentialMutation } from './storage.js';
import { LOGIN_CAPACITY_SQL, PendingSelection } from './scheduling.js';
import { inferenceHoldTimeoutMs } from './inferenceTimeout.js';

export interface Inventory {
  identity: string;
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

export interface PoolSettings {
  version: number;
  idle_target: number;
  max_accounts: number;
  lease_seconds: number;
  paused: number;
}

export type InventoryFence = string | (Pick<Inventory, 'attempt_id' | 'generation'> & Partial<Pick<Inventory, 'stage'>>);

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
const SETTING_KEYS = ['idle_target', 'max_accounts', 'lease_seconds', 'paused'];
const INVENTORY_KEYS = [
  'state', 'stage', 'attempt_id', 'oauth_attempt_id', 'sso_created_at', 'task_id', 'attempts', 'retry_at',
  'last_error', 'cooldown_until', 'verified_at',
];

export class UserPoolStore {
  private readonly pendingSelection = new PendingSelection();

  constructor(private readonly db: Database.Database, private readonly options: PoolConfig) {
    db.transaction(() => {
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
          generation INTEGER NOT NULL DEFAULT 0,
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
          identity TEXT, caller_id TEXT, lease_id TEXT, detail TEXT
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
      db.prepare(`
        INSERT OR IGNORE INTO user_pool_settings
          (id, idle_target, max_accounts, lease_seconds, account_domain) VALUES (1, ?, ?, ?, ?)
      `).run(options.idleTarget, options.maxAccounts, options.leaseSeconds, options.accountDomain);
      const persisted = db.prepare('SELECT account_domain FROM user_pool_settings WHERE id = 1')
        .get() as { account_domain: string };
      if (persisted.account_domain !== options.accountDomain) {
        throw new Error('Pool account email domain differs from persisted inventory');
      }
    }).immediate();
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
      SELECT version, idle_target, max_accounts, lease_seconds, paused FROM user_pool_settings WHERE id = 1
    `).get() as PoolSettings;
  }

  updateSettings(version: number, patch: Partial<PoolSettings>): PoolSettings {
    return this.db.transaction(() => {
      if (!Number.isSafeInteger(version) || !patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some((key) => !SETTING_KEYS.includes(key))) {
        throw new UserPoolError(400, 'invalid_pool_settings');
      }
      const current = this.settings();
      if (version !== current.version) throw new UserPoolError(409, 'settings_version_conflict');
      const next = { ...current, ...patch };
      if (!Number.isInteger(next.idle_target) || next.idle_target < 0 || next.idle_target > next.max_accounts
        || !Number.isInteger(next.max_accounts) || next.max_accounts < 1 || next.max_accounts > NAME_CAPACITY
        || !Number.isInteger(next.lease_seconds) || next.lease_seconds < 60 || next.lease_seconds > 2592000
        || ![0, 1].includes(next.paused)) {
        throw new UserPoolError(400, 'invalid_pool_settings');
      }
      // Lowering the cap stops growth; it never deletes accounts or evicts active callers.
      this.db.prepare(`
        UPDATE user_pool_settings SET idle_target = ?, max_accounts = ?, lease_seconds = ?,
          paused = ?, version = version + 1 WHERE id = 1
      `).run(next.idle_target, next.max_accounts, next.lease_seconds, next.paused);
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
    this.db.prepare(`
      INSERT INTO user_pool_events(at, action, identity, caller_id, lease_id, detail) VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.now(), action, identity ?? null, caller ?? null, leaseId ?? null, detail ?? null);
    this.db.prepare(`
      DELETE FROM user_pool_events WHERE id <= (SELECT COALESCE(MAX(id), 0) - 10000 FROM user_pool_events)
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

  events(): unknown[] {
    return this.db.prepare('SELECT * FROM user_pool_events ORDER BY id DESC LIMIT 200').all();
  }

  accounts(): unknown[] {
    return this.db.prepare(`
      SELECT p.*, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id = l.lease_id AND h.expires_at > @now)
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h
           WHERE h.member_identity = p.identity AND h.expires_at > @now) AS active_requests
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
      LEFT JOIN user_pool_leases l ON l.member_identity = p.identity ORDER BY p.ordinal LIMIT 1000
    `).all({ now: this.now() });
  }

  leases(): Array<Lease & { active_requests: number }> {
    return this.db.prepare(`SELECT l.*,
      (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>@now)
      + (SELECT COUNT(*) FROM user_pool_catalog_holds h WHERE h.member_identity=l.member_identity AND h.expires_at>@now) AS active_requests
      FROM user_pool_leases l ORDER BY assigned_at DESC, lease_id LIMIT 1000`)
      .all({ now: this.now() }) as Array<Lease & { active_requests: number }>;
  }

  inventory(identity: string): Inventory | undefined {
    return this.db.prepare('SELECT * FROM user_pool_accounts WHERE identity = ?').get(identity) as Inventory | undefined;
  }

  managesSsoUser(ssoUser: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      WHERE lower(a.sso_user)=lower(?) LIMIT 1`).get(ssoUser));
  }

  counts(): Record<string, number> {
    return this.db.transaction(() => {
      this.reclaim();
      const result: Record<string, number> = {
        total: 0, ready_idle: 0, provisioning: 0, failed: 0, cooling: 0,
        disabled: 0, leased: 0, provisional: 0, catalog_requests: 0,
      };
      const rows = this.db.prepare('SELECT state, COUNT(*) n FROM user_pool_accounts GROUP BY state')
        .all() as { state: string; n: number }[];
      for (const row of rows) {
        result[row.state] = row.n;
        result.total += row.n;
      }
      const phases = this.db.prepare('SELECT phase, COUNT(*) n FROM user_pool_leases GROUP BY phase')
        .all() as { phase: string; n: number }[];
      for (const row of phases) result[row.phase === 'active' ? 'leased' : 'provisional'] = row.n;
      result.ready_idle = (this.db.prepare(`
        SELECT COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
        WHERE p.state = 'ready' AND p.verified_at IS NOT NULL AND a.copilot_oauth_status = 'valid' AND length(a.copilot_oauth_token) > 0
          AND NOT EXISTS (SELECT 1 FROM user_pool_leases l WHERE l.member_identity = p.identity)
          AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
      `).get() as { n: number }).n;
      result.catalog_requests = (this.db.prepare('SELECT COUNT(*) n FROM user_pool_catalog_holds')
        .get() as { n: number }).n;
      return result;
    }).immediate();
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
        SELECT l.* FROM user_pool_leases l JOIN user_pool_accounts p ON p.identity = l.member_identity
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
      let lease = this.db.prepare('SELECT * FROM user_pool_leases WHERE caller_id = ?')
        .get(caller) as Lease | undefined;
      if (lease) {
        this.assertReady(lease.member_identity);
        // An expired lease stays pinned until its existing requests finish, but cannot
        // admit an endless chain of new requests that circumvents the provisional TTL.
        if (lease.expires_at <= now) throw new UserPoolError(503, 'lease_draining', 1);
      } else {
        const identity = this.availableMember(caller);
        this.assertReady(identity);
        lease = {
          caller_id: caller, member_identity: identity, lease_id: randomUUID(), phase: 'provisional',
          assigned_at: now, last_success_at: null, expires_at: now + this.options.provisionalSeconds * 1000,
        };
        this.db.prepare(`
          INSERT INTO user_pool_leases
            (caller_id, member_identity, lease_id, phase, assigned_at, last_success_at, expires_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)
        `).run(caller, identity, lease.lease_id, lease.phase, now, lease.expires_at);
        this.event('lease_acquired', identity, caller, lease.lease_id);
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
      const existing = this.db.prepare('SELECT * FROM user_pool_leases WHERE caller_id = ?')
        .get(caller) as Lease | undefined;
      const identity = existing?.member_identity ?? this.availableMember(caller);
      this.assertReady(identity);
      if (existing && existing.expires_at <= this.now()) throw new UserPoolError(503, 'lease_draining', 1);
      const now = this.now();
      return this.hold({
        caller_id: caller, member_identity: identity, lease_id: randomUUID(), phase: 'provisional',
        assigned_at: now, last_success_at: null, expires_at: now + this.options.requestTimeoutMs,
      }, 'catalog');
    });
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

  private availableMember(caller: string): string {
    // Parallel discovery and inference for the same caller must converge on one member.
    const catalog = this.db.prepare(`
      SELECT member_identity FROM user_pool_catalog_holds WHERE caller_id = ? ORDER BY assigned_at LIMIT 1
    `).get(caller) as { member_identity: string } | undefined;
    if (catalog) return catalog.member_identity;
    const row = this.db.prepare(`
      SELECT p.identity FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
      WHERE p.state = 'ready' AND p.verified_at IS NOT NULL AND a.copilot_oauth_status = 'valid' AND length(a.copilot_oauth_token) > 0
        AND NOT EXISTS (SELECT 1 FROM user_pool_leases l WHERE l.member_identity = p.identity)
        AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
      ORDER BY p.updated_at, p.ordinal LIMIT 1
    `).get() as { identity: string } | undefined;
    if (!row) throw new UserPoolError(429, 'pool_exhausted', this.options.retryAfterSeconds);
    return row.identity;
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

  reserve(): Inventory | undefined {
    const result = this.db.transaction((): Inventory | UserPoolError | undefined => {
      if (this.reservationDeficit() === 0) return undefined;
      return this.reserveCandidate();
    }).immediate();
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  reserveDeficit(owner: string): number {
    return this.db.transaction(() => {
      if (!this.matchesOwner(owner)) return 0;
      const deficit = this.reservationDeficit();
      let reserved = 0;
      for (; reserved < deficit; reserved++) {
        const row = this.reserveCandidate();
        if (row instanceof UserPoolError) break;
      }
      return reserved;
    }).immediate();
  }

  private reservationDeficit(): number {
    const settings = this.settings();
    const counts = this.counts();
    if (settings.paused) return 0;
    // Backing-off repairs already represent future capacity. Do not reserve a
    // replacement on each failure and then overfill when those repairs succeed.
    const retrying = (this.db.prepare(`
      SELECT COUNT(*) n FROM user_pool_accounts WHERE state = 'failed' AND attempts < 3
        AND COALESCE(last_error, '') NOT IN ('sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed')
    `).get() as { n: number }).n;
    return Math.max(0, Math.min(settings.max_accounts - counts.total,
      settings.idle_target - counts.ready_idle - counts.provisioning - retrying));
  }

  private reserveCandidate(): Inventory | UserPoolError {
    let ordinal = (this.db.prepare('SELECT next_ordinal n FROM user_pool_settings WHERE id = 1')
      .get() as { n: number }).n;
    while (ordinal < NAME_CAPACITY) {
      const identity = accountName(ordinal++);
      this.db.prepare('UPDATE user_pool_settings SET next_ordinal = ? WHERE id = 1').run(ordinal);
      const collision = this.db.prepare(`
        SELECT 1 FROM proxy_accounts WHERE lower(identity) = lower(?) OR lower(sso_user) = lower(?)
      `).get(identity, identity);
      if (collision) continue;
      const now = this.now();
      const timestamp = new Date(now).toISOString();
      this.db.prepare(`
        INSERT INTO proxy_accounts(identity, sso_user, copilot_oauth_status, created_at, updated_at)
        VALUES (?, ?, 'missing', ?, ?)
      `).run(identity, identity, timestamp, timestamp);
      this.db.prepare(`
        INSERT INTO user_pool_accounts(identity, ordinal, state, attempt_id, updated_at, retry_at)
        VALUES (?, ?, 'provisioning', ?, ?, ?)
      `).run(identity, ordinal - 1, randomUUID(), now, now);
      this.event('name_reserved', identity);
      return this.inventory(identity)!;
    }
    return new UserPoolError(503, 'name_catalog_exhausted');
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
