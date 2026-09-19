import { createHash } from 'node:crypto';
import {
  parseEnterprisePoolPolicyRecord, parseEnterpriseValidationEvidenceJsonV1,
  parseEnterpriseValidationEvidenceV1, type EnterprisePoolPolicyChange, type EnterprisePoolPolicyRecord, type EnterprisePoolState,
  type EnterpriseProfileV3, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1,
} from '@ghcp/shared';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { UserPoolError } from './config.js';

export interface EnterpriseSchedulingInput {
  enterpriseId: string;
  state: EnterprisePoolState;
  maxAccounts: number;
  inventory: number;
  eligibleIdle: number;
  pendingSupply: number;
  /** Temporary blockers remove candidates, never their active-denominator contribution. */
  eligible?: boolean;
}
export type EnterpriseScore = EnterpriseSchedulingInput & {
  score: number; targetShare: number | null; actualShare: number | null; shareDeficit: number | null;
};
export type EnterpriseTie = { kind: 'creation'; ordinal: number } | { kind: 'admission'; caller: string };

/** Current inventory share, deliberately not (N+1) lookahead or cap utilization. */
export function enterpriseScores(rows: readonly EnterpriseSchedulingInput[]): EnterpriseScore[] {
  const active = rows.filter(row => row.state === 'active');
  const capacity = active.reduce((sum, row) => sum + row.maxAccounts, 0);
  const inventory = active.reduce((sum, row) => sum + row.inventory, 0);
  return rows.map(row => {
    const included = row.state === 'active' && capacity > 0;
    const targetShare = included ? row.maxAccounts / capacity : null;
    const actualShare = included && inventory > 0 ? row.inventory / inventory : null;
    return {
      ...row,
      score: included ? inventory * row.maxAccounts - capacity * row.inventory : 0,
      targetShare, actualShare,
      shareDeficit: targetShare !== null && actualShare !== null ? targetShare - actualShare : null,
    };
  });
}

/** UUID order/ordinal rotation and caller+UUID hashes never depend on registry order. */
export function rankEnterprises(rows: readonly EnterpriseSchedulingInput[], tie: EnterpriseTie): EnterpriseScore[] {
  const ids = rows.filter(row => row.state === 'active').map(row => row.enterpriseId).sort();
  const offset = ids.length && tie.kind === 'creation' ? tie.ordinal % ids.length : 0;
  const rank = new Map(ids.map((id, index) => [id, (index - offset + ids.length) % ids.length]));
  const hashes = new Map(ids.map(id => [id, tie.kind === 'admission'
    ? createHash('sha256').update(`${tie.caller}\0${id}`).digest('hex') : '']));
  const empty = rows.filter(row => row.state === 'active').every(row => row.inventory === 0);
  return enterpriseScores(rows).filter(row => row.state === 'active' && row.eligible !== false
    && (tie.kind === 'creation' ? row.inventory < row.maxAccounts : row.eligibleIdle > 0))
    .sort((a, b) => (empty ? b.maxAccounts - a.maxAccounts : b.score - a.score) || (tie.kind === 'creation'
      ? rank.get(a.enterpriseId)! - rank.get(b.enterpriseId)!
      : hashes.get(a.enterpriseId)!.localeCompare(hashes.get(b.enterpriseId)!))
      || a.enterpriseId.localeCompare(b.enterpriseId));
}

export const MANUAL_POOL_ERRORS = [
  'sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous', 'oauth_task_cancelled_unconfirmed',
] as const;
const UNKNOWN_SUPPLY_ERRORS = [
  ...MANUAL_POOL_ERRORS, 'scim_sync_unconfirmed', 'seat_assignment_unconfirmed', 'oauth_dispatch_unconfirmed',
  'oauth_callback_unconfirmed', 'oauth_task_stalled', 'oauth_task_mismatch', 'sso_identity_changed',
  'proxy_identity_changed', 'unknown_provision_stage',
];
export const DISPATCHED_POOL_STAGES = ['sso-creating', 'scim-syncing', 'seat-assigning', 'oauth-dispatch', 'oauth-wait'] as const;

/** Persisted approval survives an unrelated registry append, but never an identity change. */
export function enterprisePolicyReady(policy: EnterprisePoolPolicyRecord, profile: EnterpriseProfileV3, legacyEnterpriseId: string): boolean {
  if (policy.enterpriseId !== profile.id || policy.identitySha256 !== enterpriseProfileIdentityHashV4(profile)
    || policy.validatedAt === null || !['active', 'validated', 'draining'].includes(policy.state)) return false;
  if (policy.validationKind === 'migration_preserved_v3') return profile.id === legacyEnterpriseId;
  if (policy.validationKind !== 'local_service_readiness_v1' || profile.login.provider !== 'custom') return false;
  try {
    const evidence = parseEnterpriseValidationEvidenceV1(policy.validationEvidence);
    return evidence.enterpriseId === profile.id && evidence.enterpriseRevision === profile.revision
      && evidence.profileIdentitySha256 === policy.identitySha256 && evidence.legacyEnterpriseId === legacyEnterpriseId
      && evidence.checkedAt === policy.validatedAt;
  } catch { return false; }
}

/** Fresh actions bind the entire current service pair and reject stale/future evidence. */
export function validateEnterprisePolicyEvidence(
  value: unknown, profile: EnterpriseProfileV3, registry: EnterpriseRegistryV3, now: number,
): EnterpriseValidationEvidenceV1 {
  const evidence = parseEnterpriseValidationEvidenceV1(value);
  if (profile.login.provider !== 'custom' || evidence.enterpriseId !== profile.id
    || evidence.enterpriseRevision !== profile.revision || evidence.profileIdentitySha256 !== enterpriseProfileIdentityHashV4(profile)
    || evidence.registryRevision !== registry.registryRevision || evidence.registrySha256 !== enterpriseRegistryHashV3(registry)
    || evidence.legacyEnterpriseId !== registry.legacyEnterpriseId || evidence.checkedAt > now
    || evidence.checkedAt < now - 300000) throw new Error('invalid_readiness_evidence');
  return evidence;
}

/** Both backends select policy columns plus profiles.max_accounts; never trust caller cap. */
export function enterprisePolicyFromRow(row: Record<string, unknown>): EnterprisePoolPolicyRecord {
  const integer = (value: unknown): number => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) return NaN;
    return Number(value);
  };
  return parseEnterprisePoolPolicyRecord({
    enterpriseId: row.enterprise_id, state: row.state, policyVersion: integer(row.policy_version),
    maxAccounts: integer(row.max_accounts), identitySha256: row.identity_sha256,
    validationKind: row.validation_kind,
    validationEvidence: row.validation_evidence_json === null ? null : parseEnterpriseValidationEvidenceJsonV1(row.validation_evidence_json),
    validatedAt: row.validated_at === null ? null : integer(row.validated_at), updatedAt: integer(row.updated_at),
  });
}

/** Safe blocking codes, shared by storage snapshots and admission. */
export function enterprisePolicyBlockers(registry: EnterpriseRegistryV3, policy: EnterprisePoolPolicyRecord): string[] {
  const profile = registry.profiles.find(row => row.id === policy.enterpriseId);
  const blockers: string[] = [];
  if (policy.state !== 'active') blockers.push(`enterprise_${policy.state}`);
  if (!profile || !enterprisePolicyReady(policy, profile, registry.legacyEnterpriseId)) blockers.push('enterprise_readiness_required');
  return blockers;
}

/** Storage owns CAS, total-cap validation and locks; transitions have one implementation. */
export function applyEnterprisePolicyChange(
  registry: EnterpriseRegistryV3, current: EnterprisePoolPolicyRecord, change: EnterprisePoolPolicyChange, now: number,
): EnterprisePoolPolicyRecord {
  const profile = registry.profiles.find(row => row.id === current.enterpriseId);
  if (!profile) throw new UserPoolError(404, 'enterprise_not_found');
  if (!change || typeof change !== 'object' || Array.isArray(change)) throw new UserPoolError(400, 'invalid_enterprise_policy');
  const allowed = change.type === 'cap' ? ['type', 'maxAccounts']
    : change.type === 'validate' || change.type === 'activate' ? ['type', 'evidence'] : change.type === 'drain' ? ['type'] : [];
  if (!allowed.length || Object.keys(change).length !== allowed.length || Object.keys(change).some(key => !allowed.includes(key))) {
    throw new UserPoolError(400, 'invalid_enterprise_policy');
  }
  const next = { ...current, policyVersion: current.policyVersion + 1, updatedAt: now };
  if (change.type === 'cap') {
    if (!Number.isSafeInteger(change.maxAccounts) || change.maxAccounts < 1 || change.maxAccounts > 10000) {
      throw new UserPoolError(400, 'invalid_enterprise_policy');
    }
    next.maxAccounts = change.maxAccounts;
  } else if (change.type === 'drain') {
    if (current.state !== 'active') throw new UserPoolError(409, 'invalid_policy_transition');
    next.state = 'draining';
  } else {
    if (change.type === 'validate' ? current.state === 'active' : current.state !== 'validated') {
      throw new UserPoolError(409, 'invalid_policy_transition');
    }
    try {
      const evidence = validateEnterprisePolicyEvidence(change.evidence, profile, registry, now);
      next.state = change.type === 'validate' ? 'validated' : 'active';
      next.identitySha256 = evidence.profileIdentitySha256;
      next.validationKind = 'local_service_readiness_v1';
      next.validationEvidence = evidence;
      next.validatedAt = evidence.checkedAt;
    } catch { throw new UserPoolError(400, 'invalid_readiness_evidence'); }
  }
  return next;
}

/**
 * Portable SQL for one inventory row p joined to its immutable main account a.
 * The caller applies active/validated-policy eligibility. `nowSql` is a trusted
 * SQL expression (normally a bounded integer literal), never user input.
 * Expired leases/holds and ended cooling are evaluated without physical cleanup.
 */
export function logicalSupplySql(nowSql: string, inventoryAlias = 'p', accountAlias = 'a'): {
  eligibleIdle: string; pendingSupply: string; unbound: string;
} {
  const p = inventoryAlias; const a = accountAlias;
  const unbound = `NOT EXISTS (SELECT 1 FROM user_pool_leases supply_l WHERE supply_l.member_identity=${p}.identity AND supply_l.expires_at>${nowSql})
    AND NOT EXISTS (SELECT 1 FROM user_pool_holds supply_h JOIN user_pool_leases supply_hl ON supply_hl.lease_id=supply_h.lease_id
      WHERE supply_hl.member_identity=${p}.identity AND supply_h.expires_at>${nowSql})
    AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_holds supply_c WHERE supply_c.member_identity=${p}.identity AND supply_c.expires_at>${nowSql})
    AND NOT EXISTS (SELECT 1 FROM user_pool_catalog_cooldowns supply_cc WHERE supply_cc.member_identity=${p}.identity AND supply_cc.expires_at>${nowSql})`;
  const safe = `(${unbound}) AND ${p}.cooldown_until<=${nowSql}`;
  return {
    unbound: `(${unbound})`,
    eligibleIdle: `(${safe} AND ${p}.state IN ('ready','cooling') AND ${p}.verified_at IS NOT NULL
      AND ${a}.copilot_oauth_status='valid' AND COALESCE(LENGTH(${a}.copilot_oauth_token),0)>0)`,
    pendingSupply: `(${safe} AND (${p}.state IN ('provisioning','failed')
        OR (${p}.state IN ('ready','cooling') AND (${p}.verified_at IS NULL
          OR ${a}.copilot_oauth_status<>'valid' OR COALESCE(LENGTH(${a}.copilot_oauth_token),0)=0))) AND ${p}.attempts<3
      AND ${p}.stage IN ('new','sso-created','scim-syncing','scim-synced','seat-assigning','synced','oauth-starting','oauth-dispatch','oauth-wait','warmup','ready')
      AND COALESCE(${p}.last_error,'') NOT IN (${UNKNOWN_SUPPLY_ERRORS.map(error => `'${error}'`).join(',')}))`,
  };
}
