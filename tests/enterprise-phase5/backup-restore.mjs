import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Host-only orchestration. Importing this file never starts Docker or connects.
const insist = (v, code) => { if (!v) throw new Error(`phase5_${code}`); };
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const write = (file, v) => writeFileSync(file, JSON.stringify(v, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
function parse(argv) { const r = {}; for (let i = 0; i < argv.length; i += 2) { insist(/^--[a-z-]+$/.test(argv[i]) && argv[i + 1] && !r[argv[i].slice(2)], 'explicit_arguments_required'); r[argv[i].slice(2)] = argv[i + 1]; } return r; }
function checked(command, argv, options = {}) {
  const result = spawnSync(command, argv, { timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options });
  insist(!result.error && result.status === 0, 'backup_client_failed_details_suppressed'); return result.stdout?.toString() ?? '';
}
export async function backupRestore(input = parse(process.argv.slice(2))) {
  const { loadState, assertOwnedContainer, within, noSymlinkPath } = await import('./safety.mjs');
  insist(process.env.PHASE5_SYNTHETIC_ONLY === '1' && process.env.PHASE5_DB_ALLOW_DDL === '1', 'explicit_synthetic_ddl_gate_required');
  const state = loadState(input.state);
  insist(['dump', 'restore'].includes(input.operation), 'invalid_backup_operation');
  const schema = input.schema ?? 'ghcp_enterprise_test_phase5_chain';
  insist(state.database.schemas.includes(schema) && /^ghcp_enterprise_test_phase5_(?:chain|fault_v[234]|compat_direct|compat_pool)$/.test(schema), 'backup_schema_not_owned');
  const service = input.service ?? (input.operation === 'restore' ? 'mysql-restore' : 'mysql');
  insist(['mysql','mysql-restore'].includes(service) && (input.operation !== 'restore' || service === 'mysql-restore'), 'invalid_backup_service');
  const owner = state.ownership.containers[service]; insist(owner?.id, 'new_owned_container_required');
  const inspected = JSON.parse(checked('docker', ['inspect', owner.id]))[0];
  assertOwnedContainer(state, inspected, service);
  insist(inspected.State?.Running === true, 'owned_mysql_not_running');
  if (service === 'mysql-restore') insist(owner.id !== state.ownership.containers.mysql.id, 'restore_requires_distinct_instance');
  const env = { ...process.env, MYSQL_PWD: state.database.rootPassword };
  // Pass only the variable NAME through Docker's argv. The synthetic value stays in child environment.
  const base = ['exec', '-e', 'MYSQL_PWD', owner.id];
  const sql = statement => checked('docker', [...base, 'mysql', '-uroot', '--batch', '--skip-column-names', '-e', statement], { env }).trim();
  insist(/^8\.4\./.test(sql('SELECT VERSION()')), 'owned_mysql84_required');
  if (input.operation === 'dump') {
    within(state.root + '/backups', input.output); noSymlinkPath(dirname(input.output));
    insist(!existsSync(input.output) && !existsSync(input.output + '.json'), 'backup_output_exists');
    const fd = openSync(input.output, 'wx', 0o600);
    try {
      checked('docker', [...base, 'mysqldump', '-uroot', '--single-transaction', '--skip-lock-tables', '--skip-add-locks', '--skip-add-drop-table',
        '--routines', '--events', '--triggers', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', '--column-statistics=0', schema],
      { env, stdio: ['ignore', fd, 'pipe'] });
    } finally { closeSync(fd); }
    insist(lstatSync(input.output).size > 1000, 'dump_empty');
    const files = [];
    if (input['chain-dir']) {
      within(state.hostPaths.fixture, input['chain-dir']); noSymlinkPath(input['chain-dir']);
      const target = input.output + '.files'; mkdirSync(target, { mode: 0o700 });
      for (const name of readdirSync(input['chain-dir']).sort()) {
        insist(/^[a-z0-9-]+\.(?:json|sqlite)$/.test(name), 'unexpected_chain_artifact');
        const source = join(input['chain-dir'], name); insist(lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(), 'regular_chain_artifact_required');
        if (name.endsWith('.sqlite')) {
          insist(!['-wal', '-shm', '-journal'].some(s => existsSync(source + s)), 'standalone_sqlite_required');
          const bytes = readFileSync(source); insist(bytes.subarray(0, 16).toString() === 'SQLite format 3\0' && bytes[18] === 1 && bytes[19] === 1, 'standalone_sqlite_required');
        }
        copyFileSync(source, join(target, name), constants.COPYFILE_EXCL); files.push({ name, sha256: hash(source) });
      }
    }
    write(input.output + '.json', { status: 'PASS', operation: 'dump', syntheticOnly: true, runId: state.runId, schema,
      containerId: owner.id, sha256: hash(input.output), bytes: lstatSync(input.output).size, files,
      consistentSnapshot: 'mysqldump single transaction; application writers must remain stopped', sqlite: 'standalone immutable images' });
  } else {
    within(state.root + '/backups', input.backup); noSymlinkPath(input.backup);
    within(state.hostPaths.fixture, input['output-dir']); noSymlinkPath(input['output-dir']);
    within(state.root + '/results', input.output); noSymlinkPath(input.output);
    insist(!existsSync(input['output-dir']) && !existsSync(input.output), 'restore_output_exists');
    const receipt = JSON.parse(readFileSync(input.backup + '.json', 'utf8'));
    insist(receipt.status === 'PASS' && receipt.operation === 'dump' && receipt.runId === state.runId && receipt.schema === schema
      && receipt.containerId === state.ownership.containers.mysql.id && receipt.sha256 === hash(input.backup), 'backup_integrity_or_binding_mismatch');
    for (const f of receipt.files ?? []) {
      insist(/^[a-z0-9-]+\.(?:json|sqlite)$/.test(f.name), 'unexpected_backup_artifact');
      const file = join(input.backup + '.files', f.name); noSymlinkPath(file);
      insist(lstatSync(file).isFile() && hash(file) === f.sha256, 'backup_file_hash_mismatch');
    }
    insist(sql(`SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${schema}'`) === '1', 'precreated_restore_schema_required');
    for (const [table, column] of [['TABLES', 'TABLE_SCHEMA'], ['TRIGGERS', 'TRIGGER_SCHEMA'], ['ROUTINES', 'ROUTINE_SCHEMA'], ['EVENTS', 'EVENT_SCHEMA']])
      insist(sql(`SELECT COUNT(*) FROM information_schema.${table} WHERE ${column}='${schema}'`) === '0', 'restore_target_not_empty');
    const fd = openSync(input.backup, 'r');
    try { checked('docker', ['exec', '-i', '-e', 'MYSQL_PWD', owner.id, 'mysql', '-uroot', '--binary-mode=1', schema], { env, stdio: [fd, 'pipe', 'pipe'] }); }
    finally { closeSync(fd); }
    within(state.hostPaths.fixture, input['output-dir']); noSymlinkPath(dirname(input['output-dir']));
    insist(!existsSync(input['output-dir']), 'restore_files_target_exists'); mkdirSync(input['output-dir'], { mode: 0o700 });
    for (const f of receipt.files ?? []) {
      insist(/^[a-z0-9-]+\.(?:json|sqlite)$/.test(f.name), 'unexpected_backup_artifact');
      const source = join(input.backup + '.files', f.name); insist(hash(source) === f.sha256, 'backup_file_hash_mismatch');
      copyFileSync(source, join(input['output-dir'], f.name), constants.COPYFILE_EXCL);
      insist(hash(join(input['output-dir'], f.name)) === f.sha256, 'restore_file_hash_mismatch');
    }
    within(state.root + '/results', input.output);
    write(input.output, { status: 'PASS', operation: 'restore', syntheticOnly: true, runId: state.runId, schema,
      separateInstance: true, sameDatabaseName: true, backupSha256: receipt.sha256, copiedFiles: (receipt.files ?? []).length,
      receiptOrMarkerRewritten: false, nextAction: receipt.files?.some(f => f.name === 'v4-plan.json')
        ? 'migration-chain.ts --stage restore-verify --service mysql-restore --directory restored-directory'
        : 'Restored v1/v2/v3 image: dump restored instance with --service mysql-restore, then run each remaining migration-chain stage with that service and restored directory' });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) backupRestore().catch(error => {
  console.error(/^phase5_[a-z0-9_]+$/.test(error.message) ? error.message : 'phase5_backup_operation_failed_details_suppressed'); process.exitCode = 1;
});
