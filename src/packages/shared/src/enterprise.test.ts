import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalEnterpriseProfile, enterpriseId, enterpriseProfileDto, EnterpriseContractError,
  parseEnterpriseProfile, requireEnterprise, requireEnterpriseRevision,
} from './enterprise.js';

const profile = {
  id: '11111111-2222-4333-8444-555555555555', slug: 'example-enterprise', shortcode: 'example',
  accountDomain: 'pool.example.invalid', revision: 1,
  routes: { proxyInternalUrl: 'http://proxy.internal:3000', ssoInternalUrl: 'http://sso.internal:7001',
    loginInternalUrl: 'http://login.internal:7003', ssoPublicUrl: 'https://sso.example.invalid' },
};

test('enterprise ID is stable UUID rather than slug or a default label', () => {
  assert.equal(enterpriseId(profile.id), profile.id);
  for (const value of ['default', profile.slug, '', undefined, 1, profile.id.toUpperCase(), '__proto__']) {
    if (value === profile.id) continue;
    assert.throws(() => enterpriseId(value), EnterpriseContractError);
  }
  assert.equal(parseEnterpriseProfile(profile).slug, 'example-enterprise');
});

test('profile canonicalization is ordered and never retains unknown secret fields', () => {
  assert.equal(canonicalEnterpriseProfile(profile), canonicalEnterpriseProfile({ ...profile, routes: { ...profile.routes } }));
  assert.throws(() => parseEnterpriseProfile({ ...profile, token: 'synthetic-private-value' }), /invalid_enterprise_profile/);
  assert.throws(() => parseEnterpriseProfile({ ...profile, routes: { ...profile.routes, secret: 'synthetic-private-value' } }), /invalid_enterprise_profile/);
  const dto = enterpriseProfileDto(profile, 100);
  assert.equal(dto.id, profile.id);
  assert.equal(dto.capability, 'enterprise-single-profile');
  assert.equal(dto.maxAccounts, 100);
  assert.equal(dto.contractVersion, 1);
});

test('slug and shortcode have distinct validation', () => {
  assert.equal(parseEnterpriseProfile({ ...profile, slug: 'long-enterprise-slug', shortcode: 'abc123' }).shortcode, 'abc123');
  for (const shortcode of ['ab', '123456789', 'with-dash', 'a_b', 'Abc', '', null]) {
    assert.throws(() => parseEnterpriseProfile({ ...profile, shortcode }), EnterpriseContractError);
  }
  for (const slug of ['a/b', ' bad ', '-bad', 'bad-', 'UPPER', '', null]) {
    assert.throws(() => parseEnterpriseProfile({ ...profile, slug }), EnterpriseContractError);
  }
});

test('profile refuses invalid domains and revision values', () => {
  for (const accountDomain of ['localhost', 'UPPER.invalid', 'a..invalid', '-x.invalid', 'x-.invalid', 'x.123', 'a'.repeat(64) + '.invalid']) {
    assert.throws(() => parseEnterpriseProfile({ ...profile, accountDomain }), EnterpriseContractError);
  }
  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => parseEnterpriseProfile({ ...profile, revision }), EnterpriseContractError);
  }
});

test('trusted routes reject credentials, queries, fragments and ambiguous paths', () => {
  for (const route of ['https://user:synthetic-secret@example.invalid', 'https://example.invalid/?token=synthetic-secret',
    'https://example.invalid/#a', 'file:///tmp/a', '//example.invalid', 'https://example.invalid/a%2fb',
    'https://example.invalid/a%5cb', 'https://example.invalid/%2e%2e/x', 'https://example.invalid\\x',
    'https://example.invalid/white space', '\nhttps://example.invalid', 'https:example.invalid',
    'https://example.invalid/../other', 'https://example.invalid?', 'https://example.invalid#']) {
    assert.throws(() => parseEnterpriseProfile({ ...profile, routes: { ...profile.routes, ssoPublicUrl: route } }), EnterpriseContractError);
  }
  assert.equal(parseEnterpriseProfile({ ...profile, routes: { ...profile.routes, ssoPublicUrl: 'https://sso.example.invalid/' } }).routes.ssoPublicUrl,
    'https://sso.example.invalid');
});

test('legacy omission is explicit and mismatched profile cannot silently become the registered one', () => {
  assert.equal(requireEnterprise(profile.id, profile.id), profile.id);
  assert.equal(requireEnterprise(undefined, profile.id, true), profile.id);
  for (const value of [undefined, null, '', 'default', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']) {
    assert.throws(() => requireEnterprise(value, profile.id), /unsupported_enterprise/);
  }
  assert.throws(() => requireEnterprise('default', profile.id, true), /unsupported_enterprise/);
});

test('revision and capacity guards do not accept coercion or out-of-range values', () => {
  assert.equal(requireEnterpriseRevision(1, 1), 1);
  for (const revision of ['1', undefined, 2, 0, NaN]) assert.throws(() => requireEnterpriseRevision(revision, 1), /enterprise_revision_mismatch/);
  for (const cap of [0, 10001, 1.5, NaN]) assert.throws(() => enterpriseProfileDto(profile, cap), /invalid_enterprise_capacity/);
});

test('contract failures do not expose rejected credentials', () => {
  try {
    parseEnterpriseProfile({ ...profile, routes: { ...profile.routes, ssoPublicUrl: 'https://user:synthetic-secret@example.invalid' } });
    assert.fail('must reject URL');
  } catch (error) {
    assert.ok(error instanceof EnterpriseContractError);
    assert.doesNotMatch(error.message, /synthetic-secret|example\.invalid/);
  }
});
