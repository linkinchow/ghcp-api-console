import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { UserPoolError, type PoolConfig } from './config.js';
import { MysqlPoolStore } from './mysqlStore.js';
import type { Inventory } from './store.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 4, maxAccounts: 6,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
  retryAfterSeconds: 30, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000,
};
// Capture explicit opt-in before importing the worker's application dependencies.
const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';
const skip = enabled ? false : 'Requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1; creates a fresh synthetic database.';
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;

interface Fixture {
  database: string;
  db: Pool;
  otherDb: Pool;
  first: MysqlPoolStore;
  second: MysqlPoolStore;
}

/** The URL's fixture database is never selected, migrated, cleared or dropped.
 * Each test owns a fresh random sibling; only synthetic SQL and an injected
 * worker adapter are used, never application storage or provider HTTP. */
async function withDatabase(config: PoolConfig, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  assert.equal(process.env.MYSQL_POOL_TEST_DISPOSABLE, '1');
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-loopback MySQL test server');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Refusing a non-test MySQL URL');
  assert.equal(url.search + url.hash, '', 'Connection overrides and fragments are not allowed');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  assert.notEqual(url.pathname, `/${database}`);
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1, connectTimeout: 5000 });
  const pools: Pool[] = [];
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    url.pathname = `/${database}`;
    for (let i = 0; i < 2; i++) pools.push(createPool({ uri: url.toString(), connectionLimit: 4,
      connectTimeout: 5000, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
    const [db, otherDb] = pools;
    await runMysqlMigrations(db);
    const first = new MysqlPoolStore(db, config), second = new MysqlPoolStore(otherDb, config);
    await Promise.all([first.initialize(), second.initialize()]);
    await run({ database, db, otherDb, first, second });
  } finally {
    const closed = await Promise.allSettled(pools.map(pool => pool.end()));
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}

async function ready(f: Fixture): Promise<Inventory> {
  const row = await f.first.reserve();
  assert.ok(row);
  await f.db.execute(`UPDATE proxy_accounts SET copilot_oauth_status='valid', copilot_oauth_token=?, gh_login=? WHERE identity=?`,
    [`SyntheticToken-${row.identity}`, row.identity, row.identity]);
  assert.equal(await f.first.update(row.identity, { state: 'ready', stage: 'ready', verified_at: await f.first.now() }), true);
  return (await f.first.inventory(row.identity))!;
}

async function rejectCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof UserPoolError && error.code === code);
}

async function inventory(f: Fixture): Promise<Inventory[]> {
  const [rows] = await f.db.query<RowDataPacket[]>('SELECT identity FROM user_pool_accounts ORDER BY ordinal');
  return Promise.all(rows.map(async row => (await f.first.inventory(String(row.identity)))!));
}

async function assertBudget(f: Fixture, total: number): Promise<void> {
  assert.deepEqual(await f.second.settings(), await f.first.settings(), 'replicas must read the same committed settings');
  const counts = await f.first.counts();
  assert.deepEqual(await f.second.counts(), counts);
  assert.equal(counts.total, total);
  const rows = await inventory(f);
  assert.deepEqual(rows.map(row => row.ordinal), Array.from({ length: total }, (_, i) => i));
  const [proxy] = await f.otherDb.query<RowDataPacket[]>('SELECT identity FROM proxy_accounts ORDER BY identity');
  assert.deepEqual(proxy.map(row => row.identity), rows.map(row => row.identity).sort(), 'no extra or orphan Proxy account');
  const [[settings]] = await f.otherDb.query<RowDataPacket[]>('SELECT next_ordinal FROM user_pool_settings WHERE id=1');
  assert.equal(Number(settings.next_ordinal), total, 'a zero deficit must not consume names');
  const [[events]] = await f.db.query<RowDataPacket[]>("SELECT COUNT(*) n FROM user_pool_events WHERE action='name_reserved'");
  assert.equal(Number(events.n), total, 'exactly one creation intent per member');
}

/** Make all contenders reach the actual SQL transaction gate before releasing it.
 * PROCESSLIST exposes this user's own connections without requiring PROCESS or
 * performance_schema grants. A random DB scopes the observation to this test. */
async function atSettingsGate<T>(f: Fixture, count: number, run: () => Promise<T>): Promise<T> {
  const blocker = await f.db.getConnection();
  let running: Promise<T> | undefined;
  try {
    await blocker.beginTransaction();
    await blocker.query('SELECT id FROM user_pool_settings WHERE id=1 FOR UPDATE');
    running = run();
    // Observe rejection immediately, even if a contender fails before the barrier.
    void running.catch(() => {});
    const until = performance.now() + 2000;
    let waiting = 0;
    do {
      const [[row]] = await f.otherDb.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM information_schema.PROCESSLIST
        WHERE DB=? AND INFO='SELECT id FROM user_pool_settings WHERE id=1 FOR UPDATE'`, [f.database]);
      waiting = Number(row.n);
      if (waiting === count) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (performance.now() < until);
    assert.equal(waiting, count, 'all settings writers and reservations must be waiting on the same real row lock');
    await blocker.commit();
    return await running;
  } finally {
    try { await blocker.rollback(); }
    finally {
      blocker.release();
      // Never let rejected/unfinished contenders escape into database cleanup.
      await running?.catch(() => {});
    }
  }
}

test('MySQL lifecycle: racing settings CAS and deficit batches honor shrink, pause and resumed budgets',
  { skip, timeout: 120000 }, async () => withDatabase(options, async f => {
    const member = await ready(f);
    const held = await f.second.acquire(caller(1));
    assert.equal(held.member_identity, member.identity);
    await ready(f);
    assert.ok(await f.first.reserve()); // One queued account and one ready-idle account supply the target.
    const original = await inventory(f);
    const owner = randomUUID();
    assert.equal(await f.first.claimOwner(owner), true);
    const initial = await f.first.settings();
    const patches = [
      { paused: 1, idle_target: 1, max_accounts: 2 },
      { paused: 1, idle_target: 0, max_accounts: 1 },
    ];
    const [writes, batches] = await atSettingsGate(f, 4, () => Promise.all([
      Promise.allSettled([f.first.updateSettings(initial.version, patches[0]), f.second.updateSettings(initial.version, patches[1])]),
      Promise.allSettled([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]),
    ]));
    const reservations = batches.map(result => {
      assert.equal(result.status, 'fulfilled', 'reservation transaction must complete without a SQL error');
      return result.value;
    });
    assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
    const winner = writes.findIndex(result => result.status === 'fulfilled');
    const loser = writes[1 - winner];
    assert.equal(loser.status, 'rejected');
    if (loser.status === 'rejected') {
      assert.ok(loser.reason instanceof UserPoolError);
      assert.equal(loser.reason.code, 'settings_version_conflict');
    }
    const shrunk = { ...initial, ...patches[winner], version: initial.version + 1 };
    assert.deepEqual(await f.first.settings(), shrunk);
    // Either a batch fills the OLD deficit of two before the pause commits, or
    // the pause wins first. A partial budget, double-fill or post-pause fill is illegal.
    assert.ok(reservations.every(n => n === 0 || n === 2));
    const added = reservations.reduce<number>((sum, n) => sum + n, 0);
    assert.ok(added === 0 || added === 2);
    const total = original.length + added;
    await assertBudget(f, total);
    assert.ok(total > shrunk.max_accounts, 'lowering cap below existing inventory is explicitly allowed');
    assert.deepEqual((await inventory(f)).slice(0, original.length), original, 'shrink neither deletes nor rewrites existing jobs');
    const [[events]] = await f.db.query<RowDataPacket[]>("SELECT COUNT(*) n FROM user_pool_events WHERE action='settings_updated'");
    assert.equal(Number(events.n), 1, 'losing CAS cannot leave an audit event');
    await rejectCode(f.second.updateSettings(initial.version, { paused: 0, idle_target: 6, max_accounts: 6 }), 'settings_version_conflict');
    await rejectCode(f.first.updateSettings(shrunk.version, { idle_target: shrunk.max_accounts + 1 }), 'invalid_pool_settings');
    assert.deepEqual(await f.second.settings(), shrunk);
    assert.deepEqual(await Promise.all([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]), [0, 0]);
    assert.equal(await f.first.reserve(), undefined);
    assert.deepEqual(await Promise.all([f.first.pending(), f.second.pending()]), [undefined, undefined]);
    assert.equal(await f.first.heartbeat(held), true, 'pause/shrink cannot evict a live caller');
    const discovery = await f.second.acquireCatalog(caller(2));
    assert.notEqual(discovery.member_identity, held.member_identity, 'pause gates provisioning, not admission');
    await f.first.finish(discovery, false);

    const resumed = await f.second.updateSettings(shrunk.version, { paused: 0 });
    assert.deepEqual(await Promise.all([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]), [0, 0]);
    const queued = original.find(row => row.state === 'provisioning')!;
    assert.equal((await f.first.pending())!.identity, queued.identity);
    assert.equal((await f.second.pending())!.identity, queued.identity, 'queued work survives a cap below total');
    await assertBudget(f, total);
    // Headroom alone does not create demand. Raising the idle target later adds
    // exactly two jobs: the existing caller's member is not ready-idle supply.
    const expanded = await f.first.updateSettings(resumed.version, { max_accounts: total + 3 });
    assert.deepEqual(await Promise.all([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]), [0, 0]);
    await f.second.updateSettings(expanded.version, { idle_target: total + 1 });
    const replenished = await Promise.all([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]);
    assert.equal(replenished.reduce((sum, n) => sum + n, 0), 2);
    assert.deepEqual(await Promise.all([f.first.reserveDeficit(owner), f.second.reserveDeficit(owner)]), [0, 0]);
    await assertBudget(f, total + 2);
    assert.equal((await f.second.leases())[0].lease_id, held.lease_id);
    await f.first.finish(held, false);
    await f.second.releaseOwner(owner);
  }));

test('MySQL lifecycle: full-pool credential invalidation repairs unheld members before draining multiple held members at cap',
  { skip, timeout: 120000 }, async () => withDatabase({ ...options, maxAccounts: 4 }, async f => {
    const original: Inventory[] = [];
    for (let i = 0; i < 4; i++) original.push(await ready(f));
    const inference = await f.first.acquire(caller(1));
    const catalogOnLease = await f.second.acquireCatalog(caller(1));
    const catalog = await f.second.acquireCatalog(caller(2));
    const parallelCatalog = await f.first.acquireCatalog(caller(2));
    assert.equal(inference.member_identity, original[0].identity);
    assert.equal(catalogOnLease.member_identity, inference.member_identity);
    assert.equal(catalog.member_identity, original[1].identity);
    assert.equal(parallelCatalog.member_identity, catalog.member_identity);
    const heldIdentities = [inference.member_identity, catalog.member_identity];
    const unheld = original.filter(row => !heldIdentities.includes(row.identity)).map(row => row.identity).sort();

    // This is one real external credential transaction: the production trigger
    // invalidates verification/generation on EVERY member, including live holds.
    await f.otherDb.query("UPDATE proxy_accounts SET copilot_oauth_token=CONCAT('SyntheticReplacement-',identity)");
    for (const before of original) {
      const after = (await f.first.inventory(before.identity))!;
      assert.equal(after.state, 'ready', 'the trigger fences verification, maintenance schedules repair');
      assert.equal(after.verified_at, null);
      assert.equal(after.generation, before.generation + 1);
    }
    for (const hold of [inference, catalogOnLease, catalog, parallelCatalog]) {
      assert.equal(await f.second.heartbeat(hold), false);
      assert.equal(await f.first.hasHolds(hold.member_identity), true, 'fencing is not permission to discard in-flight holds');
    }

    // Load only after explicit URL validation and disposable DB creation. Never
    // start timers or use realProvisioner; these ticks perform SQL + counted fake warmups.
    const { PrewarmWorker } = await import('./worker.js');
    const calls: Array<{ identity: string; stage: string; state: string }> = [];
    const adapter = {
      async step(row: Inventory, context: import('./provisioner.js').ProvisionContext) {
        calls.push({ identity: row.identity, stage: row.stage, state: row.state });
        await context.pinCredentials();
        return { state: 'ready', stage: 'ready', verified_at: await f.first.now() };
      },
    };
    const workers = [f.first, f.second].map(store => new PrewarmWorker(store, adapter, 60000, 2, undefined, { multiReplica: true }));
    const tick = () => Promise.all(workers.map(worker => worker.tick()));
    try {
      await tick();
      assert.equal(workers.filter(worker => worker.isActive()).length, 1, 'only one replica dispatches warmups');
      assert.deepEqual(calls.map(call => call.identity).sort(), unheld, 'held prefix cannot starve the unheld tail');
      const pinned = await Promise.all(heldIdentities.map(async identity => (await f.second.inventory(identity))!));
      for (const row of pinned) {
        assert.equal(row.state, 'failed');
        assert.equal(row.stage, 'warmup');
        assert.equal(row.last_error, 'credential_not_verified');
        assert.equal(row.attempts, 0, 'a live hold must not consume repair attempts');
      }
      for (let pass = 0; pass < 3; pass++) await tick();
      assert.equal(calls.length, 2, 'repeated ticks cannot dispatch a held member');
      assert.deepEqual(await Promise.all(heldIdentities.map(identity => f.first.inventory(identity))), pinned);
      assert.deepEqual(await Promise.all([f.first.pending(), f.second.pending()]), [undefined, undefined]);
      assert.equal((await f.second.counts()).ready_idle, 2);
      await assertBudget(f, 4);

      // One hold from each member finishes: both still have catalog work in
      // flight, so neither an expired inference lease nor a partial catalog drain
      // is sufficient to begin repair. These stale successes cannot renew leases.
      await Promise.all([f.second.finish(inference, true), f.first.finish(catalog, true)]);
      await tick();
      assert.equal(calls.length, 2);
      assert.deepEqual(await Promise.all(heldIdentities.map(identity => f.second.inventory(identity))), pinned);
      const [lease] = await f.first.leases();
      assert.equal(lease.lease_id, inference.lease_id);
      assert.equal(lease.phase, 'provisional');
      assert.equal(lease.last_success_at, null);
      assert.equal(lease.active_requests, 1);
      assert.ok(lease.expires_at <= await f.first.now());
      for (const identity of heldIdentities) assert.equal(await f.second.hasHolds(identity), true);

      await f.second.finish(catalogOnLease, true);
      await tick();
      assert.equal(calls.length, 3);
      assert.equal(calls[2].identity, inference.member_identity, 'only the fully drained member becomes repairable');
      assert.deepEqual(await f.first.inventory(catalog.member_identity), pinned[1]);
      assert.equal((await f.second.leases()).length, 0);
      assert.equal((await f.first.counts()).ready_idle, 3);

      await f.first.finish(parallelCatalog, true);
      await tick();
      for (let pass = 0; pass < 2; pass++) await tick();
      assert.equal(calls.length, 4, 'exactly one repair per original member, no repeated or replacement creation');
      assert.deepEqual(calls.map(call => call.identity).sort(), original.map(row => row.identity).sort());
      assert.ok(calls.every(call => call.stage === 'warmup' && call.state === 'provisioning'), 'no SSO/OAuth creation stage is dispatched');
      for (const before of original) {
        const after = (await f.second.inventory(before.identity))!;
        assert.equal(after.state, 'ready');
        assert.equal(after.stage, 'ready');
        assert.notEqual(after.verified_at, null);
        assert.equal(after.attempt_id, before.attempt_id, 'repair keeps the existing inventory identity/intent');
        assert.equal(after.attempts, 0);
        assert.equal(await f.first.hasHolds(after.identity), false);
      }
      const counts = await f.second.counts();
      assert.equal(counts.ready_idle, 4);
      assert.equal(counts.failed, 0);
      assert.equal(counts.provisioning, 0);
      assert.equal(counts.catalog_requests, 0);
      assert.equal((await f.first.leases()).length, 0);
      await assertBudget(f, 4);
      const [[events]] = await f.db.query<RowDataPacket[]>("SELECT COUNT(*) n FROM user_pool_events WHERE action='account_ready'");
      assert.equal(Number(events.n), 4, 'each repair checkpoint commits once');
    } finally {
      await Promise.all(workers.map(worker => worker.stop()));
    }
  }));
