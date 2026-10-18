import type { RequestHandler, Router } from 'express';
import {
  HttpApiError,
  operationRoutes,
  resolveOperationSelection,
  type ManagementQuery,
  type OperationItem,
  type SsoType,
} from '@ghcp/shared';
import { deleteAccount } from '../db/accountsRepo.js';
import { getStorage } from '../db/connection.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { getLoginTaskByAttempt } from '../clients/loginClient.js';
import { getEnterpriseAccount } from '../accounts/loginAuthorization.js';
import {
  assertNotPoolManagedAccount,
  isPoolManagedAccount,
  POOL_MEMBER_MANAGED_MESSAGE,
} from '../accounts/poolGuard.js';
import type { ProxyEnterprise } from '../enterprises.js';
import { requestEnterprise } from './requestEnterprise.js';

/** Operation previews live in memory per router, so each enterprise gets its own (and its own ids). */
const routers = new WeakMap<ProxyEnterprise, Router>();

/** `/accounts/operations` of the request's enterprise; mounted behind `requireEnterprise`. */
export function createAccountOperationsHandler(): RequestHandler {
  return (req, res, next) => {
    operationsRouterFor(requestEnterprise(res))(req, res, next);
  };
}

function operationsRouterFor(enterprise: ProxyEnterprise): Router {
  let router = routers.get(enterprise);
  if (!router) {
    router = createAccountOperationsRouter(enterprise);
    routers.set(enterprise, router);
  }
  return router;
}

/** Selection, eligibility and execution only see accounts of this enterprise (design §5.2). */
function createAccountOperationsRouter(enterprise: ProxyEnterprise): Router {
  const enterpriseId = enterprise.id;
  const account = (id: string) => getEnterpriseAccount(enterpriseId, id);
  return operationRoutes({
    scope: 'accounts', actions: ['delete', 'reauthorize'],
    resolve: (selection) => getStorage().withReadSnapshot((reader) => resolveOperationSelection(
      selection,
      (query: ManagementQuery) => reader.listAccounts(enterpriseId, query),
      (row) => row.identity,
    )),
    async snapshot(id) {
      const row = await account(id);
      const revision = row
        ? JSON.stringify([row.updatedAt, row.ssoUser, row.ghLogin, row.copilotOauthStatus, row.copilotOauthAttemptId])
        : undefined;
      return { revision, label: id };
    },
    async eligibility(action, id) {
      const row = await account(id);
      if (!row) return 'The Proxy account was removed.';
      if (action !== 'reauthorize') return undefined;
      if (row.copilotOauthStatus === 'refreshing') return 'An authorization is already active.';
      return await isPoolManagedAccount(id) ? POOL_MEMBER_MANAGED_MESSAGE : undefined;
    },
    prepareExecution(input, operationAction) {
      const overrides = readOverrides(input.overrides);
      const ssoType = readSsoType(input.ssoType, operationAction);
      return async (action, item): Promise<OperationItem> => {
        if (!await account(item.id)) return { ...item, status: 'skipped', detail: 'The account was removed.' };
        if (action === 'delete') return deleteItem(item);
        const ssoPassword = overrides.get(item.id);
        overrides.delete(item.id);
        return reauthorizeItem(item, ssoType, ssoPassword);
      };
    },
    async refresh(item) {
      if (!item.relatedTaskId || !item.attemptId) {
        return { ...item, status: 'interrupted', detail: 'No login attempt was recorded.' };
      }
      return refreshItem(enterprise, item, item.attemptId);
    },
  });
}

function readOverrides(raw: unknown): Map<string, string> {
  const overrides = new Map<string, string>();
  if (raw === undefined) return overrides;
  if (!Array.isArray(raw) || raw.length > 1000) {
    throw new HttpApiError(400, 'invalid_overrides', 'Invalid password overrides.');
  }
  for (const row of raw) {
    if (!isOverride(row)) {
      throw new HttpApiError(400, 'invalid_overrides', 'Each override needs an account and password.');
    }
    overrides.set(row.id, row.password);
  }
  return overrides;
}

function isOverride(row: unknown): row is { id: string; password: string } {
  if (!row || typeof row !== 'object') return false;
  const { id, password } = row as Record<string, unknown>;
  return typeof id === 'string' && typeof password === 'string' && password.length > 0;
}

function readSsoType(raw: unknown, operationAction: string): SsoType {
  if (raw !== undefined && raw !== 'custom' && raw !== 'azure') {
    throw new HttpApiError(400, 'invalid_sso_type', 'Invalid SSO type.');
  }
  // Proxy does not store a per-account SSO provider, so there is nothing to fall back to. Defaulting
  // to 'custom' would silently bypass the Azure guard that requires an explicit password, and every
  // Azure account in the batch would fail deep inside the browser automation instead of up front.
  if (operationAction === 'reauthorize' && raw === undefined) {
    const message = 'Choose the SSO provider (custom or azure) before re-authorizing.';
    throw new HttpApiError(400, 'sso_type_required', message);
  }
  return raw === 'azure' ? 'azure' : 'custom';
}

async function deleteItem(item: OperationItem): Promise<OperationItem> {
  const result = await deleteAccount(item.id);
  if (!result) return { ...item, status: 'skipped', detail: 'The account was removed.' };
  clearModelsCache(result.identity);
  const detail = `Account and ${result.deletedRequestStats} request records deleted. SSO/GH users are unchanged.`;
  return { ...item, status: 'success', detail };
}

async function reauthorizeItem(item: OperationItem, ssoType: SsoType, ssoPassword?: string): Promise<OperationItem> {
  // Re-checked at execution: pool membership can change after eligibility was evaluated.
  await assertNotPoolManagedAccount(item.id);
  const task = await copilotAuthManager.triggerOauthRefresh(item.id, {
    credentialMode: ssoPassword ? 'override' : 'default', ssoPassword, ssoType,
  });
  return {
    ...item, status: 'running', relatedTaskId: task.id, attemptId: task.oauthAttemptId,
    detail: 'Waiting for login completion.',
  };
}

async function refreshItem(
  enterprise: ProxyEnterprise,
  item: OperationItem,
  attemptId: string,
): Promise<OperationItem> {
  const task = await getLoginTaskByAttempt(enterprise.id, attemptId);
  if (task.oauthAttemptId !== attemptId) {
    return { ...item, status: 'interrupted', detail: 'A newer login attempt replaced this one.' };
  }
  if (task.status === 'pending' || task.status === 'running' || task.status === 'cancelling') {
    return { ...item, detail: task.stage ?? task.status };
  }
  return { ...item, status: task.status, detail: task.failureReason ?? task.status };
}
