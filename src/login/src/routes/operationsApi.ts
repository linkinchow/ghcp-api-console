import type { RequestHandler, Router } from 'express';
import {
  HttpApiError,
  operationRoutes,
  resolveOperationSelection,
  withSqliteReadSnapshot,
  type LoginCredentials,
  type OperationItem,
} from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import { getTask, hasActiveTask, listAttempts, listTasksPage } from '../db/tasksRepo.js';
import type { LoginEnterprise } from '../enterprises.js';
import { deleteLoginTask } from '../tasks/delete.js';
import { loginQueue } from '../tasks/queue.js';
import { retryTask } from '../tasks/retry.js';
import { requestEnterprise } from './requestEnterprise.js';

type PerformOperation = (action: string, item: OperationItem) => Promise<OperationItem>;

const FINISHED = ['success', 'failed', 'cancelled'];

/** Operation previews live in memory per router, so each enterprise gets its own (and its own ids). */
const routers = new WeakMap<LoginEnterprise, Router>();

/** `/tasks/operations` of the request's enterprise; mounted behind `requireEnterprise`. */
export function createTaskOperationsHandler(): RequestHandler {
  return (req, res, next) => {
    operationsRouterFor(requestEnterprise(res))(req, res, next);
  };
}

function operationsRouterFor(enterprise: LoginEnterprise): Router {
  let router = routers.get(enterprise);
  if (!router) {
    router = createTaskOperationsRouter(enterprise);
    routers.set(enterprise, router);
  }
  return router;
}

function createTaskOperationsRouter(enterprise: LoginEnterprise): Router {
  const enterpriseId = enterprise.id;
  return operationRoutes({
    scope: 'tasks',
    actions: ['retry', 'cancel', 'delete'],
    resolve: (selection) => withSqliteReadSnapshot(getDb(), (database) => resolveOperationSelection(
      selection,
      async (query) => listTasksPage(enterpriseId, query, database),
      (task) => task.id,
    )),
    async snapshot(id) {
      const task = getTask(enterpriseId, id);
      return {
        revision: task?.oauthAttemptId ?? 'legacy',
        label: task ? `${task.identity} / ${task.ssoUser}` : id,
        requiresPasswordOverride: task?.ssoType === 'azure',
      };
    },
    async dedupeKey(action, id) { return action === 'retry' ? getTask(enterpriseId, id)?.identity : undefined; },
    eligibility: async (action, id) => ineligibility(enterprise, action, id),
    prepareExecution: (input) => prepareExecution(enterprise, input),
    async refresh(item, action) {
      const attempt = listAttempts(enterpriseId, item.id).find((entry) => entry.id === item.attemptId);
      if (!attempt) return { ...item, status: 'interrupted', detail: 'Attempt history is no longer available.' };
      if (action === 'cancel' && attempt.status === 'success') {
        return { ...item, status: 'skipped', detail: 'Authorization already completed and was not rolled back.' };
      }
      if (attempt.status === 'pending' || attempt.status === 'running' || attempt.status === 'cancelling') {
        return { ...item, status: 'running', detail: attempt.stage ?? attempt.status };
      }
      return { ...item, status: attempt.status, detail: attempt.failureReason ?? attempt.status };
    },
  });
}

/** Why the task cannot take the action now, or undefined when it can. */
function ineligibility(enterprise: LoginEnterprise, action: string, id: string): string | undefined {
  const task = getTask(enterprise.id, id);
  if (!task) return 'The task was removed.';
  if (action === 'retry' && task.status !== 'failed') return 'Only failed tasks can be retried.';
  if (action === 'retry' && loginQueue.isBusy(id)) {
    return 'The previous attempt is still finishing. Wait for its queue slot to be released.';
  }
  if (action === 'retry' && hasActiveTask(task.identity)) return 'This account already has an active login attempt.';
  if (action === 'cancel' && FINISHED.includes(task.status)) return 'The task is already finished.';
  if (action === 'delete' && !FINISHED.includes(task.status)) return 'Active tasks cannot be deleted.';
  return undefined;
}

function prepareExecution(enterprise: LoginEnterprise, input: Record<string, unknown>): PerformOperation {
  const overrides = readPasswordOverrides(input.overrides);
  return async (action, item) => {
    if (action === 'delete') return deleteItem(enterprise, item);
    if (action === 'cancel') {
      const task = loginQueue.cancel(enterprise.id, item.id);
      const status = task?.status === 'cancelled' ? 'cancelled' : 'running';
      return { ...item, status, attemptId: task?.oauthAttemptId };
    }
    const password = overrides.get(item.id);
    overrides.delete(item.id);
    const credentials: LoginCredentials = password
      ? { credentialMode: 'override', ssoPassword: password }
      : { credentialMode: 'default' };
    const task = await retryTask(enterprise, item.id, credentials);
    return { ...item, status: 'running', attemptId: task.oauthAttemptId, detail: 'Waiting for login completion.' };
  };
}

async function deleteItem(enterprise: LoginEnterprise, item: OperationItem): Promise<OperationItem> {
  const result = await deleteLoginTask(enterprise.id, item.id);
  if (result !== 'deleted') return { ...item, status: 'skipped', detail: result };
  return { ...item, status: 'success', detail: 'Task and attempt records deleted.' };
}

function readPasswordOverrides(input: unknown): Map<string, string> {
  const overrides = new Map<string, string>();
  if (input === undefined) return overrides;
  if (!Array.isArray(input) || input.length > 1000) {
    throw new HttpApiError(400, 'invalid_overrides', 'Invalid password overrides.');
  }
  for (const row of input) {
    if (!isPasswordOverride(row)) {
      throw new HttpApiError(400, 'invalid_overrides', 'Each override needs a task ID and a nonempty password.');
    }
    overrides.set(row.id, row.password);
  }
  return overrides;
}

function isPasswordOverride(row: unknown): row is { id: string; password: string } {
  if (!row || typeof row !== 'object') return false;
  const { id, password } = row as Record<string, unknown>;
  return typeof id === 'string' && typeof password === 'string' && password.length > 0;
}
