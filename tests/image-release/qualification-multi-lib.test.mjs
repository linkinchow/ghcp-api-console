// node --test tests/image-release/qualification-multi-lib.test.mjs
// Static checks of the multi-enterprise qualification: no Docker, network or containers.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lib from './qualification-multi-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const SOURCE = JSON.parse(read('tests/image-release/qualification-compose.json'));
const migrationIds = (path) => [...read(path).matchAll(/'(enterprise-v1\/[a-z0-9-]+)'/g)].map((match) => match[1]);

test('migration ids mirror the service sources', () => {
  assert.deepEqual([...lib.PROXY_MIGRATION_IDS], migrationIds('src/proxy/src/db/enterpriseMigrationIds.ts'));
  assert.deepEqual([...lib.SSO_MIGRATION_IDS], migrationIds('src/sso/src/db/migrations.ts'));
  assert.deepEqual([...lib.LOGIN_MIGRATION_IDS], migrationIds('src/login/src/db/migrations.ts'));
  assert.equal(lib.expectedProxyMigrationIds('mysql').length, 8);
  assert.deepEqual(lib.expectedProxyMigrationIds('sqlite-direct'), lib.PROXY_MIGRATION_IDS.slice(0, 5));
  assert.throws(() => lib.expectedProxyMigrationIds('oracle'));
});

test('mid-migration crash state is 01-04 recorded and 05 missing', () => {
  const ids = lib.PROXY_MIGRATION_IDS;
  assert.equal(lib.isMidMigrationCrashState(ids.slice(0, 4)), true);
  assert.equal(lib.isMidMigrationCrashState(['x', ...ids.slice(0, 4)]), true);
  assert.equal(lib.isMidMigrationCrashState(ids.slice(0, 3)), false);
  assert.equal(lib.isMidMigrationCrashState(ids.slice(0, 5)), false);
  assert.deepEqual(lib.missingMigrationIds(ids.slice(1), ids), [ids[0]]);
});

test('tag patterns separate release lines', () => {
  assert.match('multi-bddc60b-amd64-r1', lib.MULTI_TAG);
  assert.match(lib.BASELINE_R4_TAG, lib.SINGLE_TAG);
  assert.doesNotMatch('single-slug-164cade-amd64-r4', lib.MULTI_TAG);
  assert.doesNotMatch('multi-bddc60b-amd64', lib.MULTI_TAG);
  assert.doesNotMatch('latest', lib.CANDIDATE_TAG);
});

test('legacy phase environment equals the r4 qualification environment exactly', () => {
  const { base, legacy, registry } = lib.buildMultiCompose(SOURCE);
  for (const service of lib.APPS) {
    assert.deepEqual(lib.mergedEnvironment([base, legacy], service), lib.sourceEnvironment(SOURCE, service), service);
  }
  assert.equal(base.services.proxy2.extends, undefined);
  assert.equal(base.services.proxy2.image, SOURCE.services.proxy.image);
  assert.deepEqual(base.services.proxy2.volumes, SOURCE.services.proxy2.volumes);
  assert.deepEqual(base.services.mock.networks.isolated.aliases, lib.gheHosts());
  assert.deepEqual(JSON.parse(base.services.mock.environment.MOCK_GHE_TENANTS), lib.mockTenants());
  assert.equal(registry.services.console, undefined);
});

test('registry phase environment clears every per-enterprise variable and adds the registry file', () => {
  const { base, registry } = lib.buildMultiCompose(SOURCE);
  for (const service of lib.REGISTRY_SERVICES) {
    const env = lib.mergedEnvironment([base, registry], service);
    assert.equal(env.ENTERPRISE_REGISTRY_FILE, lib.REGISTRY_FILE);
    const key = service === 'proxy2' ? 'proxy' : service;
    for (const name of lib.LEGACY_ENV_KEYS[key]) assert.equal(Object.hasOwn(env, name), false, `${service}.${name}`);
    const mount = '${RELEASE_QUALIFICATION_DIR:?run prepare}/registry:/registry:ro';
    assert.deepEqual(registry.services[service].volumes, [mount]);
  }
  // Secret references of `default` keep resolving from variables that stay set.
  const ssoEnv = lib.mergedEnvironment([base, registry], 'sso');
  const defaultSso = lib.buildRegistry().enterprises[0].sso;
  for (const ref of Object.values(defaultSso).filter((value) => value?.env)) assert.ok(ssoEnv[ref.env], ref.env);
});

test('the source must still carry every legacy variable', () => {
  const broken = structuredClone(SOURCE);
  delete broken.services.sso.environment.SP_ACS_URL;
  assert.throws(() => lib.buildMultiCompose(broken), /SP_ACS_URL/);
});

test('registry default restates the r4 identity and contoso follows the GHE.com rules', () => {
  const registry = lib.buildRegistry();
  const [defaults, contoso] = registry.enterprises;
  const proxy = SOURCE.services.proxy.environment;
  const sso = SOURCE.services.sso.environment;
  const login = SOURCE.services.login.environment;
  assert.equal(defaults.github.shortcode, proxy.ENTERPRISE_SHORTCODE);
  assert.equal(defaults.github.shortcode, sso.ENTERPRISE_SHORTCODE);
  assert.equal(defaults.github.slug, sso.ENTERPRISE_SLUG);
  assert.equal(defaults.github.copilotApiBaseUrl, proxy.COPILOT_API_BASE_URL);
  assert.equal(defaults.github.apiBaseUrl, sso.GITHUB_API_BASE_URL);
  assert.equal(defaults.github.oauthClientId, login.GITHUB_OAUTH_CLIENT_ID);
  assert.equal(defaults.pool.accountDomain, proxy.POOL_ACCOUNT_EMAIL_DOMAIN);
  assert.equal(defaults.pool.initialMaxAccounts, Number(proxy.POOL_MAX_ACCOUNTS));
  assert.equal(defaults.sso.scimBaseUrl, sso.SCIM_BASE_URL);
  assert.equal(defaults.sso.spEntityId, sso.SP_ENTITY_ID);
  assert.equal(defaults.sso.spAcsUrl, sso.SP_ACS_URL);
  assert.equal(defaults.sso.signingCert.file, `${sso.CERT_DIR}/idp-cert.pem`);
  assert.equal(defaults.login.ssoLoginUrl, login.SSO_URL);
  assert.equal(contoso.github.shortcode, '');
  for (const field of ['baseUrl', 'apiBaseUrl', 'copilotApiBaseUrl']) {
    assert.ok(new URL(contoso.github[field]).hostname.endsWith(lib.GHE_TENANT.host), field);
  }
  assert.ok(Object.values(contoso.sso).every((value) => typeof value !== 'object' || value.file?.startsWith('/')));
  assert.ok(registry.enterprises.reduce((sum, row) => sum + row.pool.initialMaxAccounts, 0) <= 10000);
  for (const path of Object.keys(lib.CONTOSO_SECRETS)) {
    assert.ok(JSON.stringify(contoso.sso).includes(`/registry/${path}`), path);
  }
  assert.ok(lib.CONTOSO_SECRETS['contoso/default-password'].length >= 16, 'pool password policy');
});

/** Validates the registry with the product's own loader when the shared package is built (dist is not tracked). */
const SHARED_DIST = join(ROOT, 'src/packages/shared/dist/index.js');
test('product registry loader accepts the step-4 registry without env conflicts or blockers',
  { skip: !existsSync(SHARED_DIST) && 'src/packages/shared/dist is not built' }, async () => {
    const shared = await import(pathToFileURL(SHARED_DIST).href);
    const { base, legacy, registry: overlay } = lib.buildMultiCompose(SOURCE);
    const text = JSON.stringify(lib.buildRegistry());
    const readFile = (path) => {
      assert.equal(path, lib.REGISTRY_FILE);
      return text;
    };
    const identity = (profile) => ({
      baseUrl: profile.github.baseUrl,
      slug: profile.github.slug ?? null,
      shortcode: profile.github.shortcode ?? null,
      accountDomain: profile.pool.accountDomain ?? null,
    });
    const loginSlugChange = {};
    for (const service of ['proxy', 'sso', 'login']) {
      const legacyEnv = lib.mergedEnvironment([base, legacy], service);
      const registryEnv = lib.mergedEnvironment([base, overlay], service);
      const before = shared.loadRegistry({ service, env: legacyEnv });
      const after = shared.loadRegistry({ service, env: registryEnv, readFile });
      assert.deepEqual(after.enterprises.map((row) => row.id), ['default', lib.GHE_TENANT.enterpriseId]);
      for (const profile of after.enterprises) assert.deepEqual(profile.blockers, [], `${service}.${profile.id}`);
      const [oldDefault] = before.enterprises;
      const [newDefault] = after.enterprises;
      if (service === 'proxy') {
        assert.equal(shared.profileFingerprint(newDefault), shared.profileFingerprint(oldDefault), 'proxy identity');
      }
      if (service === 'sso') {
        assert.deepEqual(
          { ...identity(newDefault), accountDomain: null },
          { ...identity(oldDefault), accountDomain: null },
          'sso identity',
        );
      }
      if (service === 'login') {
        assert.equal(newDefault.github.baseUrl, oldDefault.github.baseUrl);
        loginSlugChange.before = oldDefault.github.slug ?? null;
        loginSlugChange.after = newDefault.github.slug ?? null;
      }
      // With the legacy variables still set, equal values merge silently; a differing one is a startup error.
      // CERT_DIR resolves with the host's path rules, so it only compares equal on POSIX hosts (as in containers).
      const { CERT_DIR: _certDir, ...portable } = legacyEnv;
      const both = { ...(process.platform === 'win32' ? portable : legacyEnv), ...registryEnv };
      shared.loadRegistry({ service, env: both, readFile });
      const key = service === 'login' ? 'SSO_URL' : 'ENTERPRISE_SHORTCODE';
      const value = service === 'login' ? 'http://sso:7001/other-login' : 'other';
      assert.throws(() => shared.loadRegistry({ service, env: { ...registryEnv, [key]: value }, readFile }),
        (error) => error.code === 'enterprise_env_conflict');
    }
    // Finding (documented in the README): r4 Login has no ENTERPRISE_SLUG, so moving `default` into a shared registry
    // with `github.slug` changes Login's default fingerprint. Login accepts that only while it has no tasks.
    assert.deepEqual(loginSlugChange, { before: null, after: 'local-test' });
  });

test('SQLite compose mirrors tests/image-release/compose.yaml service environments', () => {
  const yaml = read('tests/image-release/compose.yaml');
  const compose = lib.buildSqliteCompose();
  const blocks = yaml.split(/\n {2}(?=[a-z]+:\n)/);
  for (const service of lib.SQLITE_APPS) {
    const block = blocks.find((text) => text.startsWith(`${service}:`));
    const env = Object.fromEntries([...block.matchAll(/^ {6}([A-Z_]+): "?([^"\n]*)"?$/gm)].map((m) => [m[1], m[2]]));
    assert.deepEqual(compose.services[service].environment, env, service);
    assert.deepEqual(compose.services[service].networks, ['isolated']);
    assert.equal(compose.services[service].ports, undefined);
  }
  assert.equal(compose.networks.isolated.internal, true);
});

function renderedConfig(overrides = {}) {
  const project = 'ghcp-release-qualification-test';
  const app = { image: 'x', networks: { isolated: null } };
  return {
    name: project,
    services: {
      mock: { image: 'node' }, proxy: { ...app }, console: { ...app }, sso: { ...app }, login: { ...app },
      ...overrides.services,
    },
    networks: { isolated: { internal: true } },
    volumes: { 'proxy-data': { name: `${project}_proxy-data` }, ...overrides.volumes },
  };
}

test('compose isolation rules', () => {
  const rules = { project: 'ghcp-release-qualification-test', services: lib.SQLITE_ALL, apps: lib.SQLITE_APPS };
  assert.deepEqual(lib.composeViolations(renderedConfig(), rules), []);
  const published = renderedConfig({ services: { proxy: { image: 'x', networks: { isolated: null }, ports: [{}] } } });
  assert.ok(lib.composeViolations(published, rules).includes('app_network_escape_proxy'));
  const command = renderedConfig({ services: { sso: { image: 'x', networks: { isolated: null }, command: ['sh'] } } });
  assert.ok(lib.composeViolations(command, rules).includes('shipped_cmd_overridden_sso'));
  const foreign = renderedConfig({ volumes: { other: { name: 'someone_else', external: true } } });
  assert.ok(lib.composeViolations(foreign, rules).includes('foreign_volume'));
  const extra = renderedConfig({ services: { shell: { image: 'x' } } });
  assert.ok(lib.composeViolations(extra, rules).includes('unexpected_compose_services'));
  const bridge = renderedConfig({ services: { bridge: { ports: [{ host_ip: '0.0.0.0' }] } } });
  const bridgeRules = { ...rules, services: [...lib.SQLITE_ALL, 'bridge'], bridgePorts: 1 };
  assert.ok(lib.composeViolations(bridge, bridgeRules).includes('bridge_not_loopback_only'));
});

test('session cookie signature matches keygrip (the format of cookie-session and the SSO)', () => {
  const Keygrip = createRequire(join(ROOT, 'package.json'))('keygrip');
  const secret = 'mysql-fixture-session-only';
  const value = Buffer.from(JSON.stringify({ e: 'default' })).toString('base64');
  assert.equal(lib.signCookie('sso_session', value, secret), new Keygrip([secret]).sign(`sso_session=${value}`));
  const forged = lib.forgeSessionCookie('sso_session_contoso-eu', { e: 'default', user: { ssoUser: 'a' } }, 's');
  const cookies = Object.fromEntries(forged.split('; ').map((pair) => [pair.slice(0, pair.indexOf('=')),
    pair.slice(pair.indexOf('=') + 1)]));
  assert.deepEqual(lib.decodeSessionCookie(cookies['sso_session_contoso-eu']),
    { e: 'default', user: { ssoUser: 'a' } });
  assert.equal(cookies['sso_session_contoso-eu.sig'], lib.signCookie('sso_session_contoso-eu',
    cookies['sso_session_contoso-eu'], 's'));
});

test('cookie helpers', () => {
  const cookies = lib.parseSetCookies(['sso_session=abc=; Path=/; HttpOnly', 'sso_session.sig=sig; Path=/']);
  assert.deepEqual(cookies, { sso_session: 'abc=', 'sso_session.sig': 'sig' });
  assert.equal(lib.cookieHeader(cookies, 'sso_session'), 'sso_session=abc=; sso_session.sig=sig');
  assert.equal(lib.cookieHeader(cookies, 'missing'), '');
  assert.equal(lib.renameCookie(cookies, 'sso_session', 'sso_session_x'), 'sso_session_x=abc=; sso_session_x.sig=sig');
  assert.equal(lib.decodeSessionCookie('%%%'), undefined);
});

test('SAML outcome classification and metadata identity', () => {
  const page = { status: 200, text: '<input name="SAMLResponse" value="x">' };
  assert.equal(lib.samlOutcome(page, '/login'), 'saml_response');
  assert.equal(lib.samlOutcome({ status: 302, headers: { location: '/enterprises/a/login' } }, '/enterprises/a/login'),
    'login_redirect');
  assert.equal(lib.samlOutcome({ status: 302, headers: { location: '/login' } }, '/enterprises/a/login'), 'other');
  assert.equal(lib.samlOutcome({ status: 200, text: '<h1>SSO Login</h1>' }, '/login'), 'other');
  const xml = '<md:EntityDescriptor entityID="http://sso:7001/metadata">'
    + '<ds:X509Certificate>AB\nCD</ds:X509Certificate>';
  assert.deepEqual(lib.metadataIdentity(xml),
    { entityId: 'http://sso:7001/metadata', certificateSha256: lib.sha('ABCD') });
  assert.deepEqual(lib.metadataIdentity(''), { entityId: null, certificateSha256: null });
});

test('table diff: preservation, expected drops and exact rollback comparison', () => {
  const before = {
    sso_users: { columns: ['sso_user', 'email'], rows: [{ sso_user: 'a', email: 'x' }] },
    sso_runtime_settings: { columns: ['id', 'max_sso_users'], rows: [{ id: '1', max_sso_users: '9' }] },
    schema_migrations: { columns: ['id'], rows: [{ id: 'm1' }] },
  };
  const upgraded = {
    sso_users: {
      columns: ['enterprise_id', 'sso_user', 'email'],
      rows: [{ enterprise_id: 'd', sso_user: 'a', email: 'x' }],
    },
    sso_runtime_settings: {
      columns: ['enterprise_id', 'max_sso_users'],
      rows: [{ enterprise_id: 'd', max_sso_users: '9' }],
    },
    schema_migrations: { columns: ['id'], rows: [{ id: 'm1' }, { id: 'm2' }] },
    sso_enterprises: { columns: ['id'], rows: [{ id: 'd' }] },
  };
  assert.deepEqual(lib.tableDiff(before, upgraded), []);
  const changed = structuredClone(upgraded);
  changed.sso_users.rows[0].email = 'y';
  assert.deepEqual(lib.tableDiff(before, changed), ['rows_changed_sso_users']);
  const dropped = structuredClone(upgraded);
  dropped.sso_users.columns = ['enterprise_id', 'sso_user'];
  assert.ok(lib.tableDiff(before, dropped).includes('column_removed_sso_users'));
  assert.deepEqual(lib.tableDiff(before, structuredClone(before), { exact: true }), []);
  const exact = lib.tableDiff(before, upgraded, { exact: true });
  for (const problem of ['table_added_sso_enterprises', 'column_removed_sso_runtime_settings',
    'rows_changed_schema_migrations', 'columns_changed_sso_users']) {
    assert.ok(exact.includes(problem), problem);
  }
});

test('snapshot comparison fields', () => {
  const before = { settingsHash: 'a', credentialsHash: 'b', membersHash: 'c', leasesHash: 'd', statsHash: 'e',
    schemaHash: 'f', migrationsHash: 'g' };
  assert.deepEqual(lib.snapshotDifferences(before, { ...before, schemaHash: 'z' }, lib.UPGRADE_STABLE_HASHES), []);
  assert.deepEqual(lib.snapshotDifferences(before, { ...before, schemaHash: 'z' }, lib.ROLLBACK_STABLE_HASHES),
    ['schemaHash']);
});

test('SQL helpers', () => {
  const sql = lib.statsInflationSql(['id', 'identity', 'requested_at'], 3);
  assert.equal(sql.length, 3);
  assert.equal(sql[2], "INSERT INTO proxy_request_stats (id, identity, requested_at) SELECT CONCAT('q7-02-',"
    + " SHA2(id, 224)), CONCAT(identity, '.q02'), requested_at FROM proxy_request_stats;");
  assert.throws(() => lib.statsInflationSql(['id', 'requested_at'], 1), /identity/);
  assert.ok('q7-02-'.length + 56 <= 64, 'derived id fits VARCHAR(64)');
  assert.throws(() => lib.statsInflationSql(['id', 'x; DROP'], 1));
  assert.throws(() => lib.statsInflationSql(['id'], 40));
  assert.equal(lib.restorePreamble('ghcp_pool_mysql_test').split('\n')[0],
    'DROP DATABASE IF EXISTS `ghcp_pool_mysql_test`;');
  assert.throws(() => lib.restorePreamble('x`; DROP'));
  assert.ok(lib.MYSQLDUMP_ARGS.includes('--single-transaction'));
});

test('probe payload round trip and JSON line extraction', () => {
  const requests = [{ target: 'sso', path: '/healthz', headers: { cookie: 'a="b"; c' } }];
  assert.deepEqual(lib.decodeProbe(lib.encodeProbe(requests)), requests);
  assert.match(lib.encodeProbe(requests), /^[A-Za-z0-9_-]+$/);
  assert.throws(() => lib.decodeProbe(lib.encodeProbe([])));
  assert.deepEqual(lib.lastJsonLine('noise\n{"a":1}\n{"b":2}\nmore', (value) => value.a), { a: 1 });
  assert.equal(lib.lastJsonLine('none'), undefined);
});

test('plan coverage reports missing and unplanned assertions', () => {
  const plan = lib.qualificationPlan('multi-upgrade-sqlite');
  const complete = plan.map((step) => ({
    id: step.id,
    assertions: step.assertions.map((name) => ({ name, pass: true })),
  }));
  assert.deepEqual(lib.planCoverage(plan, complete), { missing: [], unplanned: [], complete: true });
  const partial = structuredClone(complete);
  partial[1].assertions[0].pass = false;
  partial[1].assertions.push({ name: 'surprise', pass: true });
  const coverage = lib.planCoverage(plan, partial);
  assert.deepEqual(coverage.missing, [`${plan[1].id}:${plan[1].assertions[0]}`]);
  assert.deepEqual(coverage.unplanned, [`${plan[1].id}:surprise`]);
  assert.equal(coverage.complete, false);
  assert.throws(() => lib.qualificationPlan('single'));
});

test('every planned assertion is checked by the runner (no typos between plan and code)', () => {
  const runner = read('tests/image-release/qualification-multi-run.mjs');
  for (const mode of lib.MULTI_MODES) {
    const plan = lib.qualificationPlan(mode);
    assert.equal(new Set(plan.map((step) => step.id)).size, plan.length);
    for (const step of plan) {
      assert.match(runner, new RegExp(`runStep\\('${step.id}'`), step.id);
      for (const name of step.assertions) assert.ok(runner.includes(`'${name}'`), `${step.id}:${name}`);
    }
  }
  // The label is the last top-level string argument before an optional evidence object.
  const checked = checkCalls(runner).map((args) => /,\s*'([a-z0-9_]+)'\s*(?:,[\s\S]*)?$/.exec(args)?.[1]);
  assert.ok(checked.length > 60 && checked.every(Boolean), 'every check label is a literal');
  const planned = lib.MULTI_MODES.flatMap((mode) => lib.qualificationPlan(mode).flatMap((step) => step.assertions));
  for (const name of checked) assert.ok(planned.includes(name), `unplanned check ${name}`);
});

/** Top-level argument text of every `check(...)` call, keeping only top-level commas (nested calls removed). */
function checkCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/(?<![\w.])check\(/g)) {
    if (source.slice(match.index - 9, match.index) === 'function ') continue;
    let depth = 1;
    let quote;
    let top = '';
    for (let index = match.index + match[0].length; index < source.length && depth > 0; index++) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index++;
        else if (char === quote) quote = undefined;
        if (depth === 1) top += char;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      if ('([{'.includes(char)) depth++;
      if (')]}'.includes(char)) depth--;
      if (depth === 1 || (depth === 2 && '([{'.includes(char))) top += depth === 1 ? char : '';
    }
    calls.push(top);
  }
  return calls;
}

test('run budget bounds', () => {
  assert.deepEqual(lib.runBudget('multi-upgrade'), { activeMs: 3000000, finalMs: 3300000 });
  assert.equal(lib.runBudget('multi-upgrade-sqlite', '15').activeMs, 900000);
  assert.throws(() => lib.runBudget('multi-upgrade', '5'));
  assert.throws(() => lib.runBudget('multi-upgrade', 'abc'));
});
