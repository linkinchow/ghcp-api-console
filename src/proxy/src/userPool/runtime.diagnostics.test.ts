import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../config.js';
import { getLocalUserPoolSchedulerSnapshot } from './runtime.js';

test('absent local worker diagnostics never initialize storage, read pool configuration, or imply global health', t => {
  const before = { ...config };
  const mode = process.env.ACCOUNT_ROUTING_MODE;
  t.after(() => {
    Object.assign(config, before);
    if (mode === undefined) delete process.env.ACCOUNT_ROUTING_MODE;
    else process.env.ACCOUNT_ROUTING_MODE = mode;
  });
  // Reading pool configuration or initializing MySQL would throw with these values.
  process.env.ACCOUNT_ROUTING_MODE = 'invalid-observational-read-sentinel';
  config.storageDriver = 'mysql';
  config.mysqlSslMode = 'verify-ca';
  config.mysqlSslCaPath = 'nonexistent-local-diagnostics-sentinel.pem';
  for (let i = 0; i < 5; i++) assert.equal(getLocalUserPoolSchedulerSnapshot(), undefined);
});
