import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import type { UserPoolAccount, UserPoolOverview } from '../api/userPool.js';

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

test('offline browser covers pool controls, version conflicts, disabled mode, and mobile layout', { timeout: 120000 }, async () => {
  const fixture = await offlinePool(overview());
  const { page, mutations, errors } = fixture;
  try {
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await page.getByText('Low idle capacity:', { exact: false }).waitFor();
    assert.equal(await page.locator(`code[title="${hash}"]`).count(), 1);
    assert.equal(await page.locator(`code[title="${hash}"]`).first().textContent(), hash);
    await page.getByLabel('Refresh every 10s').uncheck();
    if (process.env.POOL_UI_SCREENSHOT) await page.screenshot({ path: process.env.POOL_UI_SCREENSHOT, fullPage: true });

    await page.getByLabel('Ready idle target').fill('6');
    fixture.data.settings = { ...fixture.data.settings, version: 2, idle_target: 7 };
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
    assert.equal(fixture.data.settings.paused, 1);
    assert.equal(fixture.data.settings.lease_seconds, 600);

    await page.getByRole('button', { name: 'Reconcile now' }).click();
    await page.getByText('Reconciliation scheduled.', { exact: false }).waitFor();
    const accountRow = page.getByRole('row').filter({ hasText: 'amber00' }).first();
    await accountRow.getByRole('button', { name: 'Disable', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    assert.equal(fixture.data.accounts[0]!.state, 'ready');
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
    assert.equal(fixture.data.leases.length, 1);
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
    fixture.mode = 'error';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Proxy unavailable' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reconcile now' }).isDisabled(), true);
    fixture.mode = 'disabled';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('heading', { name: 'User pool is disabled' }).waitFor();
    assert.equal(await page.getByLabel('Ready idle target').count(), 0);
    fixture.mode = 'enabled';
    fixture.data = overview();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByLabel('Ready idle target').waitFor();
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('server pagination and state/search filters cover more than 25 records and ignore out-of-order lists', { timeout: 120000 }, async () => {
  const fixture = await offlinePool(largeOverview());
  const { page } = fixture;
  try {
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByText('1–25 of 100 matching records', { exact: true }).waitFor();
    await page.getByLabel('Refresh every 10s').uncheck();
    assert.equal(await accountRows(page).count(), 25);
    assert.deepEqual(await accountIdentities(page), identities(0, 25));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('26–50 of 100 matching records', { exact: true }).waitFor();
    await accountRows(page).getByText('member-025', { exact: true }).waitFor();
    assert.deepEqual(await accountIdentities(page), identities(25, 50));
    assert.equal(fixture.reads.at(-1)?.searchParams.get('page'), '2');
    assert.equal(fixture.reads.at(-1)?.searchParams.get('pageSize'), '25');

    await page.getByLabel('Filter pool state').selectOption('failed');
    await page.getByText('1–20 of 20 matching records', { exact: true }).waitFor();
    assert.deepEqual(await accountIdentities(page), identities(80, 100));
    assert.equal(fixture.reads.at(-1)?.searchParams.get('state'), 'failed');
    assert.equal(fixture.reads.at(-1)?.searchParams.get('page'), '1');
    assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
    await page.getByLabel('Search pool records').fill('member-09');
    await page.getByText('1–10 of 10 matching records', { exact: true }).waitFor();
    assert.deepEqual(await accountIdentities(page), identities(90, 100));

    // Hold an older query until the newer one is visibly rendered.
    const oldQuery = fixture.hold((url) => url.pathname.endsWith('/page/accounts') && url.searchParams.get('q') === 'member-08');
    await page.getByLabel('Search pool records').fill('member-08');
    await oldQuery.started.promise;
    await page.getByLabel('Search pool records').fill('member-099');
    await page.getByText('1–1 of 1 matching records', { exact: true }).waitFor();
    assert.deepEqual(await accountIdentities(page), ['member-099']);
    oldQuery.release.resolve();
    await oldQuery.finished.promise;
    await paint(page);
    assert.deepEqual(await accountIdentities(page), ['member-099']);
    assert.equal(await page.getByLabel('Search pool records').inputValue(), 'member-099');

    // A late accounts response must not empty or overwrite the current leases tab.
    const oldTab = fixture.hold((url) => url.pathname.endsWith('/page/accounts') && url.searchParams.get('q') === '');
    await page.getByLabel('Search pool records').fill('');
    await oldTab.started.promise;
    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    await page.getByRole('region', { name: 'Caller leases' }).getByText('member-000', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Caller leases' }).locator('tbody tr').count(), 25);
    oldTab.release.resolve();
    await oldTab.finished.promise;
    await paint(page);
    assert.equal(await page.getByRole('button', { name: 'Leases', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('region', { name: 'Caller leases' }).locator('tbody tr').count(), 25);
    await page.getByLabel('Filter pool state').selectOption('provisional');
    await page.getByText('1–20 of 20 matching records', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Caller leases' }).getByText('member-099', { exact: true }).count(), 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('deferred mutations and settings saves lock tab/filter/page until their refresh completes', { timeout: 120000 }, async () => {
  const fixture = await offlinePool(largeOverview());
  const { page } = fixture;
  try {
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByText('1–25 of 100 matching records', { exact: true }).waitFor();
    await page.getByLabel('Refresh every 10s').uncheck();
    await page.getByLabel('Search pool records').fill('member-0');
    await page.getByLabel('Filter pool state').selectOption('ready_idle');
    await page.getByText('1–25 of 80 matching records', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByText('26–50 of 80 matching records', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();

    for (const kind of ['reconcile', 'settings', 'settings-conflict'] as const) {
      const mutation = fixture.hold((url) => url.pathname.endsWith(kind === 'reconcile' ? '/reconcile' : '/settings'));
      if (kind !== 'reconcile') await page.getByLabel('Ready idle target').fill(kind === 'settings' ? '6' : '7');
      if (kind === 'settings-conflict') fixture.data.settings = { ...fixture.data.settings, version: fixture.data.settings.version + 1, idle_target: 9 };
      const readsBefore = fixture.reads.length;
      await page.getByRole('button', { name: kind === 'reconcile' ? 'Reconcile now' : 'Save and apply', exact: true }).click();
      await mutation.started.promise;
      await assertListsLocked(page);
      assert.equal(fixture.reads.length, readsBefore, 'no list reload may start while the mutation is pending');
      assert.equal(await page.getByLabel('Search pool records').inputValue(), 'member-0');
      assert.equal(await page.getByLabel('Filter pool state').inputValue(), 'ready_idle');
      assert.equal(await page.getByText('Page 2 / 4', { exact: true }).count(), 1);
      // The lock must cover the post-mutation refresh too, not only the POST/PATCH.
      const refresh = fixture.hold((url) => url.pathname.endsWith('/page/accounts'));
      mutation.release.resolve();
      await refresh.started.promise;
      await assertListsLocked(page);
      const request = fixture.reads.at(-1)!;
      assert.equal(request.searchParams.get('page'), '2');
      assert.equal(request.searchParams.get('q'), 'member-0');
      assert.equal(request.searchParams.get('state'), 'ready_idle');
      refresh.release.resolve();
      await refresh.finished.promise;
      await page.locator('nav[aria-label="User pool lists"] button:not(:disabled)').first().waitFor();
      assert.deepEqual(await accountIdentities(page), identities(25, 50));
      if (kind === 'settings-conflict') {
        await page.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
        assert.equal(await page.getByLabel('Ready idle target').inputValue(), '7');
        await page.getByRole('button', { name: 'Reload latest settings' }).click();
        assert.equal(await page.getByLabel('Ready idle target').inputValue(), '9');
      }
    }
    // Navigation works again after success/conflict; no old mutation closure reloads accounts.
    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    await page.getByRole('region', { name: 'Caller leases' }).getByText('member-000', { exact: true }).waitFor();
    assert.equal(fixture.reads.at(-1)?.pathname.endsWith('/page/leases'), true);
    assert.equal(fixture.reads.at(-1)?.searchParams.get('page'), '1');
    assert.equal(fixture.reads.at(-1)?.searchParams.get('state'), '');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('late mutations do not reload or notify after the pool page unmounts', { timeout: 120000 }, async () => {
  const fixture = await offlinePool(overview());
  const { page } = fixture;
  try {
    for (const kind of ['reconcile', 'settings'] as const) {
      await page.goto('http://pool-console.test/#user-pool');
      await page.getByLabel('Ready idle target').waitFor();
      await page.getByLabel('Refresh every 10s').uncheck();
      const mutation = fixture.hold((url) => url.pathname.endsWith(`/${kind}`));
      if (kind === 'settings') await page.getByLabel('Ready idle target').fill('6');
      await page.getByRole('button', { name: kind === 'settings' ? 'Save and apply' : 'Reconcile now', exact: true }).click();
      await mutation.started.promise;
      const readsBefore = fixture.reads.length;
      await page.evaluate(() => { window.location.hash = 'diagnostics'; });
      await page.getByRole('heading', { name: 'Default user pool' }).waitFor({ state: 'hidden' });
      mutation.release.resolve();
      await mutation.finished.promise;
      await paint(page);
      assert.equal(fixture.reads.length, readsBefore, 'an unmounted mutation must not start a new list request');
      assert.equal(await page.getByText('Pool settings saved.', { exact: false }).count(), 0);
      assert.equal(await page.getByText('Reconciliation scheduled.', { exact: false }).count(), 0);
    }
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

function largeOverview(): UserPoolOverview {
  const data = overview();
  data.settings.max_accounts = 200;
  data.accounts = Array.from({ length: 100 }, (_, index) => ({
    ...data.accounts[0]!, identity: `member-${String(index).padStart(3, '0')}`, ordinal: index,
    ghLogin: null, state: index < 80 ? 'ready' : 'failed', callerKeyHash: null, leasePhase: null,
  }));
  data.leases = data.accounts.map((account, index) => ({
    ...data.leases[0]!, leaseId: `lease-${index}`, memberIdentity: account.identity, phase: index < 80 ? 'active' : 'provisional',
  }));
  data.counts = { ...data.counts, total: 100, ready_idle: 80, leased: 80, provisional: 20, failed: 20, disabled: 0 };
  return data;
}
function identities(start: number, end: number) { return Array.from({ length: end - start }, (_, index) => `member-${String(start + index).padStart(3, '0')}`); }
function accountRows(page: Page) { return page.getByRole('region', { name: 'Pool accounts' }).locator('tbody tr'); }
async function accountIdentities(page: Page) { return accountRows(page).locator('td:first-child p:first-child').allTextContents(); }
async function paint(page: Page) { await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function assertListsLocked(page: Page) {
  for (const name of ['Accounts', 'Leases', 'Recent events', 'Previous', 'Next']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true, `${name} should be disabled while busy`);
  }
  assert.equal(await page.getByLabel('Search pool records').isDisabled(), true);
  assert.equal(await page.getByLabel('Filter pool state').isDisabled(), true);
  // Native disabled buttons must also ignore direct clicks (without Playwright waiting for enablement).
  await page.getByRole('button', { name: 'Leases', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  await page.getByRole('button', { name: 'Next', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  assert.equal(await page.getByRole('button', { name: 'Accounts', exact: true }).getAttribute('aria-pressed'), 'true');
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('full LiteLLM hashes copy from accounts, leases, events and confirmation', { timeout: 90000 }, async () => {
  const fixture = await offlinePool(overview());
  const { page } = fixture;
  try {
    await page.addInitScript({ content: `
      window.__clipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async function(value) { window.__clipboardWrites.push(value); }
      } });
    ` });
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await page.getByLabel('Refresh every 10s').uncheck();
    const accounts = page.getByRole('region', { name: 'Pool accounts' });
    const code = accounts.locator(`code[title="${hash}"]`);
    assert.equal(await code.textContent(), hash);
    const selected = await code.evaluate(element => {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    assert.equal(selected, hash);
    await accounts.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    await accounts.getByRole('status').filter({ hasText: 'Hash copied.' }).waitFor();
    await accounts.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites.length === 2);
    assert.equal(await accounts.getByRole('row').filter({ hasText: 'birch00' }).getByRole('button', { name: /Copy/ }).count(), 0);
    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    const leases = page.getByRole('region', { name: 'Caller leases' });
    await leases.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).focus();
    await page.keyboard.press('Space');
    await leases.getByRole('status').filter({ hasText: 'Hash copied.' }).waitFor();
    await leases.getByRole('button', { name: 'Release', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Hash copied.' }).waitFor();
    assert.equal(fixture.mutations.length, 0, 'copy must not release a lease');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Recent events', exact: true }).click();
    const events = page.getByRole('region', { name: 'Recent pool events' });
    await events.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    await events.getByRole('status').filter({ hasText: 'Hash copied.' }).waitFor();
    const writes = await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites);
    assert.deepEqual(writes, Array(5).fill(hash.slice(7)));
    assert.ok(writes.every(value => !value.includes('…') && !value.includes('...')));
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('copy icon hints on hover or focus and success clears without changing row height', { timeout: 90000 }, async () => {
  const fixture = await offlinePool(overview());
  const { page } = fixture;
  try {
    await page.addInitScript({ content: `
      window.__clipboardWrites = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async function(value) { window.__clipboardWrites.push(value); }
      } });
    ` });
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await page.getByLabel('Refresh every 10s').uncheck();
    const accounts = page.getByRole('region', { name: 'Pool accounts' });
    const button = accounts.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true });
    const row = accounts.getByRole('row').filter({ has: page.getByText('amber00', { exact: true }) });
    assert.equal(await button.innerText(), '');
    assert.equal(await button.locator('svg').count(), 1);
    assert.equal(await button.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    const before = (await row.boundingBox())!.height;
    await button.hover();
    await accounts.getByRole('tooltip', { name: 'Copy hash', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Default user pool' }).hover();
    await accounts.getByRole('tooltip').waitFor({ state: 'hidden' });
    await button.focus();
    await accounts.getByRole('tooltip', { name: 'Copy hash', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await accounts.getByRole('tooltip').waitFor({ state: 'hidden' });
    await button.click();
    await accounts.getByRole('tooltip', { name: 'Copied', exact: true }).waitFor();
    assert.equal((await row.boundingBox())!.height, before);
    await accounts.getByRole('tooltip').waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await accounts.getByRole('status').textContent(), '');
    assert.equal((await row.boundingBox())!.height, before);
    await button.press('Enter');
    await accounts.getByRole('tooltip', { name: 'Copied', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    await page.getByRole('button', { name: 'Accounts', exact: true }).click();
    await accounts.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).waitFor();
    assert.equal(await accounts.getByRole('tooltip').count(), 0);
    await button.hover();
    await accounts.getByRole('tooltip', { name: 'Copy hash', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __clipboardWrites: string[] }).__clipboardWrites), [hash.slice(7), hash.slice(7)]);
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('clipboard rejection or absence exposes exact selectable value and clears on refreshed identity', { timeout: 90000 }, async () => {
  const fixture = await offlinePool(overview());
  const { page } = fixture;
  try {
    await page.addInitScript({ content: `
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async function() { throw new Error('Synthetic permission denial'); }
      } });
    ` });
    await page.goto('http://pool-console.test/#user-pool');
    await page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await page.getByLabel('Refresh every 10s').uncheck();
    await page.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    const hashInput = page.getByRole('textbox', { name: 'LiteLLM key hash — full value', exact: true });
    await hashInput.waitFor();
    assert.equal(await hashInput.inputValue(), hash.slice(7));
    assert.equal(await hashInput.evaluate(input => (input as HTMLInputElement).readOnly), true);
    assert.equal(await hashInput.evaluate(input => document.activeElement === input && (input as HTMLInputElement).selectionEnd === 64), true);
    assert.equal(await page.getByRole('status').filter({ hasText: 'copied.' }).count(), 0);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    await hashInput.waitFor();
    assert.equal(await hashInput.inputValue(), hash.slice(7));
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const changed = `sha256:${'b'.repeat(64)}`;
    fixture.data.accounts[0]!.callerKeyHash = changed;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator(`code[title="${changed}"]`).waitFor();
    assert.equal(await page.getByRole('textbox', { name: /full value/ }).count(), 0);
    await page.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'LiteLLM key hash — full value', exact: true }).inputValue(), changed.slice(7));
    await page.getByRole('button', { name: 'Leases', exact: true }).click();
    await page.getByRole('button', { name: 'Release', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Copy LiteLLM key hash', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'LiteLLM key hash — full value', exact: true }).waitFor();
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('malformed caller IDs are neither rendered nor copyable', { timeout: 60000 }, async () => {
  const data = overview();
  data.accounts[0]!.callerKeyHash = 'sk-not-a-caller-hash';
  data.leases[0]!.callerKeyHash = `sha256:${'A'.repeat(64)}`;
  data.events[0]!.callerKeyHash = `sha256:${'b'.repeat(63)}`;
  const fixture = await offlinePool(data);
  try {
    await fixture.page.goto('http://pool-console.test/#user-pool');
    await fixture.page.getByRole('heading', { name: 'Default user pool' }).waitFor();
    await fixture.page.getByLabel('Refresh every 10s').uncheck();
    for (const tab of ['Accounts', 'Leases', 'Recent events']) {
      await fixture.page.getByRole('button', { name: tab, exact: true }).click();
      await paint(fixture.page);
      assert.equal(await fixture.page.getByRole('button', { name: /Copy/ }).count(), 0);
      assert.equal(await fixture.page.locator('code[title^="sha256:"]').count(), 0);
      assert.equal(await fixture.page.getByText('sk-not-a-caller-hash', { exact: true }).count(), 0);
    }
    assert.deepEqual(fixture.mutations, []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

async function offlinePool(initialData: UserPoolOverview) {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const reads: URL[] = [];
  const mutations: Array<{ path: string; body: any }> = [];
  type Hold = { matches: (url: URL) => boolean; claimed: boolean; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> };
  const holds: Hold[] = [];
  const fixture = {
    page, errors, reads, mutations, data: initialData, mode: 'enabled' as 'enabled' | 'disabled' | 'error',
    hold(matches: Hold['matches']) {
      const hold = { matches, claimed: false, started: deferred(), release: deferred(), finished: deferred() };
      holds.push(hold);
      return hold;
    },
    async close() {
      holds.forEach((hold) => hold.release.resolve());
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await page.close();
      await browser.close();
    },
  };
  // Every request is fulfilled locally. No Proxy, SSO, Login, cloud, or real tenant is contacted.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = async (body: unknown, status = 200) => {
      const serialized = JSON.stringify(body);
      const hold = holds.find((item) => !item.claimed && item.matches(url));
      if (hold) { hold.claimed = true; hold.started.resolve(); await hold.release.promise; }
      try { await route.fulfill({ status, contentType: 'application/json', body: serialized }); }
      finally { hold?.finished.resolve(); }
    };
    if (path === '/api/console/setup') return json({ initialized: true });
    if (path === '/api/console/me') return json({ username: 'offline-admin', role: 'admin' });
    const data = fixture.data;
    if (path === '/api/console/proxy/user-pool/summary') {
      if (fixture.mode === 'disabled') return json({ error: { code: 'pool_mode_disabled', message: 'Disabled.' } }, 409);
      if (fixture.mode === 'error') return json({ error: { code: 'service_proxy_failed', message: 'Proxy unavailable.' } }, 502);
      return json({ ...data, accounts: [], leases: [], events: [] });
    }
    if (path.startsWith('/api/console/proxy/user-pool/page/')) {
      reads.push(url);
      const kind = path.split('/').at(-1) as 'accounts' | 'leases' | 'events';
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const state = url.searchParams.get('state');
      const selected = data[kind].filter((row) => {
        let rowState = '';
        if (kind === 'accounts') {
          const account = row as UserPoolAccount;
          rowState = account.state === 'ready' ? account.leasePhase ?? (account.activeRequests > 0 ? 'catalog' : 'ready_idle') : account.state;
        } else if ('phase' in row) rowState = row.phase;
        return (!state || rowState === state) && JSON.stringify(row).toLowerCase().includes(query);
      });
      const pageNumber = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('pageSize') ?? 25);
      return json({ items: selected.slice((pageNumber - 1) * size, pageNumber * size), total: selected.length, page: pageNumber, pageSize: size });
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
  return fixture;
}
