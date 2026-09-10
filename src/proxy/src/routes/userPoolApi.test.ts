import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import BetterSqlite3 from 'better-sqlite3';
import { INTERNAL_AUTH_HEADER } from '@ghcp/shared';
import { config } from '../config.js';
import { runMigrations } from '../db/migrations.js';
import { UserPoolStore } from '../userPool/store.js';
import { readPoolConfig, UserPoolError } from '../userPool/config.js';
import { createUserPoolApiRouter } from './userPoolApi.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'local-pool-admin-test';

async function fixture() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const store = new UserPoolStore(db, {
    ...readPoolConfig({}), enabled: true, accountDomain: 'example.test', idleTarget: 3, maxAccounts: 10,
  });
  let enabled = true;
  let failure: Error | undefined;
  let wakeFailure = false;
  let wakes = 0;
  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/api', createUserPoolApiRouter({
    getStore: async () => {
      if (failure) throw failure;
      return enabled ? store : undefined;
    },
    wake: async () => { if (wakeFailure) throw new Error('password=not-for-the-client'); wakes += 1; },
  }));
  const originalToken = config.internalApiToken;
  config.internalApiToken = TOKEN;
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/user-pool`;
  const request = async (path = '', method = 'GET', body?: unknown, auth: string | null = TOKEN) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { [INTERNAL_AUTH_HEADER]: auth }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  const ready = () => {
    const member = store.reserve()!;
    assert.ok(member);
    db.prepare("UPDATE proxy_accounts SET copilot_oauth_status='valid',copilot_oauth_token='gho-private-token',gh_login='pool-login' WHERE identity=?").run(member.identity);
    store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: store.now() });
    return member.identity;
  };
  return {
    db, store, request, ready,
    disableMode: () => { enabled = false; },
    fail: (error: Error) => { failure = error; },
    failWake: () => { wakeFailure = true; },
    wakes: () => wakes,
    close: async () => { config.internalApiToken = originalToken; await close(server); db.close(); },
  };
}

test('pool router authenticates every route, including alternate mounts and disabled mode', async () => {
  const f = await fixture();
  try {
    for (const [path, method] of [['', 'GET'], ['/settings', 'PATCH'], ['/reconcile', 'POST'], ['/accounts', 'GET'], ['/leases', 'GET'], ['/events', 'GET'], ['/anything', 'GET']]) {
      assert.equal((await f.request(path, method, undefined, null)).status, 401);
      assert.equal((await f.request(path, method, undefined, 'wrong')).status, 401);
    }
    f.disableMode();
    const disabled = await f.request();
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error.code, 'pool_mode_disabled');
    assert.equal((await f.request('/reconcile', 'POST')).body.error.code, 'pool_mode_disabled');
    assert.equal(f.wakes(), 0);
  } finally { await f.close(); }
});

test('overview explicitly selects safe DTOs, validates caller hashes, and sanitizes event/error details', async () => {
  const f = await fixture();
  try {
    const identity = f.ready();
    const held = f.store.acquire(HASH);
    const live = await f.request();
    assert.equal(live.status, 200);
    assert.equal(live.headers.get('cache-control'), 'no-store');
    assert.equal(live.body.poolId, 'default');
    assert.equal(live.body.counts.ready_idle, 0);
    assert.equal(live.body.counts.provisional, 1);
    assert.equal(live.body.accounts[0].callerKeyHash, HASH);
    assert.equal(live.body.accounts[0].activeRequests, 1);
    assert.equal(live.body.leases[0].inUse, true);
    f.store.finish(held, true);
    f.store.event('request_finished', identity, HASH, held.lease_id, 'not_renewed');
    f.store.event('request_finished', identity, 'alias@example.test', held.lease_id, 'password=secret; token=gho-test');
    f.db.prepare('UPDATE user_pool_accounts SET last_error=? WHERE identity=?').run('ssoPassword=secret', identity);
    const result = await f.request();
    assert.equal(result.body.counts.leased, 1);
    assert.equal(result.body.leases[0].phase, 'active');
    assert.equal(result.body.leases[0].inUse, false);
    assert.equal(result.body.events[0].callerKeyHash, null);
    assert.equal(result.body.events[0].detail, 'details_redacted');
    assert.equal(result.body.accounts[0].lastError, 'details_redacted');
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ['gho-private-token', 'password=secret', 'ssoPassword', 'alias@example.test', 'attempt_id', 'copilot_oauth_token', 'caller_id']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
    const accounts = await f.request('/accounts');
    const leases = await f.request('/leases');
    const events = await f.request('/events');
    assert.equal(accounts.body.total, 1);
    assert.equal(accounts.body.items[0].identity, identity);
    assert.equal(leases.body.items[0].callerKeyHash, HASH);
    assert.equal(events.body.limit, 200);
    assert.equal((await f.request('/accounts?limit=1')).status, 400);
  } finally { await f.close(); }
});

test('settings enforce strict values, known fields, cross-field limits, and optimistic version checks', async () => {
  const f = await fixture();
  try {
    const bad = [
      null, [], {}, { expectedVersion: '1', changes: { paused: 1 } },
      { expectedVersion: 1, changes: {} }, { expectedVersion: 1, changes: [] },
      { expectedVersion: 1, changes: { paused: true } },
      { expectedVersion: 1, changes: { paused: '1' } },
      { expectedVersion: 1, changes: { idle_target: 1.5 } },
      { expectedVersion: 1, changes: { idle_target: -1 } },
      { expectedVersion: 1, changes: { max_accounts: 0 } },
      { expectedVersion: 1, changes: { max_accounts: 99999999 } },
      { expectedVersion: 1, changes: { lease_seconds: 59 } },
      { expectedVersion: 1, changes: { lease_seconds: 2592001 } },
      { expectedVersion: 1, changes: { idle_target: 11 } },
      { expectedVersion: 1, changes: { owner: 'attacker' } },
      { expectedVersion: 1, changes: { version: 8 } },
      { expectedVersion: 1, changes: { paused: 1 }, extra: true },
    ];
    for (const body of bad) {
      const result = await f.request('/settings', 'PATCH', body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'invalid_pool_settings');
    }
    assert.equal(f.store.settings().version, 1);
    const saved = await f.request('/settings', 'PATCH', {
      expectedVersion: 1, changes: { idle_target: 5, max_accounts: 20, lease_seconds: 120, paused: 1 },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { version: 2, idle_target: 5, max_accounts: 20, lease_seconds: 120, paused: 1 });
    const stale = await f.request('/settings', 'PATCH', { expectedVersion: 1, changes: { paused: 0 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'settings_version_conflict');
    assert.equal(f.wakes(), 1);
    assert.equal((await f.request('/reconcile', 'POST', {})).status, 202);
    assert.equal((await f.request('/reconcile', 'POST', { force: true })).status, 400);
  } finally { await f.close(); }
});

test('account controls require valid state and release requires confirmation and no live holds', async () => {
  const f = await fixture();
  try {
    const identity = f.ready();
    const held = f.store.acquire(HASH);
    assert.equal((await f.request(`/accounts/${identity}/resume`, 'POST')).body.error.code, 'invalid_member_state');
    assert.equal((await f.request(`/accounts/${identity}/retry`, 'POST')).body.error.code, 'invalid_member_state');
    assert.equal((await f.request(`/accounts/${identity}/delete`, 'POST')).status, 404);
    assert.equal((await f.request('/accounts/not-found/disable', 'POST')).status, 404);
    assert.equal((await f.request('/accounts/bad%20identity/disable', 'POST')).status, 400);
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST')).body.error.code, 'confirmation_required');
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST', { confirm: 'true' })).status, 400);
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST', { confirm: true, force: true })).status, 400);
    assert.equal((await f.request('/leases/bad/release', 'POST', { confirm: true })).status, 400);
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST', { confirm: true })).body.error.code, 'lease_in_use');
    f.store.finish(held, true);
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST', { confirm: true })).status, 200);
    assert.equal(f.store.leases().length, 0);
    assert.equal((await f.request(`/leases/${held.lease_id}/release`, 'POST', { confirm: true })).status, 404);
    assert.equal((await f.request(`/accounts/${identity}/disable`, 'POST')).status, 200);
    assert.equal(f.store.inventory(identity)?.state, 'disabled');
    assert.equal((await f.request(`/accounts/${identity}/resume`, 'POST')).status, 200);
    assert.equal(f.store.inventory(identity)?.state, 'provisioning');
    f.store.fail(identity, 'service_unavailable');
    assert.equal((await f.request(`/accounts/${identity}/retry`, 'POST')).status, 200);
    f.store.fail(identity, 'sso_creation_ambiguous');
    assert.equal((await f.request(`/accounts/${identity}/retry`, 'POST')).body.error.code, 'manual_reconciliation_required');
  } finally { await f.close(); }
});

test('async initialization, read, and wake failures use safe JSON error envelopes', async () => {
  for (const failure of [new Error('token=secret'), new UserPoolError(503, 'untrusted_secret_code')]) {
    const f = await fixture();
    try {
      f.fail(failure);
      const result = await f.request();
      assert.equal(result.status, 500);
      assert.equal(result.body.error.code, 'pool_operation_failed');
      assert.equal(JSON.stringify(result.body).includes('secret'), false);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    f.failWake();
    assert.equal((await f.request('/reconcile', 'POST')).body.error.code, 'pool_operation_failed');
    f.store.counts = () => { throw new Error('database_password=secret'); };
    assert.equal((await f.request()).body.error.code, 'pool_operation_failed');
  } finally { await f.close(); }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
