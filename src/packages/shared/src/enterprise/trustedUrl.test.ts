import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTrustedUrl, sameTrustedUrl } from './trustedUrl.js';

test('URL attack samples are rejected by parseTrustedUrl', () => {
  const attacks = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    '//evil.example/login',
    'http:/evil.example',
    'http:///evil.example',
    'https://user:pass@sso.example/login',
    'https://user@sso.example/login',
    'https://@sso.example/login',
    'https://sso.example/login?next=https://evil.example',
    'https://sso.example/login?',
    'https://sso.example/login#fragment',
    'https://sso.example\\evil.example/login',
    'https:\\\\evil.example',
    'https://sso.example/a/%2e%2e/admin',
    'https://sso.example/a%2Fb',
    'https://sso.example/a%5cb',
    'https://sso.example/a/../admin',
    'https://sso.example/./login',
    'https://sso.example/login/..',
    'https://sso.example/lo gin',
    'https://sso.exa\nmple/login',
    'https://sso.example/login\t',
    'not a url',
    'https://',
  ];
  for (const attack of attacks) assert.throws(() => parseTrustedUrl(attack), Error, attack);
});

test('parseTrustedUrl normalizes host case, default ports and trailing slashes', () => {
  const url = parseTrustedUrl('HTTPS://SSO.Example:443/Enterprises/acme/');
  assert.deepEqual(url, {
    href: 'https://sso.example/Enterprises/acme',
    origin: 'https://sso.example',
    hostname: 'sso.example',
    segments: ['Enterprises', 'acme'],
  });
  assert.equal(parseTrustedUrl('http://mock:8002').href, 'http://mock:8002');
  assert.deepEqual(parseTrustedUrl('http://mock:8002/').segments, []);
  assert.equal(parseTrustedUrl('https://sso.example/a..b/c.d').href, 'https://sso.example/a..b/c.d');
});

test('sameTrustedUrl compares whole path segments, never prefixes', () => {
  const same = (left: string, right: string) => sameTrustedUrl(parseTrustedUrl(left), parseTrustedUrl(right));
  assert.equal(same('https://sso.example/a', 'https://sso.example/a/'), true);
  assert.equal(same('https://sso.example/a', 'https://sso.example/ab'), false);
  assert.equal(same('https://sso.example/a', 'https://sso.example/a/b'), false);
  assert.equal(same('https://sso.example/a', 'https://sso.example/A'), false);
  assert.equal(same('https://sso.example/a', 'http://sso.example/a'), false);
  assert.equal(same('https://sso.example/a', 'https://sso.example:8443/a'), false);
});
