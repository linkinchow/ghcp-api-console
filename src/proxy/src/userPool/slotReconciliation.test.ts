import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoginTaskDto } from '@ghcp/shared';
import type { PoolConfig } from './config.js';
import { isExhaustedLoginReservation, realProvisioner, type LoginReservationContext, type ProvisionAdapter, type ProvisionInventory } from './provisioner.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'pool.example.test', idleTarget: 5, maxAccounts: 100,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000, retryAfterSeconds: 30,
  warmupModel: 'unused', requestTimeoutMs: 1000,
};
const createdAt = '2026-01-01T00:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Async contract fixture; no real Login, SSO, credentials, database or model calls. */
function fixture(count = 5) {
  let now = Date.parse(createdAt), monotonic = 0, owner: string | undefined;
  let paused = 0, held = false;
  const rows: ProvisionInventory[] = Array.from({ length: count }, (_, i) => ({
    identity: `pool${i}`, ordinal: i, state: 'failed', stage: 'oauth-wait', attempt_id: `worker${i}`,
    oauth_attempt_id: `nonce${i}`, sso_created_at: createdAt, task_id: `task${i}`,
    attempts: 3, retry_at: now + 30000, last_error: 'sso_http_503', updated_at: now,
    cooldown_until: 0, verified_at: null, generation: 9,
  }));
  const tasks: LoginTaskDto[] = rows.map(row => ({
    id: row.task_id!, identity: row.identity, ssoUser: row.identity, ghLogin: `${row.identity}_emu`,
    oauthAttemptId: row.oauth_attempt_id!, ssoType: 'custom', status: 'running', attempts: 1, createdAt,
  }));
  const requests: string[] = [], releases: string[] = [], steps: string[] = [];
  const signals: AbortSignal[] = [];
  let beforeFetch: (() => void | Promise<void>) | undefined, beforeRelease: (() => void) | undefined;
  let responseStatus = 200;
  const live = (expected?: string) => Boolean(owner) && owner === expected;
  const same = (row: ProvisionInventory, fence: ProvisionInventory) =>
    ['attempt_id', 'generation', 'stage', 'state', 'attempts', 'task_id', 'oauth_attempt_id', 'sso_created_at']
      .every(key => row[key as keyof ProvisionInventory] === fence[key as keyof ProvisionInventory]);
  const reserved = () => rows.filter(row => ['oauth-dispatch', 'oauth-wait'].includes(row.stage)).length;
  const store: PrewarmStore = {
    async now() { return now; },
    async claimOwner(next) { if (owner) return false; owner = next; return true; },
    async renewOwner(expected) { return live(expected); },
    async releaseOwner(expected) { if (live(expected)) owner = undefined; },
    async reclaim() {},
    async settings() { return { version: 1, idle_target: 5, max_accounts: 100, lease_seconds: 600, paused }; },
    async reserveDeficit() { return 0; },
    async pending(excluded = []) {
      const row = rows.find(row => row.state === 'provisioning' && row.retry_at <= now && !excluded.includes(row.identity));
      return row && { ...row };
    },
    async hasHolds() { return held; },
    async inventory(identity) { const row = rows.find(row => row.identity === identity); return row && { ...row }; },
    async update(identity, patch) { Object.assign(rows.find(row => row.identity === identity)!, patch); return true; },
    async fail() { assert.fail('reconciliation must not charge attempts'); },
    async mutateWorkerCredential() { assert.fail('reconciliation must not modify credentials'); },
    async event() {},
    async listLoginReservations() { return rows.filter(isExhaustedLoginReservation).slice(0, 100).map(row => ({ ...row })); },
    async releaseLoginReservation(identity, fence, expected, outcome) {
      beforeRelease?.();
      const row = rows.find(row => row.identity === identity)!;
      if (!live(expected) || paused || held || !same(row, fence) || !isExhaustedLoginReservation(row)) return false;
      row.stage = outcome === 'success' ? 'warmup' : 'synced';
      row.task_id = null; row.oauth_attempt_id = null; row.generation++;
      releases.push(identity);
      return true;
    },
    async claimLoginDispatch(identity, _fence, expected, limit) {
      if (!live(expected) || paused || reserved() >= limit) return false;
      rows.find(row => row.identity === identity)!.stage = 'oauth-dispatch';
      return true;
    },
  };
  const adapter: ProvisionAdapter = {
    ...realProvisioner(store, options, {
      getAccount: async identity => ({ identity, ssoUser: identity, ghLogin: `${identity}_emu`, copilotOauthStatus: 'missing', createdAt, updatedAt: createdAt }),
      fetch: async (input, init) => {
        assert.equal(init?.method, 'GET', 'only read-only Login requests are allowed');
        const url = new URL(String(input));
        assert.ok(url.pathname.startsWith('/api/tasks'));
        requests.push(url.pathname + url.search);
        signals.push(init!.signal!);
        await beforeFetch?.();
        if (responseStatus !== 200) return json({}, responseStatus);
        if (url.pathname === '/api/tasks') return json({ items: tasks, total: tasks.length, page: 1, pageSize: 100 });
        const index = rows.findIndex(row => url.pathname === `/api/tasks/${row.task_id}`);
        const task = tasks[index];
        return json(task ?? {}, task ? 200 : 404);
      },
    }),
    async step(row, context) {
      steps.push(row.identity);
      if (row.stage === 'oauth-starting') await context.claimLoginDispatch!(5);
      return {};
    },
  };
  const worker = new PrewarmWorker(store, adapter, options.pollMs, 5, () => monotonic, { multiReplica: true });
  return {
    rows, tasks, store, worker, adapter, requests, releases, steps, signals, reserved,
    async tick() { await worker.tick(); await worker.waitForObservations(); },
    nextPoll() { now += options.pollMs; monotonic += options.pollMs; },
    pause() { paused = 1; }, hold() { held = true; }, steal() { owner = 'new-owner'; },
    vacate() { owner = undefined; }, owner: () => owner,
    beforeFetch(fn: () => void | Promise<void>) { beforeFetch = fn; }, beforeRelease(fn: () => void) { beforeRelease = fn; },
    status(value: number) { responseStatus = value; },
    addWaiting() {
      rows.push({ ...rows[0]!, identity: 'waiting', ordinal: 99, state: 'provisioning', stage: 'oauth-starting',
        attempts: 0, task_id: null, oauth_attempt_id: 'waiting-nonce', retry_at: 0 });
    },
  };
}

test('five exhausted reservations block dispatch until positively completed; release never retries exhausted accounts', async t => {
  const f = fixture(); t.after(() => f.worker.stop());
  f.addWaiting();
  await f.tick();
  assert.equal(f.reserved(), 5);
  assert.equal(f.rows.at(-1)!.stage, 'oauth-starting');
  assert.equal(f.requests.length, 5);
  f.tasks[0]!.status = 'success';
  f.nextPoll();
  await f.tick();
  assert.equal(f.rows[0]!.stage, 'warmup');
  assert.equal(f.rows[0]!.state, 'failed');
  assert.equal(f.rows[0]!.attempts, 3);
  assert.equal(f.rows[0]!.last_error, 'sso_http_503');
  assert.equal(f.rows[0]!.generation, 10);
  assert.equal(f.rows[0]!.task_id, null);
  assert.equal(f.rows[0]!.oauth_attempt_id, null);
  // Admission and observation now run independently. The waiting member retries on
  // its next ordinary due tick if the release completed after its admission check.
  f.nextPoll(); await f.tick();
  assert.equal(f.rows.at(-1)!.stage, 'oauth-dispatch');
  assert.equal(f.reserved(), 5);
  assert.ok(f.steps.every(identity => identity === 'waiting'));
  assert.equal(f.requests.filter(path => path === '/api/tasks/task0').length, 2, 'released task is never polled again');
});

for (const state of ['failed', 'disabled']) {
  for (const status of ['success', 'failed', 'cancelled', 'pending', 'running', 'unknown']) {
    test(`${state} reservation observes ${status} without changing operator state or retry count`, async t => {
      const f = fixture(1); t.after(() => f.worker.stop());
      f.rows[0]!.state = state;
      if (state === 'disabled') f.rows[0]!.attempts = 1;
      f.tasks[0]!.status = status as LoginTaskDto['status'];
      const before = { ...f.rows[0]! };
      await f.tick();
      const completed = status === 'success' || status === 'failed';
      assert.equal(f.releases.length, completed ? 1 : 0);
      assert.deepEqual(f.rows[0], completed ? {
        ...before, stage: status === 'success' ? 'warmup' : 'synced', task_id: null, oauth_attempt_id: null, generation: 10,
      } : before);
      assert.deepEqual(f.steps, []);
    });
  }
}

for (const status of [404, 503]) {
  test(`Login HTTP ${status} retains slot and does not charge another retry`, async t => {
    const f = fixture(1); t.after(() => f.worker.stop());
    f.status(status); const before = { ...f.rows[0]! };
    await f.tick(); assert.deepEqual(f.rows[0], before); assert.deepEqual(f.releases, []);
  });
}

for (const field of ['identity', 'ssoUser', 'ghLogin', 'oauthAttemptId', 'ssoType', 'id'] as const) {
  test(`terminal task with mismatched ${field} cannot release the reservation`, async t => {
    const f = fixture(1); t.after(() => f.worker.stop());
    f.tasks[0]!.status = 'success';
    Object.assign(f.tasks[0]!, { [field]: 'different' });
    await f.tick(); assert.deepEqual(f.releases, []);
  });
}

test('uncertain dispatch searches exact nonce read-only; duplicate nonce remains blocked', async t => {
  for (const duplicate of [false, true]) {
    const f = fixture(1); t.after(() => f.worker.stop());
    f.rows[0]!.stage = 'oauth-dispatch'; f.rows[0]!.task_id = null;
    f.tasks[0]!.status = 'failed';
    f.tasks.push({ ...f.tasks[0]!, id: 'other', oauthAttemptId: duplicate ? 'nonce0' : 'old-nonce' });
    await f.tick();
    assert.equal(f.releases.length, duplicate ? 0 : 1);
    assert.equal(f.requests.length, 1);
    assert.ok(f.requests[0]!.includes('?q=pool0&page=1&pageSize=100'));
  }
});

test('owner loss, row replacement, pause, and holds during observation fence terminal results', async t => {
  for (const change of ['owner', 'generation', 'pause', 'hold']) {
    const f = fixture(1); t.after(() => f.worker.stop());
    f.tasks[0]!.status = 'success';
    f.beforeFetch(() => {
      if (change === 'owner') f.steal();
      if (change === 'generation') f.rows[0]!.generation++;
      if (change === 'pause') f.pause();
      if (change === 'hold') f.hold();
    });
    await f.tick(); assert.deepEqual(f.releases, []);
    assert.equal(f.rows[0]!.stage, 'oauth-wait');
  }
});

test('atomic release rejects stale owner or row after last worker assertion', async t => {
  for (const change of ['owner', 'generation']) {
    const f = fixture(1); t.after(() => f.worker.stop());
    f.tasks[0]!.status = 'failed';
    f.beforeRelease(() => change === 'owner' ? f.steal() : f.rows[0]!.generation++);
    await f.tick(); assert.deepEqual(f.releases, []);
    assert.equal(f.rows[0]!.stage, 'oauth-wait');
  }
});

test('paused scheduler neither observes nor dispatches repair', async t => {
  const f = fixture(1); t.after(() => f.worker.stop());
  f.tasks[0]!.status = 'success'; f.pause(); f.addWaiting();
  await f.tick();
  assert.deepEqual(f.requests, []); assert.deepEqual(f.releases, []); assert.deepEqual(f.steps, []);
});

test('observation is at most ten rows per poll, rotates and ignores completion-triggered wakes', async t => {
  const f = fixture(15); t.after(() => f.worker.stop());
  await f.tick(); assert.equal(f.requests.length, 10);
  await f.tick(); assert.equal(f.requests.length, 10);
  f.nextPoll(); await f.tick(); assert.equal(f.requests.length, 20);
  assert.equal(new Set(f.requests).size, 15);
});

test('standby scheduler cannot observe reservations', async t => {
  const f = fixture(1); t.after(() => f.worker.stop());
  f.steal(); await f.tick(); assert.deepEqual(f.requests, []);
});

test('a deferred terminal GET cannot block a due member or duplicate observations across polls', async t => {
  const f = fixture(1); t.after(() => f.worker.stop());
  const response = deferred<void>();
  f.tasks[0]!.status = 'success';
  f.beforeFetch(() => response.promise);
  await f.worker.tick();
  await flush();
  assert.equal(f.requests.length, 1);
  f.addWaiting();
  await f.worker.tick();
  assert.equal(f.rows.at(-1)!.stage, 'oauth-dispatch', 'ordinary due member advances before terminal GET resolves');
  assert.deepEqual(f.releases, []);
  for (let i = 0; i < 3; i++) { f.nextPoll(); await f.worker.tick(); }
  assert.equal(f.requests.length, 1, 'one observation batch remains in flight even after multiple due polls');
  response.resolve();
  await f.worker.waitForObservations();
  assert.deepEqual(f.releases, ['pool0']);
});

test('scheduler pause aborts an in-flight observation and fences its late terminal response', async t => {
  const f = fixture(1); t.after(() => f.worker.stop());
  const response = deferred<void>();
  f.tasks[0]!.status = 'success'; f.beforeFetch(() => response.promise);
  await f.worker.tick(); await flush();
  f.pause();
  await f.worker.tick();
  await f.worker.waitForObservations();
  assert.equal(f.signals[0]!.aborted, true);
  response.resolve(); await flush();
  assert.deepEqual(f.releases, []);
  assert.equal(f.rows[0]!.stage, 'oauth-wait');
});

test('observation deadline bounds an uncooperative GET without charging retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(1); t.after(() => f.worker.stop());
  const response = deferred<void>();
  f.tasks[0]!.status = 'success'; f.beforeFetch(() => response.promise);
  const before = { ...f.rows[0]! };
  await f.worker.tick(); await flush();
  t.mock.timers.tick(options.requestTimeoutMs);
  await f.worker.waitForObservations();
  assert.equal(f.signals[0]!.aborted, true);
  assert.deepEqual(f.rows[0], before);
  response.resolve(); await flush();
  assert.deepEqual(f.releases, []);
});

test('stop joins the bounded observation and ignores an uncooperative late GET result', async () => {
  const f = fixture(1);
  const response = deferred<void>();
  f.tasks[0]!.status = 'success'; f.beforeFetch(() => response.promise);
  await f.worker.tick(); await flush();
  const draining = f.worker.waitForObservations();
  await f.worker.stop();
  await draining;
  assert.equal(f.owner(), undefined);
  assert.equal(f.signals[0]!.aborted, true);
  response.resolve(); await flush();
  assert.deepEqual(f.releases, []);
});

test('stop bounds a pending reservation selection and prevents late selection from dispatching GETs', async () => {
  const f = fixture(1);
  const selected = deferred<ProvisionInventory[]>();
  f.store.listLoginReservations = () => selected.promise;
  await f.worker.tick();
  await f.worker.stop();
  selected.resolve(f.rows.map(row => ({ ...row })));
  await flush();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.releases, []);
});

test('old observation contexts cannot borrow a new tenure after owner loss and reelection', async t => {
  const f = fixture(1); t.after(() => f.worker.stop());
  const external = deferred<'success'>();
  let context!: LoginReservationContext;
  let calls = 0;
  f.adapter.reconcileLoginReservation = async (_row, ctx) => {
    calls++;
    if (calls === 1) { context = ctx; return external.promise; }
    return undefined;
  };
  await f.worker.tick(); await flush();
  const owner = f.owner();
  f.steal(); await f.tick();
  assert.equal(context.signal.aborted, true);
  f.vacate(); f.nextPoll(); await f.tick();
  assert.equal(f.worker.isActive(), true);
  assert.notEqual(f.owner(), owner);
  assert.equal(calls, 2);
  await assert.rejects(async () => context.assertCurrent());
  external.resolve('success'); await flush();
  assert.deepEqual(f.releases, []);
});

test('a completed row context is fenced while another observation in the batch is still pending', async t => {
  const f = fixture(2); t.after(() => f.worker.stop());
  const external = deferred<undefined>();
  let completed!: LoginReservationContext;
  f.adapter.reconcileLoginReservation = async (row, context) => {
    if (row.identity === 'pool0') { completed = context; return undefined; }
    return external.promise;
  };
  await f.worker.tick(); await flush();
  assert.equal(completed.signal.aborted, true);
  await assert.rejects(async () => completed.assertCurrent());
  external.resolve(undefined);
  await f.worker.waitForObservations();
});
