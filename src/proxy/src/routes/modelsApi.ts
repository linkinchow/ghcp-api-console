import { Router, type Response } from 'express';
import { apiError, type AdminModelsResponse } from '@ghcp/shared';
import { config } from '../config.js';
import { GithubSubjectError, verifyGithubSubject } from '../accounts/githubSubject.js';
import { toAdminModels } from '../copilot/adminModels.js';
import { CopilotApiError, listModelsWithMetadata } from '../copilot/copilotClient.js';
import { ModelIdCollisionError } from '../copilot/modelIds.js';
import { ModelsAdminError, resolveModelsAdmin, type ModelsAdminCredential } from '../copilot/modelsAdmin.js';
import type { ProxyEnterprise } from '../enterprises.js';
import { requestEnterprise } from './requestEnterprise.js';

const LOOKUP_DEADLINE_MS = 35_000;
const VERIFY_TIMEOUT_MS = 15_000;

export interface ModelsApiDependencies {
  admin: (enterprise: ProxyEnterprise) => ModelsAdminCredential;
  verifySubject: (
    enterprise: ProxyEnterprise,
    token: string,
    signal: AbortSignal,
  ) => ReturnType<typeof verifyGithubSubject>;
  catalog: typeof listModelsWithMetadata;
}

const defaultDependencies: ModelsApiDependencies = {
  admin: resolveModelsAdmin,
  verifySubject: (enterprise, token, signal) => verifyGithubSubject(enterprise.endpoints.apiBaseUrl, token, signal),
  catalog: listModelsWithMetadata,
};

/**
 * GET /models?refresh=true|false — the Copilot model catalog of the request's enterprise as seen by that
 * enterprise's configured admin. Mounted behind `requireEnterprise`. It never reads, uses or falls back to
 * pool or direct-mode accounts, and it never changes any account state, even when Copilot rejects the token.
 */
export function createModelsApiRouter(overrides: Partial<ModelsApiDependencies> = {}): Router {
  const deps: ModelsApiDependencies = { ...defaultDependencies, ...overrides };
  const router = Router();

  router.get('/models', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refresh = readRefreshFlag(req.query);
    if (refresh === undefined) {
      res.status(400).json(apiError('invalid_models_query', 'Only a true/false refresh option is accepted.'));
      return;
    }

    // Stop GitHub/Copilot calls as soon as the Console request goes away or takes too long.
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    const deadline = setTimeout(abort, LOOKUP_DEADLINE_MS);
    deadline.unref();

    const enterprise = requestEnterprise(res);
    try {
      const admin = deps.admin(enterprise);
      const subject = await deps.verifySubject(
        enterprise,
        admin.accessToken,
        AbortSignal.any([controller.signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]),
      );
      controller.signal.throwIfAborted();
      if (!isConfiguredAdmin(subject, admin)) {
        res.status(502).json(apiError('models_admin_identity_mismatch',
          'The configured Copilot token does not belong to the configured enterprise admin. No other account was queried.'));
        return;
      }

      const catalog = await deps.catalog(adminCatalogAuth(enterprise, subject.id, admin), {
        useCache: !refresh,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (adminChanged(admin, deps.admin(enterprise))) {
        res.status(409).json(apiError('models_admin_changed', 'The admin configuration changed during the lookup. Refresh the model catalog.'));
        return;
      }

      const body: AdminModelsResponse = {
        adminLogin: subject.login,
        fetchedAt: new Date(catalog.fetchedAt).toISOString(),
        cacheStatus: catalog.cacheStatus,
        defaultView: config.claudeCodeOptimized ? 'messages' : 'all',
        models: toAdminModels(catalog.models),
      };
      res.json(body);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) sendModelsError(res, error, controller.signal.aborted);
    } finally {
      clearTimeout(deadline);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });

  return router;
}

/**
 * A dedicated cache identity: admin catalogs never share cache entries with member accounts, and numeric
 * GitHub user IDs of different GitHub instances never share one either (design §6).
 */
function adminCatalogAuth(enterprise: ProxyEnterprise, githubUserId: string, admin: ModelsAdminCredential) {
  return {
    identity: `models-admin:${enterprise.id}:${githubUserId}`,
    accessToken: admin.accessToken,
    api: enterprise.endpoints.copilotApiBaseUrl,
    enterpriseId: enterprise.id,
  };
}

/** `true`/`false`/absent; any other query parameter or shape is rejected. */
function readRefreshFlag(query: Record<string, unknown>): boolean | undefined {
  const keys = Object.keys(query);
  if (keys.some((key) => key !== 'refresh')) return undefined;
  if (query.refresh === undefined) return false;
  if (query.refresh === 'true') return true;
  if (query.refresh === 'false') return false;
  return undefined;
}

function isConfiguredAdmin(subject: { login: string; id: string }, admin: ModelsAdminCredential): boolean {
  if (subject.login.toLowerCase() !== admin.githubLogin.toLowerCase()) return false;
  return admin.githubUserId === undefined || subject.id === admin.githubUserId;
}

/** The token or identity rotated while the catalog was loading: the result may belong to the old admin. */
function adminChanged(before: ModelsAdminCredential, after: ModelsAdminCredential): boolean {
  return before.githubLogin !== after.githubLogin
    || before.githubUserId !== after.githubUserId
    || before.accessToken !== after.accessToken;
}

const ADMIN_ERROR_RESPONSES: Record<ModelsAdminError['code'], { status: number; message: string }> = {
  models_admin_not_configured: {
    status: 409,
    message: 'No model-catalog admin is configured for this enterprise. Ask the operator to set its modelsAdmin.',
  },
  models_admin_credential_missing: {
    status: 409,
    message: 'The configured enterprise admin Copilot token is unavailable. No pool account was used.',
  },
  models_admin_configuration_invalid: {
    status: 503,
    message: 'The model-catalog admin configuration of this enterprise is invalid. Ask the operator to check it.',
  },
};

/** Maps lookup failures to fixed messages; upstream bodies and secrets are never forwarded. */
function sendModelsError(res: Response, error: unknown, aborted: boolean): void {
  if (aborted) {
    res.status(504).json(apiError('models_lookup_timeout', 'Model catalog lookup timed out.'));
    return;
  }
  if (error instanceof ModelsAdminError) {
    const { status, message } = ADMIN_ERROR_RESPONSES[error.code];
    res.status(status).json(apiError(error.code, message));
    return;
  }
  if (error instanceof GithubSubjectError) {
    res.status(502).json(apiError('models_admin_verification_failed',
      'Could not verify the configured enterprise admin token with GitHub. No other account was queried.'));
    return;
  }
  if (error instanceof CopilotApiError) {
    sendCopilotError(res, error.status);
    return;
  }
  if (error instanceof ModelIdCollisionError || error instanceof SyntaxError || error instanceof TypeError) {
    res.status(502).json(apiError('models_catalog_invalid', 'The upstream model catalog could not be read safely.'));
    return;
  }
  res.status(503).json(apiError('models_lookup_unavailable', 'Model catalog lookup is unavailable.'));
}

function sendCopilotError(res: Response, status: number): void {
  if (status === 401 || status === 403) {
    res.status(502).json(apiError('models_upstream_authorization_rejected',
      `Copilot rejected the enterprise admin's catalog access (HTTP ${status}). No account state was changed.`));
  } else if (status === 429) {
    res.status(429).json(apiError('models_upstream_rate_limited', 'Copilot rate-limited the model catalog. Wait before refreshing.'));
  } else if (status === 504) {
    res.status(504).json(apiError('models_lookup_timeout', 'Model catalog lookup timed out.'));
  } else {
    res.status(502).json(apiError('models_upstream_unavailable', 'The upstream model catalog is unavailable.'));
  }
}
