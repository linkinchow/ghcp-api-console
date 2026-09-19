import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import express from 'express';
import { DOMParser } from '@xmldom/xmldom';
import { parseEnterpriseRegistryV3, resolveEnterpriseScope, type EnterpriseProfileV3, type EnterpriseScope } from '@ghcp/shared';
import type { SsoUserRecord } from '../db/usersRepo.js';
import { hashPassword } from '../auth/password.js';

// Run with node --import tsx --experimental-test-module-mocks --test <this file>.
// Only trusted registry/DB boundaries are mocked. SAML, XML schema, signatures,
// passwords, HTTP body/cookie handling and all transaction logic are real.
const require = createRequire(import.meta.url);
const { SignedXml } = require('xml-crypto') as typeof import('xml-crypto');
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const users = new Map<string, SsoUserRecord>();
let scopes: EnterpriseScope[];
let secretDir: string;
let server: Server;
let baseUrl: string;
let saml: typeof import('./saml.js');
let fenceHook: (() => void) | undefined;
let scopesEnabled = true;
const certs: Record<string, string> = {};
const key = (username: string, scope: EnterpriseScope): string => `${scope.enterpriseId}/${username.toLowerCase()}`;

function profile(id: string, origin: string, legacy: boolean): EnterpriseProfileV3 {
  const prefix = legacy ? origin : `${origin}/profiles/${id}`;
  return {
    id, slug: legacy ? 'synthetic-a' : 'synthetic-b', shortcode: legacy ? 'enaa' : 'enbb', accountDomain: 'synthetic.invalid', revision: 1,
    maxAccounts: 10, routes: { ssoPublicUrl: origin, ssoInternalUrl: origin, loginInternalUrl: origin, proxyInternalUrl: origin },
    sso: { entityId: `${prefix}/metadata`, ssoUrl: `${prefix}/sso`, loginUrl: `${prefix}/login`, logoutUrl: `${prefix}/logout`,
      spEntityId: `${origin}/mock-sp/${id}`, spAcsUrl: `${origin}/mock-acs/${id}`, scimBaseUrl: `${origin}/scim/${id}`, githubApiBaseUrl: `${origin}/mock-api`,
      emailDomain: 'synthetic.invalid', userPrefix: 'sso',
      signingCertRef: { file: join(secretDir, `${id}.crt`) }, signingKeyRef: { file: join(secretDir, `${id}.key`) }, sessionSecretRef: { file: join(secretDir, `${id}.session`) } },
    login: { provider: 'custom', allowedLoginUrls: [`${prefix}/login`], selectors: {} },
  };
}

before(async () => {
  secretDir = mkdtempSync(join(tmpdir(), 'saml-synthetic-'));
  for (const id of [A, B]) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(secretDir, `${id}.key`), '-out', join(secretDir, `${id}.crt`), '-days', '2', '-subj', `/CN=synthetic-${id}.invalid`], { stdio: 'ignore' });
    certs[id] = readFileSync(join(secretDir, `${id}.crt`), 'utf8');
    writeFileSync(join(secretDir, `${id}.session`), `${id}-synthetic-session-secret-only`);
  }
  const app = express();
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const registry = parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: A, profiles: [profile(A, baseUrl, true), profile(B, baseUrl, false)] });
  scopes = [A, B].map(id => resolveEnterpriseScope(registry, id));
  for (const scope of scopes) users.set(key('same-user', scope), {
    ssoUser: 'same-user', userIncarnation: randomUUID(), enterpriseId: scope.enterpriseId, email: `${scope.enterpriseId}@synthetic.invalid`,
    ...hashPassword(`password-${scope.enterpriseId}`), role: 'user', emuStatus: 'not_synced', copilotSeatStatus: 'unassigned', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as SsoUserRecord);
  mock.module('../enterprise.js', { namedExports: {
    getScopeProfile: (scope: EnterpriseScope): EnterpriseProfileV3 => {
      if (!scopesEnabled || !scopes.some(s => s.enterpriseId === scope.enterpriseId && s.enterpriseRevision === scope.enterpriseRevision && s.registryRevision === scope.registryRevision)) throw new Error('enterprise_scope_invalid');
      return scopes.find(s => s.enterpriseId === scope.enterpriseId)!.profile;
    },
    requireEnterpriseRequest: (scope: EnterpriseScope) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!scopesEnabled || req.headers['x-enterprise-id'] && req.headers['x-enterprise-id'] !== scope.enterpriseId) { res.status(400).send('scope'); return; }
      next();
    },
  } });
  mock.module('../db/usersRepo.js', { namedExports: {
    getUser: (username: string, scope: EnterpriseScope) => users.get(key(username, scope)),
    assertUserIncarnation: (user: SsoUserRecord, scope: EnterpriseScope): void => {
      fenceHook?.();
      if (user.enterpriseId !== scope.enterpriseId || users.get(key(user.ssoUser, scope))?.userIncarnation !== user.userIncarnation) throw new Error('user_incarnation_conflict');
    },
  } });
  saml = await import('./saml.js');
  const { createSamlRouter } = await import('../routes/samlRoutes.js');
  app.use(`/profiles/${A}`, createSamlRouter(scopes[0]!));
  app.use(`/profiles/${B}`, createSamlRouter(scopes[1]!));
  app.use(createSamlRouter(scopes[0]!, true));
  app.use((_req, res) => res.status(404).send('not found'));
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  mock.restoreAll();
  if (secretDir) rmSync(secretDir, { recursive: true, force: true });
});

function xml(scope: EnterpriseScope, extra = '', id = `_${randomUUID()}`): string {
  return `<p:AuthnRequest xmlns:p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:a="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${scope.profile.sso.ssoUrl}" AssertionConsumerServiceURL="${scope.profile.sso.spAcsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ${extra}><a:Issuer>${scope.profile.sso.spEntityId}</a:Issuer></p:AuthnRequest>`;
}
function encoded(raw: string, binding: 'redirect' | 'post' = 'redirect'): string {
  return (binding === 'redirect' ? deflateRawSync(Buffer.from(raw)) : Buffer.from(raw)).toString('base64');
}
function fields(html: string): Record<string, string> {
  const document = new DOMParser({ errorHandler: { warning: () => undefined } }).parseFromString(html, 'text/html');
  return Object.fromEntries(Array.from(document.getElementsByTagName('input')).map(input => [input.getAttribute('name')!, input.getAttribute('value')!]));
}
function responseXml(html: string): string { return Buffer.from(fields(html).SAMLResponse!, 'base64').toString('utf8'); }
function verifySignature(raw: string, certificate: string): void {
  const doc = new DOMParser().parseFromString(raw, 'text/xml');
  const signatures = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
  assert.equal(signatures.length, 2, 'response and assertion must both be signed');
  for (const signature of Array.from(signatures)) {
    const verifier = new SignedXml({ publicCert: certificate, getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature);
    assert.equal(verifier.checkSignature(raw), true);
  }
}
class Browser {
  private cookies = new Map<string, string>();
  async request(path: string, form?: Record<string, string> | string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, { method: form === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
      cookie: [...this.cookies.values()].join('; '), ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded', origin: baseUrl }), ...extraHeaders,
    }, body: form === undefined ? undefined : typeof form === 'string' ? form : new URLSearchParams(form) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!;
      const name = pair.split('=')[0]!;
      if (/Max-Age=0(?:;|$)/.test(cookie)) this.cookies.delete(name); else this.cookies.set(name, pair);
    }
    return response;
  }
  async begin(scope: EnterpriseScope, extra = '', relay = '', legacy = false): Promise<{ tx: string; csrf: string; [key: string]: string }> {
    const path = legacy ? '/sso' : `/profiles/${scope.enterpriseId}/sso`;
    const response = await this.request(`${path}?${new URLSearchParams({ SAMLRequest: encoded(xml(scope, extra)), RelayState: relay })}`);
    assert.equal(response.status, 302);
    const page = await this.request(response.headers.get('location')!);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    assert.match(page.headers.get('content-security-policy') ?? '', /style-src 'nonce-/);
    return fields(await page.text()) as { tx: string; csrf: string };
  }
  async login(scope: EnterpriseScope, form: Record<string, string>, legacy = false): Promise<Response> {
    return this.request(legacy ? '/login' : `/profiles/${scope.enterpriseId}/login`, { ...form, username: 'same-user', password: `password-${scope.enterpriseId}` });
  }
}

test('legacy metadata and profile metadata preserve configured identity, endpoints and distinct signing certificates', async () => {
  for (const scope of scopes) {
    const response = await fetch(`${baseUrl}/profiles/${scope.enterpriseId}/metadata`);
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.ok(raw.includes(`entityID="${scope.profile.sso.entityId}"`));
    assert.ok(raw.includes(scope.profile.sso.ssoUrl));
    assert.ok(raw.includes(certs[scope.enterpriseId]!.replace(/-----[^-]+-----|\s/g, '')));
    assert.ok(!raw.includes(certs[scope.enterpriseId === A ? B : A]!.replace(/-----[^-]+-----|\s/g, '')));
  }
  assert.equal(await (await fetch(`${baseUrl}/metadata`)).text(), saml.metadataXml(scopes[0]!));
  assert.equal((await fetch(`${baseUrl}/profiles/${randomUUID()}/metadata`)).status, 404);
});

test('strict bounded AuthnRequest validation rejects wrong endpoints, ambiguity, XML attacks and unsupported bindings', async () => {
  const scope = scopes[0]!;
  assert.equal((await saml.parseAuthnRequest({ SAMLRequest: encoded(xml(scope, 'ForceAuthn="1"')) }, 'redirect', scope)).forceAuthn, true);
  assert.equal((await saml.parseAuthnRequest({ SAMLRequest: encoded(xml(scope), 'post') }, 'post', scope)).forceAuthn, false);
  const valid = xml(scope);
  const bad = [
    valid.replace(scope.profile.sso.spEntityId, scopes[1]!.profile.sso.spEntityId),
    valid.replace(`Destination="${scope.profile.sso.ssoUrl}"`, `Destination="${scopes[1]!.profile.sso.ssoUrl}"`),
    valid.replace(scope.profile.sso.spAcsUrl, `${baseUrl}/attacker`),
    valid.replace('bindings:HTTP-POST', 'bindings:HTTP-Redirect'),
    valid.replace(/ ID="[^"]+"/, ''), valid.replace(/ ID="[^"]+"/, ' ID="9bad"'),
    valid.replace('Version="2.0"', 'Version="1.1"'), valid.replace(/ IssueInstant="[^"]+"/, ' IssueInstant="2001-01-01T00:00:00Z"'),
    valid.replace(/ AssertionConsumerServiceURL="[^"]+"/, ''),
    valid.replace('</p:AuthnRequest>', `<a:Issuer>${scope.profile.sso.spEntityId}</a:Issuer></p:AuthnRequest>`),
    valid.replace('<a:Issuer>', '<wrong:Issuer xmlns:wrong="urn:wrong">').replace('</a:Issuer>', '</wrong:Issuer>'),
    valid.replace('Version="2.0"', 'Version="2.0" Version="2.0"'),
    valid.replace('Version="2.0"', 'Version="2.0" ForceAuthn="yes"'),
    `<!DOCTYPE p:AuthnRequest [<!ENTITY xxe SYSTEM "file:///never-read-synthetic">]>${valid}`,
    `<?processing forbidden?>${valid}`, valid.replace('</p:AuthnRequest>', '<broken></p:AuthnRequest>'),
    `${valid}${valid}`, valid.replace('Version="2.0"', 'Version="2.0" IsPassive="true"'),
    xml(scope).replace('</p:AuthnRequest>', '<p:Extensions>' + '<x>'.repeat(18) + '</x>'.repeat(18) + '</p:Extensions></p:AuthnRequest>'),
    ' '.repeat(100000),
  ];
  for (const raw of bad) await assert.rejects(saml.parseAuthnRequest({ SAMLRequest: encoded(raw) }, 'redirect', scope));
  for (const parameters of [
    { SAMLRequest: [encoded(valid), encoded(valid)] }, { SAMLRequest: encoded(valid), RelayState: ['a', 'b'] },
    { SAMLRequest: encoded(valid), RelayState: 'x'.repeat(81) }, { SAMLRequest: '!!!' },
    { SAMLRequest: encoded(valid), enterpriseId: B }, { SAMLRequest: encoded(valid), SigAlg: 'bad' },
  ]) await assert.rejects(saml.parseAuthnRequest(parameters, 'redirect', scope));
  await assert.rejects(saml.parseAuthnRequest({ SAMLRequest: Buffer.from([0xff, 0xfe]).toString('base64') }, 'post', scope));
});

test('synthetic RequestedAuthnContext accepts only exact PasswordProtectedTransport with strict structure', async () => {
  // These are synthetic standard requests, not evidence of GitHub-emitted XML.
  const scope = scopes[0]!;
  const classUri = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
  const classRef = `<a:AuthnContextClassRef>${classUri}</a:AuthnContextClassRef>`;
  const context = (children = classRef, comparison = ' Comparison="exact"') => `<p:RequestedAuthnContext${comparison}>${children}</p:RequestedAuthnContext>`;
  const request = (child: string) => xml(scope).replace('</p:AuthnRequest>', `${child}</p:AuthnRequest>`);
  for (const binding of ['redirect', 'post'] as const) {
    for (const comparison of [' Comparison="exact"', '']) {
      const parsed = await saml.parseAuthnRequest({ SAMLRequest: encoded(request(context(classRef, comparison)), binding) }, binding, scope);
      assert.ok(parsed.id); // Omitted Comparison defaults to exact in the standard.
    }
  }
  const bad = [
    ...['minimum', 'maximum', 'better', 'unsupported', ''].map(value => context(classRef, ` Comparison="${value}"`)),
    context(classRef.replace('PasswordProtectedTransport', 'SmartcardPKI')),
    context(classRef.replace('PasswordProtectedTransport', 'TimeSyncToken')),
    context(classRef.replace('PasswordProtectedTransport', 'Password')),
    context(classRef.replace(classUri, 'urn:synthetic:unsupported')),
    context(''), context(classRef + classRef), context() + context(),
    context(`<a:AuthnContextDeclRef>${classUri}</a:AuthnContextDeclRef>`),
    context(classRef.replaceAll('a:AuthnContextClassRef', 'p:AuthnContextClassRef')),
    context().replaceAll('p:RequestedAuthnContext', 'a:RequestedAuthnContext'),
    context(`<a:AuthnContextClassRef><a:Issuer>${classUri}</a:Issuer></a:AuthnContextClassRef>`),
    context(`<a:AuthnContextClassRef xmlns:a="urn:wrong">${classUri}</a:AuthnContextClassRef>`),
    `<p:Extensions>${context()}</p:Extensions>`,
  ];
  for (const child of bad) await assert.rejects(saml.parseAuthnRequest({ SAMLRequest: encoded(request(child)) }, 'redirect', scope));
  const post = await saml.buildSamlResponse(users.get(key('same-user', scope))!, '_synthetic_context', undefined, scope);
  const response = new DOMParser().parseFromString(Buffer.from(post.samlResponse, 'base64').toString('utf8'), 'text/xml');
  assert.equal(response.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'AuthnContextClassRef')[0]?.textContent, classUri);
});

test('two same-name users receive independently signed audience/recipient responses; RelayState is opaque', async () => {
  const browser = new Browser();
  for (const scope of scopes) {
    const relay = `/profiles/${scope.enterpriseId === A ? B : A}/logout`;
    const form = await browser.begin(scope, '', relay);
    const result = await browser.login(scope, form);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-security-policy')!, /script-src 'nonce-/);
    const body = await result.text(), raw = responseXml(body);
    assert.equal(fields(body).RelayState, relay);
    verifySignature(raw, certs[scope.enterpriseId]!);
    const document = new DOMParser().parseFromString(raw, 'text/xml');
    assert.equal(document.documentElement.getAttribute('Destination'), scope.profile.sso.spAcsUrl);
    assert.equal(document.getElementsByTagNameNS('*', 'Audience')[0]?.textContent, scope.profile.sso.spEntityId);
    assert.equal(document.getElementsByTagNameNS('*', 'SubjectConfirmationData')[0]?.getAttribute('Recipient'), scope.profile.sso.spAcsUrl);
    assert.equal(document.getElementsByTagNameNS('*', 'NameID')[0]?.textContent, 'same-user');
    assert.ok(raw.includes(`${scope.enterpriseId}@synthetic.invalid`));
    assert.ok(!raw.includes(`${scope.enterpriseId === A ? B : A}@synthetic.invalid`));
    const signed = new DOMParser().parseFromString(raw, 'text/xml').getElementsByTagNameNS('*', 'Signature')[0]!;
    const wrong = new SignedXml({ publicCert: certs[scope.enterpriseId === A ? B : A]!, getCertFromKeyInfo: () => null });
    wrong.loadSignature(signed);
    assert.throws(() => { if (!wrong.checkSignature(raw)) throw new Error('wrong certificate'); });
  }
});

test('multitab requests keep independent IDs/RelayState; form replay and cross-session/enterprise CSRF are rejected', async () => {
  const browser = new Browser(), stranger = new Browser();
  const [a, b] = scopes as [EnterpriseScope, EnterpriseScope];
  const first = await browser.begin(a, '', 'first'), second = await browser.begin(a, '', 'second');
  assert.equal((await stranger.login(a, first)).status, 400);
  assert.equal((await browser.login(b, first)).status, 400);
  assert.equal((await browser.login(a, { ...first, csrf: second.csrf })).status, 400);
  const one = await browser.login(a, first), two = await browser.login(a, second);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  const oneBody = await one.text(), twoBody = await two.text();
  assert.equal(fields(oneBody).RelayState, 'first'); assert.equal(fields(twoBody).RelayState, 'second');
  const id1 = new DOMParser().parseFromString(responseXml(oneBody), 'text/xml').documentElement.getAttribute('InResponseTo');
  const id2 = new DOMParser().parseFromString(responseXml(twoBody), 'text/xml').documentElement.getAttribute('InResponseTo');
  assert.notEqual(id1, id2);
  assert.equal((await browser.login(a, first)).status, 400);
  const fresh = await browser.begin(a, 'ForceAuthn="true"');
  const [x, y] = await Promise.all([browser.login(a, fresh), browser.login(a, fresh)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 400]);
});

test('ForceAuthn and logout require fresh authentication/CSRF and leave the other enterprise session intact', async () => {
  const browser = new Browser();
  const [a, b] = scopes as [EnterpriseScope, EnterpriseScope];
  for (const scope of scopes) assert.equal((await browser.login(scope, await browser.begin(scope))).status, 200);
  const bFast = await browser.request(`/profiles/${B}/sso?SAMLRequest=${encodeURIComponent(encoded(xml(b)))}`);
  assert.equal(bFast.status, 200);
  const force = await browser.begin(a, 'ForceAuthn="true"');
  assert.equal((await browser.request(`/profiles/${B}/sso?SAMLRequest=${encodeURIComponent(encoded(xml(b)))}`)).status, 200);
  assert.equal((await browser.login(a, force)).status, 200);
  assert.equal((await browser.request(`/profiles/${A}/logout`, {})).status, 400);
  const logout = fields(await (await browser.request(`/profiles/${A}/logout`)).text());
  assert.equal((await browser.request(`/profiles/${A}/logout`, logout, { origin: 'https://attacker.invalid' })).status, 400);
  assert.equal((await browser.request(`/profiles/${A}/logout`, logout)).status, 302);
  assert.equal((await browser.request(`/profiles/${A}/sso?SAMLRequest=${encodeURIComponent(encoded(xml(a)))}`)).status, 302);
  assert.equal((await browser.request(`/profiles/${B}/sso?SAMLRequest=${encodeURIComponent(encoded(xml(b)))}`)).status, 200);
});

test('POST binding, duplicate parameter rejection, legacy alias replay and bounded form handling', async () => {
  const browser = new Browser(), scope = scopes[0]!;
  const request = encoded(xml(scope));
  assert.equal((await browser.request(`/sso?SAMLRequest=${encodeURIComponent(request)}&SAMLRequest=${encodeURIComponent(request)}`)).status, 400);
  assert.equal((await browser.request('/sso', { SAMLRequest: encoded(xml(scope), 'post') })).status, 302);
  assert.equal((await browser.request('/sso', `SAMLRequest=${encodeURIComponent(encoded(xml(scope), 'post'))}&RelayState=a&RelayState=b`)).status, 400);
  assert.equal((await browser.request(`/sso?SAMLRequest=${encodeURIComponent(request)}`)).status, 302);
  assert.equal((await browser.request(`/profiles/${A}/sso?SAMLRequest=${encodeURIComponent(request)}`)).status, 400);
  assert.equal((await browser.request('/sso?RelayState=/profiles/anything')).status, 400);
  const f = await browser.begin(scope, '', 'legacy', true);
  assert.equal((await browser.request('/login', new URLSearchParams({ ...f, username: 'same-user', password: `password-${A}` }).toString() + '&username=other')).status, 400);
  assert.equal((await browser.login(scope, f, true)).status, 200);
  assert.equal((await browser.request('/login', { password: 'x'.repeat(110000) })).status, 400);
  assert.equal((await browser.request('/login', '{}', { 'content-type': 'application/json' })).status, 415);
});

test('delete/recreate and revision fencing prevent stale authentication from completing', async () => {
  const scope = scopes[1]!, browser = new Browser();
  assert.equal((await browser.login(scope, await browser.begin(scope))).status, 200);
  const original = users.get(key('same-user', scope))!;
  users.set(key('same-user', scope), { ...original, userIncarnation: randomUUID() });
  assert.equal((await browser.request(`/profiles/${B}/sso?SAMLRequest=${encodeURIComponent(encoded(xml(scope)))}`)).status, 302);
  const form = await browser.begin(scope);
  fenceHook = () => { fenceHook = undefined; users.set(key('same-user', scope), { ...original, userIncarnation: randomUUID() }); };
  const failed = await browser.login(scope, form);
  assert.equal(failed.status, 400);
  assert.ok(!(await failed.text()).includes('SAMLResponse'));
  assert.equal((await browser.login(scope, form)).status, 400);
  scopesEnabled = false;
  await assert.rejects(saml.buildSamlResponse(original, '_request', undefined, scope));
  scopesEnabled = true;
});
