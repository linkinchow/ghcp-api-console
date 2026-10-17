export const DEFAULT_EXTERNAL_TIMEOUT_MS = 15_000;

export interface ExternalFetchInit extends Omit<RequestInit, 'redirect'> {
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
}

export type NotSentReason = 'invalid_url' | 'aborted' | 'connect_failed';
export type OutcomeUnknownReason = 'timeout' | 'aborted' | 'network';

export class ExternalRequestFailedError extends Error {
  readonly code = 'external_request_failed';

  constructor(readonly reason: NotSentReason, options?: ErrorOptions) {
    super(`external request was not sent: ${reason}`, options);
    this.name = 'ExternalRequestFailedError';
  }
}

export class OutcomeUnknownError extends Error {
  readonly code = 'external_outcome_unknown';

  constructor(readonly reason: OutcomeUnknownReason, options?: ErrorOptions) {
    super(`external request outcome is unknown: ${reason}`, options);
    this.name = 'OutcomeUnknownError';
  }
}

const CONNECT_FAILURE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * `fetch` for calls that leave the deployment (GitHub, GHE, service-to-service writes).
 *
 * Redirects are always refused and every call carries a timeout, which also bounds reading the body.
 * Failures are split by whether the server may have acted on the request:
 * - `ExternalRequestFailedError`: provably never sent (bad URL, signal aborted before the call,
 *   or the connection itself failed: DNS lookup, refused, unreachable, connect timeout).
 *   Safe to retry.
 * - `OutcomeUnknownError`: anything else, including timeouts, aborts in flight, resets and refused
 *   redirects. The server may have applied the request; reconcile before retrying non-idempotent
 *   calls.
 */
export async function externalFetch(url: string | URL, init: ExternalFetchInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_EXTERNAL_TIMEOUT_MS, fetcher = fetch, signal: callerSignal, ...request } = init;
  const target = parseTarget(url);
  if (callerSignal?.aborted) throw new ExternalRequestFailedError('aborted', { cause: callerSignal.reason });
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    return await fetcher(target, { ...request, redirect: 'error', signal });
  } catch (error) {
    throw classifyFailure(error, timeout, callerSignal ?? undefined);
  }
}

function parseTarget(url: string | URL): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new ExternalRequestFailedError('invalid_url', { cause: error });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ExternalRequestFailedError('invalid_url');
  }
  return parsed.href;
}

function classifyFailure(error: unknown, timeout: AbortSignal, callerSignal?: AbortSignal): Error {
  if (callerSignal?.aborted) return new OutcomeUnknownError('aborted', { cause: error });
  if (timeout.aborted) return new OutcomeUnknownError('timeout', { cause: error });
  if (hasConnectFailureCode(error)) return new ExternalRequestFailedError('connect_failed', { cause: error });
  return new OutcomeUnknownError('network', { cause: error });
}

/** Node's fetch reports socket errors as `TypeError('fetch failed')` with the errno on `cause`. */
function hasConnectFailureCode(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string' && CONNECT_FAILURE_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}
