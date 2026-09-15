// Real Worker/Provisioner in its own process; no injected fetch, timer, store or scheduler.
import assert from 'node:assert/strict';
import { childGate, CHILD_MS, options, validateMockOrigin, type Proof } from './login-network-common.js';

const url = childGate(); // Must precede MySQL/production imports and process side effects.
const upstream = validateMockOrigin(process.env.LOGIN_NETWORK_UPSTREAM ?? '');
validateMockOrigin(process.env.LOGIN_BASE_URL ?? '');
for (const key of ['SSO_BASE_URL', 'COPILOT_API_BASE_URL']) assert.equal(process.env[key], upstream);
const send = (proof: Omit<Proof, 'pid'>) => process.send?.({ ...proof, pid: process.pid });
let closing = false;
process.on('disconnect', () => { if (!closing) process.exit(2); });
setTimeout(() => process.exit(3), CHILD_MS).unref();
try {
  const [{ createPool }, { MysqlStorage }, { PrewarmWorker }, { realProvisioner }] = await Promise.all([
    import('mysql2/promise'), import('../../src/proxy/src/db/mysqlStorage.js'),
    import('../../src/proxy/src/userPool/worker.js'), import('../../src/proxy/src/userPool/provisioner.js'),
  ]);
  const pool = createPool({ uri: url.toString(), connectionLimit: 4, queueLimit: 16, connectTimeout: 5000,
    timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const storage = new MysqlStorage(pool, 2);
  const store = await storage.userPool(options);
  // Bind only the account READ to this isolated DB; all mutation, HTTP and warmup is production code.
  const adapter = realProvisioner(store, options, { getAccount: storage.getAccount.bind(storage) });
  const observe = adapter.reconcileLoginReservation!;
  adapter.reconcileLoginReservation = async (row, context) => {
    const at = performance.now();
    send({ kind: 'observation-start', identity: row.identity, generation: row.generation, at });
    let reason = 'completed';
    try { return await observe(row, context); }
    catch (error) {
      reason = context.signal.aborted ? String((context.signal.reason as { code?: string })?.code ?? 'aborted')
        : error instanceof Error && error.name === 'TimeoutError' ? 'TimeoutError' : 'request-failed';
      throw error;
    } finally { send({ kind: 'observation-end', identity: row.identity, generation: row.generation,
      at: performance.now(), elapsedMs: performance.now() - at, reason }); }
  };
  const worker = new PrewarmWorker(store, adapter, options.pollMs, options.prewarmConcurrency, undefined, { multiReplica: true });
  process.on('message', (message: { kind?: string; id?: string }) => {
    if (message.kind === 'snapshot') send({ kind: 'snapshot', id: message.id, snapshot: { ...worker.snapshot() } });
    if (message.kind === 'stop' && !closing) {
      closing = true;
      void (async () => { await worker.stop(); await storage.close(); send({ kind: 'stopped' }); process.disconnect?.(); })()
        .catch(() => { send({ kind: 'fatal' }); process.exit(1); });
    }
  });
  await worker.start();
  send({ kind: 'started', snapshot: { ...worker.snapshot(), requestTimeoutMs: options.requestTimeoutMs } });
} catch { send({ kind: 'fatal' }); process.exit(1); }
