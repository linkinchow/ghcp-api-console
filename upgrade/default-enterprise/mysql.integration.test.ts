import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnection } from 'mysql2/promise';
import { mysqlCreateTable } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { enterpriseMysqlSchema, enterpriseMysqlCreateTrigger, MYSQL_FENCE_TRIGGER, validateEnterpriseMysql } from '../../src/packages/shared/src/enterpriseMysql.js';
import { applyEnterpriseMysql, preflightEnterpriseMysql, verifyEnterpriseMysqlMigration } from './mysql.js';
import { profile, plan } from './mysql.fixture.js';

// Never read .env, discover servers, start Docker, or connect externally. Both explicit flags are required.
const enabled = process.env.ENTERPRISE_MYSQL_TEST === '1' && process.env.ENTERPRISE_MYSQL_TEST_ALLOW_DDL === '1';
test('real MySQL 8 dedicated loopback database: migration, FK/checks/immutability and binary preservation',
  { skip: !enabled ? 'No explicit opt-in dedicated loopback MySQL instance' : false }, async t => {
    const raw = process.env.ENTERPRISE_MYSQL_TEST_URL;
    assert(raw, 'Dedicated test URL is required');
    const url = new URL(raw);
    assert.equal(url.protocol, 'mysql:');
    assert(['127.0.0.1', '[::1]'].includes(url.hostname), 'Only numeric loopback is permitted');
    assert.match(url.pathname, /^\/ghcp_enterprise_test_[a-z0-9_]+$/);
    assert.equal(url.search, ''); assert.equal(url.hash, '');
    const connection = await createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 3306), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: url.pathname.slice(1), connectTimeout: 3000, dateStrings: true,
      supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z', charset: 'utf8mb4', multipleStatements: false });
    try {
      const [existing] = await connection.query<any[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
      assert.equal(existing.length, 0, 'Refuse to touch any nonempty database schema');
      for (const layout of ['direct', 'pool'] as const) await t.test(layout, async () => {
        const schema = enterpriseMysqlSchema(layout, 1);
        try {
          for (const name of Object.keys(schema)) await connection.query(mysqlCreateTable(name, schema));
          for (const id of ['2026-08-27-proxy-mysql-initial', '2026-08-27-proxy-token-binary-collation', ...(layout === 'pool' ? ['2026-09-12-user-pool-mysql-v1'] : [])]) {
            await connection.query('INSERT INTO schema_migrations VALUES (?, UTC_TIMESTAMP(3))', [id]);
          }
          const token = '  Bytes \0 aAß☃  ';
          await connection.query(`INSERT INTO proxy_accounts (identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at)
            VALUES ('alice','alice','Alice',?,'valid','2026-09-18 00:00:00.123','2026-09-17 00:00:00.000','2026-09-18 00:00:00.000')`, [token]);
          const attempt = 'ab12de34-1234-4321-9123-abcdef012345';
          const lease = 'bc12de34-1234-4321-9123-abcdef012345';
          const caller = `sha256:${'c'.repeat(64)}`;
          let preservedMember: any[] | undefined;
          let preservedLease: any[] | undefined;
          if (layout === 'pool') {
            await connection.query(`INSERT INTO user_pool_settings (id,idle_target,max_accounts,lease_seconds,paused,next_ordinal,account_domain,config_fingerprint)
              VALUES (1,2,6,172800,1,1,?,?)`, [profile.accountDomain, 'a'.repeat(64)]);
            await connection.query(`INSERT INTO user_pool_accounts (identity,ordinal,state,stage,attempt_id,oauth_attempt_id,sso_created_at,task_id,
              attempts,retry_at,last_error,updated_at,cooldown_until,verified_at,generation,reauth_count,reauth_window_at)
              VALUES ('alice',0,'ready','ready',?,?,'2026-09-17T00:00:00.000Z','completed-task',2,0,NULL,1700000000000,0,1700000000000,7,1,1699999999999)`,
            [attempt, attempt]);
            await connection.query(`INSERT INTO user_pool_leases (caller_id,member_identity,lease_id,phase,assigned_at,last_success_at,expires_at)
              VALUES (?,'alice',?,'active',1700000000000,1700000000123,1700172800000)`, [caller, lease]);
            await connection.query(enterpriseMysqlCreateTrigger('user_pool_credential_fence', MYSQL_FENCE_TRIGGER));
            [preservedMember] = await connection.query<any[]>('SELECT * FROM user_pool_accounts ORDER BY identity');
            [preservedLease] = await connection.query<any[]>('SELECT * FROM user_pool_leases ORDER BY caller_id');
          }
          const before = await preflightEnterpriseMysql(connection, profile, layout);
          const options = { ...plan(before.sourceSha256), expectedDatabase: url.pathname.slice(1) };
          await applyEnterpriseMysql(connection, profile, options);
          await verifyEnterpriseMysqlMigration(connection, profile, options);
          await validateEnterpriseMysql(connection, 'proxy', profile);
          const [rows] = await connection.query<any[]>('SELECT HEX(copilot_oauth_token) AS token,enterprise_id FROM proxy_accounts');
          assert.equal(rows[0].token, Buffer.from(token).toString('hex').toUpperCase()); assert.equal(rows[0].enterprise_id, profile.id);
          await assert.rejects(connection.query('UPDATE proxy_accounts SET enterprise_id=NULL'));
          await assert.rejects(connection.query("UPDATE enterprise_profiles SET profile_json='{}'"));
          await assert.rejects(connection.query("UPDATE enterprise_profiles SET slug='other'"));
          await assert.rejects(connection.query('DELETE FROM enterprise_profiles'));
          await assert.rejects(connection.query('UPDATE enterprise_profiles SET max_accounts=10001'));
          if (layout === 'pool') {
            const [members] = await connection.query<any[]>('SELECT * FROM user_pool_accounts ORDER BY identity');
            const [leases] = await connection.query<any[]>('SELECT * FROM user_pool_leases ORDER BY caller_id');
            assert.deepEqual(members, preservedMember, 'Enterprise backfill must not change generation/verification or provisioning evidence');
            assert.deepEqual(leases, preservedLease, 'Caller, lease IDs, member and all deadlines must survive unchanged');
            await connection.query('UPDATE enterprise_profiles SET max_accounts=7');
            assert.equal((await validateEnterpriseMysql(connection, 'proxy', profile)).maxAccounts, 7);
            await connection.query("UPDATE proxy_accounts SET copilot_oauth_token=? WHERE identity='alice'", [token + 'changed']);
            const [fenced] = await connection.query<any[]>("SELECT generation,verified_at FROM user_pool_accounts WHERE identity='alice'");
            assert.equal(Number(fenced[0].generation), Number(preservedMember![0].generation) + 1);
            assert.equal(fenced[0].verified_at, null);
            const [unchangedLeases] = await connection.query<any[]>('SELECT * FROM user_pool_leases ORDER BY caller_id');
            assert.deepEqual(unchangedLeases, preservedLease, 'Credential fence must not rebind or release the lease');
          } else {
            assert.equal((await validateEnterpriseMysql(connection, 'proxy', profile)).maxAccounts, undefined);
            // The registry allows a nullable capacity structurally; direct layout must reject a non-null value at its startup gate.
            await connection.query('UPDATE enterprise_profiles SET max_accounts=7');
            await assert.rejects(validateEnterpriseMysql(connection, 'proxy', profile), /enterprise_mysql_capacity/);
          }
        } finally {
          // Only exact tables created by this test, in reverse FK order. Never DROP DATABASE.
          for (const name of Object.keys(enterpriseMysqlSchema(layout)).reverse()) await connection.query(`DROP TABLE IF EXISTS \`${name}\``);
        }
      });
    } finally { await connection.end(); }
  });
