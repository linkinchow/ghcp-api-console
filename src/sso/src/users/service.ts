import type {
  BatchResult,
  CopilotSeatOperation,
  CopilotSeatSnapshot,
  CreateImportEmuPlanRequest,
  EnsureSsoUserResponse,
  ImportEmuPlanDto,
  ImportEmuUserRow,
  ImportEmuUsersRequest,
  PageResponse,
  SsoUserBatchRequest,
  SsoUserBatchRow,
  SsoUserCapacityDto,
  SsoUserDto,
} from '@ghcp/shared';
import { errorFields, loggerFor, newBatchId, nowIso } from '@ghcp/shared';
import { hashPassword } from '../auth/password.js';
import {
  assignCopilotSeat,
  CopilotSeatNotAssignedError,
  getCopilotSeatAssignment,
  listCopilotSeatAssignments,
  removeCopilotSeat,
} from '../copilot/seats.js';
import {
  createEmuImportPlanRecord,
  deleteEmuImportPlanRecord,
  listEmuImportPlanRows as listStoredEmuImportPlanRows,
  requireEmuImportPlan,
  type EmuImportPlanRowsQuery,
} from '../db/emuImportPlansRepo.js';
import { appendUserEvent } from '../db/eventLog.js';
import { deleteProxyAccountsBySsoUser, isProxyPoolManagedSsoUser } from '../clients/proxyClient.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import {
  assertNotLocallyPoolManaged,
  countUsers,
  createUser,
  deleteUser,
  getUser,
  isPoolManagedSsoUser,
  PoolMemberManagedError,
  recordCopilotSeatError,
  toDto,
  updateCopilotSeat,
  updateEmu,
  updateUser,
  type SsoUserRecord,
  type UserPatch,
} from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { deleteProvisionedUser, suspendUser, syncUser, type ScimEnterpriseRole } from '../scim/scimClient.js';
import { parseBulkImportText, type BulkImportRow } from './bulkImport.js';
import {
  buildEmuImportPlan,
  loadScimUsersForImport,
  withoutScimUser,
  type PlannedEmuImportRow,
} from './emuImportPlan.js';
import { applyEmuImportPlan } from './emuImportApply.js';
import {
  ensureSsoUserCandidates,
  findExistingEnsureUser,
  nextAvailableSsoUser,
  sanitizeSsoUser,
  ssoUserFromEnsureInput,
} from './ssoUserNames.js';
import {
  knownDefaultPasswordForUserAsync,
  resolveInitialPassword,
  resolvePoolManagedPassword,
} from './passwordPolicy.js';

export { applyEmuImportPlan } from './emuImportApply.js';

const logger = loggerFor('sso', 'users');
const ENSURE_USER_ATTEMPTS = 3;

export interface CreateSsoUserInput {
  ssoUser: string;
  password?: string;
  email?: string;
  role?: 'user' | 'admin';
  poolManaged?: boolean;
}

export interface PatchSsoUserInput {
  password?: string;
  email?: string;
  role?: 'user' | 'admin';
}

export interface ImportUsersRow {
  line: number;
  ssoUser: string;
  status: string;
  detail: string;
}

interface SsoUserOperationOutcome {
  user?: SsoUserDto;
  warning?: string;
}

interface CopilotSeatRemovalOutcome {
  user: SsoUserRecord;
  warning?: string;
}

export async function ensureUser(
  enterprise: SsoEnterprise,
  identity: string,
  preferredSsoUser?: string,
): Promise<EnsureSsoUserResponse> {
  const candidates = ensureSsoUserCandidates(enterprise, identity, preferredSsoUser);
  const baseSsoUser = candidates[0] ?? ssoUserFromEnsureInput(enterprise, identity);
  const findExisting = () => findExistingEnsureUser(enterprise.id, identity, preferredSsoUser, candidates);
  for (let attempt = 1; attempt <= ENSURE_USER_ATTEMPTS; attempt += 1) {
    const existing = findExisting();
    if (existing) return existingEnsureUserResult(enterprise, identity, existing);
    const settings = getSsoRuntimeSettings(enterprise.id);
    const ssoUser = nextAvailableSsoUser(enterprise.id, baseSsoUser || identity, settings.userPrefix);
    const password = resolveInitialPassword(enterprise, ssoUser);
    const { passwordHash, salt } = await hashPassword(password);
    // A concurrent request may have created this identity or claimed the name while hashing.
    // The re-check and the insert below must stay free of awaits so they run atomically.
    const raced = findExisting();
    if (raced) return existingEnsureUserResult(enterprise, identity, raced);
    if (getUser(enterprise.id, ssoUser)) continue;
    const email = `${ssoUser}@${settings.emailDomain}`;
    const user = createUser(enterprise.id, { ssoUser, passwordHash, salt, email, role: 'user' });
    appendUserEvent(enterprise, 'create', user);
    logger.info('ensure-user-created', 'Created SSO user for identity', {
      enterpriseId: enterprise.id,
      identity,
      ssoUser: user.ssoUser,
    });
    return { user: toDto(user), passwordForLogin: password, created: true };
  }
  throw new Error(
    `Could not reserve an SSO user name for "${identity}" because it was taken concurrently. Retry the request.`,
  );
}

export function getSsoUserCapacity(enterprise: SsoEnterprise): SsoUserCapacityDto {
  const current = countUsers(enterprise.id);
  const limit = getSsoRuntimeSettings(enterprise.id).maxSsoUsers;
  return {
    current,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - current),
    reached: limit !== null && current >= limit,
  };
}

export async function createSsoUser(enterprise: SsoEnterprise, input: CreateSsoUserInput): Promise<SsoUserDto> {
  const ssoUser = sanitizeSsoUser(input.ssoUser);
  if (!ssoUser) throw new Error('ssoUser is required');
  assertSsoUserAvailable(enterprise, ssoUser);
  assertPoolFlags(input);
  const password = input.poolManaged
    ? resolvePoolManagedPassword(enterprise, ssoUser, input.password)
    : resolveInitialPassword(enterprise, ssoUser, input.password);
  const { passwordHash, salt } = await hashPassword(password);
  // Re-check after hashing; the check and the insert below must stay free of awaits so they run atomically.
  assertSsoUserAvailable(enterprise, ssoUser);
  const settings = getSsoRuntimeSettings(enterprise.id);
  const user = createUser(enterprise.id, {
    ssoUser,
    passwordHash,
    salt,
    email: input.email || `${ssoUser}@${settings.emailDomain}`,
    role: input.role ?? 'user',
    poolManaged: input.poolManaged,
  });
  appendUserEvent(enterprise, 'create', user);
  logger.info('create-user', 'Created SSO user', {
    enterpriseId: enterprise.id,
    ssoUser: user.ssoUser,
    email: user.email,
    role: user.role,
  });
  return toDto(user);
}

export async function patchSsoUser(
  enterprise: SsoEnterprise,
  ssoUser: string,
  input: PatchSsoUserInput,
): Promise<SsoUserDto | undefined> {
  assertNotLocallyPoolManaged(enterprise.id, ssoUser);
  const patch: UserPatch = {};
  if (input.email !== undefined) patch.email = input.email;
  if (input.role !== undefined) patch.role = input.role;
  if (input.password) Object.assign(patch, await hashPassword(input.password));
  const user = updateUser(enterprise.id, ssoUser, patch);
  if (!user) return undefined;
  logger.info('patch-user', 'Updated SSO user', {
    enterpriseId: enterprise.id,
    ssoUser: user.ssoUser,
    changedPassword: Boolean(input.password),
    emailChanged: input.email !== undefined,
    roleChanged: input.role !== undefined,
  });
  return toDto(user);
}

export async function deleteSsoUser(
  enterprise: SsoEnterprise,
  ssoUser: string,
): Promise<{ deleted: boolean; warning?: string }> {
  const user = getUser(enterprise.id, ssoUser);
  if (!user) return { deleted: false };
  await assertDestructiveOperationAllowed(enterprise, user);
  const fields = { enterpriseId: enterprise.id, ssoUser };
  logger.info('delete-user-start', 'Deleting SSO user', fields);
  const seatRemoval = await removeCopilotSeatForUser(enterprise, user);
  await deleteProvisionedUser(enterprise, user);
  const proxyDelete = await deleteProxyAccountsBySsoUser(enterprise.id, user.ssoUser);
  logger.info('delete-user-proxy-cleaned', 'Deleted proxy data for SSO user', { ...proxyDelete });
  const deleted = deleteUser(enterprise.id, ssoUser);
  if (deleted) appendUserEvent(enterprise, 'delete', user);
  logger.info('delete-user-done', 'Deleted SSO user', { ...fields, deleted });
  return { deleted, warning: seatRemoval.warning };
}

export async function syncSsoUser(
  enterprise: SsoEnterprise,
  ssoUser: string,
  enterpriseRole?: ScimEnterpriseRole,
  shouldAssignCopilotSeat = false,
  createOnly = false,
): Promise<SsoUserDto> {
  const user = requireUser(enterprise, ssoUser);
  const resolvedRole = enterpriseRole ?? enterpriseRoleForSsoUser(user);
  if (isPoolManagedSsoUser(enterprise.id, user.ssoUser) && (!createOnly || resolvedRole !== 'user')) {
    throw new PoolMemberManagedError();
  }
  const fields = { enterpriseId: enterprise.id, ssoUser };
  logger.info('sync-emu-start', 'Syncing SSO user to GH login', {
    ...fields,
    enterpriseRole: resolvedRole,
    assignCopilotSeat: shouldAssignCopilotSeat,
  });
  const provisioned = await syncUser(enterprise, user, resolvedRole, createOnly);
  const updated = updateEmu(enterprise.id, ssoUser, {
    ghLogin: provisioned.ghLogin,
    ghScimId: provisioned.scimId,
    emuStatus: 'active',
  });
  const synced = shouldAssignCopilotSeat
    ? await assignCopilotSeatForUser(enterprise, updated, provisioned.ghLogin)
    : updated;
  const message = shouldAssignCopilotSeat
    ? 'Synced SSO user to GH login and assigned Copilot seat'
    : 'Synced SSO user to GH login';
  logger.info('sync-emu-done', message, { ...fields, ghLogin: synced.ghLogin, ghScimId: synced.ghScimId });
  return toDto(synced);
}

export async function suspendSsoUser(enterprise: SsoEnterprise, ssoUser: string): Promise<SsoUserDto> {
  const user = requireUser(enterprise, ssoUser);
  await assertDestructiveOperationAllowed(enterprise, user);
  if (!user.ghScimId) throw new Error(`SSO user "${ssoUser}" is not synced to a GH login.`);
  const fields = { enterpriseId: enterprise.id, ssoUser, ghScimId: user.ghScimId };
  logger.info('suspend-emu-start', 'Suspending GH login', fields);
  await suspendUser(enterprise, user.ghScimId);
  const updated = updateEmu(enterprise.id, ssoUser, {
    ghLogin: user.ghLogin,
    ghScimId: user.ghScimId,
    emuStatus: 'suspended',
  });
  logger.info('suspend-emu-done', 'Suspended GH login', fields);
  return toDto(updated);
}

export async function deleteEmuUser(enterprise: SsoEnterprise, ssoUser: string): Promise<SsoUserOperationOutcome> {
  const user = requireUser(enterprise, ssoUser);
  await assertDestructiveOperationAllowed(enterprise, user);
  const fields = { enterpriseId: enterprise.id, ssoUser };
  logger.info('delete-emu-start', 'Deleting provisioned GH login', { ...fields, ghScimId: user.ghScimId });
  const seatRemoval = await removeCopilotSeatForUser(enterprise, user);
  await deleteProvisionedUser(enterprise, user);
  updateEmu(enterprise.id, ssoUser, { emuStatus: 'not_synced' });
  const updated = updateCopilotSeat(enterprise.id, ssoUser, { status: 'unassigned', lastOperation: 'remove' });
  logger.info('delete-emu-done', 'Deleted provisioned GH login', fields);
  return { user: toDto(updated), warning: seatRemoval.warning };
}

export async function assignCopilotSeatForSsoUser(enterprise: SsoEnterprise, ssoUser: string): Promise<SsoUserDto> {
  const user = requireUser(enterprise, ssoUser);
  const updated = await assignCopilotSeatForUser(enterprise, user);
  logger.info('assign-copilot-seat', 'Assigned GitHub Copilot seat', {
    enterpriseId: enterprise.id,
    ssoUser,
    ghLogin: updated.ghLogin,
  });
  return toDto(updated);
}

export async function removeCopilotSeatForSsoUser(
  enterprise: SsoEnterprise,
  ssoUser: string,
): Promise<SsoUserOperationOutcome> {
  const user = requireUser(enterprise, ssoUser);
  await assertDestructiveOperationAllowed(enterprise, user);
  const result = await removeCopilotSeatForUser(enterprise, user);
  if (!result.warning) {
    logger.info('remove-copilot-seat', 'Updated GitHub direct Copilot seat cancellation', {
      enterpriseId: enterprise.id,
      ssoUser,
      ghLogin: result.user.ghLogin,
      status: result.user.copilotSeatStatus,
      pendingCancellationDate: result.user.copilotSeatPendingCancellationDate,
    });
  }
  return { user: toDto(result.user), warning: result.warning };
}

export async function runSsoUserBatch(
  enterprise: SsoEnterprise,
  input: SsoUserBatchRequest,
): Promise<BatchResult<SsoUserBatchRow>> {
  const startedAt = nowIso();
  const ssoUsers = uniqueSsoUsers(input.ssoUsers);
  const fields = { enterpriseId: enterprise.id, operation: input.operation };
  logger.info('batch-start', 'Starting SSO user batch operation', {
    ...fields,
    total: ssoUsers.length,
    enterpriseRole: input.enterpriseRole,
    assignCopilotSeat: input.assignCopilotSeat,
  });
  // Only sync runs in parallel; destructive operations stay sequential as in the baseline.
  const concurrency = input.operation === 'sync_emu' ? getSsoRuntimeSettings(enterprise.id).bulkSyncConcurrency : 1;
  const runRow = (ssoUser: string) => runBatchResultRow(enterprise, ssoUser, input);
  const rows = await mapWithConcurrency(ssoUsers, concurrency, runRow);
  const failed = rows.filter((row) => row.status === 'failed').length;
  const warnings = rows.filter((row) => row.warning).length;
  const summary = { total: rows.length, success: rows.length - failed, warnings, failed };
  logger.info('batch-done', 'Finished SSO user batch operation', { ...fields, ...summary });
  return { batchId: newBatchId(), startedAt, finishedAt: nowIso(), summary, rows };
}

export async function importEmuUsers(
  enterprise: SsoEnterprise,
  input: ImportEmuUsersRequest = {},
): Promise<BatchResult<ImportEmuUserRow>> {
  const startedAt = nowIso();
  const plan = await createEmuImportPlan(enterprise, { ssoUser: input.ssoUser });
  const appliedPlan = input.dryRun ? plan : await applyEmuImportPlan(enterprise, plan.planId);
  const rows = listAllStoredEmuImportPlanRows(enterprise, appliedPlan.planId);
  return importBatchResult(startedAt, rows);
}

export async function createEmuImportPlan(
  enterprise: SsoEnterprise,
  input: CreateImportEmuPlanRequest = {},
): Promise<ImportEmuPlanDto> {
  const targetSsoUser = input.ssoUser?.trim();
  const scimUsers = await loadScimUsersForImport(enterprise, targetSsoUser);
  const copilotSeats = scimUsers.length > 0
    ? await listCopilotSeatAssignments(enterprise)
    : new Map<string, CopilotSeatSnapshot>();
  const settings = getSsoRuntimeSettings(enterprise.id);
  const notFound: PlannedEmuImportRow = {
    ssoUser: targetSsoUser ?? '',
    status: 'failed',
    detail: 'GH SCIM user was not found.',
  };
  const plannedRows = scimUsers.length > 0
    ? buildEmuImportPlan(enterprise, scimUsers, copilotSeats, settings.emailDomain)
    : [notFound];
  const plan = createEmuImportPlanRecord(enterprise.id, {
    id: newBatchId(),
    ssoUser: targetSsoUser || undefined,
    rows: plannedRows.map(withoutScimUser),
  });
  logger.info('create-emu-import-plan', 'Created GH login import alignment plan', {
    enterpriseId: enterprise.id,
    planId: plan.planId,
    ssoUser: targetSsoUser,
    ...plan.summary,
  });
  return plan;
}

export function getEmuImportPlan(enterprise: SsoEnterprise, planId: string): ImportEmuPlanDto {
  return requireEmuImportPlan(enterprise.id, planId);
}

export function listEmuImportPlanRows(
  enterprise: SsoEnterprise,
  planId: string,
  query: EmuImportPlanRowsQuery = {},
): PageResponse<ImportEmuUserRow> {
  return listStoredEmuImportPlanRows(enterprise.id, planId, query);
}

export function deleteEmuImportPlan(enterprise: SsoEnterprise, planId: string): boolean {
  const deleted = deleteEmuImportPlanRecord(enterprise.id, planId);
  logger.info('delete-emu-import-plan', 'Deleted EMU import alignment plan data', {
    enterpriseId: enterprise.id,
    planId,
    deleted,
  });
  return deleted;
}

export async function importUsers(enterprise: SsoEnterprise, csvText: string): Promise<BatchResult<ImportUsersRow>> {
  const startedAt = nowIso();
  const parsed = parseBulkImportText(csvText);
  const rows: ImportUsersRow[] = [];
  // Rows run sequentially so hashing does not saturate the libuv pool shared with DNS/fs for SCIM and GitHub calls.
  for (const row of parsed.rows) rows.push(await importUserRow(enterprise, row));
  for (const error of parsed.errors) {
    rows.push({ line: error.line, ssoUser: error.ssoUser ?? '', status: 'failed', detail: error.error });
  }
  const failed = rows.filter((r) => r.status === 'failed').length;
  const summary = { total: rows.length, success: rows.length - failed, failed };
  logger.info('import-users', 'Imported SSO users', { enterpriseId: enterprise.id, ...summary });
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary,
    rows: rows.sort((a, b) => a.line - b.line),
  };
}

async function existingEnsureUserResult(
  enterprise: SsoEnterprise,
  identity: string,
  existing: SsoUserRecord,
): Promise<EnsureSsoUserResponse> {
  logger.info('ensure-user', 'SSO user already exists', {
    enterpriseId: enterprise.id,
    identity,
    ssoUser: existing.ssoUser,
  });
  const passwordForLogin = await knownDefaultPasswordForUserAsync(enterprise, existing);
  return { user: toDto(existing), passwordForLogin, created: false };
}

function assertPoolFlags(input: CreateSsoUserInput): void {
  if (input.poolManaged !== undefined && typeof input.poolManaged !== 'boolean') {
    throw new Error('poolManaged must be a boolean.');
  }
  if (input.poolManaged && input.role !== undefined && input.role !== 'user') {
    throw new Error('Pool users must have the user role.');
  }
}

async function importUserRow(enterprise: SsoEnterprise, row: BulkImportRow): Promise<ImportUsersRow> {
  const result = (status: string, detail: string) => ({ line: row.line, ssoUser: row.ssoUser, status, detail });
  try {
    const existing = getUser(enterprise.id, row.ssoUser);
    if (existing && row.password !== undefined) {
      const hashed = await hashPassword(row.password);
      if (!updateUser(enterprise.id, row.ssoUser, hashed)) {
        throw new Error(`SSO user "${row.ssoUser}" was removed during import.`);
      }
      return result('updated', 'Updated password');
    }
    if (existing) return result('unchanged', 'Existing SSO user password was left unchanged');
    await createSsoUser(enterprise, { ssoUser: row.ssoUser, password: row.password });
    return result('created', 'Created SSO user');
  } catch (err) {
    return result('failed', (err as Error).message);
  }
}

async function assertDestructiveOperationAllowed(enterprise: SsoEnterprise, user: SsoUserRecord): Promise<void> {
  // New pool users are protected even while provisioning, before Proxy membership exists.
  assertNotLocallyPoolManaged(enterprise.id, user.ssoUser);
  // Legacy pool users have no local marker. All destructive direct operations must
  // verify membership before touching seats, SCIM, Proxy accounts, or local state.
  if (await isProxyPoolManagedSsoUser(enterprise.id, user.ssoUser)) throw new PoolMemberManagedError();
}

function requireUser(enterprise: SsoEnterprise, ssoUser: string): SsoUserRecord {
  const user = getUser(enterprise.id, ssoUser);
  if (!user) throw new Error(`SSO user "${ssoUser}" was not found.`);
  return user;
}

function assertSsoUserAvailable(enterprise: SsoEnterprise, ssoUser: string): void {
  if (getUser(enterprise.id, ssoUser)) throw new Error(`SSO user "${ssoUser}" already exists.`);
}

async function runSsoUserBatchRow(
  enterprise: SsoEnterprise,
  ssoUser: string,
  input: SsoUserBatchRequest,
): Promise<SsoUserOperationOutcome> {
  switch (input.operation) {
    case 'sync_emu': {
      const assignSeat = input.assignCopilotSeat === true;
      const createOnly = input.createOnly === true;
      return { user: await syncSsoUser(enterprise, ssoUser, input.enterpriseRole, assignSeat, createOnly) };
    }
    case 'assign_copilot':
      return { user: await assignCopilotSeatForSsoUser(enterprise, ssoUser) };
    case 'remove_copilot':
      return removeCopilotSeatForSsoUser(enterprise, ssoUser);
    case 'suspend_emu':
      return { user: await suspendSsoUser(enterprise, ssoUser) };
    case 'delete_emu':
      return deleteEmuUser(enterprise, ssoUser);
    case 'delete_sso': {
      const result = await deleteSsoUser(enterprise, ssoUser);
      if (!result.deleted) throw new Error(`SSO user "${ssoUser}" was not found.`);
      return { warning: result.warning };
    }
  }
}

async function runBatchResultRow(
  enterprise: SsoEnterprise,
  ssoUser: string,
  input: SsoUserBatchRequest,
): Promise<SsoUserBatchRow> {
  try {
    const outcome = await runSsoUserBatchRow(enterprise, ssoUser, input);
    const detail = batchSuccessDetail(input, outcome.user);
    return { ssoUser, status: 'success', detail, user: outcome.user, warning: outcome.warning };
  } catch (err) {
    return { ssoUser, status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function uniqueSsoUsers(ssoUsers: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ssoUsers) {
    const ssoUser = raw.trim();
    const key = ssoUser.toLowerCase();
    if (!ssoUser || seen.has(key)) continue;
    seen.add(key);
    result.push(ssoUser);
  }
  return result;
}

function batchSuccessDetail(input: SsoUserBatchRequest, user?: SsoUserDto): string {
  switch (input.operation) {
    case 'sync_emu':
      return input.assignCopilotSeat
        ? 'Synced to EMU and assigned Copilot seat.'
        : 'Synced to EMU.';
    case 'assign_copilot':
      return 'Assigned Copilot seat.';
    case 'remove_copilot':
      return user?.copilotSeatStatus === 'pending_cancellation'
        ? `Direct Copilot seat: cancell at ${user.copilotSeatPendingCancellationDate}.`
        : 'No enterprise direct Copilot seat is assigned.';
    case 'suspend_emu':
      return 'Suspended in EMU.';
    case 'delete_emu':
      return 'Deleted EMU provisioning data.';
    case 'delete_sso':
      return 'Deleted local SSO user.';
  }
}

async function assignCopilotSeatForUser(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  ghLogin = user.ghLogin,
): Promise<SsoUserRecord> {
  if (!ghLogin?.trim()) {
    const message = `SSO user "${user.ssoUser}" is not synced to a GH login.`;
    const patch = { status: 'assign_failed', lastOperation: 'assign', lastError: message } as const;
    const updated = updateCopilotSeat(enterprise.id, user.ssoUser, patch);
    logger.warn('assign-copilot-seat-missing-gh-login', 'Cannot assign Copilot seat without GH login', {
      enterpriseId: enterprise.id,
      ssoUser: updated.ssoUser,
    });
    throw new Error(message);
  }
  try {
    await assignCopilotSeat(enterprise, ghLogin);
  } catch (err) {
    recordSeatMutationFailure(enterprise, user, 'assign', err);
    throw err;
  }
  return confirmSeatMutation(enterprise, user, ghLogin, 'assign');
}

async function removeCopilotSeatForUser(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
): Promise<CopilotSeatRemovalOutcome> {
  const unassigned = { status: 'unassigned', lastOperation: 'remove' } as const;
  const unassign = () => updateCopilotSeat(enterprise.id, user.ssoUser, unassigned);
  const fields = { enterpriseId: enterprise.id, ssoUser: user.ssoUser };
  if (!user.ghLogin) {
    logger.info('remove-copilot-seat-skipped', 'SSO user has no GH login for Copilot seat removal', fields);
    return { user: unassign() };
  }
  try {
    await removeCopilotSeat(enterprise, user.ghLogin);
  } catch (err) {
    if (!(err instanceof CopilotSeatNotAssignedError)) {
      recordSeatMutationFailure(enterprise, user, 'remove', err);
      throw err;
    }
    const warning = `GitHub user "${user.ghLogin}" has no Copilot seat; seat removal was skipped.`;
    const details = { ...fields, ghLogin: user.ghLogin, githubStatus: err.status };
    logger.warn('remove-copilot-seat-not-assigned', warning, details);
    return { user: unassign(), warning };
  }
  return { user: await confirmSeatMutation(enterprise, user, user.ghLogin, 'remove') };
}

function recordSeatMutationFailure(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  operation: CopilotSeatOperation,
  err: unknown,
): void {
  if (['assigned', 'pending_cancellation', 'unassigned'].includes(user.copilotSeatStatus)) {
    recordCopilotSeatError(enterprise.id, user.ssoUser, operation, errorMessage(err));
  } else {
    updateCopilotSeat(enterprise.id, user.ssoUser, {
      status: operation === 'assign' ? 'assign_failed' : 'remove_failed',
      lastOperation: operation,
      lastError: errorMessage(err),
    });
  }
  logger.error(`${operation}-copilot-seat-failed`, 'GitHub Copilot seat operation failed', {
    enterpriseId: enterprise.id,
    ssoUser: user.ssoUser,
    ghLogin: user.ghLogin,
    ...errorFields(err),
  });
}

async function confirmSeatMutation(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  ghLogin: string,
  operation: CopilotSeatOperation,
): Promise<SsoUserRecord> {
  const fields = { enterpriseId: enterprise.id, ssoUser: user.ssoUser, ghLogin };
  let seat: CopilotSeatSnapshot;
  try {
    seat = await getCopilotSeatAssignment(enterprise, ghLogin);
  } catch (err) {
    const message = `GitHub accepted the Copilot seat ${operation} request, but seat status/date synchronization `
      + `failed: ${errorMessage(err)} Previous confirmed state was kept. Import from GH to confirm.`;
    recordCopilotSeatError(enterprise.id, user.ssoUser, operation, message);
    logger.error('copilot-seat-readback-failed', message, { ...fields, ...errorFields(err) });
    throw new Error(message, { cause: err });
  }
  const updated = updateCopilotSeat(enterprise.id, user.ssoUser, { ...seat, lastOperation: operation });
  if (isSeatChangeConfirmed(operation, seat)) return updated;
  const message = `GitHub accepted the Copilot seat ${operation} request, but the direct seat is still ${seat.status}. `
    + 'The requested change is not yet confirmed; Import from GH or retry to check its state.';
  recordCopilotSeatError(enterprise.id, user.ssoUser, operation, message);
  logger.warn('copilot-seat-change-unconfirmed', message, fields);
  throw new Error(message);
}

function isSeatChangeConfirmed(operation: CopilotSeatOperation, seat: CopilotSeatSnapshot): boolean {
  return operation === 'assign' ? seat.status === 'assigned' : seat.status !== 'assigned';
}

function enterpriseRoleForSsoUser(user: SsoUserRecord): ScimEnterpriseRole {
  return user.role === 'admin' ? 'enterprise_owner' : 'user';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function listAllStoredEmuImportPlanRows(enterprise: SsoEnterprise, planId: string): ImportEmuUserRow[] {
  const rows: ImportEmuUserRow[] = [];
  for (let page = 1; ; page += 1) {
    const result = listStoredEmuImportPlanRows(enterprise.id, planId, { page, pageSize: 500 });
    rows.push(...result.items);
    if (rows.length >= result.total || result.items.length === 0) return rows;
  }
}

function importBatchResult(startedAt: string, rows: ImportEmuUserRow[]): BatchResult<ImportEmuUserRow> {
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  const failed = rows.filter((row) => row.status === 'failed' || row.status === 'conflict').length;
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - skipped - failed, skipped, failed },
    rows,
  };
}
