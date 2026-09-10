import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const gateway = 'http://127.0.0.1:17505', proxy = 'http://127.0.0.1:17500', mock = 'http://127.0.0.1:17502';
const master = 'sk-local-gateway-master-test-only';
const internal = { 'X-Internal-Token': 'local-pool-internal-test-only', 'Content-Type': 'application/json' };
const admin = { Authorization: `Bearer ${master}`, 'Content-Type': 'application/json' };
const report = { checks: [], knownLimits: [], keys: [] };
const owned = [];
const run = 'supp-' + randomUUID().slice(0, 8);
async function request(base, path, method = 'GET', body, headers = admin) {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, headers: response.headers, text };
}
const pool = async () => (await request(proxy, '/api/user-pool', 'GET', undefined, internal)).data;
const state = async () => (await request(mock, '/test/state', 'GET', undefined, internal)).data;
async function createKey(label, extra = {}) {
  const user = `${run}-${label}`;
  assert.equal((await request(gateway, '/user/new', 'POST', { user_id: user, user_role: 'internal_user', auto_create_key: false })).status, 200);
  const result = await request(gateway, '/key/generate', 'POST', { user_id: user, key_alias: user, models: ['claude-opus-5', 'other-only', 'shared-claude', 'fallback-probe'], ...extra });
  assert.equal(result.status, 200);
  const key = { raw: result.data.key, hash: createHash('sha256').update(result.data.key).digest('hex'), user, label };
  owned.push(key); report.keys.push({ user, hash: key.hash }); return key;
}
const call = (raw, model, body = {}) => request(gateway, '/v1/messages', 'POST', {
  model, max_tokens: 16, messages: [{ role: 'user', content: `Supplement ${run} ${model}` }], ...body,
}, { 'x-api-key': raw, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' });
function pass(name, detail) { report.checks.push({ name, ...detail, status: 'PASS', ...(typeof detail?.status === 'number' ? { httpStatus: detail.status } : {}) }); console.log('PASS', name, JSON.stringify(detail ?? {})); }
try {
  for (let i = 0; i < 90; i++) { try { if ((await request(gateway, '/health/liveliness')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 1000)); }
  const before = await pool();
  const masterOnly = await call(master, 'claude-opus-5');
  assert.equal(masterOnly.status, 403);
  assert.equal((await pool()).leases.length, before.leases.length);
  pass('master_key_cannot_allocate_pool', { status: masterOnly.status });
  const beforeOther = (await state()).otherInference.length;
  const masterShared = await call(master, 'shared-claude');
  assert.equal(masterShared.status, 200);
  assert.equal((await state()).otherInference.length, beforeOther + 1);
  assert.equal((await pool()).leases.length, before.leases.length);
  pass('filter_removes_pool_but_preserves_other_shared_deployment_for_master');
  const key = await createKey('routing');
  const other = await call(key.raw, 'other-only');
  assert.equal(other.status, 200);
  assert.equal((await state()).otherInference.at(-1).identityHeaderPresent, false);
  assert.ok(!(await pool()).leases.some(row => row.callerKeyHash === 'sha256:' + key.hash));
  pass('other_provider_receives_no_injected_hash_and_consumes_no_member');
  const fallback = await call(key.raw, 'fallback-probe');
  assert.equal(fallback.status, 200);
  const lease = (await pool()).leases.find(row => row.callerKeyHash === 'sha256:' + key.hash);
  assert.ok(lease && lease.phase === 'active');
  pass('fallback_into_pool_uses_authenticated_hash', { memberIdentity: lease.memberIdentity });
  const spoofOther = await call(key.raw, 'other-only', { extra_headers: { 'X-User-Identity': 'sha256:' + 'f'.repeat(64) } });
  assert.equal(spoofOther.status, 200);
  report.knownLimits.push({ name: 'client_supplied_other_provider_identity_header', forwarded: (await state()).otherInference.at(-1).identityHeaderPresent });
  const budget = await createKey('budget', { max_budget: 0.00001 });
  assert.equal((await call(budget.raw, 'claude-opus-5')).status, 200);
  let info;
  for (let i = 0; i < 120; i++) {
    info = (await request(gateway, '/key/info?key=' + budget.hash)).data.info;
    if (info.spend > 0) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(info.spend > 0.00001, 'Spend update must exceed tiny test budget');
  const blocked = await call(budget.raw, 'claude-opus-5');
  assert.ok([400, 403, 429].includes(blocked.status), 'Budget exhausted must block');
  pass('real_key_budget_after_spend_update_blocks_further_usage', { spend: info.spend, status: blocked.status });
  const priced = await call(key.raw, 'claude-opus-5');
  assert.equal(priced.status, 200);
  assert.equal(priced.data.usage.input_tokens, 4);
  assert.equal(priced.data.usage.output_tokens, 1);
  pass('native_messages_usage_available_for_builtin_price_check', { expectedCost: 4 * 0.000005 + 1 * 0.000025 });
} finally {
  const snapshot = await pool();
  for (const key of owned) {
    const lease = snapshot.leases.find(row => row.callerKeyHash === 'sha256:' + key.hash);
    if (lease && !lease.inUse) await request(proxy, '/api/user-pool/leases/' + lease.leaseId + '/release', 'POST', { confirm: true }, internal);
    await request(gateway, '/key/delete', 'POST', { keys: [key.hash] });
  }
  await writeFile(new URL('./local-gateway-supplement.json', import.meta.url), JSON.stringify(report, null, 2));
}
