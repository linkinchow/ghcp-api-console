// Test-only barriers retain the ORIGINAL real worker checkpoint in its own process.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { options, OAUTH_TOKEN, validateMockOrigin } from './worker-common.js';
import { bounded, suspendGate, type SuspendMessage } from './suspend-common.js';
import type { ProvisionContext, ProvisionInventory } from '../../src/proxy/src/userPool/provisioner.js';

const send = (message: Omit<SuspendMessage, 'pid'>) => process.send?.({ ...message, pid: process.pid });
let closing = false;
process.on('disconnect', () => { if (!closing) process.exit(2); });
const lifetime = setTimeout(() => process.exit(3), 120000);
lifetime.unref();
try {
  assert.equal(process.argv.length, 2);
  assert.ok(process.send, 'IPC required');
  const url = suspendGate(process.env);
  assert.ok(url);
  const role = process.env.SUSPEND_ROLE;
  assert.ok(role === 'old' || role === 'successor');
  assert.match(process.env.WORKER_TEST_DATABASE ?? '', /^ghcp_pool_test_[a-f0-9]{32}$/);
  assert.equal(url.pathname, `/${process.env.WORKER_TEST_DATABASE}`);
  const origin = validateMockOrigin(process.env.WORKER_MOCK_ORIGIN ?? '');
  for (const key of ['SSO_BASE_URL', 'LOGIN_BASE_URL', 'COPILOT_API_BASE_URL']) assert.equal(process.env[key], origin);
  assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
  // Nothing above imports production configuration or opens a socket.
  const [{ createPool }, { MysqlStorage }, { PrewarmWorker }, { realProvisioner }] = await Promise.all([
    import('mysql2/promise'), import('../../src/proxy/src/db/mysqlStorage.js'),
    import('../../src/proxy/src/userPool/worker.js'), import('../../src/proxy/src/userPool/provisioner.js'),
  ]);
  const pool = createPool({ uri: url.toString(), connectionLimit: 4, connectTimeout: 5000,
    timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
  const storage = new MysqlStorage(pool, 2);
  const store = await bounded('child store init', storage.userPool(options), 20000);
  let steps = 0, httpCalls = 0, updates = 0;
  let retained: ProvisionContext | undefined;
  let checkpoint: { row: ProvisionInventory; owner: string; taskId: string } | undefined;
  let release: (() => void) | undefined;
  let checkpointDone: Promise<void> | undefined;
  const claim = store.claimOwner.bind(store);
  store.claimOwner = async owner => {
    const accepted = await claim(owner);
    send({ kind: accepted ? 'claim' : 'standby', owner, dbNow: await store.now() });
    return accepted;
  };
  const update = store.update.bind(store);
  store.update = async (identity, patch, fence, owner) => {
    updates++;
    if (!checkpoint && patch.stage === 'oauth-wait' && patch.task_id && typeof fence === 'object' && fence.stage === 'oauth-dispatch') {
      assert.ok(owner);
      const row = await store.inventory(identity);
      assert.ok(row);
      assert.deepEqual(row, fence, 'Hold precedes SQL; original row fence is still current');
      checkpoint = { row, owner, taskId: patch.task_id };
      let done!: () => void;
      checkpointDone = new Promise<void>(resolve => { done = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      send({ kind: 'checkpoint-held', identity, owner, nonce: row.oauth_attempt_id, taskId: patch.task_id,
        attempt: row.attempt_id, generation: row.generation, steps, httpCalls, updates });
      await barrier; // No SQL lock, no clock replacement, no owner mutation.
      try {
        const before = await store.inventory(identity);
        const sameFence = isDeepStrictEqual(before, fence);
        // Deliberately call the original REAL MySQL method even though the old local
        // controller has aborted. This is the in-flight continuation, not a mock denial.
        const accepted = await update(identity, patch, fence, owner);
        const after = await store.inventory(identity);
        send({ kind: 'checkpoint-result', accepted, sameFence, unchanged: isDeepStrictEqual(before, after),
          owner, identity, taskId: patch.task_id, nonce: row.oauth_attempt_id });
        if (role === 'old') {
          assert.equal(sameFence, true, 'Owner is the only mismatching fence');
          assert.equal(accepted, false, 'Real SQL-backed owner fence must reject resumed checkpoint');
          assert.deepEqual(after, before);
        } else assert.equal(accepted, true);
        return accepted;
      } finally { done(); }
    }
    return update(identity, patch, fence, owner);
  };
  const adapter = realProvisioner(store, options, {
    getAccount: storage.getAccount.bind(storage),
    fetch: (...args) => { httpCalls++; return fetch(...args); },
  });
  const step = adapter.step.bind(adapter);
  adapter.step = async (row, context) => { steps++; retained = context; return step(row, context); };
  const worker = new PrewarmWorker(store, adapter, options.pollMs, 1, undefined, { multiReplica: true });
  const status = () => ({ active: worker.isActive(), snapshot: worker.snapshot(), steps, httpCalls, updates });
  let resuming = false, completing = false;
  process.on('message', message => {
    const kind = (message as { kind?: string })?.kind;
    void (async () => {
      if (kind === 'status') send({ kind: 'status', ...status() });
      if (kind === 'resume-old' && !resuming) {
        assert.equal(role, 'old'); assert.ok(checkpoint && release && checkpointDone && retained);
        resuming = true;
        // Calls the real monotonic local tenure check; no fake clock or private fields.
        send({ kind: 'resumed', ...status() });
        release();
        await bounded('retained SQL checkpoint', checkpointDone, 20000);
        const before = { steps, httpCalls, updates };
        await assert.rejects(async () => { await retained!.assertCurrent(); });
        await assert.rejects(async () => { await retained!.checkpoint({ last_error: 'suspend_stale_context' }); });
        assert.deepEqual({ steps, httpCalls, updates }, before, 'Retained context cannot reach SQL or HTTP again');
        send({ kind: 'local-fenced', ...status() });
      }
      if (kind === 'release-successor') {
        assert.equal(role, 'successor'); assert.ok(release); release();
      }
      if (kind === 'complete' && !completing) {
        assert.equal(role, 'successor'); assert.ok(checkpoint?.row.oauth_attempt_id);
        completing = true;
        // Synthetic repository callback runs in the successor, not the read-only parent.
        assert.ok(await storage.saveCopilotOauthToken(checkpoint.row.identity, checkpoint.row.oauth_attempt_id,
          OAUTH_TOKEN, `${checkpoint.row.identity}_synthetic`));
        send({ kind: 'callback', identity: checkpoint.row.identity, nonce: checkpoint.row.oauth_attempt_id });
      }
      if (kind === 'stop' && !closing) {
        closing = true; release?.();
        await bounded('worker stop', worker.stop(), 20000);
        await bounded('child storage close', storage.close(), 5000);
        send({ kind: 'stopped' });
        process.disconnect?.();
      }
    })().catch(() => { send({ kind: 'fatal' }); process.exit(1); });
  });
  send({ kind: 'boot' });
  await worker.start();
} catch {
  // Never echo driver error objects, database URLs or credentials.
  send({ kind: 'fatal' }); process.exit(1);
}
