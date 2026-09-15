import { performance } from 'node:perf_hooks';
import type { Pool, PoolConnection } from 'mysql2/promise';

/** Local SQL budget, deliberately separate from persisted pool configuration. */
export const MYSQL_POOL_DEADLINE_MS = 5000;

export class MysqlDeadlineError extends Error {
  readonly code = 'POOL_SQL_TIMEOUT';
  constructor(readonly operation: string) {
    super(`User pool MySQL deadline exceeded during ${operation}`);
    this.name = 'MysqlDeadlineError';
  }
}

export class MysqlConnectionError extends Error {
  readonly code = 'POOL_SQL_UNAVAILABLE';
  constructor(cause: unknown) {
    super('User pool MySQL storage is unavailable', { cause });
    this.name = 'MysqlConnectionError';
  }
}

export function isMysqlStorageUnavailable(error: unknown): error is MysqlConnectionError | MysqlDeadlineError {
  return error instanceof MysqlConnectionError || error instanceof MysqlDeadlineError;
}

// Classify only failures from actual MySQL driver calls, never arbitrary application
// or upstream errors. SQL/schema/constraint and lock errors retain their identity.
const connectionErrorCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR', 'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'ER_CON_COUNT_ERROR', 'ER_SERVER_SHUTDOWN',
]);

async function mysqlDriverCall<T>(start: () => Promise<T>, destroy: () => void = () => {}, acquisition = false): Promise<T> {
  try { return await start(); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    // mysql2's finite queue fails with a plain Error, but only getConnection has
    // this contract. Never reclassify matching SQL/application error messages.
    const queueFull = acquisition && error instanceof Error && error.message === 'Queue limit reached.';
    if (!queueFull && (typeof code !== 'string' || !connectionErrorCodes.has(code))) throw error;
    // Do not return an errored socket to the pool, even if driver cleanup throws.
    try { destroy(); } catch { /* Preserve the original driver failure as the cause. */ }
    throw new MysqlConnectionError(error);
  }
}

/** One monotonic budget shared by acquisition, statements, commit/rollback and retries. */
export class MysqlDeadline {
  private readonly expiresAt: number;

  constructor(timeoutMs = MYSQL_POOL_DEADLINE_MS, maxMs = MYSQL_POOL_DEADLINE_MS) {
    const cap = Number.isFinite(maxMs) ? Math.min(60000, Math.max(0, maxMs)) : MYSQL_POOL_DEADLINE_MS;
    this.expiresAt = performance.now() + Math.max(0, Math.min(
      Number.isFinite(timeoutMs) ? timeoutMs : MYSQL_POOL_DEADLINE_MS, cap));
  }

  run<T>(operation: string, start: () => Promise<T>, cancel: () => void = () => {},
    lateResult: (value: T) => void = () => {}, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
      };
      const stop = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Cancellation must close the socket BEFORE callers can observe timeout.
        try { cancel(); } catch { /* Preserve the original error if a driver is already closed. */ }
        reject(error);
      };
      const expire = () => stop(new MysqlDeadlineError(operation));
      const aborted = () => stop(signal!.reason);
      const remaining = this.expiresAt - performance.now();
      if (signal?.aborted) { aborted(); return; }
      if (remaining <= 0) { expire(); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(expire, Math.ceil(remaining));
      let pending: Promise<T>;
      try { pending = start(); }
      catch (error) { settled = true; cleanup(); reject(error); return; }
      // Observe late rejection as well as fulfillment; never orphan a driver promise.
      Promise.resolve(pending).then((value) => {
        if (!settled && performance.now() >= this.expiresAt) expire();
        if (settled) {
          try { lateResult(value); } catch { /* Best-effort disposal of an unused result. */ }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      }, (error: unknown) => {
        if (!settled && performance.now() >= this.expiresAt) expire();
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }
}

export interface MysqlConnectionLease {
  connection: PoolConnection;
  readonly destroyed: boolean;
  destroy(): void;
  release(): void;
}

/** Never wrap/destroy the Pool itself: all remote work owns an actual leased socket. */
export async function leaseMysqlConnection(pool: Pick<Pool, 'getConnection'>,
  deadline: MysqlDeadline, signal?: AbortSignal, retain?: () => () => void): Promise<MysqlConnectionLease> {
  let releasePending = () => {};
  const dispose = (late: PoolConnection) => {
    try { late.release(); } catch { late.destroy(); }
    finally { releasePending(); }
  };
  const raw = await deadline.run('getConnection', () => {
    // Retain the caller gate while mysql2 still holds its uncancelable queue entry.
    // A timeout rejects promptly, but must not let the next same-caller ticket in.
    releasePending = retain?.() ?? (() => {});
    return mysqlDriverCall(() => pool.getConnection(), undefined, true).catch(error => {
      releasePending();
      throw error;
    });
  }, undefined, dispose, signal);
  // Abort can race the deadline promise's fulfillment and this continuation.
  if (signal?.aborted) { dispose(raw); signal.throwIfAborted(); }
  releasePending();
  let destroyed = false;
  let released = false;
  const destroy = () => {
    if (destroyed || released) return;
    destroyed = true;
    raw.destroy();
  };
  const release = () => {
    if (destroyed || released) return;
    try { raw.release(); released = true; }
    catch (error) {
      try { destroy(); } catch { /* Preserve release failure after best-effort socket disposal. */ }
      throw error;
    }
  };
  const remoteMethods = new Set(['query', 'execute', 'beginTransaction', 'commit', 'rollback']);
  const connection = new Proxy(raw, {
    get(target, property) {
      if (property === 'destroy') return destroy;
      if (property === 'release') return release;
      const value = Reflect.get(target, property, target);
      if (typeof property === 'string' && remoteMethods.has(property)) {
        return (...args: unknown[]) => {
          if (destroyed || released) return Promise.reject(new Error('User pool MySQL connection is closed'));
          return deadline.run(property, () => mysqlDriverCall(async () => Reflect.apply(value, target, args), destroy), destroy);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { connection, get destroyed() { return destroyed; }, destroy, release };
}
