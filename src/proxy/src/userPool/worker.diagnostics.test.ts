import assert from 'node:assert/strict';
import test from 'node:test';
import { MysqlConnectionError, MysqlDeadlineError } from './mysqlDeadline.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';
import type { ProvisionContext, ProvisionInventory } from './provisioner.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(multiReplica = true) {
  let monotonic = 100;
  let wall = 1800000000000;
  let claim = true;
  let renew = true;
  const calls: string[] = [];
  const ownerIds: string[] = [];
  const store: PrewarmStore = {
    async now() { calls.push('now'); return wall; },
    async claimOwner(owner) { calls.push('claim'); ownerIds.push(owner); return claim; },
    async renewOwner() { calls.push('renew'); return renew; },
    async releaseOwner() { calls.push('release'); },
    async reclaim() { calls.push('reclaim'); },
    async settings() { calls.push('settings'); return { version: 1, idle_target: 0, max_accounts: 1, lease_seconds: 600, paused: 0 }; },
    async reserveDeficit() { calls.push('reserve'); return 0; },
    async pending() { calls.push('pending'); return undefined; },
    async hasHolds() { calls.push('holds'); return false; },
    async inventory() { calls.push('inventory'); return undefined; },
    async update() { calls.push('update'); return false; },
    async fail() { calls.push('fail'); },
    async mutateWorkerCredential() { calls.push('mutate'); return false; },
    async event() { calls.push('event'); },
  };
  const worker = new PrewarmWorker(store, { async step() { return {}; } }, 60000, 1, () => monotonic,
    { multiReplica, wallClockNow: () => wall });
  return { store, worker, calls, ownerIds,
    advance(ms: number) { monotonic += ms; },
    wall(value: number) { wall = value; },
    rejectClaim() { claim = false; },
    rejectRenewal() { renew = false; },
  };
}

test('snapshot observes local counters and separate wall timestamps/monotonic ages without SQL', async t => {
  const f = fixture();
  t.after(() => f.worker.stop());
  assert.deepEqual(f.worker.snapshot(), {
    scope: 'local_process', state: 'standby', observedAtUnixMs: 1800000000000, localTenureAgeMs: null,
    lastSuccessfulRenewalAtUnixMs: null, lastSuccessfulRenewalAgeMs: null,
    claimAttempts: 0, ownershipAcquisitions: 0, ownershipLosses: 0, lastOwnershipLoss: null,
  });
  assert.deepEqual(f.calls, []);
  await f.worker.tick();
  const acquired = f.worker.snapshot();
  assert.equal(acquired.state, 'owner');
  assert.equal(acquired.claimAttempts, 1);
  assert.equal(acquired.ownershipAcquisitions, 1);
  assert.equal(acquired.lastSuccessfulRenewalAtUnixMs, null, 'a claim is not a renewal');
  f.advance(250);
  f.wall(1800000007000);
  await f.worker.tick();
  const renewed = f.worker.snapshot();
  assert.equal(renewed.lastSuccessfulRenewalAtUnixMs, 1800000007000);
  assert.equal(renewed.lastSuccessfulRenewalAgeMs, 0);
  assert.equal(renewed.localTenureAgeMs, 0);
  assert.equal(renewed.claimAttempts, 1);
  f.advance(400);
  f.wall(1700000000000); // Wall clock steps backwards; elapsed durations must not.
  const before = [...f.calls];
  for (let i = 0; i < 20; i++) {
    const snapshot = f.worker.snapshot();
    assert.equal(snapshot.observedAtUnixMs, 1700000000000);
    assert.equal(snapshot.lastSuccessfulRenewalAtUnixMs, 1800000007000);
    assert.equal(snapshot.lastSuccessfulRenewalAgeMs, 400);
    assert.equal(snapshot.localTenureAgeMs, 400);
  }
  assert.deepEqual(f.calls, before);
  assert.equal(acquired.lastSuccessfulRenewalAtUnixMs, null, 'previous snapshots do not track later changes');
  await f.worker.stop();
  const stopped = f.worker.snapshot();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.localTenureAgeMs, null);
  assert.equal(stopped.ownershipLosses, 0, 'normal shutdown is not ownership loss');
  assert.equal(stopped.ownershipAcquisitions, 1);
});

test('expired snapshot never fences work, logs, claims, or records a loss; execution still fences exactly once', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const f = fixture();
  let now = 0;
  let wall = 1800000000000;
  let context!: ProvisionContext;
  const external = deferred<{}>();
  const row: ProvisionInventory = {
    identity: 'sensitive-identity', ordinal: 1, state: 'provisioning', stage: 'new', attempt_id: 'attempt',
    task_id: null, attempts: 0, retry_at: 0, last_error: null, updated_at: 0, cooldown_until: 0,
    verified_at: null, generation: 0, sso_created_at: null, oauth_attempt_id: null,
  };
  f.store.pending = async excluded => excluded?.includes(row.identity) ? undefined : { ...row };
  f.store.inventory = async () => ({ ...row });
  const worker = new PrewarmWorker(f.store, { step: (_row, ctx) => { context = ctx; return external.promise; } },
    60000, 1, () => now, { multiReplica: true, wallClockNow: () => wall });
  t.after(() => worker.stop());
  const running = worker.tick();
  await flush();
  now = 30000;
  wall += 5000;
  const calls = [...f.calls];
  for (let i = 0; i < 5; i++) {
    const snapshot = worker.snapshot();
    assert.equal(snapshot.state, 'standby');
    assert.equal(snapshot.localTenureAgeMs, 30000);
    assert.equal(snapshot.ownershipLosses, 0);
    assert.equal(snapshot.lastOwnershipLoss, null);
    assert.equal(context.signal.aborted, false);
  }
  assert.deepEqual(f.calls, calls);
  assert.equal(logs.length, 0);
  assert.equal(worker.isActive(), false, 'existing execution check still enforces local TTL');
  await running;
  assert.equal(context.signal.aborted, true);
  assert.equal(worker.snapshot().ownershipLosses, 1);
  assert.deepEqual(worker.snapshot().lastOwnershipLoss, { reason: 'local_tenure_expired', atUnixMs: wall });
  assert.equal(logs.filter(line => line.includes('ownership-lost')).length, 1);
  assert.equal(worker.isActive(), false);
  assert.equal(worker.snapshot().ownershipLosses, 1);
  external.resolve({});
});

test('rejected renewal records one local loss; standby polling is silent and reacquisition preserves history', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const f = fixture();
  t.after(() => f.worker.stop());
  await f.worker.tick();
  f.advance(100);
  f.wall(1800000000100);
  await f.worker.tick();
  f.rejectRenewal();
  f.wall(1800000000200);
  await f.worker.tick();
  assert.equal(f.worker.snapshot().state, 'standby');
  assert.deepEqual(f.worker.snapshot().lastOwnershipLoss, { reason: 'renewal_rejected', atUnixMs: 1800000000200 });
  const detached = f.worker.snapshot();
  Reflect.set(detached.lastOwnershipLoss!, 'reason', 'sensitive-injected-value');
  assert.equal(f.worker.snapshot().lastOwnershipLoss?.reason, 'renewal_rejected');
  f.rejectClaim();
  for (let i = 0; i < 8; i++) await f.worker.tick();
  assert.equal(f.worker.snapshot().claimAttempts, 9);
  assert.equal(f.worker.snapshot().ownershipAcquisitions, 1);
  assert.equal(f.worker.snapshot().ownershipLosses, 1);
  assert.equal(logs.length, 1, 'no ownership-loss logs on failed standby polls');
  const fields = JSON.parse(logs[0]!.slice(logs[0]!.indexOf('{')));
  assert.deepEqual(fields, {
    scope: 'local_process', state: 'standby', reason: 'renewal_rejected', atUnixMs: 1800000000200,
    lastSuccessfulRenewalAtUnixMs: 1800000000100,
    claimAttempts: 1, ownershipAcquisitions: 1, ownershipLosses: 1,
  });
  for (const owner of f.ownerIds) assert.equal(logs[0]!.includes(owner), false);
  f.store.claimOwner = async () => true;
  await f.worker.tick();
  assert.equal(f.worker.snapshot().state, 'owner');
  assert.equal(f.worker.snapshot().claimAttempts, 10);
  assert.equal(f.worker.snapshot().ownershipAcquisitions, 2);
  assert.equal(f.worker.snapshot().ownershipLosses, 1);
  assert.equal(f.worker.snapshot().lastOwnershipLoss?.reason, 'renewal_rejected');
  assert.equal(f.worker.snapshot().lastSuccessfulRenewalAtUnixMs, 1800000000100);
});

const sensitive = 'secret-token caller-secret account-secret mysql://user:secret-password@private-host/db';
const failures = [
  { name: 'deadline wrapper', error: new MysqlDeadlineError(sensitive), reason: 'storage_unavailable', storageFailure: 'deadline' },
  { name: 'connection wrapper', error: new MysqlConnectionError(Object.assign(new Error(sensitive), { code: sensitive })),
    reason: 'storage_unavailable', storageFailure: 'connection' },
  { name: 'generic SQL error', error: Object.assign(new Error(sensitive), { code: sensitive, sql: sensitive }), reason: 'storage_operation_failed' },
  { name: 'forged wrapper code', error: Object.assign(new Error(sensitive), { code: 'POOL_SQL_TIMEOUT', name: 'MysqlDeadlineError' }), reason: 'storage_operation_failed' },
  { name: 'arbitrary throw value', error: sensitive, reason: 'storage_operation_failed' },
] as const;
for (const operation of ['renewOwner', 'reclaim'] as const) {
  for (const failure of failures) {
    test(`${operation} classifies ${failure.name} without exposing sensitive input`, async t => {
      const logs: string[] = [];
      t.mock.method(console, 'error', (line: string) => logs.push(line));
      const f = fixture();
      t.after(() => f.worker.stop());
      await f.worker.tick();
      f.store[operation] = async () => { throw failure.error; };
      await f.worker.tick();
      const snapshot = f.worker.snapshot();
      const expected = { reason: failure.reason, ...('storageFailure' in failure ? { storageFailure: failure.storageFailure } : {}), atUnixMs: 1800000000000 };
      assert.equal(snapshot.state, 'standby');
      assert.equal(snapshot.ownershipLosses, 1);
      assert.deepEqual(snapshot.lastOwnershipLoss, expected);
      const lossLogs = logs.filter(line => line.includes('ownership-lost'));
      assert.equal(lossLogs.length, 1);
      const fields = JSON.parse(lossLogs[0]!.slice(lossLogs[0]!.indexOf('{')));
      assert.equal(fields.reason, failure.reason);
      assert.equal(fields.storageFailure, 'storageFailure' in failure ? failure.storageFailure : undefined);
      const output = `${logs.join('\n')} ${JSON.stringify(snapshot)}`;
      for (const secret of [...sensitive.split(' '), ...f.ownerIds]) assert.equal(output.includes(secret), false, secret);
      assert.equal(output.includes('POOL_SQL_TIMEOUT'), false, 'never forwards raw error codes');
      assert.equal(output.includes('MysqlDeadlineError'), false, 'never forwards raw error names');
      f.store.claimOwner = async () => { throw new Error(sensitive); };
      const before = logs.length;
      for (let i = 0; i < 4; i++) await f.worker.tick();
      assert.equal(logs.length, before);
      assert.equal(f.worker.snapshot().ownershipLosses, 1);
    });
  }
}

test('failed initial claims mean absent LOCAL owner, not a loss or a cluster-health conclusion', async t => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (line: string) => logs.push(line));
  const f = fixture();
  t.after(() => f.worker.stop());
  f.rejectClaim();
  await f.worker.tick();
  f.store.claimOwner = async () => { throw new MysqlConnectionError(new Error(sensitive)); };
  await f.worker.tick();
  assert.equal(f.worker.snapshot().scope, 'local_process');
  assert.equal(f.worker.snapshot().state, 'standby');
  assert.equal(f.worker.snapshot().claimAttempts, 2);
  assert.equal(f.worker.snapshot().ownershipAcquisitions, 0);
  assert.equal(f.worker.snapshot().ownershipLosses, 0);
  assert.equal(f.worker.snapshot().lastOwnershipLoss, null);
  assert.deepEqual(logs, []);
  const other = fixture();
  t.after(() => other.worker.stop());
  await other.worker.tick();
  assert.equal(other.worker.snapshot().claimAttempts, 1, 'counters are not shared between workers/processes');
  assert.equal(other.worker.snapshot().state, 'owner');
  assert.equal(f.worker.snapshot().state, 'standby');
});

test('default SQLite loss remains stopped and fallback renewals do not count as claims', async t => {
  const f = fixture(false);
  delete f.store.renewOwner;
  t.after(() => f.worker.stop());
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.calls.filter(call => call === 'claim').length, 2);
  assert.equal(f.worker.snapshot().claimAttempts, 1);
  assert.equal(f.worker.snapshot().lastSuccessfulRenewalAtUnixMs, 1800000000000);
  f.rejectClaim();
  await f.worker.tick();
  assert.equal(f.worker.snapshot().state, 'stopped');
  assert.equal(f.worker.snapshot().lastOwnershipLoss?.reason, 'renewal_rejected');
  const calls = [...f.calls];
  await f.worker.tick();
  assert.deepEqual(f.calls, calls);
  assert.equal(f.worker.snapshot().ownershipLosses, 1);
});

test('pending election single-flight/stop cleanup does not count a late claim as local acquisition', async t => {
  const f = fixture();
  t.after(() => f.worker.stop());
  const gate = deferred<boolean>();
  f.store.claimOwner = () => gate.promise;
  const starting = f.worker.start();
  const ticking = f.worker.tick();
  await flush();
  assert.equal(f.worker.snapshot().state, 'standby');
  assert.equal(f.worker.snapshot().claimAttempts, 1);
  const stopping = f.worker.stop();
  assert.equal(f.worker.snapshot().state, 'stopped');
  gate.resolve(true);
  await Promise.all([starting, ticking, stopping]);
  assert.equal(f.worker.snapshot().ownershipAcquisitions, 0);
  assert.equal(f.worker.snapshot().ownershipLosses, 0);
  assert.equal(f.calls.filter(call => call === 'release').length, 1);
});

test('accepted slow renewal records response wall time but retains request-start tenure age', async t => {
  const f = fixture();
  t.after(() => f.worker.stop());
  await f.worker.tick();
  f.advance(100);
  const gate = deferred<boolean>();
  f.store.renewOwner = () => { f.calls.push('delayed-renew'); return gate.promise; };
  const ticks = [f.worker.tick(), f.worker.tick(), f.worker.tick()];
  await flush();
  assert.equal(f.worker.snapshot().lastSuccessfulRenewalAtUnixMs, null);
  f.advance(500);
  f.wall(1800000099000);
  gate.resolve(true);
  await Promise.all(ticks);
  assert.equal(f.calls.filter(call => call === 'delayed-renew').length, 1);
  assert.equal(f.worker.snapshot().lastSuccessfulRenewalAtUnixMs, 1800000099000);
  assert.equal(f.worker.snapshot().lastSuccessfulRenewalAgeMs, 0);
  assert.equal(f.worker.snapshot().localTenureAgeMs, 500);
  assert.equal(f.worker.snapshot().claimAttempts, 1);
});

test('late successful renewal cannot update diagnostics after local expiry or stop', async t => {
  for (const action of ['expire', 'stop'] as const) {
    const f = fixture();
    t.after(() => f.worker.stop());
    await f.worker.tick();
    const gate = deferred<boolean>();
    f.store.renewOwner = () => gate.promise;
    const ticking = f.worker.tick();
    await flush();
    let stopping: Promise<void> | undefined;
    if (action === 'expire') f.advance(30000);
    else stopping = f.worker.stop();
    gate.resolve(true);
    await ticking;
    await stopping;
    assert.equal(f.worker.snapshot().lastSuccessfulRenewalAtUnixMs, null, action);
    assert.equal(f.worker.snapshot().ownershipLosses, action === 'expire' ? 1 : 0, action);
    assert.equal(f.worker.snapshot().state, action === 'expire' ? 'standby' : 'stopped', action);
    if (action === 'expire') assert.equal(f.worker.snapshot().lastOwnershipLoss?.reason, 'local_tenure_expired');
  }
});
