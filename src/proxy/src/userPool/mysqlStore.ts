import { beginMysqlAttempt } from '../db/mysqlAuthorization.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { PoolConfig } from './config.js';
import { normalizeCaller, normalizePoolConfig, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { validateEnterpriseMysqlV4 } from '@ghcp/shared/enterpriseMysqlV4';
import { resolveEnterpriseScope, enterprisePoolPolicyDto,
  type EnterpriseRegistryV3, type EnterprisePoolPolicyRecord, type EnterprisePoolPolicyChange,
  type EnterprisePoolOverviewDto, type EnterprisePoolCountsDto } from '@ghcp/shared';
import { loadProxyEnterpriseRegistry } from '../enterprise.js';
import { leaseMysqlConnection, MysqlDeadline, MysqlDeadlineError } from './mysqlDeadline.js';
import { acquireMysqlCaller, type MysqlCallerPermit } from './mysqlCallerGate.js';
import type { HeldLease, Inventory, InventoryFence, Lease, PoolSettings } from './store.js';
import type { PoolStore, WorkerCredentialFence, WorkerCredentialMutation } from './storage.js';
import type { PoolList, PoolPage, PoolPageQuery } from './paging.js';
import { LOGIN_CAPACITY_SQL, PendingSelection } from './scheduling.js';
import { inferenceHoldTimeoutMs } from './inferenceTimeout.js';
import { enterpriseScores, rankEnterprises, logicalSupplySql, enterprisePolicyBlockers, enterprisePolicyReady,
  applyEnterprisePolicyChange, enterprisePolicyFromRow, DISPATCHED_POOL_STAGES, type EnterpriseSchedulingInput } from './enterpriseScheduling.js';

type Connection = Pool | PoolConnection;
interface Tx { connection: PoolConnection; credentials?: Map<string, Credential | undefined> }
interface SettingsRow extends PoolSettings {
  owner: string | null; owner_until: number; next_ordinal: number;
  account_domain: string; config_fingerprint: string;
}
interface Credential {
  identity: string; copilot_oauth_token: string | null; copilot_oauth_status: string;
}
interface PolicyRow {
  enterprise_id: string; state: EnterprisePoolPolicyRecord['state']; policy_version: number;
  identity_sha256: string; validation_kind: EnterprisePoolPolicyRecord['validationKind'];
  validation_evidence_json: string | null; validated_at: number | null; updated_at: number;
  max_accounts?: number;
}
interface EnterpriseSnapshot extends EnterpriseSchedulingInput {
  policy: EnterprisePoolPolicyRecord;
  counts: EnterprisePoolCountsDto;
  blockedReasons: string[];
}
interface HoldRow {
  request_id: string; lease_id: string; member_identity: string; caller_id: string;
  generation: number; deadline_at: number; expires_at: number;
}
const MANUAL_ERRORS = ['sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed'];
const MANUAL_SQL = MANUAL_ERRORS.map(() => '?').join(',');
const HOLD_DRAIN_MS = 10000;
const REAUTH_WINDOW_MS = 3600000;
const REAUTH_MAX_CYCLES = 3;
// Bound lock duration even with a large target. The scheduler fills subsequent batches.
const RESERVATION_BATCH = 32;
const SETTING_KEYS = ['idle_target', 'lease_seconds', 'paused'];
const INVENTORY_KEYS = ['state', 'stage', 'attempt_id', 'oauth_attempt_id', 'sso_created_at', 'task_id',
  'attempts', 'retry_at', 'last_error', 'cooldown_until', 'verified_at'];
const NUMERIC_KEYS = new Set(['id', 'at', 'n', 'total', 'version', 'idle_target', 'max_accounts', 'lease_seconds',
  'paused', 'owner_until', 'next_ordinal', 'ordinal', 'attempts', 'retry_at', 'updated_at',
  'cooldown_until', 'verified_at', 'generation', 'reauth_count', 'reauth_window_at', 'assigned_at',
  'last_success_at', 'expires_at', 'deadline_at', 'active_requests', 'now', 'enterprise_revision',
  'active_max_accounts', 'policy_version', 'validated_at', 'inventory', 'eligible_idle', 'pending_supply',
  'ready_idle', 'provisioning', 'failed', 'cooling', 'disabled', 'leased', 'provisional']);
const DB_NOW = "(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000)";
const OWNER_SQL = `EXISTS (SELECT 1 FROM user_pool_settings WHERE id=1 AND owner=? AND owner_until>${DB_NOW})`;

/** SQL is authoritative. No credential cache and no network work inside transactions. */
export class MysqlPoolStore implements PoolStore {
  private readonly options: PoolConfig;
  private reclaimCursor = '';
  private readonly pendingSelection = new PendingSelection();

  private enterpriseId?: string;
  private registry?: EnterpriseRegistryV3;

  constructor(private readonly pool: Pool, options: PoolConfig, private readonly expectedRegistry?: EnterpriseRegistryV3) {
    this.options = normalizePoolConfig(options);
  }

  async initialize(): Promise<void> {
    const expected = this.expectedRegistry ?? loadProxyEnterpriseRegistry();
    // Targets/cap/lease duration remain mutable persisted settings, not configuration invariants.
    const { idleTarget: _idle, maxAccounts: _max, leaseSeconds: _lease, enabled: _enabled,
      callerDomain: _legacy, ...invariants } = this.options;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(Object.entries(invariants).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex');
    await this.withConnection(async (connection) => {
      const state = await validateEnterpriseMysqlV4(connection, 'proxy', expected);
      if (state.layout !== 'pool') throw new Error('enterprise_pool_layout_required');
      this.enterpriseId = state.legacyEnterpriseId;
      this.registry = state.registry;
      const settings = await this.settingsRow(connection);
      if (settings.account_domain !== this.options.accountDomain) {
        throw new Error('Pool account email domain differs from persisted inventory');
      }
      if (settings.config_fingerprint !== fingerprint) throw new Error('Pool configuration differs between Proxy replicas');
      this.enterpriseId = state.legacyEnterpriseId;
    }, 30000);
  }

  async now(): Promise<number> { return this.time(this.pool); }

  async settings(): Promise<PoolSettings> { return this.readSettings(this.pool); }

  async updateSettings(version: number, patch: Partial<PoolSettings>): Promise<PoolSettings> {
    return this.tx(async (tx) => {
      if (!Number.isSafeInteger(version) || !patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some((key) => !SETTING_KEYS.includes(key))) throw new UserPoolError(400, 'invalid_pool_settings');
      const current = await this.readSettings(tx.connection);
      if (version !== current.version) throw new UserPoolError(409, 'settings_version_conflict');
      const next = { ...current, ...patch };
      if (!Number.isInteger(next.idle_target) || next.idle_target < 0 || next.idle_target > NAME_CAPACITY
        || !Number.isInteger(next.lease_seconds) || next.lease_seconds < 60 || next.lease_seconds > 2592000
        || ![0, 1].includes(next.paused)) throw new UserPoolError(400, 'invalid_pool_settings');
      await this.exec(tx, `UPDATE user_pool_settings SET idle_target=?, lease_seconds=?,
        paused=?, version=version+1 WHERE id=1 AND version=?`, [next.idle_target, next.lease_seconds, next.paused, version]);
      await this.addEvent(tx, 'settings_updated');
      return this.readSettings(tx.connection);
    });
  }

  async enterprisePolicies(): Promise<EnterprisePoolPolicyRecord[]> {
    return this.readPolicies(this.pool);
  }

  async enterprisePolicy(id: string): Promise<EnterprisePoolPolicyRecord | undefined> {
    return (await this.readPolicies(this.pool, id))[0];
  }

  async updateEnterprisePolicy(id: string, expectedVersion: number,
    change: EnterprisePoolPolicyChange): Promise<EnterprisePoolPolicyRecord> {
    return this.tx(async tx => {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new UserPoolError(400, 'invalid_enterprise_policy');
      // Every exclusive policy writer first holds settings X. This locking query
      // MUST remain policy-only: joining profiles would invert admission's locks.
      const row = await this.one<PolicyRow>(tx.connection,
        'SELECT * FROM enterprise_pool_policy WHERE enterprise_id=? FOR UPDATE', [id]);
      if (!row) throw new UserPoolError(404, 'enterprise_not_found');
      if (row.policy_version !== expectedVersion) throw new UserPoolError(409, 'policy_version_conflict');
      const profile = await this.one<{ max_accounts: number }>(tx.connection,
        'SELECT max_accounts FROM enterprise_profiles WHERE id=?', [id]);
      if (!profile) throw new UserPoolError(404, 'enterprise_not_found');
      const current = this.policyRecord({ ...row, max_accounts: profile.max_accounts });
      const next = applyEnterprisePolicyChange(this.currentRegistry(), current, change, await this.time(tx.connection));
      if (change.type === 'cap') {
        const caps = await this.one<{ n: number }>(tx.connection,
          'SELECT COALESCE(SUM(max_accounts),0) n FROM enterprise_profiles WHERE id<>?', [id]);
        if (caps!.n + next.maxAccounts > NAME_CAPACITY) throw new UserPoolError(400, 'invalid_enterprise_policy');
        await this.exec(tx, 'UPDATE enterprise_profiles SET max_accounts=? WHERE id=?', [next.maxAccounts, id]);
      }
      await this.exec(tx, `UPDATE enterprise_pool_policy SET state=?, policy_version=?, identity_sha256=?,
        validation_kind=?, validation_evidence_json=?, validated_at=?, updated_at=? WHERE enterprise_id=? AND policy_version=?`,
      [next.state, next.policyVersion, next.identitySha256, next.validationKind,
        next.validationEvidence === null ? null : JSON.stringify(next.validationEvidence), next.validatedAt, next.updatedAt,
        id, expectedVersion]);
      // Policy row version/timestamp is the audit trail. NEVER add/prune pool
      // events or touch member/lease/hold rows while this policy X is held.
      return next;
    });
  }

  async enterpriseOverview(): Promise<EnterprisePoolOverviewDto> {
    return this.tx(async tx => {
      const observedAt = await this.time(tx.connection);
      const settings = await this.readSettings(tx.connection);
      const state = await this.settingsRow(tx.connection);
      const snapshots = await this.enterpriseSnapshot(tx.connection, observedAt);
      const scores = new Map(enterpriseScores(snapshots).map(row => [row.enterpriseId, row]));
      const eligibleIdle = snapshots.reduce((sum, row) => sum + row.eligibleIdle, 0);
      const pendingSupply = snapshots.reduce((sum, row) => sum + row.pendingSupply, 0);
      const deficit = Math.max(0, settings.idle_target - eligibleIdle - pendingSupply);
      const blockedReasons: string[] = [];
      if (settings.paused) blockedReasons.push('pool_paused');
      if (!snapshots.some(row => row.state === 'active')) blockedReasons.push('no_active_enterprises');
      if (settings.idle_target > settings.active_max_accounts) blockedReasons.push('idle_target_above_active_capacity');
      if (state.next_ordinal >= NAME_CAPACITY) blockedReasons.push('name_catalog_exhausted');
      if (deficit > 0 && !rankEnterprises(snapshots, { kind: 'creation', ordinal: state.next_ordinal }).length) {
        blockedReasons.push('enterprise_capacity_exhausted');
      }
      return {
        enabled: this.options.enabled, legacyEnterpriseId: this.currentRegistry().legacyEnterpriseId, observedAt,
        settings: { ...settings, paused: settings.paused as 0 | 1 },
        enterprises: snapshots.map(row => {
          const score = scores.get(row.enterpriseId)!;
          return { ...enterprisePoolPolicyDto(resolveEnterpriseScope(this.currentRegistry(), row.enterpriseId).profile, row.policy),
            counts: row.counts, eligibleIdle: row.eligibleIdle, pendingSupply: row.pendingSupply,
            targetShare: score.targetShare, actualShare: score.actualShare, shareDeficit: score.shareDeficit,
            score: score.score, overCap: row.inventory > row.maxAccounts, blockedReasons: row.blockedReasons };
        }),
        supply: { eligibleIdle, pendingSupply, deficit },
        names: { capacity: NAME_CAPACITY, nextOrdinal: state.next_ordinal,
          remainingPositions: Math.max(0, NAME_CAPACITY - state.next_ordinal) }, blockedReasons,
      };
    }, false);
  }

  async canProvision(identity: string, mode: 'advance' | 'observe' = 'advance'): Promise<boolean> {
    return this.withConnection(async connection => {
      const row = await this.readInventory(connection, identity);
      return Boolean(row && await this.canProvisionTx({ connection }, row, mode));
    });
  }

  async claimLoginDispatch(identity: string, fence: WorkerCredentialFence, owner: string, limit: number): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new UserPoolError(400, 'invalid_login_limit');
    return this.tx(async (tx) => {
      const candidate = await this.readInventory(tx.connection, identity);
      if (!candidate || !await this.canProvisionTx(tx, candidate, 'advance', true)) return false;
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || row.state !== 'provisioning' || row.stage !== 'oauth-starting' || !this.matchesFence(row, fence)
        || !await this.canProvisionTx(tx, row, 'advance')
        || !await this.matchesOwner(tx, owner) || await this.hasHoldsTx(tx.connection, identity)) return false;
      const occupied = await this.one<{ n: number }>(tx.connection,
        "SELECT COUNT(*) n FROM user_pool_accounts WHERE stage IN ('oauth-dispatch', 'oauth-wait')");
      if (occupied!.n >= limit) return false;
      return this.updateTx(tx, identity, { stage: 'oauth-dispatch' }, fence, owner);
    });
  }

  async listLoginReservations(): Promise<Inventory[]> {
    return this.rows<Inventory>(this.pool, `SELECT p.*, a.enterprise_id, e.revision enterprise_revision
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      JOIN enterprise_profiles e ON e.id=a.enterprise_id WHERE p.stage IN ('oauth-dispatch', 'oauth-wait')
      AND (p.state='disabled' OR (p.state='failed' AND p.attempts>=3)) ORDER BY p.ordinal LIMIT 100`);
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
    }, false);
  }

  async events(enterpriseId?: string): Promise<unknown[]> {
    return this.rows(this.pool, `SELECT * FROM user_pool_events ${enterpriseId === undefined ? '' : 'WHERE enterprise_id=?'}
      ORDER BY id DESC LIMIT 200`, enterpriseId === undefined ? [] : [enterpriseId]);
  }

  async accounts(enterpriseId?: string): Promise<unknown[]> {
    return this.withConnection(async (connection) => {
      const now = await this.time(connection);
      return this.rows(connection, `SELECT p.*, a.enterprise_id, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>?)
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity AND h.expires_at>?) AS active_requests
        FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        LEFT JOIN user_pool_leases l ON l.member_identity=p.identity
        ${enterpriseId === undefined ? '' : 'WHERE a.enterprise_id=?'} ORDER BY p.ordinal LIMIT 1000`,
      [now, now, ...(enterpriseId === undefined ? [] : [enterpriseId])]);
    });
  }

  async leases(enterpriseId?: string): Promise<Array<Lease & { active_requests: number }>> {
    return this.rows<Lease & { active_requests: number }>(this.pool, `SELECT l.*, a.enterprise_id,
      (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>${DB_NOW})
      + (SELECT COUNT(*) FROM user_pool_catalog_holds h WHERE h.member_identity=l.member_identity AND h.expires_at>${DB_NOW}) AS active_requests
      FROM user_pool_leases l JOIN proxy_accounts a ON a.identity=l.member_identity
      ${enterpriseId === undefined ? '' : 'WHERE a.enterprise_id=?'} ORDER BY assigned_at DESC, lease_id LIMIT 1000`,
    enterpriseId === undefined ? [] : [enterpriseId]);
  }

  async inventory(identity: string): Promise<Inventory | undefined> { return this.readInventory(this.pool, identity); }

  async managesSsoUser(ssoUser: string, enterpriseId = this.enterpriseId): Promise<boolean> {
    if (!enterpriseId) throw new Error('MySQL pool storage has not been initialized.');
    return Boolean(await this.one(this.pool, `SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      WHERE a.enterprise_id=? AND LOWER(a.sso_user)=LOWER(?) LIMIT 1`, [enterpriseId, ssoUser]));
  }

  async counts(enterpriseId?: string): Promise<Record<string, number>> {
    return this.tx((tx) => this.readCounts(tx, enterpriseId), false);
  }
  async reclaim(): Promise<void> { await this.tx((tx) => this.reclaimTx(tx)); }

  async acquire(caller: string, signal?: AbortSignal, requestTimeoutMs?: number): Promise<HeldLease> {
    normalizeCaller(caller);
    const holdTimeoutMs = inferenceHoldTimeoutMs(requestTimeoutMs, this.options.requestTimeoutMs);
    return this.admit(caller, async (tx, identity, current) => {
      let lease = current;
      if (!lease) {
        const member = (await this.readInventory(tx.connection, identity))!;
        await this.assertActivePolicy(tx, member.enterprise_id);
        const now = await this.time(tx.connection);
        lease = { caller_id: caller, member_identity: identity, lease_id: randomUUID(), phase: 'provisional',
          assigned_at: now, last_success_at: null, expires_at: now + this.options.provisionalSeconds * 1000 };
        await this.exec(tx, `INSERT INTO user_pool_leases
          (caller_id, member_identity, lease_id, phase, assigned_at, last_success_at, expires_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)`, [caller, identity, lease.lease_id, lease.phase, now, lease.expires_at]);
        await this.exec(tx, 'UPDATE user_pool_accounts SET updated_at=? WHERE identity=?', [now, identity]);
        await this.addEvent(tx, 'lease_acquired', identity, caller, lease.lease_id);
      }
      return this.hold(tx, lease, 'lease', holdTimeoutMs);
    }, signal);
  }

  async acquireCatalog(caller: string, signal?: AbortSignal): Promise<HeldLease> {
    normalizeCaller(caller);
    return this.admit(caller, async (tx, identity) => {
      const member = (await this.readInventory(tx.connection, identity))!;
      await this.assertActivePolicy(tx, member.enterprise_id);
      const now = await this.time(tx.connection);
      return this.hold(tx, { caller_id: caller, member_identity: identity, lease_id: randomUUID(), phase: 'provisional',
        assigned_at: now, last_success_at: null, expires_at: now + this.options.requestTimeoutMs }, 'catalog');
    }, signal);
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
      JOIN enterprise_profiles e ON e.id=a.enterprise_id
      WHERE h.request_id=? AND h.lease_id=? AND ${member}=? AND ${caller}=? AND a.enterprise_id=? AND e.revision=?
        AND h.deadline_at>${DB_NOW} AND h.expires_at>${DB_NOW} AND h.generation=p.generation
        AND p.state IN ('ready','cooling') AND a.copilot_oauth_status='valid' AND LENGTH(a.copilot_oauth_token)>0`,
    [held.request_id, held.lease_id, held.member_identity, held.caller_id, held.enterprise_id, held.enterprise_revision]));
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

  async release(leaseId: string, enterpriseId?: string): Promise<void> {
    await this.tx(async (tx) => {
      let lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      if (!lease) throw new UserPoolError(404, 'lease_not_found');
      await this.lockCredential(tx, lease.member_identity);
      lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      if (!lease) throw new UserPoolError(404, 'lease_not_found');
      const member = await this.readInventory(tx.connection, lease.member_identity);
      if (!member || enterpriseId !== undefined && member.enterprise_id !== enterpriseId) throw new UserPoolError(404, 'lease_not_found');
      if (await this.hasHoldsTx(tx.connection, lease.member_identity)) throw new UserPoolError(409, 'lease_in_use');
      await this.exec(tx, 'DELETE FROM user_pool_leases WHERE lease_id=?', [leaseId]);
      await this.addEvent(tx, 'lease_released', lease.member_identity, lease.caller_id, lease.lease_id);
    });
  }

  async hasHolds(identity: string): Promise<boolean> {
    return this.withConnection((connection) => this.hasHoldsTx(connection, identity));
  }
  async releaseInactive(identity: string): Promise<void> { await this.tx((tx) => this.releaseInactiveTx(tx, identity)); }

  async reserve(): Promise<Inventory | undefined> {
    const result = await this.tx(async (tx) => await this.reservationDeficit(tx) === 0 ? undefined : this.reserveCandidate(tx));
    if (result instanceof UserPoolError) throw result;
    return result;
  }

  async reserveDeficit(owner: string, eligibleEnterpriseIds?: readonly string[]): Promise<number> {
    const eligible = this.creationEligibility(eligibleEnterpriseIds);
    return this.tx(async (tx) => {
      if (!await this.matchesOwner(tx, owner)) return 0;
      let reserved = 0;
      for (; reserved < RESERVATION_BATCH; reserved++) {
        if (!await this.matchesOwner(tx, owner) || await this.reservationDeficit(tx) === 0) break;
        const row = await this.reserveCandidate(tx, owner, eligible);
        if (!row || row instanceof UserPoolError) break;
      }
      return reserved;
    });
  }

  async pending(excluded: readonly string[] = []): Promise<Inventory | undefined> {
    const row = await this.tx(async (tx) => {
      await this.reclaimTx(tx);
      if ((await this.readSettings(tx.connection)).paused) return undefined;
      const registry = this.currentRegistry();
      const policies = (await this.readPolicies(tx.connection)).filter(policy => {
        const profile = registry.profiles.find(profile => profile.id === policy.enterpriseId);
        return profile && enterprisePolicyReady(policy, profile, registry.legacyEnterpriseId);
      });
      const active = policies.filter(policy => policy.state === 'active').map(policy => policy.enterpriseId);
      const draining = policies.filter(policy => ['validated', 'draining'].includes(policy.state)).map(policy => policy.enterpriseId);
      if (!active.length && !draining.length) return undefined;
      const inIds = (ids: string[]) => ids.length ? `a.enterprise_id IN (${ids.map(() => '?').join(',')})` : '0=1';
      const policySql = `(${inIds(active)} OR (${inIds(draining)} AND (p.stage IN (${DISPATCHED_POOL_STAGES.map(() => '?').join(',')})
        OR EXISTS (SELECT 1 FROM user_pool_leases obligation WHERE obligation.member_identity=p.identity AND obligation.expires_at>${DB_NOW}))))`;
      const exclusion = excluded.length ? `AND p.identity NOT IN (${excluded.map(() => '?').join(',')})` : '';
      return this.one<Inventory>(tx.connection, `SELECT p.*, a.enterprise_id, e.revision enterprise_revision
        FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        JOIN enterprise_profiles e ON e.id=a.enterprise_id WHERE p.retry_at<=? AND (
        p.state='provisioning' OR (p.state='failed' AND p.attempts<3 AND COALESCE(p.last_error, '') NOT IN (${MANUAL_SQL})))
        AND p.cooldown_until<=${DB_NOW} AND ${policySql} ${exclusion} AND NOT EXISTS (SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id=h.lease_id
          WHERE l.member_identity=p.identity)
        AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity)
        AND ${LOGIN_CAPACITY_SQL}
        ORDER BY ${this.pendingSelection.orderSql()} LIMIT 1`,
      [await this.time(tx.connection), ...MANUAL_ERRORS, ...active, ...draining, ...DISPATCHED_POOL_STAGES,
        ...excluded, this.options.loginMaxPending ?? 5]);
    });
    if (row) this.pendingSelection.selected();
    return row;
  }

  async update(identity: string, patch: Partial<Inventory>, expected?: InventoryFence, owner?: string): Promise<boolean> {
    return this.tx(async tx => {
      if (['sso-creating', 'scim-syncing', 'seat-assigning'].includes(patch.stage ?? '')) {
        const candidate = await this.readInventory(tx.connection, identity);
        const dispatchIntent = candidate?.stage === 'new' && patch.stage === 'sso-creating'
          || candidate?.stage === 'sso-created' && patch.stage === 'scim-syncing'
          || candidate?.stage === 'scim-synced' && patch.stage === 'seat-assigning';
        if (dispatchIntent) {
          // Settings X -> chosen policy S -> account. The persisted intent is
          // the admission boundary; never hold these locks across provider I/O.
          if (!await this.canProvisionTx(tx, candidate!, 'advance', true)) return false;
          await this.lockCredential(tx, identity);
          const current = await this.readInventory(tx.connection, identity);
          if (!current || !await this.canProvisionTx(tx, current, 'advance')) return false;
        }
      }
      return this.updateTx(tx, identity, patch, expected, owner);
    });
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

  async disable(identity: string, enterpriseId?: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || enterpriseId !== undefined && row.enterprise_id !== enterpriseId) throw new UserPoolError(404, 'member_not_found');
      if (row.state === 'disabled') return;
      await this.updateTx(tx, identity, { state: 'disabled', attempt_id: randomUUID() });
      await this.releaseInactiveTx(tx, identity);
      await this.addEvent(tx, 'member_disabled', identity);
    });
  }

  async retry(identity: string, enterpriseId?: string): Promise<void> {
    await this.tx(async (tx) => {
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || enterpriseId !== undefined && row.enterprise_id !== enterpriseId) throw new UserPoolError(404, 'member_not_found');
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
      if (mutation.type === 'begin') {
        const candidate = await this.readInventory(tx.connection, identity);
        if (!candidate || !await this.canProvisionTx(tx, candidate, 'advance', true)) return false;
      }
      await this.lockCredential(tx, identity);
      const row = await this.readInventory(tx.connection, identity);
      if (!row || row.state !== 'provisioning' || row.stage !== fence.stage || !this.matchesFence(row, fence)
        || mutation.type === 'begin' && !await this.canProvisionTx(tx, row, 'advance')
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
        const account=await this.one<{account_incarnation:string;gh_login:string|null}>(tx.connection,
          'SELECT account_incarnation,gh_login FROM proxy_accounts WHERE enterprise_id=? AND identity=? AND CAST(sso_user AS BINARY)=CAST(? AS BINARY)',
          [row.enterprise_id,identity,identity]);
        if (!account?.gh_login) return false;
        await beginMysqlAttempt(tx.connection,{enterpriseId:row.enterprise_id,enterpriseRevision:row.enterprise_revision,
          identity,accountIncarnation:account.account_incarnation,oauthAttemptId:mutation.oauthAttemptId,expectedGhLogin:account.gh_login});
        return true;
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

  private currentRegistry(): EnterpriseRegistryV3 {
    const registry = this.registry ?? this.expectedRegistry;
    if (!registry) throw new Error('MySQL pool storage has not been initialized.');
    return registry;
  }

  private policyRecord(row: PolicyRow): EnterprisePoolPolicyRecord {
    return enterprisePolicyFromRow({ ...row });
  }

  private async readPolicies(connection: Connection, id?: string): Promise<EnterprisePoolPolicyRecord[]> {
    const rows = await this.rows<PolicyRow>(connection, `SELECT policy.*, e.max_accounts FROM enterprise_pool_policy policy
      JOIN enterprise_profiles e ON e.id=policy.enterprise_id ${id === undefined ? '' : 'WHERE policy.enterprise_id=?'}
      ORDER BY policy.enterprise_id`, id === undefined ? [] : [id]);
    return rows.map(row => this.policyRecord(row));
  }

  /** Lock only the chosen policy, after admission owns every needed credential row. */
  private async assertActivePolicy(tx: Tx, enterpriseId: string): Promise<void> {
    const row = await this.one<PolicyRow>(tx.connection,
      'SELECT * FROM enterprise_pool_policy WHERE enterprise_id=? FOR SHARE', [enterpriseId]);
    const profile = resolveEnterpriseScope(this.currentRegistry(), enterpriseId).profile;
    if (!row || row.state !== 'active'
      || !enterprisePolicyReady(this.policyRecord({ ...row, max_accounts: profile.maxAccounts }), profile,
        this.currentRegistry().legacyEnterpriseId)) throw new UserPoolError(503, 'enterprise_not_active', 1);
  }

  private async canProvisionTx(tx: Tx, row: Inventory, mode: 'advance' | 'observe', lock = false): Promise<boolean> {
    const policyRow = await this.one<PolicyRow>(tx.connection,
      `SELECT * FROM enterprise_pool_policy WHERE enterprise_id=?${lock ? ' FOR SHARE' : ''}`, [row.enterprise_id]);
    const registry = this.currentRegistry();
    const profile = registry.profiles.find(profile => profile.id === row.enterprise_id);
    if (!policyRow || !profile || !enterprisePolicyReady(
      this.policyRecord({ ...policyRow, max_accounts: profile.maxAccounts }), profile, registry.legacyEnterpriseId)) return false;
    if (policyRow.state === 'active') return true;
    if (!['validated', 'draining'].includes(policyRow.state)) return false;
    if (mode === 'observe' && (DISPATCHED_POOL_STAGES as readonly string[]).includes(row.stage)) return true;
    return Boolean(await this.one(tx.connection,
      `SELECT 1 FROM user_pool_leases WHERE member_identity=? AND expires_at>${DB_NOW}`, [row.identity]));
  }

  private async enterpriseSnapshot(connection: Connection, now: number): Promise<EnterpriseSnapshot[]> {
    const supply = logicalSupplySql(String(now));
    const leaseLive = `(l.expires_at>${now} OR p.cooldown_until>${now}
      OR EXISTS (SELECT 1 FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>${now})
      OR EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity=p.identity AND h.expires_at>${now}))`;
    type CountRow = EnterprisePoolCountsDto & { enterprise_id: string; eligible_idle: number; pending_supply: number };
    // One grouped inventory snapshot, all states included; no per-enterprise
    // inventory/count queries and no cleanup side effects in a summary.
    const counts = await this.rows<CountRow>(connection, `SELECT a.enterprise_id, COUNT(*) total,
      SUM(CASE WHEN ${supply.eligibleIdle} THEN 1 ELSE 0 END) ready_idle,
      SUM(CASE WHEN p.state='provisioning' THEN 1 ELSE 0 END) provisioning,
      SUM(CASE WHEN p.state='failed' THEN 1 ELSE 0 END) failed,
      SUM(CASE WHEN p.state='cooling' THEN 1 ELSE 0 END) cooling,
      SUM(CASE WHEN p.state='disabled' THEN 1 ELSE 0 END) disabled,
      SUM(CASE WHEN l.phase='active' AND ${leaseLive} THEN 1 ELSE 0 END) leased,
      SUM(CASE WHEN l.phase='provisional' AND ${leaseLive} THEN 1 ELSE 0 END) provisional,
      SUM(CASE WHEN ${supply.eligibleIdle} THEN 1 ELSE 0 END) eligible_idle,
      SUM(CASE WHEN ${supply.pendingSupply} THEN 1 ELSE 0 END) pending_supply
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      LEFT JOIN user_pool_leases l ON l.member_identity=p.identity GROUP BY a.enterprise_id`);
    const byEnterprise = new Map(counts.map(row => [row.enterprise_id, row]));
    return (await this.readPolicies(connection)).map(policy => {
      const row = byEnterprise.get(policy.enterpriseId);
      const blockedReasons = enterprisePolicyBlockers(this.currentRegistry(), policy);
      const eligible = blockedReasons.length === 0;
      const inventory = Number(row?.total ?? 0);
      const logicalCounts: EnterprisePoolCountsDto = { total: inventory, ready_idle: Number(row?.ready_idle ?? 0),
        provisioning: Number(row?.provisioning ?? 0), failed: Number(row?.failed ?? 0), cooling: Number(row?.cooling ?? 0),
        disabled: Number(row?.disabled ?? 0), leased: Number(row?.leased ?? 0), provisional: Number(row?.provisional ?? 0) };
      if (inventory >= policy.maxAccounts) blockedReasons.push('enterprise_cap_reached');
      return { enterpriseId: policy.enterpriseId, state: policy.state, maxAccounts: policy.maxAccounts,
        inventory, eligible, eligibleIdle: eligible ? Number(row?.eligible_idle ?? 0) : 0,
        pendingSupply: eligible ? Number(row?.pending_supply ?? 0) : 0, counts: logicalCounts, policy, blockedReasons };
    });
  }

  private async settingsRow(connection: Connection): Promise<SettingsRow> {
    const row = await this.one<SettingsRow>(connection, `SELECT s.*,
      (SELECT COALESCE(SUM(max_accounts),0) FROM enterprise_profiles) max_accounts,
      (SELECT COALESCE(SUM(e.max_accounts),0) FROM enterprise_profiles e JOIN enterprise_pool_policy policy
        ON policy.enterprise_id=e.id WHERE policy.state='active') active_max_accounts
      FROM user_pool_settings s WHERE s.id=1`);
    if (!row) throw new Error('User pool settings have not been initialized');
    return row;
  }

  private async readSettings(connection: Connection): Promise<PoolSettings> {
    const { version, idle_target, max_accounts, active_max_accounts, lease_seconds, paused } = await this.settingsRow(connection);
    return { version, idle_target, max_accounts, active_max_accounts, lease_seconds, paused };
  }

  private readInventory(connection: Connection, identity: string): Promise<Inventory | undefined> {
    return this.one<Inventory>(connection, `SELECT p.*, a.enterprise_id, e.revision enterprise_revision
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      JOIN enterprise_profiles e ON e.id=a.enterprise_id WHERE p.identity=?`, [identity]);
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

  private async addEvent(tx: Tx, action: string, identity?: string, caller?: string, leaseId?: string, detail?: string): Promise<void> {
    await this.exec(tx, `INSERT INTO user_pool_events(at, action, identity, caller_id, lease_id, detail, enterprise_id)
      VALUES (?, ?, ?, ?, ?, ?, (SELECT enterprise_id FROM proxy_accounts WHERE identity=?))`,
    [await this.time(tx.connection), action, identity ?? null, caller ?? null, leaseId ?? null, detail ?? null, identity ?? null]);
    // MySQL forbids directly selecting a DELETE target in its scalar subquery.
    const cutoff = (await this.one<{ n: number }>(tx.connection, 'SELECT CAST(COALESCE(MAX(id), 0) AS SIGNED)-10000 AS n FROM user_pool_events'))!.n;
    if (cutoff > 0) await this.exec(tx, 'DELETE FROM user_pool_events WHERE id<=?', [cutoff]);
  }

  private async readCounts(tx: Tx, enterpriseId?: string): Promise<Record<string, number>> {
    const now = await this.time(tx.connection);
    const snapshots = await this.enterpriseSnapshot(tx.connection, now);
    const result: Record<string, number> = { total: 0, ready_idle: 0, provisioning: 0, failed: 0,
      cooling: 0, disabled: 0, leased: 0, provisional: 0, catalog_requests: 0 };
    for (const row of snapshots) {
      if (enterpriseId !== undefined && row.enterpriseId !== enterpriseId) continue;
      for (const [key, value] of Object.entries(row.counts)) result[key] += value;
    }
    result.catalog_requests = (await this.one<{ n: number }>(tx.connection, `SELECT COUNT(*) n
      FROM user_pool_catalog_holds h JOIN proxy_accounts a ON a.identity=h.member_identity
      WHERE h.expires_at>? ${enterpriseId === undefined ? '' : 'AND a.enterprise_id=?'}`,
    [now, ...(enterpriseId === undefined ? [] : [enterpriseId])]))!.n;
    return result;
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

  private async admit(caller: string,
    acquire: (tx: Tx, identity: string, lease?: Lease) => Promise<HeldLease>, signal?: AbortSignal): Promise<HeldLease> {
    const deadline = new MysqlDeadline(this.options.requestTimeoutMs);
    const permit = await acquireMysqlCaller(this.pool, caller, deadline, signal);
    try {
      return await this.admitTx(caller, acquire, deadline, signal, permit);
    } finally {
      // SQL retries and RELEASE_LOCK/socket disposal finish before this handoff.
      // A canceled getConnection retains its own reference until late disposal.
      permit.release();
    }
  }

  private async admitTx(caller: string,
    acquire: (tx: Tx, identity: string, lease?: Lease) => Promise<HeldLease>, deadline: MysqlDeadline,
    signal: AbortSignal | undefined, permit: MysqlCallerPermit): Promise<HeldLease> {
    const result = await this.tx(async (tx) => {
      // Only this caller's old bindings are reclaimed. Cross-caller inactive
      // inventory is discovered lazily by availableMember, not a global sweep.
      const bound = await this.rows<{ identity: string }>(tx.connection, `
        SELECT member_identity AS identity FROM user_pool_leases WHERE caller_id=?
        UNION SELECT member_identity FROM user_pool_catalog_holds WHERE caller_id=?
        UNION SELECT member_identity FROM user_pool_catalog_cooldowns WHERE caller_id=? ORDER BY identity`, [caller, caller, caller]);
      for (const { identity } of bound) await this.reclaimMemberTx(tx, identity);
      let identity: string;
      let lease: Lease | undefined;
      try {
        await this.assertCallerNotCooling(tx, caller);
        lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE caller_id=?', [caller]);
        identity = lease?.member_identity ?? await this.availableMember(tx, caller);
        await this.assertReady(tx, identity);
        // Re-read after taking the credential lock: finish may have renewed or
        // removed the initial binding while admission was waiting for that lock.
        lease = await this.one<Lease>(tx.connection, 'SELECT * FROM user_pool_leases WHERE caller_id=?', [caller]);
        if (lease && lease.expires_at <= await this.time(tx.connection)) throw new UserPoolError(503, 'lease_draining', 1);
      } catch (error) {
        if (!(error instanceof UserPoolError)) throw error;
        return error; // Commit quarantine/cleanup even when admission rejects.
      }
      await this.exec(tx, 'SAVEPOINT pool_admission');
      try {
        const held = await acquire(tx, identity, lease);
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

  private async assertCallerNotCooling(tx: Tx, caller: string): Promise<void> {
    const now = await this.time(tx.connection);
    const row = await this.one<{ expires_at: number }>(tx.connection,
      'SELECT expires_at FROM user_pool_catalog_cooldowns WHERE caller_id=? AND expires_at>?', [caller, now]);
    if (row) throw new UserPoolError(429, 'member_cooling', Math.max(1, Math.ceil((row.expires_at - now) / 1000)));
  }

  private async availableMember(tx: Tx, caller: string): Promise<string> {
    const catalog = await this.one<{ member_identity: string }>(tx.connection,
      'SELECT member_identity FROM user_pool_catalog_holds WHERE caller_id=? ORDER BY assigned_at LIMIT 1', [caller]);
    if (catalog) return catalog.member_identity; // Target caller cleanup already owns its credential lock.
    const excluded: string[] = [];
    const ranked = rankEnterprises(await this.enterpriseSnapshot(tx.connection, await this.time(tx.connection)),
      { kind: 'admission', caller });
    const supply = logicalSupplySql(DB_NOW);
    for (let attempt = 0; attempt < 128; attempt++) {
      if (!ranked.length) break;
      const enterprise = ranked[0];
      // Discovery never locks inventory. All states/enterprises remain in the
      // score denominator; candidate filtering is separate from that arithmetic.
      const member = await this.one<{ identity: string }>(tx.connection, `SELECT p.identity
        FROM user_pool_accounts p FORCE INDEX (idx_user_pool_available)
        JOIN proxy_accounts a ON a.identity=p.identity WHERE a.enterprise_id=? AND ${supply.eligibleIdle}
        ${excluded.length ? `AND p.identity NOT IN (${excluded.map(() => '?').join(',')})` : ''}
        ORDER BY CASE WHEN p.state='ready' THEN 0 ELSE 1 END, p.updated_at, p.ordinal LIMIT 1`,
      [enterprise.enterpriseId, ...excluded]);
      if (!member) { ranked.shift(); continue; }
      excluded.push(member.identity);
      if (!await this.lockCredential(tx, member.identity, true)) continue;
      await this.reclaimMemberTx(tx, member.identity);
      // The discovery result may already be stale. Every writer of these bindings
      // holds this same Proxy row; recheck after obtaining it, not in the join.
      const inventory = await this.readInventory(tx.connection, member.identity);
      if (inventory?.state !== 'ready' || inventory.verified_at === null
        || !validCredential(tx.credentials!.get(member.identity))) continue;
      if (await this.one(tx.connection, `SELECT 1 FROM user_pool_leases WHERE member_identity=?
        UNION ALL SELECT 1 FROM user_pool_catalog_holds WHERE member_identity=? LIMIT 1`, [member.identity, member.identity])) continue;
      return member.identity;
    }
    throw new UserPoolError(429, 'pool_exhausted', this.options.retryAfterSeconds);
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
    const member = (await this.readInventory(tx.connection, lease.member_identity))!;
    const generation = member.generation;
    if (kind === 'catalog') {
      await this.exec(tx, `INSERT INTO user_pool_catalog_holds
        (request_id, lease_id, caller_id, member_identity, assigned_at, expires_at, deadline_at, generation)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [requestId, lease.lease_id, lease.caller_id, lease.member_identity,
        lease.assigned_at, deadline + HOLD_DRAIN_MS, deadline, generation]);
    } else {
      await this.exec(tx, 'INSERT INTO user_pool_holds(request_id, lease_id, expires_at, deadline_at, generation) VALUES (?, ?, ?, ?, ?)',
        [requestId, lease.lease_id, deadline + HOLD_DRAIN_MS, deadline, generation]);
    }
    return { ...lease, enterprise_id: member.enterprise_id, enterprise_revision: member.enterprise_revision,
      request_id: requestId, kind, deadline_at: deadline };
  }

  private async heldRow(tx: Tx, held: HeldLease): Promise<HoldRow | undefined> {
    const row = await this.one<HoldRow>(tx.connection, held.kind === 'catalog'
      ? 'SELECT * FROM user_pool_catalog_holds WHERE request_id=? AND lease_id=?'
      : `SELECT h.*, l.member_identity, l.caller_id FROM user_pool_holds h
        JOIN user_pool_leases l ON l.lease_id=h.lease_id WHERE h.request_id=? AND h.lease_id=?`, [held.request_id, held.lease_id]);
    if (row?.member_identity !== held.member_identity || row.caller_id !== held.caller_id) return undefined;
    const member = await this.readInventory(tx.connection, row.member_identity);
    return member?.enterprise_id === held.enterprise_id && member?.enterprise_revision === held.enterprise_revision ? row : undefined;
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

  private async reservationDeficit(tx: Tx): Promise<number> {
    const settings = await this.readSettings(tx.connection);
    if (settings.paused) return 0;
    const snapshot = await this.enterpriseSnapshot(tx.connection, await this.time(tx.connection));
    return Math.max(0, settings.idle_target - snapshot.reduce((sum, row) => sum + row.eligibleIdle + row.pendingSupply, 0));
  }

  private creationEligibility(ids?: readonly string[]): ReadonlySet<string> | undefined {
    if (ids === undefined) return undefined;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !this.currentRegistry().profiles.some(profile => profile.id === id))) {
      throw new UserPoolError(400, 'invalid_enterprise_eligibility');
    }
    return new Set(ids);
  }

  private async reserveCandidate(tx: Tx, owner?: string, eligible?: ReadonlySet<string>): Promise<Inventory | UserPoolError | undefined> {
    let ordinal = (await this.settingsRow(tx.connection)).next_ordinal;
    // Health filters candidates only: score against ALL active registered
    // inventory, including unhealthy/cap-full enterprises, on every insertion.
    const snapshot = (await this.enterpriseSnapshot(tx.connection, await this.time(tx.connection))).map(row => ({ ...row,
      eligible: row.eligible !== false && (eligible === undefined || eligible.has(row.enterpriseId)) }));
    const ranked = rankEnterprises(snapshot, { kind: 'creation', ordinal });
    if (!ranked.length) return undefined;
    const enterpriseId = ranked[0].enterpriseId;
    // Creation holds settings X before policy S, and only then locks/inserts
    // accounts. No policy upgrades and no admission-style account-first inversion.
    await this.assertActivePolicy(tx, enterpriseId);
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
        await this.exec(tx, `INSERT INTO proxy_accounts(enterprise_id, account_incarnation, identity, sso_user, copilot_oauth_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'missing', ?, ?)`, [enterpriseId, randomUUID(), identity, identity, timestamp, timestamp]);
      } catch (error) {
        if (mysqlCode(error) === 'ER_DUP_ENTRY') {
          await this.exec(tx, 'ROLLBACK TO SAVEPOINT pool_reservation');
          await this.exec(tx, 'RELEASE SAVEPOINT pool_reservation');
          continue;
        }
        throw error;
      }
      const inserted = await this.exec(tx, `INSERT INTO user_pool_accounts(identity, ordinal, state, attempt_id, updated_at, retry_at)
        SELECT ?, ?, 'provisioning', ?, ?, ? ${owner === undefined ? '' : `WHERE ${OWNER_SQL}`}`,
      [identity, ordinal - 1, randomUUID(), now, now, ...(owner === undefined ? [] : [owner])]);
      if (!inserted.affectedRows) {
        await this.exec(tx, 'ROLLBACK TO SAVEPOINT pool_reservation');
        await this.exec(tx, 'RELEASE SAVEPOINT pool_reservation');
        return new UserPoolError(503, 'pool_owner_expired');
      }
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
