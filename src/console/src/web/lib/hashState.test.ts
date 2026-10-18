import assert from 'node:assert/strict';
import test from 'node:test';
import { hashFor, listHash, readHash } from './hashState.js';
import { readListQuery } from './management.js';

test('the hash carries the page, the enterprise and the page query separately', () => {
  const state = readHash('#/users?e=ghe-tenant&status=active&page=2');
  assert.equal(state.page, 'users');
  assert.equal(state.enterpriseId, 'ghe-tenant');
  assert.equal(state.params.toString(), 'status=active&page=2');
  assert.equal(readListQuery('#/users?e=ghe-tenant&status=active').status, 'active');
});

test('legacy and empty hashes still parse; no enterprise means the UI picks its own default', () => {
  assert.deepEqual(readHash('#tasks?status=failed').page, 'tasks');
  assert.equal(readHash('#tasks?status=failed').enterpriseId, undefined);
  assert.equal(readHash('').page, '');
  assert.equal(readHash('#/models?e=').enterpriseId, undefined);
});

test('hashFor puts the enterprise first and never duplicates it from the page query', () => {
  assert.equal(hashFor('users', 'default'), '#/users?e=default');
  assert.equal(hashFor('dashboard'), '#/dashboard');
  assert.equal(hashFor('tasks', 'b', 'e=a&status=failed'), '#/tasks?e=b&status=failed');
  const round = readHash(hashFor('stats', 'ghe-tenant', new URLSearchParams({ success: 'false' })));
  assert.equal(round.enterpriseId, 'ghe-tenant');
  assert.equal(round.params.get('success'), 'false');
});

test('list navigation keeps the enterprise already in the location', () => {
  assert.equal(listHash('users', 'page=2&q=x', '#/users?e=ghe-tenant&page=1'), '#/users?e=ghe-tenant&page=2&q=x');
  assert.equal(listHash('users', 'page=1', '#users'), '#/users?page=1');
});
