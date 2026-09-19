import express from 'express';
import { requireEnterpriseRequest } from './enterprise.js';
import { apiError, EnterpriseContractError, resolveEnterpriseScope } from '@ghcp/shared';
import { config } from './config.js';
import { getDb, getEnterpriseRegistry } from './db/connection.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { createUsersApiRouter } from './routes/usersApi.js';
import { createBudgetApiRouter } from './routes/budgetApi.js';
import { createSamlRouter } from './routes/samlRoutes.js';
import { createSettingsApiRouter } from './routes/settingsApi.js';
import { createEnterpriseReadinessRouter } from './routes/enterpriseReadiness.js';

export function buildApp(): express.Express {
  const registry = getEnterpriseRegistry();
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', service: 'sso' }); });
  app.use('/internal', requireInternalToken, createEnterpriseReadinessRouter());
  // SAML owns its bounded parsers. Never decode a large generic request body first.
  for (const profile of registry.profiles) {
    const scope = resolveEnterpriseScope(registry, profile.id);
    app.use(`/profiles/${profile.id}`, createSamlRouter(scope, false));
  }
  app.use(createSamlRouter(resolveEnterpriseScope(registry), true));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  for (const profile of registry.profiles) {
    const scope = resolveEnterpriseScope(registry, profile.id);
    app.use(`/api/profiles/${profile.id}`, requireInternalToken, requireEnterpriseRequest(scope),
      createSettingsApiRouter(scope), createUsersApiRouter(scope), createBudgetApiRouter(scope));
  }
  // Unknown explicit profile can never fall through to legacy routing.
  app.use(['/profiles/:enterpriseId', '/api/profiles/:enterpriseId'], (_req, res) => {
    res.status(404).json(apiError('enterprise_not_found', 'Enterprise profile was not found.'));
  });
  const legacy = resolveEnterpriseScope(registry);
  app.use('/api', requireInternalToken, requireEnterpriseRequest(legacy),
    createSettingsApiRouter(legacy), createUsersApiRouter(legacy), createBudgetApiRouter(legacy));
  app.use((_req, res) => { res.status(404).json(apiError('not_found', 'SSO route is not implemented yet.')); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof EnterpriseContractError) { res.status(400).json(apiError(error.code, 'Enterprise request was rejected.')); return; }
    res.status(500).json(apiError('sso_request_failed', 'SSO request failed.'));
  });
  return app;
}

export function startServer(): void {
  getDb();
  const server = buildApp().listen(config.port, () => { console.log(`[sso] listening on ${config.baseUrl}`); });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') { console.error(`[sso] failed to listen on port ${config.port}: address already in use`); process.exitCode = 1; return; }
    throw err;
  });
}
