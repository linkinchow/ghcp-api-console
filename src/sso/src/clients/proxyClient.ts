import { JsonHttpClient } from '@ghcp/shared';
import { config } from '../config.js';

export interface DeleteProxyAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export class PoolMembershipUnavailableError extends Error {
  readonly code = 'pool_membership_unavailable';

  constructor() {
    super('pool_membership_unavailable: Cannot verify user pool ownership; no destructive action was performed.');
    this.name = 'PoolMembershipUnavailableError';
  }
}

export async function isProxyPoolManagedSsoUser(ssoUser: string): Promise<boolean> {
  try {
    const result = await client.request<{ managed?: unknown }>(`/internal/accounts/by-sso-user/${encodeURIComponent(ssoUser)}/pool-membership`, {
      method: 'GET',
    });
    // Missing endpoints, malformed responses and transport failures must not allow deletion.
    if (!result || typeof result.managed !== 'boolean') throw new PoolMembershipUnavailableError();
    return result.managed;
  } catch {
    // Never relay Proxy response bodies, credentials, or network errors to ordinary DTOs.
    throw new PoolMembershipUnavailableError();
  }
}

export async function deleteProxyAccountsBySsoUser(ssoUser: string): Promise<DeleteProxyAccountsBySsoUserResult> {
  return client.request<DeleteProxyAccountsBySsoUserResult>(`/internal/accounts/by-sso-user/${encodeURIComponent(ssoUser)}`, {
    method: 'DELETE',
  });
}
