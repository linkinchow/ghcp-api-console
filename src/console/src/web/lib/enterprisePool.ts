import type { EnterpriseLifecycleState } from '@ghcp/shared';
import type { EnterpriseList, EnterpriseListItem } from '../api/enterprises.js';

export type LifecycleAction = 'activate' | 'drain' | 'resume';

export interface EnterpriseShares {
  /** C_e / ΣC over active enterprises. */
  target: number | null;
  /** N_e / ΣN over active enterprises. */
  actual: number | null;
}

const BLOCKER_CODE = /^[a-z0-9_.:-]{1,80}$/i;

function activePools(items: readonly EnterpriseListItem[]) {
  return items.flatMap((item) => item.pool?.state === 'active' ? [item.pool] : []);
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Scheduling shares; `null` for enterprises that are not active or when nothing is active. */
export function enterpriseShares(items: readonly EnterpriseListItem[]): Map<string, EnterpriseShares> {
  const active = activePools(items);
  const caps = active.reduce((sum, pool) => sum + pool.maxAccounts, 0);
  const inventory = active.reduce((sum, pool) => sum + pool.inventory, 0);
  const shares = new Map<string, EnterpriseShares>();
  for (const item of items) {
    const pool = item.pool?.state === 'active' ? item.pool : undefined;
    shares.set(item.id, {
      target: pool ? ratio(pool.maxAccounts, caps) : null,
      actual: pool ? ratio(pool.inventory, inventory) : null,
    });
  }
  return shares;
}

/** Names left for cap increases: the catalog is shared, and Proxy enforces ΣC_e ≤ capacity over all enterprises. */
export function nameCapacityRemaining(list: EnterpriseList): number {
  const caps = list.items.reduce((sum, item) => sum + (item.pool?.maxAccounts ?? 0), 0);
  return Math.max(0, list.nameCapacity - caps);
}

export function lifecycleActions(state: EnterpriseLifecycleState): LifecycleAction[] {
  if (state === 'draft') return ['activate'];
  if (state === 'active') return ['drain'];
  return ['resume'];
}

export function targetState(action: LifecycleAction): EnterpriseLifecycleState {
  return action === 'drain' ? 'draining' : 'active';
}

/** Readiness blocker codes from an `enterprise_not_ready` error; anything that is not a plain code is dropped. */
export function blockerCodes(details: unknown): { codes: string[]; hidden: number } {
  const raw = details && typeof details === 'object' ? Reflect.get(details, 'blockers') : undefined;
  const values: unknown[] = Array.isArray(raw) ? raw : [];
  const codes = values.filter((value): value is string => typeof value === 'string' && BLOCKER_CODE.test(value));
  return { codes, hidden: values.length - codes.length };
}

export function formatShare(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function poolCount(item: EnterpriseListItem, key: string): number | null {
  const value = item.poolSummary?.[key];
  return typeof value === 'number' ? value : null;
}
