import { Router, type Request, type Response } from 'express';
import { apiError, HttpApiError, readLoginCredentials, type EnterpriseId } from '@ghcp/shared';
import { clearModelsCache } from '../copilot/copilotClient.js';
import {
  deleteAccountsBySsoUser,
  failCopilotOauthAuthorization,
  getAccount,
  saveCopilotOauthToken,
  toAccountDto,
} from '../db/accountsRepo.js';
import type { ProxyAccountRecord } from '../db/storageTypes.js';
import { GithubSubjectError, verifyGithubSubject, type GithubSubject } from '../accounts/githubSubject.js';
import { getEnterpriseAccount, prepareLoginAuthorization } from '../accounts/loginAuthorization.js';
import { assertNotPoolManagedAccount } from '../accounts/poolGuard.js';
import type { ProxyEnterprise } from '../enterprises.js';
import { Logger } from '../logger.js';
import { getUserPool } from '../userPool/runtime.js';
import { requestEnterprise } from './requestEnterprise.js';

export interface InternalApiDependencies {
  /** `GET <enterprise apiBaseUrl>/user` with the token Login obtained (design §5.7). */
  verifySubject(enterprise: ProxyEnterprise, token: string): Promise<GithubSubject>;
}

const SUBJECT_TIMEOUT_MS = 15_000;
const logger = new Logger('internal-api');

const defaultDependencies: InternalApiDependencies = {
  verifySubject: (enterprise, token) => verifyGithubSubject(
    enterprise.endpoints.apiBaseUrl,
    token,
    AbortSignal.timeout(SUBJECT_TIMEOUT_MS),
  ),
};

/**
 * Login and SSO callbacks of one enterprise; mount behind `requireEnterprise` at
 * `/internal/enterprises/:enterpriseId`. A row of another enterprise answers exactly like a missing row.
 */
export function createInternalApiRouter(overrides: Partial<InternalApiDependencies> = {}): Router {
  const deps: InternalApiDependencies = { ...defaultDependencies, ...overrides };
  const router = Router();
  router.post('/accounts/:identity/oauth-attempts/:attemptId/prepare', prepareAttempt);
  router.put('/accounts/:identity/copilot-oauth-token', (req, res) => saveToken(deps, req, res));
  router.post('/accounts/:identity/mark-copilot-oauth-failed', markFailed);
  router.get('/accounts/:identity/login-task-protection', loginTaskProtection);
  router.get('/accounts/by-sso-user/:ssoUser/pool-membership', poolMembership);
  router.delete('/accounts/by-sso-user/:ssoUser', deleteBySsoUser);
  return router;
}

function enterpriseIdOf(res: Response): EnterpriseId {
  return requestEnterprise(res).id;
}

/**
 * Login calls this to retry a task: Proxy resolves the default SSO password (or takes the override)
 * and switches the account to the new attempt, but only if the account still points at the attempt
 * the task ran before (`previousAttemptId`, `null` for none).
 */
async function prepareAttempt(req: Request<{ identity: string; attemptId: string }>, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const { identity, attemptId } = req.params;
  try {
    const body = readPrepareBody(attemptId, req.body);
    // Another enterprise's row is reported as missing before its pool membership could show through.
    if (!await getEnterpriseAccount(enterpriseIdOf(res), identity)) {
      throw new HttpApiError(404, 'account_not_found', 'The Proxy account no longer exists.');
    }
    await assertNotPoolManagedAccount(identity);
    res.json(await prepareLoginAuthorization(identity, attemptId, {
      ...readLoginCredentials(body), enterpriseId: enterpriseIdOf(res), ssoUser: body.ssoUser,
      ghLogin: body.ghLogin, ssoType: body.ssoType, previousAttemptId: body.previousAttemptId,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('prepare-authorization-failed', 'Could not prepare login authorization', { identity, error: message });
    const code = err instanceof HttpApiError ? err.code : 'authorization_prepare_failed';
    res.status(err instanceof HttpApiError ? err.status : 502).json(apiError(code, message));
  }
}

interface PrepareBody extends Record<string, unknown> {
  ssoUser: string;
  ghLogin: string;
  ssoType: 'custom' | 'azure';
  previousAttemptId: string | null;
}

function readPrepareBody(attemptId: string, raw: unknown): PrepareBody {
  const body: Record<string, unknown> = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const valid = /^[a-f0-9-]{36}$/i.test(attemptId)
    && typeof body.ssoUser === 'string' && typeof body.ghLogin === 'string'
    && (body.ssoType === 'custom' || body.ssoType === 'azure')
    && (body.previousAttemptId === null || typeof body.previousAttemptId === 'string');
  if (!valid) {
    const message = 'A valid attempt ID, previous attempt, account mapping and SSO type are required.';
    throw new HttpApiError(400, 'invalid_attempt', message);
  }
  return body as PrepareBody;
}

/**
 * Accepts Login's token only for this enterprise's row, for the account's current attempt, and only when GitHub
 * confirms the token belongs to the account's GitHub login (design §5.7, checks 1–3).
 */
async function saveToken(deps: InternalApiDependencies, req: Request<{ identity: string }>, res: Response) {
  const { identity } = req.params;
  const body = readTokenBody(req.body);
  if (typeof body === 'string') {
    res.status(400).json(apiError(body, TOKEN_BODY_MESSAGES[body]));
    return;
  }
  const account = await getEnterpriseAccount(enterpriseIdOf(res), identity);
  if (!account) return sendAccountNotFound(res);
  if (!isCurrentAttempt(account, body.oauthAttemptId)) return sendStaleAttempt(res);
  const subject = await checkSubject(deps, requestEnterprise(res), account, body);
  if (subject !== 'match') return sendSubjectFailure(res, account, body.oauthAttemptId, subject);
  const ghLogin = typeof body.ghLogin === 'string' ? body.ghLogin : undefined;
  const saved = await saveCopilotOauthToken(identity, body.oauthAttemptId, body.copilotOauthToken, ghLogin);
  if (!saved) return sendStaleAttempt(res);
  clearModelsCache(identity);
  logger.info('save-copilot-oauth', 'Saved Copilot OAuth token from login service', {
    identity,
    enterpriseId: saved.enterpriseId,
    ghLogin: saved.ghLogin,
    copilotOauthStatus: saved.copilotOauthStatus,
  });
  res.json(toAccountDto(saved));
}

interface TokenBody {
  oauthAttemptId: string;
  copilotOauthToken: string;
  ghLogin?: unknown;
}

type TokenBodyError = 'invalid_oauth_attempt' | 'invalid_copilot_oauth_token';

const TOKEN_BODY_MESSAGES: Record<TokenBodyError, string> = {
  invalid_oauth_attempt: 'Request body must include a non-empty oauthAttemptId string.',
  invalid_copilot_oauth_token: 'Request body must include a non-empty copilotOauthToken string.',
};

function readTokenBody(raw: unknown): TokenBody | TokenBodyError {
  const body = (raw ?? {}) as Partial<Record<keyof TokenBody, unknown>>;
  if (typeof body.oauthAttemptId !== 'string' || !body.oauthAttemptId.trim()) return 'invalid_oauth_attempt';
  if (typeof body.copilotOauthToken !== 'string' || !body.copilotOauthToken.trim()) {
    return 'invalid_copilot_oauth_token';
  }
  return { oauthAttemptId: body.oauthAttemptId, copilotOauthToken: body.copilotOauthToken, ghLogin: body.ghLogin };
}

/** The same predicate the storage CAS applies; checked first so a stale callback never reaches GitHub. */
function isCurrentAttempt(account: ProxyAccountRecord, oauthAttemptId: string): boolean {
  return account.copilotOauthAttemptId === oauthAttemptId && account.copilotOauthStatus === 'refreshing';
}

type SubjectOutcome = 'match' | 'mismatch' | 'unavailable';

async function checkSubject(
  deps: InternalApiDependencies,
  enterprise: ProxyEnterprise,
  account: ProxyAccountRecord,
  body: TokenBody,
): Promise<SubjectOutcome> {
  const expected = account.ghLogin ?? (typeof body.ghLogin === 'string' ? body.ghLogin : undefined);
  let subject: GithubSubject;
  try {
    subject = await deps.verifySubject(enterprise, body.copilotOauthToken);
  } catch (error) {
    if (error instanceof GithubSubjectError) return 'unavailable';
    throw error;
  }
  if (!expected || subject.login.toLowerCase() !== expected.toLowerCase()) return 'mismatch';
  return 'match';
}

/**
 * A token of another GitHub user fails the attempt, so Login stops; an unreachable GitHub answers 503, which
 * Login retries a bounded number of times. Neither response says whose token it was.
 */
async function sendSubjectFailure(
  res: Response,
  account: ProxyAccountRecord,
  oauthAttemptId: string,
  outcome: Exclude<SubjectOutcome, 'match'>,
): Promise<void> {
  if (outcome === 'unavailable') {
    const message = 'GitHub could not confirm who owns the new token. Retry the callback.';
    res.status(503).json(apiError('authorization_subject_unavailable', message));
    return;
  }
  await failCopilotOauthAuthorization(account.identity, oauthAttemptId);
  logger.warn('authorization-subject-mismatch', 'Refused a Copilot OAuth token of another GitHub user', {
    identity: account.identity,
    enterpriseId: account.enterpriseId,
  });
  const message = 'The new token does not belong to this account\'s GitHub user.';
  res.status(409).json(apiError('authorization_subject_mismatch', message));
}

async function markFailed(req: Request<{ identity: string }>, res: Response): Promise<void> {
  const { identity } = req.params;
  const account = await getEnterpriseAccount(enterpriseIdOf(res), identity);
  if (!account) return sendAccountNotFound(res);
  const { oauthAttemptId } = (req.body ?? {}) as { oauthAttemptId?: unknown };
  if (typeof oauthAttemptId !== 'string' || !oauthAttemptId.trim()) {
    res.status(400).json(apiError('invalid_oauth_attempt', TOKEN_BODY_MESSAGES.invalid_oauth_attempt));
    return;
  }
  const updated = await failCopilotOauthAuthorization(identity, oauthAttemptId);
  logger.warn(
    updated ? 'mark-copilot-oauth-failed' : 'ignore-stale-copilot-oauth-failure',
    updated
      ? 'Marked Copilot OAuth authorization failed from login service'
      : 'Ignored a stale Copilot OAuth failure because the authorization attempt is no longer active',
    { identity, enterpriseId: account.enterpriseId },
  );
  const current = await getEnterpriseAccount(account.enterpriseId, identity);
  if (!current) return sendAccountNotFound(res);
  res.json(toAccountDto(current));
}

/** An identity unknown to Proxy is unmanaged; one of another enterprise is not found (design §5.3). */
async function loginTaskProtection(req: Request<{ identity: string }>, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const { identity } = req.params;
  const enterpriseId = enterpriseIdOf(res);
  const member = await (await getUserPool())?.inventory(identity);
  if (member && member.enterprise_id !== enterpriseId) return sendAccountNotFound(res);
  if (!member && await otherEnterpriseAccount(enterpriseId, identity)) return sendAccountNotFound(res);
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
  const attempt = typeof req.query.oauthAttemptId === 'string' ? req.query.oauthAttemptId : undefined;
  const referenced = Boolean(member && !['warmup', 'ready'].includes(member.stage)
    && ((taskId && member.task_id === taskId) || (attempt && member.oauth_attempt_id === attempt)));
  res.json({ managed: Boolean(member), referenced });
}

async function otherEnterpriseAccount(enterpriseId: EnterpriseId, identity: string): Promise<boolean> {
  const account = await getAccount(identity);
  return Boolean(account && account.enterpriseId !== enterpriseId);
}

/** Fails closed: a storage error is a 5xx, which SSO treats as "cannot verify" (design §5.3). */
async function poolMembership(req: Request<{ ssoUser: string }>, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const pool = await getUserPool();
  const managed = pool ? await pool.managesSsoUser(enterpriseIdOf(res), req.params.ssoUser) : false;
  res.json({ managed });
}

async function deleteBySsoUser(req: Request<{ ssoUser: string }>, res: Response): Promise<void> {
  const enterpriseId = enterpriseIdOf(res);
  const result = await deleteAccountsBySsoUser(enterpriseId, req.params.ssoUser);
  logger.info('delete-by-sso-user', 'Deleted proxy account data by SSO user', { ...result, enterpriseId });
  res.json(result);
}

function sendAccountNotFound(res: Response): void {
  res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
}

function sendStaleAttempt(res: Response): void {
  res.status(409).json(apiError('stale_oauth_attempt', 'This OAuth authorization attempt is no longer active.'));
}
