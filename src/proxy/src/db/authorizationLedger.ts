import { createHash } from 'node:crypto';
import { bindingKey, parseAuthorizationBinding, type AuthorizationBinding } from '@ghcp/shared';
import { AccountScopeError, type AuthorizationAttempt, type AuthorizationResult, type VerifiedGithubSubject } from './storageTypes.js';

export interface AttemptRow {
  oauth_attempt_id: string; enterprise_id: string; enterprise_revision: number;
  identity: string; account_incarnation: string; expected_gh_login: string; expected_github_user_id: string | null;
  status: AuthorizationAttempt['status']; result_fingerprint: string | null; failure_reason: string | null;
  result_gh_login: string | null; result_github_user_id: string | null;
}
export function mapAttempt(row: AttemptRow): AuthorizationAttempt {
  return { binding: parseAuthorizationBinding({ enterpriseId: row.enterprise_id, enterpriseRevision: Number(row.enterprise_revision),
    identity: row.identity, accountIncarnation: row.account_incarnation, oauthAttemptId: row.oauth_attempt_id,
    expectedGhLogin: row.expected_gh_login,
    ...(row.expected_github_user_id == null ? {} : { expectedGithubUserId: row.expected_github_user_id }) }),
  status: row.status, resultFingerprint: row.result_fingerprint ?? undefined, failureReason: row.failure_reason ?? undefined,
  resultSubject: row.result_gh_login && row.result_github_user_id ? {login:row.result_gh_login,id:row.result_github_user_id} : undefined };
}
export function assertSameBinding(attempt: AuthorizationAttempt | undefined, binding: AuthorizationBinding): asserts attempt is AuthorizationAttempt {
  if (!attempt || bindingKey(attempt.binding) !== bindingKey(binding)) throw new AccountScopeError('stale_authorization_binding');
}
export function assertSubject(binding: AuthorizationBinding, subject: VerifiedGithubSubject): void {
  if (subject.login !== binding.expectedGhLogin || !/^[1-9]\d{0,19}$/.test(subject.id)
      || binding.expectedGithubUserId !== undefined && subject.id !== binding.expectedGithubUserId) {
    throw new AccountScopeError('oauth_subject_mismatch');
  }
}
export function safeFailureReason(reason: string | undefined): string {
  if (reason === undefined) return 'authorization_failed';
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(reason)) throw new AccountScopeError('invalid_authorization_failure_reason');
  return reason;
}
/** Private high-entropy token/payload digest. It never leaves persistence or enters a DTO/log. */
export function resultFingerprint(binding: AuthorizationBinding, status: AuthorizationResult['status'], payload: unknown): string {
  return createHash('sha256').update(JSON.stringify([bindingKey(binding), status, payload])).digest('hex');
}
export function terminalResult(attempt: AuthorizationAttempt, binding: AuthorizationBinding,
  status: AuthorizationResult['status'], fingerprint: string): AuthorizationResult | undefined {
  assertSameBinding(attempt, binding);
  if (attempt.status === 'active') return undefined;
  if (attempt.status !== status || attempt.resultFingerprint !== fingerprint) throw new AccountScopeError('authorization_outcome_conflict');
  return { binding, status, outcome: `already-${status}` };
}
export function bindingValues(binding: AuthorizationBinding): Array<string | number | null> {
  const b = parseAuthorizationBinding(binding);
  return [b.oauthAttemptId,b.enterpriseId,b.enterpriseRevision,b.identity,b.accountIncarnation,b.expectedGhLogin,b.expectedGithubUserId ?? null];
}
export const INSERT_ATTEMPT = `INSERT INTO proxy_authorization_attempts
  (oauth_attempt_id,enterprise_id,enterprise_revision,identity,account_incarnation,expected_gh_login,expected_github_user_id,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,'active',?,?)`;
