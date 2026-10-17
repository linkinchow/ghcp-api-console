import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AccountLogger } from '../tasks/accountLogger.js';
import { HeadlessPlaywrightAuthStrategy } from '../auth/HeadlessPlaywrightAuthStrategy.js';
import type { GithubDeployment } from '../auth/githubUrls.js';

const SLUG = 'sample-ent';
const SSO_USER = 'alice';
const SSO_PASSWORD = 'fixture-password';
const USER_CODE = 'ABCD-1234';

test('GHE.com mode signs in through the enterprise SSO page before entering the device code', { timeout: 90_000 }, async (t) => {
  const fixture = await startFixture(t);
  await fixture.authorize(t, { enterpriseSso: true });
  assert.deepEqual(fixture.events, [
    'ghe:enterprise-sso',
    'sso:login-form',
    `sso:signed-in:${SSO_USER}`,
    `ghe:saml-consume:${SSO_USER}:/`,
    'ghe:device-form',
    `ghe:device-code:${USER_CODE}`,
    'ghe:authorized',
  ]);
});

test('GHE.com mode follows a sign-in redirect from the device page to the enterprise SSO page', { timeout: 90_000 }, async (t) => {
  const fixture = await startFixture(t);
  await fixture.authorize(t, { enterpriseSso: false });
  assert.deepEqual(fixture.events, [
    'ghe:sign-in-redirect',
    'ghe:enterprise-sso',
    'sso:login-form',
    `sso:signed-in:${SSO_USER}`,
    `ghe:saml-consume:${SSO_USER}:/login/device`,
    'ghe:device-form',
    `ghe:device-code:${USER_CODE}`,
    'ghe:authorized',
  ]);
});

async function startFixture(t: TestContext) {
  process.env.DOTENV_CONFIG_PATH = '/dev/null';
  const { config } = await import('../config.js');
  const directory = await mkdtemp(join(tmpdir(), 'login-ghecom-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: string[] = [];
  let ghePort = 0;
  let ssoPort = 0;

  const ghe = await listen(t, async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ghePort}`);
    const signedIn = (req.headers.cookie ?? '').includes('ghe_session=ok');
    if (req.method === 'GET' && url.pathname === `/enterprises/${SLUG}/sso`) {
      events.push('ghe:enterprise-sso');
      return html(res, `<h1>Single sign-on to ${SLUG}</h1>
        <form method="get" action="/enterprises/${SLUG}/saml/initiate">
          <input type="hidden" name="return_to" value="${escapeHtml(url.searchParams.get('return_to') ?? '/')}">
          <button type="submit">Continue</button>
        </form>
        <p>Signing in as the enterprise admin? <a href="/login?admin=1">Sign in</a></p>`);
    }
    if (req.method === 'GET' && url.pathname === `/enterprises/${SLUG}/saml/initiate`) {
      const relayState = url.searchParams.get('return_to') ?? '/';
      return redirect(res, `http://localhost:${ssoPort}/sso?SAMLRequest=fixture&RelayState=${encodeURIComponent(relayState)}`);
    }
    if (req.method === 'POST' && url.pathname === `/enterprises/${SLUG}/saml/consume`) {
      const form = await readForm(req);
      const relayState = form.get('RelayState') || '/';
      events.push(`ghe:saml-consume:${form.get('SAMLResponse')}:${relayState}`);
      return redirect(res, relayState, { 'Set-Cookie': 'ghe_session=ok; Path=/' });
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      return redirect(res, `/enterprises/${SLUG}/sso?return_to=${encodeURIComponent(url.searchParams.get('return_to') ?? '/')}`);
    }
    if (req.method === 'GET' && url.pathname === '/login/device') {
      if (!signedIn) {
        events.push('ghe:sign-in-redirect');
        return redirect(res, '/login?return_to=%2Flogin%2Fdevice');
      }
      events.push('ghe:device-form');
      return html(res, `<h1>Device Activation</h1>
        <form method="post" action="/login/device"><input type="text" name="user_code"><button type="submit">Continue</button></form>`);
    }
    if (req.method === 'POST' && url.pathname === '/login/device' && signedIn) {
      events.push(`ghe:device-code:${(await readForm(req)).get('user_code')}`);
      return html(res, `<h1>Authorize OpenCode</h1>
        <form method="post" action="/login/oauth/authorize"><button type="submit">Authorize opencode</button></form>`);
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/authorize' && signedIn) {
      events.push('ghe:authorized');
      return html(res, '<h1>Congratulations, you are all set!</h1>');
    }
    if (req.method === 'GET' && url.pathname === '/') return html(res, '<h1>Enterprise dashboard</h1>');
    res.writeHead(404).end();
  });
  ghePort = ghe;

  const sso = await listen(t, async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${ssoPort}`);
    if (req.method === 'GET' && url.pathname === '/sso') {
      return redirect(res, `/login?RelayState=${encodeURIComponent(url.searchParams.get('RelayState') ?? '')}`);
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      events.push('sso:login-form');
      return html(res, `<h1>SSO Login</h1>
        <form method="post" action="/login">
          <input type="hidden" name="RelayState" value="${escapeHtml(url.searchParams.get('RelayState') ?? '')}">
          <label>Username <input type="text" name="username"></label>
          <label>Password <input type="password" name="password"></label>
          <button type="submit">Sign in</button>
        </form>`);
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const form = await readForm(req);
      if (form.get('username') !== SSO_USER || form.get('password') !== SSO_PASSWORD) return html(res, '<h1>Invalid credentials</h1>', 401);
      events.push(`sso:signed-in:${SSO_USER}`);
      return html(res, `<form method="post" action="http://127.0.0.1:${ghePort}/enterprises/${SLUG}/saml/consume">
        <input type="hidden" name="SAMLResponse" value="${SSO_USER}">
        <input type="hidden" name="RelayState" value="${escapeHtml(form.get('RelayState') ?? '')}">
        </form><script>document.forms[0].submit()</script>`);
    }
    res.writeHead(404).end();
  });
  ssoPort = sso;

  return {
    events,
    async authorize(ctx: TestContext, options: { enterpriseSso: boolean }): Promise<void> {
      const baseUrl = `http://127.0.0.1:${ghePort}`;
      const github: GithubDeployment = {
        baseUrl,
        host: '127.0.0.1',
        isGheCom: true,
        enterpriseSsoUrl: options.enterpriseSso ? `${baseUrl}/enterprises/${SLUG}/sso` : undefined,
      };
      const logger = AccountLogger.create(directory, SSO_USER, false, `ghecom-${options.enterpriseSso}`, undefined, [SSO_PASSWORD]);
      ctx.diagnostic(`account log: ${logger.path}`);
      const strategy = new HeadlessPlaywrightAuthStrategy(
        {
          ...config.auth,
          github,
          ssoUrl: `http://localhost:${ssoPort}/login`,
          ssoProvider: 'custom',
          headless: true,
          timeoutMs: 30_000,
          debugArtifacts: false,
          debugLogs: false,
        },
        // GHE.com logins carry the hidden shortcode suffix; it must never be typed into a page.
        { githubUsername: `${SSO_USER}_hidden1`, ssoUsername: SSO_USER, ssoPassword: SSO_PASSWORD },
        logger,
      );
      await strategy.authorize({
        device_code: 'fixture-device-code',
        user_code: USER_CODE,
        verification_uri: `${baseUrl}/login/device`,
        expires_in: 900,
        interval: 1,
      });
    },
  };
}

async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void): Promise<number> {
  const server: Server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); });
  return (server.address() as AddressInfo).port;
}

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
