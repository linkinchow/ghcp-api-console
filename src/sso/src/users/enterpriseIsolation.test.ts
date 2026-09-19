import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { resolveEnterpriseScope } from '@ghcp/shared';
import { initSsoRegistryFixture, SECOND_FIXTURE_ID } from '../db/enterpriseFixture.js';

process.env.LOG_LEVEL = 'error';
process.env.INTERNAL_API_TOKEN = 'synthetic-internal-token';
const registry = initSsoRegistryFixture(true);
const a = resolveEnterpriseScope(registry);
const b = resolveEnterpriseScope(registry, SECOND_FIXTURE_ID);
const repo = await import('../db/usersRepo.js');
const service = await import('./service.js');
const settings = await import('../db/runtimeSettingsRepo.js');
const budget = await import('../db/budgetRepo.js');
const plans = await import('../db/emuImportPlansRepo.js');
const { getDb } = await import('../db/connection.js');
const { refreshAiCreditsUsage } = await import('../budget/budgetService.js');
const { createUsersApiRouter } = await import('../routes/usersApi.js');
const { requireEnterpriseRequest } = await import('../enterprise.js');
const { hashPassword, verifyPassword } = await import('../auth/password.js');

const create = (name: string, scope: typeof a) => repo.createUser({ ssoUser: name, ...hashPassword(`password-${scope.enterpriseId}`), email: `${name}@${scope.profile.sso.emailDomain}` }, scope);

test('two enterprises isolate same-name CRUD, OR search, settings, count and capacity', () => {
  const left = create('Same.Name', a), right = create('Same.Name', b);
  assert.equal(left.ssoUser, 'Same.Name');
  assert.notEqual(left.userIncarnation, right.userIncarnation);
  assert.throws(() => create('same.name', a), /UNIQUE/);
  assert.equal(repo.getUser('SAME.NAME', b)?.userIncarnation, right.userIncarnation);
  service.patchSsoUser('same.name', { email: 'unique@search.example', password: 'changed-password', role: 'admin' }, a);
  assert.equal(repo.getUser('same.name', b)?.role, 'user');
  assert.equal(verifyPassword('changed-password', repo.getUser('same.name', b)!.passwordHash, right.salt), false);
  assert.equal(repo.listUsers({ q: 'unique@search' }, b).total, 0);
  assert.equal(repo.listUsers({ q: 'unique@search' }, a).total, 1);
  const bSettings = settings.getSsoRuntimeSettings(b);
  settings.updateSsoRuntimeSettings({ expectedVersion: 1, changes: { maxSsoUsers: 1, emailDomain: 'changed.example' } }, a);
  assert.equal(settings.getSsoRuntimeSettings(b), bSettings);
  assert.equal(service.getSsoUserCapacity(a).remaining, 0);
  assert.equal(service.getSsoUserCapacity(b).reached, false);
  assert.throws(() => create('over-limit', a), /limit/);
  repo.deleteUser(left.ssoUser, left.userIncarnation, undefined, a);
  assert.equal(repo.countUsers(a), 0);
  assert.equal(repo.countUsers(b), 1);
  settings.updateSsoRuntimeSettings({ expectedVersion: 2, changes: { maxSsoUsers: null, scimRequestDelayMs: 0, scimMaxRetries: 0 } }, a);
  settings.updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } }, b);
});

test('budget cache and import IDs/rows/paging/apply/delete remain enterprise scoped', async () => {
  budget.saveAiCreditsUsagePeriod({ year: 2026, month: 9, quantity: 11, rawJson: {}, fetchedAt: new Date().toISOString() }, a);
  budget.saveAiCreditsUsagePeriod({ year: 2026, month: 9, quantity: 22, rawJson: {}, fetchedAt: new Date().toISOString() }, b);
  assert.equal(budget.getAiCreditsUsagePeriod(2026, 9, a)?.quantity, 11);
  assert.equal(budget.getAiCreditsUsagePeriod(2026, 9, b)?.quantity, 22);
  const row = { ssoUser: 'imported', email: 'imported@example.com', ghLogin: 'same_gh', ghScimId: 'same-scim', emuStatus: 'active' as const, copilotSeatStatus: 'unassigned' as const, status: 'pending_create' as const, action: 'create' as const, detail: '' };
  plans.createEmuImportPlanRecord({ id: 'same-plan', rows: [row] }, a);
  plans.createEmuImportPlanRecord({ id: 'same-plan', rows: [{ ...row, email: 'other@example.com' }] }, b);
  service.applyEmuImportPlan('same-plan', a);
  assert.equal(repo.getUser('imported', b), undefined);
  assert.equal(service.listEmuImportPlanRows('same-plan', { status: 'pending_create', page: 1, pageSize: 1 }, b).total, 1);
  service.deleteEmuImportPlan('same-plan', a);
  assert.equal(service.getEmuImportPlan('same-plan', b).status, 'planned');
  const original = create('aba-import', a);
  plans.createEmuImportPlanRecord({ id: 'aba-plan', rows: [{ ...row, ssoUser: original.ssoUser, action: 'update', status: 'pending_update', expectedUserIncarnation: original.userIncarnation }] }, a);
  repo.deleteUser(original.ssoUser, original.userIncarnation, undefined, a);
  const replacement = create(original.ssoUser, a);
  assert.equal(service.applyEmuImportPlan('aba-plan', a).summary.conflict, 1);
  assert.equal(repo.getUser(original.ssoUser, a)?.email, replacement.email);
  plans.createEmuImportPlanRecord({ id: 'old-unfenced-plan', rows: [{ ...row, ssoUser: original.ssoUser, action: 'update', status: 'pending_update' }] }, a);
  assert.equal(service.applyEmuImportPlan('old-unfenced-plan', a).summary.conflict, 1);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    const enterprise = url.pathname.includes(a.profile.slug) ? a.profile.slug : b.profile.slug;
    await new Promise(resolve => setTimeout(resolve, enterprise === a.profile.slug ? 10 : 0));
    return Response.json({ enterprise, timePeriod: { year: Number(url.searchParams.get('year')), month: Number(url.searchParams.get('month')) }, usageItems: [{ sku: 'copilot_ai_unit', grossQuantity: enterprise === a.profile.slug ? 17 : 29 }] });
  };
  try {
    const [left, right] = await Promise.all([refreshAiCreditsUsage(new Date('2026-09-15'), a), refreshAiCreditsUsage(new Date('2026-09-15'), b)]);
    assert.equal(left.enterprise, a.profile.slug); assert.equal(left.currentMonth.quantity, 17);
    assert.equal(right.enterprise, b.profile.slug); assert.equal(right.currentMonth.quantity, 29);
  } finally { globalThis.fetch = originalFetch; }
});

test('interleaved same-name SCIM operations bind endpoints and block ABA during external work', async () => {
  const left = create('interleave', a), right = create('interleave', b);
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push(url);
    assert.equal(init?.redirect, 'error');
    if (url.startsWith(a.profile.sso.scimBaseUrl)) { started(); await pending; }
    return Response.json({ id: 'same-scim', userName: 'interleave', githubLogin: url.startsWith(a.profile.sso.scimBaseUrl) ? 'interleave_a' : 'interleave_b' }, { status: 201 });
  };
  try {
    const slow = service.syncSsoUser('interleave', undefined, false, true, a);
    await reached;
    assert.throws(() => repo.deleteUser('interleave', left.userIncarnation, undefined, a), /in progress/);
    assert.throws(() => service.patchSsoUser('interleave', { email: 'wrong@example.com' }, a), /in progress/);
    const fast = await service.syncSsoUser('interleave', undefined, false, true, b);
    assert.equal(fast.ghLogin, 'interleave_b');
    release(); await slow;
    assert.equal(repo.getUser('interleave', a)?.ghLogin, 'interleave_a');
    assert.equal(repo.getUser('interleave', b)?.userIncarnation, right.userIncarnation);
    assert.equal(requests.length, 2);
    repo.deleteUser('interleave', left.userIncarnation, undefined, a);
    const replacement = create('interleave', a);
    assert.throws(() => repo.updateEmu('interleave', { emuStatus: 'active' }, left.userIncarnation, a), /recreated/);
    assert.equal(repo.getUser('interleave', a)?.userIncarnation, replacement.userIncarnation);
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('queued batch rows retain admission-time user incarnation', async () => {
  create('batch-first', a);
  const original = create('batch-later', a);
  const snapshot = settings.getSsoRuntimeSettings(a);
  settings.updateSsoRuntimeSettings({ expectedVersion: snapshot.version, changes: { bulkSyncConcurrency: 1 } }, a);
  const originalFetch = globalThis.fetch;
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  const names: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)); names.push(body.userName);
    started(); await blocked;
    return Response.json({ id: 'batch-scim', userName: body.userName, githubLogin: `${body.userName}_enaa` }, { status: 201 });
  };
  try {
    const batch = service.runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['batch-first', 'batch-later'], createOnly: true }, a);
    await reached;
    repo.deleteUser(original.ssoUser, original.userIncarnation, undefined, a);
    const replacement = create(original.ssoUser, a);
    release();
    const result = await batch;
    assert.equal(result.rows[0].status, 'success');
    assert.equal(result.rows[1].status, 'failed');
    assert.match(result.rows[1].detail, /recreated/);
    assert.deepEqual(names, ['batch-first']);
    assert.equal(repo.getUser(original.ssoUser, a)?.userIncarnation, replacement.userIncarnation);
    assert.equal(repo.getUser(original.ssoUser, a)?.ghScimId ?? null, null);
  } finally { release(); globalThis.fetch = originalFetch; }
});

test('unknown mutation outcome persists fence across DB reopen and no secret body leaks', async () => {
  const user = create('uncertain', a);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('SECRET-do-not-log'); };
  try { await assert.rejects(service.syncSsoUser(user.ssoUser, undefined, false, true, a), /outcome is unknown/); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 1);
  assert.ok((getDb().prepare('SELECT operation_fence FROM sso_users WHERE enterprise_id = ? AND sso_user = ?').get(a.enterpriseId, user.ssoUser) as { operation_fence: string }).operation_fence);
  getDb().close(); getDb();
  assert.throws(() => repo.deleteUser(user.ssoUser, user.userIncarnation, undefined, a), /in progress/);
  assert.throws(() => service.patchSsoUser(user.ssoUser, { role: 'admin' }, a), /in progress/);
  assert.equal(repo.getUser(user.ssoUser, b), undefined);
});

test('scoped routes reject conflicting enterprise and legacy cannot read the other enterprise', async () => {
  const app = express(); app.use(express.json());
  app.use(`/api/profiles/${a.enterpriseId}`, requireEnterpriseRequest(a), createUsersApiRouter(a));
  app.use(`/api/profiles/${b.enterpriseId}`, requireEnterpriseRequest(b), createUsersApiRouter(b));
  app.use('/api', requireEnterpriseRequest(a), createUsersApiRouter(a));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const scoped = await fetch(`${base}/api/profiles/${b.enterpriseId}/users/Same.Name`);
    assert.equal(scoped.status, 200); assert.equal((await scoped.json()).enterpriseId, b.enterpriseId);
    assert.equal((await fetch(`${base}/api/users/Same.Name`)).status, 404);
    assert.equal((await fetch(`${base}/api/profiles/${b.enterpriseId}/users?enterpriseId=${a.enterpriseId}`)).status, 400);
    assert.equal((await fetch(`${base}/api/profiles/${b.enterpriseId}/users`, { headers: { 'x-enterprise-id': a.enterpriseId } })).status, 400);
  } finally { server.close(); await once(server, 'close'); }
});
