import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import Database from 'better-sqlite3';
import { parseEnterpriseRegistryV3, resolveEnterpriseScope, type EnterpriseProfileV3, type EnterpriseRegistryV3, type EnterpriseScope } from '@ghcp/shared';
import { initEnterpriseSqliteV3 } from '@ghcp/shared/enterpriseStorageV3';

export const LEGACY_FIXTURE_ID = 'a2793f03-dafd-4e59-89cf-587b1673d30b';
export const SECOND_FIXTURE_ID = 'bf6bdc25-3b9b-483e-a010-c015780d2573';

/** Explicit synthetic initialization only; never a runtime gate bypass. */
export function initSsoFixture(): EnterpriseScope { return resolveEnterpriseScope(initSsoRegistryFixture()); }
export function initSsoRegistryFixture(twoProfiles = false): EnterpriseRegistryV3 {
  const directory = mkdtempSync(join(tmpdir(), 'sso-enterprise-v3-test-'));
  process.env.DOTENV_CONFIG_PATH = join(directory, 'missing.env');
  process.env.TEST_SSO_SCIM_TOKEN = process.env.SCIM_TOKEN ?? 'synthetic-scim-token';
  process.env.TEST_SSO_SEAT_PAT = process.env.GITHUB_COPILOT_SEAT_PAT ?? 'synthetic-seat-token';
  process.env.TEST_SSO_SESSION_SECRET = 'synthetic-session-secret-long-enough-for-tests';
  const base = process.env.BASE_URL ?? 'http://127.0.0.1:7001';
  const slug = process.env.ENTERPRISE_SLUG ?? 'test-enterprise';
  const makeProfile = (id: string, legacy: boolean): EnterpriseProfileV3 => ({
    id, slug: legacy ? slug : 'second-enterprise', shortcode: legacy ? process.env.ENTERPRISE_SHORTCODE ?? 'test' : 'second',
    accountDomain: 'pool.example.com', revision: 1, maxAccounts: 10,
    routes: { proxyInternalUrl: process.env.PROXY_BASE_URL ?? 'http://127.0.0.1:3000',
      ssoInternalUrl: 'http://127.0.0.1:7001', loginInternalUrl: 'http://127.0.0.1:7003', ssoPublicUrl: base },
    sso: {
      entityId: `${base}${legacy ? '' : `/profiles/${id}`}/metadata`,
      ssoUrl: `${base}${legacy ? '' : `/profiles/${id}`}/sso`,
      loginUrl: `${base}${legacy ? '' : `/profiles/${id}`}/login`,
      logoutUrl: `${base}${legacy ? '' : `/profiles/${id}`}/logout`,
      spEntityId: `https://github.test/enterprises/${legacy ? slug : 'second-enterprise'}`,
      spAcsUrl: `http://127.0.0.1:8002/enterprises/${legacy ? slug : 'second-enterprise'}/saml/consume`,
      scimBaseUrl: legacy ? process.env.SCIM_BASE_URL || `${process.env.MOCK_GITHUB_BASE_URL ?? 'http://127.0.0.1:8002'}/scim/v2/enterprises/${slug}` : 'http://127.0.0.1:8002/scim/v2/enterprises/second-enterprise',
      githubApiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'http://127.0.0.1:8002',
      emailDomain: legacy ? process.env.EMAIL_DOMAIN ?? 'example.com' : 'second.example.com',
      userPrefix: legacy ? process.env.USER_PREFIX ?? 'user' : 'second',
      signingCertRef: { env: 'TEST_SSO_SIGNING_CERT' }, signingKeyRef: { env: 'TEST_SSO_SIGNING_KEY' },
      sessionSecretRef: { env: 'TEST_SSO_SESSION_SECRET' }, scimTokenRef: { env: 'TEST_SSO_SCIM_TOKEN' },
      seatPatRef: { env: 'TEST_SSO_SEAT_PAT' },
      ...(process.env.SSO_DEFAULT_USER_PASSWORD ? { defaultPasswordRef: { env: 'SSO_DEFAULT_USER_PASSWORD' } } : {}),
    },
    login: { provider: 'custom', allowedLoginUrls: [`${base}${legacy ? '' : `/profiles/${id}`}/login`], selectors: {} },
  });
  const registry = parseEnterpriseRegistryV3({ version: 3, registryRevision: 1, legacyEnterpriseId: LEGACY_FIXTURE_ID,
    profiles: [makeProfile(LEGACY_FIXTURE_ID, true), ...(twoProfiles ? [makeProfile(SECOND_FIXTURE_ID, false)] : [])] });
  process.env.DB_PATH = join(directory, 'sso.sqlite');
  process.env.ENTERPRISE_REGISTRY_FILE = join(directory, 'registry.json');
  process.env.SSO_USER_EVENTS_LOG = join(directory, 'events.log');
  writeFileSync(process.env.ENTERPRISE_REGISTRY_FILE, JSON.stringify(registry));
  const db = new Database(process.env.DB_PATH);
  try { initEnterpriseSqliteV3(db, 'sso', registry); } finally { db.close(); }
  after(async () => {
    const { getDb } = await import('./connection.js');
    try { getDb().close(); } catch { /* Deliberately rejected gate fixture. */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return registry;
}
