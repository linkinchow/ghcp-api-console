import { Router, type NextFunction, type Request, type Response } from 'express';
import { apiError, requireEnterprise } from '@ghcp/shared';
import { requireInternalToken } from '../auth/internalAuth.js';
import { findProxyEnterprise } from '../enterprises.js';
import {
  createAccountsRouter,
  createRequestStatsRouter,
  enterpriseAccountScope,
  legacyAccountScope,
} from './accountsApi.js';
import { createInternalApiRouter, type InternalApiDependencies } from './internalApi.js';
import { createModelsApiRouter } from './modelsApi.js';
import { createAccountOperationsHandler } from './operationsApi.js';
import { createEnterpriseUserPoolRouter } from './userPoolApi.js';

/**
 * Management API of one enterprise (design §5.2): accounts, operations, statistics, pool members and Models
 * under the same sub-paths as the single-enterprise `/api/...`. Mount at `/api/enterprises/:enterpriseId`.
 */
export function createEnterpriseApiRouter(): Router {
  const router = scopedRouter();
  router.use('/accounts/operations', createAccountOperationsHandler());
  router.use(createAccountsRouter(enterpriseAccountScope), createRequestStatsRouter());
  router.use(createEnterpriseUserPoolRouter(), createModelsApiRouter());
  router.use(notFound);
  return router;
}

/** Login and SSO callbacks of one enterprise. Mount at `/internal/enterprises/:enterpriseId`. */
export function createEnterpriseInternalRouter(dependencies: Partial<InternalApiDependencies> = {}): Router {
  const router = scopedRouter();
  router.use(createInternalApiRouter(dependencies));
  router.use(notFound);
  return router;
}

/**
 * The single-enterprise account routes, kept for one release (design §13 #2): listing uses
 * DIRECT_MODE_ENTERPRISE_ID and single rows are addressed by global identity. Every response is marked deprecated.
 */
export function createLegacyAccountsRouter(): Router {
  const router = Router();
  router.use('/accounts', markDeprecated);
  router.use(createAccountsRouter(legacyAccountScope));
  return router;
}

/** Unscoped pool, statistics, Models and internal paths never fall back to `default` (design §5.1). */
export function rejectUnscoped(_req: Request, res: Response): void {
  const message = 'Use /api/enterprises/:enterpriseId/... or /internal/enterprises/:enterpriseId/....';
  res.status(400).json(apiError('enterprise_scope_required', message));
}

function markDeprecated(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Deprecation', 'true');
  next();
}

/** A scoped path that matches no route must not fall through to `rejectUnscoped`. */
function notFound(_req: Request, res: Response): void {
  res.status(404).json(apiError('not_found', 'Proxy route is not implemented.'));
}

/** Internal token first, so an unauthenticated caller cannot probe which enterprises exist. */
function scopedRouter(): Router {
  const router = Router({ mergeParams: true });
  router.use(requireInternalToken, requireEnterprise(findProxyEnterprise));
  return router;
}
