import assert from 'node:assert/strict';
import test from 'node:test';
import { EnterpriseRegistryError, normalizeField, parseLoginUrl } from './registryFields.js';

function rejects(path: string, value: unknown, label = `acme.${path}`): EnterpriseRegistryError {
  let caught: unknown;
  assert.throws(() => normalizeField(path, value, label), (error: unknown) => {
    caught = error;
    return error instanceof EnterpriseRegistryError;
  });
  const error = caught as EnterpriseRegistryError;
  assert.equal(error.code, 'enterprise_registry_invalid');
  assert.equal(error.field, label);
  return error;
}

test('unknown field paths are rejected', () => {
  rejects('github.proxyInternalUrl', 'http://proxy:3000');
  rejects('login.selectors.unknownSelector', '#x');
  rejects('routes', {});
});

test('secrets are references only, and errors never echo values', () => {
  const values = [
    'inline-super-secret',
    { env: 'lower_case' },
    { env: '1ABC' },
    { file: 'relative/path' },
    { file: '/run/sec\0ret' },
    { env: 'A', file: '/a' },
    { value: 'inline-super-secret' },
    {},
    null,
    ['inline-super-secret'],
  ];
  for (const value of values) {
    const error = rejects('sso.sessionSecret', value);
    assert.doesNotMatch(error.message, /inline-super-secret|relative|lower_case|1ABC/);
  }
  assert.deepEqual(normalizeField('sso.sessionSecret', { env: 'SESSION_SECRET' }, 'x'), { env: 'SESSION_SECRET' });
  assert.deepEqual(normalizeField('sso.scimToken', { file: '/run/secrets/scim' }, 'x'), { file: '/run/secrets/scim' });
});

test('shortcodes are lower-cased before validation', () => {
  assert.equal(normalizeField('github.shortcode', ' ACME ', 'x'), 'acme');
  rejects('github.shortcode', 'acme_1');
});

test('URLs: github.baseUrl is an origin; API and other URLs keep their path', () => {
  assert.equal(normalizeField('github.baseUrl', ' https://GitHub.com/ ', 'x'), 'https://github.com');
  assert.equal(normalizeField('github.apiBaseUrl', 'http://mock:8002/', 'x'), 'http://mock:8002');
  assert.equal(normalizeField('sso.spAcsUrl', 'http://mock:8002/saml/acs/', 'x'), 'http://mock:8002/saml/acs');
  rejects('github.baseUrl', 'https://github.com/enterprises');
  rejects('github.baseUrl', 'https://user@github.com');
  assert.equal(normalizeField('github.apiBaseUrl', 'https://gw.example.test/github/', 'x'),
    'https://gw.example.test/github');
  rejects('github.apiBaseUrl', 'http://mock:8002/api?x=1');
  rejects('github.copilotApiBaseUrl', 'ftp://mock');
  rejects('sso.spAcsUrl', 'https://github.com/a/../b');
  rejects('sso.spAcsUrl', 'http://sso/login#x');
});

test('login URLs drop the query and fragment that r4 ignored, then pass the trusted-URL checks', () => {
  assert.equal(normalizeField('login.ssoLoginUrl', 'http://sso:7001/login?next=%2e#x', 'x'), 'http://sso:7001/login');
  assert.equal(normalizeField('login.ssoLoginUrl', 'http://sso:7001/login#a?b', 'x'), 'http://sso:7001/login');
  const allowed = normalizeField('login.allowedLoginUrls', ['http://sso:7001/a?x=1', 'http://sso:7001/b#f'], 'x');
  assert.deepEqual(allowed, ['http://sso:7001/a', 'http://sso:7001/b']);
  rejects('login.ssoLoginUrl', 'http://sso:7001/%2e%2e/login?x=1');
  rejects('login.ssoLoginUrl', 'http://user@sso:7001/login?x=1');
  rejects('login.allowedLoginUrls', ['http://sso:7001/a\\b?x=1']);
  assert.equal(parseLoginUrl('http://SSO:7001/login/?RelayState=%2f').href, 'http://sso:7001/login');
  assert.throws(() => parseLoginUrl('http://sso:7001/../login?x'), /dot segments/);
});

test('allowedLoginUrls holds 1 to 16 trusted URLs', () => {
  const allowed = normalizeField('login.allowedLoginUrls', ['http://SSO:7001/login/'], 'x');
  assert.deepEqual(allowed, ['http://sso:7001/login']);
  rejects('login.allowedLoginUrls', []);
  rejects('login.allowedLoginUrls', 'http://sso/login');
  rejects('login.allowedLoginUrls', ['http://sso/ok', 'http://sso/%2e']);
  rejects('login.allowedLoginUrls', Array.from({ length: 17 }, (_, index) => `http://sso/${index}`));
});

test('shortcode is empty or (lower-cased) ^[a-z0-9]{3,8}$; the github.com rule is applied per profile', () => {
  assert.equal(normalizeField('github.shortcode', '', 'x'), '');
  assert.equal(normalizeField('github.shortcode', 'octo', 'x'), 'octo');
  for (const value of ['ab', 'abcdefghi', 'oc_to', 7]) rejects('github.shortcode', value);
});

test('domains, slugs, providers, counts and text are validated', () => {
  assert.equal(normalizeField('pool.accountDomain', ' Pool.Example.COM ', 'x'), 'pool.example.com');
  rejects('pool.accountDomain', 'not a domain');
  rejects('pool.accountDomain', 'localhost');
  rejects('sso.emailDomain', 'example.c0m');
  rejects('github.slug', 'a/b');
  assert.equal(normalizeField('github.slug', 'local-test', 'x'), 'local-test');
  rejects('login.ssoProvider', 'okta');
  assert.equal(normalizeField('login.ssoProvider', 'azure', 'x'), 'azure');
  rejects('displayName', '  ');
  rejects('displayName', 'two\nlines');
  rejects('displayName', 7);
  for (const value of [0, -1, 1.5, 10_001, '5', null]) rejects('pool.initialMaxAccounts', value);
  assert.equal(normalizeField('pool.initialMaxAccounts', 10_000, 'x'), 10_000);
});

test('errors are labelled with the given label, such as an environment variable', () => {
  const error = rejects('github.shortcode', 'NOT-VALID', 'ENTERPRISE_SHORTCODE');
  assert.match(error.message, /^ENTERPRISE_SHORTCODE /);
  assert.doesNotMatch(error.message, /NOT-VALID/);
});
