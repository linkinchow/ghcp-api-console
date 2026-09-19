import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import type { AuthorizationBinding } from '@ghcp/shared';
import { beginMysqlAttempt, finishMysqlAttempt, getMysqlAttempt } from './mysqlAuthorization.js';
import { AccountScopeError } from './storageTypes.js';
import type { AttemptRow } from './authorizationLedger.js';

const A = '86e2ee02-223a-45ea-8c26-bdd1c570a4ee';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const subject = { login: 'alice_octo', id: '123' };
interface Account {
  enterprise_id: string; identity: string; account_incarnation: string; gh_login: string;
  copilot_oauth_attempt_id: string | null; copilot_oauth_status: string;
  copilot_oauth_token: string | null; updated_at?: string; copilot_oauth_updated_at?: string;
}
type StoredAttempt = AttemptRow & { created_at: string; updated_at: string };
const key = (enterpriseId: string, identity: string) => JSON.stringify([enterpriseId, identity]);

/** Strict, stateful SQL adapter: unknown/missing-scope SQL fails rather than returning canned successes.
 * The parent MysqlStorage owns transactions; this harness models that boundary and rollback only.
 * It does not claim to model MySQL's scheduler/isolation engine or replace the real-DB suite. */
class SqlFixture {
  accounts = new Map<string, Account>();
  attempts = new Map<string, StoredAttempt>();
  calls: Array<{ sql: string; values: unknown[] }> = [];
  private inTransaction = false;
  private accountLocks = new Set<string>();
  private attemptLocks = new Set<string>();
  beforeWrite?: (sql: string) => void;
  readonly connection = { execute: async (sql: string, values: unknown[] = []) => this.execute(sql, values) } as unknown as Pick<PoolConnection, 'execute'>;

  seed(binding: AuthorizationBinding): void {
    this.accounts.set(key(binding.enterpriseId, binding.identity), {
      enterprise_id: binding.enterpriseId, identity: binding.identity, account_incarnation: binding.accountIncarnation,
      gh_login: binding.expectedGhLogin, copilot_oauth_attempt_id: null, copilot_oauth_status: 'missing', copilot_oauth_token: null,
    });
  }
  account(binding: AuthorizationBinding): Account { return this.accounts.get(key(binding.enterpriseId, binding.identity))!; }
  snapshot() { return structuredClone({ accounts: [...this.accounts], attempts: [...this.attempts] }); }
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    assert.equal(this.inTransaction, false, 'tests serialize the parent transaction boundary');
    const before = this.snapshot(); this.inTransaction = true;
    try { return await operation(); }
    catch (error) { this.accounts = new Map(before.accounts); this.attempts = new Map(before.attempts); throw error; }
    finally { this.inTransaction = false; this.accountLocks.clear(); this.attemptLocks.clear(); }
  }
  begin(binding: AuthorizationBinding) { return this.transaction(() => beginMysqlAttempt(this.connection, binding)); }
  finish(binding: AuthorizationBinding, status: 'succeeded' | 'failed' | 'cancelled', token?: string, actual = subject, reason?: string) {
    return this.transaction(() => finishMysqlAttempt(this.connection, binding, status, token, status === 'succeeded' ? actual : undefined, reason));
  }
  private lockedAccount(e: unknown, identity: unknown): Account | undefined {
    assert.equal(typeof e, 'string'); assert.equal(typeof identity, 'string');
    const scope = key(e as string, identity as string);
    assert.ok(this.accountLocks.has(scope), 'account mutation requires its enterprise/identity lock');
    return this.accounts.get(scope);
  }
  private timestamp(value: unknown): string {
    assert.equal(typeof value, 'string'); assert.match(value as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    return value as string;
  }
  private execute(rawSql: string, values: unknown[]) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    assert.equal((sql.match(/\?/g) ?? []).length, values.length, 'every placeholder receives one parameter');
    this.calls.push({ sql, values: [...values] });
    const rows = (value: unknown[]) => [structuredClone(value), []];
    const changed = (affectedRows: number) => [{ affectedRows }, []];
    if (sql === 'SELECT account_incarnation,gh_login,copilot_oauth_attempt_id FROM proxy_accounts WHERE enterprise_id=? AND identity=? FOR UPDATE') {
      assert.ok(this.inTransaction); const [e, id] = values;
      this.accountLocks.add(key(String(e), String(id)));
      const account = this.accounts.get(key(String(e), String(id)));
      return rows(account ? [account] : []);
    }
    if (sql === 'SELECT * FROM proxy_authorization_attempts WHERE oauth_attempt_id=? FOR UPDATE') {
      assert.ok(this.inTransaction && this.accountLocks.size === 1, 'begin locks account before global nonce');
      this.attemptLocks.add(String(values[0]));
      const attempt = this.attempts.get(String(values[0])); return rows(attempt ? [attempt] : []);
    }
    if (sql === 'SELECT * FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? AND oauth_attempt_id=?'
      || sql === 'SELECT * FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? AND oauth_attempt_id=? FOR UPDATE') {
      const [e, id, nonce] = values;
      if (sql.endsWith(' FOR UPDATE')) { assert.ok(this.inTransaction); this.lockedAccount(e, id); this.attemptLocks.add(String(nonce)); }
      const attempt = this.attempts.get(String(nonce));
      return rows(attempt && attempt.enterprise_id === e && attempt.identity === id ? [attempt] : []);
    }
    assert.ok(this.inTransaction, 'all writes require the parent transaction');
    assert.ok(!/^UPDATE proxy_accounts SET .*\bgh_login\s*=/.test(sql), 'authorization must never reassign account GitHub login');
    this.beforeWrite?.(sql);
    if (sql === "UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='superseded',updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND status='active'") {
      const [time, e, id, incarnation] = values; this.timestamp(time); this.lockedAccount(e, id);
      let count = 0;
      for (const attempt of this.attempts.values()) if (attempt.enterprise_id === e && attempt.identity === id && attempt.account_incarnation === incarnation && attempt.status === 'active') {
        attempt.status = 'cancelled'; attempt.failure_reason = 'superseded'; attempt.updated_at = String(time); count++;
      }
      return changed(count);
    }
    if (sql === "INSERT INTO proxy_authorization_attempts (oauth_attempt_id,enterprise_id,enterprise_revision,identity,account_incarnation,expected_gh_login,expected_github_user_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?)") {
      const [nonce, e, revision, id, incarnation, login, githubId, created, updated] = values;
      const account = this.lockedAccount(e, id); assert.ok(account); assert.equal(account.account_incarnation, incarnation); assert.equal(account.gh_login, login);
      assert.equal(typeof revision, 'number'); assert.ok(Number.isSafeInteger(revision) && Number(revision) > 0);
      assert.ok(!this.attempts.has(String(nonce)), 'nonce PK is globally unique'); assert.ok(this.attemptLocks.has(String(nonce)));
      assert.ok(githubId === null || typeof githubId === 'string');
      this.attempts.set(String(nonce), { oauth_attempt_id: String(nonce), enterprise_id: String(e), enterprise_revision: Number(revision), identity: String(id),
        account_incarnation: String(incarnation), expected_gh_login: String(login), expected_github_user_id: githubId as string | null,
        status: 'active', result_fingerprint: null, result_gh_login: null, result_github_user_id: null, failure_reason: null,
        created_at: this.timestamp(created), updated_at: this.timestamp(updated) });
      return changed(1);
    }
    if (sql === "UPDATE proxy_accounts SET copilot_oauth_status='refreshing',copilot_oauth_attempt_id=?,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=?") {
      const [nonce, time, e, id, incarnation] = values; const account = this.lockedAccount(e, id); this.timestamp(time);
      if (!account || account.account_incarnation !== incarnation) return changed(0);
      account.copilot_oauth_status = 'refreshing'; account.copilot_oauth_attempt_id = String(nonce); account.updated_at = String(time); return changed(1);
    }
    if (sql === "UPDATE proxy_accounts SET copilot_oauth_token=?,copilot_oauth_status='valid',copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?") {
      const [token, tokenTime, time, e, id, incarnation, nonce] = values; const account = this.lockedAccount(e, id);
      this.timestamp(tokenTime); this.timestamp(time); assert.equal(typeof token, 'string');
      if (!account || account.account_incarnation !== incarnation || account.copilot_oauth_attempt_id !== nonce) return changed(0);
      account.copilot_oauth_token = String(token); account.copilot_oauth_status = 'valid'; account.copilot_oauth_attempt_id = null;
      account.copilot_oauth_updated_at = String(tokenTime); account.updated_at = String(time); return changed(1);
    }
    if (sql === "UPDATE proxy_accounts SET copilot_oauth_status='failed',copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id=?") {
      const [time, e, id, incarnation, nonce] = values; const account = this.lockedAccount(e, id); this.timestamp(time);
      if (!account || account.account_incarnation !== incarnation || account.copilot_oauth_attempt_id !== nonce) return changed(0);
      account.copilot_oauth_status = 'failed'; account.copilot_oauth_attempt_id = null; account.updated_at = String(time); return changed(1);
    }
    if (sql === "UPDATE proxy_authorization_attempts SET status=?,result_fingerprint=?,result_gh_login=?,result_github_user_id=?,failure_reason=?,updated_at=? WHERE oauth_attempt_id=? AND status='active'") {
      const [status, fingerprint, login, githubId, reason, time, nonce] = values;
      assert.ok(this.attemptLocks.has(String(nonce)), 'consumption requires prior scoped attempt lock'); this.timestamp(time);
      assert.ok(['succeeded', 'failed', 'cancelled'].includes(String(status))); assert.match(String(fingerprint), /^[0-9a-f]{64}$/);
      const attempt = this.attempts.get(String(nonce));
      if (!attempt || attempt.status !== 'active') return changed(0);
      this.lockedAccount(attempt.enterprise_id, attempt.identity);
      Object.assign(attempt, { status, result_fingerprint: fingerprint, result_gh_login: login, result_github_user_id: githubId, failure_reason: reason, updated_at: time });
      return changed(1);
    }
    assert.fail(`Unrecognized or insufficiently scoped SQL: ${sql}`);
  }
}
function binding(overrides: Partial<AuthorizationBinding> = {}): AuthorizationBinding {
  return { enterpriseId: A, enterpriseRevision: 3, identity: 'same-identity', accountIncarnation: randomUUID(), oauthAttemptId: randomUUID(),
    expectedGhLogin: subject.login, expectedGithubUserId: subject.id, ...overrides };
}
const isScopeError = (code: string) => (error: unknown) => error instanceof AccountScopeError && error.code === code;
const writes = (f: SqlFixture) => f.calls.filter(call => /^(UPDATE|INSERT|DELETE)/.test(call.sql));

test('MySQL begin persists full binding under account→nonce locks; same nonce is idempotent and replacement is scoped', async () => {
  const f = new SqlFixture(), a = binding(), other = binding({ enterpriseId: B }); f.seed(a); f.seed(other);
  assert.deepEqual(await f.begin(a), { binding: a, status: 'active' }); await f.begin(other);
  assert.equal(f.account(a).copilot_oauth_attempt_id, a.oauthAttemptId);
  assert.deepEqual((await getMysqlAttempt(f.connection, A, a.identity, a.oauthAttemptId))?.binding, a);
  const before = f.snapshot(), count = writes(f).length;
  assert.equal((await f.begin(a)).status, 'active'); assert.equal(writes(f).length, count); assert.deepEqual(f.snapshot(), before);
  const next = { ...a, oauthAttemptId: randomUUID() }; await f.begin(next);
  assert.equal(f.attempts.get(a.oauthAttemptId)?.status, 'cancelled'); assert.equal(f.attempts.get(a.oauthAttemptId)?.failure_reason, 'superseded');
  assert.equal(f.attempts.get(other.oauthAttemptId)?.status, 'active'); assert.equal(f.account(other).copilot_oauth_attempt_id, other.oauthAttemptId);
  assert.equal(f.account(a).copilot_oauth_attempt_id, next.oauthAttemptId);
  assert.equal(await getMysqlAttempt(f.connection, B, a.identity, a.oauthAttemptId), undefined);
  assert.equal(await getMysqlAttempt(f.connection, A, 'wrong-identity', a.oauthAttemptId), undefined);
});

test('MySQL global nonce cannot be rebound across enterprise/revision/incarnation/expected numeric subject', async () => {
  const f = new SqlFixture(), a = binding(), other = binding({ enterpriseId: B }); f.seed(a); f.seed(other); await f.begin(a);
  const before = f.snapshot();
  for (const wrong of [{ ...a, enterpriseRevision: 4 }, { ...a, expectedGithubUserId: '456' }, { ...other, oauthAttemptId: a.oauthAttemptId },
    { ...a, accountIncarnation: randomUUID() }, { ...a, expectedGhLogin: 'mallory_octo' }]) {
    await assert.rejects(f.begin(wrong), isScopeError('stale_authorization_binding')); assert.deepEqual(f.snapshot(), before);
  }
});

test('MySQL successful completion updates only pinned token, consumes once and accepts identical lost-ACK replay', async () => {
  const f = new SqlFixture(), a = binding(), other = binding({ enterpriseId: B }); f.seed(a); f.seed(other); await f.begin(a); await f.begin(other);
  const untouched = structuredClone(f.account(other));
  assert.equal((await f.finish(a, 'succeeded', 'synthetic-token')).outcome, 'applied');
  assert.equal(f.account(a).copilot_oauth_token, 'synthetic-token'); assert.equal(f.account(a).gh_login, a.expectedGhLogin);
  assert.equal(f.account(a).copilot_oauth_attempt_id, null); assert.equal(f.account(a).copilot_oauth_status, 'valid'); assert.deepEqual(f.account(other), untouched);
  const saved = f.snapshot(), count = writes(f).length;
  assert.equal((await f.finish(a, 'succeeded', 'synthetic-token')).outcome, 'already-succeeded');
  assert.equal(writes(f).length, count); assert.deepEqual(f.snapshot(), saved);
  await assert.rejects(f.finish(a, 'succeeded', 'conflicting-token'), isScopeError('authorization_outcome_conflict'));
  await assert.rejects(f.finish(a, 'cancelled'), isScopeError('authorization_outcome_conflict')); assert.deepEqual(f.snapshot(), saved);
  assert.ok(!JSON.stringify([...f.attempts.values()]).includes('synthetic-token'));
});

test('MySQL cancellation wins over late success; final failure reason is validated and retry cannot reopen nonce', async () => {
  for (const status of ['cancelled', 'failed'] as const) {
    const f = new SqlFixture(), a = binding(); f.seed(a); await f.begin(a);
    assert.equal((await f.finish(a, status, undefined, subject, 'login_failed')).outcome, 'applied');
    const before = f.snapshot(), count = writes(f).length;
    assert.equal((await f.finish(a, status, undefined, subject, 'login_failed')).outcome, `already-${status}`);
    await assert.rejects(f.finish(a, 'succeeded', 'late-token'), isScopeError('authorization_outcome_conflict'));
    await assert.rejects(f.begin(a), isScopeError('authorization_outcome_conflict'));
    assert.equal(writes(f).length, count); assert.deepEqual(f.snapshot(), before); assert.equal(f.account(a).copilot_oauth_token, null);
  }
  const f = new SqlFixture(), a = binding(); f.seed(a); await f.begin(a); const before = f.snapshot();
  await assert.rejects(f.finish(a, 'failed', undefined, subject, 'secret unsafe reason'), isScopeError('invalid_authorization_failure_reason'));
  assert.deepEqual(f.snapshot(), before);
});

test('MySQL stale incarnation/nonce and every tuple component reject completion without mutation', async () => {
  const f = new SqlFixture(), a = binding(), other = binding({ enterpriseId: B }); f.seed(a); f.seed(other); await f.begin(a);
  for (const patch of [{ enterpriseId: B }, { identity: 'missing' }, { enterpriseRevision: 4 }, { accountIncarnation: randomUUID() },
    { oauthAttemptId: randomUUID() }, { expectedGhLogin: 'mallory_octo' }, { expectedGithubUserId: '456' }]) {
    const before = f.snapshot(), wrong = { ...a, ...patch };
    await assert.rejects(f.finish(wrong, 'succeeded', 'token', { login: wrong.expectedGhLogin, id: wrong.expectedGithubUserId! }), isScopeError('stale_authorization_binding'));
    assert.deepEqual(f.snapshot(), before);
  }
  f.account(a).account_incarnation = randomUUID(); const recreated = f.snapshot();
  await assert.rejects(f.finish(a, 'succeeded', 'late-token'), isScopeError('stale_authorization_binding')); assert.deepEqual(f.snapshot(), recreated);
});

test('MySQL subject mismatch fails before SQL; optional subject ID never changes expected login', async () => {
  const f = new SqlFixture(), a = binding(); f.seed(a); await f.begin(a);
  const count = f.calls.length, before = f.snapshot();
  for (const wrong of [{ login: 'mallory_octo', id: subject.id }, { login: subject.login, id: '456' }, { login: subject.login, id: 'not-numeric' }]) {
    await assert.rejects(f.finish(a, 'succeeded', 'token', wrong), isScopeError('oauth_subject_mismatch'));
  }
  await assert.rejects(f.finish(a, 'succeeded', ''), isScopeError('invalid_oauth_token'));
  assert.equal(f.calls.length, count); assert.deepEqual(f.snapshot(), before);
  const optional = binding({ expectedGithubUserId: undefined }); f.seed(optional); await f.begin(optional);
  await f.finish(optional, 'succeeded', 'optional-id-token', { login: subject.login, id: '999' });
  assert.equal(f.account(optional).gh_login, subject.login); assert.equal(f.attempts.get(optional.oauthAttemptId)?.result_github_user_id, '999');
});

test('MySQL both final CAS row counts must succeed; parent transaction rolls back partial token write', async () => {
  for (const stage of ['account', 'ledger'] as const) {
    const f = new SqlFixture(), a = binding(); f.seed(a); await f.begin(a); const before = f.snapshot();
    f.beforeWrite = sql => {
      if (stage === 'account' && sql.startsWith('UPDATE proxy_accounts SET copilot_oauth_token=')) f.account(a).copilot_oauth_attempt_id = randomUUID();
      if (stage === 'ledger' && sql.startsWith('UPDATE proxy_authorization_attempts SET status=?')) f.attempts.get(a.oauthAttemptId)!.status = 'cancelled';
    };
    await assert.rejects(f.finish(a, 'succeeded', 'must-rollback-token'), isScopeError('stale_authorization_binding'));
    assert.deepEqual(f.snapshot(), before); assert.equal(f.account(a).copilot_oauth_token, null);
  }
});
