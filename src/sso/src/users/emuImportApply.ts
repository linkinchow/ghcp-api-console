import type { CopilotSeatSnapshot, ImportEmuPlanDto, ImportEmuUserRow } from '@ghcp/shared';
import { loggerFor } from '@ghcp/shared';
import { hashPassword } from '../auth/password.js';
import { isCancellationDate } from '../copilot/seats.js';
import { getDb } from '../db/connection.js';
import {
  listPendingEmuImportPlanRows,
  markEmuImportPlanApplied,
  requireEmuImportPlan,
  updateEmuImportPlanRow,
  type EmuImportPlanRowRecord,
} from '../db/emuImportPlansRepo.js';
import { appendUserEvent } from '../db/eventLog.js';
import {
  createUser,
  listAllUsers,
  SsoUserLimitReachedError,
  updateCopilotSeatFromGitHub,
  updateEmu,
  updateUser,
} from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { importSeatDescription, localUserIndex, type LocalUserIndex } from './emuImportPlan.js';
import { resolveInitialPassword } from './passwordPolicy.js';

type PasswordHash = Awaited<ReturnType<typeof hashPassword>>;

/** A pending row whose required GH fields are all present. */
type CompleteRow = EmuImportPlanRowRecord & Required<Pick<
  EmuImportPlanRowRecord,
  'ghScimId' | 'ghLogin' | 'email' | 'emuStatus' | 'copilotSeatStatus'
>>;

const logger = loggerFor('sso', 'users');

export async function applyEmuImportPlan(enterprise: SsoEnterprise, planId: string): Promise<ImportEmuPlanDto> {
  requireEmuImportPlan(enterprise.id, planId);
  // Hash outside the synchronous transaction so large imports do not block the event loop.
  const passwordHashes = await hashNewUserPasswords(enterprise, planId);
  getDb().transaction(() => {
    // Re-read inside the transaction: a concurrent apply of this plan may have finished while hashing.
    const pendingRows = listPendingEmuImportPlanRows(enterprise.id, planId);
    const local = localUserIndex(listAllUsers(enterprise.id));
    for (const row of pendingRows) {
      const applied = applyPendingRow(enterprise, row, local, passwordHashes.get(row.rowIndex));
      updateEmuImportPlanRow(enterprise.id, planId, applied);
    }
    markEmuImportPlanApplied(enterprise.id, planId);
  })();
  const plan = requireEmuImportPlan(enterprise.id, planId);
  logger.info('apply-emu-import-plan', 'Applied EMU import alignment plan', {
    enterpriseId: enterprise.id,
    planId,
    ...plan.summary,
  });
  return plan;
}

async function hashNewUserPasswords(enterprise: SsoEnterprise, planId: string): Promise<Map<number, PasswordHash>> {
  const passwordHashes = new Map<number, PasswordHash>();
  for (const row of listPendingEmuImportPlanRows(enterprise.id, planId)) {
    if (row.action !== 'create') continue;
    passwordHashes.set(row.rowIndex, await hashPassword(resolveInitialPassword(enterprise, row.ssoUser)));
  }
  return passwordHashes;
}

function applyPendingRow(
  enterprise: SsoEnterprise,
  row: EmuImportPlanRowRecord,
  local: LocalUserIndex,
  passwordHash: PasswordHash | undefined,
): EmuImportPlanRowRecord {
  try {
    return applyStoredEmuImportRow(enterprise, row, local, passwordHash);
  } catch (err) {
    if (!(err instanceof SsoUserLimitReachedError)) throw err;
    return { ...row, action: undefined, status: 'failed', detail: err.message };
  }
}

function applyStoredEmuImportRow(
  enterprise: SsoEnterprise,
  row: EmuImportPlanRowRecord,
  local: LocalUserIndex,
  passwordHash: PasswordHash | undefined,
): EmuImportPlanRowRecord {
  const staleConflict = staleConflictForRow(row, local);
  if (staleConflict) return { ...row, action: undefined, status: 'conflict', detail: staleConflict };
  return { ...applyEmuImportRow(enterprise, row, passwordHash), rowIndex: row.rowIndex, action: undefined };
}

function applyEmuImportRow(
  enterprise: SsoEnterprise,
  row: EmuImportPlanRowRecord,
  passwordHash: PasswordHash | undefined,
): ImportEmuUserRow {
  if (row.action === 'skip' || row.status === 'conflict' || row.status === 'failed') return toImportRow(row);
  if (!isCompleteRow(row)) return { ...toImportRow(row), status: 'failed', detail: 'Import plan row is incomplete.' };
  if (row.action === 'create') return createImportedUser(enterprise, row, passwordHash);
  if (row.action === 'update') return updateImportedUser(enterprise, row);
  return { ...toImportRow(row), status: 'failed', detail: 'Import plan row has no applicable action.' };
}

function createImportedUser(
  enterprise: SsoEnterprise,
  row: CompleteRow,
  passwordHash: PasswordHash | undefined,
): ImportEmuUserRow {
  if (!passwordHash) {
    const detail = 'Import plan changed while applying. Preview again before applying.';
    return { ...toImportRow(row), status: 'failed', detail };
  }
  const created = createUser(enterprise.id, { ssoUser: row.ssoUser, ...passwordHash, email: row.email, role: 'user' });
  updateEmu(enterprise.id, created.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
  const updated = updateCopilotSeatFromGitHub(enterprise.id, created.ssoUser, importSeatSnapshot(row));
  appendUserEvent(enterprise, 'import_emu_create', updated);
  logger.info('import-emu-user-created', 'Recreated SSO user from GH SCIM user', importFields(enterprise, row));
  const seat = importSeatDescription(row);
  return {
    ...toImportRow(row),
    email: updated.email,
    ghLogin: updated.ghLogin,
    ghScimId: updated.ghScimId,
    emuStatus: updated.emuStatus,
    status: 'created',
    copilotSeatStatus: row.copilotSeatStatus,
    detail: `Created SSO user using the configured default password policy. Direct Copilot seat: ${seat}.`,
  };
}

function updateImportedUser(enterprise: SsoEnterprise, row: CompleteRow): ImportEmuUserRow {
  updateUser(enterprise.id, row.ssoUser, { email: row.email });
  updateEmu(enterprise.id, row.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
  const updated = updateCopilotSeatFromGitHub(enterprise.id, row.ssoUser, importSeatSnapshot(row));
  logger.info('import-emu-user-updated', 'Updated SSO user from GH SCIM user', importFields(enterprise, row));
  return {
    ...toImportRow(row),
    email: updated.email,
    ghLogin: updated.ghLogin,
    ghScimId: updated.ghScimId,
    emuStatus: updated.emuStatus,
    status: 'updated',
    copilotSeatStatus: row.copilotSeatStatus,
    detail: `Updated SSO user from GH SCIM. Direct Copilot seat: ${importSeatDescription(row)}.`,
  };
}

function staleConflictForRow(row: EmuImportPlanRowRecord, local: LocalUserIndex): string | undefined {
  if (!isCompleteRow(row)) return 'Import plan row is incomplete.';
  if (row.copilotSeatStatus === 'pending_cancellation' && !isCancellationDate(row.copilotSeatPendingCancellationDate)) {
    return 'Import plan has an invalid pending cancellation date. Preview again before applying.';
  }
  const existing = local.bySsoUser.get(row.ssoUser.toLowerCase());
  const boundLocalUser = local.byScimId.get(row.ghScimId);
  if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== row.ssoUser.toLowerCase()) {
    return `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Preview again before applying.`;
  }
  if (existing?.ghScimId && existing.ghScimId !== row.ghScimId) {
    return `SSO user is already bound to different GH SCIM id "${existing.ghScimId}". Preview again before applying.`;
  }
  if (row.action === 'create' && existing) return 'SSO user now exists. Preview again before applying.';
  if (row.action === 'update' && !existing) return 'SSO user disappeared after preview. Preview again before applying.';
  return undefined;
}

function isCompleteRow(row: EmuImportPlanRowRecord): row is CompleteRow {
  return Boolean(row.ghScimId && row.ghLogin && row.email && row.emuStatus && row.copilotSeatStatus);
}

function importSeatSnapshot(row: ImportEmuUserRow): CopilotSeatSnapshot {
  const date = row.copilotSeatPendingCancellationDate;
  if (row.copilotSeatStatus === 'pending_cancellation' && isCancellationDate(date)) {
    return { status: 'pending_cancellation', pendingCancellationDate: date };
  }
  if (row.copilotSeatStatus === 'assigned' || row.copilotSeatStatus === 'unassigned') {
    return { status: row.copilotSeatStatus };
  }
  throw new Error('Import plan has an invalid Copilot seat snapshot. Preview again before applying.');
}

function importFields(enterprise: SsoEnterprise, row: CompleteRow): Record<string, unknown> {
  return {
    enterpriseId: enterprise.id,
    ssoUser: row.ssoUser,
    ghLogin: row.ghLogin,
    ghScimId: row.ghScimId,
    emuStatus: row.emuStatus,
  };
}

function toImportRow(row: ImportEmuUserRow): ImportEmuUserRow {
  return {
    ssoUser: row.ssoUser,
    email: row.email,
    ghLogin: row.ghLogin,
    ghScimId: row.ghScimId,
    emuStatus: row.emuStatus,
    copilotSeatStatus: row.copilotSeatStatus,
    copilotSeatPendingCancellationDate: row.copilotSeatPendingCancellationDate,
    status: row.status,
    detail: row.detail,
  };
}
