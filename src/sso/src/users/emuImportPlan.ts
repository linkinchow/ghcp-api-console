import type { CopilotSeatSnapshot, ImportEmuUserRow } from '@ghcp/shared';
import type { EmuImportPlanRowRecord } from '../db/emuImportPlansRepo.js';
import { listAllUsers, type SsoUserRecord } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { normalizeHandle } from '../scim/handle.js';
import { findScimUserByUsername, listScimUsers, type ScimUserResource } from '../scim/scimClient.js';
import { sanitizeSsoUser } from './ssoUserNames.js';

export type PlannedEmuAction = 'create' | 'update' | 'skip';

export interface PlannedEmuImportRow extends ImportEmuUserRow {
  action?: PlannedEmuAction;
  scimUser?: ScimUserResource;
}

/** Local users of one enterprise, indexed the way plan building and applying look them up. */
export interface LocalUserIndex {
  bySsoUser: Map<string, SsoUserRecord>;
  byScimId: Map<string, SsoUserRecord>;
}

export function localUserIndex(users: SsoUserRecord[]): LocalUserIndex {
  return {
    bySsoUser: new Map(users.map((user) => [user.ssoUser.toLowerCase(), user])),
    byScimId: new Map(users.filter((user) => user.ghScimId).map((user) => [user.ghScimId!, user])),
  };
}

export async function loadScimUsersForImport(
  enterprise: SsoEnterprise,
  targetSsoUser: string | undefined,
): Promise<ScimUserResource[]> {
  if (!targetSsoUser) return listScimUsers(enterprise);
  const byUserName = await findScimUserByUsername(enterprise, targetSsoUser);
  if (byUserName) return [byUserName];
  const target = targetSsoUser.toLowerCase();
  const users = await listScimUsers(enterprise);
  return users.filter((scimUser) => scimUserMatches(enterprise, scimUser, target));
}

export function buildEmuImportPlan(
  enterprise: SsoEnterprise,
  scimUsers: ScimUserResource[],
  copilotSeats: ReadonlyMap<string, CopilotSeatSnapshot>,
  emailDomain: string,
): PlannedEmuImportRow[] {
  const candidates = scimUsers.map((scimUser) => toPlannedCandidate(enterprise, scimUser, copilotSeats, emailDomain));
  const duplicateSsoUsers = duplicateValues(candidates.filter((row) => row.scimUser).map((row) => row.ssoUser));
  const local = localUserIndex(listAllUsers(enterprise.id));
  return candidates.map((candidate) => planCandidate(candidate, duplicateSsoUsers, local));
}

export function withoutScimUser(row: PlannedEmuImportRow): Omit<EmuImportPlanRowRecord, 'rowIndex'> {
  const { scimUser: _scimUser, ...stored } = row;
  return stored;
}

export function importSeatDescription(row: ImportEmuUserRow): string {
  return row.copilotSeatStatus === 'pending_cancellation'
    ? `cancell at ${row.copilotSeatPendingCancellationDate}`
    : String(row.copilotSeatStatus);
}

function planCandidate(
  candidate: PlannedEmuImportRow,
  duplicateSsoUsers: Set<string>,
  local: LocalUserIndex,
): PlannedEmuImportRow {
  if (!candidate.scimUser || candidate.status === 'failed') return candidate;
  const conflict = planConflict(candidate, duplicateSsoUsers, local);
  if (conflict) return { ...candidate, action: undefined, status: 'conflict', detail: conflict };
  const existing = local.bySsoUser.get(candidate.ssoUser.toLowerCase());
  const seat = importSeatDescription(candidate);
  if (!existing) {
    const detail = `Will create SSO user using the configured default password policy. Direct Copilot seat: ${seat}.`;
    return { ...candidate, action: 'create', status: 'pending_create', detail };
  }
  if (isAlreadyAligned(existing, candidate)) {
    const detail = 'SSO user and Copilot seat are already aligned with GH.';
    return { ...candidate, action: 'skip', status: 'skipped', detail };
  }
  const detail = `Will update local GH metadata. Direct Copilot seat: ${seat}.`;
  return { ...candidate, action: 'update', status: 'pending_update', detail };
}

function planConflict(
  candidate: PlannedEmuImportRow,
  duplicateSsoUsers: Set<string>,
  local: LocalUserIndex,
): string | undefined {
  if (duplicateSsoUsers.has(candidate.ssoUser)) {
    return `Multiple GH SCIM users map to SSO user "${candidate.ssoUser}".`;
  }
  const existing = local.bySsoUser.get(candidate.ssoUser.toLowerCase());
  const boundLocalUser = local.byScimId.get(candidate.ghScimId!);
  if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== candidate.ssoUser.toLowerCase()) {
    return `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Rename is not applied automatically.`;
  }
  if (existing?.ghScimId && existing.ghScimId !== candidate.ghScimId) {
    return `SSO user is already bound to different GH SCIM id "${existing.ghScimId}".`;
  }
  return undefined;
}

function toPlannedCandidate(
  enterprise: SsoEnterprise,
  scimUser: ScimUserResource,
  copilotSeats: ReadonlyMap<string, CopilotSeatSnapshot>,
  emailDomain: string,
): PlannedEmuImportRow {
  const rawSsoUser = ssoUserFromScimUser(scimUser);
  if (!scimUser.id) {
    const detail = `GH SCIM user "${scimUser.userName}" does not include an id.`;
    return { ssoUser: rawSsoUser, status: 'failed', detail };
  }
  const ssoUser = sanitizeSsoUser(rawSsoUser);
  if (!ssoUser) {
    return {
      ssoUser: rawSsoUser || scimUser.externalId || scimUser.userName,
      ghLogin: ghLoginFromScimUser(enterprise, scimUser, rawSsoUser),
      ghScimId: scimUser.id,
      status: 'failed',
      detail: `GH SCIM user "${scimUser.userName}" cannot be mapped to an SSO user.`,
    };
  }
  const ghLogin = ghLoginFromScimUser(enterprise, scimUser, ssoUser);
  const seat = copilotSeats.get(ghLogin.toLowerCase()) ?? { status: 'unassigned' };
  return {
    ssoUser,
    email: primaryEmail(scimUser) || `${ssoUser}@${emailDomain}`,
    ghLogin,
    ghScimId: scimUser.id,
    emuStatus: scimUser.active === false ? 'suspended' : 'active',
    copilotSeatStatus: seat.status,
    copilotSeatPendingCancellationDate: seat.pendingCancellationDate,
    status: 'pending_update',
    detail: '',
    scimUser,
  };
}

function scimUserMatches(enterprise: SsoEnterprise, scimUser: ScimUserResource, target: string): boolean {
  const ssoUser = ssoUserFromScimUser(scimUser).toLowerCase();
  const ghLogin = ghLoginFromScimUser(enterprise, scimUser, ssoUser).toLowerCase();
  return ssoUser === target
    || ghLogin === target
    || scimUser.userName.toLowerCase() === target
    || scimUser.externalId?.toLowerCase() === target;
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function isAlreadyAligned(existing: SsoUserRecord, row: PlannedEmuImportRow): boolean {
  return existing.email === row.email
    && existing.ghLogin === row.ghLogin
    && existing.ghScimId === row.ghScimId
    && existing.emuStatus === row.emuStatus
    && existing.copilotSeatStatus === row.copilotSeatStatus
    && existing.copilotSeatPendingCancellationDate === row.copilotSeatPendingCancellationDate
    && !existing.copilotSeatLastError;
}

function ssoUserFromScimUser(scimUser: ScimUserResource): string {
  return scimUser.userName || scimUser.externalId || '';
}

/** GitHub's own login when SCIM reports it, else the handle GitHub derives for this enterprise. */
function ghLoginFromScimUser(enterprise: SsoEnterprise, scimUser: ScimUserResource, ssoUser: string): string {
  return scimUser.githubLogin || normalizeHandle(ssoUser || scimUser.userName, enterprise.endpoints.shortcode);
}

function primaryEmail(scimUser: ScimUserResource): string | undefined {
  return scimUser.emails?.find((email) => email.primary)?.value ?? scimUser.emails?.[0]?.value;
}
