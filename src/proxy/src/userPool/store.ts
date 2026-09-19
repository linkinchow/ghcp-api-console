import { validateEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import {
  resolveEnterpriseScope, enterprisePoolPolicyDto,
  type EnterpriseRegistryV3, type EnterprisePoolPolicyRecord, type EnterprisePoolPolicyChange, type EnterprisePoolOverviewDto,
} from '@ghcp/shared';
import { loadProxyEnterpriseRegistry } from '../enterprise.js';
import { beginSqliteAttempt } from '../db/sqliteAuthorization.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PoolConfig } from './config.js';
import { normalizeCaller, UserPoolError } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { poolPageSql, type PoolList, type PoolPage, type PoolPageQuery } from './paging.js';
import type { WorkerCredentialFence, WorkerCredentialMutation } from './storage.js';
import { LOGIN_CAPACITY_SQL, PendingSelection } from './scheduling.js';
import { inferenceHoldTimeoutMs } from './inferenceTimeout.js';
import {
  applyEnterprisePolicyChange, enterprisePolicyBlockers, enterprisePolicyReady, enterprisePolicyFromRow, enterpriseScores,
  logicalSupplySql, rankEnterprises, DISPATCHED_POOL_STAGES, type EnterpriseSchedulingInput,
} from './enterpriseScheduling.js';

export interface Inventory {
  enterprise_id: string;
  enterprise_revision: number;
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
  enterprise_id: string;
  enterprise_revision: number;
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
  active_max_accounts: number;
  lease_seconds: number;
  paused: 0 | 1;
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
const SETTING_KEYS = ['idle_target', 'lease_seconds', 'paused'];
const INVENTORY_KEYS = [
  'state', 'stage', 'attempt_id', 'oauth_attempt_id', 'sso_created_at', 'task_id', 'attempts', 'retry_at',
  'last_error', 'cooldown_until', 'verified_at',
];

export class UserPoolStore {
  private readonly pendingSelection = new PendingSelection();

  private readonly enterpriseId: string;
  private readonly registry: EnterpriseRegistryV3;

  constructor(private readonly db: Database.Database, private readonly options: PoolConfig, expectedRegistry?: EnterpriseRegistryV3) {
    const state = validateEnterpriseSqliteV4(db, 'proxy', expectedRegistry ?? loadProxyEnterpriseRegistry());
    if (state.layout !== 'pool') throw new Error('enterprise_pool_layout_required');
    if (resolveEnterpriseScope(state.registry).profile.accountDomain !== options.accountDomain) {
      throw new Error('Pool account email domain differs from persisted inventory');
    }
    this.enterpriseId = state.legacyEnterpriseId;
    this.registry = state.registry;
  }

  now(): number {
    return (this.db.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now")
      .get() as { now: number }).now;
  }

  settings(): PoolSettings {
    return this.db.prepare(`
      SELECT s.version, s.idle_target, s.lease_seconds, s.paused,
        (SELECT COALESCE(SUM(max_accounts),0) FROM enterprise_profiles) AS max_accounts,
        (SELECT COALESCE(SUM(e.max_accounts),0) FROM enterprise_profiles e
          JOIN enterprise_pool_policy policy ON policy.enterprise_id=e.id WHERE policy.state='active') AS active_max_accounts
      FROM user_pool_settings s WHERE s.id=1
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
      if (!Number.isInteger(next.idle_target) || next.idle_target < 0 || next.idle_target > NAME_CAPACITY
        || !Number.isInteger(next.lease_seconds) || next.lease_seconds < 60 || next.lease_seconds > 2592000
        || ![0, 1].includes(next.paused)) {
        throw new UserPoolError(400, 'invalid_pool_settings');
      }
      this.db.prepare(`
        UPDATE user_pool_settings SET idle_target=?, lease_seconds=?, paused=?, version=version+1 WHERE id=1 AND version=?
      `).run(next.idle_target, next.lease_seconds, next.paused, version);
      this.event('settings_updated');
      return this.settings();
    }).immediate();
  }

  enterprisePolicies(): EnterprisePoolPolicyRecord[] {
    return (this.db.prepare(`SELECT policy.*, e.max_accounts FROM enterprise_pool_policy policy
      JOIN enterprise_profiles e ON e.id=policy.enterprise_id ORDER BY policy.enterprise_id`).all() as Record<string, unknown>[])
      .map(enterprisePolicyFromRow);
  }

  enterprisePolicy(id: string): EnterprisePoolPolicyRecord | undefined {
    const row = this.db.prepare(`SELECT policy.*, e.max_accounts FROM enterprise_pool_policy policy
      JOIN enterprise_profiles e ON e.id=policy.enterprise_id WHERE policy.enterprise_id=?`).get(id) as Record<string, unknown> | undefined;
    return row && enterprisePolicyFromRow(row);
  }

  updateEnterprisePolicy(id: string, expectedVersion: number, change: EnterprisePoolPolicyChange): EnterprisePoolPolicyRecord {
    return this.db.transaction(() => {
      const current = this.enterprisePolicy(id);
      if (!current) throw new UserPoolError(404, 'enterprise_not_found');
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new UserPoolError(400, 'invalid_enterprise_policy');
      if (current.policyVersion !== expectedVersion) throw new UserPoolError(409, 'policy_version_conflict');
      const next = applyEnterprisePolicyChange(this.registry, current, change, this.now());
      if (this.settings().max_accounts - current.maxAccounts + next.maxAccounts > NAME_CAPACITY) {
        throw new UserPoolError(400, 'invalid_enterprise_policy');
      }
      this.db.prepare('UPDATE enterprise_profiles SET max_accounts=? WHERE id=?').run(next.maxAccounts, id);
      this.db.prepare(`UPDATE enterprise_pool_policy SET state=?, policy_version=?, identity_sha256=?, validation_kind=?,
        validation_evidence_json=?, validated_at=?, updated_at=? WHERE enterprise_id=? AND policy_version=?`)
        .run(next.state, next.policyVersion, next.identitySha256, next.validationKind,
          next.validationEvidence === null ? null : JSON.stringify(next.validationEvidence), next.validatedAt, next.updatedAt, id, expectedVersion);
      // The policy row is the audit record. No member/event locks are taken by a policy write.
      return this.enterprisePolicy(id)!;
    }).immediate();
  }

  private schedulingSnapshot(now: number): EnterpriseSchedulingInput[] {
    const supply = logicalSupplySql(String(now));
    const rows = this.db.prepare(`SELECT a.enterprise_id, COUNT(*) AS inventory,
      SUM(CASE WHEN ${supply.eligibleIdle} THEN 1 ELSE 0 END) AS eligibleIdle,
      SUM(CASE WHEN ${supply.pendingSupply} THEN 1 ELSE 0 END) AS pendingSupply
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity GROUP BY a.enterprise_id`)
      .all() as { enterprise_id: string; inventory: number; eligibleIdle: number; pendingSupply: number }[];
    const byId = new Map(rows.map(row => [row.enterprise_id, row]));
    return this.enterprisePolicies().map(policy => {
      const row = byId.get(policy.enterpriseId);
      const eligible = enterprisePolicyBlockers(this.registry, policy).length === 0;
      return { enterpriseId: policy.enterpriseId, state: policy.state, maxAccounts: policy.maxAccounts,
        inventory: row?.inventory ?? 0, eligibleIdle: eligible ? row?.eligibleIdle ?? 0 : 0,
        pendingSupply: eligible ? row?.pendingSupply ?? 0 : 0, eligible };
    });
  }

  enterpriseOverview(): EnterprisePoolOverviewDto {
    return this.db.transaction(() => {
      const now = this.now(); const settings = this.settings();
      const scores = enterpriseScores(this.schedulingSnapshot(now));
      const policies = new Map(this.enterprisePolicies().map(row => [row.enterpriseId, row]));
      const eligibleIdle = scores.reduce((sum, row) => sum + row.eligibleIdle, 0);
      const pendingSupply = scores.reduce((sum, row) => sum + row.pendingSupply, 0);
      const deficit = Math.max(0, settings.idle_target - eligibleIdle - pendingSupply);
      const nextOrdinal = (this.db.prepare('SELECT next_ordinal n FROM user_pool_settings WHERE id=1').get() as { n: number }).n;
      const blockedReasons: string[] = [];
      if (settings.paused) blockedReasons.push('pool_paused');
      if (!scores.some(row => row.state === 'active')) blockedReasons.push('no_active_enterprises');
      if (settings.idle_target > settings.active_max_accounts) blockedReasons.push('idle_target_above_active_capacity');
      if (nextOrdinal >= NAME_CAPACITY) blockedReasons.push('name_catalog_exhausted');
      if (deficit > 0 && !rankEnterprises(scores, { kind: 'creation', ordinal: nextOrdinal }).length) blockedReasons.push('enterprise_capacity_exhausted');
      return { enabled: true, legacyEnterpriseId: this.enterpriseId, observedAt: now, settings,
        enterprises: scores.map(row => {
          const policy = policies.get(row.enterpriseId)!;
          const profile = this.registry.profiles.find(profile => profile.id === row.enterpriseId)!;
          const counts = this.counts(row.enterpriseId);
          const blocked = enterprisePolicyBlockers(this.registry, policy);
          if (row.inventory >= row.maxAccounts) blocked.push('enterprise_cap_reached');
          return { ...enterprisePoolPolicyDto(profile, policy), counts: {
            total: counts.total, ready_idle: counts.ready_idle, leased: counts.leased, provisional: counts.provisional,
            provisioning: counts.provisioning, cooling: counts.cooling, failed: counts.failed, disabled: counts.disabled,
          }, eligibleIdle: row.eligibleIdle, pendingSupply: row.pendingSupply, targetShare: row.targetShare,
          actualShare: row.actualShare, shareDeficit: row.shareDeficit, score: row.score,
          overCap: row.inventory > row.maxAccounts, blockedReasons: blocked };
        }), supply: { eligibleIdle, pendingSupply, deficit },
        names: { capacity: NAME_CAPACITY, nextOrdinal, remainingPositions: Math.max(0, NAME_CAPACITY - nextOrdinal) }, blockedReasons };
    })();
  }

  canProvision(identity: string, mode: 'advance' | 'observe' = 'advance'): boolean {
    const row = this.inventory(identity);
    if (!row) return false;
    const policy = this.enterprisePolicy(row.enterprise_id);
    const profile = this.registry.profiles.find(profile => profile.id === row.enterprise_id);
    if (!policy || !profile || !enterprisePolicyReady(policy, profile, this.enterpriseId)) return false;
    if (policy.state === 'active') return true;
    if (!['validated', 'draining'].includes(policy.state)) return false;
    if (this.db.prepare('SELECT 1 FROM user_pool_leases WHERE member_identity=? AND expires_at>?').get(identity, this.now())) return true;
    return mode === 'observe' && (DISPATCHED_POOL_STAGES as readonly string[]).includes(row.stage);
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
        if (!this.canProvision(identity, 'advance')) return false;
        const account=this.db.prepare('SELECT account_incarnation,gh_login FROM proxy_accounts WHERE enterprise_id=? AND identity=? AND sso_user=?')
          .get(row.enterprise_id,identity,identity) as {account_incarnation:string;gh_login:string|null}|undefined;
        if (!account?.gh_login) return false;
        beginSqliteAttempt(this.db,{enterpriseId:row.enterprise_id,enterpriseRevision:row.enterprise_revision,
          identity,accountIncarnation:account.account_incarnation,oauthAttemptId:mutation.oauthAttemptId,expectedGhLogin:account.gh_login});
        return true;
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
        || !this.matchesOwner(owner) || this.hasHolds(identity) || !this.canProvision(identity, 'advance')) return false;
      const occupied = (this.db.prepare(`SELECT COUNT(*) n FROM user_pool_accounts
        WHERE stage IN ('oauth-dispatch', 'oauth-wait')`).get() as { n: number }).n;
      if (occupied >= limit) return false;
      return this.update(identity, { stage: 'oauth-dispatch' }, fence, owner);
    }).immediate();
  }

  listLoginReservations(): Inventory[] {
    return this.db.prepare(`SELECT p.*, a.enterprise_id, e.revision AS enterprise_revision FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity=p.identity JOIN enterprise_profiles e ON e.id=a.enterprise_id
      WHERE p.stage IN ('oauth-dispatch', 'oauth-wait')
      AND (p.state = 'disabled' OR (p.state = 'failed' AND p.attempts >= 3)) ORDER BY p.ordinal LIMIT 100`).all() as Inventory[];
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
      INSERT INTO user_pool_events(at, action, identity, caller_id, lease_id, detail, enterprise_id)
      VALUES (?, ?, ?, ?, ?, ?, (SELECT enterprise_id FROM proxy_accounts WHERE identity=?))
    `).run(this.now(), action, identity ?? null, caller ?? null, leaseId ?? null, detail ?? null, identity ?? null);
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

  events(enterpriseId?: string): unknown[] {
    return this.db.prepare(`SELECT * FROM user_pool_events ${enterpriseId === undefined ? '' : 'WHERE enterprise_id=?'} ORDER BY id DESC LIMIT 200`)
      .all(...(enterpriseId === undefined ? [] : [enterpriseId]));
  }

  accounts(enterpriseId?: string): unknown[] {
    return this.db.prepare(`
      SELECT p.*, a.enterprise_id, e.revision AS enterprise_revision, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at,
        (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id = l.lease_id AND h.expires_at > @now)
        + (SELECT COUNT(*) FROM user_pool_catalog_holds h
           WHERE h.member_identity = p.identity AND h.expires_at > @now) AS active_requests
      FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity = p.identity
      JOIN enterprise_profiles e ON e.id=a.enterprise_id
      LEFT JOIN user_pool_leases l ON l.member_identity = p.identity
      ${enterpriseId === undefined ? '' : 'WHERE a.enterprise_id=@enterpriseId'} ORDER BY p.ordinal LIMIT 1000
    `).all({ now: this.now(), ...(enterpriseId === undefined ? {} : { enterpriseId }) });
  }

  leases(enterpriseId?: string): Array<Lease & { active_requests: number }> {
    return this.db.prepare(`SELECT l.*, a.enterprise_id, e.revision AS enterprise_revision,
      (SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id=l.lease_id AND h.expires_at>@now)
      + (SELECT COUNT(*) FROM user_pool_catalog_holds h WHERE h.member_identity=l.member_identity AND h.expires_at>@now) AS active_requests
      FROM user_pool_leases l JOIN proxy_accounts a ON a.identity=l.member_identity JOIN enterprise_profiles e ON e.id=a.enterprise_id
      ${enterpriseId === undefined ? '' : 'WHERE a.enterprise_id=@enterpriseId'} ORDER BY l.assigned_at DESC, l.lease_id LIMIT 1000`)
      .all({ now: this.now(), ...(enterpriseId === undefined ? {} : { enterpriseId }) }) as Array<Lease & { active_requests: number }>;
  }

  inventory(identity: string): Inventory | undefined {
    return this.db.prepare(`SELECT p.*, a.enterprise_id, e.revision AS enterprise_revision FROM user_pool_accounts p
      JOIN proxy_accounts a ON a.identity=p.identity JOIN enterprise_profiles e ON e.id=a.enterprise_id WHERE p.identity=?`)
      .get(identity) as Inventory | undefined;
  }

  managesSsoUser(ssoUser: string, enterpriseId = this.enterpriseId): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
      WHERE a.enterprise_id=? AND lower(a.sso_user)=lower(?) LIMIT 1`).get(enterpriseId, ssoUser));
  }

  /** Logical read only. Expiry/cleanup lag cannot mutate overview or manufacture supply. */
  counts(enterpriseId?: string): Record<string, number> {
    return this.db.transaction(() => {
      const now = this.now(); const supply = logicalSupplySql(String(now));
      const filter = enterpriseId === undefined ? '' : 'AND a.enterprise_id=?';
      const args = enterpriseId === undefined ? [] : [enterpriseId];
      const result: Record<string, number> = {
        total: 0, ready_idle: 0, provisioning: 0, failed: 0, cooling: 0,
        disabled: 0, leased: 0, provisional: 0, catalog_requests: 0,
      };
      const rows = this.db.prepare(`SELECT p.state, COUNT(*) n FROM user_pool_accounts p
        JOIN proxy_accounts a ON a.identity=p.identity WHERE 1=1 ${filter} GROUP BY p.state`)
        .all(...args) as { state: string; n: number }[];
      for (const row of rows) { result[row.state] = row.n; result.total += row.n; }
      const phases = this.db.prepare(`SELECT l.phase, COUNT(*) n FROM user_pool_leases l
        JOIN user_pool_accounts p ON p.identity=l.member_identity JOIN proxy_accounts a ON a.identity=p.identity
        WHERE (NOT ${supply.unbound} OR (p.state='cooling' AND p.cooldown_until>${now})) ${filter} GROUP BY l.phase`)
        .all(...args) as { phase: string; n: number }[];
      for (const row of phases) result[row.phase === 'active' ? 'leased' : 'provisional'] = row.n;
      result.ready_idle = (this.db.prepare(`SELECT COUNT(*) n FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        WHERE ${supply.eligibleIdle} ${filter}`).get(...args) as { n: number }).n;
      result.catalog_requests = (this.db.prepare(`SELECT COUNT(*) n FROM user_pool_catalog_holds h
        JOIN proxy_accounts a ON a.identity=h.member_identity WHERE h.expires_at>${now} ${filter}`).get(...args) as { n: number }).n;
      return result;
    })();
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
        this.assertEnterpriseActive(identity);
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
      this.assertEnterpriseActive(identity);
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
    const now = this.now();
    const ranked = rankEnterprises(this.schedulingSnapshot(now), { kind: 'admission', caller });
    const supply = logicalSupplySql(String(now));
    for (const enterprise of ranked) {
      const row = this.db.prepare(`SELECT p.identity FROM user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity
        WHERE a.enterprise_id=? AND ${supply.eligibleIdle} ORDER BY p.updated_at, p.ordinal LIMIT 1`)
        .get(enterprise.enterpriseId) as { identity: string } | undefined;
      if (row) return row.identity;
    }
    throw new UserPoolError(429, 'pool_exhausted', this.options.retryAfterSeconds);
  }

  private assertEnterpriseActive(identity: string): void {
    const row = this.inventory(identity);
    const policy = row && this.enterprisePolicy(row.enterprise_id);
    if (!policy || enterprisePolicyBlockers(this.registry, policy).length) throw new UserPoolError(503, 'enterprise_not_active');
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
    const member = this.inventory(lease.member_identity)!;
    const generation = member.generation;
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
    return { ...lease, request_id: requestId, kind, deadline_at: deadline,
      enterprise_id: member.enterprise_id, enterprise_revision: member.enterprise_revision };
  }

  private heldRow(held: HeldLease): HoldRow | undefined {
    const row = (held.kind === 'catalog'
      ? this.db.prepare('SELECT * FROM user_pool_catalog_holds WHERE request_id = ? AND lease_id = ?')
      : this.db.prepare(`
          SELECT h.*, l.member_identity, l.caller_id FROM user_pool_holds h
          JOIN user_pool_leases l ON l.lease_id = h.lease_id WHERE h.request_id = ? AND h.lease_id = ?
        `)).get(held.request_id, held.lease_id) as HoldRow | undefined;
    if (!row || row.member_identity !== held.member_identity || row.caller_id !== held.caller_id) return undefined;
    const member = this.inventory(row.member_identity);
    return member?.enterprise_id === held.enterprise_id && member.enterprise_revision === held.enterprise_revision ? row : undefined;
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

  release(leaseId: string, enterpriseId?: string): void {
    this.db.transaction(() => {
      const lease = this.db.prepare(`SELECT l.* FROM user_pool_leases l JOIN proxy_accounts a ON a.identity=l.member_identity
        WHERE l.lease_id=? ${enterpriseId === undefined ? '' : 'AND a.enterprise_id=?'}`)
        .get(leaseId, ...(enterpriseId === undefined ? [] : [enterpriseId])) as Lease | undefined;
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

  reserveDeficit(owner: string, eligibleEnterpriseIds?: readonly string[]): number {
    const eligible = this.creationEligibility(eligibleEnterpriseIds);
    return this.db.transaction(() => {
      if (!this.matchesOwner(owner)) return 0;
      let reserved = 0;
      // Recompute global D and current-share ranking after each persisted member.
      for (; reserved < 100 && this.reservationDeficit() > 0;) {
        const row = this.reserveCandidate(eligible);
        if (!row || row instanceof UserPoolError) break;
        reserved++;
      }
      return reserved;
    }).immediate();
  }

  private reservationDeficit(): number {
    const settings = this.settings();
    if (settings.paused) return 0;
    const rows = this.schedulingSnapshot(this.now());
    return Math.max(0, settings.idle_target - rows.reduce((sum, row) => sum + row.eligibleIdle + row.pendingSupply, 0));
  }

  private creationEligibility(ids?: readonly string[]): ReadonlySet<string> | undefined {
    if (ids === undefined) return undefined;
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string' || !this.registry.profiles.some(profile => profile.id === id))) {
      throw new UserPoolError(400, 'invalid_enterprise_eligibility');
    }
    return new Set(ids);
  }

  private reserveCandidate(eligible?: ReadonlySet<string>): Inventory | UserPoolError | undefined {
    let ordinal = (this.db.prepare('SELECT next_ordinal n FROM user_pool_settings WHERE id = 1')
      .get() as { n: number }).n;
    // Live pairing controls only candidates, never the active E denominator or
    // existing logical supply. Copy the caller list before entering the batch.
    const snapshot = this.schedulingSnapshot(this.now()).map(row => ({ ...row,
      eligible: row.eligible !== false && (eligible === undefined || eligible.has(row.enterpriseId)) }));
    const enterprise = rankEnterprises(snapshot, { kind: 'creation', ordinal })[0];
    if (!enterprise) return undefined;
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
        INSERT INTO proxy_accounts(enterprise_id, account_incarnation, identity, sso_user, copilot_oauth_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'missing', ?, ?)
      `).run(enterprise.enterpriseId, randomUUID(), identity, identity, timestamp, timestamp);
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
      const eligible = this.enterprisePolicies().filter(policy => {
        const profile = this.registry.profiles.find(profile => profile.id === policy.enterpriseId)!;
        return ['active', 'validated', 'draining'].includes(policy.state) && enterprisePolicyReady(policy, profile, this.enterpriseId);
      }).map(policy => policy.enterpriseId);
      if (!eligible.length) return undefined;
      return this.db.prepare(`
        SELECT p.*, a.enterprise_id, e.revision AS enterprise_revision FROM user_pool_accounts p
        JOIN proxy_accounts a ON a.identity=p.identity JOIN enterprise_profiles e ON e.id=a.enterprise_id
        JOIN enterprise_pool_policy policy ON policy.enterprise_id=a.enterprise_id
        WHERE p.retry_at <= ? AND p.cooldown_until<=${this.now()} AND (
          p.state = 'provisioning' OR (p.state = 'failed' AND p.attempts < 3
            AND COALESCE(p.last_error, '') NOT IN ('sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed')))
          ${exclusion}
          AND a.enterprise_id IN (${eligible.map(() => '?').join(',')})
          AND (policy.state='active' OR (policy.state IN ('validated','draining') AND
            (p.stage IN (${DISPATCHED_POOL_STAGES.map(stage => `'${stage}'`).join(',')})
              OR EXISTS (SELECT 1 FROM user_pool_leases live WHERE live.member_identity=p.identity AND live.expires_at>${this.now()}))))
          AND NOT EXISTS (SELECT 1 FROM user_pool_holds h JOIN user_pool_leases l ON l.lease_id = h.lease_id
            WHERE l.member_identity = p.identity)
          AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity)
          AND ${LOGIN_CAPACITY_SQL}
        ORDER BY ${this.pendingSelection.orderSql()} LIMIT 1
      `).get(this.now(), ...excluded, ...eligible, this.options.loginMaxPending ?? 5) as Inventory | undefined;
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
      // Admit only NEW external-operation intents under this same write
      // transaction. Completion and observation checkpoints remain policy-free.
      const dispatchIntent = row.stage === 'new' && patch.stage === 'sso-creating'
        || row.stage === 'sso-created' && patch.stage === 'scim-syncing'
        || row.stage === 'scim-synced' && patch.stage === 'seat-assigning';
      if (dispatchIntent && !this.canProvision(identity, 'advance')) return false;
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

  disable(identity: string, enterpriseId?: string): void {
    this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || enterpriseId !== undefined && row.enterprise_id !== enterpriseId) throw new UserPoolError(404, 'member_not_found');
      if (row.state === 'disabled') return;
      this.update(identity, { state: 'disabled', attempt_id: randomUUID() });
      this.releaseInactive(identity);
      this.event('member_disabled', identity);
    }).immediate();
  }

  retry(identity: string, enterpriseId?: string): void {
    this.db.transaction(() => {
      const row = this.inventory(identity);
      if (!row || enterpriseId !== undefined && row.enterprise_id !== enterpriseId) throw new UserPoolError(404, 'member_not_found');
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
