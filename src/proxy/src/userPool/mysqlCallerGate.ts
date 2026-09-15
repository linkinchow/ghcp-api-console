import type { Pool } from 'mysql2/promise';
import { UserPoolError } from './config.js';
import type { MysqlDeadline } from './mysqlDeadline.js';

// Runtime safeguards, not persisted configuration or replica fingerprints.
export const MYSQL_CALLER_QUEUE_LIMIT = 32;
export const MYSQL_CALLER_TICKET_LIMIT = 1024;

interface Scope { active?: Ticket; waiters: Ticket[] }
interface Ticket { grant(): void; permit: MysqlCallerPermit }
export interface MysqlCallerPermit {
  release(): void;
  /** A driver-queued acquisition cannot be canceled; retain until its late socket is disposed. */
  retain(): () => void;
}
const pools = new WeakMap<object, Map<string, Scope>>();
let retainedTickets = 0;

function poolKey(pool: Pick<Pool, 'getConnection'>): object {
  return (pool as { pool?: object }).pool ?? pool;
}

/** One admission per caller and underlying mysql2 pool, shared by all store wrappers. */
export function acquireMysqlCaller(pool: Pick<Pool, 'getConnection'>, caller: string,
  deadline: MysqlDeadline, signal?: AbortSignal): Promise<MysqlCallerPermit> {
  let ticket: Ticket | undefined;
  return deadline.run('caller queue', () => {
    const key = poolKey(pool);
    let callers = pools.get(key);
    let scope = callers?.get(caller);
    if (retainedTickets >= MYSQL_CALLER_TICKET_LIMIT || (scope?.waiters.length ?? 0) >= MYSQL_CALLER_QUEUE_LIMIT) {
      throw new UserPoolError(503, 'pool_storage_unavailable', 1);
    }
    if (!callers) pools.set(key, callers = new Map());
    if (!scope) callers.set(caller, scope = { waiters: [] });
    const scopes = callers;
    const current = scope;
    retainedTickets++;
    return new Promise<MysqlCallerPermit>(resolve => {
      let references = 1;
      let released = false;
      const drop = () => {
        if (--references !== 0) return;
        retainedTickets--;
        if (current.active === ticket) {
          current.active = current.waiters.shift();
          current.active?.grant();
        } else {
          const index = current.waiters.indexOf(ticket!);
          if (index !== -1) current.waiters.splice(index, 1);
        }
        if (!current.active && current.waiters.length === 0) {
          scopes.delete(caller);
          if (scopes.size === 0) pools.delete(key);
        }
      };
      const permit: MysqlCallerPermit = {
        release() {
          if (released) return;
          released = true;
          drop();
        },
        retain() {
          if (released) throw new Error('User pool caller permit is released');
          references++;
          let done = false;
          return () => { if (!done) { done = true; drop(); } };
        },
      };
      ticket = { permit, grant: () => resolve(permit) };
      if (current.active) current.waiters.push(ticket);
      else { current.active = ticket; ticket.grant(); }
    });
  }, () => {
    ticket?.permit.release();
    // Settle the removed waiter too; the deadline's late-result path is idempotent.
    ticket?.grant();
  }, late => late.release(), signal);
}

/** Read-only diagnostics for focused tests; no registry of pool objects or callers escapes. */
export function mysqlCallerGateStats(pool: Pick<Pool, 'getConnection'>) {
  const callers = pools.get(poolKey(pool));
  let active = 0;
  let queued = 0;
  for (const scope of callers?.values() ?? []) {
    if (scope.active) active++;
    queued += scope.waiters.length;
  }
  return { retainedTickets, scopes: callers?.size ?? 0, active, queued };
}
