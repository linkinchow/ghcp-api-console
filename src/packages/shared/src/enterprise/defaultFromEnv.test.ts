import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  defaultFromEnv,
  fallbackFields,
  isPoolMode,
  registryOptionsFromEnv,
  selectorVariable,
} from './defaultFromEnv.js';
import { EnterpriseRegistryError, LOGIN_SELECTOR_KEYS, type ProfileFields } from './registryFields.js';

function entries(fields: ProfileFields): Record<string, unknown> {
  return Object.fromEntries(fields);
}

test('Proxy: maps the §3.5 variables; pool variables only in caller-lease mode', () => {
  const env = {
    GITHUB_BASE_URL: 'https://github.com',
    GITHUB_API_BASE_URL: 'http://mock:8002/',
    COPILOT_API_BASE_URL: 'http://mock:8002',
    ENTERPRISE_SHORTCODE: 'octo',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'Pool.Example.com',
    POOL_MAX_ACCOUNTS: '300',
    MODELS_ADMIN_GITHUB_LOGIN: 'admin_octo',
    MODELS_ADMIN_GITHUB_USER_ID: '101',
    MODELS_ADMIN_COPILOT_TOKEN: 'token-value',
  };
  const direct = defaultFromEnv('proxy', env);
  assert.deepEqual(entries(direct.fields), {
    'github.baseUrl': 'https://github.com',
    'github.apiBaseUrl': 'http://mock:8002',
    'github.copilotApiBaseUrl': 'http://mock:8002',
    'github.shortcode': 'octo',
    'modelsAdmin.githubLogin': 'admin_octo',
    'modelsAdmin.githubUserId': '101',
    'modelsAdmin.copilotToken': { env: 'MODELS_ADMIN_COPILOT_TOKEN' },
  });
  assert.equal(direct.sources.get('github.apiBaseUrl'), 'GITHUB_API_BASE_URL');
  const pool = defaultFromEnv('proxy', { ...env, ACCOUNT_ROUTING_MODE: 'caller-lease' });
  assert.equal(pool.fields.get('pool.accountDomain'), 'pool.example.com');
  assert.equal(pool.fields.get('pool.initialMaxAccounts'), 300);
  assert.deepEqual(direct.warnings, []);
});

test('Proxy: stale pool variables have no effect in direct mode, and fail with the variable name otherwise', () => {
  const stale = { POOL_MAX_ACCOUNTS: 'many', POOL_ACCOUNT_EMAIL_DOMAIN: 'not a domain' };
  assert.equal(defaultFromEnv('proxy', stale).fields.size, 0);
  assert.throws(() => defaultFromEnv('proxy', { ...stale, ACCOUNT_ROUTING_MODE: 'caller-lease' }), (error: unknown) => {
    return error instanceof EnterpriseRegistryError && error.field === 'POOL_ACCOUNT_EMAIL_DOMAIN';
  });
  assert.throws(() => defaultFromEnv('proxy', { POOL_MAX_ACCOUNTS: '0', ACCOUNT_ROUTING_MODE: 'caller-lease' }),
    /POOL_MAX_ACCOUNTS/);
});

test('Proxy: the models-admin token file wins over the token variable, with a warning', () => {
  const result = defaultFromEnv('proxy', {
    MODELS_ADMIN_COPILOT_TOKEN_FILE: '/run/secrets/models-admin',
    MODELS_ADMIN_COPILOT_TOKEN: 'token-value',
  });
  assert.deepEqual(result.fields.get('modelsAdmin.copilotToken'), { file: '/run/secrets/models-admin' });
  assert.deepEqual(result.warnings, [
    'MODELS_ADMIN_COPILOT_TOKEN is ignored because MODELS_ADMIN_COPILOT_TOKEN_FILE is set.',
  ]);
  assert.throws(() => defaultFromEnv('proxy', { MODELS_ADMIN_COPILOT_TOKEN_FILE: 'relative/token' }),
    /MODELS_ADMIN_COPILOT_TOKEN_FILE/);
});

test('GHE.com ignores ENTERPRISE_SHORTCODE with a single warning, even an invalid one', () => {
  for (const service of ['proxy', 'sso'] as const) {
    const env = { GITHUB_BASE_URL: 'http://fixture.ghe.com:8002', ENTERPRISE_SHORTCODE: 'T!' };
    const result = defaultFromEnv(service, env);
    assert.equal(result.fields.has('github.shortcode'), false);
    assert.deepEqual(result.warnings, ['ENTERPRISE_SHORTCODE is ignored on GHE.com.']);
  }
  const fromRegistry = defaultFromEnv('proxy', { ENTERPRISE_SHORTCODE: 'octo' }, {
    registryBaseUrl: 'https://contoso.ghe.com',
  });
  assert.equal(fromRegistry.fields.has('github.shortcode'), false);
  assert.equal(fromRegistry.warnings.length, 1);
  const login = defaultFromEnv('login', { GITHUB_BASE_URL: 'https://x.ghe.com', ENTERPRISE_SHORTCODE: 'a' });
  assert.deepEqual(login.warnings, []);
});

test('SSO: secrets become env references; CERT_DIR becomes absolute cert and key files', () => {
  const env = {
    ENTERPRISE_SLUG: 'acme',
    SP_ENTITY_ID: 'http://mock:8002/saml',
    SP_ACS_URL: 'http://mock:8002/saml/acs',
    SCIM_BASE_URL: 'http://mock:8002/scim/v2/enterprises/acme',
    SCIM_TOKEN: 'scim-value',
    GITHUB_COPILOT_SEAT_PAT: 'pat-value',
    SESSION_SECRET: 'session-value',
    SSO_DEFAULT_USER_PASSWORD: 'password-value',
    CERT_DIR: '/certs',
  };
  const { fields } = defaultFromEnv('sso', env);
  assert.deepEqual(entries(fields), {
    'github.slug': 'acme',
    'sso.spEntityId': 'http://mock:8002/saml',
    'sso.spAcsUrl': 'http://mock:8002/saml/acs',
    'sso.scimBaseUrl': 'http://mock:8002/scim/v2/enterprises/acme',
    'sso.scimToken': { env: 'SCIM_TOKEN' },
    'sso.seatPat': { env: 'GITHUB_COPILOT_SEAT_PAT' },
    'sso.sessionSecret': { env: 'SESSION_SECRET' },
    'sso.defaultUserPassword': { env: 'SSO_DEFAULT_USER_PASSWORD' },
    'sso.signingCert': { file: resolve('/certs', 'idp-cert.pem') },
    'sso.signingKey': { file: resolve('/certs', 'idp-key.pem') },
  });
  assert.doesNotMatch(JSON.stringify(entries(fields)), /-value/);
});

test('Login: maps base URL, slug, OAuth client, SSO_URL and every AUTH_*_SELECTOR', () => {
  const { fields } = defaultFromEnv('login', {
    GITHUB_BASE_URL: 'https://github.com',
    ENTERPRISE_SLUG: 'acme',
    GITHUB_OAUTH_CLIENT_ID: 'client',
    SSO_URL: 'http://sso:7001/login',
    AUTH_SSO_SUBMIT_SELECTOR: '#submit',
    AUTH_AZURE_STAY_SIGNED_IN_YES_SELECTOR: '#yes',
  });
  assert.equal(fields.get('github.oauthClientId'), 'client');
  assert.equal(fields.get('login.ssoLoginUrl'), 'http://sso:7001/login');
  assert.equal(fields.get('login.selectors.ssoSubmit'), '#submit');
  assert.equal(fields.get('login.selectors.azureStaySignedInYes'), '#yes');
  assert.equal(selectorVariable('deviceCodeInput'), 'AUTH_DEVICE_CODE_INPUT_SELECTOR');
  assert.equal(selectorVariable('githubSsoSubmit'), 'AUTH_GITHUB_SSO_SUBMIT_SELECTOR');
  assert.equal(new Set(LOGIN_SELECTOR_KEYS.map(selectorVariable)).size, LOGIN_SELECTOR_KEYS.length);
});

test('blank variables count as unset, as Compose passes unset variables as empty strings', () => {
  const blank = { GITHUB_BASE_URL: '', ENTERPRISE_SLUG: '  ', SESSION_SECRET: '', CERT_DIR: '' };
  assert.equal(defaultFromEnv('sso', blank).fields.size, 0);
});

test('fallbacks reproduce the baseline built-in values', () => {
  const none: ProfileFields = new Map();
  assert.deepEqual(entries(fallbackFields('proxy', {}, none)), {
    'github.baseUrl': 'https://github.com',
    'github.shortcode': 'octo',
  });
  assert.deepEqual(entries(fallbackFields('login', {}, none)), { 'github.baseUrl': 'https://github.com' });
  assert.deepEqual(entries(fallbackFields('sso', {}, none)), {
    'github.baseUrl': 'https://github.com',
    'github.shortcode': 'octo',
    'github.slug': 'acme',
    'sso.sessionSecret': { env: 'SESSION_SECRET' },
    'sso.signingCert': { file: resolve('../../certs', 'idp-cert.pem') },
    'sso.signingKey': { file: resolve('../../certs', 'idp-key.pem') },
    'sso.spAcsUrl': 'http://localhost:8002/enterprises/acme/saml/consume',
    'sso.scimBaseUrl': 'http://localhost:8002/scim/v2/enterprises/acme',
  });
});

test('fallbacks follow the merged fields: no shortcode on GHE.com, mock URLs use the merged slug', () => {
  const ghe: ProfileFields = new Map([['github.baseUrl', 'https://contoso.ghe.com'], ['github.slug', 'contoso']]);
  const fallbacks = fallbackFields('sso', { MOCK_GITHUB_BASE_URL: 'http://mock:8002/' }, ghe);
  assert.equal(fallbacks.has('github.shortcode'), false);
  assert.equal(fallbacks.get('sso.spAcsUrl'), 'http://mock:8002/enterprises/contoso/saml/consume');
  const noMock = fallbackFields('sso', { MOCK_GITHUB_BASE_URL: '' }, ghe);
  assert.equal(noMock.has('sso.spAcsUrl'), false);
  assert.equal(noMock.has('sso.scimBaseUrl'), false);
  assert.throws(() => fallbackFields('sso', { MOCK_GITHUB_BASE_URL: 'http://mock/?x' }, ghe), /MOCK_GITHUB_BASE_URL/);
});

test('registry options carry the service-wide settings', () => {
  assert.deepEqual(registryOptionsFromEnv('proxy', { ACCOUNT_ROUTING_MODE: 'caller-lease' }), {
    service: 'proxy',
    poolMode: true,
  });
  assert.deepEqual(registryOptionsFromEnv('sso', {}), { service: 'sso' });
  const loginEnv = { SSO_URL: 'http://sso:7001/login', AUTH_SSO_SUBMIT_SELECTOR: '#s' };
  assert.deepEqual(registryOptionsFromEnv('login', loginEnv), {
    service: 'login',
    ssoUrl: 'http://sso:7001/login',
    oauthClientId: 'Ov23li8tweQw6odWQebz',
    selectors: { ssoSubmit: '#s' },
  });
  assert.equal(isPoolMode({}), false);
  assert.equal(isPoolMode({ ACCOUNT_ROUTING_MODE: 'direct' }), false);
});
