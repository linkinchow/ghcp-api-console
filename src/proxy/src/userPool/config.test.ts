import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCaller, readPoolConfig, UserPoolError } from './config.js';

const enabledEnv = {
  ACCOUNT_ROUTING_MODE: 'caller-lease',
  POOL_ACCOUNT_EMAIL_DOMAIN: 'accounts.example.test',
  POOL_WARMUP_MODEL: 'test-model',
};

test('caller identity accepts only the canonical authenticated SHA-256 key hash', () => {
  const caller = `sha256:${'a0'.repeat(32)}`;
  assert.equal(normalizeCaller(caller), caller);
  assert.equal(normalizeCaller(caller, 'ignored.legacy.test'), caller);
  for (const invalid of [
    '', 'alice@example.test', 'alice', 'a'.repeat(64), `SHA256:${'a'.repeat(64)}`,
    `sha256:${'A'.repeat(64)}`, `sha256:${'0'.repeat(63)}`, `sha256:${'0'.repeat(65)}`,
    `sha256:${'g'.repeat(64)}`, ` ${caller}`, `${caller}\n`, `${caller},${caller}`,
    undefined, null, [caller],
  ]) {
    assert.throws(() => normalizeCaller(invalid as string), (error: unknown) => {
      return error instanceof UserPoolError && error.status === 403 && error.code === 'invalid_caller_identity';
    });
  }
});

test('pool defaults are 5-minute provisional and 48-hour success leases with no caller domain', () => {
  const options = readPoolConfig(enabledEnv);
  assert.equal(options.enabled, true);
  assert.equal(options.callerDomain, undefined);
  assert.equal(options.accountDomain, 'accounts.example.test');
  assert.equal(options.provisionalSeconds, 300);
  assert.equal(options.leaseSeconds, 172800);
  assert.equal(options.requestTimeoutMs, 120000);
  assert.equal(options.idleTarget, 10);
  assert.equal(options.maxAccounts, 100);
  assert.equal(options.prewarmConcurrency, 5);
  assert.equal(readPoolConfig({ ...enabledEnv, POOL_CALLER_EMAIL_DOMAIN: 'not an email' }).enabled, true);
});

test('direct mode ignores all pool-only settings and does not restrict storage', () => {
  const direct = readPoolConfig({
    STORAGE_DRIVER: 'mysql', READY_IDLE_TARGET: '-1', POOL_MAX_ACCOUNTS: 'bad',
    POOL_ACCOUNT_EMAIL_DOMAIN: 'bad', POOL_REQUEST_TIMEOUT_SECONDS: 'bad',
  });
  assert.equal(direct.enabled, false);
  assert.deepEqual(direct, readPoolConfig({ ACCOUNT_ROUTING_MODE: 'direct' }));
  assert.throws(() => readPoolConfig({ ACCOUNT_ROUTING_MODE: 'other' }), /ACCOUNT_ROUTING_MODE/);
  for (const driver of ['mysql', 'postgres', 'SQLite']) {
    assert.throws(() => readPoolConfig({ ...enabledEnv, STORAGE_DRIVER: driver }), /single-instance SQLite/);
  }
});

test('account domain is configurable and strictly validates DNS labels', () => {
  assert.equal(readPoolConfig({ ...enabledEnv, POOL_ACCOUNT_EMAIL_DOMAIN: ' Accts.Sub.Example.COM ' }).accountDomain,
    'accts.sub.example.com');
  for (const domain of ['', 'localhost', 'user@example.test', '.example.test', 'a..test',
    'a-.test', '-a.test', 'a_b.test', 'a.test.', 'a.12', `${'a'.repeat(64)}.test`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`]) {
    assert.throws(() => readPoolConfig({ ...enabledEnv, POOL_ACCOUNT_EMAIL_DOMAIN: domain }), /email domain/);
  }
  assert.throws(() => readPoolConfig({ ...enabledEnv, POOL_WARMUP_MODEL: ' ' }), /POOL_WARMUP_MODEL/);
});

test('integer options reject coercion and respect all bounds', () => {
  for (const value of ['', ' ', '10\n', '10\r', '1.5', '1e2', '0x10', '-1', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => readPoolConfig({ ...enabledEnv, POOL_MAX_ACCOUNTS: value }), /POOL_MAX_ACCOUNTS/);
  }
  for (const [key, min, max] of [
    ['READY_IDLE_TARGET', 0, 10000], ['POOL_MAX_ACCOUNTS', 1, 10000],
    ['CALLER_LEASE_TTL_SECONDS', 60, 2592000], ['PROVISIONAL_LEASE_TTL_SECONDS', 10, 3600],
    ['PREWARM_POLL_SECONDS', 1, 3600], ['POOL_EXHAUSTED_RETRY_AFTER_SECONDS', 1, 3600],
    ['POOL_REQUEST_TIMEOUT_SECONDS', 5, 600], ['PREWARM_CONCURRENCY', 1, 20],
  ] as const) {
    const env = { ...enabledEnv, READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '10000' };
    assert.doesNotThrow(() => readPoolConfig({ ...env, [key]: String(min) }));
    assert.doesNotThrow(() => readPoolConfig({ ...env, [key]: String(max) }));
    assert.throws(() => readPoolConfig({ ...env, [key]: String(min - 1) }), new RegExp(key));
    assert.throws(() => readPoolConfig({ ...env, [key]: String(max + 1) }), new RegExp(key));
  }
  assert.throws(() => readPoolConfig({ ...enabledEnv, READY_IDLE_TARGET: '11', POOL_MAX_ACCOUNTS: '10' }),
    /Idle target exceeds/);
});
