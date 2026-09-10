import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const base = 'http://127.0.0.1:17300';
const internal = { 'X-Internal-Token': 'local-pool-internal-test-only' };
const caller = `sha256:${createHash('sha256').update('local-pool-expiry-smoke').digest('hex')}`;
async function snapshot() { const r = await fetch(`${base}/api/user-pool`, { headers: internal }); assert.equal(r.status, 200); return r.json(); }
async function infer() {
  const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { Authorization: 'Bearer local-pool-proxy-test-only', 'X-User-Identity': caller, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-2', max_tokens: 8, messages: [{ role: 'user', content: 'Expiry check' }] }) });
  assert.equal(r.status, 200); await r.text();
}
await infer();
const before = await snapshot();
const lease = before.leases.find(row => row.callerKeyHash === caller);
assert.equal(lease.phase, 'active');
const wait = lease.expiresAt - Date.now() + 1500;
assert.ok(wait > 0 && wait < 65000);
await new Promise(resolve => setTimeout(resolve, wait));
const after = await snapshot();
assert.equal(after.leases.some(row => row.leaseId === lease.leaseId), false);
assert.equal(after.counts.total, before.counts.total);
await infer();
const next = (await snapshot()).leases.find(row => row.callerKeyHash === caller);
assert.notEqual(next.leaseId, lease.leaseId);
const release = await fetch(`${base}/api/user-pool/leases/${next.leaseId}/release`, { method: 'POST', headers: { ...internal, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
assert.equal(release.status, 200);
console.log('PASS real 60-second TTL expired, reclaimed, and allocated a new fenced lease without growing inventory');
