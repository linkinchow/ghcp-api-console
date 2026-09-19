import express from 'express';
import { requireEnterpriseRequest } from './enterprise.js';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { recoverInterruptedTasks } from './db/tasksRepo.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { createTasksApiRouter } from './routes/tasksApi.js';
import { createSettingsApiRouter } from './routes/settingsApi.js';
import { loginQueue, type LoginQueue } from './tasks/queue.js';
import { createEnterpriseReadinessRouter } from './routes/enterpriseReadiness.js';

export function buildApp(queue: LoginQueue = loginQueue): express.Express {
  const app = express();
  const tasksApiRouter = createTasksApiRouter(queue);
  const settingsApiRouter = createSettingsApiRouter(queue);
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'login' });
  });
  app.use('/internal', requireInternalToken, createEnterpriseReadinessRouter());
  app.use('/api/profiles/:enterpriseId', requireInternalToken, tasksApiRouter);
  app.use('/api', requireInternalToken, tasksApiRouter);
  // Concurrency remains one global setting, not per-enterprise weight.
  app.use('/api', requireInternalToken, requireEnterpriseRequest, settingsApiRouter);
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'Login route is not implemented yet.'));
  });
  return app;
}

export function startServer(queue: LoginQueue = loginQueue): void {
  getDb();
  recoverInterruptedTasks();
  // One bounded pass, no background redispatch or restored passwords.
  void queue.reconcileInterruptedTasks().catch(() => undefined);
  buildApp(queue).listen(config.port, () => {
    console.log(`[login] listening on http://localhost:${config.port}`);
  });
}
