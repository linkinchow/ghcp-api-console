import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedLoginUrl } from './loginUrlAllowlist.js';

const LOGIN = 'http://sso:7001/enterprises/contoso-eu/login';
const allowed = [LOGIN];

test('the exact page and whole-segment sub-paths are allowed; query and fragment are ignored', () => {
  for (const url of [
    LOGIN,
    `${LOGIN}/`,
    `${LOGIN}/step-2`,
    `${LOGIN}?RelayState=%2Flogin%2Fdevice#top`,
    `${LOGIN}?next=%2e%2e%2f%5c`,
    'http://SSO:7001/enterprises/contoso-eu/login',
    'HTTP://sso:7001/enterprises/contoso-eu/login',
  ]) {
    assert.equal(isAllowedLoginUrl(url, allowed), true, url);
  }
});

test('sibling prefixes, parents and other enterprises are refused', () => {
  for (const url of [
    `${LOGIN}foo`,
    `${LOGIN}2/x`,
    'http://sso:7001/enterprises/contoso-eu',
    'http://sso:7001/enterprises/contoso-eu/LOGIN',
    'http://sso:7001/enterprises/contoso/login',
    'http://sso:7001/enterprises/other/login',
    'http://sso:7001/login',
  ]) {
    assert.equal(isAllowedLoginUrl(url, allowed), false, url);
  }
});

test('encoded traversal, dot segments, backslashes and userinfo are refused', () => {
  for (const url of [
    `${LOGIN}/%2e%2e/%2e%2e/other/login`,
    `${LOGIN}/%2E%2E`,
    `${LOGIN}%2fadmin`,
    `${LOGIN}/%2Fadmin`,
    `${LOGIN}%5cadmin`,
    `${LOGIN}/../admin`,
    `${LOGIN}/./x`,
    `${LOGIN}\\admin`,
    'http://user:secret@sso:7001/enterprises/contoso-eu/login',
    'http://sso:7001@evil.test/enterprises/contoso-eu/login',
  ]) {
    assert.equal(isAllowedLoginUrl(url, allowed), false, url);
  }
});

test('a different scheme, host or port is refused, as are non-URLs and an empty allowlist', () => {
  for (const url of [
    'https://sso:7001/enterprises/contoso-eu/login',
    'http://sso:7002/enterprises/contoso-eu/login',
    'http://sso/enterprises/contoso-eu/login',
    'http://sso.evil.test:7001/enterprises/contoso-eu/login',
    'http://evil-sso:7001/enterprises/contoso-eu/login',
    'javascript:alert(1)',
    'about:blank',
    'not a url',
  ]) {
    assert.equal(isAllowedLoginUrl(url, allowed), false, url);
  }
  assert.equal(isAllowedLoginUrl(LOGIN, []), false);
});

test('any of several entries may match, and an invalid entry never matches', () => {
  const entries = ['http://sso:7001/%2e%2e', 'https://login.example.test/tenant-a/saml', LOGIN];
  assert.equal(isAllowedLoginUrl('https://login.example.test/tenant-a/saml/sso?SAMLRequest=x', entries), true);
  assert.equal(isAllowedLoginUrl('https://login.example.test/tenant-b/saml', entries), false);
  assert.equal(isAllowedLoginUrl('http://sso:7001/x', entries), false);
});

test('the default port is the same origin as no port', () => {
  const tenant = ['https://login.example.test/tenant-a'];
  assert.equal(isAllowedLoginUrl('https://login.example.test:443/tenant-a', tenant), true);
  assert.equal(isAllowedLoginUrl('http://sso:80/login', ['http://sso/login']), true);
});
