import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig } from './config.js';
import { UserPoolStore } from './store.js';

function fixture(t: TestContext) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  runMigrations(db);
  const store = new UserPoolStore(db, readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test', POOL_WARMUP_MODEL: 'test-model', READY_IDLE_TARGET: '1', POOL_MAX_ACCOUNTS: '1' }));
  let now = 1800000000000;
  store.now = () => now;
  const row = store.reserve()!;
  const token = (value: string) => db.prepare("UPDATE proxy_accounts SET copilot_oauth_status='valid',copilot_oauth_token=?,copilot_oauth_attempt_id=NULL WHERE identity=?").run(value, row.identity);
  const ready = (value = 'test-token') => { token(value); store.update(row.identity, { state: 'ready', stage: 'ready', verified_at: now, attempts: 0 }); };
  ready();
  t.after(() => db.close());
  return { db, store, identity: row.identity, token, ready, advance: (ms: number) => { now += ms; } };
}
const caller = 'sha256:' + 'a'.repeat(64);

test('concurrent 401s invalidate and schedule one repair, after every old hold drains', t => {
  const f = fixture(t);
  const first = f.store.acquire(caller), second = f.store.acquire(caller);
  const previous = f.store.inventory(f.identity)!;
  assert.equal(f.store.recoverUnauthorized(first, 'test-token'), true);
  const scheduled = f.store.inventory(f.identity)!;
  assert.equal(scheduled.state, 'failed');
  assert.equal(scheduled.stage, 'synced');
  assert.equal(scheduled.attempts, 0);
  assert.equal(scheduled.reauth_count, 1);
  assert.notEqual(scheduled.attempt_id, previous.attempt_id);
  assert.equal(f.store.recoverUnauthorized(second, 'test-token'), false);
  assert.equal(f.store.pending(), undefined);
  f.store.finish(first, true);
  assert.equal(f.store.pending(), undefined);
  f.store.finish(second, true);
  assert.equal(f.store.leases().length, 0);
  assert.equal(f.store.pending()!.identity, f.identity);
  assert.equal(f.store.inventory(f.identity)!.reauth_count, 1);
  assert.equal(f.store.events().filter((e: any) => e.action === 'oauth_reauth_scheduled').length, 1);
});

test('stale token, generation ABA, disabled account and expired hold cannot start recovery', t => {
  const f = fixture(t);
  const held = f.store.acquire(caller);
  assert.equal(f.store.recoverUnauthorized(held, 'wrong-token'), false);
  f.token('replacement'); f.token('test-token');
  assert.equal(f.store.recoverUnauthorized(held, 'test-token'), false);
  f.store.finish(held, false);
  f.ready();
  const current = f.store.acquire(caller);
  f.store.disable(f.identity);
  assert.equal(f.store.recoverUnauthorized(current, 'test-token'), false);
  assert.equal(f.store.inventory(f.identity)!.state, 'disabled');
});

test('expired hold cannot start recovery or clear credentials', t => {
  const f = fixture(t);
  const held = f.store.acquire(caller);
  f.advance(120001);
  assert.equal(f.store.recoverUnauthorized(held, 'test-token'), false);
  assert.equal(f.store.inventory(f.identity)!.reauth_count, 0);
  assert.deepEqual(f.db.prepare('SELECT copilot_oauth_status FROM proxy_accounts').get(), { copilot_oauth_status: 'valid' });
});

test('cancelled unconfirmed Login remains manual and cannot be blindly retried', t => {
  const f = fixture(t);
  f.store.update(f.identity, { state: 'failed', stage: 'oauth-wait', attempts: 3, last_error: 'oauth_task_cancelled_unconfirmed' });
  assert.equal(f.store.pending(), undefined);
  assert.throws(() => f.store.retry(f.identity), /manual_reconciliation_required/);
});

test('repeated invalid-token cycles persist a three-per-hour automatic repair ceiling', t => {
  const f = fixture(t);
  for (let i = 1; i <= 4; i++) {
    const held = f.store.acquire(caller);
    assert.equal(f.store.recoverUnauthorized(held, 'test-token'), true);
    f.store.finish(held, false);
    const row = f.store.inventory(f.identity)!;
    if (i <= 3) {
      assert.equal(row.attempts, 0);
      assert.equal(row.reauth_count, i);
      f.ready();
    } else {
      assert.equal(row.attempts, 3);
      assert.equal(row.last_error, 'oauth_reauth_limit_reached');
      assert.equal(f.store.pending(), undefined);
    }
  }
  const reopened = new UserPoolStore(f.db, readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test', POOL_WARMUP_MODEL: 'test-model' }));
  assert.equal(reopened.inventory(f.identity)!.reauth_count, 3);
  assert.equal(reopened.inventory(f.identity)!.attempts, 3);
  f.advance(3600000);
  assert.equal(f.store.pending(), undefined, 'exhausted members remain manual even after window ends');
  f.ready();
  const next = f.store.acquire(caller);
  f.store.recoverUnauthorized(next, 'test-token');
  assert.equal(f.store.inventory(f.identity)!.reauth_count, 1);
});

test('catalog cooldown survives request cleanup and prevents rotation into inference', t => {
  const f = fixture(t);
  const catalog = f.store.acquireCatalog(caller);
  assert.equal(f.store.cool(f.identity, 60, catalog), true);
  f.store.finish(catalog, false);
  assert.equal(f.store.hasHolds(f.identity), false);
  assert.throws(() => f.store.acquire(caller), /member_cooling/);
  assert.throws(() => f.store.acquireCatalog(caller), /member_cooling/);
  f.advance(60000);
  const renewed = f.store.acquire(caller);
  assert.equal(renewed.member_identity, f.identity);
});

test('pause defers automatic repair and repeated requests do not reset backoff or failure budget', t => {
  const f = fixture(t);
  const held = f.store.acquire(caller);
  f.store.recoverUnauthorized(held, 'test-token');
  f.store.finish(held, false);
  f.store.updateSettings(f.store.settings().version, { paused: 1 });
  assert.equal(f.store.pending(), undefined);
  f.store.updateSettings(f.store.settings().version, { paused: 0 });
  assert.ok(f.store.pending());
  f.store.fail(f.identity, 'oauth_login_failed');
  assert.equal(f.store.recoverUnauthorized(held, 'test-token'), false);
  assert.equal(f.store.pending(), undefined);
  f.advance(30000);
  assert.equal(f.store.pending()!.attempts, 1);
});
