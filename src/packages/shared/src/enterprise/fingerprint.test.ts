import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, profileFingerprint, type ProfileIdentity } from './fingerprint.js';
import { parseRegistry } from './registry.js';

const ACME: ProfileIdentity = {
  id: 'default',
  github: { baseUrl: 'https://github.com', shortcode: 'octo' },
  pool: { accountDomain: 'pool.acme.example.com' },
};

test('hashes the canonical JSON of the identity fields with sha256', () => {
  const canonical = '{"accountDomain":"pool.acme.example.com","githubBaseUrl":"https://github.com",'
    + '"id":"default","shortcode":"octo"}';
  const expected = createHash('sha256').update(canonical).digest('hex');
  assert.equal(profileFingerprint(ACME), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('is stable across property order and ignores non-identity fields', () => {
  const reordered = {
    pool: { initialMaxAccounts: 500, accountDomain: 'pool.acme.example.com' },
    displayName: 'Renamed',
    github: { apiBaseUrl: 'http://mock:8002', shortcode: 'octo', baseUrl: 'https://github.com' },
    id: 'default',
  };
  assert.equal(profileFingerprint(reordered), profileFingerprint(ACME));
});

test('changes when any identity field changes', () => {
  const variants: ProfileIdentity[] = [
    { ...ACME, id: 'acme' },
    { ...ACME, github: { baseUrl: 'https://acme.ghe.com', shortcode: 'octo' } },
    { ...ACME, github: { baseUrl: 'https://github.com', shortcode: 'acme' } },
    { ...ACME, github: { baseUrl: 'https://github.com' } },
    { ...ACME, github: { baseUrl: 'https://github.com', shortcode: '' } },
    { ...ACME, pool: { accountDomain: 'pool.other.example.com' } },
    { ...ACME, pool: {} },
  ];
  const fingerprints = new Set([ACME, ...variants].map(profileFingerprint));
  assert.equal(fingerprints.size, variants.length + 1);
});

test('accepts a resolved registry profile, whose URLs are already normalized', () => {
  const registry = parseRegistry({ version: 1, enterprises: [{
    id: 'default',
    github: { baseUrl: 'https://GitHub.com/', shortcode: 'octo' },
    pool: { accountDomain: 'Pool.Acme.Example.com' },
  }] });
  assert.equal(profileFingerprint(registry.enterprises[0]), profileFingerprint(ACME));
});

test('canonicalJson sorts keys at every depth and keeps array order', () => {
  assert.equal(canonicalJson({ b: [2, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[2,{"c":null,"d":1}]}');
  assert.equal(canonicalJson({ env: 'A' }), canonicalJson({ env: 'A' }));
  assert.notEqual(canonicalJson({ env: 'A' }), canonicalJson({ file: 'A' }));
  assert.equal(canonicalJson('quote"d'), '"quote\\"d"');
});
