import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import express from 'express';
import { parseRegistry } from '@ghcp/shared';

// A public https base URL is the deployment case behind a TLS-terminating proxy: Node itself sees plain HTTP.
const BASE_URL = 'https://sso.example.test';
const SECRETS = { DEFAULT_SESSION: 'default-session-secret', CONTOSO_SESSION: 'contoso-session-secret' };

type SessionModule = typeof import('./enterpriseSession.js');
type Enterprises = typeof import('../enterprises.js');

let session: SessionModule;
let enterprises: Enterprises;
let server: Server;
let serverUrl: string;

before(async () => {
  process.env.BASE_URL = BASE_URL;
  Object.assign(process.env, SECRETS);
  enterprises = await import('../enterprises.js');
  enterprises.setSsoEnterprisesForTesting(parseRegistry({
    version: 1,
    enterprises: [
      { id: 'default', github: { baseUrl: 'https://github.com', slug: 'octo-corp' }, sso: sessionSecret('DEFAULT') },
      { id: 'contoso', github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' }, sso: sessionSecret('CONTOSO') },
    ],
  }, { service: 'sso' }));
  session = await import('./enterpriseSession.js');
  server = sessionApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
});

function sessionSecret(prefix: string): Record<string, unknown> {
  return { sessionSecret: { env: `${prefix}_SESSION` } };
}

/** Writes `{ user }` on POST and echoes the session read on GET, for the enterprise named in the path. */
function sessionApp(): express.Express {
  const app = express();
  app.post('/:enterpriseId', (req, res) => {
    const enterprise = enterprises.findSsoEnterprise(req.params.enterpriseId)!;
    const user = { ssoUser: 'alice', createdAt: '2026-10-18T00:00:00.000Z' };
    session.writeSession(res, enterprise, { e: enterprise.id, user });
    res.end();
  });
  app.get('/:enterpriseId', (req, res) => {
    res.json(session.readSession(req, enterprises.findSsoEnterprise(req.params.enterpriseId)!));
  });
  app.delete('/:enterpriseId', (req, res) => {
    session.clearSession(res, enterprises.findSsoEnterprise(req.params.enterpriseId)!);
    res.end();
  });
  return app;
}

async function issue(enterpriseId: string): Promise<string[]> {
  const response = await fetch(`${serverUrl}/${enterpriseId}`, { method: 'POST' });
  return response.headers.getSetCookie();
}

async function read(enterpriseId: string, cookie: string): Promise<unknown> {
  return (await fetch(`${serverUrl}/${enterpriseId}`, { headers: { cookie } })).json();
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map((setCookie) => setCookie.split(';')[0]).join('; ');
}

test('cookies carry Secure for an https base URL even when Node sees plain HTTP', async () => {
  const [value, signature] = await issue('default');
  for (const setCookie of [value!, signature!]) {
    assert.match(setCookie, /; Path=\/(;|$)/);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; Secure/);
    assert.match(setCookie, /; SameSite=Lax/);
    assert.match(setCookie, /; Max-Age=28800(;|$)/);
  }
  assert.match(value!, /^sso_session=/);
  assert.match(signature!, /^sso_session\.sig=/);
});

test('a non-default enterprise cookie is named and scoped by enterprise', async () => {
  const [value, signature] = await issue('contoso');
  assert.match(value!, /^sso_session_contoso=[^;]+;/);
  assert.match(signature!, /^sso_session_contoso\.sig=[^;]+;/);
  for (const setCookie of [value!, signature!]) assert.match(setCookie, /; Path=\/enterprises\/contoso(;|$)/);
});

test('a written session reads back only for its enterprise and only with a valid signature', async () => {
  const cookie = cookieHeader(await issue('contoso'));
  const user = { ssoUser: 'alice', createdAt: '2026-10-18T00:00:00.000Z' };
  assert.deepEqual(await read('contoso', cookie), { e: 'contoso', user });
  assert.deepEqual(await read('default', cookie), { e: 'default' });
  const tampered = cookie.replace(/sso_session_contoso=([^;]+)/, (_match, value: string) => {
    const payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as { user: { ssoUser: string } };
    payload.user.ssoUser = 'mallory';
    return `sso_session_contoso=${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
  });
  assert.deepEqual(await read('contoso', tampered), { e: 'contoso' });
  const unsigned = cookie.replace(/; sso_session_contoso\.sig=[^;]+/, '');
  assert.deepEqual(await read('contoso', unsigned), { e: 'contoso' });
});

test('clearing a session expires both cookies on the enterprise path', async () => {
  const response = await fetch(`${serverUrl}/contoso`, { method: 'DELETE' });
  const cleared = response.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  for (const setCookie of cleared) {
    assert.match(setCookie, /^sso_session_contoso(\.sig)?=;/);
    assert.match(setCookie, /; Path=\/enterprises\/contoso(;|$)/);
    assert.match(setCookie, /Expires=Thu, 01 Jan 1970/);
  }
});

test('newPending expires five minutes after creation', () => {
  const pending = session.newPending('_id', 'relay', 1_000);
  assert.deepEqual(pending, { requestId: '_id', relayState: 'relay', exp: 1_000 + session.PENDING_TTL_MS });
  assert.equal(session.PENDING_TTL_MS, 5 * 60 * 1000);
});
