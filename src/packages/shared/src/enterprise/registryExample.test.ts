import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ServiceEnv } from './defaultFromEnv.js';
import { parseRegistry, type RegistryService } from './registry.js';
import { EnterpriseRegistryError } from './registryFields.js';
import { loadRegistry } from './registryFile.js';

/** The customer-facing example shipped in `deploy/` (docs/multi-enterprise-registry.md). */
const EXAMPLE_PATH = fileURLToPath(new URL('../../../../../deploy/enterprise-registry.example.json', import.meta.url));
const EXAMPLE = readFileSync(EXAMPLE_PATH, 'utf8');
const MOUNT_PATH = resolve('/config/enterprise-registry.json');
const SERVICES: readonly RegistryService[] = ['proxy', 'sso', 'login'];

/**
 * docker-compose.yml with the example mounted: per-enterprise variables the registry's `default` sets are blank,
 * and required ones repeat the registry values.
 */
const COMPOSE_ENV: ServiceEnv = {
  ENTERPRISE_REGISTRY_FILE: MOUNT_PATH,
  ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.fabrikam.example.com',
  POOL_MAX_ACCOUNTS: '100',
  GITHUB_BASE_URL: '',
  GITHUB_API_BASE_URL: '',
  COPILOT_API_BASE_URL: '',
  ENTERPRISE_SHORTCODE: '',
  ENTERPRISE_SLUG: 'fabrikam',
  GITHUB_OAUTH_CLIENT_ID: '',
  SSO_URL: 'http://sso:7001/login',
  SESSION_SECRET: 'example-session-secret',
  SCIM_TOKEN: 'example-scim-token',
  SCIM_BASE_URL: 'https://api.github.com/scim/v2/enterprises/fabrikam',
  SP_ENTITY_ID: 'https://github.com/enterprises/fabrikam',
  SP_ACS_URL: 'https://github.com/enterprises/fabrikam/saml/consume',
};

function loadExample(service: RegistryService, env: ServiceEnv) {
  return loadRegistry({ service, env, readFile: () => EXAMPLE });
}

test('the registry example parses: a github.com default and a GHE.com enterprise with derived endpoints', () => {
  const registry = parseRegistry(EXAMPLE);
  assert.deepEqual(registry.enterprises.map((profile) => profile.id), ['default', 'contoso-ghe']);
  const [fabrikam, contoso] = registry.enterprises;
  assert.equal(fabrikam.github.apiBaseUrl, 'https://api.github.com');
  assert.equal(fabrikam.sso.spAcsUrl, 'https://github.com/enterprises/fabrikam/saml/consume');
  assert.equal(contoso.github.isGheCom, true);
  assert.equal(contoso.github.shortcode, '');
  assert.equal(contoso.github.apiBaseUrl, 'https://api.contoso.ghe.com');
  assert.equal(contoso.github.copilotApiBaseUrl, 'https://copilot-api.contoso.ghe.com');
  assert.equal(contoso.sso.scimBaseUrl, 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso');
});

test('every enterprise of the example is configured for Proxy (pool mode), SSO and Login', () => {
  for (const service of SERVICES) {
    const registry = parseRegistry(EXAMPLE, { service, poolMode: true, ssoUrl: 'http://sso:7001/login' });
    for (const profile of registry.enterprises) assert.deepEqual(profile.blockers, [], `${service} ${profile.id}`);
  }
});

test('the example loads in every service next to the compose environment without env conflicts', () => {
  for (const service of SERVICES) {
    const registry = loadExample(service, COMPOSE_ENV);
    assert.deepEqual(registry.enterprises.map((profile) => profile.id), ['default', 'contoso-ghe']);
    assert.equal(registry.enterprises[0].github.shortcode, 'fab');
  }
});

test('a non-blank r4 compose default next to the example is an enterprise_env_conflict', () => {
  for (const service of ['proxy', 'sso'] as const) {
    assert.throws(() => loadExample(service, { ...COMPOSE_ENV, ENTERPRISE_SHORTCODE: 'octo' }), (error: unknown) => {
      assert.ok(error instanceof EnterpriseRegistryError);
      assert.equal(error.code, 'enterprise_env_conflict');
      assert.equal(error.field, 'default.github.shortcode');
      return true;
    });
  }
});
