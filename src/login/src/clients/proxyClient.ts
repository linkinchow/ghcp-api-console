import {
  JsonHttpClient,
  type CreateLoginTaskRequest,
  type EnterpriseId,
  type LoginCredentials,
  type LoginTaskDto,
} from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export interface PoolTaskProtection {
  managed: boolean;
  referenced: boolean;
}

export async function getPoolTaskProtection(
  enterpriseId: EnterpriseId,
  identity: string,
  taskId: string,
  oauthAttemptId?: string,
): Promise<PoolTaskProtection> {
  const query = new URLSearchParams({ taskId, ...(oauthAttemptId ? { oauthAttemptId } : {}) });
  const result = await client.request<{ managed?: unknown; referenced?: unknown }>(
    `${accountPath(enterpriseId, identity)}/login-task-protection?${query}`,
  );
  if (typeof result?.managed !== 'boolean' || typeof result?.referenced !== 'boolean') {
    throw new Error('Invalid pool task protection response.');
  }
  return { managed: result.managed, referenced: result.referenced };
}

/**
 * Asks Proxy to switch the account to a new attempt and to resolve the password for it. Proxy only
 * agrees while the account still points at the attempt this task ran before, so a retry of a stale
 * task cannot take over an authorization that was started elsewhere in the meantime.
 */
export function prepareLoginRetry(
  enterpriseId: EnterpriseId,
  task: LoginTaskDto,
  attemptId: string,
  credentials: LoginCredentials,
  previousAttemptId: string | null,
): Promise<CreateLoginTaskRequest> {
  const path = `${accountPath(enterpriseId, task.identity)}/oauth-attempts/${encodeURIComponent(attemptId)}/prepare`;
  const body = {
    ...credentials,
    ssoUser: task.ssoUser,
    ghLogin: task.ghLogin,
    ssoType: task.ssoType,
    previousAttemptId,
  };
  return client.request(path, { method: 'POST', body });
}

export async function saveCopilotOauthToken(
  enterpriseId: EnterpriseId,
  identity: string,
  oauthAttemptId: string,
  copilotOauthToken: string,
  ghLogin?: string,
): Promise<void> {
  await client.request(`${accountPath(enterpriseId, identity)}/copilot-oauth-token`, {
    method: 'PUT',
    body: { oauthAttemptId, copilotOauthToken, ghLogin },
  });
}

export async function markCopilotOauthFailed(
  enterpriseId: EnterpriseId,
  identity: string,
  oauthAttemptId: string,
  failureReason: string,
): Promise<void> {
  await client.request(`${accountPath(enterpriseId, identity)}/mark-copilot-oauth-failed`, {
    method: 'POST',
    body: { oauthAttemptId, failureReason },
  });
}

/** Proxy checks that the account belongs to the path's enterprise (design §5.3). */
function accountPath(enterpriseId: EnterpriseId, identity: string): string {
  return `/internal/enterprises/${encodeURIComponent(enterpriseId)}/accounts/${encodeURIComponent(identity)}`;
}
