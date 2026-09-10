import { config } from '../config.js';
import { verifyPassword } from '../auth/password.js';
import type { SsoUserRecord } from '../db/usersRepo.js';

export function resolveInitialPassword(ssoUser: string, explicitPassword?: string): string {
  if (explicitPassword !== undefined) {
    if (!explicitPassword) throw new Error('Password must not be empty.');
    return explicitPassword;
  }
  return config.defaultUserPassword ?? ssoUser;
}

export class PoolPasswordPolicyError extends Error {
  readonly code = 'pool_password_policy';

  constructor() {
    super('pool_password_policy: Pool users require SSO_DEFAULT_USER_PASSWORD with at least 16 non-padding characters, different from the username; custom passwords are not supported.');
    this.name = 'PoolPasswordPolicyError';
  }
}

export function resolvePoolManagedPassword(ssoUser: string, explicitPassword?: string): string {
  const password = config.defaultUserPassword;
  if (!password || password.trim().length < 16 || password.trim().toLowerCase() === ssoUser.toLowerCase()
    || (explicitPassword !== undefined && explicitPassword !== password)) {
    throw new PoolPasswordPolicyError();
  }
  return password;
}

export function knownDefaultPasswordForUser(user: SsoUserRecord): string | undefined {
  const candidates = [...new Set([config.defaultUserPassword, user.ssoUser].filter((value): value is string => Boolean(value)))];
  return candidates.find((candidate) => verifyPassword(candidate, user.passwordHash, user.salt));
}
