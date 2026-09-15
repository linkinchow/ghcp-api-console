import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import { createPool } from 'mysql2/promise';
import type { LoginTaskDto, SsoUserDto } from '@ghcp/shared';
import type { Awaitable, PoolStore } from './storage.js';
import type { Inventory } from './store.js';
import type { PrewarmStore, PrewarmWorker as Worker } from './worker.js';

// Capture explicit shell opt-in before importing anything that could load dotenv.
const mysqlUrl = process.env.MYSQL_TEST_URL;
const mysqlDisposable = process.env.MYSQL_POOL_TEST_DISPOSABLE;
const mysqlEnabled = Boolean(mysqlUrl) && mysqlDisposable === '1';
const savedEnv = { ...process.env };
const { SqliteStorage, MysqlStorage, readPoolConfig, realProvisioner, PrewarmWorker } = await (async () => {
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, {
      DOTENV_CONFIG_PATH: join(tmpdir(), `login-polling-recovery-no-env-${randomUUID()}`, '.env'),
      STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', ACCOUNT_ROUTING_MODE: 'direct',
      INTERNAL_API_TOKEN: 'synthetic-only', API_KEY: 'synthetic-only',
      SSO_BASE_URL: 'http://sso.polling-recovery.invalid', LOGIN_BASE_URL: 'http://login.polling-recovery.invalid',
      COPILOT_API_BASE_URL: 'http://copilot.polling-recovery.invalid', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
    });
    const [sqlite, mysql, config, provisioner, worker] = await Promise.all([
      import('../db/sqliteStorage.js'), import('../db/mysqlStorage.js'), import('./config.js'),
      import('./provisioner.js'), import('./worker.js'),
    ]);
    return { SqliteStorage: sqlite.SqliteStorage, MysqlStorage: mysql.MysqlStorage,
      readPoolConfig: config.readPoolConfig, realProvisioner: provisioner.realProvisioner, PrewarmWorker: worker.PrewarmWorker };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
})();

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => Awaitable<boolean>, message: string) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(1); // Real I/O yield; elapsed time, not query count, bounds the wait.
  }
  assert.fail(message);
}

type Driver = 'sqlite' | 'mysql';
type ReadMode = '503' | 'reject' | '404' | 'task';

async function fixture(t: TestContext, driver: Driver) {
  const cleanup: (() => Awaitable<void>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Polling recovery fixture cleanup failed');
  });
  const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', STORAGE_DRIVER: driver,
    POOL_ACCOUNT_EMAIL_DOMAIN: 'polling-recovery.test', POOL_WARMUP_MODEL: 'synthetic',
    READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '7', POOL_LOGIN_MAX_PENDING: '1', PREWARM_POLL_SECONDS: '1' });
  let mysqlDb: ReturnType<typeof createPool> | undefined;
  let storage: InstanceType<typeof SqliteStorage> | InstanceType<typeof MysqlStorage>;
  if (driver === 'sqlite') {
    storage = new SqliteStorage(':memory:', 100);
    cleanup.push(() => storage.close());
  } else {
    // No default DB, remote address, URL options, or caller-named database is ever used.
    // The supplied disposable URL is only a credentials source for a fresh random DB.
    assert.equal(mysqlDisposable, '1');
    const url = new URL(mysqlUrl!);
    assert.equal(url.protocol, 'mysql:');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'MySQL must be strict loopback');
    assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
    assert.equal(url.search + url.hash, '');
    url.pathname = '/';
    const admin = createPool({ uri: url.toString(), connectionLimit: 1, connectTimeout: 5000 });
    cleanup.push(() => admin.end());
    const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    url.pathname = '/' + database;
    mysqlDb = createPool({ uri: url.toString(), connectionLimit: 4, connectTimeout: 5000,
      dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    storage = new MysqlStorage(mysqlDb, 100);
    cleanup.push(async () => {
      try { await storage.close(); }
      finally { await admin.query(`DROP DATABASE \`${database}\``); }
    });
  }
  await storage.initialize();
  const store: PoolStore = await storage.userPool(options);
  let now = await store.now(), monotonicNow = 0;
  if (driver === 'sqlite') store.now = () => now;
  const cadence = () => monotonicNow;
  const later = async <T>(operation: () => Awaitable<T>): Promise<T> => { await yieldTurn(); return operation(); };
  // Same asynchronous SQLite boundary as scheduling.worker.test.ts. These delegates
  // do not fake pending selection, reservation enumeration/release, or credential fences.
  const asyncStore: PrewarmStore = {
    now: () => later(() => store.now()),
    claimOwner: owner => later(() => store.claimOwner(owner)),
    renewOwner: owner => later(() => store.renewOwner(owner)),
    releaseOwner: owner => later(() => store.releaseOwner(owner)),
    reclaim: () => later(() => store.reclaim()),
    settings: () => later(() => store.settings()),
    reserveDeficit: owner => later(() => store.reserveDeficit(owner)),
    pending: excluded => later(() => store.pending(excluded)),
    hasHolds: id => later(() => store.hasHolds(id)),
    inventory: id => later(() => store.inventory(id)),
    update: (...args) => later(() => store.update(...args)),
    fail: (...args) => later(() => store.fail(...args)),
    event: (...args) => later(() => store.event(...args)),
    mutateWorkerCredential: (...args) => later(() => store.mutateWorkerCredential(...args)),
    claimLoginDispatch: (...args) => later(() => store.claimLoginDispatch(...args)),
    listLoginReservations: () => later(() => store.listLoginReservations()),
    releaseLoginReservation: (...args) => later(() => store.releaseLoginReservation(...args)),
  };
  const users = new Map<string, SsoUserDto>(), tasks = new Map<string, LoginTaskDto>();
  const posted: LoginTaskDto[] = [], requests: string[] = [], unexpected: string[] = [];
  const forbiddenCalls: string[] = [], mockErrors: unknown[] = [];
  const transportRejection = new TypeError('synthetic task GET transport rejection');
  const recordMock = async <T>(operation: () => Awaitable<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error !== transportRejection) mockErrors.push(error);
      throw error;
    }
  };
  const postsPerAttempt = new Map<string, number>();
  const ordinary = new Set<string>(), observations = new Set<string>();
  const reads: { identity: string; lane: 'ordinary' | 'observer'; at: number }[] = [];
  const gates = new Set<ReturnType<typeof deferred>>();
  let readMode: ReadMode = 'task';
  let readGate: ReturnType<typeof deferred> | undefined;
  let reply: Partial<LoginTaskDto> = {};
  let primary: string | undefined;
  let worker: Worker;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const adapter = realProvisioner(asyncStore, options, {
    getAccount: id => storage.getAccount(id),
    fetch: (input, init) => recordMock(async () => {
      // All transport is synthetic; there is no delegation to global fetch.
      await yieldTurn();
      const url = new URL(String(input)), method = init?.method ?? 'GET';
      requests.push(`${method} ${url.pathname}`);
      const body = () => JSON.parse(String(init?.body));
      if (url.pathname === '/api/users' && method === 'POST') {
        const request = body() as { ssoUser: string };
        assert.ok(!users.has(request.ssoUser), 'never recreate an SSO identity');
        assert.equal((await store.inventory(request.ssoUser))!.stage, 'sso-creating');
        assert.deepEqual(request, { ssoUser: request.ssoUser, email: `${request.ssoUser}@${options.accountDomain}`,
          role: 'user', poolManaged: true });
        const stamp = new Date(await store.now()).toISOString();
        const user: SsoUserDto = { ssoUser: request.ssoUser, email: `${request.ssoUser}@${options.accountDomain}`,
          role: 'user', emuStatus: 'not_synced', copilotSeatStatus: 'unassigned', createdAt: stamp, updatedAt: stamp };
        users.set(user.ssoUser, user);
        return json(user);
      }
      if (url.pathname === '/api/users/batch' && method === 'POST') {
        const request = body() as { ssoUsers: string[] };
        assert.equal(request.ssoUsers.length, 1);
        const user = users.get(request.ssoUsers[0]!)!;
        assert.ok(user);
        assert.equal(user.emuStatus, 'not_synced', 'never repeat SCIM create');
        assert.deepEqual(request, { operation: 'sync_emu', ssoUsers: [user.ssoUser], assignCopilotSeat: false, createOnly: true });
        Object.assign(user, { ghLogin: `${user.ssoUser}_emu`, ghScimId: `synthetic-${user.ssoUser}`, emuStatus: 'active' });
        return json({ rows: [{ ssoUser: user.ssoUser, status: 'success', user }] });
      }
      if (url.pathname.startsWith('/api/users/')) {
        const id = decodeURIComponent(url.pathname.split('/')[3]!);
        const user = users.get(id);
        if (url.pathname === `/api/users/${id}` && method === 'GET') return user ? json(user) : json({}, 404);
        assert.ok(user);
        if (url.pathname === `/api/users/${id}/copilot-seat` && method === 'POST') {
          assert.equal(user.copilotSeatStatus, 'unassigned', 'never repeat seat assignment');
          user.copilotSeatStatus = 'assigned';
          return json(user);
        }
        if (url.pathname === `/api/users/${id}/login-credentials` && method === 'POST') {
          assert.deepEqual(body(), { expectedCreatedAt: user.createdAt, expectedEmail: user.email });
          return json({ user, passwordForLogin: 'synthetic-password' });
        }
      }
      if (url.pathname === '/api/tasks' && method === 'POST') {
        const request = body() as { identity: string; oauthAttemptId: string };
        const row = (await store.inventory(request.identity))!, user = users.get(row.identity)!;
        assert.equal(row.stage, 'oauth-dispatch', 'real capacity transaction precedes Login POST');
        assert.deepEqual(request, { identity: row.identity, ssoUser: row.identity, ghLogin: user.ghLogin,
          oauthAttemptId: row.oauth_attempt_id, ssoType: 'custom', ssoPassword: 'synthetic-password' });
        const account = await storage.getAccount(row.identity);
        assert.equal(account?.copilotOauthAttemptId, request.oauthAttemptId);
        assert.equal(account?.copilotOauthStatus, 'refreshing');
        const count = (postsPerAttempt.get(request.oauthAttemptId) ?? 0) + 1;
        postsPerAttempt.set(request.oauthAttemptId, count);
        assert.equal(count, 1, 'Login POST is not idempotent: never repeat a nonce');
        const task: LoginTaskDto = { id: randomUUID(), identity: row.identity, ssoUser: row.identity,
          ghLogin: user.ghLogin, oauthAttemptId: request.oauthAttemptId, ssoType: 'custom', status: 'running',
          attempts: 1, createdAt: new Date(await store.now()).toISOString() };
        tasks.set(task.id, task); posted.push(task);
        return json(task);
      }
      if (url.pathname.startsWith('/api/tasks/') && method === 'GET') {
        const task = tasks.get(decodeURIComponent(url.pathname.slice('/api/tasks/'.length)));
        assert.ok(task, 'poll only a task from a real accepted POST');
        assert.notEqual(ordinary.has(task.identity), observations.has(task.identity), 'read belongs to exactly one lane');
        reads.push({ identity: task.identity, lane: ordinary.has(task.identity) ? 'ordinary' : 'observer', at: cadence() });
        if (task.identity === primary) {
          const gate = readGate;
          if (gate) await gate.promise;
          if (readMode === 'reject') throw transportRejection;
          if (readMode !== 'task') return json({ error: 'synthetic task read unavailable' }, Number(readMode));
          return json({ ...task, ...reply });
        }
        return json(task);
      }
      unexpected.push(`${method} ${url.pathname}`);
      throw new Error('Unexpected synthetic request');
    }),
    async resolveModel() {
      forbiddenCalls.push('resolveModel');
      assert.fail('failed/disabled members must never implicitly warm up');
    },
    async executeRequest() {
      forbiddenCalls.push('executeRequest');
      assert.fail('no real Copilot request permitted');
    },
  });
  worker = new PrewarmWorker(asyncStore, { ...adapter,
    async step(row, context) {
      await recordMock(() => assert.equal(ordinary.size, 0, 'ordinary concurrency is exactly one'));
      ordinary.add(row.identity);
      try { return await adapter.step(row, context); }
      finally { ordinary.delete(row.identity); }
    },
    async reconcileLoginReservation(row, context) {
      await recordMock(() => {
        assert.ok(!ordinary.has(row.identity));
        assert.ok(observations.size < 10, 'respect the bounded terminal-observer batch');
      });
      observations.add(row.identity);
      try { return await adapter.reconcileLoginReservation!(row, context); }
      finally { observations.delete(row.identity); }
    },
  }, options.pollMs, 1, cadence, { multiReplica: driver === 'mysql' });
  // Resolve synthetic gates before stopping; no held fake transport survives cleanup.
  cleanup.push(async () => { for (const gate of gates) gate.resolve(); await worker.stop(); });
  const tick = async (drain = true) => {
    await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
    if (drain) await worker.waitForObservations();
    assert.ok(worker.isActive(), 'injected monotonic time must not expire ownership');
  };
  const drive = async (predicate: () => Awaitable<boolean>, message: string) => {
    for (let turn = 0; turn < 100 && !await predicate(); turn++) await tick(false);
    assert.ok(await predicate(), message);
  };
  const advance = async (milliseconds = options.pollMs) => {
    // SQLite uses simulated DB/wall time. Every <=1s increment includes real owner
    // renewal. MySQL retains actual DB time; only observer cadence is simulated.
    for (let remaining = milliseconds; remaining > 0;) {
      const elapsed = Math.min(options.pollMs, remaining);
      monotonicNow += elapsed;
      if (driver === 'sqlite') now += elapsed;
      remaining -= elapsed;
      await tick();
    }
  };
  const row = async (identity = primary!) => (await store.inventory(identity))!;
  const protectedFields = (item: Inventory) => ({ state: item.state, attempts: item.attempts,
    attempt_id: item.attempt_id, last_error: item.last_error, retry_at: item.retry_at, verified_at: item.verified_at });
  const assertPollSpacing = () => {
    const observerReads = reads.filter(read => read.lane === 'observer' && read.identity === primary);
    for (let n = 1; n < observerReads.length; n++) {
      assert.ok(observerReads[n]!.at - observerReads[n - 1]!.at >= options.pollMs,
        'terminal observations are poll-limited, not completion-triggered busy loops');
    }
  };
  const reserveStarters = async (count: number) => {
    let settings = await store.settings();
    settings = await store.updateSettings(settings.version, { idle_target: 7 });
    const identities: string[] = [];
    for (let n = 0; n < count; n++) {
      const member = await store.reserve();
      assert.ok(member);
      identities.push(member.identity);
    }
    await store.updateSettings(settings.version, { idle_target: 0 });
    return identities;
  };
  return { store, storage, options, worker, posted, users, requests, reads, ordinary, observations,
    tick, drive, advance, row, protectedFields, unexpected, forbiddenCalls, mockErrors, postsPerAttempt, reserveStarters, assertPollSpacing,
    setRead(mode: ReadMode, patch: Partial<LoginTaskDto> = {}) { readMode = mode; reply = patch; },
    holdRead() { readGate = deferred(); gates.add(readGate); return readGate; },
    releaseRead() { readGate?.resolve(); readGate = undefined; },
    async start() {
      await drive(async () => posted.length === 1 && (await row(posted[0]!.identity)).stage === 'oauth-wait',
        'normal SSO, SCIM, seat and Login dispatch must complete');
      primary = posted[0]!.identity;
      assert.equal((await row()).attempts, 0);
      // One pending member demonstrates ordinary-lane blocking. Reserve the remaining
      // five only after exhaustion so observer independence cannot pass vacuously.
      return reserveStarters(1);
    },
    async retryDue() {
      const failed = await row();
      assert.equal(failed.state, 'failed');
      assert.ok(failed.attempts < 3);
      assert.ok(failed.retry_at > await store.now(), 'real failure transaction sets backoff');
      if (mysqlDb) {
        // Explicit fast-forward of this fixture's retry only, inside its random test DB.
        // This tests due selection/recovery, not real-time 30s/60s backoff duration.
        await mysqlDb.execute('UPDATE user_pool_accounts SET retry_at=0 WHERE identity=? AND attempt_id=?',
          [failed.identity, failed.attempt_id]);
        await advance();
      } else await advance(failed.retry_at - now);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function exhaust(f: Fixture, mode: '503' | 'reject') {
  const others = await f.start();
  f.setRead(mode);
  f.holdRead();
  const pendingTick = f.tick(false);
  await until(() => f.reads.length === 1, 'normal oauth-wait must reach the held task GET');
  assert.equal(f.reads[0]!.lane, 'ordinary');
  const before = f.requests.length;
  await f.tick(false);
  assert.equal(f.requests.length, before, 'normal blocked task polling occupies the only ordinary lane');
  assert.equal(f.ordinary.size, 1);
  assert.equal(f.observations.size, 0);
  f.releaseRead();
  await pendingTick;
  for (let attempts = 1; attempts <= 3; attempts++) {
    await f.drive(async () => (await f.row()).attempts === attempts, `task GET error must charge attempt ${attempts}`);
    const row = await f.row();
    assert.equal(row.state, 'failed');
    assert.equal(row.last_error, mode === '503' ? 'login_http_503' : 'service_unavailable');
    assert.equal(row.stage, 'oauth-wait');
    assert.equal(row.task_id, f.posted[0]!.id);
    assert.equal(row.oauth_attempt_id, f.posted[0]!.oauthAttemptId);
    assert.equal(f.posted.length, 1);
    if (attempts < 3) await f.retryDue();
  }
  await f.worker.waitForObservations();
  assert.equal(f.reads.filter(read => read.lane === 'ordinary' && read.identity === f.posted[0]!.identity).length, 3);
  assert.equal((await f.store.listLoginReservations()).length, 1, 'exhaustion remains persistently reserved');
  return others;
}

async function assertNoRetry(f: Fixture, protectedRow: Inventory) {
  assert.deepEqual(f.protectedFields(await f.row()), f.protectedFields(protectedRow));
  assert.equal(f.posted.filter(task => task.identity === protectedRow.identity).length, 1);
  assert.ok([...f.postsPerAttempt.values()].every(count => count === 1));
  assert.equal((await f.store.counts()).ready_idle, 0);
  f.assertPollSpacing();
  assert.deepEqual(f.unexpected, []);
  assert.deepEqual(f.forbiddenCalls, [], 'worker/observer cannot swallow forbidden warmup calls');
  assert.deepEqual(f.mockErrors, [], 'synthetic transport assertions must not become ordinary retry failures');
}

for (const driver of ['sqlite', 'mysql'] as const) {
  for (const scenario of ['failed-read-503', 'disabled-read-rejection', 'success-callback-race'] as const) {
    test(`${driver}: exhausted Login polling recovery / ${scenario}`,
      { timeout: 45000, skip: driver === 'mysql' && !mysqlEnabled ? 'requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1' : false }, async t => {
        const f = await fixture(t, driver);
        const others = await exhaust(f, scenario === 'disabled-read-rejection' ? 'reject' : '503');
        if (scenario === 'disabled-read-rejection') await f.store.disable(f.posted[0]!.identity);
        const protectedRow = await f.row();
        assert.equal(protectedRow.attempts, 3);
        assert.equal(protectedRow.state, scenario === 'disabled-read-rejection' ? 'disabled' : 'failed');

        // Delayed exhausted-task GET is independent of ordinary lanes. Five NEW
        // members plus the ordinary-lane witness must reach blocked oauth-starting.
        const fresh = await f.reserveStarters(5);
        others.push(...fresh);
        for (const identity of fresh) {
          assert.equal((await f.row(identity)).stage, 'new');
          assert.ok(!f.users.has(identity), 'fresh starter has no SSO identity before observation');
        }
        f.setRead('task', { status: 'running' });
        f.holdRead();
        const observerBefore = f.reads.filter(read => read.lane === 'observer').length;
        // Advance cadence without awaiting the intentionally held observation batch.
        const observing = f.advance();
        await until(() => f.reads.filter(read => read.lane === 'observer').length > observerBefore,
          'exhausted member must enter independent terminal observer');
        assert.equal(f.reads.at(-1)!.lane, 'observer');
        assert.ok(!f.ordinary.has(protectedRow.identity), 'exhausted row is excluded from ordinary pending selection');
        await f.drive(async () => (await Promise.all(others.map(id => f.row(id)))).every(row => row.stage === 'oauth-starting'),
          'ordinary provisioning must advance while terminal task GET is blocked');
        assert.equal(f.users.size, 7);
        // MySQL retry fast-forward may leave the earlier witness uncreated too.
        // Prove these exact five fresh identities progressed, not a total-map delta.
        for (const identity of fresh) {
          assert.ok(f.users.has(identity), 'fresh SSO work completes during the held observation');
        }
        assert.equal(f.observations.size, 1);
        assert.equal(f.posted.length, 1, 'persistent reservation still blocks every other Login POST');
        f.releaseRead();
        await observing;

        const assertRetained = async () => {
          assert.deepEqual(await f.row(), protectedRow);
          assert.equal((await f.store.listLoginReservations()).length, 1);
          assert.equal(f.posted.length, 1);
          await assertNoRetry(f, protectedRow);
        };
        await assertRetained();
        const observed = f.reads.length;
        for (let n = 0; n < 5; n++) await f.tick();
        assert.equal(f.reads.length, observed, 'same-clock scheduler wakes must respect observer poll interval');

        for (const [mode, patch] of [
          ['task', { status: 'cancelled' }],
          ['404', {}],
          ['503', {}],
          ['task', { status: 'success', id: randomUUID() }],
          ['task', { status: 'failed', oauthAttemptId: randomUUID() }],
        ] as const) {
          f.setRead(mode, patch);
          const count = f.reads.length;
          await f.advance();
          assert.equal(f.reads.length, count + 1, 'one exhausted reservation yields one bounded observation per poll');
          await assertRetained();
        }

        const success = scenario === 'success-callback-race';
        f.setRead('task', { status: success ? 'success' : 'failed' });
        if (success) {
          f.holdRead();
          const count = f.reads.length;
          const racing = f.advance();
          await until(() => f.reads.length > count, 'observer must capture the pre-callback generation');
          const task = f.posted[0]!;
          assert.equal(await f.storage.saveCopilotOauthToken(task.identity, randomUUID(), 'synthetic-stale-token', task.ghLogin), undefined);
          assert.ok(await f.storage.saveCopilotOauthToken(task.identity, task.oauthAttemptId!, 'synthetic-success-token', task.ghLogin));
          const callbackRow = await f.row();
          assert.equal(callbackRow.generation, protectedRow.generation + 1, 'real storage callback activates the credential fence');
          assert.deepEqual(f.protectedFields(callbackRow), f.protectedFields(protectedRow), 'callback cannot reset exhausted retry budget');
          assert.equal((await f.storage.getAccount(task.identity))!.copilotOauthToken, 'synthetic-success-token');
          f.releaseRead();
          await racing;
          assert.deepEqual(await f.row(), callbackRow, 'stale observer response cannot release the new generation');
          assert.equal(f.posted.length, 1);
          assert.equal(await f.storage.saveCopilotOauthToken(task.identity, task.oauthAttemptId!, 'synthetic-replay-token', task.ghLogin), undefined);
        }
        await f.advance();
        await f.drive(() => f.posted.length === 2, 'exact terminal task frees one slot for a different pending starter');
        const released = await f.row();
        assert.equal(released.stage, success ? 'warmup' : 'synced');
        assert.equal(released.task_id, null);
        assert.equal(released.oauth_attempt_id, null);
        assert.equal(released.generation, protectedRow.generation + (success ? 2 : 1));
        assert.equal((await f.store.listLoginReservations()).length, 0);
        assert.ok(others.includes(f.posted[1]!.identity));
        await f.advance(3000);
        assert.equal(f.posted.length, 2, 'exactly one new Login dispatch consumes the released capacity');
        assert.equal((await Promise.all(others.map(id => f.row(id)))).filter(row => row.stage === 'oauth-starting').length, 5);
        await assertNoRetry(f, protectedRow);
      });
  }
}
