import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'mysql2/promise';
import { args, assertEmpty, connect, hashFile, insist, loadDbGate, resultPath, safeError, sha256, writePrivate } from './db-gate.js';
import { legacySource, seedLegacyMysql } from './db-fixtures.js';

export type FaultMode = 'known-before' | 'known-after' | 'ack-ddl' | 'ack-commit' | 'kill-ddl';
/** Transport-only injection. SQL executes unchanged; lost ACK means server result arrives before socket destruction/throw. */
export function interceptConnection(c: Connection, match: (sql: string) => boolean, after: boolean,
  effect?: (sql: string, dispatch: () => Promise<unknown>) => Promise<unknown>) {
  let hit = false;
  const connection = new Proxy(c, { get(target, key) {
    if (key === 'query') return async (...a: any[]) => {
      const sql = typeof a[0] === 'string' ? a[0] : a[0]?.sql;
      const dispatch = () => Reflect.apply(target.query, target, a);
      if (!hit && typeof sql === 'string' && match(sql)) {
        hit = true;
        if (effect) return effect(sql, dispatch);
        if (after) await dispatch();
        if (after) c.destroy();
        throw new Error(after ? 'phase5_injected_ack_loss' : 'phase5_injected_before_dispatch');
      }
      return dispatch();
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { connection, hit: () => hit };
}
export async function migrationFaults(input = args()): Promise<void> {
  const state = await loadDbGate(input.state, input.inspect);
  resultPath(state, input.output);
  insist(['v2', 'v3', 'v4'].includes(input.version) && ['seed', 'run'].includes(input.stage), 'invalid_fault_stage');
  const schema = `ghcp_enterprise_test_phase5_fault_${input.version}`;
  const fixture = input.state.startsWith('/fixture/') ? '/fixture' : state.hostPaths.fixture;
  const registry = JSON.parse(readFileSync(existsSync(state.registryFile) ? state.registryFile : join(fixture, 'registry.json'), 'utf8'));
  const profile = registry.profiles.find((p: any) => p.id === registry.legacyEnterpriseId);
  const legacy = Object.fromEntries(['id', 'slug', 'shortcode', 'accountDomain', 'revision', 'routes'].map(k => [k, profile[k]]));
  let c = await connect(state, schema);
  try {
    if (input.stage === 'seed') {
      await assertEmpty(c);
      if (input.version === 'v2') await seedLegacyMysql(c, legacySource(), profile);
      else {
        const pool = { fingerprint: sha256('phase5-fault-fixture'), settings: { version: 1, idle_target: 1, lease_seconds: 172800,
          paused: 1 as const, next_ordinal: 0, account_domain: profile.accountDomain, owner: null, owner_until: 0 } };
        if (input.version === 'v3') {
          const { initEnterpriseMysql } = await import('../../src/packages/shared/src/enterpriseMysql.js');
          await initEnterpriseMysql(c, 'proxy', legacy as any, { layout: 'pool', maxAccounts: profile.maxAccounts, pool });
        } else {
          const { initEnterpriseMysqlV3 } = await import('../../src/packages/shared/src/enterpriseMysqlV3.js');
          await initEnterpriseMysqlV3(c, 'proxy', registry, { layout: 'pool', pool });
        }
      }
      writePrivate(input.output, { status: 'PASS', stage: 'fault-seed', version: input.version, runId: state.runId, syntheticOnly: true, schema,
        nextAction: 'host dump this exact schema, then run stage with --backup actual dump path' }); return;
    }
    insist(input.backup && hashFile(input.backup), 'actual_fault_backup_required');
    const backup = JSON.parse(readFileSync(input.backup + '.json', 'utf8'));
    insist(backup.status === 'PASS' && backup.operation === 'dump' && backup.runId === state.runId && backup.schema === schema
      && backup.containerId === state.ownership.containers.mysql.id && backup.sha256 === hashFile(input.backup), 'fault_backup_binding_mismatch');
    const versions = {
      v2: await import('../../upgrade/default-enterprise/mysql.js'),
      v3: await import('../../upgrade/multi-enterprise/mysql.js'),
      v4: await import('../../upgrade/multi-enterprise-pool/mysql.js'),
    };
    const api: any = versions[input.version as keyof typeof versions];
    const suffix = input.version === 'v2' ? '' : input.version.toUpperCase();
    const preflight = api[`preflightEnterpriseMysql${suffix}`], apply = api[`applyEnterpriseMysql${suffix}`];
    const verify = api[`verifyEnterpriseMysqlMigration${suffix}`];
    const subject = input.version === 'v2' ? legacy : registry;
    const before = await preflight(c, subject, 'pool');
    const options: any = { migrationId: `phase5-fault-${input.version}`, expectedDatabase: schema,
      expectedSourceSha256: before.sourceSha256, manifestSha256: sha256(JSON.stringify({ version: input.version, backup: backup.sha256, schema, registry })),
      backupReference: `phase5-${state.runId}-fault-${input.version}`, backupSha256: backup.sha256,
      confirmOffline: true, confirmBackup: true, confirmDrained: true, layout: 'pool',
      ...(input.version === 'v3' ? { accountIncarnations: before.accountIncarnations } : {}) };
    const table = input.version === 'v2' ? 'enterprise_upgrade' : `enterprise_upgrade_${input.version}`;
    const checkpoints: any[] = [];
    const saved = async () => (await c.query<any[]>(`SELECT step,checkpoint_state,state FROM ${table}`))[0][0];
    const reconnect = async () => { await c.end().catch(() => c.destroy()); c = await connect(state, schema); };
    // Persist known-before, stop BEFORE unknown marker dispatch. Explicit resume validates exact before shape.
    let wrapped = interceptConnection(c, sql => sql === `UPDATE ${table} SET checkpoint_state='unknown' WHERE singleton=1`, false);
    await assert.rejects(apply(wrapped.connection, subject, options)); insist(wrapped.hit(), 'known_before_injection_not_hit');
    await reconnect(); let checkpoint = await saved(); assert.equal(checkpoint.checkpoint_state, 'before'); checkpoints.push({ kind: 'known-before', ...checkpoint });
    // Resume step1; stop after acknowledged after marker without destroying that durable evidence.
    wrapped = interceptConnection(c, sql => sql.startsWith(`UPDATE ${table} SET checkpoint_state='after',state=`), true);
    await assert.rejects(apply(wrapped.connection, subject, { ...options, resume: true })); insist(wrapped.hit(), 'known_after_injection_not_hit');
    await reconnect(); checkpoint = await saved(); assert.equal(checkpoint.checkpoint_state, 'after'); checkpoints.push({ kind: 'known-after', ...checkpoint });
    // A separate, explicit resume confirms known-after before delivering an ambiguous server operation.
    const mode = input.mode ?? (input.version === 'v2' ? 'ack-ddl' : input.version === 'v3' ? 'kill-ddl' : 'ack-commit');
    insist(['ack-ddl', 'ack-commit', 'kill-ddl'].includes(mode), 'invalid_fault_mode');
    let blockedDdlObserved = false, killedOwnedConnection = false;
    if (mode === 'kill-ddl') {
      const blocker = await connect(state, schema), killer = await connect(state, schema);
      try {
        await blocker.beginTransaction(); await blocker.query('SELECT identity FROM proxy_accounts FOR UPDATE');
        const [ids] = await c.query<any[]>('SELECT CONNECTION_ID() AS id'); const id = Number(ids[0].id); insist(Number.isSafeInteger(id) && id > 0, 'invalid_owned_connection_id');
        wrapped = interceptConnection(c, sql => /^(?:DROP TRIGGER enterprise_account_immutable|ALTER TABLE proxy_accounts )/.test(sql), false, async (_sql, dispatch) => {
          const pending = dispatch().then(value => ({ value }), error => ({ error }));
          try {
            for (let i = 0; i < 50; i++) {
              const [rows] = await killer.query<any[]>('SELECT STATE,DB FROM information_schema.PROCESSLIST WHERE ID=?', [id]);
              if (rows[0]?.DB === schema && /metadata lock/i.test(rows[0]?.STATE ?? '')) { blockedDdlObserved = true; break; }
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            insist(blockedDdlObserved, 'blocked_ddl_not_observed');
            // Only the connection opened above on this run schema may be killed, never a scanned arbitrary thread.
            await killer.query(`KILL CONNECTION ${id}`); killedOwnedConnection = true;
            const result = await pending; if ('error' in result) throw result.error;
            insist(false, 'killed_ddl_unexpected_success');
          } finally { await blocker.rollback(); }
        });
        await assert.rejects(apply(wrapped.connection, subject, { ...options, resume: true }));
      } finally { await blocker.rollback().catch(() => {}); await blocker.end().catch(() => blocker.destroy()); await killer.end().catch(() => killer.destroy()); }
    } else wrapped = interceptConnection(c, sql => mode === 'ack-commit' ? sql === 'COMMIT' : /^(?:CREATE|ALTER|DROP) (?:TABLE|TRIGGER) /.test(sql), true);
    if (mode !== 'kill-ddl') await assert.rejects(apply(wrapped.connection, subject, { ...options, resume: true }));
    insist(wrapped.hit(), 'unknown_injection_not_hit'); await reconnect(); checkpoint = await saved();
    assert.equal(checkpoint.checkpoint_state, 'unknown'); checkpoints.push({ kind: mode, ...checkpoint });
    if (input.version === 'v2') {
      // Frozen v2 intentionally proves its exact before/after state; do not change it to v3/v4 semantics.
      await apply(c, subject, { ...options, resume: true }); await verify(c, subject, options);
      checkpoint = await saved(); assert.equal(checkpoint.state, 'complete'); checkpoints.push({ kind: 'v2-exact-state-resume', ...checkpoint });
    } else {
      await assert.rejects(apply(c, subject, { ...options, resume: true }), /unknown_manual_inspection_required/);
      assert.deepEqual(await saved(), checkpoint, 'Rejected resume must not rewrite a checkpoint');
    }
    writePrivate(input.output, { status: 'PASS', syntheticOnly: true, runId: state.runId, schema, version: input.version,
      checkpoints, mode, blockedDdlObserved, killedOwnedConnection, backupSha256: backup.sha256,
      faultModel: mode.startsWith('ack-') ? 'server result received, then injected client ACK loss and socket destroy; not network chaos' : 'actual server metadata lock then kill exact owned connection',
      policy: input.version === 'v2' ? 'frozen-v2-exact-before-after-proof' : 'unknown-checkpoint-fail-closed-no-marker-edit', retainedForInspection: true });
  } finally { await c.end().catch(() => c.destroy()); }
}
if (process.argv[1]?.endsWith('migration-faults.ts')) migrationFaults().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
