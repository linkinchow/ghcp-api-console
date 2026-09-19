import { Router } from 'express';
import {
  apiError, EnterpriseContractError, ENTERPRISE_V3_CAPABILITY, resolveEnterpriseScope,
  type EnterpriseReadinessV1, type EnterpriseRegistryV3,
} from '@ghcp/shared';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { getValidatedEnterpriseRegistry } from '../db/connection.js';

export function loginReadiness(registry: EnterpriseRegistryV3, enterpriseId: string): EnterpriseReadinessV1 {
  const { profile } = resolveEnterpriseScope(registry, enterpriseId);
  const blockers = profile.login.provider === 'custom' ? [] : ['pool_provider_unsupported'];
  return {
    probeVersion: 1, component: 'login', schemaVersion: 3, contractVersion: 2, capability: ENTERPRISE_V3_CAPABILITY,
    enterpriseId: profile.id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
    registryRevision: registry.registryRevision, registrySha256: enterpriseRegistryHashV3(registry),
    legacyEnterpriseId: registry.legacyEnterpriseId, ready: blockers.length === 0, blockers,
  };
}

export function createEnterpriseReadinessRouter(getRegistry = getValidatedEnterpriseRegistry): Router {
  const router = Router();
  router.get('/profiles/:enterpriseId/readiness', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const registry = getRegistry();
      const scope = resolveEnterpriseScope(registry, req.params.enterpriseId);
      if (Object.keys(req.query).length || req.headers['x-enterprise-id'] !== undefined
        && req.headers['x-enterprise-id'] !== scope.enterpriseId || req.headers['x-enterprise-revision'] !== undefined
        && req.headers['x-enterprise-revision'] !== String(scope.enterpriseRevision)) {
        res.status(400).json(apiError('enterprise_scope_mismatch', 'Enterprise readiness scope does not match.'));
        return;
      }
      res.json(loginReadiness(registry, scope.enterpriseId));
    } catch (error) {
      const missing = error instanceof EnterpriseContractError && error.code === 'enterprise_not_found';
      res.status(missing ? 404 : 503).json(apiError(missing ? 'enterprise_not_found' : 'enterprise_readiness_unavailable',
        'Enterprise readiness is unavailable.'));
    }
  });
  return router;
}
