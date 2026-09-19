import { readEnterpriseRegistryFile } from '@ghcp/shared/enterpriseRuntimeV3';
import dotenv from 'dotenv';
import type { EnterpriseRegistryV3 } from '@ghcp/shared';

// Unit/integration fixtures must never load a developer's real deployment secrets.
if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) dotenv.config({ path: process.env.DOTENV_CONFIG_PATH });

export interface SsoConfig {
  port: number;
  dbPath: string;
  enterpriseRegistryFile?: string;
  internalApiToken: string;
  baseUrl: string;
  proxyBaseUrl: string;
  mockGithubBaseUrl: string;
  sessionSecret: string;
  defaultUserPassword?: string;
  eventLogPath: string;
  enterpriseSlug: string;
  enterpriseShortcode: string;
  githubApiBaseUrl: string;
  githubCopilotSeatPat?: string;
  scimBaseUrl: string;
  scimToken: string;
  certDir: string;
  spEntityId: string;
  spAcsUrl: string;
}

export const config: SsoConfig = {
  port: readPort(process.env.PORT, 7001),
  dbPath: process.env.DB_PATH ?? './data/sso.sqlite',
  enterpriseRegistryFile: process.env.ENTERPRISE_REGISTRY_FILE,
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:7001',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  mockGithubBaseUrl: process.env.MOCK_GITHUB_BASE_URL ?? 'http://localhost:8002',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  defaultUserPassword: process.env.SSO_DEFAULT_USER_PASSWORD || undefined,
  eventLogPath: process.env.SSO_USER_EVENTS_LOG ?? './data/sso-user-events.log',
  enterpriseSlug: process.env.ENTERPRISE_SLUG ?? 'acme',
  enterpriseShortcode: process.env.ENTERPRISE_SHORTCODE ?? 'octo',
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
  githubCopilotSeatPat: process.env.GITHUB_COPILOT_SEAT_PAT,
  scimBaseUrl: process.env.SCIM_BASE_URL ?? '',
  scimToken: process.env.SCIM_TOKEN ?? '',
  certDir: process.env.CERT_DIR ?? '../../certs',
  spEntityId: process.env.SP_ENTITY_ID ?? '',
  spAcsUrl: process.env.SP_ACS_URL ?? '',
};

export function readConfiguredEnterpriseRegistry(): EnterpriseRegistryV3 {
  if (!config.enterpriseRegistryFile) throw new Error('enterprise_registry_file_required');
  return readEnterpriseRegistryFile(config.enterpriseRegistryFile);
}

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}
