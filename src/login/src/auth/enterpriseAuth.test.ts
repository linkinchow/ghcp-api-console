import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRegistry } from '@ghcp/shared';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { enterpriseAuthConfig } = await import('./enterpriseAuth.js');
const { findLoginEnterprise, readyLoginEnterprise, resolveSsoType, setLoginEnterprisesForTesting } =
  await import('../enterprises.js');

/** No SSO_URL, so none of these enterprises has a login page. */
setLoginEnterprisesForTesting(parseRegistry({
  version: 1,
  enterprises: [
    { id: 'open', github: { baseUrl: 'https://open.ghe.com', slug: 'open' } },
    pinned('pinned-custom', 'custom'),
    pinned('pinned-azure', 'azure'),
  ],
}, { service: 'login', oauthClientId: 'client' }));

function pinned(id: string, ssoProvider: string) {
  return { id, github: { baseUrl: `https://${id}.ghe.com`, slug: id }, login: { ssoProvider } };
}

const SETTINGS = { timeoutMs: 1_000, debugLogs: false, debugArtifacts: false };

test('a missing login page blocks only an enterprise that pins custom SSO', () => {
  assert.deepEqual(findLoginEnterprise('open')!.blockers, []);
  assert.deepEqual(findLoginEnterprise('pinned-custom')!.blockers, ['enterprise_field_missing:login.ssoLoginUrl']);
  assert.deepEqual(findLoginEnterprise('pinned-azure')!.blockers, []);
});

test('the task chooses the provider only when the profile leaves it open', () => {
  const open = findLoginEnterprise('open')!;
  const pinned = findLoginEnterprise('pinned-azure')!;
  assert.equal(resolveSsoType(open, undefined), 'custom');
  assert.equal(resolveSsoType(open, 'azure'), 'azure');
  assert.throws(() => resolveSsoType(open, 'okta'), { code: 'invalid_login_task' });
  assert.equal(resolveSsoType(pinned, undefined), 'azure');
  assert.equal(resolveSsoType(pinned, 'azure'), 'azure');
  assert.throws(() => resolveSsoType(pinned, 'custom'), { code: 'sso_type_mismatch' });
  assert.equal(enterpriseAuthConfig(readyLoginEnterprise(open), 'azure', SETTINGS).ssoProvider, 'azure');
  assert.equal(enterpriseAuthConfig(readyLoginEnterprise(pinned), 'custom', SETTINGS).ssoProvider, 'azure');
});
