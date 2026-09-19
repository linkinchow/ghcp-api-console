import { Router, type Response } from 'express';
import {
  apiError,
  errorFields,
  type ClearProxyErrorDiagnosticsRequest,
  type ImportCopilotOauthTokensRequest,
} from '@ghcp/shared';
import { importCopilotOauthTokens } from '../accounts/copilotOauthTokenImport.js';
import { deleteAccount, getAccount, listAccounts, toAccountDto } from '../db/accountsRepo.js';
import { listRequestStats, pageRequestStats } from '../db/requestStatsRepo.js';
import { AccountScopeError } from '../db/storageTypes.js';
import { enterpriseId } from '@ghcp/shared';
import { errorDiagnosticsStore } from '../diagnostics/errorDiagnostics.js';
import { ErrorDiagnosticsDisabledError } from '../diagnostics/errorDiagnosticsStore.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { Logger } from '../logger.js';
import { getUserPool } from '../userPool/runtime.js';

import { requestEnterpriseProfile, requireEnterpriseRequest } from '../enterprise.js';

export const adminApiRouter = Router();
adminApiRouter.use(requireEnterpriseRequest);
const logger = new Logger('admin-api');

adminApiRouter.get('/error-diagnostics', async (req, res) => {
  try {
    res.json(await errorDiagnosticsStore.list(numberQuery(req.query.page), numberQuery(req.query.pageSize)));
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.delete('/error-diagnostics', async (req, res) => {
  const body = req.body as Partial<ClearProxyErrorDiagnosticsRequest>;
  if (body.confirm !== true) {
    res.status(400).json(apiError('error_diagnostics_confirmation_required', 'Set confirm to true to clear all error diagnostics.'));
    return;
  }
  try {
    await errorDiagnosticsStore.clear();
    logger.info('clear-error-diagnostics', 'Cleared all proxy error diagnostics');
    res.json({ cleared: true });
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.get('/error-diagnostics/:id/download', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, true);
});

adminApiRouter.get('/error-diagnostics/:id', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, false);
});

adminApiRouter.get(['/accounts','/profiles/:enterpriseId/accounts'], async (req, res) => {
  const result = await listAccounts({
    enterpriseId:requestEnterpriseProfile(req).id,
    q: stringQuery(req.query.q),
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize),
    sort: stringQuery(req.query.sort) as never,
    dir: stringQuery(req.query.dir) as never,
  });
  res.json({ ...result, items: result.items.map(toAccountDto) });
});

adminApiRouter.get(['/accounts/:identity','/profiles/:enterpriseId/accounts/:identity'], async (req, res) => {
  const account = await getAccount(String(req.params.identity),requestEnterpriseProfile(req).id);
  if (!account) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  res.json(toAccountDto(account));
});

adminApiRouter.delete(['/accounts/:identity','/profiles/:enterpriseId/accounts/:identity'], async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'expectedAccountIncarnation')) {
      res.status(400).json(apiError('invalid_request', 'Only the expected account incarnation is accepted.')); return;
    }
    const incarnation = body.expectedAccountIncarnation === undefined ? undefined : enterpriseId(body.expectedAccountIncarnation);
    const result = await deleteAccount(String(req.params.identity), requestEnterpriseProfile(req).id, incarnation);
    if (!result) { res.status(404).json(apiError('account_not_found', 'Proxy account was not found.')); return; }
    clearModelsCache(result.identity);
    logger.info('delete-account', 'Deleted Proxy account and request stats', { ...result });
    res.json(result);
  } catch (error) {
    if (error instanceof AccountScopeError) res.status(409).json(apiError(error.code, 'Account changed after selection. Refresh before acting.'));
    else res.status(400).json(apiError('account_delete_rejected', 'Account deletion was rejected.'));
  }
});

adminApiRouter.post(['/accounts/copilot-oauth-token/import','/profiles/:enterpriseId/accounts/copilot-oauth-token/import'], async (req, res) => {
  if (await getUserPool()) {
    res.status(409).json(apiError('pool_member_managed', 'OAuth token imports are disabled in caller-lease mode. Use pool-managed authorization.'));
    return;
  }
  const body = req.body as ImportCopilotOauthTokensRequest;
  if (typeof body.csvText !== 'string' || !body.csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  try {
    logger.info('import-copilot-oauth-start', 'Copilot OAuth token CSV import requested');
    const result = await importCopilotOauthTokens(body.csvText,requestEnterpriseProfile(req).id);
    logger.info('import-copilot-oauth-done', 'Copilot OAuth token CSV import completed', { total: result.summary.total, success: result.summary.success, failed: result.summary.failed });
    res.json(result);
  } catch (err) {
    logger.error('import-copilot-oauth-failed', 'Copilot OAuth token CSV import failed', { ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_import_failed', err instanceof Error ? err.message : String(err)));
  }
});

adminApiRouter.get(['/accounts/:identity/request-stats','/profiles/:enterpriseId/accounts/:identity/request-stats'], async (req, res) => {
  if (!await getAccount(String(req.params.identity),requestEnterpriseProfile(req).id)) {
    res.status(404).json(apiError('account_not_found','Proxy account was not found.'));return;
  }
  res.json(await listRequestStats(String(req.params.identity), readLimit(req.query.limit),requestEnterpriseProfile(req).id));
});

adminApiRouter.get(['/request-stats','/profiles/:enterpriseId/request-stats'], async (req, res) => {
  res.json(await listRequestStats(undefined, readLimit(req.query.limit),requestEnterpriseProfile(req).id));
});

adminApiRouter.get('/profiles/:enterpriseId/request-stats/page', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (Object.keys(req.query).some(key => !['page', 'pageSize', 'q', 'identity', 'model', 'success'].includes(key))
      || Object.values(req.query).some(value => typeof value !== 'string')
      || req.query.success !== undefined && !['true', 'false'].includes(String(req.query.success))) {
      throw new AccountScopeError('invalid_request_stats_query');
    }
    const integer = (key: string, fallback: number) => {
      const value = req.query[key];
      if (value === undefined) return fallback;
      if (!/^\d+$/.test(String(value))) throw new AccountScopeError('invalid_request_stats_query');
      return Number(value);
    };
    res.json(await pageRequestStats({ enterpriseId: requestEnterpriseProfile(req).id,
      page: integer('page', 1), pageSize: integer('pageSize', 25), q: req.query.q as string | undefined,
      identity: req.query.identity as string | undefined, model: req.query.model as string | undefined,
      success: req.query.success === undefined ? undefined : req.query.success === 'true' }));
  } catch (error) {
    if (error instanceof AccountScopeError) res.status(400).json(apiError(error.code, 'Request statistics filters are invalid.'));
    else res.status(503).json(apiError('request_stats_unavailable', 'Request statistics are unavailable.'));
  }
});

adminApiRouter.post(['/accounts/:identity/copilot-oauth/reauthorize','/profiles/:enterpriseId/accounts/:identity/copilot-oauth/reauthorize'], async (req, res) => {
  try {
    if (await (await getUserPool())?.inventory(String(req.params.identity))) {
      res.status(409).json(apiError('pool_member_managed', 'Use User pool recovery controls for this account; an independent Login task cannot be started.'));
      return;
    }
    const body = req.body as { ssoPassword?: unknown; ssoType?: unknown; expectedAccountIncarnation?: unknown };
    const expectedAccountIncarnation = body.expectedAccountIncarnation === undefined ? undefined : enterpriseId(body.expectedAccountIncarnation);
    logger.info('reauthorize-copilot-start', 'Manual Copilot OAuth reauthorization requested', { identity: String(req.params.identity), ssoType: body.ssoType });
    await copilotAuthManager.triggerOauthRefresh(String(req.params.identity), {
      enterpriseId:requestEnterpriseProfile(req).id,
      expectedAccountIncarnation,
      ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : undefined,
      ssoType: body.ssoType === 'azure' || body.ssoType === 'custom' ? body.ssoType : undefined,
    });
    const account = await getAccount(String(req.params.identity),requestEnterpriseProfile(req).id);
    logger.info('reauthorize-copilot-queued', 'Copilot OAuth reauthorization queued a login task', { identity: String(req.params.identity), copilotOauthStatus: account?.copilotOauthStatus });
    res.json(account ? toAccountDto(account) : undefined);
  } catch (err) {
    logger.error('reauthorize-copilot-failed', 'Manual Copilot OAuth reauthorization failed', { identity: String(req.params.identity), ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_reauthorization_failed', err instanceof Error ? err.message : String(err)));
  }
});

function readLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

function stringQuery(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const raw = stringQuery(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function sendDiagnosticRecord(id: string, res: Response, download: boolean): Promise<void> {
  if (!isDiagnosticId(id)) {
    res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
    return;
  }
  try {
    const record = await errorDiagnosticsStore.get(id);
    if (!record) {
      res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
      return;
    }
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="proxy-error-${record.id}.log"`);
      res.type('text/plain').send(record.content);
      return;
    }
    res.json(record);
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
}

function sendDiagnosticsError(res: Response, err: unknown): void {
  if (err instanceof ErrorDiagnosticsDisabledError) {
    res.status(503).json(apiError('error_diagnostics_disabled', err.message));
    return;
  }
  logger.error('error-diagnostics-storage-failed', 'Proxy error diagnostics storage operation failed', {
    ...errorFields(err),
  });
  res.status(500).json(apiError('error_diagnostics_storage_failed', err instanceof Error ? err.message : String(err)));
}

function isDiagnosticId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
