import { api } from './client.js';

export interface UserPoolSettings {
  version: number;
  idle_target: number;
  max_accounts: number;
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
export interface UserPoolOverview {
  enabled: true;
  poolId: 'default';
  observedAt: number;
  settings: UserPoolSettings;
  counts: UserPoolCounts;
  accounts: UserPoolAccount[];
  leases: UserPoolLease[];
  events: UserPoolEvent[];
  limits: UserPoolLimits;
  listLimits: { accounts: number; leases: number; events: number };
}
export type UserPoolAccountAction = 'disable' | 'resume' | 'retry';
const BASE = '/api/console/proxy/user-pool';

export function getUserPoolSummary(signal?: AbortSignal): Promise<UserPoolOverview> {
  return api<UserPoolOverview>(`${BASE}/summary`, { signal, cache: 'no-store' });
}
export interface UserPoolPageResult {
  items: Array<UserPoolAccount | UserPoolLease | UserPoolEvent>;
  total: number;
  page: number;
  pageSize: number;
}
export function getUserPoolPage(kind: 'accounts' | 'leases' | 'events', page: number, pageSize: number,
  q: string, state: string, signal?: AbortSignal): Promise<UserPoolPageResult> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q, state });
  return api(`${BASE}/page/${kind}?${query}`, { signal, cache: 'no-store' });
}
export function getUserPoolOverview(signal?: AbortSignal): Promise<UserPoolOverview> {
  return api<UserPoolOverview>(BASE, { signal, cache: 'no-store' });
}
export function updateUserPoolSettings(expectedVersion: number, changes: Partial<UserPoolSettingsChanges>): Promise<UserPoolSettings> {
  return api<UserPoolSettings>(`${BASE}/settings`, { method: 'PATCH', body: JSON.stringify({ expectedVersion, changes }) });
}
export function reconcileUserPool(): Promise<{ scheduled: true }> {
  return api(`${BASE}/reconcile`, { method: 'POST' });
}
export function updateUserPoolAccount(identity: string, action: UserPoolAccountAction): Promise<{ accepted: true }> {
  return api(`${BASE}/accounts/${encodeURIComponent(identity)}/${action}`, { method: 'POST' });
}
export function releaseUserPoolLease(leaseId: string): Promise<{ released: true }> {
  return api(`${BASE}/leases/${encodeURIComponent(leaseId)}/release`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
}
