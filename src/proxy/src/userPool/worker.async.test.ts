import assert from 'node:assert/strict';
import test from 'node:test';
import type { InventoryFence } from './store.js';
import { ProvisionFailure, isExhaustedLoginReservation, type ProvisionContext, type ProvisionInventory } from './provisioner.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Synthetic async database: checks and writes occur together after the injected delay. */
function fixture(stage = 'new') {
  let now = 1800000000000;
  let monotonic = 0;
  let owner: string | undefined;
  let ownerUntil = 0;
  let held = false;
  let token: string | undefined = 'synthetic-token';
  const row: ProvisionInventory = {
    identity: 'synthetic001', ordinal: 0, state: 'provisioning', stage, attempt_id: 'attempt-1', generation: 0,
    task_id: null, attempts: 0, retry_at: 0, last_error: null, updated_at: now, cooldown_until: 0,
    verified_at: null, sso_created_at: null, oauth_attempt_id: null,
  };
  const claims: string[] = [];
  const renewals: string[] = [];
  const writes: string[] = [];
  const failures: string[] = [];
  const hooks: Partial<Record<'claim' | 'renew' | 'inventory' | 'update' | 'fail' | 'mutation', () => Promise<void>>> = {};
  let renewing = 0;
  let peakRenewing = 0;
  const liveOwner = (expected?: string) => owner === expected && ownerUntil > now;
  const matches = (fence?: InventoryFence) => !fence || (typeof fence === 'string' ? fence === row.attempt_id
    : fence.attempt_id === row.attempt_id && fence.generation === row.generation
      && (!('stage' in fence) || fence.stage === row.stage));
  const valid = (fence?: InventoryFence, expected?: string) => matches(fence) && liveOwner(expected) && !held;
  const store: PrewarmStore = {
    async now() { return now; },
    async claimOwner(next) {
      claims.push(next);
      await hooks.claim?.();
      if (ownerUntil > now) return false;
      owner = next; ownerUntil = now + 30000;
      return true;
    },
    async renewOwner(expected) {
      renewals.push(expected);
      renewing++; peakRenewing = Math.max(peakRenewing, renewing);
      try {
        await hooks.renew?.();
        if (!liveOwner(expected)) return false;
        ownerUntil = now + 30000;
        return true;
      } finally { renewing--; }
    },
    async releaseOwner(expected) { if (owner === expected) { owner = undefined; ownerUntil = 0; } },
    async reclaim() {},
    async settings() { return { version: 1, idle_target: 1, max_accounts: 1, lease_seconds: 600, paused: 0 }; },
    async reserveDeficit() { return 0; },
    async pending(excluded = []) {
      return !excluded.includes(row.identity) && row.retry_at <= now && (row.state === 'provisioning'
        || row.state === 'failed' && row.attempts < 3) ? { ...row } : undefined;
    },
    async hasHolds() { return held; },
    async inventory() { await hooks.inventory?.(); return { ...row }; },
    async update(_identity, patch, fence, expected) {
      await hooks.update?.();
      if (!valid(fence, expected) || row.state === 'disabled') return false;
      if (patch.state && ['failed', 'disabled', 'provisioning'].includes(patch.state) && patch.state !== row.state) row.generation++;
      Object.assign(row, patch);
      writes.push(expected!);
      return true;
    },
    async fail(_identity, code, fence, expected, terminal = false) {
      await hooks.fail?.();
      if (!valid(fence, expected) || row.state !== 'provisioning') return;
      row.state = 'failed'; row.generation++;
      row.attempts = terminal ? Math.max(3, row.attempts + 1) : row.attempts + 1;
      row.last_error = code; row.retry_at = now + 30000;
      failures.push(code);
    },
    async mutateWorkerCredential(_identity, fence, expected, mutation) {
      await hooks.mutation?.();
      if (!valid(fence, expected) || row.state !== 'provisioning' || row.stage !== fence.stage) return false;
      if (mutation.type === 'invalidate') {
        if (token !== mutation.expectedToken) return false;
        token = undefined;
      }
      row.generation++;
      writes.push(expected);
      return true;
    },
    async event() {},
  };
  const worker = (step: (row: ProvisionInventory, context: ProvisionContext) => Promise<{}>, multiReplica = true) =>
    new PrewarmWorker(store, { step }, 60000, 1, () => monotonic, { multiReplica });
  return {
    store, row, hooks, claims, renewals, writes, failures, worker,
    owner: () => owner, token: () => token, peakRenewing: () => peakRenewing,
    advanceDb(ms: number) { now += ms; },
    advanceLocal(ms: number) { monotonic += ms; },
    steal() { owner = 'other-replica'; ownerUntil = now + 30000; },
    hold() { held = true; },
    replaceToken(value = 'replacement-token') { token = value; row.generation++; },
  };
}

async function fenced(operation: () => unknown) {
  await assert.rejects(async () => operation(), error => error instanceof ProvisionFailure && error.code === 'provision_fenced');
}

test('async replicas elect one scheduler, standby starts successfully and takes over with a fresh UUID', async t => {
  const f = fixture();
  let firstCalls = 0, secondCalls = 0;
  const first = f.worker(async () => { firstCalls++; return {}; });
  const second = f.worker(async () => { secondCalls++; return {}; });
  t.after(async () => { await first.stop(); await second.stop(); });
  await Promise.all([first.start(), second.start()]);
  await flush();
  assert.equal(first.isActive(), true);
  assert.equal(second.isActive(), false);
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 0);
  const old = f.owner();
  await first.stop();
  f.row.retry_at = 0;
  await second.tick();
  assert.equal(second.isActive(), true);
  assert.equal(secondCalls, 1);
  assert.notEqual(f.owner(), old);
  assert.equal(new Set(f.claims).size, f.claims.length, 'each election candidate uses a new UUID');
});

test('SQLite rejects a second scheduler and remains stopped after ownership loss', async () => {
  const f = fixture();
  f.steal();
  const worker = f.worker(async () => ({}), false);
  await assert.rejects(worker.start(), /Another Proxy owns the SQLite user pool/);
  f.advanceDb(30001);
  await worker.tick();
  assert.equal(worker.isActive(), false);
  assert.equal(f.claims.length, 1);
  await worker.stop();
});

test('heartbeat is singleflight even when SQL takes longer than several intervals', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  const worker = f.worker(async () => ({}));
  t.after(() => worker.stop());
  await worker.start();
  await worker.tick();
  const gate = deferred<void>();
  f.hooks.renew = () => gate.promise;
  const before = f.renewals.length;
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(5000); await flush(); }
  assert.equal(f.renewals.length, before + 1);
  assert.equal(f.peakRenewing(), 1);
  gate.resolve();
  await flush();
  assert.equal(worker.isActive(), true);
});

test('local monotonic expiration revokes execution without querying or resurrecting the old UUID', async () => {
  const f = fixture();
  const worker = f.worker(async () => ({}));
  await worker.tick();
  const claims = f.claims.length, renewals = f.renewals.length;
  f.advanceLocal(30001);
  assert.equal(worker.isActive(), false);
  assert.equal(f.claims.length, claims);
  assert.equal(f.renewals.length, renewals);
  f.advanceDb(30001);
  await worker.tick();
  assert.equal(worker.isActive(), true);
  assert.notEqual(f.claims.at(-1), f.claims[0]);
  await worker.stop();
});

test('DB expiration cannot be renewed even when the local clock still permits the old tenure', async () => {
  const f = fixture();
  let context!: ProvisionContext;
  const external = deferred<{}>();
  const worker = f.worker(async (_row, ctx) => { context = ctx; return external.promise; });
  const running = worker.tick();
  await flush();
  const old = f.owner();
  f.advanceDb(30001);
  await fenced(() => context.assertCurrent());
  await running;
  assert.equal(worker.isActive(), false);
  assert.equal(context.signal.aborted, true);
  assert.equal(f.owner(), old, 'renewal did not revive the expired database row');
  external.resolve({});
  await worker.stop();
  assert.deepEqual(f.failures, []);
});

test('delayed successful renewal cannot extend a locally expired tenure', async () => {
  const f = fixture();
  let context!: ProvisionContext;
  const external = deferred<{}>();
  const worker = f.worker(async (_row, ctx) => { context = ctx; return external.promise; });
  const running = worker.tick();
  await flush();
  const gate = deferred<void>();
  f.hooks.renew = () => gate.promise;
  const checking = fenced(() => context.assertCurrent());
  await flush();
  f.advanceLocal(30001);
  gate.resolve();
  await checking;
  await running;
  assert.equal(worker.isActive(), false);
  assert.equal(context.signal.aborted, true);
  assert.deepEqual(f.failures, []);
  external.resolve({});
  await worker.stop();
});

test('old contexts cannot borrow a new local tenure after an abort and standby election', async () => {
  const f = fixture();
  let oldContext!: ProvisionContext;
  const external = deferred<{}>();
  let calls = 0;
  const worker = f.worker(async (_row, context) => {
    if (++calls === 1) { oldContext = context; return external.promise; }
    return { retry_at: Number.MAX_SAFE_INTEGER };
  });
  const first = worker.tick();
  await flush();
  const old = f.owner();
  f.steal();
  await worker.tick();
  await first;
  assert.equal(oldContext.signal.aborted, true);
  f.advanceDb(30001);
  await worker.tick();
  assert.equal(worker.isActive(), true);
  assert.notEqual(f.owner(), old);
  const writes = f.writes.length, claims = f.claims.length;
  await fenced(() => oldContext.checkpoint({ state: 'ready' }));
  await fenced(() => oldContext.mutateCredentials!({ type: 'link', ghLogin: 'old-login' }));
  external.resolve({ state: 'ready' });
  await flush();
  assert.equal(f.writes.length, writes);
  assert.equal(f.claims.length, claims);
  assert.deepEqual(f.failures, []);
  await worker.stop();
});

test('owner loss while checkpoint SQL is pending cannot charge retries or record late success', async () => {
  const f = fixture();
  const gate = deferred<void>();
  f.hooks.update = () => gate.promise;
  const worker = f.worker(async () => ({ state: 'ready', stage: 'ready' }));
  const running = worker.tick();
  await flush();
  f.steal();
  gate.resolve();
  await running;
  assert.equal(f.row.state, 'provisioning');
  assert.deepEqual(f.failures, []);
  assert.deepEqual(f.writes, []);
  await worker.stop();
});

test('fenced mutation rejects owner, stage, generation ABA and hold changes inside its async transaction', async () => {
  for (const race of ['owner', 'stage', 'generation', 'hold'] as const) {
    const f = fixture('warmup');
    const gate = deferred<void>();
    f.hooks.mutation = () => gate.promise;
    const worker = f.worker(async (_row, context) => {
      await context.pinCredentials();
      await context.mutateCredentials!({ type: 'invalidate', expectedToken: 'synthetic-token' });
      throw new ProvisionFailure('warmup_http_401');
    });
    const running = worker.tick();
    await flush();
    if (race === 'owner') f.steal();
    if (race === 'stage') f.row.stage = 'synced';
    if (race === 'generation') { f.replaceToken(); f.replaceToken('synthetic-token'); }
    if (race === 'hold') f.hold();
    gate.resolve();
    await running;
    assert.equal(f.token(), 'synthetic-token', race);
    assert.deepEqual(f.failures, [], race);
    assert.deepEqual(f.writes, [], race);
    await worker.stop();
  }
});

test('atomic 401 invalidation keeps the new generation pinned and preserves the repair retry', async () => {
  const f = fixture('warmup');
  const worker = f.worker(async (_row, context) => {
    await context.pinCredentials();
    await context.checkpoint({ stage: 'synced', oauth_attempt_id: null, task_id: null });
    await context.mutateCredentials!({ type: 'invalidate', expectedToken: 'synthetic-token' });
    throw new ProvisionFailure('warmup_http_401');
  });
  await worker.tick();
  assert.equal(f.token(), undefined);
  assert.equal(f.row.stage, 'synced');
  assert.equal(f.row.state, 'failed');
  assert.equal(f.row.generation, 2);
  assert.equal(f.row.attempts, 1);
  assert.deepEqual(f.failures, ['warmup_http_401']);
  await worker.stop();
});

test('replacement after successful invalidation cannot be repinned or charged for the old 401', async () => {
  const f = fixture('warmup');
  const mutate = f.store.mutateWorkerCredential;
  f.store.mutateWorkerCredential = async (...args) => {
    const changed = await mutate(...args);
    if (changed) f.replaceToken();
    return changed;
  };
  const worker = f.worker(async (_row, context) => {
    await context.pinCredentials();
    await context.checkpoint({ stage: 'synced' });
    await context.mutateCredentials!({ type: 'invalidate', expectedToken: 'synthetic-token' });
    throw new ProvisionFailure('warmup_http_401');
  });
  await worker.tick();
  assert.equal(f.token(), 'replacement-token');
  assert.equal(f.row.generation, 2);
  assert.equal(f.row.attempts, 0);
  assert.deepEqual(f.failures, []);
  await worker.stop();
});

test('storage errors fence a step instead of consuming provisioning retries', async () => {
  const f = fixture();
  const worker = f.worker(async () => {
    f.hooks.update = async () => { throw new Error('synthetic storage outage'); };
    return { stage: 'sso-creating' };
  });
  await worker.tick();
  assert.equal(worker.isActive(), false);
  assert.deepEqual(f.failures, []);
  assert.equal(f.row.stage, 'new');
  await worker.stop();
});

test('renewal errors abort the old tenure without charging retries, then standby can reelect', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let context!: ProvisionContext;
  let calls = 0;
  const external = deferred<{}>();
  const worker = f.worker(async (_row, ctx) => {
    if (++calls === 1) { context = ctx; return external.promise; }
    return {};
  });
  await worker.start();
  await flush();
  const old = f.owner();
  f.hooks.renew = async () => { throw new Error('synthetic database outage'); };
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(context.signal.aborted, true);
  assert.equal(worker.isActive(), false);
  assert.deepEqual(f.failures, []);
  delete f.hooks.renew;
  f.advanceDb(30001);
  await worker.tick();
  assert.equal(worker.isActive(), true);
  assert.notEqual(f.owner(), old);
  external.resolve({ state: 'ready' });
  await flush();
  assert.equal(f.row.state, 'provisioning');
  await worker.stop();
});

test('async fail transaction rejects a newer generation without changing its retry budget', async () => {
  const f = fixture('warmup');
  const gate = deferred<void>();
  f.hooks.fail = () => gate.promise;
  const worker = f.worker(async (_row, context) => {
    await context.pinCredentials();
    throw new ProvisionFailure('warmup_http_429');
  });
  const running = worker.tick();
  await flush();
  f.replaceToken();
  gate.resolve();
  await running;
  assert.equal(f.row.attempts, 0);
  assert.equal(f.row.state, 'provisioning');
  assert.deepEqual(f.failures, []);
  await worker.stop();
});

test('Login callback after atomic terminal failure cannot restore retries or lose the reservation', async t => {
  const f = fixture('oauth-wait');
  f.row.task_id = 'running-task';
  f.row.oauth_attempt_id = 'login-nonce';
  const fail = f.store.fail;
  f.store.fail = async (...args) => {
    await fail(...args);
    // A successful Login callback commits a new credential generation immediately
    // after fail's transaction, before the worker sees that transaction complete.
    f.replaceToken('callback-token');
  };
  f.hooks.update = async () => assert.fail('terminal failure must not need a second update');
  let calls = 0;
  const worker = f.worker(async () => {
    calls++;
    throw new ProvisionFailure('oauth_task_stalled', true);
  });
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.row.attempts, 3);
  assert.equal(f.row.state, 'failed');
  assert.equal(f.row.stage, 'oauth-wait');
  assert.equal(f.row.generation, 2);
  assert.equal(f.row.last_error, 'oauth_task_stalled');
  assert.equal(f.row.task_id, 'running-task');
  assert.equal(f.row.oauth_attempt_id, 'login-nonce');
  assert.equal(f.token(), 'callback-token');
  assert.equal(isExhaustedLoginReservation(f.row), true);
  f.row.retry_at = 0;
  await worker.tick();
  assert.equal(worker.isActive(), true);
  assert.equal(calls, 1, 'no automatic retry after the callback changes generation');
  assert.deepEqual(f.failures, ['oauth_task_stalled']);
});

test('terminal fail transaction rejects replacement generation before committing exhaustion', async t => {
  const f = fixture('oauth-wait');
  const gate = deferred<void>();
  f.hooks.fail = () => gate.promise;
  const worker = f.worker(async () => { throw new ProvisionFailure('oauth_task_stalled', true); });
  t.after(() => worker.stop());
  const running = worker.tick();
  await flush();
  f.replaceToken();
  gate.resolve();
  await running;
  assert.equal(f.row.attempts, 0);
  assert.equal(f.row.state, 'provisioning');
  assert.deepEqual(f.failures, []);
});

test('old contexts expire when an adapter returns, even if it retains callbacks', async () => {
  const f = fixture();
  let context!: ProvisionContext;
  const worker = f.worker(async (_row, ctx) => { context = ctx; return {}; });
  await worker.tick();
  const writes = f.writes.length;
  await fenced(() => context.checkpoint({ stage: 'sso-creating' }));
  await fenced(() => context.mutateCredentials!({ type: 'link', ghLogin: 'late-login' }));
  assert.equal(f.writes.length, writes);
  await worker.stop();
});

test('shutdown while claim is pending waits for and releases the candidate without starting timers', async () => {
  const f = fixture();
  const gate = deferred<void>();
  f.hooks.claim = () => gate.promise;
  let calls = 0;
  const worker = f.worker(async () => { calls++; return {}; });
  const starting = worker.start();
  await flush();
  const stopping = worker.stop();
  gate.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(f.owner(), undefined);
  assert.equal(worker.isActive(), false);
  assert.equal(calls, 0);
});
