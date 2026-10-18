import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegistry, type EnterpriseProfile, type ParseRegistryOptions } from './registry.js';
import { EnterpriseRegistryError } from './registryFields.js';

type Json = Record<string, unknown>;

function registryOf(...enterprises: Json[]): Json {
  return { version: 1, enterprises };
}

function githubCom(id: string, extra: Json = {}): Json {
  return { id, github: { baseUrl: 'https://github.com', slug: id, shortcode: 'octo' }, ...extra };
}

function gheCom(id: string, github: Json = {}): Json {
  return { id, github: { baseUrl: `https://${id}.ghe.com`, slug: id, ...github } };
}

function only(json: Json, options: ParseRegistryOptions = {}): EnterpriseProfile {
  return parseRegistry(json, options).enterprises[0];
}

function rejects(json: unknown, field: string | RegExp, options: ParseRegistryOptions = {}): void {
  assert.throws(() => parseRegistry(json, options), (error: unknown) => {
    if (!(error instanceof EnterpriseRegistryError)) return false;
    assert.equal(error.code, 'enterprise_registry_invalid');
    if (typeof field === 'string') assert.equal(error.field, field);
    else assert.match(error.field, field);
    return true;
  });
}

test('derives github.com and GHE.com defaults (design §3.3)', () => {
  const [acme, contoso] = parseRegistry(registryOf(githubCom('acme'), gheCom('contoso'))).enterprises;
  assert.deepEqual(acme, {
    id: 'acme',
    displayName: 'acme',
    github: {
      baseUrl: 'https://github.com',
      host: 'github.com',
      isGheCom: false,
      apiBaseUrl: 'https://api.github.com',
      copilotApiBaseUrl: 'https://api.githubcopilot.com',
      slug: 'acme',
      shortcode: 'octo',
    },
    sso: {
      spEntityId: 'https://github.com/enterprises/acme',
      spAcsUrl: 'https://github.com/enterprises/acme/saml/consume',
      scimBaseUrl: 'https://api.github.com/scim/v2/enterprises/acme',
    },
    login: { ssoProvider: 'custom', allowedLoginUrls: [], selectors: {} },
    pool: { initialMaxAccounts: 10 },
    blockers: [],
  });
  assert.equal(contoso.github.apiBaseUrl, 'https://api.contoso.ghe.com');
  assert.equal(contoso.github.copilotApiBaseUrl, 'https://copilot-api.contoso.ghe.com');
  assert.equal(contoso.github.shortcode, '');
  assert.equal(contoso.sso.scimBaseUrl, 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso');
  assert.equal(contoso.sso.spAcsUrl, 'https://contoso.ghe.com/enterprises/contoso/saml/consume');
});

test('GHE.com defaults keep the scheme and port of mock hosts', () => {
  const profile = only(registryOf({ id: 'fixture', github: { baseUrl: 'http://fixture.ghe.com:8002/' } }));
  assert.equal(profile.github.baseUrl, 'http://fixture.ghe.com:8002');
  assert.equal(profile.github.apiBaseUrl, 'http://api.fixture.ghe.com:8002');
  assert.equal(profile.github.copilotApiBaseUrl, 'http://copilot-api.fixture.ghe.com:8002');
});

test('default enterprise starts with 100 accounts, others with 10, unless configured', () => {
  const [first, second, third] = parseRegistry(registryOf(
    githubCom('default'),
    githubCom('acme'),
    githubCom('beta', { pool: { initialMaxAccounts: 42 } }),
  )).enterprises;
  assert.deepEqual([first.pool, second.pool, third.pool].map((pool) => pool.initialMaxAccounts), [100, 10, 42]);
});

test('login URLs default from SSO_URL: the URL itself for default, /enterprises/<id>/login otherwise', () => {
  const options = { ssoUrl: 'http://sso:7001/login', oauthClientId: 'client', selectors: { ssoSubmit: '#go' } };
  const [first, second] = parseRegistry(registryOf(githubCom('default'), githubCom('acme')), options).enterprises;
  assert.equal(first.login.ssoLoginUrl, 'http://sso:7001/login');
  assert.equal(second.login.ssoLoginUrl, 'http://sso:7001/enterprises/acme/login');
  assert.deepEqual(second.login.allowedLoginUrls, ['http://sso:7001/enterprises/acme/login']);
  assert.equal(second.github.oauthClientId, 'client');
  assert.deepEqual(second.login.selectors, { ssoSubmit: '#go' });
  rejects(registryOf(githubCom('acme')), 'SSO_URL', { ssoUrl: 'http://sso:7001/login?next=x' });
});

test('profile values override global login defaults', () => {
  const entry = githubCom('acme', {
    github: { baseUrl: 'https://github.com', shortcode: 'octo', oauthClientId: 'own' },
    login: { ssoProvider: 'azure', selectors: { ssoSubmit: '#mine' } },
  });
  const selectors = { ssoSubmit: '#go', ssoUsernameInput: '#u' };
  const profile = only(registryOf(entry), { oauthClientId: 'global', selectors });
  assert.equal(profile.github.oauthClientId, 'own');
  assert.equal(profile.login.ssoProvider, 'azure');
  assert.deepEqual(profile.login.selectors, { ssoUsernameInput: '#u', ssoSubmit: '#mine' });
});

test('allowedLoginUrls must contain ssoLoginUrl, compared by exact segments, and has at most 16 entries', () => {
  const login = (ssoLoginUrl: string, allowedLoginUrls: string[]) => registryOf(githubCom('acme', {
    login: { ssoLoginUrl, allowedLoginUrls },
  }));
  assert.ok(only(login('http://sso:7001/login', ['http://SSO:7001/login/'])));
  rejects(login('http://sso:7001/login', ['http://sso:7001/log']), 'acme.login.allowedLoginUrls');
  rejects(login('http://sso:7001/login', ['http://sso:7001/login/x']), 'acme.login.allowedLoginUrls');
  rejects(login('http://sso:7001/a', ['http://sso:7001/ab']), 'acme.login.allowedLoginUrls');
  const many = Array.from({ length: 17 }, (_, index) => `http://sso:7001/${index}`);
  rejects(login('http://sso:7001/1', many), 'acme.login.allowedLoginUrls');
});

test('GHE.com: shortcode must be empty, hosts must stay under the same <sub>.ghe.com', () => {
  assert.equal(only(registryOf(gheCom('contoso', { shortcode: '' }))).github.shortcode, '');
  rejects(registryOf(gheCom('contoso', { shortcode: 'octo' })), 'contoso.github.shortcode');
  rejects(registryOf(gheCom('contoso', { apiBaseUrl: 'https://api.github.com' })), 'contoso.github.apiBaseUrl');
  rejects(registryOf(gheCom('contoso', { apiBaseUrl: 'https://api.fabrikam.ghe.com' })), 'contoso.github.apiBaseUrl');
  rejects(registryOf(gheCom('contoso', { apiBaseUrl: 'https://apicontoso.ghe.com' })), 'contoso.github.apiBaseUrl');
  rejects(registryOf(gheCom('contoso', { copilotApiBaseUrl: 'https://api.githubcopilot.com' })),
    'contoso.github.copilotApiBaseUrl');
  const fixture = { baseUrl: 'http://fixture.ghe.com:8002', apiBaseUrl: 'http://api.fixture.ghe.com:8002' };
  assert.equal(only(registryOf(gheCom('fixture', fixture))).github.apiBaseUrl, 'http://api.fixture.ghe.com:8002');
});

test('GHE.com: a missing slug blocks SSO and Login but not the Proxy', () => {
  const json = registryOf({ id: 'contoso', github: { baseUrl: 'https://contoso.ghe.com' } });
  const missingSlug = [{ code: 'enterprise_field_missing', field: 'github.slug' }];
  assert.deepEqual(only(json, { service: 'login' }).blockers, missingSlug);
  assert.deepEqual(only(json, { service: 'proxy' }).blockers, []);
  assert.ok(only(json, { service: 'sso' }).blockers.some((blocker) => blocker.field === 'github.slug'));
  assert.equal(only(json, { service: 'sso' }).sso.spEntityId, undefined);
});

test('github.com: shortcode (lower-cased) must match ^[a-z0-9]{3,8}$; a missing one blocks Proxy and SSO only', () => {
  for (const shortcode of ['', 'ab', 'abcdefghi', 'oc_to', 7]) {
    rejects(registryOf({ id: 'acme', github: { baseUrl: 'https://github.com', shortcode } }), 'acme.github.shortcode');
  }
  assert.equal(only(registryOf(githubCom('acme'))).github.shortcode, 'octo');
  const json = registryOf({ id: 'acme', github: { baseUrl: 'https://github.com', slug: 'acme' } });
  const missing = { code: 'enterprise_field_missing', field: 'github.shortcode' };
  assert.deepEqual(only(json, { service: 'proxy' }).blockers, [missing]);
  assert.deepEqual(only(json, { service: 'login' }).blockers, []);
  assert.ok(only(json, { service: 'sso' }).blockers.some((blocker) => blocker.field === 'github.shortcode'));
});

test('github.com: an explicit apiBaseUrl is a trusted http(s) URL and may carry a gateway path', () => {
  const mock = { baseUrl: 'https://github.com', shortcode: 'octo', apiBaseUrl: 'http://mock:8002/' };
  assert.equal(only(registryOf({ id: 'acme', github: mock })).github.apiBaseUrl, 'http://mock:8002');
  const gateway = { ...mock, copilotApiBaseUrl: 'https://gw.example.test/copilot/' };
  assert.equal(only(registryOf({ id: 'acme', github: gateway })).github.copilotApiBaseUrl,
    'https://gw.example.test/copilot');
  rejects(registryOf({ id: 'acme', github: { ...mock, apiBaseUrl: 'http://mock:8002/a/../b' } }),
    'acme.github.apiBaseUrl');
  rejects(registryOf({ id: 'acme', github: { ...mock, apiBaseUrl: 'ftp://mock' } }), 'acme.github.apiBaseUrl');
});

test('SSO blockers list the missing required fields; pool mode requires an account domain', () => {
  const json = registryOf(githubCom('acme'));
  assert.deepEqual(only(json, { service: 'sso' }).blockers.map((blocker) => blocker.field),
    ['sso.signingCert', 'sso.signingKey', 'sso.sessionSecret']);
  assert.deepEqual(only(json, { service: 'proxy', poolMode: true }).blockers.map((blocker) => blocker.field),
    ['pool.accountDomain']);
  assert.deepEqual(only(json, { service: 'proxy', poolMode: false }).blockers, []);
  assert.deepEqual(only(json).blockers, []);
});
