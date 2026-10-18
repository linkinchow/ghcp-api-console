import { setTimeout as delay } from 'node:timers/promises';
import {
  HttpApiError,
  JsonHttpClient,
  type BatchResult,
  type EnsureSsoUserRequest,
  type EnsureSsoUserResponse,
  type EnterpriseId,
  type SsoUserBatchRow,
  type SsoUserDto,
} from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.ssoBaseUrl,
  internalToken: config.internalApiToken,
});

/**
 * SSO caps concurrent scrypt verifications and answers 429 `default_credentials_busy` beyond it.
 * That is backpressure, not a failure: a batch re-authorization would otherwise fail most of its
 * accounts simply because they were submitted at the same time.
 */
const BUSY_RETRIES = 5;
const BUSY_RETRY_DELAY_MS = 1000;

/** `/api/enterprises/:id` on SSO; `sso_user` is unique only within an enterprise (design §5.3). */
export function ssoApiPath(enterpriseId: EnterpriseId, path: string): string {
  return `/api/enterprises/${encodeURIComponent(enterpriseId)}${path}`;
}

export function ssoUserPath(enterpriseId: EnterpriseId, ssoUser: string, suffix = ''): string {
  return ssoApiPath(enterpriseId, `/users/${encodeURIComponent(ssoUser)}${suffix}`);
}

export async function resolveDefaultLoginPassword(enterpriseId: EnterpriseId, ssoUser: string): Promise<string> {
  const path = `/internal/enterprises/${encodeURIComponent(enterpriseId)}/users/${encodeURIComponent(ssoUser)}`
    + '/login-credentials';
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await client.request<{ password: string }>(path, { method: 'POST', body: {} });
      return result.password;
    } catch (err) {
      if (!isCredentialsBusy(err) || attempt > BUSY_RETRIES) throw err;
      await delay(BUSY_RETRY_DELAY_MS * attempt);
    }
  }
}

export async function ensureSsoUser(
  enterpriseId: EnterpriseId,
  request: EnsureSsoUserRequest,
): Promise<EnsureSsoUserResponse> {
  const path = ssoApiPath(enterpriseId, '/users/ensure');
  return client.request<EnsureSsoUserResponse>(path, { method: 'POST', body: request });
}

export async function getSsoUser(enterpriseId: EnterpriseId, ssoUser: string): Promise<SsoUserDto> {
  return client.request<SsoUserDto>(ssoUserPath(enterpriseId, ssoUser));
}

export async function syncEmuUser(
  enterpriseId: EnterpriseId,
  ssoUser: string,
  options: { assignCopilotSeat?: boolean } = {},
): Promise<SsoUserDto> {
  const result = await client.request<BatchResult<SsoUserBatchRow>>(ssoApiPath(enterpriseId, '/users/batch'), {
    method: 'POST',
    body: {
      operation: 'sync_emu',
      ssoUsers: [ssoUser],
      ...(options.assignCopilotSeat ? { assignCopilotSeat: true } : {}),
    },
  });
  const row = result.rows[0];
  if (!row || row.status === 'failed' || !row.user) {
    throw new Error(row?.detail ?? `Failed to sync GH login "${ssoUser}".`);
  }
  return row.user;
}

function isCredentialsBusy(err: unknown): boolean {
  return err instanceof HttpApiError && err.status === 429 && err.code === 'default_credentials_busy';
}
