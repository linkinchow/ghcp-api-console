import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpApiError } from '@ghcp/shared';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig } from './config.js';
import { UserPoolStore } from './store.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';
import { ProvisionFailure, type ProvisionAdapter, type ProvisionContext, type ProvisionInventory } from './provisioner.js';

function fixture(target = 2) {
  let owner = '';
  let claims = 0;
  let paused = 0;
  const rows = new Map<string, ProvisionInventory>();
  const holds = new Set<string>();
  const leased = new Set<string>();
  const events: string[] = [];
  const failures: string[] = [];
  const store: PrewarmStore & { reserve(): ProvisionInventory | undefined } = {
    now: () => Date.now(),
    claimOwner: (next) => {
      claims++;
      if (owner && owner !== next) return false;
      owner = next;
      return true;
    },
    releaseOwner: (expected) => { if (owner === expected) owner = ''; },
    reclaim: () => {},
    settings: () => ({ version: 1, idle_target: target, max_accounts: 20, lease_seconds: 600, paused }),
    hasHolds: (identity) => holds.has(identity),
    inventory: (identity) => { const row = rows.get(identity); return row && { ...row }; },
    pending: (excluded = []) => [...rows.values()].filter((row) => !excluded.includes(row.identity))
      .sort((a, b) => a.retry_at - b.retry_at || a.updated_at - b.updated_at || a.ordinal - b.ordinal)
      .find((row) => row.retry_at <= Date.now()
        && (row.state === 'provisioning' || row.state === 'failed' && row.attempts < 3) && !holds.has(row.identity)),
    reserveDeficit: (expectedOwner) => {
      if (owner !== expectedOwner) return 0;
      let count = 0;
      while (store.reserve()) count++;
      return count;
    },
    reserve: () => {
      const ready = [...rows.values()].filter((row) => row.state === 'ready' && !leased.has(row.identity)).length;
      const provisioning = [...rows.values()].filter((row) => row.state === 'provisioning' || row.state === 'failed' && row.attempts < 3).length;
      if (paused || ready + provisioning >= target || rows.size >= 20) return undefined;
      const identity = `member-${rows.size}`;
      const row: ProvisionInventory = {
        identity, ordinal: rows.size, state: 'provisioning', stage: 'new', attempt_id: `attempt-${identity}`,
        task_id: null, attempts: 0, retry_at: Date.now(), last_error: null, updated_at: Date.now(),
        cooldown_until: 0, verified_at: null, generation: 0, sso_created_at: null, oauth_attempt_id: null,
      };
      rows.set(identity, row);
      return { ...row };
    },
    update: (identity, patch, attempt, expectedOwner) => {
      const row = rows.get(identity);
      if (!row || row.state === 'disabled' || (typeof attempt === 'string' ? attempt !== row.attempt_id
        : attempt?.attempt_id !== row.attempt_id || attempt.generation !== row.generation) || owner !== expectedOwner) return false;
      Object.assign(row, patch, { updated_at: Date.now() });
      return true;
    },
    fail: (identity, code, attempt, expectedOwner) => {
      const row = rows.get(identity);
      if (!row || row.state === 'disabled' || (typeof attempt === 'string' ? attempt !== row.attempt_id
        : attempt?.attempt_id !== row.attempt_id || attempt.generation !== row.generation) || owner !== expectedOwner) return;
      failures.push(code);
      row.state = 'failed';
      row.attempts++;
      row.last_error = code;
      row.retry_at = Date.now() + 30000 * 2 ** (row.attempts - 1);
    },
    event: (action) => { events.push(action); },
  };
  return { store, rows, holds, leased, events, failures, claims: () => claims,
    stealOwner: () => { owner = 'other'; }, owner: () => owner, pause: () => { paused = 1; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('serial reconciliation fills only the READY_IDLE deficit and replenishes a leased member', async () => {
  const f = fixture(3);
  let active = 0;
  let peak = 0;
  const stages = ['new', 'sso-created', 'scim-synced', 'synced', 'oauth-wait', 'warmup', 'ready'];
  const worker = new PrewarmWorker(f.store, { async step(row) {
    active++;
    peak = Math.max(peak, active);
    await flush();
    active--;
    const stage = stages[stages.indexOf(row.stage) + 1]!;
    return stage === 'ready' ? { stage, state: 'ready', verified_at: Date.now() } : { stage };
  } }, 60000, 1);
  for (let i = 0; i < 25; i++) await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
  assert.equal(peak, 1);
  assert.equal(f.rows.size, 3);
  assert.equal([...f.rows.values()].every((row) => row.state === 'ready'), true);
  assert.equal(f.events.filter((event) => event === 'account_ready').length, 3);
  f.leased.add('member-0');
  for (let i = 0; i < 8; i++) await worker.tick();
  assert.equal(f.rows.size, 4);
  await worker.stop();
});

test('poll interval is not capped at five seconds; owner heartbeat is independent', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(1);
  let calls = 0;
  const worker = new PrewarmWorker(f.store, { async step() { calls++; return {}; } }, 60000);
  worker.start();
  await worker.tick();
  const claims = f.claims();
  const eligibilityClock = Date.now();
  f.store.now = () => eligibilityClock;
  t.mock.timers.tick(55000);
  await flush();
  assert.equal(calls, 1);
  assert.ok(f.claims() > claims + 5);
  f.rows.get('member-0')!.retry_at = 0;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(calls, 2);
  await worker.stop();
});

test('readiness detects a lost worker owner before the next scheduled heartbeat', async () => {
  const f = fixture(0);
  const worker = new PrewarmWorker(f.store, { async step() { return {}; } }, 60000);
  worker.start();
  assert.equal(worker.isActive(), true);
  f.stealOwner();
  assert.equal(worker.isActive(), false);
  await worker.stop();
  assert.equal(worker.isActive(), false);
});

test('ownership stays renewed during slow external work', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(1);
  const external = deferred<{}>();
  const worker = new PrewarmWorker(f.store, { step: () => external.promise }, 60000);
  worker.start();
  const claims = f.claims();
  t.mock.timers.tick(45000);
  await flush();
  assert.ok(f.claims() > claims + 5);
  external.resolve({});
  await worker.tick();
  assert.equal(f.failures.length, 0);
  await worker.stop();
});

test('stop aborts bounded work and ignores an uncooperative late result', async () => {
  const f = fixture(1);
  const external = deferred<{ state: string }>();
  let context!: ProvisionContext;
  const worker = new PrewarmWorker(f.store, { step: (_row, ctx) => { context = ctx; return external.promise; } }, 60000);
  const running = worker.tick();
  await flush();
  await worker.stop();
  await running;
  assert.equal(context.signal.aborted, true);
  assert.equal(f.owner(), '');
  external.resolve({ state: 'ready' });
  await flush();
  assert.equal(f.rows.get('member-0')!.state, 'provisioning');
  assert.equal(f.failures.length, 0);
  assert.throws(() => context.checkpoint({ state: 'ready' }));
});

test('shutdown immediately after a scheduled tick cannot reserve or dispatch work', async () => {
  const f = fixture(1);
  let dispatched = false;
  const worker = new PrewarmWorker(f.store, { async step() { dispatched = true; return {}; } }, 60000);
  void worker.tick();
  await worker.stop();
  assert.equal(dispatched, false);
  assert.equal(f.rows.size, 0);
});

test('deadline bounds an uncooperative adapter and records only a sanitized failure', async () => {
  const f = fixture(1);
  const worker = new PrewarmWorker(f.store, {
    stepTimeoutMs: 15, step: () => new Promise(() => {}),
  }, 60000);
  // Keep a ref while testing the deliberately unref'd production timer.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await worker.tick();
    assert.deepEqual(f.failures, ['provision_timeout']);
  } finally {
    clearTimeout(keepAlive);
    await worker.stop();
  }
});

test('ownership loss aborts external work and fences late success/failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(1);
  const external = deferred<{ state: string }>();
  let context!: ProvisionContext;
  const worker = new PrewarmWorker(f.store, { step: (_row, ctx) => { context = ctx; return external.promise; } }, 60000);
  worker.start();
  await flush();
  f.stealOwner();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(context.signal.aborted, true);
  external.resolve({ state: 'ready' });
  await flush();
  assert.equal(f.rows.get('member-0')!.state, 'provisioning');
  assert.equal(f.failures.length, 0);
  await worker.stop();
  assert.equal(f.owner(), 'other');
});

test('operator disable and retry fence a prior attempt even when the same member is reused', async () => {
  const f = fixture(1);
  const external = deferred<{ state: string }>();
  const worker = new PrewarmWorker(f.store, { step: () => external.promise }, 60000);
  const running = worker.tick();
  await flush();
  const row = f.rows.get('member-0')!;
  row.state = 'provisioning';
  row.attempt_id = 'new-operator-attempt';
  external.resolve({ state: 'ready' });
  await running;
  assert.equal(row.state, 'provisioning');
  assert.deepEqual(f.failures, []);
  await worker.stop();
});

test('disable during external work cannot be undone by a late success', async () => {
  const f = fixture(1);
  const external = deferred<{ state: string }>();
  const worker = new PrewarmWorker(f.store, { step: () => external.promise }, 60000);
  const running = worker.tick();
  await flush();
  const row = f.rows.get('member-0')!;
  row.state = 'disabled';
  external.resolve({ state: 'ready' });
  await running;
  assert.equal(row.state, 'disabled');
  assert.deepEqual(f.failures, []);
  await worker.stop();
});

test('credential generation changes fence a successful warmup, including ABA token replacement', async () => {
  const f = fixture(1);
  const external = deferred<{ state: string; stage: string }>();
  const worker = new PrewarmWorker(f.store, { step: (_row, context) => {
    context.pinCredentials();
    return external.promise;
  } }, 60000);
  const running = worker.tick();
  await flush();
  const row = f.rows.get('member-0')!;
  row.generation += 2;
  external.resolve({ state: 'ready', stage: 'ready' });
  await running;
  assert.equal(row.state, 'provisioning');
  assert.equal(f.failures.length, 0);
  assert.equal(f.events.length, 0);
  await worker.stop();
});

test('late warmup rejection cannot consume a replacement credential retry budget', async () => {
  const f = fixture(1);
  const external = deferred<{}>();
  const worker = new PrewarmWorker(f.store, { async step(_row, context) {
    context.pinCredentials();
    await external.promise;
    throw new Error('old request failed');
  } }, 60000);
  const running = worker.tick();
  await flush();
  const row = f.rows.get('member-0')!;
  row.attempts = 2;
  row.generation += 2;
  external.resolve({});
  await running;
  assert.equal(row.attempts, 2);
  assert.equal(row.state, 'provisioning');
  assert.equal(f.failures.length, 0);
  await worker.stop();
});

test('never reauthorizes an in-flight held member, even if pending returns it', async () => {
  const f = fixture(1);
  const row = f.store.reserve()!;
  row.state = 'failed';
  row.stage = 'ready';
  f.rows.set(row.identity, row);
  f.holds.add(row.identity);
  f.store.pending = () => ({ ...row });
  let calls = 0;
  const worker = new PrewarmWorker(f.store, { async step() { calls++; return {}; } }, 60000);
  await worker.tick();
  assert.equal(calls, 0);
  assert.equal(row.state, 'failed');
  await worker.stop();
});

test('failures are bounded by retry count/backoff and secret messages are never persisted', async () => {
  const f = fixture(1);
  let calls = 0;
  const errors = [new Error('secret-password'), new HttpApiError(503, 'sensitive', 'secret-token'), new ProvisionFailure('unsafe secret')];
  const worker = new PrewarmWorker(f.store, { async step() { throw errors[calls++]; } }, 60000);
  await worker.tick();
  const row = f.rows.get('member-0')!;
  assert.equal(row.attempts, 1);
  assert.ok(row.retry_at > Date.now());
  f.pause(); // Preserve the failed row while preventing replacement reservations.
  f.store.settings = () => ({ version: 1, idle_target: 1, max_accounts: 1, lease_seconds: 600, paused: 0 });
  await worker.tick();
  assert.equal(calls, 1);
  for (let i = 0; i < 2; i++) { row.retry_at = 0; await worker.tick(); }
  row.retry_at = 0;
  await worker.tick();
  assert.equal(calls, 3);
  assert.equal(row.attempts, 3);
  assert.deepEqual(f.failures, ['service_unavailable', 'service_http_503', 'service_unavailable']);
  await worker.stop();
});

test('terminal ambiguity is quarantined immediately; paused pool has no side effects', async () => {
  const f = fixture(1);
  const adapter: ProvisionAdapter = { async step() { throw new ProvisionFailure('sso_creation_ambiguous', true); } };
  const worker = new PrewarmWorker(f.store, adapter, 60000);
  await worker.tick();
  assert.equal(f.rows.get('member-0')!.attempts, 3);
  f.pause();
  await worker.tick();
  assert.equal(f.rows.size, 1);
  assert.equal(f.failures.length, 1);
  await worker.stop();
});

test('restart resumes the persisted checkpoint, not the previously selected stage', async () => {
  const f = fixture(1);
  const external = deferred<{}>();
  const first = new PrewarmWorker(f.store, { step: (_row, context) => {
    context.checkpoint({ stage: 'oauth-dispatch', oauth_attempt_id: 'oauth-nonce' });
    return external.promise;
  } }, 60000);
  void first.tick();
  await flush();
  await first.stop();
  const second = new PrewarmWorker(f.store, { async step(row) {
    assert.equal(row.stage, 'oauth-dispatch');
    assert.equal(row.oauth_attempt_id, 'oauth-nonce');
    return { stage: 'oauth-wait', task_id: 'recovered-task' };
  } }, 60000);
  await second.tick();
  assert.equal(f.rows.get('member-0')!.task_id, 'recovered-task');
  await second.stop();
  external.resolve({});
});

test('SQLite persists worker intents across recreation and excludes live holds during credential repair', async (t) => {
  const db = new BetterSqlite3(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const options = readPoolConfig({
    ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test',
    POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '1',
  });
  const store = new UserPoolStore(db, options);
  const external = deferred<{}>();
  const first = new PrewarmWorker(store, { step: (_row, context) => {
    context.checkpoint({ stage: 'oauth-dispatch', oauth_attempt_id: 'persisted-oauth', sso_created_at: 'sso-creation-marker' });
    return external.promise;
  } }, 60000);
  void first.tick();
  await flush();
  await first.stop();
  const reopened = new UserPoolStore(db, options);
  let calls = 0;
  let identity = '';
  const second = new PrewarmWorker(reopened, { async step(row, context) {
    calls++;
    identity = row.identity;
    assert.equal(row.stage, 'oauth-dispatch');
    assert.equal(row.oauth_attempt_id, 'persisted-oauth');
    assert.equal(row.sso_created_at, 'sso-creation-marker');
    db.prepare("UPDATE proxy_accounts SET copilot_oauth_status = 'valid', copilot_oauth_token = 'test-token' WHERE identity = ?")
      .run(row.identity);
    context.pinCredentials();
    return { state: 'ready', stage: 'ready', verified_at: store.now() };
  } }, 60000);
  await second.tick();
  assert.equal(reopened.counts().ready_idle, 1);
  const held = reopened.acquire(`sha256:${'a'.repeat(64)}`);
  db.prepare("UPDATE proxy_accounts SET copilot_oauth_status = 'expired' WHERE identity = ?").run(identity);
  await second.tick();
  assert.equal(calls, 1);
  const row = reopened.inventory(identity)!;
  assert.equal(row.state, 'failed');
  db.prepare('UPDATE user_pool_accounts SET retry_at = 0 WHERE identity = ?').run(identity);
  await second.tick();
  assert.equal(calls, 1);
  assert.equal(reopened.hasHolds(identity), true);
  reopened.finish(held, false);
  assert.equal(reopened.hasHolds(identity), false);
  await second.stop();
  external.resolve({});
});

test('an incompatible store cannot silently discard an intent checkpoint and dispatch work', async () => {
  const f = fixture(1);
  const update = f.store.update;
  f.store.update = (identity, patch, attempt, owner) => {
    const { oauth_attempt_id: _ignored, ...supported } = patch;
    return update(identity, supported, attempt, owner);
  };
  let dispatched = false;
  const worker = new PrewarmWorker(f.store, { async step(_row, context) {
    context.checkpoint({ stage: 'oauth-dispatch', oauth_attempt_id: 'must-persist' });
    dispatched = true;
    return {};
  } }, 60000);
  await worker.tick();
  assert.equal(dispatched, false);
  assert.equal(f.rows.get('member-0')!.attempts, 3);
  assert.deepEqual(f.failures, ['provision_storage_incompatible']);
  await worker.stop();
});
