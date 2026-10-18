import type { AdminModelsResponse } from '@ghcp/shared';
import { api } from './client.js';
import { enterprisePath } from './enterprises.js';

/** The catalog of this enterprise's configured admin; Proxy never falls back to pool or direct accounts. */
export function getAdminModels(
  enterpriseId: string,
  refresh = false,
  signal?: AbortSignal,
): Promise<AdminModelsResponse> {
  const path = `${enterprisePath('proxy', enterpriseId)}/models?refresh=${refresh}`;
  return api(path, { signal, cache: 'no-store' });
}
