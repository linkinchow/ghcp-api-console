import type { NextFunction, Request, Response } from 'express';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Rejects cross-site writes (same rule as SSO's `requireSameOrigin`): a present `Origin` must name this
 * Console's host or the configured public base URL host, `Origin: null` is rejected, and so is
 * `Sec-Fetch-Site: cross-site`. A missing `Origin` is allowed for non-browser clients.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (isSameOriginWrite(req)) {
    next();
    return;
  }
  rejectCrossSite(res);
}

export function rejectCrossSite(res: Response): void {
  res.status(403).json(apiError('cross_site_request_rejected', 'Console writes must come from this Console.'));
}

export function isSameOriginWrite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  if (req.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.get('origin');
  return origin === undefined || isSameHostOrigin(origin, req.get('host'));
}

function isSameHostOrigin(origin: string, hostHeader: string | undefined): boolean {
  const originUrl = parseUrl(origin);
  if (!originUrl) return false;
  const requestHost = hostHeader ? parseUrl(`${originUrl.protocol}//${hostHeader}`)?.host : undefined;
  return originUrl.host === requestHost || originUrl.host === publicHost();
}

function publicHost(): string | undefined {
  return config.publicBaseUrl ? parseUrl(config.publicBaseUrl)?.host : undefined;
}

/** `undefined` for `null` and other values that are not absolute URLs. */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
