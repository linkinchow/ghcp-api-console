import assert from 'node:assert/strict';
import test from 'node:test';

test('GHE.com mode ignores ENTERPRISE_SHORTCODE and uses unsuffixed GH logins for Copilot seats', async () => {
  process.env.DB_PATH = ':memory:';
  process.env.SSO_USER_EVENTS_LOG = '/dev/null';
  process.env.SCIM_BASE_URL = 'https://api.sample-ent.ghe.com/scim/v2/enterprises/sample-ent';
  process.env.SCIM_TOKEN = 'test-scim-token';
  process.env.GITHUB_BASE_URL = 'https://sample-ent.ghe.com';
  process.env.GITHUB_API_BASE_URL = 'https://api.sample-ent.ghe.com';
  process.env.ENTERPRISE_SLUG = 'sample-ent';
  process.env.ENTERPRISE_SHORTCODE = '73h2pyw9';
  process.env.GITHUB_COPILOT_SEAT_PAT = 'test-seat-token';
  process.env.LOG_LEVEL = 'error';

  const originalFetch = globalThis.fetch;
  const seatAssignments: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    // GHE.com hides the shortcode and its REST API rejects suffixed usernames.
    if (url.includes('_73h2pyw9') || body.includes('_73h2pyw9')) {
      return jsonResponse(404, { message: 'Unable to complete request that contains suffixed values in the request parameters. Remove the suffix and request again.', status: '404' });
    }
    if (url === 'https://api.sample-ent.ghe.com/scim/v2/enterprises/sample-ent/Users' && init?.method === 'POST') {
      const user = JSON.parse(body) as { userName: string };
      return jsonResponse(201, { id: `scim-${user.userName}`, userName: user.userName, active: true });
    }
    if (url.startsWith('https://api.sample-ent.ghe.com/scim/v2/enterprises/sample-ent/Users?')) {
      return jsonResponse(200, {
        totalResults: 2,
        Resources: ['alice', 'bob'].map((name) => ({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          id: `scim-${name}`,
          userName: name,
          active: true,
          emails: [{ value: `${name}@example.com`, primary: true }],
        })),
      });
    }
    if (url === 'https://api.sample-ent.ghe.com/enterprises/sample-ent/copilot/billing/selected_users' && init?.method === 'POST') {
      seatAssignments.push(...(JSON.parse(body) as { selected_usernames: string[] }).selected_usernames);
      return jsonResponse(201, { seats_created: 1 });
    }
    if (url === 'https://api.sample-ent.ghe.com/enterprises/sample-ent/members/alice/copilot') {
      return jsonResponse(200, { seats: [{ assignee: { login: 'alice' }, pending_cancellation_date: null }] });
    }
    if (url.startsWith('https://api.sample-ent.ghe.com/enterprises/sample-ent/copilot/billing/seats')) {
      return jsonResponse(200, { total_seats: 1, seats: [{ assignee: { login: 'bob' }, pending_cancellation_date: null }] });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  };

  try {
    const { config } = await import('../config.js');
    const { createUser, getUser } = await import('../db/usersRepo.js');
    const { updateSsoRuntimeSettings } = await import('../db/runtimeSettingsRepo.js');
    const { createEmuImportPlan, listEmuImportPlanRows, runSsoUserBatch } = await import('./service.js');
    assert.equal(config.gheCom, true);
    assert.equal(config.enterpriseShortcode, '');
    updateSsoRuntimeSettings({ expectedVersion: 1, changes: { scimRequestDelayMs: 0, scimMaxRetries: 0 } });
    createUser({ ssoUser: 'alice', passwordHash: 'hash', salt: 'salt', email: 'alice@example.com' });

    const synced = await runSsoUserBatch({ operation: 'sync_emu', ssoUsers: ['alice'], assignCopilotSeat: true });

    assert.equal(synced.rows[0]?.detail, 'Synced to EMU and assigned Copilot seat.');
    assert.equal(getUser('alice')?.ghLogin, 'alice');
    assert.equal(getUser('alice')?.copilotSeatStatus, 'assigned');
    assert.deepEqual(seatAssignments, ['alice']);

    const plan = await createEmuImportPlan();
    const bob = listEmuImportPlanRows(plan.planId).items.find((row) => row.ssoUser === 'bob');
    assert.equal(bob?.ghLogin, 'bob');
    assert.equal(bob?.copilotSeatStatus, 'assigned');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
