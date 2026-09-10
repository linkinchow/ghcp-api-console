import type { UserPoolCounts, UserPoolLimits, UserPoolSettings, UserPoolSettingsChanges } from '../api/userPool.js';

export interface UserPoolSettingsDraft {
  idleTarget: string;
  maxAccounts: string;
  leaseSeconds: string;
  paused: boolean;
}
export function poolSettingsDraft(settings: UserPoolSettings): UserPoolSettingsDraft {
  return { idleTarget: String(settings.idle_target), maxAccounts: String(settings.max_accounts), leaseSeconds: String(settings.lease_seconds), paused: settings.paused === 1 };
}
export function parsePoolSettingsDraft(draft: UserPoolSettingsDraft, limits: UserPoolLimits): UserPoolSettingsChanges {
  const read = (raw: string, label: string, min: number, max: number) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    }
    return value;
  };
  const idle_target = read(draft.idleTarget, 'Idle target', 0, limits.maxAccounts);
  const max_accounts = read(draft.maxAccounts, 'Maximum accounts', 1, limits.maxAccounts);
  const lease_seconds = read(draft.leaseSeconds, 'Lease TTL', limits.minLeaseSeconds, limits.maxLeaseSeconds);
  if (idle_target > max_accounts) throw new Error('Idle target cannot exceed maximum accounts.');
  return { idle_target, max_accounts, lease_seconds, paused: draft.paused ? 1 : 0 };
}
export function poolWarnings(counts: UserPoolCounts, settings: UserPoolSettings): string[] {
  const warnings: string[] = [];
  if (counts.ready_idle < settings.idle_target) {
    warnings.push(`Low idle capacity: ${counts.ready_idle} ready idle; target ${settings.idle_target}. ${settings.idle_target - counts.ready_idle} more account(s) are needed to reach the target.`);
  }
  if (counts.ready_idle === 0) warnings.push('No ready idle accounts. New caller keys cannot acquire an account until capacity becomes available.');
  if (settings.paused) warnings.push('Prewarming is paused. Existing leases and ready accounts remain usable, but provisioning will not advance until resumed.');
  if (counts.total >= settings.max_accounts && counts.ready_idle < settings.idle_target) {
    warnings.push('The account cap has been reached. Review failed or disabled accounts, release idle leases, or increase the cap; no accounts are deleted automatically.');
  }
  return warnings;
}
export function formatCallerKeyHash(value: string | null): string | null {
  return value && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value) ? `${value.slice(0, 19)}…${value.slice(-8)}` : null;
}
export function poolDate(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}
