import type {
  BatchResult,
  ClearProxyErrorDiagnosticsResponse,
  ImportCopilotOauthTokenRow,
  ManagementSummary,
  ProxyAccountDto,
  ProxyErrorDiagnosticDetailDto,
  ProxyRequestStatDto,
  SsoType,
} from '@ghcp/shared';
import { api, downloadApi } from './client.js';
import { enterprisePath } from './enterprises.js';

type ReauthorizeBody = { ssoPassword?: string; ssoType?: SsoType; credentialMode?: 'default' | 'override' };

/** Error diagnostics stay process-wide; each record carries its `enterpriseId`. */
const DIAGNOSTICS = '/api/console/proxy/error-diagnostics';

/** `/api/console/proxy/enterprises/<id>`: accounts, operations, request stats, pool members and Models. */
export function proxyPath(enterpriseId: string): string {
  return enterprisePath('proxy', enterpriseId);
}

function accountPath(enterpriseId: string, identity: string): string {
  return `${proxyPath(enterpriseId)}/accounts/${encodeURIComponent(identity)}`;
}

export function getProxyAccount(
  enterpriseId: string,
  identity: string,
  signal?: AbortSignal,
): Promise<ProxyAccountDto> {
  return api<ProxyAccountDto>(accountPath(enterpriseId, identity), { signal });
}

export function getAccountsSummary(enterpriseId: string, signal?: AbortSignal): Promise<ManagementSummary> {
  return api<ManagementSummary>(`${proxyPath(enterpriseId)}/accounts/summary`, { signal });
}

export function listRequestStats(
  enterpriseId: string,
  params: { identity?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ProxyRequestStatDto[]> {
  const search = new URLSearchParams();
  if (params.limit) search.set('limit', String(params.limit));
  const base = params.identity ? accountPath(enterpriseId, params.identity) : proxyPath(enterpriseId);
  return api<ProxyRequestStatDto[]>(`${base}/request-stats${query(search)}`, { signal });
}

export function reauthorizeCopilotOauth(
  enterpriseId: string,
  identity: string,
  body: ReauthorizeBody,
): Promise<ProxyAccountDto> {
  const init = { method: 'POST', body: JSON.stringify(body) };
  return api<ProxyAccountDto>(`${accountPath(enterpriseId, identity)}/copilot-oauth/reauthorize`, init);
}

export function importCopilotOauthTokens(
  enterpriseId: string,
  csvText: string,
): Promise<BatchResult<ImportCopilotOauthTokenRow>> {
  const path = `${proxyPath(enterpriseId)}/accounts/copilot-oauth-token/import`;
  return api<BatchResult<ImportCopilotOauthTokenRow>>(path, { method: 'POST', body: JSON.stringify({ csvText }) });
}

export function getErrorDiagnostic(id: string, signal?: AbortSignal): Promise<ProxyErrorDiagnosticDetailDto> {
  return api<ProxyErrorDiagnosticDetailDto>(`${DIAGNOSTICS}/${encodeURIComponent(id)}`, { signal });
}

export function downloadErrorDiagnostic(id: string): Promise<{ blob: Blob; filename: string }> {
  const path = `${DIAGNOSTICS}/${encodeURIComponent(id)}/download`;
  return downloadApi(path, { fallbackFilename: 'proxy-error-diagnostic.log' });
}

export function clearErrorDiagnostics(): Promise<ClearProxyErrorDiagnosticsResponse> {
  return api<ClearProxyErrorDiagnosticsResponse>(DIAGNOSTICS, {
    method: 'DELETE',
    body: JSON.stringify({ confirm: true }),
  });
}

export const errorDiagnosticsPath = DIAGNOSTICS;

function query(search: URLSearchParams): string {
  const value = search.toString();
  return value ? `?${value}` : '';
}
