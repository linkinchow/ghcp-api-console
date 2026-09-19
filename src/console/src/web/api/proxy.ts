import type {
  BatchResult,
  ClearProxyErrorDiagnosticsResponse,
  DeleteProxyAccountResult,
  ImportCopilotOauthTokenRow,
  PageResponse,
  ProxyAccountDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyErrorDiagnosticsListResponse,
  ProxyRequestStatDto,
  SsoType,
} from '@ghcp/shared';
import { api, downloadApi } from './client.js';
import { profilePath, requireIncarnation } from './enterprises.js';

export interface ListProxyAccountsQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}

export function listProxyAccounts(enterpriseId: string, params: ListProxyAccountsQuery = {}, signal?: AbortSignal): Promise<PageResponse<ProxyAccountDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return api(`${profilePath('proxy', enterpriseId)}/accounts${query(search)}`, { signal, cache: 'no-store' });
}
export function getProxyAccount(enterpriseId: string, identity: string, signal?: AbortSignal): Promise<ProxyAccountDto> {
  return api(`${profilePath('proxy', enterpriseId)}/accounts/${encodeURIComponent(identity)}`, { signal, cache: 'no-store' });
}
export function deleteProxyAccount(enterpriseId: string, identity: string, expectedAccountIncarnation: string): Promise<DeleteProxyAccountResult> {
  return api(`${profilePath('proxy', enterpriseId)}/accounts/${encodeURIComponent(identity)}`, {
    method: 'DELETE', body: JSON.stringify({ expectedAccountIncarnation: requireIncarnation(expectedAccountIncarnation) }),
  });
}
export interface RequestStatsQuery { page?: number; pageSize?: number; q?: string; success?: string; model?: string; identity?: string }
export function listRequestStatsPage(enterpriseId: string, params: RequestStatsQuery = {}, signal?: AbortSignal): Promise<PageResponse<ProxyRequestStatDto>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  return api(`${profilePath('proxy', enterpriseId)}/request-stats/page${query(search)}`, { signal, cache: 'no-store' });
}
export function reauthorizeCopilotOauth(enterpriseId: string, identity: string, body: { ssoPassword: string; ssoType: SsoType; expectedAccountIncarnation: string }): Promise<ProxyAccountDto | undefined> {
  requireIncarnation(body.expectedAccountIncarnation);
  return api(`${profilePath('proxy', enterpriseId)}/accounts/${encodeURIComponent(identity)}/copilot-oauth/reauthorize`, { method: 'POST', body: JSON.stringify(body) });
}
export function importCopilotOauthTokens(enterpriseId: string, csvText: string): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  return api(`${profilePath('proxy', enterpriseId)}/accounts/copilot-oauth-token/import`, { method: 'POST', body: JSON.stringify({ csvText }) });
}

export function listErrorDiagnostics(params: { page?: number; pageSize?: number } = {}): Promise<ProxyErrorDiagnosticsListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  return api<ProxyErrorDiagnosticsListResponse>(`/api/console/proxy/error-diagnostics${query(search)}`);
}

export function getErrorDiagnostic(id: string): Promise<ProxyErrorDiagnosticDetailDto> {
  return api<ProxyErrorDiagnosticDetailDto>(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}`);
}

export function downloadErrorDiagnostic(id: string): Promise<{ blob: Blob; filename: string }> {
  return downloadApi(`/api/console/proxy/error-diagnostics/${encodeURIComponent(id)}/download`);
}

export function clearErrorDiagnostics(): Promise<ClearProxyErrorDiagnosticsResponse> {
  return api<ClearProxyErrorDiagnosticsResponse>('/api/console/proxy/error-diagnostics', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
}

function query(search: URLSearchParams): string {
  const value = search.toString();
  return value ? `?${value}` : '';
}
