import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalDiagnostics } from './local-diagnostics-contract.mjs';

const valid = () => ({ enabled: true, poolId: 'default', observedAt: 1000, scope: 'local_process', localScheduler: {
  scope: 'local_process', state: 'standby', observedAtUnixMs: 1000, localTenureAgeMs: null,
  lastSuccessfulRenewalAtUnixMs: 900, lastSuccessfulRenewalAgeMs: 100.5,
  claimAttempts: 2, ownershipAcquisitions: 1, ownershipLosses: 1,
  lastOwnershipLoss: { reason: 'storage_unavailable', storageFailure: 'deadline', atUnixMs: 950 },
} });

test('diagnostics contract accepts populated and not-yet-renewed snapshots', () => {
  validateLocalDiagnostics(valid());
  const value = valid();
  Object.assign(value.localScheduler, { lastSuccessfulRenewalAtUnixMs: null, lastSuccessfulRenewalAgeMs: null, lastOwnershipLoss: null });
  validateLocalDiagnostics(value);
});

test('diagnostics contract rejects every missing required field and extra fields', () => {
  for (const section of ['', 'localScheduler', 'lastOwnershipLoss']) {
    const get = value => section === '' ? value : section === 'localScheduler' ? value.localScheduler : value.localScheduler.lastOwnershipLoss;
    for (const key of Object.keys(get(valid())).filter(key => key !== 'storageFailure')) {
      const value = valid(); delete get(value)[key];
      assert.throws(() => validateLocalDiagnostics(value), `${section}.${key}`);
    }
    const value = valid(); get(value).secret = 'not-allowed';
    assert.throws(() => validateLocalDiagnostics(value));
  }
});

test('diagnostics contract rejects malformed timestamps ages and counters', () => {
  for (const key of ['observedAtUnixMs', 'localTenureAgeMs', 'lastSuccessfulRenewalAtUnixMs', 'lastSuccessfulRenewalAgeMs',
    'claimAttempts', 'ownershipAcquisitions', 'ownershipLosses']) {
    for (const invalid of ['1', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const value = valid(); value.localScheduler[key] = invalid;
      assert.throws(() => validateLocalDiagnostics(value), key);
    }
  }
  for (const invalid of [undefined, '1', 0, -1]) {
    const value = valid(); value.observedAt = invalid;
    assert.throws(() => validateLocalDiagnostics(value));
    const loss = valid(); loss.localScheduler.lastOwnershipLoss.atUnixMs = invalid;
    assert.throws(() => validateLocalDiagnostics(loss));
  }
});
