// Pure helpers of the multi-enterprise in-place upgrade qualification (docs/multi-enterprise-design.md §9.4, §9.5).
// No Docker, network, process or file-system access: everything here is covered by `node --test`.
import { createHash, createHmac } from 'node:crypto';

export const MULTI_MODES = Object.freeze(['multi-upgrade', 'multi-upgrade-sqlite', 'multi-fresh', 'multi-fresh-dba',
  'multi-fresh-sqlite']);
/** Fresh single-enterprise deployments (empty databases, no registry): `default` is synthesized from env. */
export const FRESH_MODES = Object.freeze(['multi-fresh', 'multi-fresh-dba', 'multi-fresh-sqlite']);
/** Modes running SQLite direct mode instead of the MySQL + two-replica environment. */
export const SQLITE_MODES = Object.freeze(['multi-upgrade-sqlite', 'multi-fresh-sqlite']);
export const isFreshMode = (mode) => FRESH_MODES.includes(mode);
export const isSqliteMode = (mode) => SQLITE_MODES.includes(mode);
/** Single-slug r4, the baseline every multi candidate must upgrade from in place (design §11). */
export const BASELINE_R4_TAG = 'single-slug-164cade-amd64-r4';
export const RELEASE_PREFIX = 'ghcp-release';
export const SINGLE_TAG = /^single-slug-[a-f0-9]{7}-amd64-r\d+$/;
export const MULTI_TAG = /^multi-[a-f0-9]{7}-amd64-r\d+$/;
/** Local candidates of either release line; Docker Hub tags are never used here. */
export const CANDIDATE_TAG = /^(?:single-slug|multi)-[a-f0-9]{7}-amd64-r\d+$/;
export const NODE_IMAGE = 'node:22-bookworm-slim'
  + '@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562';
export const PROJECT_PATTERN = /^ghcp-release-qualification-[a-z0-9-]+$/;
export const SUBNET_PATTERN = /^10\.(?:\d{1,3})\.(?:\d{1,3})\.0\/24$/;

/** The GHE.com mock enterprise of design §9.5; its host names are internal network aliases of the mock. */
export const GHE_TENANT = Object.freeze({
  enterpriseId: 'contoso-eu',
  host: 'contoso.ghe.com',
  slug: 'contoso',
  port: 8002,
  initialMaxAccounts: 2,
  accountDomain: 'pool.contoso.example.eu',
  emailDomain: 'contoso.example.eu',
});

export function gheHosts(host = GHE_TENANT.host) {
  return [host, `api.${host}`, `copilot-api.${host}`];
}

/** Mirrors src/proxy/src/db/enterpriseMigrationIds.ts (the unit test guards drift). */
export const PROXY_MIGRATION_IDS = Object.freeze([
  'enterprise-v1/01-create-proxy-enterprises',
  'enterprise-v1/02-seed-default',
  'enterprise-v1/03-accounts-enterprise',
  'enterprise-v1/04-accounts-guards',
  'enterprise-v1/05-initializations-and-stats',
  'enterprise-v1/06-pool-accounts',
  'enterprise-v1/07-pool-events',
  'enterprise-v1/08-pool-config-fingerprint',
]);
/** Mirrors src/sso/src/db/migrations.ts. */
export const SSO_MIGRATION_IDS = Object.freeze([
  'enterprise-v1/01-create-sso-enterprises',
  'enterprise-v1/02-users-enterprise',
  'enterprise-v1/03-runtime-settings-enterprise',
  'enterprise-v1/04-budget-cache-enterprise',
  'enterprise-v1/05-emu-import-plans-enterprise',
]);
/** Mirrors src/login/src/db/migrations.ts. */
export const LOGIN_MIGRATION_IDS = Object.freeze([
  'enterprise-v1/01-create-login-enterprises',
  'enterprise-v1/02-tasks-enterprise',
  'enterprise-v1/03-tasks-enterprise-guards',
]);

/**
 * Proxy migration ids a backend records: MySQL pool mode records all eight; SQLite direct mode has no pool tables
 * (06/07 run only when UserPoolStore exists) and 08 is MySQL only.
 */
export function expectedProxyMigrationIds(backend) {
  if (backend === 'mysql') return [...PROXY_MIGRATION_IDS];
  if (backend === 'sqlite-direct') return PROXY_MIGRATION_IDS.slice(0, 5);
  if (backend === 'sqlite-pool') return PROXY_MIGRATION_IDS.slice(0, 7);
  throw new Error(`unknown backend ${backend}`);
}

/** Single-enterprise Proxy MySQL migration ids (r4 schema and pool); src/proxy/src/db/mysqlMigrations.ts and
 * src/proxy/src/userPool/mysqlMigrations.ts (the unit test guards drift). */
export const PROXY_MYSQL_BASE_MIGRATION_IDS = Object.freeze([
  '2026-08-27-proxy-mysql-initial',
  '2026-08-27-proxy-token-binary-collation',
  '2026-09-12-user-pool-mysql-v1',
]);

/** Every id a fresh caller-lease MySQL database records once Proxy has started (either migration path). */
export function expectedFreshMysqlMigrationIds() {
  return [...PROXY_MYSQL_BASE_MIGRATION_IDS, ...PROXY_MIGRATION_IDS].sort();
}

/** Every expected id present; returns the missing ones (empty when complete). */
export function missingMigrationIds(recorded, expected) {
  const set = new Set(recorded);
  return expected.filter((id) => !set.has(id));
}

/** The step-7 crash point: 01–04 recorded, 05 (the stats table) not yet. */
export function isMidMigrationCrashState(recorded) {
  const set = new Set(recorded);
  return PROXY_MIGRATION_IDS.slice(0, 4).every((id) => set.has(id)) && !set.has(PROXY_MIGRATION_IDS[4]);
}

/**
 * Per-enterprise environment variables of the r4 qualification Compose file (§3.5 mapping). In the registry phase
 * they move into the registry's `default` entry and are removed from the services, as the env-conflict rule requires.
 * Secret variables (SESSION_SECRET, SCIM_TOKEN, ...) stay: the `default` entry references them with `{ "env": ... }`.
 */
export const LEGACY_ENV_KEYS = Object.freeze({
  proxy: Object.freeze([
    'COPILOT_API_BASE_URL',
    'ENTERPRISE_SHORTCODE',
    'POOL_ACCOUNT_EMAIL_DOMAIN',
    'POOL_MAX_ACCOUNTS',
  ]),
  sso: Object.freeze([
    'ENTERPRISE_SLUG',
    'ENTERPRISE_SHORTCODE',
    'GITHUB_API_BASE_URL',
    'SCIM_BASE_URL',
    'SP_ENTITY_ID',
    'SP_ACS_URL',
    'CERT_DIR',
  ]),
  login: Object.freeze(['SSO_URL', 'GITHUB_OAUTH_CLIENT_ID']),
});
export const REGISTRY_SERVICES = Object.freeze(['proxy', 'proxy2', 'sso', 'login']);
export const REGISTRY_FILE = '/registry/registry.json';
export const APPS = Object.freeze(['proxy', 'proxy2', 'console', 'sso', 'login']);
export const MYSQL_ALL = Object.freeze(['mysql', 'mock', ...APPS, 'bridge']);
export const SQLITE_APPS = Object.freeze(['proxy', 'console', 'sso', 'login']);
export const SQLITE_ALL = Object.freeze(['mock', ...SQLITE_APPS]);

const legacyKeysOf = (service) => LEGACY_ENV_KEYS[service === 'proxy2' ? 'proxy' : service] ?? [];

/** Synthetic secrets of the GHE.com mock enterprise; written as files under the run's registry directory. */
export const CONTOSO_SECRETS = Object.freeze({
  'contoso/session-secret': 'contoso-fixture-session-only',
  'contoso/scim-token': 'contoso-fixture-scim-only',
  'contoso/seat-pat': 'contoso-fixture-seat-only',
  'contoso/default-password': 'contoso-fixture-sso-default-only',
});

/** Mock tenant configuration passed to mock-services.mjs as MOCK_GHE_TENANTS (JSON). */
export function mockTenants() {
  return [{
    host: GHE_TENANT.host,
    slug: GHE_TENANT.slug,
    enterpriseId: GHE_TENANT.enterpriseId,
    port: GHE_TENANT.port,
    scimToken: CONTOSO_SECRETS['contoso/scim-token'],
    seatPat: CONTOSO_SECRETS['contoso/seat-pat'],
    ssoPassword: CONTOSO_SECRETS['contoso/default-password'],
    idpSsoUrl: `http://sso:7001/enterprises/${GHE_TENANT.enterpriseId}/sso`,
  }];
}

/**
 * The step-4 registry (design §3.2 shape). `default` restates every identity field of the r4 environment so its
 * fingerprints stay unchanged; `github.apiBaseUrl` additionally points Proxy's subject check (`/user`) at the mock.
 */
export function buildRegistry() {
  const origin = (host) => `http://${host}:${GHE_TENANT.port}`;
  const [web, api, copilot] = gheHosts();
  return {
    version: 1,
    enterprises: [
      {
        id: 'default',
        displayName: 'Default (github.com mock)',
        github: {
          baseUrl: 'https://github.com',
          apiBaseUrl: 'http://mock:8002',
          copilotApiBaseUrl: 'http://mock:8002',
          slug: 'local-test',
          shortcode: 'test',
          oauthClientId: 'mysql-fixture-unused',
        },
        sso: {
          spEntityId: 'http://mock:8002/saml',
          spAcsUrl: 'http://mock:8002/saml/acs',
          scimBaseUrl: 'http://mock:8002/scim/v2/enterprises/local-test',
          signingCert: { file: '/certs/idp-cert.pem' },
          signingKey: { file: '/certs/idp-key.pem' },
          sessionSecret: { env: 'SESSION_SECRET' },
          scimToken: { env: 'SCIM_TOKEN' },
          seatPat: { env: 'GITHUB_COPILOT_SEAT_PAT' },
          defaultUserPassword: { env: 'SSO_DEFAULT_USER_PASSWORD' },
        },
        login: { ssoLoginUrl: 'http://sso:7001/login' },
        pool: { accountDomain: 'pool.mysql.example.test', initialMaxAccounts: 2000 },
      },
      {
        id: GHE_TENANT.enterpriseId,
        displayName: 'Contoso EU (GHE.com mock)',
        github: {
          baseUrl: origin(web),
          apiBaseUrl: origin(api),
          copilotApiBaseUrl: origin(copilot),
          slug: GHE_TENANT.slug,
          shortcode: '',
        },
        sso: {
          scimBaseUrl: `${origin(api)}/scim/v2/enterprises/${GHE_TENANT.slug}`,
          emailDomain: GHE_TENANT.emailDomain,
          userPrefix: 'ghcp',
          signingCert: { file: '/certs/idp-cert.pem' },
          signingKey: { file: '/certs/idp-key.pem' },
          sessionSecret: { file: '/registry/contoso/session-secret' },
          scimToken: { file: '/registry/contoso/scim-token' },
          seatPat: { file: '/registry/contoso/seat-pat' },
          defaultUserPassword: { file: '/registry/contoso/default-password' },
        },
        login: { ssoLoginUrl: `http://sso:7001/enterprises/${GHE_TENANT.enterpriseId}/login` },
        pool: { accountDomain: GHE_TENANT.accountDomain, initialMaxAccounts: GHE_TENANT.initialMaxAccounts },
      },
    ],
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(object, key))
  .map((key) => [key, object[key]]));

/**
 * Derives the three Compose files of the MySQL multi-upgrade run from the checked-in r4 qualification Compose file:
 * - `base`: r4 services minus the per-enterprise variables; mock gains the GHE.com aliases and tenants.
 * - `legacy`: overlay restoring exactly the r4 per-enterprise variables (steps 1–3, 5, 7: "env unchanged").
 * - `registry`: overlay adding ENTERPRISE_REGISTRY_FILE and the read-only /registry mount (step 4).
 * `proxy2` is flattened (no `extends`) so overlays apply to it explicitly.
 */
export function buildMultiCompose(source) {
  const base = clone(source);
  const proxy = base.services.proxy;
  const { extends: _extends, ...proxy2Own } = base.services.proxy2;
  base.services.proxy2 = { ...clone(proxy), ...proxy2Own };
  const legacy = { services: {} };
  for (const service of ['proxy', 'proxy2', 'sso', 'login']) {
    const environment = base.services[service].environment;
    const keys = legacyKeysOf(service);
    const missing = keys.filter((key) => !Object.hasOwn(environment, key));
    if (missing.length) throw new Error(`legacy variables missing from ${service}: ${missing.join(',')}`);
    legacy.services[service] = { environment: pick(environment, keys) };
    for (const key of keys) delete environment[key];
  }
  const mock = base.services.mock;
  mock.environment = {
    ...mock.environment,
    MOCK_GHE_TENANTS: JSON.stringify(mockTenants()),
    MOCK_LOGIN_READINESS_URL: 'http://login:7003',
  };
  mock.networks = { isolated: { aliases: gheHosts() } };
  const registry = { services: {} };
  for (const service of REGISTRY_SERVICES) {
    registry.services[service] = {
      environment: { ENTERPRISE_REGISTRY_FILE: REGISTRY_FILE },
      volumes: ['${RELEASE_QUALIFICATION_DIR:?run prepare}/registry:/registry:ro'],
    };
  }
  return { base, legacy, registry };
}

/** Environment a service sees for a phase: base plus overlays, later files winning (Compose map merge). */
export function mergedEnvironment(files, service) {
  return Object.assign({}, ...files.map((file) => file.services?.[service]?.environment ?? {}));
}

/** Variables of the r4 qualification Compose service, with proxy2 inheriting proxy (as `extends` does). */
export function sourceEnvironment(source, service) {
  const own = source.services[service];
  const inherited = own.extends ? source.services[own.extends.service].environment : {};
  return { ...inherited, ...(own.environment ?? {}) };
}

/**
 * Proxy variables a fresh multi deployment adds to the r4 qualification environment: the multi Proxy checks every
 * Login callback token with GitHub `GET /user` on `default`'s REST API (design §5.7), which defaults to
 * https://api.github.com and is unreachable from the internal network; the mock answers `/user` instead.
 */
export const FRESH_PROXY_ENV = Object.freeze({ GITHUB_API_BASE_URL: 'http://mock:8002' });

/**
 * Compose file of a fresh single-enterprise MySQL deployment (`multi-fresh`, `multi-fresh-dba`): the r4 qualification
 * services and environment (so `default` is synthesized from the same per-enterprise variables) plus
 * FRESH_PROXY_ENV, no registry, `proxy2` flattened. Mock forwards Login readiness to the real Login. With
 * `autoMigrate: false` both replicas get MYSQL_AUTO_MIGRATE=false (DBA path); otherwise the variable stays unset
 * (the default, `true`).
 */
export function buildFreshCompose(source, { autoMigrate = true } = {}) {
  const compose = clone(source);
  const { extends: _extends, ...proxy2Own } = compose.services.proxy2;
  compose.services.proxy2 = { ...clone(compose.services.proxy), ...proxy2Own };
  compose.services.mock.environment = { ...compose.services.mock.environment,
    MOCK_LOGIN_READINESS_URL: 'http://login:7003' };
  for (const service of ['proxy', 'proxy2']) {
    const environment = compose.services[service].environment;
    for (const key of ['MYSQL_AUTO_MIGRATE', ...Object.keys(FRESH_PROXY_ENV)]) {
      if (Object.hasOwn(environment, key)) throw new Error(`source sets ${key}`);
    }
    Object.assign(environment, FRESH_PROXY_ENV);
    if (!autoMigrate) environment.MYSQL_AUTO_MIGRATE = 'false';
  }
  return compose;
}

/** Services of a rendered Compose config that would load an enterprise registry (must be none when fresh). */
export function registryReferences(config) {
  return Object.entries(config.services ?? {}).filter(([, item]) => {
    const environment = item.environment ?? {};
    return Object.hasOwn(environment, 'ENTERPRISE_REGISTRY_FILE')
      || (item.volumes ?? []).some((volume) => volume.target === '/registry');
  }).map(([service]) => service);
}

/** Database name the generated scripts/proxy-mysql-initial.sql creates and uses. */
export const INITIAL_SQL_DATABASE = 'ghcp_proxy';

/**
 * The generated initial SQL retargeted to `database`, as a DBA running it for a differently named database would.
 * Only the `CREATE DATABASE` and `USE` statements change; both must be present exactly once.
 */
export function initialSqlForDatabase(script, database) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('invalid database name');
  const create = `CREATE DATABASE IF NOT EXISTS ${INITIAL_SQL_DATABASE}\n`;
  const use = `USE ${INITIAL_SQL_DATABASE};\n`;
  const text = String(script).replace(/\r+\n/g, '\n');
  for (const marker of [create, use]) {
    if (text.split(marker).length !== 2) throw new Error('initial SQL database markers changed');
  }
  const retargeted = text.replace(create, `CREATE DATABASE IF NOT EXISTS ${database}\n`).replace(use, `USE ${database};\n`);
  if (new RegExp(`\\b${INITIAL_SQL_DATABASE}\\b`).test(retargeted)) throw new Error('initial SQL names the database');
  return retargeted;
}

/** `schema_migrations` ids the initial SQL records itself (Proxy adds the rest with runtime privileges). */
export function initialSqlMigrationIds(script) {
  return [...String(script).matchAll(/INSERT IGNORE INTO schema_migrations \(id, applied_at\) VALUES \('([^']+)'/g)]
    .map((match) => match[1]).sort();
}

/**
 * Least-privilege runtime grants of scripts/proxy-mysql-initial.sql's header: DML on the database plus TRIGGER on
 * proxy_accounts (caller-lease mode reads the credential fence trigger's metadata). Replaces the image entrypoint's
 * `GRANT ALL` for MYSQL_USER (granted on the underscore-escaped database name, so it is revoked in the global form).
 */
export function dbaRuntimeGrantsSql(database, user) {
  if (!/^[a-z0-9_]+$/.test(database) || !/^[a-z0-9_]+$/.test(user)) throw new Error('invalid grant target');
  return [
    `REVOKE ALL PRIVILEGES, GRANT OPTION FROM '${user}'@'%';`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${user}'@'%';`,
    `GRANT TRIGGER ON \`${database}\`.\`proxy_accounts\` TO '${user}'@'%';`,
  ].join('\n');
}

const DDL_PRIVILEGES = ['ALL PRIVILEGES', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES', 'CREATE VIEW',
  'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT', 'LOCK TABLES', 'CREATE TEMPORARY TABLES'];

/** Schema-changing privileges named in `SHOW GRANTS` lines (empty when the account can only read and write rows). */
export function ddlPrivileges(grantLines) {
  const found = new Set();
  for (const line of grantLines) {
    const match = /^GRANT (.+?) ON /.exec(String(line).trim());
    if (!match) continue;
    for (const privilege of match[1].split(',').map((value) => value.trim().toUpperCase())) {
      if (DDL_PRIVILEGES.includes(privilege)) found.add(privilege);
    }
  }
  return [...found].sort();
}

/**
 * The SQLite direct-mode Compose of step 6, mirroring tests/image-release/compose.yaml's service environment one to
 * one, with run-owned images, a fresh internal subnet and the probe/snapshot fixtures mounted read-only.
 */
export function buildSqliteCompose() {
  const image = (component) => `\${RELEASE_QUALIFICATION_PREFIX:-ghcp-release}-${component}:`
    + '${RELEASE_QUALIFICATION_TAG:?run prepare}';
  const fixtures = '${RELEASE_QUALIFICATION_DIR:?run prepare}/fixtures';
  const health = (port) => ({
    test: ['CMD', 'node', '-e',
      `fetch('http://127.0.0.1:${port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
    interval: '2s',
    timeout: '3s',
    retries: 60,
  });
  const app = (component, port, environment, volumes) => ({
    image: image(component),
    environment,
    volumes: [...volumes, `${fixtures}:/qualification:ro`],
    networks: ['isolated'],
    depends_on: { mock: { condition: 'service_healthy' } },
    healthcheck: health(port),
  });
  return {
    name: 'ghcp-release-qualification-sqlite',
    services: {
      mock: {
        image: NODE_IMAGE,
        init: true,
        command: ['node', '/fixtures/mock.mjs'],
        volumes: [`${fixtures}:/fixtures:ro`],
        networks: ['isolated'],
        healthcheck: health(8002),
      },
      proxy: app('proxy', 3000, {
        PORT: '3000',
        STORAGE_DRIVER: 'sqlite',
        DB_PATH: '/data/proxy.sqlite',
        ACCOUNT_ROUTING_MODE: 'direct',
        API_KEY: 'release-fixture-api',
        INTERNAL_API_TOKEN: 'release-fixture-internal',
        COPILOT_API_BASE_URL: 'http://mock:8002',
        SSO_BASE_URL: 'http://sso:7001',
        LOGIN_BASE_URL: 'http://login:7003',
        PROXY_ERROR_DIAGNOSTICS_ENABLED: 'false',
        PROXY_ERROR_DIAGNOSTICS_REDACT: 'true',
      }, ['proxy-data:/data']),
      sso: app('sso', 7001, {
        PORT: '7001',
        DB_PATH: '/data/sso.sqlite',
        CERT_DIR: '/certs',
        INTERNAL_API_TOKEN: 'release-fixture-internal',
        SESSION_SECRET: 'release-fixture-session-long-only',
        BASE_URL: 'http://sso:7001',
        PROXY_BASE_URL: 'http://proxy:3000',
        MOCK_GITHUB_BASE_URL: 'http://mock:8002',
        GITHUB_API_BASE_URL: 'http://mock:8002',
        SCIM_BASE_URL: 'http://mock:8002/scim',
        SCIM_TOKEN: 'release-fixture-scim',
        ENTERPRISE_SLUG: 'release-fixture',
        ENTERPRISE_SHORTCODE: 'fixture',
        SSO_DEFAULT_USER_PASSWORD: 'release-fixture-password-only',
      }, ['sso-data:/data', '${RELEASE_QUALIFICATION_DIR:?run prepare}/certs:/certs:ro']),
      login: app('login', 7003, {
        PORT: '7003',
        DB_PATH: '/data/login.sqlite',
        INTERNAL_API_TOKEN: 'release-fixture-internal',
        PROXY_BASE_URL: 'http://proxy:3000',
        SSO_URL: 'http://sso:7001/login',
        SESSION_SECRET: 'release-fixture-session-long-only',
        AUTH_HEADLESS: 'true',
      }, ['login-data:/data']),
      console: app('console', 7004, {
        PORT: '7004',
        ADMINS_FILE: '/data/admins.json',
        SESSION_SECRET: 'release-fixture-session-long-only',
        INTERNAL_API_TOKEN: 'release-fixture-internal',
        PROXY_BASE_URL: 'http://proxy:3000',
        SSO_BASE_URL: 'http://sso:7001',
        LOGIN_BASE_URL: 'http://login:7003',
      }, ['console-data:/data']),
    },
    networks: {
      isolated: {
        internal: true,
        ipam: { config: [{ subnet: '${RELEASE_QUALIFICATION_ISOLATED_SUBNET:?set a fresh subnet}' }] },
      },
    },
    volumes: { 'proxy-data': {}, 'sso-data': {}, 'login-data': {}, 'console-data': {} },
  };
}

/** Volumes copied by the step-1 backup and restored in step 5 (MySQL itself is dumped separately). */
export const MYSQL_APP_VOLUMES = Object.freeze(['sso-data', 'login-data', 'login-logs', 'console-data', 'proxy-data',
  'proxy2-data']);
export const SQLITE_APP_VOLUMES = Object.freeze(['proxy-data', 'sso-data', 'login-data', 'console-data']);

/**
 * Isolation rules of one rendered Compose config (`docker compose config --format json`): fixed service set, app
 * containers only on the internal network with no published ports and the shipped CMD, loopback-only bridge, and
 * project-owned volumes. Returns the violated rule names (empty when isolated).
 */
export function composeViolations(config, { project, services, apps, bridgePorts = 0 }) {
  const problems = [];
  if (config.name !== project) problems.push('compose_project_mismatch');
  const names = Object.keys(config.services ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...services].sort())) problems.push('unexpected_compose_services');
  for (const service of apps) {
    const item = config.services?.[service];
    if (!item) continue;
    if (item.command || item.entrypoint || item.working_dir || item.build) {
      problems.push(`shipped_cmd_overridden_${service}`);
    }
    const networks = Object.keys(item.networks ?? {});
    if (networks.length !== 1 || networks[0] !== 'isolated' || item.ports) {
      problems.push(`app_network_escape_${service}`);
    }
  }
  if (config.networks?.isolated?.internal !== true) problems.push('network_not_internal');
  if (bridgePorts) {
    const ports = config.services?.bridge?.ports ?? [];
    if (ports.length !== bridgePorts || !ports.every((port) => port.host_ip === '127.0.0.1')) {
      problems.push('bridge_not_loopback_only');
    }
  }
  for (const [service, item] of Object.entries(config.services ?? {})) {
    if (service !== 'bridge' && item.ports) problems.push(`ports_published_${service}`);
  }
  const owned = (volume) => volume.name?.startsWith(`${project}_`) && !volume.external;
  if (!Object.values(config.volumes ?? {}).every(owned)) {
    problems.push('foreign_volume');
  }
  return problems;
}

/** keygrip's default cookie signature (HMAC-SHA1, base64url), as the SSO session cookie uses. */
export function signCookie(name, value, secret) {
  return createHmac('sha1', secret).update(`${name}=${value}`).digest('base64url');
}

/** A signed SSO session cookie pair for `name` with the given payload (used to forge cross-enterprise cookies). */
export function forgeSessionCookie(name, payload, secret) {
  const value = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `${name}=${value}; ${name}.sig=${signCookie(name, value, secret)}`;
}

/** Decodes the base64 JSON value of an SSO session cookie; undefined when it is not one. */
export function decodeSessionCookie(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** `{ name: value }` of Set-Cookie header lines (attributes dropped). */
export function parseSetCookies(lines = []) {
  const cookies = {};
  for (const line of lines) {
    const pair = String(line).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator > 0) cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

/** Cookie header carrying `name` and `name.sig` from a cookie map. */
export function cookieHeader(cookies, name) {
  if (cookies[name] === undefined || cookies[`${name}.sig`] === undefined) return '';
  return `${name}=${cookies[name]}; ${name}.sig=${cookies[`${name}.sig`]}`;
}

/** Moves a cookie pair to another name without re-signing (the "cookie swap" attack of step 4). */
export function renameCookie(cookies, from, to) {
  return `${to}=${cookies[from]}; ${to}.sig=${cookies[`${from}.sig`]}`;
}

/** Classifies an SSO `/sso` probe: a SAML POST page, a redirect to the enterprise's login page, or other. */
export function samlOutcome(response, loginPath) {
  if (response.status === 200 && /name="SAMLResponse"/.test(response.text ?? '')) return 'saml_response';
  const location = response.headers?.location ?? '';
  if ([302, 303].includes(response.status) && (location === loginPath || location.endsWith(loginPath))) {
    return 'login_redirect';
  }
  return 'other';
}

/** `entityID` and the first X509 certificate of SAML metadata, for comparing IdP identity across versions. */
export function metadataIdentity(xml) {
  const entityId = /entityID="([^"]+)"/.exec(xml ?? '')?.[1] ?? null;
  const certificate = /<(?:\w+:)?X509Certificate>([^<]+)</.exec(xml ?? '')?.[1]?.replace(/\s+/g, '') ?? null;
  return { entityId, certificateSha256: certificate ? sha(certificate) : null };
}

/** The `certificateSha256` metadataIdentity reports for an IdP whose signing certificate is this PEM. */
export function pemCertificateSha256(pem) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(String(pem));
  if (!match) throw new Error('not a PEM certificate');
  return sha(match[1].replace(/\s+/g, ''));
}

export const sha = (value) => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest('hex');

/** Columns the multi-enterprise SSO/Login migrations drop on purpose (design §4.3: id=1 becomes enterprise_id). */
export const EXPECTED_DROPPED_COLUMNS = Object.freeze({ sso_runtime_settings: ['id'] });
/** Tables that may only grow across an upgrade. */
export const APPEND_ONLY_TABLES = Object.freeze(['schema_migrations']);

/**
 * Compares two logical table dumps (`{ table: { columns, rows: [{ column: hash }] } }`): every pre-existing table,
 * column (except the expected drops) and value must survive. Returns violation names (empty when preserved).
 * With `exact`, the after-dump must also have no new tables, columns or rows (rollback check).
 */
export function tableDiff(before, after, { exact = false, dropped = EXPECTED_DROPPED_COLUMNS } = {}) {
  const problems = [];
  for (const [table, previous] of Object.entries(before ?? {})) {
    const current = after?.[table];
    if (!current) {
      problems.push(`table_removed_${table}`);
      continue;
    }
    const allowed = exact ? [] : dropped[table] ?? [];
    const kept = previous.columns.filter((column) => !allowed.includes(column));
    if (!kept.every((column) => current.columns.includes(column))) problems.push(`column_removed_${table}`);
    const project = (rows) => rows.map((row) => JSON.stringify(kept.map((column) => row[column]))).sort();
    const beforeRows = project(previous.rows);
    const afterRows = project(current.rows);
    const preserved = APPEND_ONLY_TABLES.includes(table) && !exact
      ? beforeRows.every((row) => afterRows.includes(row))
      : JSON.stringify(beforeRows) === JSON.stringify(afterRows);
    if (!preserved) problems.push(`rows_changed_${table}`);
    if (exact && JSON.stringify(previous.columns) !== JSON.stringify(current.columns)) {
      problems.push(`columns_changed_${table}`);
    }
  }
  if (exact) {
    for (const table of Object.keys(after ?? {})) if (!before?.[table]) problems.push(`table_added_${table}`);
  }
  return problems;
}

/** Hash fields of the MySQL logical snapshot that must be identical across the in-place upgrade. */
export const UPGRADE_STABLE_HASHES = Object.freeze(['settingsHash', 'credentialsHash', 'membersHash', 'leasesHash',
  'statsHash']);
/** Rollback (restore of the step-1 backup) must restore everything, schema included. */
export const ROLLBACK_STABLE_HASHES = Object.freeze([...UPGRADE_STABLE_HASHES, 'schemaHash', 'migrationsHash']);

export function snapshotDifferences(before, after, fields) {
  return fields.filter((field) => before?.[field] !== after?.[field]);
}

/** Stable SQL dump options: one consistent transaction, triggers/routines kept, no GTID or tablespace statements. */
export const MYSQLDUMP_ARGS = Object.freeze([
  '--single-transaction',
  '--routines',
  '--triggers',
  '--events',
  '--set-gtid-purged=OFF',
  '--no-tablespaces',
  '--skip-dump-date',
]);

/** SQL that restores the dump into a clean database (DB-level grants survive DROP DATABASE). */
export function restorePreamble(database) {
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error('invalid database name');
  return `DROP DATABASE IF EXISTS \`${database}\`;\nCREATE DATABASE \`${database}\`;\nUSE \`${database}\`;\n`;
}

/**
 * Doubling INSERT … SELECT statements that multiply `proxy_request_stats` for step 7 (a larger table to migrate).
 * Ids are re-derived per round so they stay ≤ 64 characters and unique. Each copy also gets a new identity, so no
 * identity exceeds its per-account retention: Proxy prunes every identity to REQUEST_STATS_PER_ACCOUNT_LIMIT at
 * startup under its 5 s statement deadline, and a table that is mostly over retention would time that out instead.
 */
export function statsInflationSql(columns, rounds) {
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 16) throw new Error('rounds must be 0..16');
  const names = columns.filter((column) => column !== 'id');
  if (!names.every((column) => /^[a-z_]+$/.test(column))) throw new Error('unsafe column name');
  if (!names.includes('identity')) throw new Error('identity column required');
  const list = names.join(', ');
  return Array.from({ length: rounds }, (_, round) => {
    const tag = String(round).padStart(2, '0');
    const values = names.map((column) => (column === 'identity' ? `CONCAT(identity, '.q${tag}')` : column)).join(', ');
    return `INSERT INTO proxy_request_stats (id, ${list}) `
      + `SELECT CONCAT('q7-${tag}-', SHA2(id, 224)), ${values} FROM proxy_request_stats;`;
  });
}

/** Probe request payload for multi-probe.mjs: base64url JSON keeps argv quoting safe on every platform. */
export function encodeProbe(requests) {
  return Buffer.from(JSON.stringify({ requests })).toString('base64url');
}

export function decodeProbe(encoded) {
  const value = JSON.parse(Buffer.from(String(encoded), 'base64url').toString('utf8'));
  if (!value || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 40) {
    throw new Error('invalid_probe');
  }
  return value.requests;
}

/** Last JSON line of a fixture's stdout that satisfies `accept`. */
export function lastJsonLine(stdout, accept = () => true) {
  const lines = String(stdout).trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (accept(value)) return value;
    } catch {
      // Not a JSON line.
    }
  }
  return undefined;
}

const step = (id, title, assertions) => Object.freeze({ id, title, assertions: Object.freeze(assertions) });

/**
 * The qualification plan. Assertion names are the `check` labels the runner records; the report is complete only
 * when every planned assertion of every step passed (`planCoverage`).
 */
export function qualificationPlan(mode) {
  if (mode === 'multi-upgrade') return MYSQL_PLAN;
  if (mode === 'multi-upgrade-sqlite') return SQLITE_PLAN;
  if (mode === 'multi-fresh') return FRESH_MYSQL_PLAN;
  if (mode === 'multi-fresh-dba') return FRESH_DBA_PLAN;
  if (mode === 'multi-fresh-sqlite') return FRESH_SQLITE_PLAN;
  throw new Error(`unknown multi mode ${mode}`);
}

const MYSQL_PLAN = Object.freeze([
  step('preflight', 'Fresh project, isolated Compose renders (legacy and registry phases), local images only', [
    'fresh_project_and_volumes',
    'compose_isolated_legacy_phase',
    'compose_isolated_registry_phase',
    'images_present_locally',
    'candidate_shipped_defaults',
    'candidate_legacy_command_starts_and_stops_cleanly',
  ]),
  step('step1', 'r4 baseline: smoke data, renewed leases, sessions, snapshot, stop, backup', [
    'baseline_smoke_passed',
    'baseline_leases_renewed_for_run',
    'baseline_console_session',
    'baseline_sso_root_session_cookie',
    'baseline_runtime_verified',
    'baseline_quiescent_snapshot',
    'baseline_applications_stopped',
    'backup_mysql_dump_written',
    'backup_volumes_copied',
  ]),
  step('step2', 'Candidate on the same volumes, no registry, env unchanged', [
    'candidate_env_equals_r4_env',
    'infrastructure_not_recreated',
    'snapshot_preserved_except_schema',
    'pool_config_fingerprint_rewritten',
    'schema_migrations_complete_mysql',
    'enterprise_id_default_backfilled',
    'enterprise_columns_fail_closed',
    'default_enterprise_row_seeded',
    'replacement_scheduler_owner_renewing',
    'console_session_and_enterprise_api',
    'candidate_runtime_verified',
    'sso_login_persistent_rows_preserved',
    'sso_root_metadata_identity_unchanged',
    'sso_existing_root_session_valid',
    'sso_root_login_issues_default_cookie',
    'login_task_history_preserved',
    'same_lease_protocol_json_sse',
    'release_line_health_evidence',
  ]),
  step('step3', 'r4 Proxy refuses to start on the migrated MySQL', [
    'r4_proxy_exits_nonzero',
    'r4_proxy_never_listened',
    'migrated_schema_untouched_by_r4',
    'candidate_replicas_still_ready',
  ]),
  step('step4', 'Registry (default with env cleared, GHE.com mock enterprise): draft, active, inventory, inference', [
    'registry_env_cleared',
    'rolling_restart_healthy',
    'registry_default_identity_unchanged',
    'new_enterprise_is_draft',
    'new_enterprise_ready',
    'stale_policy_version_rejected',
    'new_enterprise_activated',
    'global_cap_patch_rejected',
    'replenished_into_new_enterprise_only',
    'ghe_tenant_unsuffixed_handles',
    'ghe_tenant_callbacks_scoped',
    'inference_through_new_enterprise',
    'new_enterprise_stats_scoped',
    'wrong_enterprise_callback_404',
    'wrong_enterprise_management_404',
    'unknown_enterprise_404',
    'same_name_sso_user_isolated',
    'sso_cookie_swap_rejected',
    'sso_forged_enterprise_claim_rejected',
    'unscoped_paths_400',
    'default_tenant_untouched',
  ]),
  step('step5', 'Restore the step-1 backup and run r4 (rollback drill)', [
    'candidate_applications_stopped',
    'mysql_restored_from_dump',
    'volumes_restored_from_backup',
    'r4_restarted_healthy',
    'rollback_snapshot_equals_baseline',
    'rollback_has_no_enterprise_schema',
    'rollback_replacement_scheduler_owner',
    'rollback_runtime_and_persistence',
    'rollback_console_and_sso_sessions',
    'rollback_same_lease_protocol',
  ]),
  step('step7', 'Kill the Proxy mid-migration, restart, migration completes', [
    'r4_applications_stopped',
    'stats_table_inflated',
    'migration_blocked_mid_step',
    'proxy_killed_mid_migration',
    'partial_migration_recorded',
    'restart_completes_all_migration_ids',
    'crash_recovery_backfill_complete',
    'crash_recovery_protocol',
  ]),
]);

const SQLITE_PLAN = Object.freeze([
  step('preflight', 'Fresh project, isolated SQLite Compose render, local images only', [
    'fresh_project_and_volumes',
    'compose_isolated_sqlite',
    'images_present_locally',
  ]),
  step('step6-baseline', 'r4 SQLite direct mode: seed account, stats, SSO and Console sessions; snapshot; backup', [
    'sqlite_baseline_healthy',
    'sqlite_baseline_seeded',
    'sqlite_baseline_snapshot',
    'sqlite_baseline_backup',
  ]),
  step('step6-candidate', 'Candidate on the same SQLite volumes, env unchanged', [
    'sqlite_candidate_healthy',
    'sqlite_rows_preserved',
    'sqlite_enterprise_default_backfilled',
    'sqlite_migration_ids_recorded',
    'sqlite_fail_closed_triggers_present',
    'sqlite_direct_inference_and_stats',
    'sqlite_legacy_accounts_deprecated',
    'sqlite_unscoped_400_scoped_200',
    'sqlite_sessions_survive_upgrade',
  ]),
  step('step6-r4-on-migrated', 'r4 on the migrated SQLite cannot write rows without an enterprise', [
    'sqlite_r4_writes_refused',
  ]),
  step('step6-restore', 'Restore the backup and run r4', [
    'sqlite_restored_exact',
    'sqlite_r4_inference_after_restore',
  ]),
]);

// Fresh single-enterprise deployments: empty databases and volumes, no registry, candidate images only.
const FRESH_COMMON_TAIL = Object.freeze([
  step('fresh-scope', 'Scoped /api/enterprises/default/... answers; unscoped management paths are 400', [
    'scoped_management_200',
    'unscoped_management_400',
  ]),
  step('fresh-sso', 'SAML login of the default enterprise at the root paths /login, /sso and /metadata', [
    'sso_root_login_default_cookie',
    'sso_root_saml_response',
    'sso_root_metadata_identity',
  ]),
  step('fresh-runtime', 'In-container runtime checks of every application (scoped management API)', [
    'runtime_verified_scoped',
  ]),
  step('fresh-stop', 'Every application stops cleanly', [
    'applications_exit_zero',
  ]),
]);

const FRESH_CONSOLE = step('fresh-console', 'Console first-run admin setup, login and the default enterprise overview', [
  'console_first_run_setup',
  'console_login',
  'console_default_enterprise_overview',
]);

function freshMysqlPlan(dba) {
  return Object.freeze([
    step('preflight', 'Fresh project, isolated Compose render without a registry, local candidate images only', [
      'fresh_project_and_volumes',
      'compose_isolated_fresh',
      'images_present_locally',
      'candidate_shipped_defaults',
      'candidate_legacy_command_starts_and_stops_cleanly',
    ]),
    ...(dba ? [step('fresh-dba-schema', 'DBA path: empty database, generated initial SQL, DML-only runtime account', [
      'mysql_database_empty',
      'initial_sql_applied',
      'runtime_grants_dml_only',
    ])] : []),
    step('fresh-start', dba
      ? 'Both replicas start with MYSQL_AUTO_MIGRATE=false on the prepared schema; default synthesized from env'
      : 'Both replicas start on an empty database (MYSQL_AUTO_MIGRATE default); default synthesized from env', [
      'fresh_services_healthy',
      'release_line_multi',
      'fresh_migration_ids_complete',
      ...(dba ? ['dba_startup_no_ddl'] : []),
      'fresh_enterprise_columns_fail_closed',
      'single_default_enterprise_active',
      'sso_login_single_default_enterprise',
      'single_scheduler_owner_renewing',
    ]),
    FRESH_CONSOLE,
    step('fresh-pool', 'Pool provisions synthetic members through mock SCIM, Login and Copilot to the idle target', [
      'pool_fresh_settings',
      'pool_reaches_idle_target',
      'pool_provisioning_scoped_to_default',
    ]),
    step('fresh-caller', 'Caller key: provisional then active lease, three protocols JSON + SSE, sticky across replicas', [
      'caller_provisional_lease',
      'caller_protocol_json_sse_same_member',
      'caller_active_lease_both_replicas',
      'caller_stats_default_enterprise',
      'second_caller_exclusive_member',
    ]),
    ...FRESH_COMMON_TAIL,
  ]);
}

const FRESH_MYSQL_PLAN = freshMysqlPlan(false);
const FRESH_DBA_PLAN = freshMysqlPlan(true);

const FRESH_SQLITE_PLAN = Object.freeze([
  step('preflight', 'Fresh project, isolated SQLite Compose render, local candidate images only', [
    'fresh_project_and_volumes',
    'compose_isolated_sqlite',
    'images_present_locally',
    'candidate_shipped_defaults',
  ]),
  step('fresh-start', 'Direct mode on empty volumes; default synthesized from env', [
    'fresh_services_healthy',
    'release_line_multi',
    'sqlite_fresh_migration_ids_complete',
    'sqlite_fail_closed_triggers_present',
    'sqlite_single_default_enterprise',
  ]),
  FRESH_CONSOLE,
  step('fresh-direct', 'Direct mode: scoped SSO user and token import, inference JSON + SSE, statistics', [
    'sqlite_scoped_user_and_token_import',
    'sqlite_direct_inference_json_sse',
    'sqlite_stats_default_enterprise',
    'sqlite_legacy_accounts_deprecated',
  ]),
  ...FRESH_COMMON_TAIL,
]);

/** Which planned assertions never passed, and which recorded ones were not planned. */
export function planCoverage(plan, results) {
  const missing = [];
  const unplanned = [];
  for (const planned of plan) {
    const result = results.find((row) => row.id === planned.id);
    const passed = new Set((result?.assertions ?? []).filter((row) => row.pass).map((row) => row.name));
    for (const name of planned.assertions) if (!passed.has(name)) missing.push(`${planned.id}:${name}`);
    for (const row of result?.assertions ?? []) {
      if (!planned.assertions.includes(row.name)) unplanned.push(`${planned.id}:${row.name}`);
    }
  }
  return { missing, unplanned, complete: missing.length === 0 };
}

/** Bounded run time (minutes) for the multi modes; Docker Desktop under load is slow. */
export function runBudget(mode, raw) {
  const fallback = { 'multi-upgrade': 50, 'multi-fresh': 30, 'multi-fresh-dba': 30 }[mode] ?? 20;
  const minutes = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 120) throw new Error('invalid_run_budget');
  return { activeMs: minutes * 60000, finalMs: (minutes + 5) * 60000 };
}
