import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseLine } from './releaseLine.js';

test('the release line defaults to single and otherwise reports GHCP_RELEASE_LINE', () => {
  assert.equal(releaseLine({}), 'single');
  assert.equal(releaseLine({ GHCP_RELEASE_LINE: '' }), 'single');
  assert.equal(releaseLine({ GHCP_RELEASE_LINE: ' multi\n' }), 'multi');
  assert.equal(releaseLine({ GHCP_RELEASE_LINE: 'single' }), 'single');
});
