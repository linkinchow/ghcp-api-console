import { Router } from 'express';
import type { EnterpriseServiceReadinessDto } from '@ghcp/shared';
import { requireInternalToken } from '../auth/internalAuth.js';
import { loginEnterprises, type LoginEnterprise } from '../enterprises.js';

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
  return loginEnterprises().map(enterpriseReadiness);
}

/** Login does not know the EMU shortcode, so it reports `null` and Proxy compares it with SSO only. */
function enterpriseReadiness(enterprise: LoginEnterprise): EnterpriseServiceReadinessDto {
  const { github } = enterprise.profile;
  return {
    id: enterprise.id,
    githubBaseUrl: github.baseUrl,
    slug: github.slug ?? null,
    shortcode: null,
    configured: enterprise.blockers.length === 0,
    blockers: [...enterprise.blockers],
  };
}
