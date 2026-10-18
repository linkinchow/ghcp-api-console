import type { EnterpriseId } from '@ghcp/shared';
import { getUser, getUserByGhLogin, listAllUsers, type SsoUserRecord } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';

const MAX_SSO_USER_LENGTH = 32;
const MAX_NAME_SUFFIX = 100_000;

export function sanitizeSsoUser(raw: string): string {
  return normalizeName(raw).slice(0, MAX_SSO_USER_LENGTH);
}

/** An identity such as `alice_octo` or `alice@example.com` maps to `alice` (the enterprise's shortcode removed). */
export function ssoUserFromEnsureInput(enterprise: SsoEnterprise, raw: string): string {
  return stripEnterpriseShortcode(enterprise, normalizeName(raw)).slice(0, MAX_SSO_USER_LENGTH);
}

export function ensureSsoUserCandidates(
  enterprise: SsoEnterprise,
  identity: string,
  preferredSsoUser?: string,
): string[] {
  return uniqueCandidates([preferredSsoUser, identity], (raw) => ssoUserFromEnsureInput(enterprise, raw));
}

export function findExistingEnsureUser(
  enterpriseId: EnterpriseId,
  identity: string,
  preferredSsoUser: string | undefined,
  ssoUserCandidates: string[],
): SsoUserRecord | undefined {
  for (const ssoUser of ssoUserCandidates) {
    const user = getUser(enterpriseId, ssoUser);
    if (user) return user;
  }
  for (const ghLogin of uniqueCandidates([identity, preferredSsoUser], (raw) => raw.trim())) {
    const user = getUserByGhLogin(enterpriseId, ghLogin);
    if (user) return user;
  }
  return undefined;
}

/** The first free name of `<base>`, `<base>-2`, `<base>-3`, ... within the enterprise. */
export function nextAvailableSsoUser(enterpriseId: EnterpriseId, raw: string, userPrefix: string): string {
  const base = sanitizeSsoUser(raw) || userPrefix;
  if (!getUser(enterpriseId, base)) return base;
  for (let i = 2; i < MAX_NAME_SUFFIX; i += 1) {
    const candidate = `${base}-${i}`;
    if (!getUser(enterpriseId, candidate)) return candidate;
  }
  return `${userPrefix}${listAllUsers(enterpriseId).length + 1}`;
}

function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueCandidates(values: Array<string | undefined>, normalize: (raw: string) => string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const candidate = normalize(raw);
    const key = candidate.toLowerCase();
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return candidates;
}

/** GHE.com enterprises have no shortcode, so nothing is stripped there. */
function stripEnterpriseShortcode(enterprise: SsoEnterprise, value: string): string {
  const shortcode = enterprise.endpoints.shortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}
