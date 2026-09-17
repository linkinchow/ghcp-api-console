import type { RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { SqliteStorage } from '../db/sqliteStorage.js';
import { Logger } from '../logger.js';
import { normalizeCaller, readPoolConfig, UserPoolError, type PoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { PrewarmWorker, type PrewarmWorkerSnapshot } from './worker.js';
import type { HeldLease } from './store.js';
import type { PoolStore } from './storage.js';
import { boundedAdmission } from './admission.js';
import { isMysqlStorageUnavailable } from './mysqlDeadline.js';
import { readInferenceTimeoutMs } from './inferenceTimeout.js';

export interface PoolRequest {
  held: HeldLease;
  store: PoolStore;
  options: PoolConfig;
  controller: AbortController;
  completed: boolean;
  operationActive: boolean;
  upstreamComplete?: boolean;
  finish?: (success: boolean) => Promise<void>;
}

let store: PoolStore | undefined;
let worker: PrewarmWorker | undefined;
let options: PoolConfig | undefined;
let inferenceTimeoutMs: number | undefined;
let wakeTimer: ReturnType<typeof setTimeout> | undefined;
const logger = new Logger('user-pool');

export async function getUserPool(): Promise<PoolStore | undefined> {
  if (!options) {
    const parsed = readPoolConfig(process.env);
    inferenceTimeoutMs = readInferenceTimeoutMs(process.env, parsed.enabled);
    options = parsed;
  }
  if (!options.enabled) return undefined;
  await initializeStorage();
  const storage = getStorage();
  store ??= await storage.userPool(options);
  return store;
}

export async function startUserPool(): Promise<void> {
  const current = await getUserPool();
  if (current && !worker) {
    if (!config.apiKey || !config.internalApiToken) throw new Error('User pool requires Proxy API and internal service authentication');
    worker = new PrewarmWorker(current, realProvisioner(current, options!), options!.pollMs, options!.prewarmConcurrency, undefined,
      { multiReplica: !(getStorage() instanceof SqliteStorage) });
    logger.info('timeouts', 'Pool request budgets', {
      inferenceTimeoutMs: inferenceTimeoutMs ?? options!.requestTimeoutMs,
      catalogAndProvisionTimeoutMs: options!.requestTimeoutMs,
    });
    await worker.start();
  }
}

export async function stopUserPool(): Promise<void> {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = undefined;
  await worker?.stop();
  worker = undefined;
  store = undefined;
  options = undefined;
  inferenceTimeoutMs = undefined;
}

/** No initialization or storage access. Undefined means no worker in THIS process,
 * not that the cluster has no scheduler, nor that routing/storage is unhealthy. */
export function getLocalUserPoolSchedulerSnapshot(): PrewarmWorkerSnapshot | undefined {
  return worker?.snapshot();
}

export function assertUserPoolOwner(): void {
  if (worker && getStorage() instanceof SqliteStorage && !worker.isActive()) throw new UserPoolError(503, 'pool_owner_unavailable');
}

export function wakePool(): void {
  if (!worker || wakeTimer) return;
  const tick = () => { void worker?.tick().catch(() => logger.error('wake-failed', 'Pool worker could not reconcile')); };
  if (getStorage() instanceof SqliteStorage) return tick();
  wakeTimer = setTimeout(() => { wakeTimer = undefined; tick(); }, Math.min(options?.pollMs ?? 1000, 1000));
  wakeTimer.unref();
}

export function poolRequest(res: Response): PoolRequest | undefined {
  return res.locals?.userPool as PoolRequest | undefined;
}

export function statIdentity(res: Response, fallback: string): { identity: string; callerId?: string; leaseId?: string } {
  const context = poolRequest(res);
  return context
    ? { identity: context.held.member_identity, callerId: context.held.caller_id, leaseId: context.held.lease_id }
    : { identity: fallback };
}

export async function withPoolOperation(res: Response, operation: () => Promise<void>): Promise<void> {
  const context = poolRequest(res);
  if (context) context.operationActive = true;
  try {
    await operation();
  } finally {
    if (context) {
      context.operationActive = false;
      if (res.destroyed || res.writableFinished) await context.finish?.(res.locals.poolSuccess === true && res.writableFinished);
    }
  }
}

export const routeUserPool: RequestHandler = async (req, res, next) => {
  try {
    const current = await getUserPool();
    if (!current) return next();
    assertUserPoolOwner();
    const path = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    const supported = ['GET', 'HEAD'].includes(req.method) && path === '/v1/models'
      || req.method === 'POST' && ['/v1/messages', '/chat/completions', '/responses', '/v1/messages/count_tokens'].includes(path);
    if (!supported) return next();
    const caller = normalizeCaller(req.identity ?? '');
    if (req.method === 'POST' && (!req.body || Array.isArray(req.body) || typeof req.body.model !== 'string' || !req.body.model.trim())) {
      throw new UserPoolError(400, 'invalid_model');
    }
    const isInference = req.method === 'POST' && path !== '/v1/messages/count_tokens';
    const requestTimeoutMs = isInference ? inferenceTimeoutMs ?? options!.requestTimeoutMs : options!.requestTimeoutMs;
    const admittedAt = performance.now();
    const admission = new AbortController();
    const admissionTimeout = setTimeout(() => admission.abort(), requestTimeoutMs);
    admissionTimeout.unref();
    const disconnect = () => admission.abort();
    res.once('close', disconnect);
    let held: HeldLease;
    try {
      held = await boundedAdmission(() => isInference
        ? current.acquire(caller, admission.signal, inferenceTimeoutMs) : current.acquireCatalog(caller, admission.signal), admission.signal,
      async late => {
        try { await current.finish(late, false); }
        catch { logger.error('request-finish-failed', 'Late admission cleanup failed; its bounded hold will expire'); }
      });
    } finally {
      clearTimeout(admissionTimeout);
      res.off('close', disconnect);
    }
    if (res.destroyed || req.aborted) {
      try { await current.finish(held, false); } catch { logger.error('request-finish-failed', 'Disconnected admission cleanup failed'); }
      return;
    }
    const context: PoolRequest = {
      held, store: current, options: options!, controller: new AbortController(), completed: false, operationActive: false,
    };
    res.locals.userPool = context;
    req.identity = held.member_identity;
    const canRenew = isInference;
    let responseSucceeded = false;
    let finishing: Promise<void> | undefined;
    const finish = (success: boolean): Promise<void> => {
      responseSucceeded ||= success && canRenew && res.statusCode >= 200 && res.statusCode < 300;
      if (finishing) return finishing;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      context.controller.abort();
      // A disconnected upstream may still be draining; unrelated post-response
      // statistics must not hold up an already completed inference's renewal.
      if (context.operationActive && !context.upstreamComplete) return Promise.resolve();
      context.completed = true;
      finishing = (async () => {
        try {
          await current.finish(context.held, responseSucceeded);
          await current.event('request_finished', context.held.member_identity, caller, context.held.lease_id, responseSucceeded ? 'success' : 'not_renewed');
        } catch {
          logger.error('request-finish-failed', 'Pool request cleanup failed; its bounded hold will expire');
        } finally {
          wakePool();
        }
      })();
      return finishing;
    };
    context.finish = finish;
    const timeout = setTimeout(() => {
      context.controller.abort(new Error('Pool request deadline exceeded'));
      if (!res.headersSent) {
        res.status(504).json({ type: 'error', error: { type: 'api_error', code: 'pool_request_timeout', message: 'Upstream request timed out.' } });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }, Math.max(1, requestTimeoutMs - (performance.now() - admittedAt)));
    let checking = false;
    const heartbeat = setInterval(() => {
      if (checking || context.completed) return;
      checking = true;
      void (async () => {
        try {
          assertUserPoolOwner();
          if (!await current.heartbeat(context.held)) throw new Error('Pool request hold expired or was fenced');
        } catch {
          if (!context.completed) {
            context.controller.abort(new Error('Pool hold could not be verified'));
            res.destroy();
          }
        } finally { checking = false; }
      })();
    }, 5000);
    timeout.unref();
    heartbeat.unref();
    res.once('finish', () => { void finish(res.locals.poolSuccess === true); });
    res.once('close', () => {
      context.controller.abort();
      void finish(false);
    });
    wakePool();
    next();
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (isMysqlStorageUnavailable(error)) error = new UserPoolError(503, 'pool_storage_unavailable', 1);
    if (error instanceof UserPoolError) {
      if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      res.status(error.status).json({ type: 'error', error: {
        type: error.status === 429 ? 'rate_limit_error' : error.status === 400 ? 'invalid_request_error' : 'api_error',
        code: error.code, message: error.message,
      } });
    } else {
      next(error);
    }
  }
};
