import { JsonHttpClient, type EnterpriseId } from '@ghcp/shared';
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

/** `sso_user` is unique only within an enterprise, so every lookup is scoped (design §5.3). */
export async function isProxyPoolManagedSsoUser(enterpriseId: EnterpriseId, ssoUser: string): Promise<boolean> {
  try {
    const path = `${bySsoUserPath(enterpriseId, ssoUser)}/pool-membership`;
    const result = await client.request<{ managed?: unknown }>(path, { method: 'GET' });
    // Missing endpoints, malformed responses and transport failures must not allow deletion.
    if (!result || typeof result.managed !== 'boolean') throw new PoolMembershipUnavailableError();
    return result.managed;
  } catch {
    // Never relay Proxy response bodies, credentials, or network errors to ordinary DTOs.
    throw new PoolMembershipUnavailableError();
  }
}

export async function deleteProxyAccountsBySsoUser(
  enterpriseId: EnterpriseId,
  ssoUser: string,
): Promise<DeleteProxyAccountsBySsoUserResult> {
  return client.request<DeleteProxyAccountsBySsoUserResult>(bySsoUserPath(enterpriseId, ssoUser), {
    method: 'DELETE',
  });
}

function bySsoUserPath(enterpriseId: EnterpriseId, ssoUser: string): string {
  const enterprise = encodeURIComponent(enterpriseId);
  return `/internal/enterprises/${enterprise}/accounts/by-sso-user/${encodeURIComponent(ssoUser)}`;
}
