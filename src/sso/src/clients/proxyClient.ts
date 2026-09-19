import { externalFetch } from './externalFetch.js';
import { ExternalOperationUncertainError } from '../users/operationFence.js';
import { EnterpriseContractError, type EnterpriseScope } from '@ghcp/shared';
import { config } from '../config.js';
import { getScopeProfile } from '../enterprise.js';

export interface DeleteProxyAccountsBySsoUserResult {
  enterpriseId: string;
  enterpriseRevision: number;
  contractVersion: 2;
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export class PoolMembershipUnavailableError extends Error {
  readonly code = 'pool_membership_unavailable';
  constructor() {
    super('pool_membership_unavailable: Cannot verify user pool ownership; no destructive action was performed.');
    this.name = 'PoolMembershipUnavailableError';
  }
}

async function request(ssoUser: string, suffix: string, method: 'GET' | 'DELETE', scope: EnterpriseScope): Promise<Record<string, unknown>> {
  const profile = getScopeProfile(scope);
  const url = `${profile.routes.proxyInternalUrl}/internal/profiles/${encodeURIComponent(profile.id)}/accounts/by-sso-user/${encodeURIComponent(ssoUser)}${suffix}`;
  const response = await externalFetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: {
      'x-internal-token': config.internalApiToken,
      'x-enterprise-id': profile.id,
      'x-enterprise-revision': String(profile.revision),
      Accept: 'application/json',
    },
  });
  if (!response.ok) throw new EnterpriseContractError('proxy_scoped_operation_unavailable');
  let value: unknown;
  try { value = await response.json(); } catch {
    if (method === 'DELETE') throw new ExternalOperationUncertainError();
    throw new EnterpriseContractError('proxy_scoped_response_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (method === 'DELETE') throw new ExternalOperationUncertainError();
    throw new EnterpriseContractError('proxy_scoped_response_invalid');
  }
  const result = value as Record<string, unknown>;
  if (result.enterpriseId !== profile.id || result.enterpriseRevision !== profile.revision || result.contractVersion !== 2) {
    if (method === 'DELETE') throw new ExternalOperationUncertainError();
    throw new EnterpriseContractError('proxy_scoped_response_mismatch');
  }
  return result;
}

export async function isProxyPoolManagedSsoUser(ssoUser: string, scope: EnterpriseScope): Promise<boolean> {
  try {
    const result = await request(ssoUser, '/pool-membership', 'GET', scope);
    if (typeof result.managed !== 'boolean') throw new PoolMembershipUnavailableError();
    return result.managed;
  } catch { throw new PoolMembershipUnavailableError(); }
}

export async function deleteProxyAccountsBySsoUser(ssoUser: string, scope: EnterpriseScope): Promise<DeleteProxyAccountsBySsoUserResult> {
  const result = await request(ssoUser, '', 'DELETE', scope);
  if (result.ssoUser !== ssoUser || !['matchedAccounts', 'deletedAccounts', 'deletedRequestStats'].every(key => Number.isSafeInteger(result[key]) && (result[key] as number) >= 0)
    || (result.deletedAccounts as number) > (result.matchedAccounts as number)) {
    throw new ExternalOperationUncertainError();
  }
  return result as unknown as DeleteProxyAccountsBySsoUserResult;
}
