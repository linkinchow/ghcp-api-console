import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertOwnedContainer, exclusiveJson, insist, loadState, noSymlinkPath, validateState } from '../enterprise-phase5/safety.mjs';

/** Main-only host controller; importing or planning does not run Docker/SQL. */
export const STAGES = Object.freeze(['seed', 'v2', 'v3', 'v4', 'verify', 'restore', 'restore-verify', 'names', 'register']);
const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const schema = 'ghcp_enterprise_test_phase5_chain';
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function parseQualificationArgs(argv) {
  const input = {};
  for (let i = 0; i < argv.length; i += 2) {
    insist(/^--(?:state|legacy-source|stage|execute)$/.test(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'), 'qualification_arguments');
    const key = argv[i].slice(2); insist(!Object.hasOwn(input, key), 'qualification_duplicate_argument'); input[key] = argv[i + 1];
  }
  return input;
}
export function qualificationPlan(input) {
  insist(Object.keys(input).every(key => ['state', 'legacy-source', 'stage', 'execute'].includes(key)) && STAGES.includes(input.stage), 'qualification_stage');
  insist(input.execute === undefined || input.execute === '1', 'qualification_execute_requires_one');
  for (const value of [input.state, input['legacy-source']]) insist(typeof value === 'string' && posix.isAbsolute(value)
    && posix.normalize(value) === value && !/[\\\x00-\x1f\x7f]/.test(value), 'qualification_canonical_linux_path_required');
  insist(/^\/opt\/ghcp-test\/phase5-[a-z0-9]{6,24}\/fixture\/state\.json$/.test(input.state), 'qualification_phase5_host_state_required');
  const root = posix.dirname(posix.dirname(input.state)), stage = input.stage;
  const output = suffix => posix.join(root, 'results', `phase7-${suffix}.json`);
  const dump = version => ({ kind: 'backup', operation: 'dump', schema, service: 'mysql',
    output: posix.join(root, 'backups', `phase7-${version}.sql`), 'chain-dir': posix.join(root, 'fixture', 'chain') });
  const chain = (version, extra = {}) => ({ kind: 'tool', entry: 'migration-chain.ts', args: { stage: version, ...extra },
    service: version === 'restore-verify' ? 'mysql-restore' : 'mysql', output: output(version) });
  let steps;
  if (stage === 'seed') steps = [chain('seed')];
  else if (['v2', 'v3', 'v4'].includes(stage)) {
    const previous = `v${Number(stage.slice(1)) - 1}`;
    steps = [dump(previous), chain(stage, { backup: `/backups/phase7-${previous}.sql` })];
  } else if (stage === 'verify') steps = [chain('verify'), dump('v4')];
  else if (stage === 'restore') steps = [{ kind: 'backup', operation: 'restore', schema, service: 'mysql-restore',
    backup: posix.join(root, 'backups', 'phase7-v4.sql'), 'output-dir': posix.join(root, 'fixture', 'phase7-restored'), output: output('restore') }];
  else if (stage === 'restore-verify') steps = [chain(stage, { directory: '/fixture/phase7-restored' })];
  else steps = [{ kind: 'tool', entry: stage === 'names' ? 'db-run.ts' : 'registration.ts',
    args: stage === 'names' ? { suite: 'names' } : {}, service: 'mysql', output: output(stage) }];
  return { version: 1, execution: 'PLAN_ONLY', realMysqlExecuted: false, root, state: input.state, legacySource: input['legacy-source'], stage,
    wrapperOutput: output(`${stage}-wrapper`), steps,
    requiredEnvironment: ['PHASE7_MIGRATION_QUALIFICATION=1', 'PHASE5_SYNTHETIC_ONLY=1', 'PHASE5_DB_ALLOW_DDL=1'],
    prerequisites: 'Main provisions fresh phase5 mode=migration fixture, owned MySQL8.4 and distinct restore instance and empty schemas via existing run.mjs. Never init/app-up before these offline stages.',
    order: STAGES, cleanup: 'No reset, schema drop, marker rewrite or automatic cleanup. Names suite alone uses existing acknowledged-empty mysqlHarness lifecycle; registration retains v4 schema and runs last.',
    claims: 'Public migration CLIs preflight/apply/verify/inspect/repeated apply --resume; real dump/restore only when executed successfully. Register uses the existing public command API harness. No runtime/HTTP/provider qualification.' };
}
export function validateQualificationState(state, plan, env = process.env) {
  insist(env.PHASE7_MIGRATION_QUALIFICATION === '1' && env.PHASE5_SYNTHETIC_ONLY === '1' && env.PHASE5_DB_ALLOW_DDL === '1', 'qualification_explicit_main_gate_required');
  validateState(state);
  insist(state.mode === 'migration' && state.root === plan.root && state.hostPaths.source === join(plan.root, 'workspace'), 'qualification_migration_fixture_required');
  insist(Object.keys(state.ownership.containers).every(service => ['mysql', 'mysql-restore'].includes(service))
    && !existsSync(join(state.hostPaths.fixture, 'ownership-app.json')), 'qualification_offline_no_app_ownership_required');
  for (const service of new Set(plan.steps.map(step => step.service))) insist(state.ownership.containers[service]?.id, 'qualification_owned_mysql_required');
  insist(!state.ownership.containers['mysql-restore'] || state.ownership.containers['mysql-restore'].id !== state.ownership.containers.mysql?.id,
    'qualification_distinct_restore_instance_required');
}
function cleanEnv() {
  return Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'TMP', 'TEMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
function argv(input) { return Object.entries(input).flatMap(([key, value]) => [`--${key}`, value]); }
function privateDir(path) {
  noSymlinkPath(path);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  insist(stat.isDirectory() && (stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'qualification_private_directory');
}
export async function migrationQualification(input = parseQualificationArgs(process.argv.slice(2))) {
  const plan = qualificationPlan(input);
  if (input.execute !== '1') return plan;
  insist(process.platform === 'linux', 'qualification_linux_main_host_required');
  // Nothing executable, no driver imports and no output creation before all gates.
  const state = loadState(input.state);
  validateQualificationState(state, plan);
  insist(realpathSync(sourceRoot) === realpathSync(state.hostPaths.source), 'qualification_run_from_exact_source_required');
  noSymlinkPath(input['legacy-source']);
  insist(isAbsolute(input['legacy-source']) && lstatSync(input['legacy-source']).isDirectory(), 'qualification_legacy_directory');
  insist(!existsSync(plan.wrapperOutput), 'qualification_output_exists');
  for (const step of plan.steps) {
    noSymlinkPath(step.output); insist(!existsSync(step.output), 'qualification_stage_output_exists');
    if (step.kind === 'backup' && step.operation === 'dump') insist(!existsSync(`${step.output}.json`) && !existsSync(`${step.output}.files`), 'qualification_backup_exists');
    if (step['output-dir']) insist(!existsSync(step['output-dir']), 'qualification_restore_directory_exists');
  }
  const privateRoot = join(state.hostPaths.results, 'private'); privateDir(privateRoot);
  const logs = join(privateRoot, `phase7-${plan.stage}`); insist(!existsSync(logs), 'qualification_evidence_exists'); privateDir(logs);
  const sourceFiles = ['tests/enterprise-phase5/migration-chain.ts', 'tests/enterprise-phase5/backup-restore.mjs',
    'tests/enterprise-phase5/registration.ts', 'tests/enterprise-phase5/db-run.ts', 'tests/enterprise-phase5/db-fixtures.ts',
    'tests/enterprise-phase7/migration-qualification.mjs', 'tests/enterprise-phase7/name-gate.ts',
    'upgrade/multi-enterprise-pool/nameCatalog.integration.test.ts'].map(file => ({ file, sha256: hash(join(sourceRoot, file)) }));
  const bootstrap = `import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import {spawnSync} from 'node:child_process';
    for (const row of JSON.parse(process.argv[1])) if (createHash('sha256').update(readFileSync('/app/'+row.file)).digest('hex')!==row.sha256) throw new Error('phase5_qualification_tooling_source_mismatch');
    const child=spawnSync(process.execPath,process.argv.slice(2),{stdio:'inherit',env:process.env}); process.exit(child.status??1);`;
  const expires = Date.now() + 600_000, results = [];
  const env = { ...cleanEnv(), DOCKER_CONTEXT: 'default', PHASE5_SYNTHETIC_ONLY: '1', PHASE5_DB_ALLOW_DDL: '1' };
  let serial = 0;
  function checked(command, args, capture = false) {
    const left = expires - Date.now(); insist(left > 0, 'qualification_batch_deadline');
    const stem = join(logs, String(++serial)), stdout = openSync(`${stem}.stdout`, 'wx', 0o600), stderr = openSync(`${stem}.stderr`, 'wx', 0o600);
    let result;
    try {
      result = spawnSync(command, args, { env, timeout: left, cwd: sourceRoot, stdio: ['ignore', stdout, stderr] });
    } finally { closeSync(stdout); closeSync(stderr); }
    insist(!result.error && result.status === 0, 'qualification_child_failed_private_evidence_retained');
    return capture ? readFileSync(`${stem}.stdout`, 'utf8') : undefined;
  }
  function docker(args, capture = false) { return checked('docker', ['--context', 'default', ...args], capture); }
  try {
    // Authoritative project check: reject app/unknown containers even if ownership was not recorded.
    const known = new Set(Object.values(state.ownership.containers).map(owner => owner.id));
    const ids = docker(['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${state.project}`], true).trim().split(/\s+/).filter(Boolean);
    insist(ids.every(id => known.has(id)), 'qualification_unknown_project_container');
    const tools = JSON.parse(docker(['image', 'inspect', state.images.tooling], true));
    insist(tools.length === 1 && typeof tools[0].Id === 'string', 'qualification_cached_tooling_image_required');
    for (const step of plan.steps) {
      const inspected = JSON.parse(docker(['inspect', state.ownership.containers[step.service].id], true));
      const row = assertOwnedContainer(state, inspected, step.service);
      insist(row.State?.Running === true, 'qualification_mysql_not_running');
      const inspectedFile = join(state.hostPaths.results, `phase7-${plan.stage}-${step.service}-${serial}-inspect.json`);
      exclusiveJson(inspectedFile, inspected);
      if (step.kind === 'backup') {
        const { kind: _kind, ...options } = step;
        checked(process.execPath, [join(sourceRoot, 'tests/enterprise-phase5/backup-restore.mjs'), ...argv({ state: input.state, ...options })]);
      } else {
        const childArgs = { state: '/fixture/state.json', inspect: `/results/${inspectedFile.slice(state.hostPaths.results.length + 1)}`,
          output: `/results/${step.output.slice(state.hostPaths.results.length + 1)}`, ...step.args,
          ...(step.entry === 'migration-chain.ts' ? { service: step.service } : {}) };
        // All final sources/tests come from the current source bundle, never legacy.
        // Only legacy builders and their own previously built dependencies use
        // the unchanged absolute legacy path; do not break absolute package links.
        docker(['run', '--pull', 'never', '--rm', '--name', `${state.project}-qual-${randomBytes(5).toString('hex')}`, '--network', 'host',
          '--label', `io.ghcp.phase5.run-id=${state.runId}`, '--label', 'io.ghcp.phase5.synthetic=true', '--label', `com.docker.compose.project=${state.project}`,
          '--mount', `type=bind,source=${state.hostPaths.fixture},target=/fixture`,
          '--mount', `type=bind,source=${state.hostPaths.results},target=/results`,
          '--mount', `type=bind,source=${state.hostPaths.backups},target=/backups,readonly`,
          '--mount', `type=bind,source=${input['legacy-source']},target=${input['legacy-source']},readonly`,
          '-e', 'PHASE5_SYNTHETIC_ONLY=1', '-e', 'PHASE5_DB_ALLOW_DDL=1', '-e', `PHASE5_LEGACY_SOURCE_ROOT=${input['legacy-source']}`,
          tools[0].Id, 'node', '--input-type=module', '-e', bootstrap, JSON.stringify(sourceFiles),
          '--import', 'tsx', `/app/tests/enterprise-phase5/${step.entry}`, ...argv(childArgs)]);
      }
      const receipt = step.kind === 'backup' && step.operation === 'dump' ? `${step.output}.json` : step.output;
      const evidence = JSON.parse(readFileSync(receipt, 'utf8'));
      insist(evidence.status === 'PASS' && evidence.runId === state.runId, 'qualification_step_not_pass');
      results.push({ kind: step.kind, stage: step.args?.stage ?? step.operation ?? plan.stage, output: receipt, sha256: hash(receipt), status: 'PASS' });
    }
    const result = { status: 'PASS', stage: plan.stage, syntheticOnly: true, runId: state.runId, source: state.source,
      toolingImageId: tools[0].Id, sourceFiles, results,
      runtimeStarted: false, externalProviderRequests: 0, resetOrMarkerRewrite: false,
      evidenceRetained: true, cleanup: plan.stage === 'names' ? 'Existing mysqlHarness acknowledged-empty object lifecycle only' : 'None' };
    exclusiveJson(plan.wrapperOutput, result); return result;
  } catch (error) {
    const result = { status: 'FAIL', stage: plan.stage, syntheticOnly: true, runId: state.runId, results,
      error: /^phase5_[a-z0-9_]+$/.test(error?.message) ? error.message : 'phase5_qualification_failed_details_suppressed',
      evidenceRetained: true, automaticCleanup: false, rawEvidenceExportAllowed: false };
    exclusiveJson(plan.wrapperOutput, result); throw new Error(result.error);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) migrationQualification().then(result => {
  console.log(JSON.stringify(result, null, 2));
}).catch(error => { console.error(/^phase5_[a-z0-9_]+$/.test(error?.message) ? error.message : 'phase5_qualification_failed_details_suppressed'); process.exitCode = 1; });
