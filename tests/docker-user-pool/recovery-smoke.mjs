import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:17600', mock = 'http://127.0.0.1:17602';
const internal = { 'X-Internal-Token': 'local-pool-internal-test-only', 'Content-Type': 'application/json' };
const caller = 'sha256:' + 'a'.repeat(64);
async function read(url) { const r = await fetch(url, { headers: internal, signal: AbortSignal.timeout(5000) }); assert.equal(r.status, 200); return r.json(); }
const pool = () => read(base + '/api/user-pool');
const state = () => read(mock + '/test/state');
async function poll(fn, predicate, timeout = 45000) { const end = Date.now() + timeout; do { const v = await fn(); if (predicate(v)) return v; await new Promise(r => setTimeout(r, 150)); } while (Date.now() < end); throw new Error('Recovery condition timed out'); }
async function infer(status, id, hash = caller) {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { Authorization: 'Bearer local-pool-proxy-test-only', 'X-User-Identity': hash, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-2', max_tokens: 16, messages: [{ role: 'user', content: `POOL_TEST:${JSON.stringify({ id, status })}` }] }) });
  await r.text(); return r.status;
}
await poll(async () => { try { return await pool(); } catch { return {}; } }, value => value.enabled);
const initial = await pool();
assert.equal(initial.counts.total, 0, 'Run only against fresh recovery fixture');
assert.equal((await fetch(base + '/api/user-pool/settings', { method: 'PATCH', headers: internal, body: JSON.stringify({ expectedVersion: initial.settings.version, changes: { idle_target: 1, max_accounts: 1 } }) })).status, 200);
await poll(pool, value => value.counts.ready_idle === 1);
const identity = (await pool()).accounts[0].identity;
assert.equal((await state()).counters.taskPosts, 1);
for (let cycle = 1; cycle <= 3; cycle++) {
  assert.equal(await infer(200, `before-${cycle}`), 200);
  const before = (await pool()).leases[0];
  assert.equal(await infer(401, `unauthorized-${cycle}`), 401);
  const recovered = await poll(pool, value => value.counts.ready_idle === 1 && value.counts.failed === 0 && value.counts.provisioning === 0);
  const upstream = await state();
  assert.equal(upstream.counters.taskPosts, cycle + 1);
  assert.equal(upstream.counters.callbacksSucceeded, cycle + 1);
  assert.equal(upstream.counters.scimCreates, 1);
  assert.equal(upstream.counters.seatAssignments, 1);
  assert.equal(recovered.accounts[0].identity, identity);
  assert.equal(recovered.leases.some(row => row.leaseId === before.leaseId), false);
  assert.equal(upstream.inference.filter(row => row.marker === `unauthorized-${cycle}`).length, 1);
  assert.equal(await infer(200, `after-${cycle}`), 200);
  console.log(`PASS recovery cycle ${cycle}: 401 returned once; automatic Login+callback+warmup; no new account or seat`);
}
assert.equal(await infer(401, 'unauthorized-limit'), 401);
await poll(pool, value => value.counts.failed === 1 && value.accounts[0].activeRequests === 0);
const blocked = await pool();
assert.equal(blocked.accounts[0].lastError, 'oauth_reauth_limit_reached');
assert.equal(blocked.accounts[0].attempts, 3);
for (let i = 0; i < 3; i++) {
  await fetch(base + '/api/user-pool/reconcile', { method: 'POST', headers: internal });
  assert.equal(await infer(200, `blocked-${i}`, 'sha256:' + 'b'.repeat(64)), 429);
}
assert.equal((await state()).counters.taskPosts, 4);
console.log('PASS fourth recovery cycle blocked; no uncontrolled login storm; manual intervention required');
console.log(JSON.stringify({ totalAccounts: 1, initialLoginTasks: 1, automaticRepairTasks: 3, duplicateInferenceReplays: 0, manualRetryCalls: 0 }));
