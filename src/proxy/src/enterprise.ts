import type { NextFunction, Request, Response } from 'express';
import {
  apiError, EnterpriseContractError, requireEnterprise, requireEnterpriseRevision,
  resolveEnterpriseScope, type EnterpriseProfile, type EnterpriseProfileV3, type EnterpriseRegistryV3,
} from '@ghcp/shared';
import { readEnterpriseRegistryFile } from '@ghcp/shared/enterpriseRuntimeV3';

let registry: EnterpriseRegistryV3 | undefined;

/** Offline registration takes effect after a coordinated service restart. */
export function loadProxyEnterpriseRegistry(): EnterpriseRegistryV3 {
  return registry ??= readEnterpriseRegistryFile();
}

/** Unscoped legacy entry points are permanently pinned, not the first registry entry. */
export function loadProxyEnterpriseProfile(id?: string): EnterpriseProfileV3 {
  return resolveEnterpriseScope(loadProxyEnterpriseRegistry(), id).profile;
}

export function assertProxyEnterpriseConfig(profile: EnterpriseProfile,
  service: { enterpriseShortcode: string; ssoBaseUrl: string; loginBaseUrl: string }): void {
  if (profile.shortcode !== service.enterpriseShortcode
      || profile.routes.ssoInternalUrl !== canonicalRoute(service.ssoBaseUrl)
      || profile.routes.loginInternalUrl !== canonicalRoute(service.loginBaseUrl)) {
    throw new EnterpriseContractError('enterprise_config_mismatch');
  }
}

function canonicalRoute(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new Error('Invalid enterprise service route.'); }
}

/** Each supplied source is checked; matching headers cannot mask conflicting bodies. */
export function assertEnterpriseRequest(req: Pick<Request, 'body' | 'query' | 'headers'>,
  profile: EnterpriseProfile): void {
  const binding = req.body && typeof req.body === 'object' ? req.body.binding : undefined;
  for (const source of [req.body, req.query, binding]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    if (Object.hasOwn(source, 'enterpriseId')) requireEnterprise(source.enterpriseId, profile.id);
    if (Object.hasOwn(source, 'enterpriseRevision')) {
      const value = source.enterpriseRevision;
      requireEnterpriseRevision(source === req.query && typeof value === 'string' && /^[1-9]\d*$/.test(value)
        ? Number(value) : value, profile.revision);
    }
  }
  if (req.headers['x-enterprise-id'] !== undefined) requireEnterprise(req.headers['x-enterprise-id'], profile.id);
  const revision = req.headers['x-enterprise-revision'];
  if (revision !== undefined) {
    requireEnterpriseRevision(typeof revision === 'string' && /^[1-9]\d*$/.test(revision) ? Number(revision) : revision,
      profile.revision);
  }
}

export function requestEnterpriseProfile(req: Request): EnterpriseProfileV3 {
  // This middleware may run before Express matches a nested router's parameters.
  const matched = /^\/profiles\/([^/]+)(?:\/|$)/.exec(req.path);
  const id = req.params.enterpriseId ?? (matched ? decodeURIComponent(matched[1]!) : undefined);
  if (Array.isArray(id)) throw new EnterpriseContractError("enterprise_scope_invalid");
  const profile = loadProxyEnterpriseProfile(id);
  assertEnterpriseRequest(req, profile);
  return profile;
}

export function requireEnterpriseRequest(req: Request, res: Response, next: NextFunction): void {
  try {
    requestEnterpriseProfile(req);
    next();
  } catch (error) {
    if (error instanceof EnterpriseContractError) {
      res.status(error.code === 'enterprise_not_found' ? 404 : error.code === 'enterprise_revision_mismatch' ? 409 : 400)
        .json(apiError(error.code, 'Enterprise identity or configuration revision does not match this service.'));
    } else {
      res.status(503).json(apiError('enterprise_configuration_unavailable', 'Enterprise configuration is unavailable.'));
    }
  }
}
