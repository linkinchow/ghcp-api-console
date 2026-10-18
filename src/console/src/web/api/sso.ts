import type {
  AiCreditsUsageDto, BatchResult, CreateImportEmuPlanRequest, ImportEmuPlanDto, ImportEmuUserRow,
  ImportEmuUsersRequest, ImportEmuUserStatus, PageResponse, SsoRuntimeSettingsDto, SsoUserBatchRequest,
  SsoUserBatchRow, SsoUserCapacityDto, SsoUserDto, UpdateSsoRuntimeSettingsRequest,
} from '@ghcp/shared';
import { api } from './client.js';
import { enterprisePath } from './enterprises.js';

type ImportRow = { line: number; ssoUser: string; status: string; detail: string };
type PlanRowsQuery = { page?: number; pageSize?: number; status?: ImportEmuUserStatus | '' };

/** `/api/console/sso/enterprises/<id>`; every SSO management route is enterprise-scoped. */
export function ssoPath(enterpriseId: string): string {
  return enterprisePath('sso', enterpriseId);
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function getSsoUserCapacity(enterpriseId: string, signal?: AbortSignal): Promise<SsoUserCapacityDto> {
  return api<SsoUserCapacityDto>(`${ssoPath(enterpriseId)}/users/capacity`, { signal });
}

export function getSsoRuntimeSettings(enterpriseId: string, signal?: AbortSignal): Promise<SsoRuntimeSettingsDto> {
  return api<SsoRuntimeSettingsDto>(`${ssoPath(enterpriseId)}/settings/runtime`, { signal });
}

export function updateSsoRuntimeSettings(
  enterpriseId: string,
  body: UpdateSsoRuntimeSettingsRequest,
): Promise<SsoRuntimeSettingsDto> {
  const init = { method: 'PATCH', body: JSON.stringify(body) };
  return api<SsoRuntimeSettingsDto>(`${ssoPath(enterpriseId)}/settings/runtime`, init);
}

export function createSsoUser(
  enterpriseId: string,
  body: { ssoUser: string; password?: string; email?: string; role?: 'user' | 'admin' },
): Promise<SsoUserDto> {
  return post<SsoUserDto>(`${ssoPath(enterpriseId)}/users`, body);
}

export function importSsoUsers(enterpriseId: string, csvText: string): Promise<BatchResult<ImportRow>> {
  return post<BatchResult<ImportRow>>(`${ssoPath(enterpriseId)}/users/import`, { csvText });
}

export function importEmuUsers(
  enterpriseId: string,
  body: ImportEmuUsersRequest = {},
): Promise<BatchResult<ImportEmuUserRow>> {
  return post<BatchResult<ImportEmuUserRow>>(`${ssoPath(enterpriseId)}/users/emu/import`, body);
}

export function createEmuImportPlan(
  enterpriseId: string,
  body: CreateImportEmuPlanRequest = {},
): Promise<ImportEmuPlanDto> {
  return post<ImportEmuPlanDto>(`${ssoPath(enterpriseId)}/users/emu/import/plans`, body);
}

function planPath(enterpriseId: string, planId: string): string {
  return `${ssoPath(enterpriseId)}/users/emu/import/plans/${encodeURIComponent(planId)}`;
}

export function listEmuImportPlanRows(
  enterpriseId: string,
  planId: string,
  params: PlanRowsQuery = {},
  signal?: AbortSignal,
): Promise<PageResponse<ImportEmuUserRow>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  const path = `${planPath(enterpriseId, planId)}/rows${query ? `?${query}` : ''}`;
  return api<PageResponse<ImportEmuUserRow>>(path, { signal });
}

export function applyEmuImportPlan(enterpriseId: string, planId: string): Promise<ImportEmuPlanDto> {
  return post<ImportEmuPlanDto>(`${planPath(enterpriseId, planId)}/apply`);
}

export function deleteEmuImportPlan(enterpriseId: string, planId: string): Promise<void> {
  return api<void>(planPath(enterpriseId, planId), { method: 'DELETE' });
}

export function patchSsoUser(
  enterpriseId: string,
  ssoUser: string,
  body: { password?: string; email?: string; role?: 'user' | 'admin' },
): Promise<SsoUserDto> {
  const init = { method: 'PATCH', body: JSON.stringify(body) };
  return api<SsoUserDto>(`${ssoPath(enterpriseId)}/users/${encodeURIComponent(ssoUser)}`, init);
}

export function runSsoUserBatch(
  enterpriseId: string,
  body: SsoUserBatchRequest,
): Promise<BatchResult<SsoUserBatchRow>> {
  return post<BatchResult<SsoUserBatchRow>>(`${ssoPath(enterpriseId)}/users/batch`, body);
}

export function readAiCreditsUsage(enterpriseId: string, signal?: AbortSignal): Promise<AiCreditsUsageDto> {
  return api<AiCreditsUsageDto>(`${ssoPath(enterpriseId)}/ai-credits/usage`, { signal });
}

export function refreshAiCreditsUsage(enterpriseId: string, signal?: AbortSignal): Promise<AiCreditsUsageDto> {
  const init = { method: 'POST', body: JSON.stringify({}), signal };
  return api<AiCreditsUsageDto>(`${ssoPath(enterpriseId)}/ai-credits/usage/refresh`, init);
}
