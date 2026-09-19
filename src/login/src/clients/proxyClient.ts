import { JsonHttpClient, EnterpriseContractError, bindingKey, parseAuthorizationBinding, type AuthorizationBinding, type AuthorizationOutcome } from '@ghcp/shared';
import { getTask, taskBinding, type LoginTaskRecord } from '../db/tasksRepo.js';
import { requireEnterpriseInput } from '../enterprise.js';
import { getEnterpriseProfile } from '../db/connection.js';
import { config } from '../config.js';

export interface AuthorityState { binding: AuthorizationBinding; status: AuthorizationOutcome }
function clientFor(enterpriseId: string): JsonHttpClient {
  return new JsonHttpClient({ baseUrl:getEnterpriseProfile(enterpriseId).routes.proxyInternalUrl,internalToken:config.internalApiToken,timeoutMs:10_000 });
}
function attemptPath(binding: AuthorizationBinding): string {
  return `/internal/profiles/${encodeURIComponent(binding.enterpriseId)}/accounts/${encodeURIComponent(binding.identity)}/authorization-attempts/${encodeURIComponent(binding.oauthAttemptId)}`;
}
function parseState(result: unknown,binding: AuthorizationBinding): AuthorityState {
  const raw = result as Partial<AuthorityState>;
  if (!raw || !['active','succeeded','failed','cancelled'].includes(raw.status ?? '')) throw new EnterpriseContractError('authorization_authority_invalid');
  const actual = parseAuthorizationBinding(raw.binding);
  if (bindingKey(actual) !== bindingKey(binding)) throw new EnterpriseContractError('authorization_binding_mismatch');
  return {binding:actual,status:raw.status!};
}
export async function readAuthorizationAttempt(binding: AuthorizationBinding,signal?: AbortSignal): Promise<AuthorityState> {
  requireEnterpriseInput(binding);
  const result = await clientFor(binding.enterpriseId).request(attemptPath(binding),{signal,redirect:'error'});
  return parseState(result,binding);
}
export async function getPoolTaskProtection(task: LoginTaskRecord,signal?: AbortSignal): Promise<{managed:boolean;referenced:boolean}> {
  const query = new URLSearchParams({taskId:task.id,...(task.oauthAttemptId ? {oauthAttemptId:task.oauthAttemptId} : {})});
  const result = await clientFor(task.enterpriseId).request<{managed?:unknown;referenced?:unknown}>(
    `/internal/profiles/${encodeURIComponent(task.enterpriseId)}/accounts/${encodeURIComponent(task.identity)}/login-task-protection?${query}`,{signal,redirect:'error'});
  if (typeof result?.managed !== 'boolean' || typeof result?.referenced !== 'boolean') throw new EnterpriseContractError('pool_protection_invalid');
  return {managed:result.managed,referenced:result.referenced};
}
export async function saveCopilotOauthToken(enterpriseId: string,taskId: string,copilotOauthToken: string,signal?: AbortSignal): Promise<AuthorityState> {
  const task = callbackTask(enterpriseId,taskId),binding = taskBinding(task);
  if (task.status !== 'callback_pending' || task.authorityCloseAction !== 'success') throw new EnterpriseContractError('authorization_callback_not_pending');
  const result = await clientFor(enterpriseId).request(`${attemptPath(binding)}/success`,{
    method:'POST',body:{binding,copilotOauthToken},signal,redirect:'error',
  });
  return parseState(result,binding);
}
export async function markCopilotOauthFailed(enterpriseId: string,taskId: string,failureReason: string,signal?: AbortSignal): Promise<AuthorityState> {
  const task = callbackTask(enterpriseId,taskId),binding = taskBinding(task);
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(failureReason)) throw new EnterpriseContractError('authorization_failure_code_invalid');
  if (task.status !== 'callback_pending' || task.authorityCloseAction !== 'fail') throw new EnterpriseContractError('authorization_callback_not_pending');
  const result = await clientFor(enterpriseId).request(`${attemptPath(binding)}/failure`,{
    method:'POST',body:{binding,failureReason},signal,redirect:'error',
  });
  return parseState(result,binding);
}
export async function cancelAuthorizationAttempt(enterpriseId: string,taskId: string,signal?: AbortSignal): Promise<AuthorityState> {
  const task = callbackTask(enterpriseId,taskId),binding = taskBinding(task);
  if (!['cancel_requested','uncertain'].includes(task.status)) throw new EnterpriseContractError('authorization_cancel_not_pending');
  const result = await clientFor(enterpriseId).request(`${attemptPath(binding)}/cancel`,{method:'POST',body:{binding},signal,redirect:'error'});
  return parseState(result,binding);
}
function callbackTask(enterpriseId: string,taskId: string): LoginTaskRecord {
  const task = getTask(enterpriseId,taskId);
  if (!task) throw new EnterpriseContractError('enterprise_task_missing');
  taskBinding(task);
  requireEnterpriseInput(task);
  return task;
}
