import type { EnterpriseScope } from '@ghcp/shared';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

/** One SSO writer process; the persisted fence survives crashes and unknown external outcomes. */
const operations = new Map<string, UserOperationLease>();
export interface UserOperationLease { readonly key: string; readonly nonce: string; readonly incarnation: string }
export class UserOperationBusyError extends Error {
  readonly code = 'sso_user_operation_in_progress';
  constructor() { super('An operation for this enterprise user is in progress or requires reconciliation.'); this.name = 'UserOperationBusyError'; }
}
export class ExternalOperationUncertainError extends Error {
  readonly code = 'external_operation_uncertain';
  constructor() { super('External operation outcome is unknown; user is blocked pending reconciliation.'); this.name = 'ExternalOperationUncertainError'; }
}
function key(ssoUser: string, scope: EnterpriseScope): string {
  return `${scope.enterpriseId}:${ssoUser.replace(/[A-Z]/g, letter => letter.toLowerCase())}`;
}
export function assertUserOperationAvailable(ssoUser: string, lease: UserOperationLease | undefined, scope: EnterpriseScope): void {
  const active = operations.get(key(ssoUser, scope));
  if (active && active !== lease) throw new UserOperationBusyError();
  const row = getDb().prepare('SELECT operation_fence FROM sso_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE')
    .get(scope.enterpriseId, ssoUser) as { operation_fence: string | null } | undefined;
  if (row?.operation_fence && (active !== lease || row.operation_fence !== lease?.nonce)) throw new UserOperationBusyError();
}
export async function runUserOperation<T>(ssoUser: string, action: (lease: UserOperationLease) => Promise<T>, scope: EnterpriseScope): Promise<T> {
  const lease = getDb().transaction(() => {
    assertUserOperationAvailable(ssoUser, undefined, scope);
    const row = getDb().prepare('SELECT user_incarnation FROM sso_users WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE')
      .get(scope.enterpriseId, ssoUser) as { user_incarnation: string } | undefined;
    // Missing users never initiate external work, but still take a local key until the caller returns.
    const captured = Object.freeze({ key: key(ssoUser, scope), nonce: randomUUID(), incarnation: row?.user_incarnation ?? '' });
    if (row) {
      const result = getDb().prepare('UPDATE sso_users SET operation_fence = ? WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ? AND operation_fence IS NULL')
        .run(captured.nonce, scope.enterpriseId, ssoUser, row.user_incarnation);
      if (result.changes !== 1) throw new UserOperationBusyError();
    }
    return captured;
  }).immediate();
  operations.set(lease.key, lease);
  let uncertain = false;
  try { return await action(lease); }
  catch (error) { uncertain = error instanceof ExternalOperationUncertainError; throw error; }
  finally {
    // Only this exact operation on the exact user incarnation may release the persisted fence.
    if (!uncertain) {
      getDb().prepare('UPDATE sso_users SET operation_fence = NULL WHERE enterprise_id = ? AND sso_user = ? COLLATE NOCASE AND user_incarnation = ? AND operation_fence = ?')
        .run(scope.enterpriseId, ssoUser, lease.incarnation, lease.nonce);
      if (operations.get(lease.key) === lease) operations.delete(lease.key);
    }
  }
}
