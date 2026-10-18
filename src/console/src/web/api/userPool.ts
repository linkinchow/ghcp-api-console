import { api } from './client.js';
import { enterprisePath } from './enterprises.js';

/** Global pool settings; each enterprise's account cap lives in its pool policy. */
export interface UserPoolSettings {
  version: number;
  idle_target: number;
  lease_seconds: number;
  paused: number;
}
export type UserPoolSettingsChanges = Omit<UserPoolSettings, 'version'>;
export interface UserPoolCounts {
  total: number;
  ready_idle: number;
  leased: number;
  provisional: number;
  provisioning: number;
  cooling: number;
  failed: number;
  disabled: number;
}
export interface UserPoolAccount {
  identity: string;
  ordinal: number;
  state: string;
  stage: string;
  ghLogin: string | null;
  oauthStatus: string;
  attempts: number;
  retryAt: number | null;
  lastError: string | null;
  updatedAt: number | null;
  cooldownUntil: number | null;
  verifiedAt: number | null;
  callerKeyHash: string | null;
  leasePhase: string | null;
  leaseExpiresAt: number | null;
  activeRequests: number;
}
export interface UserPoolLease {
  leaseId: string;
  memberIdentity: string;
  callerKeyHash: string | null;
  phase: string;
  assignedAt: number | null;
  lastSuccessAt: number | null;
  expiresAt: number | null;
  inUse: boolean;
}
export interface UserPoolEvent {
  id: number;
  at: number | null;
  action: string;
  identity: string | null;
  callerKeyHash: string | null;
  leaseId: string | null;
  detail: string | null;
}
export interface UserPoolLimits {
  maxAccounts: number;
  minLeaseSeconds: number;
  maxLeaseSeconds: number;
}
/** `GET /user-pool/overview`: process-wide settings and counts across every enterprise. */
export interface UserPoolOverview {
  enabled: true;
  poolId: 'default';
  observedAt: number;
  settings: UserPoolSettings;
  counts: UserPoolCounts;
  limits: UserPoolLimits;
  listLimits: { accounts: number; leases: number; events: number };
}
/** `GET /enterprises/:id/user-pool/summary`: one enterprise's member counts. */
export interface EnterprisePoolSummary {
  enabled: true;
  enterpriseId: string;
  observedAt: number;
  counts: UserPoolCounts;
  listLimits: { accounts: number; leases: number; events: number };
}
export type UserPoolAccountAction = 'disable' | 'resume' | 'retry';
export interface UserPoolPageResult {
  items: Array<UserPoolAccount | UserPoolLease | UserPoolEvent>;
  total: number;
  page: number;
  pageSize: number;
}

/** Settings, the overview and reconcile are global; members, leases and events need an enterprise. */
const GLOBAL = '/api/console/proxy/user-pool';

function scoped(enterpriseId: string): string {
  return `${enterprisePath('proxy', enterpriseId)}/user-pool`;
}

export function getUserPoolOverview(signal?: AbortSignal): Promise<UserPoolOverview> {
  return api<UserPoolOverview>(`${GLOBAL}/overview`, { signal, cache: 'no-store' });
}
export function updateUserPoolSettings(
  expectedVersion: number,
  changes: Partial<UserPoolSettingsChanges>,
): Promise<UserPoolSettings> {
  const body = JSON.stringify({ expectedVersion, changes });
  return api<UserPoolSettings>(`${GLOBAL}/settings`, { method: 'PATCH', body });
}
export function reconcileUserPool(): Promise<{ scheduled: true }> {
  return api(`${GLOBAL}/reconcile`, { method: 'POST' });
}
export function getEnterprisePoolSummary(enterpriseId: string, signal?: AbortSignal): Promise<EnterprisePoolSummary> {
  return api<EnterprisePoolSummary>(`${scoped(enterpriseId)}/summary`, { signal, cache: 'no-store' });
}
export function getUserPoolPage(enterpriseId: string, kind: 'accounts' | 'leases' | 'events', page: number,
  pageSize: number, q: string, state: string, signal?: AbortSignal): Promise<UserPoolPageResult> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q, state });
  return api(`${scoped(enterpriseId)}/page/${kind}?${query}`, { signal, cache: 'no-store' });
}
export function updateUserPoolAccount(
  enterpriseId: string,
  identity: string,
  action: UserPoolAccountAction,
): Promise<{ accepted: true }> {
  return api(`${scoped(enterpriseId)}/accounts/${encodeURIComponent(identity)}/${action}`, { method: 'POST' });
}
export function releaseUserPoolLease(enterpriseId: string, leaseId: string): Promise<{ released: true }> {
  const path = `${scoped(enterpriseId)}/leases/${encodeURIComponent(leaseId)}/release`;
  return api(path, { method: 'POST', body: JSON.stringify({ confirm: true }) });
}
