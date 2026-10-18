import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseLifecycleState } from '@ghcp/shared';
import type { EnterpriseListItem } from '../api/enterprises.js';
import {
  blockerCodes, enterpriseShares, formatShare, lifecycleActions, nameCapacityRemaining, targetState,
} from './enterprisePool.js';

function item(id: string, state: EnterpriseLifecycleState | null, maxAccounts = 0, inventory = 0): EnterpriseListItem {
  const pool = state === null ? null : {
    enterpriseId: id, state, maxAccounts, inventory, policyVersion: 1, updatedAt: '2026-10-01T00:00:00.000Z',
  };
  return {
    id, displayName: id, githubBaseUrl: 'https://example.test', slug: id, shortcode: '', pool,
    readiness: null, poolSummary: null, shareScore: null,
  };
}

test('shares are computed among active enterprises only', () => {
  const items = [item('a', 'active', 30, 10), item('b', 'active', 10, 30), item('c', 'draft', 50), item('d', null)];
  const shares = enterpriseShares(items);
  assert.deepEqual(shares.get('a'), { target: 0.75, actual: 0.25 });
  assert.deepEqual(shares.get('b'), { target: 0.25, actual: 0.75 });
  assert.deepEqual(shares.get('c'), { target: null, actual: null });
  assert.deepEqual(shares.get('d'), { target: null, actual: null });
  assert.deepEqual(enterpriseShares([item('a', 'active', 5, 0)]).get('a'), { target: 1, actual: null });
  assert.equal(formatShare(0.755), '75.5%');
  assert.equal(formatShare(null), '—');
});

test('name capacity counts the caps of every enterprise, including drafts and draining ones', () => {
  const items = [item('a', 'active', 4000), item('b', 'draft', 3000), item('c', 'draining', 2500), item('d', null)];
  assert.equal(nameCapacityRemaining({ items, nameCapacity: 10000 }), 500);
  assert.equal(nameCapacityRemaining({ items: [item('a', 'active', 12000)], nameCapacity: 10000 }), 0);
});

test('lifecycle offers activate for drafts, drain for active and resume for draining', () => {
  assert.deepEqual(lifecycleActions('draft'), ['activate']);
  assert.deepEqual(lifecycleActions('active'), ['drain']);
  assert.deepEqual(lifecycleActions('draining'), ['resume']);
  assert.equal(targetState('activate'), 'active');
  assert.equal(targetState('resume'), 'active');
  assert.equal(targetState('drain'), 'draining');
});

test('only plain readiness codes are shown from error details', () => {
  const details = { blockers: ['sso_missing', 'login:github_base_url_mismatch', '<img src=x>', 'https://x.test/a', 7] };
  assert.deepEqual(blockerCodes(details), { codes: ['sso_missing', 'login:github_base_url_mismatch'], hidden: 3 });
  assert.deepEqual(blockerCodes(undefined), { codes: [], hidden: 0 });
  assert.deepEqual(blockerCodes({ blockers: 'sso_missing' }), { codes: [], hidden: 0 });
});
