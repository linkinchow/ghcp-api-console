import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { PrewarmWorkerSnapshot } from '../userPool/worker.js';

const saved = { ...process.env };
const { config, createUserPoolApiRouter } = await (async () => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { DOTENV_CONFIG_PATH: join(tmpdir(), `no-scheduler-env-${randomUUID()}`),
    STORAGE_DRIVER: 'sqlite', DB_PATH: ':memory:', INTERNAL_API_TOKEN: 'local-scheduler-fixture' });
  try { return { ...await import('../config.js'), ...await import('./userPoolApi.js') }; }
  finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); }
})();
const token = 'local-scheduler-fixture';
const sample = (): PrewarmWorkerSnapshot => ({ scope: 'local_process', state: 'standby', observedAtUnixMs: 200000,
  localTenureAgeMs: null, lastSuccessfulRenewalAtUnixMs: 190000, lastSuccessfulRenewalAgeMs: 10000,
  claimAttempts: 3, ownershipAcquisitions: 1, ownershipLosses: 1,
  lastOwnershipLoss: { reason: 'storage_unavailable', storageFailure: 'connection', atUnixMs: 195000 } });

test('local scheduler diagnostics authenticate, remain storage-independent and expose only allowlisted state', async t => {
  const prior = config.internalApiToken; config.internalApiToken = token;
  let enabled = true, reads = 0, storeReads = 0, wakes = 0, snapshot: PrewarmWorkerSnapshot | undefined = sample();
  let thrown: Error | undefined;
  const app = express();
  app.use('/alternate', createUserPoolApiRouter({
    getStore: async () => { storeReads++; throw new Error('database is down password=synthetic-secret'); },
    wake: () => { wakes++; }, isPoolEnabled: () => enabled,
    localScheduler: () => { reads++; if (thrown) throw thrown; return snapshot; },
  }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); config.internalApiToken = prior; });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/alternate/user-pool/diagnostics/local`;
  const get = async (credential: string | null = token, query = '') => {
    const response = await fetch(url + query, { headers: credential ? { 'X-Internal-Token': credential } : {}, signal: AbortSignal.timeout(3000) });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as any };
  };
  for (const credential of [null, 'wrong']) assert.equal((await get(credential)).status, 401);
  assert.equal(reads, 0);
  const result = await get();
  assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
  assert.equal(result.body.scope, 'local_process'); assert.equal(result.body.enabled, true);
  assert.deepEqual(result.body.localScheduler, sample());
  assert.equal(storeReads, 0); assert.equal(wakes, 0);
  assert.equal((await get(token, '?refresh=1')).body.error.code, 'invalid_request');
  snapshot = undefined;
  assert.equal((await get()).body.localScheduler, null, 'No local worker does not imply no cluster owner');
  snapshot = { ...sample(), state: 'unsafe state', extra: 'synthetic-secret',
    lastOwnershipLoss: { reason: 'password=synthetic-secret', storageFailure: 'raw error synthetic-secret', atUnixMs: 195000, cause: 'synthetic-secret' } } as unknown as PrewarmWorkerSnapshot;
  const sanitized = await get();
  assert.equal(sanitized.body.localScheduler.state, 'unknown');
  assert.equal(sanitized.body.localScheduler.lastOwnershipLoss.reason, 'unknown');
  assert.ok(!JSON.stringify(sanitized.body).includes('synthetic-secret'));
  thrown = new Error('password=synthetic-secret');
  const failure = await get(); assert.equal(failure.status, 500); assert.equal(failure.cache, 'no-store');
  assert.equal(failure.body.error.code, 'pool_operation_failed'); assert.ok(!JSON.stringify(failure.body).includes('synthetic-secret'));
  enabled = false;
  const disabled = await get(); assert.equal(disabled.status, 409); assert.equal(disabled.cache, 'no-store');
  assert.equal(disabled.body.error.code, 'pool_mode_disabled');
  assert.equal(storeReads, 0); assert.equal(wakes, 0);
});
