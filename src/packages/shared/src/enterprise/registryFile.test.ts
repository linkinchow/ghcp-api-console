import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ServiceEnv } from './defaultFromEnv.js';
import type { EnterpriseProfile, RegistryService } from './registry.js';
import { EnterpriseRegistryError } from './registryFields.js';
import { loadRegistry } from './registryFile.js';

const REGISTRY_PATH = resolve('/etc/ghcp/enterprises.json');

function load(service: RegistryService, env: ServiceEnv, registry?: unknown) {
  const reads: string[] = [];
  const readFile = (path: string) => {
    reads.push(path);
    return JSON.stringify(registry);
  };
  const fileEnv = registry === undefined ? env : { ...env, ENTERPRISE_REGISTRY_FILE: REGISTRY_PATH };
  return { registry: loadRegistry({ service, env: fileEnv, readFile }), reads };
}

function defaultOf(service: RegistryService, env: ServiceEnv, registry?: unknown): EnterpriseProfile {
  const loaded = load(service, env, registry).registry;
  assert.equal(loaded.enterprises[0].id, 'default');
  return loaded.enterprises[0];
}

function conflict(service: RegistryService, env: ServiceEnv, registry: unknown, variable: string, field: string): void {
  assert.throws(() => load(service, env, registry), (error: unknown) => {
    if (!(error instanceof EnterpriseRegistryError)) return false;
    assert.equal(error.code, 'enterprise_env_conflict');
    assert.equal(error.field, field);
    assert.match(error.message, new RegExp(`^${variable} conflicts with ${field.replace('.', '\\.')}`));
    return true;
  });
}

const PROXY_ENV = {
  GITHUB_BASE_URL: 'https://github.com',
  GITHUB_API_BASE_URL: 'https://api.github.com',
  COPILOT_API_BASE_URL: 'https://api.githubcopilot.com',
  ENTERPRISE_SHORTCODE: 'octo',
  ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.com',
  POOL_MAX_ACCOUNTS: '300',
  MODELS_ADMIN_GITHUB_LOGIN: 'admin_octo',
  MODELS_ADMIN_GITHUB_USER_ID: '101',
  MODELS_ADMIN_COPILOT_TOKEN_FILE: '/run/secrets/models-admin-token',
};

const SSO_GHE_ENV = {
  SESSION_SECRET: 'ghe-fixture-session-only',
  GITHUB_BASE_URL: 'http://fixture.ghe.com:8002',
  ENTERPRISE_SLUG: 'local-test',
  ENTERPRISE_SHORTCODE: 'test',
  GITHUB_API_BASE_URL: 'http://api.fixture.ghe.com:8002',
  GITHUB_COPILOT_SEAT_PAT: 'ghe-fixture-seat-only',
  SCIM_BASE_URL: 'http://api.fixture.ghe.com:8002/scim/v2/enterprises/local-test',
  SCIM_TOKEN: 'ghe-fixture-scim-only',
  SP_ACS_URL: 'http://fixture.ghe.com:8002/enterprises/local-test/saml/consume',
  CERT_DIR: '/certs',
};

test('no registry file: Proxy default equals today\'s Proxy config', () => {
  const { registry, reads } = load('proxy', PROXY_ENV);
  assert.deepEqual(reads, []);
  assert.equal(registry.enterprises.length, 1);
  const profile = registry.enterprises[0];
  assert.deepEqual(profile.github, {
    baseUrl: 'https://github.com',
    host: 'github.com',
    isGheCom: false,
    apiBaseUrl: 'https://api.github.com',
    copilotApiBaseUrl: 'https://api.githubcopilot.com',
    shortcode: 'octo',
  });
  assert.deepEqual(profile.pool, { accountDomain: 'pool.example.com', initialMaxAccounts: 300 });
  assert.deepEqual(profile.modelsAdmin, {
    githubLogin: 'admin_octo',
    githubUserId: '101',
    copilotToken: { file: '/run/secrets/models-admin-token' },
  });
  assert.deepEqual(profile.blockers, []);
});

test('no registry file and no variables: every service falls back to today\'s built-in defaults', () => {
  const proxy = defaultOf('proxy', {});
  assert.equal(proxy.github.baseUrl, 'https://github.com');
  assert.equal(proxy.github.apiBaseUrl, 'https://api.github.com');
  assert.equal(proxy.github.copilotApiBaseUrl, 'https://api.githubcopilot.com');
  assert.equal(proxy.github.shortcode, 'octo');
  assert.equal(proxy.pool.initialMaxAccounts, 100);
  assert.equal(proxy.modelsAdmin, undefined);
  const sso = defaultOf('sso', {});
  assert.equal(sso.github.slug, 'acme');
  assert.equal(sso.github.shortcode, 'octo');
  assert.deepEqual(sso.sso, {
    spEntityId: 'https://github.com/enterprises/acme',
    spAcsUrl: 'http://localhost:8002/enterprises/acme/saml/consume',
    scimBaseUrl: 'http://localhost:8002/scim/v2/enterprises/acme',
    signingCert: { file: resolve('../../certs', 'idp-cert.pem') },
    signingKey: { file: resolve('../../certs', 'idp-key.pem') },
    sessionSecret: { env: 'SESSION_SECRET' },
  });
  assert.deepEqual(sso.blockers, []);
  const login = defaultOf('login', {});
  assert.equal(login.github.oauthClientId, 'Ov23li8tweQw6odWQebz');
  assert.equal(login.github.slug, undefined);
  assert.equal(login.login.ssoLoginUrl, undefined);
  assert.deepEqual(login.login.selectors, {});
});

test('no registry file: SSO default equals today\'s SSO config on the GHE.com fixture', () => {
  const { registry } = load('sso', SSO_GHE_ENV);
  const profile = registry.enterprises[0];
  assert.equal(profile.github.baseUrl, 'http://fixture.ghe.com:8002');
  assert.equal(profile.github.isGheCom, true);
  assert.equal(profile.github.shortcode, '');
  assert.equal(profile.github.slug, 'local-test');
  assert.equal(profile.github.apiBaseUrl, 'http://api.fixture.ghe.com:8002');
  assert.deepEqual(profile.sso, {
    spEntityId: 'http://fixture.ghe.com:8002/enterprises/local-test',
    spAcsUrl: SSO_GHE_ENV.SP_ACS_URL,
    scimBaseUrl: SSO_GHE_ENV.SCIM_BASE_URL,
    signingCert: { file: resolve('/certs', 'idp-cert.pem') },
    signingKey: { file: resolve('/certs', 'idp-key.pem') },
    sessionSecret: { env: 'SESSION_SECRET' },
    scimToken: { env: 'SCIM_TOKEN' },
    seatPat: { env: 'GITHUB_COPILOT_SEAT_PAT' },
  });
  assert.deepEqual(registry.warnings, ['ENTERPRISE_SHORTCODE is ignored on GHE.com.']);
  assert.deepEqual(profile.blockers, []);
});

test('no registry file: Login default equals today\'s Login config', () => {
  const profile = defaultOf('login', {
    GITHUB_BASE_URL: 'http://fixture.ghe.com:8002',
    ENTERPRISE_SLUG: 'local-test',
    SSO_URL: 'http://sso:7001/login',
    AUTH_SSO_SUBMIT_SELECTOR: 'button[type=submit]',
  });
  assert.equal(profile.github.baseUrl, 'http://fixture.ghe.com:8002');
  assert.equal(profile.github.slug, 'local-test');
  assert.equal(profile.github.oauthClientId, 'Ov23li8tweQw6odWQebz');
  assert.deepEqual(profile.login, {
    ssoLoginUrl: 'http://sso:7001/login',
    allowedLoginUrls: ['http://sso:7001/login'],
    selectors: { ssoSubmit: 'button[type=submit]' },
  });
});

test('registry without default: default comes from the environment and is listed first', () => {
  const contoso = { id: 'contoso-eu', github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' } };
  const env = { SSO_URL: 'http://sso:7001/login', GITHUB_OAUTH_CLIENT_ID: 'client' };
  const { registry, reads } = load('login', env, { version: 1, enterprises: [contoso] });
  assert.deepEqual(reads, [REGISTRY_PATH]);
  assert.deepEqual(registry.enterprises.map((profile) => profile.id), ['default', 'contoso-eu']);
  const [first, second] = registry.enterprises;
  assert.equal(first.login.ssoLoginUrl, 'http://sso:7001/login');
  assert.equal(second.login.ssoLoginUrl, 'http://sso:7001/enterprises/contoso-eu/login');
  assert.equal(second.github.oauthClientId, 'client');
});

test('registry with default: the entry and the environment merge field by field', () => {
  const registry = {
    version: 1,
    enterprises: [{ id: 'default', github: { baseUrl: 'https://github.com/', shortcode: 'octo' }, pool: {
      accountDomain: 'POOL.example.com',
    } }],
  };
  const profile = defaultOf('proxy', { ...PROXY_ENV, MODELS_ADMIN_COPILOT_TOKEN_FILE: '' }, registry);
  assert.equal(profile.pool.accountDomain, 'pool.example.com');
  assert.equal(profile.pool.initialMaxAccounts, 300);
  assert.equal(profile.modelsAdmin?.githubLogin, 'admin_octo');
  const partial = { version: 1, enterprises: [{ id: 'default', pool: { accountDomain: 'pool.example.com' } }] };
  assert.equal(defaultOf('proxy', {}, partial).github.baseUrl, 'https://github.com');
});

test('registry with default: a differing value on both sides is enterprise_env_conflict', () => {
  const entry = (extra: Record<string, unknown>) => ({ version: 1, enterprises: [{ id: 'default', ...extra }] });
  const shortcode = entry({ github: { baseUrl: 'https://github.com', shortcode: 'acme' } });
  conflict('proxy', { ENTERPRISE_SHORTCODE: 'octo' }, shortcode, 'ENTERPRISE_SHORTCODE',
    'default.github.shortcode');
  conflict('proxy', { GITHUB_BASE_URL: 'https://github.com' }, entry({ github: { baseUrl: 'https://acme.ghe.com' } }),
    'GITHUB_BASE_URL', 'default.github.baseUrl');
  conflict('sso', { SCIM_TOKEN: 'value' }, entry({ github: { baseUrl: 'https://github.com' }, sso: {
    scimToken: { file: '/run/secrets/scim' },
  } }), 'SCIM_TOKEN', 'default.sso.scimToken');
  const login = entry({ github: { baseUrl: 'https://github.com' }, login: { ssoLoginUrl: 'http://sso:7001/x' } });
  conflict('login', { SSO_URL: 'http://sso:7001/login' }, login, 'SSO_URL', 'default.login.ssoLoginUrl');
});

test('conflict errors never contain secret values', () => {
  const registry = { version: 1, enterprises: [{ id: 'default', github: { baseUrl: 'https://github.com' }, sso: {
    sessionSecret: { file: '/run/secrets/session' },
  } }] };
  assert.throws(() => load('sso', { SESSION_SECRET: 'very-secret-session' }, registry), (error: unknown) => {
    return error instanceof Error && !error.message.includes('very-secret-session');
  });
});

test('GHE.com default in the registry: ENTERPRISE_SHORTCODE is ignored with a warning, not a conflict', () => {
  const registry = { version: 1, enterprises: [{ id: 'default', github: {
    baseUrl: 'https://contoso.ghe.com',
    slug: 'contoso',
  } }] };
  const { registry: loaded } = load('proxy', { ENTERPRISE_SHORTCODE: 'octo' }, registry);
  assert.equal(loaded.enterprises[0].github.shortcode, '');
  assert.deepEqual(loaded.warnings, ['ENTERPRISE_SHORTCODE is ignored on GHE.com.']);
});

test('missing required fields after the merge are blockers, not startup errors', () => {
  const pool = defaultOf('proxy', { ACCOUNT_ROUTING_MODE: 'caller-lease' });
  assert.deepEqual(pool.blockers, [{ code: 'enterprise_field_missing', field: 'pool.accountDomain' }]);
  const login = defaultOf('login', { GITHUB_BASE_URL: 'https://contoso.ghe.com' });
  assert.deepEqual(login.blockers, [{ code: 'enterprise_field_missing', field: 'github.slug' }]);
});

test('the registry file must be an absolute path holding valid JSON; the result is deep-frozen', () => {
  const readFile = () => '{"version":1,';
  assert.throws(() => loadRegistry({ service: 'proxy', env: { ENTERPRISE_REGISTRY_FILE: 'enterprises.json' } }),
    /ENTERPRISE_REGISTRY_FILE must be an absolute path/);
  assert.throws(() => loadRegistry({ service: 'proxy', env: { ENTERPRISE_REGISTRY_FILE: REGISTRY_PATH }, readFile }),
    /ENTERPRISE_REGISTRY_FILE must contain valid JSON/);
  const { registry } = load('proxy', {});
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(registry.enterprises[0].github));
  assert.ok(Object.isFrozen(registry.warnings));
});
