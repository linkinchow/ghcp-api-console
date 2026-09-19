import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium, type Route } from 'playwright';
import type { EnterprisePoolPolicyDto, GlobalPoolSettingsDto } from '@ghcp/shared';
const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const incarnationA = 'cccccccc-3333-4333-8333-333333333333';
const incarnationB = 'dddddddd-4444-4444-8444-444444444444';
const now = 1789000000000;

function policy(enterpriseId: string): EnterprisePoolPolicyDto {
  return { enterpriseId, enterpriseRevision: 1, slug: enterpriseId === A ? 'legacy-enterprise' : 'new-enterprise', shortcode: enterpriseId === A ? 'old' : 'new', state: enterpriseId === A ? 'active' : 'draft', policyVersion: 1, maxAccounts: enterpriseId === A ? 9 : 1, validationKind: enterpriseId === A ? 'migration_preserved_v3' : null, validatedAt: enterpriseId === A ? now : null, updatedAt: now };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
async function paint(page: import('playwright').Page) { await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))); }

async function offlineEnterprise() {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(12000);
  const errors: string[] = [], unexpected: string[] = [];
  const reads: URL[] = [], writes: Array<{ path: string; body: any; method: string }> = [];
  page.on('pageerror', error => errors.push(error.message));
  type Hold = { predicate: (url: URL, method: string) => boolean; claimed: boolean; started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> };
  const holds: Hold[] = [];
  const fixture = {
    page, errors, unexpected, reads, writes, enabled: true, discoveryMode: 'ok' as 'ok' | 'unavailable' | 'unknown',
    policies: { [A]: policy(A), [B]: policy(B) } as Record<string, EnterprisePoolPolicyDto>, missingIncarnation: false, conflictCap: false, readinessBlocked: false,
    settings: { version: 1, idle_target: 4, lease_seconds: 600, paused: 1, max_accounts: 10, active_max_accounts: 9 } as GlobalPoolSettingsDto,
    hold(predicate: Hold['predicate']) { const hold = { predicate, claimed: false, started: deferred(), release: deferred(), finished: deferred() }; holds.push(hold); return hold; },
    async close() { holds.forEach(hold => hold.release.resolve()); await page.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close(); },
  };
  await page.route('**/*', async (route: Route) => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = async (body: unknown, status = 200) => {
      const serialized = JSON.stringify(body);
      const hold = holds.find(item => !item.claimed && item.predicate(url, req.method()));
      if (hold) { hold.claimed = true; hold.started.resolve(); await hold.release.promise; }
      try { await route.fulfill({ status, contentType: 'application/json', body: serialized }); } finally { hold?.finished.resolve(); }
    };
    if (url.origin !== 'http://enterprise-console.test') { unexpected.push(url.href); return route.abort(); }
    if (path === '/api/console/setup') return json({ initialized: true });
    if (path === '/api/console/me') return json({ username: 'synthetic-admin', role: 'admin' });
    if (path === '/api/console/proxy/management/enterprises') {
      if (fixture.discoveryMode === 'unavailable') return json({ error: { code: 'offline', message: 'Discovery unavailable.' } }, 503);
      return json({ enabled: fixture.enabled, legacyEnterpriseId: fixture.discoveryMode === 'unknown' ? incarnationA : A, enterprises: Object.values(fixture.policies) });
    }
    if (path.startsWith('/api/console/')) {
      if (req.method() === 'GET') reads.push(url);
      else writes.push({ path, method: req.method(), body: req.postDataJSON() });
      if (path === '/api/console/proxy/management/pool/summary') return json({
        enabled: true, legacyEnterpriseId: A, observedAt: now, settings: fixture.settings,
        enterprises: Object.values(fixture.policies).map(item => ({ ...item, counts: { total: item.enterpriseId === A ? 7 : 0, ready_idle: 2, leased: 1, provisional: 1, provisioning: 1, cooling: 1, failed: 1, disabled: 1 }, eligibleIdle: 1, pendingSupply: 1, targetShare: item.state === 'active' ? 1 : null, actualShare: item.state === 'active' ? 1 : null, shareDeficit: item.state === 'active' ? 0 : null, score: 0, overCap: false, blockedReasons: item.state === 'draft' ? ['enterprise_draft'] : [] })),
        supply: { eligibleIdle: 1, pendingSupply: 1, deficit: 2 }, names: { capacity: 10000, nextOrdinal: 54, remainingPositions: 9946 }, blockedReasons: ['prewarming_paused'],
      });
      if (path === '/api/console/proxy/management/pool/settings' && req.method() === 'PATCH') {
        const body = req.postDataJSON();
        if (body.expectedVersion !== fixture.settings.version) return json({ error: { code: 'settings_version_conflict', message: 'Global settings changed.' } }, 409);
        fixture.settings = { ...fixture.settings, ...body.changes, version: fixture.settings.version + 1 }; return json(fixture.settings);
      }
      if (path === '/api/console/login-service/settings/runtime') return json({ version: 1, updatedAt: '2026-09-18T00:00:00Z', concurrency: 1, authTimeoutMs: 120000, authDebugLogs: false, authDebugArtifacts: false });
      const scoped = path.match(/^\/api\/console\/(proxy|sso|login-service)\/profiles\/([^/]+)(\/.*)$/);
      if (scoped && [A, B].includes(scoped[2]!)) {
        const id = scoped[2]!, suffix = scoped[3]!, current = fixture.policies[id]!;
        if (suffix === '/pool-policy' && req.method() === 'GET') return json(current);
        if (suffix.startsWith('/pool-policy')) {
          const body = req.postDataJSON();
          if (fixture.readinessBlocked && suffix.endsWith('/validate')) return json({ error: {
            code: 'enterprise_readiness_blocked', message: 'Enterprise pool operation was not applied.',
            details: { blockers: ['seat_secret_unavailable', 'scim_secret_unavailable', 'https://secret.test/private', '<img src=x onerror=alert(1)>'], raw: 'private-secret-ref-not-for-display' },
          } }, 503);
          if (fixture.conflictCap || current.policyVersion !== body.expectedVersion) {
            fixture.conflictCap = false; fixture.policies[id] = { ...current, policyVersion: current.policyVersion + 1, maxAccounts: 6 };
            return json({ error: { code: 'policy_version_conflict', message: 'Policy changed.' } }, 409);
          }
          fixture.policies[id] = { ...current, policyVersion: current.policyVersion + 1, ...(suffix.endsWith('/validate') ? { state: 'validated', validationKind: 'local_service_readiness_v1', validatedAt: now } : suffix.endsWith('/activate') ? { state: 'active' } : suffix.endsWith('/drain') ? { state: 'draining' } : { maxAccounts: body.maxAccounts }) };
          return json(fixture.policies[id]);
        }
        if (suffix === '/accounts' && req.method() === 'GET') return json({ items: [{ enterpriseId: id, accountIncarnation: fixture.missingIncarnation ? undefined : id === A ? incarnationA : incarnationB, identity: 'same-name', ssoUser: 'same-name', ghLogin: `${current.shortcode}-account`, copilotOauthStatus: 'valid', updatedAt: '2026-09-18T00:00:00Z' }], total: 1, page: 1, pageSize: 25 });
        if (suffix === '/accounts/same-name' && req.method() === 'DELETE') return json({ deleted: true });
        if (suffix === '/accounts/same-name/copilot-oauth/reauthorize' && req.method() === 'POST') return json({ identity: 'same-name' });
        if (suffix === '/users' && req.method() === 'GET') return json({ items: [{ enterpriseId: id, userIncarnation: id === A ? incarnationA : incarnationB, ssoUser: 'same-name', email: `${current.shortcode}@example.test`, role: 'user', emuStatus: 'provisioned', copilotSeatStatus: 'assigned', updatedAt: '2026-09-18T00:00:00Z' }], total: 1, page: 1, pageSize: 25 });
        if (suffix === '/users/capacity') return json({ current: 1, limit: 10, remaining: 9, reached: false });
        if (suffix === '/users/same-name' && req.method() === 'PATCH') return json({ ssoUser: 'same-name', email: req.postDataJSON().email, userIncarnation: id === A ? incarnationA : incarnationB });
        if (suffix === '/users/batch') return json({ batchId: 'synthetic-batch', summary: { success: 1, failed: 0 }, rows: [{ ssoUser: 'same-name', status: 'success' }] });
        if (suffix === '/settings/runtime') return json({ version: 1, updatedAt: '2026-09-18T00:00:00Z', maxSsoUsers: 10, userPrefix: current.shortcode, emailDomain: `${current.shortcode}.test`, bulkSyncConcurrency: 1, scimRequestDelayMs: 0, scimMaxRetries: 1, scimRetryBaseDelayMs: 0 });
        if (suffix === '/tasks') return json({ items: [{ enterpriseId: id, id: 'uncertain-task', status: 'uncertain', identity: 'same-name', ssoUser: 'same-name', bindingVersion: 2, accountIncarnation: incarnationA, attempts: 1, createdAt: '2026-09-18T00:00:00Z' }], total: 1, page: 1, pageSize: 25 });
        if (suffix === '/tasks/uncertain-task/reconcile') return json({ task: { id: 'uncertain-task', status: 'uncertain' }, outcome: 'unknown' }, 202);
        if (suffix === '/request-stats/page') {
          const pageNumber = Number(url.searchParams.get('page') ?? '1'), filtered = Boolean(url.searchParams.get('q'));
          return json({ items: [{ id: pageNumber, identity: filtered ? 'retained-old-account' : `${current.shortcode}-record-page-${pageNumber}`, success: false, model: 'synthetic', path: '/v1/chat/completions', requestedAt: '2026-09-18T00:00:00Z', failureReason: 'HTTP 429: preserved error detail' }], total: filtered ? 1 : 1505, page: pageNumber, pageSize: 25 });
        }
      }
      unexpected.push(`${req.method()} ${path}`); return json({ error: { code: 'unexpected', message: 'Unexpected offline route.' } }, 404);
    }
    if (path === '/' || /^\/assets\/[\w.-]+$/.test(path)) return route.fulfill({ contentType: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(resolve(process.cwd(), 'dist/web', path === '/' ? 'index.html' : path.slice(1))) });
    if (path !== '/favicon.ico') unexpected.push(path); return route.fulfill({ status: 404, body: '' });
  });
  return fixture;
}

test('offline enterprise policy has scoped cap CAS, lifecycle confirmation, and draft reset', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    await page.goto('http://enterprise-console.test/#enterprise-policy');
    await page.getByLabel('Enterprise maximum accounts').waitFor();
    assert.equal(await page.getByLabel('Enterprise', { exact: true }).inputValue(), A);
    await page.getByLabel('Enterprise maximum accounts').fill('8');
    await page.getByLabel('Enterprise', { exact: true }).selectOption(B);
    await page.getByLabel('Enterprise maximum accounts').waitFor();
    assert.equal(await page.getByLabel('Enterprise maximum accounts').inputValue(), '1');
    await page.getByLabel('Enterprise maximum accounts').fill('3'); f.conflictCap = true;
    await page.getByRole('button', { name: 'Save enterprise cap' }).click();
    await page.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
    assert.equal(await page.getByLabel('Enterprise maximum accounts').inputValue(), '3');
    assert.deepEqual(f.writes.at(-1), { path: `/api/console/proxy/profiles/${B}/pool-policy`, method: 'PATCH', body: { expectedVersion: 1, maxAccounts: 3 } });
    await page.getByRole('button', { name: 'Reload latest policy' }).click();
    assert.equal(await page.getByLabel('Enterprise maximum accounts').inputValue(), '6');
    await page.getByRole('button', { name: 'Validate configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Activate enterprise', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Activate enterprise', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.match(await page.getByRole('dialog').innerText(), new RegExp(B));
    await page.getByRole('button', { name: 'Confirm activation', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(f.writes.at(-1)!.body, { expectedVersion: 3, confirm: true });
    await page.getByRole('button', { name: 'Drain enterprise', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm drain', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(f.policies[B]!.state, 'draining');
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('missing-secret readiness shows safe blocker codes without activation or raw details', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    f.readinessBlocked = true;
    await page.goto('http://enterprise-console.test/#enterprise-policy');
    await page.getByLabel('Enterprise maximum accounts').waitFor();
    await page.getByLabel('Enterprise', { exact: true }).selectOption(B);
    await page.getByRole('button', { name: 'Validate configuration', exact: true }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Configuration blockers:' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /seat_secret_unavailable, scim_secret_unavailable/);
    assert.match(await alert.innerText(), /offline service configuration/);
    const content = await page.locator('body').innerText();
    assert.equal(content.includes('secret.test'), false);
    assert.equal(content.includes('private-secret-ref'), false);
    assert.equal(await alert.locator('img').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Activate enterprise', exact: true }).isDisabled(), true);
    assert.equal(f.policies[B]!.state, 'draft');
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0]!.path, `/api/console/proxy/profiles/${B}/pool-policy/validate`);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('global summary uses authoritative supply/catalog, editable idle TTL pause and derived read-only caps', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    await page.goto('http://enterprise-console.test/#enterprises');
    await page.getByRole('heading', { name: 'Global pool settings', exact: true }).waitFor();
    assert.equal(await page.getByText('9,946', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('Enterprise maximum accounts').count(), 0);
    assert.equal(await page.getByLabel('Maximum accounts', { exact: true }).count(), 0);
    await page.getByLabel('Global idle target', { exact: true }).fill('900');
    await page.getByLabel('Global lease TTL (seconds)', { exact: true }).fill('700');
    await page.getByLabel('Pause global prewarming').uncheck();
    await page.getByRole('button', { name: 'Save global settings' }).click();
    await page.getByText('Global settings version 2', { exact: true }).waitFor();
    assert.deepEqual(f.writes.at(-1), { path: '/api/console/proxy/management/pool/settings', method: 'PATCH', body: { expectedVersion: 1, changes: { idle_target: 900, lease_seconds: 700, paused: 0 } } });
    await page.getByLabel('Global idle target', { exact: true }).fill('901');
    f.settings = { ...f.settings, version: 3, idle_target: 42 };
    await page.getByRole('button', { name: 'Save global settings' }).click();
    await page.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
    assert.equal(await page.getByLabel('Global idle target', { exact: true }).inputValue(), '901');
    assert.equal(f.writes.at(-1)!.body.expectedVersion, 2);
    await page.getByRole('button', { name: 'Reload latest settings' }).click();
    assert.equal(await page.getByLabel('Global idle target', { exact: true }).inputValue(), '42');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('same-named records reset selection/dialogs and late account writes stay on the confirmed scope/incarnation', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    await page.goto('http://enterprise-console.test/#accounts');
    await page.getByText('old-account', { exact: true }).waitFor();
    await page.getByLabel('Select same-name', { exact: true }).check();
    await page.getByRole('button', { name: 'Details', exact: true }).click(); await page.getByRole('dialog').waitFor();
    await page.evaluate(id => {
      const select = document.querySelector('select[aria-label="Enterprise"]') as HTMLSelectElement;
      select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
    }, B);
    await page.getByText('new-account', { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByLabel('Select same-name', { exact: true }).isChecked(), false);
    await page.getByLabel('Select same-name', { exact: true }).check();
    await page.getByRole('button', { name: 'Reauthorize Copilot', exact: true }).click();
    await page.getByRole('dialog').getByLabel('SSO password', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'Create reauthorization task', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(f.writes.at(-1)!.body.expectedAccountIncarnation, incarnationB);
    assert.equal(f.writes.at(-1)!.path, `/api/console/proxy/profiles/${B}/accounts/same-name/copilot-oauth/reauthorize`);
    await page.getByLabel('Select same-name', { exact: true }).check();
    const pending = f.hold((url, method) => method === 'DELETE' && url.pathname.endsWith('/accounts/same-name'));
    page.once('dialog', async dialog => { assert.match(dialog.message(), new RegExp(B)); await dialog.accept(); });
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click(); await pending.started.promise;
    await page.getByLabel('Enterprise', { exact: true }).selectOption(A); await page.getByText('old-account', { exact: true }).waitFor();
    const readsBefore = f.reads.length; pending.release.resolve(); await pending.finished.promise; await paint(page);
    assert.equal(f.reads.length, readsBefore, 'late mutation cannot refresh newly selected or abandoned scope');
    assert.equal(await page.getByText('Proxy account delete:', { exact: false }).count(), 0);
    assert.deepEqual(f.writes.at(-1), { path: `/api/console/proxy/profiles/${B}/accounts/same-name`, method: 'DELETE', body: { expectedAccountIncarnation: incarnationB } });
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('late enterprise reads cannot overwrite current list and retained stats use server filters/pages', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    const pending = f.hold((url, method) => method === 'GET' && url.pathname === `/api/console/proxy/profiles/${A}/request-stats/page`);
    await page.goto('http://enterprise-console.test/#stats'); await pending.started.promise;
    await page.getByLabel('Enterprise', { exact: true }).selectOption(B); await page.getByText('new-record-page-1', { exact: true }).waitFor();
    pending.release.resolve(); await pending.finished.promise; await paint(page);
    assert.equal(await page.getByText('old-record-page-1', { exact: true }).count(), 0);
    await page.getByText('1,505 matching retained records.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.getByText('new-record-page-2', { exact: true }).waitFor();
    assert.equal(f.reads.at(-1)!.searchParams.get('page'), '2');
    await page.getByLabel('Search request stats').fill('retained-old-account'); await page.getByText('retained-old-account', { exact: true }).waitFor();
    assert.equal(f.reads.at(-1)!.searchParams.get('q'), 'retained-old-account'); assert.equal(f.reads.at(-1)!.searchParams.get('page'), '1');
    assert.match(f.reads.at(-1)!.pathname, new RegExp(B));
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('SSO edits/batches use selected user incarnation and uncertain Login reconciles without nonce retry', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    await page.goto('http://enterprise-console.test/#users'); await page.getByText('old@example.test', { exact: true }).waitFor();
    await page.getByLabel('Enterprise', { exact: true }).selectOption(B); await page.getByText('new@example.test', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(f.writes.at(-1)!.body.expectedUserIncarnation, incarnationB); assert.match(f.writes.at(-1)!.path, new RegExp(B));
    await page.getByLabel('Select same-name', { exact: true }).check();
    await page.getByRole('button', { name: 'Assign seat', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.deepEqual(f.writes.at(-1)!.body.expectedIncarnations, { 'same-name': incarnationB });
    await page.evaluate(() => { window.location.hash = 'tasks'; });
    await page.getByLabel('Select login task uncertain-task', { exact: true }).check();
    assert.equal(await page.getByRole('button', { name: 'Retry failed task', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Reconcile uncertain task', exact: true }).click();
    await page.getByText('Authorization is still uncertain.', { exact: false }).waitFor();
    assert.equal(f.writes.at(-1)!.path, `/api/console/login-service/profiles/${B}/tasks/uncertain-task/reconcile`);
    assert.equal(f.writes.some(item => item.path.endsWith('/retry')), false);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('SSO runtime drafts reset per enterprise while Login settings requests stay global', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    await page.goto('http://enterprise-console.test/#settings');
    await page.getByLabel('Fallback user prefix', { exact: true }).waitFor();
    await page.getByLabel('Fallback user prefix', { exact: true }).fill('abandoned-draft');
    await page.getByLabel('Enterprise', { exact: true }).selectOption(B);
    await page.waitForFunction(() => Array.from(document.querySelectorAll('input')).some(input => input.value === 'new'));
    assert.equal(await page.getByLabel('Fallback user prefix', { exact: true }).inputValue(), 'new');
    assert.equal(f.reads.some(url => url.pathname === `/api/console/sso/profiles/${B}/settings/runtime`), true);
    assert.equal(f.reads.some(url => url.pathname === '/api/console/login-service/settings/runtime'), true);
    assert.equal(f.reads.some(url => /login-service\/profiles\/.*\/settings/.test(url.pathname)), false);
    assert.deepEqual(f.writes, []); assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});

test('missing incarnation and unavailable discovery cannot silently fall back to unsafe writes', { timeout: 120000 }, async () => {
  const f = await offlineEnterprise(); const { page } = f;
  try {
    f.missingIncarnation = true;
    await page.goto('http://enterprise-console.test/#accounts'); await page.getByLabel('Select same-name', { exact: true }).check();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click();
    await page.getByText('Identity incarnation is unavailable.', { exact: false }).waitFor();
    assert.equal(f.writes.length, 0);
    for (const mode of ['unavailable', 'unknown'] as const) {
      f.discoveryMode = mode; await page.reload(); await page.getByRole('alert').waitFor();
      assert.equal(await page.getByLabel('Enterprise', { exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Delete selected', exact: true }).count(), 0);
      assert.equal(f.writes.length, 0);
    }
    f.discoveryMode = 'ok'; f.enabled = false; await page.goto('http://enterprise-console.test/#enterprises'); await page.reload();
    await page.getByRole('heading', { name: 'Pool management is disabled' }).waitFor();
    assert.equal(f.reads.some(url => url.pathname.includes('/management/pool')), false);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.unexpected, []);
  } finally { await f.close(); }
});
