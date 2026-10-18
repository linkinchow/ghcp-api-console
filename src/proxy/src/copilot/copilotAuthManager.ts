import { randomUUID } from 'node:crypto';
import {
  HttpApiError,
  readLoginCredentials,
  type CreateLoginTaskRequest,
  type EnsureSsoUserResponse,
  type EnterpriseId,
  type LoginTaskDto,
  type SsoType,
} from '@ghcp/shared';
import {
  claimIdentityInitialization,
  createAccount,
  failCopilotOauthAuthorization,
  getAccount,
  invalidateCopilotOauthToken,
  releaseIdentityInitialization,
} from '../db/accountsRepo.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { createLoginTask, type LoginTaskSubmission } from '../clients/loginClient.js';
import { config } from '../config.js';
import { directModeEnterprise, requireProxyEnterprise, type ProxyEnterprise } from '../enterprises.js';
import { Logger } from '../logger.js';
import type { CopilotAuthContext } from './copilotAuth.js';
import { prepareLoginAuthorization } from '../accounts/loginAuthorization.js';

export class CopilotAuthNotReadyError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'account_initializing' | 'account_limit_reached' | 'oauth_not_ready',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CopilotAuthNotReadyError';
  }
}

class CopilotAuthManager {
  private readonly logger = new Logger('copilot-auth-manager');
  private readonly initializing = new Map<string, { prepared: Promise<void>; completed: Promise<void> }>();

  async getAuth(identity: string): Promise<CopilotAuthContext> {
    const account = await getAccount(identity);
    if (!account) {
      try {
        await this.beginIdentityInitialization(identity);
      } catch (err) {
        if (err instanceof HttpApiError && err.code === 'sso_user_limit_reached') {
          throw new CopilotAuthNotReadyError(409, 'account_limit_reached', err.message, err.details);
        }
        throw err;
      }
      throw new CopilotAuthNotReadyError(202, 'account_initializing', 'Account initialization has started.');
    }
    if (!account.copilotOauthToken || account.copilotOauthStatus !== 'valid') {
      const initializing = account.copilotOauthStatus === 'refreshing';
      throw new CopilotAuthNotReadyError(
        initializing ? 202 : 503,
        initializing ? 'account_initializing' : 'oauth_not_ready',
        initializing
          ? 'Copilot OAuth authorization is in progress for this identity.'
          : 'Copilot OAuth authorization is required for this identity.',
      );
    }
    const enterprise = requireProxyEnterprise(account.enterpriseId);
    return {
      identity,
      accessToken: account.copilotOauthToken,
      api: enterprise.endpoints.copilotApiBaseUrl,
      enterpriseId: enterprise.id,
    };
  }

  async triggerOauthRefresh(identity: string, options: OauthRefreshOptions = {}): Promise<LoginTaskDto> {
    const account = await getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    const oauthAttemptId = randomUUID();
    const enterprise = requireProxyEnterprise(account.enterpriseId);
    const payload = await prepareLoginAuthorization(identity, oauthAttemptId, {
      ...readLoginCredentials(options), enterpriseId: enterprise.id, ssoUser: account.ssoUser,
      ghLogin: account.ghLogin, ssoType: effectiveSsoType(enterprise, options.ssoType), force: true,
    });
    return this.submitLogin(enterprise, payload);
  }

  private async submitLogin(enterprise: ProxyEnterprise, payload: CreateLoginTaskRequest): Promise<LoginTaskDto> {
    try { return await createLoginTask(enterprise.id, loginSubmission(enterprise, payload)); }
    catch (err) {
      // Login did not accept the task, so the account must not stay `refreshing`. The rollback is
      // fenced on the attempt id: if Login did accept it and already wrote the token, this is a no-op.
      await failCopilotOauthAuthorization(payload.identity, payload.oauthAttemptId).catch((rollbackErr: unknown) => {
        this.logger.error('rollback-failed', 'Could not mark the authorization attempt failed after a rejected Login submission; reauthorize the account manually if it stays refreshing', {
          identity: payload.identity, oauthAttemptId: payload.oauthAttemptId,
          submissionError: err instanceof Error ? err.message : String(err),
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        });
      });
      throw err;
    }
  }

  invalidate(identity: string, expectedToken: string): Promise<boolean> {
    return invalidateCopilotOauthToken(identity, expectedToken, 'expired');
  }

  /** New direct-mode identities belong to DIRECT_MODE_ENTERPRISE_ID (design §5.1). */
  private async beginIdentityInitialization(identity: string): Promise<void> {
    const existing = this.initializing.get(identity);
    if (existing) return existing.prepared;

    const enterprise = directModeEnterprise();
    const claimId = randomUUID();
    const claimed = await claimIdentityInitialization(
      enterprise.id,
      identity,
      claimId,
      config.identityInitLeaseSeconds,
    );
    if (!claimed) return;

    this.logger.info('identity-init', 'Initializing unknown identity', { identity, enterpriseId: enterprise.id });
    const preferredSsoUser = ssoUserFromIdentity(identity, enterprise);
    const ensured = ensureSsoUser(enterprise.id, { identity, preferredSsoUser });
    const prepared = ensured.then(() => undefined);
    const completed = ensured.then((result) => this.initializeEnsuredIdentity(enterprise, identity, result));
    const state = { prepared, completed };
    this.initializing.set(identity, state);
    void completed
      .catch((err: unknown) => {
        this.logger.error('identity-init', 'Identity initialization failed', {
          identity,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(async () => {
        if (this.initializing.get(identity) === state) this.initializing.delete(identity);
        try {
          await releaseIdentityInitialization(identity, claimId);
        } catch (err) {
          this.logger.error('identity-init-release', 'Failed to release identity initialization claim', {
            identity,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return prepared;
  }

  private async initializeEnsuredIdentity(
    enterprise: ProxyEnterprise,
    identity: string,
    ensured: EnsureSsoUserResponse,
  ): Promise<void> {
    const enterpriseId = enterprise.id;
    const synced = await syncEmuUser(enterpriseId, ensured.user.ssoUser, { assignCopilotSeat: true });
    if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);
    const oauthAttemptId = randomUUID();
    const ssoPassword = ensured.passwordForLogin;
    await createAccount({
      enterpriseId,
      identity,
      ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin,
      copilotOauthStatus: ssoPassword ? 'missing' : 'failed',
    });
    if (!ssoPassword) {
      throw new Error(`SSO password is required to initialize identity "${identity}"; reauthorize it from Console with an explicit password.`);
    }
    // The row was created (or re-created) by this initialization, so there is no earlier attempt to respect.
    const payload = await prepareLoginAuthorization(identity, oauthAttemptId, {
      credentialMode: 'override', ssoPassword, enterpriseId, ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin, ssoType: effectiveSsoType(enterprise, undefined), force: true,
    });
    await this.submitLogin(enterprise, payload);
  }
}

interface OauthRefreshOptions {
  ssoPassword?: string;
  ssoType?: SsoType;
  credentialMode?: 'default' | 'override';
}

/**
 * The SSO provider of one Login task. A profile that sets `login.ssoProvider` decides it; otherwise each task
 * chooses, as r4 did (design §5.7).
 */
function effectiveSsoType(enterprise: ProxyEnterprise, requested: SsoType | undefined): SsoType {
  return enterprise.profile.login.ssoProvider ?? requested ?? 'custom';
}

/** `ssoType` is sent only while the profile leaves the choice to the task; Login applies the profile's own. */
function loginSubmission(enterprise: ProxyEnterprise, payload: CreateLoginTaskRequest): LoginTaskSubmission {
  const { ssoType, ...task } = payload;
  return enterprise.profile.login.ssoProvider ? task : { ...task, ssoType };
}

function ssoUserFromIdentity(identity: string, enterprise: ProxyEnterprise): string {
  const normalized = identity
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized, enterprise.endpoints.shortcode).slice(0, 32);
}

function stripEnterpriseShortcode(value: string, enterpriseShortcode: string): string {
  const shortcode = enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}

export const copilotAuthManager = new CopilotAuthManager();
