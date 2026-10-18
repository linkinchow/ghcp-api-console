import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium, type Page, type Route } from 'playwright';
import type { AdminModelsResponse } from '@ghcp/shared';

const ORIGIN = 'http://models-console.test';
const MODELS_PATH = /^\/api\/console\/proxy\/enterprises\/(default|ghe-tenant)\/models$/;
const FETCHED_AT = '2026-10-17T08:00:00.000Z';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function catalog(adminLogin = 'example_admin'): AdminModelsResponse {
  return {
    adminLogin,
    fetchedAt: FETCHED_AT,
    cacheStatus: 'cached',
    defaultView: 'messages',
    models: [
      { id: 'synthetic-chat', upstreamId: 'synthetic-chat-upstream', name: 'Synthetic chat model', supportedPaths: ['/chat/completions'],
        details: { family: 'synthetic', nested: { safe: true }, description: '<img src=x onerror=alert(1)>' } },
      { id: 'synthetic-messages', upstreamId: 'synthetic-messages-upstream', supportedPaths: ['/v1/messages', '/responses'],
        contextWindow: 200000, maxOutputTokens: 16000, details: { family: 'synthetic-messages' } },
    ],
  };
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((done) => { resolvePromise = done; });
  return { resolve: resolvePromise, promise };
}

/** Waits two frames so React has committed whatever a just-finished response triggered. */
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

// Builds the real ModelsPage and Console CSS into memory (no server, no App shell).
let assetsPromise: Promise<Map<string, string | Uint8Array>> | undefined;
function testAssets() {
  assetsPromise ??= (async () => {
    const entry = 'virtual:models-test.tsx';
    const harness = `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ModelsPage } from '/src/web/pages/ModelsPage.tsx';
      import { EnterpriseScopeContext } from '/src/web/lib/scope.ts';
      import '/src/web/styles.css';
      function Harness() {
        const [notice, setNotice] = useState('');
        const [enterprise, setEnterprise] = useState('default');
        const scope = { id: enterprise, slug: enterprise + '-slug', displayName: 'Enterprise ' + enterprise };
        return <main className="min-w-0 p-4">
          <output aria-label="Notification">{notice}</output>
          <select aria-label="Enterprise" value={enterprise} onChange={(event) => setEnterprise(event.target.value)}>
            <option value="default">default</option><option value="ghe-tenant">ghe-tenant</option>
          </select>
          <EnterpriseScopeContext.Provider key={enterprise} value={scope}>
            <ModelsPage notify={(message) => setNotice(message)} />
          </EnterpriseScopeContext.Provider>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Harness />);`;
    const result = await build({
      root, configFile: false, logLevel: 'silent',
      plugins: [react(), tailwindcss(), {
        name: 'models-test-entry',
        resolveId: (id) => (id === entry ? entry : undefined),
        load: (id) => (id === entry ? harness : undefined),
      }],
      build: { write: false, rollupOptions: { input: entry } },
    });
    if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected Vite build output');
    const assets = new Map<string, string | Uint8Array>();
    let script = '';
    const css: string[] = [];
    for (const item of result.output) {
      assets.set(`/${item.fileName}`, item.type === 'chunk' ? item.code : item.source);
      if (item.type === 'chunk' && item.isEntry) script = `/${item.fileName}`;
      if (item.fileName.endsWith('.css')) css.push(`/${item.fileName}`);
    }
    const links = css.map((path) => `<link rel="stylesheet" href="${path}">`).join('');
    assets.set('/', `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${links}</head>`
      + `<body><div id="root"></div><script type="module" src="${script}"></script></body></html>`);
    return assets;
  })();
  return assetsPromise;
}

/** Every browser request is answered locally; any other destination is recorded and aborted. */
async function offlineModels() {
  const assets = await testAssets();
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(10000);
  const fixture = {
    page,
    errors: [] as string[],
    unexpected: [] as string[],
    requests: [] as URL[],
    response: (_enterprise: string) => catalog(),
    /** Per-enterprise failures; `failure`/`errorCode` apply to every enterprise without one. */
    failures: {} as Record<string, { status: number; code: string }>,
    failure: 0,
    errorCode: 'synthetic_failure',
    holds: [] as Array<{ started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred> }>,
    /** The next catalog request waits until `release` resolves. */
    holdNext() {
      const hold = { started: deferred(), release: deferred(), finished: deferred() };
      fixture.holds.push(hold);
      return hold;
    },
    async close() {
      fixture.holds.forEach((hold) => hold.release.resolve());
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await browser.close();
    },
  };
  page.on('pageerror', (error) => fixture.errors.push(error.message));
  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      fixture.unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) return answerApi(route, url);
    const body = assets.get(url.pathname);
    if (body === undefined) {
      if (url.pathname !== '/favicon.ico') fixture.unexpected.push(url.href);
      return route.fulfill({ status: 404, body: '' });
    }
    const type = url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ contentType: type, body: typeof body === 'string' ? body : Buffer.from(body) });
  });

  async function answerApi(route: Route, url: URL) {
    fixture.requests.push(url);
    const enterprise = MODELS_PATH.exec(url.pathname)?.[1];
    if (!enterprise || route.request().method() !== 'GET') {
      fixture.unexpected.push(url.href);
      return route.abort();
    }
    const fallback = fixture.failure ? { status: fixture.failure, code: fixture.errorCode } : undefined;
    const failure = fixture.failures[enterprise] ?? fallback;
    const status = failure?.status ?? 200;
    const body = failure
      ? { error: { code: failure.code, message: 'Synthetic failure' } }
      : fixture.response(enterprise);
    const hold = fixture.holds.shift();
    if (hold) {
      hold.started.resolve();
      await hold.release.promise;
    }
    try {
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    } catch {
      // A superseded request was aborted by the page; that is expected.
    } finally {
      hold?.finished.resolve();
    }
  }

  return fixture;
}

test('catalog views, sanitized details, copy fallback, refresh and responsive table', { timeout: 120000 }, async () => {
  const f = await offlineModels();
  const { page } = f;
  try {
    await page.goto(`${ORIGIN}/`);
    await page.getByRole('button', { name: 'Details for synthetic-chat', exact: true }).waitFor();
    assert.equal(await page.getByText('example_admin', { exact: true }).count(), 1);
    assert.match(await page.locator('body').innerText(), /No pool accounts are queried/);
    assert.equal(await page.getByLabel('Model view').inputValue(), 'all');
    assert.equal(await page.locator('time').innerText(), FETCHED_AT);
    assert.match(await page.locator('body').innerText(), /Unknown/, 'missing limits are shown as unknown');
    assert.equal(f.requests.at(-1)!.searchParams.get('refresh'), 'false');

    await page.getByRole('button', { name: 'Details for synthetic-chat', exact: true }).click();
    assert.match(await page.getByRole('dialog').innerText(), /"safe": true/);
    assert.equal(await page.getByRole('dialog').locator('img').count(), 0, 'metadata is rendered as text');
    await page.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByLabel('Model view').selectOption('messages');
    assert.equal(await page.getByRole('button', { name: 'Details for synthetic-chat', exact: true }).count(), 0);
    await page.getByLabel('Search models').fill('nothing');
    await page.getByText('No models match this search and view.', { exact: false }).waitFor();
    await page.getByLabel('Search models').fill('');
    await page.getByLabel('Model view').selectOption('all');

    await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: function (text) { window.copied = text; return Promise.resolve(); } } })`);
    await page.getByRole('button', { name: 'Copy model ID synthetic-chat', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as unknown as { copied: string }).copied), 'synthetic-chat');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.getByRole('button', { name: 'Copy model ID synthetic-chat', exact: true }).click();
    const manual = page.getByLabel('Model ID for manual copy');
    assert.equal(await manual.inputValue(), 'synthetic-chat');
    assert.equal(await manual.evaluate((element: HTMLTextAreaElement) => element.selectionEnd - element.selectionStart), 'synthetic-chat'.length);

    f.response = () => ({ ...catalog(), cacheStatus: 'stale' });
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await page.getByText('Stale catalog:', { exact: false }).waitFor();
    assert.equal(f.requests.at(-1)!.searchParams.get('refresh'), 'true');

    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.close();
  }
});

test('refresh is disabled while loading; errors clear previous data', { timeout: 120000 }, async () => {
  const f = await offlineModels();
  const { page } = f;
  try {
    const first = f.holdNext();
    await page.goto(`${ORIGIN}/`);
    await first.started.promise;
    const refresh = page.getByRole('button', { name: 'Loading models…', exact: true });
    assert.equal(await refresh.isDisabled(), true, 'only one catalog request runs at a time');
    first.release.resolve();
    await first.finished.promise;
    await page.getByRole('button', { name: 'Details for synthetic-chat', exact: true }).waitFor();

    f.failure = 503;
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await paint(page);
    assert.equal(await page.getByRole('region', { name: 'Models' }).count(), 0, 'old rows are cleared on error');

    f.failure = 401;
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Your console session may have expired' }).waitFor();
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.close();
  }
});

test('empty catalog, filtered catalog, and admin configuration or authorization errors are distinct', { timeout: 120000 }, async () => {
  const f = await offlineModels();
  const { page } = f;
  try {
    f.response = () => ({ ...catalog(), models: [] });
    await page.goto(`${ORIGIN}/`);
    await page.getByText('The enterprise admin returned an empty model catalog.', { exact: false }).waitFor();

    const cases = [
      [409, 'models_admin_not_configured', 'No GitHub enterprise admin is configured'],
      [409, 'models_admin_credential_missing', 'credential is unavailable'],
      [502, 'models_admin_identity_mismatch', 'does not belong to the configured'],
      [502, 'models_upstream_authorization_rejected', 'Copilot rejected'],
      [503, 'models_admin_configuration_invalid', 'configuration is invalid'],
    ] as const;
    for (const [status, code, message] of cases) {
      f.failure = status;
      f.errorCode = code;
      await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
      const alert = page.getByRole('alert').filter({ hasText: message });
      await alert.waitFor();
      const scoped = /Enterprise default: .*No pool account or other enterprise is used instead/;
      assert.match(await alert.innerText(), scoped);
      assert.equal(await page.getByRole('region', { name: 'Models' }).count(), 0);
    }

    f.failure = 0;
    f.response = () => catalog();
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await page.getByLabel('Search models').fill('nonexistent');
    await page.getByText('No models match this search and view.', { exact: false }).waitFor();
    const onlyDefault = f.requests.every((url) => url.pathname === '/api/console/proxy/enterprises/default/models');
    assert.ok(onlyDefault, 'only the Models API of the selected enterprise is called');
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.close();
  }
});

const PER_ENTERPRISE = 'each enterprise reads its own catalog; a switch drops the late lookup and never falls back';
test(PER_ENTERPRISE, { timeout: 120000 }, async () => {
  const f = await offlineModels();
  const { page } = f;
  try {
    f.response = (enterprise) => catalog(enterprise === 'default' ? 'default_admin' : 'ghe_admin');
    await page.goto(`${ORIGIN}/`);
    await page.getByText('default_admin', { exact: true }).waitFor();
    assert.equal(f.requests.at(-1)!.pathname, '/api/console/proxy/enterprises/default/models');

    const late = f.holdNext();
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await late.started.promise;
    f.failures['ghe-tenant'] = { status: 409, code: 'models_admin_not_configured' };
    await page.getByLabel('Enterprise', { exact: true }).selectOption('ghe-tenant');
    const alert = page.getByRole('alert').filter({ hasText: 'Enterprise ghe-tenant:' });
    await alert.waitFor();
    assert.match(await alert.innerText(), /No GitHub enterprise admin is configured/);
    late.release.resolve();
    await late.finished.promise;
    await paint(page);
    const lateRows = await page.getByText('default_admin', { exact: true }).count();
    assert.equal(lateRows, 0, 'the late default catalog is dropped');
    assert.equal(await alert.count(), 1);
    const scoped = f.requests.slice(-1).map((url) => url.pathname);
    const tenant = ['/api/console/proxy/enterprises/ghe-tenant/models'];
    assert.deepEqual(scoped, tenant, 'no fallback lookup follows the error');

    delete f.failures['ghe-tenant'];
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
    await page.getByText('ghe_admin', { exact: true }).waitFor();
    await page.getByLabel('Enterprise', { exact: true }).selectOption('default');
    await page.getByText('default_admin', { exact: true }).waitFor();
    assert.equal(await page.getByText('ghe_admin', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.unexpected, []);
  } finally {
    await f.close();
  }
});
