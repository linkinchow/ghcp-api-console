import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeLicense } from './package-runtime.mjs';

test('normalizes current and legacy npm license metadata', () => {
  assert.equal(normalizeLicense({ license: 'MIT' }), 'MIT');
  assert.equal(normalizeLicense({ license: ' (MIT OR Apache-2.0) ' }), '(MIT OR Apache-2.0)');
  assert.equal(normalizeLicense({ license: { type: 'BSD-3-Clause', url: 'https://example.test' } }), 'BSD-3-Clause');
  // busboy and other older packages publish `licenses: [{ type, url }]`.
  assert.equal(normalizeLicense({ licenses: [{ type: 'MIT', url: 'https://example.test' }] }), 'MIT');
  assert.equal(normalizeLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }), '(MIT OR Apache-2.0)');
  assert.equal(normalizeLicense({ licenses: ['ISC'] }), 'ISC');
});

test('missing license metadata stays null so the inventory flags it for review', () => {
  assert.equal(normalizeLicense({}), null);
  assert.equal(normalizeLicense({ license: '' }), null);
  assert.equal(normalizeLicense({ licenses: [] }), null);
  assert.equal(normalizeLicense({ licenses: [{ url: 'https://example.test' }] }), null);
});
