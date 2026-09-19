import type { AiCreditsUsageDto, BatchResult, CreateImportEmuPlanRequest, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUsersRequest, ImportEmuUserStatus, PageResponse, SsoRuntimeSettingsDto, SsoUserBatchRequest, SsoUserBatchRow, SsoUserCapacityDto, SsoUserDto, UpdateSsoRuntimeSettingsRequest } from '@ghcp/shared';
import { api } from './client.js';
import { profilePath, requireIncarnation } from './enterprises.js';

export interface ListUsersQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function listSsoUsers(enterpriseId: string, params: ListUsersQuery = {}, signal?: AbortSignal): Promise<PageResponse<SsoUserDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return api<PageResponse<SsoUserDto>>(`${profilePath('sso', enterpriseId)}/users${query ? `?${query}` : ''}`, { cache: 'no-store', signal });
}

export function getSsoUserCapacity(enterpriseId: string, signal?: AbortSignal): Promise<SsoUserCapacityDto> {
  return api<SsoUserCapacityDto>(`${profilePath('sso', enterpriseId)}/users/capacity`, { signal, cache: 'no-store' });
}

export function getSsoRuntimeSettings(enterpriseId: string): Promise<SsoRuntimeSettingsDto> {
  return api<SsoRuntimeSettingsDto>(`${profilePath('sso', enterpriseId)}/settings/runtime`);
}

export function updateSsoRuntimeSettings(enterpriseId: string, body: UpdateSsoRuntimeSettingsRequest): Promise<SsoRuntimeSettingsDto> {
  return api<SsoRuntimeSettingsDto>(`${profilePath('sso', enterpriseId)}/settings/runtime`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function createSsoUser(enterpriseId: string, body: { ssoUser: string; password?: string; email?: string; role?: 'user' | 'admin' }): Promise<SsoUserDto> {
  return api<SsoUserDto>(`${profilePath('sso', enterpriseId)}/users`, { method: 'POST', body: JSON.stringify(body) });
}

export function importSsoUsers(enterpriseId: string, csvText: string): Promise<BatchResult<{ line: number; ssoUser: string; status: string; detail: string }>> {
  return api<BatchResult<{ line: number; ssoUser: string; status: string; detail: string }>>(`${profilePath('sso', enterpriseId)}/users/import`, {
    method: 'POST',
    body: JSON.stringify({ csvText }),
  });
}

export function importEmuUsers(enterpriseId: string, body: ImportEmuUsersRequest = {}): Promise<BatchResult<ImportEmuUserRow>> {
  return api<BatchResult<ImportEmuUserRow>>(`${profilePath('sso', enterpriseId)}/users/emu/import`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function createEmuImportPlan(enterpriseId: string, body: CreateImportEmuPlanRequest = {}): Promise<ImportEmuPlanDto> {
  return api<ImportEmuPlanDto>(`${profilePath('sso', enterpriseId)}/users/emu/import/plans`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function listEmuImportPlanRows(enterpriseId: string, planId: string, params: { page?: number; pageSize?: number; status?: ImportEmuUserStatus | '' } = {}): Promise<PageResponse<ImportEmuUserRow>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return api<PageResponse<ImportEmuUserRow>>(`${profilePath('sso', enterpriseId)}/users/emu/import/plans/${encodeURIComponent(planId)}/rows${query ? `?${query}` : ''}`);
}

export function applyEmuImportPlan(enterpriseId: string, planId: string): Promise<ImportEmuPlanDto> {
  return api<ImportEmuPlanDto>(`${profilePath('sso', enterpriseId)}/users/emu/import/plans/${encodeURIComponent(planId)}/apply`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function deleteEmuImportPlan(enterpriseId: string, planId: string): Promise<void> {
  return api<void>(`${profilePath('sso', enterpriseId)}/users/emu/import/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
}

export function patchSsoUser(enterpriseId: string, ssoUser: string, body: { password?: string; email?: string; role?: 'user' | 'admin'; expectedUserIncarnation: string }): Promise<SsoUserDto> {
  requireIncarnation(body.expectedUserIncarnation);
  return api<SsoUserDto>(`${profilePath('sso', enterpriseId)}/users/${encodeURIComponent(ssoUser)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function runSsoUserBatch(enterpriseId: string, body: SsoUserBatchRequest & { expectedIncarnations: Record<string, string> }): Promise<BatchResult<SsoUserBatchRow>> {
  for (const user of body.ssoUsers) requireIncarnation(body.expectedIncarnations[user]);
  return api<BatchResult<SsoUserBatchRow>>(`${profilePath('sso', enterpriseId)}/users/batch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function readAiCreditsUsage(enterpriseId: string): Promise<AiCreditsUsageDto> {
  return api<AiCreditsUsageDto>(`${profilePath('sso', enterpriseId)}/ai-credits/usage`);
}

export function refreshAiCreditsUsage(enterpriseId: string): Promise<AiCreditsUsageDto> {
  return api<AiCreditsUsageDto>(`${profilePath('sso', enterpriseId)}/ai-credits/usage/refresh`, { method: 'POST', body: JSON.stringify({}) });
}
