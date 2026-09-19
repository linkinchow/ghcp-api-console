import type { EnterpriseScope } from '@ghcp/shared';
import { Router } from 'express';
import { apiError, errorFields, loggerFor } from '@ghcp/shared';
import { readAiCreditsUsage, refreshAiCreditsUsage } from '../budget/budgetService.js';

export function createBudgetApiRouter(scope: EnterpriseScope): Router {
const budgetApiRouter = Router();
const logger = loggerFor('sso', 'ai-credits-api');

budgetApiRouter.get('/ai-credits/usage', (_req, res) => {
  const usage = readAiCreditsUsage(undefined, scope);
  if (!usage) {
    res.status(404).json(apiError('ai_credits_usage_not_found', 'AI Credits usage cache was not found.'));
    return;
  }
  res.json(usage);
});

budgetApiRouter.post('/ai-credits/usage/refresh', async (_req, res) => {
  try {
    logger.info('refresh-ai-credits-start', 'Refreshing AI Credits usage cache', { enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
    res.json(await refreshAiCreditsUsage(undefined, scope));
    logger.info('refresh-ai-credits-done', 'Refreshed AI Credits usage cache', { enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  } catch (err) {
    logger.error('refresh-ai-credits-failed', 'AI Credits usage refresh failed', { ...errorFields(err), enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
    res.status(400).json(apiError('ai_credits_refresh_failed', (err as Error).message));
  }
});

return budgetApiRouter;
}
