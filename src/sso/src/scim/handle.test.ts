import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHandle } from './handle.js';

test('appends the enterprise shortcode on GitHub.com and keeps the 39 character limit', () => {
  assert.equal(normalizeHandle('alice', 'octo'), 'alice_octo');
  assert.equal(normalizeHandle('Mona.Lisa@example.com', 'octo'), 'mona-lisa_octo');
  const login = normalizeHandle('a'.repeat(40), 'octo');
  assert.equal(login, `${'a'.repeat(34)}_octo`);
  assert.equal(login.length, 39);
});

test('uses the plain username without a suffix on GHE.com and keeps the 30 character limit', () => {
  assert.equal(normalizeHandle('alice', ''), 'alice');
  assert.equal(normalizeHandle('mona.lisa@example.com', ''), 'mona-lisa');
  assert.equal(normalizeHandle('a'.repeat(32), ''), 'a'.repeat(30));
  assert.equal(normalizeHandle(`${'a'.repeat(29)}-b`, ''), 'a'.repeat(29));
});
