import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegistry, type EnterpriseProfile, type ParseRegistryOptions } from './registry.js';
import { ACCOUNT_NAME_CAPACITY, EnterpriseRegistryError } from './registryFields.js';

type Json = Record<string, unknown>;

const DESIGN_EXAMPLE = {
  version: 1,
  enterprises: [
    {
      id: 'default',
      displayName: 'Acme (github.com)',
      github: {
        baseUrl: 'https://github.com',
        apiBaseUrl: 'https://api.github.com',
        copilotApiBaseUrl: 'https://api.githubcopilot.com',
        slug: 'acme',
        shortcode: 'octo',
        oauthClientId: 'Ov23li8tweQw6odWQebz',
      },
      sso: {
        spEntityId: 'https://github.com/enterprises/acme',
        spAcsUrl: 'https://github.com/enterprises/acme/saml/consume',
        scimBaseUrl: 'https://api.github.com/scim/v2/enterprises/acme',
        emailDomain: 'acme.example.com',
        userPrefix: 'ghcp',
        signingCert: { file: '/certs/idp-cert.pem' },
        signingKey: { file: '/certs/idp-key.pem' },
        sessionSecret: { env: 'SESSION_SECRET' },
        scimToken: { env: 'SCIM_TOKEN' },
        seatPat: { env: 'GITHUB_COPILOT_SEAT_PAT' },
        defaultUserPassword: { env: 'SSO_DEFAULT_USER_PASSWORD' },
      },
      login: {
        ssoProvider: 'custom',
        ssoLoginUrl: 'http://sso:7001/login',
        allowedLoginUrls: ['http://sso:7001/login'],
      },
      pool: { accountDomain: 'pool.acme.example.com', initialMaxAccounts: 300 },
      modelsAdmin: {
        githubLogin: 'acme-admin_octo',
        githubUserId: '101',
        copilotToken: { file: '/run/secrets/acme/models-admin-token' },
      },
    },
    {
      id: 'contoso-eu',
      displayName: 'Contoso EU (GHE.com)',
      github: {
        baseUrl: 'https://contoso.ghe.com',
        apiBaseUrl: 'https://api.contoso.ghe.com',
        copilotApiBaseUrl: 'https://copilot-api.contoso.ghe.com',
        slug: 'contoso',
        shortcode: '',
      },
      sso: {
        spEntityId: 'https://contoso.ghe.com/enterprises/contoso',
        spAcsUrl: 'https://contoso.ghe.com/enterprises/contoso/saml/consume',
        scimBaseUrl: 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso',
        emailDomain: 'contoso.example.eu',
        userPrefix: 'ghcp',
        signingCert: { file: '/run/secrets/contoso/idp-cert.pem' },
        signingKey: { file: '/run/secrets/contoso/idp-key.pem' },
        sessionSecret: { file: '/run/secrets/contoso/session-secret' },
        scimToken: { file: '/run/secrets/contoso/scim-token' },
        seatPat: { file: '/run/secrets/contoso/seat-pat' },
        defaultUserPassword: { file: '/run/secrets/contoso/default-password' },
      },
      login: {
        ssoProvider: 'custom',
        ssoLoginUrl: 'http://sso:7001/enterprises/contoso-eu/login',
        allowedLoginUrls: ['http://sso:7001/enterprises/contoso-eu/login'],
      },
      pool: { accountDomain: 'pool.contoso.example.eu', initialMaxAccounts: 200 },
      modelsAdmin: { githubLogin: 'contoso-admin', copilotToken: { env: 'CONTOSO_MODELS_ADMIN_TOKEN' } },
    },
  ],
};

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

test('parses the design example; explicit values equal the derived defaults', () => {
  const registry = parseRegistry(JSON.stringify(DESIGN_EXAMPLE));
  const derived = parseRegistry(registryOf(
    { ...githubCom('default'), github: { baseUrl: 'https://github.com', slug: 'acme', shortcode: 'octo' } },
    gheCom('contoso-eu', { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' }),
  ), { ssoUrl: 'http://sso:7001/login' });
  for (const [index, profile] of registry.enterprises.entries()) {
    const defaults = derived.enterprises[index];
    assert.equal(defaults.github.apiBaseUrl, profile.github.apiBaseUrl);
    assert.equal(defaults.github.copilotApiBaseUrl, profile.github.copilotApiBaseUrl);
    assert.equal(defaults.sso.spEntityId, profile.sso.spEntityId);
    assert.equal(defaults.sso.spAcsUrl, profile.sso.spAcsUrl);
    assert.equal(defaults.sso.scimBaseUrl, profile.sso.scimBaseUrl);
    assert.equal(defaults.login.ssoLoginUrl, profile.login.ssoLoginUrl);
    assert.deepEqual(defaults.login.allowedLoginUrls, profile.login.allowedLoginUrls);
  }
  assert.equal(registry.enterprises[1].github.shortcode, '');
  assert.deepEqual(registry.enterprises[1].modelsAdmin?.copilotToken, { env: 'CONTOSO_MODELS_ADMIN_TOKEN' });
  assert.deepEqual(registry.warnings, []);
  assert.deepEqual(parseRegistry(DESIGN_EXAMPLE, { service: 'sso' }).enterprises.flatMap((p) => p.blockers), []);
});

test('the result is deep-frozen', () => {
  const registry = parseRegistry(DESIGN_EXAMPLE);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.enterprises));
  assert.ok(Object.isFrozen(registry.enterprises[0].sso.signingCert));
  assert.ok(Object.isFrozen(registry.enterprises[0].login.allowedLoginUrls));
});

test('structure: unknown fields, version and enterprise count fail closed', () => {
  rejects('{', 'registry');
  rejects([], 'registry');
  rejects({ ...registryOf(githubCom('acme')), extra: true }, 'extra');
  rejects({ version: 2, enterprises: [githubCom('acme')] }, 'version');
  rejects(registryOf(), 'enterprises');
  rejects(registryOf(...Array.from({ length: 33 }, (_, index) => githubCom(`e${index}`))), 'enterprises');
  const thirtyTwo = Array.from({ length: 32 }, (_, index) => githubCom(`e${index}`));
  assert.equal(parseRegistry(registryOf(...thirtyTwo)).enterprises.length, 32);
  rejects(registryOf(githubCom('acme', { routes: {} })), 'acme.routes');
  rejects(registryOf(githubCom('acme', { github: { baseUrl: 'https://github.com', proxyInternalUrl: 'x' } })),
    'acme.github.proxyInternalUrl');
  rejects(registryOf(githubCom('acme', { login: { selectors: { unknownSelector: '#x' } } })),
    'acme.login.selectors.unknownSelector');
  rejects(registryOf(githubCom('acme', { sso: 'x' })), 'acme.sso');
  rejects(registryOf(githubCom('acme', { __proto__: null, displayName: 7 })), 'acme.displayName');
  rejects(registryOf({ id: 'acme' }), 'acme.github.baseUrl');
});

test('enterprise IDs must match ^[a-z][a-z0-9-]{0,30}[a-z0-9]$', () => {
  for (const id of ['Default', '1abc', '-abc', 'abc-', 'a', 'a_b', 'a'.repeat(33), 7]) {
    rejects(registryOf({ id, github: { baseUrl: 'https://github.com' } }), 'enterprises[0].id');
  }
  for (const id of ['ab', 'a1', 'contoso-eu', 'a'.repeat(32)]) {
    assert.equal(only(registryOf({ id, github: { baseUrl: 'https://github.com' } })).id, id);
  }
});

test('uniqueness of id, slug per GitHub instance, account domain and login URL', () => {
  rejects(registryOf(githubCom('acme'), githubCom('acme')), 'acme.id');
  const sameSlug = { id: 'beta', github: { baseUrl: 'https://github.com/', slug: 'ACME', shortcode: 'beta' } };
  rejects(registryOf(githubCom('acme'), sameSlug), 'beta.github.slug');
  const otherInstance = { id: 'beta', github: { baseUrl: 'https://acme.ghe.com', slug: 'acme' } };
  assert.equal(parseRegistry(registryOf(githubCom('acme'), otherInstance)).enterprises.length, 2);
  const domain = (id: string, accountDomain: string) => githubCom(id, { pool: { accountDomain } });
  rejects(registryOf(domain('acme', 'pool.example.com'), domain('beta', 'POOL.example.com')),
    'beta.pool.accountDomain');
  const login = (id: string, ssoLoginUrl: string) => githubCom(id, { login: { ssoLoginUrl } });
  rejects(registryOf(login('acme', 'http://sso:7001/login'), login('beta', 'http://SSO:7001/login/')),
    'beta.login.ssoLoginUrl');
  rejects(registryOf(githubCom('default'), login('beta', 'http://sso:7001/login')), 'beta.login.ssoLoginUrl',
    { ssoUrl: 'http://sso:7001/login' });
});

test('URL attacks inside registry fields fail closed with the field path', () => {
  rejects(registryOf({ id: 'acme', github: { baseUrl: 'https://user@github.com' } }), 'acme.github.baseUrl');
  rejects(registryOf({ id: 'acme', github: { baseUrl: 'https://github.com/enterprises' } }), 'acme.github.baseUrl');
  rejects(registryOf(githubCom('acme', { sso: { spAcsUrl: 'https://github.com/a/../b' } })), 'acme.sso.spAcsUrl');
  rejects(registryOf(githubCom('acme', { login: { ssoLoginUrl: 'http://sso/%2e%2e/x?y' } })), 'acme.login.ssoLoginUrl');
  rejects(registryOf(githubCom('acme', { login: { allowedLoginUrls: ['http://sso/ok', 'http://sso/%2e'] } })),
    'acme.login.allowedLoginUrls');
});

test('capacity: initial caps sum to at most 10,000 accounts', () => {
  const capped = (id: string, initialMaxAccounts: number) => githubCom(id, { pool: { initialMaxAccounts } });
  assert.equal(ACCOUNT_NAME_CAPACITY, 10_000);
  assert.equal(parseRegistry(registryOf(capped('acme', 9_000), capped('beta', 1_000))).enterprises.length, 2);
  rejects(registryOf(capped('acme', 9_000), capped('beta', 1_001)), 'pool.initialMaxAccounts');
  rejects(registryOf(githubCom('default'), capped('beta', 9_901)), 'pool.initialMaxAccounts');
  for (const value of [0, -1, 1.5, 10_001, '5', null]) {
    rejects(registryOf(githubCom('acme', { pool: { initialMaxAccounts: value } })), 'acme.pool.initialMaxAccounts');
  }
});
