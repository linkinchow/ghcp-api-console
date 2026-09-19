import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import catalog from './nameCatalog.json' with { type: 'json' };
import { accountName, NAME_BASE_COUNT, NAME_CAPACITY, NAME_SUFFIX_COUNT } from './names.js';
import { assertPoolNameCatalogCompatible, PoolNameCatalogCompatibilityError } from '@ghcp/shared/poolNames';

const frozenPath = new URL('../../../../upgrade/v1-frozen/userPool/nameCatalog.json', import.meta.url);
const frozenText = readFileSync(frozenPath, 'utf8').replaceAll('\r\n', '\n');
const frozen: string[] = JSON.parse(frozenText);
const inventory = (ordinal: number) => ({ ordinal, identity: accountName(ordinal), sso_user: accountName(ordinal) });

test('5000 append-only bases produce exactly 10000 distinct casefolded and GitHub-normalized names', () => {
  assert.equal(NAME_BASE_COUNT, 5000); assert.equal(NAME_SUFFIX_COUNT, 2); assert.equal(NAME_CAPACITY, 10000);
  assert.equal(catalog.length, 5000); assert.equal(new Set(catalog).size, 5000);
  assert.deepEqual(catalog.slice(0, 1000), frozen);
  assert.equal([...new Set(catalog.map(name => name[0]))].sort().join(''), 'abcdefghijklmnopqrstuvwxyz');
  const additions = catalog.slice(1000);
  assert.equal(additions.length, 4000);
  assert.deepEqual(additions, [...additions].sort(), 'all appended bases form one F-Z sequence');
  assert.deepEqual(frozen, [...frozen].sort(), 'original A-E prefix already has lexical order');
  assert.deepEqual(catalog, [...catalog].sort(), 'whole catalog is A-Z without reordering the original prefix');
  for (const letter of 'fghijklmnopqrstuvwxyz') {
    const count = additions.filter(name => name[0] === letter).length;
    assert.ok(count === 190 || count === 191);
  }
  const names = Array.from({ length: NAME_CAPACITY }, (_, ordinal) => accountName(ordinal));
  assert.equal(new Set(names).size, 10000); assert.equal(new Set(names.map(name => name.toLowerCase())).size, 10000);
  // The longest allowed enterprise shortcode is eight characters, leaving 30
  // local handle chars; this matches the SSO normalizer's punctuation/truncation.
  const normalized = names.map(name => `${name.replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/-+$/g, '')}_abcdefgh`);
  assert.equal(new Set(normalized).size, 10000);
  for (const name of names) { assert.match(name, /^[a-z]+\.[a-z]+0[0-1]$/); assert.ok(name.length <= 64); }
  for (let suffix = 0; suffix < NAME_SUFFIX_COUNT; suffix++) for (let base = 0; base < NAME_BASE_COUNT; base++) {
    assert.equal(accountName(suffix * NAME_BASE_COUNT + base), `${catalog[base]}0${suffix}`);
  }
});

test('frozen prefix order and reproducible compatibility copy are pinned', () => {
  assert.equal(accountName(0), 'aaliyah.abbott00'); assert.equal(accountName(999), 'emmanuelle.corkery00');
  assert.equal(accountName(1000), `${catalog[1000]}00`); assert.equal(accountName(5000), 'aaliyah.abbott01');
  assert.equal(accountName(4999), `${catalog[4999]}00`);
  assert.equal(accountName(9999), `${catalog[4999]}01`);
  assert.equal(createHash('sha256').update(frozenText).digest('hex'), '300b019ad4ed10c25071af2e8105b6fc556bfb4378bf77d3cddd90f5858951b5');
  const local = readFileSync(new URL('./nameCatalog.json', import.meta.url));
  assert.deepEqual(local, readFileSync(new URL('../../../packages/shared/src/poolNameCatalog.json', import.meta.url)));
  execFileSync(process.execPath, [fileURLToPath(new URL('../../../../scripts/generate-pool-name-catalog.mjs', import.meta.url)), '--check'], { stdio: 'pipe' });
});

test('compatibility guard preserves prefix inventories and accepts genuine new-catalog restarts at full capacity', () => {
  assertPoolNameCatalogCompatible(0, []);
  assertPoolNameCatalogCompatible(40, Array.from({ length: 40 }, (_, index) => inventory(index)));
  assertPoolNameCatalogCompatible(1000, [inventory(0), inventory(999)]);
  assertPoolNameCatalogCompatible(1001, [inventory(0), inventory(1000)]);
  assertPoolNameCatalogCompatible(10000, Array.from({ length: 10000 }, (_, index) => inventory(index)));
});

test('compatibility guard rejects old suffix rows, mixed interpretations and ambiguous consumed cursor without rewriting', () => {
  const old = { ordinal: 1000, identity: 'aaliyah.abbott01', sso_user: 'aaliyah.abbott01' };
  for (const [cursor, rows] of [
    [1001, [old]], [5001, [old, inventory(5000)]], [1001, [inventory(0)]], [10000, []],
    [1, [inventory(1)]], [2, [inventory(0), inventory(0)]], [10001, []], [-1, []], [0.5, []],
    [1, [{ ...inventory(0), sso_user: 'other' }]], [1, [{ ...inventory(0), ordinal: '0' }]],
    [10000, Array.from({ length: 10001 }, () => inventory(0))],
  ] as Array<[number, unknown[]]>) {
    const original = structuredClone(rows);
    assert.throws(() => assertPoolNameCatalogCompatible(cursor, rows as never), PoolNameCatalogCompatibilityError);
    assert.deepEqual(rows, original);
  }
});

test('invalid ordinals never wrap or reuse a reserved name', () => {
  for (const ordinal of [-1, 10000, 10001, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => accountName(ordinal), /Name catalog exhausted/);
  }
});
