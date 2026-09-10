import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import type { UserPoolOverview } from '../api/userPool.js';

const hash = `sha256:${'a'.repeat(64)}`;
const leaseId = '11111111-2222-4333-8444-555555555555';
const now = 1_789_000_000_000;
function overview(): UserPoolOverview {
  const account = {
    identity: 'amber00', ordinal: 0, state: 'ready', stage: 'ready', ghLogin: 'amber00-example', oauthStatus: 'valid',
    attempts: 0, retryAt: null, lastError: null, updatedAt: now, cooldownUntil: null, verifiedAt: now,
    callerKeyHash: hash, leasePhase: 'active', leaseExpiresAt: now + 172800000, activeRequests: 0,
  };
  return {
    enabled: true, poolId: 'default', observedAt: now,
    settings: { version: 1, idle_target: 5, max_accounts: 20, lease_seconds: 172800, paused: 0 },
    counts: { total: 3, ready_idle: 0, leased: 1, provisional: 0, provisioning: 0, cooling: 0, failed: 1, disabled: 1 },
    accounts: [account, { ...account, identity: 'birch00', state: 'failed', lastError: 'service_unavailable', callerKeyHash: null, leasePhase: null },
      { ...account, identity: 'cedar00', state: 'disabled', callerKeyHash: null, leasePhase: null }],
    leases: [{ leaseId, memberIdentity: 'amber00', callerKeyHash: hash, phase: 'active', assignedAt: now, lastSuccessAt: now, expiresAt: now + 172800000, inUse: false }],
    events: [{ id: 1, at: now, action: 'lease_acquired', identity: 'amber00', callerKeyHash: hash, leaseId, detail: null }],
    limits: { maxAccounts: 10000, minLeaseSeconds: 60, maxLeaseSeconds: 2592000 },
    listLimits: { accounts: 1000, leases: 1000, events: 200 },
  };
}

test('offline browser covers pool controls, version conflicts, disabled mode, and mobile layout', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let data = overview();
  let mode: 'enabled' | 'disabled' | 'error' = 'enabled';
  const mutations: Array<{ path: string; body: any }> = [];
  try {
    // Every request is fulfilled locally. No Proxy, SSO, Login, cloud, or real tenant is contacted.
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/console/setup') return json({ initialized: true });
      if (path === '/api/console/me') return json({ username: 'offline-admin', role: 'admin' });
      if (path === '/api/console/proxy/user-pool') {
        if (mode === 'disabled') return json({ error: { code: 'pool_mode_disabled', message: 'Disabled.' } }, 409);
        if (mode === 'error') return json({ error: { code: 'service_proxy_failed', message: 'Proxy unavailable.' } }, 502);
        return json(data);
      }
      if (path.startsWith('/api/console/proxy/user-pool/')) {
        const body = route.request().postDataJSON();
        mutations.push({ path, body });
        if (path.endsWith('/settings')) {
          if (body.expectedVersion !== data.settings.version) return json({ error: { code: 'settings_version_conflict', message: 'Reload latest settings.' } }, 409);
          data.settings = { ...data.settings, ...body.changes, version: data.settings.version + 1 };
          return json(data.settings);
        }
        if (path.endsWith('/release')) {
          data.leases = [];
          data.counts.leased = 0;
          return json({ released: true });
        }
        if (path.endsWith('/reconcile')) return json({ scheduled: true }, 202);
        const action = path.split('/').at(-1);
        const identity = path.split('/').at(-2);
        const account = data.accounts.find((item) => item.identity === identity);
        if (account) account.state = action === 'disable' ? 'disabled' : 'provisioning';
        return json({ accepted: true });
      }
      if (path === '/' || path.startsWith('/assets/')) {
        const file = resolve(process.cwd(), 'dist/web', path === '/' ? 'index.html' : path.slice(1));
        const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
        return route.fulfill({ contentType, body: await readFile(file) });
      }
      return route.abort();
    });
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await page.getByText('Low idle capacity:', { exact: false }).waitFor();
    assert.equal(await page.locator(`code[title="${hash}"]`).count(), 1);
    assert.match(await page.locator(`code[title="${hash}"]`).first().innerText(), /^sha256:.*…/);
    await page.getByLabel('Refresh every 10s').uncheck();
    if (process.env.POOL_UI_SCREENSHOT) await page.screenshot({ path: process.env.POOL_UI_SCREENSHOT, fullPage: true });

    await page.getByLabel('Ready idle target').fill('6');
    data.settings = { ...data.settings, version: 2, idle_target: 7 };
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await page.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
    assert.equal(await page.getByLabel('Ready idle target').inputValue(), '6');
    assert.equal(mutations.at(-1)?.body.expectedVersion, 1);
    await page.getByRole('button', { name: 'Reload latest settings' }).click();
    assert.equal(await page.getByLabel('Ready idle target').inputValue(), '7');
    await page.getByLabel('Lease TTL (seconds)').fill('600');
    await page.getByLabel('Pause prewarming').check();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await page.getByText('Editing version 3', { exact: false }).waitFor();
    assert.equal(mutations.at(-1)?.body.expectedVersion, 2);
    assert.equal(data.settings.paused, 1);
    assert.equal(data.settings.lease_seconds, 600);

    await page.getByRole('button', { name: 'Reconcile now' }).click();
    await page.getByText('Reconciliation scheduled.', { exact: false }).waitFor();
    const accountRow = page.getByRole('row').filter({ hasText: 'amber00' }).first();
    await accountRow.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(data.accounts[0]!.state, 'ready');
    await accountRow.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disable account' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await accountRow.getByRole('button', { name: 'Resume', exact: true }).click();
    await accountRow.getByText('Provisioning', { exact: true }).waitFor();
    await page.getByRole('row').filter({ hasText: 'birch00' }).getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('row').filter({ hasText: 'birch00' }).getByText('Provisioning', { exact: true }).waitFor();

    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('dialog').locator(`code[title="${hash}"]`).count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(data.leases.length, 1);
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Release lease' }).click();
    await page.getByText('No leases match.', { exact: false }).waitFor();
    assert.deepEqual(mutations.find((item) => item.path.endsWith('/release'))?.body, { confirm: true });
    await page.getByRole('button', { name: 'Recent events', exact: true }).click();
    await page.getByText('lease acquired', { exact: true }).waitFor();

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    mode = 'error';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Proxy unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reconcile now' }).isDisabled(), true);
    mode = 'disabled';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'User pool is disabled' }).waitFor();
    assert.equal(await page.getByLabel('Ready idle target').count(), 0);
    mode = 'enabled';
    data = overview();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByLabel('Ready idle target').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
