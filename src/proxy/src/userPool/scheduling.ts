import {
  isEnterpriseId,
  planCreations,
  rankEnterprisesForAdmission,
  replenishmentDeficit,
  type EnterpriseLifecycleState,
  type PoolEnterprise,
} from '@ghcp/shared';
import { UserPoolError } from './config.js';
import { NAME_CAPACITY } from './names.js';

// The final dispatch claim remains authoritative; this filter only avoids work
// that cannot progress and prioritizes consumers that release scarce capacity.
export const LOGIN_CAPACITY_SQL = `(p.stage <> 'oauth-starting' OR
  (SELECT COUNT(*) FROM user_pool_accounts occupied WHERE occupied.stage IN ('oauth-dispatch','oauth-wait')) < ?)`;

const PROGRESS_ORDER = `CASE p.stage
  WHEN 'warmup' THEN 0 WHEN 'ready' THEN 0
  WHEN 'oauth-wait' THEN 1 WHEN 'oauth-dispatch' THEN 2
  WHEN 'oauth-starting' THEN 3 WHEN 'synced' THEN 4
  WHEN 'seat-assigning' THEN 5 WHEN 'scim-synced' THEN 6
  WHEN 'scim-syncing' THEN 7 WHEN 'sso-created' THEN 8
  WHEN 'sso-creating' THEN 9 ELSE 10 END`;

export class PendingSelection {
  private selections = 0;

  orderSql(): string {
    // One in four selections uses age alone, so continuously arriving downstream
    // work cannot starve earlier stages. No persisted ownership depends on this.
    return `${this.selections === 3 ? '' : `${PROGRESS_ORDER}, `}p.retry_at, p.updated_at, p.ordinal`;
  }

  selected(): void { this.selections = (this.selections + 1) % 4; }
}

/** Errors a worker cannot resolve by retrying; such members are not future supply. */
export const MANUAL_ERRORS: readonly string[] = [
  'sso_creation_ambiguous',
  'sso_name_conflict',
  'oauth_dispatch_ambiguous',
  'oauth_task_cancelled_unconfirmed',
];

/** The scheduling columns of one `proxy_enterprises` row. */
export interface SchedulingEnterprise {
  id: string;
  state: EnterpriseLifecycleState;
  max_accounts: number;
  inventory_count: number;
}

/** I and P of design §5.8 for the `active` enterprises, from the batch's only aggregate query. */
export interface PoolSupply {
  ready_idle: number;
  in_flight: number;
}

export interface PoolSupplyQuery {
  sql: string;
  values: unknown[];
}

export interface PolicyPatch {
  maxAccounts?: number;
  state?: EnterpriseLifecycleState;
}

export interface PolicyChange {
  maxAccounts: number;
  state: EnterpriseLifecycleState;
}

export interface SettingsValues {
  idle_target: number;
  lease_seconds: number;
  paused: number;
}

/** A `proxy_enterprises` row as a policy edit reads it. */
export interface PolicyEnterprise extends SchedulingEnterprise {
  policy_version: number;
}

export const SCHEDULING_ENTERPRISE_SQL = `
  SELECT id, state, max_accounts, inventory_count
  FROM proxy_enterprises
  ORDER BY id`;

export const POLICY_ENTERPRISE_SQL = `
  SELECT id, state, max_accounts, inventory_count, policy_version
  FROM proxy_enterprises
  ORDER BY id`;

const SETTING_KEYS = ['idle_target', 'lease_seconds', 'paused'];
const POLICY_KEYS = ['maxAccounts', 'state'];
const STATES: readonly string[] = ['draft', 'active', 'draining'];
const TRANSITIONS: readonly string[] = ['draft>active', 'active>draining', 'draining>active'];
const MAX_LEASE_SECONDS = 2592000;

/**
 * A leasable member: ready (or cooling with an elapsed cooldown), verified, with a valid credential and no live
 * binding. Expired bindings without live holds already count, as admission would reclaim them.
 */
const READY_IDLE_SQL = `p.state IN ('ready', 'cooling')
      AND (p.state = 'ready' OR p.cooldown_until <= ?)
      AND p.verified_at IS NOT NULL
      AND a.copilot_oauth_status = 'valid'
      AND LENGTH(a.copilot_oauth_token) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM user_pool_leases l
        WHERE l.member_identity = p.identity
          AND (l.expires_at > ? OR EXISTS (
            SELECT 1
            FROM user_pool_holds h
            WHERE h.lease_id = l.lease_id
              AND h.expires_at > ?
          ))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM user_pool_catalog_holds c
        WHERE c.member_identity = p.identity
          AND c.expires_at > ?
      )`;

/** Supply that will become idle without a new reservation: provisioning, retrying and awaiting repair. */
const IN_FLIGHT_SQL = (manual: string) => `p.state = 'provisioning'
      OR (p.state = 'failed' AND p.attempts < 3 AND COALESCE(p.last_error, '') NOT IN (${manual}))
      OR (p.state IN ('ready', 'cooling') AND p.verified_at IS NULL)`;

/** One aggregate over the members of `active` enterprises; both backends run exactly this statement. */
export function poolSupplyQuery(now: number): PoolSupplyQuery {
  const manual = MANUAL_ERRORS.map(() => '?').join(', ');
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN ${READY_IDLE_SQL} THEN 1 ELSE 0 END), 0) AS ready_idle,
      COALESCE(SUM(CASE WHEN ${IN_FLIGHT_SQL(manual)} THEN 1 ELSE 0 END), 0) AS in_flight
    FROM user_pool_accounts p
    JOIN proxy_accounts a ON a.identity = p.identity
    JOIN proxy_enterprises e ON e.id = p.enterprise_id
    WHERE e.state = 'active'`;
  return { sql, values: [now, now, now, now, ...MANUAL_ERRORS] };
}

/** Copies and validates the caller's list before any asynchronous work can observe a later mutation. */
export function eligibleEnterprises(ids: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(ids) || ids.some((id) => !isEnterpriseId(id))) {
    throw new UserPoolError(400, 'invalid_eligible_enterprises');
  }
  return new Set(ids);
}

/** Active enterprises form C and N; only eligible ones below their cap are candidates (shared ranking). */
export function creationEnterprises(rows: readonly SchedulingEnterprise[],
  eligible: ReadonlySet<string>): PoolEnterprise[] {
  return rows.filter(isActive).map((row) => ({
    id: row.id,
    cap: row.max_accounts,
    inventory: row.inventory_count,
    eligible: eligible.has(row.id),
  }));
}

/** The enterprises to create `limit` members in at most, in order; empty when the pool needs nothing. */
export function planReplenishment(rows: readonly SchedulingEnterprise[], eligible: ReadonlySet<string>,
  input: { supply: PoolSupply; settings: SettingsValues; ordinal: number; limit: number }): string[] {
  const deficit = replenishmentDeficit({
    idleTarget: input.settings.idle_target,
    readyIdle: input.supply.ready_idle,
    inFlight: input.supply.in_flight,
    paused: input.settings.paused === 1,
  });
  if (deficit === 0) return [];
  const enterprises = creationEnterprises(rows, eligible);
  return planCreations({ enterprises, deficit: Math.min(deficit, input.limit), ordinal: input.ordinal });
}

/**
 * Admission order for a caller without a binding. Idle supply is discovered per enterprise afterwards, so every
 * active enterprise is ranked as if it had idle members; the score does not depend on the idle count.
 */
export function admissionOrder(rows: readonly SchedulingEnterprise[], caller: string): string[] {
  const enterprises = rows.filter(isActive).map((row) => ({
    id: row.id,
    cap: row.max_accounts,
    inventory: row.inventory_count,
    eligible: true,
    eligibleIdle: 1,
  }));
  return rankEnterprisesForAdmission({ enterprises, caller });
}

export function isActive(row: Pick<SchedulingEnterprise, 'state'>): boolean {
  return row.state === 'active';
}

/** A caller bound only to a member of a non-active enterprise must not move to another enterprise. */
export function assertEnterpriseActive(state: string | undefined): void {
  if (state !== 'active') throw new UserPoolError(503, 'enterprise_draining', 30);
}

/** Validates a `PATCH /api/user-pool/settings` body; the cap moved to each enterprise. */
export function nextSettings(version: number, current: SettingsValues & { version: number },
  patch: unknown): SettingsValues {
  if (isRecord(patch) && Object.hasOwn(patch, 'max_accounts')) throw new UserPoolError(409, 'use_enterprise_cap');
  if (!Number.isSafeInteger(version) || !isRecord(patch) || Object.keys(patch).some(isUnknownSetting)) {
    throw new UserPoolError(400, 'invalid_pool_settings');
  }
  if (version !== current.version) throw new UserPoolError(409, 'settings_version_conflict');
  const next = { ...pickSettings(current), ...patch } as SettingsValues;
  if (!validSettings(next)) throw new UserPoolError(400, 'invalid_pool_settings');
  return next;
}

/**
 * Validates a policy patch against the current row and every enterprise's cap. Errors: 409 policy_version_conflict,
 * 400 invalid_pool_policy, 409 invalid_state_transition and 409 name_capacity_exceeded (ΣC_e > NAME_CAPACITY).
 */
export function nextPolicy(current: PolicyEnterprise,
  all: readonly SchedulingEnterprise[], expectedVersion: number, patch: unknown): PolicyChange {
  const policy = parsePolicyPatch(expectedVersion, patch);
  if (expectedVersion !== current.policy_version) throw new UserPoolError(409, 'policy_version_conflict');
  const next = { maxAccounts: policy.maxAccounts ?? current.max_accounts, state: policy.state ?? current.state };
  if (next.state !== current.state && !TRANSITIONS.includes(`${current.state}>${next.state}`)) {
    throw new UserPoolError(409, 'invalid_state_transition');
  }
  const others = all.filter((row) => row.id !== current.id);
  const capacity = others.reduce((total, row) => total + row.max_accounts, next.maxAccounts);
  if (capacity > NAME_CAPACITY) throw new UserPoolError(409, 'name_capacity_exceeded');
  return next;
}

function parsePolicyPatch(expectedVersion: number, patch: unknown): PolicyPatch {
  const valid = Number.isSafeInteger(expectedVersion) && isRecord(patch) && Object.keys(patch).length > 0
    && Object.keys(patch).every((key) => POLICY_KEYS.includes(key))
    && (patch.maxAccounts === undefined || isCap(patch.maxAccounts))
    && (patch.state === undefined || STATES.includes(String(patch.state)));
  if (!valid) throw new UserPoolError(400, 'invalid_pool_policy');
  return patch as PolicyPatch;
}

function isCap(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= NAME_CAPACITY;
}

function isUnknownSetting(key: string): boolean {
  return !SETTING_KEYS.includes(key);
}

function pickSettings(current: SettingsValues): SettingsValues {
  return { idle_target: current.idle_target, lease_seconds: current.lease_seconds, paused: current.paused };
}

function validSettings(next: SettingsValues): boolean {
  return Number.isInteger(next.idle_target) && next.idle_target >= 0 && next.idle_target <= NAME_CAPACITY
    && Number.isInteger(next.lease_seconds) && next.lease_seconds >= 60 && next.lease_seconds <= MAX_LEASE_SECONDS
    && [0, 1].includes(next.paused);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
