import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const reference = '[ref: 11111111-2222-4333-8444-555555555555]';
const longReason = `HTTP 400: legacy upstream error <img src=x onerror="window.injected=true"> & payload\n${'long legacy detail '.repeat(180)}END`;
const reasons = [longReason, `HTTP 502: upstream unavailable ${reference}`, 'HTTP 400: Bad request', undefined];

for (const clipboard of ['success', 'reject', 'absent'] as const) {
  test(`offline request failure details and ${clipboard} clipboard`, { timeout: 120000 }, async () => {
    const fixture = await offlineStats(clipboard);
    const { page } = fixture;
    try {
      await page.goto('http://request-console.test/#stats', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const row = page.locator('tbody tr').filter({ hasText: 'fixture-0' });
      const summary = row.locator('summary');
      await summary.waitFor();
      assert.equal(await summary.textContent(), longReason, 'collapsed DOM retains the full legacy reason');
      assert.equal(await row.locator('details').getAttribute('open'), null);
      assert.equal(await row.locator('img').count(), 0);
      assert.equal(await page.evaluate('window.injected'), undefined);
      assert.equal(await summary.locator('span').evaluate((element) => getComputedStyle(element).textOverflow), 'ellipsis');
      await summary.focus();
      await page.keyboard.press('Enter');
      await row.locator('details[open]').waitFor();
      assert.equal(await row.locator('pre').textContent(), longReason);
      assert.equal(await row.locator('pre').evaluate((element) => getComputedStyle(element).whiteSpace), 'pre-wrap');
      assert.equal(await row.locator('pre').evaluate((element) => getComputedStyle(element).maxHeight), '256px');
      await page.keyboard.press('Enter');
      await row.locator('details:not([open])').waitFor();
      const copy = row.getByRole('button', { name: 'Copy full failure reason', exact: true });
      assert.equal(await copy.getAttribute('title'), 'Copy full failure reason');
      await copy.focus();
      await page.keyboard.press('Enter');
      if (clipboard === 'success') {
        await row.getByRole('button', { name: 'Copied failure reason', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate('window.copiedReasons'), [longReason]);
        assert.equal(await row.locator('textarea').count(), 0);
        assert.equal(await row.locator('details').getAttribute('open'), null, 'copy does not toggle details');
        await copy.waitFor({ timeout: 4000 });
        assert.equal(await row.getByRole('status').textContent(), '');
      } else {
        const fallback = row.getByRole('textbox', { name: 'Full failure reason for manual copy' });
        await fallback.waitFor();
        assert.equal(await fallback.inputValue(), longReason);
        assert.equal(await fallback.evaluate((element) => (element as HTMLTextAreaElement).readOnly), true);
        assert.equal(await fallback.evaluate((element) => document.activeElement === element && (element as HTMLTextAreaElement).selectionEnd === (element as HTMLTextAreaElement).value.length), true);
        assert.equal(await row.getByRole('status').textContent(), '', 'clipboard failures never claim success');
        assert.equal(await row.getByRole('button', { name: 'Copied failure reason' }).count(), 0);
      }
      const referenced = page.locator('tbody tr').filter({ hasText: 'fixture-1' });
      assert.equal((await referenced.locator('summary').textContent())?.includes(reference), true);
      assert.equal(await referenced.locator('a').count(), 0, 'a log reference is not a diagnostic-file link');
      const legacy = page.locator('tbody tr').filter({ hasText: 'fixture-2' });
      assert.equal(await legacy.locator('summary').textContent(), 'HTTP 400: Bad request');
      const missing = page.locator('tbody tr').filter({ hasText: 'fixture-3' });
      assert.equal(await missing.locator('td:last-child').textContent(), '-');
      assert.equal(await missing.locator('button, details').count(), 0);
      await page.setViewportSize({ width: 375, height: 812 });
      const scroller = page.locator('table').locator('..');
      assert.equal(await scroller.evaluate((element) => getComputedStyle(element).overflowX), 'auto');
      assert.equal(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth), true);
      await copy.scrollIntoViewIfNeeded();
      assert.equal(await scroller.evaluate((element) => element.scrollLeft > 0), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      fixture.fail = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.getByText('Stats unavailable.', { exact: true }).waitFor();
      assert.equal(await row.locator('pre').textContent(), longReason, 'failed refresh does not mutate existing reasons');
      assert.deepEqual(fixture.mutations, []);
      assert.deepEqual(fixture.unexpected, []);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

async function offlineStats(clipboard: 'success' | 'reject' | 'absent') {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(10000);
  // Pure JavaScript avoids transpiler-injected __name references in browser init scripts.
  await page.addInitScript(`
    window.copiedReasons = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: ${clipboard === 'absent' ? 'undefined' : `{ writeText: function(value) { ${clipboard === 'reject' ? 'return Promise.reject(new Error("denied"));' : 'window.copiedReasons.push(value); return Promise.resolve();'} } }`} });
  `);
  const errors: string[] = [];
  const mutations: string[] = [];
  const unexpected: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = { page, errors, mutations, unexpected, fail: false, close: () => browser.close() };
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') { mutations.push(`${request.method()} ${url.pathname}`); return json({}, 405); }
    if (url.origin !== 'http://request-console.test') { unexpected.push(url.href); return json({}, 404); }
    if (url.pathname === '/api/console/setup') return json({ initialized: true });
    if (url.pathname === '/api/console/me') return json({ username: 'offline-admin', role: 'admin' });
    if (url.pathname === '/api/console/login-service/tasks') return json([]);
    if (url.pathname === '/api/console/proxy/accounts' || url.pathname === '/api/console/sso/users') {
      return json({ items: [], total: 0, page: 1, pageSize: 100 });
    }
    if (url.pathname === '/api/console/proxy/request-stats') {
      if (fixture.fail) return json({ error: { code: 'service_proxy_failed', message: 'Stats unavailable.' } }, 502);
      return json(reasons.map((failureReason, index) => ({ id: index + 1, identity: `fixture-${index}`, path: '/v1/chat/completions', model: 'fixture-model', success: false, requestedAt: '2026-09-18T12:00:00Z', inputTokens: 1, outputTokens: 0, failureReason })));
    }
    if (url.pathname === '/' || /^\/assets\/[\w.-]+$/.test(url.pathname)) {
      const file = resolve(process.cwd(), 'dist/web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(file) });
    }
    if (url.pathname !== '/favicon.ico') unexpected.push(url.pathname);
    return route.fulfill({ status: 404, body: '' });
  });
  return fixture;
}
