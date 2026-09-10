import type { RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { SqliteStorage } from '../db/sqliteStorage.js';
import { Logger } from '../logger.js';
import { normalizeCaller, readPoolConfig, UserPoolError, type PoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { PrewarmWorker } from './worker.js';
import type { HeldLease, UserPoolStore } from './store.js';

export interface PoolRequest {
  held: HeldLease;
  store: UserPoolStore;
  options: PoolConfig;
  controller: AbortController;
  completed: boolean;
  operationActive: boolean;
  finish?: (success: boolean) => void;
}

let store: UserPoolStore | undefined;
let worker: PrewarmWorker | undefined;
let options: PoolConfig | undefined;
const logger = new Logger('user-pool');

export async function getUserPool(): Promise<UserPoolStore | undefined> {
  options ??= readPoolConfig(process.env);
  if (!options.enabled) return undefined;
  await initializeStorage();
  const storage = getStorage();
  if (!(storage instanceof SqliteStorage)) throw new Error('User pool requires SQLite');
  store ??= storage.userPool(options);
  return store;
}

export async function startUserPool(): Promise<void> {
  const current = await getUserPool();
  if (current && !worker) {
    if (!config.apiKey || !config.internalApiToken) throw new Error('User pool requires Proxy API and internal service authentication');
    worker = new PrewarmWorker(current, realProvisioner(current, options!), options!.pollMs, options!.prewarmConcurrency);
    worker.start();
  }
}

export async function stopUserPool(): Promise<void> {
  await worker?.stop();
  worker = undefined;
  store = undefined;
  options = undefined;
}

export function assertUserPoolOwner(): void {
  if (worker && !worker.isActive()) throw new UserPoolError(503, 'pool_owner_unavailable');
}

export function wakePool(): void {
  void worker?.tick().catch(() => logger.error('wake-failed', 'Pool worker could not reconcile'));
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
      if (res.destroyed || res.writableFinished) context.finish?.(res.locals.poolSuccess === true && res.writableFinished);
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
    const held = req.method === 'GET' || req.method === 'HEAD' || path === '/v1/messages/count_tokens'
      ? current.acquireCatalog(caller) : current.acquire(caller);
    const context: PoolRequest = {
      held, store: current, options: options!, controller: new AbortController(), completed: false, operationActive: false,
    };
    res.locals.userPool = context;
    req.identity = held.member_identity;
    const canRenew = req.method === 'POST' && path !== '/v1/messages/count_tokens';
    let responseSucceeded = false;
    const finish = (success: boolean) => {
      responseSucceeded ||= success && canRenew && res.statusCode >= 200 && res.statusCode < 300;
      if (context.completed || context.operationActive) return;
      context.completed = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      context.controller.abort();
      try {
        current.finish(context.held, responseSucceeded);
        current.event('request_finished', context.held.member_identity, caller, context.held.lease_id, responseSucceeded ? 'success' : 'not_renewed');
      } catch {
        logger.error('request-finish-failed', 'Pool request cleanup failed; its bounded hold will expire');
      } finally {
        wakePool();
      }
    };
    context.finish = finish;
    const timeout = setTimeout(() => {
      context.controller.abort(new Error('Pool request deadline exceeded'));
      if (!res.headersSent) {
        res.status(504).json({ type: 'error', error: { type: 'api_error', code: 'pool_request_timeout', message: 'Upstream request timed out.' } });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }, Math.max(1, Math.min(options!.requestTimeoutMs, (held.deadline_at ?? current.now() + options!.requestTimeoutMs) - current.now())));
    const heartbeat = setInterval(() => {
      try {
        assertUserPoolOwner();
        if (!current.heartbeat(context.held)) throw new Error('Pool request hold expired or was fenced');
      } catch {
        context.controller.abort(new Error('Pool hold could not be renewed'));
        res.destroy();
      }
    }, 5000);
    timeout.unref();
    heartbeat.unref();
    res.once('finish', () => finish(res.locals.poolSuccess === true));
    res.once('close', () => {
      context.controller.abort();
      finish(false);
    });
    wakePool();
    next();
  } catch (error) {
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
