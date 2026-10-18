import { DEFAULT_GITHUB_BASE_URL, parseRegistry, type EnterpriseId, type Registry } from '@ghcp/shared';

/** A github.com enterprise (`default`), a GHE.com enterprise and an unready one, for isolation tests (§9.2). */
export const GHE_ENTERPRISE_ID = 'contoso-eu' as EnterpriseId;
export const UNREADY_ENTERPRISE_ID = 'unready' as EnterpriseId;
export const FIXTURE_SSO_URL = 'http://sso.test:7001/login';
export const DEFAULT_CLIENT_ID = 'default-client';
export const GHE_CLIENT_ID = 'contoso-client';

/** `unready` is a GHE.com enterprise without `github.slug`, so Login reports a readiness blocker for it. */
export function loginFixtureRegistry(): Registry {
  const registry = {
    version: 1,
    enterprises: [
      {
        id: 'default',
        github: { baseUrl: DEFAULT_GITHUB_BASE_URL, slug: 'acme', oauthClientId: DEFAULT_CLIENT_ID },
        login: { selectors: { ssoSubmit: '#acme-submit' } },
      },
      {
        id: GHE_ENTERPRISE_ID,
        github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso', oauthClientId: GHE_CLIENT_ID },
        login: { ssoProvider: 'azure', selectors: { azureNextSubmit: '#contoso-next' } },
      },
      {
        id: UNREADY_ENTERPRISE_ID,
        github: { baseUrl: 'https://unready.ghe.com' },
      },
    ],
  };
  return parseRegistry(registry, { service: 'login', ssoUrl: FIXTURE_SSO_URL, oauthClientId: 'global-client' });
}
