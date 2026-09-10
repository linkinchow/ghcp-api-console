import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:17400', mock = 'http://127.0.0.1:17402';
const headers = { 'X-Internal-Token': 'local-pool-internal-test-only', 'Content-Type': 'application/json' };
async function get(url) { const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return response.json(); }
async function poll(fn, predicate, timeout = 120000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); } while (Date.now() < end);
  throw new Error('Timed out waiting for concurrent provisioning');
}
await poll(async () => { try { return await get(base + '/healthz'); } catch { return {}; } }, value => value.status === 'ok');
const start = await get(base + '/api/user-pool');
assert.equal(start.counts.total, 0, 'Run only against fresh concurrent test project');
const response = await fetch(base + '/api/user-pool/settings', { method: 'PATCH', headers,
  body: JSON.stringify({ expectedVersion: start.settings.version, changes: { idle_target: 20, max_accounts: 20 } }) });
assert.equal(response.status, 200);
const reserved = await get(base + '/api/user-pool');
assert.equal(reserved.counts.total, 20);
assert.equal(reserved.counts.provisioning, 20);
console.log('PASS deficit=20: all twenty accounts reserved before provisioning completes');
const done = await poll(() => get(base + '/api/user-pool'), value => value.counts.ready_idle === 20);
assert.equal(done.counts.failed, 0);
const state = await get(mock + '/test/state');
assert.equal(state.counters.scimCreates, 20);
assert.equal(state.counters.seatAssignments, 20);
assert.equal(state.counters.taskPosts, 20);
assert.equal(state.counters.callbacksSucceeded, 20);
assert.equal(state.concurrency.peakStages, 5);
assert.equal(new Set(state.users.map(user => user.userName)).size, 20);
console.log('PASS real Docker HTTP peak concurrent stages=5; 20 unique SCIM accounts/seats/OAuth callbacks ready');
console.log(JSON.stringify({ counts: done.counts, concurrency: state.concurrency }));
