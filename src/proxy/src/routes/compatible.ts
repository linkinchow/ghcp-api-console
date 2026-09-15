import { TextDecoder } from 'node:util';
import { once } from 'node:events';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { apiError } from '@ghcp/shared';
import { recordRequestStat as persistRequestStat } from '../db/requestStatsRepo.js';
import { Logger } from '../logger.js';
import {
  DiagnosticBodyCapture,
  createErrorDiagnosticContext,
  recordFetchFailure,
  recordHttpFailure,
  recordStreamFailure,
  type CapturedResponseBody,
  type ErrorDiagnosticContext,
} from '../diagnostics/errorDiagnostics.js';
import { copilotAuthManager, CopilotAuthNotReadyError } from '../copilot/copilotAuthManager.js';
import {
  executePreparedCopilotRequest,
  listModels,
  modelSupportsPath,
  prepareCopilotRequest,
  resolveCopilotModel,
  CopilotApiError,
  CopilotModelPathError,
  type CopilotApiPath,
  type ForwardCopilotRequestOptions,
  type ModelInfo,
  type PreparedCopilotRequest,
} from '../copilot/copilotClient.js';
import {
  estimateInputTokens,
  isTokenCountFallbackStatus,
  prepareClaudeCodeMessagesRequest,
  shouldTranslateWebSearchError,
  webSearchUnsupportedMessage,
} from './claudeCodeCompat.js';
import { resolveClaudeCodeOptimized } from './claudeCodeMode.js';
import { resolveRequestIntent } from './requestIntent.js';
import { toCanonicalRequestedModelId, withCanonicalModelIds } from '../copilot/modelIds.js';
import { poolRequest, statIdentity, withPoolOperation, type PoolRequest } from '../userPool/runtime.js';
import { UserPoolError } from '../userPool/config.js';
import { isMysqlStorageUnavailable } from '../userPool/mysqlDeadline.js';
import { isSuccessfulJson, StreamCompletion } from '../userPool/responseCompletion.js';
import { getAccount } from '../db/accountsRepo.js';
import { config } from '../config.js';
import type { CopilotAuthContext } from '../copilot/copilotAuth.js';

export const compatibleRouter = Router();
const requestStatsLogger = new Logger('request-stats');

interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

compatibleRouter.get('/v1/models', async (req, res) => withPoolOperation(res, () => handleModels(req, res)));

async function handleModels(req: Request, res: Response): Promise<void> {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  let accessToken: string | undefined;
  try {
    const context = poolRequest(res);
    const copilot = await requestAuth(identity, context);
    accessToken = copilot.accessToken;
    const useCache = req.get('x-cache')?.trim().toLowerCase() !== 'false';
    const diagnostics = createErrorDiagnosticContext(req, identity, '/v1/models');
    const models = await listModels(copilot, { useCache, diagnostics, signal: context?.controller.signal });
    context?.controller.signal.throwIfAborted();
    const visibleModels = withCanonicalModelIds(
      claudeCodeOptimized ? models.filter((m) => modelSupportsPath(m, '/v1/messages')) : models,
    );
    await recordRequestStat({ ...statIdentity(res, identity), path: '/v1/models', success: true });
    if (claudeCodeOptimized) {
      const data = visibleModels.map(toClaudeCodeModel);
      res.json({
        data,
        has_more: false,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
      });
      return;
    }
    res.json({ object: 'list', data: visibleModels.map((m) => ({ object: 'model', owned_by: 'github-copilot', ...m })) });
  } catch (err) {
    try {
      await handlePoolFailure(poolRequest(res), accessToken, err);
      if (!poolRequest(res)) await invalidateUnauthorizedAuth(identity, accessToken, err);
    } catch (storageError) {
      // Recovery is itself a storage operation; keep its outage inside the JSON
      // error path without hiding unrelated recovery/application failures.
      if (!isMysqlStorageUnavailable(storageError)) throw storageError;
      err = storageError;
    }
    await recordRequestStat({ ...statIdentity(res, identity), path: '/v1/models', success: false, failureReason: errorMessage(err) });
    if (!res.headersSent && !res.destroyed) sendCompatibleError(req, res, err);
  }
}

compatibleRouter.post('/chat/completions', async (req, res) => {
  await withPoolOperation(res, () => handleForward(req, res, '/chat/completions'));
});

compatibleRouter.post('/responses', async (req, res) => {
  await withPoolOperation(res, () => handleForward(req, res, '/responses'));
});

compatibleRouter.post('/v1/messages/count_tokens', async (req, res) => {
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  if (!claudeCodeOptimized) {
    sendUnsupportedCompatiblePath(req, res, claudeCodeOptimized);
    return;
  }
  await withPoolOperation(res, () => handleCountTokens(req, res, claudeCodeOptimized));
});

compatibleRouter.post('/v1/messages', async (req, res) => {
  await withPoolOperation(res, () => handleForward(req, res, '/v1/messages'));
});

compatibleRouter.use('/v1/files', handleFilesApiUnsupported);

function handleFilesApiUnsupported(req: Request, res: Response, next: NextFunction): void {
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  if (!claudeCodeOptimized) {
    next();
    return;
  }
  sendAnthropicError(
    res,
    404,
    'not_supported',
    'The Anthropic Files API is not supported by the GitHub Copilot backend. Disable Claude Code features that require /v1/files or use a separate Anthropic-compatible file service.',
  );
}

async function handleForward(req: Request, res: Response, path: CopilotApiPath): Promise<void> {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const claudeCodeOptimized = requireClaudeCodeOptimized(req, res);
  if (claudeCodeOptimized === undefined) return;
  const body = readJsonObject(req.body);
  if (!body) {
    sendOpenAiLikeError(req, res, 400, 'Request body must be a JSON object.', 'invalid_request_error');
    return;
  }
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const canonicalRequestedModel = requestedModel ? toCanonicalRequestedModelId(requestedModel) : undefined;
  try {
    if (!requestedModel) throw new CopilotModelPathError('Request body must include a string "model".');
    const prepared = prepareForward(req, path, body, claudeCodeOptimized);
    if (prepared.preflightError) {
      await recordRequestStat({ ...statIdentity(res, identity), path, model: canonicalRequestedModel, success: false, failureReason: prepared.preflightError.message });
      sendAnthropicError(res, prepared.preflightError.status, prepared.preflightError.type, prepared.preflightError.message);
      return;
    }
    const preparedModel = typeof prepared.body.model === 'string' ? prepared.body.model : requestedModel;
    const diagnostics = createErrorDiagnosticContext(req, identity, path, canonicalRequestedModel);
    const upstream = await forwardAuthenticated(identity, path, prepared.body, preparedModel, diagnostics, prepared.forwardOptions, poolRequest(res));
    await pipeAndRecord(upstream.response, upstream.request, res, { ...statIdentity(res, identity), path, model: upstream.canonicalModel }, diagnostics, {
      ...prepared.pipeOptions,
      canonicalModel: upstream.canonicalModel,
    });
  } catch (err) {
    if (!(err instanceof HandledUpstreamStreamError)) {
      await recordRequestStat({ ...statIdentity(res, identity), path, model: canonicalRequestedModel, success: false, failureReason: errorMessage(err) });
    }
    const responseError = err instanceof HandledUpstreamStreamError ? err.cause : err;
    if (!res.headersSent && !res.destroyed) sendCompatibleError(req, res, responseError);
    else if (!res.writableEnded) res.end();
  }
}

async function handleCountTokens(req: Request, res: Response, claudeCodeOptimized: boolean): Promise<void> {
  const identity = requireIdentity(req, res);
  if (!identity) return;
  const path: CopilotApiPath = '/v1/messages/count_tokens';
  const body = readJsonObject(req.body);
  if (!body) {
    sendOpenAiLikeError(req, res, 400, 'Request body must be a JSON object.', 'invalid_request_error');
    return;
  }
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const canonicalRequestedModel = requestedModel ? toCanonicalRequestedModelId(requestedModel) : undefined;
  try {
    if (!requestedModel) throw new CopilotModelPathError('Request body must include a string "model".');
    const prepared = prepareForward(req, path, body, claudeCodeOptimized);
    if (prepared.preflightError) {
      await recordRequestStat({ ...statIdentity(res, identity), path, model: canonicalRequestedModel, success: false, failureReason: prepared.preflightError.message });
      sendAnthropicError(res, prepared.preflightError.status, prepared.preflightError.type, prepared.preflightError.message);
      return;
    }
    const preparedModel = typeof prepared.body.model === 'string' ? prepared.body.model : requestedModel;
    const diagnostics = createErrorDiagnosticContext(req, identity, path, canonicalRequestedModel);
    const upstream = await forwardAuthenticated(identity, path, prepared.body, preparedModel, diagnostics, prepared.forwardOptions, poolRequest(res));
    if (isTokenCountFallbackStatus(upstream.response.status)) {
      await recordTokenCountFallbackFailure(upstream.response, upstream.request, diagnostics);
      const inputTokens = estimateInputTokens(upstream.body);
      await recordRequestStat({ ...statIdentity(res, identity), path, model: upstream.canonicalModel, success: true, inputTokens });
      res.json({ input_tokens: inputTokens });
      return;
    }
    await pipeAndRecord(upstream.response, upstream.request, res, { ...statIdentity(res, identity), path, model: upstream.canonicalModel }, diagnostics, {
      ...prepared.pipeOptions,
      canonicalModel: upstream.canonicalModel,
    });
  } catch (err) {
    if (!(err instanceof HandledUpstreamStreamError)) {
      await recordRequestStat({ ...statIdentity(res, identity), path, model: canonicalRequestedModel, success: false, failureReason: errorMessage(err) });
    }
    const responseError = err instanceof HandledUpstreamStreamError ? err.cause : err;
    if (!res.headersSent && !res.destroyed) sendCompatibleError(req, res, responseError);
    else if (!res.writableEnded) res.end();
  }
}

export async function recordTokenCountFallbackFailure(
  upstream: globalThis.Response,
  upstreamRequest: PreparedCopilotRequest,
  diagnostics: ErrorDiagnosticContext,
): Promise<void> {
  if (!upstream.body) {
    await recordHttpFailure(diagnostics, upstreamRequest, upstream);
    return;
  }
  try {
    const body = await readBufferedBody(upstream.body);
    await recordHttpFailure(diagnostics, upstreamRequest, upstream, body.capture);
  } catch (err) {
    if (!(err instanceof ResponseStreamReadError)) throw err;
    await recordStreamFailure(diagnostics, upstreamRequest, upstream, err.capture, err.cause);
  }
}

function prepareForward(
  req: Request,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  claudeCodeOptimized: boolean,
): {
  body: Record<string, unknown>;
  forwardOptions?: ForwardCopilotRequestOptions;
  pipeOptions?: PipeOptions;
  preflightError?: { status: number; type: string; message: string };
} {
  if (!claudeCodeOptimized || !path.startsWith('/v1/messages')) {
    return {
      body,
      forwardOptions: {
        initiator: resolveRequestIntent(path, body, req.get('x-initiator')).initiator,
      },
    };
  }
  const prepared = prepareClaudeCodeMessagesRequest(req, body, { tokenCounting: path === '/v1/messages/count_tokens' });
  return {
    body: prepared.body,
    forwardOptions: prepared.forwardOptions,
    pipeOptions: { claudeCodeOptimized: true, requestBody: prepared.body },
    preflightError: prepared.preflightError,
  };
}

async function forwardAuthenticated(
  identity: string,
  path: CopilotApiPath,
  body: Record<string, unknown>,
  requestedModel: string,
  diagnostics: ErrorDiagnosticContext,
  options?: ForwardCopilotRequestOptions,
  context?: PoolRequest,
): Promise<{ response: globalThis.Response; request: PreparedCopilotRequest; body: Record<string, unknown>; canonicalModel: string }> {
  const copilot = await requestAuth(identity, context);
  let resolved;
  try {
    resolved = await resolveCopilotModel(copilot, path, requestedModel, diagnostics, context?.controller.signal);
    context?.controller.signal.throwIfAborted();
    if (context && !await context.store.heartbeat(context.held)) throw new UserPoolError(503, 'member_unavailable');
  } catch (err) {
    await handlePoolFailure(context, copilot.accessToken, err);
    if (!context) await invalidateUnauthorizedAuth(identity, copilot.accessToken, err);
    throw err;
  }
  diagnostics.model = resolved.canonicalId;
  const upstreamBody = { ...body, model: resolved.upstreamId };
  const request = prepareCopilotRequest(copilot, path, upstreamBody, options);
  let response: globalThis.Response;
  try {
    response = await executePreparedCopilotRequest(request, context?.controller.signal);
  } catch (err) {
    await recordFetchFailure(diagnostics, request, err);
    throw err;
  }
  if (response.status === 401) {
    if (context) await context.store.recoverUnauthorized(context.held, copilot.accessToken);
    else await copilotAuthManager.invalidate(identity, copilot.accessToken);
  } else if (response.status === 429 && context) {
    await context.store.cool(identity, retryAfterSeconds(response.headers.get('retry-after'), context.options.retryAfterSeconds), context.held);
  }
  return { response, request, body: upstreamBody, canonicalModel: resolved.canonicalId };
}

async function requestAuth(identity: string, context?: PoolRequest): Promise<CopilotAuthContext> {
  if (!context) return copilotAuthManager.getAuth(identity);
  context.controller.signal.throwIfAborted();
  if (!await context.store.heartbeat(context.held)) throw new UserPoolError(503, 'member_unavailable');
  const account = await getAccount(identity);
  context.controller.signal.throwIfAborted();
  if (!account?.copilotOauthToken || account.copilotOauthStatus !== 'valid' || !await context.store.heartbeat(context.held)) {
    throw new UserPoolError(503, 'member_unavailable');
  }
  return { identity, accessToken: account.copilotOauthToken, api: config.copilotApiBaseUrl };
}

async function handlePoolFailure(context: PoolRequest | undefined, token: string | undefined, error: unknown): Promise<void> {
  if (!context || !(error instanceof CopilotApiError)) return;
  if (error.status === 401 && token) {
    await context.store.recoverUnauthorized(context.held, token);
  } else if (error.status === 429) {
    await context.store.cool(context.held.member_identity, retryAfterSeconds(error.retryAfter ?? null, context.options.retryAfterSeconds), context.held);
  }
}

function retryAfterSeconds(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback;
}

export async function pipeAndRecord(
  upstream: globalThis.Response,
  upstreamRequest: PreparedCopilotRequest,
  res: Response,
  stat: { identity: string; path: CopilotApiPath; model?: string },
  diagnostics: ErrorDiagnosticContext,
  options: PipeOptions = {},
): Promise<void> {
  const context = poolRequest(res);
  context?.controller.signal.throwIfAborted();
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type') ?? 'application/json';
  res.setHeader('content-type', contentType);
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter) res.setHeader('Retry-After', retryAfter);
  if (!upstream.body) {
    if (!upstream.ok) await recordHttpFailure(diagnostics, upstreamRequest, upstream);
    res.end();
    await recordRequestStat({ ...stat, success: upstream.ok && !context, failureReason: upstream.ok ? (context ? 'empty_upstream_body' : undefined) : `HTTP ${upstream.status}` });
    return;
  }
  const shouldBuffer = contentType.includes('application/json')
    || (!upstream.ok && (contentType.includes('text/event-stream') || options.claudeCodeOptimized));
  if (shouldBuffer) {
    let body: BufferedResponseBody;
    try {
      body = await readBufferedBody(upstream.body);
    } catch (err) {
      if (!(err instanceof ResponseStreamReadError)) throw err;
      await handleStreamReadFailure(upstream, upstreamRequest, res, stat, diagnostics, err);
      throw new HandledUpstreamStreamError(err.cause);
    }
    if (!upstream.ok) await recordHttpFailure(diagnostics, upstreamRequest, upstream, body.capture);
    const text = body.buffer.toString('utf8');
    if (options.claudeCodeOptimized && shouldTranslateWebSearchError(upstream.status, text, options.requestBody)) {
      sendAnthropicError(res, 400, 'not_supported', webSearchUnsupportedMessage(options.requestBody));
      await recordRequestStat({ ...stat, success: false, failureReason: `HTTP ${upstream.status}` });
      return;
    }
    context?.controller.signal.throwIfAborted();
    const success = upstream.ok && (!context || isSuccessfulJson(text));
    if (context) {
      res.locals.poolSuccess = success;
      context.upstreamComplete = true;
    }
    res.send(canonicalizeJsonResponse(body.buffer, options.canonicalModel));
    const usage = parseUsage(text);
    await recordRequestStat({
      ...stat,
      success,
      failureReason: success ? undefined : upstream.ok ? 'invalid_upstream_body' : `HTTP ${upstream.status}`,
      ...usageStatFields(usage),
    });
    return;
  }
  const reader = upstream.body.getReader();
  const completion = context ? new StreamCompletion(stat.path) : undefined;
  const usage: UsageStats = {};
  const capture = new DiagnosticBodyCapture();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  const filterCopilotDone = options.claudeCodeOptimized && contentType.includes('text/event-stream');
  for (;;) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await reader.read();
    } catch (err) {
      const streamError = new ResponseStreamReadError(err, capture.result(false));
      await handleStreamReadFailure(upstream, upstreamRequest, res, stat, diagnostics, streamError);
      throw new HandledUpstreamStreamError(err);
    }
    if (result.done || !result.value) break;
    context?.controller.signal.throwIfAborted();
    completion?.add(result.value);
    capture.add(result.value);
    if (filterCopilotDone) {
      sseBuffer = forwardSseEvents(sseBuffer + decoder.decode(result.value, { stream: true }), res, usage, options.canonicalModel);
    } else {
      sseBuffer = forwardSseEvents(sseBuffer + decoder.decode(result.value, { stream: true }), res, usage, options.canonicalModel, false);
    }
    if (context && sseBuffer.length > 4 * 1024 * 1024) {
      context.controller.abort(new Error('Upstream SSE event exceeds size limit'));
      throw new Error('Upstream SSE event exceeds size limit');
    }
    if (context && res.writableNeedDrain) await once(res, 'drain', { signal: context.controller.signal });
  }
  const remaining = decoder.decode();
  if (filterCopilotDone) {
    if (remaining) sseBuffer = forwardSseEvents(sseBuffer + remaining, res, usage, options.canonicalModel);
    flushSseRemainder(sseBuffer, res, usage, options.canonicalModel, true);
  } else {
    if (remaining) sseBuffer = forwardSseEvents(sseBuffer + remaining, res, usage, options.canonicalModel, false);
    flushSseRemainder(sseBuffer, res, usage, options.canonicalModel, false);
  }
  const capturedBody = capture.result(true);
  if (!upstream.ok) await recordHttpFailure(diagnostics, upstreamRequest, upstream, capturedBody);
  context?.controller.signal.throwIfAborted();
  const success = upstream.ok && (!completion || completion.finish());
  if (context) {
    res.locals.poolSuccess = success;
    context.upstreamComplete = true;
  }
  res.end();
  await recordRequestStat({
    ...stat,
    success,
    failureReason: success ? undefined : upstream.ok ? 'incomplete_or_failed_stream' : `HTTP ${upstream.status}`,
    ...usageStatFields(usage),
  });
}

interface PipeOptions {
  claudeCodeOptimized?: boolean;
  requestBody?: Record<string, unknown>;
  canonicalModel?: string;
}

interface BufferedResponseBody {
  buffer: Buffer;
  capture: CapturedResponseBody;
}

class ResponseStreamReadError extends Error {
  constructor(
    readonly cause: unknown,
    readonly capture: CapturedResponseBody,
  ) {
    super(errorMessage(cause));
    this.name = 'ResponseStreamReadError';
  }
}

class HandledUpstreamStreamError extends Error {
  constructor(readonly cause: unknown) {
    super(errorMessage(cause));
    this.name = 'HandledUpstreamStreamError';
  }
}

async function readBufferedBody(body: ReadableStream<Uint8Array>): Promise<BufferedResponseBody> {
  const reader = body.getReader();
  const capture = new DiagnosticBodyCapture();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (;;) {
    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await reader.read();
    } catch (err) {
      throw new ResponseStreamReadError(err, capture.result(false));
    }
    if (result.done || !result.value) break;
    const chunk = Buffer.from(result.value);
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    capture.add(result.value);
  }
  return {
    buffer: Buffer.concat(chunks, totalBytes),
    capture: capture.result(true),
  };
}

async function handleStreamReadFailure(
  upstream: globalThis.Response,
  upstreamRequest: PreparedCopilotRequest,
  res: Response,
  stat: { identity: string; path: CopilotApiPath; model?: string },
  diagnostics: ErrorDiagnosticContext,
  err: ResponseStreamReadError,
): Promise<void> {
  const diagnosticId = await recordStreamFailure(diagnostics, upstreamRequest, upstream, err.capture, err.cause);
  await recordRequestStat({
    ...stat,
    success: false,
    failureReason: `Upstream stream failed (${diagnosticId}): ${errorMessage(err.cause)}`,
  });
  if (res.headersSent) res.end();
}

function usageStatFields(usage: UsageStats): UsageStats {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheTokens: cacheTokenTotal(usage),
    cacheInputTokens: usage.cacheInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  };
}

function parseUsage(text: string): UsageStats {
  try {
    const usage: UsageStats = {};
    collectUsageFromValue(JSON.parse(text) as unknown, usage);
    return usage;
  } catch {
    return {};
  }
}

function collectSseUsage(buffer: string, usage: UsageStats): string {
  let remaining = buffer;
  for (;;) {
    const boundary = nextSseEventBoundary(remaining);
    if (!boundary) return remaining;
    collectSseEventUsage(remaining.slice(0, boundary.eventEnd), usage);
    remaining = remaining.slice(boundary.nextEventStart);
  }
}

function forwardSseEvents(
  buffer: string,
  res: Response,
  usage: UsageStats,
  canonicalModel?: string,
  filterDone = true,
): string {
  let remaining = buffer;
  for (;;) {
    const boundary = nextSseEventBoundary(remaining);
    if (!boundary) return remaining;
    const eventText = remaining.slice(0, boundary.eventEnd);
    collectSseEventUsage(eventText, usage);
    if (!filterDone || !isCopilotDoneEvent(eventText)) {
      const delimiter = remaining.slice(boundary.eventEnd, boundary.nextEventStart);
      res.write(`${canonicalizeSseEvent(eventText, canonicalModel)}${delimiter}`);
    }
    remaining = remaining.slice(boundary.nextEventStart);
  }
}

function flushSseRemainder(
  buffer: string,
  res: Response,
  usage: UsageStats,
  canonicalModel?: string,
  filterDone = true,
): void {
  if (!buffer) return;
  collectSseEventUsage(buffer, usage);
  if (!filterDone || !isCopilotDoneEvent(buffer)) res.write(canonicalizeSseEvent(buffer, canonicalModel));
}

function canonicalizeJsonResponse(buffer: Buffer, canonicalModel?: string): Buffer {
  if (!canonicalModel) return buffer;
  try {
    const value = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!setResponseModel(value, canonicalModel)) return buffer;
    return Buffer.from(JSON.stringify(value));
  } catch {
    return buffer;
  }
}

function canonicalizeSseEvent(eventText: string, canonicalModel?: string): string {
  if (!canonicalModel) return eventText;
  const data = sseData(eventText);
  if (!data || data === '[DONE]') return eventText;
  try {
    const value = JSON.parse(data) as unknown;
    if (!setResponseModel(value, canonicalModel)) return eventText;
    const serialized = JSON.stringify(value);
    let replaced = false;
    return eventText.split(/\r?\n/).map((line) => {
      if (replaced || !line.startsWith('data:')) return line;
      replaced = true;
      return `data: ${serialized}`;
    }).filter((line) => !replaced || !line.startsWith('data:') || line === `data: ${serialized}`).join('\n');
  } catch {
    return eventText;
  }
}

function setResponseModel(value: unknown, canonicalModel: string): boolean {
  const object = recordField(value);
  if (!object) return false;
  if (typeof object.model === 'string' && object.model !== canonicalModel) {
    object.model = canonicalModel;
    return true;
  }
  const message = recordField(object.message);
  if (typeof message?.model === 'string' && message.model !== canonicalModel) {
    message.model = canonicalModel;
    return true;
  }
  const response = recordField(object.response);
  if (typeof response?.model === 'string' && response.model !== canonicalModel) {
    response.model = canonicalModel;
    return true;
  }
  return false;
}

function nextSseEventBoundary(buffer: string): { eventEnd: number; nextEventStart: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return undefined;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { eventEnd: crlf, nextEventStart: crlf + 4 };
  return { eventEnd: lf, nextEventStart: lf + 2 };
}

function collectSseEventUsage(eventText: string, usage: UsageStats): void {
  const data = sseData(eventText);
  if (!data || data === '[DONE]') return;
  try {
    collectUsageFromValue(JSON.parse(data) as unknown, usage);
  } catch {
    return;
  }
}

function sseData(eventText: string): string | undefined {
  const dataLines: string[] = [];
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5);
    dataLines.push(data.startsWith(' ') ? data.slice(1) : data);
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined;
}

function sseEventName(eventText: string): string | undefined {
  for (const line of eventText.split(/\r?\n/)) {
    if (!line.startsWith('event:')) continue;
    const eventName = line.slice(6).trim();
    return eventName || undefined;
  }
  return undefined;
}

function isCopilotDoneEvent(eventText: string): boolean {
  const data = sseData(eventText)?.trim();
  if (data !== '[DONE]') return false;
  const eventName = sseEventName(eventText);
  return eventName === undefined || eventName === 'message';
}

function collectUsageFromValue(value: unknown, usage: UsageStats): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUsageFromValue(item, usage);
    return;
  }

  const object = recordField(value);
  if (!object) return;

  const usageObject = recordField(object.usage);
  if (usageObject) mergeUsage(usage, usageFromObject(usageObject));

  const copilotUsage = recordField(object.copilot_usage);
  if (copilotUsage) mergeUsage(usage, usageFromCopilotObject(copilotUsage));

  for (const childValue of Object.values(object)) collectUsageFromValue(childValue, usage);
}

function usageFromObject(usage: Record<string, unknown>): UsageStats {
  const promptDetails = recordField(usage.prompt_tokens_details);
  const inputDetails = recordField(usage.input_tokens_details);
  const cacheInputTokens =
    numberField(usage.cache_read_input_tokens) ??
    numberField(usage.input_cached_tokens) ??
    numberField(promptDetails?.cached_tokens) ??
    numberField(inputDetails?.cached_tokens);
  const cacheWriteTokens =
    numberField(usage.cache_creation_input_tokens) ?? cacheCreationInputTokens(recordField(usage.cache_creation));
  return {
    inputTokens: numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens),
    outputTokens: numberField(usage.completion_tokens) ?? numberField(usage.output_tokens),
    cacheTokens: numberField(usage.cache_tokens) ?? sumDefined(cacheInputTokens, cacheWriteTokens),
    cacheInputTokens,
    cacheWriteTokens,
  };
}

function usageFromCopilotObject(copilotUsage: Record<string, unknown>): UsageStats {
  const details = Array.isArray(copilotUsage.token_details) ? copilotUsage.token_details : [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheTokens: number | undefined;
  let cacheInputTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

  for (const detail of details) {
    const detailObject = recordField(detail);
    const tokenType = typeof detailObject?.token_type === 'string' ? detailObject.token_type : undefined;
    const tokenCount = numberField(detailObject?.token_count);
    if (!tokenType || tokenCount === undefined) continue;

    if (tokenType === 'input') inputTokens = addDefined(inputTokens, tokenCount);
    else if (tokenType === 'output') outputTokens = addDefined(outputTokens, tokenCount);
    else if (tokenType === 'cache_read') cacheInputTokens = addDefined(cacheInputTokens, tokenCount);
    else if (tokenType === 'cache_write' || tokenType === 'cache_creation') {
      cacheWriteTokens = addDefined(cacheWriteTokens, tokenCount);
    } else if (tokenType.startsWith('cache_')) {
      cacheTokens = addDefined(cacheTokens, tokenCount);
    }
  }

  return { inputTokens, outputTokens, cacheTokens, cacheInputTokens, cacheWriteTokens };
}

function mergeUsage(target: UsageStats, source: UsageStats): void {
  if (source.inputTokens !== undefined) target.inputTokens = source.inputTokens;
  if (source.outputTokens !== undefined) target.outputTokens = source.outputTokens;
  if (source.cacheTokens !== undefined) target.cacheTokens = source.cacheTokens;
  if (source.cacheInputTokens !== undefined) target.cacheInputTokens = source.cacheInputTokens;
  if (source.cacheWriteTokens !== undefined) target.cacheWriteTokens = source.cacheWriteTokens;
}

function addDefined(current: number | undefined, value: number): number {
  return (current ?? 0) + value;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value !== undefined) total = addDefined(total, value);
  }
  return total;
}

function cacheCreationInputTokens(cacheCreation: Record<string, unknown> | undefined): number | undefined {
  if (!cacheCreation) return undefined;
  return sumDefined(
    numberField(cacheCreation.ephemeral_5m_input_tokens),
    numberField(cacheCreation.ephemeral_1h_input_tokens),
  );
}

function cacheTokenTotal(usage: UsageStats): number | undefined {
  return usage.cacheTokens ?? sumDefined(usage.cacheInputTokens, usage.cacheWriteTokens);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readJsonObject(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

function requireIdentity(req: Request, res: Response): string | undefined {
  if (req.identity) return req.identity;
  res.status(400).json(apiError('missing_identity', 'Request identity has not been resolved.'));
  return undefined;
}

function requireClaudeCodeOptimized(req: Request, res: Response): boolean | undefined {
  const resolved = resolveClaudeCodeOptimized(req);
  if (resolved.ok) return resolved.enabled;
  sendOpenAiLikeError(req, res, 400, resolved.message, 'invalid_request_error');
  return undefined;
}

function sendCompatibleError(req: Request, res: Response, err: unknown): void {
  if (isMysqlStorageUnavailable(err)) err = new UserPoolError(503, 'pool_storage_unavailable', 1);
  if (err instanceof UserPoolError) {
    if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
    res.status(err.status).json({ type: 'error', error: {
      type: err.status === 429 ? 'rate_limit_error' : 'api_error', code: err.code, message: err.message,
    } });
    return;
  }
  if (err instanceof CopilotAuthNotReadyError) {
    res.status(err.status).json(apiError(err.code, err.message, err.details));
    return;
  }
  const status = proxyErrorStatus(err);
  if (err instanceof CopilotApiError && err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
  sendOpenAiLikeError(req, res, status, errorMessage(err), proxyErrorType(err));
}

function sendOpenAiLikeError(req: Request, res: Response, status: number, message: string, type = 'api_error'): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(status).json({ type: 'error', error: { type, message } });
    return;
  }
  res.status(status).json({ error: { message, type } });
}

function sendAnthropicError(res: Response, status: number, type: string, message: string): void {
  res.status(status).type('application/json').json({ type: 'error', error: { type, message } });
}

function sendUnsupportedCompatiblePath(req: Request, res: Response, claudeCodeOptimized: boolean): void {
  const message =
    `Unsupported Copilot API path: ${req.originalUrl}. ` +
    supportedPathsMessage(claudeCodeOptimized);
  sendOpenAiLikeError(req, res, 404, message, 'invalid_request_error');
}

function supportedPathsMessage(claudeCodeOptimized: boolean): string {
  const paths = ['GET /v1/models', 'POST /chat/completions', 'POST /v1/messages', 'POST /responses'];
  if (claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  return `Supported paths: ${paths.join(', ')}.`;
}

function toClaudeCodeModel(model: ModelInfo): Record<string, unknown> {
  const capabilities = recordField(model.capabilities);
  const limits = recordField(capabilities?.limits);
  return {
    type: 'model',
    id: model.id,
    display_name: stringField(model.name) ?? model.id,
    created_at: '1970-01-01T00:00:00Z',
    max_input_tokens: numberField(limits?.max_context_window_tokens),
    max_tokens: numberField(limits?.max_output_tokens),
  };
}

function proxyErrorStatus(err: unknown): number {
  if (err instanceof CopilotModelPathError) return err.status;
  if (err instanceof CopilotApiError && [401, 403, 429].includes(err.status)) return err.status;
  return 502;
}

function proxyErrorType(err: unknown): string {
  return err instanceof CopilotModelPathError ? 'invalid_request_error' : 'api_error';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function recordRequestStat(input: Parameters<typeof persistRequestStat>[0]): Promise<void> {
  try {
    await persistRequestStat(input);
  } catch (err) {
    requestStatsLogger.error('write-failed', 'Failed to persist Proxy request statistics', {
      identity: input.identity,
      path: input.path,
      error: errorMessage(err),
    });
  }
}

async function invalidateUnauthorizedAuth(identity: string, accessToken: string | undefined, err: unknown): Promise<void> {
  if (accessToken && err instanceof CopilotApiError && err.status === 401) {
    await copilotAuthManager.invalidate(identity, accessToken);
  }
}
