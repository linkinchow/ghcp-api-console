import {
  HttpApiError,
  JsonHttpClient,
  loggerFor,
  redactSecrets,
  type CreateLoginTaskRequest,
  type EnterpriseId,
  type LoginTaskDto,
} from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.loginBaseUrl,
  internalToken: config.internalApiToken,
});

/** What Login accepts for a new task (design §5.7): the SSO page and selectors come from the registry only. */
export interface LoginTaskSubmission {
  identity: string;
  ssoUser: string;
  ssoPassword: string;
  ghLogin: string;
  oauthAttemptId: string;
  /** Omitted when the enterprise profile decides the provider. */
  ssoType?: CreateLoginTaskRequest['ssoType'];
}

/** `/api/enterprises/:id` on Login. */
export function loginApiPath(enterpriseId: EnterpriseId, path: string): string {
  return `/api/enterprises/${encodeURIComponent(enterpriseId)}${path}`;
}

export async function createLoginTask(
  enterpriseId: EnterpriseId,
  request: LoginTaskSubmission,
): Promise<LoginTaskDto> {
  const body = submissionBody(request);
  try {
    return await client.request<LoginTaskDto>(loginApiPath(enterpriseId, '/tasks'), { method: 'POST', body });
  } catch (submissionError) {
    if (isDefiniteRejection(submissionError)) throw submissionError;
    return reconcileSubmission(enterpriseId, request);
  }
}

export function getLoginTaskByAttempt(enterpriseId: EnterpriseId, attemptId: string): Promise<LoginTaskDto> {
  return client.request(loginApiPath(enterpriseId, `/tasks/by-attempt/${encodeURIComponent(attemptId)}`));
}

/** Only the fields Login allows; `ssoUrl`, `selectorOverrides` and the like would be refused. */
function submissionBody(request: LoginTaskSubmission): LoginTaskSubmission {
  return {
    identity: request.identity,
    ssoUser: request.ssoUser,
    ssoPassword: request.ssoPassword,
    ghLogin: request.ghLogin,
    oauthAttemptId: request.oauthAttemptId,
    ...(request.ssoType === undefined ? {} : { ssoType: request.ssoType }),
  };
}

function isDefiniteRejection(error: unknown): boolean {
  return error instanceof HttpApiError && error.status < 500 && error.status !== 408;
}

async function reconcileSubmission(enterpriseId: EnterpriseId, request: LoginTaskSubmission): Promise<LoginTaskDto> {
  try {
    return await getLoginTaskByAttempt(enterpriseId, request.oauthAttemptId);
  } catch (lookupError) {
    const message = lookupError instanceof Error ? lookupError.message : String(lookupError);
    const logger = loggerFor('proxy', 'login-client');
    logger.warn('submission-unconfirmed', 'Could not reconcile the login submission response', {
      enterpriseId,
      identity: request.identity,
      attemptId: request.oauthAttemptId,
      error: redactSecrets(message, [request.ssoPassword]),
    });
    throw new HttpApiError(
      502,
      'login_submission_unconfirmed',
      'The Login submission response could not be confirmed; inspect this account and its Login tasks before retrying.',
    );
  }
}
