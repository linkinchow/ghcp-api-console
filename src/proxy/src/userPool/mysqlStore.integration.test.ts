import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, type Pool, type RowDataPacket } from 'mysql2/promise';
import { runMysqlMigrations } from '../db/mysqlMigrations.js';
import { UserPoolError, type PoolConfig } from './config.js';
import { MysqlPoolStore } from './mysqlStore.js';
import { MysqlConnectionError } from './mysqlDeadline.js';
import { accountName, NAME_CAPACITY } from './names.js';
import type { HeldLease, Inventory } from './store.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'synthetic.example.test', idleTarget: 4, maxAccounts: 8,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, prewarmConcurrency: 2,
  retryAfterSeconds: 30, warmupModel: 'synthetic-no-http', requestTimeoutMs: 120000,
};
const caller = (n: number): string => `sha256:${n.toString(16).padStart(64, '0')}`;
const mysqlUrl = process.env.MYSQL_TEST_URL;
const enabled = Boolean(mysqlUrl) && process.env.MYSQL_POOL_TEST_DISPOSABLE === '1';

async function rejectsCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof UserPoolError && error.code === code);
}

/**
 * Opt-in only: MYSQL_TEST_URL must name a loopback ghcp_pool_test_* database and
 * MYSQL_POOL_TEST_DISPOSABLE=1 must be explicit. That database is NEVER modified:
 * the suite creates/drops a random fresh sibling database (requires CREATE DATABASE).
 * No deployment env is loaded, no credentials are imported, and no HTTP is issued.
 */
test('MySQL user pool: isolated real multi-connection contract', {
  skip: enabled ? false : 'Requires loopback MYSQL_TEST_URL and MYSQL_POOL_TEST_DISPOSABLE=1; creates a fresh synthetic database.',
}, async (t) => {
  const url = new URL(mysqlUrl!);
  assert.equal(url.protocol, 'mysql:');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Refusing a non-loopback MySQL test server');
  assert.match(url.pathname, /^\/ghcp_pool_test_[a-z0-9_]+$/, 'Refusing a non-test MySQL URL');
  assert.equal(url.search, '', 'Connection overrides are not allowed in the disposable test URL');
  const name = `ghcp_pool_test_${randomUUID().replaceAll('-', '')}`;
  url.pathname = '/';
  const admin = createPool({ uri: url.toString(), connectionLimit: 1 });
  const pools: Pool[] = [];
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    url.pathname = `/${name}`;
    for (let i = 0; i < 2; i++) pools.push(createPool({ uri: url.toString(), connectionLimit: 3,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }));
    const [db, otherDb] = pools;
    const first = new MysqlPoolStore(db, options);
    const second = new MysqlPoolStore(otherDb, options);
    await runMysqlMigrations(db);
    await Promise.all([first.initialize(), second.initialize()]);

    const reset = async (patch: { idle_target?: number; max_accounts?: number } = {}) => {
      // Only the random database created above is ever cleaned. Keep schema/fingerprint.
      for (const table of ['user_pool_holds', 'user_pool_catalog_holds', 'user_pool_catalog_cooldowns',
        'user_pool_leases', 'user_pool_accounts', 'user_pool_events', 'proxy_accounts']) await db.query(`DELETE FROM ${table}`);
      await db.execute(`UPDATE user_pool_settings SET version=1, idle_target=?, max_accounts=?,
        lease_seconds=?, paused=0, next_ordinal=0, owner=NULL, owner_until=0 WHERE id=1`,
      [patch.idle_target ?? options.idleTarget, patch.max_accounts ?? options.maxAccounts, options.leaseSeconds]);
    };
    const ready = async (count = 1): Promise<string[]> => {
      const identities: string[] = [];
      for (let i = 0; i < count; i++) {
        const member = await first.reserve();
        assert.ok(member);
        await db.execute(`UPDATE proxy_accounts SET copilot_oauth_status='valid', copilot_oauth_token=?, gh_login=? WHERE identity=?`,
          [`SyntheticToken-${member.identity}`, member.identity, member.identity]);
        await first.update(member.identity, { state: 'ready', stage: 'ready', verified_at: await first.now() });
        identities.push(member.identity);
      }
      return identities;
    };
    const expireLease = async (held: HeldLease) => {
      await db.execute('UPDATE user_pool_leases SET expires_at=0 WHERE lease_id=?', [held.lease_id]);
    };

    await t.test('schema restart, binary identities, foreign keys, numeric epochs and configuration CAS', async () => {
      await reset();
      await Promise.all([first.initialize(), second.initialize()]);
      assert.equal(typeof await first.now(), 'number');
      const [member] = await ready();
      const inventory = (await first.inventory(member))!;
      assert.equal(typeof inventory.updated_at, 'number');
      assert.equal(typeof inventory.generation, 'number');
      assert.equal(await first.inventory(member.toUpperCase()), undefined);
      assert.equal(await first.managesSsoUser(member.toUpperCase()), true);
      await assert.rejects(db.execute('DELETE FROM proxy_accounts WHERE identity=?', [member]),
        (e: unknown) => (e as { code?: string }).code === 'ER_ROW_IS_REFERENCED_2');
      const writes = await Promise.allSettled([first.updateSettings(1, { paused: 1 }), second.updateSettings(1, { idle_target: 1 })]);
      assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1);
      const settings = await first.settings();
      assert.equal(settings.version, 2);
      assert.deepEqual(await second.settings(), settings);
      await rejectsCode(first.updateSettings(2, { idle_target: -1 }), 'invalid_pool_settings');
      await rejectsCode(first.updateSettings(2, { version: 20 }), 'invalid_pool_settings');
      const restarted = new MysqlPoolStore(otherDb, { ...options, idleTarget: 2, maxAccounts: 2, leaseSeconds: 60 });
      await restarted.initialize();
      assert.deepEqual(await restarted.settings(), settings, 'seed changes cannot overwrite settings');
      await assert.rejects(new MysqlPoolStore(otherDb, { ...options, accountDomain: 'other.test' }).initialize(), /domain differs/);
      await assert.rejects(new MysqlPoolStore(otherDb, { ...options, requestTimeoutMs: 5000 }).initialize(), /configuration differs/);
      assert.equal(JSON.stringify(await first.accounts()).includes('SyntheticToken'), false);
      const page = await first.page('accounts', { page: 1, pageSize: 1, q: member.toUpperCase(), state: 'ready_idle' });
      assert.equal(page.total, 1);
      assert.equal(page.items.length, 1);
      assert.equal(JSON.stringify(page).includes('SyntheticToken'), false);
      assert.equal((await second.page('accounts', { page: 2, pageSize: 1 })).items.length, 0);
      assert.equal(JSON.stringify(await first.events()).includes('SyntheticToken'), false);
    });

    await t.test('same caller races converge; distinct callers never share a member', async () => {
      await reset();
      await ready(2);
      const holds = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? first : second).acquire(caller(1))));
      assert.equal(new Set(holds.map((h) => h.lease_id)).size, 1);
      assert.equal(new Set(holds.map((h) => h.request_id)).size, 12);
      const races = await Promise.allSettled([first.acquire(caller(2)), second.acquire(caller(3))]);
      const winner = races.find((r) => r.status === 'fulfilled');
      assert.ok(winner?.status === 'fulfilled');
      assert.notEqual(winner.value.member_identity, holds[0].member_identity);
      assert.equal(races.filter((r) => r.status === 'rejected' && r.reason.code === 'pool_exhausted').length, 1);
      await Promise.all(holds.map((h) => first.finish(h, false)));
      assert.equal((await second.leases()).find((l) => l.caller_id === caller(1))!.expires_at, holds[0].expires_at);
      await rejectsCode(first.acquire('not-a-hash'), 'invalid_caller_identity');
    });

    await t.test('catalog/inference crossing pins one member and catalog never renews a lease', async () => {
      await reset();
      await ready(2);
      const discovery = await first.acquireCatalog(caller(1));
      assert.equal((await first.leases()).length, 0);
      assert.equal((await second.counts()).catalog_requests, 1);
      const [inference, parallelCatalog] = await Promise.all([second.acquire(caller(1)), first.acquireCatalog(caller(1))]);
      assert.equal(inference.member_identity, discovery.member_identity);
      assert.equal(parallelCatalog.member_identity, discovery.member_identity);
      const before = await first.leases();
      await first.finish(discovery, true);
      await second.finish(parallelCatalog, true);
      assert.equal(before[0].active_requests, 3);
      assert.deepEqual(await first.leases(), before.map(row => ({ ...row, active_requests: 1 })));
      await first.finish(inference, true);
      const active = (await first.leases())[0];
      assert.equal(active.phase, 'active');
      assert.equal(active.expires_at - active.last_success_at!, 172800000);
      const catalog = await second.acquireCatalog(caller(1));
      await first.finish(catalog, true);
      await second.finish(inference, true);
      assert.deepEqual((await first.leases())[0], active, 'duplicate success cannot renew');
    });

    await t.test('provisional expiry drains and successful live request may promote after TTL', async () => {
      await reset();
      const [identity] = await ready();
      const held = await first.acquire(caller(1));
      await expireLease(held);
      await first.reclaim();
      await rejectsCode(second.acquire(caller(1)), 'lease_draining');
      await rejectsCode(second.acquire(caller(2)), 'pool_exhausted');
      await rejectsCode(first.release(held.lease_id), 'lease_in_use');
      await first.releaseInactive(identity);
      assert.equal((await first.leases()).length, 1);
      await first.finish(held, true);
      assert.equal((await first.leases())[0].phase, 'active');
      const catalog = await second.acquireCatalog(caller(1));
      await expireLease(held);
      await first.reclaim();
      assert.equal((await first.leases()).length, 1, 'catalog also pins an expired lease');
      await first.finish(catalog, true);
      assert.equal((await first.leases()).length, 0);
      assert.equal((await second.counts()).ready_idle, 1);
    });

    await t.test('absolute deadline, drain grace, forged finish and stale completion are fenced', async () => {
      await reset();
      const [identity] = await ready();
      const held = await first.acquire(caller(1));
      const [before] = await db.query<RowDataPacket[]>('SELECT deadline_at, expires_at FROM user_pool_holds');
      assert.equal(await second.heartbeat(held), true);
      const [after] = await db.query<RowDataPacket[]>('SELECT deadline_at, expires_at FROM user_pool_holds');
      assert.deepEqual(after, before);
      assert.equal(Number(before[0].expires_at) - Number(before[0].deadline_at), 10000);
      const forged = { ...held, caller_id: caller(99) };
      await first.finish(forged, true);
      assert.equal(await first.heartbeat(forged), false);
      assert.equal(await first.hasHolds(identity), true);
      await db.execute('UPDATE user_pool_holds SET deadline_at=0 WHERE request_id=?', [held.request_id]);
      await expireLease(held);
      assert.equal(await second.heartbeat(held), false);
      await first.reclaim();
      assert.equal(await first.hasHolds(identity), true);
      await rejectsCode(first.release(held.lease_id), 'lease_in_use');
      await db.execute('UPDATE user_pool_holds SET expires_at=0 WHERE request_id=?', [held.request_id]);
      await first.reclaim();
      const replacement = await second.acquire(caller(2));
      await first.finish(held, true);
      assert.equal((await first.leases())[0].lease_id, replacement.lease_id);
      assert.equal((await first.leases())[0].phase, 'provisional');
    });

    await t.test('credential ABA fences all stale reports and failed admission preserves quarantine', async () => {
      await reset();
      const [identity] = await ready();
      const held = await first.acquire(caller(1));
      const initial = (await first.inventory(identity))!;
      await otherDb.execute('UPDATE proxy_accounts SET copilot_oauth_token=? WHERE identity=?', ['Replacement', identity]);
      await otherDb.execute('UPDATE proxy_accounts SET copilot_oauth_token=? WHERE identity=?', [`SyntheticToken-${identity}`, identity]);
      assert.equal((await first.inventory(identity))!.generation, initial.generation + 2);
      assert.equal(await second.heartbeat(held), false);
      assert.equal(await second.cool(identity, 60, held), false);
      assert.equal(await second.quarantine(identity, 'late', held), false);
      assert.equal(await second.recoverUnauthorized(held, `SyntheticToken-${identity}`), false);
      assert.equal(await first.update(identity, { state: 'ready', verified_at: await first.now() }, initial), false);
      await rejectsCode(first.acquire(caller(1)), 'member_unavailable');
      const quarantined = (await second.inventory(identity))!;
      assert.equal(quarantined.state, 'failed');
      assert.equal(quarantined.last_error, 'credential_not_verified', 'savepoint rejection cannot undo reclaim');
      assert.equal(await first.pending(), undefined, 'hold still pins work');
      await first.finish(held, true);
      assert.equal((await first.leases()).length, 0);
      assert.equal((await first.pending())!.identity, identity);
    });

    await t.test('trigger covers every credential field including byte-only changes, not metadata', async () => {
      await reset();
      const [identity] = await ready();
      let generation = (await first.inventory(identity))!.generation;
      await db.execute('UPDATE proxy_accounts SET updated_at=UTC_TIMESTAMP(3) WHERE identity=?', [identity]);
      assert.equal((await first.inventory(identity))!.generation, generation);
      const mutations: [string, string][] = [
        ['copilot_oauth_status', 'refreshing'], ['copilot_oauth_attempt_id', randomUUID()],
        ['gh_login', identity.toUpperCase()], ['gh_login', `${identity.toUpperCase()} `],
        ['sso_user', identity.toUpperCase()], ['copilot_oauth_updated_at', '2026-01-01 00:00:00.001'],
        ['copilot_oauth_token', 'DifferentToken'],
      ];
      for (const [column, value] of mutations) {
        await db.execute(`UPDATE proxy_accounts SET ${column}=? WHERE identity=?`, [value, identity]);
        assert.equal((await first.inventory(identity))!.generation, ++generation, column);
        assert.equal((await first.inventory(identity))!.verified_at, null);
      }
      await db.execute(`UPDATE proxy_accounts SET copilot_oauth_token='DifferentToken' WHERE identity=?`, [identity]);
      assert.equal((await first.inventory(identity))!.generation, generation, 'no-op update does not fence');
    });

    await t.test('401 uses exact token, schedules existing member, and bounds reauthorization cycles', async () => {
      await reset();
      const [identity] = await ready();
      for (let cycle = 0; cycle < 4; cycle++) {
        const held = await first.acquire(caller(1));
        assert.equal(await second.recoverUnauthorized(held, `synthetictoken-${identity}`), false);
        assert.equal(await second.recoverUnauthorized(held, `SyntheticToken-${identity} `), false);
        assert.equal(await second.recoverUnauthorized(held, `SyntheticToken-${identity}`), true);
        assert.equal(await first.recoverUnauthorized(held, `SyntheticToken-${identity}`), false);
        let inventory = (await first.inventory(identity))!;
        assert.equal(inventory.stage, 'synced');
        assert.equal(inventory.reauth_count, Math.min(cycle + 1, 3));
        assert.equal(inventory.attempts, cycle === 3 ? 3 : 0);
        assert.equal(inventory.last_error, cycle === 3 ? 'oauth_reauth_limit_reached' : 'upstream_unauthorized');
        await first.finish(held, true);
        assert.equal((await first.counts()).total, 1);
        if (cycle < 3) {
          await first.retry(identity);
          await db.execute(`UPDATE proxy_accounts SET copilot_oauth_token=?, copilot_oauth_status='valid' WHERE identity=?`,
            [`SyntheticToken-${identity}`, identity]);
          inventory = (await first.inventory(identity))!;
          assert.equal(await first.update(identity, { state: 'ready', stage: 'ready', verified_at: await first.now() }, inventory), true);
        }
      }
      assert.equal(await first.pending(), undefined);
    });

    await t.test('cooling retains bindings and catalog-only caller cooldown survives finish', async () => {
      await reset();
      const [identity] = await ready(2);
      const catalog = await first.acquireCatalog(caller(1));
      assert.equal(catalog.member_identity, identity);
      assert.equal(await second.cool(identity, 60, catalog), true);
      const until = (await first.inventory(identity))!.cooldown_until;
      assert.equal(await first.cool(identity, 1, catalog), true);
      assert.equal((await first.inventory(identity))!.cooldown_until, until);
      await first.finish(catalog, true);
      await rejectsCode(second.acquire(caller(1)), 'member_cooling');
      await rejectsCode(second.acquireCatalog(caller(1)), 'member_cooling');
      const other = await second.acquire(caller(2));
      assert.notEqual(other.member_identity, identity);
      assert.equal(await first.cool(other.member_identity, 60, other), true);
      await expireLease(other);
      await first.finish(other, true);
      assert.equal((await first.leases()).length, 1, 'cooling pins even expired lease');
      await rejectsCode(first.acquire(caller(2)), 'member_cooling');
      await db.execute('UPDATE user_pool_accounts SET cooldown_until=0');
      await db.execute('UPDATE user_pool_catalog_cooldowns SET expires_at=0');
      await first.reclaim();
      assert.equal((await first.counts()).ready_idle, 2);
      await rejectsCode(first.cool(identity, Infinity), 'invalid_cooldown');
    });

    await t.test('multi-writer reservations obey hard cap, retries count toward future inventory', async () => {
      await reset({ idle_target: 3, max_accounts: 3 });
      const reserved = await Promise.all(Array.from({ length: 12 }, (_, n) => (n % 2 ? first : second).reserve()));
      assert.equal(reserved.filter(Boolean).length, 3);
      assert.equal(new Set(reserved.filter(Boolean).map((i) => i!.identity)).size, 3);
      const row = reserved.find(Boolean)!;
      await first.fail(row.identity, 'temporary', row);
      const failed = (await first.inventory(row.identity))!;
      assert.equal(failed.attempts, 1);
      assert.ok(failed.retry_at > await first.now());
      assert.equal(await second.reserve(), undefined);
      await first.updateSettings(1, { idle_target: 3, max_accounts: 8 });
      assert.equal(await second.reserve(), undefined, 'backing-off repair already represents capacity');
      await first.disable(row.identity);
      assert.equal((await first.inventory(row.identity))!.state, 'disabled');
      assert.equal(await first.update(row.identity, { state: 'ready' }), false);
      await first.retry(row.identity);
      assert.notEqual((await first.inventory(row.identity))!.attempt_id, row.attempt_id);
      assert.equal(await first.update(row.identity, { state: 'ready' }, row), false);
      await first.update(row.identity, { state: 'failed', last_error: 'oauth_dispatch_ambiguous', attempts: 0 });
      await rejectsCode(second.retry(row.identity), 'manual_reconciliation_required');
    });

    await t.test('reservation batches bounded, aliases skipped, and name exhaustion never wraps', async () => {
      await reset({ idle_target: 80, max_accounts: 80 });
      const owner = randomUUID();
      assert.equal(await first.claimOwner(owner), true);
      const count = await second.reserveDeficit(owner);
      assert.ok(count > 0 && count <= 32);
      assert.equal((await first.counts()).total, count);
      assert.equal(await first.reserveDeficit(randomUUID()), 0);
      await reset();
      await db.execute(`INSERT INTO proxy_accounts(identity,sso_user,created_at,updated_at)
        VALUES (?, 'direct', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)), ('direct-alias', ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [accountName(0).toUpperCase(), accountName(1).toUpperCase()]);
      assert.equal((await first.reserve())!.ordinal, 2);
      await db.execute('UPDATE user_pool_settings SET next_ordinal=?', [NAME_CAPACITY - 1]);
      assert.equal((await first.reserve())!.ordinal, NAME_CAPACITY - 1);
      await rejectsCode(second.reserve(), 'name_catalog_exhausted');
      await rejectsCode(first.reserve(), 'name_catalog_exhausted');
      const [rows] = await db.query<RowDataPacket[]>('SELECT next_ordinal FROM user_pool_settings');
      assert.equal(Number(rows[0].next_ordinal), NAME_CAPACITY);
    });

    await t.test('owner expiry and atomic worker credential fences reject late work and stale callbacks', async () => {
      await reset();
      const owners = [randomUUID(), randomUUID()];
      const claims = await Promise.all([first.claimOwner(owners[0]), second.claimOwner(owners[1])]);
      assert.equal(claims.filter(Boolean).length, 1);
      const owner = owners[claims[0] ? 0 : 1];
      assert.equal(await first.claimOwner(owner), true);
      let row = (await first.reserve())!;
      assert.equal(await first.mutateWorkerCredential(row.identity, { ...row, stage: 'wrong' }, owner,
        { type: 'link', ghLogin: 'synthetic-gh' }), false);
      assert.equal(await first.mutateWorkerCredential(row.identity, row, owner, { type: 'link', ghLogin: 'synthetic-gh' }), true);
      assert.equal(await second.update(row.identity, { stage: 'synced' }, row, owner), false, 'link increments generation');
      row = (await first.inventory(row.identity))!;
      const oauthAttemptId = randomUUID();
      assert.equal(await second.mutateWorkerCredential(row.identity, row, owner, { type: 'begin', oauthAttemptId }), true);
      const [staleCallback] = await db.execute<RowDataPacket[]>(`SELECT identity FROM proxy_accounts
        WHERE identity=? AND copilot_oauth_attempt_id=?`, [row.identity, randomUUID()]);
      assert.equal(staleCallback.length, 0);
      const [staleWrite] = await db.execute(`UPDATE proxy_accounts SET copilot_oauth_token='stale', copilot_oauth_status='valid'
        WHERE identity=? AND copilot_oauth_attempt_id=?`, [row.identity, randomUUID()]);
      assert.equal((staleWrite as { affectedRows: number }).affectedRows, 0);
      await db.execute(`UPDATE proxy_accounts SET copilot_oauth_token='callback-token', copilot_oauth_status='valid',
        copilot_oauth_attempt_id=NULL WHERE identity=? AND copilot_oauth_attempt_id=?`, [row.identity, oauthAttemptId]);
      row = (await first.inventory(row.identity))!;
      await db.execute('UPDATE user_pool_settings SET owner_until=0');
      assert.equal(await first.claimOwner(owner), false, 'expired UUID cannot revive its tenure');
      assert.equal(await second.update(row.identity, { stage: 'ready' }, row, owner), false);
      await first.fail(row.identity, 'stale-owner', row, owner);
      assert.equal((await first.inventory(row.identity))!.state, 'provisioning');
      assert.equal(await first.mutateWorkerCredential(row.identity, row, owner, { type: 'invalidate', expectedToken: 'callback-token' }), false);
      const replacement = randomUUID();
      assert.equal(await second.claimOwner(replacement), true);
      await first.releaseOwner(owner);
      assert.equal(await second.claimOwner(replacement), true);
      assert.equal(await second.mutateWorkerCredential(row.identity, row, replacement,
        { type: 'invalidate', expectedToken: 'callback-token' }), true);
    });

    await t.test('external account update cannot invert inventory locking or validate stale warmup', async () => {
      await reset();
      const [identity] = await ready();
      const snapshot: Inventory = (await first.inventory(identity))!;
      const connection = await otherDb.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('SELECT identity FROM proxy_accounts WHERE identity=? FOR UPDATE', [identity]);
        const checkpoint = first.update(identity, { verified_at: await first.now() }, snapshot);
        // Trigger can update inventory without waiting for a pool transaction that is waiting on Proxy.
        await connection.execute('UPDATE proxy_accounts SET copilot_oauth_token=? WHERE identity=?', ['rotated', identity]);
        await connection.commit();
        assert.equal(await checkpoint, false);
      } finally {
        await connection.rollback();
        connection.release();
      }
    });

    await t.test('lock wait failure rolls back without partial settings or event changes', async () => {
      await reset();
      const blocker = await db.getConnection();
      const limited = createPool({ uri: url.toString(), connectionLimit: 1 });
      try {
        await limited.query('SET SESSION innodb_lock_wait_timeout=1');
        const victim = new MysqlPoolStore(limited, options);
        await blocker.beginTransaction();
        await blocker.query('SELECT id FROM user_pool_settings WHERE id=1 FOR UPDATE');
        await assert.rejects(victim.updateSettings(1, { paused: 1 }),
          (e: unknown) => (e as { code?: string }).code === 'ER_LOCK_WAIT_TIMEOUT');
        await blocker.rollback();
        assert.equal((await first.settings()).paused, 0);
        assert.equal((await first.events()).length, 0);
        assert.equal((await victim.updateSettings(1, { paused: 1 })).version, 2);
      } finally {
        await blocker.rollback();
        blocker.release();
        await limited.end();
      }
    });

    await t.test('events are bounded and inventory disable respects live catalog holds', async () => {
      await reset();
      const [identity] = await ready();
      const catalog = await first.acquireCatalog(caller(1));
      await second.disable(identity);
      assert.equal(await first.heartbeat(catalog), false);
      await rejectsCode(first.retry(identity), 'member_in_use');
      await first.finish(catalog, true);
      await first.retry(identity);
      assert.equal((await first.inventory(identity))!.stage, 'warmup');
      // Seed synthetic audit rows in bulk, then exercise the provider retention boundary.
      for (let offset = 0; offset < 10020; offset += 500) {
        const count = Math.min(500, 10020 - offset);
        await db.query(`INSERT INTO user_pool_events(at, action) VALUES ${Array(count).fill("(1, 'synthetic')").join(',')}`);
      }
      await first.event('last');
      const [rows] = await db.query<RowDataPacket[]>('SELECT COUNT(*) n FROM user_pool_events');
      assert.equal(Number(rows[0].n), 10000);
      assert.equal((await first.events()).length, 200);
    });
    await t.test('dispatch backpressure retains uncertain slots and releases only fenced terminal observations', async () => {
      await reset();
      const owner = randomUUID();
      assert.equal(await first.claimOwner(owner), true);
      const a = (await first.reserve())!, b = (await first.reserve())!;
      for (const row of [a, b]) await first.update(row.identity, { stage: 'oauth-starting', oauth_attempt_id: randomUUID() });
      assert.equal(await first.claimLoginDispatch(a.identity, (await first.inventory(a.identity))!, owner, 1), true);
      assert.equal(await second.claimLoginDispatch(b.identity, (await second.inventory(b.identity))!, owner, 1), false);
      await first.fail(a.identity, 'service_unavailable');
      await first.update(a.identity, { attempts: 3 });
      const fence = (await first.inventory(a.identity))!;
      assert.equal((await second.listLoginReservations()).length, 1);
      assert.equal(await second.releaseLoginReservation(a.identity, { ...fence, generation: fence.generation - 1 }, owner, 'success'), false);
      await first.updateSettings((await first.settings()).version, { paused: 1 });
      assert.equal(await first.releaseLoginReservation(a.identity, fence, owner, 'success'), false);
      await first.updateSettings((await first.settings()).version, { paused: 0 });
      assert.equal(await second.releaseLoginReservation(a.identity, fence, owner, 'success'), true);
      const settled = (await first.inventory(a.identity))!;
      assert.equal(settled.state, 'failed');
      assert.equal(settled.attempts, 3);
      assert.equal(settled.last_error, 'service_unavailable');
      assert.equal(settled.stage, 'warmup');
      assert.equal(settled.generation, fence.generation + 1);
      assert.equal(await second.claimLoginDispatch(b.identity, (await second.inventory(b.identity))!, owner, 1), true);
    });

    await t.test('catalog admission rereads a lease renewed while it waits for the member lock', async () => {
      await reset();
      const [identity] = await ready();
      const held = await first.acquire(caller(1));
      const connection = await otherDb.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('SELECT identity FROM proxy_accounts WHERE identity=? FOR UPDATE', [identity]);
        const admission = second.acquireCatalog(caller(1));
        await new Promise(resolve => setTimeout(resolve, 100));
        await connection.query('UPDATE user_pool_leases SET phase=\'active\', last_success_at=?, expires_at=? WHERE lease_id=?',
          [await first.now(), await first.now() + 172800000, held.lease_id]);
        await connection.commit();
        const catalog = await admission;
        assert.equal(catalog.member_identity, identity);
        await first.finish(catalog, true);
        await first.finish(held, false);
        assert.equal((await first.leases())[0].phase, 'active');
      } finally { await connection.rollback(); connection.release(); }
    });

    await t.test('startup fails closed if an installed credential fence disappears', async () => {
      await db.query('DROP TRIGGER user_pool_credential_fence');
      await assert.rejects(first.initialize(), /credential fence is missing/);
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    try {
      if (created) await admin.query(`DROP DATABASE \`${name}\``);
    } finally { await admin.end(); }
  }
});

// These fault-injection tests run without MySQL and never access any network.
test('MySQL pool destroys an ambiguous COMMIT disconnect without rollback or replay', async () => {
  const cause = Object.assign(new Error('lost commit response'), { code: 'PROTOCOL_CONNECTION_LOST' });
  let begins = 0;
  let commits = 0;
  let rollbacks = 0;
  let connections = 0;
  let destroyed = 0;
  let released = 0;
  const fake = {
    getConnection: async () => {
      connections++;
      return {
        query: async (sql: string) => {
          if (sql.includes('SELECT id FROM user_pool_settings')) return [[{ id: 1 }]];
          if (sql.includes('TIMESTAMPDIFF')) return [[{ now: '1800000000000' }]];
          if (sql.includes('MAX(id)')) return [[{ n: -9999 }]];
          return [{ affectedRows: 1 }];
        },
        beginTransaction: async () => { begins++; },
        commit: async () => { commits++; throw cause; },
        rollback: async () => { rollbacks++; },
        release: () => { released++; },
        destroy: () => { destroyed++; },
      };
    },
  } as unknown as Pool;
  await assert.rejects(new MysqlPoolStore(fake, options).event('synthetic'), (error: unknown) => {
    assert.ok(error instanceof MysqlConnectionError);
    assert.equal(error.cause, cause);
    assert.equal(error.message, 'User pool MySQL storage is unavailable');
    return true;
  });
  assert.equal(connections, 1);
  assert.equal(begins, 1);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 0, 'The disconnected socket is already destroyed; do not queue rollback on it');
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
});

test('MySQL pool never retries an unconfirmed rollback, even for a deadlock code', async () => {
  let connections = 0;
  let destroyed = 0;
  let released = 0;
  const fake = {
    getConnection: async () => {
      connections++;
      return {
        query: async (sql: string) => {
          if (sql.includes('FOR UPDATE')) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
          return [{ affectedRows: 1 }];
        },
        beginTransaction: async () => {},
        commit: async () => assert.fail('must not commit'),
        rollback: async () => { throw new Error('connection lost during rollback'); },
        destroy: () => { destroyed++; },
        release: () => { released++; },
      };
    },
  } as unknown as Pool;
  await assert.rejects(new MysqlPoolStore(fake, options).claimOwner('synthetic'), /deadlock/);
  assert.equal(connections, 1);
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
});

test('MySQL pool retries only confirmed rollback lock errors with a fresh transaction', async () => {
  let connections = 0;
  let rollbacks = 0;
  let commits = 0;
  const fake = {
    getConnection: async () => {
      const attempt = ++connections;
      return {
        query: async (sql: string) => {
          if (sql.includes('SELECT id FROM user_pool_settings')) {
            if (attempt === 1) throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
            return [[{ id: 1 }]];
          }
          if (sql.includes('TIMESTAMPDIFF')) return [[{ now: '1800000000000' }]];
          if (sql.includes('MAX(id)')) return [[{ n: -9999 }]];
          return [{ affectedRows: 1 }];
        },
        beginTransaction: async () => {}, commit: async () => { commits++; },
        rollback: async () => { rollbacks++; }, release: () => {}, destroy: () => {},
      };
    },
  } as unknown as Pool;
  await new MysqlPoolStore(fake, options).claimOwner('synthetic');
  assert.equal(connections, 2);
  assert.equal(rollbacks, 1);
  assert.equal(commits, 1);
});
