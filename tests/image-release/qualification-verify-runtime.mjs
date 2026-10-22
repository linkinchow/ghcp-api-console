// Executed inside a running shipped image using `compose exec ... node`.
// Only this fixture is mounted; resolution is anchored in the image's own app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional third argument `scoped`: multi-enterprise images, whose SSO/Login management APIs are enterprise-scoped
// (unscoped paths answer 400 enterprise_scope_required); the `default` enterprise is checked instead.
// Optional fourth argument: the number of SSO users the deployment holds (default 3, the MySQL smoke's inventory).
const [service, phase, apiScope = 'unscoped', ssoUsers = '3'] = process.argv.slice(2);
assert.ok(['proxy', 'proxy2', 'console', 'sso', 'login'].includes(service));
assert.ok(['baseline', 'candidate', 'rollback'].includes(phase));
assert.ok(['unscoped', 'scoped'].includes(apiScope));
assert.match(ssoUsers, /^\d{1,3}$/);
const scoped = apiScope === 'scoped';
const managementPath = (path) => (scoped ? `/api/enterprises/default${path}` : `/api${path}`);
const component = service === 'proxy2' ? 'proxy' : service;
const anchor = `/app/src/${component}/package.json`;
const requireImage = createRequire(anchor);
const hash = (value) => createHash('sha256')
  .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  .digest('hex');
const result = {
  service,
  phase,
  apiScope,
  pass: false,
  node: process.versions.node,
  abi: process.versions.modules,
  cwd: process.cwd(),
};
try {
  assert.match(process.versions.node, /^22\./);
  const sharedPackage = JSON.parse(readFileSync('/app/node_modules/@ghcp/shared/package.json', 'utf8'));
  const shared = realpathSync(join('/app/node_modules/@ghcp/shared', sharedPackage.exports['.'].import));
  assert.ok(shared.startsWith('/app/'), 'shared_must_resolve_inside_image');
  await import(pathToFileURL(shared).href);
  result.sharedResolution = true;

  // Native module probe: better-sqlite3 must load and behave in this image's Node ABI.
  const Database = requireImage('better-sqlite3');
  const directory = mkdtempSync('/data/qualification-native-');
  const path = join(directory, 'probe.sqlite');
  let db;
  try {
    db = new Database(path);
    assert.equal(db.pragma('journal_mode = WAL', { simple: true }), 'wal');
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
    db.transaction(() => db.prepare('INSERT INTO probe VALUES (?, ?)').run(1, 'synthetic-native-probe'))();
    assert.throws(() => db.prepare('INSERT INTO probe VALUES (?, ?)').run('not-an-integer', 'rejected'));
    assert.throws(() => db.transaction(() => {
      db.prepare('INSERT INTO probe VALUES (?, ?)').run(2, 'rolled-back');
      throw Error('rollback');
    })());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM probe').get().n, 1);
    db.close();
    db = new Database(path);
    assert.equal(db.prepare('SELECT value FROM probe WHERE id=1').get().value, 'synthetic-native-probe');
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.pragma('wal_checkpoint(TRUNCATE)');
    result.sqliteWalStrictTransactionReopenIntegrity = true;
  } finally {
    if (db?.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  }

  // Process tree: PID 1 should be Tini and no npm wrapper should be running or installed.
  const pid1 = readFileSync('/proc/1/cmdline', 'utf8').replaceAll('\0', ' ');
  const processes = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      // A process may exit between listing and reading; skip it.
      try {
        return [readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean)];
      } catch {
        return [];
      }
    });
  result.pid1Tini = /(?:^|\/)tini(?: |$)/.test(pid1);
  result.npmProcessPresent = processes.some((args) => args.some((arg) => /(?:^|\/)(?:npm|npm-cli\.js)$/.test(arg)));
  result.npmFilesPresent = ['/usr/local/bin/npm', '/usr/local/bin/npx', '/usr/local/lib/node_modules/npm']
    .some(existsSync);
  if (phase === 'candidate') {
    assert.equal(result.pid1Tini, true, 'candidate_pid1_tini');
    assert.equal(result.npmProcessPresent, false, 'candidate_npm_process_absent');
    assert.equal(result.npmFilesPresent, false, 'candidate_npm_files_absent');
    assert.equal(process.cwd(), `/app/src/${component}`, 'candidate_component_workdir');
  }
  const entry = `/app/src/${component}/dist/${component === 'console' ? 'server/index.js' : 'index.js'}`;
  assert.ok(existsSync(entry), 'shipped_absolute_entry_missing');
  result.absoluteCommandResolvable = true;
  result.dependencyVersions = Object.fromEntries(['multer', 'proxy-addr', 'brace-expansion'].map((name) => [
    name,
    JSON.parse(readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version,
  ]));
  if (phase === 'candidate') {
    assert.deepEqual(
      result.dependencyVersions,
      { multer: '2.4.0', 'proxy-addr': '2.0.8', 'brace-expansion': '1.1.21' },
    );
  }
  if (service === 'proxy') {
    const expand = requireImage('brace-expansion');
    assert.deepEqual(expand('fixture-{a,b}-{1..2}'), ['fixture-a-1', 'fixture-a-2', 'fixture-b-1', 'fixture-b-2']);
    const proxyAddress = requireImage('proxy-addr');
    // X-Forwarded-For is honoured only when the direct peer is a trusted (loopback) proxy.
    assert.equal(
      proxyAddress(
        { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.12' } },
        proxyAddress.compile('loopback'),
      ),
      '192.0.2.12',
    );
    assert.equal(
      proxyAddress(
        { socket: { remoteAddress: '192.0.2.10' }, headers: { 'x-forwarded-for': '192.0.2.12' } },
        proxyAddress.compile('loopback'),
      ),
      '192.0.2.10',
    );
    const express = requireImage('express');
    const multer = requireImage('multer');
    const app = express();
    app.post(
      '/upload',
      multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 } }).single('file'),
      (req, res) => res.json({ content: req.file?.buffer.toString('utf8') }),
    );
    app.use((error, req, res, next) => res.status(400).json({ code: error.code ?? 'INVALID_MULTIPART' }));
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const endpoint = `http://127.0.0.1:${server.address().port}/upload`;

      const valid = new FormData();
      valid.append('file', new Blob(['synthetic']), 'fixture.txt');
      const accepted = await fetch(endpoint, { method: 'POST', body: valid, signal: AbortSignal.timeout(3000) });
      assert.equal(accepted.status, 200);
      assert.equal((await accepted.json()).content, 'synthetic');

      const large = new FormData();
      large.append('file', new Blob(['x'.repeat(32)]), 'fixture.txt');
      const rejected = await fetch(endpoint, { method: 'POST', body: large, signal: AbortSignal.timeout(3000) });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).code, 'LIMIT_FILE_SIZE');

      const malformed = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: 'synthetic-invalid-boundary',
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(malformed.status, 400);
      await malformed.body?.cancel();

      result.dependencyFunctionalChecks = {
        braceExpansion: true,
        proxyAddressTrustedAndUntrusted: true,
        multipartValidMalformedAndSizeLimit: true,
      };
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }
  if (service === 'proxy' && phase === 'candidate') {
    // Old templates run `node src/proxy/dist/index.js` from the image WORKDIR. Running it here would
    // start a second Proxy against the shared database, so only check where the shim points.
    // The qualification runner starts the legacy command for real in a separate offline container.
    const shim = `/app/src/proxy/src/proxy/dist/index.js`;
    const target = readFileSync(shim, 'utf8').match(/^import '([^']+)';\s*$/)?.[1];
    assert.equal(target && join(shim, '..', target), entry, 'legacy_command_shim_target');
    result.legacyRootRelativeCommand = { shim, resolvesTo: entry };
  }

  // HTTP checks against the service's own port inside the container.
  // The container's own synthetic token (the MySQL and SQLite qualification environments use different ones).
  const auth = { 'X-Internal-Token': process.env.INTERNAL_API_TOKEN || 'mysql-fixture-internal-only' };
  async function get(path, headers = auth) {
    const port = { proxy: 3000, proxy2: 3000, console: 7004, sso: 7001, login: 7003 }[service];
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, 'runtime_http');
    return response;
  }
  const health = await (await get('/healthz')).json();
  // Multi-enterprise images may report their release line; r4 does not.
  result.releaseLine = typeof health.releaseLine === 'string' ? health.releaseLine : null;
  async function expectScopeRequired(path) {
    const port = { sso: 7001, login: 7003 }[service];
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: auth,
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 400, 'unscoped_management_status');
    assert.equal((await response.json()).error?.code, 'enterprise_scope_required', 'unscoped_management_code');
  }
  function hashTables(dbPath) {
    // Hash only fixture-generated logical table rows; never emit password hashes or tokens.
    // Rows are reported per table and column so an upgrade may add tables or columns while the
    // runner still proves every pre-existing value is unchanged.
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      return Object.fromEntries(tables.map(({ name }) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const columns = db
          .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
          .all(name)
          .map((column) => column.name);
        const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
        return [name, {
          columns,
          rows: rows.map((row) => Object.fromEntries(columns.map((column) => [column, hash(String(row[column]))]))),
        }];
      }));
    } finally {
      db.close();
    }
  }
  if (service === 'sso') {
    const xml = await (await get('/metadata')).text();
    assert.match(xml, /EntityDescriptor/);
    result.metadataSha256 = hash(xml);
    result.certSha256 = hash(readFileSync('/certs/idp-cert.pem'));
    const users = await (await get(`${managementPath('/users')}?page=1&pageSize=100`)).json();
    assert.equal(users.total, Number(ssoUsers), 'sso_users_survive');
    result.userCount = users.total;
    if (scoped) await expectScopeRequired('/api/users?page=1&pageSize=100');
    result.logicalTables = hashTables('/data/sso.sqlite');
  }
  if (service === 'console') {
    result.adminFileSha256 = hash(readFileSync('/data/admins.json'));
    const html = await (await get('/', {})).text();
    assert.match(html, /<div id="root">/);
    const asset = html.match(/src="([^" ]+\.js)"/);
    assert.ok(asset);
    assert.ok(asset[1].startsWith('/') && !asset[1].startsWith('//'));
    const response = await get(asset[1], {});
    assert.match(response.headers.get('content-type'), /javascript/);
    result.asset = { path: asset[1], sha256: hash(await response.text()) };
  }
  if (service === 'login') {
    const tasks = await (await get(`${managementPath('/tasks')}?page=1&pageSize=100`)).json();
    assert.equal(tasks.total, 0, 'real_login_must_remain_zero_tasks');
    if (scoped) await expectScopeRequired('/api/tasks?page=1&pageSize=100');
    result.logicalTables = hashTables('/data/login.sqlite');
    const unauthorized = await fetch(`http://127.0.0.1:7003${managementPath('/tasks')}`, {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();
    // Chromium must launch, but every network request is aborted: local HTML only.
    const { chromium } = requireImage('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      timeout: 60000,
    });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(
        '<!doctype html><html><head><title>qualification-local-only</title></head>'
        + '<body><p id="probe">synthetic chromium fixture</p></body></html>',
      );
      assert.equal(await page.title(), 'qualification-local-only');
      assert.equal(await page.locator('#probe').textContent(), 'synthetic chromium fixture');
      result.chromiumLocalHtml = true;
    } finally {
      await browser.close();
    }
    result.realLoginTasks = 0;
  }
  result.pass = true;
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({
    service,
    phase,
    pass: false,
    error: 'runtime_qualification_failed',
    code: typeof error?.code === 'string' ? error.code : null,
    check: error?.name === 'AssertionError' && /^[a-z0-9_]+$/.test(error.message) ? error.message : null,
  }));
  process.exitCode = 1;
}
