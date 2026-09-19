import { HttpApiError, INTERNAL_AUTH_HEADER, type ApiErrorResponse } from './api.js';

export interface JsonClientOptions {
  baseUrl: string;
  internalToken?: string;
  timeoutMs?: number;
}

export interface JsonRequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  redirect?: 'follow' | 'error' | 'manual';
}

export class JsonHttpClient {
  constructor(private readonly options: JsonClientOptions) {}

  async request<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
    const res = await fetch(this.url(path), {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: this.headers(options),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? 30_000)])
        : AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? 30_000),
      ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
    });
    if (!res.ok) {
      throw await errorFromResponse(res);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  private headers(options: JsonRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.internalToken) headers[INTERNAL_AUTH_HEADER] = this.options.internalToken;
    return headers;
  }
}

async function errorFromResponse(res: Response): Promise<HttpApiError> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as ApiErrorResponse;
    if (parsed.error?.code && parsed.error.message) {
      return new HttpApiError(res.status, parsed.error.code, parsed.error.message, parsed.error.details);
    }
  } catch {
    // Fall through to a status-shaped error when the upstream is not a JSON API.
  }
  return new HttpApiError(res.status, 'http_error', text || `HTTP ${res.status}`);
}
