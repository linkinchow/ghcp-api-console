import type { EnterpriseManagementListDto, EnterprisePoolOverviewDto, EnterprisePoolPolicyDto, GlobalPoolSettingsDto } from '@ghcp/shared';
import { api } from './client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Scope is a required argument, never mutable module state or a legacy fallback. */
export function profilePath(service: 'proxy' | 'sso' | 'login-service', enterpriseId: string): string {
  if (!UUID.test(enterpriseId)) throw new Error('A discovered enterprise must be selected before making this request.');
  return `/api/console/${service}/profiles/${encodeURIComponent(enterpriseId)}`;
}
export function requireIncarnation(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw new Error('Identity incarnation is unavailable. Refresh and review the record before changing it.');
  return value;
}
export async function discoverEnterprises(signal?: AbortSignal): Promise<EnterpriseManagementListDto> {
  const result = await api<EnterpriseManagementListDto>('/api/console/proxy/management/enterprises', { signal, cache: 'no-store' });
  if (typeof result.enabled !== 'boolean' || !Array.isArray(result.enterprises) || !UUID.test(result.legacyEnterpriseId)
    || !result.enterprises.some(item => item.enterpriseId === result.legacyEnterpriseId)
    || new Set(result.enterprises.map(item => item.enterpriseId)).size !== result.enterprises.length
    || result.enterprises.some(item => !UUID.test(item.enterpriseId) || !item.slug || !Number.isSafeInteger(item.policyVersion))) {
    throw new Error('Enterprise discovery is invalid. Scoped operations are unavailable; no legacy fallback will be used.');
  }
  return result;
}
export function getGlobalPoolSummary(signal?: AbortSignal): Promise<EnterprisePoolOverviewDto> {
  return api('/api/console/proxy/management/pool/summary', { signal, cache: 'no-store' });
}
export function getGlobalPoolSettings(signal?: AbortSignal): Promise<GlobalPoolSettingsDto> {
  return api('/api/console/proxy/management/pool/settings', { signal, cache: 'no-store' });
}
export function updateGlobalPoolSettings(expectedVersion: number, changes: Partial<Pick<GlobalPoolSettingsDto, 'idle_target' | 'lease_seconds' | 'paused'>>): Promise<GlobalPoolSettingsDto> {
  return api('/api/console/proxy/management/pool/settings', { method: 'PATCH', body: JSON.stringify({ expectedVersion, changes }) });
}
export function getEnterprisePolicy(enterpriseId: string, signal?: AbortSignal): Promise<EnterprisePoolPolicyDto> {
  return api(`${profilePath('proxy', enterpriseId)}/pool-policy`, { signal, cache: 'no-store' });
}
export function updateEnterpriseCap(enterpriseId: string, expectedVersion: number, maxAccounts: number): Promise<EnterprisePoolPolicyDto> {
  return api(`${profilePath('proxy', enterpriseId)}/pool-policy`, { method: 'PATCH', body: JSON.stringify({ expectedVersion, maxAccounts }) });
}
export function transitionEnterprise(enterpriseId: string, expectedVersion: number, action: 'validate' | 'activate' | 'drain'): Promise<EnterprisePoolPolicyDto> {
  return api(`${profilePath('proxy', enterpriseId)}/pool-policy/${action}`, {
    method: 'POST', body: JSON.stringify({ expectedVersion, ...(action === 'validate' ? {} : { confirm: true }) }),
  });
}
