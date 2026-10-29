// Local, process-based environment for the administrator-manual screenshots.
// Runs the built Proxy, SSO, Login and Console (`npm run build:deploy`) as plain Node processes with SQLite, plus
// the repository mock (tests/docker-user-pool/mock-services.mjs) and edge-mock.mjs. Every process is preloaded
// with dns-shim.mjs, so only local service names and *.ghe.com mock hosts resolve (to 127.0.0.1).
// All credentials below are fixed synthetic fixture strings; nothing here is a real secret.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../../..');
const SHIM = pathToFileURL(join(here, 'dns-shim.mjs')).href;

export const PORTS = { proxy: 3000, sso: 7001, login: 7003, console: 7004, mock: 8002, edge: 80 };
export const INTERNAL = 'am-fixture-internal-only';
export const PROXY_API_KEY = 'am-fixture-proxy-api-only';
export const MODELS_ADMIN_TOKEN = 'am-fixture-models-admin-only';
export const ADMIN = { username: 'admin', password: 'Example-Console-Pass-01' };

const DEFAULT_TENANT = {
  scimToken: 'am-fixture-scim-default-only', seatPat: 'am-fixture-seat-default-only',
  ssoPassword: 'am-fixture-sso-default-password', session: 'am-fixture-session-default-only',
};
const FABRIKAM = {
  id: 'fabrikam', host: 'fabrikam.ghe.com', slug: 'fabrikam',
  scimToken: 'am-fixture-scim-fabrikam-only', seatPat: 'am-fixture-seat-fabrikam-only',
  ssoPassword: 'am-fixture-sso-fabrikam-password', session: 'am-fixture-session-fabrikam-only',
};
const CONTOSO = {
  id: 'contoso-eu', slug: 'contoso-eu',
  scimToken: 'am-fixture-scim-contoso-only', seatPat: 'am-fixture-seat-contoso-only',
  ssoPassword: 'am-fixture-sso-contoso-password', session: 'am-fixture-session-contoso-only',
};

const slash = (path) => path.replaceAll('\\', '/');

function generateCert(dir) {
  mkdirSync(dir, { recursive: true });
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'idp-key.pem'),
    '-out', join(dir, 'idp-cert.pem'), '-days', '30', '-subj', '/CN=example-fixture-idp'], { stdio: 'pipe' });
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr}`);
}

function writeSecret(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${value}\n`);
}

/** Creates the run directory: certificates, secret files and the three-enterprise registry. */
export function prepareRun(runDir) {
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  const secrets = join(runDir, 'secrets');
  generateCert(join(runDir, 'certs', 'default'));
  generateCert(join(runDir, 'certs', 'fabrikam'));
  generateCert(join(runDir, 'certs', 'contoso-eu'));
  writeSecret(join(secrets, 'default', 'models-admin-token'), MODELS_ADMIN_TOKEN);
  for (const tenant of [FABRIKAM, CONTOSO]) {
    writeSecret(join(secrets, tenant.id, 'session-secret'), tenant.session);
    writeSecret(join(secrets, tenant.id, 'scim-token'), tenant.scimToken);
    writeSecret(join(secrets, tenant.id, 'seat-pat'), tenant.seatPat);
    writeSecret(join(secrets, tenant.id, 'default-password'), tenant.ssoPassword);
  }
  const secret = (id, name) => ({ file: slash(join(secrets, id, name)) });
  const cert = (id, name) => ({ file: slash(join(runDir, 'certs', id, name)) });
  const registry = {
    version: 1,
    enterprises: [
      {
        id: 'default',
        displayName: 'Default (github.com)',
        github: {
          baseUrl: 'https://github.com', apiBaseUrl: 'http://mock', copilotApiBaseUrl: 'http://mock',
          slug: 'local-test', shortcode: 'test',
        },
        // Only the first SSO runtime defaults; the remaining `default` fields come from the SSO environment.
        sso: { emailDomain: 'example.com', userPrefix: 'ghcp' },
      },
      {
        id: CONTOSO.id,
        displayName: 'Contoso EU (github.com)',
        github: {
          baseUrl: 'https://github.com', apiBaseUrl: 'http://mock', copilotApiBaseUrl: 'http://mock',
          slug: CONTOSO.slug, shortcode: 'contoso',
        },
        sso: {
          scimBaseUrl: `http://mock/scim/v2/enterprises/${CONTOSO.slug}`,
          emailDomain: 'contoso.example.com',
          userPrefix: 'ghcp',
          signingCert: cert(CONTOSO.id, 'idp-cert.pem'),
          // Deliberately points at a file that is created only later in the scenario (readiness blocker demo).
          signingKey: cert(CONTOSO.id, 'idp-key-rotated.pem'),
          sessionSecret: secret(CONTOSO.id, 'session-secret'),
          scimToken: secret(CONTOSO.id, 'scim-token'),
          seatPat: secret(CONTOSO.id, 'seat-pat'),
          defaultUserPassword: secret(CONTOSO.id, 'default-password'),
        },
        pool: { accountDomain: 'pool.contoso.example.com', initialMaxAccounts: 10 },
      },
      {
        id: FABRIKAM.id,
        displayName: 'Fabrikam (GHE.com)',
        github: {
          baseUrl: `http://${FABRIKAM.host}`, apiBaseUrl: `http://api.${FABRIKAM.host}`,
          copilotApiBaseUrl: `http://copilot-api.${FABRIKAM.host}`, slug: FABRIKAM.slug,
        },
        sso: {
          emailDomain: 'fabrikam.example.com',
          userPrefix: 'ghcp',
          signingCert: cert(FABRIKAM.id, 'idp-cert.pem'),
          signingKey: cert(FABRIKAM.id, 'idp-key.pem'),
          sessionSecret: secret(FABRIKAM.id, 'session-secret'),
          scimToken: secret(FABRIKAM.id, 'scim-token'),
          seatPat: secret(FABRIKAM.id, 'seat-pat'),
          defaultUserPassword: secret(FABRIKAM.id, 'default-password'),
        },
        login: { ssoProvider: 'custom' },
        pool: { accountDomain: 'pool.fabrikam.example.com', initialMaxAccounts: 10 },
      },
    ],
  };
  writeFileSync(join(runDir, 'registry.json'), `${JSON.stringify(registry, null, 2)}\n`);
  return { registry: join(runDir, 'registry.json') };
}

/** The scenario's "fix the blocker" step: provide the missing contoso-eu signing key (then restart SSO). */
export function provideContosoSigningKey(runDir) {
  const dir = join(runDir, 'certs', CONTOSO.id);
  copyFileSync(join(dir, 'idp-key.pem'), join(dir, 'idp-key-rotated.pem'));
}

function baseEnv() {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'];
  const env = { NODE_ENV: 'production', LOG_LEVEL: process.env.AM_LOG_LEVEL ?? 'warn', INTERNAL_API_TOKEN: INTERNAL, TZ: 'UTC' };
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function serviceSpecs(runDir) {
  const registry = slash(join(runDir, 'registry.json'));
  const mockTenants = [{
    host: FABRIKAM.host, slug: FABRIKAM.slug, enterpriseId: FABRIKAM.id, port: PORTS.edge,
    scimToken: FABRIKAM.scimToken, seatPat: FABRIKAM.seatPat, ssoPassword: FABRIKAM.ssoPassword,
    idpSsoUrl: `http://sso:${PORTS.sso}/enterprises/${FABRIKAM.id}/sso`,
  }];
  return {
    mock: {
      cwd: REPO, entry: 'tests/docker-user-pool/mock-services.mjs',
      env: {
        PORT: String(PORTS.mock), SCIM_TOKEN: DEFAULT_TENANT.scimToken, SEAT_PAT: DEFAULT_TENANT.seatPat,
        SSO_DEFAULT_USER_PASSWORD: DEFAULT_TENANT.ssoPassword, PROXY_BASE_URL: `http://proxy:${PORTS.proxy}`,
        MOCK_GHE_TENANTS: JSON.stringify(mockTenants), MOCK_LOGIN_READINESS_URL: `http://login:${PORTS.login}`,
      },
      health: `http://127.0.0.1:${PORTS.mock}/healthz`,
    },
    edge: {
      cwd: REPO, entry: 'docs/admin-manual/tools/edge-mock.mjs',
      env: {
        EDGE_PORT: String(PORTS.edge), EDGE_UPSTREAM_PORT: String(PORTS.mock),
        EDGE_SEAT_PATS: [DEFAULT_TENANT.seatPat, FABRIKAM.seatPat, CONTOSO.seatPat].join(','),
        EDGE_MODELS_ADMIN_TOKEN: MODELS_ADMIN_TOKEN, EDGE_MODELS_ADMIN_LOGIN: 'example-admin',
      },
      health: `http://127.0.0.1:${PORTS.edge}/healthz`,
    },
    sso: {
      cwd: join(REPO, 'src/sso'), entry: 'dist/index.js',
      env: {
        PORT: String(PORTS.sso), DB_PATH: join(runDir, 'sso.sqlite'), BASE_URL: `http://sso:${PORTS.sso}`,
        PROXY_BASE_URL: `http://proxy:${PORTS.proxy}`, SESSION_SECRET: DEFAULT_TENANT.session,
        SSO_DEFAULT_USER_PASSWORD: DEFAULT_TENANT.ssoPassword, SSO_USER_EVENTS_LOG: join(runDir, 'sso-user-events.log'),
        ENTERPRISE_SLUG: 'local-test', ENTERPRISE_SHORTCODE: 'test', GITHUB_COPILOT_SEAT_PAT: DEFAULT_TENANT.seatPat,
        SCIM_BASE_URL: 'http://mock/scim/v2/enterprises/local-test', SCIM_TOKEN: DEFAULT_TENANT.scimToken,
        SP_ENTITY_ID: 'http://mock/saml', SP_ACS_URL: 'http://mock/saml/acs', CERT_DIR: join(runDir, 'certs', 'default'),
        ENTERPRISE_REGISTRY_FILE: registry,
      },
      health: `http://127.0.0.1:${PORTS.sso}/healthz`,
    },
    login: {
      cwd: join(REPO, 'src/login'), entry: 'dist/index.js',
      env: {
        PORT: String(PORTS.login), DB_PATH: join(runDir, 'login.sqlite'), PROXY_BASE_URL: `http://proxy:${PORTS.proxy}`,
        LOG_DIR: join(runDir, 'logs', 'login'), SSO_URL: `http://sso:${PORTS.sso}/login`, AUTH_HEADLESS: 'true',
        ENTERPRISE_SLUG: 'local-test', ENTERPRISE_REGISTRY_FILE: registry,
      },
      health: `http://127.0.0.1:${PORTS.login}/healthz`,
    },
    proxy: {
      cwd: join(REPO, 'src/proxy'), entry: 'dist/index.js',
      env: {
        PORT: String(PORTS.proxy), PROXY_INSTANCE_ID: 'proxy-a', API_KEY: PROXY_API_KEY, STORAGE_DRIVER: 'sqlite',
        DB_PATH: join(runDir, 'proxy.sqlite'), ACCOUNT_ROUTING_MODE: 'caller-lease',
        POOL_ACCOUNT_EMAIL_DOMAIN: 'pool.example.com', POOL_WARMUP_MODEL: 'claude-opus-5-2',
        READY_IDLE_TARGET: '0', POOL_MAX_ACCOUNTS: '6', PREWARM_POLL_SECONDS: '1', PREWARM_CONCURRENCY: '2',
        POOL_REQUEST_TIMEOUT_SECONDS: '30', POOL_EXHAUSTED_RETRY_AFTER_SECONDS: '5',
        SSO_BASE_URL: `http://sso:${PORTS.sso}`, LOGIN_BASE_URL: `http://mock:${PORTS.mock}`,
        ENTERPRISE_SHORTCODE: 'test', REQUEST_STATS_PER_ACCOUNT_LIMIT: '100',
        PROXY_ERROR_DIAGNOSTICS_ENABLED: 'true', PROXY_ERROR_DIAGNOSTICS_REDACT: 'true',
        PROXY_ERROR_DIAGNOSTICS_DIR: join(runDir, 'error-diagnostics'),
        MODELS_ADMIN_GITHUB_LOGIN: 'example-admin', MODELS_ADMIN_GITHUB_USER_ID: '4242',
        MODELS_ADMIN_COPILOT_TOKEN_FILE: join(runDir, 'secrets', 'default', 'models-admin-token'),
        ENTERPRISE_REGISTRY_FILE: registry,
      },
      health: `http://127.0.0.1:${PORTS.proxy}/readyz`,
    },
    console: {
      cwd: join(REPO, 'src/console'), entry: 'dist/server/index.js',
      env: {
        PORT: String(PORTS.console), ADMINS_FILE: join(runDir, 'admins.json'),
        SESSION_SECRET: 'am-fixture-console-session-only', PROXY_BASE_URL: `http://proxy:${PORTS.proxy}`,
        SSO_BASE_URL: `http://sso:${PORTS.sso}`, LOGIN_BASE_URL: `http://login:${PORTS.login}`,
      },
      health: `http://127.0.0.1:${PORTS.console}/healthz`,
    },
  };
}

export const START_ORDER = ['mock', 'edge', 'sso', 'login', 'proxy', 'console'];

async function waitHealthy(name, url, child, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with ${child.exitCode}; see its log`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status < 500 || name === 'edge') return;
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${name} did not become healthy at ${url}`);
}

/** Starts (or restarts) the named services in order and waits for each to answer its health URL. */
export class LocalEnvironment {
  constructor(runDir) {
    this.runDir = runDir;
    this.specs = serviceSpecs(runDir);
    this.children = new Map();
  }

  async start(names = START_ORDER) {
    for (const name of names) {
      // A cold start occasionally stalls on Windows (seen once or twice per dozen starts, before any output);
      // a fresh process then starts normally, so each service gets three bounded attempts.
      for (let attempt = 1; ; attempt += 1) {
        const child = this.spawn(name);
        try {
          await waitHealthy(name, this.specs[name].health, child, 60000);
          break;
        } catch (error) {
          await this.stop([name]);
          if (attempt === 3) throw error;
          appendFileSync(join(this.runDir, 'logs', `${name}.log`), `\n[admin-manual env] attempt ${attempt} failed: ${error.message}; retrying\n`);
        }
      }
    }
  }

  spawn(name) {
    const spec = this.specs[name];
    // File descriptors rather than pipes: output reaches the log even if the process is stuck or killed.
    const log = openSync(join(this.runDir, 'logs', `${name}.log`), 'a');
    const child = spawn(process.execPath, ['--import', SHIM, spec.entry], {
      cwd: spec.cwd, env: { ...baseEnv(), ...spec.env }, stdio: ['ignore', log, log], windowsHide: true,
    });
    child.once('exit', () => closeSync(log));
    this.children.set(name, child);
    return child;
  }

  async stop(names = [...START_ORDER].reverse()) {
    for (const name of names) {
      const child = this.children.get(name);
      if (!child || child.exitCode !== null) continue;
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 10000);
      await exited;
      clearTimeout(timer);
      this.children.delete(name);
    }
  }

  async restart(name) {
    await this.stop([name]);
    await this.start([name]);
  }
}
