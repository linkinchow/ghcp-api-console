import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  apiError,
  csvExport,
  errorFields,
  loggerFor,
  readManagementQuery,
  SecretError,
  withSqliteReadSnapshot,
} from '@ghcp/shared';
import type { ImportEmuUserStatus, SsoUserBatchOperation, SsoUserLoginCredentialsResponse } from '@ghcp/shared';
import { getDb } from '../db/connection.js';
import {
  getUser,
  listUsers,
  PoolMemberManagedError,
  summarizeUsers,
  SsoUserLimitReachedError,
  toDto,
  type SsoUserRecord,
} from '../db/usersRepo.js';
import { PoolMembershipUnavailableError } from '../clients/proxyClient.js';
import type { ScimEnterpriseRole } from '../scim/scimClient.js';
import { knownDefaultPasswordForUserAsync, PoolPasswordPolicyError } from '../users/passwordPolicy.js';
import {
  applyEmuImportPlan,
  assignCopilotSeatForSsoUser,
  createEmuImportPlan,
  createSsoUser,
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
  type CreateSsoUserInput,
  type PatchSsoUserInput,
} from '../users/service.js';
import { requestEnterprise } from './requestEnterprise.js';

const SCIM_ENTERPRISE_ROLES = new Set<ScimEnterpriseRole>(['user', 'enterprise_owner']);
const EMU_IMPORT_ROW_STATUSES = new Set([
  'pending_create',
  'pending_update',
  'created',
  'updated',
  'skipped',
  'conflict',
  'failed',
]);
const SSO_USER_BATCH_OPERATIONS = new Set([
  'sync_emu',
  'suspend_emu',
  'delete_emu',
  'delete_sso',
  'assign_copilot',
  'remove_copilot',
]);
const EXPORT_COLUMNS = [
  'ssoUser',
  'email',
  'role',
  'ghLogin',
  'emuStatus',
  'copilotSeatStatus',
  'copilotSeatPendingCancellationDate',
  'updatedAt',
];
const logger = loggerFor('sso', 'users-api');

interface Ownership {
  expectedCreatedAt: string;
  expectedEmail: string;
}

interface BatchBody {
  operation?: unknown;
  ssoUsers?: unknown;
  enterpriseRole?: unknown;
  assignCopilotSeat?: unknown;
  createOnly?: unknown;
}

/** `/users...` of one enterprise; mounted behind `requireEnterprise` (see `enterpriseRoutes.ts`). */
export function createUsersApiRouter(): Router {
  const router = Router();
  router.post('/users/ensure', ensureUserHandler);
  router.get('/users', (req, res) => {
    res.json(listUsers(requestEnterprise(res).id, readManagementQuery(req.query)));
  });
  router.get('/users/summary', (_req, res) => res.json(summarizeUsers(requestEnterprise(res).id)));
  router.route('/users/export').get(exportUsers).post(exportUsers);
  router.get('/users/capacity', (_req, res) => res.json(getSsoUserCapacity(requestEnterprise(res))));
  router.post('/users', createUserHandler);
  router.post('/users/import', importUsersHandler);
  router.post('/users/batch', batchHandler);
  router.post('/users/emu/import', importEmuHandler);
  router.post('/users/emu/import/plans', createPlanHandler);
  router.get('/users/emu/import/plans/:planId', getPlanHandler);
  router.get('/users/emu/import/plans/:planId/rows', listPlanRowsHandler);
  router.post('/users/emu/import/plans/:planId/apply', applyPlanHandler);
  router.delete('/users/emu/import/plans/:planId', deletePlanHandler);
  router.get('/users/:ssoUser', getUserHandler);
  router.post('/users/:ssoUser/login-credentials', loginCredentialsHandler);
  router.patch('/users/:ssoUser', patchUserHandler);
  router.post('/users/:ssoUser/copilot-seat', assignSeatHandler);
  router.delete('/users/:ssoUser/copilot-seat', removeSeatHandler);
  return router;
}

async function ensureUserHandler(req: Request, res: Response): Promise<void> {
  const { identity, preferredSsoUser } = req.body as { identity?: unknown; preferredSsoUser?: unknown };
  if (typeof identity !== 'string' || !identity.trim()) {
    res.status(400).json(apiError('invalid_identity', 'identity is required.'));
    return;
  }
  const preferred = typeof preferredSsoUser === 'string' ? preferredSsoUser : undefined;
  try {
    res.json(await ensureUser(requestEnterprise(res), identity, preferred));
  } catch (err) {
    sendCreateUserError(res, err, 'ensure_user_failed');
  }
}

async function exportUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const enterpriseId = requestEnterprise(res).id;
  const handler = csvExport(
    'sso-users',
    EXPORT_COLUMNS,
    async (query) => listUsers(enterpriseId, query),
    (user) => [
      user.ssoUser,
      user.email,
      user.role,
      user.ghLogin,
      user.emuStatus,
      user.copilotSeatStatus,
      user.copilotSeatPendingCancellationDate,
      user.updatedAt,
    ],
    (_query, consume) => withSqliteReadSnapshot(getDb(), (database) => (
      consume(async (query) => listUsers(enterpriseId, query, database))
    )),
  );
  await handler(req, res, next);
}

async function createUserHandler(req: Request, res: Response): Promise<void> {
  if (req.body?.poolManaged !== undefined && typeof req.body.poolManaged !== 'boolean') {
    res.status(400).json(apiError('invalid_pool_managed', 'poolManaged must be a boolean when provided.'));
    return;
  }
  try {
    res.status(201).json(await createSsoUser(requestEnterprise(res), req.body as CreateSsoUserInput));
  } catch (err) {
    sendCreateUserError(res, err, 'create_user_failed');
  }
}

async function importUsersHandler(req: Request, res: Response): Promise<void> {
  const { csvText } = req.body as { csvText?: unknown };
  if (typeof csvText !== 'string' || !csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  res.json(await importUsers(requestEnterprise(res), csvText));
}

async function batchHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as BatchBody;
  const invalid = invalidBatchBody(body);
  if (invalid) {
    res.status(400).json(apiError(invalid.code, invalid.message));
    return;
  }
  const request = {
    operation: body.operation as SsoUserBatchOperation,
    ssoUsers: body.ssoUsers as string[],
    enterpriseRole: body.enterpriseRole as ScimEnterpriseRole | undefined,
    assignCopilotSeat: body.assignCopilotSeat as boolean | undefined,
    createOnly: body.createOnly as boolean | undefined,
  };
  const { ssoUsers, ...fields } = request;
  const enterprise = requestEnterprise(res);
  const logFields = { ...fields, total: ssoUsers.length };
  await sendAsync(res, 'batch-users', logFields, () => runSsoUserBatch(enterprise, request));
}

function invalidBatchBody(body: BatchBody): { code: string; message: string } | undefined {
  if (typeof body.operation !== 'string' || !SSO_USER_BATCH_OPERATIONS.has(body.operation)) {
    const operations = [...SSO_USER_BATCH_OPERATIONS].join(', ');
    return { code: 'invalid_operation', message: `operation must be one of ${operations}.` };
  }
  if (!Array.isArray(body.ssoUsers) || body.ssoUsers.some((ssoUser) => typeof ssoUser !== 'string')) {
    return { code: 'invalid_sso_users', message: 'ssoUsers must be an array of strings.' };
  }
  if (body.ssoUsers.length === 0) return { code: 'invalid_sso_users', message: 'At least one ssoUser is required.' };
  if (body.enterpriseRole !== undefined && !SCIM_ENTERPRISE_ROLES.has(body.enterpriseRole as ScimEnterpriseRole)) {
    return { code: 'invalid_enterprise_role', message: 'enterpriseRole must be "user" or "enterprise_owner".' };
  }
  if (body.assignCopilotSeat !== undefined && typeof body.assignCopilotSeat !== 'boolean') {
    return { code: 'invalid_assign_copilot_seat', message: 'assignCopilotSeat must be a boolean when provided.' };
  }
  if (body.createOnly !== undefined && (typeof body.createOnly !== 'boolean' || body.operation !== 'sync_emu')) {
    return { code: 'invalid_create_only', message: 'createOnly must be a boolean and is only supported for sync_emu.' };
  }
  return undefined;
}

async function importEmuHandler(req: Request, res: Response): Promise<void> {
  const { ssoUser, dryRun } = req.body as { ssoUser?: unknown; dryRun?: unknown };
  if (ssoUser !== undefined && typeof ssoUser !== 'string') {
    res.status(400).json(apiError('invalid_sso_user', 'ssoUser must be a string when provided.'));
    return;
  }
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    res.status(400).json(apiError('invalid_dry_run', 'dryRun must be a boolean when provided.'));
    return;
  }
  const enterprise = requestEnterprise(res);
  const input = { ssoUser: ssoUser as string | undefined, dryRun: dryRun as boolean | undefined };
  await sendAsync(res, 'import-emu-users', input, () => importEmuUsers(enterprise, input));
}

async function createPlanHandler(req: Request, res: Response): Promise<void> {
  const { ssoUser } = req.body as { ssoUser?: unknown };
  if (ssoUser !== undefined && typeof ssoUser !== 'string') {
    res.status(400).json(apiError('invalid_sso_user', 'ssoUser must be a string when provided.'));
    return;
  }
  const enterprise = requestEnterprise(res);
  const input = { ssoUser: ssoUser as string | undefined };
  await sendAsync(res, 'create-emu-import-plan', input, () => createEmuImportPlan(enterprise, input));
}

async function getPlanHandler(req: Request, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const { planId } = req.params as { planId: string };
  await sendAsync(res, 'get-emu-import-plan', { planId }, async () => getEmuImportPlan(enterprise, planId));
}

async function listPlanRowsHandler(req: Request, res: Response): Promise<void> {
  const status = stringQuery(req.query.status);
  if (status && !EMU_IMPORT_ROW_STATUSES.has(status)) {
    res.status(400).json(apiError('invalid_status', 'status is not a valid EMU import row status.'));
    return;
  }
  const enterprise = requestEnterprise(res);
  const { planId } = req.params as { planId: string };
  const query = {
    status: status as ImportEmuUserStatus | undefined,
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize),
  };
  await sendAsync(res, 'list-emu-import-plan-rows', { planId, status }, async () => (
    listEmuImportPlanRows(enterprise, planId, query)
  ));
}

async function applyPlanHandler(req: Request, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const { planId } = req.params as { planId: string };
  await sendAsync(res, 'apply-emu-import-plan', { planId }, () => applyEmuImportPlan(enterprise, planId));
}

async function deletePlanHandler(req: Request, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const { planId } = req.params as { planId: string };
  await sendAsync(res, 'delete-emu-import-plan', { planId }, async () => {
    deleteEmuImportPlan(enterprise, planId);
  }, 204);
}

function getUserHandler(req: Request, res: Response): void {
  const user = getUser(requestEnterprise(res).id, req.params.ssoUser as string);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
    return;
  }
  res.json(toDto(user));
}

// Mounted behind requireInternalToken. This deliberately never ensures, creates or changes a
// user/password: ownership is checked on the same read snapshot.
async function loginCredentialsHandler(req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'no-store');
  const ownership = readOwnership(req.body);
  if (!ownership) {
    const message = 'expectedCreatedAt and expectedEmail are required; expectedCreatedAt must be a timestamp.';
    res.status(400).json(apiError('invalid_ownership', message));
    return;
  }
  const enterprise = requestEnterprise(res);
  const ssoUser = req.params.ssoUser as string;
  const user = getUser(enterprise.id, ssoUser);
  if (!user) {
    res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
    return;
  }
  if (!isEligibleOwner(user, ssoUser, ownership)) {
    const message = 'SSO user no longer matches the expected ownership or is not eligible for login.';
    res.status(409).json(apiError('user_ownership_mismatch', message));
    return;
  }
  const passwordForLogin = await knownDefaultPasswordForUserAsync(enterprise, user);
  if (passwordForLogin === undefined) {
    const message = 'The existing SSO user password is not available for automatic login.';
    res.status(409).json(apiError('login_credentials_unavailable', message));
    return;
  }
  res.json({ user: toDto(user), passwordForLogin } satisfies SsoUserLoginCredentialsResponse);
}

function isEligibleOwner(user: SsoUserRecord, ssoUser: string, ownership: Ownership): boolean {
  if (user.ssoUser !== ssoUser || user.role !== 'user') return false;
  if (user.createdAt !== ownership.expectedCreatedAt || user.email !== ownership.expectedEmail) return false;
  return user.emuStatus !== 'suspended' && user.emuStatus !== 'deleted';
}

function readOwnership(body: unknown): Ownership | undefined {
  const { expectedCreatedAt, expectedEmail } = (body ?? {}) as { expectedCreatedAt?: unknown; expectedEmail?: unknown };
  if (typeof expectedCreatedAt !== 'string' || !expectedCreatedAt.trim()) return undefined;
  if (!Number.isFinite(Date.parse(expectedCreatedAt))) return undefined;
  if (typeof expectedEmail !== 'string' || !expectedEmail.trim()) return undefined;
  return { expectedCreatedAt, expectedEmail };
}

async function patchUserHandler(req: Request, res: Response): Promise<void> {
  try {
    const input = req.body as PatchSsoUserInput;
    const user = await patchSsoUser(requestEnterprise(res), req.params.ssoUser as string, input);
    if (!user) {
      res.status(404).json(apiError('user_not_found', 'SSO user was not found.'));
      return;
    }
    res.json(user);
  } catch (err) {
    if (!(err instanceof PoolMemberManagedError)) throw err;
    res.status(409).json(apiError(err.code, err.message));
  }
}

async function assignSeatHandler(req: Request, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const ssoUser = req.params.ssoUser as string;
  await sendAsync(res, 'assign-copilot-seat', { ssoUser }, () => assignCopilotSeatForSsoUser(enterprise, ssoUser));
}

async function removeSeatHandler(req: Request, res: Response): Promise<void> {
  const enterprise = requestEnterprise(res);
  const ssoUser = req.params.ssoUser as string;
  await sendAsync(res, 'remove-copilot-seat', { ssoUser }, async () => {
    const result = await removeCopilotSeatForSsoUser(enterprise, ssoUser);
    return result.user;
  });
}

async function sendAsync(
  res: Response,
  operation: string,
  fields: Record<string, unknown>,
  fn: () => Promise<unknown>,
  successStatus = 200,
): Promise<void> {
  try {
    const result = await fn();
    if (successStatus === 204) {
      res.status(204).end();
      return;
    }
    res.status(successStatus).json(result);
  } catch (err) {
    const enterpriseId = requestEnterprise(res).id;
    logger.error(`${operation}-failed`, 'SSO user operation failed', { enterpriseId, ...fields, ...errorFields(err) });
    sendOperationError(res, err);
  }
}

function sendOperationError(res: Response, err: unknown): void {
  if (err instanceof PoolMemberManagedError) {
    res.status(409).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof PoolMembershipUnavailableError) {
    res.status(503).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof SecretError) {
    res.status(503).json(apiError(err.code, err.message));
    return;
  }
  res.status(400).json(apiError('operation_failed', (err as Error).message));
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

function sendCreateUserError(res: Response, err: unknown, fallbackCode: string): void {
  const enterpriseId = requestEnterprise(res).id;
  logger.error(fallbackCode, 'Create SSO user failed', { enterpriseId, ...errorFields(err) });
  if (err instanceof PoolPasswordPolicyError) {
    res.status(400).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof SsoUserLimitReachedError) {
    const details = { current: err.current, limit: err.limit };
    res.status(409).json(apiError('sso_user_limit_reached', err.message, details));
    return;
  }
  res.status(400).json(apiError(fallbackCode, err instanceof Error ? err.message : String(err)));
}

