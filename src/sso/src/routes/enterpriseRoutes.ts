import { Router, type Request, type Response } from 'express';
import { apiError, requireEnterprise } from '@ghcp/shared';
import { requireInternalToken } from '../auth/internalAuth.js';
import { findSsoEnterprise } from '../enterprises.js';
import { createBudgetApiRouter } from './budgetApi.js';
import { createLoginCredentialsRouter } from './loginCredentials.js';
import { createUserOperationsHandler } from './operationsApi.js';
import { createSettingsApiRouter } from './settingsApi.js';
import { createUsersApiRouter } from './usersApi.js';

/**
 * Management API of one enterprise (design §5.1): users, settings, AI credits and operations under the same
 * sub-paths as the single-enterprise `/api/...`. Mount at `/api/enterprises/:enterpriseId`.
 */
export function createEnterpriseApiRouter(): Router {
  const router = scopedRouter();
  router.use('/users/operations', createUserOperationsHandler());
  router.use(createSettingsApiRouter(), createUsersApiRouter(), createBudgetApiRouter());
  router.use(notFound);
  return router;
}

/**
 * Service-to-service routes of one enterprise (Login's credential lookup).
 * Mount at `/internal/enterprises/:enterpriseId`.
 */
export function createEnterpriseInternalRouter(): Router {
  const router = scopedRouter();
  router.use(createLoginCredentialsRouter());
  router.use(notFound);
  return router;
}

/** Unscoped `/api/*` and `/internal/*` requests never fall back to `default` (design §1.1 item 5, §13 #2). */
export function rejectUnscoped(_req: Request, res: Response): void {
  const message = 'Use /api/enterprises/:enterpriseId/... or /internal/enterprises/:enterpriseId/....';
  res.status(400).json(apiError('enterprise_scope_required', message));
}

/** A scoped path that matches no route must not fall through to `rejectUnscoped`. */
function notFound(_req: Request, res: Response): void {
  res.status(404).json(apiError('not_found', 'SSO route is not implemented.'));
}

/** Internal token first, so an unauthenticated caller cannot probe which enterprises exist. */
function scopedRouter(): Router {
  const router = Router({ mergeParams: true });
  router.use(requireInternalToken, requireEnterprise(findSsoEnterprise));
  return router;
}
