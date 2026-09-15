import assert from 'node:assert/strict';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CREATED_AT, INTERNAL_TOKEN, OAUTH_TOKEN, PASSWORD, options } from './worker-common.js';

export interface Task {
  id: string; identity: string; ssoUser: string; ghLogin: string; oauthAttemptId: string;
  ssoType: 'custom'; status: 'running' | 'success'; createdAt: string;
}
interface RequestProof { method: string; path: string; query: string; taskId?: string; nonce?: string }

/** Lives in the parent, outside both workers. No public control API. No deduplication. */
export class WorkerMock {
  identity = '';
  taskAgeMs = 0;
  taskPosts = 0;
  taskGets = 0;
  warmups = 0;
  modelGets = 0;
  tasks: Task[] = [];
  requests: RequestProof[] = [];
  errors: string[] = [];
  private held?: { res: ServerResponse; task: Task };
  private holdNext = false;
  private server = createServer((req, res) => {
    void this.handle(req, res).catch(() => { this.errors.push('fixture_request_failed'); this.json(res, 500, {}); });
  });

  get origin(): string {
    const address = this.server.address();
    assert.ok(address && typeof address !== 'string', 'Mock must be listening');
    return `http://127.0.0.1:${address.port}`;
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
  }
  async close(): Promise<void> {
    this.releaseTaskGet();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  reset(identity: string, taskAgeMs: number): void {
    assert.equal(this.held, undefined);
    this.identity = identity; this.taskAgeMs = taskAgeMs; this.taskPosts = 0; this.taskGets = 0;
    this.warmups = 0; this.modelGets = 0; this.tasks = []; this.requests = []; this.errors = [];
    this.holdNext = false;
  }
  holdTaskGet(): void { assert.equal(this.held, undefined); this.holdNext = true; }
  get taskGetHeld(): boolean { return Boolean(this.held); }
  releaseTaskGet(holdFollowing = false): void {
    const held = this.held;
    this.held = undefined;
    this.holdNext = holdFollowing;
    if (held) this.json(held.res, 200, held.task);
  }
  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      assert.ok(size <= 16384);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  }
  private user() {
    return { ssoUser: this.identity, email: `${this.identity}@${options.accountDomain}`, role: 'user',
      createdAt: CREATED_AT, emuStatus: 'active', ghLogin: `${this.identity}_synthetic`,
      ghScimId: 'synthetic-scim', copilotSeatStatus: 'assigned' };
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, this.origin);
    const proof: RequestProof = { method: req.method!, path: url.pathname, query: url.search };
    this.requests.push(proof);
    assert.ok(this.requests.length <= 5000, 'Bounded request ledger');
    if (url.pathname.startsWith('/api/')) assert.equal(req.headers['x-internal-token'], INTERNAL_TOKEN);
    else assert.equal(req.headers.authorization, `Bearer ${OAUTH_TOKEN}`);
    const userPath = `/api/users/${encodeURIComponent(this.identity)}`;
    if (req.method === 'GET' && url.pathname === userPath) return this.json(res, 200, this.user());
    if (req.method === 'POST' && url.pathname === `${userPath}/login-credentials`) {
      const body = await this.body(req);
      assert.equal(body.expectedCreatedAt, CREATED_AT);
      assert.equal(body.expectedEmail, this.user().email);
      return this.json(res, 200, { user: this.user(), passwordForLogin: PASSWORD });
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await this.body(req);
      assert.equal(body.identity, this.identity);
      assert.equal(body.ssoUser, this.identity);
      assert.equal(body.ghLogin, this.user().ghLogin);
      assert.equal(body.ssoPassword, PASSWORD);
      assert.equal(body.ssoType, 'custom');
      assert.match(String(body.oauthAttemptId), /^[a-f0-9-]{36}$/);
      const task: Task = { id: randomUUID(), identity: this.identity, ssoUser: this.identity,
        ghLogin: this.user().ghLogin, oauthAttemptId: String(body.oauthAttemptId), ssoType: 'custom',
        status: 'running', createdAt: new Date(Date.now() - this.taskAgeMs).toISOString() };
      this.tasks.push(task); this.taskPosts++;
      proof.nonce = task.oauthAttemptId; proof.taskId = task.id;
      return this.json(res, 202, task);
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      assert.equal(url.searchParams.get('q'), this.identity);
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('pageSize'), '100');
      return this.json(res, 200, { items: this.tasks, total: this.tasks.length, page: 1, pageSize: 100 });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
      const task = this.tasks.find(task => url.pathname === `/api/tasks/${task.id}`);
      assert.ok(task);
      proof.taskId = task.id; proof.nonce = task.oauthAttemptId;
      this.taskGets++;
      if (this.holdNext) { this.holdNext = false; this.held = { res, task: { ...task } }; return; }
      return this.json(res, 200, task);
    }
    if (req.method === 'GET' && url.pathname === '/models') {
      this.modelGets++;
      return this.json(res, 200, { data: [{ id: options.warmupModel, capabilities: {
        type: 'chat', endpoints: ['/v1/messages'],
      } }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const body = await this.body(req);
      assert.equal(body.model, options.warmupModel);
      assert.equal(body.stream, false);
      this.warmups++;
      return this.json(res, 200, { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
    }
    this.errors.push('unexpected_route');
    this.json(res, 404, {});
  }
}
