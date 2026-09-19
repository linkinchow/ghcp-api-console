import { Router, type Response } from 'express';
import { requireEnterpriseRequest, bindingFromInput } from '../enterprise.js';
import { apiError, EnterpriseContractError, type CreateLoginTaskV2, type LoginTaskStatus, type EnterpriseScope } from '@ghcp/shared';
import { deleteTask, getTask, isTerminalTask, listTasks, listTasksPage } from '../db/tasksRepo.js';
import { getPoolTaskProtection } from '../clients/proxyClient.js';
import { loginQueue, type LoginQueue } from '../tasks/queue.js';

const STATUSES = new Set<LoginTaskStatus>(['pending','running','success','failed','cancelled','callback_pending','cancel_requested','uncertain']);
const CREATE_KEYS = new Set(['enterpriseId','enterpriseRevision','identity','accountIncarnation','oauthAttemptId','expectedGhLogin','expectedGithubUserId','ssoUser','ssoPassword','ssoType']);
const enterprise = (res: Response): string => (res.locals.enterpriseScope as EnterpriseScope).enterpriseId;
export function createTasksApiRouter(queue: LoginQueue = loginQueue): Router {
  const router = Router({mergeParams:true});
  router.use(requireEnterpriseRequest);
  router.get('/tasks',(req,res) => {
    const id = enterprise(res);
    if (['page','pageSize','q','status'].some(key => req.query[key] !== undefined)) {
      const status = stringQuery(req.query.status);
      if (status && !STATUSES.has(status as LoginTaskStatus)) { res.status(400).json(apiError('invalid_status','Invalid login task status.')); return; }
      res.json(listTasksPage(id,{q:stringQuery(req.query.q),status:status as LoginTaskStatus | undefined,page:numberQuery(req.query.page),pageSize:numberQuery(req.query.pageSize)}));
    } else res.json(listTasks(id,numberQuery(req.query.limit) ?? 100));
  });
  router.post('/tasks',async (req,res) => {
    try {
      const value = readCreateTask(req.body);
      if (value.enterpriseId !== enterprise(res)) throw new EnterpriseContractError('enterprise_scope_mismatch');
      res.status(202).json(await queue.enqueue(value));
    } catch (error) { respondError(res,error); }
  });
  router.get('/tasks/:id',(req,res) => {
    const task = getTask(enterprise(res),req.params.id);
    if (!task) { missing(res); return; }
    res.json(task);
  });
  router.post('/tasks/:id/cancel',async (req,res) => {
    try {
      const result = await queue.cancel(enterprise(res),req.params.id);
      if (!result) { missing(res); return; }
      res.status(result.outcome === 'unknown' ? 202 : 200).json(result);
    } catch (error) { respondError(res,error); }
  });
  router.post('/tasks/:id/reconcile',async (req,res) => {
    try {
      const result = await queue.reconcile(enterprise(res),req.params.id);
      if (!result) { missing(res); return; }
      res.status(result.outcome === 'unknown' ? 202 : 200).json(result);
    } catch (error) { respondError(res,error); }
  });
  router.delete('/tasks/:id',async (req,res) => {
    const id = enterprise(res),task = getTask(id,req.params.id);
    if (!task) { missing(res); return; }
    if (!isTerminalTask(task)) { res.status(409).json(apiError('task_delete_not_allowed','Task closure is not confirmed.')); return; }
    try {
      const protection = await getPoolTaskProtection(task);
      if (protection.referenced) { res.status(409).json(apiError('pool_task_managed','Pool recovery still references this task.')); return; }
    } catch { res.status(503).json(apiError('pool_membership_unavailable','Cannot verify pool ownership; no task was changed.')); return; }
    const result = deleteTask(id,task.id);
    if (result === 'not_found') missing(res);
    else if (result !== 'deleted') res.status(409).json(apiError('task_delete_not_allowed','Task closure is not confirmed.'));
    else res.status(204).end();
  });
  router.post('/tasks/:id/retry',(req,res) => {
    if (!getTask(enterprise(res),req.params.id)) { missing(res); return; }
    try { queue.retry(enterprise(res),req.params.id); } catch (error) { respondError(res,error); }
  });
  return router;
}
export const tasksApiRouter = createTasksApiRouter();
function readCreateTask(body: unknown): CreateLoginTaskV2 {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new EnterpriseContractError('login_task_input_invalid');
  const value = body as Record<string,unknown>;
  if (Object.keys(value).some(key => !CREATE_KEYS.has(key)) || typeof value.ssoUser !== 'string' || !value.ssoUser.trim()
    || value.ssoUser !== value.ssoUser.trim() || value.ssoUser.length > 255 || /[\x00-\x1f\x7f]/u.test(value.ssoUser)
    || typeof value.ssoPassword !== 'string' || !value.ssoPassword || value.ssoPassword.length > 4096
    || (value.ssoType !== 'custom' && value.ssoType !== 'azure')) throw new EnterpriseContractError('login_task_input_invalid');
  return {...bindingFromInput(value),ssoUser:value.ssoUser,ssoPassword:value.ssoPassword,ssoType:value.ssoType};
}
function missing(res: Response): void { res.status(404).json(apiError('task_not_found','Login task was not found.')); }
function respondError(res: Response,error: unknown): void {
  if (error instanceof EnterpriseContractError) {
    const status = ['authorization_nonce_conflict','authorization_nonce_consumed','authorization_attempt_not_active','new_proxy_attempt_required','legacy_task_history_only','task_reconcile_not_allowed','authorization_binding_mismatch'].includes(error.code) ? 409 : 400;
    res.status(status).json(apiError(error.code,'Login task request was rejected.'));
  } else res.status(503).json(apiError('authorization_authority_unavailable','Proxy authority could not be confirmed.'));
}
function stringQuery(value: unknown): string | undefined { return typeof value === 'string' ? value.trim() || undefined : undefined; }
function numberQuery(value: unknown): number | undefined { const n = typeof value === 'string' ? Number(value) : NaN; return Number.isSafeInteger(n) && n > 0 ? n : undefined; }
