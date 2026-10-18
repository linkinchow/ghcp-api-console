import express from 'express';
import type { Server } from 'node:http';
import { apiError, installGracefulShutdown, managementErrorHandler } from '@ghcp/shared';
import { config } from './config.js';
import { closeDb, getDb } from './db/connection.js';
import { loginEnterprises, loginRegistryWarnings, type LoginEnterprise } from './enterprises.js';
import { loginQueue } from './tasks/queue.js';
import { recoverLoginOutcomes } from './tasks/recovery.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { createEnterpriseApiRouter, rejectUnscoped } from './routes/enterpriseRoutes.js';
import { createEnterprisesInternalRouter } from './routes/enterprisesInternal.js';
import { settingsApiRouter } from './routes/settingsApi.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'login' });
  });
  mountManagementRouters(app);
  app.use(managementErrorHandler('login'));
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'Login route is not implemented yet.'));
  });
  return app;
}

/** Tasks are scoped by enterprise; only the process-wide runtime settings stay unscoped (design §4.4, §5.1). */
function mountManagementRouters(app: express.Express): void {
  app.use('/api/enterprises/:enterpriseId', createEnterpriseApiRouter());
  app.use('/internal/enterprises', requireInternalToken, createEnterprisesInternalRouter());
  app.use('/api', requireInternalToken, settingsApiRouter, rejectUnscoped);
}

export function startServer(): Server {
  getDb();
  recoverLoginOutcomes();
  const server = buildApp().listen(config.port, () => {
    console.log(`[login] listening on http://localhost:${config.port}`);
    for (const warning of loginRegistryWarnings()) console.warn(`[login] enterprise registry: ${warning}`);
    for (const enterprise of loginEnterprises()) logEnterprise(enterprise);
  });
  installGracefulShutdown({
    server,
    service: 'login',
    // Running browser sessions are not awaited: interrupted tasks are recovered on the next start.
    onShutdownStart: () => loginQueue.stopAccepting(),
    release: closeDb,
  });
  return server;
}

function logEnterprise(enterprise: LoginEnterprise): void {
  const { github } = enterprise.profile;
  const sso = enterprise.endpoints?.enterpriseSsoUrl;
  const mode = github.isGheCom ? ` (GHE.com, enterprise SSO ${sso ?? 'not configured'})` : '';
  console.log(`[login] enterprise ${enterprise.id}: GitHub ${github.baseUrl}${mode}`);
  if (enterprise.blockers.length > 0) {
    console.warn(`[login] enterprise ${enterprise.id} is not ready: ${enterprise.blockers.join(', ')}`);
  }
}
