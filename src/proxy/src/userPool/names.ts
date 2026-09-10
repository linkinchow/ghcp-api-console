import catalog from './nameCatalog.json' with { type: 'json' };

export const NAME_BASE_COUNT = 1000;
export const NAME_SUFFIX_COUNT = 10;
export const NAME_CAPACITY = NAME_BASE_COUNT * NAME_SUFFIX_COUNT;

// Ordinals are persisted in SQLite. Never reorder this checked-in synthetic catalog.
if (catalog.length !== NAME_BASE_COUNT || new Set(catalog).size !== NAME_BASE_COUNT
  || catalog.some((name) => !/^[a-z]+\.[a-z]+$/.test(name) || name.length > 62)) {
  throw new Error('Invalid synthetic account name catalog');
}

export function accountName(ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= NAME_CAPACITY) {
    throw new Error('Name catalog exhausted');
  }
  const base = catalog[ordinal % NAME_BASE_COUNT];
  const suffix = String(Math.floor(ordinal / NAME_BASE_COUNT)).padStart(2, '0');
  return `${base}${suffix}`;
}
