import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import type { LoginTaskDto, SsoUserDto } from '@ghcp/shared';
import type { ProxyStorage } from '../db/storageTypes.js';
import type { PoolStore } from './storage.js';
import type { Inventory } from './store.js';
import type { PoolConfig } from './config.js';
import type { ProvisionAdapter } from './provisioner.js';
import type { PrewarmStore } from './worker.js';

// Capture opt-in BEFORE application imports; never load the checkout's .env or
// use application credentials. Restore the whole environment even on import failure.
const mysqlUrl = process.env.MYSQL_TEST_URL;
const mysqlEnabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';
const savedEnv = { ...process.env };
const application = await (async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: join(tmpdir(), `absent-owner-side-effects-${randomUUID()}.env`),
    STORAGE_DRIVER: 'sqlite', INTERNAL_API_TOKEN: 'synthetic-internal',
    SSO_BASE_URL: 'http://sso.synthetic.test', LOGIN_BASE_URL: 'http://login.synthetic.test',
    COPILOT_API_BASE_URL: 'http://copilot.synthetic.test', PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
  });
  try {
    return {
      ...await import('../db/sqliteStorage.js'), ...await import('../db/mysqlStorage.js'),
      ...await import('./worker.js'), ...await import('./provisioner.js'),
    };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
})();
const { SqliteStorage, MysqlStorage, PrewarmWorker, realProvisioner } = application;
const options: PoolConfig = {
  enabled: true, accountDomain: 'owner.synthetic.test', idleTarget: 1, maxAccounts: 1,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 1000, prewarmConcurrency: 1,
  loginMaxPending: 1, retryAfterSeconds: 1, warmupModel: 'synthetic-model', requestTimeoutMs: 5000,
};
const createdAt = '2026-01-01T00:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Stage = 'sso' | 'scim' | 'seat' | 'login';
type Timing = 'http-response' | 'store-update';
const stages = {
  sso: { before: 'new', intent: 'sso-creating', after: 'sso-created' },
  scim: { before: 'sso-created', intent: 'scim-syncing', after: 'scim-synced' },
  seat: { before: 'scim-synced', intent: 'seat-assigning', after: 'synced' },
  login: { before: 'oauth-starting', intent: 'oauth-dispatch', after: 'oauth-wait' },
} as const;

function gate() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, async hold() { enter(); await released; } };
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owner-side-effect barrier did not settle')), 8000);
    })]);
  } finally { clearTimeout(timer); }
}

interface WriteTrace { sql: string; affected: number }
const isWrite = (sql: string) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql)
  && /\b(user_pool_accounts|proxy_accounts|user_pool_events)\b/i.test(sql);
/** Observe real results, never manufacture a SQL response or keep a transaction open. */
function tracedPool(pool: Pool, writes: WriteTrace[]): Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'getConnection') return async () => {
      const connection = await target.getConnection();
      return new Proxy(connection, { get(c, method) {
        if (method === 'query' || method === 'execute') return async (...args: unknown[]) => {
          const result = await (c[method] as (...a: unknown[]) => Promise<unknown[]>).apply(c, args);
          const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { sql: string }).sql);
          if (isWrite(sql)) writes.push({ sql, affected: Number((result[0] as { affectedRows: number }).affectedRows) });
          return result;
        };
        const value: unknown = Reflect.get(c, method);
        return typeof value === 'function' ? value.bind(c) : value;
      } }) as PoolConnection;
    };
    const value: unknown = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
interface Fixture {
  first: PoolStore; second: PoolStore; storage: ProxyStorage; writes: WriteTrace[];
  owner(): Promise<string | null>;
  expire(owner: string): Promise<void>;
  snapshot(): Promise<unknown>;
}
async function withDatabase(driver: 'SQLite' | 'MySQL', run: (f: Fixture) => Promise<void>) {
  const writes: WriteTrace[] = [];
  if (driver === 'SQLite') {
    const directory = mkdtempSync(join(tmpdir(), 'owner-side-effects-'));
    const path = join(directory, 'test.sqlite');
    const storage = new SqliteStorage(path, 10), other = new SqliteStorage(path, 10);
    try {
      await storage.initialize(); await other.initialize();
      const first = storage.userPool(options), second = other.userPool(options);
      // Test-only SQL observation on the real private handle. No replacement store.
      const db = (storage as unknown as { db: Database.Database }).db;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (isWrite(sql)) {
          const run = statement.run.bind(statement);
          statement.run = (...args: unknown[]) => {
            const result = run(...args);
            writes.push({ sql, affected: result.changes });
            return result;
          };
        }
        return statement;
      }) as typeof db.prepare;
      await run({ first, second, storage, writes,
        owner: async () => (db.prepare('SELECT owner FROM user_pool_settings WHERE id=1').get() as { owner: string | null }).owner,
        expire: async owner => {
          assert.equal(db.prepare('UPDATE user_pool_settings SET owner_until=? WHERE id=1 AND owner=?')
            .run(first.now() - 1, owner).changes, 1);
        },
        snapshot: async () => ({
          accounts: db.prepare('SELECT * FROM user_pool_accounts ORDER BY identity').all(),
          credentials: db.prepare('SELECT * FROM proxy_accounts ORDER BY identity').all(),
          events: db.prepare('SELECT * FROM user_pool_events ORDER BY id').all(),
        }),
      });
    } finally {
      await Promise.all([storage.close(), other.close()]);
      rmSync(directory, { recursive: true, force: true });
    }
    return;
  }
  assert.equal(mysqlEnabled, true);
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(decodeURIComponent(url.username), 'root', 'Requires an explicitly disposable root test server');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Only loopback MySQL is allowed');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search + url.hash, '', 'URL overrides and fragments are forbidden');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(url.pathname, `/${database}`);
  url.pathname = '/'; // The supplied fixture database is NEVER selected or changed.
  const admin = createPool({ uri: url.toString(), connectionLimit: 1, connectTimeout: 5000 });
  const pools: Pool[] = [];
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true; url.pathname = `/${database}`;
    for (let i = 0; i < 2; i++) pools.push(createPool({ uri: url.toString(), connectionLimit: 4,
      connectTimeout: 5000, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
    const [db, otherDb] = pools;
    const storage = new MysqlStorage(tracedPool(db, writes), 10), other = new MysqlStorage(otherDb, 10);
    await storage.initialize();
    const first = await storage.userPool(options), second = await other.userPool(options);
    await run({ first, second, storage, writes,
      owner: async () => (await db.query<RowDataPacket[]>('SELECT owner FROM user_pool_settings WHERE id=1'))[0][0].owner,
      expire: async owner => {
        const [result] = await db.query<import('mysql2/promise').ResultSetHeader>(`UPDATE user_pool_settings
          SET owner_until=(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',UTC_TIMESTAMP(3)) DIV 1000)-1 WHERE id=1 AND owner=?`, [owner]);
        assert.equal(result.affectedRows, 1);
      },
      snapshot: async () => {
        const rows = [];
        for (const table of ['user_pool_accounts', 'proxy_accounts', 'user_pool_events']) {
          rows.push((await db.query(`SELECT * FROM ${table} ORDER BY ${table === 'user_pool_events' ? 'id' : 'identity'}`))[0]);
        }
        return rows;
      },
    });
  } finally {
    const closed = await Promise.allSettled(pools.map(pool => pool.end()));
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}

function services(f: Fixture, target: Stage, timing: Timing, observable: boolean) {
  const barrier = gate();
  const posts = { sso: 0, scim: 0, seat: 0, login: 0, credentials: 0 };
  const trace: { method: string; path: string; attempt: string; nonce?: string | null }[] = [];
  const errors: unknown[] = [], tasks: LoginTaskDto[] = [];
  const steps: Promise<unknown>[] = [];
  let user: SsoUserDto | undefined, visible: SsoUserDto | undefined;
  let warms = 0;
  const read = async () => {
    const rows = (await f.storage.listAccounts()).items;
    assert.equal(rows.length, 1);
    const row = await f.first.inventory(rows[0].identity);
    assert.ok(row);
    return row;
  };
  const effect = async (stage: Stage, response: Response) => {
    if (stage === target && timing === 'http-response') await barrier.hold();
    return response;
  };
  const adapter = (store: PoolStore): ProvisionAdapter => {
    const real = realProvisioner(store, options, {
      getAccount: id => f.storage.getAccount(id),
      async fetch(input, init) {
        try {
          const url = new URL(String(input)), path = url.pathname, method = init?.method ?? 'GET';
          assert.equal(url.origin, path.startsWith('/api/tasks') ? 'http://login.synthetic.test' : 'http://sso.synthetic.test');
          assert.equal(new Headers(init?.headers).get('x-internal-token'), 'synthetic-internal');
          assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
          const row = await read(), body = init?.body ? JSON.parse(String(init.body)) : undefined;
          trace.push({ method, path: path + url.search, attempt: row.attempt_id, nonce: row.oauth_attempt_id });
          if (method === 'GET' && path === `/api/users/${row.identity}`) return visible ? json(visible) : json({}, 404);
          if (method === 'POST' && path === '/api/users') {
            assert.equal(++posts.sso, 1, 'count POST attempts, not deduplicated identities');
            assert.equal(row.stage, 'sso-creating'); assert.equal(row.sso_created_at, null);
            assert.deepEqual(body, { ssoUser: row.identity, email: `${row.identity}@${options.accountDomain}`, role: 'user', poolManaged: true });
            user = { ssoUser: row.identity, email: body.email, role: 'user', emuStatus: 'not_synced',
              copilotSeatStatus: 'unassigned', createdAt, updatedAt: createdAt };
            visible = { ...user! };
            return effect('sso', json(user, 201));
          }
          assert.ok(user, 'only the originally created identity exists');
          assert.equal(row.sso_created_at, createdAt, 'known-user creation marker is immutable');
          if (method === 'POST' && path === '/api/users/batch') {
            assert.equal(++posts.scim, 1); assert.equal(row.stage, 'scim-syncing');
            assert.deepEqual(body, { operation: 'sync_emu', ssoUsers: [row.identity], assignCopilotSeat: false, createOnly: true });
            user = { ...user, emuStatus: 'active', ghLogin: `${row.identity}_emu`, ghScimId: 'synthetic-scim-original' };
            if (target !== 'scim' || observable) visible = { ...user };
            return effect('scim', json({ rows: [{ ssoUser: row.identity, status: 'success', user }] }));
          }
          if (method === 'POST' && path === `/api/users/${row.identity}/copilot-seat`) {
            assert.equal(++posts.seat, 1); assert.equal(row.stage, 'seat-assigning'); assert.deepEqual(body, {});
            user = { ...user, copilotSeatStatus: 'assigned' };
            if (target !== 'seat' || observable) visible = { ...user };
            return effect('seat', json(user));
          }
          if (method === 'POST' && path === `/api/users/${row.identity}/login-credentials`) {
            posts.credentials++;
            assert.deepEqual(body, { expectedCreatedAt: createdAt, expectedEmail: user.email });
            return json({ user, passwordForLogin: 'synthetic-password' });
          }
          if (method === 'POST' && path === '/api/tasks') {
            assert.equal(++posts.login, 1, 'Login POST is NOT idempotent, even for the same nonce');
            assert.equal(row.stage, 'oauth-dispatch'); assert.ok(row.oauth_attempt_id);
            assert.deepEqual(body, { identity: row.identity, ssoUser: row.identity, ghLogin: user.ghLogin,
              oauthAttemptId: row.oauth_attempt_id, ssoPassword: 'synthetic-password', ssoType: 'custom' });
            const account = await f.storage.getAccount(row.identity);
            assert.equal(account?.copilotOauthStatus, 'refreshing');
            assert.equal(account.copilotOauthAttemptId, row.oauth_attempt_id);
            const task: LoginTaskDto = { id: 'synthetic-original-task', identity: row.identity, ssoUser: row.identity,
              ghLogin: user.ghLogin, oauthAttemptId: row.oauth_attempt_id, ssoType: 'custom', status: 'running',
              attempts: 1, createdAt: new Date(await store.now()).toISOString() };
            tasks.push(task);
            return effect('login', json(task, 202));
          }
          if (method === 'GET' && path === '/api/tasks') {
            assert.equal(url.searchParams.get('q'), row.identity);
            assert.equal(url.searchParams.get('page'), '1'); assert.equal(url.searchParams.get('pageSize'), '100');
            assert.equal(row.oauth_attempt_id, tasks[0]?.oauthAttemptId);
            const items = target === 'login' && !observable ? [] : tasks;
            return json({ items, total: items.length, page: 1, pageSize: 100 });
          }
          if (method === 'GET' && path === `/api/tasks/${tasks[0]?.id}`) return json(tasks[0]);
          assert.fail(`Unexpected synthetic HTTP request ${method} ${path}`);
        } catch (error) { errors.push(error); throw error; }
      },
      async resolveModel(auth, path, model, _diagnostics, signal) {
        assert.equal(auth.accessToken, 'synthetic-original-token'); assert.equal(path, '/v1/messages');
        assert.equal(model, options.warmupModel); assert.ok(signal);
        return { requestedId: model, canonicalId: model, upstreamId: model, model: { id: model }, supportedPaths: ['/v1/messages'] };
      },
      async executeRequest(request) {
        const row = await read(); assert.equal(row.stage, 'warmup'); assert.equal(row.state, 'provisioning');
        assert.equal(row.verified_at, null);
        assert.equal(new Headers(request.headers).get('authorization'), 'Bearer synthetic-original-token');
        assert.equal(new URL(request.url).origin, 'http://copilot.synthetic.test');
        warms++;
        return json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
      },
    });
    return { ...real, step(row, context) {
      const step = real.step(row, context); steps.push(step); void step.catch(() => {}); return step;
    } };
  };
  return { barrier, adapter, posts, trace, errors, tasks, steps, read, warms: () => warms };
}

async function contract(f: Fixture, target: Stage, timing: Timing, observable = true) {
  const service = services(f, target, timing, observable), updateBarrier = gate();
  const updates: { owner?: string; patch: Partial<Inventory>; accepted: boolean }[] = [];
  let delayed = false, oldFailures = 0;
  // Only the final success patch is delayed; intent checkpoints still commit normally.
  const wrapped = new Proxy(f.first, { get(store, key) {
    if (key === 'update') return async (...args: Parameters<PoolStore['update']>) => {
      const [, patch, , owner] = args;
      if (timing === 'store-update' && patch.stage === stages[target].after && !delayed) {
        delayed = true; await updateBarrier.hold();
      }
      const accepted = await store.update(...args);
      updates.push({ owner, patch, accepted });
      return accepted;
    };
    if (key === 'fail') return async (...args: Parameters<PoolStore['fail']>) => { oldFailures++; return store.fail(...args); };
    const value: unknown = Reflect.get(store, key);
    return typeof value === 'function' ? value.bind(store) : value;
  } }) as PrewarmStore;
  // No start(): no heartbeat may renew the intentionally expired lease in the background.
  const old = new PrewarmWorker(wrapped, service.adapter(f.first), options.pollMs, 1, undefined, { multiReplica: true });
  const successor = new PrewarmWorker(f.second, service.adapter(f.second), options.pollMs, 1, undefined, { multiReplica: true });
  let oldTick: Promise<void> | undefined;
  const tick = async (worker: InstanceType<typeof PrewarmWorker>) => {
    await bounded(worker.tick()); await worker.waitForObservations();
    assert.deepEqual(service.errors, [], 'mock assertion/unexpected HTTP failures must not be swallowed by worker');
  };
  try {
    assert.equal((await f.first.counts()).total, 0, 'start empty: no fixture Ready rows or direct stage seeding');
    if (target !== 'sso') {
      for (let i = 0; i < 6; i++) {
        await tick(old);
        if ((await service.read()).stage === stages[target].before) break;
      }
      assert.equal((await service.read()).stage, stages[target].before);
    }
    oldTick = old.tick();
    await bounded(timing === 'http-response' ? service.barrier.entered : updateBarrier.entered);
    const held = await service.read(), ownerA = await f.owner();
    assert.ok(ownerA); assert.equal(held.stage, stages[target].intent);
    assert.equal(held.state, 'provisioning'); assert.equal(held.attempts, 0); assert.equal(held.last_error, null);
    assert.equal(held.sso_created_at, target === 'sso' ? null : createdAt);
    assert.equal(service.posts[target], 1);
    assert.ok(f.writes.some(write => write.affected === 1 && /UPDATE user_pool_accounts/i.test(write.sql)),
      'SQL instrumentation must witness real successful intent checkpoints before testing rejection');
    const postsAtBarrier = { ...service.posts }, requestsAtBarrier = service.trace.length;
    if (target === 'login') {
      assert.ok(held.oauth_attempt_id); assert.equal(held.task_id, null);
      assert.equal(service.tasks[0].oauthAttemptId, held.oauth_attempt_id);
    }
    // Force DB expiry, not an abort/stop. No account state is changed by test SQL.
    await f.expire(ownerA);
    assert.equal(await f.owner(), ownerA);
    assert.equal(await f.first.renewOwner(ownerA), false, 'expired UUID cannot resurrect its lease');
    await tick(successor);
    const ownerB = await f.owner(); assert.ok(ownerB); assert.notEqual(ownerB, ownerA);
    const recovered = await service.read();
    assert.deepEqual(service.posts, postsAtBarrier, 'successor recovery is read-only externally, with no replayed POST');
    const recoveryRequests = service.trace.slice(requestsAtBarrier);
    assert.equal(recoveryRequests.length, target === 'sso' ? 0 : target === 'login' ? 2 : 1);
    assert.ok(recoveryRequests.every(request => request.method === 'GET'));
    assert.equal(recovered.attempt_id, held.attempt_id);
    assert.equal(recovered.oauth_attempt_id, held.oauth_attempt_id);
    assert.equal(recovered.sso_created_at, held.sso_created_at);
    assert.equal(recovered.verified_at, null);
    if (target === 'sso' || !observable) {
      const error = target === 'sso' ? 'sso_creation_ambiguous' : `${target === 'scim' ? 'scim_sync' : target === 'seat' ? 'seat_assignment' : 'oauth_dispatch'}_unconfirmed`;
      assert.equal(recovered.stage, stages[target].intent); assert.equal(recovered.state, 'failed');
      assert.equal(recovered.last_error, error); assert.equal(recovered.attempts, target === 'sso' ? 3 : 1);
      assert.equal(recovered.generation, held.generation + 1);
      if (target === 'sso') {
        await assert.rejects(Promise.resolve().then(() => f.second.retry(held.identity)), { code: 'manual_reconciliation_required' });
      }
    } else {
      assert.equal(recovered.stage, stages[target].after); assert.equal(recovered.state, 'provisioning');
      assert.equal(recovered.attempts, 0); assert.equal(recovered.last_error, null);
      if (target === 'seat') assert.equal((await f.storage.getAccount(held.identity))?.ghLogin, `${held.identity}_emu`);
      if (target === 'login') {
        assert.equal(recovered.task_id, service.tasks[0].id);
        assert.equal((await f.storage.getAccount(held.identity))?.copilotOauthAttemptId, held.oauth_attempt_id);
        assert.equal(service.trace.filter(r => r.method === 'GET' && r.path.startsWith('/api/tasks?')).length, 1);
      }
    }
    const beforeDrain = await f.snapshot(), postsAtRecovery = { ...service.posts };
    // Fresh row fence removes stage/generation mismatch as an explanation: ONLY
    // old owner authority is wrong. Real update/fail must reject before account DML.
    f.writes.length = 0;
    assert.equal(await f.first.update(held.identity, { retry_at: recovered.retry_at + 1 }, recovered, ownerA), false);
    await f.first.fail(held.identity, 'synthetic_stale_failure', recovered, ownerA, true);
    assert.deepEqual(f.writes, [], 'owner rejection occurs before account/event SQL, not a fabricated affectedRows=0');
    assert.deepEqual(await f.snapshot(), beforeDrain);
    f.writes.length = 0;
    service.barrier.release(); updateBarrier.release();
    await bounded(oldTick);
    await bounded(Promise.allSettled(service.steps));
    assert.equal(oldFailures, 0, 'late old success/error cannot charge a retry');
    if (timing === 'store-update') {
      const final = updates.filter(update => update.owner === ownerA && update.patch.stage === stages[target].after);
      assert.equal(final.length, 1); assert.equal(final[0].accepted, false, 'delayed call reached the REAL fenced store');
    }
    assert.deepEqual(f.writes, [], 'old response/checkpoint must execute no account/event writes');
    assert.deepEqual(await f.snapshot(), beforeDrain, 'late old work cannot overwrite recovery or credentials');
    assert.deepEqual(service.posts, postsAtRecovery, 'no duplicate POST attempts during old drain');
    assert.deepEqual(service.errors, []);
    assert.equal(await f.owner(), ownerB);

    if (observable && target !== 'sso') {
      // Finish normal real steps, then send the original Login callback through
      // the real storage nonce predicate (not an in-memory account fake).
      for (let i = 0; i < 6 && (await service.read()).stage !== 'oauth-wait'; i++) await tick(successor);
      const waiting = await service.read(); assert.equal(waiting.stage, 'oauth-wait');
      const task = service.tasks[0]; assert.ok(task.oauthAttemptId);
      assert.equal(task.oauthAttemptId, waiting.oauth_attempt_id);
      const beforeCallback = await f.snapshot();
      assert.equal(await f.storage.saveCopilotOauthToken(waiting.identity, 'wrong-synthetic-nonce', 'bad-token'), undefined);
      assert.deepEqual(await f.snapshot(), beforeCallback);
      assert.ok(await f.storage.saveCopilotOauthToken(waiting.identity, task.oauthAttemptId, 'synthetic-original-token', task.ghLogin));
      task.status = 'success';
      await tick(successor); assert.equal((await service.read()).stage, 'warmup');
      await tick(successor);
      const ready = await service.read(), account = await f.storage.getAccount(ready.identity);
      assert.equal(ready.state, 'ready'); assert.equal(ready.stage, 'ready'); assert.equal(ready.attempts, 0);
      assert.ok(ready.verified_at); assert.equal(ready.attempt_id, held.attempt_id); assert.equal(ready.sso_created_at, createdAt);
      assert.equal(ready.oauth_attempt_id, task.oauthAttemptId); assert.equal(account?.copilotOauthAttemptId, undefined);
      assert.equal(account?.copilotOauthToken, 'synthetic-original-token'); assert.equal(account.copilotOauthStatus, 'valid');
      const completed = await f.snapshot();
      assert.equal(await f.storage.saveCopilotOauthToken(ready.identity, task.oauthAttemptId, 'late-duplicate-token'), undefined);
      assert.equal(await f.storage.failCopilotOauthAuthorization(ready.identity, task.oauthAttemptId), false);
      assert.deepEqual(await f.snapshot(), completed);
      assert.equal(service.warms(), 1); assert.equal((await f.first.counts()).ready_idle, 1);
      assert.deepEqual(service.posts, { sso: 1, scim: 1, seat: 1, login: 1, credentials: 1 });
    } else {
      await tick(successor);
      assert.deepEqual(await f.snapshot(), beforeDrain, 'failed/unconfirmed inventory does not silently auto-retry');
      assert.equal((await f.first.counts()).ready_idle, 0); assert.equal(service.warms(), 0);
    }
    assert.equal((await f.first.counts()).total, 1);
    assert.equal((await f.storage.listAccounts()).total, 1);
    assert.equal(new Set(service.trace.map(request => request.attempt)).size, 1);
    assert.equal(new Set(service.trace.map(request => request.nonce).filter(Boolean)).size, service.tasks.length ? 1 : 0);
    assert.deepEqual(service.errors, []);
    await old.stop(); // Cleanup cannot release the successor's distinct UUID.
    assert.equal(await f.owner(), ownerB);
  } finally {
    service.barrier.release(); updateBarrier.release();
    await bounded(Promise.all([old.stop(), successor.stop(), oldTick]));
    await bounded(Promise.allSettled(service.steps));
  }
}

// These are controlled in-process dependency/SQL contracts, NOT real SSO/Login
// service HTTP, process-crash durability, or a real elapsed 30-second lease test.
for (const driver of ['SQLite', 'MySQL'] as const) {
  const skip = driver === 'MySQL' && !mysqlEnabled
    ? 'Requires root loopback MYSQL_TEST_URL=/ghcp_pool_test_* and MYSQL_POOL_TEST_DISPOSABLE=1; fresh sibling databases only.' : false;
  for (const target of ['sso', 'scim', 'seat', 'login'] as const) {
    for (const timing of ['http-response', 'store-update'] as const) {
      test(`${driver}: ${target} committed, ${timing} withheld, successor recovers before old owner drains`,
        { skip, timeout: 30000 }, () => withDatabase(driver, f => contract(f, target, timing)));
    }
  }
  for (const target of ['scim', 'seat', 'login'] as const) {
    test(`${driver}: ${target} effect not observable after owner loss stays unconfirmed without another POST`,
      { skip, timeout: 30000 }, () => withDatabase(driver, f => contract(f, target, 'http-response', false)));
  }
}
