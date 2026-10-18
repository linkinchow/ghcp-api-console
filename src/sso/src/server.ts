import express from 'express';
import { apiError, installGracefulShutdown, managementErrorHandler } from '@ghcp/shared';
import { config } from './config.js';
import type { Server } from 'node:http';
import { closeDb, getDb } from './db/connection.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { ssoEnterprises, ssoRegistryWarnings, type SsoEnterprise } from './enterprises.js';
import { mountSamlRouters } from './routes/samlRoutes.js';
import {
  createEnterpriseApiRouter,
  createEnterpriseInternalRouter,
  rejectUnscoped,
} from './routes/enterpriseRoutes.js';
import { createEnterprisesInternalRouter } from './routes/enterprisesInternal.js';
import { samlUrls } from './saml/saml.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'sso' });
  });
  mountSamlRouters(app);
  mountManagementRouters(app);
  app.use(managementErrorHandler('sso'));
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'SSO route is not implemented yet.'));
  });
  return app;
}

/** Every management and internal route is scoped by enterprise; unscoped paths are rejected (design §5.1). */
function mountManagementRouters(app: express.Express): void {
  app.use('/api/enterprises/:enterpriseId', requireInternalToken, createEnterpriseApiRouter());
  app.use('/internal/enterprises/:enterpriseId', requireInternalToken, createEnterpriseInternalRouter());
  app.use('/internal/enterprises', requireInternalToken, createEnterprisesInternalRouter());
  app.use('/api', requireInternalToken, rejectUnscoped);
  app.use('/internal', requireInternalToken, rejectUnscoped);
}

export function startServer(): Server {
  getDb();
  const server = buildApp().listen(config.port, () => {
    console.log(`[sso] listening on ${config.baseUrl}`);
    for (const warning of ssoRegistryWarnings()) console.warn(`[sso] enterprise registry: ${warning}`);
    for (const enterprise of ssoEnterprises()) logEnterprise(enterprise);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sso] failed to listen on port ${config.port}: address already in use`);
      process.exitCode = 1;
      return;
    }
    throw err;
  });
  installGracefulShutdown({ server, service: 'sso', release: closeDb });
  return server;
}

function logEnterprise(enterprise: SsoEnterprise): void {
  const { endpoints } = enterprise;
  const loginRule = endpoints.isGheCom
    ? 'GHE.com; GH logins carry no shortcode suffix'
    : endpoints.shortcode ? `GH login suffix _${endpoints.shortcode}` : 'no GH login suffix';
  console.log(`[sso] enterprise ${enterprise.id}: GitHub ${endpoints.baseUrl} (${loginRule})`);
  try {
    console.log(`[sso] enterprise ${enterprise.id}: SAML metadata ${samlUrls(enterprise).idpEntityId}`);
  } catch (err) {
    console.warn(`[sso] enterprise ${enterprise.id}: SAML is not configured: ${(err as Error).message}`);
  }
}
