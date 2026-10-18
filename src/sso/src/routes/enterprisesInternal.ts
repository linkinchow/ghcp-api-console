import { Router } from 'express';
import { SecretError, type EnterpriseServiceReadinessDto } from '@ghcp/shared';
import { requireInternalToken } from '../auth/internalAuth.js';
import { ssoEnterprises, ssoSessionSecret, type SsoEnterprise, type SsoSecretField } from '../enterprises.js';
import { requireSsoSecret } from '../enterpriseSecrets.js';

/** Secrets SAML cannot work without; the optional ones only fail their own feature (design §3.3). */
const REQUIRED_SECRETS: readonly SsoSecretField[] = ['signingCert', 'signingKey', 'sessionSecret'];

/** `GET /internal/enterprises` (design §3.8); mount at `/internal/enterprises`. */
export function createEnterprisesInternalRouter(): Router {
  const router = Router();
  router.get('/', requireInternalToken, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(listEnterpriseReadiness());
  });
  return router;
}

export function listEnterpriseReadiness(): EnterpriseServiceReadinessDto[] {
  return ssoEnterprises().map(enterpriseReadiness);
}

function enterpriseReadiness(enterprise: SsoEnterprise): EnterpriseServiceReadinessDto {
  const { github } = enterprise.profile;
  const blockers = [...fieldBlockers(enterprise), ...secretBlockers(enterprise)];
  return {
    id: enterprise.id,
    githubBaseUrl: github.baseUrl,
    slug: github.slug ?? null,
    shortcode: github.shortcode ?? null,
    configured: blockers.length === 0,
    blockers,
  };
}

function fieldBlockers(enterprise: SsoEnterprise): string[] {
  return enterprise.profile.blockers.map((blocker) => `${blocker.code}:${blocker.field}`);
}

/** Only field paths are reported, never values or their sources (design §3.4). */
function secretBlockers(enterprise: SsoEnterprise): string[] {
  const blockers: string[] = [];
  for (const field of REQUIRED_SECRETS) {
    if (!enterprise.profile.sso[field]) continue;
    const error = secretError(enterprise, field);
    if (error) blockers.push(`${error.code}:sso.${field}`);
  }
  return blockers;
}

function secretError(enterprise: SsoEnterprise, field: SsoSecretField): SecretError | undefined {
  try {
    if (field === 'sessionSecret') ssoSessionSecret(enterprise);
    else requireSsoSecret(enterprise, field);
    return undefined;
  } catch (error) {
    if (error instanceof SecretError) return error;
    return new SecretError('enterprise_secret_unconfigured', `${enterprise.id}.sso.${field}`, 'is not configured');
  }
}
