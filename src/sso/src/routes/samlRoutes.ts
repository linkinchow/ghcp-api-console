import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { apiError } from '@ghcp/shared';
import { getUser, type SsoUserRecord } from '../db/usersRepo.js';
import { verifyPassword } from '../auth/password.js';
import { config } from '../config.js';
import { findSsoEnterprise, ssoEnterprises, type SsoEnterprise } from '../enterprises.js';
import { buildSamlResponse, metadataXml, parseAuthnRequest } from '../saml/saml.js';
import {
  clearSession,
  newPending,
  readSession,
  writeSession,
  type EnterpriseSession,
} from '../saml/enterpriseSession.js';

/** `default` keeps the root SAML URLs; other enterprises use `/enterprises/<id>`; unknown ids never fall back. */
export function mountSamlRouters(app: Express): void {
  for (const enterprise of ssoEnterprises()) {
    if (enterprise.publicPath) app.use(enterprise.publicPath, createSamlRouter(enterprise));
    else app.use(createSamlRouter(enterprise));
  }
  app.use('/enterprises/:enterpriseId', (req, res, next) => {
    if (findSsoEnterprise(req.params.enterpriseId)) {
      next();
      return;
    }
    res.status(404).json(apiError('enterprise_not_found', 'Unknown enterprise.'));
  });
}

/**
 * The SAML IdP routes of one enterprise. `default` is mounted at the root (baseline URLs); other enterprises are
 * mounted at their `publicPath`, `/enterprises/<id>`.
 */
export function createSamlRouter(enterprise: SsoEnterprise): Router {
  const router = Router();
  router.get('/metadata', (_req, res) => {
    res.type('application/xml').send(metadataXml(enterprise));
  });
  router.get('/sso', (req, res) => startSso(enterprise, req, res));
  router.get('/login', (_req, res) => {
    res.type('html').send(loginHtml(enterprise));
  });
  router.post('/login', requireSameOrigin, (req, res) => login(enterprise, req, res));
  router.post('/logout', requireSameOrigin, (_req, res) => {
    clearSession(res, enterprise);
    res.redirect(loginPath(enterprise));
  });
  return router;
}

async function startSso(enterprise: SsoEnterprise, req: Request, res: Response): Promise<void> {
  const session = readSession(req, enterprise);
  try {
    await recordPendingRequest(enterprise, req.query as Record<string, unknown>, session);
  } catch (err) {
    res.status(400).type('text').send(`Invalid SAML request: ${(err as Error).message}`);
    return;
  }
  const user = currentUser(enterprise, session);
  if (!user) {
    writeSession(res, enterprise, session);
    res.redirect(loginPath(enterprise));
    return;
  }
  await respondSaml(enterprise, res, session, user);
}

async function recordPendingRequest(
  enterprise: SsoEnterprise,
  query: Record<string, unknown>,
  session: EnterpriseSession,
): Promise<void> {
  if (!query.SAMLRequest) {
    session.pending = newPending(undefined, typeof query.RelayState === 'string' ? query.RelayState : undefined);
    return;
  }
  const parsed = await parseAuthnRequest(enterprise, query);
  session.pending = newPending(parsed.id, parsed.relayState);
  if (parsed.forceAuthn) session.user = undefined;
}

async function login(enterprise: SsoEnterprise, req: Request, res: Response): Promise<void> {
  const { username, password } = req.body as { username?: unknown; password?: unknown };
  const user = typeof username === 'string' && username ? getUser(enterprise.id, username) : undefined;
  const passwordText = typeof password === 'string' ? password : '';
  if (!user || !(await verifyPassword(passwordText, user.passwordHash, user.salt))) {
    res.status(401).type('html').send(loginHtml(enterprise, 'Invalid username or password.'));
    return;
  }
  const session = readSession(req, enterprise);
  session.user = { ssoUser: user.ssoUser, createdAt: user.createdAt };
  if (session.pending) {
    await respondSaml(enterprise, res, session, user);
    return;
  }
  writeSession(res, enterprise, session);
  res.type('html').send(loggedInHtml(enterprise, user.ssoUser));
}

/**
 * The signed-in user of the session, read again from this enterprise's users. A cookie issued for an earlier user
 * row of the same name (deleted and recreated) no longer matches its `created_at`. A baseline cookie on `default`
 * has no `created_at`; it is accepted once, as before the upgrade, and rewritten with the row's value.
 */
function currentUser(enterprise: SsoEnterprise, session: EnterpriseSession): SsoUserRecord | undefined {
  const sessionUser = session.user;
  if (!sessionUser) return undefined;
  const user = getUser(enterprise.id, sessionUser.ssoUser);
  const recreated = sessionUser.createdAt !== undefined && sessionUser.createdAt !== user?.createdAt;
  if (!user || recreated) {
    session.user = undefined;
    return undefined;
  }
  session.user = { ssoUser: user.ssoUser, createdAt: user.createdAt };
  return user;
}

/** Answers the pending AuthnRequest; the pending request is used for one response only. */
async function respondSaml(
  enterprise: SsoEnterprise,
  res: Response,
  session: EnterpriseSession,
  user: SsoUserRecord,
): Promise<void> {
  const pending = session.pending;
  const post = await buildSamlResponse(enterprise, user, pending?.requestId, pending?.relayState);
  writeSession(res, enterprise, { ...session, pending: undefined });
  res.type('html').send(samlPostHtml(post.acsUrl, post.samlResponse, post.relayState));
}

/**
 * Rejects cross-site form posts: `Sec-Fetch-Site: cross-site`, `Origin: null`, or an Origin whose host is neither
 * the BASE_URL host nor the request's Host (internal-mode access such as http://127.0.0.1:7001). Hosts are compared
 * without the scheme because TLS may terminate at a proxy. A missing Origin is accepted, as in the baseline.
 */
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  const allowedOrigin = origin === undefined || isSameHostOrigin(origin, req.get('host'));
  if (!allowedOrigin || req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).type('text').send('Cross-site request rejected.');
    return;
  }
  next();
}

function isSameHostOrigin(origin: string, hostHeader: string | undefined): boolean {
  const originUrl = parseUrl(origin);
  if (!originUrl) return false;
  const requestHost = hostHeader ? parseUrl(`${originUrl.protocol}//${hostHeader}`)?.host : undefined;
  return originUrl.host === new URL(config.baseUrl).host || originUrl.host === requestHost;
}

/** `undefined` for `null` and other values that are not absolute URLs. */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function loginPath(enterprise: SsoEnterprise): string {
  return `${enterprise.publicPath}/login`;
}

function loginHtml(enterprise: SsoEnterprise, error?: string): string {
  const message = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  return '<!doctype html><html><body><main><h1>SSO Login</h1>' +
    message +
    `<form method="post" action="${escapeHtml(loginPath(enterprise))}">` +
    '<label>Username <input name="username" autocomplete="username"></label><br>' +
    '<label>Password <input name="password" type="password" autocomplete="current-password"></label><br>' +
    '<button type="submit">Sign in</button></form></main></body></html>';
}

function loggedInHtml(enterprise: SsoEnterprise, ssoUser: string): string {
  return `<p>Logged in as ${escapeHtml(ssoUser)}</p>` +
    `<form method="post" action="${escapeHtml(`${enterprise.publicPath}/logout`)}"><button>Logout</button></form>`;
}

function samlPostHtml(acsUrl: string, samlResponse: string, relayState: string): string {
  return '<!doctype html><html><body onload="document.forms[0].submit()">' +
    `<form method="post" action="${escapeHtml(acsUrl)}">` +
    `<input type="hidden" name="SAMLResponse" value="${escapeHtml(samlResponse)}">` +
    `<input type="hidden" name="RelayState" value="${escapeHtml(relayState)}">` +
    '<noscript><button type="submit">Continue</button></noscript></form></body></html>';
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (char) => entities[char]!);
}
