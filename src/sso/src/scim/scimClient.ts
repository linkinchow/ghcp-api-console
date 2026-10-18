import { errorFields, externalFetch, loggerFor, type EnterpriseId } from '@ghcp/shared';
import { getSsoRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { requireSsoSecret } from '../enterpriseSecrets.js';
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
const LIST_PAGE_SIZE = 100;

/** Each enterprise has its own SCIM endpoint and token, so pacing and backoff are tracked per enterprise. */
const nextScimRequestAt = new Map<EnterpriseId, number>();

export async function syncUser(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  enterpriseRole: ScimEnterpriseRole = 'user',
  createOnly = false,
): Promise<ProvisionResult> {
  if (createOnly && (user.ghScimId || user.ghLogin || user.emuStatus !== 'not_synced')) {
    throw new Error(`SCIM create-only refused: SSO user ${user.ssoUser} already has provisioning data.`);
  }
  const fields = { enterpriseId: enterprise.id, ssoUser: user.ssoUser, enterpriseRole };
  if (user.ghScimId) {
    logger.info('sync-existing', 'Updating existing SCIM user', { ...fields, scimId: user.ghScimId });
    const updated = await replaceUser(enterprise, user.ghScimId, user, enterpriseRole);
    if (updated) return resultFromScimUser(enterprise, updated);
  }
  logger.info('sync-create', 'Creating SCIM user', fields);
  const created = await createUser(enterprise, user, enterpriseRole);
  if (created) return resultFromScimUser(enterprise, created);
  if (createOnly) {
    const detail = 'no lookup or update was attempted.';
    throw new Error(`SCIM create-only conflict: user ${user.ssoUser} already exists; ${detail}`);
  }
  return adoptExistingUser(enterprise, user, enterpriseRole);
}

export async function suspendUser(enterprise: SsoEnterprise, scimId: string): Promise<void> {
  logger.info('suspend', 'Suspending SCIM user', { enterpriseId: enterprise.id, scimId });
  const body = { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] };
  const res = await scimFetch(enterprise, `/Users/${scimId}`, {
    method: 'PATCH',
    headers: { ...authHeader(enterprise), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(body),
  }, 'SCIM suspend');
  if (!res.ok) throw new Error(`SCIM suspend failed: ${res.status} ${await res.text()}`);
}

export async function deleteProvisionedUser(enterprise: SsoEnterprise, user: SsoUserRecord): Promise<boolean> {
  logger.info('delete-provisioned-start', 'Deleting provisioned SCIM user if present', {
    enterpriseId: enterprise.id,
    ssoUser: user.ssoUser,
    scimId: user.ghScimId,
  });
  let deleted = false;
  if (user.ghScimId) deleted = await deleteByScimId(enterprise, user.ghScimId);
  const existing = await findScimUserByUsername(enterprise, user.ssoUser);
  if (!existing?.id) return deleted;
  return (await deleteByScimId(enterprise, existing.id)) || deleted;
}

export async function findScimUserByUsername(
  enterprise: SsoEnterprise,
  username: string,
): Promise<ScimUserResource | undefined> {
  const filter = encodeURIComponent(`userName eq "${scimStringLiteral(username)}"`);
  const init = { headers: authHeader(enterprise) };
  const res = await scimFetch(enterprise, `/Users?filter=${filter}`, init, 'SCIM lookup');
  if (!res.ok) throw new Error(`SCIM lookup failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as ScimListResponse;
  return body.Resources?.[0];
}

export async function listScimUsers(enterprise: SsoEnterprise): Promise<ScimUserResource[]> {
  const users: ScimUserResource[] = [];
  const seen = new Set<string>();
  let startIndex = 1;
  while (true) {
    const body = await readScimUsersPage(enterprise, startIndex);
    const page = body.Resources ?? [];
    const newUsers = page.filter((user) => markUnseen(seen, user));
    users.push(...newUsers);
    if (isLastScimPage(body, page.length, newUsers.length, users.length)) return users;
    startIndex += body.itemsPerPage && body.itemsPerPage > 0 ? body.itemsPerPage : page.length;
  }
}

async function adoptExistingUser(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  enterpriseRole: ScimEnterpriseRole,
): Promise<ProvisionResult> {
  const fields = { enterpriseId: enterprise.id, ssoUser: user.ssoUser };
  logger.info('sync-conflict-lookup', 'SCIM user already exists, looking up by SSO user', fields);
  const existing = await findScimUserByUsername(enterprise, user.ssoUser);
  if (!existing?.id) throw new Error(`SCIM user ${user.ssoUser} already exists but could not be found`);
  logger.info('sync-conflict-update', 'Updating existing SCIM user found by SSO user', {
    ...fields,
    scimId: existing.id,
  });
  const updated = await replaceUser(enterprise, existing.id, user, enterpriseRole);
  if (!updated) throw new Error(`SCIM user ${user.ssoUser} disappeared before update`);
  return resultFromScimUser(enterprise, updated);
}

async function readScimUsersPage(enterprise: SsoEnterprise, startIndex: number): Promise<ScimListResponse> {
  const search = new URLSearchParams({ startIndex: String(startIndex), count: String(LIST_PAGE_SIZE) });
  const res = await scimFetch(enterprise, `/Users?${search}`, { headers: authHeader(enterprise) }, 'SCIM list users');
  if (!res.ok) throw new Error(`SCIM list users failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScimListResponse;
}

function markUnseen(seen: Set<string>, user: ScimUserResource): boolean {
  const key = user.id || user.userName;
  if (!key || seen.has(key)) return false;
  seen.add(key);
  return true;
}

function isLastScimPage(body: ScimListResponse, pageLength: number, newCount: number, total: number): boolean {
  if (pageLength === 0 || newCount === 0) return true;
  if (typeof body.totalResults === 'number' && total >= body.totalResults) return true;
  return pageLength < LIST_PAGE_SIZE;
}

async function createUser(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
  enterpriseRole: ScimEnterpriseRole,
): Promise<ScimUserResource | undefined> {
  const res = await scimFetch(enterprise, '/Users', {
    method: 'POST',
    headers: { ...authHeader(enterprise), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM create');
  if (res.status === 409) return undefined;
  if (!res.ok) throw new Error(`SCIM create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScimUserResource;
}

async function replaceUser(
  enterprise: SsoEnterprise,
  scimId: string,
  user: SsoUserRecord,
  enterpriseRole: ScimEnterpriseRole,
): Promise<ScimUserResource | undefined> {
  const res = await scimFetch(enterprise, `/Users/${scimId}`, {
    method: 'PUT',
    headers: { ...authHeader(enterprise), 'Content-Type': 'application/scim+json' },
    body: JSON.stringify(toScimUser(user, enterpriseRole)),
  }, 'SCIM update');
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`SCIM update failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScimUserResource;
}

async function deleteByScimId(enterprise: SsoEnterprise, scimId: string): Promise<boolean> {
  const init = { method: 'DELETE', headers: authHeader(enterprise) };
  const res = await scimFetch(enterprise, `/Users/${scimId}`, init, 'SCIM delete');
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`SCIM delete failed: ${res.status} ${await res.text()}`);
  return true;
}

/**
 * Baseline retry semantics: 429, 5xx and throttling 403 responses and transport failures are retried up to
 * `scimMaxRetries` times. Requests refuse redirects and time out (shared `externalFetch`).
 */
async function scimFetch(
  enterprise: SsoEnterprise,
  path: string,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  const settings = getSsoRuntimeSettings(enterprise.id);
  const url = `${scimBase(enterprise)}${path}`;
  const method = init.method ?? 'GET';
  const base = { enterpriseId: enterprise.id, operation, method, path };
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= settings.scimMaxRetries; attempt += 1) {
    await waitForScimSlot(enterprise.id, settings.scimRequestDelayMs);
    const startedAt = Date.now();
    try {
      logger.debug('request', 'Sending SCIM request', { ...base, attempt });
      const res = await externalFetch(url, init);
      const fields = { ...base, attempt, status: res.status, durationMs: Date.now() - startedAt };
      if (!isRetryable(res)) return logScimResponse(res, fields);
      const body = await res.text();
      if (attempt === settings.scimMaxRetries) {
        throw new Error(`${operation} failed after retries: ${res.status} ${body}`);
      }
      logger.warn('retry', 'SCIM request will retry after retryable response', { ...fields, responseBody: body });
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs, res));
    } catch (err) {
      lastError = err as Error;
      if (attempt === settings.scimMaxRetries) break;
      const fields = { ...base, attempt, durationMs: Date.now() - startedAt, ...errorFields(err) };
      logger.warn('retry-error', 'SCIM request failed and will retry', fields);
      await sleep(backoffMs(attempt, settings.scimRetryBaseDelayMs));
    }
  }
  logger.error('failed', 'SCIM request failed after retries', { ...base, ...errorFields(lastError) });
  throw lastError ?? new Error(`${operation} failed`);
}

function logScimResponse(res: Response, fields: Record<string, unknown>): Response {
  if (res.ok) logger.info('response', 'SCIM request completed', fields);
  else logger.warn('response-failed', 'SCIM request returned non-success status', fields);
  return res;
}

async function waitForScimSlot(enterpriseId: EnterpriseId, requestDelayMs: number): Promise<void> {
  const now = Date.now();
  const next = nextScimRequestAt.get(enterpriseId) ?? 0;
  const waitMs = Math.max(0, next - now);
  nextScimRequestAt.set(enterpriseId, Math.max(now, next) + requestDelayMs);
  if (waitMs > 0) await sleep(waitMs);
}

function scimBase(enterprise: SsoEnterprise): string {
  const base = enterprise.endpoints.scimBaseUrl;
  if (!base) throw new Error(`${enterprise.id}.sso.scimBaseUrl is not configured.`);
  return base;
}

function authHeader(enterprise: SsoEnterprise): Record<string, string> {
  return {
    Authorization: `Bearer ${requireSsoSecret(enterprise, 'scimToken')}`,
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

/** The GH login GitHub derives: `<handle>_<shortcode>` on github.com, an unsuffixed handle on GHE.com. */
function resultFromScimUser(enterprise: SsoEnterprise, body: ScimUserResource): ProvisionResult {
  if (!body.id) throw new Error(`SCIM response for ${body.userName} did not include an id`);
  const ghLogin = body.githubLogin ?? normalizeHandle(body.userName, enterprise.endpoints.shortcode);
  logger.info('provision-result', 'SCIM user provisioned', {
    enterpriseId: enterprise.id,
    ssoUser: body.userName,
    scimId: body.id,
    ghLogin,
  });
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
  return retryAfterMs(res ?? new Response()) ?? Math.min(30_000, retryBaseDelayMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
