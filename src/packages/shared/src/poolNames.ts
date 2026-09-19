import catalog from './poolNameCatalog.json' with { type: 'json' };

export const NAME_BASE_COUNT = 5000;
export const NAME_SUFFIX_COUNT = 2;
export const NAME_CAPACITY = NAME_BASE_COUNT * NAME_SUFFIX_COUNT;
export const LEGACY_NAME_BASE_COUNT = 1000;
export const NAME_CATALOG_VERSION = 'synthetic-5000-v2' as const;

if (catalog.length !== NAME_BASE_COUNT || new Set(catalog).size !== NAME_BASE_COUNT
  || catalog.some(name => !/^[a-z]+\.[a-z]+$/.test(name) || name.length > 62)) {
  throw new Error('Invalid synthetic account name catalog');
}

export function accountName(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= NAME_CAPACITY) throw new Error('Name catalog exhausted');
  return `${catalog[ordinal % NAME_BASE_COUNT]}${String(Math.floor(ordinal / NAME_BASE_COUNT)).padStart(2, '0')}`;
}

export class PoolNameCatalogCompatibilityError extends Error {
  readonly code = 'name_catalog_upgrade_required';
  constructor() {
    super('name_catalog_upgrade_required: Existing inventory or consumed ordinals are incompatible with the 5000-base catalog. Keep the previous runtime and arrange an offline identity-preserving migration; never reset the cursor or rename existing accounts.');
    this.name = 'PoolNameCatalogCompatibilityError';
  }
}
export interface PoolNameInventoryRow { identity: unknown; ordinal: unknown; sso_user: unknown }

/** Read-only startup/offline preflight. Ordinals are global, not per enterprise.
 * This deliberately rejects legacy suffix rows instead of accepting two meanings
 * for one ordinal. No persistent schema/version/fingerprint is rewritten.
 */
export function assertPoolNameCatalogCompatible(nextOrdinal: number, inventory: readonly PoolNameInventoryRow[]): void {
  const fail = (): never => { throw new PoolNameCatalogCompatibilityError(); };
  if (!Number.isSafeInteger(nextOrdinal) || nextOrdinal < 0 || nextOrdinal > NAME_CAPACITY || inventory.length > NAME_CAPACITY) fail();
  const ordinals = new Set<number>(), identities = new Set<string>();
  let newCatalogWitness = false;
  for (const row of inventory) {
    if (typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || row.ordinal >= nextOrdinal
      || typeof row.identity !== 'string' || row.identity !== accountName(row.ordinal) || row.sso_user !== row.identity
      || ordinals.has(row.ordinal) || identities.has(row.identity)) fail();
    ordinals.add(row.ordinal as number); identities.add(row.identity as string);
    if ((row.ordinal as number) >= LEGACY_NAME_BASE_COUNT) newCatalogWitness = true;
  }
  // A cursor can advance solely by collision skips. With no new-catalog row we
  // cannot distinguish such a run from an old catalog's consumed-name history.
  if (nextOrdinal > LEGACY_NAME_BASE_COUNT && !newCatalogWitness) fail();
}
