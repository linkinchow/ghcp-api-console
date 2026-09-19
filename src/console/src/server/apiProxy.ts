import type { Request, Response } from 'express';
import { apiError, errorFields, INTERNAL_AUTH_HEADER, loggerFor } from '@ghcp/shared';
import { config } from './config.js';

const logger = loggerFor('console', 'api-proxy');

export function serviceProxy(target: 'proxy' | 'sso' | 'login', mountPath: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const baseUrl = targetBaseUrl(target);
    const suffix = req.originalUrl.slice(mountPath.length) || '/';
    // Only new management/scoped browser writes use this guard. Existing admin
    // authentication and legacy API compatibility remain unchanged.
    if (isManagementWrite(req.method, suffix) && !isSameOrigin(req)) {
      res.status(403).json(apiError('console_same_origin_required', 'Management writes must originate from this Console.'));
      return;
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/api${suffix}`;
    const startedAt = Date.now();
    logger.info('proxy-request', 'Forwarding console API request', {
      target,
      method: req.method,
      suffix,
    });
    try {
      const upstream = await fetch(url, {
        method: req.method,
        redirect: 'error',
        headers: {
          Accept: req.get('accept') ?? 'application/json',
          'Content-Type': 'application/json',
          [INTERNAL_AUTH_HEADER]: config.internalApiToken,
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      const contentDisposition = upstream.headers.get('content-disposition');
      if (contentType) res.setHeader('Content-Type', contentType);
      if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition);
      for (const name of ['Cache-Control', 'Retry-After']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.send(body);
      logger.info('proxy-response', 'Console API request completed', {
        target,
        method: req.method,
        suffix,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.error('proxy-failed', 'Console API request failed', {
        target,
        method: req.method,
        suffix,
        durationMs: Date.now() - startedAt,
        ...errorFields(err),
      });
      res.status(502).json(apiError('service_proxy_failed', err instanceof Error ? err.message : String(err)));
    }
  };
}

function isManagementWrite(method: string, suffix: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  let path: string;
  try { path = decodeURIComponent(suffix.split('?')[0]!).replace(/\/{2,}/g, '/').toLowerCase(); }
  catch { return true; }
  return path === '/management' || path.startsWith('/management/') || path === '/profiles' || path.startsWith('/profiles/');
}

function isSameOrigin(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const expected = `${req.protocol}://${req.get('host') ?? ''}`;
  const origin = req.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== origin) return false;
      // A TLS-terminating reverse proxy must preserve the browser Host. Fetch
      // Metadata supplies same-origin proof without trusting arbitrary forwarded
      // host/proto headers or enabling a global Express trust-proxy setting.
      return parsed.origin === expected || (site === 'same-origin' && parsed.host === req.get('host'));
    } catch { return false; }
  }
  // Fetch Metadata is emitted by modern same-origin browsers; missing both is
  // not accepted as proof, so forged non-browser writes cannot bypass the guard.
  return site === 'same-origin';
}

function targetBaseUrl(target: 'proxy' | 'sso' | 'login'): string {
  if (target === 'proxy') return config.proxyBaseUrl;
  if (target === 'sso') return config.ssoBaseUrl;
  return config.loginBaseUrl;
}
