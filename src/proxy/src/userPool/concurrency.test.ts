import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig } from './config.js';
import { UserPoolStore } from './store.js';
import { PrewarmWorker } from './worker.js';
import type { ProvisionAdapter, ProvisionContext, ProvisionPatch } from './provisioner.js';

function setup(t: TestContext, target = 20, cap = target) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const config = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
    POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: String(target), POOL_MAX_ACCOUNTS: String(cap) });
  const store = new UserPoolStore(db, config);
  const workers: PrewarmWorker[] = [];
  t.after(async () => { for (const worker of workers) await worker.stop(); db.close(); });
  const worker = (adapter: ProvisionAdapter, concurrency = 5, pollMs = 5000) => {
    const instance = new PrewarmWorker(store, adapter, pollMs, concurrency);
    workers.push(instance);
    return instance;
  };
  const rows = () => db.prepare('SELECT * FROM user_pool_accounts ORDER BY ordinal').all() as ReturnType<typeof store.inventory>[];
  const ready = (identity: string) => {
    db.prepare("UPDATE proxy_accounts SET copilot_oauth_status='valid',copilot_oauth_token=? WHERE identity=?").run(`test-${identity}`, identity);
    return { state: 'ready', stage: 'ready', verified_at: store.now() };
  };
  return { db, store, worker, rows, ready };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'condition not reached');
}

test('N=50 and idle=30 registers all 20 missing accounts but runs at most five stages', async (t) => {
  const f = setup(t, 50);
  for (let i = 0; i < 30; i++) { const row = f.store.reserve()!; f.store.update(row.identity, f.ready(row.identity)); }
  let active = 0, peak = 0;
  const steps = new Map<string, ReturnType<typeof deferred<ProvisionPatch>>>();
  const worker = f.worker({ step(row) {
    assert.equal(steps.has(row.identity), false);
    const task = deferred<ProvisionPatch>(); steps.set(row.identity, task);
    peak = Math.max(peak, ++active);
    return task.promise.finally(() => { active--; });
  } });
  await worker.start();
  await waitFor(() => steps.size === 5);
  assert.equal(f.store.counts().total, 50);
  assert.equal(f.store.counts().provisioning, 20);
  await Promise.all(Array.from({ length: 100 }, () => worker.tick()));
  assert.equal(steps.size, 5);
  assert.equal(peak, 5);
  const first = [...steps.keys()][0];
  steps.get(first)!.resolve(f.ready(first));
  await waitFor(() => steps.size === 6);
  assert.equal(active, 5, 'slot is filled without waiting for the other four steps');
  assert.equal(f.store.counts().total, 50);
  await worker.stop();
  for (const step of steps.values()) step.resolve({});
});

test('one slow stage cannot block other lanes from advancing through the full pipeline', async (t) => {
  const f = setup(t, 8);
  const slow = deferred<ProvisionPatch>();
  let first = '';
  const calls = new Map<string, number>();
  const worker = f.worker({ async step(row) {
    first ||= row.identity;
    calls.set(row.identity, (calls.get(row.identity) ?? 0) + 1);
    if (row.identity === first) return slow.promise;
    if (row.stage === 'new') return { stage: 'warmup' };
    return f.ready(row.identity);
  } }, 2);
  await worker.start();
  await waitFor(() => f.store.counts().ready_idle === 7);
  assert.equal(calls.get(first), 1);
  assert.equal(f.store.counts().provisioning, 1);
  slow.resolve(f.ready(first));
  await waitFor(() => f.store.counts().ready_idle === 8);
});

test('OAuth wait yields its lane and cannot be hot-polled by request wake storms', async (t) => {
  const f = setup(t, 3);
  let now = f.store.now(); f.store.now = () => now;
  let waiter = '', polls = 0;
  const worker = f.worker({ async step(row) {
    waiter ||= row.identity;
    if (row.identity === waiter) { polls++; return {}; }
    return f.ready(row.identity);
  } }, 1, 5000);
  await worker.start();
  await waitFor(() => f.store.counts().ready_idle === 2);
  assert.equal(polls, 1);
  await Promise.all(Array.from({ length: 100 }, () => worker.tick()));
  assert.equal(polls, 1);
  now += 5000;
  await worker.tick();
  assert.equal(polls, 2);
});

test('backoff counts as projected supply; terminal failures permit bounded replacement', (t) => {
  const f = setup(t, 5, 7);
  assert.equal(f.store.claimOwner('owner'), true);
  assert.equal(f.store.reserveDeficit('owner'), 5);
  const rows = f.rows();
  for (const row of rows.slice(0, 2)) f.store.update(row!.identity, f.ready(row!.identity));
  for (const row of rows.slice(3)) f.store.fail(row!.identity, 'service_unavailable');
  assert.equal(f.store.reserveDeficit('owner'), 0);
  assert.equal(f.store.reserveDeficit('other-owner'), 0);
  f.store.update(rows[4]!.identity, { attempts: 3 });
  assert.equal(f.store.reserveDeficit('owner'), 1);
  assert.equal(f.store.reserveDeficit('owner'), 0);
  assert.equal(f.store.counts().total, 6);
});

test('catalog exhaustion keeps existing and partially reserved tasks dispatchable', async (t) => {
  const f = setup(t, 5);
  f.db.prepare('UPDATE user_pool_settings SET next_ordinal=?').run(9998);
  const worker = f.worker({ async step(row) { return f.ready(row.identity); } });
  await worker.tick();
  assert.equal(f.store.counts().ready_idle, 2);
  await worker.tick();
  assert.equal(f.store.counts().total, 2);
});

test('due retry and OAuth polls are scheduled ahead of newly reserved accounts', (t) => {
  const f = setup(t, 3, 4);
  let now = f.store.now(); f.store.now = () => now;
  const first = f.store.reserve()!, second = f.store.reserve()!;
  f.store.update(first.identity, { stage: 'oauth-wait', retry_at: now + 100 });
  f.store.fail(second.identity, 'temporary');
  now += 31000;
  assert.equal(f.store.claimOwner('owner'), true);
  assert.equal(f.store.reserveDeficit('owner'), 1);
  assert.equal(f.store.pending()!.identity, first.identity);
  assert.equal(f.store.pending([first.identity])!.identity, second.identity);
});

test('pause stops new dispatch while active stages finish; shrink does not delete queued jobs', async (t) => {
  const f = setup(t, 6);
  const running = new Map<string, ReturnType<typeof deferred<ProvisionPatch>>>();
  const worker = f.worker({ step(row) { const step = deferred<ProvisionPatch>(); running.set(row.identity, step); return step.promise; } }, 2);
  await worker.start();
  await waitFor(() => running.size === 2);
  f.store.updateSettings(f.store.settings().version, { paused: 1, idle_target: 0, max_accounts: 1 });
  for (const [identity, step] of running) step.resolve(f.ready(identity));
  await waitFor(() => f.store.counts().ready_idle === 2);
  await worker.tick();
  assert.equal(running.size, 2);
  assert.equal(f.store.counts().total, 6);
  f.store.updateSettings(f.store.settings().version, { paused: 0 });
  void worker.tick();
  await waitFor(() => running.size === 4);
  await worker.stop();
  for (const step of running.values()) step.resolve({});
});

test('owner loss aborts all lanes and fences late results', async (t) => {
  const f = setup(t, 5);
  const contexts: ProvisionContext[] = [];
  const tasks: ReturnType<typeof deferred<ProvisionPatch>>[] = [];
  const worker = f.worker({ step(_row, context) {
    contexts.push(context); const step = deferred<ProvisionPatch>(); tasks.push(step); return step.promise;
  } });
  await worker.start();
  await waitFor(() => contexts.length === 5);
  f.db.prepare("UPDATE user_pool_settings SET owner='replacement-owner'").run();
  await worker.tick();
  assert.equal(worker.isActive(), false);
  await worker.stop();
  assert.ok(contexts.every(context => context.signal.aborted));
  for (const task of tasks) task.resolve({ state: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.counts().ready_idle, 0);
});

test('stopped concurrent stages resume their individual persisted checkpoints after restart', async (t) => {
  const f = setup(t, 3);
  const tasks: ReturnType<typeof deferred<ProvisionPatch>>[] = [];
  const first = f.worker({ async step(row, context) {
    await context.checkpoint({ stage: 'oauth-dispatch', oauth_attempt_id: `nonce-${row.ordinal}` });
    const task = deferred<ProvisionPatch>(); tasks.push(task); return task.promise;
  } }, 3);
  await first.start();
  await waitFor(() => tasks.length === 3);
  await first.stop();
  const second = f.worker({ async step(row) {
    assert.equal(row.stage, 'oauth-dispatch');
    assert.equal(row.oauth_attempt_id, `nonce-${row.ordinal}`);
    return f.ready(row.identity);
  } }, 3);
  await second.tick();
  assert.equal(f.store.counts().ready_idle, 3);
  for (const task of tasks) task.resolve({ stage: 'new' });
});
