import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { toEnterpriseRecord } from '../db/enterpriseRepo.js';
import type { ProxyEnterpriseRecord } from '../db/storageTypes.js';
import type { PoolConfig } from './config.js';
import { normalizeCaller, normalizePoolConfig, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { poolConfigFingerprint, runMysqlPoolMigrations, validateMysqlPoolSchema } from './mysqlMigrations.js';
import { MYSQL_MIGRATION_LOCK_WAIT } from '../db/mysqlMigrationLock.js';
import { leaseMysqlConnection, MysqlDeadline, MysqlDeadlineError } from './mysqlDeadline.js';
import { acquireMysqlCaller, type MysqlCallerPermit } from './mysqlCallerGate.js';
import type { HeldLease, Inventory, InventoryFence, Lease, PoolSettings } from './store.js';
import type { PoolStore, WorkerCredentialFence, WorkerCredentialMutation } from './storage.js';
import type { PoolList, PoolPage, PoolPageQuery } from './paging.js';
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

type Connection = Pool | PoolConnection;
interface Tx { connection: PoolConnection; credentials?: Map<string, Credential | undefined> }
interface SettingsRow extends PoolSettings {
  owner: string | null; owner_until: number; next_ordinal: number;
  account_domain: string; config_fingerprint: string;
}
interface Credential {
  identity: string; copilot_oauth_token: string | null; copilot_oauth_status: string;
}
interface HoldRow {
  request_id: string; lease_id: string; member_identity: string; caller_id: string;
  generation: number; deadline_at: number; expires_at: number;
}
/** A member chosen for a new binding, with the enterprise the binding then belongs to. */
interface PoolMember {
  identity: string;
  enterprise_id: string;
}
type AdmissionKind = 'lease' | 'catalog';
type Acquire = (tx: Tx, member: PoolMember, lease?: Lease) => Promise<HeldLease>;
interface Admission {
  member: PoolMember;
  lease?: Lease;
}
const MANUAL_ERRORS = ['sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed'];
const MANUAL_SQL = MANUAL_ERRORS.map(() => '?').join(',');
const HOLD_DRAIN_MS = 10000;
const REAUTH_WINDOW_MS = 3600000;
const REAUTH_MAX_CYCLES = 3;
// Bound lock duration even with a large target. The scheduler fills subsequent batches.
const RESERVATION_BATCH = 32;
// Members one admission may examine across all enterprises before it reports exhaustion.
const ADMISSION_CANDIDATES = 128;
const INVENTORY_KEYS = ['state', 'stage', 'attempt_id', 'oauth_attempt_id', 'sso_created_at', 'task_id',
  'attempts', 'retry_at', 'last_error', 'cooldown_until', 'verified_at'];
const NUMERIC_KEYS = new Set(['id', 'at', 'n', 'total', 'version', 'idle_target', 'max_accounts', 'lease_seconds',
  'paused', 'owner_until', 'next_ordinal', 'ordinal', 'attempts', 'retry_at', 'updated_at',
  'cooldown_until', 'verified_at', 'generation', 'reauth_count', 'reauth_window_at', 'assigned_at',
  'last_success_at', 'expires_at', 'deadline_at', 'active_requests', 'now', 'inventory_count', 'actual',
  'ready_idle', 'in_flight', 'policy_version']);
const DB_NOW = "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000)";
const OWNER_SQL = `EXISTS (SELECT 1 FROM user_pool_settings WHERE id=1 AND owner=? AND owner_until>${DB_NOW})`;
const READY_SQL = `p.state = 'ready' AND p.verified_at IS NOT NULL
  AND a.copilot_oauth_status = 'valid' AND LENGTH(a.copilot_oauth_token) > 0`;

/** SQL is authoritative. No credential cache and no network work inside transactions. */
export class MysqlPoolStore implements PoolStore {
  private readonly options: PoolConfig;
  private reclaimCursor = '';
  private readonly pendingSelection = new PendingSelection();

  constructor(private readonly pool: Pool, options: PoolConfig, private readonly autoMigrate = true,
    private readonly migrationLockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds) {
    this.options = normalizePoolConfig(options);
  }

  async initialize(): Promise<void> {
    await (this.autoMigrate
      ? runMysqlPoolMigrations(this.pool, this.options, this.migrationLockWaitSeconds)
      : validateMysqlPoolSchema(this.pool, this.options, this.migrationLockWaitSeconds));
    // Targets/lease duration are initial seeds, subsequently shared mutable settings. The cap lives in
    // proxy_enterprises; the account domain is covered by the enterprise identity fingerprint.
    const fingerprint = poolConfigFingerprint(this.options);
    const [inserted] = await this.withConnection((connection) => connection.execute<ResultSetHeader>(`INSERT IGNORE
      INTO user_pool_settings (id, idle_target, max_accounts, lease_seconds, account_domain, config_fingerprint)
      VALUES (1, ?, ?, ?, ?, ?)`, [this.options.idleTarget, this.options.maxAccounts,
      this.options.leaseSeconds, this.options.accountDomain, fingerprint]));
    await this.tx(async (tx) => {
      const settings = await this.settingsRow(tx.connection);
      if (settings.config_fingerprint !== fingerprint) throw new Error('Pool configuration differs between Proxy replicas');
      // A newly created pool takes its configured cap, as before; afterwards the persisted cap wins.
      if (inserted.affectedRows === 1) await this.updateCap(tx, this.options.maxAccounts);
      await this.correctInventory(tx);
    });
  }

  async now(): Promise<number> { return this.time(this.pool); }

  async settings(): Promise<PoolSettings> { return this.readSettings(this.pool); }

  /** Accepts idle_target, lease_seconds and paused; a `max_accounts` key is 409 use_enterprise_cap. */
  async updateSettings(version: number, patch: Partial<PoolSettings>): Promise<PoolSettings> {
    return this.tx(async (tx) => {
      const next = nextSettings(version, await this.readSettings(tx.connection), patch);
      await this.exec(tx, `UPDATE user_pool_settings SET idle_target=?, lease_seconds=?,
        paused=?, version=version+1 WHERE id=1`, [next.idle_target, next.lease_seconds, next.paused]);
      await this.addEvent(tx, 'settings_updated');
      return this.readSettings(tx.connection);
    });
  }

  /** Design §5.8: recounts N_e (GROUP BY), records each correction and returns how many enterprises drifted. */
  async correctInventoryDrift(): Promise<number> {
    return this.tx((tx) => this.correctInventory(tx));
  }

  /** Every `proxy_enterprises` row, including enterprises that are no longer in the registry. */
  async enterprisePolicies(): Promise<ProxyEnterpriseRecord[]> {
    return this.enterpriseRecords(this.pool);
  }

  /** Compare-and-set on `policy_version`. Lock order: settings (tx gate), then every enterprise row by id. */
  async updateEnterprisePolicy(id: string, expectedVersion: number,
    patch: PolicyPatch): Promise<ProxyEnterpriseRecord> {
    return this.tx(async (tx) => {
      const rows = await this.enterpriseRows<PolicyEnterprise>(tx.connection, `${POLICY_ENTERPRISE_SQL}
  FOR UPDATE`);
      const current = rows.find((row) => row.id === id);
      if (!current) throw new UserPoolError(404, 'enterprise_not_found');
      const next = nextPolicy(current, rows, expectedVersion, patch);
      await this.exec(tx, `
        UPDATE proxy_enterprises
        SET max_accounts=?, state=?, policy_version=policy_version+1, updated_at=${DB_NOW}
        WHERE id=?
          AND policy_version=?`, [next.maxAccounts, next.state, id, expectedVersion]);
      await this.addEvent(tx, 'enterprise_policy_updated', undefined, undefined, undefined, JSON.stringify(next), id);
      const records = await this.enterpriseRecords(tx.connection);
      return records.find((record) => record.id === id)!;
    });
  }

  private async enterpriseRecords(connection: Connection): Promise<ProxyEnterpriseRecord[]> {
    const rows = await this.enterpriseRows<Parameters<typeof toEnterpriseRecord>[0]>(connection, `
      SELECT *
      FROM proxy_enterprises
      ORDER BY id`);
    return rows.map(toEnterpriseRecord);
  }

  /** `proxy_enterprises.id` is text: these rows skip the numeric `id` of pool rows and convert only counters. */
  private async enterpriseRows<T>(connection: Connection, sql: string): Promise<T[]> {
    if (connection === this.pool) return this.withConnection((leased) => this.enterpriseRows<T>(leased, sql));
    const [rows] = await connection.query<RowDataPacket[]>(sql);
    return rows.map((row) => enterpriseNumbers(row) as T);
  }

  async claimLoginDispatch(identity: string, fence: WorkerCredentialFence, owner: string, limit: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserPoolError(400, 'invalid_login_limit');
    return this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || row.state !== 'provisioning' || row.stage !== 'oauth-starting' || !this.matchesFence(row, fence)
        || !await this.matchesOwner(tx, owner) || await this.hasHoldsTx(tx.connection, identity)) return false;
      const occupied = await this.one<{ n: number }>(tx.connection,
        "SELECT COUNT(*) n FROM user_pool_accounts WHERE stage IN ('oauth-dispatch', 'oauth-wait')");
      if (occupied!.n >= limit) return false;
      return this.updateTx(tx, identity, { stage: 'oauth-dispatch' }, fence, owner);
    });
  }

  async listLoginReservations(): Promise<Inventory[]> {
    return this.rows<Inventory>(this.pool, `SELECT * FROM user_pool_accounts WHERE stage IN ('oauth-dispatch', 'oauth-wait')
      AND (state='disabled' OR (state='failed' AND attempts>=3)) ORDER BY ordinal LIMIT 100`);
  }

  async releaseLoginReservation(identity: string, fence: Inventory, owner: string, outcome: 'success' | 'failed'): Promise<boolean> {
    return this.tx(async tx => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      const keys: (keyof Inventory)[] = ['attempt_id', 'generation', 'stage', 'state', 'attempts', 'task_id', 'oauth_attempt_id', 'sso_created_at'];
      if (!row || !['success', 'failed'].includes(outcome) || !['oauth-dispatch', 'oauth-wait'].includes(row.stage)
        || !(row.state === 'disabled' || row.state === 'failed' && row.attempts >= 3)
        || keys.some(key => (row[key] ?? null) !== (fence[key] ?? null)) || !await this.matchesOwner(tx, owner)
        || (await this.readSettings(tx.connection)).paused || await this.hasHoldsTx(tx.connection, identity)) return false;
      return (await this.exec(tx, `UPDATE user_pool_accounts SET stage=?, task_id=NULL, oauth_attempt_id=NULL,
        generation=generation+1 WHERE identity=? AND ${OWNER_SQL}`,
      [outcome === 'success' ? 'warmup' : 'synced', identity, owner])).affectedRows === 1;
    });
  }

  async claimOwner(owner: string): Promise<boolean> {
    return this.tx(async (tx) => {
      // An expired tenure cannot renew itself. Standby must present a NEW tenure UUID.
      return (await this.exec(tx, `UPDATE user_pool_settings SET owner=?, owner_until=${DB_NOW}+30000 WHERE id=1
        AND ((owner=? AND owner_until>${DB_NOW}) OR (owner_until<=${DB_NOW} AND (owner IS NULL OR owner<>?)))`,
      [owner, owner, owner])).affectedRows === 1;
    });
  }

  async renewOwner(owner: string): Promise<boolean> {
    return this.tx(async (tx) => (await this.exec(tx, `UPDATE user_pool_settings
      SET owner_until=${DB_NOW}+30000 WHERE id=1 AND owner=? AND owner_until>${DB_NOW}`, [owner])).affectedRows === 1);
  }

  async releaseOwner(owner: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.exec(tx, 'UPDATE user_pool_settings SET owner=NULL, owner_until=0 WHERE id=1 AND owner=?', [owner]);
    });
  }

  async event(action: string, identity?: string, caller?: string, leaseId?: string, detail?: string): Promise<void> {
    await this.tx((tx) => this.addEvent(tx, action, identity, caller, leaseId, detail), false);
  }

  async page(kind: PoolList, query: PoolPageQuery): Promise<PoolPage> {
    // Dynamic import keeps this provider's non-paging tests independent of the optional
    // management UI module; it also uses exactly the shared SQLite filter contract.
    const { poolPageSql } = await import('./paging.js');
    return this.tx(async (tx) => {
      const sql = poolPageSql(kind, query, await this.time(tx.connection));
      const count = await this.one<{ total: number }>(tx.connection, sql.countSql, sql.values);
      const items = await this.rows(tx.connection, sql.itemsSql,
        [...sql.values, query.pageSize, (query.page - 1) * query.pageSize]);
      return { items, total: Number(count!.total), page: query.page, pageSize: query.pageSize };
    });
  }

  /** The enterprise's events; global events (settings, ownership) have no enterprise and are not listed. */
  async events(enterpriseId: string): Promise<unknown[]> {
    return this.rows(this.pool, `
      SELECT *
      FROM user_pool_events
      WHERE enterprise_id=?
      ORDER BY id DESC
      LIMIT 200`, [enterpriseId]);
  }

  async accounts(enterpriseId: string): Promise<unknown[]> {
    return this.withConnection(async (connection) => {
      const now = await this.time(connection);
      return this.rows(connection, `
        SELECT p.*, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at,
          (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>?)
          + (SELECT COUNT(*) FROM user_pool_catalog_holds h
             WHERE h.member_identity=p.identity AND h.expires_at>?) AS active_requests
        FROM user_pool_accounts p
        JOIN proxy_accounts a ON a.identity=p.identity
        LEFT JOIN user_pool_leases l ON l.member_identity=p.identity
        WHERE p.enterprise_id=?
        ORDER BY p.ordinal
        LIMIT 1000`, [now, now, enterpriseId]);
    });
  }

  async leases(enterpriseId: string): Promise<Array<Lease & { active_requests: number }>> {
    return this.rows<Lease & { active_requests: number }>(this.pool, `
      SELECT l.*, p.enterprise_id,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>${DB_NOW})
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h
           WHERE h.member_identity=l.member_identity AND h.expires_at>${DB_NOW}) AS active_requests
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity=l.member_identity
      WHERE p.enterprise_id=?
      ORDER BY l.assigned_at DESC, l.lease_id
      LIMIT 1000`, [enterpriseId]);
  }

  async inventory(identity: string): Promise<Inventory | undefined> { return this.readInventory(this.pool, identity); }

  /** `sso_user` is unique only within an enterprise (design §5.3). */
  async managesSsoUser(enterpriseId: string, ssoUser: string): Promise<boolean> {
    return Boolean(await this.one(this.pool, `
      SELECT 1
      FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity=p.identity
      WHERE p.enterprise_id=?
        AND LOWER(a.sso_user)=LOWER(?)
      LIMIT 1`, [enterpriseId, ssoUser]));
  }

  /** One enterprise's counts, or the whole pool's when `enterpriseId` is undefined. */
  async counts(enterpriseId?: string): Promise<Record<string, number>> {
    return this.tx((tx) => this.readCounts(tx, enterpriseId));
  }
  async reclaim(): Promise<void> { await this.tx((tx) => this.reclaimTx(tx)); }

  async acquire(caller: string, signal?: AbortSignal, requestTimeoutMs?: number): Promise<HeldLease> {
    normalizeCaller(caller);
    const holdTimeoutMs = inferenceHoldTimeoutMs(requestTimeoutMs, this.options.requestTimeoutMs);
    return this.admit(caller, 'lease', async (tx, member, current) => {
      const lease = current ?? await this.insertLease(tx, caller, member);
      return this.hold(tx, lease, 'lease', holdTimeoutMs);
    }, signal);
  }

  async acquireCatalog(caller: string, signal?: AbortSignal): Promise<HeldLease> {
    normalizeCaller(caller);
    return this.admit(caller, 'catalog', async (tx, member) => {
      const now = await this.time(tx.connection);
      return this.hold(tx, { caller_id: caller, member_identity: member.identity, enterprise_id: member.enterprise_id,
        lease_id: randomUUID(), phase: 'provisional', assigned_at: now, last_success_at: null,
        expires_at: now + this.options.requestTimeoutMs }, 'catalog');
    }, signal);
  }

  private async insertLease(tx: Tx, caller: string, member: PoolMember): Promise<Lease> {
    const now = await this.time(tx.connection);
    const lease: Lease = { caller_id: caller, member_identity: member.identity, enterprise_id: member.enterprise_id,
      lease_id: randomUUID(), phase: 'provisional', assigned_at: now, last_success_at: null,
      expires_at: now + this.options.provisionalSeconds * 1000 };
    await this.exec(tx, `INSERT INTO user_pool_leases
      (caller_id, member_identity, lease_id, phase, assigned_at, last_success_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`, [caller, member.identity, lease.lease_id, lease.phase, now, lease.expires_at]);
    await this.exec(tx, 'UPDATE user_pool_accounts SET updated_at=? WHERE identity=?', [now, member.identity]);
    await this.addEvent(tx, 'lease_acquired', member.identity, caller, lease.lease_id);
    return lease;
  }

  /** Checks only; cannot extend the persisted absolute deadline or drain grace. */
  async heartbeat(held: HeldLease): Promise<boolean> {
    const from = held.kind === 'catalog'
      ? 'user_pool_catalog_holds h'
      : 'user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id';
    const member = held.kind === 'catalog' ? 'h.member_identity' : 'l.member_identity';
    const caller = held.kind === 'catalog' ? 'h.caller_id' : 'l.caller_id';
    return Boolean(await this.one(this.pool, `SELECT 1 FROM ${from}
      JOIN user_pool_accounts p ON p.identity=${member} JOIN proxy_accounts a ON a.identity=p.identity
      WHERE h.request_id=? AND h.lease_id=? AND ${member}=? AND ${caller}=?
        AND h.deadline_at>${DB_NOW} AND h.expires_at>${DB_NOW} AND h.generation=p.generation
        AND p.state IN ('ready','cooling') AND a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0`,
    [held.request_id, held.lease_id, held.member_identity, held.caller_id]));
  }

  async recoverUnauthorized(held: HeldLease, expectedToken: string): Promise<boolean> {
    return this.tx(async (tx) => {
      if (!await this.currentHold(tx, held)) return false;
      const identity = held.member_identity;
      const member = (await this.readInventory(tx.connection, identity))!;
      const now = await this.time(tx.connection);
      if (!await this.invalidate(tx, identity, expectedToken, now, undefined, held)) return false;
      const windowAt = member.reauth_window_at ?? 0;
      const resetWindow = windowAt === 0 || now - windowAt >= REAUTH_WINDOW_MS;
      const count = resetWindow ? 0 : member.reauth_count ?? 0;
      const exhausted = count >= REAUTH_MAX_CYCLES;
      await this.updateTx(tx, identity, { state: 'failed', stage: 'synced', attempt_id: randomUUID(),
        oauth_attempt_id: null, task_id: null, verified_at: null, attempts: exhausted ? 3 : 0,
        last_error: exhausted ? 'oauth_reauth_limit_reached' : 'upstream_unauthorized', retry_at: now });
      await this.exec(tx, 'UPDATE user_pool_accounts SET reauth_count=?, reauth_window_at=? WHERE identity=?',
        [exhausted ? count : count + 1, resetWindow ? now : windowAt, identity]);
      await this.addEvent(tx, exhausted ? 'oauth_reauth_blocked' : 'oauth_reauth_scheduled', identity,
        held.caller_id, held.lease_id, exhausted ? 'oauth_reauth_limit_reached' : 'upstream_unauthorized');
      return true;
    });
  }

  async quarantine(identity: string, code: string, held?: HeldLease): Promise<boolean> {
    return this.tx(async (tx) => {
      if (held && (held.member_identity !== identity || !await this.currentHold(tx, held))) return false;
      await this.lockCredential(tx, identity);
      const member = await this.readInventory(tx.connection, identity);
      if (!member || member.state === 'disabled') return false;
      if (!await this.updateTx(tx, identity, { state: 'failed', last_error: code, attempts: 3,
        retry_at: await this.time(tx.connection) + 300000 }, undefined, undefined, held)) return false;
      await this.addEvent(tx, 'member_quarantined', identity, held?.caller_id, held?.lease_id, code);
      return true;
    });
  }

  async cool(identity: string, seconds: number, held?: HeldLease): Promise<boolean> {
    return this.tx(async (tx) => {
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UserPoolError(400, 'invalid_cooldown');
      if (held && (held.member_identity !== identity || !await this.currentHold(tx, held))) return false;
      await this.lockCredential(tx, identity);
      const member = await this.readInventory(tx.connection, identity);
      if (!member || !['ready', 'cooling'].includes(member.state)) return false;
      const until = Math.max(member.cooldown_until, await this.time(tx.connection) + Math.ceil(Math.min(seconds, 2592000)) * 1000);
      if (!await this.updateTx(tx, identity, { state: 'cooling', cooldown_until: until }, undefined, undefined, held)) return false;
      await this.exec(tx, `INSERT INTO user_pool_catalog_cooldowns(caller_id, member_identity, expires_at)
        SELECT DISTINCT caller_id, member_identity, ? FROM user_pool_catalog_holds WHERE member_identity=?
        ON DUPLICATE KEY UPDATE expires_at=GREATEST(user_pool_catalog_cooldowns.expires_at, VALUES(expires_at))`, [until, identity]);
      await this.addEvent(tx, 'member_cooling', identity, held?.caller_id, held?.lease_id);
      return true;
    });
  }

  async finish(held: HeldLease, success: boolean): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, held.member_identity);
      if (!await this.heldRow(tx, held)) return;
      if (success && held.kind !== 'catalog' && await this.currentHold(tx, held)) {
        const now = await this.time(tx.connection);
        const settings = await this.readSettings(tx.connection);
        const changed = await this.exec(tx, `UPDATE user_pool_leases SET phase='active', last_success_at=?, expires_at=?
          WHERE lease_id=? AND caller_id=? AND member_identity=?
          AND member_identity IN (SELECT identity FROM user_pool_accounts WHERE state='ready')
          AND EXISTS (SELECT 1 FROM user_pool_holds h WHERE h.request_id=? AND h.lease_id=user_pool_leases.lease_id
            AND h.deadline_at>${DB_NOW} AND h.expires_at>${DB_NOW})`,
        [now, now + settings.lease_seconds * 1000, held.lease_id, held.caller_id, held.member_identity, held.request_id]);
        if (changed.affectedRows) await this.addEvent(tx, 'lease_renewed', held.member_identity, held.caller_id, held.lease_id);
      }
      const table = held.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds';
      await this.exec(tx, `DELETE FROM ${table} WHERE request_id=? AND lease_id=?`, [held.request_id, held.lease_id]);
      const now = await this.time(tx.connection);
      const expired = await this.one<Lease>(tx.connection, `SELECT l.* FROM user_pool_leases l
        JOIN user_pool_accounts p ON p.identity=l.member_identity
        WHERE l.member_identity=? AND l.expires_at<=? AND p.state<>'cooling'`, [held.member_identity, now]);
      if (expired && !await this.hasHoldsTx(tx.connection, held.member_identity)) {
        await this.exec(tx, 'DELETE FROM user_pool_leases WHERE lease_id=?', [expired.lease_id]);
        await this.addEvent(tx, 'lease_expired', expired.member_identity, expired.caller_id, expired.lease_id);
      }
    }, false);
  }

  async release(leaseId: string): Promise<void> {
    await this.tx(async (tx) => {
      let lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      if (!lease) throw new UserPoolError(404, 'lease_not_found');
      await this.lockCredential(tx, lease.member_identity);
      lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      if (!lease) throw new UserPoolError(404, 'lease_not_found');
      if (await this.hasHoldsTx(tx.connection, lease.member_identity)) throw new UserPoolError(409, 'lease_in_use');
      await this.exec(tx, 'DELETE FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      await this.addEvent(tx, 'lease_released', lease.member_identity, lease.caller_id, lease.lease_id);
    });
  }

  async hasHolds(identity: string): Promise<boolean> {
    return this.withConnection((connection) => this.hasHoldsTx(connection, identity));
  }
  async releaseInactive(identity: string): Promise<void> { await this.tx((tx) => this.releaseInactiveTx(tx, identity)); }

  /** Reserves at most one member, in the enterprise the shared ranking picks among `eligibleEnterpriseIds`. */
  async reserve(eligibleEnterpriseIds: readonly string[]): Promise<Inventory | undefined> {
    const eligible = eligibleEnterprises(eligibleEnterpriseIds);
    const result = await this.tx(async (tx) => {
      const [enterpriseId] = await this.planBatch(tx, eligible, 1);
      return enterpriseId === undefined ? undefined : this.reserveCandidate(tx, enterpriseId);
    });
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  /**
   * One replenishment batch of at most RESERVATION_BATCH members (design §5.8). `eligibleEnterpriseIds`: active
   * enterprises that may grow now; every active enterprise still counts in the share denominators.
   */
  async reserveDeficit(owner: string, eligibleEnterpriseIds: readonly string[]): Promise<number> {
    const eligible = eligibleEnterprises(eligibleEnterpriseIds);
    return this.tx(async (tx) => {
      if (!await this.matchesOwner(tx, owner)) return 0;
      let reserved = 0;
      for (const enterpriseId of await this.planBatch(tx, eligible, RESERVATION_BATCH)) {
        if (!await this.matchesOwner(tx, owner)) break;
        if (await this.reserveCandidate(tx, enterpriseId, owner) instanceof UserPoolError) break;
        reserved++;
      }
      return reserved;
    });
  }

  /**
   * Lock order: settings (tx gate), every enterprise row by id, then members (reclaim, inserts). The batch's only
   * aggregate yields I and P; the enterprises are then chosen with in-memory counters by the shared `planCreations`.
   */
  private async planBatch(tx: Tx, eligible: ReadonlySet<string>, limit: number): Promise<string[]> {
    const enterprises = await this.enterpriseRows<SchedulingEnterprise>(tx.connection, `${SCHEDULING_ENTERPRISE_SQL}
  FOR UPDATE`);
    await this.reclaimTx(tx);
    const settings = await this.settingsRow(tx.connection);
    const query = poolSupplyQuery(await this.time(tx.connection));
    const supply = (await this.one<PoolSupply>(tx.connection, query.sql, query.values))!;
    return planReplenishment(enterprises, eligible, { supply, settings, ordinal: settings.next_ordinal, limit });
  }

  async pending(excluded: readonly string[] = []): Promise<Inventory | undefined> {
    const row = await this.tx(async (tx) => {
      await this.reclaimTx(tx);
      if ((await this.readSettings(tx.connection)).paused) return undefined;
      const exclusion = excluded.length ? `AND p.identity NOT IN (${excluded.map(() => '?').join(',')})` : '';
      return this.one<Inventory>(tx.connection, `SELECT p.* FROM user_pool_accounts p WHERE retry_at<=? AND (
        state='provisioning' OR (state='failed' AND attempts<3 AND COALESCE(last_error, '') NOT IN (${MANUAL_SQL})))
        ${exclusion} AND NOT EXISTS (SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id
          WHERE l.member_identity=p.identity)
        AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity)
        AND ${LOGIN_CAPACITY_SQL}
        ORDER BY ${this.pendingSelection.orderSql()} LIMIT 1`,
      [await this.time(tx.connection), ...MANUAL_ERRORS, ...excluded, this.options.loginMaxPending ?? 5]);
    });
    if (row) this.pendingSelection.selected();
    return row;
  }

  async update(identity: string, patch: Partial<Inventory>, expected?: InventoryFence, owner?: string): Promise<boolean> {
    return this.tx((tx) => this.updateTx(tx, identity, patch, expected, owner));
  }

  async fail(identity: string, code: string, expected?: InventoryFence, owner?: string, terminal = false): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || row.state === 'disabled' || !this.matchesFence(row, expected) || !await this.matchesOwner(tx, owner)) return;
      const attempts = terminal ? Math.max(3, row.attempts + 1) : row.attempts + 1;
      const written = await this.updateTx(tx, identity, { state: 'failed', attempts, last_error: code,
        retry_at: await this.time(tx.connection) + Math.min(300, 30 * 2 ** (attempts - 1)) * 1000 }, expected, owner);
      if (written) await this.addEvent(tx, 'provision_failed', identity, undefined, undefined, code);
    });
  }

  async disable(identity: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row) throw new UserPoolError(404, 'member_not_found');
      if (row.state === 'disabled') return;
      await this.updateTx(tx, identity, { state: 'disabled', attempt_id: randomUUID() });
      await this.releaseInactiveTx(tx, identity);
      await this.addEvent(tx, 'member_disabled', identity);
    });
  }

  async retry(identity: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row) throw new UserPoolError(404, 'member_not_found');
      if (await this.hasHoldsTx(tx.connection, identity) || !['failed', 'disabled'].includes(row.state)) {
        throw new UserPoolError(409, 'member_in_use');
      }
      if (MANUAL_ERRORS.includes(row.last_error ?? '')) throw new UserPoolError(409, 'manual_reconciliation_required');
      await this.releaseInactiveTx(tx, identity);
      await this.exec(tx, `UPDATE user_pool_accounts SET state='provisioning', attempts=0, retry_at=0,
        last_error=NULL, cooldown_until=0, verified_at=NULL, generation=generation+1,
        attempt_id=?, stage=?, updated_at=? WHERE identity=?`,
      [randomUUID(), row.stage === 'ready' ? 'warmup' : row.stage, await this.time(tx.connection), identity]);
      await this.addEvent(tx, 'member_retry', identity);
    });
  }

  async mutateWorkerCredential(identity: string, fence: WorkerCredentialFence, owner: string,
    mutation: WorkerCredentialMutation): Promise<boolean> {
    return this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || row.state !== 'provisioning' || row.stage !== fence.stage || !this.matchesFence(row, fence)
        || !await this.matchesOwner(tx, owner) || await this.hasHoldsTx(tx.connection, identity)) return false;
      const now = await this.time(tx.connection);
      const timestamp = mysqlTimestamp(now);
      if (mutation.type === 'link') {
        return (await this.exec(tx, `UPDATE proxy_accounts SET gh_login=?, updated_at=? WHERE identity=?
          AND CAST(sso_user AS BINARY)=CAST(? AS BINARY)
          AND (gh_login IS NULL OR CAST(gh_login AS BINARY)=CAST(? AS BINARY)) AND ${OWNER_SQL}`,
        [mutation.ghLogin, timestamp, identity, identity, mutation.ghLogin, owner])).affectedRows === 1;
      }
      if (mutation.type === 'begin') {
        return (await this.exec(tx, `UPDATE proxy_accounts SET copilot_oauth_status='refreshing',
          copilot_oauth_attempt_id=?, updated_at=? WHERE identity=? AND CAST(sso_user AS BINARY)=CAST(? AS BINARY)
          AND ${OWNER_SQL}`,
        [mutation.oauthAttemptId, timestamp, identity, identity, owner])).affectedRows === 1;
      }
      return this.invalidate(tx, identity, mutation.expectedToken, now, owner);
    });
  }

  // All nested work uses the SAME connection. Never call a public transactional method here.
  private async tx<T>(operation: (tx: Tx) => Promise<T>, poolGate: boolean | string = true,
    deadline = new MysqlDeadline(this.options.requestTimeoutMs), signal?: AbortSignal,
    permit?: MysqlCallerPermit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const lease = await leaseMysqlConnection(this.pool, deadline, signal, permit && (() => permit.retain()));
      const { connection } = lease;
      let begun = false;
      let committing = false;
      let callerLock: string | undefined;
      try {
        signal?.throwIfAborted();
        if (typeof poolGate === 'string') {
          const database = await this.one<{ name: string }>(connection, 'SELECT DATABASE() AS name');
          if (!database?.name) throw new Error('User pool requires a selected database');
          // MySQL lock names are server-wide and limited to 64 bytes. Hash the
          // unambiguous database/caller pair, never the caller alone.
          callerLock = createHash('sha256').update(JSON.stringify([database.name, poolGate])).digest('hex');
          const lock = await this.one<{ acquired: number | null }>(connection,
            'SELECT GET_LOCK(?, 5) AS acquired', [callerLock]);
          // The leased socket's shared deadline also bounds pool queue + GET_LOCK
          // + transaction + release; the server timeout is only a second fence.
          if (Number(lock?.acquired) !== 1) throw new MysqlDeadlineError('caller lock');
        }
        signal?.throwIfAborted();
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        begun = true;
        if (poolGate === true) {
          const gate = await this.one(connection, 'SELECT id FROM user_pool_settings WHERE id=1 FOR UPDATE');
          if (!gate) throw new Error('User pool settings have not been initialized');
        }
        signal?.throwIfAborted();
        const result = await operation({ connection });
        signal?.throwIfAborted();
        // Once dispatched, COMMIT is bounded only by the original SQL deadline.
        // Cancellation cannot disambiguate it or authorize replay; a late ACK is
        // returned for boundedAdmission's persisted-hold cleanup.
        committing = true;
        await connection.commit();
        return result;
      } catch (error) {
        let rolledBack = false;
        if (begun && !lease.destroyed) {
          try { await connection.rollback(); rolledBack = true; }
          catch { lease.destroy(); }
        }
        // Even a successful ROLLBACK cannot disambiguate a lost COMMIT response.
        // A timeout has already destroyed the socket; never queue rollback on it.
        // Only a known lock error before COMMIT + acknowledged rollback may replay.
        if (committing) lease.destroy();
        if (committing || !rolledBack || !isLockError(error) || attempt >= 2) throw error;
      } finally {
        if (callerLock && !lease.destroyed) {
          try {
            const released = await this.one<{ released: number | null }>(connection,
              'SELECT RELEASE_LOCK(?) AS released', [callerLock]);
            if (Number(released?.released) !== 1) lease.destroy();
          } catch { lease.destroy(); }
        }
        // Never return a possibly lock-owning socket to the pool. Release failure
        // after an acknowledged COMMIT must not replay the admitted request.
        lease.release();
      }
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      await deadline.run('retry delay', () => new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, 10 * (attempt + 1));
      }), () => clearTimeout(retryTimer), undefined, signal);
    }
  }

  private async withConnection<T>(operation: (connection: PoolConnection) => Promise<T>,
    budgetMs = Math.min(this.options.requestTimeoutMs, 5000)): Promise<T> {
    const lease = await leaseMysqlConnection(this.pool, new MysqlDeadline(budgetMs, budgetMs));
    try { return await operation(lease.connection); }
    finally { lease.release(); }
  }

  private async rows<T = Record<string, unknown>>(connection: Connection, sql: string, values: unknown[] = []): Promise<T[]> {
    if (connection === this.pool) return this.withConnection((leased) => this.rows<T>(leased, sql, values));
    const [rows] = await connection.query<RowDataPacket[]>(sql, values);
    return rows.map((row) => {
      for (const [key, value] of Object.entries(row)) {
        if (value !== null && NUMERIC_KEYS.has(key)) {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new Error(`Unsafe MySQL pool integer: ${key}`);
          row[key] = number;
        }
      }
      return row as T;
    });
  }

  private async one<T = Record<string, unknown>>(connection: Connection, sql: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.rows<T>(connection, sql, values))[0];
  }

  private async exec(tx: Tx, sql: string, values: unknown[] = []): Promise<ResultSetHeader> {
    const [result] = await tx.connection.query<ResultSetHeader>(sql, values);
    if (/^UPDATE proxy_accounts\b/i.test(sql.trim())) tx.credentials?.clear();
    return result;
  }

  private async time(connection: Connection): Promise<number> {
    // Independent of both host clock and MySQL session timezone, with millisecond precision.
    return (await this.one<{ now: number }>(connection,
      "SELECT TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000 AS now"))!.now;
  }

  private async settingsRow(connection: Connection): Promise<SettingsRow> {
    const row = await this.one<SettingsRow>(connection, 'SELECT * FROM user_pool_settings WHERE id=1');
    if (!row) throw new Error('User pool settings have not been initialized');
    return row;
  }

  private async readSettings(connection: Connection): Promise<PoolSettings> {
    const { version, idle_target, lease_seconds, paused } = await this.settingsRow(connection);
    return { version, idle_target, lease_seconds, paused };
  }

  /** Lock order: user_pool_settings row, then proxy_enterprises rows, then members. */
  private async updateCap(tx: Tx, maxAccounts: number): Promise<void> {
    await this.exec(tx, `
      UPDATE proxy_enterprises
      SET max_accounts=?, policy_version=policy_version+1, updated_at=${DB_NOW}
      WHERE id=?`, [maxAccounts, DEFAULT_ENTERPRISE_ID]);
  }

  /** Design §5.8: re-derive the incremental inventory counters and record any drift. */
  private async correctInventory(tx: Tx): Promise<number> {
    const rows = await this.rows<{ enterprise_id: string; inventory_count: number; actual: number }>(tx.connection, `
      SELECT e.id AS enterprise_id, e.inventory_count,
        (SELECT COUNT(*) FROM user_pool_accounts p WHERE p.enterprise_id=e.id) AS actual
      FROM proxy_enterprises e
      ORDER BY e.id
      FOR UPDATE`);
    for (const row of rows.filter((candidate) => candidate.inventory_count !== candidate.actual)) {
      await this.exec(tx, `
        UPDATE proxy_enterprises
        SET inventory_count=?
        WHERE id=?`, [row.actual, row.enterprise_id]);
      const detail = JSON.stringify({ stored: row.inventory_count, actual: row.actual });
      await this.addEvent(tx, 'enterprise_inventory_drift', undefined, undefined, undefined, detail, row.enterprise_id);
    }
    return rows.filter((candidate) => candidate.inventory_count !== candidate.actual).length;
  }

  private readInventory(connection: Connection, identity: string): Promise<Inventory | undefined> {
    return this.one<Inventory>(connection, 'SELECT * FROM user_pool_accounts WHERE identity=?', [identity]);
  }

  private async lockCredential(tx: Tx, identity: string, skipLocked = false): Promise<Credential | undefined> {
    tx.credentials ??= new Map();
    if (tx.credentials.has(identity)) return tx.credentials.get(identity);
    // External OAuth writes lock Proxy before the trigger's inventory row.
    const row = await this.one<Credential>(tx.connection, `SELECT identity, copilot_oauth_token, copilot_oauth_status
      FROM proxy_accounts WHERE identity=? FOR UPDATE${skipLocked ? ' SKIP LOCKED' : ''}`, [identity]);
    if (row || !skipLocked) tx.credentials.set(identity, row);
    return row;
  }

  /** A member's event belongs to the member's enterprise; settings and owner events are global (NULL). */
  private async addEvent(tx: Tx, action: string, identity?: string, caller?: string, leaseId?: string, detail?: string,
    enterpriseId?: string): Promise<void> {
    await this.exec(tx, `
      INSERT INTO user_pool_events(at, action, identity, caller_id, lease_id, detail, enterprise_id)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT enterprise_id FROM user_pool_accounts WHERE identity=?)))`,
    [await this.time(tx.connection), action, identity ?? null, caller ?? null, leaseId ?? null, detail ?? null,
      enterpriseId ?? null, identity ?? null]);
    // MySQL forbids directly selecting a DELETE target in its scalar subquery. An index lookup, not an
    // aggregate: replenishment and admission write events too.
    const newest = await this.one<{ n: number }>(tx.connection, `
      SELECT CAST(id AS SIGNED)-10000 AS n
      FROM user_pool_events
      ORDER BY id DESC
      LIMIT 1`);
    if (newest && newest.n > 0) await this.exec(tx, 'DELETE FROM user_pool_events WHERE id<=?', [newest.n]);
  }

  private async readCounts(tx: Tx, enterpriseId?: string): Promise<Record<string, number>> {
    await this.reclaimTx(tx);
    const result: Record<string, number> = { total: 0, ready_idle: 0, provisioning: 0, failed: 0,
      cooling: 0, disabled: 0, leased: 0, provisional: 0, catalog_requests: 0 };
    const where = memberScope(enterpriseId, 'WHERE');
    for (const row of await this.rows<{ state: string; n: number }>(tx.connection, `
      SELECT p.state, COUNT(*) n
      FROM user_pool_accounts p
      ${where.sql}
      GROUP BY p.state`, where.values)) {
      result[row.state] = row.n;
      result.total += row.n;
    }
    for (const row of await this.rows<{ phase: string; n: number }>(tx.connection, `
      SELECT l.phase, COUNT(*) n
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity=l.member_identity
      ${where.sql}
      GROUP BY l.phase`, where.values)) result[row.phase === 'active' ? 'leased' : 'provisional'] = row.n;
    result.ready_idle = await this.readyIdleCount(tx, memberScope(enterpriseId, 'AND'));
    result.catalog_requests = (await this.one<{ n: number }>(tx.connection, `
      SELECT COUNT(*) n
      FROM user_pool_catalog_holds h
      JOIN user_pool_accounts p ON p.identity=h.member_identity
      ${where.sql}`, where.values))!.n;
    return result;
  }

  private async readyIdleCount(tx: Tx, scope: { sql: string; values: string[] }): Promise<number> {
    return (await this.one<{ n: number }>(tx.connection, `SELECT COUNT(*) n FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity=p.identity WHERE ${READY_SQL}
      AND NOT EXISTS (SELECT 1 FROM user_pool_leases l WHERE l.member_identity=p.identity)
      AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity)
      ${scope.sql}`, scope.values))!.n;
  }

  private async reclaimTx(tx: Tx): Promise<void> {
    const now = await this.time(tx.connection);
    // Maintenance retains the settings gate, but admission does not. Discover
    // without row locks, then mutate only after locking Proxy (the trigger order).
    const candidates = await this.rows<{ identity: string }>(tx.connection, `
      SELECT identity FROM (
        SELECT identity FROM user_pool_accounts WHERE state IN ('ready','cooling') AND verified_at IS NULL
        UNION SELECT identity FROM user_pool_accounts WHERE state='cooling' AND cooldown_until<=?
        UNION SELECT member_identity FROM user_pool_leases WHERE expires_at<=?
        UNION SELECT l.member_identity FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE h.expires_at<=?
        UNION SELECT member_identity FROM user_pool_catalog_holds WHERE expires_at<=?
        UNION SELECT member_identity FROM user_pool_catalog_cooldowns WHERE expires_at<=?
      ) candidates ORDER BY identity<=?, identity LIMIT 32`, [now, now, now, now, now, this.reclaimCursor]);
    const started = performance.now();
    for (const { identity } of candidates) {
      // The cursor also advances over pinned/busy rows, so a full batch of long
      // holds cannot starve later expired members. State is always rechecked.
      this.reclaimCursor = identity;
      if (await this.lockCredential(tx, identity, true)) await this.reclaimMemberTx(tx, identity);
      if (performance.now() - started >= 1000) break;
    }
  }

  private async reclaimMemberTx(tx: Tx, identity: string): Promise<void> {
    const credential = await this.lockCredential(tx, identity);
    let member = await this.readInventory(tx.connection, identity);
    if (!member) return;
    const now = await this.time(tx.connection);
    await this.exec(tx, `DELETE h FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id
      WHERE l.member_identity=? AND h.expires_at<=?`, [identity, now]);
    await this.exec(tx, 'DELETE FROM user_pool_catalog_holds WHERE member_identity=? AND expires_at<=?', [identity, now]);
    await this.exec(tx, 'DELETE FROM user_pool_catalog_cooldowns WHERE member_identity=? AND expires_at<=?', [identity, now]);
    if (['ready', 'cooling'].includes(member.state)) {
      if (member.state === 'cooling' && member.cooldown_until <= now) {
        await this.updateTx(tx, identity, { state: 'ready', cooldown_until: 0 });
        member = (await this.readInventory(tx.connection, identity))!;
      }
      if (!validCredential(credential)) {
        await this.updateTx(tx, identity, { state: 'failed', last_error: 'credential_not_valid', retry_at: now + 30000 });
      } else if (member.state === 'ready' && member.verified_at === null) {
        await this.updateTx(tx, identity, { state: 'failed', stage: 'warmup', last_error: 'credential_not_verified', retry_at: now });
      }
    }
    const expired = await this.one<Lease>(tx.connection, `SELECT l.* FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity=l.member_identity
      WHERE l.member_identity=? AND l.expires_at<=${DB_NOW} AND p.state<>'cooling'`, [identity]);
    if (expired && !await this.hasHoldsTx(tx.connection, identity)) {
      await this.exec(tx, 'DELETE FROM user_pool_leases WHERE lease_id=?', [expired.lease_id]);
      await this.addEvent(tx, 'lease_expired', identity, expired.caller_id, expired.lease_id);
    }
  }

  private async admit(caller: string, kind: AdmissionKind, acquire: Acquire,
    signal?: AbortSignal): Promise<HeldLease> {
    const deadline = new MysqlDeadline(this.options.requestTimeoutMs);
    const permit = await acquireMysqlCaller(this.pool, caller, deadline, signal);
    try {
      return await this.admitTx(caller, kind, acquire, deadline, signal, permit);
    } finally {
      // SQL retries and RELEASE_LOCK/socket disposal finish before this handoff.
      // A canceled getConnection retains its own reference until late disposal.
      permit.release();
    }
  }

  private async admitTx(caller: string, kind: AdmissionKind, acquire: Acquire, deadline: MysqlDeadline,
    signal: AbortSignal | undefined, permit: MysqlCallerPermit): Promise<HeldLease> {
    const result = await this.tx(async (tx) => {
      // Only this caller's old bindings are reclaimed. Cross-caller inactive
      // inventory is discovered lazily by availableMember, not a global sweep.
      const bound = await this.rows<{ identity: string }>(tx.connection, `
        SELECT member_identity AS identity FROM user_pool_leases WHERE caller_id=?
        UNION SELECT member_identity FROM user_pool_catalog_holds WHERE caller_id=?
        UNION SELECT member_identity FROM user_pool_catalog_cooldowns WHERE caller_id=? ORDER BY identity`, [caller, caller, caller]);
      for (const { identity } of bound) await this.reclaimMemberTx(tx, identity);
      let admission: Admission;
      try {
        admission = await this.resolveAdmission(tx, caller, kind);
      } catch (error) {
        if (!(error instanceof UserPoolError)) throw error;
        return error; // Commit quarantine/cleanup even when admission rejects.
      }
      await this.exec(tx, 'SAVEPOINT pool_admission');
      try {
        const held = await acquire(tx, admission.member, admission.lease);
        await this.exec(tx, 'RELEASE SAVEPOINT pool_admission');
        return held;
      } catch (error) {
        if (!(error instanceof UserPoolError)) throw error;
        await this.exec(tx, 'ROLLBACK TO SAVEPOINT pool_admission');
        await this.exec(tx, 'RELEASE SAVEPOINT pool_admission');
        return error;
      }
    }, caller, deadline, signal, permit);
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  /**
   * An existing lease keeps its member and enterprise, even while that enterprise drains; a draining enterprise
   * admits no new catalog hold, not even on an existing lease.
   */
  private async resolveAdmission(tx: Tx, caller: string, kind: AdmissionKind): Promise<Admission> {
    await this.assertCallerNotCooling(tx, caller);
    const existing = await this.callerLease(tx.connection, caller);
    if (existing && kind === 'catalog') assertEnterpriseActive(await this.enterpriseState(tx, existing.enterprise_id));
    const member = existing ? leaseMember(existing) : await this.availableMember(tx, caller);
    await this.assertReady(tx, member.identity);
    // Re-read after taking the credential lock: finish may have renewed or
    // removed the initial binding while admission was waiting for that lock.
    const lease = await this.callerLease(tx.connection, caller);
    if (lease && lease.expires_at <= await this.time(tx.connection)) throw new UserPoolError(503, 'lease_draining', 1);
    return { member, lease };
  }

  private callerLease(connection: Connection, caller: string): Promise<Lease | undefined> {
    return this.one<Lease>(connection, `
      SELECT l.*, p.enterprise_id
      FROM user_pool_leases l
      JOIN user_pool_accounts p ON p.identity=l.member_identity
      WHERE l.caller_id=?`, [caller]);
  }

  private async enterpriseState(tx: Tx, id: string): Promise<string | undefined> {
    const row = await this.one<{ state: string }>(tx.connection, `
      SELECT state
      FROM proxy_enterprises
      WHERE id=?`, [id]);
    return row?.state;
  }

  private async assertCallerNotCooling(tx: Tx, caller: string): Promise<void> {
    const now = await this.time(tx.connection);
    const row = await this.one<{ expires_at: number }>(tx.connection,
      'SELECT expires_at FROM user_pool_catalog_cooldowns WHERE caller_id=? AND expires_at>?', [caller, now]);
    if (row) throw new UserPoolError(429, 'member_cooling', Math.max(1, Math.ceil((row.expires_at - now) / 1000)));
  }

  /**
   * Design §5.8 admission: a catalog hold keeps its member (503 enterprise_draining when its enterprise is no longer
   * active); otherwise the caller's ranking of the active enterprises (no lock, no aggregate), then one indexed pick
   * per enterprise in that order.
   */
  private async availableMember(tx: Tx, caller: string): Promise<PoolMember> {
    const catalog = await this.one<PoolMember & { state: string }>(tx.connection, `
      SELECT h.member_identity AS identity, p.enterprise_id, e.state
      FROM user_pool_catalog_holds h
      JOIN user_pool_accounts p ON p.identity=h.member_identity
      JOIN proxy_enterprises e ON e.id=p.enterprise_id
      WHERE h.caller_id=?
      ORDER BY h.assigned_at
      LIMIT 1`, [caller]);
    if (catalog) {
      // Target caller cleanup already owns its credential lock.
      assertEnterpriseActive(catalog.state);
      return { identity: catalog.identity, enterprise_id: catalog.enterprise_id };
    }
    const enterprises = await this.enterpriseRows<SchedulingEnterprise>(tx.connection, SCHEDULING_ENTERPRISE_SQL);
    const excluded: string[] = [];
    for (const enterpriseId of admissionOrder(enterprises, caller)) {
      const identity = await this.idleMember(tx, enterpriseId, excluded);
      if (identity) return { identity, enterprise_id: enterpriseId };
    }
    throw new UserPoolError(429, 'pool_exhausted', this.options.retryAfterSeconds);
  }

  /** The least recently used leasable member of one enterprise; `excluded` bounds the whole admission. */
  private async idleMember(tx: Tx, enterpriseId: string, excluded: string[]): Promise<string | undefined> {
    while (excluded.length < ADMISSION_CANDIDATES) {
      const identity = await this.idleCandidate(tx, enterpriseId, 'ready', excluded)
        ?? await this.idleCandidate(tx, enterpriseId, 'cooling', excluded);
      if (!identity) return undefined;
      excluded.push(identity);
      if (await this.claimCandidate(tx, identity)) return identity;
    }
    return undefined;
  }

  /**
   * Candidate discovery must NOT lock inventory before Proxy. Include idle expired bindings/cooldowns so admission
   * does not depend on a sweep worker. Equality on (enterprise_id, state) keeps the ordered LIMIT scan on the index.
   */
  private async idleCandidate(tx: Tx, enterpriseId: string, state: 'ready' | 'cooling',
    excluded: readonly string[]): Promise<string | undefined> {
    const cooled = state === 'cooling' ? `AND p.cooldown_until<=${DB_NOW}` : '';
    const exclusion = excluded.length ? `AND p.identity NOT IN (${excluded.map(() => '?').join(',')})` : '';
    const row = await this.one<{ identity: string }>(tx.connection, `
      SELECT p.identity
      FROM user_pool_accounts p FORCE INDEX (idx_user_pool_accounts_enterprise_state)
      WHERE p.enterprise_id=?
        AND p.state=?
        ${cooled}
        ${exclusion}
        AND NOT EXISTS (
          SELECT 1
          FROM user_pool_leases l
          WHERE l.member_identity=p.identity
            AND (l.expires_at>${DB_NOW} OR EXISTS (
              SELECT 1 FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>${DB_NOW}))
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity AND h.expires_at>${DB_NOW}
        )
      ORDER BY p.updated_at, p.ordinal
      LIMIT 1`, [enterpriseId, state, ...excluded]);
    return row?.identity;
  }

  /** `FOR UPDATE SKIP LOCKED` on the Proxy row, then a recheck under that lock. */
  private async claimCandidate(tx: Tx, identity: string): Promise<boolean> {
    if (!await this.lockCredential(tx, identity, true)) return false;
    await this.reclaimMemberTx(tx, identity);
    // The discovery result may already be stale. Every writer of these bindings
    // holds this same Proxy row; recheck after obtaining it, not in the join.
    const inventory = await this.readInventory(tx.connection, identity);
    if (inventory?.state !== 'ready' || inventory.verified_at === null
      || !validCredential(tx.credentials!.get(identity))) return false;
    const bound = await this.one(tx.connection, `
      SELECT 1 FROM user_pool_leases WHERE member_identity=?
      UNION ALL SELECT 1 FROM user_pool_catalog_holds WHERE member_identity=?
      LIMIT 1`, [identity, identity]);
    return !bound;
  }

  private async assertReady(tx: Tx, identity: string): Promise<void> {
    const credential = await this.lockCredential(tx, identity);
    const member = await this.readInventory(tx.connection, identity);
    if (member?.state === 'cooling') throw new UserPoolError(429, 'member_cooling',
      Math.max(1, Math.ceil((member.cooldown_until - await this.time(tx.connection)) / 1000)));
    if (member?.state !== 'ready' || member.verified_at === null || !validCredential(credential)) {
      throw new UserPoolError(503, 'member_unavailable');
    }
  }

  private async hold(tx: Tx, lease: Lease, kind: 'lease' | 'catalog', timeoutMs = this.options.requestTimeoutMs): Promise<HeldLease> {
    const requestId = randomUUID();
    const deadline = await this.time(tx.connection) + timeoutMs;
    const generation = (await this.readInventory(tx.connection, lease.member_identity))!.generation;
    if (kind === 'catalog') {
      await this.exec(tx, `INSERT INTO user_pool_catalog_holds
        (request_id, lease_id, caller_id, member_identity, assigned_at, expires_at, deadline_at, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [requestId, lease.lease_id, lease.caller_id, lease.member_identity,
        lease.assigned_at, deadline + HOLD_DRAIN_MS, deadline, generation]);
    } else {
      await this.exec(tx, 'INSERT INTO user_pool_holds(request_id, lease_id, expires_at, deadline_at, generation) VALUES (?, ?, ?, ?, ?)',
        [requestId, lease.lease_id, deadline + HOLD_DRAIN_MS, deadline, generation]);
    }
    return { ...lease, request_id: requestId, kind, deadline_at: deadline };
  }

  private async heldRow(tx: Tx, held: HeldLease): Promise<HoldRow | undefined> {
    const row = await this.one<HoldRow>(tx.connection, held.kind === 'catalog'
      ? 'SELECT * FROM user_pool_catalog_holds WHERE request_id=? AND lease_id=?'
      : `SELECT h.*, l.member_identity, l.caller_id FROM user_pool_holds h
        JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE h.request_id=? AND h.lease_id=?`, [held.request_id, held.lease_id]);
    return row?.member_identity === held.member_identity && row.caller_id === held.caller_id ? row : undefined;
  }

  private async currentHold(tx: Tx, held: HeldLease): Promise<HoldRow | undefined> {
    const row = await this.heldRow(tx, held);
    if (!row) return undefined;
    const credential = await this.lockCredential(tx, row.member_identity);
    const now = await this.time(tx.connection);
    if (row.deadline_at <= now || row.expires_at <= now) return undefined;
    const member = await this.readInventory(tx.connection, row.member_identity);
    if (!member || member.generation !== row.generation || !['ready', 'cooling'].includes(member.state)) return undefined;
    return validCredential(credential) ? row : undefined;
  }

  private async invalidate(tx: Tx, identity: string, expectedToken: string, now: number, owner?: string, held?: HeldLease): Promise<boolean> {
    const timestamp = mysqlTimestamp(now);
    const table = held?.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds';
    return (await this.exec(tx, `UPDATE proxy_accounts SET copilot_oauth_token=NULL, copilot_oauth_status='expired',
      copilot_oauth_attempt_id=NULL, copilot_oauth_updated_at=?, updated_at=?
      WHERE identity=? AND CAST(copilot_oauth_token AS BINARY)=CAST(? AS BINARY) AND copilot_oauth_status='valid'
      ${owner === undefined ? '' : `AND ${OWNER_SQL}`}
      ${held === undefined ? '' : `AND EXISTS (SELECT 1 FROM ${table} WHERE request_id=? AND lease_id=?
        AND deadline_at>${DB_NOW} AND expires_at>${DB_NOW})`}`,
    [timestamp, timestamp, identity, expectedToken, ...(owner === undefined ? [] : [owner]),
      ...(held === undefined ? [] : [held.request_id, held.lease_id])])).affectedRows === 1;
  }

  private async hasHoldsTx(connection: Connection, identity: string): Promise<boolean> {
    const now = await this.time(connection);
    return Boolean(await this.one(connection, `SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id
      WHERE l.member_identity=? AND h.expires_at>? UNION ALL SELECT 1 FROM user_pool_catalog_holds
      WHERE member_identity=? AND expires_at>? LIMIT 1`, [identity, now, identity, now]));
  }

  private async releaseInactiveTx(tx: Tx, identity: string): Promise<void> {
    await this.lockCredential(tx, identity);
    if (!await this.hasHoldsTx(tx.connection, identity)) {
      await this.exec(tx, 'DELETE FROM user_pool_leases WHERE member_identity=?', [identity]);
    }
  }

  /** The caller's batch already holds the enterprise rows; the member, account and N_e += 1 are one write. */
  private async reserveCandidate(tx: Tx, enterpriseId: string, owner?: string): Promise<Inventory | UserPoolError> {
    let ordinal = (await this.settingsRow(tx.connection)).next_ordinal;
    // A bounded scan also prevents a populated direct-mode namespace monopolizing the gate.
    const end = Math.min(NAME_CAPACITY, ordinal + 128);
    while (ordinal < end) {
      const identity = accountName(ordinal++);
      if (!await this.matchesOwner(tx, owner)) return new UserPoolError(503, 'pool_owner_expired');
      await this.exec(tx, 'UPDATE user_pool_settings SET next_ordinal=? WHERE id=1', [ordinal]);
      if (await this.one(tx.connection, `SELECT 1 FROM proxy_accounts
        WHERE LOWER(identity)=LOWER(?) OR LOWER(sso_user)=LOWER(?) LIMIT 1`, [identity, identity])) continue;
      const now = await this.time(tx.connection);
      const timestamp = mysqlTimestamp(now);
      // Concurrent direct account creation may win after the collision query. Never adopt it.
      // The savepoint also discards a newly inserted Proxy row if ownership expires while waiting.
      await this.exec(tx, 'SAVEPOINT pool_reservation');
      try {
        await this.exec(tx, `
          INSERT INTO proxy_accounts(identity, sso_user, copilot_oauth_status, created_at, updated_at, enterprise_id)
          VALUES (?, ?, 'missing', ?, ?, ?)`, [identity, identity, timestamp, timestamp, enterpriseId]);
      } catch (error) {
        if (mysqlCode(error) === 'ER_DUP_ENTRY') {
          await this.exec(tx, 'ROLLBACK TO SAVEPOINT pool_reservation');
          await this.exec(tx, 'RELEASE SAVEPOINT pool_reservation');
          continue;
        }
        throw error;
      }
      const inserted = await this.exec(tx, `
        INSERT INTO user_pool_accounts(identity, ordinal, state, attempt_id, updated_at, retry_at, enterprise_id)
        SELECT ?, ?, 'provisioning', ?, ?, ?, ? ${owner === undefined ? '' : `WHERE ${OWNER_SQL}`}`,
      [identity, ordinal - 1, randomUUID(), now, now, enterpriseId, ...(owner === undefined ? [] : [owner])]);
      if (!inserted.affectedRows) {
        await this.exec(tx, 'ROLLBACK TO SAVEPOINT pool_reservation');
        await this.exec(tx, 'RELEASE SAVEPOINT pool_reservation');
        return new UserPoolError(503, 'pool_owner_expired');
      }
      await this.exec(tx, `
        UPDATE proxy_enterprises
        SET inventory_count=inventory_count+1
        WHERE id=?`, [enterpriseId]);
      await this.exec(tx, 'RELEASE SAVEPOINT pool_reservation');
      await this.addEvent(tx, 'name_reserved', identity);
      return (await this.readInventory(tx.connection, identity))!;
    }
    return new UserPoolError(503, ordinal >= NAME_CAPACITY ? 'name_catalog_exhausted' : 'name_scan_pending', 1);
  }

  private matchesFence(row: Inventory, fence?: InventoryFence): boolean {
    return fence === undefined || (typeof fence === 'string' ? row.attempt_id === fence
      : row.attempt_id === fence.attempt_id && row.generation === fence.generation
        && (fence.stage === undefined || row.stage === fence.stage));
  }

  private async matchesOwner(tx: Tx, owner?: string): Promise<boolean> {
    if (owner === undefined) return true;
    const row = await this.settingsRow(tx.connection);
    return row.owner === owner && row.owner_until > await this.time(tx.connection);
  }

  private async updateTx(tx: Tx, identity: string, patch: Partial<Inventory>, expected?: InventoryFence, owner?: string,
    held?: HeldLease): Promise<boolean> {
    await this.lockCredential(tx, identity);
    const row = await this.readInventory(tx.connection, identity);
    if (!row || row.state === 'disabled' || !this.matchesFence(row, expected) || !await this.matchesOwner(tx, owner)) return false;
    const entries = Object.entries(patch).filter(([key]) => INVENTORY_KEYS.includes(key));
    if (!entries.length) return true;
    if (patch.state === 'provisioning' && await this.hasHoldsTx(tx.connection, identity)) return false;
    const invalidating = patch.state !== undefined && ['failed', 'disabled', 'provisioning'].includes(patch.state) && patch.state !== row.state;
    const now = await this.time(tx.connection);
    const table = held?.kind === 'catalog' ? 'user_pool_catalog_holds' : 'user_pool_holds';
    const changed = await this.exec(tx, `UPDATE user_pool_accounts SET ${entries.map(([key]) => `${key}=?`).join(', ')}, updated_at=?
      ${invalidating ? ', generation=generation+1' : ''} WHERE identity=?
      ${owner === undefined ? '' : `AND ${OWNER_SQL}`}
      ${held === undefined ? '' : `AND EXISTS (SELECT 1 FROM ${table} WHERE request_id=? AND lease_id=?
        AND deadline_at>${DB_NOW} AND expires_at>${DB_NOW})`}`,
    [...entries.map(([, value]) => value ?? null), now, identity, ...(owner === undefined ? [] : [owner]),
      ...(held === undefined ? [] : [held.request_id, held.lease_id])]);
    if (!changed.affectedRows) return false;
    if (invalidating) await this.exec(tx, 'UPDATE user_pool_leases SET expires_at=LEAST(expires_at, ?) WHERE member_identity=?', [now, identity]);
    return true;
  }
}

function validCredential(row: Credential | undefined): boolean {
  return row?.copilot_oauth_status === 'valid' && Boolean(row.copilot_oauth_token?.length);
}
function mysqlTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().slice(0, 23).replace('T', ' ');
}
function mysqlCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
function isLockError(error: unknown): boolean {
  return ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(String(mysqlCode(error)));
}
function leaseMember(lease: Lease): PoolMember {
  return { identity: lease.member_identity, enterprise_id: lease.enterprise_id };
}
function memberScope(enterpriseId: string | undefined, keyword: 'WHERE' | 'AND'): { sql: string; values: string[] } {
  if (enterpriseId === undefined) return { sql: '', values: [] };
  return { sql: `${keyword} p.enterprise_id=?`, values: [enterpriseId] };
}
const ENTERPRISE_NUMBERS = ['max_accounts', 'inventory_count', 'policy_version', 'created_at', 'updated_at'];
function enterpriseNumbers(row: RowDataPacket): Record<string, unknown> {
  const converted: Record<string, unknown> = { ...row };
  for (const key of ENTERPRISE_NUMBERS.filter((candidate) => row[candidate] !== undefined)) {
    converted[key] = Number(row[key]);
  }
  return converted;
}
