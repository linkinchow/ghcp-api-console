import assert from 'node:assert/strict';
import { deadline, gate } from './multihot-safety.js';

// Guards precede the reused child's production imports and all instrumentation.
gate(process.env);
const end = deadline(process.env);
assert.equal(process.env.REPLICAS_CHILD, '1');
assert.equal(process.env.REPLICAS_COUNT, '5');
assert.equal(process.argv.length, 2);
assert.ok(process.connected && process.send, 'REFUSED: parent IPC required');
// The inherited child also shuts down on IPC disconnect. This absolute watchdog
// supersedes its longer default lifetime without changing any production budget.
const lifetime = setTimeout(() => {
  process.emit('SIGTERM');
  setTimeout(() => process.exit(1), 5000).unref();
}, Math.max(1, end - Date.now()));
lifetime.unref();
await import('./replicas-child.js');
const [{ getStorage }, { mysqlCallerGateStats }] = await Promise.all([
  import('../../src/proxy/src/db/connection.js'), import('../../src/proxy/src/userPool/mysqlCallerGate.js'),
]);
type Native = {
  config: { connectionLimit: number; queueLimit: number; waitForConnections: boolean };
  _allConnections: { length: number }; _freeConnections: { length: number }; _connectionQueue: { length: number };
};
// TypeScript-private fields are read only here; no pool, store or budget is replaced.
const pool = (getStorage() as unknown as { pool: import('mysql2/promise').Pool & { pool: Native } }).pool;
const native = pool.pool;
const maximum = { nativeQueued: 0, connections: 0, active: 0, queued: 0, retainedTickets: 0 };
let samples = 0;
function snapshot() {
  const gate = mysqlCallerGateStats(pool);
  const current = { nativeQueued: native._connectionQueue.length, connections: native._allConnections.length,
    free: native._freeConnections.length, ...gate };
  for (const key of Object.keys(maximum) as Array<keyof typeof maximum>) maximum[key] = Math.max(maximum[key], current[key]);
  samples++;
  return { pid: process.pid, current, maximum: { ...maximum }, samples,
    connectionLimit: native.config.connectionLimit, queueLimit: native.config.queueLimit,
    waitForConnections: native.config.waitForConnections };
}
// Sample actual internals and immediately after every REAL driver acquisition is
// enqueued. Return the exact original promise; no result, timing, SQL or queue edit.
const acquire = pool.getConnection.bind(pool);
pool.getConnection = () => { const pending = acquire(); snapshot(); return pending; };
const sampling = setInterval(snapshot, 25); sampling.unref();
process.on('message', message => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'multihot-snapshot') {
    process.send?.({ type: 'multihot-snapshot', snapshot: snapshot() });
  }
});
process.send!({ type: 'multihot-instrumented', pid: process.pid, snapshot: snapshot() });
