import { randomUUID } from 'node:crypto';
import { HttpApiError, loggerFor, redactSecrets, type LoginCredentials, type LoginTaskDto } from '@ghcp/shared';
import { markCopilotOauthFailed, prepareLoginRetry } from '../clients/proxyClient.js';
import { getTask, markFailed, reserveRetry, type LoginTaskRecord } from '../db/tasksRepo.js';
import type { LoginEnterprise } from '../enterprises.js';
import { assertPoolTaskMutationAllowed } from './poolProtection.js';
import { loginQueue } from './queue.js';
import type { LoginTaskRequest } from './runner.js';

const logger = loggerFor('login', 'retry');

/**
 * Starts a new attempt of a failed task. The task keeps its enterprise; nothing in the request can move it or
 * change its SSO page, selectors or provider (design §5.7).
 */
export async function retryTask(
  enterprise: LoginEnterprise,
  id: string,
  credentials: LoginCredentials,
): Promise<LoginTaskDto> {
  const enterpriseId = enterprise.id;
  const task = getTask(enterpriseId, id);
  if (!task) throw new HttpApiError(404, 'task_not_found', 'Login task was not found.');
  if (loginQueue.isBusy(id)) throw new HttpApiError(409, 'task_already_active', 'The previous attempt is still finishing. Wait for its queue slot to be released before retrying.');
  assertSameProvider(enterprise, task);
  await assertPoolTaskMutationAllowed(task, 'retry');
  const attemptId = randomUUID();
  // `task` still carries the attempt the account should point at; `reserveRetry` moves the task on.
  const reserved = reserveRetry(enterpriseId, task, attemptId);
  try {
    const previousAttemptId = task.oauthAttemptId ?? null;
    const prepared = await prepareLoginRetry(enterpriseId, reserved, attemptId, credentials, previousAttemptId);
    const request = retryRequest(reserved, attemptId, prepared.ssoPassword);
    const current = getTask(enterpriseId, id);
    if (current?.status === 'cancelling') return loginQueue.cancel(enterpriseId, id)!;
    if (!current || current.status !== 'pending' || current.oauthAttemptId !== attemptId) {
      // The task was cancelled (or otherwise closed) while Proxy was preparing the attempt, so the
      // attempt Proxy just switched to will never run; release it instead of leaving it refreshing.
      await releaseAttempt(task, attemptId, 'Retry was cancelled before it started.');
      return current ?? reserved;
    }
    return loginQueue.retry(reserved, request);
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err), credentials.credentialMode === 'override' ? [credentials.ssoPassword] : []);
    const current = getTask(enterpriseId, id);
    if (current?.status === 'cancelling') return loginQueue.cancel(enterpriseId, id)!;
    if (current?.status === 'cancelled') return current;
    markFailed(enterpriseId, id, message, attemptId, err instanceof HttpApiError ? err.code : 'retry_failed');
    // Fenced on the attempt id at Proxy: a no-op unless preparation already switched the account.
    await releaseAttempt(task, attemptId, message);
    throw new HttpApiError(err instanceof HttpApiError ? err.status : 502, err instanceof HttpApiError ? err.code : 'retry_failed', message);
  }
}

/** A profile that pins a provider cannot replay a task recorded under another one; an open profile can. */
function assertSameProvider(enterprise: LoginEnterprise, task: LoginTaskRecord): void {
  const provider = enterprise.profile.login.ssoProvider;
  if (provider === undefined || task.ssoType === provider) return;
  const message = `This task used ${task.ssoType} SSO, but the enterprise now uses `
    + `${provider}. Start a new authorization from the account.`;
  throw new HttpApiError(409, 'sso_type_mismatch', message);
}

/** Only the password comes from Proxy; the account mapping is the task's own. */
function retryRequest(task: LoginTaskRecord, attemptId: string, ssoPassword: string): LoginTaskRequest {
  return {
    identity: task.identity,
    ssoUser: task.ssoUser,
    ssoPassword,
    ghLogin: task.ghLogin ?? '',
    oauthAttemptId: attemptId,
    ssoType: task.ssoType,
  };
}

async function releaseAttempt(task: LoginTaskRecord, attemptId: string, reason: string): Promise<void> {
  try {
    await markCopilotOauthFailed(task.enterpriseId, task.identity, attemptId, reason);
  } catch (err) {
    logger.error('retry-cleanup-failed', 'Could not report the abandoned retry attempt to Proxy; reauthorize the account if it stays refreshing', {
      taskId: task.id, attemptId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
