import {
  HttpApiError,
  type CreateLoginTaskRequest,
  type EnterpriseId,
  type LoginCredentials,
  type SsoType,
} from '@ghcp/shared';
import { resolveDefaultLoginPassword } from '../clients/ssoClient.js';
import { beginCopilotOauthAuthorization, getAccount } from '../db/accountsRepo.js';
import type { ProxyAccountRecord } from '../db/storageTypes.js';

export type PrepareLoginAuthorizationInput = LoginCredentials & {
  /** The enterprise the caller addressed; an account of another enterprise is reported as missing. */
  enterpriseId: EnterpriseId;
  ssoType: SsoType;
  ssoUser: string;
  ghLogin: string;
} & (
  /** Manual re-authorization: supersedes whatever attempt the account currently points at. */
  | { force: true }
  /**
   * Retry of an earlier attempt: only proceeds while the account still points at that attempt
   * (`null` for an account that never had one), so a stale retry cannot hijack a newer authorization.
   */
  | { force?: false; previousAttemptId: string | null }
);

/** An account row of the enterprise, or undefined; another enterprise's row is never revealed (design §5.3). */
export async function getEnterpriseAccount(
  enterpriseId: EnterpriseId,
  identity: string,
): Promise<ProxyAccountRecord | undefined> {
  const account = await getAccount(identity);
  return account?.enterpriseId === enterpriseId ? account : undefined;
}

/**
 * Switches the Proxy account to a new authorization attempt and returns the payload Login needs to
 * run it. The account row is the only fence: `copilot_oauth_attempt_id` decides which attempt may
 * still write a token or report a failure, and a forced begin simply replaces it.
 */
export async function prepareLoginAuthorization(
  identity: string,
  attemptId: string,
  input: PrepareLoginAuthorizationInput,
): Promise<CreateLoginTaskRequest> {
  const account = await getEnterpriseAccount(input.enterpriseId, identity);
  if (!account) throw new HttpApiError(404, 'account_not_found', 'The Proxy account no longer exists.');
  assertAuthorizable(account, input);
  const password = input.credentialMode === 'override'
    ? input.ssoPassword
    : await resolveDefaultLoginPassword(account.enterpriseId, account.ssoUser);
  const expected = input.force ? undefined : input.previousAttemptId;
  if (!await beginCopilotOauthAuthorization(identity, attemptId, expected)) {
    throw authorizationConflict();
  }
  return {
    identity, oauthAttemptId: attemptId, ssoUser: account.ssoUser, ghLogin: input.ghLogin,
    ssoType: input.ssoType, ssoPassword: password,
  };
}

function assertAuthorizable(account: ProxyAccountRecord, input: PrepareLoginAuthorizationInput): void {
  if (account.ssoUser !== input.ssoUser || account.ghLogin !== input.ghLogin) {
    const message = 'The account mapping changed. Open the current account to reauthorize.';
    throw new HttpApiError(409, 'account_mapping_changed', message);
  }
  if (!input.force) {
    if (account.copilotOauthStatus === 'valid') {
      const message = 'The account is already authorized. Reauthorize it from the account if a new token is required.';
      throw new HttpApiError(409, 'authorization_not_needed', message);
    }
    if ((account.copilotOauthAttemptId ?? null) !== input.previousAttemptId) throw authorizationConflict();
  }
  if (input.credentialMode === 'default' && input.ssoType !== 'custom') {
    throw new HttpApiError(409, 'password_override_required', 'Azure login requires an explicit password override.');
  }
}

function authorizationConflict(): HttpApiError {
  const message = 'Another authorization changed this account. Refresh before retrying.';
  return new HttpApiError(409, 'authorization_conflict', message);
}
