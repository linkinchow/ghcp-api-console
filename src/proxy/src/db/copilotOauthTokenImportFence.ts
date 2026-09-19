import { AccountScopeError, type CopilotOauthTokenImportFence } from './storageTypes.js';

export interface ImportFenceRow {
  enterprise_id: string | null;
  account_incarnation: string | null;
  copilot_oauth_attempt_id: string | null;
  authorization_attempts: number | string;
}

/** One statement snapshots the global identity and its immutable attempt history. */
export const IMPORT_FENCE_SQL = `SELECT a.enterprise_id,a.account_incarnation,a.copilot_oauth_attempt_id,
  (SELECT COUNT(*) FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=?) AS authorization_attempts
  FROM (SELECT 1 AS seed) s LEFT JOIN proxy_accounts a ON a.identity=?`;

export function importFence(row: ImportFenceRow, enterpriseId: string): CopilotOauthTokenImportFence {
  if (row.enterprise_id !== null && row.enterprise_id !== enterpriseId) throw new AccountScopeError('identity_enterprise_collision');
  return { accountIncarnation: row.account_incarnation, oauthAttemptId: row.copilot_oauth_attempt_id,
    authorizationAttempts: Number(row.authorization_attempts) };
}

export function assertImportFence(expected: CopilotOauthTokenImportFence, current: CopilotOauthTokenImportFence): void {
  if (!expected) throw new AccountScopeError('token_import_fence_required');
  if (expected.accountIncarnation !== current.accountIncarnation
      || expected.oauthAttemptId !== current.oauthAttemptId
      || expected.authorizationAttempts !== current.authorizationAttempts) {
    throw new AccountScopeError('stale_token_import');
  }
}
