import type { EnterprisePoolPolicyDto, EnterpriseSummaryDto, UpdateEnterprisePoolPolicyRequest } from '@ghcp/shared';
import { api } from './client.js';

export type ConsoleService = 'proxy' | 'sso' | 'login-service';

/** One row of Proxy's `GET /api/enterprises`. */
export interface EnterpriseListItem extends EnterpriseSummaryDto {
  /** Pool member counts of this enterprise; `null` outside pool mode. */
  poolSummary: Record<string, number> | null;
  /** Scheduling score among active enterprises; `null` unless active. */
  shareScore: number | null;
}

export interface EnterpriseList {
  items: EnterpriseListItem[];
  /** Size of the account name catalog shared by every enterprise. */
  nameCapacity: number;
}

/** Same rule as the shared `isEnterpriseId`; the web bundle only imports types from `@ghcp/shared`. */
const ENTERPRISE_ID = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export const DEFAULT_ENTERPRISE = 'default';

export function isEnterpriseId(value: unknown): value is string {
  return typeof value === 'string' && ENTERPRISE_ID.test(value);
}

/**
 * The only way to build an enterprise-scoped Console API path. The enterprise is a required argument, never
 * module state, and an invalid id throws instead of falling back to `default`.
 */
export function enterprisePath(service: ConsoleService, enterpriseId: string): string {
  if (!isEnterpriseId(enterpriseId)) throw new Error(`Invalid enterprise "${enterpriseId}". Choose an enterprise.`);
  return `/api/console/${service}/enterprises/${enterpriseId}`;
}

export function listEnterprises(signal?: AbortSignal): Promise<EnterpriseList> {
  return api<EnterpriseList>('/api/console/proxy/enterprises', { signal, cache: 'no-store' });
}

export function updatePoolPolicy(
  enterpriseId: string,
  body: UpdateEnterprisePoolPolicyRequest,
): Promise<EnterprisePoolPolicyDto> {
  const init = { method: 'PATCH', body: JSON.stringify(body) };
  return api<EnterprisePoolPolicyDto>(`${enterprisePath('proxy', enterpriseId)}/pool-policy`, init);
}

/** `github.com` or `<name>.ghe.com`; the raw value when it is not a URL. */
export function githubHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
