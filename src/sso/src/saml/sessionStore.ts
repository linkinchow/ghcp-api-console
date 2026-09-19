import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EnterpriseScope } from '@ghcp/shared';

const SESSION_TTL = 8 * 60 * 60 * 1000;
const TRANSACTION_TTL = 5 * 60 * 1000;
// At least the AuthnRequest acceptance window plus clock skew.
const REPLAY_TTL = 11 * 60 * 1000;
const MAX_SESSIONS = 2048;
const MAX_TRANSACTIONS = 8;
const MAX_REQUEST_IDS = 8192;

export interface SessionUser { ssoUser: string; userIncarnation: string; enterpriseId: string }
export interface SamlTransaction {
  nonce: string;
  csrf: string;
  enterpriseId: string;
  enterpriseRevision: number;
  registryRevision: number;
  sessionId: string;
  generation: number;
  expiresAt: number;
  requestId?: string;
  relayState?: string;
  user?: SessionUser;
  attempts: number;
}
export interface SamlSession {
  id: string;
  expiresAt: number;
  generation: number;
  csrf: string;
  user?: SessionUser;
  transactions: Map<string, SamlTransaction>;
}

export class SamlStateError extends Error {
  constructor(readonly code: string) { super(code); }
}

const token = (): string => randomBytes(32).toString('base64url');
export function equalToken(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const actual = Buffer.from(a), expected = Buffer.from(b);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Single-process, fail-closed bounded store. Restart deliberately invalidates all sessions.
 * Multi-process deployments need sticky routing or a shared atomic implementation. */
export class SamlSessionStore {
  private readonly sessions = new Map<string, SamlSession>();
  readonly cookieName: string;
  readonly cookiePath: string;
  readonly secure: boolean;

  constructor(
    private readonly scope: EnterpriseScope,
    private readonly secret: string,
    legacy: boolean,
    publicUrl: string,
    private readonly now: () => number = Date.now,
    private readonly requestIds: Map<string, number> = new Map(),
  ) {
    if (Buffer.byteLength(secret) < 32) throw new SamlStateError('saml_session_secret_too_short');
    this.cookieName = `sso_${scope.enterpriseId.replaceAll('-', '')}${legacy ? '_legacy' : ''}`;
    this.cookiePath = legacy ? '/' : `/profiles/${scope.enterpriseId}`;
    this.secure = new URL(publicUrl).protocol === 'https:';
  }

  private sign(id: string): string {
    return createHmac('sha256', this.secret)
      .update(`${this.cookieName}\0${this.cookiePath}\0${this.scope.enterpriseId}\0${this.scope.enterpriseRevision}\0${this.scope.registryRevision}\0${id}`)
      .digest('base64url');
  }

  cookie(session: SamlSession): string {
    return `${this.cookieName}=${session.id}.${this.sign(session.id)}; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((session.expiresAt - this.now()) / 1000))}${this.secure ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${this.cookieName}=; Path=${this.cookiePath}; HttpOnly; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`;
  }

  read(header: string | undefined): SamlSession | undefined {
    this.prune();
    const matches = (header ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${this.cookieName}=`));
    if (matches.length > 1) throw new SamlStateError('saml_duplicate_cookie');
    if (!matches.length) return undefined;
    const value = matches[0]!.slice(this.cookieName.length + 1);
    const parts = value.split('.');
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]{43}$/.test(part!)) || !equalToken(parts[1], this.sign(parts[0]!))) return undefined;
    return this.sessions.get(parts[0]!);
  }

  create(): SamlSession {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) throw new SamlStateError('saml_session_capacity');
    const session: SamlSession = { id: token(), expiresAt: this.now() + SESSION_TTL, generation: 0, csrf: token(), transactions: new Map() };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Rotation preserves outstanding tab transactions, but invalidates the old cookie. */
  authenticate(session: SamlSession, user: SessionUser): void {
    this.assertLive(session);
    this.assertUser(user);
    if (session.user && !sameUser(session.user, user)) {
      session.generation++;
      session.transactions.clear();
    }
    this.sessions.delete(session.id);
    session.id = token();
    session.user = { ...user };
    session.csrf = token();
    for (const tx of session.transactions.values()) {
      tx.sessionId = session.id;
      tx.user ??= { ...user };
    }
    this.sessions.set(session.id, session);
  }

  forceAuthn(session: SamlSession): void {
    this.assertLive(session);
    session.user = undefined;
    session.generation++;
    session.transactions.clear();
  }

  logout(session: SamlSession): void {
    session.generation++;
    session.user = undefined;
    session.transactions.clear();
    this.sessions.delete(session.id);
  }

  issue(session: SamlSession, request?: { id: string; relayState?: string }): SamlTransaction {
    this.prune();
    this.assertLive(session);
    if (session.transactions.size >= MAX_TRANSACTIONS) throw new SamlStateError('saml_transaction_capacity');
    if (request) {
      if (this.requestIds.has(request.id)) throw new SamlStateError('saml_request_replayed');
      if (this.requestIds.size >= MAX_REQUEST_IDS) throw new SamlStateError('saml_replay_capacity');
      this.requestIds.set(request.id, this.now() + REPLAY_TTL);
    }
    const tx: SamlTransaction = {
      nonce: token(), csrf: token(), enterpriseId: this.scope.enterpriseId,
      enterpriseRevision: this.scope.enterpriseRevision, registryRevision: this.scope.registryRevision,
      sessionId: session.id, generation: session.generation, expiresAt: this.now() + TRANSACTION_TTL,
      requestId: request?.id, relayState: request?.relayState, user: session.user ? { ...session.user } : undefined, attempts: 0,
    };
    session.transactions.set(tx.nonce, tx);
    return tx;
  }

  peek(session: SamlSession, nonce: string): SamlTransaction {
    this.assertLive(session);
    const tx = session.transactions.get(nonce);
    if (!tx || tx.expiresAt <= this.now() || tx.generation !== session.generation || tx.sessionId !== session.id ||
      tx.enterpriseId !== this.scope.enterpriseId || tx.enterpriseRevision !== this.scope.enterpriseRevision || tx.registryRevision !== this.scope.registryRevision) {
      throw new SamlStateError('saml_transaction_invalid');
    }
    return tx;
  }

  verifyForm(session: SamlSession, nonce: string, csrf: string): SamlTransaction {
    const tx = this.peek(session, nonce);
    if (!equalToken(csrf, tx.csrf)) throw new SamlStateError('saml_csrf_invalid');
    if (++tx.attempts > 5) {
      session.transactions.delete(nonce);
      throw new SamlStateError('saml_transaction_invalid');
    }
    return tx;
  }

  /** Synchronous removal is the atomic consume: no await may occur before this call. */
  consume(session: SamlSession, nonce: string, user: SessionUser): SamlTransaction {
    const tx = this.peek(session, nonce);
    this.assertUser(user);
    if (tx.user && !sameUser(tx.user, user)) throw new SamlStateError('saml_user_changed');
    session.transactions.delete(nonce);
    tx.user = { ...user };
    return tx;
  }

  assertCompletion(session: SamlSession, tx: SamlTransaction, user: SessionUser): void {
    this.assertLive(session);
    if (tx.expiresAt <= this.now() || tx.generation !== session.generation || tx.sessionId !== session.id ||
      tx.enterpriseId !== this.scope.enterpriseId || tx.enterpriseRevision !== this.scope.enterpriseRevision ||
      tx.registryRevision !== this.scope.registryRevision || !tx.user || !sameUser(tx.user, user) ||
      (session.user && !sameUser(session.user, user))) throw new SamlStateError('saml_transaction_invalid');
  }

  private assertUser(user: SessionUser): void {
    if (user.enterpriseId !== this.scope.enterpriseId || !user.userIncarnation || !user.ssoUser) throw new SamlStateError('saml_user_changed');
  }
  private assertLive(session: SamlSession): void {
    if (session.expiresAt <= this.now() || this.sessions.get(session.id) !== session) throw new SamlStateError('saml_session_expired');
  }
  private prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
      else for (const [nonce, tx] of session.transactions) if (tx.expiresAt <= now) session.transactions.delete(nonce);
    }
    for (const [id, expiresAt] of this.requestIds) if (expiresAt <= now) this.requestIds.delete(id);
  }
}

function sameUser(a: SessionUser, b: SessionUser): boolean {
  return a.enterpriseId === b.enterpriseId && a.ssoUser === b.ssoUser && a.userIncarnation === b.userIncarnation;
}
