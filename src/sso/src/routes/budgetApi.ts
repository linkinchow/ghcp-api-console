import { Router, type Response } from 'express';
import { apiError, errorFields, loggerFor } from '@ghcp/shared';
import { readAiCreditsUsage, refreshAiCreditsUsage } from '../budget/budgetService.js';
import { requestEnterprise } from './requestEnterprise.js';

const logger = loggerFor('sso', 'ai-credits-api');

/** `/ai-credits/usage` of one enterprise; mounted behind `requireEnterprise`. */
export function createBudgetApiRouter(): Router {
  const router = Router();
  router.get('/ai-credits/usage', (_req, res) => {
    const usage = readAiCreditsUsage(requestEnterprise(res));
    if (!usage) {
      res.status(404).json(apiError('ai_credits_usage_not_found', 'AI Credits usage cache was not found.'));
      return;
    }
    res.json(usage);
  });
  router.post('/ai-credits/usage/refresh', (_req, res) => refreshHandler(res));
  return router;
}

async function refreshHandler(res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const fields = { enterpriseId: enterprise.id };
  try {
    logger.info('refresh-ai-credits-start', 'Refreshing AI Credits usage cache', fields);
    res.json(await refreshAiCreditsUsage(enterprise));
    logger.info('refresh-ai-credits-done', 'Refreshed AI Credits usage cache', fields);
  } catch (err) {
    logger.error('refresh-ai-credits-failed', 'AI Credits usage refresh failed', { ...fields, ...errorFields(err) });
    res.status(400).json(apiError('ai_credits_refresh_failed', (err as Error).message));
  }
}
