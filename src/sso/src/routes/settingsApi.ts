import { Router, type Request, type Response } from 'express';
import { apiError, errorFields, loggerFor, type UpdateSsoRuntimeSettingsRequest } from '@ghcp/shared';
import {
  getSsoRuntimeSettings,
  InvalidSsoRuntimeSettingsError,
  SsoSettingsVersionConflictError,
  updateSsoRuntimeSettings,
} from '../db/runtimeSettingsRepo.js';
import { requestEnterprise } from './requestEnterprise.js';

const logger = loggerFor('sso', 'settings-api');
const ROOT_KEYS = new Set(['expectedVersion', 'changes']);

/** `/settings/runtime` of one enterprise; mounted behind `requireEnterprise`. */
export function createSettingsApiRouter(): Router {
  const router = Router();
  router.get('/settings/runtime', (_req, res) => {
    res.json(getSsoRuntimeSettings(requestEnterprise(res).id));
  });
  router.patch('/settings/runtime', patchSettingsHandler);
  return router;
}

function patchSettingsHandler(req: Request, res: Response): void {
  const body = req.body as Partial<UpdateSsoRuntimeSettingsRequest> | undefined;
  const invalid = invalidSettingsBody(body);
  if (invalid) {
    res.status(400).json(apiError('invalid_runtime_settings', invalid));
    return;
  }
  const enterpriseId = requestEnterprise(res).id;
  try {
    res.json(updateSsoRuntimeSettings(enterpriseId, body as UpdateSsoRuntimeSettingsRequest));
  } catch (err) {
    logger.error('update-failed', 'Update SSO runtime settings failed', { enterpriseId, ...errorFields(err) });
    sendSettingsError(res, err);
  }
}

function invalidSettingsBody(body: Partial<UpdateSsoRuntimeSettingsRequest> | undefined): string | undefined {
  const changes = body?.changes;
  if (!body || typeof body !== 'object' || !Number.isInteger(body.expectedVersion)
    || !changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return 'expectedVersion and changes are required.';
  }
  const unknownRootKeys = Object.keys(body).filter((key) => !ROOT_KEYS.has(key));
  if (unknownRootKeys.length > 0) return `Unknown request field(s): ${unknownRootKeys.join(', ')}.`;
  return undefined;
}

function sendSettingsError(res: Response, err: unknown): void {
  if (err instanceof InvalidSsoRuntimeSettingsError) {
    res.status(400).json(apiError('invalid_runtime_settings', err.message, { fields: err.fields }));
    return;
  }
  if (err instanceof SsoSettingsVersionConflictError) {
    const details = { expectedVersion: err.expectedVersion, currentVersion: err.currentVersion };
    res.status(409).json(apiError('settings_version_conflict', err.message, details));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json(apiError('runtime_settings_update_failed', message));
}
