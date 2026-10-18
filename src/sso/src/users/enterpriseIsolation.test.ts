import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createEnterpriseFixture, GHE_ENTERPRISE_ID } from '../testing/enterpriseFixture.js';

interface OutboundRequest {
  url: string;
  method: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
  body: string;
}

type Responder = (request: OutboundRequest) => Response | Promise<Response> | undefined;

const fixture = createEnterpriseFixture();
process.env.DB_PATH = ':memory:';
process.env.SSO_USER_EVENTS_LOG = join(fixture.directory, 'logs', 'events.log');
process.env.PROXY_BASE_URL = 'https://proxy.test';
process.env.INTERNAL_API_TOKEN = 'isolation-internal-token';
process.env.LOG_LEVEL = 'error';

const { findSsoEnterprise, setSsoEnterprisesForTesting } = await import('../enterprises.js');
setSsoEnterprisesForTesting(fixture.registry);
const repo = await import('../db/usersRepo.js');
const settings = await import('../db/runtimeSettingsRepo.js');
const budget = await import('../db/budgetRepo.js');
const { refreshAiCreditsUsage } = await import('../budget/budgetService.js');
const { hashPassword, verifyPassword } = await import('../auth/password.js');
const { normalizeHandle } = await import('../scim/handle.js');
const { findScimUserByUsername } = await import('../scim/scimClient.js');
const service = await import('./service.js');

const a = findSsoEnterprise('default')!;
const b = findSsoEnterprise(GHE_ENTERPRISE_ID)!;
const requests: OutboundRequest[] = [];
let responders: Responder[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request: OutboundRequest = {
    url: String(input),
    method: init?.method ?? 'GET',
    authorization: new Headers(init?.headers).get('authorization'),
    redirect: init?.redirect,
    body: typeof init?.body === 'string' ? init.body : '',
  };
  requests.push(request);
  for (const responder of responders) {
    const response = await responder(request);
    if (response) return response;
  }
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};

test.after(() => {
  globalThis.fetch = originalFetch;
  rmSync(fixture.directory, { recursive: true, force: true });
});

for (const enterprise of [a, b]) {
  const current = settings.getSsoRuntimeSettings(enterprise.id);
  const changes = { scimRequestDelayMs: 0, scimMaxRetries: 0 };
  settings.updateSsoRuntimeSettings(enterprise.id, { expectedVersion: current.version, changes });
}

async function seed(enterpriseId: typeof a.id, ssoUser: string, password: string, email = `${ssoUser}@example.test`) {
  return repo.createUser(enterpriseId, { ssoUser, ...await hashPassword(password), email });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function scimUser(userName: string, id = `scim-${userName}`) {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id,
    userName,
    active: true,
    emails: [{ value: `${userName}@scim.example`, primary: true }],
  };
}

test('same-name users stay separate across CRUD, search, settings, capacity and events', async () => {
  const left = await seed(a.id, 'same.name', 'password-a');
  const right = await seed(b.id, 'same.name', 'password-b');
  assert.notEqual(left.salt, right.salt);
  await assert.rejects(seed(a.id, 'same.name', 'again'), /UNIQUE/);
  assert.equal(repo.getUser(b.id, 'SAME.NAME')?.passwordHash, right.passwordHash);
  const patch = { email: 'unique@search.example', password: 'changed-password', role: 'admin' as const };
  await service.patchSsoUser(a, 'same.name', patch);
  const untouched = repo.getUser(b.id, 'same.name')!;
  assert.equal(untouched.role, 'user');
  assert.equal(untouched.email, right.email);
  assert.equal(await verifyPassword('changed-password', untouched.passwordHash, untouched.salt), false);
  assert.equal(repo.listUsers(b.id, { q: 'unique@search' }).total, 0);
  assert.equal(repo.listUsers(a.id, { q: 'unique@search' }).total, 1);
  assert.equal(repo.summarizeUsers(a.id).total, 1);

  const before = settings.getSsoRuntimeSettings(b.id);
  const aVersion = settings.getSsoRuntimeSettings(a.id).version;
  const changes = { maxSsoUsers: 1, emailDomain: 'changed.example' };
  settings.updateSsoRuntimeSettings(a.id, { expectedVersion: aVersion, changes });
  assert.equal(settings.getSsoRuntimeSettings(b.id), before);
  assert.equal(before.emailDomain, 'contoso.example.eu');
  assert.equal(before.userPrefix, 'ghcp');
  assert.equal(service.getSsoUserCapacity(a).reached, true);
  assert.equal(service.getSsoUserCapacity(b).reached, false);
  await assert.rejects(seed(a.id, 'over-limit', 'pw'), repo.SsoUserLimitReachedError);
  await seed(b.id, 'under-limit', 'pw');

  assert.equal(repo.deleteUser(a.id, 'same.name'), true);
  assert.equal(repo.countUsers(a.id), 0);
  assert.equal(repo.countUsers(b.id), 2);
  const aSettings = settings.getSsoRuntimeSettings(a.id);
  const reset = { maxSsoUsers: null, emailDomain: 'acme.example.com' };
  settings.updateSsoRuntimeSettings(a.id, { expectedVersion: aSettings.version, changes: reset });

  await service.createSsoUser(a, { ssoUser: 'logged-a' });
  await service.createSsoUser(b, { ssoUser: 'logged-b' });
  const aLog = readFileSync(a.eventLogPath, 'utf8');
  const bLog = readFileSync(b.eventLogPath, 'utf8');
  assert.equal(b.eventLogPath, join(fixture.directory, 'logs', GHE_ENTERPRISE_ID, 'events.log'));
  assert.match(aLog, /logged-a/);
  assert.doesNotMatch(aLog, /logged-b/);
  assert.match(bLog, /logged-b/);
  assert.doesNotMatch(bLog, /logged-a/);
});

test('ensure, import and default passwords follow the enterprise profile', async () => {
  const ensuredA = await service.ensureUser(a, 'ensured_octo');
  const ensuredB = await service.ensureUser(b, 'ensured_octo');
  assert.equal(ensuredA.user.ssoUser, 'ensured', 'the github.com shortcode suffix is stripped');
  assert.equal(ensuredB.user.ssoUser, 'ensured_octo', 'GHE.com has no shortcode to strip');
  assert.equal(ensuredA.user.email, 'ensured@acme.example.com');
  assert.equal(ensuredB.user.email, 'ensured_octo@contoso.example.eu');
  assert.equal(ensuredA.passwordForLogin, process.env.ACME_DEFAULT_PASSWORD);
  assert.equal(ensuredB.passwordForLogin, process.env.CONTOSO_DEFAULT_PASSWORD);
  const imported = await service.importUsers(b, 'ssoUser\nimported-only-b');
  assert.equal(imported.summary.success, 1);
  assert.equal(repo.getUser(a.id, 'imported-only-b'), undefined);
  const user = repo.getUser(b.id, 'imported-only-b')!;
  assert.equal(await verifyPassword(process.env.CONTOSO_DEFAULT_PASSWORD!, user.passwordHash, user.salt), true);
});

test('budget cache and refresh use each enterprise endpoint and seat PAT', async () => {
  const fetchedAt = new Date().toISOString();
  budget.saveAiCreditsUsagePeriod(a.id, { year: 2026, month: 9, quantity: 11, rawJson: {}, fetchedAt });
  budget.saveAiCreditsUsagePeriod(b.id, { year: 2026, month: 9, quantity: 22, rawJson: {}, fetchedAt });
  assert.equal(budget.getAiCreditsUsagePeriod(a.id, 2026, 9)?.quantity, 11);
  assert.equal(budget.getAiCreditsUsagePeriod(b.id, 2026, 9)?.quantity, 22);
  requests.length = 0;
  responders = [(request) => {
    const url = new URL(request.url);
    const quantity = url.host === 'api.acme.test' ? 17 : 29;
    const timePeriod = { year: Number(url.searchParams.get('year')), month: Number(url.searchParams.get('month')) };
    return json(200, { timePeriod, usageItems: [{ sku: 'copilot_ai_unit', grossQuantity: quantity }] });
  }];
  const now = new Date('2026-09-15T00:00:00Z');
  const [left, right] = await Promise.all([refreshAiCreditsUsage(a, now), refreshAiCreditsUsage(b, now)]);
  assert.equal(left.enterprise, 'acme');
  assert.equal(left.currentMonth.quantity, 17);
  assert.equal(right.enterprise, 'contoso');
  assert.equal(right.currentMonth.quantity, 29);
  const byHost = (host: string) => requests.filter((request) => new URL(request.url).host === host);
  const acme = byHost('api.acme.test');
  const contoso = byHost('api.contoso.ghe.com');
  assert.equal(acme.length, 2);
  assert.equal(contoso.length, 2);
  assert.ok(acme.every((request) => request.url.includes('/enterprises/acme/settings/billing/usage/summary')));
  assert.ok(acme.every((request) => request.authorization === 'Bearer acme-seat-pat'));
  assert.ok(contoso.every((request) => request.url.includes('/enterprises/contoso/settings/billing/usage/summary')));
  assert.ok(contoso.every((request) => request.authorization === 'Bearer contoso-seat-pat'));
  assert.ok(requests.every((request) => request.redirect === 'error'));
  assert.equal(budget.getAiCreditsUsagePeriod(a.id, 2026, 9)?.quantity, 17);
  assert.equal(budget.getAiCreditsUsagePeriod(b.id, 2026, 9)?.quantity, 29);
});

test('import plans stay in their enterprise and GHE.com handles are unsuffixed and at most 30 characters', async () => {
  const longName = 'contoso-imported-user-with-a-very-long-name';
  requests.length = 0;
  responders = [(request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/copilot/billing/seats')) return json(200, { total_seats: 0, seats: [] });
    if (url.host === 'scim.acme.test') return json(200, { Resources: [scimUser('importee', 'scim-a')] });
    if (url.host === 'api.contoso.ghe.com') return json(200, { Resources: [scimUser('importee'), scimUser(longName)] });
    return undefined;
  }];
  const planA = await service.createEmuImportPlan(a);
  const planB = await service.createEmuImportPlan(b);
  assert.throws(() => service.getEmuImportPlan(b, planA.planId), /was not found/);
  assert.throws(() => service.listEmuImportPlanRows(b, planA.planId), /was not found/);
  assert.throws(() => service.deleteEmuImportPlan(b, planA.planId), /was not found/);
  assert.equal(service.getEmuImportPlan(a, planA.planId).summary.pendingCreate, 1);
  const rowsA = service.listEmuImportPlanRows(a, planA.planId).items;
  const rowsB = service.listEmuImportPlanRows(b, planB.planId).items;
  assert.equal(rowsA[0]?.ghLogin, 'importee_octo');
  assert.equal(rowsB.find((row) => row.ssoUser === 'importee')?.ghLogin, 'importee');
  const longLogin = rowsB.find((row) => row.ghScimId === `scim-${longName}`)?.ghLogin ?? '';
  assert.equal(longLogin, normalizeHandle(longName, ''));
  assert.ok(longLogin.length <= 30 && !longLogin.includes('_'), longLogin);
  const scimRequests = requests.filter((request) => !request.url.includes('/copilot/'));
  assert.ok(scimRequests.filter((r) => r.url.startsWith('https://scim.acme.test/')).every(
    (request) => request.authorization === 'Bearer acme-scim-token',
  ));
  const contosoScim = 'https://api.contoso.ghe.com/scim/v2/enterprises/contoso/';
  assert.ok(scimRequests.filter((r) => r.url.startsWith(contosoScim)).every(
    (request) => request.authorization === 'Bearer contoso-scim-token',
  ));
  await service.applyEmuImportPlan(a, planA.planId);
  assert.equal(repo.getUser(a.id, 'importee')?.ghScimId, 'scim-a');
  assert.equal(repo.getUser(b.id, 'importee'), undefined);
  assert.equal(service.getEmuImportPlan(b, planB.planId).status, 'planned');
});

test('GHE.com SCIM sync derives an unsuffixed handle of at most 30 characters', async () => {
  const ssoUser = 'contoso-sync-user-with-a-long-name';
  await seed(b.id, ssoUser, 'pw');
  await seed(a.id, ssoUser, 'pw');
  requests.length = 0;
  responders = [(request) => {
    if (request.method !== 'POST' || !request.url.endsWith('/Users')) return undefined;
    const body = JSON.parse(request.body) as { userName: string };
    return json(201, { id: `scim-${request.url.includes('contoso') ? 'b' : 'a'}`, userName: body.userName });
  }];
  const syncedB = await service.syncSsoUser(b, ssoUser);
  const syncedA = await service.syncSsoUser(a, ssoUser);
  assert.equal(syncedB.ghLogin, normalizeHandle(ssoUser, ''));
  assert.ok(syncedB.ghLogin!.length <= 30 && !syncedB.ghLogin!.includes('_'), syncedB.ghLogin);
  assert.match(syncedA.ghLogin ?? '', /_octo$/);
  assert.ok(syncedA.ghLogin!.length <= 39);
  assert.deepEqual(requests.map((request) => request.url), [
    'https://api.contoso.ghe.com/scim/v2/enterprises/contoso/Users',
    'https://scim.acme.test/scim/v2/enterprises/acme/Users',
  ]);
  assert.equal(repo.getUser(b.id, ssoUser)?.ghScimId, 'scim-b');
  assert.equal(repo.getUser(a.id, ssoUser)?.ghScimId, 'scim-a');
});

test('pool membership checks are scoped to the enterprise and fail closed', async () => {
  await service.createSsoUser(a, { ssoUser: 'shared', poolManaged: true });
  await seed(b.id, 'shared', 'pw');
  await assert.rejects(service.patchSsoUser(a, 'shared', { email: 'x@example.test' }), repo.PoolMemberManagedError);
  assert.equal((await service.patchSsoUser(b, 'shared', { email: 'b@example.test' }))?.email, 'b@example.test');
  assert.equal(repo.isPoolManagedSsoUser(b.id, 'shared'), false);

  let membership: () => Response = () => json(200, { managed: false });
  requests.length = 0;
  responders = [(request) => {
    if (request.url.endsWith('/pool-membership')) return membership();
    if (request.url.startsWith('https://proxy.test/') && request.method === 'DELETE') {
      return json(200, { ssoUser: 'shared', matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 });
    }
    if (request.url.startsWith('https://api.contoso.ghe.com/scim/')) return json(200, { Resources: [] });
    return undefined;
  }];
  const deleted = await service.runSsoUserBatch(b, { operation: 'delete_sso', ssoUsers: ['shared'] });
  assert.equal(deleted.summary.success, 1, JSON.stringify(deleted));
  const proxyCalls = requests.filter((request) => request.url.startsWith('https://proxy.test/'));
  assert.deepEqual(proxyCalls.map((request) => `${request.method} ${request.url}`), [
    'GET https://proxy.test/internal/enterprises/contoso-eu/accounts/by-sso-user/shared/pool-membership',
    'DELETE https://proxy.test/internal/enterprises/contoso-eu/accounts/by-sso-user/shared',
  ]);
  assert.equal(repo.getUser(b.id, 'shared'), undefined);
  assert.ok(repo.getUser(a.id, 'shared'));

  await seed(b.id, 'guarded', 'pw');
  const linked = { ghLogin: 'guarded', ghScimId: 'scim-guarded', emuStatus: 'active' } as const;
  const guarded = repo.updateEmu(b.id, 'guarded', linked);
  for (const response of [() => json(503, { message: 'down' }), () => json(200, { managed: 'no' })]) {
    membership = response;
    requests.length = 0;
    const result = await service.runSsoUserBatch(b, { operation: 'delete_emu', ssoUsers: ['guarded'] });
    assert.match(result.rows[0]?.detail ?? '', /^pool_membership_unavailable:/);
    assert.deepEqual(requests.map((request) => request.url), [
      'https://proxy.test/internal/enterprises/contoso-eu/accounts/by-sso-user/guarded/pool-membership',
    ]);
    assert.deepEqual(repo.getUser(b.id, 'guarded'), guarded);
  }
});

test('SCIM pacing is tracked per enterprise', async () => {
  const current = settings.getSsoRuntimeSettings(a.id);
  const slow = { expectedVersion: current.version, changes: { scimRequestDelayMs: 60_000 } };
  settings.updateSsoRuntimeSettings(a.id, slow);
  responders = [() => json(200, { Resources: [] })];
  await findScimUserByUsername(a, 'first');
  const startedAt = Date.now();
  await findScimUserByUsername(b, 'not-delayed');
  assert.ok(Date.now() - startedAt < 5_000, 'a slow enterprise must not delay another enterprise');
});
