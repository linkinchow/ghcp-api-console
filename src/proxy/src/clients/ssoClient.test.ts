import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';

test('requests Copilot seat assignment when syncing a new Proxy identity', async () => {
  let requestBody: unknown;
  let requestPath: string | undefined;
  const server = createServer((req, res) => {
    requestPath = req.url;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        batchId: 'batch-1',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
        summary: { total: 1, success: 1, failed: 0 },
        rows: [{
          ssoUser: 'alice',
          status: 'success',
          detail: 'Synced to EMU and assigned Copilot seat.',
          user: {
            ssoUser: 'alice',
            email: 'alice@example.com',
            role: 'user',
            ghLogin: 'alice_emu',
            ghScimId: 'scim-alice',
            emuStatus: 'active',
            copilotSeatStatus: 'assigned',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  process.env.SSO_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.INTERNAL_API_TOKEN = 'test-token';

  try {
    const { syncEmuUser } = await import('./ssoClient.js');
    const user = await syncEmuUser(DEFAULT_ENTERPRISE_ID, 'alice', { assignCopilotSeat: true });

    assert.equal(user.copilotSeatStatus, 'assigned');
    assert.equal(requestPath, '/api/enterprises/default/users/batch');
    assert.deepEqual(requestBody, {
      operation: 'sync_emu',
      ssoUsers: ['alice'],
      assignCopilotSeat: true,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
