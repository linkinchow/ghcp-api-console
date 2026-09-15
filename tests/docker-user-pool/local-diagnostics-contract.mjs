import { check } from './mysql-smoke.mjs';

function keys(value, required, optional, label) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), label);
}
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => Number.isSafeInteger(value) && value > 0;

export function validateLocalDiagnostics(value) {
  keys(value, ['enabled', 'poolId', 'observedAt', 'scope', 'localScheduler'], [], 'diagnostics_envelope_fields');
  check(value.enabled === true && value.poolId === 'default' && value.scope === 'local_process' && timestamp(value.observedAt), 'diagnostics_envelope_values');
  const snapshot = value.localScheduler;
  keys(snapshot, ['scope', 'state', 'observedAtUnixMs', 'localTenureAgeMs', 'lastSuccessfulRenewalAtUnixMs',
    'lastSuccessfulRenewalAgeMs', 'claimAttempts', 'ownershipAcquisitions', 'ownershipLosses', 'lastOwnershipLoss'], [], 'diagnostics_snapshot_fields');
  check(snapshot.scope === 'local_process' && ['owner', 'standby', 'stopped'].includes(snapshot.state), 'diagnostics_scope_state');
  check(timestamp(snapshot.observedAtUnixMs), 'diagnostics_observed_time');
  check(snapshot.localTenureAgeMs === null || nonnegative(snapshot.localTenureAgeMs), 'diagnostics_tenure_age');
  check(snapshot.lastSuccessfulRenewalAtUnixMs === null || timestamp(snapshot.lastSuccessfulRenewalAtUnixMs), 'diagnostics_renewal_time');
  check(snapshot.lastSuccessfulRenewalAgeMs === null || nonnegative(snapshot.lastSuccessfulRenewalAgeMs), 'diagnostics_renewal_age');
  check((snapshot.lastSuccessfulRenewalAtUnixMs === null) === (snapshot.lastSuccessfulRenewalAgeMs === null), 'diagnostics_renewal_pair');
  for (const key of ['claimAttempts', 'ownershipAcquisitions', 'ownershipLosses']) {
    check(Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0, 'diagnostics_counter');
  }
  if (snapshot.lastOwnershipLoss !== null) {
    keys(snapshot.lastOwnershipLoss, ['reason', 'atUnixMs'], ['storageFailure'], 'diagnostics_loss_fields');
    check(['local_tenure_expired', 'renewal_rejected', 'storage_unavailable', 'storage_operation_failed'].includes(snapshot.lastOwnershipLoss.reason), 'diagnostics_reason');
    check(timestamp(snapshot.lastOwnershipLoss.atUnixMs), 'diagnostics_loss_time');
    check(!Object.hasOwn(snapshot.lastOwnershipLoss, 'storageFailure') || ['deadline', 'connection'].includes(snapshot.lastOwnershipLoss.storageFailure), 'diagnostics_storage_failure');
  }
}
