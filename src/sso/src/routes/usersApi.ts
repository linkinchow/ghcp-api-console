import { Router } from 'express';
import { apiError, errorFields, loggerFor } from '@ghcp/shared';
import { getUser, listUsers, PoolMemberManagedError, SsoUserLimitReachedError, toDto } from '../db/usersRepo.js';
import { PoolMembershipUnavailableError } from '../clients/proxyClient.js';
import type { ScimEnterpriseRole } from '../scim/scimClient.js';
import type { ImportEmuUserStatus, SsoUserBatchOperation, SsoUserLoginCredentialsResponse } from '@ghcp/shared';
import { knownDefaultPasswordForUser, PoolPasswordPolicyError } from '../users/passwordPolicy.js';
import {
  applyEmuImportPlan,
  assignCopilotSeatForSsoUser,
  createSsoUser,
  createEmuImportPlan,
  deleteEmuImportPlan,
  ensureUser,
  getEmuImportPlan,
  getSsoUserCapacity,
  importEmuUsers,
  importUsers,
  listEmuImportPlanRows,
  patchSsoUser,
  removeCopilotSeatForSsoUser,
  runSsoUserBatch,
} from '../users/service.js';

export const usersApiRouter = Router();
const SCIM_ENTERPRISE_ROLES = new Set<ScimEnterpriseRole>(['user', 'enterprise_owner']);
const EMU_IMPORT_ROW_STATUSES = new Set(['pending_create', 'pending_update', 'created', 'updated', 'skipped', 'conflict', 'failed']);
const SSO_USER_BATCH_OPERATIONS = new Set(['sync_emu', 'suspend_emu', 'delete_emu', 'delete_sso', 'assign_copilot', 'remove_copilot']);
const logger = loggerFor('sso', 'users-api');

usersApiRouter.post('/users/ensure', (req, res) => {
  const { identity, preferredSsoUser } = req.body as { identity?: unknown; preferredSsoUser?: unknown };
  if (typeof identity !== 'string' || !identity.trim()) {
    res.status(400).json(apiError('invalid_identity', 'identity is required.'));
    return;
  }
  try {
    res.json(ensureUser(identity, typeof preferredSsoUser === 'string' ? preferredSsoUser : undefined));
  } catch (err) {
    sendCreateUserError(res, err, 'ensure_user_failed');
  }
});

usersApiRouter.get('/users', (req, res) => {
  res.json(
    listUsers({
      q: stringQuery(req.query.q),
      page: numberQuery(req.query.page),
      pageSize: numberQuery(req.query.pageSize),
      sort: stringQuery(req.query.sort) as never,
      dir: stringQuery(req.query.dir) as never,
    }),
  );
});

usersApiRouter.get('/users/capacity', (_req, res) => {
  res.json(getSsoUserCapacity());
});

usersApiRouter.post('/users', (req, res) => {
  if (req.body?.poolManaged !== undefined && typeof req.body.poolManaged !== 'boolean') {
    res.status(400).json(apiError('invalid_pool_managed', 'poolManaged must be a boolean when provided.'));
    return;
  }
  try {
    res.status(201).json(createSsoUser(req.body as Parameters<typeof createSsoUser>[0]));
  } catch (err) {
    sendCreateUserError(res, err, 'create_user_failed');
  }
});

usersApiRouter.post('/users/import', (req, res) => {
  const { csvText } = req.body as { csvText?: unknown };
  if (typeof csvText !== 'string' || !csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  res.json(importUsers(csvText));
});

usersApiRouter.post('/users/batch', async (req, res) => {
  const body = req.body as { operation?: unknown; ssoUsers?: unknown; enterpriseRole?: unknown; assignCopilotSeat?: unknown; createOnly?: unknown };
  if (typeof body.operation !== 'string' || !SSO_USER_BATCH_OPERATIONS.has(body.operation)) {
    res.status(400).json(apiError('invalid_operation', 'operation must be one of sync_emu, suspend_emu, delete_emu, delete_sso, assign_copilot, remove_copilot.'));
    return;
  }
  if (!Array.isArray(body.ssoUsers) || body.ssoUsers.some((ssoUser) => typeof ssoUser !== 'string')) {
    res.status(400).json(apiError('invalid_sso_users', 'ssoUsers must be an array of strings.'));
    return;
  }
  if (body.ssoUsers.length === 0) {
    res.status(400).json(apiError('invalid_sso_users', 'At least one ssoUser is required.'));
    return;
  }
  if (body.enterpriseRole !== undefined && !SCIM_ENTERPRISE_ROLES.has(body.enterpriseRole as ScimEnterpriseRole)) {
    res.status(400).json(apiError('invalid_enterprise_role', 'enterpriseRole must be "user" or "enterprise_owner".'));
    return;
  }
  if (body.assignCopilotSeat !== undefined && typeof body.assignCopilotSeat !== 'boolean') {
    res.status(400).json(apiError('invalid_assign_copilot_seat', 'assignCopilotSeat must be a boolean when provided.'));
    return;
  }
  if (body.createOnly !== undefined && (typeof body.createOnly !== 'boolean' || body.operation !== 'sync_emu')) {
    res.status(400).json(apiError('invalid_create_only', 'createOnly must be a boolean and is only supported for sync_emu.'));
    return;
  }
  const operation = body.operation as SsoUserBatchOperation;
  const enterpriseRole = body.enterpriseRole as ScimEnterpriseRole | undefined;
  const assignCopilotSeat = body.assignCopilotSeat as boolean | undefined;
  const createOnly = body.createOnly as boolean | undefined;
  await sendAsync(res, 'batch-users', {
    operation,
    total: body.ssoUsers.length,
    enterpriseRole,
    assignCopilotSeat,
    createOnly,
  }, () => runSsoUserBatch({
    operation,
    ssoUsers: body.ssoUsers as string[],
    enterpriseRole,
    assignCopilotSeat,
    createOnly,
  }));
});

usersApiRouter.post('/users/emu/import', async (req, res) => {
  const { ssoUser, dryRun } = req.body as { ssoUser?: unknown; dryRun?: unknown };
  if (ssoUser !== undefined && typeof ssoUser !== 'string') {
    res.status(400).json(apiError('invalid_sso_user', 'ssoUser must be a string when provided.'));
    return;
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    res.status(400).json(apiError('invalid_dry_run', 'dryRun must be a boolean when provided.'));
    return;
  }
  await sendAsync(res, 'import-emu-users', { ssoUser, dryRun }, () => importEmuUsers({
    ssoUser: typeof ssoUser === 'string' ? ssoUser : undefined,
    dryRun: typeof dryRun === 'boolean' ? dryRun : undefined,
  }));
});

usersApiRouter.post('/users/emu/import/plans', async (req, res) => {
  const { ssoUser } = req.body as { ssoUser?: unknown };
  if (ssoUser !== undefined && typeof ssoUser !== 'string') {
    res.status(400).json(apiError('invalid_sso_user', 'ssoUser must be a string when provided.'));
    return;
  }
  await sendAsync(res, 'create-emu-import-plan', { ssoUser }, () => createEmuImportPlan({ ssoUser: typeof ssoUser === 'string' ? ssoUser : undefined }));
});

usersApiRouter.get('/users/emu/import/plans/:planId', async (req, res) => {
  await sendAsync(res, 'get-emu-import-plan', { planId: req.params.planId }, () => Promise.resolve(getEmuImportPlan(req.params.planId)));
});

usersApiRouter.get('/users/emu/import/plans/:planId/rows', async (req, res) => {
  const status = stringQuery(req.query.status);
  if (status && !EMU_IMPORT_ROW_STATUSES.has(status)) {
    res.status(400).json(apiError('invalid_status', 'status is not a valid EMU import row status.'));
    return;
  }
  const rowStatus = status as ImportEmuUserStatus | undefined;
  await sendAsync(res, 'list-emu-import-plan-rows', { planId: req.params.planId, status }, () => Promise.resolve(listEmuImportPlanRows(req.params.planId, {
    status: rowStatus,
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize),
  })));
});

usersApiRouter.post('/users/emu/import/plans/:planId/apply', async (req, res) => {
  await sendAsync(res, 'apply-emu-import-plan', { planId: req.params.planId }, () => Promise.resolve(applyEmuImportPlan(req.params.planId)));
});

usersApiRouter.delete('/users/emu/import/plans/:planId', async (req, res) => {
  await sendAsync(res, 'delete-emu-import-plan', { planId: req.params.planId }, () => {
    deleteEmuImportPlan(req.params.planId);
    return Promise.resolve(undefined);
  }, 204);
});

usersApiRouter.get('/users/:ssoUser', (req, res) => {
  const user = getUser(req.params.ssoUser);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
    return;
  }
  res.json(toDto(user));
});

// Mounted behind requireInternalToken in server.ts. This deliberately never ensures,
// creates or changes a user/password: ownership is checked on the same read snapshot.
usersApiRouter.post('/users/:ssoUser/login-credentials', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { expectedCreatedAt, expectedEmail } = (req.body ?? {}) as { expectedCreatedAt?: unknown; expectedEmail?: unknown };
  if (typeof expectedCreatedAt !== 'string' || !expectedCreatedAt.trim() || !Number.isFinite(Date.parse(expectedCreatedAt))
    || typeof expectedEmail !== 'string' || !expectedEmail.trim()) {
    res.status(400).json(apiError('invalid_ownership', 'expectedCreatedAt and expectedEmail are required; expectedCreatedAt must be a timestamp.'));
    return;
  }
  const user = getUser(req.params.ssoUser);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
    return;
  }
  if (user.ssoUser !== req.params.ssoUser || user.createdAt !== expectedCreatedAt || user.email !== expectedEmail
    || user.role !== 'user' || user.emuStatus === 'suspended' || user.emuStatus === 'deleted') {
    res.status(409).json(apiError('user_ownership_mismatch', 'SSO user no longer matches the expected ownership or is not eligible for login.'));
    return;
  }
  const passwordForLogin = knownDefaultPasswordForUser(user);
  if (passwordForLogin === undefined) {
    res.status(409).json(apiError('login_credentials_unavailable', 'The existing SSO user password is not available for automatic login.'));
    return;
  }
  res.json({ user: toDto(user), passwordForLogin } satisfies SsoUserLoginCredentialsResponse);
});

usersApiRouter.patch('/users/:ssoUser', (req, res, next) => {
  try {
    const user = patchSsoUser(req.params.ssoUser, req.body as { password?: string; email?: string; role?: 'user' | 'admin' });
    if (!user) {
      res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
      return;
    }
    res.json(user);
  } catch (err) {
    if (err instanceof PoolMemberManagedError) {
      res.status(409).json(apiError(err.code, err.message));
      return;
    }
    next(err);
  }
});

usersApiRouter.post('/users/:ssoUser/copilot-seat', async (req, res) => {
  await sendAsync(res, 'assign-copilot-seat', { ssoUser: req.params.ssoUser }, () => assignCopilotSeatForSsoUser(req.params.ssoUser));
});

usersApiRouter.delete('/users/:ssoUser/copilot-seat', async (req, res) => {
  await sendAsync(res, 'remove-copilot-seat', { ssoUser: req.params.ssoUser }, async () => {
    const result = await removeCopilotSeatForSsoUser(req.params.ssoUser);
    return result.user;
  });
});

async function sendAsync(res: import('express').Response, operation: string, fields: Record<string, unknown>, fn: () => Promise<unknown>, successStatus = 200): Promise<void> {
  try {
    const result = await fn();
    if (successStatus === 204) {
      res.status(204).end();
      return;
    }
    res.status(successStatus).json(result);
  } catch (err) {
    logger.error(`${operation}-failed`, 'SSO user operation failed', { ...fields, ...errorFields(err) });
    if (err instanceof PoolMemberManagedError || err instanceof PoolMembershipUnavailableError) {
      res.status(err instanceof PoolMemberManagedError ? 409 : 503).json(apiError(err.code, err.message));
      return;
    }
    res.status(400).json(apiError('operation_failed', (err as Error).message));
  }
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const raw = stringQuery(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sendCreateUserError(res: import('express').Response, err: unknown, fallbackCode: string): void {
  logger.error(fallbackCode, 'Create SSO user failed', { ...errorFields(err) });
  if (err instanceof PoolPasswordPolicyError) {
    res.status(400).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof SsoUserLimitReachedError) {
    res.status(409).json(apiError('sso_user_limit_reached', err.message, {
      current: err.current,
      limit: err.limit,
    }));
    return;
  }
  res.status(400).json(apiError(fallbackCode, err instanceof Error ? err.message : String(err)));
}
