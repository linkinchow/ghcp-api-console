import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import BetterSqlite3 from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID, INTERNAL_AUTH_HEADER, requireEnterprise } from '@ghcp/shared';
import { config } from '../config.js';
import { runMigrations } from '../db/migrations.js';
import { findProxyEnterprise } from '../enterprises.js';
import { UserPoolStore } from '../userPool/store.js';
import { readPoolConfig, UserPoolError } from '../userPool/config.js';
import { createEnterpriseUserPoolRouter, createUserPoolApiRouter } from './userPoolApi.js';
import { defaultEnterpriseSeed } from '../db/enterpriseSeed.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'local-pool-admin-test';

async function fixture() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, defaultEnterpriseSeed({}));
  const store = new UserPoolStore(db, {
    ...readPoolConfig({}), enabled: true, accountDomain: 'example.test', idleTarget: 3, maxAccounts: 10,
  });
  let enabled = true;
  let failure: Error | undefined;
  let wakeFailure = false;
  let wakes = 0;
  const dependencies = {
    getStore: async () => {
      if (failure) throw failure;
      return enabled ? store : undefined;
    },
    wake: async () => { if (wakeFailure) throw new Error('password=not-for-the-client'); wakes += 1; },
  };
  const app = express();
  app.use(express.json({ strict: false }));
  app.use('/api', createUserPoolApiRouter(dependencies));
  const scoped = createEnterpriseUserPoolRouter(dependencies);
  app.use('/api/enterprises/:enterpriseId', requireEnterprise(findProxyEnterprise), scoped);
  const originalToken = config.internalApiToken;
  config.internalApiToken = TOKEN;
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (url: string, method: string, body: unknown, auth: string | null) => {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth === null ? {} : { [INTERNAL_AUTH_HEADER]: auth }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };
  /** The process-wide `/api/user-pool...` routes. */
  const request = (path = '/overview', method = 'GET', body?: unknown, auth: string | null = TOKEN) => {
    return call(`${origin}/user-pool${path}`, method, body, auth);
  };
  /** `/api/enterprises/<id>/user-pool...`. */
  const scope = (path: string, method = 'GET', body?: unknown, auth: string | null = TOKEN, id = 'default') => {
    return call(`${origin}/enterprises/${id}/user-pool${path}`, method, body, auth);
  };
  const ready = () => {
    const member = store.reserve([DEFAULT_ENTERPRISE_ID])!;
    assert.ok(member);
    db.prepare(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'valid', copilot_oauth_token = 'gho-private-token', gh_login = 'pool-login'
      WHERE identity = ?
    `).run(member.identity);
    store.update(member.identity, { state: 'ready', stage: 'ready', verified_at: store.now() });
    return member.identity;
  };
  return {
    db, store, request, scope, ready,
    disableMode: () => { enabled = false; },
    fail: (error: Error) => { failure = error; },
    failWake: () => { wakeFailure = true; },
    wakes: () => wakes,
    close: async () => { config.internalApiToken = originalToken; await close(server); db.close(); },
  };
}

test('pool routers authenticate every route, including alternate mounts and disabled mode', async () => {
  const f = await fixture();
  try {
    const global = [['/overview', 'GET'], ['/settings', 'GET'], ['/settings', 'PATCH'], ['/reconcile', 'POST'],
      ['/accounts', 'GET'], ['/anything', 'GET']];
    for (const [path, method] of global) {
      assert.equal((await f.request(path, method, undefined, null)).status, 401);
      assert.equal((await f.request(path, method, undefined, 'wrong')).status, 401);
    }
    for (const path of ['/summary', '/accounts', '/leases', '/events', '/anything']) {
      assert.equal((await f.scope(path, 'GET', undefined, null)).status, 401);
    }
    f.disableMode();
    const disabled = await f.request();
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.error.code, 'pool_mode_disabled');
    assert.equal((await f.request('/reconcile', 'POST')).body.error.code, 'pool_mode_disabled');
    assert.equal((await f.scope('/accounts')).body.error.code, 'pool_mode_disabled');
    assert.equal(f.wakes(), 0);
  } finally { await f.close(); }
});

test('members, leases and events need an enterprise; unknown enterprises are not found', async () => {
  const f = await fixture();
  try {
    for (const path of ['/accounts', '/leases', '/events', '/summary', '/page/accounts', '/accounts/x/disable']) {
      const unscoped = await f.request(path, path.endsWith('disable') ? 'POST' : 'GET');
      assert.equal(unscoped.status, 400, path);
      assert.equal(unscoped.body.error.code, 'enterprise_scope_required');
    }
    const unknown = await f.scope('/accounts', 'GET', undefined, TOKEN, 'unknown-co');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'enterprise_not_found');
  } finally { await f.close(); }
});

test('lease lists use joined hold counts instead of per-row lookups', async () => {
  const f = await fixture();
  try {
    f.ready();
    const held = f.store.acquire(HASH);
    f.store.hasHolds = () => { throw new Error('Unexpected per-lease query'); };
    const result = await f.scope('/leases');
    assert.equal(result.status, 200);
    assert.equal(result.body.items[0].inUse, true);
    assert.ok(held.request_id);
  } finally { await f.close(); }
});

test('pool lists explicitly select safe DTOs, validate caller hashes, and sanitize event/error details', async () => {
  const f = await fixture();
  try {
    const identity = f.ready();
    const held = f.store.acquire(HASH);
    const overview = await f.request();
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    assert.equal(overview.body.poolId, 'default');
    assert.equal(overview.body.counts.provisional, 1);
    assert.equal(overview.body.accounts, undefined, 'the global overview lists no members');
    const summary = await f.scope('/summary');
    assert.equal(summary.body.enterpriseId, 'default');
    assert.equal(summary.body.counts.ready_idle, 0);
    assert.equal(summary.body.counts.provisional, 1);
    const live = await f.scope('/accounts');
    assert.equal(live.body.items[0].callerKeyHash, HASH);
    assert.equal(live.body.items[0].activeRequests, 1);
    assert.equal((await f.scope('/leases')).body.items[0].inUse, true);
    f.store.finish(held, true);
    f.store.event('request_finished', identity, HASH, held.lease_id, 'not_renewed');
    f.store.event('request_finished', identity, 'alias@example.test', held.lease_id, 'password=secret; token=gho-test');
    f.db.prepare('UPDATE user_pool_accounts SET last_error=? WHERE identity=?').run('ssoPassword=secret', identity);
    const lists = ['/accounts', '/leases', '/events'].map((path) => f.scope(path));
    const [accounts, leases, events] = await Promise.all(lists);
    assert.equal((await f.scope('/summary')).body.counts.leased, 1);
    assert.equal(leases.body.items[0].phase, 'active');
    assert.equal(leases.body.items[0].inUse, false);
    assert.equal(leases.body.items[0].callerKeyHash, HASH);
    assert.equal(events.body.items[0].callerKeyHash, null);
    assert.equal(events.body.items[0].detail, 'details_redacted');
    assert.equal(events.body.limit, 200);
    assert.equal(accounts.body.items[0].lastError, 'details_redacted');
    assert.equal(accounts.body.total, 1);
    assert.equal(accounts.body.items[0].identity, identity);
    const serialized = JSON.stringify([accounts.body, leases.body, events.body]);
    const forbidden = ['gho-private-token', 'password=secret', 'ssoPassword', 'alias@example.test', 'attempt_id',
      'copilot_oauth_token', 'caller_id'];
    for (const value of forbidden) assert.equal(serialized.includes(value), false, value);
    assert.equal((await f.scope('/accounts?limit=1')).status, 400);
  } finally { await f.close(); }
});

test('settings enforce strict values, known fields, the enterprise cap and optimistic version checks', async () => {
  const f = await fixture();
  try {
    const bad = [
      null, [], {}, { expectedVersion: '1', changes: { paused: 1 } },
      { expectedVersion: 1, changes: {} }, { expectedVersion: 1, changes: [] },
      { expectedVersion: 1, changes: { paused: true } },
      { expectedVersion: 1, changes: { paused: '1' } },
      { expectedVersion: 1, changes: { idle_target: 1.5 } },
      { expectedVersion: 1, changes: { idle_target: -1 } },
      { expectedVersion: 1, changes: { lease_seconds: 59 } },
      { expectedVersion: 1, changes: { lease_seconds: 2592001 } },
      { expectedVersion: 1, changes: { owner: 'attacker' } },
      { expectedVersion: 1, changes: { version: 8 } },
      { expectedVersion: 1, changes: { paused: 1 }, extra: true },
    ];
    for (const body of bad) {
      const result = await f.request('/settings', 'PATCH', body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error.code, 'invalid_pool_settings');
    }
    for (const max_accounts of [0, 20]) {
      const cap = await f.request('/settings', 'PATCH', { expectedVersion: 1, changes: { max_accounts } });
      assert.equal(cap.status, 409);
      assert.equal(cap.body.error.code, 'use_enterprise_cap');
    }
    assert.equal(f.store.settings().version, 1);
    const saved = await f.request('/settings', 'PATCH', {
      expectedVersion: 1, changes: { idle_target: 5, lease_seconds: 120, paused: 1 },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { version: 2, idle_target: 5, lease_seconds: 120, paused: 1 });
    assert.deepEqual((await f.request('/settings')).body, saved.body);
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
    const release = `/leases/${held.lease_id}/release`;
    assert.equal((await f.scope(`/accounts/${identity}/resume`, 'POST')).body.error.code, 'invalid_member_state');
    assert.equal((await f.scope(`/accounts/${identity}/retry`, 'POST')).body.error.code, 'invalid_member_state');
    assert.equal((await f.scope(`/accounts/${identity}/delete`, 'POST')).status, 404);
    assert.equal((await f.scope('/accounts/not-found/disable', 'POST')).status, 404);
    assert.equal((await f.scope('/accounts/bad%20identity/disable', 'POST')).status, 400);
    assert.equal((await f.scope(release, 'POST')).body.error.code, 'confirmation_required');
    assert.equal((await f.scope(release, 'POST', { confirm: 'true' })).status, 400);
    assert.equal((await f.scope(release, 'POST', { confirm: true, force: true })).status, 400);
    assert.equal((await f.scope('/leases/bad/release', 'POST', { confirm: true })).status, 400);
    assert.equal((await f.scope(release, 'POST', { confirm: true })).body.error.code, 'lease_in_use');
    f.store.finish(held, true);
    assert.equal((await f.scope(release, 'POST', { confirm: true })).status, 200);
    assert.equal(f.store.leases(DEFAULT_ENTERPRISE_ID).length, 0);
    assert.equal((await f.scope(release, 'POST', { confirm: true })).status, 404);
    assert.equal((await f.scope(`/accounts/${identity}/disable`, 'POST')).status, 200);
    assert.equal(f.store.inventory(identity)?.state, 'disabled');
    assert.equal((await f.scope(`/accounts/${identity}/resume`, 'POST')).status, 200);
    assert.equal(f.store.inventory(identity)?.state, 'provisioning');
    f.store.fail(identity, 'service_unavailable');
    assert.equal((await f.scope(`/accounts/${identity}/retry`, 'POST')).status, 200);
    f.store.fail(identity, 'sso_creation_ambiguous');
    const manual = await f.scope(`/accounts/${identity}/retry`, 'POST');
    assert.equal(manual.body.error.code, 'manual_reconciliation_required');
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

test('server paging validates parameters, authenticates and preserves DTO redaction', async () => {
  const f = await fixture();
  try {
    const first = f.ready(), second = f.ready();
    const held = f.store.acquire(HASH);
    const summary = await f.scope('/summary');
    assert.equal(summary.status, 200);
    assert.equal(summary.body.counts.total, 2);
    const page = await f.scope('/page/accounts?page=2&pageSize=1');
    assert.equal(page.body.total, 2);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].identity, second);
    assert.ok(!JSON.stringify(page.body).includes('gho-private-token'));
    const leased = await f.scope('/page/leases?pageSize=1');
    assert.equal(leased.body.items[0].inUse, true);
    assert.equal(leased.body.items[0].memberIdentity, first);
    assert.equal((await f.scope(`/page/accounts?q=${encodeURIComponent(second)}&state=ready_idle`)).body.total, 1);
    assert.equal((await f.scope('/page/accounts?q=%25')).body.total, 0);
    for (const query of ['page=0', 'pageSize=101', 'page=1.5', 'state=unknown', 'extra=1', 'q=a&q=b']) {
      assert.equal((await f.scope(`/page/accounts?${query}`)).status, 400);
    }
    assert.equal((await f.scope('/page/accounts', 'GET', undefined, null)).status, 401);
    f.store.finish(held, false);
  } finally { await f.close(); }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
