import type { SsoProvider } from '@ghcp/shared';
import { config, type RuntimeAuthConfig } from '../config.js';
import type { ReadyLoginEnterprise } from '../enterprises.js';
import type { DeviceFlowClient } from './deviceFlow.js';

/** Per-run switches: the global runtime settings, or the debug CLI's flags. */
export interface AuthRunSettings {
  timeoutMs: number;
  debugLogs: boolean;
  debugArtifacts: boolean;
  headless?: boolean;
}

/**
 * The browser authorization config of one enterprise. Only the task's SSO type comes from the task, and only when
 * the profile leaves the provider open; pages, allowlist and selectors are the enterprise's (design §5.7).
 */
export function enterpriseAuthConfig(
  enterprise: ReadyLoginEnterprise,
  ssoType: SsoProvider,
  settings: AuthRunSettings,
): RuntimeAuthConfig {
  const { login } = enterprise.profile;
  return {
    ...config.auth,
    headless: settings.headless ?? config.auth.headless,
    github: enterprise.deployment,
    ssoProvider: login.ssoProvider ?? ssoType,
    ssoLoginUrl: login.ssoLoginUrl,
    allowedLoginUrls: login.allowedLoginUrls,
    selectors: login.selectors,
    timeoutMs: settings.timeoutMs,
    debugLogs: settings.debugLogs,
    debugArtifacts: settings.debugArtifacts,
  };
}

/** The enterprise's device-flow endpoints, verification page and OAuth client ID (design §6). */
export function enterpriseDeviceFlowClient(enterprise: ReadyLoginEnterprise): DeviceFlowClient {
  return {
    clientId: enterprise.oauthClientId,
    endpoints: enterprise.endpoints.deviceFlow,
    verificationUrl: enterprise.endpoints.deviceVerificationUrl,
  };
}
