import { Router, type Response } from 'express';
import {
  apiError,
  errorFields,
  readManagementQuery,
  csvExport,
  HttpApiError,
  type ClearProxyErrorDiagnosticsRequest,
} from '@ghcp/shared';
import { errorDiagnosticsStore } from '../diagnostics/errorDiagnostics.js';
import { ErrorDiagnosticsDisabledError } from '../diagnostics/errorDiagnosticsStore.js';
import { Logger } from '../logger.js';

/** Error diagnostics stay global (design §5.1); accounts and statistics live in `accountsApi.ts`. */
export const adminApiRouter = Router();
const logger = new Logger('admin-api');

adminApiRouter.get('/error-diagnostics', async (req, res) => {
  try {
    const query = readManagementQuery(req.query);
    if (query.status && !/^[1-5]\d\d$/.test(query.status)) throw new HttpApiError(400, 'invalid_status', 'HTTP status must be a three-digit status code.');
    if (query.failureCode && !['http', 'fetch', 'stream'].includes(query.failureCode)) throw new HttpApiError(400, 'invalid_failure_kind', 'Unknown diagnostic failure kind.');
    res.json(await errorDiagnosticsStore.list(query.page, query.pageSize, query));
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.route('/error-diagnostics/export').get(exportDiagnostics()).post(exportDiagnostics());
function exportDiagnostics() {
  return csvExport('error-diagnostics',
    ['id', 'identity', 'timestamp', 'path', 'model', 'failureKind', 'status'],
    (query) => errorDiagnosticsStore.list(query.page, query.pageSize, query),
    (record) => [record.id, record.identity, record.timestamp, record.path, record.model, record.failureKind, record.status],
    async (_query, consume) => {
      const items = await errorDiagnosticsStore.snapshot();
      await consume(async (query) => errorDiagnosticsStore.pageSnapshot(items, query));
    },
  );
}

adminApiRouter.delete('/error-diagnostics', async (req, res) => {
  const body = req.body as Partial<ClearProxyErrorDiagnosticsRequest>;
  if (body.confirm !== true) {
    res.status(400).json(apiError('error_diagnostics_confirmation_required', 'Set confirm to true to clear all error diagnostics.'));
    return;
  }
  try {
    await errorDiagnosticsStore.clear();
    logger.info('clear-error-diagnostics', 'Cleared all proxy error diagnostics');
    res.json({ cleared: true });
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
});

adminApiRouter.get('/error-diagnostics/:id/download', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, true);
});

adminApiRouter.get('/error-diagnostics/:id', async (req, res) => {
  await sendDiagnosticRecord(req.params.id, res, false);
});

async function sendDiagnosticRecord(id: string, res: Response, download: boolean): Promise<void> {
  if (!isDiagnosticId(id)) {
    res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
    return;
  }
  try {
    const record = await errorDiagnosticsStore.get(id);
    if (!record) {
      res.status(404).json(apiError('error_diagnostic_not_found', 'Proxy error diagnostic was not found.'));
      return;
    }
    if (download) {
      res.setHeader('Content-Disposition', `attachment; filename="proxy-error-${record.id}.log"`);
      res.type('text/plain').send(record.content);
      return;
    }
    res.json(record);
  } catch (err) {
    sendDiagnosticsError(res, err);
  }
}

function sendDiagnosticsError(res: Response, err: unknown): void {
  if (err instanceof HttpApiError) {
    res.status(err.status).json(apiError(err.code, err.message));
    return;
  }
  if (err instanceof ErrorDiagnosticsDisabledError) {
    res.status(503).json(apiError('error_diagnostics_disabled', err.message));
    return;
  }
  logger.error('error-diagnostics-storage-failed', 'Proxy error diagnostics storage operation failed', {
    ...errorFields(err),
  });
  res.status(500).json(apiError('error_diagnostics_storage_failed', err instanceof Error ? err.message : String(err)));
}

function isDiagnosticId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
