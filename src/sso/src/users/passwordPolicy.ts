import { verifyPassword } from '../auth/password.js';
import type { SsoUserRecord } from '../db/usersRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { optionalSsoSecret } from '../enterpriseSecrets.js';

const POOL_PASSWORD_MIN_LENGTH = 16;

/** An explicit password, else the enterprise's `sso.defaultUserPassword`, else the username (baseline). */
export function resolveInitialPassword(enterprise: SsoEnterprise, ssoUser: string, explicitPassword?: string): string {
  if (explicitPassword !== undefined) {
    if (!explicitPassword) throw new Error('Password must not be empty.');
    return explicitPassword;
  }
  return defaultUserPassword(enterprise) ?? ssoUser;
}

export class PoolPasswordPolicyError extends Error {
  readonly code = 'pool_password_policy';

  constructor() {
    super(
      'pool_password_policy: Pool users require SSO_DEFAULT_USER_PASSWORD with at least 16 non-padding characters, '
      + 'different from the username; custom passwords are not supported.',
    );
    this.name = 'PoolPasswordPolicyError';
  }
}

export function resolvePoolManagedPassword(
  enterprise: SsoEnterprise,
  ssoUser: string,
  explicitPassword?: string,
): string {
  const password = defaultUserPassword(enterprise);
  if (!password || !isStrongPoolPassword(password, ssoUser)) throw new PoolPasswordPolicyError();
  if (explicitPassword !== undefined && explicitPassword !== password) throw new PoolPasswordPolicyError();
  return password;
}

export async function knownDefaultPasswordForUserAsync(
  enterprise: SsoEnterprise,
  user: SsoUserRecord,
): Promise<string | undefined> {
  for (const candidate of defaultCandidates(enterprise, user)) {
    if (await verifyPassword(candidate, user.passwordHash, user.salt)) return candidate;
  }
  return undefined;
}

function isStrongPoolPassword(password: string, ssoUser: string): boolean {
  const trimmed = password.trim();
  return trimmed.length >= POOL_PASSWORD_MIN_LENGTH && trimmed.toLowerCase() !== ssoUser.toLowerCase();
}

function defaultCandidates(enterprise: SsoEnterprise, user: SsoUserRecord): string[] {
  const candidates = [defaultUserPassword(enterprise), user.ssoUser];
  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
}

/** Read on every use: `{ env }` values follow the environment and `{ file }` values rotate (design §3.4). */
function defaultUserPassword(enterprise: SsoEnterprise): string | undefined {
  return optionalSsoSecret(enterprise, 'defaultUserPassword');
}
