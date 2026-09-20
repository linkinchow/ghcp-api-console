import { chromium } from 'playwright';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE, SOFT_LIMIT_MS, HARD_LIMIT_MS, allowedBrowserRequest, bounded, deferred, exactRequest, flags, insist, loadFixture, safeError, trustedPath, writeExclusive } from './console-support.mjs';

const SUMMARY = '/api/console/proxy/management/pool/summary';
const SETTINGS = '/api/console/proxy/management/pool/settings';
const DISCOVERY = '/api/console/proxy/management/enterprises';
const policyPath = id => `/api/console/proxy/profiles/${id}/pool-policy`;
const usersPath = id => `/api/console/sso/profiles/${id}/users`;
const capInput = page => page.getByLabel('Enterprise maximum accounts', { exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const scope = page => page.getByLabel('Enterprise', { exact: true });
const toastSelector = 'div.fixed.bottom-4.right-4';
const STALE_USER = 'SSO user changed or was recreated; stale operation was not applied.';

export async function runConsoleBrowser({ stateFile, output }) {
  const { state, username } = loadFixture(stateFile, output);
  insist(realpathSync('/results') === '/results', 'results_root');
  const privateDir = '/results/private', artifactDir = join(privateDir, `${basename(output, '.json')}-screenshots`);
  trustedPath(artifactDir, '/results');
  if (!existsSync(privateDir)) mkdirSync(privateDir, { mode: 0o700 });
  insist(!existsSync(artifactDir), 'fresh_artifacts'); mkdirSync(artifactDir, { mode: 0o700 });
  const origin = state.origins.console, [A, B] = state.enterpriseIds;
  const started = Date.now(), assertions = [], cases = [], holds = [], requests = [], pendingRoutes = new Set(), contexts = [], screenshots = [];
  let browser, stage = 'launch', timeout = false, closing = false, blockedRequests = 0, pageErrors = 0, routeErrors = 0, browserVersion, providerBefore, loginPosts = 0;
  const hardTimer = setTimeout(() => {
    timeout = true;
    const report = result('FAIL', 'phase7_console_hard_deadline');
    if (!existsSync(output)) writeExclusive(output, JSON.stringify(report, null, 2) + '\n');
    process.exit(1); // Last-resort bound includes a wedged browser shutdown.
  }, HARD_LIMIT_MS);
  const softTimer = setTimeout(() => { timeout = true; for (const h of holds) h.release.resolve(); void browser?.close().catch(() => {}); }, SOFT_LIMIT_MS);
  function check(value, code) { insist(!timeout && Date.now() - started < SOFT_LIMIT_MS, 'deadline'); insist(value, code); assertions.push({ case: stage, code }); }
  function result(status, error) {
    return { status, qualification: 'real Chromium / Console UI and API / synthetic internal fixture only; no real provider acceptance', group: 'C', runId: state.runId,
      mode: 'two-admin-synthetic-writes', source: { baseline: BASELINE, current: state.source.head, dirty: state.source.dirty === true, bundleSha256: state.source.bundleSha256 },
      durationMs: Date.now() - started, browserVersion, completedAssertions: assertions.length, assertions, cases, ...(error ? { stage, error } : {}),
      loginPosts, businessWrites: requests.filter(r => !['GET', 'POST_LOGIN', 'POST_LOGOUT'].includes(r.kind)).length,
      blockedRequests, pageErrors, routeErrors, expectedApiStatuses: [200, 201, 204, 400, 401, 403, 409], httpStatusCounts: requests.reduce((out, r) => { if (r.status) out[r.status] = (out[r.status] ?? 0) + 1; return out; }, {}),
      completedBusinessResponses: requests.filter(r => r.kind === 'WRITE' && r.status).length,
      screenshots, screenshotDirectory: `private/${basename(artifactDir)}`, limits: { softMs: SOFT_LIMIT_MS, hardMs: HARD_LIMIT_MS },
      cleanup: 'No rollback or fixture destruction. Leave synthetic evidence in dedicated fixture; pool remains paused at target 0; main owns teardown.' };
  }
  async function runCase(name, operation) {
    stage = name; const start = Date.now(), count = assertions.length;
    try { const evidence = await operation(); cases.push({ name, status: 'PASS', durationMs: Date.now() - start, assertions: assertions.length - count, ...evidence }); }
    catch (error) { cases.push({ name, status: 'FAIL', durationMs: Date.now() - start, completedAssertions: assertions.length - count, error: safeError(error) }); throw error; }
  }
  function expectedResponse(page, path, method = 'GET', query = null) {
    const pending = page.waitForResponse(response => { const u = new URL(response.url()); return u.origin === origin && u.pathname === path && (query === null || u.search === query) && response.request().method() === method; }, { timeout: 8000 });
    pending.catch(() => {}); // An earlier failed assertion still owns reporting.
    return pending;
  }
  async function responseData(response, status = 200, code) {
    check(response.status() === status, `http_${status}`); if (status === 204) return undefined; const data = await response.json();
    if (code) check(data.error?.code === code, code);
    return data;
  }
  async function paint(page) { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))); }
  async function screenshot(page, name) {
    // No authentication forms, HAR, trace, console bodies or credential dumps.
    check(await page.getByPlaceholder('Password', { exact: true }).count() === 0 && await page.locator('input[type=password]').count() === 0, 'screenshot_no_password_form');
    writeExclusive(join(artifactDir, `${name}.png`), await page.screenshot({ fullPage: true, timeout: 5000 })); screenshots.push(`${name}.png`);
  }
  function hold(page, method, path, body) {
    insist(!path.includes('?'), 'hold_path');
    const h = { page, method, path, body, claimed: false, reached: deferred(), release: deferred(), finished: deferred(), terminal: deferred() };
    holds.push(h); return h;
  }
  async function held(h) { await bounded(h.reached.promise, 8000, 'barrier_not_reached'); check(h.claimed, 'exact_barrier_reached'); }
  async function release(h) { h.release.resolve(); await bounded(h.finished.promise, 8000, 'barrier_continue'); }
  async function terminal(h) { return bounded(h.terminal.promise, 8000, 'barrier_terminal'); }
  async function install(context) {
    // Every allowed response is the actual server response. Never fulfill/fetch a
    // business response; exact request barriers merely delay route.continue().
    await context.route('**/*', async route => {
      const task = deferred(); pendingRoutes.add(task.promise);
      let entry, h;
      try {
        const req = route.request(), u = new URL(req.url());
        let body; if (req.postData()) { try { body = req.postDataJSON(); } catch { blockedRequests++; await route.abort(); return; } }
        if (!allowedBrowserRequest(state, username, u, req.method(), body) || requests.length >= 350 || timeout) { blockedRequests++; await route.abort(); return; }
        const kind = req.method() === 'GET' ? 'GET' : u.pathname === '/api/console/login' ? 'POST_LOGIN' : u.pathname === '/api/console/logout' ? 'POST_LOGOUT' : 'WRITE';
        if (kind === 'POST_LOGIN') loginPosts++;
        entry = { request: req, page: req.frame().page(), path: u.pathname, method: req.method(), kind }; requests.push(entry);
        h = holds.find(item => !item.claimed && item.page === entry.page && exactRequest(req, origin, item.method, item.path, item.body));
        if (h) { h.claimed = true; h.request = req; h.reached.resolve(); await h.release.promise; }
        if (closing || timeout) { await route.abort(); return; }
        await route.continue();
      } catch {
        // Aborted, scope-owned reads may be cancelled while paused. Mutation
        // failures are never excused as scope cancellation.
        let expectedCancellation = false;
        if (h?.method === 'GET') {
          const end = await bounded(h.terminal.promise, 1000, 'cancelled_route_terminal').catch(() => undefined);
          expectedCancellation = end?.type === 'cancelled' && end.aborted === true;
        }
        if (!expectedCancellation && !timeout) routeErrors++;
      } finally { h?.finished.resolve(); task.resolve(); pendingRoutes.delete(task.promise); }
    });
    insist(typeof context.routeWebSocket === 'function', 'websocket_interception_required');
    await context.routeWebSocket('**/*', socket => { blockedRequests++; socket.close(); });
    context.on('page', page => {
      page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
      page.on('pageerror', () => { pageErrors++; });
      page.on('response', response => { const entry = requests.find(r => r.request === response.request()); if (entry) entry.status = response.status(); const h = holds.find(x => x.request === response.request()); h?.terminal.resolve({ type: 'response', response }); });
      page.on('requestfailed', request => { const entry = requests.find(r => r.request === request); if (entry) entry.cancelled = request.failure()?.errorText?.includes('ERR_ABORTED') === true; const h = holds.find(x => x.request === request); h?.terminal.resolve({ type: 'cancelled', aborted: request.failure()?.errorText?.includes('ERR_ABORTED') === true }); });
    });
  }
  async function login(page) {
    await page.goto(`${origin}/#enterprise-policy`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Admin Login', { exact: true }).waitFor();
    await page.getByPlaceholder('Username', { exact: true }).fill(state.credentials.consoleUsername);
    await page.getByPlaceholder('Password', { exact: true }).fill(state.credentials.consolePassword);
    const signed = expectedResponse(page, '/api/console/login', 'POST'), found = expectedResponse(page, DISCOVERY), p = expectedResponse(page, policyPath(A));
    await button(page, 'Sign in').click(); await responseData(await signed);
    const discovery = await responseData(await found); await responseData(await p); await capInput(page).waitFor(); await paint(page);
    check(discovery.enabled === true && discovery.enterprises.length === 2 && state.enterpriseIds.every(id => discovery.enterprises.some(e => e.enterpriseId === id)), 'discovery_exact_fixture');
  }
  async function uiRead(page, id, kind = 'enterprise-policy') {
    const path = kind === 'enterprise-policy' ? policyPath(id) : usersPath(id), hash = await page.evaluate(() => window.location.hash.slice(1));
    if (await scope(page).inputValue() !== id) {
      // Navigate first so changing the scope never accidentally invokes another page.
      if (hash !== kind) { const read = expectedResponse(page, kind === 'enterprise-policy' ? policyPath(await scope(page).inputValue()) : usersPath(await scope(page).inputValue())); await page.evaluate(value => { location.hash = value; }, kind); await responseData(await read); }
      const read = expectedResponse(page, path); await scope(page).selectOption(id); const data = await responseData(await read); await ready(page, kind); return data;
    }
    const read = expectedResponse(page, path);
    if (hash !== kind) await page.evaluate(value => { location.hash = value; }, kind);
    else await button(page, kind === 'enterprise-policy' ? 'Refresh policy' : 'Search').click();
    const data = await responseData(await read); await ready(page, kind); return data;
  }
  async function ready(page, kind) {
    if (kind === 'enterprise-policy') { await capInput(page).waitFor(); await page.waitForFunction(() => !document.querySelector('input[aria-label="Enterprise maximum accounts"]')?.disabled); }
    else { await page.getByText('Loading users...', { exact: true }).waitFor({ state: 'hidden' }); await button(page, 'Create user').waitFor(); }
    await paint(page);
  }
  async function uiCap(page, id, value) {
    await uiRead(page, id); await capInput(page).fill(String(value));
    const response = expectedResponse(page, policyPath(id), 'PATCH'); await button(page, 'Save enterprise cap').click();
    const data = await responseData(await response); await page.waitForFunction(value => document.querySelector('input[aria-label="Enterprise maximum accounts"]')?.value === value && !document.querySelector('input[aria-label="Enterprise maximum accounts"]')?.disabled, String(value)); return data;
  }
  async function call(page, path, method = 'GET', body) {
    check(allowedBrowserRequest(state, username, new URL(path, origin), method, body), 'explicit_browser_api_allowlist');
    return page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(path, { method, redirect: 'error', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000) });
      return { status: response.status, data: await response.json() };
    }, { path, method, body });
  }
  async function get(page, path) { const r = await call(page, path); check(r.status === 200, 'read_actual_api_200'); return r.data; }
  async function providerSnapshot() {
    // Node-only, exact allowlisted internal endpoint. Fixture token never enters
    // browser state, request records, screenshots or reports.
    const url = new URL('/fixture/snapshot', state.origins.provider); insist(url.origin === state.origins.provider, 'provider_origin');
    const response = await fetch(url, { headers: { authorization: `Bearer ${state.credentials.fixtureToken}` }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    check(response.status === 200, 'provider_snapshot_200'); return response.json();
  }
  async function settingsPage(page) { const p = expectedResponse(page, SUMMARY); if (await page.evaluate(() => location.hash) === '#enterprises') await button(page, 'Refresh global pool').click(); else await page.evaluate(() => { location.hash = 'enterprises'; }); const summary = await responseData(await p); await page.getByLabel('Global lease TTL (seconds)', { exact: true }).waitFor(); await paint(page);     check(summary?.settings?.paused === 1 && summary.settings.idle_target === 0, 'settings_view_preserves_pause_zero');
    return summary;
  }
  async function inspectMe(page) { const me = await get(page, '/api/console/me'); check(me.username === state.credentials.consoleUsername && me.role === 'admin', 'same_global_admin'); }
  async function beginToastAudit(page) { await page.evaluate(selector => { window.__phase7ToastAudit?.observer.disconnect(); const texts = []; const observer = new MutationObserver(() => { const t = document.querySelector(selector)?.textContent; if (t) texts.push(t); }); observer.observe(document.body, { subtree: true, childList: true, characterData: true }); window.__phase7ToastAudit = { texts, observer }; }, toastSelector); }
  async function noToast(page) { await paint(page); check(await page.locator(toastSelector).count() === 0, 'no_current_scope_toast'); check(await page.evaluate(() => window.__phase7ToastAudit.texts.length) === 0, 'no_transient_stale_notification'); }
  function reads(page) { return requests.filter(r => r.page === page && r.kind === 'GET' && r.path.startsWith('/api/console/')).length; }
  async function safeUsers(page, id) { const list = await get(page, usersPath(id)); check(list.items.length === list.total && list.items.every(u => u.ssoUser === username && !u.ghLogin && !u.ghScimId && u.emuStatus === 'not_synced'), 'local_unprovisioned_sso_only'); return list; }
  const createBody = email => ({ ssoUser: username, password: state.credentials.defaultPassword, email: `${email}@phase7.invalid`, role: 'user' });
  async function createUser(page, id, email) { const r = await call(page, usersPath(id), 'POST', createBody(email)); check(r.status === 201, 'create_sso_201'); check(r.data.enterpriseId === id && r.data.ssoUser === username && Boolean(r.data.userIncarnation), 'created_user_identity'); return r.data; }
  async function deleteUser(page, id, incarnation) {
    await safeUsers(page, id); const r = await call(page, `${usersPath(id)}/batch`, 'POST', { operation: 'delete_sso', ssoUsers: [username], expectedIncarnations: { [username]: incarnation } });
    check(r.status === 200 && r.data.summary.success === 1 && r.data.summary.failed === 0, 'delete_local_sso_success');
    check((await safeUsers(page, id)).total === 0, 'deleted_user_absent');
  }
  try {
    browser = await chromium.launch({ headless: true, timeout: 15000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] }); browserVersion = browser.version();
    for (let i = 0; i < 2; i++) { const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: false }); contexts.push(c); await install(c); }
    const [one, two] = await Promise.all(contexts.map(c => c.newPage()));
    await runCase('real_login_and_fresh_paused_fixture', async () => {
      await Promise.all([login(one), login(two)]); await inspectMe(one); await inspectMe(two);
      check(contexts[0] !== contexts[1], 'two_independent_browser_contexts');
      const summary = await get(one, SUMMARY);
      check(summary.settings.paused === 1 && summary.settings.idle_target === 0 && summary.settings.max_accounts === 12 && summary.names.nextOrdinal === 0, 'paused_zero_target_fresh_caps');
      check(summary.enterprises.every(e => e.state === 'draft' && e.maxAccounts === 6 && e.counts.total === 0), 'draft_empty_inventory');
      for (const id of state.enterpriseIds) {
        check((await safeUsers(one, id)).total === 0, 'fresh_sso_no_existing_user');
        const accounts = await get(one, `/api/console/proxy/profiles/${id}/accounts`), tasks = await get(one, `/api/console/login-service/profiles/${id}/tasks?page=1&pageSize=25`);
        check(accounts.total === 0 && tasks.total === 0, 'real_proxy_login_apis_empty');
      }
      providerBefore = await providerSnapshot();
      check(providerBefore.enterprises.every(e => e.scimUsers === 0 && e.seats === 0 && e.issuedTokens === 0 && Object.keys(e.counts).length === 0 && e.calls.length === 0), 'fresh_synthetic_provider_empty');
      return { contexts: 2, sameGlobalAdmin: true, freshDrafts: true, paused: 1, idleTarget: 0 };
    });
    await runCase('same_enterprise_cap_cas_409', async () => {
      const old = await uiRead(one, A); await uiRead(two, A);
      await capInput(one).fill('7'); await capInput(two).fill('8');
      const h1 = hold(one, 'PATCH', policyPath(A), { expectedVersion: old.policyVersion, maxAccounts: 7 });
      const h2 = hold(two, 'PATCH', policyPath(A), { expectedVersion: old.policyVersion, maxAccounts: 8 });
      await Promise.all([button(one, 'Save enterprise cap').click(), button(two, 'Save enterprise cap').click()]); await Promise.all([held(h1), held(h2)]);
      // Both browsers have submitted the same version before either reaches API.
      await Promise.all([release(h1), release(h2)]); const terminals = await Promise.all([terminal(h1), terminal(h2)]);
      check(terminals.every(t => t.type === 'response'), 'both_cas_reached_real_server');
      const rs = terminals.map(t => t.response); check(rs.map(r => r.status()).sort().join(',') === '200,409', 'one_winner_one_actual_409');
      const loser = rs[0].status() === 409 ? one : two, winnerIndex = rs[0].status() === 200 ? 0 : 1;
      await responseData(rs[1 - winnerIndex], 409, 'policy_version_conflict');
      await loser.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
      check(await capInput(loser).inputValue() === (loser === one ? '7' : '8') && await button(loser, 'Save enterprise cap').isDisabled(), 'loser_preserves_draft_requires_reload');
      const current = await get(one, policyPath(A)); check(current.policyVersion === old.policyVersion + 1 && current.maxAccounts === (winnerIndex === 0 ? 7 : 8), 'cas_one_version_increment');
      await button(loser, 'Reload latest policy').click(); check(await capInput(loser).inputValue() === String(current.maxAccounts), 'explicit_reload_latest');
      check(requests.filter(r => r.kind === 'WRITE' && r.path === policyPath(A)).length === 2, 'cas_no_automatic_retry');
      await screenshot(loser, 'cap-cas-conflict-reloaded'); return { statuses: [200, 409], conflictCode: 'policy_version_conflict' };
    });
    await runCase('different_enterprise_global_capacity_serialization', async () => {
      await uiCap(one, A, 4999); await uiCap(two, B, 4999);
      const a = await uiRead(one, A), b = await uiRead(two, B);
      await capInput(one).fill('5001'); await capInput(two).fill('5001');
      const h1 = hold(one, 'PATCH', policyPath(A), { expectedVersion: a.policyVersion, maxAccounts: 5001 });
      const h2 = hold(two, 'PATCH', policyPath(B), { expectedVersion: b.policyVersion, maxAccounts: 5001 });
      await Promise.all([button(one, 'Save enterprise cap').click(), button(two, 'Save enterprise cap').click()]); await Promise.all([held(h1), held(h2)]);
      await Promise.all([release(h1), release(h2)]); const ts = await Promise.all([terminal(h1), terminal(h2)]);
      check(ts.every(t => t.type === 'response'), 'both_enterprise_writes_actual'); const responses = ts.map(t => t.response);
      check(responses.map(r => r.status()).sort().join(',') === '200,400', 'cap_sum_one_winner_one_400');
      const rejected = responses.find(r => r.status() === 400); await responseData(rejected, 400, 'invalid_enterprise_policy');
      const actual = await Promise.all([get(one, policyPath(A)), get(two, policyPath(B))]);
      check(actual[0].maxAccounts + actual[1].maxAccounts === 10000 && actual.map(p => p.maxAccounts).sort().join(',') === '4999,5001', 'global_cap_never_exceeds_10000');
      check(actual.reduce((n, p, i) => n + p.policyVersion - [a, b][i].policyVersion, 0) === 1, 'rejected_cap_no_version_change');
      const summary = await get(one, SUMMARY); check(summary.settings.max_accounts === 10000 && summary.settings.paused === 1 && summary.settings.idle_target === 0, 'derived_cap_and_pause_authoritative');
      // Decrease first so reset itself cannot cross the global limit.
      await uiCap(one, A, 6); await uiCap(two, B, 6); return { startingSum: 9998, requestedSum: 10002, actualSum: 10000, statuses: [200, 400], rejectionCode: 'invalid_enterprise_policy' };
    });
    await runCase('global_settings_cas_keeps_pool_paused', async () => {
      const s1 = await settingsPage(one), s2 = await settingsPage(two); check(s1.settings.version === s2.settings.version, 'shared_settings_snapshot');
      await one.getByLabel('Global lease TTL (seconds)', { exact: true }).fill('121'); await two.getByLabel('Global lease TTL (seconds)', { exact: true }).fill('122');
      const body = ttl => ({ expectedVersion: s1.settings.version, changes: { idle_target: 0, lease_seconds: ttl, paused: 1 } });
      const h1 = hold(one, 'PATCH', SETTINGS, body(121)), h2 = hold(two, 'PATCH', SETTINGS, body(122));
      await Promise.all([button(one, 'Save global settings').click(), button(two, 'Save global settings').click()]); await Promise.all([held(h1), held(h2)]);
      await Promise.all([release(h1), release(h2)]); const ts = await Promise.all([terminal(h1), terminal(h2)]);
      check(ts.every(t => t.type === 'response') && ts.map(t => t.response.status()).sort().join(',') === '200,409', 'settings_actual_cas_409');
      const loser = ts[0].response.status() === 409 ? one : two;
      await responseData(ts.find(t => t.response.status() === 409).response, 409, 'settings_version_conflict');
      await loser.getByRole('alert').filter({ hasText: 'Your draft was not saved' }).waitFor();
      check(await button(loser, 'Save global settings').isDisabled(), 'stale_global_settings_disabled');
      const now = await get(one, SETTINGS); check(now.version === s1.settings.version + 1 && now.paused === 1 && now.idle_target === 0, 'settings_one_increment_safe_target');
      return { statuses: [200, 409], paused: 1, idleTarget: 0 };
    });
    await runCase('aba_scope_deferred_write_natural_response', async () => {
      const old = await uiRead(one, A); await capInput(one).fill('7');
      const h = hold(one, 'PATCH', policyPath(A), { expectedVersion: old.policyVersion, maxAccounts: 7 });
      await button(one, 'Save enterprise cap').click(); await held(h);
      const b = await uiRead(one, B); check(await capInput(one).inputValue() === String(b.maxAccounts), 'b_scope_not_replaced_by_a_draft');
      const a = await uiRead(one, A); check(a.maxAccounts === 6, 'aba_new_mount_prewrite_snapshot');
      await capInput(one).fill('9'); await beginToastAudit(one); const beforeReads = reads(one);
      await release(h); const t = await terminal(h); check(t.type === 'response', 'late_write_real_response'); await responseData(t.response); await noToast(one);
      check(await scope(one).inputValue() === A && await capInput(one).inputValue() === '9', 'old_a_write_cannot_replace_new_a_draft');
      check(reads(one) === beforeReads, 'late_write_no_current_scope_reload');
      const actual = await get(two, policyPath(A)); check(actual.maxAccounts === 7 && actual.policyVersion === old.policyVersion + 1, 'late_write_committed_original_scope_only');
      check((await get(two, policyPath(B))).maxAccounts === b.maxAccounts, 'late_write_b_unchanged');
      await screenshot(one, 'aba-deferred-write-current-draft'); return { pathScope: 'A', navigation: ['A', 'B', 'A'], actualStatus: 200, currentDraftRetained: true, staleNotifications: 0 };
    });
    await runCase('aba_scope_deferred_read_cancellation', async () => {
      await uiRead(one, A); await button(one, 'Reload latest policy').click();
      const h = hold(one, 'GET', policyPath(A)); await button(one, 'Refresh policy').click(); await held(h);
      await uiRead(one, B); const current = await uiRead(one, A); await capInput(one).fill('10'); await beginToastAudit(one); const beforeReads = reads(one);
      await release(h); const t = await terminal(h); await noToast(one);
      // React aborts scoped reads on unmount. Do not call a cancelled request an
      // executed HTTP response; the evidence records the actual disposition.
      if (t.type === 'cancelled') check(t.aborted === true, 'abandoned_read_browser_aborted');
      else await responseData(t.response);
      check(await scope(one).inputValue() === A && await capInput(one).inputValue() === '10', 'late_read_cannot_replace_current_aba_draft');
      check(reads(one) === beforeReads, 'abandoned_read_no_reload');
      return { navigation: ['A', 'B', 'A'], currentVersion: current.policyVersion, disposition: t.type === 'response' ? `actual-http-${t.response.status()}` : 'browser-ERR_ABORTED', fabricatedResponses: 0 };
    });
    await runCase('sso_same_name_recreation_stale_edit_409', async () => {
      const original = await createUser(two, A, 'a-original'); const b = await createUser(two, B, 'b-original');
      check(original.userIncarnation !== b.userIncarnation, 'same_name_cross_enterprise_unique_incarnation');
      await uiRead(one, A, 'users'); const row = one.locator('tbody tr').filter({ has: one.getByText(username, { exact: true }) });
      await row.getByRole('button', { name: 'Edit', exact: true }).click(); await one.getByRole('dialog').getByLabel('Email', { exact: true }).fill('stale-edit@phase7.invalid');
      await deleteUser(two, A, original.userIncarnation); const replacement = await createUser(two, A, 'a-replacement');
      check(replacement.userIncarnation !== original.userIncarnation, 'recreated_user_new_incarnation');
      const r = expectedResponse(one, `${usersPath(A)}/${username}`, 'PATCH'); await button(one, 'Save changes').click(); const response = await r;
      await responseData(response, 409, 'user_incarnation_conflict');
      check(response.request().postDataJSON().expectedUserIncarnation === original.userIncarnation, 'stale_dialog_original_incarnation');
      await one.getByRole('dialog').getByText(STALE_USER, { exact: true }).waitFor();
      const actual = (await safeUsers(two, A)).items[0]; check(actual.userIncarnation === replacement.userIncarnation && actual.email === 'a-replacement@phase7.invalid', 'replacement_unchanged_after_stale_edit');
      check((await safeUsers(two, B)).items[0].userIncarnation === b.userIncarnation, 'same_name_b_untouched');
      await button(one.getByRole('dialog'), 'Cancel').click();
      return { actualStatus: 409, errorCode: 'user_incarnation_conflict', replacementRetained: true };
    });
    await runCase('sso_stale_delete_confirmation_incarnation_refusal', async () => {
      await uiRead(one, A, 'users'); const original = (await safeUsers(two, A)).items[0];
      await one.getByLabel(`Select ${username}`, { exact: true }).check();
      const gotDialog = deferred(); one.once('dialog', dialog => gotDialog.resolve(dialog));
      const clicking = button(one, 'Delete Users').click(); clicking.catch(() => {});
      const dialog = await bounded(gotDialog.promise, 8000, 'delete_confirmation');
      check(dialog.type() === 'confirm' && dialog.message().includes(A), 'native_delete_confirmation_bound_to_a');
      await deleteUser(two, A, original.userIncarnation); const replacement = await createUser(two, A, 'a-after-confirm');
      const response = expectedResponse(one, `${usersPath(A)}/batch`, 'POST'); await dialog.accept(); await clicking;
      const actualResponse = await response, batch = await responseData(actualResponse);
      check(actualResponse.request().postDataJSON().expectedIncarnations[username] === original.userIncarnation, 'confirmation_retains_original_incarnation');
      check(batch.summary.success === 0 && batch.summary.failed === 1 && batch.rows[0].detail === STALE_USER, 'stale_delete_failed_row_not_http_409');
      const actual = (await safeUsers(two, A)).items[0]; check(actual.userIncarnation === replacement.userIncarnation && actual.email === 'a-after-confirm@phase7.invalid', 'replacement_survives_stale_delete');
      await one.getByRole('dialog').filter({ hasText: 'Delete SSO users' }).waitFor(); await screenshot(one, 'stale-delete-confirmation-refused'); await button(one.getByRole('dialog'), 'Close').click();
      await uiRead(one, B, 'users'); check(await one.getByLabel(`Select ${username}`, { exact: true }).isChecked() === false && await one.getByRole('dialog').count() === 0, 'scope_switch_clears_sso_selection_and_dialog');
      await uiRead(one, A, 'users'); check(await one.getByLabel(`Select ${username}`, { exact: true }).isChecked() === false, 'aba_sso_selection_not_resurrected');
      return { actualStatus: 200, failedRows: 1, expectedIncarnationRefused: true, replacementRetained: true };
    });
    await runCase('same_origin_guard_real_server_before_mutation', async () => {
      const old = await get(two, policyPath(B));
      const payload = { expectedVersion: old.policyVersion, maxAccounts: old.maxAccounts + 1 };
      const headersCases = [{}, { Origin: state.origins.sso, 'Sec-Fetch-Site': 'cross-site' }, { Origin: state.origins.sso, 'Sec-Fetch-Site': 'same-origin' }, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }];
      for (const headers of headersCases) {
        // APIRequestContext shares the real browser session; redirects disabled,
        // exact same Console destination; only Origin/Fetch Metadata vary.
        const url = new URL(policyPath(B), origin); check(url.origin === state.origins.console && allowedBrowserRequest(state, username, url, 'PATCH', payload), 'guard_probe_exact_allowlist');
        const response = await contexts[1].request.patch(url.href, { data: payload, headers, maxRedirects: 0, timeout: 8000 });
        requests.push({ kind: 'WRITE', path: policyPath(B), method: 'PATCH', status: response.status() });
        check(response.status() === 403 && (await response.json()).error?.code === 'console_same_origin_required', 'actual_same_origin_403');
        await response.dispose();
      }
      const after = await get(two, policyPath(B)); check(after.policyVersion === old.policyVersion && after.maxAccounts === old.maxAccounts, 'guard_rejections_no_mutation');
      return { actualStatuses: [403, 403, 403, 403], externalDestinations: 0, unchangedVersion: true };
    });
    await runCase('logout_and_cookie_expiry_before_mutations', async () => {
      // An already-rendered draft in a second tab of the same context must not
      // mutate after logout; the other admin context remains signed in.
      await uiRead(one, A); await capInput(one).fill('8');
      const before = await get(two, policyPath(A)); const logoutTab = await contexts[0].newPage();
      await logoutTab.goto(`${origin}/#enterprise-policy`, { waitUntil: 'domcontentloaded' }); await capInput(logoutTab).waitFor();
      const logout = expectedResponse(logoutTab, '/api/console/logout', 'POST'); await button(logoutTab, 'Logout').click(); await responseData(await logout, 204); await logoutTab.getByText('Admin Login', { exact: true }).waitFor();
      const staleWrite = expectedResponse(one, policyPath(A), 'PATCH'); await button(one, 'Save enterprise cap').click(); await responseData(await staleWrite, 401, 'not_authenticated');
      await one.getByRole('alert').filter({ hasText: 'Console login is required.' }).waitFor();
      check((await get(two, policyPath(A))).policyVersion === before.policyVersion, 'logout_stale_tab_no_mutation'); await inspectMe(two);
      // Production sessions last eight hours. Expire this browser's real cookie
      // locally, not server time and not a forged auth response. No 8h TTL claim.
      await uiRead(two, B); await capInput(two).fill('8'); const oldB = await get(two, policyPath(B));
      const cookies = (await contexts[1].cookies(origin)).filter(c => ['console_session', 'console_session.sig'].includes(c.name)); check(cookies.length === 2, 'signed_session_cookie_pair_present');
      await contexts[1].addCookies(cookies.map(c => ({ ...c, expires: Math.floor(Date.now() / 1000) - 60 })));
      check((await contexts[1].cookies(origin)).every(c => !['console_session', 'console_session.sig'].includes(c.name)), 'session_cookies_expired_in_browser');
      const expiredWrite = expectedResponse(two, policyPath(B), 'PATCH'); await button(two, 'Save enterprise cap').click(); await responseData(await expiredWrite, 401, 'not_authenticated');
      await two.getByRole('alert').filter({ hasText: 'Console login is required.' }).waitFor();
      await one.reload({ waitUntil: 'domcontentloaded' }); await login(one); check((await get(one, policyPath(B))).policyVersion === oldB.policyVersion, 'expired_cookie_no_mutation');
      return { actualStatuses: [401, 401], logoutViaRealEndpoint: true, expiration: 'browser cookie expiry; not server 8-hour TTL time travel', otherContextUnaffectedByLogout: true };
    });
    await runCase('final_safety_and_side_effect_audit', async () => {
      const summary = await get(one, SUMMARY);
      check(summary.settings.paused === 1 && summary.settings.idle_target === 0 && summary.names.nextOrdinal === 0, 'pool_still_paused_zero_target_no_name_consumption');
      check(summary.enterprises.every(e => e.state === 'draft' && e.counts.total === 0), 'no_activation_or_inventory_created');
      const providerAfter = await providerSnapshot();
      for (const before of providerBefore.enterprises) {
        const after = providerAfter.enterprises.find(e => e.enterpriseId === before.enterpriseId), expectedReads = before.enterpriseId === A ? 2 : 0;
        check(Boolean(after), 'provider_enterprise_preserved');
        check(after.scimUsers === 0 && after.seats === 0 && after.issuedTokens === 0 && JSON.stringify(after.subjects) === JSON.stringify(before.subjects), 'provider_subjects_seats_tokens_unchanged');
        check(Object.entries(after.counts).every(([key, value]) => key === 'scim-read' && value === expectedReads) && (after.counts['scim-read'] ?? 0) === expectedReads, 'only_two_internal_synthetic_scim_lookups');
        check(after.calls.length === expectedReads && after.calls.every(c => c.operation === 'scim-read' && c.subject === null && c.marker === null), 'no_provider_mutations_authorize_or_inference');
        check(JSON.stringify(after.members) === JSON.stringify(before.members) && JSON.stringify(after.markers) === JSON.stringify(before.markers) && JSON.stringify(after.faults) === JSON.stringify(before.faults), 'provider_other_state_unchanged');
      }
      for (const id of state.enterpriseIds) { await safeUsers(one, id); check((await get(one, `/api/console/login-service/profiles/${id}/tasks?page=1&pageSize=25`)).total === 0, 'no_login_task_created'); }
      await bounded(Promise.all([...pendingRoutes]), 2000, 'routes_not_settled');
      check(holds.every(h => h.claimed), 'all_exact_barriers_exercised'); check(blockedRequests === 0, 'no_forbidden_browser_traffic'); check(pageErrors === 0 && routeErrors === 0, 'no_page_or_route_errors');
      check(requests.filter(r => r.path.startsWith('/api/console/') && r.status).every(r => [200, 201, 204, 400, 401, 403, 409].includes(r.status)), 'no_unexpected_api_status');
      check(requests.every(r => r.status || r.cancelled || !r.path.startsWith('/api/console/')), 'api_requests_have_actual_terminal_evidence');
      await screenshot(one, 'final-paused-fixture'); return { businessWritesAuthorized: true, target: 0, paused: 1, syntheticScimReads: 2, providerMutations: 0, realExternalTraffic: 0 };
    });
    const report = result('PASS'); writeExclusive(output, JSON.stringify(report, null, 2) + '\n'); return report;
  } catch (error) {
    // Retain private call frames for main's diagnosis, not arbitrary error text,
    // request/response bodies or Playwright call logs (which can contain inputs).
    const frames = error instanceof Error ? (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 30) : [];
    const failure = { stage, error: timeout ? 'phase7_console_deadline' : safeError(error), stackFrames: frames };
    writeExclusive(join(artifactDir, 'failure-private.json'), JSON.stringify(failure, null, 2) + '\n');
    const report = result('FAIL', failure.error); if (!existsSync(output)) writeExclusive(output, JSON.stringify(report, null, 2) + '\n'); return report;
  } finally {
    closing = true; clearTimeout(softTimer); for (const h of holds) h.release.resolve();
    await bounded(Promise.all(contexts.map(c => c.close().catch(() => {}))), 5000, 'context_close').catch(() => {});
    await bounded(browser?.close().catch(() => {}), 5000, 'browser_close').catch(() => {}); clearTimeout(hardTimer);
  }
}
async function main() {
  const report = await runConsoleBrowser(flags(process.argv.slice(2)));
  process.stdout.write(JSON.stringify({ status: report.status, runId: report.runId, mode: report.mode, durationMs: report.durationMs, completedAssertions: report.completedAssertions, cases: report.cases.map(c => ({ name: c.name, status: c.status })), ...(report.error ? { stage: report.stage, error: report.error } : {}) }) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(JSON.stringify({ status: 'FAIL', error: safeError(error) }) + '\n'); process.exitCode = 1; });
