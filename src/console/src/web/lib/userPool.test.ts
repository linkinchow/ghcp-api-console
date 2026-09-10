import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCallerKeyHash, parsePoolSettingsDraft, poolSettingsDraft, poolWarnings } from './userPool.js';

const limits = { maxAccounts: 10000, minLeaseSeconds: 60, maxLeaseSeconds: 2592000 };
const settings = { version: 4, idle_target: 5, max_accounts: 20, lease_seconds: 172800, paused: 0 };

test('pool settings draft preserves zero and validates whole numbers without coercing empty fields', () => {
  const draft = poolSettingsDraft(settings);
  assert.deepEqual(parsePoolSettingsDraft(draft, limits), { idle_target: 5, max_accounts: 20, lease_seconds: 172800, paused: 0 });
  assert.equal(parsePoolSettingsDraft({ ...draft, idleTarget: '0', paused: true }, limits).paused, 1);
  for (const value of ['', ' ', '-1', '1.5', '1e2', 'NaN', '10001']) {
    assert.throws(() => parsePoolSettingsDraft({ ...draft, idleTarget: value }, limits));
  }
  assert.throws(() => parsePoolSettingsDraft({ ...draft, idleTarget: '21' }, limits), /cannot exceed/);
  assert.throws(() => parsePoolSettingsDraft({ ...draft, maxAccounts: '0' }, limits));
  assert.throws(() => parsePoolSettingsDraft({ ...draft, leaseSeconds: '59' }, limits));
});

test('caller display accepts only exact authenticated key hashes, never aliases or emails', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  assert.equal(formatCallerKeyHash(hash), 'sha256:aaaaaaaaaaaa…aaaaaaaa');
  for (const value of [null, '', 'alice', 'alice@example.test', 'sk-secret', ` ${hash}`, `${hash}\n`, hash.toUpperCase(), hash.slice(0, -1)]) {
    assert.equal(formatCallerKeyHash(value), null, String(value));
  }
});

test('capacity warnings distinguish idle shortage, exhaustion, pause, and account cap', () => {
  const counts = { total: 20, ready_idle: 0, leased: 15, provisional: 0, provisioning: 1, cooling: 1, failed: 2, disabled: 1 };
  const warnings = poolWarnings(counts, { ...settings, paused: 1 });
  assert.equal(warnings.length, 4);
  assert.match(warnings[0]!, /Low idle capacity/);
  assert.match(warnings[1]!, /No ready idle/);
  assert.match(warnings[2]!, /paused/);
  assert.match(warnings[3]!, /cap/);
  assert.deepEqual(poolWarnings({ ...counts, ready_idle: 5 }, settings), []);
  assert.equal(poolWarnings({ ...counts, ready_idle: 0 }, { ...settings, idle_target: 0 }).length, 1);
});
