import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GITHUB_BASE_URL, parseRegistry, type EnterpriseId, type Registry } from '@ghcp/shared';

/** A github.com enterprise (`default`) and a GHE.com enterprise, for isolation tests (design §9.2). */
export const GHE_ENTERPRISE_ID = 'contoso-eu' as EnterpriseId;

export const FIXTURE_SECRETS = {
  ACME_SESSION_SECRET: 'acme-session-secret',
  ACME_SCIM_TOKEN: 'acme-scim-token',
  ACME_SEAT_PAT: 'acme-seat-pat',
  ACME_DEFAULT_PASSWORD: 'acme-default-password-0123456789',
  CONTOSO_SESSION_SECRET: 'contoso-session-secret',
  CONTOSO_SCIM_TOKEN: 'contoso-scim-token',
  CONTOSO_SEAT_PAT: 'contoso-seat-pat',
  CONTOSO_DEFAULT_PASSWORD: 'contoso-default-password-0123456789',
} as const;

export interface EnterpriseFixture {
  directory: string;
  registry: Registry;
}

/**
 * Writes the signing certificate files and sets the secret variables. The GHE.com enterprise's signing key file
 * is deliberately missing, so it reports a readiness blocker.
 */
export function createEnterpriseFixture(): EnterpriseFixture {
  const directory = mkdtempSync(join(tmpdir(), 'sso-enterprises-'));
  for (const name of ['acme-cert.pem', 'acme-key.pem', 'contoso-cert.pem']) {
    writeFileSync(join(directory, name), `fixture ${name}\n`);
  }
  Object.assign(process.env, FIXTURE_SECRETS);
  return { directory, registry: parseRegistry(registryJson(directory), { service: 'sso' }) };
}

function registryJson(directory: string): unknown {
  return {
    version: 1,
    enterprises: [
      {
        id: 'default',
        github: {
          baseUrl: DEFAULT_GITHUB_BASE_URL,
          apiBaseUrl: 'https://api.acme.test',
          slug: 'acme',
          shortcode: 'octo',
        },
        sso: {
          scimBaseUrl: 'https://scim.acme.test/scim/v2/enterprises/acme',
          emailDomain: 'acme.example.com',
          ...secretRefs(directory, 'acme', 'ACME', 'acme-key.pem'),
        },
      },
      {
        id: GHE_ENTERPRISE_ID,
        github: { baseUrl: 'https://contoso.ghe.com', slug: 'contoso' },
        sso: {
          emailDomain: 'contoso.example.eu',
          userPrefix: 'ghcp',
          ...secretRefs(directory, 'contoso', 'CONTOSO', 'contoso-key-missing.pem'),
        },
      },
    ],
  };
}

function secretRefs(directory: string, file: string, env: string, keyFile: string): Record<string, unknown> {
  return {
    signingCert: { file: join(directory, `${file}-cert.pem`) },
    signingKey: { file: join(directory, keyFile) },
    sessionSecret: { env: `${env}_SESSION_SECRET` },
    scimToken: { env: `${env}_SCIM_TOKEN` },
    seatPat: { env: `${env}_SEAT_PAT` },
    defaultUserPassword: { env: `${env}_DEFAULT_PASSWORD` },
  };
}
