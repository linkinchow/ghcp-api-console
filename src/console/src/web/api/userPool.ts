import { api } from './client.js';
import { profilePath } from './enterprises.js';
import type { EnterprisePoolCountsDto, GlobalPoolSettingsDto } from '@ghcp/shared';

export type UserPoolSettings = GlobalPoolSettingsDto;
export type UserPoolSettingsChanges = Pick<GlobalPoolSettingsDto, 'idle_target' | 'lease_seconds' | 'paused'>;
export type UserPoolCounts = EnterprisePoolCountsDto;
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
  poolId: string;
  enterpriseId: string;
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
const base = (enterpriseId: string) => `${profilePath('proxy', enterpriseId)}/user-pool`;

export function getUserPoolSummary(enterpriseId: string, signal?: AbortSignal): Promise<UserPoolOverview> {
  return api<UserPoolOverview>(`${base(enterpriseId)}/summary`, { signal, cache: 'no-store' });
}
export interface UserPoolPageResult {
  items: Array<UserPoolAccount | UserPoolLease | UserPoolEvent>;
  total: number;
  page: number;
  pageSize: number;
}
export function getUserPoolPage(enterpriseId: string, kind: 'accounts' | 'leases' | 'events', page: number, pageSize: number,
  q: string, state: string, signal?: AbortSignal): Promise<UserPoolPageResult> {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), q, state });
  return api(`${base(enterpriseId)}/page/${kind}?${query}`, { signal, cache: 'no-store' });
}
export function getUserPoolOverview(enterpriseId: string, signal?: AbortSignal): Promise<UserPoolOverview> {
  return api<UserPoolOverview>(base(enterpriseId), { signal, cache: 'no-store' });
}
export function updateUserPoolAccount(enterpriseId: string, identity: string, action: UserPoolAccountAction): Promise<{ accepted: true }> {
  return api(`${base(enterpriseId)}/accounts/${encodeURIComponent(identity)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
}
export function releaseUserPoolLease(enterpriseId: string, leaseId: string): Promise<{ released: true }> {
  return api(`${base(enterpriseId)}/leases/${encodeURIComponent(leaseId)}/release`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
}
