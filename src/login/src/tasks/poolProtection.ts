import { HttpApiError, type LoginTaskDto } from '@ghcp/shared';
import { getPoolTaskProtection } from '../clients/proxyClient.js';

export type PoolTaskMutation = 'delete' | 'retry';

/**
 * Pool-managed Login tasks are recovery evidence for the user pool. Every delete/retry path
 * (single-task routes and batch operations) must pass through here, and it fails closed:
 * if Proxy cannot confirm ownership, nothing is changed.
 */
export async function assertPoolTaskMutationAllowed(task: LoginTaskDto, operation: PoolTaskMutation): Promise<void> {
  let protection: { managed: boolean; referenced: boolean };
  try {
    protection = await getPoolTaskProtection(task.identity, task.id, task.oauthAttemptId);
  } catch {
    throw new HttpApiError(503, 'pool_membership_unavailable', 'Cannot verify pool task ownership; no task was changed.');
  }
  // History that the pool no longer references may be deleted, but a managed task is never retried independently.
  const blocked = operation === 'delete' ? protection.referenced : protection.managed;
  if (blocked) {
    throw new HttpApiError(409, 'pool_task_managed', 'Use User pool recovery controls; this Login task is managed by the pool.');
  }
}
