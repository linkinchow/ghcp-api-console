import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  apiError,
  csvExport,
  errorFields,
  HttpApiError,
  readManagementQuery,
  type EnterpriseId,
  type ImportCopilotOauthTokensRequest,
  type ManagementQuery,
  type ProxyAccountDto,
} from '@ghcp/shared';
import { importCopilotOauthTokens } from '../accounts/copilotOauthTokenImport.js';
import { getEnterpriseAccount } from '../accounts/loginAuthorization.js';
import { isPoolManagedAccount, POOL_MEMBER_MANAGED_MESSAGE } from '../accounts/poolGuard.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { deleteAccount, getAccount, listAccounts, toAccountDto } from '../db/accountsRepo.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { listRequestStats, listRequestStatsPage } from '../db/requestStatsRepo.js';
import type { ProxyAccountRecord } from '../db/storageTypes.js';
import { directModeEnterprise, type ProxyEnterprise } from '../enterprises.js';
import { Logger } from '../logger.js';
import { getUserPool } from '../userPool/runtime.js';
import { requestEnterprise } from './requestEnterprise.js';

/**
 * How an accounts router finds its enterprise. The scoped router uses the path enterprise for everything; the
 * deprecated `/api/accounts` lists DIRECT_MODE_ENTERPRISE_ID and addresses single rows by global identity.
 */
export interface AccountScope {
  /** The enterprise whose accounts are listed, summarized, exported and imported. */
  enterprise(res: Response): ProxyEnterprise;
  /** One account row; undefined when it does not exist or is outside the scope. */
  account(res: Response, identity: string): Promise<ProxyAccountRecord | undefined>;
}

export const enterpriseAccountScope: AccountScope = {
  enterprise: requestEnterprise,
  account: (res, identity) => getEnterpriseAccount(requestEnterprise(res).id, identity),
};

export const legacyAccountScope: AccountScope = {
  enterprise: directModeEnterprise,
  account: (_res, identity) => getAccount(identity),
};

const EXPORT_COLUMNS = ['identity', 'ssoUser', 'ghLogin', 'copilotOauthStatus', 'updatedAt'];
const STAT_COLUMNS = [
  'id', 'identity', 'ghLogin', 'requestedAt', 'path', 'model', 'success', 'inputTokens', 'outputTokens',
  'cacheInputTokens', 'cacheWriteTokens', 'failureReason',
];
const logger = new Logger('admin-api');

/** Account routes; mount under `/api/enterprises/:enterpriseId` (scoped) or `/api` (deprecated, direct). */
export function createAccountsRouter(scope: AccountScope): Router {
  const router = Router();
  router.get('/accounts', async (req, res) => {
    const result = await listAccounts(scope.enterprise(res).id, readManagementQuery(req.query));
    res.json({ ...result, items: result.items.map(accountDto) });
  });
  router.get('/accounts/summary', async (_req, res) => {
    await initializeStorage();
    res.json(await getStorage().summarizeAccounts(scope.enterprise(res).id));
  });
  router.route('/accounts/export').get(exportAccounts(scope)).post(exportAccounts(scope));
  router.post('/accounts/copilot-oauth-token/import', (req, res) => importTokens(scope, req, res));
  router.get('/accounts/:identity', async (req, res) => {
    const account = await scope.account(res, req.params.identity);
    if (!account) return sendAccountNotFound(res);
    res.json(accountDto(account));
  });
  router.delete('/accounts/:identity', (req, res) => deleteOneAccount(scope, req, res));
  router.get('/accounts/:identity/request-stats', (req, res) => accountRequestStats(scope, req, res));
  router.post('/accounts/:identity/copilot-oauth/reauthorize', (req, res) => reauthorize(scope, req, res));
  return router;
}

/** Request statistics of the path enterprise; mounted behind `requireEnterprise`. */
export function createRequestStatsRouter(): Router {
  const router = Router();
  router.route('/request-stats/export').get(exportRequests).post(exportRequests);
  router.get('/request-stats/page', async (req, res) => {
    res.json(await listRequestStatsPage(requestEnterprise(res).id, readManagementQuery(req.query)));
  });
  router.get('/request-stats', async (req, res) => {
    const enterpriseId = requestEnterprise(res).id;
    res.json(Object.keys(req.query).some((key) => key !== 'limit')
      ? await listRequestStatsPage(enterpriseId, readManagementQuery(req.query))
      : await listRequestStats(enterpriseId, undefined, readLimit(req.query.limit)));
  });
  return router;
}

/** Every account DTO names its enterprise, so a global identity lookup shows where the row lives. */
export function accountDto(account: ProxyAccountRecord): ProxyAccountDto {
  return { ...toAccountDto(account), enterpriseId: account.enterpriseId };
}

function exportAccounts(scope: AccountScope): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    await accountsExport(scope.enterprise(res).id)(req, res, next);
  };
}

function accountsExport(enterpriseId: EnterpriseId): RequestHandler {
  const list = (query: ManagementQuery) => listAccounts(enterpriseId, query);
  return csvExport('proxy-accounts', EXPORT_COLUMNS, list, accountValues, async (_query, consume) => {
    await initializeStorage();
    await getStorage().withReadSnapshot((reader) => consume((query) => reader.listAccounts(enterpriseId, query)));
  });
}

function accountValues(account: ProxyAccountRecord): unknown[] {
  return [account.identity, account.ssoUser, account.ghLogin, account.copilotOauthStatus, account.updatedAt];
}

async function exportRequests(req: Request, res: Response, next: NextFunction): Promise<void> {
  const enterpriseId = requestEnterprise(res).id;
  const list = (query: ManagementQuery) => listRequestStatsPage(enterpriseId, query);
  const handler = csvExport('request-stats', STAT_COLUMNS, list, statValues, async (_query, consume) => {
    await initializeStorage();
    await getStorage().withReadSnapshot((reader) => consume((query) => {
      return reader.listRequestStatsPage(enterpriseId, query);
    }));
  });
  await handler(req, res, next);
}

function statValues(stat: Awaited<ReturnType<typeof listRequestStatsPage>>['items'][number]): unknown[] {
  return [
    stat.id, stat.identity, stat.ghLogin, stat.requestedAt, stat.path, stat.model, stat.success, stat.inputTokens,
    stat.outputTokens, stat.cacheInputTokens, stat.cacheWriteTokens, stat.failureReason,
  ];
}

async function deleteOneAccount(scope: AccountScope, req: Request<{ identity: string }>, res: Response): Promise<void> {
  const account = await scope.account(res, req.params.identity);
  const result = account ? await deleteAccount(account.identity) : undefined;
  if (!result) return sendAccountNotFound(res);
  clearModelsCache(result.identity);
  const fields = { ...result, enterpriseId: account!.enterpriseId };
  logger.info('delete-account', 'Deleted Proxy account and request stats', fields);
  res.json(result);
}

/** A deprecated lookup of a missing identity keeps listing the direct-mode enterprise's statistics, as r4 did. */
async function accountRequestStats(scope: AccountScope, req: Request<{ identity: string }>, res: Response) {
  const account = await scope.account(res, req.params.identity);
  if (!account && scope === enterpriseAccountScope) return sendAccountNotFound(res);
  const enterpriseId = account?.enterpriseId ?? scope.enterprise(res).id;
  res.json(await listRequestStats(enterpriseId, req.params.identity, readLimit(req.query.limit)));
}

async function importTokens(scope: AccountScope, req: Request, res: Response): Promise<void> {
  if (await getUserPool()) {
    const message = 'OAuth token imports are disabled in caller-lease mode. Use pool-managed authorization.';
    res.status(409).json(apiError('pool_member_managed', message));
    return;
  }
  const body = req.body as ImportCopilotOauthTokensRequest;
  if (typeof body.csvText !== 'string' || !body.csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  const enterprise = scope.enterprise(res);
  try {
    const fields = { enterpriseId: enterprise.id };
    logger.info('import-copilot-oauth-start', 'Copilot OAuth token CSV import requested', fields);
    const result = await importCopilotOauthTokens(enterprise, body.csvText);
    logger.info('import-copilot-oauth-done', 'Copilot OAuth token CSV import completed', {
      enterpriseId: enterprise.id, ...result.summary,
    });
    res.json(result);
  } catch (err) {
    logger.error('import-copilot-oauth-failed', 'Copilot OAuth token CSV import failed', { ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_import_failed', err instanceof Error ? err.message : String(err)));
  }
}

async function reauthorize(scope: AccountScope, req: Request<{ identity: string }>, res: Response): Promise<void> {
  const { identity } = req.params;
  try {
    const account = await scope.account(res, identity);
    if (!account) return sendAccountNotFound(res);
    if (await isPoolManagedAccount(identity)) {
      res.status(409).json(apiError('pool_member_managed', POOL_MEMBER_MANAGED_MESSAGE));
      return;
    }
    const body = req.body as { ssoPassword?: unknown; ssoType?: unknown; credentialMode?: unknown };
    logger.info('reauthorize-copilot-start', 'Manual Copilot OAuth reauthorization requested', {
      identity, enterpriseId: account.enterpriseId, ssoType: body.ssoType,
    });
    await copilotAuthManager.triggerOauthRefresh(identity, {
      ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : undefined,
      ssoType: body.ssoType === 'azure' || body.ssoType === 'custom' ? body.ssoType : undefined,
      credentialMode: body.credentialMode === 'default' ? 'default' : 'override',
    });
    const updated = await getAccount(identity);
    if (!updated) throw accountRemovedAfterSubmission();
    logger.info('reauthorize-copilot-queued', 'Copilot OAuth reauthorization queued a login task', {
      identity, copilotOauthStatus: updated.copilotOauthStatus,
    });
    res.json(accountDto(updated));
  } catch (err) {
    sendReauthorizeError(res, identity, err);
  }
}

function accountRemovedAfterSubmission(): HttpApiError {
  const message = 'Authorization was submitted, but the account was removed. '
    + 'Check the associated Login task before retrying.';
  return new HttpApiError(409, 'account_removed_after_submission', message);
}

function sendReauthorizeError(res: Response, identity: string, err: unknown): void {
  logger.error('reauthorize-copilot-failed', 'Manual Copilot OAuth reauthorization failed', {
    identity, ...errorFields(err),
  });
  const status = err instanceof HttpApiError ? err.status : 400;
  const code = err instanceof HttpApiError ? err.code : 'copilot_oauth_reauthorization_failed';
  res.status(status).json(apiError(code, err instanceof Error ? err.message : String(err)));
}

function sendAccountNotFound(res: Response): void {
  res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
}

function readLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}
