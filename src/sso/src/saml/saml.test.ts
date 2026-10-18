import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { after, before, test } from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import cookieSession from 'cookie-session';
import express from 'express';
import { parseRegistry, type EnterpriseId } from '@ghcp/shared';

// Real SAML, signatures, passwords, SQLite and cookies; only the registry and certificates are synthetic.
const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto') as typeof import('xml-crypto');

const BASE_URL = 'http://sso.test';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

interface Fixture {
  id: EnterpriseId;
  path: string;
  cookieName: string;
  spEntityId: string;
  spAcsUrl: string;
  certificate: string;
  sessionSecret: string;
}

interface Modules {
  routes: typeof import('../routes/samlRoutes.js');
  users: typeof import('../db/usersRepo.js');
  password: typeof import('../auth/password.js');
}

const secretDir = mkdtempSync(join(tmpdir(), 'sso-saml-test-'));
const defaultFixture = fixture('default', '', 'https://github.com/enterprises/octo-corp');
const contosoFixture = fixture('contoso', '/enterprises/contoso', 'https://contoso.ghe.com/enterprises/contoso');
let modules: Modules;
let server: Server;
let serverUrl: string;
let restartedServer: Server;
let restartedUrl: string;

function fixture(id: string, path: string, spEntityId: string): Fixture {
  return {
    id: id as EnterpriseId,
    path,
    cookieName: path ? `sso_session_${id}` : 'sso_session',
    spEntityId,
    spAcsUrl: `${spEntityId}/saml/consume`,
    certificate: '',
    sessionSecret: `${id}-synthetic-session-secret`,
  };
}

function writeSecrets(target: Fixture): Record<string, { file: string }> {
  const file = (name: string) => join(secretDir, `${target.id}-${name}`);
  const subject = `/CN=${target.id}.sso.invalid`;
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', subject];
  execFileSync('openssl', [...args, '-keyout', file('key.pem'), '-out', file('cert.pem')], { stdio: 'ignore' });
  writeFileSync(file('session'), target.sessionSecret);
  target.certificate = readFileSync(file('cert.pem'), 'utf8');
  return {
    signingCert: { file: file('cert.pem') },
    signingKey: { file: file('key.pem') },
    sessionSecret: { file: file('session') },
  };
}

function ssoFields(target: Fixture): Record<string, unknown> {
  return { spEntityId: target.spEntityId, spAcsUrl: target.spAcsUrl, ...writeSecrets(target) };
}

function registryJson(): unknown {
  return {
    version: 1,
    enterprises: [
      {
        id: 'default',
        github: { baseUrl: 'https://github.com', slug: 'octo-corp', shortcode: 'octo' },
        sso: ssoFields(defaultFixture),
      },
      {
        id: 'contoso',
        github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' },
        sso: ssoFields(contosoFixture),
      },
    ],
  };
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const listening = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listening.once('listening', resolve));
  return { server: listening, url: `http://127.0.0.1:${(listening.address() as AddressInfo).port}` };
}

function samlApp(): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  modules.routes.mountSamlRouters(app);
  app.use((_req, res) => {
    res.status(404).send('not found');
  });
  return app;
}

async function createUser(target: Fixture, ssoUser: string, password: string): Promise<void> {
  const hashed = await modules.password.hashPassword(password);
  modules.users.createUser(target.id, { ssoUser, ...hashed, email: `${ssoUser}@${target.id}.invalid` });
}

before(async () => {
  process.env.DOTENV_CONFIG_PATH = join(secretDir, 'missing.env');
  process.env.DB_PATH = ':memory:';
  process.env.BASE_URL = BASE_URL;
  process.env.SSO_USER_EVENTS_LOG = join(secretDir, 'events.log');
  const { setSsoEnterprisesForTesting } = await import('../enterprises.js');
  setSsoEnterprisesForTesting(parseRegistry(registryJson(), { service: 'sso' }));
  modules = {
    routes: await import('../routes/samlRoutes.js'),
    users: await import('../db/usersRepo.js'),
    password: await import('../auth/password.js'),
  };
  await createUser(defaultFixture, 'alice', 'default-alice-password');
  await createUser(defaultFixture, 'bob', 'default-bob-password');
  await createUser(contosoFixture, 'alice', 'contoso-alice-password');
  ({ server, url: serverUrl } = await listen(samlApp()));
  ({ server: restartedServer, url: restartedUrl } = await listen(samlApp()));
});

after(async () => {
  for (const running of [server, restartedServer]) {
    running?.closeAllConnections();
    await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  }
  rmSync(secretDir, { recursive: true, force: true });
});

class Browser {
  readonly cookies = new Map<string, string>();

  constructor(private origin = serverUrl) {}

  useServer(origin: string): void {
    this.origin = origin;
  }

  async get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send(path, { method: 'GET', headers });
  }

  async post(path: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    const formHeaders = { 'content-type': 'application/x-www-form-urlencoded', origin: BASE_URL, ...headers };
    return this.send(path, { method: 'POST', headers: formHeaders, body: new URLSearchParams(form) });
  }

  async login(target: Fixture, username: string, password: string): Promise<Response> {
    return this.post(`${target.path}/login`, { username, password });
  }

  async send(path: string, init: RequestInit): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const headers = { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) };
    const response = await fetch(`${this.origin}${path}`, { ...init, headers, redirect: 'manual' });
    for (const setCookie of response.headers.getSetCookie()) this.store(setCookie);
    return response;
  }

  private store(setCookie: string): void {
    const [name, value] = cookiePair(setCookie);
    if (/Expires=Thu, 01 Jan 1970/i.test(setCookie)) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

function cookiePair(setCookie: string): [string, string] {
  const pair = setCookie.split(';')[0]!;
  const separator = pair.indexOf('=');
  return [pair.slice(0, separator), pair.slice(separator + 1)];
}

interface RequestOptions {
  id?: string;
  issuer?: string;
  destination?: string | null;
  acsUrl?: string | null;
  prolog?: string;
  forceAuthn?: boolean;
}

function authnRequestXml(target: Fixture, options: RequestOptions = {}): string {
  const destination = options.destination === undefined ? `${BASE_URL}${target.path}/sso` : options.destination;
  const acsUrl = options.acsUrl === undefined ? target.spAcsUrl : options.acsUrl;
  const attributes = [
    `ID="${options.id ?? '_request-1'}"`,
    'Version="2.0"',
    `IssueInstant="${new Date().toISOString()}"`,
    destination === null ? '' : `Destination="${destination}"`,
    acsUrl === null ? '' : `AssertionConsumerServiceURL="${acsUrl}"`,
    options.forceAuthn ? 'ForceAuthn="true"' : '',
  ].filter(Boolean).join(' ');
  return `${options.prolog ?? ''}<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ` +
    `xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ${attributes}>` +
    `<saml:Issuer>${options.issuer ?? target.spEntityId}</saml:Issuer></samlp:AuthnRequest>`;
}

function ssoPath(target: Fixture, options: RequestOptions = {}, relayState = 'relay-1'): string {
  const samlRequest = deflateRawSync(Buffer.from(authnRequestXml(target, options))).toString('base64');
  return `${target.path}/sso?${new URLSearchParams({ SAMLRequest: samlRequest, RelayState: relayState })}`;
}

function formFields(html: string): Record<string, string> {
  const document = new DOMParser({ errorHandler: { warning: () => undefined } }).parseFromString(html, 'text/html');
  const inputs = Array.from(document.getElementsByTagName('input'));
  return Object.fromEntries(inputs.map((input) => [input.getAttribute('name')!, input.getAttribute('value')!]));
}

function formAction(html: string): string | undefined {
  return /<form method="post" action="([^"]*)"/.exec(html)?.[1];
}

function responseXml(html: string): string {
  return Buffer.from(formFields(html).SAMLResponse!, 'base64').toString('utf8');
}

function assertSignedBy(xml: string, certificate: string): void {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const signatures = Array.from(document.getElementsByTagNameNS(DSIG_NS, 'Signature'));
  assert.ok(signatures.length > 0, 'the response must be signed');
  for (const signature of signatures) {
    const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature);
    assert.equal(verifier.checkSignature(xml), true);
  }
}

function certificateBody(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
}

function decodeSession(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
}

/** Issues a cookie with the real cookie-session middleware, as the baseline SSO did. */
async function mintCookie(
  name: string,
  secret: string,
  payload: Record<string, unknown>,
): Promise<Map<string, string>> {
  const app = express();
  app.use(cookieSession({ name, secret, httpOnly: true, sameSite: 'lax', maxAge: 60_000 }));
  app.get('/', (req, res) => {
    Object.assign(req.session!, payload);
    res.end();
  });
  const minted = await listen(app);
  try {
    const response = await fetch(minted.url);
    return new Map(response.headers.getSetCookie().map((cookie) => cookiePair(cookie)));
  } finally {
    minted.server.close();
  }
}

async function signedInBrowser(target: Fixture, username: string, password: string): Promise<Browser> {
  const browser = new Browser();
  const response = await browser.login(target, username, password);
  assert.equal(response.status, 200);
  return browser;
}

test('each enterprise publishes its own IdP entity ID, endpoints and signing certificate', async () => {
  const defaultXml = await (await fetch(`${serverUrl}/metadata`)).text();
  assert.match(defaultXml, /entityID="http:\/\/sso\.test\/metadata"/);
  assert.match(defaultXml, /Location="http:\/\/sso\.test\/sso"/);
  assert.ok(defaultXml.includes(certificateBody(defaultFixture.certificate)));
  assert.ok(!defaultXml.includes(certificateBody(contosoFixture.certificate)));
  const contosoXml = await (await fetch(`${serverUrl}/enterprises/contoso/metadata`)).text();
  assert.match(contosoXml, /entityID="http:\/\/sso\.test\/enterprises\/contoso\/metadata"/);
  assert.match(contosoXml, /Location="http:\/\/sso\.test\/enterprises\/contoso\/sso"/);
  assert.match(contosoXml, /Location="http:\/\/sso\.test\/enterprises\/contoso\/logout"/);
  assert.ok(contosoXml.includes(certificateBody(contosoFixture.certificate)));
  assert.ok(!contosoXml.includes(certificateBody(defaultFixture.certificate)));
});

test('default SP-initiated login keeps the baseline URLs, cookie and signed response', async () => {
  const browser = new Browser();
  const start = await browser.get(ssoPath(defaultFixture, { id: '_default-request' }));
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), '/login');
  const setCookie = start.headers.getSetCookie().find((cookie) => cookie.startsWith('sso_session='))!;
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=28800/);
  assert.doesNotMatch(setCookie, /Secure/);
  assert.equal(formAction(await (await browser.get('/login')).text()), '/login');
  const response = await browser.login(defaultFixture, 'alice', 'default-alice-password');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(formAction(html), defaultFixture.spAcsUrl);
  assert.equal(formFields(html).RelayState, 'relay-1');
  const xml = responseXml(html);
  assert.match(xml, /InResponseTo="_default-request"/);
  assert.match(xml, /<saml:Issuer>http:\/\/sso\.test\/metadata<\/saml:Issuer>/);
  assert.ok(xml.includes(`<saml:Audience>${defaultFixture.spEntityId}</saml:Audience>`));
  assertSignedBy(xml, defaultFixture.certificate);
  const again = await browser.get(ssoPath(defaultFixture, { id: '_second-request' }));
  assert.equal(again.status, 200);
  assert.match(responseXml(await again.text()), /InResponseTo="_second-request"/);
});

test('a non-default enterprise uses its own paths, cookie and certificate', async () => {
  const browser = new Browser();
  const start = await browser.get(ssoPath(contosoFixture, { id: '_contoso-request' }));
  assert.equal(start.status, 302);
  assert.equal(start.headers.get('location'), '/enterprises/contoso/login');
  const setCookie = start.headers.getSetCookie().find((cookie) => cookie.startsWith('sso_session_contoso='))!;
  assert.match(setCookie, /Path=\/enterprises\/contoso/);
  assert.equal(browser.cookies.has('sso_session'), false);
  const loginPage = await (await browser.get('/enterprises/contoso/login')).text();
  assert.equal(formAction(loginPage), '/enterprises/contoso/login');
  const html = await (await browser.login(contosoFixture, 'alice', 'contoso-alice-password')).text();
  assert.equal(formAction(html), contosoFixture.spAcsUrl);
  const xml = responseXml(html);
  assert.match(xml, /<saml:Issuer>http:\/\/sso\.test\/enterprises\/contoso\/metadata<\/saml:Issuer>/);
  assertSignedBy(xml, contosoFixture.certificate);
  const loggedIn = await (await new Browser().login(contosoFixture, 'alice', 'contoso-alice-password')).text();
  assert.equal(formAction(loggedIn), '/enterprises/contoso/logout');
});

test('AuthnRequests must name this enterprise SP, IdP endpoint and ACS, without DTDs or PIs', async () => {
  const rejected: Record<string, [Fixture, RequestOptions]> = {
    wrongIssuer: [contosoFixture, { issuer: defaultFixture.spEntityId }],
    wrongDestination: [contosoFixture, { destination: `${BASE_URL}/sso` }],
    wrongAcs: [defaultFixture, { acsUrl: contosoFixture.spAcsUrl }],
    doctype: [defaultFixture, { prolog: '<!DOCTYPE r [<!ENTITY x "y">]>' }],
    processingInstruction: [defaultFixture, { prolog: '<?xml-stylesheet href="x"?>' }],
    invalidId: [defaultFixture, { id: '1 bad' }],
  };
  for (const [name, [target, options]] of Object.entries(rejected)) {
    const response = await new Browser().get(ssoPath(target, options));
    assert.equal(response.status, 400, name);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/, name);
  }
  const optionalOmitted = await new Browser().get(ssoPath(contosoFixture, { destination: null, acsUrl: null }));
  assert.equal(optionalOmitted.status, 302);
  const declared = await new Browser().get(ssoPath(defaultFixture, { prolog: '<?xml version="1.0"?>' }));
  assert.equal(declared.status, 302);
});

test('a session cookie of one enterprise is not accepted by another', async () => {
  const defaultBrowser = await signedInBrowser(defaultFixture, 'alice', 'default-alice-password');
  const contosoBrowser = await signedInBrowser(contosoFixture, 'alice', 'contoso-alice-password');
  const renamedToContoso = new Browser();
  renamedToContoso.cookies.set('sso_session_contoso', defaultBrowser.cookies.get('sso_session')!);
  renamedToContoso.cookies.set('sso_session_contoso.sig', defaultBrowser.cookies.get('sso_session.sig')!);
  assert.equal((await renamedToContoso.get(ssoPath(contosoFixture))).status, 302);
  const renamedToDefault = new Browser();
  renamedToDefault.cookies.set('sso_session', contosoBrowser.cookies.get('sso_session_contoso')!);
  renamedToDefault.cookies.set('sso_session.sig', contosoBrowser.cookies.get('sso_session_contoso.sig')!);
  assert.equal((await renamedToDefault.get(ssoPath(defaultFixture))).status, 302);
  const contosoPayload = decodeSession(contosoBrowser.cookies.get('sso_session_contoso')!);
  const forged = new Browser();
  for (const [name, value] of await mintCookie('sso_session', defaultFixture.sessionSecret, contosoPayload)) {
    forged.cookies.set(name, value);
  }
  assert.equal((await forged.get(ssoPath(defaultFixture))).status, 302, 'e must match the route enterprise');
  assert.equal((await defaultBrowser.get(ssoPath(defaultFixture))).status, 200);
  assert.equal((await contosoBrowser.get(ssoPath(contosoFixture))).status, 200);
});

test('a baseline sso_session cookie stays valid on default and is upgraded', async () => {
  const browser = new Browser();
  for (const [name, value] of await mintCookie('sso_session', defaultFixture.sessionSecret, {
    user: { ssoUser: 'alice' },
  })) browser.cookies.set(name, value);
  const response = await browser.get(ssoPath(defaultFixture, { id: '_legacy-user' }));
  assert.equal(response.status, 200);
  assert.match(responseXml(await response.text()), /InResponseTo="_legacy-user"/);
  const upgraded = decodeSession(browser.cookies.get('sso_session')!);
  const alice = modules.users.getUser(defaultFixture.id, 'alice')!;
  assert.deepEqual(upgraded, { e: 'default', user: { ssoUser: 'alice', createdAt: alice.createdAt } });
  const pending = new Browser();
  for (const [name, value] of await mintCookie('sso_session', defaultFixture.sessionSecret, {
    ssoPending: true,
    pendingInResponseTo: '_legacy-pending',
    pendingRelayState: 'legacy-relay',
  })) pending.cookies.set(name, value);
  const html = await (await pending.login(defaultFixture, 'bob', 'default-bob-password')).text();
  assert.match(responseXml(html), /InResponseTo="_legacy-pending"/);
  assert.equal(formFields(html).RelayState, 'legacy-relay');
});

test('a baseline cookie without an enterprise is rejected outside default', async () => {
  const browser = new Browser();
  for (const [name, value] of await mintCookie('sso_session_contoso', contosoFixture.sessionSecret, {
    user: { ssoUser: 'alice' },
  })) browser.cookies.set(name, value);
  assert.equal((await browser.get(ssoPath(contosoFixture))).status, 302);
});

test('recreating a user invalidates the old session cookie', async () => {
  await createUser(defaultFixture, 'carol', 'default-carol-password');
  const browser = await signedInBrowser(defaultFixture, 'carol', 'default-carol-password');
  assert.equal((await browser.get(ssoPath(defaultFixture))).status, 200);
  modules.users.deleteUser(defaultFixture.id, 'carol');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await createUser(defaultFixture, 'carol', 'default-carol-password');
  const response = await browser.get(ssoPath(defaultFixture));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
});

test('a session survives a restart: another app instance with the same secret accepts the cookie', async () => {
  const browser = await signedInBrowser(contosoFixture, 'alice', 'contoso-alice-password');
  browser.useServer(restartedUrl);
  const response = await browser.get(ssoPath(contosoFixture, { id: '_after-restart' }));
  assert.equal(response.status, 200);
  assert.match(responseXml(await response.text()), /InResponseTo="_after-restart"/);
});

test('a pending AuthnRequest expires after five minutes and answers one response only', async () => {
  const browser = new Browser();
  const startedAt = Date.now();
  await browser.get(ssoPath(defaultFixture, { id: '_pending' }));
  const pending = decodeSession(browser.cookies.get('sso_session')!).pending as { exp: number };
  assert.ok(pending.exp >= startedAt + 5 * 60 * 1000 && pending.exp <= Date.now() + 5 * 60 * 1000);
  const answered = await browser.login(defaultFixture, 'alice', 'default-alice-password');
  assert.match(responseXml(await answered.text()), /InResponseTo="_pending"/);
  assert.equal(decodeSession(browser.cookies.get('sso_session')!).pending, undefined);
  const second = await (await browser.login(defaultFixture, 'alice', 'default-alice-password')).text();
  assert.match(second, /Logged in as alice/);
  const expired = new Browser();
  for (const [name, value] of await mintCookie('sso_session', defaultFixture.sessionSecret, {
    e: 'default',
    pending: { requestId: '_expired', relayState: 'r', exp: Date.now() - 1 },
  })) expired.cookies.set(name, value);
  const late = await (await expired.login(defaultFixture, 'alice', 'default-alice-password')).text();
  assert.match(late, /Logged in as alice/);
});

test('login and logout reject cross-site posts', async () => {
  const browser = new Browser();
  const credentials = { username: 'alice', password: 'default-alice-password' };
  const foreign = await browser.post('/login', credentials, { origin: 'http://evil.test' });
  assert.equal(foreign.status, 403);
  const crossSite = await browser.post('/enterprises/contoso/login', credentials, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  assert.equal((await browser.post('/login', credentials, { origin: 'null' })).status, 403);
  const foreignScheme = await browser.post('/login', credentials, { origin: 'https://evil.test' });
  assert.equal(foreignScheme.status, 403);
  const signedIn = await signedInBrowser(defaultFixture, 'alice', 'default-alice-password');
  const logout = await signedIn.post('/logout', {}, { origin: 'http://evil.test' });
  assert.equal(logout.status, 403);
  assert.equal((await signedIn.get(ssoPath(defaultFixture))).status, 200);
  const sameOrigin = await signedIn.post('/logout', {}, { 'sec-fetch-site': 'same-origin' });
  assert.equal(sameOrigin.status, 302);
  assert.equal(sameOrigin.headers.get('location'), '/login');
  assert.equal((await signedIn.get(ssoPath(defaultFixture))).status, 302);
});

test('posts from the internal host or the public host are same-origin', async () => {
  const credentials = { username: 'alice', password: 'default-alice-password' };
  // The page was opened at http://127.0.0.1:<port> while BASE_URL is the public http://sso.test.
  const internal = await new Browser().post('/login', credentials, { origin: serverUrl });
  assert.equal(internal.status, 200);
  const contosoInternal = await new Browser().post('/enterprises/contoso/login', {
    username: 'alice',
    password: 'contoso-alice-password',
  }, { origin: serverUrl });
  assert.equal(contosoInternal.status, 200);
  // TLS may terminate at a proxy, so only the host is compared.
  assert.equal((await new Browser().post('/login', credentials, { origin: 'https://sso.test' })).status, 200);
  const withoutOrigin = await new Browser().send('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(credentials),
  });
  assert.equal(withoutOrigin.status, 200);
  const signedIn = await signedInBrowser(defaultFixture, 'alice', 'default-alice-password');
  assert.equal((await signedIn.post('/logout', {}, { origin: serverUrl })).status, 302);
  assert.equal((await signedIn.get(ssoPath(defaultFixture))).status, 302);
});

test('same-name users of two enterprises cannot sign in to each other', async () => {
  const browser = new Browser();
  assert.equal((await browser.login(contosoFixture, 'alice', 'default-alice-password')).status, 401);
  assert.equal((await browser.login(defaultFixture, 'alice', 'contoso-alice-password')).status, 401);
  assert.equal((await browser.login(contosoFixture, 'bob', 'default-bob-password')).status, 401);
  assert.equal((await browser.login(contosoFixture, 'alice', 'contoso-alice-password')).status, 200);
});

test('unknown enterprises are 404 and never fall back to default', async () => {
  const unknown = await fetch(`${serverUrl}/enterprises/nope/metadata`);
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'enterprise_not_found');
  assert.equal((await fetch(`${serverUrl}/enterprises/nope/sso`)).status, 404);
  assert.equal((await fetch(`${serverUrl}/enterprises/default/metadata`)).status, 404);
  assert.equal((await fetch(`${serverUrl}/enterprises/contoso/unknown`)).status, 404);
});
