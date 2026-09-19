import { randomBytes } from 'node:crypto';
import { Router, urlencoded, type Request, type Response, type ErrorRequestHandler } from 'express';
import type { EnterpriseScope } from '@ghcp/shared';
import { readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';
import { getScopeProfile, requireEnterpriseRequest } from '../enterprise.js';
import { assertUserIncarnation, getUser, type SsoUserRecord } from '../db/usersRepo.js';
import { verifyPassword } from '../auth/password.js';
import { buildSamlResponse, metadataXml, parseAuthnRequest } from '../saml/saml.js';
import { equalToken, SamlSessionStore, SamlStateError, type SamlSession, type SamlTransaction } from '../saml/sessionStore.js';

// A single ledger per enterprise/revision, including legacy aliases. It contains only request
// IDs/expiries, never users or credentials. Scope is always explicit, never ambient.
const ledgers = new Map<string, { revision: number; registryRevision: number; ids: Map<string, number> }>();

export function createSamlRouter(scope: EnterpriseScope, legacy = false): Router {
  const profile = getScopeProfile(scope);
  if (legacy && new URL(profile.sso.ssoUrl).pathname !== '/sso') throw new Error('saml_legacy_profile_invalid');
  const base = legacy ? '' : `/profiles/${scope.enterpriseId}`;
  const loginPath = `${base}/login`;
  const logoutPath = `${base}/logout`;
  const origin = new URL(profile.sso.ssoUrl).origin;
  let ledger = ledgers.get(scope.enterpriseId);
  if (!ledger || ledger.revision !== scope.enterpriseRevision || ledger.registryRevision !== scope.registryRevision) {
    if (!ledger && ledgers.size >= 100) throw new Error('saml_profile_capacity');
    ledger = { revision: scope.enterpriseRevision, registryRevision: scope.registryRevision, ids: new Map() };
    ledgers.set(scope.enterpriseId, ledger);
  }
  // A draft profile must not make another profile (or readiness) fail to boot. Read
  // its own secret only when a session is actually needed; never substitute one.
  const replayIds = ledger.ids;
  let sessionStore: SamlSessionStore | undefined;
  const getStore = (): SamlSessionStore => sessionStore ??= new SamlSessionStore(
    scope, readEnterpriseSecret(profile.sso.sessionSecretRef), legacy, profile.sso.ssoUrl, Date.now, replayIds,
  );
  const router = Router();
  const paths = ['/metadata', '/sso', '/login', '/logout'];
  router.use(paths, requireEnterpriseRequest(scope), (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    next();
  });
  const formParser = urlencoded({ extended: false, limit: '100kb', parameterLimit: 8, inflate: false });
  router.use(['/sso', '/login', '/logout'], (req, res, next) => {
    if (req.method === 'POST' && !req.is('application/x-www-form-urlencoded')) { res.status(415).send('Form encoding required.'); return; }
    next();
  }, formParser);

  router.get('/metadata', (req, res) => {
    singleParameters(req.query, []);
    res.type('application/xml').send(metadataXml(scope));
  });

  const sso = async (req: Request, res: Response): Promise<void> => {
    try {
      const post = req.method === 'POST';
      if (post) singleParameters(req.query, []);
      const parameters = singleParameters(post ? req.body : req.query, ['SAMLRequest', 'RelayState']);
      const parsed = await parseAuthnRequest(parameters, post ? 'post' : 'redirect', scope);
      const store = getStore();
      const session = store.read(req.headers.cookie) ?? store.create();
      if (parsed.forceAuthn) store.forceAuthn(session);
      // An old authenticated cookie must not pick up a same-name replacement user.
      let user = session.user ? getUser(session.user.ssoUser, scope) : undefined;
      if (session.user && (!user || user.userIncarnation !== session.user.userIncarnation || user.enterpriseId !== session.user.enterpriseId)) {
        store.forceAuthn(session);
        user = undefined;
      }
      const tx = store.issue(session, parsed);
      res.append('Set-Cookie', store.cookie(session));
      if (!user) { res.redirect(`${loginPath}?tx=${encodeURIComponent(tx.nonce)}`); return; }
      const consumed = store.consume(session, tx.nonce, user);
      await respondSaml(session, consumed, user, false, res);
    } catch (error) { fail(res, error); }
  };
  router.get('/sso', sso);
  router.post('/sso', sso);

  router.get('/login', (req, res) => {
    try {
      const query = singleParameters(req.query, ['tx']);
      const store = getStore();
      let session = store.read(req.headers.cookie);
      if (query.tx && !session) throw new SamlStateError('saml_transaction_invalid');
      session ??= store.create();
      const tx = query.tx ? store.peek(session, query.tx) : store.issue(session);
      res.append('Set-Cookie', store.cookie(session));
      html(res, loginHtml(loginPath, tx));
    } catch (error) { fail(res, error); }
  });

  router.post('/login', async (req, res) => {
    try {
      checkOrigin(req, origin);
      singleParameters(req.query, []);
      const form = singleParameters(req.body, ['username', 'password', 'tx', 'csrf']);
      const store = getStore();
      const session = store.read(req.headers.cookie);
      if (!session || !form.tx || !form.csrf) throw new SamlStateError('saml_transaction_invalid');
      const tx = store.verifyForm(session, form.tx, form.csrf);
      if (!form.username || form.username.length > 255 || !form.password || Buffer.byteLength(form.password) > 1024) throw new SamlStateError('saml_credentials_invalid');
      const user = getUser(form.username, scope);
      if (!user || !verifyPassword(form.password, user.passwordHash, user.salt)) {
        html(res.status(401), loginHtml(loginPath, tx, 'Invalid username or password.'));
        return;
      }
      const consumed = store.consume(session, tx.nonce, user);
      if (consumed.requestId) {
        await respondSaml(session, consumed, user, true, res);
      } else {
        getScopeProfile(scope);
        store.assertCompletion(session, consumed, user);
        assertUserIncarnation(user, scope);
        store.authenticate(session, user);
        res.append('Set-Cookie', store.cookie(session));
        const body = loggedInHtml(logoutPath, session.csrf, user.ssoUser);
        assertUserIncarnation(user, scope);
        html(res, body);
      }
    } catch (error) { fail(res, error); }
  });

  router.get('/logout', (req, res) => {
    try {
      singleParameters(req.query, []);
      const store = getStore();
      const session = store.read(req.headers.cookie);
      if (!session) { res.redirect(loginPath); return; }
      html(res, loggedInHtml(logoutPath, session.csrf));
    } catch (error) { fail(res, error); }
  });

  router.post('/logout', (req, res) => {
    try {
      checkOrigin(req, origin);
      singleParameters(req.query, []);
      const form = singleParameters(req.body, ['csrf']);
      const store = getStore();
      const session = store.read(req.headers.cookie);
      if (!session || !equalToken(form.csrf, session.csrf)) throw new SamlStateError('saml_csrf_invalid');
      store.logout(session);
      res.append('Set-Cookie', store.clearCookie());
      res.redirect(loginPath);
    } catch (error) { fail(res, error); }
  });

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    // XML/body-parser details may contain credentials, file paths, or untrusted request XML.
    if (!res.headersSent) fail(res, error);
  };
  router.use(onError);
  return router;

  async function respondSaml(session: SamlSession, tx: SamlTransaction, user: SsoUserRecord, authenticate: boolean, res: Response): Promise<void> {
    const store = getStore();
    if (!tx.requestId) throw new SamlStateError('saml_transaction_invalid');
    const post = await buildSamlResponse(user, tx.requestId, tx.relayState, scope);
    const nonce = tx.csrf;
    const body = samlPostHtml(post.acsUrl, post.samlResponse, post.relayState, nonce);
    getScopeProfile(scope);
    store.assertCompletion(session, tx, user);
    assertUserIncarnation(user, scope);
    if (authenticate) {
      store.authenticate(session, user);
      res.append('Set-Cookie', store.cookie(session));
    }
    // Synchronous DB fence with no intervening await: delete/recreate never inherits auth.
    assertUserIncarnation(user, scope);
    html(res, body, `script-src 'nonce-${nonce}'; form-action ${new URL(post.acsUrl).origin};`);
  }
}

function singleParameters(value: unknown, allowed: readonly string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SamlStateError('saml_parameter_invalid');
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof item !== 'string') throw new SamlStateError('saml_parameter_invalid');
    result[key] = item;
  }
  return result;
}
function checkOrigin(req: Request, expected: string): void {
  if ((req.headers.origin && req.headers.origin !== expected) || req.headers['sec-fetch-site'] === 'cross-site') throw new SamlStateError('saml_csrf_invalid');
}
function fail(res: Response, error: unknown): void {
  if (res.headersSent) return;
  const capacity = error instanceof SamlStateError && error.code.endsWith('_capacity');
  res.status(capacity ? 503 : 400).type('text').send(capacity ? 'SSO is at capacity. Try again later.' : 'Invalid or expired SSO request. Start sign-in again.');
}
function html(res: Response, body: string, directives = "form-action 'self';"): void {
  const styleNonce = randomBytes(24).toString('base64url');
  const styled = body.replace('</head>', `<style nonce="${styleNonce}">:root{color-scheme:light}body{background:#fff;color:#111;font-family:Arial,sans-serif;margin:24px;line-height:1.5}input,button{font:inherit}input{margin:4px 0}button{margin-top:12px}</style></head>`);
  res.set('Content-Security-Policy', `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'nonce-${styleNonce}'; ${directives}`).type('html').send(styled);
}
function loginHtml(action: string, tx: SamlTransaction, error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSO Login</title></head><body><main><h1>SSO Login</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="tx" value="${escapeHtml(tx.nonce)}"><input type="hidden" name="csrf" value="${escapeHtml(tx.csrf)}"><label>Username <input name="username" autocomplete="username" required maxlength="255"></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><br><button type="submit">Sign in</button></form></main></body></html>`;
}
function loggedInHtml(action: string, csrf: string, username?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SSO Session</title></head><body>${username ? `<p>Logged in as ${escapeHtml(username)}</p>` : ''}<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Logout</button></form></body></html>`;
}
function samlPostHtml(acsUrl: string, samlResponse: string, relayState: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Continue sign-in</title></head><body><form method="post" action="${escapeHtml(acsUrl)}"><input type="hidden" name="SAMLResponse" value="${escapeHtml(samlResponse)}"><input type="hidden" name="RelayState" value="${escapeHtml(relayState)}"><button type="submit">Continue</button></form><script nonce="${escapeHtml(nonce)}">document.forms[0].submit()</script></body></html>`;
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
