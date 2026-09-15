// Independent process: only IPC fixture barriers; no production server/debug endpoints.
import assert from 'node:assert/strict';
import { createPool } from 'mysql2/promise';
import { optedIn, options, validateMockOrigin, type WorkerMessage } from './worker-common.js';

const send = (message: Omit<WorkerMessage, 'pid'>) => process.send?.({ ...message, pid: process.pid });
let closing = false;
// Install before imports/migrations; even initialization must not outlive its parent.
process.on('disconnect', () => { if (!closing) process.exit(2); });
const lifetime = setTimeout(() => process.exit(3), 120000);
lifetime.unref();
try {
  assert.equal(process.argv.length, 2, 'No child command-line arguments accepted');
  assert.ok(process.send, 'Child must be launched with IPC');
  const url = optedIn(process.env);
  assert.ok(url, 'Explicit process-test opt-in required');
  assert.match(process.env.WORKER_TEST_DATABASE ?? '', /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname, `/${process.env.WORKER_TEST_DATABASE}`);
  const mockOrigin = validateMockOrigin(process.env.WORKER_MOCK_ORIGIN ?? '');
  for (const key of ['SSO_BASE_URL', 'LOGIN_BASE_URL', 'COPILOT_API_BASE_URL']) assert.equal(process.env[key], mockOrigin);
  assert.equal(process.env.DOTENV_CONFIG_PATH, process.platform === 'win32' ? 'NUL' : '/dev/null');
  // Environment isolation happens in the parent BEFORE any production import (dotenv/config).
  const [{ MysqlStorage }, { PrewarmWorker }, { realProvisioner }] = await Promise.all([
    import('../../src/proxy/src/db/mysqlStorage.js'),
    import('../../src/proxy/src/userPool/worker.js'),
    import('../../src/proxy/src/userPool/provisioner.js'),
  ]);
  const pool = createPool({ uri: url.toString(), connectionLimit: 4, connectTimeout: 5000,
    timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const storage = new MysqlStorage(pool, 2);
  const store = await storage.userPool(options);
  const claimOwner = store.claimOwner.bind(store);
  store.claimOwner = async owner => {
    const claimed = await claimOwner(owner);
    send({ kind: claimed ? 'claim' : 'standby', owner, dbNow: await store.now() });
    return claimed;
  };
  if (process.env.WORKER_HOLD_CHECKPOINT === '1') {
    const update = store.update.bind(store);
    let held = false;
    store.update = async (identity, patch, fence, owner) => {
      if (!held && patch.stage === 'oauth-wait' && patch.task_id && typeof fence === 'object' && fence.stage === 'oauth-dispatch') {
        held = true;
        const saved = await store.inventory(identity);
        assert.ok(saved);
        send({ kind: 'checkpoint-held', identity, owner, nonce: saved.oauth_attempt_id,
          taskId: patch.task_id, attempt: saved.attempt_id, generation: saved.generation });
        // No SQL lock, no fake DB, no lease changes. Kill terminates this actual
        // unresolved checkpoint; it can never resume in the successor's address space.
        await new Promise<never>(() => {});
      }
      return update(identity, patch, fence, owner);
    };
  }
  // Real HTTP, real credential mutation, real model resolver and warmup. Only the
  // account read is wired explicitly to THIS MySQL pool, not the global connection.
  const adapter = realProvisioner(store, options, { getAccount: storage.getAccount.bind(storage) });
  const reconcile = adapter.reconcileLoginReservation!;
  adapter.reconcileLoginReservation = async (row, context) => {
    try { return await reconcile(row, context); }
    finally {
      // Read-only evidence that a particular retained-generation observation drained.
      send({ kind: 'observation-finished', identity: row.identity, generation: row.generation });
    }
  };
  const worker = new PrewarmWorker(store, adapter, options.pollMs, 1, undefined, { multiReplica: true });
  send({ kind: 'boot' });
  process.on('message', message => {
    const kind = (message as { kind?: string })?.kind;
    if (kind === 'status') send({ kind: 'status', active: worker.isActive() });
    if (kind === 'stop' && !closing) {
      closing = true;
      void (async () => {
        await worker.stop();
        await storage.close();
        send({ kind: 'stopped' });
        process.disconnect?.();
      })().catch(() => process.exit(1));
    }
  });
  await worker.start();
  send({ kind: 'started', active: worker.isActive() });
} catch {
  // Do not serialize MySQL errors/URLs/credentials to stdout or IPC.
  send({ kind: 'fatal' });
  process.exit(1);
}
