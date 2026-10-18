import type { UserPoolCounts, UserPoolLimits, UserPoolSettings, UserPoolSettingsChanges } from '../api/userPool.js';

export interface UserPoolSettingsDraft {
  idleTarget: string;
  leaseSeconds: string;
  paused: boolean;
}
export function poolSettingsDraft(settings: UserPoolSettings): UserPoolSettingsDraft {
  return {
    idleTarget: String(settings.idle_target),
    leaseSeconds: String(settings.lease_seconds),
    paused: settings.paused === 1,
  };
}
function readWholeNumber(raw: string, label: string, min: number, max: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}
/** Global settings only: each enterprise's cap is edited through its pool policy. */
export function parsePoolSettingsDraft(draft: UserPoolSettingsDraft, limits: UserPoolLimits): UserPoolSettingsChanges {
  const idle_target = readWholeNumber(draft.idleTarget, 'Idle target', 0, limits.maxAccounts);
  const { minLeaseSeconds, maxLeaseSeconds } = limits;
  const lease_seconds = readWholeNumber(draft.leaseSeconds, 'Lease TTL', minLeaseSeconds, maxLeaseSeconds);
  return { idle_target, lease_seconds, paused: draft.paused ? 1 : 0 };
}
/** Whole-pool warnings for the overview; per-enterprise caps are shown in the enterprise table. */
export function poolWarnings(counts: UserPoolCounts, settings: UserPoolSettings): string[] {
  const warnings: string[] = [];
  const missing = settings.idle_target - counts.ready_idle;
  if (missing > 0) {
    warnings.push(`Low idle capacity: ${counts.ready_idle} ready idle; target ${settings.idle_target}. `
      + `${missing} more account(s) are needed to reach the target.`);
  }
  if (counts.ready_idle === 0) {
    warnings.push('No ready idle accounts. New caller keys cannot acquire an account '
      + 'until capacity becomes available.');
  }
  if (settings.paused) {
    warnings.push('Prewarming is paused. Existing leases and ready accounts remain usable, '
      + 'but provisioning will not advance until resumed.');
  }
  return warnings;
}
export function formatCallerKeyHash(value: string | null): string | null {
  return value && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value) ? `${value.slice(0, 19)}…${value.slice(-8)}` : null;
}
export function poolDate(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}
