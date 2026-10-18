import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Page, Route } from 'playwright';
import type { ManagementOperation, SsoRuntimeSettingsDto, SsoUserDto } from '@ghcp/shared';
import { createConsoleFixture, enterpriseRow, paths, settle } from './test-support/console-fixture.js';

const TENANT = 'ghe-tenant';
const TENANT_PREFIX = `/enterprises/${TENANT}/`;
const timestamp = '2026-10-18T00:00:00.000Z';

const tenantUser: SsoUserDto = {
  ssoUser: 'tenant-user', email: 'tenant-user@example.test', role: 'user', emuStatus: 'active',
  copilotSeatStatus: 'assigned', createdAt: timestamp, updatedAt: timestamp,
};
const tenantSettings: SsoRuntimeSettingsDto = {
  maxSsoUsers: 10, userPrefix: 'tenant', emailDomain: 'tenant.example.test', bulkSyncConcurrency: 1,
  scimRequestDelayMs: 0, scimMaxRetries: 1, scimRetryBaseDelayMs: 0, version: 4, updatedAt: timestamp,
};

function preview(action: string, ids: string[]): ManagementOperation {
  return {
    id: 'tenant-operation', scope: 'users', action, status: 'preview',
    items: ids.map((id) => ({ id, status: 'pending' })),
    createdAt: timestamp, updatedAt: timestamp, expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

/** The shared fixture serves `default`; the second enterprise is answered in the browser. */
async function twoEnterprises(t: TestContext) {
  const fixture = await createConsoleFixture(t);
  const tenantRequests: string[] = [];
  const items = [
    enterpriseRow('default', { displayName: 'Default enterprise', slug: 'default-slug' }),
    enterpriseRow(TENANT, { displayName: 'GHE tenant', slug: 'ghe-slug' }),
  ];
  await fixture.page.route(`**${paths.enterprises}`, (route) => fulfill(route, { items, nameCapacity: 10000 }));
  await fixture.page.route(`**/api/console/*${TENANT_PREFIX}**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    tenantRequests.push(`${request.method()} ${url.pathname}`);
    return fulfill(route, tenantResponse(url.pathname, request.postDataJSON()));
  });
  return { ...fixture, tenantRequests };
}

function tenantResponse(path: string, body: { action?: string; selection?: { ids?: string[] } } | null): unknown {
  if (path.endsWith('/users')) return { items: [tenantUser], total: 1, page: 1, pageSize: 25 };
  if (path.endsWith('/users/capacity')) return { current: 1, limit: 10, remaining: 9, reached: false };
  if (path.endsWith('/settings/runtime')) return tenantSettings;
  if (path.endsWith('/users/operations/preview')) return preview(body?.action ?? '', body?.selection?.ids ?? []);
  return { error: { code: 'not_found', message: `Unexpected tenant route ${path}` } };
}

function fulfill(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function selectEnterprise(page: Page, id: string) {
  await page.getByLabel('Enterprise', { exact: true }).selectOption(id);
  await settle(page);
}

async function paint(page: Page) {
  await page.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))');
}

test('enterprise switch aborts the list read, drops late rows and resets selection', { timeout: 90_000 }, async (t) => {
  const fixture = await twoEnterprises(t);
  const { page } = fixture;
  await fixture.goto('users');
  await page.getByLabel('Select user-0', { exact: true }).check();
  await page.getByText('1 record(s) selected', { exact: true }).waitFor();
  const release = fixture.hold(paths.users);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Refreshing records...', { exact: true }).waitFor();
  await page.getByLabel('Enterprise', { exact: true }).selectOption(TENANT);
  await page.getByLabel('Select tenant-user', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, `#/users?e=${TENANT}`);
  await page.getByText('0 record(s) selected', { exact: true }).waitFor();
  release();
  await settle(page);
  await paint(page);
  assert.equal(await page.getByLabel('Select user-0', { exact: true }).count(), 0, 'the late default list is dropped');
  assert.equal(await page.getByLabel('Select tenant-user', { exact: true }).count(), 1);
  assert.ok(fixture.tenantRequests.includes(`GET /api/console/sso/enterprises/${TENANT}/users`));
  await selectEnterprise(page, 'default');
  await page.getByLabel('Select user-0', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Select user-0', { exact: true }).isChecked(), false);
  fixture.assertHealthy();
});

test('SSO settings drafts reset on switch; global Login drafts stay', { timeout: 90_000 }, async (t) => {
  const fixture = await twoEnterprises(t);
  const { page } = fixture;
  await fixture.goto('settings');
  await page.getByLabel('Fallback user prefix').fill('draft-prefix');
  await page.getByLabel('Login concurrency').fill('7');
  await selectEnterprise(page, TENANT);
  await page.getByText(`Account defaults and GitHub synchronization of enterprise ${TENANT}.`).waitFor();
  assert.equal(await page.getByLabel('Fallback user prefix').inputValue(), 'tenant');
  assert.equal(await page.getByLabel('Login concurrency').inputValue(), '7', 'Login settings are global');
  await selectEnterprise(page, 'default');
  await page.getByText('Account defaults and GitHub synchronization of enterprise default.').waitFor();
  assert.equal(await page.getByLabel('Fallback user prefix').inputValue(), 'fixture', 'the old draft is discarded');
  assert.equal(fixture.count(paths.ssoSettings, 'PATCH'), 0);
  assert.equal(fixture.tenantRequests.filter((entry) => entry.startsWith('PATCH')).length, 0);
  fixture.assertHealthy();
});

test('destructive confirmations name the enterprise id and slug they act on', { timeout: 90_000 }, async (t) => {
  const fixture = await twoEnterprises(t);
  const { page } = fixture;
  await fixture.goto(`/users?e=${TENANT}`);
  await page.getByLabel('Select tenant-user', { exact: true }).check();
  await page.getByRole('button', { name: 'Delete SSO users', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm: delete_sso' });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Enterprise ghe-tenant \(slug ghe-slug\)\. 1 eligible target\(s\)/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(fixture.tenantRequests.filter((entry) => entry.startsWith('POST')), [
    `POST /api/console/sso/enterprises/${TENANT}/users/operations/preview`,
  ]);
  assert.equal(fixture.count(`${paths.users}/operations/preview`, 'POST'), 0);
  fixture.assertHealthy();
});

test('an unknown enterprise in the URL blocks scoped pages and requests', { timeout: 60_000 }, async (t) => {
  const fixture = await twoEnterprises(t);
  const { page } = fixture;
  await fixture.goto('/users?e=missing-one');
  await page.getByRole('alert').filter({ hasText: 'Enterprise "missing-one" is not configured' }).waitFor();
  assert.equal(fixture.requests.some((request) => request.path.includes('/enterprises/missing-one')), false);
  assert.equal(fixture.tenantRequests.length, 0);
  await selectEnterprise(page, 'default');
  await page.getByLabel('Select user-0', { exact: true }).waitFor();
  fixture.assertHealthy();
});
