import type { CreateLoginTaskV2, EnterpriseProfileV3 } from '@ghcp/shared';
import { bindingKey, EnterpriseContractError, loggerFor } from '@ghcp/shared';
import { bindingFromInput, requireEnterpriseInput } from '../enterprise.js';
import { config, type RuntimeAuthConfig } from '../config.js';
import { loginRuntimeSettings } from '../db/runtimeSettingsRepo.js';
import { HeadlessPlaywrightAuthStrategy } from '../auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from '../auth/deviceFlow.js';
import { readAuthorizationAttempt, saveCopilotOauthToken, markCopilotOauthFailed } from '../clients/proxyClient.js';
import { getTask, markAuthorityUncertain, markCallbackPending, resolveAuthority, setTaskLogPath, taskBinding, type LoginTaskRecord } from '../db/tasksRepo.js';
import { AccountLogger } from './accountLogger.js';

const stdoutLogger = loggerFor('login','runner');
export interface RuntimeTaskPayload extends CreateLoginTaskV2 { taskId: string; profile: EnterpriseProfileV3 }
interface RunnerDependencies {
  authorize(options: RuntimeAuthConfig,payload: RuntimeTaskPayload,logger: AccountLogger,signal: AbortSignal): Promise<string>;
  readAuthorizationAttempt: typeof readAuthorizationAttempt;
  saveCopilotOauthToken: typeof saveCopilotOauthToken;
  markCopilotOauthFailed: typeof markCopilotOauthFailed;
}
const defaultDependencies: RunnerDependencies = {
  authorize: (options,payload,logger,signal) => loginWithDeviceFlow(new HeadlessPlaywrightAuthStrategy(options,{
    githubUsername:payload.expectedGhLogin,ssoUsername:payload.ssoUser,ssoPassword:payload.ssoPassword,
  },logger),logger,undefined,signal),readAuthorizationAttempt,saveCopilotOauthToken,markCopilotOauthFailed,
};
export async function runLoginTask(task: LoginTaskRecord,payload: RuntimeTaskPayload,signal: AbortSignal = new AbortController().signal,
  overrides: Partial<RunnerDependencies> = {}): Promise<void> {
  const deps = {...defaultDependencies,...overrides};
  const scope = requireEnterpriseInput(task),binding = taskBinding(task);
  requireEnterpriseInput(payload);
  if (payload.taskId !== task.id || bindingKey(bindingFromInput(payload)) !== bindingKey(binding)
      || payload.ssoUser !== task.ssoUser || payload.ssoType !== task.ssoType
      || payload.profile !== scope.profile || payload.profile.login.provider !== payload.ssoType) {
    throw new EnterpriseContractError('enterprise_task_payload_mismatch');
  }
  if (getTask(task.enterpriseId,task.id)?.status !== 'running') return;
  signal.throwIfAborted();
  const settings = loginRuntimeSettings.getSnapshot();
  const runSignal = AbortSignal.any([signal,AbortSignal.timeout(settings.authTimeoutMs)]);
  const logger = AccountLogger.createTask(config.logDir,{enterpriseId:task.enterpriseId,taskId:task.id,oauthAttemptId:binding.oauthAttemptId},settings.authDebugLogs);
  setTaskLogPath(task.enterpriseId,task.id,logger.path);
  try {
    if (!payload.ssoPassword) throw new EnterpriseContractError('login_password_required');
    const authority = await deps.readAuthorizationAttempt(binding,runSignal);
    if (authority.status !== 'active') {
      if (markCallbackPending(task.enterpriseId,task.id,'fail','authorization_attempt_closed')) {
        resolveAuthority(task.enterpriseId,task.id,authority.status);
      }
      return;
    }
    runSignal.throwIfAborted();
    const options: RuntimeAuthConfig = Object.freeze({
      ...config.auth,ssoUrl:payload.profile.sso.loginUrl,ssoProvider:payload.profile.login.provider,
      allowedLoginUrls:payload.profile.login.allowedLoginUrls,selectors:payload.profile.login.selectors,
      timeoutMs:settings.authTimeoutMs,debugLogs:settings.authDebugLogs,debugArtifacts:settings.authDebugArtifacts,
      artifactScope:{enterpriseId:task.enterpriseId,taskId:task.id,oauthAttemptId:binding.oauthAttemptId},
    });
    const token = await deps.authorize(options,payload,logger,runSignal);
    runSignal.throwIfAborted();
    if (!markCallbackPending(task.enterpriseId,task.id,'success')) return; // Cancellation won CAS.
    try {
      // Proxy revalidates the token via its own GET /user. Never reassign expected subject from browser/request data.
      const state = await deps.saveCopilotOauthToken(task.enterpriseId,task.id,token,runSignal);
      if (state.status === 'succeeded') resolveAuthority(task.enterpriseId,task.id,state.status);
      else markAuthorityUncertain(task.enterpriseId,task.id);
    } catch {
      // Ambiguous callback is not a browser failure. Read-only resolution, no new login or failure callback.
      markAuthorityUncertain(task.enterpriseId,task.id);
      if (!signal.aborted) {
        try {
          const state = await deps.readAuthorizationAttempt(binding,signal);
          resolveAuthority(task.enterpriseId,task.id,state.status);
        } catch { /* durable uncertain; bounded reconcile closes after restart/operator request */ }
      }
    }
  } catch {
    if (signal.aborted) return; // Cancel path owns closure/ack; cannot overwrite it.
    if (markCallbackPending(task.enterpriseId,task.id,'fail','login_authorization_failed')) {
      try {
        const state = await deps.markCopilotOauthFailed(task.enterpriseId,task.id,'login_authorization_failed',signal);
        if (state.status === 'failed') resolveAuthority(task.enterpriseId,task.id,state.status);
        else markAuthorityUncertain(task.enterpriseId,task.id);
      } catch { markAuthorityUncertain(task.enterpriseId,task.id); }
    }
  } finally {
    const status = getTask(task.enterpriseId,task.id)?.status;
    logger.info('complete','Login execution stopped',{status});
    stdoutLogger.info('complete','Login execution stopped',{enterpriseId:task.enterpriseId,taskId:task.id,oauthAttemptId:task.oauthAttemptId,status});
  }
}
