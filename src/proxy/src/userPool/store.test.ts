import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig, UserPoolError, type PoolConfig } from './config.js';
import { accountName, NAME_CAPACITY } from './names.js';
import { UserPoolStore, type HeldLease } from './store.js';

const options = readPoolConfig({
  ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'accounts.example.test',
  POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '10', POOL_MAX_ACCOUNTS: '100',
});
const caller = (number: number): string => `sha256:${number.toString(16).padStart(64, '0')}`;

function fixture(t: TestContext, patch: Partial<PoolConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'user-pool-core-'));
  const path = join(dir, 'pool.sqlite');
  const connections: BetterSqlite3.Database[] = [];
  const clock = { now: 1_800_000_000_000 };
  const config = { ...options, ...patch };
  function connect() {
    const db = new BetterSqlite3(path);
    connections.push(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    runMigrations(db);
    const store = new UserPoolStore(db, config);
    store.now = () => clock.now;
    return { db, store };
  }
  const first = connect();
  t.after(() => {
    for (const db of connections) if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function ready(count = 1): string[] {
    const members: string[] = [];
    for (let index = 0; index < count; index++) {
      const row = first.store.reserve();
      assert.ok(row);
      first.db.prepare(`
        UPDATE proxy_accounts SET copilot_oauth_token = ?, copilot_oauth_status = 'valid', gh_login = ?
        WHERE identity = ?
      `).run(`token-${row.identity}`, row.identity, row.identity);
      first.store.update(row.identity, {
        state: 'ready', stage: 'ready', verified_at: clock.now, attempts: 0, last_error: null,
      });
      members.push(row.identity);
    }
    return members;
  }
  return { ...first, path, connect, ready, clock, config };
}

function errorCode(action: () => unknown, code: string, status?: number): void {
  assert.throws(action, (error: unknown) => error instanceof UserPoolError && error.code === code
    && (status === undefined || error.status === status));
}

// The same test file also acts as a real, separate SQLite-connection worker. These are
// local test threads, not network services; the barrier makes their writes contend.
if (!isMainThread) {
  const data = workerData as { path: string; barrier: SharedArrayBuffer; caller: string; operation: string; now: number };
  const db = new BetterSqlite3(data.path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 10000');
  const store = new UserPoolStore(db, options);
  store.now = () => data.now;
  parentPort!.postMessage({ ready: true });
  const barrier = new Int32Array(data.barrier);
  Atomics.wait(barrier, 0, 0);
  try {
    const result = data.operation === 'reserve' ? store.reserve()
      : data.operation === 'catalog' ? store.acquireCatalog(data.caller) : store.acquire(data.caller);
    parentPort!.postMessage({ result });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof UserPoolError ? error.code : String(error) });
  } finally {
    db.close();
  }
} else {
  test('already canceled inference and catalog admission do not mutate SQLite holds or leases', t => {
    const f = fixture(t);
    f.ready();
    const controller = new AbortController();
    const reason = new Error('disconnected before admission');
    controller.abort(reason);
    assert.throws(() => f.store.acquire(caller(1), controller.signal), error => error === reason);
    assert.throws(() => f.store.acquireCatalog(caller(1), controller.signal), error => error === reason);
    assert.equal(f.store.leases().length, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM user_pool_holds').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM user_pool_catalog_holds').get() as { n: number }).n, 0);
  });

  test('initial pool schema upgrades preserve inventory and drain unfenced legacy holds', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'user-pool-migration-'));
    const db = new BetterSqlite3(join(dir, 'legacy.sqlite'));
    t.after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.exec(`
      CREATE TABLE user_pool_settings (
        id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, idle_target INTEGER NOT NULL,
        max_accounts INTEGER NOT NULL, lease_seconds INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
        next_ordinal INTEGER NOT NULL DEFAULT 0, account_domain TEXT NOT NULL,
        owner TEXT, owner_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE user_pool_accounts (
        identity TEXT PRIMARY KEY REFERENCES proxy_accounts(identity), ordinal INTEGER UNIQUE NOT NULL,
        state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'new', attempt_id TEXT NOT NULL, task_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        updated_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, verified_at INTEGER
      );
      CREATE TABLE user_pool_leases (
        caller_id TEXT PRIMARY KEY, member_identity TEXT UNIQUE NOT NULL REFERENCES user_pool_accounts(identity),
        lease_id TEXT UNIQUE NOT NULL, phase TEXT NOT NULL, assigned_at INTEGER NOT NULL,
        last_success_at INTEGER, expires_at INTEGER NOT NULL
      );
      CREATE TABLE user_pool_holds (
        request_id TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES user_pool_leases(lease_id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
    `);
    let now = 1_800_000_000_000;
    const member = accountName(0);
    db.prepare(`INSERT INTO user_pool_settings
      (id, idle_target, max_accounts, lease_seconds, account_domain, next_ordinal) VALUES (1, 10, 100, 172800, ?, 1)`)
      .run(options.accountDomain);
    db.prepare(`INSERT INTO proxy_accounts
      (identity, sso_user, copilot_oauth_status, copilot_oauth_token, created_at, updated_at)
      VALUES (?, ?, 'valid', 'old-token', 'old', 'old')`).run(member, member);
    db.prepare(`INSERT INTO user_pool_accounts(identity, ordinal, state, stage, attempt_id, updated_at, verified_at)
      VALUES (?, 0, 'ready', 'ready', 'old-attempt', ?, ?)`).run(member, now, now);
    db.prepare('INSERT INTO user_pool_leases VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(caller(1), member, 'legacy-lease', 'provisional', now, now + 1000);
    db.prepare('INSERT INTO user_pool_holds VALUES (?, ?, ?)').run('legacy-request', 'legacy-lease', now + 5000);
    const store = new UserPoolStore(db, options);
    store.now = () => now;
    const held: HeldLease = { ...store.leases()[0], request_id: 'legacy-request' };
    assert.equal(store.inventory(member)!.generation, 0);
    assert.equal(store.inventory(member)!.oauth_attempt_id, null);
    assert.equal(store.heartbeat(held), false);
    now += 2000;
    store.reclaim();
    errorCode(() => store.acquire(caller(2)), 'pool_exhausted');
    assert.equal(store.hasHolds(member), true);
    now += 3000;
    store.reclaim();
    assert.equal(store.hasHolds(member), false);
    const replacement = store.acquire(caller(2));
    store.finish(held, true);
    assert.equal(store.leases()[0].lease_id, replacement.lease_id);
    assert.equal(store.leases()[0].phase, 'provisional');
  });

  test('valid replacement credentials require fresh warmup before new admissions', (t) => {
    const f = fixture(t);
    const [identity] = f.ready(1);
    const held = f.store.acquire(caller(1));
    f.store.finish(held, true);
    f.db.prepare('UPDATE proxy_accounts SET copilot_oauth_token = ? WHERE identity = ?').run('new-token', identity);
    assert.equal(f.store.inventory(identity)!.verified_at, null);
    assert.equal(f.store.counts().ready_idle, 0);
    assert.equal(f.store.inventory(identity)!.stage, 'warmup');
    errorCode(() => f.store.acquire(caller(2)), 'pool_exhausted');
    f.store.update(identity, { state: 'ready', verified_at: f.clock.now });
    assert.equal(f.store.acquire(caller(2)).member_identity, identity);
  });

  test('same caller shares one exclusive lease; failure and acquisition never renew it', (t) => {
    const f = fixture(t);
    const [first, second] = f.ready(2);
    const held = f.store.acquire(caller(1));
    assert.equal(held.member_identity, first);
    assert.equal(held.phase, 'provisional');
    assert.equal(held.expires_at, f.clock.now + 300000);
    f.clock.now += 5000;
    const parallel = f.connect().store.acquire(caller(1));
    assert.equal(parallel.lease_id, held.lease_id);
    assert.notEqual(parallel.request_id, held.request_id);
    assert.equal(parallel.expires_at, held.expires_at);
    const other = f.store.acquire(caller(2));
    assert.equal(other.member_identity, second);
    assert.equal(f.store.leases().length, 2);
    errorCode(() => f.store.acquire(caller(3)), 'pool_exhausted', 429);
    f.store.finish(held, false);
    f.store.finish(parallel, false);
    assert.equal(f.store.leases().find((lease) => lease.caller_id === caller(1))!.expires_at, held.expires_at);
    errorCode(() => f.store.acquire('alice@example.test'), 'invalid_caller_identity', 403);
  });

  test('only a live successful request promotes and renews to persisted 48-hour TTL', (t) => {
    const f = fixture(t);
    f.ready();
    const held = f.store.acquire(caller(1));
    f.clock.now += 500;
    f.store.finish(held, true);
    const active = f.store.leases()[0];
    assert.equal(active.phase, 'active');
    assert.equal(active.last_success_at, f.clock.now);
    assert.equal(active.expires_at, f.clock.now + 172800000);
    f.clock.now += 10000;
    f.store.finish(held, true);
    assert.deepEqual(f.store.leases()[0], active, 'duplicate success cannot extend TTL');
    const next = f.store.acquire(caller(1));
    const settings = f.store.settings();
    f.store.updateSettings(settings.version, { lease_seconds: 3600 });
    f.clock.now += 10;
    f.store.finish(next, true);
    assert.equal(f.store.leases()[0].expires_at, f.clock.now + 3600000);
  });

  test('provisional and active expiry cannot reassign a member with a live request', (t) => {
    const f = fixture(t, { provisionalSeconds: 10 });
    const [member] = f.ready();
    const held = f.store.acquire(caller(1));
    f.clock.now += 11000;
    f.store.reclaim();
    assert.equal(f.store.leases().length, 1);
    errorCode(() => f.store.acquire(caller(1)), 'lease_draining', 503);
    errorCode(() => f.store.acquire(caller(2)), 'pool_exhausted', 429);
    f.store.finish(held, true);
    assert.equal(f.store.leases()[0].phase, 'active', 'a pinned live request may finish after provisional expiry');
    f.db.prepare('UPDATE user_pool_leases SET expires_at = ?').run(f.clock.now + 1000);
    const activeHold = f.store.acquire(caller(1));
    f.clock.now += 2000;
    f.store.reclaim();
    assert.equal(f.store.hasHolds(member), true);
    errorCode(() => f.store.acquire(caller(2)), 'pool_exhausted');
    f.store.finish(activeHold, false);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.acquire(caller(2)).member_identity, member);
  });

  test('request deadline is absolute; heartbeat cannot resurrect or renew timed-out work', (t) => {
    const f = fixture(t, { requestTimeoutMs: 5000, provisionalSeconds: 10 });
    const [member] = f.ready();
    const held = f.store.acquire(caller(1));
    assert.equal(held.deadline_at, f.clock.now + 5000);
    const expires = f.db.prepare('SELECT expires_at FROM user_pool_holds').get() as { expires_at: number };
    f.clock.now += 4000;
    assert.equal(f.store.heartbeat(held), true);
    assert.deepEqual(f.db.prepare('SELECT expires_at FROM user_pool_holds').get(), expires);
    f.clock.now += 1000;
    assert.equal(f.store.heartbeat(held), false);
    f.clock.now += 6000;
    f.store.reclaim();
    assert.equal(f.store.hasHolds(member), true, 'drain grace still blocks reassignment');
    errorCode(() => f.store.release(held.lease_id), 'lease_in_use');
    f.clock.now += 4000;
    f.store.reclaim();
    assert.equal(f.store.hasHolds(member), false);
    const reassigned = f.store.acquire(caller(2));
    f.store.finish(held, true);
    assert.equal(f.store.heartbeat(held), false);
    assert.equal(f.store.leases()[0].lease_id, reassigned.lease_id);
    assert.equal(f.store.leases()[0].phase, 'provisional');
  });

  test('late completion within drain grace removes hold without success renewal', (t) => {
    const f = fixture(t, { requestTimeoutMs: 5000 });
    f.ready();
    const held = f.store.acquire(caller(1));
    f.clock.now += 5001;
    f.store.finish(held, true);
    assert.equal(f.store.leases()[0].phase, 'provisional');
    assert.equal(f.store.hasHolds(held.member_identity), false);
  });

  test('credential mutations including ABA replacement fence old completions and failure reports', (t) => {
    const f = fixture(t);
    const [member] = f.ready();
    const held = f.store.acquire(caller(1));
    const original = f.store.inventory(member)!.generation;
    const other = f.connect();
    other.db.prepare('UPDATE proxy_accounts SET copilot_oauth_token = ? WHERE identity = ?').run('replacement', member);
    other.db.prepare('UPDATE proxy_accounts SET copilot_oauth_token = ? WHERE identity = ?').run(`token-${member}`, member);
    assert.equal(f.store.inventory(member)!.generation, original + 2);
    assert.equal(f.store.heartbeat(held), false);
    assert.equal(f.store.cool(member, 30, held), false);
    assert.equal(f.store.quarantine(member, 'old_401', held), false);
    f.store.finish(held, true);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.inventory(member)!.last_error, 'credential_not_verified');
    f.store.update(member, { state: 'ready', stage: 'ready', verified_at: f.clock.now });
    const current = f.store.acquire(caller(1));
    f.store.finish(current, true);
    assert.equal(f.store.leases()[0].phase, 'active');
  });

  test('status/authorization/login changes fence holds but unrelated metadata changes do not', (t) => {
    const f = fixture(t);
    const [member] = f.ready();
    const first = f.store.acquire(caller(1));
    f.db.prepare('UPDATE proxy_accounts SET updated_at = ? WHERE identity = ?').run('unrelated', member);
    assert.equal(f.store.heartbeat(first), true);
    for (const assignment of [
      "copilot_oauth_status = 'refreshing'", "copilot_oauth_attempt_id = 'new-attempt'",
      "gh_login = 'changed-login'", "sso_user = 'changed-sso'", "copilot_oauth_updated_at = 'changed-time'",
    ]) {
      const before = f.store.inventory(member)!.generation;
      f.db.prepare(`UPDATE proxy_accounts SET ${assignment} WHERE identity = ?`).run(member);
      assert.equal(f.store.inventory(member)!.generation, before + 1);
    }
    assert.equal(f.store.heartbeat(first), false);
    f.store.finish(first, true);
    assert.equal(f.store.inventory(member)!.state, 'failed');
    assert.equal(f.store.leases().length, 0);
  });

  test('completion must match request, lease, member, and caller together', (t) => {
    const f = fixture(t);
    f.ready(2);
    const first = f.store.acquire(caller(1));
    const second = f.store.acquire(caller(2));
    for (const forged of [
      { ...first, request_id: second.request_id }, { ...first, caller_id: caller(2) },
      { ...first, member_identity: second.member_identity }, { ...first, lease_id: second.lease_id },
    ]) {
      f.store.finish(forged, true);
      assert.equal(f.store.heartbeat(forged), false);
    }
    assert.equal(f.store.hasHolds(first.member_identity), true);
    assert.equal(f.store.hasHolds(second.member_identity), true);
    assert.ok(f.store.leases().every((lease) => lease.phase === 'provisional'));
  });

  test('catalog discovery has only request-scoped holds and never promotes/renews caller leases', (t) => {
    const f = fixture(t);
    const [member] = f.ready();
    const catalog = f.store.acquireCatalog(caller(1));
    assert.equal(catalog.kind, 'catalog');
    assert.equal(catalog.member_identity, member);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.counts().catalog_requests, 1);
    assert.equal(f.store.counts().ready_idle, 0);
    errorCode(() => f.store.acquireCatalog(caller(2)), 'pool_exhausted');
    errorCode(() => f.store.acquire(caller(2)), 'pool_exhausted');
    const second = f.connect().store.acquireCatalog(caller(1));
    assert.equal(second.member_identity, member);
    const inference = f.store.acquire(caller(1));
    assert.equal(inference.member_identity, member);
    const lease = f.store.leases()[0];
    f.store.finish(catalog, true);
    assert.deepEqual(f.store.leases()[0], { ...lease, active_requests: 2 });
    f.store.finish(inference, true);
    const active = f.store.leases()[0];
    f.clock.now += 1000;
    f.store.finish(second, true);
    assert.deepEqual(f.store.leases()[0], { ...active, active_requests: 0 });
    const onActive = f.store.acquireCatalog(caller(1));
    f.store.finish(onActive, true);
    assert.deepEqual(f.store.leases()[0], { ...active, active_requests: 0 });
  });

  test('catalog-only finish/expiry promptly frees capacity, while disable/retry respects discovery holds', (t) => {
    const f = fixture(t, { requestTimeoutMs: 5000 });
    const [member] = f.ready();
    const catalog = f.store.acquireCatalog(caller(1));
    f.store.finish(catalog, false);
    assert.equal(f.store.counts().ready_idle, 1);
    const next = f.store.acquireCatalog(caller(2));
    f.store.disable(member);
    assert.equal(f.store.heartbeat(next), false);
    errorCode(() => f.store.retry(member), 'member_in_use');
    f.clock.now += 15000;
    f.store.reclaim();
    f.store.retry(member);
    f.db.prepare("UPDATE proxy_accounts SET copilot_oauth_status = 'valid' WHERE identity = ?").run(member);
    f.store.update(member, { state: 'ready', verified_at: f.clock.now });
    const reassigned = f.store.acquireCatalog(caller(3));
    assert.equal(reassigned.member_identity, member);
    f.store.finish(next, true);
    assert.equal(f.store.hasHolds(member), true);
    assert.equal(f.store.leases().length, 0);
  });

  test('catalog hold also pins an expired active lease until discovery drains', (t) => {
    const f = fixture(t);
    f.ready();
    const first = f.store.acquire(caller(1));
    f.store.finish(first, true);
    f.db.prepare('UPDATE user_pool_leases SET expires_at = ?').run(f.clock.now + 500);
    const catalog = f.store.acquireCatalog(caller(1));
    f.clock.now += 1000;
    f.store.reclaim();
    errorCode(() => f.store.release(first.lease_id), 'lease_in_use');
    errorCode(() => f.store.acquire(caller(2)), 'pool_exhausted');
    f.store.finish(catalog, true);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.counts().ready_idle, 1);
  });

  test('429 cooldown never rotates callers, never shortens on repeated reports, or bypasses by retry', (t) => {
    const f = fixture(t, { provisionalSeconds: 10 });
    const [member, spare] = f.ready(2);
    const held = f.store.acquire(caller(1));
    const held2 = f.store.acquire(caller(1));
    assert.equal(f.store.cool(member, 60, held), true);
    const until = f.store.inventory(member)!.cooldown_until;
    assert.equal(f.store.cool(member, 2, held2), true);
    assert.equal(f.store.inventory(member)!.cooldown_until, until);
    f.store.finish(held, false);
    f.store.finish(held2, true);
    assert.equal(f.store.leases()[0].phase, 'provisional');
    f.clock.now += 11000;
    f.store.reclaim();
    errorCode(() => f.store.acquire(caller(1)), 'member_cooling', 429);
    errorCode(() => f.store.acquireCatalog(caller(1)), 'member_cooling', 429);
    errorCode(() => f.store.retry(member), 'member_in_use');
    assert.equal(f.store.acquire(caller(2)).member_identity, spare);
    f.clock.now = until;
    f.store.reclaim();
    assert.equal(f.store.inventory(member)!.state, 'ready');
    assert.equal(f.store.acquire(caller(1)).member_identity, member);
    for (const invalid of [0, -1, Infinity, NaN]) errorCode(() => f.store.cool(member, invalid), 'invalid_cooldown');
  });

  test('quarantine and manual disable cannot be undone by in-flight successes or stale worker results', (t) => {
    const f = fixture(t);
    const [member] = f.ready();
    const held = f.store.acquire(caller(1));
    const before = f.store.inventory(member)!;
    assert.equal(f.store.quarantine(member, 'entitlement_denied', held), true);
    assert.equal(f.store.hasHolds(member), true);
    assert.equal(f.store.pending(), undefined);
    errorCode(() => f.store.retry(member), 'member_in_use');
    f.store.finish(held, true);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.inventory(member)!.state, 'failed');
    assert.equal(f.store.update(member, { state: 'ready' }, before), false);
    f.store.retry(member);
    assert.notEqual(f.store.inventory(member)!.attempt_id, before.attempt_id);
    f.store.disable(member);
    assert.equal(f.store.update(member, { state: 'ready' }), false);
    f.store.fail(member, 'late_failure');
    assert.equal(f.store.cool(member, 60), false);
    assert.equal(f.store.quarantine(member, 'late_quarantine'), false);
    assert.equal(f.store.inventory(member)!.state, 'disabled');
    f.store.retry(member);
    assert.equal(f.store.inventory(member)!.state, 'provisioning');
    assert.equal(f.store.inventory(member)!.stage, 'warmup');
    assert.equal(f.store.update(member, { state: 'ready' }, before.attempt_id), false);
  });

  test('invalid and empty credentials are quarantined before allocation, not silently reused', (t) => {
    const f = fixture(t);
    const [member, spare] = f.ready(2);
    const held = f.store.acquire(caller(1));
    f.db.prepare("UPDATE proxy_accounts SET copilot_oauth_token = '' WHERE identity = ?").run(member);
    errorCode(() => f.store.acquire(caller(1)), 'member_unavailable', 503);
    assert.equal(f.store.inventory(member)!.state, 'failed');
    assert.equal(f.store.pending(), undefined);
    assert.equal(f.store.hasHolds(member), true);
    assert.equal(f.store.acquire(caller(2)).member_identity, spare);
    f.store.finish(held, true);
    f.clock.now += 30000;
    assert.equal(f.store.pending()!.identity, member);
  });

  test('manual release and disable are atomic and cannot evict in-flight requests', (t) => {
    const f = fixture(t);
    const [member] = f.ready();
    const held = f.store.acquire(caller(1));
    const other = f.connect().store;
    errorCode(() => other.release(held.lease_id), 'lease_in_use', 409);
    other.releaseInactive(member);
    assert.equal(f.store.leases().length, 1);
    other.disable(member);
    assert.equal(f.store.leases().length, 1);
    assert.equal(other.pending(), undefined);
    f.store.finish(held, true);
    assert.equal(f.store.leases().length, 0);
    assert.equal(f.store.inventory(member)!.state, 'disabled');
    errorCode(() => other.release(held.lease_id), 'lease_not_found', 404);
    errorCode(() => other.disable('missing'), 'member_not_found', 404);
    errorCode(() => other.retry('missing'), 'member_not_found', 404);
  });

  test('settings CAS, validation, persistence, pause and cap lowering never evict callers', (t) => {
    const f = fixture(t);
    f.ready(2);
    const held = f.store.acquire(caller(1));
    const other = f.connect();
    const initial = f.store.settings();
    const updated = other.store.updateSettings(initial.version, { idle_target: 0, max_accounts: 1, paused: 1 });
    assert.equal(updated.version, initial.version + 1);
    errorCode(() => f.store.updateSettings(initial.version, { paused: 0 }), 'settings_version_conflict', 409);
    assert.equal(f.store.reserve(), undefined);
    assert.equal(f.store.pending(), undefined);
    assert.equal(f.store.leases()[0].lease_id, held.lease_id);
    assert.equal(f.store.acquire(caller(2)).phase, 'provisional', 'pause only stops provisioning');
    for (const patch of [
      { version: 10 }, { other: 1 }, { idle_target: -1 }, { idle_target: 2 }, { max_accounts: 0 },
      { max_accounts: 10001 }, { lease_seconds: 59 }, { lease_seconds: 2592001 }, { lease_seconds: 1.5 },
      { paused: true }, { paused: 2 }, { idle_target: undefined }, null, [],
    ]) {
      errorCode(() => f.store.updateSettings(updated.version, patch as never), 'invalid_pool_settings', 400);
    }
    assert.deepEqual(new UserPoolStore(other.db, { ...f.config, idleTarget: 99, leaseSeconds: 60 }).settings(), updated);
    assert.throws(() => new UserPoolStore(other.db, { ...f.config, accountDomain: 'other.test' }), /domain differs/);
  });

  test('reservation counts provisioning and leased capacity and safely skips existing aliases', (t) => {
    const f = fixture(t, { idleTarget: 2, maxAccounts: 3 });
    const timestamp = new Date(f.clock.now).toISOString();
    f.db.prepare(`
      INSERT INTO proxy_accounts(identity, sso_user, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(accountName(0).toUpperCase(), 'direct', timestamp, timestamp,
      'another-direct-account', accountName(1).toUpperCase(), timestamp, timestamp);
    const first = f.store.reserve()!;
    const second = f.connect().store.reserve()!;
    assert.equal(first.ordinal, 2);
    assert.equal(second.ordinal, 3);
    assert.equal(f.store.reserve(), undefined);
    assert.equal(f.store.counts().provisioning, 2);
    f.db.prepare("UPDATE proxy_accounts SET copilot_oauth_token = 'valid', copilot_oauth_status = 'valid' WHERE identity = ?")
      .run(first.identity);
    f.store.update(first.identity, { state: 'ready', stage: 'ready', verified_at: f.clock.now });
    f.store.acquire(caller(1));
    const third = f.store.reserve()!;
    assert.equal(third.ordinal, 4);
    assert.equal(f.store.reserve(), undefined, 'all inventory states count toward the cap');
    f.store.disable(second.identity);
    assert.equal(f.store.reserve(), undefined);
    assert.equal(f.store.counts().total, 3);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM proxy_accounts').get() as { n: number }).n, 5);
  });

  test('name capacity exhausts without wraparound and survives store reconstruction', (t) => {
    const f = fixture(t);
    f.db.prepare('UPDATE user_pool_settings SET next_ordinal = ?').run(NAME_CAPACITY - 1);
    const last = f.store.reserve()!;
    assert.equal(last.identity, accountName(9999));
    errorCode(() => f.store.reserve(), 'name_catalog_exhausted', 503);
    errorCode(() => f.connect().store.reserve(), 'name_catalog_exhausted', 503);
    assert.equal((f.db.prepare('SELECT next_ordinal n FROM user_pool_settings').get() as { n: number }).n, NAME_CAPACITY);
  });

  test('failed provisioning obeys backoff, maximum attempts, pause and ambiguous-stage reconciliation', (t) => {
    const f = fixture(t);
    const row = f.store.reserve()!;
    f.store.fail(row.identity, 'temporary');
    assert.equal(f.store.pending(), undefined);
    f.clock.now += 30000;
    assert.equal(f.store.pending()!.identity, row.identity);
    f.store.fail(row.identity, 'temporary');
    f.clock.now += 59999;
    assert.equal(f.store.pending(), undefined);
    f.clock.now += 1;
    assert.equal(f.store.pending()!.attempts, 2);
    f.store.fail(row.identity, 'temporary');
    f.clock.now += 300000;
    assert.equal(f.store.pending(), undefined);
    f.store.retry(row.identity);
    assert.equal(f.store.pending()!.attempts, 0);
    for (const code of ['sso_creation_ambiguous', 'sso_name_conflict', 'oauth_dispatch_ambiguous']) {
      f.store.update(row.identity, { state: 'failed', attempts: 0, retry_at: 0, last_error: code });
      assert.equal(f.store.pending(), undefined);
      errorCode(() => f.store.retry(row.identity), 'manual_reconciliation_required', 409);
    }
    f.store.update(row.identity, { last_error: null });
    assert.equal(f.store.pending()!.identity, row.identity, 'NULL error is not excluded by SQL NOT IN');
    f.store.update(row.identity, { state: 'provisioning', retry_at: f.clock.now + 1000 });
    assert.equal(f.store.pending(), undefined, 'provisioning poll delay is respected');
  });

  test('owner claim is exclusive, renewable, expiry-bound, and fenced on release', (t) => {
    const f = fixture(t);
    const second = f.connect().store;
    assert.equal(f.store.claimOwner('owner-a'), true);
    assert.equal(second.claimOwner('owner-b'), false);
    f.clock.now += 20000;
    assert.equal(f.store.claimOwner('owner-a'), true);
    f.clock.now += 20000;
    assert.equal(second.claimOwner('owner-b'), false);
    f.clock.now += 10000;
    assert.equal(second.claimOwner('owner-b'), true);
    f.store.releaseOwner('owner-a');
    assert.equal(f.store.claimOwner('owner-a'), false);
    second.releaseOwner('owner-b');
    assert.equal(f.store.claimOwner('owner-a'), true);
  });

  test('worker writes are atomically fenced by retry attempt and owner lease expiry', (t) => {
    const f = fixture(t);
    const row = f.store.reserve()!;
    const second = f.connect().store;
    assert.equal(f.store.claimOwner('first'), true);
    assert.equal(f.store.update(row.identity, { stage: 'sso-created' }, row.attempt_id, 'first'), true);
    assert.equal(f.store.update(row.identity, { stage: 'synced' }, row.attempt_id, 'other'), false);
    f.clock.now += 30000;
    assert.equal(f.store.update(row.identity, { state: 'ready' }, row.attempt_id, 'first'), false);
    f.store.fail(row.identity, 'expired-owner', row.attempt_id, 'first');
    assert.equal(f.store.inventory(row.identity)!.state, 'provisioning');
    assert.equal(second.claimOwner('second'), true);
    assert.equal(second.update(row.identity, { stage: 'synced' }, row.attempt_id, 'second'), true);
    second.fail(row.identity, 'temporary', row.attempt_id, 'second');
    assert.equal(f.store.inventory(row.identity)!.state, 'failed');
    f.store.retry(row.identity);
    assert.equal(second.update(row.identity, { state: 'ready' }, row.attempt_id, 'second'), false);
    second.fail(row.identity, 'old-retry', row.attempt_id, 'second');
    assert.equal(f.store.inventory(row.identity)!.state, 'provisioning');
  });

  test('OAuth callback correlation persists independently of the provisioning retry fence', (t) => {
    const f = fixture(t);
    const row = f.store.reserve()!;
    assert.equal(f.store.update(row.identity, {
      stage: 'oauth-wait', oauth_attempt_id: 'oauth-attempt', task_id: 'login-task',
      sso_created_at: '2026-01-01T00:00:00.000Z',
    }, row.attempt_id), true);
    const reopened = f.connect().store.inventory(row.identity)!;
    assert.equal(reopened.oauth_attempt_id, 'oauth-attempt');
    assert.equal(reopened.sso_created_at, '2026-01-01T00:00:00.000Z');
    f.store.fail(row.identity, 'temporary', row.attempt_id);
    f.store.retry(row.identity);
    const retried = f.store.inventory(row.identity)!;
    assert.notEqual(retried.attempt_id, row.attempt_id);
    assert.equal(retried.oauth_attempt_id, 'oauth-attempt');
    assert.equal(retried.task_id, 'login-task');
    assert.equal(retried.stage, 'oauth-wait');
  });

  test('audit output is bounded and never includes credentials', (t) => {
    const f = fixture(t);
    f.ready();
    for (let index = 0; index < 10020; index++) f.store.event('test_event', undefined, undefined, undefined, 'safe');
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM user_pool_events').get() as { n: number }).n, 10000);
    assert.equal(f.store.events().length, 200);
    assert.equal(JSON.stringify(f.store.accounts()).includes('token-'), false);
    assert.equal(JSON.stringify(f.store.events()).includes('token-'), false);
  });

  async function parallel(f: ReturnType<typeof fixture>, operation: string, callers: string[]) {
    const barrier = new SharedArrayBuffer(4);
    const threads: Worker[] = [];
    const ready: Promise<void>[] = [];
    const results: Promise<{ result?: HeldLease | { identity: string }; error?: string }>[] = [];
    for (const identity of callers) {
      const thread = new Worker(new URL(import.meta.url), {
        workerData: { path: f.path, barrier, operation, caller: identity, now: f.clock.now },
      });
      threads.push(thread);
      ready.push(new Promise((resolve, reject) => {
        thread.on('message', (message) => { if (message.ready) resolve(); });
        thread.once('error', reject);
      }));
      results.push(new Promise((resolve, reject) => {
        thread.on('message', (message) => { if (!message.ready) resolve(message); });
        thread.once('error', reject);
        thread.once('exit', (code) => { if (code) reject(new Error(`SQLite test worker exited ${code}`)); });
      }));
    }
    try {
      await Promise.all(ready);
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0);
      return await Promise.all(results);
    } finally {
      await Promise.all(threads.map((thread) => thread.terminate()));
    }
  }

  test('parallel SQLite connections cannot give two callers the same member', async (t) => {
    const f = fixture(t);
    f.ready(2);
    const results = await parallel(f, 'acquire', [caller(1), caller(2), caller(3), caller(4)]);
    const successes = results.filter((item) => item.result).map((item) => item.result as HeldLease);
    assert.equal(successes.length, 2);
    assert.equal(new Set(successes.map((held) => held.member_identity)).size, 2);
    assert.equal(results.filter((item) => item.error === 'pool_exhausted').length, 2);
  });

  test('parallel SQLite connections converge concurrent calls to a single caller lease', async (t) => {
    const f = fixture(t);
    f.ready(2);
    const results = await parallel(f, 'acquire', [caller(1), caller(1), caller(1), caller(1)]);
    assert.ok(results.every((item) => item.result));
    const holds = results.map((item) => item.result as HeldLease);
    assert.equal(new Set(holds.map((held) => held.lease_id)).size, 1);
    assert.equal(new Set(holds.map((held) => held.request_id)).size, 4);
    assert.equal(f.store.leases().length, 1);
  });

  test('parallel discovery never borrows another caller member or creates durable leases', async (t) => {
    const f = fixture(t);
    f.ready(2);
    const results = await parallel(f, 'catalog', [caller(1), caller(2), caller(3), caller(4)]);
    const holds = results.filter((item) => item.result).map((item) => item.result as HeldLease);
    assert.equal(holds.length, 2);
    assert.equal(new Set(holds.map((held) => held.member_identity)).size, 2);
    assert.equal(results.filter((item) => item.error === 'pool_exhausted').length, 2);
    assert.equal(f.store.leases().length, 0);
    for (const held of holds) f.store.finish(held, true);
    assert.equal(f.store.counts().ready_idle, 2);
  });

  test('parallel provisioning reservations never overfill the idle target', async (t) => {
    const f = fixture(t, { idleTarget: 2 });
    const results = await parallel(f, 'reserve', [caller(1), caller(2), caller(3), caller(4)]);
    assert.equal(results.filter((item) => item.result).length, 2);
    assert.ok(results.every((item) => !item.error));
    assert.equal(f.store.counts().provisioning, 2);
  });
}
