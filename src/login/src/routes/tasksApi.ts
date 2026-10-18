import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  apiError,
  csvExport,
  HttpApiError,
  readLoginCredentials,
  readManagementQuery,
  withSqliteReadSnapshot,
  type EnterpriseId,
  type LoginAttemptDto,
} from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import {
  getTask,
  getTaskByAttempt,
  listAttempts,
  listTasks,
  listTasksPage,
  summarizeTasks,
  type LoginTaskRecord,
} from '../db/tasksRepo.js';
import { readyLoginEnterprise, resolveSsoType, type LoginEnterprise } from '../enterprises.js';
import { deleteLoginTask } from '../tasks/delete.js';
import { loginQueue } from '../tasks/queue.js';
import { retryTask } from '../tasks/retry.js';
import type { LoginTaskRequest } from '../tasks/runner.js';
import { resolveAttemptLog } from '../tasks/taskLogs.js';
import { requestEnterprise } from './requestEnterprise.js';

/** The enterprise profile alone decides the SSO page and selectors; a request may never set them (design §5.7). */
const FORBIDDEN_OVERRIDES = ['ssoUrl', 'ssoLoginUrl', 'allowedLoginUrls', 'selectors', 'selectorOverrides'];
const LOG_PREVIEW_BYTES = 20_000;
const EXPORT_COLUMNS = [
  'id', 'identity', 'ssoUser', 'ghLogin', 'status', 'stage', 'attempts', 'failure', 'createdAt', 'startedAt',
  'finishedAt',
];

/** Login tasks of one enterprise; mounted behind `requireEnterprise` under `/api/enterprises/:enterpriseId`. */
export function createTasksApiRouter(): Router {
  const router = Router();
  router.get('/tasks/summary', (_req, res) => res.json(summarizeTasks(enterpriseIdOf(res))));
  router.get('/queue', (_req, res) => res.json(loginQueue.snapshot(enterpriseIdOf(res))));
  router.get('/tasks/by-attempt/:attemptId', getByAttempt);
  router.route('/tasks/export').get(exportTasks).post(exportTasks);
  router.get('/tasks/:id/attempts/:attemptId/log', getAttemptLog);
  router.get('/tasks/:id/attempts', listTaskAttempts);
  router.get('/tasks', listTaskPage);
  router.post('/tasks', createTask);
  router.get('/tasks/:id', getOneTask);
  router.post('/tasks/:id/cancel', cancelTask);
  router.delete('/tasks/:id', deleteOneTask);
  router.post('/tasks/:id/retry', retryOneTask);
  return router;
}

function enterpriseIdOf(res: Response): EnterpriseId {
  return requestEnterprise(res).id;
}

function taskNotFound(res: Response): void {
  res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
}

function getByAttempt(req: Request<{ attemptId: string }>, res: Response): void {
  const task = getTaskByAttempt(enterpriseIdOf(res), req.params.attemptId);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'No task was accepted for this authorization attempt.'));
    return;
  }
  res.json(task);
}

async function exportTasks(req: Request, res: Response, next: NextFunction): Promise<void> {
  await tasksExport(enterpriseIdOf(res))(req, res, next);
}

function tasksExport(enterpriseId: EnterpriseId): RequestHandler {
  return csvExport(
    'login-tasks',
    EXPORT_COLUMNS,
    async (query) => listTasksPage(enterpriseId, query),
    exportValues,
    (_query, consume) => withSqliteReadSnapshot(getDb(), (database) => consume(
      async (query) => listTasksPage(enterpriseId, query, database),
    )),
  );
}

function exportValues(task: LoginTaskRecord): unknown[] {
  return [
    task.id, task.identity, task.ssoUser, task.ghLogin, task.status, task.stage, task.attempts, task.failureReason,
    task.createdAt, task.startedAt, task.finishedAt,
  ];
}

async function getAttemptLog(req: Request<{ id: string; attemptId: string }>, res: Response): Promise<void> {
  const attempt = listAttempts(enterpriseIdOf(res), req.params.id).find((entry) => entry.id === req.params.attemptId);
  if (!attempt?.logPath || attempt.historyIncomplete) {
    res.status(404).json(apiError('log_unavailable', 'An isolated log is not available for this attempt.'));
    return;
  }
  try {
    const file = await resolveAttemptLog(attempt);
    if (!file) throw new HttpApiError(404, 'log_unavailable', 'This log has been removed.');
    res.setHeader('Cache-Control', 'no-store');
    if (req.query.download === '1') await sendLogFile(res, attempt, file);
    else res.json(await readLogPreview(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    res.status(404).json(apiError('log_unavailable', 'This log has been removed.'));
  }
}

async function sendLogFile(res: Response, attempt: LoginAttemptDto, file: string): Promise<void> {
  res.type('text/plain').attachment(`login-${attempt.id}.log`);
  await pipeline(createReadStream(file), res);
}

async function readLogPreview(file: string): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(file, 'r');
  try {
    const bytes = Buffer.alloc(LOG_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, Math.min(bytesRead, LOG_PREVIEW_BYTES)).toString('utf8');
    return { content, truncated: bytesRead > LOG_PREVIEW_BYTES };
  } finally {
    await handle.close();
  }
}

function listTaskAttempts(req: Request<{ id: string }>, res: Response): void {
  const enterpriseId = enterpriseIdOf(res);
  if (!getTask(enterpriseId, req.params.id)) {
    taskNotFound(res);
    return;
  }
  res.json(listAttempts(enterpriseId, req.params.id).map(({ logPath: _logPath, ...attempt }) => attempt));
}

function listTaskPage(req: Request, res: Response): void {
  const enterpriseId = enterpriseIdOf(res);
  if (Object.keys(req.query).some((key) => key !== 'limit')) {
    res.json(listTasksPage(enterpriseId, readManagementQuery(req.query)));
    return;
  }
  const limit = Number(req.query.limit ?? 100);
  res.json(listTasks(enterpriseId, Number.isInteger(limit) && limit > 0 ? limit : 100));
}

function createTask(req: Request, res: Response): void {
  const enterprise = requestEnterprise(res);
  const request = readCreateTask(req.body, enterprise);
  readyLoginEnterprise(enterprise);
  res.status(202).json(loginQueue.enqueue(enterprise.id, request));
}

function getOneTask(req: Request<{ id: string }>, res: Response): void {
  const task = getTask(enterpriseIdOf(res), req.params.id);
  if (!task) {
    taskNotFound(res);
    return;
  }
  res.json(task);
}

function cancelTask(req: Request<{ id: string }>, res: Response): void {
  const task = loginQueue.cancel(enterpriseIdOf(res), req.params.id);
  if (!task) {
    taskNotFound(res);
    return;
  }
  res.status(task.status === 'cancelling' ? 202 : 200).json(task);
}

async function deleteOneTask(req: Request<{ id: string }>, res: Response): Promise<void> {
  let result: Awaited<ReturnType<typeof deleteLoginTask>>;
  try {
    result = await deleteLoginTask(enterpriseIdOf(res), req.params.id);
  } catch (err) {
    if (!(err instanceof HttpApiError)) throw err;
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  if (result === 'not_found') {
    taskNotFound(res);
    return;
  }
  if (result === 'not_allowed') {
    res.status(400).json(apiError('task_delete_not_allowed', 'Pending or running login tasks cannot be deleted.'));
    return;
  }
  res.status(204).end();
}

/** The task keeps its enterprise; scope or SSO page fields in the body are refused, not applied. */
async function retryOneTask(req: Request<{ id: string }>, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  if (!getTask(enterprise.id, req.params.id)) {
    taskNotFound(res);
    return;
  }
  try {
    const body = readBody(req.body);
    assertNoOverrides(body);
    res.status(202).json(await retryTask(enterprise, req.params.id, readLoginCredentials(body)));
  } catch (err) {
    const code = err instanceof HttpApiError ? err.code : 'retry_failed';
    const message = err instanceof Error ? err.message : String(err);
    res.status(err instanceof HttpApiError ? err.status : 502).json(apiError(code, message));
  }
}

/** `{ identity, ssoUser, ghLogin, oauthAttemptId, ssoType? }` plus the password Proxy resolved (design §5.7). */
function readCreateTask(input: unknown, enterprise: LoginEnterprise): LoginTaskRequest {
  const body = readBody(input);
  assertNoOverrides(body);
  const oauthAttemptId = requiredText(body, 'oauthAttemptId', 'start a new reauthorization for legacy tasks');
  return {
    identity: requiredText(body, 'identity'),
    ssoUser: requiredText(body, 'ssoUser'),
    ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : '',
    ghLogin: requiredText(body, 'ghLogin'),
    oauthAttemptId,
    ssoType: resolveSsoType(enterprise, body.ssoType),
  };
}

function assertNoOverrides(body: Record<string, unknown>): void {
  const field = FORBIDDEN_OVERRIDES.find((key) => body[key] !== undefined);
  if (field === undefined) return;
  const message = `${field} cannot be set per task; the enterprise registry decides the SSO login page and selectors.`;
  throw new HttpApiError(400, 'task_override_forbidden', message);
}

function requiredText(body: Record<string, unknown>, field: string, hint?: string): string {
  const value = body[field];
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new HttpApiError(400, 'invalid_login_task', `${field} is required${hint ? `; ${hint}` : ''}.`);
}

function readBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}
