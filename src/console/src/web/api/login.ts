import type { LoginRuntimeSettingsDto, LoginTaskDto, LoginTaskStatus, PageResponse, UpdateLoginRuntimeSettingsRequest } from '@ghcp/shared';
import { api } from './client.js';
import { profilePath } from './enterprises.js';

export function listLoginTasks(enterpriseId: string, limit = 100): Promise<LoginTaskDto[]> {
  return api<LoginTaskDto[]>(`${profilePath('login-service', enterpriseId)}/tasks?limit=${encodeURIComponent(String(limit))}`);
}

export function getLoginRuntimeSettings(): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>('/api/console/login-service/settings/runtime');
}

export function updateLoginRuntimeSettings(body: UpdateLoginRuntimeSettingsRequest): Promise<LoginRuntimeSettingsDto> {
  return api<LoginRuntimeSettingsDto>('/api/console/login-service/settings/runtime', { method: 'PATCH', body: JSON.stringify(body) });
}

export function listLoginTasksPage(enterpriseId: string, params: { q?: string; status?: LoginTaskStatus | ''; page?: number; pageSize?: number } = {}, signal?: AbortSignal): Promise<PageResponse<LoginTaskDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return api<PageResponse<LoginTaskDto>>(`${profilePath('login-service', enterpriseId)}/tasks?${search.toString()}`, { signal, cache: 'no-store' });
}

export async function cancelLoginTask(enterpriseId: string, id: string): Promise<LoginTaskDto> {
  const result = await api<{ task: LoginTaskDto; outcome: 'cancelled' | 'already-succeeded' | 'already-failed' | 'unknown' }>(
    `${profilePath('login-service', enterpriseId)}/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({}) });
  if (result.outcome !== 'cancelled') {
    throw new Error(result.outcome === 'unknown'
      ? 'Cancellation is not confirmed; refresh the task status before taking further action.'
      : 'The authorization attempt completed before cancellation; refresh the task status.');
  }
  return result.task;
}

export function deleteLoginTask(enterpriseId: string, id: string): Promise<void> {
  return api<void>(`${profilePath('login-service', enterpriseId)}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function reconcileLoginTask(enterpriseId: string, id: string): Promise<{ task: LoginTaskDto; outcome: string }> {
  return api(`${profilePath('login-service', enterpriseId)}/tasks/${encodeURIComponent(id)}/reconcile`, { method: 'POST', body: JSON.stringify({}) });
}
