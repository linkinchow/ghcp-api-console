import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { readPoolConfig } from './config.js';
import { UserPoolStore } from './store.js';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const store = new UserPoolStore(db, readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.test', POOL_WARMUP_MODEL: 'mock', READY_IDLE_TARGET: '2000', POOL_MAX_ACCOUNTS: '2000' }));
  return { db, store };
}

test('SQLite dispatch slots are atomic, fenced and retained for uncertain Login work', () => {
  const { db, store } = fixture();
  try {
    store.claimOwner('owner');
    const first = store.reserve()!, second = store.reserve()!;
    for (const row of [first, second]) store.update(row.identity, { stage: 'oauth-starting', oauth_attempt_id: 'test-attempt' });
    let fence = store.inventory(first.identity)!;
    assert.equal(store.claimLoginDispatch(first.identity, fence, 'other-owner', 1), false);
    assert.equal(store.claimLoginDispatch(first.identity, { ...fence, stage: 'new' }, 'owner', 1), false);
    assert.equal(store.claimLoginDispatch(first.identity, fence, 'owner', 1), true);
    fence = store.inventory(second.identity)!;
    assert.equal(store.claimLoginDispatch(second.identity, fence, 'owner', 1), false);
    assert.equal(store.inventory(second.identity)!.attempts, 0);
    store.fail(first.identity, 'oauth_dispatch_ambiguous');
    assert.equal(store.claimLoginDispatch(second.identity, fence, 'owner', 1), false);
    store.update(first.identity, { stage: 'warmup' });
    assert.equal(store.claimLoginDispatch(second.identity, fence, 'owner', 1), true);
  } finally { db.close(); }
});

test('SQLite pagination reaches beyond 1000 members and escapes wildcard searches', () => {
  const { db, store } = fixture();
  try {
    const account = db.prepare("INSERT INTO proxy_accounts(identity,sso_user,copilot_oauth_status,created_at,updated_at) VALUES (?,?,'missing',?,?)");
    const inventory = db.prepare("INSERT INTO user_pool_accounts(identity,ordinal,state,stage,attempt_id,updated_at) VALUES (?,?,'provisioning','new',?,?)");
    db.transaction(() => {
      for (let n = 0; n < 2000; n++) {
        const identity = `synthetic-${n.toString().padStart(4, '0')}`;
        account.run(identity, identity, '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
        inventory.run(identity, n, `attempt-${n}`, 1);
      }
    })();
    const page = store.page('accounts', { page: 21, pageSize: 50 });
    assert.equal(page.total, 2000);
    assert.equal(page.items.length, 50);
    assert.equal((page.items[0] as { identity: string }).identity, 'synthetic-1000');
    assert.equal(store.page('accounts', { page: 1, pageSize: 25, q: 'SYNTHETIC-1999' }).total, 1);
    assert.equal(store.page('accounts', { page: 1, pageSize: 25, q: '%' }).total, 0);
    assert.equal(store.page('accounts', { page: 1, pageSize: 25, state: 'ready_idle' }).total, 0);
    assert.throws(() => store.page('accounts', { page: 0, pageSize: 25 }));
    assert.throws(() => store.page('events', { page: 1, pageSize: 25, state: 'active' }));
  } finally { db.close(); }
});
