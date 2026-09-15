import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { type PoolConfig, UserPoolError } from './config.js';
import { MysqlPoolStore } from './mysqlStore.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 16, maxAccounts: 16,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
  retryAfterSeconds: 30, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000,
};
const caller = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
const lockName = (database: string, id: string) => createHash('sha256').update(JSON.stringify([database, id])).digest('hex');
const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';

// No environment files, external providers or real inventory. Only a newly
// created random database on an explicitly opted-in loopback test server.
test('MySQL admission: caller locks and member-first allocation across replicas', {
  skip: enabled ? false : 'Requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1.',
}, async t => {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/);
  assert.equal(url.search, '');
  const database = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  const pools: Pool[] = [];
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    url.pathname = `/${database}`;
    for (let i = 0; i < 2; i++) pools.push(createPool({ uri: url.toString(), connectionLimit: 8,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
    const [db, other] = pools;
    const first = new MysqlPoolStore(db, options), second = new MysqlPoolStore(other, options);
    await runMysqlMigrations(db);
    await Promise.all([first.initialize(), second.initialize()]);
    const reset = async (count = 2) => {
      for (const table of ['user_pool_holds', 'user_pool_catalog_holds', 'user_pool_catalog_cooldowns',
        'user_pool_leases', 'user_pool_accounts', 'user_pool_events', 'proxy_accounts']) await db.query(`DELETE FROM ${table}`);
      await db.query('UPDATE user_pool_settings SET next_ordinal=0, owner=NULL, owner_until=0');
      const identities: string[] = [];
      for (let i = 0; i < count; i++) {
        const row = await first.reserve();
        assert.ok(row);
        await db.execute("UPDATE proxy_accounts SET copilot_oauth_status='valid', copilot_oauth_token='SyntheticToken' WHERE identity=?", [row.identity]);
        await first.update(row.identity, { state: 'ready', stage: 'ready', verified_at: await first.now() });
        identities.push(row.identity);
      }
      return identities;
    };
    const rejectCode = async (action: Promise<unknown>, code: string) => {
      await assert.rejects(action, (error: unknown) => error instanceof UserPoolError && error.code === code);
    };

    await t.test('simultaneous same-caller catalog/inference converge; five different callers do not share', async () => {
      await reset(8);
      const holds = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2
        ? first.acquire(caller(1)) : second.acquireCatalog(caller(1))));
      assert.equal(new Set(holds.map(h => h.member_identity)).size, 1);
      assert.equal(new Set(holds.filter(h => h.kind === 'lease').map(h => h.lease_id)).size, 1);
      assert.equal(new Set(holds.map(h => h.request_id)).size, 8);
      const others = await Promise.all(Array.from({ length: 5 }, (_, i) => i % 2
        ? first.acquire(caller(i + 2)) : second.acquireCatalog(caller(i + 2))));
      assert.equal(new Set([...holds, ...others].map(h => h.member_identity)).size, 6);
      await Promise.all([...holds, ...others].map(h => first.finish(h, false)));
    });

    await t.test('settings gate and an unrelated credential lock do not block allocation', async () => {
      const [locked, free] = await reset();
      const blocker = await other.getConnection();
      try {
        await blocker.beginTransaction();
        await blocker.query('SELECT id FROM user_pool_settings WHERE id=1 FOR UPDATE');
        await blocker.query('SELECT identity FROM proxy_accounts WHERE identity=? FOR UPDATE', [locked]);
        const held = await first.acquire(caller(1));
        assert.equal(held.member_identity, free);
        await first.finish(held, false);
      } finally { await blocker.rollback(); blocker.release(); }
    });

    await t.test('expired bindings are reclaimed lazily, but deadline drain grace pins members', async () => {
      const [identity] = await reset(1);
      const old = await first.acquire(caller(1));
      await db.query('UPDATE user_pool_leases SET expires_at=0');
      await db.query('UPDATE user_pool_holds SET deadline_at=0');
      await rejectCode(second.acquire(caller(2)), 'pool_exhausted');
      await rejectCode(second.acquireCatalog(caller(1)), 'lease_draining');
      await db.query('UPDATE user_pool_holds SET expires_at=0');
      const replacement = await second.acquireCatalog(caller(2));
      assert.equal(replacement.member_identity, identity);
      await first.finish(old, true);
      assert.equal(await first.heartbeat(replacement), true);
      await db.query('UPDATE user_pool_catalog_holds SET deadline_at=0, expires_at=0');
      const inference = await first.acquire(caller(3));
      assert.equal(inference.member_identity, identity);
      assert.equal((await first.leases()).length, 1);
    });

    await t.test('finish renewal while admission waits is reread; disable fences admitted holds', async () => {
      const [identity] = await reset(1);
      const held = await first.acquire(caller(1));
      await db.query('UPDATE user_pool_leases SET expires_at=0');
      const blocker = await other.getConnection();
      try {
        await blocker.beginTransaction();
        await blocker.query('SELECT identity FROM proxy_accounts WHERE identity=? FOR UPDATE', [identity]);
        const renewing = first.finish(held, true);
        const admission = second.acquireCatalog(caller(1));
        // Either waiter can win the member row: admission may observe draining
        // before finish, but must converge after the acknowledged renewal.
        const outcome = Promise.allSettled([renewing, admission]);
        await blocker.commit();
        const [renewed, admitted] = await outcome;
        assert.equal(renewed.status, 'fulfilled');
        if (admitted.status === 'rejected') assert.equal(admitted.reason.code, 'lease_draining');
        const catalog = admitted.status === 'fulfilled' ? admitted.value! : await second.acquireCatalog(caller(1));
        assert.ok(catalog && typeof catalog === 'object');
        assert.equal(catalog.member_identity, identity);
        await first.disable(identity);
        assert.equal(await second.heartbeat(catalog), false);
        await rejectCode(second.acquire(caller(1)), 'member_unavailable');
        await first.finish(catalog, true);
        assert.equal((await first.leases()).length, 0);
      } finally { await blocker.rollback(); blocker.release(); }
    });

    await t.test('disable racing new admission never leaves a usable hold', async () => {
      const [identity] = await reset(1);
      const [admission, disabled] = await Promise.allSettled([first.acquire(caller(1)), second.disable(identity)]);
      assert.equal(disabled.status, 'fulfilled');
      assert.equal((await first.inventory(identity))!.state, 'disabled');
      if (admission.status === 'fulfilled') {
        assert.equal(await second.heartbeat(admission.value), false);
        await first.finish(admission.value, true);
      } else {
        assert.ok(['pool_exhausted', 'member_unavailable'].includes(admission.reason.code));
      }
      assert.equal((await first.leases()).length, 0);
      await rejectCode(first.acquireCatalog(caller(1)), 'pool_exhausted');
    });

    await t.test('credential quarantine is committed on rejected admission without a global sweep', async () => {
      const [identity] = await reset(1);
      const held = await first.acquire(caller(1));
      await other.query("UPDATE proxy_accounts SET copilot_oauth_token='RotatedSyntheticToken' WHERE identity=?", [identity]);
      await rejectCode(first.acquire(caller(1)), 'member_unavailable');
      const quarantined = (await second.inventory(identity))!;
      assert.equal(quarantined.state, 'failed');
      assert.equal(quarantined.last_error, 'credential_not_verified');
      assert.equal(await first.hasHolds(identity), true);
      await first.finish(held, true);
      assert.equal((await first.leases()).length, 0);
    });

    await t.test('a partitioned caller lock blocks only that caller and remains bounded', async () => {
      await reset(2);
      const blocker = await other.getConnection();
      try {
        const name = lockName(database, caller(1));
        await blocker.query('SELECT GET_LOCK(?, 0)', [name]);
        const limited = new MysqlPoolStore(db, { ...options, requestTimeoutMs: 100 });
        const pending = assert.rejects(limited.acquire(caller(1)), (error: unknown) =>
          (error as { code?: string }).code === 'POOL_SQL_TIMEOUT');
        const unrelated = await second.acquire(caller(2));
        await pending;
        assert.ok(unrelated.member_identity);
        await blocker.query('SELECT RELEASE_LOCK(?)', [name]);
        const recovered = await first.acquire(caller(1));
        assert.notEqual(recovered.member_identity, unrelated.member_identity);
        const [locks] = await db.query<RowDataPacket[]>('SELECT IS_USED_LOCK(?) AS owner', [name]);
        assert.equal(locks[0].owner, null);
      } finally { blocker.release(); }
    });
  } finally {
    await Promise.all(pools.map(pool => pool.end()));
    try { if (created) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
  }
});

// Fault injection runs with no database/network. Empty inventory makes admission
// reject normally after committing cleanup, exercising all named-lock lifecycle paths.
function fakePool(settings: { database?: string; release?: number | null | 'error' | 'hang'; getLock?: 'hang'; query?: (sql: string) => void } = {}) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let destroyed = 0, released = 0, commits = 0, begun = 0;
  const raw = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      settings.query?.(sql);
      if (sql.includes('DATABASE()')) return [[{ name: settings.database ?? 'synthetic_db' }]];
      if (sql.includes('GET_LOCK')) return settings.getLock === 'hang' ? new Promise(() => {}) : [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) {
        if (settings.release === 'error') throw new Error('lost release response');
        if (settings.release === 'hang') return new Promise(() => {});
        return [[{ released: settings.release === undefined ? 1 : settings.release }]];
      }
      if (sql.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: 1800000000000 }]];
      return [[], []];
    },
    beginTransaction: async () => { begun++; calls.push({ sql: 'BEGIN' }); },
    commit: async () => { commits++; }, rollback: async () => {},
    destroy: () => { destroyed++; }, release: () => { released++; },
  };
  return { pool: { getConnection: async () => raw } as unknown as Pool, calls,
    stats: () => ({ destroyed, released, commits, begun }) };
}

test('admission obtains database-scoped bounded caller lock before BEGIN, never the settings gate', async () => {
  const names: unknown[] = [];
  for (const database of ['synthetic_a', 'synthetic_b']) {
    const fake = fakePool({ database });
    await assert.rejects(new MysqlPoolStore(fake.pool, options).acquire(caller(1)), /pool_exhausted/);
    const get = fake.calls.findIndex(call => call.sql.includes('GET_LOCK'));
    assert.ok(get >= 0 && get < fake.calls.findIndex(call => call.sql === 'BEGIN'));
    assert.equal(fake.calls.some(call => call.sql.includes('user_pool_settings')), false);
    assert.equal(fake.calls.some(call => /DELETE.*expires_at/.test(call.sql)), false, 'no global reclaim');
    const name = fake.calls[get].values![0];
    assert.match(String(name), /^[a-f0-9]{64}$/);
    assert.equal(name, lockName(database, caller(1)));
    assert.deepEqual(fake.stats(), { destroyed: 0, released: 1, commits: 1, begun: 1 });
    names.push(name);
  }
  assert.notEqual(names[0], names[1]);
});

for (const release of [0, null, 'error', 'hang'] as const) {
  test(`uncertain named-lock release (${release}) destroys the socket without replay`, async () => {
    const fake = fakePool({ release });
    await assert.rejects(new MysqlPoolStore(fake.pool, { ...options, requestTimeoutMs: 50 }).acquireCatalog(caller(1)), /pool_exhausted/);
    assert.deepEqual(fake.stats(), { destroyed: 1, released: 0, commits: 1, begun: 1 });
  });
}

test('confirmed deadlock rollback releases the caller lock before reacquisition', async () => {
  let failed = false;
  const fake = fakePool({ query: sql => {
    if (!failed && sql.includes('SELECT member_identity AS identity')) {
      failed = true;
      throw Object.assign(new Error('synthetic deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    }
  } });
  await assert.rejects(new MysqlPoolStore(fake.pool, options).acquire(caller(1)), /pool_exhausted/);
  const lockCalls = fake.calls.filter(call => /GET_LOCK|RELEASE_LOCK/.test(call.sql));
  assert.deepEqual(lockCalls.map(call => call.sql.includes('GET_LOCK')), [true, false, true, false]);
  assert.equal(new Set(lockCalls.map(call => call.values![0])).size, 1);
  assert.deepEqual(fake.stats(), { destroyed: 0, released: 2, commits: 1, begun: 2 });
});

test('hung named-lock acquisition destroys the dedicated connection before any transaction', async () => {
  const fake = fakePool({ getLock: 'hang' });
  await assert.rejects(new MysqlPoolStore(fake.pool, { ...options, requestTimeoutMs: 30 }).acquire(caller(1)),
    (error: unknown) => (error as { code?: string }).code === 'POOL_SQL_TIMEOUT');
  assert.deepEqual(fake.stats(), { destroyed: 1, released: 0, commits: 0, begun: 0 });
  assert.equal(fake.calls.some(call => call.sql.includes('RELEASE_LOCK')), false);
});

test('pool queue timeout releases a late connection without acquiring any caller lock', async () => {
  let deliver!: (value: unknown) => void;
  let released = 0;
  const pool = { getConnection: () => new Promise(resolve => { deliver = resolve; }) } as unknown as Pool;
  await assert.rejects(new MysqlPoolStore(pool, { ...options, requestTimeoutMs: 20 }).acquire(caller(1)),
    (error: unknown) => (error as { code?: string }).code === 'POOL_SQL_TIMEOUT');
  deliver({ release: () => { released++; }, destroy: () => assert.fail('late unused connection can be released'),
    query: () => assert.fail('late connection must not execute SQL') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
});
