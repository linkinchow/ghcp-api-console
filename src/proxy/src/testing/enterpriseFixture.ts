import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSecretCache,
  DEFAULT_GITHUB_BASE_URL,
  loadRegistry,
  REGISTRY_FILE_VARIABLE,
  type EnterpriseId,
} from '@ghcp/shared';
import { setProxyEnterprisesForTesting } from '../enterprises.js';

/**
 * A GHE.com enterprise next to the env-synthesized github.com `default`, plus a third github.com enterprise
 * whose profile fixes the SSO provider; new enterprises start as `draft` (design §9.2, §9.5). Hosts are mocks.
 */
export const GHE_ENTERPRISE_ID = 'contoso-eu' as EnterpriseId;
export const SECOND_ENTERPRISE_ID = 'fabrikam' as EnterpriseId;

export const GHE_ENDPOINTS = {
  baseUrl: 'https://contoso.ghe.com',
  apiBaseUrl: 'https://api.contoso.ghe.com',
  copilotApiBaseUrl: 'https://copilot-api.contoso.ghe.com',
} as const;

export const SECOND_ENDPOINTS = {
  apiBaseUrl: 'https://api.fabrikam.test',
  copilotApiBaseUrl: 'https://copilot.fabrikam.test',
} as const;

export const GHE_ACCOUNT_DOMAIN = 'pool.contoso.test';
export const GHE_MODELS_ADMIN = {
  githubLogin: 'contoso-admin',
  githubUserId: '7',
  tokenVariable: 'CONTOSO_MODELS_TOKEN',
} as const;

export interface EnterpriseFixture {
  readonly file: string;
  restore(): void;
}

/**
 * Writes the registry, points ENTERPRISE_REGISTRY_FILE at it (so storage seeds the same enterprises) and makes
 * the Proxy reload it. `restore` puts the previous environment back.
 */
/**
 * Single-enterprise pool tests: the env-synthesized `default` enterprise as caller-lease mode builds it, with this
 * account domain (members' emails come from their enterprise's profile, design §3.5).
 */
export function installDefaultPoolDomain(accountDomain: string): void {
  const env = { ...process.env, ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: accountDomain };
  setProxyEnterprisesForTesting(loadRegistry({ service: 'proxy', env }));
}

export function installEnterpriseFixture(): EnterpriseFixture {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-enterprises-'));
  const file = join(directory, 'registry.json');
  writeFileSync(file, JSON.stringify(fixtureRegistry()));
  const previous = process.env[REGISTRY_FILE_VARIABLE];
  process.env[REGISTRY_FILE_VARIABLE] = file;
  reloadEnterprises();
  return {
    file,
    restore() {
      if (previous === undefined) delete process.env[REGISTRY_FILE_VARIABLE];
      else process.env[REGISTRY_FILE_VARIABLE] = previous;
      reloadEnterprises();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function fixtureRegistry(): unknown {
  return {
    version: 1,
    enterprises: [
      {
        id: GHE_ENTERPRISE_ID,
        displayName: 'Contoso EU (GHE.com)',
        github: { ...GHE_ENDPOINTS, slug: 'contoso' },
        pool: { accountDomain: GHE_ACCOUNT_DOMAIN, initialMaxAccounts: 20 },
        modelsAdmin: {
          githubLogin: GHE_MODELS_ADMIN.githubLogin,
          githubUserId: GHE_MODELS_ADMIN.githubUserId,
          copilotToken: { env: GHE_MODELS_ADMIN.tokenVariable },
        },
      },
      {
        id: SECOND_ENTERPRISE_ID,
        github: { baseUrl: DEFAULT_GITHUB_BASE_URL, ...SECOND_ENDPOINTS, shortcode: 'fab' },
        login: { ssoProvider: 'azure' },
        pool: { accountDomain: 'pool.fabrikam.test', initialMaxAccounts: 10 },
      },
    ],
  };
}

function reloadEnterprises(): void {
  setProxyEnterprisesForTesting(undefined);
  clearSecretCache();
}
