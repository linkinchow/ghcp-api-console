#!/usr/bin/env node
// Reproduces every screenshot of the administrator manual (docs/admin-manual/images/*.png).
//
//   npm ci && npm run build:deploy
//   node docs/admin-manual/capture-screenshots.mjs [--keep-env]
//
// Starts a local, process-based environment (tools/env.mjs): built Proxy/SSO/Login/Console with SQLite, the
// repository mock (tests/docker-user-pool/mock-services.mjs) and tools/edge-mock.mjs. Only synthetic data is used;
// tools/dns-shim.mjs refuses every host name except the local service names and *.ghe.com mock hosts, and binds
// every listener to 127.0.0.1. Requires: Node 22+, openssl on PATH (Git for Windows ships one), Microsoft Edge or
// Chrome (Playwright channel, override with AM_BROWSER_CHANNEL), free local ports 80, 3000, 7001, 7003, 7004, 8002.
// The run directory (.claude/admin-manual-run/capture, git-ignored) is recreated on every run.
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  ADMIN, INTERNAL, LocalEnvironment, PORTS, PROXY_API_KEY, REPO, prepareRun, provideContosoSigningKey,
} from './tools/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IMAGES = join(here, 'images');
const RUN_DIR = join(REPO, '.claude', 'admin-manual-run', 'capture');
const CONSOLE = `http://127.0.0.1:${PORTS.console}`;
const PROXY = `http://127.0.0.1:${PORTS.proxy}`;
const KEEP_ENV = process.argv.includes('--keep-env');

/** Synthetic LiteLLM virtual keys; the Proxy only ever sees sha256:<hex> of them, as LiteLLM sends it. */
const CALLERS = {
  alice: 'sk-example-alice-0001', bob: 'sk-example-bob-0002', carol: 'sk-example-carol-0003',
  dave: 'sk-example-dave-0004', erin: 'sk-example-erin-0005', frank: 'sk-example-frank-0006',
  grace: 'sk-example-grace-0007',
};
export const keyHash = (key) => `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function proxyApi(method, path, body) {
  const response = await fetch(`${PROXY}${path}`, {
    method, headers: { 'X-Internal-Token': INTERNAL, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(label, check, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(1000);
  }
}

/** One inference through the Proxy exactly as LiteLLM sends it; `control` drives the mock (POOL_TEST marker). */
/** Returns the HTTP status; `inferResult` gives "status error_code" for the behaviour checks. */
async function infer(caller, control, path = '/v1/messages') {
  return Number((await inferResult(caller, control, path)).split(' ')[0]);
}

async function inferResult(caller, control, path = '/v1/messages') {
  const text = control ? `Hello POOL_TEST:${JSON.stringify(control)}` : 'Hello';
  const body = { model: 'claude-opus-5-2', max_tokens: 16, messages: [{ role: 'user', content: text }] };
  const response = await fetch(`${PROXY}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PROXY_API_KEY}`, 'X-User-Identity': keyHash(CALLERS[caller]),
      'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const reply = await response.text();
  let code = '';
  try { code = JSON.parse(reply)?.error?.code ?? ''; } catch { /* SSE or non-JSON body */ }
  return code ? `${response.status} ${code}` : String(response.status);
}

async function leaseOf(caller) {
  const hash = keyHash(CALLERS[caller]);
  for (const id of ['default', 'contoso-eu', 'fabrikam']) {
    const page = await proxyApi('GET', `/api/enterprises/${id}/user-pool/page/leases?page=1&pageSize=50`);
    const lease = page.items.find((item) => item.callerKeyHash === hash);
    if (lease) return { enterpriseId: id, ...lease };
  }
  return undefined;
}

// ---------------------------------------------------------------- annotations
/**
 * Draws a red box around each mark and an optional numbered badge at the box's top-left corner.
 * Boxes are fixed-position overlays computed from the target's own geometry after scrolling (table cells use the
 * bounds of their content, not the whole row height); badges are nudged sideways so they never overlap.
 * A mark is a CSS selector, a Playwright Locator, or { locator, badge }.
 */
async function annotate(page, marks) {
  const specs = marks.map((mark) => (typeof mark === 'string' ? { locator: page.locator(mark) }
    : typeof mark.locator === 'function' ? { locator: mark } : mark));
  if (specs.length) await centerVertically(specs[0].locator).catch(() => undefined);
  await page.evaluate(() => { window.__amBadges = []; });
  for (const spec of specs) {
    await spec.locator.first().evaluate((element, label) => {
      const PAD = 4;
      let rect = element.getBoundingClientRect();
      if (['TD', 'TH'].includes(element.tagName) && element.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const content = range.getBoundingClientRect();
        if (content.width && content.height) rect = content;
      }
      // Tiny targets (a single digit) get a minimum box so the frame stays readable.
      const MIN = 26;
      if (rect.width < MIN || rect.height < MIN) {
        const width = Math.max(rect.width, MIN);
        const height = Math.max(rect.height, MIN);
        rect = { left: rect.left + rect.width / 2 - width / 2, top: rect.top + rect.height / 2 - height / 2, width, height };
      }
      const host = element.closest('dialog') ?? document.body;
      const box = document.createElement('div');
      box.dataset.amBadge = '1';
      Object.assign(box.style, {
        position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', boxSizing: 'border-box',
        left: `${rect.left - PAD}px`, top: `${rect.top - PAD}px`,
        width: `${rect.width + PAD * 2}px`, height: `${rect.height + PAD * 2}px`,
        border: '3px solid #dc2626', borderRadius: '6px',
      });
      host.appendChild(box);
      if (label === undefined) return;
      const SIZE = 26;
      let left = Math.max(2, rect.left - PAD - SIZE / 2);
      const top = Math.max(2, rect.top - PAD - SIZE / 2);
      while (window.__amBadges.some((other) => Math.abs(other.left - left) < SIZE + 2 && Math.abs(other.top - top) < SIZE + 2)) {
        left += SIZE + 4;
      }
      window.__amBadges.push({ left, top });
      const badge = document.createElement('div');
      badge.dataset.amBadge = '1';
      badge.textContent = String(label);
      Object.assign(badge.style, {
        position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', left: `${left}px`, top: `${top}px`,
        width: `${SIZE}px`, height: `${SIZE}px`, borderRadius: `${SIZE / 2}px`, background: '#dc2626', color: '#fff',
        font: `700 14px/${SIZE}px system-ui, sans-serif`, textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.35)',
      });
      host.appendChild(badge);
    }, spec.badge);
  }
}

async function clearAnnotations(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('[data-am-badge]')) element.remove();
  });
}

const captured = [];
const VIEWPORT = { width: 1440, height: 900 };

/** Closes success/warning toasts so they do not cover the content. */
async function dismissToasts(page) {
  for (const button of await page.getByRole('button', { name: 'Dismiss notification' }).all()) {
    await button.click().catch(() => undefined);
  }
}

/**
 * Captures the viewport. `tall` grows the viewport to the page height (instead of Playwright's fullPage stitching,
 * which misplaces the sticky header); `width` widens it for wide tables such as the enterprise table.
 */
async function shot(page, name, { marks = [], tall = false, width, scrollTop = true, keepToast = false, clipTo } = {}) {
  if (!keepToast) await dismissToasts(page);
  if (tall || width) {
    await page.setViewportSize({ width: width ?? VIEWPORT.width, height: VIEWPORT.height });
    await sleep(400);
    const height = tall ? Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 2600) : VIEWPORT.height;
    await page.setViewportSize({ width: width ?? VIEWPORT.width, height });
    await sleep(400);
  }
  if (scrollTop) await page.evaluate(() => window.scrollTo(0, 0));
  await annotate(page, marks);
  await sleep(300);
  let clip;
  if (clipTo) {
    // Crop to the union of the given sections (with a margin), e.g. a warning box and the card below it.
    const boxes = await Promise.all(clipTo.map((locator) => locator.first().boundingBox()));
    const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 16);
    const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - 16);
    clip = {
      x, y,
      width: Math.max(...boxes.map((box) => box.x + box.width)) + 16 - x,
      height: Math.max(...boxes.map((box) => box.y + box.height)) + 16 - y,
    };
  }
  await page.screenshot({ path: join(IMAGES, `${name}.png`), animations: 'disabled', clip });
  await clearAnnotations(page);
  if (tall || width) await page.setViewportSize(VIEWPORT);
  captured.push(`${name}.png`);
  log('captured', name);
}

/** Scrolls the window (never a table) so the element sits mid-screen when it is outside the viewport. */
async function centerVertically(locator) {
  await locator.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--console-header-height')) || 0;
    if (rect.top < header || rect.bottom > window.innerHeight) window.scrollBy(0, rect.top - window.innerHeight / 2);
  });
}

async function go(page, hash) {
  await page.evaluate((value) => { window.location.hash = value; }, hash);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await sleep(800);
}

async function waitText(page, text, timeout = 30000) {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
}

// ---------------------------------------------------------------- scenario
async function main() {
  mkdirSync(IMAGES, { recursive: true });
  log('preparing run directory');
  prepareRun(RUN_DIR);
  const env = new LocalEnvironment(RUN_DIR);
  let browser;
  try {
    log('starting services');
    await env.start();
    browser = await chromium.launch({ channel: process.env.AM_BROWSER_CHANNEL ?? 'msedge', headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1,
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CONSOLE });
    const page = await context.newPage();

    // 1. First visit: initialize the Console administrator, then sign in again.
    await page.goto(`${CONSOLE}/`);
    await waitText(page, 'Initialize Console');
    await page.getByPlaceholder('Password').fill(ADMIN.password);
    await shot(page, '01-console-initialize', { marks: [page.getByRole('button', { name: 'Create admin' })] });
    await page.getByRole('button', { name: 'Create admin' }).click();
    await waitText(page, 'Health and signals of every enterprise.');
    await page.getByRole('button', { name: 'Logout' }).click();
    await waitText(page, 'Admin Login');
    await page.getByPlaceholder('Password').fill(ADMIN.password);
    await shot(page, '02-console-login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await waitText(page, 'Health and signals of every enterprise.');

    // 2. New enterprises appear as draft; contoso-eu is blocked by a missing secret.
    await go(page, '#/pool-overview');
    await waitText(page, 'sso:enterprise_secret_unconfigured:sso.signingKey');
    const row = (id) => page.locator(`tr[data-enterprise="${id}"]`);
    await shot(page, '10-pool-overview-draft', {
      tall: true, width: 1760,
      marks: [
        { locator: row('contoso-eu').locator('td').nth(10), badge: 1 },
        { locator: row('fabrikam').locator('td').nth(1), badge: 2 },
        { locator: row('fabrikam').locator('td').nth(11), badge: 3 },
      ],
    });

    // Activating a blocked enterprise is refused and lists the blockers.
    await page.getByRole('button', { name: 'Activate Contoso EU (github.com) (contoso-eu)' }).click();
    await page.getByRole('button', { name: 'Confirm activation' }).click();
    await waitText(page, 'Not changed: the enterprise is not ready');
    await shot(page, '11-activate-not-ready', { width: 1760, marks: [page.getByRole('alert')] });
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Cap first (draft enterprises can be edited), then activation.
    await page.getByRole('button', { name: 'Edit cap of Fabrikam (GHE.com) (fabrikam)' }).click();
    await page.getByLabel('Enterprise maximum accounts').fill('4');
    await shot(page, '12-edit-cap', { width: 1760, marks: [page.getByLabel('Enterprise maximum accounts')] });
    await page.getByRole('button', { name: 'Save cap' }).click();
    await waitText(page, 'Cap of fabrikam set to 4');
    await page.getByRole('button', { name: 'Activate Fabrikam (GHE.com) (fabrikam)' }).click();
    await waitText(page, 'Last readiness check: ready');
    await shot(page, '13-activate-ready', { width: 1760, marks: [page.getByText('Last readiness check: ready')] });
    await page.getByRole('button', { name: 'Confirm activation' }).click();
    await waitText(page, 'fabrikam is now active');

    // 3. Global settings: an idle target larger than one enterprise's cap.
    await page.getByLabel('Ready idle target').fill('6');
    await shot(page, '20-global-settings', {
      width: 1760,
      marks: [
        { locator: page.getByLabel('Ready idle target'), badge: 1 },
        { locator: page.getByLabel('Lease TTL (seconds)'), badge: 2 },
        { locator: page.locator('label', { hasText: 'Pause prewarming' }), badge: 3 },
        { locator: page.getByRole('button', { name: 'Save and apply' }), badge: 4 },
      ],
      scrollTop: false,
    });
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await waitText(page, 'Pool settings saved');
    log('waiting for provisioning');
    await waitFor('6 ready idle accounts', async () => {
      const overview = await proxyApi('GET', '/api/user-pool/overview');
      return overview.counts.ready_idle >= 6 && overview.counts.provisioning === 0;
    }, 180000);

    // 4. Traffic: leases in both active enterprises, plus a few failures.
    log('generating traffic');
    for (const caller of ['alice', 'bob', 'carol', 'dave']) {
      await infer(caller);
      await infer(caller, undefined, '/chat/completions');
    }
    await infer('carol', { id: 'demo-500-a', status: 500 });
    await infer('carol', { id: 'demo-500-b', status: 500 });
    await infer('dave', { id: 'demo-429', status: 429, retryAfter: 120 });
    await infer('bob', { id: 'demo-stream-error', streamMode: 'error' }).catch(() => undefined);
    await go(page, '#/pool-overview');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await sleep(1500);
    await shot(page, '21-pool-overview-shares', {
      tall: true, width: 1760,
      marks: [
        { locator: page.locator('th', { hasText: 'Target share' }), badge: 1 },
        { locator: page.locator('th', { hasText: 'Actual share' }), badge: 2 },
        { locator: page.locator('th', { hasText: 'Score' }), badge: 3 },
      ],
    });

    // Pause prewarming (keeps the failed member below visible instead of auto-repairing it).
    await page.getByLabel('Pause prewarming').check();
    await page.getByRole('button', { name: 'Save and apply' }).click();
    await waitText(page, 'Pool settings saved');
    // erin's account gets an upstream 401: the member fails and its lease ends.
    await infer('erin');
    const erinLease = await leaseOf('erin');
    await infer('erin', { id: 'demo-401', status: 401 });
    await infer('frank');
    await go(page, '#/pool-overview');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await waitText(page, 'Prewarming is paused');
    await shot(page, '22-attention-needed', {
      marks: [
        { locator: page.getByRole('region', { name: 'Pool warnings' }).locator('ul'), badge: 1 },
        { locator: page.locator('label', { hasText: 'Pause prewarming' }), badge: 2 },
      ],
      clipTo: [page.getByRole('region', { name: 'Pool warnings' }),
        page.locator('form', { has: page.getByLabel('Ready idle target') })],
    });

    // 5. Pool members of the enterprise holding erin's (now failed) member.
    const failedEnterprise = erinLease.enterpriseId;
    await go(page, `#/user-pool?e=${failedEnterprise}`);
    await waitText(page, 'Account capacity');
    await page.getByLabel('Refresh every 10s').uncheck();
    await shot(page, '30-pool-members-accounts', {
      marks: [
        { locator: page.locator('header select[aria-label="Enterprise"]'), badge: 1 },
        { locator: page.getByRole('region', { name: 'Pool overview' }).locator('dl'), badge: 2 },
        { locator: page.getByRole('navigation', { name: 'User pool lists' }), badge: 3 },
      ],
    });
    const failedRow = page.locator('tr', { hasText: erinLease.memberIdentity });
    await centerVertically(failedRow);
    await shot(page, '31-member-failed-retry', {
      scrollTop: false,
      marks: [
        { locator: failedRow.locator('td').nth(1), badge: 1 },
        { locator: failedRow.locator('td').nth(4), badge: 2 },
        { locator: failedRow.getByRole('button', { name: 'Retry' }), badge: 3 },
      ],
    });

    // Disable an idle member, then show its Resume button.
    const idleRow = page.locator('tr', { hasText: 'Ready idle' }).first();
    const idleIdentity = (await idleRow.locator('td').first().locator('p').first().textContent()).trim();
    await idleRow.getByRole('button', { name: 'Disable' }).click();
    await waitText(page, 'Disable pool account?');
    await shot(page, '32-disable-confirm', { marks: [page.getByRole('button', { name: 'Disable account' })] });
    await page.getByRole('button', { name: 'Disable account' }).click();
    await waitText(page, 'disabled. No new requests will use this account.');
    const disabledRow = page.locator('tr', { hasText: idleIdentity });
    await centerVertically(disabledRow);
    await shot(page, '33-member-disabled-resume', {
      scrollTop: false,
      marks: [{ locator: disabledRow.getByRole('button', { name: 'Resume' }), badge: 1 }],
    });

    // 6. Find a caller by key hash and release its lease.
    const alice = await leaseOf('alice');
    await go(page, `#/user-pool?e=${alice.enterpriseId}`);
    await waitText(page, 'Account capacity');
    await page.getByLabel('Refresh every 10s').uncheck();
    await page.getByRole('button', { name: 'Leases' }).click();
    const aliceHex = keyHash(CALLERS.alice).slice('sha256:'.length);
    await page.getByLabel('Search pool records').fill(aliceHex);
    await sleep(1500);
    const aliceRow = page.locator('tr', { hasText: alice.memberIdentity });
    await shot(page, '40-find-caller-lease', {
      marks: [
        { locator: page.getByLabel('Search pool records'), badge: 1 },
        { locator: aliceRow.locator('td').nth(1), badge: 2 },
        { locator: aliceRow.getByRole('button', { name: 'Copy LiteLLM key hash' }), badge: 3 },
      ],
    });
    await aliceRow.getByRole('button', { name: 'Release' }).click();
    await waitText(page, 'Release caller lease?');
    await page.getByRole('button', { name: 'Cancel' }).focus(); // hides the focus tooltip of the copy icon
    await shot(page, '41-release-confirm', { marks: [page.getByRole('button', { name: 'Release lease' })] });
    await page.getByRole('button', { name: 'Release lease' }).click();
    await waitText(page, 'Lease released.');
    await infer('alice');
    await page.getByRole('button', { name: 'Recent events' }).click();
    await page.getByLabel('Search pool records').fill('');
    await sleep(1500);
    await shot(page, '42-recent-events', { marks: [page.getByRole('navigation', { name: 'User pool lists' })] });

    // Request Stats of the member alice used (exact identity filter).
    await go(page, `#/stats?e=${alice.enterpriseId}&identity=${encodeURIComponent(alice.memberIdentity)}`);
    await waitText(page, alice.memberIdentity);
    await shot(page, '43-request-stats-by-identity', {
      marks: [page.getByRole('group', { name: 'Applied filters' }).or(page.locator('[aria-label="Applied filters"]'))],
    });
    const carol = await leaseOf('carol');
    await page.reload();
    await go(page, `#/stats?e=${carol.enterpriseId}&success=false`);
    await waitText(page, 'failed');
    await page.setViewportSize({ width: 1760, height: 900 });
    await page.locator('summary[title="Expand full failure reason"]').first().click();
    await shot(page, '50-request-stats-failures', {
      width: 1760,
      marks: [
        { locator: page.locator('details').first(), badge: 1 },
        { locator: page.getByRole('button', { name: 'Copy full failure reason' }).first(), badge: 2 },
      ],
    });

    // 7. Drain fabrikam; existing leases continue.
    await go(page, '#/pool-overview');
    await page.getByRole('button', { name: 'Drain Fabrikam (GHE.com) (fabrikam)' }).click();
    await waitText(page, 'Drain enterprise');
    await shot(page, '14-drain-dialog', { width: 1760, marks: [page.getByRole('button', { name: 'Confirm drain' })] });
    await page.getByRole('button', { name: 'Confirm drain' }).click();
    await waitText(page, 'fabrikam is now draining');

    // 8. Fix contoso-eu's blocker (provide the key file, restart SSO); it stays draft and ready to activate.
    log('fixing contoso-eu blocker and restarting SSO');
    provideContosoSigningKey(RUN_DIR);
    await env.restart('sso');
    await waitFor('contoso-eu ready', async () => {
      const list = await proxyApi('GET', '/api/enterprises');
      return list.items.find((item) => item.id === 'contoso-eu')?.readiness?.ready;
    }, 120000);
    await go(page, '#/pool-overview');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await sleep(2000);
    await shot(page, '15-pool-overview-final', {
      tall: true, width: 1760,
      marks: [
        { locator: row('contoso-eu').locator('td').nth(1), badge: 1 },
        { locator: row('fabrikam').locator('td').nth(1), badge: 2 },
        { locator: row('fabrikam').locator('td').nth(7), badge: 3 },
      ],
    });

    // 9. Dashboard and the enterprise selector.
    await page.reload(); // the header enterprise list is loaded once per page load
    await go(page, '#/dashboard');
    await waitText(page, 'Last checked');
    await sleep(1500);
    await shot(page, '03-dashboard', {
      marks: [
        { locator: page.getByLabel('Enterprise contoso-eu').locator('.flex.flex-wrap.gap-1').first(), badge: 1 },
        { locator: page.getByRole('button', { name: 'Refresh dashboard' }), badge: 2 },
      ],
    });
    await go(page, '#/user-pool?e=default');
    await waitText(page, 'Account capacity');
    await page.getByLabel('Refresh every 10s').uncheck();
    await page.evaluate(() => {
      // Illustration only: draws the native <select> options as an open list (headless browsers never render it).
      const select = document.querySelector('header select[aria-label="Enterprise"]');
      const rect = select.getBoundingClientRect();
      const list = document.createElement('div');
      list.dataset.amBadge = '1';
      Object.assign(list.style, {
        position: 'absolute', left: `${rect.left}px`, top: `${rect.bottom + 2}px`, minWidth: `${rect.width}px`,
        background: '#fff', border: '1px solid #94a3b8', borderRadius: '6px', boxShadow: '0 6px 18px rgba(0,0,0,.18)',
        font: '14px system-ui, sans-serif', zIndex: '2147483646', padding: '4px 0',
      });
      for (const option of select.options) {
        const item = document.createElement('div');
        item.textContent = option.textContent;
        Object.assign(item.style, { padding: '6px 12px', background: option.selected ? '#e2e8f0' : '#fff' });
        list.appendChild(item);
      }
      document.body.appendChild(list);
    });
    await shot(page, '04-enterprise-selector', { marks: [page.locator('header select[aria-label="Enterprise"]')] });

    // 10. SSO users, Proxy accounts, Models, AI Credits, diagnostics and settings.
    await go(page, '#/users?e=default');
    await waitText(page, 'users');
    await sleep(1000);
    await shot(page, '60-sso-users', {
      marks: [
        { locator: page.getByRole('group', { name: 'Selection actions' }), badge: 1 },
        { locator: page.getByRole('button', { name: 'Create user' }), badge: 2 },
      ],
    });
    await go(page, '#/accounts?e=default');
    await sleep(1500);
    await shot(page, '61-proxy-accounts');
    await go(page, '#/tasks?e=default');
    await sleep(1500);
    await shot(page, '62-login-tasks');

    await go(page, '#/models?e=default');
    await waitText(page, 'claude-sonnet-5');
    await shot(page, '70-models', { marks: [page.getByRole('button', { name: 'Refresh models' })] });
    await go(page, '#/models?e=fabrikam');
    await waitText(page, 'No GitHub enterprise admin is configured');
    await sleep(2000);
    await shot(page, '71-models-not-configured');

    await go(page, '#/budgets?e=default');
    await waitText(page, 'Projected this month');
    await shot(page, '72-ai-credits', { marks: [page.getByRole('button', { name: 'Refresh usage' })] });

    await go(page, '#/error-diagnostics');
    await waitText(page, 'Collection enabled');
    await sleep(1000);
    await shot(page, '51-error-diagnostics', {
      marks: [{ locator: page.getByText('Sensitive data redacted'), badge: 1 }],
    });
    await page.getByRole('button', { name: 'Details' }).first().click();
    await waitText(page, 'Download complete log');
    await shot(page, '52-error-diagnostic-detail');
    await page.keyboard.press('Escape');

    await go(page, '#/settings?e=default');
    await waitText(page, 'Login concurrency');
    await sleep(1000);
    await shot(page, '80-settings', { tall: true });
    await go(page, '#/diagnostics?e=default');
    await waitText(page, 'Service connectivity');
    await sleep(2500);
    await shot(page, '81-diagnostics');

    // 11. Behaviour checks behind statements in the manual (logged, no screenshots).
    const drained = await leaseOf('carol');
    log('check: carol lease enterprise =', drained?.enterpriseId);
    log('check: request on a draining enterprise lease ->', await inferResult('carol'));
    await proxyApi('POST', `/api/enterprises/${drained.enterpriseId}/user-pool/leases/${drained.leaseId}/release`,
      { confirm: true });
    log('check: same caller after release, paused, no idle in active enterprises ->', await inferResult('carol'));
    log('check: brand-new caller while no idle ->', await inferResult('grace'));
    const settings = await proxyApi('GET', '/api/user-pool/settings');
    await proxyApi('PATCH', '/api/user-pool/settings', { expectedVersion: settings.version, changes: { paused: 0 } });
    await waitFor('replenishment after resume', async () => (await proxyApi('GET', '/api/user-pool/overview'))
      .counts.ready_idle > 0, 120000);
    log('check: carol after resume ->', await inferResult('carol'), 'lease enterprise =',
      (await leaseOf('carol'))?.enterpriseId);
    const list = await proxyApi('GET', '/api/enterprises');
    for (const item of list.items) {
      log('check: enterprise', item.id, item.pool.state, `inventory ${item.pool.inventory}/${item.pool.maxAccounts}`,
        JSON.stringify(item.poolSummary));
    }

    log(`done: ${captured.length} screenshots`);
  } finally {
    await browser?.close();
    if (KEEP_ENV) {
      log('--keep-env: services keep running; press Ctrl+C to stop them');
      process.on('SIGINT', async () => { await env.stop(); process.exit(0); });
      await new Promise(() => {});
    }
    await env.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
