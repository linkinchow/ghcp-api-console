import { EnterpriseContractError, enterpriseId } from './enterprise.js';
import type { EnterpriseProfileV3 } from './enterpriseV3.js';

export const ENTERPRISE_V4_SCHEMA = 4 as const;
export const ENTERPRISE_V4_CONTRACT = 2 as const;
export const ENTERPRISE_V4_CAPABILITY = 'enterprise-multi-pool' as const;
export type EnterprisePoolState = 'draft' | 'validated' | 'active' | 'draining';
export type EnterpriseValidationKind = 'local_service_readiness_v1' | 'migration_preserved_v3';
export interface EnterpriseReadinessV1 {
  probeVersion: 1; component: 'proxy' | 'sso' | 'login'; schemaVersion: number; contractVersion: 2;
  capability: string; enterpriseId: string; enterpriseRevision: number; profileIdentitySha256: string;
  registryRevision: number; registrySha256: string; legacyEnterpriseId: string; ready: boolean; blockers: string[];
}
export interface EnterpriseValidationEvidenceV1 {
  version: 1; enterpriseId: string; enterpriseRevision: number; profileIdentitySha256: string;
  registryRevision: number; registrySha256: string; legacyEnterpriseId: string; checkedAt: number;
  sso: EnterpriseReadinessV1; login: EnterpriseReadinessV1;
}
export interface EnterprisePoolPolicyRecord {
  enterpriseId: string; state: EnterprisePoolState; policyVersion: number; maxAccounts: number; identitySha256: string;
  validationKind: EnterpriseValidationKind | null; validationEvidence: EnterpriseValidationEvidenceV1 | null;
  validatedAt: number | null; updatedAt: number;
}
export type EnterprisePoolPolicyChange = { type: 'cap'; maxAccounts: number } | { type: 'validate'; evidence: EnterpriseValidationEvidenceV1 }
  | { type: 'activate'; evidence: EnterpriseValidationEvidenceV1 } | { type: 'drain' };
export interface EnterprisePoolPolicyDto {
  enterpriseId: string; enterpriseRevision: number; slug: string; shortcode: string; state: EnterprisePoolState;
  policyVersion: number; maxAccounts: number; validationKind: EnterpriseValidationKind | null; validatedAt: number | null; updatedAt: number;
}
export interface EnterprisePoolCountsDto {
  total: number; ready_idle: number; leased: number; provisional: number; provisioning: number; cooling: number; failed: number; disabled: number;
}
export interface EnterprisePoolSummaryDto extends EnterprisePoolPolicyDto {
  counts: EnterprisePoolCountsDto; eligibleIdle: number; pendingSupply: number; targetShare: number | null; actualShare: number | null;
  shareDeficit: number | null; score: number; overCap: boolean; blockedReasons: string[];
}
export interface GlobalPoolSettingsDto {
  version: number; idle_target: number; lease_seconds: number; paused: 0 | 1; max_accounts: number; active_max_accounts: number;
}
export interface EnterprisePoolOverviewDto {
  enabled: boolean; legacyEnterpriseId: string; observedAt: number; settings: GlobalPoolSettingsDto; enterprises: EnterprisePoolSummaryDto[];
  supply: { eligibleIdle: number; pendingSupply: number; deficit: number };
  names: { capacity: number; nextOrdinal: number; remainingPositions: number }; blockedReasons: string[];
}
export interface EnterpriseManagementListDto { enabled: boolean; legacyEnterpriseId: string; enterprises: EnterprisePoolPolicyDto[] }

const fail = (): never => { throw new EnterpriseContractError('enterprise_pool_contract_invalid'); };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return fail();
  return row;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail();
  return value as number;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return fail(); return value; }
function code(value: unknown): string { if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,95}$/.test(value)) return fail(); return value; }
export function parseEnterpriseReadinessV1(value: unknown): EnterpriseReadinessV1 {
  const r = record(value, ['probeVersion','component','schemaVersion','contractVersion','capability','enterpriseId','enterpriseRevision',
    'profileIdentitySha256','registryRevision','registrySha256','legacyEnterpriseId','ready','blockers']);
  if (r.probeVersion !== 1 || r.contractVersion !== 2 || !['proxy','sso','login'].includes(r.component as string)
    || typeof r.ready !== 'boolean' || !Array.isArray(r.blockers) || r.blockers.length > 32) return fail();
  const blockers = r.blockers.map(code);
  if (new Set(blockers).size !== blockers.length || r.ready !== (blockers.length === 0)) return fail();
  return { probeVersion: 1, component: r.component as EnterpriseReadinessV1['component'], schemaVersion: integer(r.schemaVersion,1,10000),
    contractVersion: 2, capability: code(r.capability), enterpriseId: enterpriseId(r.enterpriseId), enterpriseRevision: integer(r.enterpriseRevision,1),
    profileIdentitySha256: hash(r.profileIdentitySha256), registryRevision: integer(r.registryRevision,1), registrySha256: hash(r.registrySha256),
    legacyEnterpriseId: enterpriseId(r.legacyEnterpriseId), ready: r.ready, blockers };
}
export function parseEnterpriseValidationEvidenceV1(value: unknown): EnterpriseValidationEvidenceV1 {
  const r = record(value, ['version','enterpriseId','enterpriseRevision','profileIdentitySha256','registryRevision','registrySha256','legacyEnterpriseId','checkedAt','sso','login']);
  if (r.version !== 1) return fail();
  const evidence: EnterpriseValidationEvidenceV1 = { version: 1, enterpriseId: enterpriseId(r.enterpriseId), enterpriseRevision: integer(r.enterpriseRevision,1),
    profileIdentitySha256: hash(r.profileIdentitySha256), registryRevision: integer(r.registryRevision,1), registrySha256: hash(r.registrySha256),
    legacyEnterpriseId: enterpriseId(r.legacyEnterpriseId), checkedAt: integer(r.checkedAt), sso: parseEnterpriseReadinessV1(r.sso), login: parseEnterpriseReadinessV1(r.login) };
  for (const component of ['sso','login'] as const) {
    const probe = evidence[component];
    if (probe.component !== component || probe.schemaVersion !== 3 || probe.capability !== 'enterprise-isolation-legacy-pool' || !probe.ready
      || ['enterpriseId','enterpriseRevision','profileIdentitySha256','registryRevision','registrySha256','legacyEnterpriseId']
        .some(key => probe[key as keyof EnterpriseReadinessV1] !== evidence[key as keyof EnterpriseValidationEvidenceV1])) return fail();
  }
  return evidence;
}
export function parseEnterprisePoolPolicyRecord(value: unknown): EnterprisePoolPolicyRecord {
  const r = record(value, ['enterpriseId','state','policyVersion','maxAccounts','identitySha256','validationKind','validationEvidence','validatedAt','updatedAt']);
  if (!['draft','validated','active','draining'].includes(r.state as string)
    || r.validationKind !== null && !['local_service_readiness_v1','migration_preserved_v3'].includes(r.validationKind as string)) return fail();
  const result: EnterprisePoolPolicyRecord = { enterpriseId: enterpriseId(r.enterpriseId), state: r.state as EnterprisePoolState,
    policyVersion: integer(r.policyVersion,1), maxAccounts: integer(r.maxAccounts,1,10000), identitySha256: hash(r.identitySha256),
    validationKind: r.validationKind as EnterpriseValidationKind | null,
    validationEvidence: r.validationEvidence === null ? null : parseEnterpriseValidationEvidenceV1(r.validationEvidence),
    validatedAt: r.validatedAt === null ? null : integer(r.validatedAt), updatedAt: integer(r.updatedAt) };
  if (result.validationKind === null) {
    if (result.validationEvidence !== null || result.validatedAt !== null || ['active','validated'].includes(result.state)) return fail();
  } else if (result.validationKind === 'local_service_readiness_v1') {
    const e = result.validationEvidence;
    if (!e || e.enterpriseId !== result.enterpriseId || e.profileIdentitySha256 !== result.identitySha256 || result.validatedAt !== e.checkedAt) return fail();
  } else if (result.validationEvidence !== null || result.validatedAt === null || !['active','draining'].includes(result.state)) return fail();
  if (result.state === 'draft' && result.validationKind !== null || result.validatedAt !== null && result.validatedAt > result.updatedAt) return fail();
  return result;
}
/** Bounded persisted JSON parser; rejects extensions instead of interpreting unknown evidence. */
export function parseEnterpriseValidationEvidenceJsonV1(value: unknown): EnterpriseValidationEvidenceV1 {
  if (typeof value !== 'string' || value.length > 16384) return fail();
  try { return parseEnterpriseValidationEvidenceV1(JSON.parse(value)); } catch { return fail(); }
}
/** Explicit projection only: never spread a profile or the persisted policy/evidence into HTTP DTOs. */
export function enterprisePoolPolicyDto(profile: EnterpriseProfileV3, value: EnterprisePoolPolicyRecord): EnterprisePoolPolicyDto {
  const p = parseEnterprisePoolPolicyRecord(value);
  if (profile.id !== p.enterpriseId) return fail();
  return { enterpriseId: p.enterpriseId, enterpriseRevision: profile.revision, slug: profile.slug, shortcode: profile.shortcode,
    state: p.state, policyVersion: p.policyVersion, maxAccounts: p.maxAccounts, validationKind: p.validationKind,
    validatedAt: p.validatedAt, updatedAt: p.updatedAt };
}
