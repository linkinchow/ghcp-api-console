import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import type { MysqlStorage } from '../../src/proxy/src/db/mysqlStorage.js';
import type { MysqlPoolStore } from '../../src/proxy/src/userPool/mysqlStore.js';
import { WorkerMock } from './worker-mock.js';
import { bounded, childEnv, CLEANUP_MS, gate, options, siblingUrl, until, type Proof } from './login-network-common.js';

export class Process {
  readonly child: ChildProcess;
  readonly messages: Proof[] = [];
  readonly exit: Promise<void>;
  exited = false;
  code: number | null = null;
  signal: NodeJS.Signals | null = null;
  constructor(file: 'server' | 'worker', env: NodeJS.ProcessEnv, private readonly abort: AbortSignal) {
    gate(env); abort.throwIfAborted();
    this.child = fork(fileURLToPath(new URL(`./login-network-${file}.ts`, import.meta.url)), [], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), execArgv: ['--import', 'tsx'], env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child.on('message', message => {
      if (this.messages.length >= 10000) { this.child.kill('SIGKILL'); return; }
      this.messages.push(message as Proof);
    });
    this.exit = new Promise(resolve => {
      this.child.once('error', () => { this.messages.push({ kind: 'fatal', pid: 0 });
        if (!this.child.pid) { this.exited = true; this.code = 1; resolve(); } });
      this.child.once('exit', (code, signal) => { this.exited = true; this.code = code; this.signal = signal; resolve(); });
    });
  }
  healthy(): void {
    assert.equal(this.exited, false, 'Unexpected child exit');
    assert.equal(this.messages.some(message => message.kind === 'fatal'), false, 'Child failed; private details suppressed');
  }
  async message(kind: string, after = 0, ms = 12000): Promise<Proof> {
    return until(() => { this.healthy(); return this.messages.slice(after).find(message => message.kind === kind); },
      `process ${kind}`, this.abort, ms);
  }
  async command(kind: string, extra: Record<string, unknown> = {}): Promise<Proof> {
    this.healthy(); const id = randomUUID(); this.child.send({ kind, id, ...extra });
    return until(() => { this.healthy(); return this.messages.find(message => message.id === id); }, `IPC ${kind}`, this.abort);
  }
  async kill(): Promise<void> {
    if (!this.exited) this.child.kill('SIGKILL');
    await bounded(this.exit, 'OS process exit', 8000);
    assert.ok(this.exited, 'Actual exit, not child.killed');
  }
  async stop(): Promise<void> {
    // This terminal handshake differs from ordinary message(): a child may enqueue
    // its stopped acknowledgement and exit before our next polling observation.
    const stopped = () => {
      assert.equal(this.messages.some(message => message.kind === 'fatal'), false, 'Child failed during stop');
      const acknowledgement = this.messages.find(message => message.kind === 'stopped');
      if (this.exited) {
        assert.equal(this.code, 0, 'Graceful worker must exit zero');
        assert.equal(this.signal, null, 'Graceful worker must not be signal-terminated');
        assert.ok(acknowledgement, 'Child exited without stopped acknowledgement');
      }
      return acknowledgement;
    };
    try {
      if (!this.exited) this.child.send({ kind: 'stop' });
      await until(stopped, 'process stopped acknowledgement', this.abort);
      await bounded(this.exit, 'graceful worker exit', 8000);
      assert.equal(this.exited, true, 'Actual graceful exit observed');
      stopped(); // Reject nonzero/fatal exit even when the acknowledgement arrived first.
    } finally { if (!this.exited) await this.kill(); }
  }
}

export class Fixture {
  readonly sibling: ReturnType<typeof siblingUrl>;
  readonly children: Process[] = [];
  readonly upstream: WorkerMock;
  readonly sockets = new Set<Connection>();
  storage!: MysqlStorage;
  store!: MysqlPoolStore;
  pool?: Pool;
  admin?: Pool;
  private attemptedCreate = false;
  private mockStarted = false;
  private mockStarting?: Promise<void>;
  private cleaning?: Promise<void>;
  private closing = false;
  private interrupting = false;
  private readonly shutdown = new AbortController();
  readonly signal: AbortSignal;
  private readonly interrupt = () => {
    if (this.interrupting) return;
    this.interrupting = true;
    // Abort before cleanup so late initialization cannot create fresh resources.
    this.shutdown.abort(new Error('Fixture interrupted'));
    const deadline = setTimeout(() => {
      console.error(`Interrupted cleanup deadline; inspect only ${this.sibling.database}`);
      process.exit(1);
    }, CLEANUP_MS);
    void this.cleanup().then(() => {
      console.error(`Interrupted fixture cleaned ${this.sibling.database}`);
    }, () => {
      console.error(`Interrupted cleanup incomplete; inspect only ${this.sibling.database}`);
    }).finally(() => { clearTimeout(deadline); process.exit(1); });
  };
  constructor(signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.shutdown.signal]);
    this.sibling = siblingUrl(gate(process.env));
    assert.equal(process.env.DOTENV_CONFIG_PATH, process.platform === 'win32' ? 'NUL' : '/dev/null', 'Use the sanitized runner');
    for (const key of ['NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
      'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'DOTENV_CONFIG_OVERRIDE']) assert.equal(process.env[key], undefined);
    for (const key of ['SSO_BASE_URL', 'LOGIN_BASE_URL', 'COPILOT_API_BASE_URL']) {
      assert.equal(process.env[key], 'http://127.0.0.1:0', 'Use the sanitized runner');
    }
    signal.throwIfAborted(); this.upstream = new WorkerMock();
    process.on('SIGTERM', this.interrupt); process.on('SIGINT', this.interrupt);
  }
  async init(): Promise<void> {
    this.signal.throwIfAborted();
    const [{ createPool }, { MysqlStorage }] = await Promise.all([
      import('mysql2/promise'), import('../../src/proxy/src/db/mysqlStorage.js'),
    ]);
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
    this.admin = createPool({ uri: this.sibling.admin.toString(), connectionLimit: 1, queueLimit: 4, connectTimeout: 5000 });
    this.admin.on('connection', connection => this.sockets.add(connection));
    // Even an ambiguous CREATE timeout is cleaned up using exactly our random sibling.
    this.attemptedCreate = true;
    await bounded(this.admin.query({ sql: `CREATE DATABASE \`${this.sibling.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      timeout: 8000 }), 'CREATE sibling', 10000);
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
    this.pool = createPool({ uri: this.sibling.url.toString(), connectionLimit: 6, queueLimit: 16, connectTimeout: 5000,
      timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    this.pool.on('connection', connection => this.sockets.add(connection));
    this.storage = new MysqlStorage(this.pool, 2);
    await bounded(this.storage.initialize(), 'migrate isolated sibling', 25000);
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
    this.store = await bounded(this.storage.userPool(options), 'initialize pool store', 20000);
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
    this.mockStarting = this.upstream.start().then(() => { this.mockStarted = true; });
    await this.mockStarting;
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
  }
  process(file: 'server' | 'worker', login?: string): Process {
    this.signal.throwIfAborted(); assert.equal(this.closing, false);
    const child = new Process(file, childEnv(this.sibling.url, this.sibling.database,
      this.upstream.origin, login ?? this.upstream.origin), this.signal);
    this.children.push(child); return child;
  }
  async slots(): Promise<number> {
    const [rows] = await this.pool!.query<RowDataPacket[]>({ sql:
      "SELECT COUNT(*) n FROM user_pool_accounts WHERE stage IN ('oauth-dispatch','oauth-wait')", timeout: 5000 });
    return Number(rows[0].n);
  }
  async cleanup(): Promise<void> {
    this.closing = true;
    return this.cleaning ??= (async () => {
      const failures: string[] = [];
      const end = performance.now() + CLEANUP_MS;
      const attempt = async (label: string, fn: () => Promise<unknown>, ms: number) => {
        try { await bounded(fn(), label, Math.max(1, Math.min(ms, end - performance.now()))); }
        catch { failures.push(label); }
      };
      await attempt('kill child processes', () => Promise.all(this.children.map(child => child.kill())), 9000);
      if (this.mockStarting) await attempt('drain upstream bind', () => this.mockStarting!, 3000);
      if (this.mockStarted) await attempt('close synthetic upstream', () => this.upstream.close(), 3000);
      for (const socket of this.sockets) socket.destroy();
      if (this.pool) await attempt('close fixture pool', () => this.pool!.end(), 3000);
      // Never DROP with live workers; ownership leases are not rewritten to hurry cleanup.
      if (this.attemptedCreate && this.children.every(child => child.exited) && this.admin) {
        await attempt('DROP sibling', () => this.admin!.query({ sql: `DROP DATABASE IF EXISTS \`${this.sibling.database}\``, timeout: 8000 }), 9000);
      } else if (this.attemptedCreate) failures.push('DROP refused: unconfirmed child exit');
      for (const socket of this.sockets) socket.destroy();
      if (this.admin) await attempt('close admin', () => this.admin!.end(), 3000);
      if (failures.length) throw new Error(`Cleanup incomplete: ${failures.join(', ')}; inspect only ${this.sibling.database}`);
    })().finally(() => {
      process.removeListener('SIGTERM', this.interrupt); process.removeListener('SIGINT', this.interrupt);
    });
  }
}
