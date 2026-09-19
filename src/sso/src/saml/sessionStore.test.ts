import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseScope } from '@ghcp/shared';
import { equalToken, SamlSessionStore } from './sessionStore.js';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
function scope(id = A, revision = 1): EnterpriseScope {
  return { enterpriseId: id, enterpriseRevision: revision, registryRevision: 1, profile: {} as EnterpriseScope['profile'] };
}
const user = { ssoUser: 'same-user', enterpriseId: A, userIncarnation: 'original-incarnation' };
const cookie = (header: string): string => header.split(';')[0]!;

test('opaque authenticated cookies isolate enterprise, revision, signing key and legacy path', () => {
  const a = new SamlSessionStore(scope(), 'a'.repeat(32), false, 'https://idp.invalid');
  const b = new SamlSessionStore(scope(B), 'b'.repeat(32), false, 'https://idp.invalid');
  const session = a.create();
  a.authenticate(session, user);
  const encoded = a.cookie(session);
  assert.match(encoded, /HttpOnly; SameSite=Lax/);
  assert.match(encoded, /; Secure$/);
  assert.ok(encoded.includes(`Path=/profiles/${A}`));
  assert.ok(!encoded.includes('same-user') && !encoded.includes('original-incarnation'));
  assert.equal(a.read(cookie(encoded)), session);
  assert.equal(b.read(cookie(encoded).replace(a.cookieName, b.cookieName)), undefined);
  assert.equal(new SamlSessionStore(scope(), 'z'.repeat(32), false, 'https://idp.invalid').read(cookie(encoded)), undefined);
  assert.equal(new SamlSessionStore(scope(A, 2), 'a'.repeat(32), false, 'https://idp.invalid').read(cookie(encoded)), undefined);
  const legacy = new SamlSessionStore(scope(), 'a'.repeat(32), true, 'https://idp.invalid');
  assert.notEqual(legacy.cookieName, a.cookieName);
  assert.equal(legacy.cookiePath, '/');
  assert.equal(legacy.read(cookie(encoded).replace(a.cookieName, legacy.cookieName)), undefined);
  assert.throws(() => a.read(`${cookie(encoded)}; ${cookie(encoded)}`), /duplicate_cookie/);
  assert.equal(a.read('sso_session=eyJ1c2VyIjoic2FtZS11c2VyIn0='), undefined);
  assert.equal(equalToken('界'.repeat(43), 'a'.repeat(43)), false);
});

test('one-use transactions bind session, enterprise, user incarnation and preserve separate tabs across rotation', () => {
  const store = new SamlSessionStore(scope(), 'x'.repeat(32), false, 'http://127.0.0.1');
  const session = store.create(), stranger = store.create();
  const tab1 = store.issue(session, { id: '_first', relayState: 'opaque1' });
  const tab2 = store.issue(session, { id: '_second', relayState: 'opaque2' });
  assert.throws(() => store.peek(stranger, tab1.nonce), /invalid/);
  assert.throws(() => store.verifyForm(session, tab1.nonce, 'wrong'), /csrf/);
  assert.throws(() => store.consume(session, tab1.nonce, { ...user, enterpriseId: B }), /user_changed/);
  store.verifyForm(session, tab1.nonce, tab1.csrf);
  const consumed = store.consume(session, tab1.nonce, user);
  store.assertCompletion(session, consumed, user);
  const oldCookie = cookie(store.cookie(session));
  store.authenticate(session, user);
  assert.equal(store.read(oldCookie), undefined);
  assert.equal(store.peek(session, tab2.nonce).relayState, 'opaque2');
  assert.throws(() => store.consume(session, tab1.nonce, user), /invalid/);
  assert.throws(() => store.issue(stranger, { id: '_first' }), /replayed/);
  const tab3 = store.issue(session, { id: '_third' });
  assert.throws(() => store.consume(session, tab3.nonce, { ...user, userIncarnation: 'replacement' }), /user_changed/);
});

test('ForceAuthn/logout invalidate current enterprise inflight work, not other enterprise sessions', () => {
  const a = new SamlSessionStore(scope(), 'a'.repeat(32), false, 'http://127.0.0.1');
  const b = new SamlSessionStore(scope(B), 'b'.repeat(32), false, 'http://127.0.0.1');
  const as = a.create(), bs = b.create();
  a.authenticate(as, user);
  b.authenticate(bs, { ...user, enterpriseId: B });
  const pending = a.consume(as, a.issue(as, { id: '_inflight' }).nonce, user);
  a.forceAuthn(as);
  assert.equal(as.user, undefined);
  assert.throws(() => a.assertCompletion(as, pending, user), /invalid/);
  assert.equal(bs.user?.ssoUser, user.ssoUser);
  const fresh = a.consume(as, a.issue(as, { id: '_logout' }).nonce, user);
  a.logout(as);
  assert.throws(() => a.assertCompletion(as, fresh, user), /expired/);
  assert.equal(b.read(cookie(b.cookie(bs))), bs);
});

test('bounded session/transaction/replay storage and expiry fail closed', () => {
  let now = 0;
  const store = new SamlSessionStore(scope(), 'x'.repeat(32), false, 'http://127.0.0.1', () => now);
  const s = store.create();
  const tx = store.issue(s, { id: '_expiring' });
  for (let i = 1; i < 8; i++) store.issue(s);
  assert.throws(() => store.issue(s), /transaction_capacity/);
  now += 5 * 60 * 1000;
  assert.throws(() => store.peek(s, tx.nonce), /invalid/);
  store.issue(s);
  assert.throws(() => store.issue(s, { id: '_expiring' }), /replayed/);
  now += 7 * 60 * 1000;
  store.issue(s, { id: '_expiring' });
  for (let i = 1; i < 2048; i++) store.create();
  assert.throws(() => store.create(), /session_capacity/);
  now += 8 * 60 * 60 * 1000;
  assert.equal(store.read(cookie(store.cookie(s))), undefined);
  assert.ok(store.create());
  const ledger = new Map(Array.from({ length: 8192 }, (_, i) => [`_${i}`, now + 10000]));
  const full = new SamlSessionStore(scope(), 'x'.repeat(32), false, 'http://127.0.0.1', () => now, ledger);
  assert.throws(() => full.issue(full.create(), { id: '_overflow' }), /replay_capacity/);
});

test('legacy aliases share a request replay ledger without sharing browser sessions', () => {
  const ledger = new Map<string, number>();
  const old = new SamlSessionStore(scope(), 'x'.repeat(32), true, 'http://127.0.0.1', Date.now, ledger);
  const modern = new SamlSessionStore(scope(), 'x'.repeat(32), false, 'http://127.0.0.1', Date.now, ledger);
  old.issue(old.create(), { id: '_same_request' });
  assert.throws(() => modern.issue(modern.create(), { id: '_same_request' }), /replayed/);
});
