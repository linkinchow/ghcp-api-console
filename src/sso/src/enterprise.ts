import type { RequestHandler } from 'express';
import { apiError, EnterpriseContractError, requireEnterprise, requireEnterpriseRevision, resolveEnterpriseScope, type EnterpriseProfileV3, type EnterpriseScope } from '@ghcp/shared';
import { getEnterpriseRegistry } from './db/connection.js';

/** Never trust a caller-supplied profile object or infer a scope from a username. */
export function getScopeProfile(scope: EnterpriseScope): EnterpriseProfileV3 {
  if (!scope) throw new EnterpriseContractError('enterprise_required');
  const registry = getEnterpriseRegistry();
  const selected = resolveEnterpriseScope(registry, scope.enterpriseId);
  requireEnterpriseRevision(scope.enterpriseRevision, selected.enterpriseRevision);
  if (scope.registryRevision !== registry.registryRevision) throw new EnterpriseContractError('enterprise_registry_revision_mismatch');
  return selected.profile;
}

/** Legacy fallback is permitted only at route/fixture boundaries. */
export function getLegacyEnterpriseScope(): EnterpriseScope {
  return resolveEnterpriseScope(getEnterpriseRegistry());
}

export function requireEnterpriseInput(value: unknown, scope: EnterpriseScope): void {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const profile = getScopeProfile(scope);
  requireEnterprise(input.enterpriseId, profile.id, true);
  if (input.enterpriseRevision !== undefined) requireEnterpriseRevision(input.enterpriseRevision, profile.revision);
}

// Validate each source separately: a correct body cannot hide a wrong query/header.
export function requireEnterpriseRequest(scope: EnterpriseScope): RequestHandler {
  return (req, res, next) => {
    try {
      requireEnterpriseInput(req.body, scope);
      requireEnterpriseInput({ ...req.query, enterpriseRevision: numericRevision(req.query.enterpriseRevision) }, scope);
      requireEnterpriseInput({ enterpriseId: req.headers['x-enterprise-id'], enterpriseRevision: numericRevision(req.headers['x-enterprise-revision']) }, scope);
      if (req.params.enterpriseId !== undefined) requireEnterpriseInput({ enterpriseId: req.params.enterpriseId }, scope);
      next();
    } catch (error) {
      if (!(error instanceof EnterpriseContractError)) { next(error); return; }
      res.status(400).json(apiError(error.code, 'Enterprise identity or revision does not match the registered profile.'));
    }
  };
}

function numericRevision(value: unknown): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}
