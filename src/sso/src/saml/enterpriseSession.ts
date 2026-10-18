import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { DEFAULT_ENTERPRISE_ID, type EnterpriseId } from '@ghcp/shared';
import { config } from '../config.js';
import { ssoSessionSecret, type SsoEnterprise } from '../enterprises.js';

/**
 * Per-enterprise SAML sessions kept only in a signed cookie (design §5.5), so they survive restarts and work
 * across instances that share the secret.
 *
 * The wire format is the baseline cookie-session one: the value is base64 JSON and `<name>.sig` holds the
 * keygrip HMAC-SHA1 of `<name>=<value>`. Baseline `sso_session` cookies therefore stay readable. The cookies are
 * written here rather than by cookie-session because cookie-session drops a Secure cookie without an error when
 * Node itself does not see TLS, which is the case behind a TLS-terminating proxy.
 */
export const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
export const PENDING_TTL_MS = 5 * 60 * 1000;

const DEFAULT_COOKIE_NAME = 'sso_session';

export interface SessionUser {
  ssoUser: string;
  /**
   * The `created_at` of the user row at login; a recreated user does not match. Undefined only for a baseline
   * cookie on `default`, which the routes check against the user row once and then rewrite.
   */
  createdAt: string | undefined;
}

/** An AuthnRequest waiting for the user to sign in; `exp` is epoch milliseconds. */
export interface PendingRequest {
  requestId?: string;
  relayState?: string;
  exp: number;
}

export interface EnterpriseSession {
  e: EnterpriseId;
  user?: SessionUser;
  pending?: PendingRequest;
}

interface CookieRef {
  name: string;
  path: string;
}

/** The session of the request for this enterprise; an empty session when the cookie is absent or not valid here. */
export function readSession(req: Request, enterprise: SsoEnterprise, now = Date.now()): EnterpriseSession {
  const empty: EnterpriseSession = { e: enterprise.id };
  const cookie = cookieRef(enterprise);
  const value = readCookie(req.headers.cookie, cookie.name);
  const signature = readCookie(req.headers.cookie, `${cookie.name}.sig`);
  if (value === undefined || signature === undefined) return empty;
  if (!hasValidSignature(cookie.name, value, signature, ssoSessionSecret(enterprise))) return empty;
  const payload = decodePayload(value);
  if (!isRecord(payload)) return empty;
  if (!('e' in payload)) return enterprise.id === DEFAULT_ENTERPRISE_ID ? legacySession(payload, now) : empty;
  if (payload.e !== enterprise.id) return empty;
  return { e: enterprise.id, user: readUser(payload.user), pending: readPending(payload.pending, now) };
}

export function writeSession(res: Response, enterprise: SsoEnterprise, session: EnterpriseSession): void {
  const cookie = cookieRef(enterprise);
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const options = cookieOptions(cookie);
  res.cookie(cookie.name, value, options);
  res.cookie(`${cookie.name}.sig`, sign(`${cookie.name}=${value}`, ssoSessionSecret(enterprise)), options);
}

export function clearSession(res: Response, enterprise: SsoEnterprise): void {
  const cookie = cookieRef(enterprise);
  const { maxAge: _maxAge, ...options } = cookieOptions(cookie);
  res.clearCookie(cookie.name, options);
  res.clearCookie(`${cookie.name}.sig`, options);
}

export function newPending(
  requestId: string | undefined,
  relayState: string | undefined,
  now = Date.now(),
): PendingRequest {
  return { requestId, relayState, exp: now + PENDING_TTL_MS };
}

/** `default` keeps the baseline name and root path; other enterprises are scoped to their own path. */
function cookieRef(enterprise: SsoEnterprise): CookieRef {
  if (enterprise.id === DEFAULT_ENTERPRISE_ID) return { name: DEFAULT_COOKIE_NAME, path: '/' };
  return { name: `${DEFAULT_COOKIE_NAME}_${enterprise.id}`, path: enterprise.publicPath };
}

function cookieOptions(cookie: CookieRef): CookieOptions {
  return {
    path: cookie.path,
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(config.baseUrl).protocol === 'https:',
    maxAge: SESSION_MAX_AGE_MS,
    // The value is already cookie-safe base64; URI-encoding it would break the baseline signature format.
    encode: String,
  };
}

/** Baseline cookie-session payload: `{ user?: { ssoUser }, pendingInResponseTo?, pendingRelayState?, ssoPending? }`. */
function legacySession(payload: Record<string, unknown>, now: number): EnterpriseSession {
  const session: EnterpriseSession = { e: DEFAULT_ENTERPRISE_ID };
  const ssoUser = isRecord(payload.user) ? payload.user.ssoUser : undefined;
  if (typeof ssoUser === 'string' && ssoUser) session.user = { ssoUser, createdAt: undefined };
  if (payload.ssoPending === true) {
    const requestId = optionalString(payload.pendingInResponseTo);
    session.pending = newPending(requestId, optionalString(payload.pendingRelayState), now);
  }
  return session;
}

function readUser(value: unknown): SessionUser | undefined {
  if (!isRecord(value) || typeof value.ssoUser !== 'string' || typeof value.createdAt !== 'string') return undefined;
  return { ssoUser: value.ssoUser, createdAt: value.createdAt };
}

function readPending(value: unknown, now: number): PendingRequest | undefined {
  if (!isRecord(value) || typeof value.exp !== 'number' || value.exp <= now) return undefined;
  return { requestId: optionalString(value.requestId), relayState: optionalString(value.relayState), exp: value.exp };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return unquote(part.slice(separator + 1).trim());
  }
  return undefined;
}

function unquote(value: string): string {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** keygrip's default signature: HMAC-SHA1, base64url without padding. */
function sign(data: string, secret: string): string {
  return createHmac('sha1', secret).update(data).digest('base64url');
}

function hasValidSignature(name: string, value: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(`${name}=${value}`, secret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodePayload(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
