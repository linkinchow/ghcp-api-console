import type { RequestHandler, Router } from 'express';
import {
  HttpApiError,
  operationRoutes,
  resolveOperationSelection,
  withSqliteReadSnapshot,
  type OperationItem,
  type SsoUserBatchOperation,
} from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import { getUser, listUsers } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { runSsoUserBatch } from '../users/service.js';
import { requestEnterprise } from './requestEnterprise.js';

const actions: SsoUserBatchOperation[] = [
  'sync_emu',
  'suspend_emu',
  'delete_emu',
  'delete_sso',
  'assign_copilot',
  'remove_copilot',
];
const RETRY_HINT = ' Some external steps may have completed; check GitHub, seat and Proxy state before retrying.';

/** Operation previews live in memory per router, so each enterprise gets its own (and its own ids). */
const routers = new WeakMap<SsoEnterprise, Router>();

/** `/users/operations` of the request's enterprise; mounted behind `requireEnterprise`. */
export function createUserOperationsHandler(): RequestHandler {
  return (req, res, next) => {
    operationsRouterFor(requestEnterprise(res))(req, res, next);
  };
}

function operationsRouterFor(enterprise: SsoEnterprise): Router {
  let router = routers.get(enterprise);
  if (!router) {
    router = createUserOperationsRouter(enterprise);
    routers.set(enterprise, router);
  }
  return router;
}

function createUserOperationsRouter(enterprise: SsoEnterprise): Router {
  const enterpriseId = enterprise.id;
  return operationRoutes({
    scope: 'users',
    actions,
    resolve: (selection) => withSqliteReadSnapshot(getDb(), (database) => resolveOperationSelection(
      selection,
      async (query) => listUsers(enterpriseId, query, database),
      (user) => user.ssoUser,
    )),
    snapshot: async (id) => ({ revision: userRevision(enterprise, id), label: id }),
    concurrency: (action) => action === 'sync_emu' ? getSsoRuntimeSettings(enterpriseId).bulkSyncConcurrency : 1,
    eligibility: async (_action, id) => getUser(enterpriseId, id) ? undefined : 'The SSO user was removed.',
    prepareExecution: (input) => prepareExecution(enterprise, input),
  });
}

function userRevision(enterprise: SsoEnterprise, id: string): string | undefined {
  const user = getUser(enterprise.id, id);
  if (!user) return undefined;
  return JSON.stringify([
    user.updatedAt,
    user.ghLogin,
    user.emuStatus,
    user.copilotSeatStatus,
    user.copilotSeatPendingCancellationDate,
    user.role,
    user.email,
  ]);
}

function prepareExecution(
  enterprise: SsoEnterprise,
  input: Record<string, unknown>,
): (action: string, item: OperationItem) => Promise<OperationItem> {
  if (input.assignCopilotSeat !== undefined && typeof input.assignCopilotSeat !== 'boolean') {
    throw new HttpApiError(400, 'invalid_assign_copilot_seat', 'assignCopilotSeat must be a boolean.');
  }
  const assignCopilotSeat = input.assignCopilotSeat as boolean | undefined;
  return async (action, item) => {
    const operation = actions.find((entry) => entry === action);
    if (!operation) throw new HttpApiError(400, 'invalid_operation', 'Unknown SSO operation.');
    const result = await runSsoUserBatch(enterprise, { operation, ssoUsers: [item.id], assignCopilotSeat });
    const row = result.rows[0];
    if (!row) throw new Error('SSO operation did not return an item result.');
    const warning = row.warning ? ` Warning: ${row.warning}` : '';
    const hint = row.status === 'failed' ? RETRY_HINT : '';
    return { ...item, status: row.status, detail: `${row.detail}${warning}${hint}` };
  };
}
