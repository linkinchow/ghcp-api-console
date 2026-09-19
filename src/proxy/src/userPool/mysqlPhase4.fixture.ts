import { parseEnterpriseRegistryV3, type EnterpriseProfileV3, type EnterpriseRegistryV3 } from '@ghcp/shared';

/** Synthetic-only fixture; no deployment configuration or secret values. */
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export function profileV3(id = A): EnterpriseProfileV3 {
  const legacy = id === A, slug = legacy ? 'acme-corp' : 'other-corp';
  const root = 'https://sso.example.test', path = legacy ? '' : `/profiles/${id}`;
  return { id, slug, shortcode: legacy ? 'acm' : 'oth', accountDomain: `${slug}.example.test`, revision: 1, maxAccounts: 5,
    routes: { proxyInternalUrl: 'http://127.0.0.1:13000', ssoInternalUrl: 'http://127.0.0.1:13001',
      loginInternalUrl: 'http://127.0.0.1:13002', ssoPublicUrl: root },
    sso: { entityId: `${root}${path}/metadata`, ssoUrl: `${root}${path}/sso`, loginUrl: `${root}${path}/login`, logoutUrl: `${root}${path}/logout`,
      spEntityId: `https://github.com/enterprises/${slug}`, spAcsUrl: `https://github.com/enterprises/${slug}/saml/consume`,
      scimBaseUrl: `https://api.github.com/scim/v2/enterprises/${slug}`, githubApiBaseUrl: 'https://api.github.com',
      emailDomain: `${slug}.example.test`, userPrefix: 'User', signingCertRef: { env: legacy ? 'TEST_A_CERT' : 'TEST_B_CERT' },
      signingKeyRef: { env: legacy ? 'TEST_A_KEY' : 'TEST_B_KEY' }, sessionSecretRef: { env: legacy ? 'TEST_A_SESSION' : 'TEST_B_SESSION' } },
    login: { provider: 'custom', allowedLoginUrls: [`${root}${path}/login`], selectors: { user: '#user', password: '#password' } } };
}
export function registryV3(): EnterpriseRegistryV3 {
  return parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: A, profiles: [profileV3(A), profileV3(B)] });
}
export const poolOptionsV3 = () => ({ layout: 'pool' as const, pool: { fingerprint: 'a'.repeat(64), settings: {
  version: 1, idle_target: 1, lease_seconds: 600, paused: 1 as const, next_ordinal: 0,
  account_domain: profileV3(A).accountDomain, owner: null, owner_until: 0,
} } });
