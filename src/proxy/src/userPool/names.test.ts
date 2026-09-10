import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import catalog from './nameCatalog.json' with { type: 'json' };
import { accountName, NAME_BASE_COUNT, NAME_CAPACITY, NAME_SUFFIX_COUNT } from './names.js';

test('1000 fixed synthetic bases produce exactly 10000 distinct account names', () => {
  assert.equal(NAME_BASE_COUNT, 1000);
  assert.equal(NAME_SUFFIX_COUNT, 10);
  assert.equal(NAME_CAPACITY, 10000);
  assert.equal(catalog.length, 1000);
  assert.equal(new Set(catalog).size, 1000);
  const names = Array.from({ length: NAME_CAPACITY }, (_, ordinal) => accountName(ordinal));
  assert.equal(new Set(names).size, 10000);
  for (const name of names) {
    assert.match(name, /^[a-z]+\.[a-z]+0[0-9]$/);
    assert.ok(name.length <= 64);
  }
  for (let suffix = 0; suffix < NAME_SUFFIX_COUNT; suffix++) {
    for (let base = 0; base < NAME_BASE_COUNT; base++) {
      assert.equal(accountName(suffix * NAME_BASE_COUNT + base), `${catalog[base]}0${suffix}`);
    }
  }
});

test('catalog order is a persistent ordinal contract', () => {
  assert.equal(accountName(0), 'aaliyah.abbott00');
  assert.equal(accountName(999), 'emmanuelle.corkery00');
  assert.equal(accountName(1000), 'aaliyah.abbott01');
  assert.equal(accountName(9999), 'emmanuelle.corkery09');
  const json = readFileSync(new URL('./nameCatalog.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(createHash('sha256').update(json).digest('hex'),
    '300b019ad4ed10c25071af2e8105b6fc556bfb4378bf77d3cddd90f5858951b5');
});

test('invalid ordinals never wrap or reuse a reserved name', () => {
  for (const ordinal of [-1, 10000, 10001, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => accountName(ordinal), /Name catalog exhausted/);
  }
});
