import assert from 'node:assert/strict';
import test from 'node:test';

// GitHub's real response when cancelling a user that has no direct Copilot seat.
const NOT_ASSIGNED_RESPONSE = {
  message: 'One or more seat assignments could not be cancelled: User is not assigned to a seat',
  documentation_url: 'https://docs.github.com/rest/copilot/copilot-user-management#remove-users-from-the-copilot-subscription-for-an-enterprise',
  status: '422',
};

test('Remove seat, Delete GH login and Delete SSO user skip a missing seat for users imported from GH', async (t) => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.GITHUB_API_BASE_URL = 'https://github.test';
  process.env.ENTERPRISE_SLUG = 'test-enterprise';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.SCIM_BASE_URL = 'https://scim.test/enterprise';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.PROXY_BASE_URL = 'http://proxy.test';
  process.env.LOG_LEVEL = 'error';
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    // Fork pool-membership preflight before destructive operations: this user is not pool-managed.
    if (url.endsWith('/pool-membership') && method === 'GET') return jsonResponse(200, { managed: false });
    requests.push(`${method} ${url}`);
    if (url.endsWith('/copilot/billing/selected_users') && method === 'DELETE') return jsonResponse(422, NOT_ASSIGNED_RESPONSE);
    if (url === 'https://scim.test/enterprise/Users/scim-wangwu' && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith('https://scim.test/enterprise/Users?filter=')) return jsonResponse(200, { Resources: [] });
    if (url === 'http://proxy.test/internal/enterprises/default/accounts/by-sso-user/wangwu' && method === 'DELETE') {
      return jsonResponse(200, { ssoUser: 'wangwu', matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 });
    }
    throw new Error(`Unexpected external step: ${method} ${url}`);
  };

  const { createUser, getUser, updateCopilotSeatFromGitHub, updateEmu } = await import('../db/usersRepo.js');
  const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
  const { runSsoUserBatch } = await import('./service.js');
  const enterprise = (await import('../enterprises.js')).defaultSsoEnterprise();
  updateSsoRuntimeSettings(enterprise.id, {
    expectedVersion: 1,
    changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 },
  });
  // Same local writes as applying an Import from GH row for a user without a direct seat.
  const importFromGh = () => {
    updateEmu(enterprise.id, 'wangwu', { ghLogin: 'wangwu_selfsso', ghScimId: 'scim-wangwu', emuStatus: 'active' });
    updateCopilotSeatFromGitHub(enterprise.id, 'wangwu', { status: 'unassigned' });
  };
  createUser(enterprise.id, { ssoUser: 'wangwu', email: 'wangwu@example.test', passwordHash: 'hash', salt: 'salt' });
  importFromGh();

  const removed = await runSsoUserBatch(enterprise, { operation: 'remove_copilot', ssoUsers: ['wangwu'] });
  assert.equal(removed.rows[0]?.status, 'success', removed.rows[0]?.detail);
  assert.match(removed.rows[0]?.warning ?? '', /has no Copilot seat; seat removal was skipped/);
  assert.equal(getUser(enterprise.id, 'wangwu')?.copilotSeatStatus, 'unassigned');

  const deletedEmu = await runSsoUserBatch(enterprise, { operation: 'delete_emu', ssoUsers: ['wangwu'] });
  assert.equal(deletedEmu.rows[0]?.status, 'success', deletedEmu.rows[0]?.detail);
  assert.match(deletedEmu.rows[0]?.warning ?? '', /has no Copilot seat/);
  assert.equal(getUser(enterprise.id, 'wangwu')?.emuStatus, 'not_synced');
  assert.ok(requests.includes('DELETE https://scim.test/enterprise/Users/scim-wangwu'));

  importFromGh();
  requests.length = 0;
  const deletedSso = await runSsoUserBatch(enterprise, { operation: 'delete_sso', ssoUsers: ['wangwu'] });
  assert.equal(deletedSso.rows[0]?.status, 'success', deletedSso.rows[0]?.detail);
  assert.match(deletedSso.rows[0]?.warning ?? '', /has no Copilot seat/);
  assert.equal(getUser(enterprise.id, 'wangwu'), undefined);
  assert.ok(requests.includes('DELETE https://scim.test/enterprise/Users/scim-wangwu'));
  assert.ok(requests.includes('DELETE http://proxy.test/internal/enterprises/default/accounts/by-sso-user/wangwu'));
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
