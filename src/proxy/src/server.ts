import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { installGracefulShutdown, managementErrorHandler, releaseLine, shouldRedact } from '@ghcp/shared';
import { config } from './config.js';
import { closeStorage, initializeStorage, pingStorage } from './db/connection.js';
import { pruneAllRequestStats } from './db/requestStatsRepo.js';
import { requireApiKey } from './auth/apiKey.js';
import { requireIdentityHeader } from './auth/identityHeader.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { Logger } from './logger.js';
import { compatibleRouter } from './routes/compatible.js';
import { resolveClaudeCodeOptimized } from './routes/claudeCodeMode.js';
import { adminApiRouter } from './routes/adminApi.js';
import {
  createEnterpriseApiRouter,
  createEnterpriseInternalRouter,
  createLegacyAccountsRouter,
  rejectUnscoped,
} from './routes/enterpriseRoutes.js';
import { createEnterprisesApiRouter } from './routes/enterprisesApi.js';
import { userPoolApiRouter } from './routes/userPoolApi.js';
import { assertUserPoolOwner, getUserPool, routeUserPool, startUserPool, stopUserPool } from './userPool/runtime.js';
import { readPoolConfig } from './userPool/config.js';
import { directModeEnterprise, proxyEnterprises, proxyRegistryWarnings, type ProxyEnterprise } from './enterprises.js';

const requestLogger = new Logger('request');

export function buildApp(): express.Express {
  const app = express();
  app.use(logRequestHeaders);
  app.use(captureRawRequestBody);
  app.use(express.json({ limit: '20mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'proxy', releaseLine: releaseLine() });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await pingStorage();
      assertUserPoolOwner();
      res.json({ status: 'ok', service: 'proxy', storage: config.storageDriver });
    } catch (err) {
      requestLogger.error('readiness-failed', 'Proxy storage readiness check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({ status: 'unavailable', service: 'proxy' });
    }
  });
  mountManagementRouters(app);
  app.use(requireApiKey, requireIdentityHeader, routeUserPool, compatibleRouter);
  app.use((req, res) => {
    const claudeCodeOptimized = resolveClaudeCodeOptimized(req);
    if (!claudeCodeOptimized.ok) {
      sendInvalidRequestError(req, res, claudeCodeOptimized.message);
      return;
    }
    const message =
      `Unsupported Copilot API path: ${req.originalUrl}. ` +
      supportedPathsMessage(claudeCodeOptimized.enabled);
    if (req.path.startsWith('/v1/messages')) {
      res.status(404).json({ type: 'error', error: { type: 'invalid_request_error', message } });
      return;
    }
    res.status(404).json({ error: { message, type: 'invalid_request_error' } });
  });
  return app;
}

/**
 * Management and internal routes (design §5.1): enterprise-scoped routers, the global enterprise list, pool
 * settings and diagnostics, and the deprecated direct `/api/accounts`. Everything else unscoped answers 400.
 */
function mountManagementRouters(app: express.Express): void {
  const errors = managementErrorHandler('proxy');
  // The enterprise list router passes every path it does not own on to the scoped router.
  app.use('/api/enterprises', requireInternalToken, createEnterprisesApiRouter(), errors);
  app.use('/api/enterprises/:enterpriseId', requireInternalToken, createEnterpriseApiRouter(), errors);
  app.use('/api', requireInternalToken, adminApiRouter, userPoolApiRouter, createLegacyAccountsRouter(), errors);
  app.use('/api', requireInternalToken, rejectUnscoped);
  app.use('/internal/enterprises/:enterpriseId', requireInternalToken, createEnterpriseInternalRouter(), errors);
  app.use('/internal', requireInternalToken, rejectUnscoped);
}

export function captureRawRequestBody(req: Request, _res: Response, next: NextFunction): void {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  req.on('data', (chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(Buffer.from(buffer));
    byteLength += buffer.byteLength;
  });
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks, byteLength);
  });
  next();
}

function logRequestHeaders(req: Request, _res: Response, next: NextFunction): void {
  requestLogger.debug('request-headers', 'Received proxy request headers', {
    method: req.method,
    path: req.originalUrl,
    identityHeader: config.identityHeader,
    rawHeaders: redactRawHeaders(req.rawHeaders),
  });
  next();
}

function redactRawHeaders(rawHeaders: string[]): string[] {
  return rawHeaders.map((value, index) => {
    if (index % 2 === 0) return value;
    const headerName = rawHeaders[index - 1] ?? '';
    return shouldRedactHeader(headerName) ? '<redacted>' : value;
  });
}

function shouldRedactHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return shouldRedact(normalized) || normalized === config.identityHeader.toLowerCase()
    || normalized === 'x-api-key' || normalized === 'api-key' || normalized === 'apikey';
}

function supportedPathsMessage(claudeCodeOptimized: boolean): string {
  const paths = ['GET /v1/models', 'POST /chat/completions', 'POST /v1/messages', 'POST /responses'];
  if (claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  return `Supported paths: ${paths.join(', ')}.`;
}

/** Fails startup when DIRECT_MODE_ENTERPRISE_ID names no registry enterprise; logs each enterprise once. */
function logEnterprises(): void {
  const direct = directModeEnterprise();
  for (const warning of proxyRegistryWarnings()) console.warn(`[proxy] enterprise registry: ${warning}`);
  for (const enterprise of proxyEnterprises()) logEnterprise(enterprise, enterprise === direct);
}

function logEnterprise(enterprise: ProxyEnterprise, direct: boolean): void {
  const { endpoints } = enterprise;
  const role = direct ? ' (direct mode)' : '';
  const urls = `GitHub ${endpoints.baseUrl}, Copilot ${endpoints.copilotApiBaseUrl}`;
  console.log(`[proxy] enterprise ${enterprise.id}${role}: ${urls}`);
  const blockers = enterprise.profile.blockers.map((blocker) => `${blocker.code}:${blocker.field}`);
  if (blockers.length) console.warn(`[proxy] enterprise ${enterprise.id} is not ready: ${blockers.join(', ')}`);
}

function sendInvalidRequestError(req: Request, res: Response, message: string): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message } });
    return;
  }
  res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

export async function startServer(): Promise<Server> {
  let server: Server;
  try {
    const poolOptions = readPoolConfig(process.env);
    if (poolOptions.enabled && (!config.apiKey || !config.internalApiToken)) {
      throw new Error('User pool requires authenticated Proxy/internal APIs');
    }
    logEnterprises();
    await initializeStorage();
    await getUserPool();
    await pruneAllRequestStats();
    await startUserPool();
    server = await new Promise<Server>((resolve, reject) => {
      const listening = buildApp().listen(config.port, () => {
        console.log(`[proxy] listening on http://localhost:${config.port}`);
        resolve(listening);
      });
      listening.once('error', reject);
    });
  } catch (err) {
    try {
      await stopUserPool();
      await closeStorage();
    } catch (closeError) {
      throw new AggregateError([err, closeError], 'Proxy startup and storage cleanup both failed.');
    }
    throw err;
  }
  installGracefulShutdown({
    server,
    service: 'proxy',
    release: async () => {
      await stopUserPool();
      await closeStorage();
    },
  });
  return server;
}
