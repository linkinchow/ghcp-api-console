import { Router, type Request, type Response } from 'express';
import { apiError, requireEnterprise } from '@ghcp/shared';
import { requireInternalToken } from '../auth/internalAuth.js';
import { findLoginEnterprise } from '../enterprises.js';
import { createTaskOperationsHandler } from './operationsApi.js';
import { createTasksApiRouter } from './tasksApi.js';

/**
 * Management API of one enterprise (design §5.1): tasks, queue and operations under the same sub-paths as the
 * single-enterprise `/api/...`. Mount at `/api/enterprises/:enterpriseId`.
 */
export function createEnterpriseApiRouter(): Router {
  const router = Router({ mergeParams: true });
  // Internal token first, so an unauthenticated caller cannot probe which enterprises exist.
  router.use(requireInternalToken, requireEnterprise(findLoginEnterprise));
  router.use('/tasks/operations', createTaskOperationsHandler());
  router.use(createTasksApiRouter());
  router.use(notFound);
  return router;
}

/**
 * Unscoped `/api/*` requests never fall back to `default` (design §1.1 item 5, §13 #2). Only the process-wide
 * runtime settings (`/api/settings/runtime`) stay unscoped: concurrency is a Login process resource (§4.4).
 */
export function rejectUnscoped(_req: Request, res: Response): void {
  const message = 'Use /api/enterprises/:enterpriseId/....';
  res.status(400).json(apiError('enterprise_scope_required', message));
}

/** A scoped path that matches no route must not fall through to `rejectUnscoped`. */
function notFound(_req: Request, res: Response): void {
  res.status(404).json(apiError('not_found', 'Login route is not implemented.'));
}
