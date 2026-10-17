import type { AdminModelsResponse } from '@ghcp/shared';
import { api } from './client.js';

/** The catalog of the configured GitHub enterprise admin; Proxy never falls back to pool accounts. */
export function getAdminModels(refresh = false, signal?: AbortSignal): Promise<AdminModelsResponse> {
  return api(`/api/console/proxy/models?refresh=${refresh}`, { signal, cache: 'no-store' });
}
