import type { RequestHandler } from 'express';
import { apiError, EnterpriseContractError, resolveEnterpriseScope, type EnterpriseScope, type AuthorizationBinding, parseAuthorizationBinding } from '@ghcp/shared';
import { getEnterpriseRegistry } from './db/connection.js';

/** Explicit task inputs always carry a revision; no historical binding is inferred. */
export function requireEnterpriseInput(value: { enterpriseId: string; enterpriseRevision?: number }): EnterpriseScope {
  const scope = resolveEnterpriseScope(getEnterpriseRegistry(), value.enterpriseId);
  if (value.enterpriseRevision !== scope.enterpriseRevision) throw new EnterpriseContractError('enterprise_revision_mismatch');
  return scope;
}

export function bindingFromInput(value: unknown): AuthorizationBinding {
  const input = value as Record<string, unknown>;
  return parseAuthorizationBinding(Object.fromEntries([
    'enterpriseId', 'enterpriseRevision', 'identity', 'accountIncarnation', 'oauthAttemptId', 'expectedGhLogin', 'expectedGithubUserId',
  ].filter(key => input?.[key] !== undefined).map(key => [key, input[key]])));
}

/** Mounted once: scoped paths select a registered UUID, root paths select only the immutable legacy pin. */
export const requireEnterpriseRequest: RequestHandler = (req, res, next) => {
  try {
    const scope = resolveEnterpriseScope(getEnterpriseRegistry(), req.params.enterpriseId);
    for (const source of [req.body, req.query, {
      enterpriseId: req.headers['x-enterprise-id'], enterpriseRevision: req.headers['x-enterprise-revision'],
    }]) {
      if (!source || typeof source !== 'object') continue;
      if (source.enterpriseId !== undefined && source.enterpriseId !== scope.enterpriseId) {
        throw new EnterpriseContractError('enterprise_scope_mismatch');
      }
      if (source.enterpriseRevision !== undefined && numericRevision(source.enterpriseRevision) !== scope.enterpriseRevision) {
        throw new EnterpriseContractError('enterprise_revision_mismatch');
      }
      if (source.ssoUrl !== undefined || source.selectorOverrides !== undefined) {
        throw new EnterpriseContractError('enterprise_route_override_forbidden');
      }
    }
    res.locals.enterpriseScope = scope;
    next();
  } catch (error) {
    if (!(error instanceof EnterpriseContractError)) { next(error); return; }
    res.status(error.code === 'enterprise_not_found' ? 404 : 400).json(apiError(error.code, 'Enterprise scope or revision is invalid.'));
  }
};

function numericRevision(value: unknown): unknown {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
}
