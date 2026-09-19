import { externalFetch, mutationJson } from '../clients/externalFetch.js';
import { ExternalOperationUncertainError } from '../users/operationFence.js';
import type { EnterpriseScope } from '@ghcp/shared';
import { errorFields, loggerFor } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';
import { assertUserIncarnation } from '../db/usersRepo.js';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import { normalizeHandle } from './handle.js';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

export type ScimEnterpriseRole = 'user' | 'enterprise_owner';

export interface ScimUserResource {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string };
  displayName?: string;
  emails?: { value: string; primary?: boolean; type?: string }[];
  roles?: { value: ScimEnterpriseRole | string; primary?: boolean; display?: string; type?: string }[];
  active?: boolean;
  githubLogin?: string;
}

interface ScimListResponse {
  totalResults?: number;
  startIndex?: number;
  itemsPerPage?: number;
  Resources?: ScimUserResource[];
}

export interface ProvisionResult {
  scimId: string;
  ghLogin: string;
}

const logger = loggerFor('sso', 'scim');

export async function syncUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole = 'user', createOnly = false, scope: EnterpriseScope): Promise<ProvisionResult> {
  assertUserIncarnation(user, scope);
  if (createOnly && (user.ghScimId || user.ghLogin || user.emuStatus !== 'not_synced')) {
    throw new Error(`SCIM create-only refused: SSO user ${user.ssoUser} already has provisioning data.`);
  }
  if (user.ghScimId) {
    logger.info('sync-existing', 'Updating existing SCIM user', { ssoUser: user.ssoUser, scimId: user.ghScimId, enterpriseRole, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
    const updated = await replaceUser(user.ghScimId, user, enterpriseRole, scope);
    if (updated) return resultFromScimUser(updated, scope);
  }
  logger.info('sync-create', 'Creating SCIM user', { ssoUser: user.ssoUser, enterpriseRole, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  assertUserIncarnation(user, scope);
  const created = await createUser(user, enterpriseRole, scope);
  if (created) return resultFromScimUser(created, scope);
  if (createOnly) throw new Error(`SCIM create-only conflict: user ${user.ssoUser} already exists; no lookup or update was attempted.`);
  logger.info('sync-conflict-lookup', 'SCIM user already exists, looking up by SSO user', { ssoUser: user.ssoUser, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  const existing = await findScimUserByUsername(user.ssoUser, scope);
  if (!existing?.id) throw new Error(`SCIM user ${user.ssoUser} already exists but could not be found`);
  logger.info('sync-conflict-update', 'Updating existing SCIM user found by SSO user', { ssoUser: user.ssoUser, scimId: existing.id, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  assertUserIncarnation(user, scope);
  const updated = await replaceUser(existing.id, user, enterpriseRole, scope);
  if (!updated) throw new Error(`SCIM user ${user.ssoUser} disappeared before update`);
  return resultFromScimUser(updated, scope);
}

export async function suspendUser(scimId: string, scope: EnterpriseScope): Promise<void> {
  logger.info('suspend', 'Suspending SCIM user', { scimId, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  const res = await scimFetch(`/Users/${encodeURIComponent(scimId)}`, {
    method: 'PATCH',
    headers: { ...authHeader(scope), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify({ schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] }),
  }, 'SCIM suspend', scope);
  if (!res.ok) throw new Error(`SCIM suspend failed: ${res.status}`);
}

export async function deleteProvisionedUser(user: SsoUserRecord, scope: EnterpriseScope): Promise<boolean> {
  assertUserIncarnation(user, scope);
  logger.info('delete-provisioned-start', 'Deleting provisioned SCIM user if present', { ssoUser: user.ssoUser, scimId: user.ghScimId, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  let deleted = false;
  if (user.ghScimId) deleted = await deleteByScimId(user.ghScimId, scope);
  assertUserIncarnation(user, scope);
  const existing = await findScimUserByUsername(user.ssoUser, scope);
  assertUserIncarnation(user, scope);
  if (!existing?.id) return deleted;
  return (await deleteByScimId(existing.id, scope)) || deleted;
}

async function createUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole, scope: EnterpriseScope): Promise<ScimUserResource | undefined> {
  const res = await scimFetch('/Users', {
    method: 'POST',
    headers: { ...authHeader(scope), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM create', scope);
  if (res.status === 409) return undefined;
  if (!res.ok) throw new Error(`SCIM create failed: ${res.status}`);
  return confirmedMutationUser(await mutationJson(res));
}

async function replaceUser(scimId: string, user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole, scope: EnterpriseScope): Promise<ScimUserResource | undefined> {
  const res = await scimFetch(`/Users/${encodeURIComponent(scimId)}`, {
    method: 'PUT',
    headers: { ...authHeader(scope), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM update', scope);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`SCIM update failed: ${res.status}`);
  return confirmedMutationUser(await mutationJson(res));
}

export async function findScimUserByUsername(username: string, scope: EnterpriseScope): Promise<ScimUserResource | undefined> {
  const filter = encodeURIComponent(`userName eq "${scimStringLiteral(username)}"`);
  const res = await scimFetch(`/Users?filter=${filter}`, { headers: authHeader(scope) }, 'SCIM lookup', scope);
  if (!res.ok) throw new Error(`SCIM lookup failed: ${res.status}`);
  const body = (await res.json()) as ScimListResponse;
  const matches = body.Resources ?? [];
  if (matches.length > 1 || (matches[0] && matches[0].userName.toLowerCase() !== username.toLowerCase())) throw new Error('SCIM lookup ownership is ambiguous.');
  return matches[0];
}

export async function listScimUsers(scope: EnterpriseScope): Promise<ScimUserResource[]> {
  const users: ScimUserResource[] = [];
  const seen = new Set<string>();
  const count = 100;
  let startIndex = 1;
  while (true) {
    const search = new URLSearchParams({ startIndex: String(startIndex), count: String(count) });
    const res = await scimFetch(`/Users?${search}`, { headers: authHeader(scope) }, 'SCIM list users', scope);
    if (!res.ok) throw new Error(`SCIM list users failed: ${res.status}`);
    const body = (await res.json()) as ScimListResponse;
    const page = body.Resources ?? [];
    const newUsers = page.filter((user) => {
      const key = user.id || user.userName;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    users.push(...newUsers);
    if (page.length === 0) return users;
    if (newUsers.length === 0) return users;
    if (typeof body.totalResults === 'number' && users.length >= body.totalResults) return users;
    if (page.length < count) return users;
    startIndex += body.itemsPerPage && body.itemsPerPage > 0 ? body.itemsPerPage : page.length;
  }
}

async function deleteByScimId(scimId: string, scope: EnterpriseScope): Promise<boolean> {
  const res = await scimFetch(`/Users/${encodeURIComponent(scimId)}`, { method: 'DELETE', headers: authHeader(scope) }, 'SCIM delete', scope);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`SCIM delete failed: ${res.status}`);
  return true;
}

async function scimFetch(path: string, init: RequestInit, operation: string, scope: EnterpriseScope): Promise<Response> {
  const settings = getSsoRuntimeSettings(scope);
  const baseUrl = scimBase(scope);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= settings.scimMaxRetries; attempt += 1) {
    await waitForScimSlot(settings.scimRequestDelayMs, scope);
    const startedAt = Date.now();
    try {
      logger.debug('request', 'Sending SCIM request', { operation, method: init.method ?? 'GET', path, attempt, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
      const res = await externalFetch(`${baseUrl}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const fields = { operation, method: init.method ?? 'GET', path, attempt, status: res.status, durationMs: Date.now() - startedAt };
      if (!isRetryable(res)) {
        if (res.ok) logger.info('response', 'SCIM request completed', { ...fields, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
        else logger.warn('response-failed', 'SCIM request returned non-success status', { ...fields, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
        return res;
      }
      await res.body?.cancel();
      if (attempt === settings.scimMaxRetries) throw new Error(`${operation} failed after retries: ${res.status}`);
      logger.warn('retry', 'SCIM request will retry after retryable response', { ...fields, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs, res));
    } catch (err) {
      if (err instanceof ExternalOperationUncertainError) throw err;
      lastError = err as Error;
      if (attempt === settings.scimMaxRetries) break;
      logger.warn('retry-error', 'SCIM request failed and will retry', { operation, path, attempt, durationMs: Date.now() - startedAt, ...errorFields(err), enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs));
    }
  }
  logger.error('failed', 'SCIM request failed after retries', { operation, path, ...errorFields(lastError), enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  throw lastError ?? new Error(`${operation} failed`);
}

const nextScimRequestAt = new Map<string, number>();

async function waitForScimSlot(requestDelayMs: number, scope: EnterpriseScope): Promise<void> {
  const key = `${scope.enterpriseId}:${scope.enterpriseRevision}`;
  const now = Date.now();
  const next = nextScimRequestAt.get(key) ?? 0;
  const waitMs = Math.max(0, next - now);
  nextScimRequestAt.set(key, Math.max(now, next) + requestDelayMs);
  if (waitMs > 0) await sleep(waitMs);
}

function scimBase(scope: EnterpriseScope): string {
  return getScopeProfile(scope).sso.scimBaseUrl.replace(/\/+$/, '');
}

function authHeader(scope: EnterpriseScope): Record<string, string> {
  return {
    Authorization: `Bearer ${readEnterpriseSecret(getScopeProfile(scope).sso.scimTokenRef)}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
  };
}

function scimStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toScimUser(user: SsoUserRecord, enterpriseRole: ScimEnterpriseRole): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    userName: user.ssoUser,
    externalId: user.ssoUser,
    displayName: user.ssoUser,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    roles: [{ value: enterpriseRole, primary: false }],
    active: true,
  };
}

// A 2xx mutation may have taken effect even when its JSON is well-formed but
// unusable. Do not treat null like the explicit 404/409 sentinel or release the
// durable fence because result mapping later throws a plain validation error.
function confirmedMutationUser(value: unknown): ScimUserResource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExternalOperationUncertainError();
  const body = value as Record<string, unknown>;
  if (typeof body.id !== 'string' || !body.id.trim() || typeof body.userName !== 'string' || !body.userName.trim()
    || body.githubLogin !== undefined && (typeof body.githubLogin !== 'string' || !body.githubLogin.trim())) {
    throw new ExternalOperationUncertainError();
  }
  return value as ScimUserResource;
}

function resultFromScimUser(body: ScimUserResource, scope: EnterpriseScope): ProvisionResult {
  if (!body.id) throw new Error(`SCIM response for ${body.userName} did not include an id`);
  const ghLogin = body.githubLogin ?? normalizeHandle(body.userName, getScopeProfile(scope).shortcode);
  logger.info('provision-result', 'SCIM user provisioned', { ssoUser: body.userName, scimId: body.id, ghLogin, enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision });
  return { scimId: body.id, ghLogin };
}

function isRetryable(res: Response): boolean {
  return res.status === 429 || res.status >= 500 || (res.status === 403 && Boolean(res.headers.get('retry-after')));
}

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function backoffMs(attempt: number, retryBaseDelayMs: number, res?: Response): number {
  return Math.min(30_000, retryAfterMs(res ?? new Response()) ?? retryBaseDelayMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
