import type { LoginRuntimeSettingsDto, UpdateLoginRuntimeSettingsRequest } from '@ghcp/shared';
import { api } from './client.js';
import { enterprisePath } from './enterprises.js';

/** Login runtime settings are process-wide (one queue and concurrency for every enterprise). */
const SETTINGS = '/api/console/login-service/settings/runtime';

/** `/api/console/login-service/enterprises/<id>`: tasks, queue and task operations. */
export function loginPath(enterpriseId: string): string {
  return enterprisePath('login-service', enterpriseId);
}

export function getLoginRuntimeSettings(signal?: AbortSignal): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>(SETTINGS, { signal });
}

export function updateLoginRuntimeSettings(body: UpdateLoginRuntimeSettingsRequest): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>(SETTINGS, { method: 'PATCH', body: JSON.stringify(body) });
}
