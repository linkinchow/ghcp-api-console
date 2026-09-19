import type { CreateLoginTaskV2 } from '@ghcp/shared';
import { bindingKey, EnterpriseContractError, loggerFor } from '@ghcp/shared';
import { bindingFromInput, requireEnterpriseInput } from '../enterprise.js';
import { getEnterpriseProfile } from '../db/connection.js';
import { claimTask, createTask, getTask, isTerminalTask, listUncertainTasks, markAuthorityUncertain, requestCancellation, resolveAuthority, taskBinding, type LoginTaskRecord } from '../db/tasksRepo.js';
import { loginRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import { cancelAuthorizationAttempt, readAuthorizationAttempt } from '../clients/proxyClient.js';
import { runLoginTask, type RuntimeTaskPayload } from './runner.js';

interface LoginQueueDependencies {
  createTask: typeof createTask; getTask: typeof getTask; claimTask: typeof claimTask;
  requestCancellation: typeof requestCancellation; resolveAuthority: typeof resolveAuthority;
  markAuthorityUncertain: typeof markAuthorityUncertain; listUncertainTasks: typeof listUncertainTasks;
  readAuthorizationAttempt: typeof readAuthorizationAttempt; cancelAuthorizationAttempt: typeof cancelAuthorizationAttempt;
  runLoginTask: typeof runLoginTask; getConcurrency: () => number;
}
const defaultDependencies: LoginQueueDependencies = {
  createTask,getTask,claimTask,requestCancellation,resolveAuthority,markAuthorityUncertain,listUncertainTasks,
  readAuthorizationAttempt,cancelAuthorizationAttempt,runLoginTask,
  getConcurrency:() => loginRuntimeSettings.getSnapshot().concurrency,
};
export interface CancellationResult {task: LoginTaskRecord; outcome:'cancelled'|'already-succeeded'|'already-failed'|'unknown'}

export class LoginQueue {
  private readonly logger = loggerFor('login','queue');
  private readonly pending: RuntimeTaskPayload[] = [];
  private readonly activeMap = new Map<string,AbortController>();
  private readonly dependencies: LoginQueueDependencies;
  constructor(dependencies: Partial<LoginQueueDependencies> = {}) { this.dependencies = {...defaultDependencies,...dependencies}; }

  async enqueue(request: CreateLoginTaskV2): Promise<LoginTaskRecord> {
    const scope = requireEnterpriseInput(request),binding = bindingFromInput(request);
    if (request.ssoType !== scope.profile.login.provider || !request.ssoUser || !request.ssoPassword) {
      throw new EnterpriseContractError('login_task_input_invalid');
    }
    if (['ssoUrl','selectorOverrides'].some(key => key in request)) throw new EnterpriseContractError('enterprise_route_override_forbidden');
    // No local mutation before this authority read and exact tuple comparison.
    const authority = await this.dependencies.readAuthorizationAttempt(binding);
    if (bindingKey(authority.binding) !== bindingKey(binding)) throw new EnterpriseContractError('authorization_binding_mismatch');
    const {task,created} = this.dependencies.createTask(request,authority.status === 'active');
    if (!created) return task;
    const payload: RuntimeTaskPayload = Object.freeze({...binding,ssoUser:task.ssoUser,ssoType:task.ssoType,
      ssoPassword:request.ssoPassword,taskId:task.id,profile:scope.profile});
    this.pending.push(payload);
    this.logger.info('enqueue','Queued login task',{enterpriseId:task.enterpriseId,taskId:task.id,oauthAttemptId:task.oauthAttemptId});
    this.drain();
    return task;
  }

  retry(enterpriseId: string,id: string): never {
    const task = this.dependencies.getTask(enterpriseId,id);
    if (!task) throw new EnterpriseContractError('enterprise_task_missing');
    if (task.bindingVersion !== 2) throw new EnterpriseContractError('legacy_task_history_only');
    throw new EnterpriseContractError('new_proxy_attempt_required');
  }

  async cancel(enterpriseId: string,id: string): Promise<CancellationResult | undefined> {
    const existing = this.dependencies.getTask(enterpriseId,id);
    if (!existing) return undefined;
    taskBinding(existing); // Migrated history cannot emit callbacks.
    if (isTerminalTask(existing)) return cancellationResult(existing);
    const task = this.dependencies.requestCancellation(enterpriseId,id)!;
    const index = this.pending.findIndex(item => item.taskId === id && item.enterpriseId === enterpriseId);
    if (index !== -1) this.pending.splice(index,1); // Forget password, not just the queue marker.
    this.activeMap.get(id)?.abort(); // Only the matching task owns this controller/browser.
    return this.closeAttempt(task);
  }

  async reconcile(enterpriseId: string,id: string,signal?: AbortSignal): Promise<CancellationResult | undefined> {
    const task = this.dependencies.getTask(enterpriseId,id);
    if (!task) return undefined;
    taskBinding(task);
    if (isTerminalTask(task)) return cancellationResult(task);
    if (task.status !== 'uncertain' || this.activeMap.has(id)) throw new EnterpriseContractError('task_reconcile_not_allowed');
    return this.closeAttempt(task,signal,true);
  }
  async reconcileInterruptedTasks(limit = 20): Promise<void> {
    const signal = AbortSignal.timeout(30_000);
    for (const task of this.dependencies.listUncertainTasks(limit)) {
      if (signal.aborted) break;
      try { await this.reconcile(task.enterpriseId,task.id,signal); }
      catch { /* One concurrently changed task must not consume the entire bounded recovery pass. */ }
    }
  }
  onRuntimeSettingsUpdated(): void { this.drain(); }

  private async closeAttempt(task: LoginTaskRecord,signal?: AbortSignal,readFirst = false): Promise<CancellationResult> {
    const binding = taskBinding(task);
    // On restart, first establish whether a previously sent callback actually committed.
    if (readFirst) {
      try {
        const state = await this.dependencies.readAuthorizationAttempt(binding,signal);
        if (state.status !== 'active') {
          this.dependencies.resolveAuthority(task.enterpriseId,task.id,state.status);
          return cancellationResult(this.dependencies.getTask(task.enterpriseId,task.id)!);
        }
      } catch {
        this.dependencies.markAuthorityUncertain(task.enterpriseId,task.id);
        return cancellationResult(this.dependencies.getTask(task.enterpriseId,task.id)!);
      }
    }
    try {
      const state = await this.dependencies.cancelAuthorizationAttempt(task.enterpriseId,task.id,signal);
      if (state.status !== 'active') this.dependencies.resolveAuthority(task.enterpriseId,task.id,state.status);
      else this.dependencies.markAuthorityUncertain(task.enterpriseId,task.id);
    } catch {
      try {
        const state = await this.dependencies.readAuthorizationAttempt(binding,signal);
        if (state.status === 'active') this.dependencies.markAuthorityUncertain(task.enterpriseId,task.id);
        else this.dependencies.resolveAuthority(task.enterpriseId,task.id,state.status);
      } catch { this.dependencies.markAuthorityUncertain(task.enterpriseId,task.id); }
    }
    return cancellationResult(this.dependencies.getTask(task.enterpriseId,task.id)!);
  }
  private drain(): void {
    while (this.activeMap.size < this.dependencies.getConcurrency() && this.pending.length > 0) {
      const payload = this.pending.shift()!;
      // Current registry must still agree before claiming; no mutable global profile swap.
      if (getEnterpriseProfile(payload.enterpriseId).revision !== payload.enterpriseRevision) continue;
      const task = this.dependencies.claimTask(payload.enterpriseId,payload.taskId);
      if (!task) continue;
      const controller = new AbortController();
      this.activeMap.set(task.id,controller);
      void this.dependencies.runLoginTask(task,payload,controller.signal).catch(async () => {
        // Unexpected runner failure must still revoke the authority, never mark a locally failed terminal task.
        try { await this.cancel(task.enterpriseId,task.id); }
        catch { this.logger.error('closure-unconfirmed','Task closure needs reconciliation',{enterpriseId:task.enterpriseId,taskId:task.id}); }
      }).finally(() => {
        this.activeMap.delete(task.id);
        this.drain();
      });
    }
  }
}
function cancellationResult(task: LoginTaskRecord): CancellationResult {
  return {task,outcome:task.status === 'cancelled' ? 'cancelled' : task.status === 'success' ? 'already-succeeded' : task.status === 'failed' ? 'already-failed' : 'unknown'};
}
export const loginQueue = new LoginQueue();
