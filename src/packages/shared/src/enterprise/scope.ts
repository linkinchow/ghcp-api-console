import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apiError, HttpApiError } from '../api.js';

declare const enterpriseIdBrand: unique symbol;

/** A validated deployment-internal enterprise ID (not the GitHub slug). */
export type EnterpriseId = string & { readonly [enterpriseIdBrand]: true };

/** Resolves a validated ID to its profile, or undefined when the registry does not know it. */
export type EnterpriseLookup<Profile> = (id: EnterpriseId) => Profile | undefined;

export interface ScopedEnterprise<Profile> {
  readonly id: EnterpriseId;
  readonly profile: Profile;
}

export type EnterpriseScopeErrorCode =
  | 'enterprise_scope_required'
  | 'invalid_enterprise_id'
  | 'enterprise_scope_conflict'
  | 'enterprise_not_found'
  | 'enterprise_scope_missing';

export const DEFAULT_ENTERPRISE_ID = 'default' as EnterpriseId;
export const ENTERPRISE_ID_HEADER = 'x-enterprise-id';

const ENTERPRISE_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const ENTERPRISE_ID_PARAM = 'enterpriseId';
const LOCALS_KEY = 'enterprise';

export class EnterpriseScopeError extends HttpApiError {
  constructor(status: number, readonly code: EnterpriseScopeErrorCode, message: string) {
    super(status, code, message);
    this.name = 'EnterpriseScopeError';
  }
}

export function isEnterpriseId(value: unknown): value is EnterpriseId {
  return typeof value === 'string' && ENTERPRISE_ID_PATTERN.test(value);
}

export function parseEnterpriseId(raw: unknown): EnterpriseId {
  if (raw === undefined || raw === null || raw === '') {
    throw new EnterpriseScopeError(400, 'enterprise_scope_required', 'An enterprise ID is required.');
  }
  if (!isEnterpriseId(raw)) {
    throw new EnterpriseScopeError(400, 'invalid_enterprise_id', 'The enterprise ID has an invalid format.');
  }
  return raw;
}

/**
 * Resolves `:enterpriseId` from the route path and stores it on `res.locals` for `enterpriseOf`.
 * An enterprise ID repeated in the header, query or body must equal the path value.
 */
export function requireEnterprise<Profile>(lookup: EnterpriseLookup<Profile>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals[LOCALS_KEY] = resolveScope(req, lookup);
    } catch (error) {
      if (!(error instanceof EnterpriseScopeError)) throw error;
      res.status(error.status).json(apiError(error.code, error.message));
      return;
    }
    next();
  };
}

/** The enterprise resolved by `requireEnterprise`; a route mounted without it is a server bug. */
export function enterpriseOf<Profile>(res: Response): ScopedEnterprise<Profile> {
  const scoped = res.locals[LOCALS_KEY] as ScopedEnterprise<Profile> | undefined;
  if (!scoped) {
    const message = 'The route is not mounted behind requireEnterprise.';
    throw new EnterpriseScopeError(500, 'enterprise_scope_missing', message);
  }
  return scoped;
}

function resolveScope<Profile>(req: Request, lookup: EnterpriseLookup<Profile>): ScopedEnterprise<Profile> {
  const id = parseEnterpriseId(req.params[ENTERPRISE_ID_PARAM]);
  assertNoConflict(id, repeatedIds(req));
  const profile = lookup(id);
  if (profile === undefined) {
    throw new EnterpriseScopeError(404, 'enterprise_not_found', `Enterprise "${id}" was not found.`);
  }
  return Object.freeze({ id, profile });
}

function repeatedIds(req: Request): unknown[] {
  const ids: unknown[] = [req.get(ENTERPRISE_ID_HEADER), req.query[ENTERPRISE_ID_PARAM], bodyEnterpriseId(req.body)];
  return ids.filter((value) => value !== undefined);
}

function bodyEnterpriseId(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.hasOwn(body, ENTERPRISE_ID_PARAM) ? Reflect.get(body, ENTERPRISE_ID_PARAM) : undefined;
}

function assertNoConflict(id: EnterpriseId, repeated: unknown[]): void {
  if (repeated.every((value) => value === id)) return;
  throw new EnterpriseScopeError(400, 'enterprise_scope_conflict', 'The request names more than one enterprise.');
}
