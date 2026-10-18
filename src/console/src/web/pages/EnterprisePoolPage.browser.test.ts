import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, type Page, type Route } from 'playwright';
import type { EnterpriseLifecycleState, EnterpriseReadinessDto } from '@ghcp/shared';
import type { EnterpriseListItem } from '../api/enterprises.js';
import type { UserPoolOverview } from '../api/userPool.js';
import { enterpriseRow } from '../test-support/console-fixture.js';

const ORIGIN = 'http://enterprise-pool.test';
const POLICY = /^\/api\/console\/proxy\/enterprises\/([^/]+)\/pool-policy$/;
const UNSAFE_BLOCKERS = ['<img src=x onerror=alert(1)>', 'https://secret.test/private'];
const NOT_READY_BLOCKERS = ['sso_missing', 'login:github_base_url_mismatch', ...UNSAFE_BLOCKERS];
const now = 1_789_000_000_000;

type Write = { path: string; method: string; body: Record<string, unknown> };

function readiness(id: string, blockers: string[]): EnterpriseReadinessDto {
  const service = { id, githubBaseUrl: null, slug: null, shortcode: null, configured: true, blockers: [] };
  return {
    enterpriseId: id, ready: blockers.length === 0, blockers, checkedAt: '2026-10-18T00:00:00.000Z',
    services: { proxy: service, sso: blockers.length ? null : service, login: service },
  };
}

function enterprise(id: string, state: EnterpriseLifecycleState, maxAccounts: number, inventory: number) {
  const counts = { total: inventory, ready_idle: 2, leased: 3, provisioning: 1, failed: 1, disabled: 0 };
  return enterpriseRow(id, {
    displayName: `Enterprise ${id}`, slug: `${id}-slug`,
    pool: { enterpriseId: id, state, maxAccounts, inventory, policyVersion: 1, updatedAt: '2026-10-18T00:00:00.000Z' },
    readiness: readiness(id, state === 'draft' ? ['sso_missing'] : []),
    poolSummary: counts, shareScore: state === 'active' ? 0 : null,
  });
}

function overview(): UserPoolOverview {
  return {
    enabled: true, poolId: 'default', observedAt: now,
    settings: { version: 1, idle_target: 4, lease_seconds: 600, paused: 1 },
    counts: { total: 9, ready_idle: 2, leased: 3, provisional: 0, provisioning: 1, cooling: 0, failed: 1, disabled: 0 },
    limits: { maxAccounts: 10000, minLeaseSeconds: 60, maxLeaseSeconds: 2592000 },
    listLimits: { accounts: 1000, leases: 1000, events: 200 },
  };
}

function deferred() {
  let done!: () => void;
  const promise = new Promise<void>((resolveDone) => { done = resolveDone; });
  return { promise, resolve: done };
}

async function paint(page: Page) {
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))');
}

/** Every request is answered locally; no Proxy, SSO, Login or GitHub endpoint is contacted. */
async function offlinePoolOverview() {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(15000);
  const fixture = {
    page,
    errors: [] as string[],
    unexpected: [] as string[],
    writes: [] as Write[],
    overview: overview(),
    items: [enterprise('default', 'active', 9, 7), enterprise('ghe-tenant', 'draft', 1, 0),
      enterprise('drained', 'draining', 5, 2)] as EnterpriseListItem[],
    notReady: true,
    holdPolicy: undefined as ReturnType<typeof deferred> | undefined,
    async close() {
      fixture.holdPolicy?.resolve();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await browser.close();
    },
  };
  page.on('pageerror', (error) => fixture.errors.push(error.message));
  await page.route('**/*', (route) => answer(fixture, route));
  return fixture;
}

type Fixture = Awaited<ReturnType<typeof offlinePoolOverview>>;

async function answer(fixture: Fixture, route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const json = (body: unknown, status = 200) => {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  };
  if (url.origin !== ORIGIN) {
    fixture.unexpected.push(url.href);
    return route.abort();
  }
  if (!url.pathname.startsWith('/api/')) return asset(route, url.pathname);
  if (url.pathname === '/api/console/setup') return json({ initialized: true });
  if (url.pathname === '/api/console/me') return json({ username: 'offline-admin', role: 'admin' });
  if (request.method() !== 'GET') {
    fixture.writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() ?? {} });
  }
  if (url.pathname === '/api/console/proxy/enterprises') return json({ items: fixture.items, nameCapacity: 10000 });
  if (url.pathname === '/api/console/proxy/user-pool/overview') return json(fixture.overview);
  if (url.pathname === '/api/console/proxy/user-pool/settings') return json(...updateSettings(fixture));
  if (url.pathname === '/api/console/proxy/user-pool/reconcile') return json({ scheduled: true }, 202);
  const policy = POLICY.exec(url.pathname);
  if (policy && request.method() === 'PATCH') {
    await fixture.holdPolicy?.promise;
    return json(...updatePolicy(fixture, policy[1]!)).catch(() => undefined);
  }
  fixture.unexpected.push(`${request.method()} ${url.pathname}`);
  return json({ error: { code: 'unexpected', message: 'Unexpected offline route.' } }, 404);
}

function updateSettings(fixture: Fixture): [unknown, number?] {
  const body = fixture.writes.at(-1)!.body as { expectedVersion: number; changes: Record<string, number> };
  if (body.expectedVersion !== fixture.overview.settings.version) {
    return [{ error: { code: 'settings_version_conflict', message: 'Reload settings.' } }, 409];
  }
  const settings = { ...fixture.overview.settings, ...body.changes, version: body.expectedVersion + 1 };
  fixture.overview = { ...fixture.overview, settings };
  return [settings];
}

function updatePolicy(fixture: Fixture, id: string): [unknown, number?] {
  const body = fixture.writes.at(-1)!.body as { expectedVersion: number; maxAccounts?: number; state?: string };
  const item = fixture.items.find((entry) => entry.id === id)!;
  const pool = item.pool!;
  if (body.expectedVersion !== pool.policyVersion) {
    return [{ error: { code: 'policy_version_conflict', message: 'The pool policy changed.' } }, 409];
  }
  if (body.state === 'active' && pool.state !== 'active' && fixture.notReady && id === 'ghe-tenant') {
    const error = { code: 'enterprise_not_ready', message: 'Not ready.', details: { blockers: NOT_READY_BLOCKERS } };
    return [{ error }, 409];
  }
  const state = (body.state ?? pool.state) as EnterpriseLifecycleState;
  const maxAccounts = body.maxAccounts ?? pool.maxAccounts;
  item.pool = { ...pool, state, maxAccounts, policyVersion: pool.policyVersion + 1 };
  item.readiness = readiness(id, []);
  return [item.pool];
}

async function asset(route: Route, path: string) {
  const file = resolve(process.cwd(), 'dist/web', path === '/' ? 'index.html' : path.slice(1));
  const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
  return route.fulfill({ contentType, body: await readFile(file) });
}

function row(page: Page, id: string) {
  return page.locator(`tr[data-enterprise="${id}"]`);
}

async function open(fixture: Fixture) {
  await fixture.page.goto(`${ORIGIN}/#/pool-overview`);
  await fixture.page.getByRole('heading', { name: 'Global pool settings' }).waitFor();
  await row(fixture.page, 'drained').waitFor();
}

test('global settings use CAS, keep drafts on conflict and never send a cap', { timeout: 180_000 }, async () => {
  const f = await offlinePoolOverview();
  const { page } = f;
  try {
    await open(f);
    assert.equal(await page.getByLabel('Maximum accounts', { exact: true }).count(), 0);
    await page.getByLabel('Ready idle target').fill('6');
    f.overview = { ...f.overview, settings: { ...f.overview.settings, version: 2, idle_target: 7 } };
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await page.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
    assert.equal(await page.getByLabel('Ready idle target').inputValue(), '6');
    assert.deepEqual(f.writes.at(-1), {
      path: '/api/console/proxy/user-pool/settings', method: 'PATCH',
      body: { expectedVersion: 1, changes: { idle_target: 6, lease_seconds: 600, paused: 1 } },
    });
    await page.getByRole('button', { name: 'Reload latest settings' }).click();
    assert.equal(await page.getByLabel('Ready idle target').inputValue(), '7');
    await page.getByLabel('Lease TTL (seconds)').fill('900');
    await page.getByLabel('Pause prewarming').uncheck();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await page.getByText('Editing version 3', { exact: false }).waitFor();
    const saved = f.writes.at(-1)!.body as { expectedVersion: number; changes: Record<string, number> };
    assert.deepEqual(saved, { expectedVersion: 2, changes: { idle_target: 7, lease_seconds: 900, paused: 0 } });
    assert.equal(f.writes.some((write) => JSON.stringify(write.body).includes('max_accounts')), false);
    await page.getByRole('button', { name: 'Reconcile now' }).click();
    await page.getByText('Reconciliation scheduled.', { exact: false }).waitFor();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('enterprise table shows state, inventory, shares, blockers and name capacity', { timeout: 180_000 }, async () => {
  const f = await offlinePoolOverview();
  const { page } = f;
  try {
    await open(f);
    const active = await row(page, 'default').locator('td').allInnerTexts();
    assert.deepEqual(active.slice(1, 11), ['active', '7 / 9', '100.0%', '100.0%', '0', '2', '3', '1', '1 / 0', 'None']);
    const draft = await row(page, 'ghe-tenant').locator('td').allInnerTexts();
    assert.deepEqual(draft.slice(1, 6), ['draft', '0 / 1', '—', '—', '—']);
    assert.equal(draft[10], 'sso_missing');
    assert.match(draft[0]!, /ghe-tenant · fixture\.ghe\.com/);
    await page.getByText('9,985 of 10,000 names remain', { exact: false }).waitFor();
    await page.getByText('it is not a billing figure', { exact: false }).waitFor();
    await page.getByText('they are not traffic quotas', { exact: false }).waitFor();
    assert.equal(await row(page, 'default').getByRole('button', { name: /^Drain / }).count(), 1);
    assert.equal(await row(page, 'ghe-tenant').getByRole('button', { name: /^Activate / }).count(), 1);
    assert.equal(await row(page, 'drained').getByRole('button', { name: /^Resume / }).count(), 1);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('cap edits use CAS on policy_version and keep the draft until reload', { timeout: 180_000 }, async () => {
  const f = await offlinePoolOverview();
  const { page } = f;
  try {
    await open(f);
    await row(page, 'ghe-tenant').getByRole('button', { name: /^Edit cap of / }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit enterprise cap' });
    assert.match(await dialog.innerText(), /ghe-tenant[\s\S]*ghe-tenant-slug/);
    await dialog.getByLabel('Enterprise maximum accounts').fill('3');
    const tenant = f.items[1]!;
    tenant.pool = { ...tenant.pool!, policyVersion: 2, maxAccounts: 6 };
    await dialog.getByRole('button', { name: 'Save cap' }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
    assert.equal(await dialog.getByLabel('Enterprise maximum accounts').inputValue(), '3');
    assert.deepEqual(f.writes.at(-1), {
      path: '/api/console/proxy/enterprises/ghe-tenant/pool-policy', method: 'PATCH',
      body: { expectedVersion: 1, maxAccounts: 3 },
    });
    await dialog.getByRole('button', { name: 'Reload latest policy' }).click();
    assert.equal(await dialog.getByLabel('Enterprise maximum accounts').inputValue(), '6');
    await dialog.getByLabel('Enterprise maximum accounts').fill('4');
    await dialog.getByRole('button', { name: 'Save cap' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(f.writes.at(-1)!.body, { expectedVersion: 2, maxAccounts: 4 });
    await row(page, 'ghe-tenant').getByText('0 / 4', { exact: true }).waitFor();
    await page.getByText('Cap of ghe-tenant set to 4.', { exact: false }).waitFor();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('blocked activation lists safe blockers; drain and resume name the enterprise', { timeout: 180_000 }, async () => {
  const f = await offlinePoolOverview();
  const { page } = f;
  try {
    await open(f);
    await row(page, 'ghe-tenant').getByRole('button', { name: /^Activate / }).click();
    const activate = page.getByRole('dialog', { name: 'Activate enterprise' });
    assert.match(await activate.innerText(), /Enterprise ID\s+ghe-tenant[\s\S]*Slug\s+ghe-tenant-slug/);
    assert.match(await activate.innerText(), /sso: unknown/);
    await activate.getByRole('button', { name: 'Confirm activation' }).click();
    const blocked = activate.getByRole('alert').filter({ hasText: 'Readiness blockers:' });
    await blocked.waitFor();
    assert.match(await blocked.innerText(), /sso_missing, login:github_base_url_mismatch and 2 other blocker\(s\)/);
    const text = await page.locator('body').innerText();
    assert.equal(text.includes('secret.test'), false);
    assert.equal(await activate.locator('img').count(), 0);
    assert.equal(f.items[1]!.pool!.state, 'draft');
    assert.deepEqual(f.writes.at(-1)!.body, { expectedVersion: 1, state: 'active' });

    f.notReady = false;
    await activate.getByRole('button', { name: 'Confirm activation' }).click();
    await activate.waitFor({ state: 'hidden' });
    await row(page, 'ghe-tenant').getByText('active', { exact: true }).waitFor();

    await row(page, 'default').getByRole('button', { name: /^Drain / }).click();
    const drain = page.getByRole('dialog', { name: 'Drain enterprise' });
    assert.match(await drain.innerText(), /Enterprise ID\s+default[\s\S]*Slug\s+default-slug/);
    await drain.getByRole('button', { name: 'Confirm drain' }).click();
    await drain.waitFor({ state: 'hidden' });
    assert.deepEqual(f.writes.at(-1), {
      path: '/api/console/proxy/enterprises/default/pool-policy', method: 'PATCH',
      body: { expectedVersion: 1, state: 'draining' },
    });
    await row(page, 'drained').getByRole('button', { name: /^Resume / }).click();
    const resume = page.getByRole('dialog', { name: 'Resume enterprise' });
    await resume.getByRole('button', { name: 'Confirm resume' }).click();
    await row(page, 'drained').getByText('active', { exact: true }).waitFor();
    assert.equal(f.items[0]!.pool!.state, 'draining');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('a lifecycle response after leaving the page neither reloads nor notifies', { timeout: 180_000 }, async () => {
  const f = await offlinePoolOverview();
  const { page } = f;
  try {
    await open(f);
    f.holdPolicy = deferred();
    await row(page, 'default').getByRole('button', { name: /^Drain / }).click();
    await page.getByRole('dialog', { name: 'Drain enterprise' }).getByRole('button', { name: 'Confirm drain' }).click();
    await page.evaluate(() => { window.location.hash = '#/error-diagnostics'; });
    await page.getByRole('heading', { name: 'Global pool settings' }).waitFor({ state: 'hidden' });
    const writes = f.writes.length;
    f.holdPolicy.resolve();
    await paint(page);
    await page.waitForTimeout(200);
    assert.equal(await page.getByText('Drain enterprise:', { exact: false }).count(), 0);
    assert.equal(f.writes.length, writes);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
