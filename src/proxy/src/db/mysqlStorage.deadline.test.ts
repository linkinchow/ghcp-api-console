import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { MysqlStorage } from './mysqlStorage.js';
import { MysqlDeadlineError } from '../userPool/mysqlDeadline.js';

function fixture(mode: 'execute' | 'commit' | 'rollback' = 'execute') {
  let destroyed = 0, released = 0, rollbacks = 0;
  const calls: string[] = [];
  const connection = {
    async execute(sql: string) {
      calls.push(sql);
      if (mode === 'execute') return new Promise(() => {});
      if (sql.startsWith('SELECT')) return [[{ found: 1 }], []];
      if (mode === 'rollback') throw new Error('write failed');
      return [{ affectedRows: 1 }, []];
    },
    async beginTransaction() {},
    async commit() { throw new Error('commit response lost'); },
    async rollback() { rollbacks++; throw new Error('rollback response lost'); },
    destroy() { destroyed++; }, release() { released++; },
  } as unknown as PoolConnection;
  const pool = { async getConnection() { return connection; } } as unknown as Pool;
  return { storage: new MysqlStorage(pool, 2), counts: () => ({ destroyed, released, rollbacks }), calls };
}

for (const operation of ['getAccount', 'recordRequestStat', 'ping'] as const) {
  test(`generic MySQL ${operation} bounds stalled SQL and destroys its socket`, async () => {
    const f = fixture();
    const call = operation === 'getAccount' ? f.storage.getAccount('synthetic')
      : operation === 'ping' ? f.storage.ping()
        : f.storage.recordRequestStat({ identity: 'synthetic', path: '/v1/messages', success: true });
    await assert.rejects(call, error => error instanceof MysqlDeadlineError);
    assert.deepEqual(f.counts(), { destroyed: 1, released: 0, rollbacks: 0 });
  });
}

test('generic account deletion never replays or rolls back an uncertain commit', async () => {
  const f = fixture('commit');
  await assert.rejects(f.storage.deleteAccount('synthetic'), /commit response lost/);
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0, rollbacks: 0 });
  assert.equal(f.calls.filter(sql => sql.startsWith('DELETE FROM proxy_accounts')).length, 1);
});

test('generic account deletion destroys a connection after unconfirmed rollback', async () => {
  const f = fixture('rollback');
  await assert.rejects(f.storage.deleteAccount('synthetic'), /write failed/);
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0, rollbacks: 1 });
});
