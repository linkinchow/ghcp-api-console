import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoginTaskDto, SsoUserDto } from '@ghcp/shared';
import type { ProxyAccountRecord } from '../db/storageTypes.js';
import { CopilotApiError, CopilotModelPathError, type CopilotApiPath } from '../copilot/copilotClient.js';
import type { PoolConfig } from './config.js';
import {
  ProvisionFailure,
  realProvisioner,
  type ProvisionContext,
  type ProvisionInventory,
  type ProvisionPatch,
} from './provisioner.js';

const options: PoolConfig = {
  enabled: true, accountDomain: 'pool.example.test', idleTarget: 2, maxAccounts: 10,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 10000, retryAfterSeconds: 30,
  warmupModel: 'test-warmup-model', requestTimeoutMs: 1000,
};
const createdAt = '2026-01-01T00:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fixture(stage = 'new') {
  let row: ProvisionInventory = {
    identity: 'alex001', ordinal: 0, state: 'provisioning', stage, attempt_id: 'worker-attempt',
    task_id: null, attempts: 0, retry_at: 0, last_error: null, updated_at: Date.now(),
    cooldown_until: 0, verified_at: null, generation: 0,
    sso_created_at: stage === 'new' ? null : createdAt,
    oauth_attempt_id: ['oauth-starting', 'oauth-dispatch', 'oauth-wait', 'warmup'].includes(stage) ? 'oauth-attempt' : null,
  };
  let user: SsoUserDto | undefined = stage === 'new' ? undefined : {
    ssoUser: row.identity, email: `${row.identity}@${options.accountDomain}`, role: 'user',
    emuStatus: 'active', copilotSeatStatus: 'assigned', ghLogin: 'alex001_emu', ghScimId: 'scim-1',
    createdAt, updatedAt: createdAt,
  };
  let account: ProxyAccountRecord = {
    identity: row.identity, ssoUser: row.identity, ghLogin: user?.ghLogin,
    copilotOauthStatus: stage === 'warmup' ? 'valid' : 'missing',
    copilotOauthToken: stage === 'warmup' ? 'test-oauth-token' : undefined,
    createdAt, updatedAt: createdAt,
  };
  const tasks: LoginTaskDto[] = [];
  const checkpoints: ProvisionPatch[] = [];
  const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let begins = 0;
  let warms = 0;
  let invalidations = 0;
  let failure: ((path: string, method: string) => Response | Promise<Response> | undefined) | undefined;
  let warmResponse = () => json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
  let modelRequest: unknown;
  let modelError: Error | undefined;
  let supportedPath: CopilotApiPath = '/v1/messages';
  let warmPath: string | undefined;
  let warmBody: Record<string, unknown> | undefined;
  let fenced = false;
  const controller = new AbortController();
  const context: ProvisionContext = {
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
      if (fenced) throw new ProvisionFailure('provision_fenced');
    },
    pinCredentials() { this.assertCurrent(); },
    checkpoint(patch) {
      this.assertCurrent();
      checkpoints.push({ ...patch });
      row = { ...row, ...patch };
      return { ...row };
    },
  };
  const fetchMock: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ path, method, body });
    assert.ok(init?.signal);
    assert.equal(init?.redirect, 'error');
    const result = failure?.(path, method);
    if (result) return result;
    if (path === `/api/users/${row.identity}` && method === 'GET') return user ? json(user) : json({}, 404);
    if (path === '/api/users' && method === 'POST') {
      assert.equal(row.stage, 'sso-creating');
      assert.equal(body?.email, `${row.identity}@${options.accountDomain}`);
      user = {
        ssoUser: row.identity, email: String(body.email), role: 'user', emuStatus: 'not_synced',
        copilotSeatStatus: 'unassigned', createdAt, updatedAt: createdAt,
      };
      return json(user, 201);
    }
    if (path === '/api/users/batch') {
      assert.equal(row.stage, 'scim-syncing');
      assert.deepEqual(body, { operation: 'sync_emu', ssoUsers: [row.identity], assignCopilotSeat: false, createOnly: true });
      user = { ...user!, ghLogin: 'alex001_emu', ghScimId: 'scim-1', emuStatus: 'active' };
      return json({ rows: [{ ssoUser: row.identity, status: 'success', user }] });
    }
    if (path.endsWith('/copilot-seat')) {
      assert.equal(row.stage, 'seat-assigning');
      user!.copilotSeatStatus = 'assigned';
      return json(user);
    }
    if (path === `/api/users/${row.identity}/login-credentials`) {
      assert.deepEqual(body, { expectedCreatedAt: row.sso_created_at, expectedEmail: `${row.identity}@${options.accountDomain}` });
      return json({ user, passwordForLogin: 'test-only-password' });
    }
    if (path === '/api/tasks' && method === 'POST') {
      assert.equal(row.stage, 'oauth-dispatch');
      assert.equal(body?.oauthAttemptId, row.oauth_attempt_id);
      assert.equal(body?.ssoPassword, 'test-only-password');
      const task = makeTask({ oauthAttemptId: String(body.oauthAttemptId) });
      tasks.push(task);
      return json(task, 202);
    }
    if (path === '/api/tasks' && method === 'GET') return json({ items: tasks, total: tasks.length, page: 1, pageSize: 100 });
    if (path.startsWith('/api/tasks/')) return json(tasks.find((task) => path.endsWith(task.id)), tasks.length ? 200 : 404);
    assert.fail(`Unexpected mock request ${method} ${path}`);
  };
  const adapter = realProvisioner({ now: () => Date.now() }, options, {
    fetch: fetchMock,
    getAccount: async () => ({ ...account }),
    createAccount: async (input) => { account = { ...account, ...input }; return { ...account }; },
    beginAuthorization: async (_identity, attempt) => {
      begins++;
      account.copilotOauthAttemptId = attempt;
      account.copilotOauthStatus = 'refreshing';
      return true;
    },
    invalidateToken: async () => { invalidations++; return true; },
    resolveModel: async (_auth, path, model, _diagnostics, signal) => {
      if (modelError) throw modelError;
      if (path !== supportedPath) throw new CopilotModelPathError('unsupported warmup path');
      assert.equal(model, options.warmupModel);
      assert.ok(signal);
      modelRequest = model;
      return { requestedId: model, canonicalId: model, upstreamId: 'upstream-test-model', model: { id: model }, supportedPaths: ['/v1/messages'] };
    },
    executeRequest: async (request, signal) => {
      assert.ok(signal);
      warms++;
      warmBody = JSON.parse(request.body!) as Record<string, unknown>;
      warmPath = new URL(request.url).pathname;
      return warmResponse();
    },
  });
  const advance = async () => { const patch = await adapter.step({ ...row }, context); await context.checkpoint(patch); return patch; };
  return {
    adapter, context, controller, advance, requests, checkpoints, tasks,
    row: () => row, user: () => user!, account: () => account,
    patch: (patch: ProvisionPatch) => { row = { ...row, ...patch }; },
    changeUser: (patch: Partial<SsoUserDto>) => { user = { ...user!, ...patch }; },
    changeAccount: (patch: Partial<ProxyAccountRecord>) => { account = { ...account, ...patch }; },
    fail: (fn: NonNullable<typeof failure>) => { failure = fn; },
    warmResponse: (fn: typeof warmResponse) => { warmResponse = fn; },
    fence: () => { fenced = true; },
    begins: () => begins, warms: () => warms, invalidations: () => invalidations,
    warmBody: () => warmBody, modelRequest: () => modelRequest, warmPath: () => warmPath,
    supportedPath: (path: CopilotApiPath) => { supportedPath = path; },
    modelError: (error: Error) => { modelError = error; },
  };
}

function makeTask(patch: Partial<LoginTaskDto> = {}): LoginTaskDto {
  return {
    id: 'task-1', identity: 'alex001', ssoUser: 'alex001', ghLogin: 'alex001_emu', oauthAttemptId: 'oauth-attempt',
    ssoType: 'custom', status: 'pending', attempts: 1, createdAt: new Date().toISOString(), ...patch,
  };
}

async function rejectsCode(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, (error: unknown) => error instanceof ProvisionFailure && error.code === code);
}

test('complete prewarm persists each stage and requires paid seat, Login success, and real configured model output', async () => {
  const f = fixture();
  for (const stage of ['sso-created', 'scim-synced', 'synced', 'oauth-starting', 'oauth-wait']) {
    await f.advance();
    assert.equal(f.row().stage, stage);
    assert.equal(f.row().state, 'provisioning');
    assert.equal(f.row().verified_at, null);
  }
  assert.equal(f.begins(), 1);
  assert.equal(f.row().attempt_id, 'worker-attempt');
  assert.notEqual(f.row().oauth_attempt_id, 'worker-attempt');
  assert.ok(f.row().task_id);
  // A token alone, including a stale valid one, cannot bypass the Login task result.
  f.changeAccount({ copilotOauthStatus: 'valid', copilotOauthToken: 'test-only-token', copilotOauthAttemptId: undefined });
  await f.advance();
  assert.equal(f.row().stage, 'oauth-wait');
  f.tasks[0]!.status = 'success';
  await f.advance();
  assert.equal(f.row().stage, 'warmup');
  assert.equal(f.row().state, 'provisioning');
  await f.advance();
  assert.equal(f.row().state, 'ready');
  assert.ok(f.row().verified_at);
  assert.equal(f.warms(), 1);
  assert.equal(f.modelRequest(), options.warmupModel);
  assert.deepEqual(f.warmBody(), {
    model: 'upstream-test-model', max_tokens: 16, stream: false, messages: [{ role: 'user', content: 'Reply OK' }],
  });
  const persisted = JSON.stringify(f.checkpoints);
  assert.equal(persisted.includes('test-only-password'), false);
  assert.equal(persisted.includes('test-only-token'), false);
});

test('warmup supports chat and Responses models from live capabilities without a model whitelist', async () => {
  for (const path of ['/chat/completions', '/responses'] as const) {
    const f = fixture('warmup');
    f.supportedPath(path);
    f.warmResponse(() => json(path === '/responses'
      ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] }
      : { choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
    await f.advance();
    assert.equal(f.row().state, 'ready');
    assert.equal(f.warmPath(), path);
    assert.equal(f.warms(), 1);
    if (path === '/responses') assert.equal(f.warmBody()?.input, 'Reply OK');
    else assert.ok(f.warmBody()?.messages);
  }
});

test('never adopts an existing same-name SSO user, even with the expected email', async () => {
  const f = fixture('sso-created');
  f.patch({ stage: 'new' });
  await rejectsCode(f.advance(), 'sso_name_conflict');
  assert.equal(f.requests.some((request) => request.method === 'POST'), false);
});

test('uncertain SSO create is persisted and never replayed or adopted on restart', async () => {
  const f = fixture();
  f.fail((path, method) => {
    if (path === '/api/users' && method === 'POST') throw new Error('secret-password in a disconnected response');
    return undefined;
  });
  await rejectsCode(f.advance(), 'sso_creation_ambiguous');
  assert.equal(f.row().stage, 'sso-creating');
  const count = f.requests.length;
  await rejectsCode(f.advance(), 'sso_creation_ambiguous');
  assert.equal(f.requests.length, count);
});

test('owned SSO creation marker rejects a deleted/recreated or renamed account before mutation', async () => {
  for (const patch of [
    { createdAt: '2026-02-01T00:00:00.000Z' }, { email: 'unrelated@example.test' }, { role: 'admin' as const },
  ]) {
    const f = fixture('sso-created');
    f.changeUser(patch);
    await rejectsCode(f.advance(), 'sso_identity_changed');
    assert.equal(f.requests.filter((request) => request.method === 'POST').length, 0);
  }
});

test('SCIM and seat mutation intentions recover by reading their results, never replaying uncertain writes', async () => {
  const f = fixture('sso-created');
  f.changeUser({ emuStatus: 'not_synced', ghLogin: undefined, ghScimId: undefined, copilotSeatStatus: 'unassigned' });
  f.fail((path) => path === '/api/users/batch' ? json({ error: { message: 'secret' } }, 503) : undefined);
  await rejectsCode(f.advance(), 'sso_http_503');
  assert.equal(f.row().stage, 'scim-syncing');
  await rejectsCode(f.advance(), 'scim_sync_unconfirmed');
  assert.equal(f.requests.filter((request) => request.path === '/api/users/batch').length, 1);
  f.changeUser({ emuStatus: 'active', ghLogin: 'alex001_emu', ghScimId: 'scim-1' });
  await f.advance();
  assert.equal(f.row().stage, 'scim-synced');
  f.fail((path) => path.endsWith('/copilot-seat') ? json({}, 503) : undefined);
  await rejectsCode(f.advance(), 'sso_http_503');
  assert.equal(f.row().stage, 'seat-assigning');
  await rejectsCode(f.advance(), 'seat_assignment_unconfirmed');
  assert.equal(f.requests.filter((request) => request.path.endsWith('/copilot-seat')).length, 1);
  f.changeUser({ copilotSeatStatus: 'assigned' });
  await f.advance();
  assert.equal(f.row().stage, 'synced');
});

test('SCIM success without paid Copilot entitlement never starts OAuth or marks ready', async () => {
  const f = fixture('scim-synced');
  f.changeUser({ copilotSeatStatus: 'unassigned' });
  f.fail((path) => path.endsWith('/copilot-seat') ? json(f.user()) : undefined);
  await rejectsCode(f.advance(), 'entitlement_not_ready');
  assert.equal(f.begins(), 0);
  assert.equal(f.warms(), 0);
  assert.equal(f.row().state, 'provisioning');
});

test('OAuth starting resumes the same attempt and does not reset an already refreshing account', async () => {
  const f = fixture('oauth-starting');
  f.changeAccount({ copilotOauthStatus: 'refreshing', copilotOauthAttemptId: 'oauth-attempt' });
  await f.advance();
  assert.equal(f.row().oauth_attempt_id, 'oauth-attempt');
  assert.equal(f.begins(), 0);
  assert.equal(f.tasks.length, 1);
});

test('Login dispatch ambiguity recovers exact attempt ID without duplicate POSTs', async () => {
  const f = fixture('oauth-starting');
  f.fail((path, method) => {
    if (path === '/api/tasks' && method === 'POST') {
      f.tasks.push(makeTask());
      throw new Error('connection closed after acceptance');
    }
    return undefined;
  });
  await assert.rejects(f.advance());
  assert.equal(f.row().stage, 'oauth-dispatch');
  // Operator retry changes only the worker nonce; task recovery retains its OAuth nonce.
  f.patch({ attempt_id: 'new-worker-attempt' });
  await f.advance();
  assert.equal(f.row().stage, 'oauth-wait');
  assert.equal(f.row().task_id, 'task-1');
  assert.equal(f.requests.filter((request) => request.path === '/api/tasks' && request.method === 'POST').length, 1);
  assert.equal(f.begins(), 1);
});

test('missing, unrelated, duplicated, or wrong-user Login tasks cannot be adopted or redispatched', async () => {
  const missing = fixture('oauth-dispatch');
  missing.tasks.push(makeTask({ oauthAttemptId: 'unrelated-attempt' }));
  await rejectsCode(missing.advance(), 'oauth_dispatch_unconfirmed');
  await rejectsCode(missing.advance(), 'oauth_dispatch_unconfirmed');
  assert.equal(missing.requests.some((request) => request.method === 'POST'), false);
  const duplicate = fixture('oauth-dispatch');
  duplicate.tasks.push(makeTask(), makeTask({ id: 'duplicate-task' }));
  await rejectsCode(duplicate.advance(), 'oauth_dispatch_ambiguous');
  const mismatch = fixture('oauth-wait');
  mismatch.patch({ task_id: 'task-1' });
  mismatch.tasks.push(makeTask({ ssoUser: 'unrelated' }));
  await rejectsCode(mismatch.advance(), 'oauth_task_mismatch');
});

test('task search handles pagination and has a bounded page limit', async () => {
  const f = fixture('oauth-dispatch');
  let pages = 0;
  f.fail((path) => {
    if (path === '/api/tasks') {
      pages++;
      return json({ items: pages === 2 ? [makeTask()] : [], total: 150 });
    }
    return undefined;
  });
  await f.advance();
  assert.equal(pages, 2);
  assert.equal(f.row().task_id, 'task-1');
  const bounded = fixture('oauth-dispatch');
  bounded.fail((path) => path === '/api/tasks' ? json({ items: [], total: 1001 }) : undefined);
  await rejectsCode(bounded.advance(), 'oauth_task_search_limit');
  assert.equal(bounded.requests.filter((request) => request.path === '/api/tasks').length, 10);
});

test('failed Login retries use a new OAuth nonce, stalled tasks never dispatch concurrent replacements', async () => {
  const failed = fixture('oauth-wait');
  failed.patch({ task_id: 'task-1' });
  failed.tasks.push(makeTask({ status: 'failed', failureReason: 'sensitive task log' }));
  await rejectsCode(failed.advance(), 'oauth_login_failed');
  assert.equal(failed.row().stage, 'synced');
  await failed.advance();
  assert.notEqual(failed.row().oauth_attempt_id, 'oauth-attempt');
  const stalled = fixture('oauth-wait');
  stalled.patch({ task_id: 'task-1' });
  stalled.tasks.push(makeTask({ status: 'running', createdAt }));
  await rejectsCode(stalled.advance(), 'oauth_task_stalled');
  assert.equal(stalled.row().stage, 'oauth-wait');
  assert.equal(stalled.requests.some((request) => request.method === 'POST'), false);
});

test('cancelled Login may still be running and never dispatches a concurrent replacement', async () => {
  const f = fixture('oauth-wait');
  f.patch({ task_id: 'task-1' });
  f.tasks.push(makeTask({ status: 'cancelled' }));
  for (let i = 0; i < 3; i++) await rejectsCode(f.advance(), 'oauth_task_cancelled_unconfirmed');
  assert.equal(f.row().stage, 'oauth-wait');
  assert.equal(f.row().oauth_attempt_id, 'oauth-attempt');
  assert.equal(f.requests.some(request => request.method === 'POST'), false);
});

test('Login task success without its persisted callback cannot advance to warmup', async () => {
  const f = fixture('oauth-wait');
  f.patch({ task_id: 'task-1' });
  f.tasks.push(makeTask({ status: 'success' }));
  await rejectsCode(f.advance(), 'oauth_callback_unconfirmed');
  assert.equal(f.row().stage, 'oauth-wait');
  assert.equal(f.warms(), 0);
});

test('model catalog 401 schedules a fresh OAuth stage instead of retrying invalid credentials', async () => {
  const f = fixture('warmup');
  f.modelError(new CopilotApiError('Unauthorized catalog', 401));
  await rejectsCode(f.advance(), 'warmup_http_401');
  assert.equal(f.row().stage, 'synced');
  assert.equal(f.row().task_id, null);
  assert.equal(f.row().oauth_attempt_id, null);
  assert.equal(f.invalidations(), 1);
  assert.equal(f.warms(), 0);
});

test('warmup rejects HTTP failures, malformed/empty responses and credential changes', async () => {
  for (const [response, code] of [
    [() => json({}, 401), 'warmup_http_401'],
    [() => json({}, 429), 'warmup_http_429'],
    [() => json({ error: 'secret' }), 'warmup_invalid_response'],
    [() => json({ type: 'message', role: 'assistant', content: [] }), 'warmup_invalid_response'],
    [() => new Response('not JSON'), 'service_invalid_json'],
  ] as const) {
    const f = fixture('warmup');
    f.warmResponse(response);
    await rejectsCode(f.advance(), code);
    assert.equal(f.row().state, 'provisioning');
    assert.equal(f.row().verified_at, null);
    assert.equal(f.invalidations(), code === 'warmup_http_401' ? 1 : 0);
    if (code === 'warmup_http_401') assert.equal(f.row().stage, 'synced');
  }
  const changed = fixture('warmup');
  changed.warmResponse(() => {
    changed.changeAccount({ copilotOauthToken: 'replacement-token' });
    return json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }] });
  });
  await rejectsCode(changed.advance(), 'warmup_credential_changed');
});

test('warmup entitlement and credential gates run before the model request', async () => {
  const seat = fixture('warmup');
  seat.changeUser({ copilotSeatStatus: 'unassigned' });
  await rejectsCode(seat.advance(), 'entitlement_not_ready');
  assert.equal(seat.warms(), 0);
  const credential = fixture('warmup');
  credential.changeAccount({ copilotOauthStatus: 'expired' });
  await rejectsCode(credential.advance(), 'credential_not_valid');
  assert.equal(credential.row().stage, 'synced');
  assert.equal(credential.warms(), 0);
});

test('fencing between external calls blocks subsequent side effects', async () => {
  const f = fixture('oauth-starting');
  f.fail((path) => {
    if (path.endsWith('/login-credentials')) {
      f.fence();
      return json({ user: f.user(), passwordForLogin: 'test-only-password' });
    }
    return undefined;
  });
  await rejectsCode(f.advance(), 'provision_fenced');
  assert.equal(f.begins(), 0);
  assert.equal(f.requests.some((request) => request.path === '/api/tasks'), false);
});

test('step deadline aborts an external request and never records a successful checkpoint', async () => {
  const f = fixture('sso-created');
  let observed: AbortSignal | undefined;
  const adapter = realProvisioner({ now: () => Date.now() }, { ...options, requestTimeoutMs: 15 }, {
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      observed = init!.signal as AbortSignal;
      observed.addEventListener('abort', () => reject(observed!.reason), { once: true });
    }),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(adapter.step(f.row(), f.context));
    assert.equal(observed?.aborted, true);
    assert.equal(f.row().state, 'provisioning');
    assert.equal(f.checkpoints.length, 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('async context assertions and checkpoints finish before any external side effect', async () => {
  const f = fixture('oauth-starting');
  const asserted = f.context.assertCurrent.bind(f.context);
  f.context.assertCurrent = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await asserted();
  };
  const checkpoint = f.context.checkpoint.bind(f.context);
  f.context.checkpoint = async patch => {
    await new Promise<void>(resolve => setImmediate(resolve));
    return checkpoint(patch);
  };
  await f.advance();
  assert.equal(f.row().stage, 'oauth-wait');
  assert.equal(f.tasks.length, 1, 'mock POST asserts the intent was already persisted');

  const fenced = fixture();
  fenced.context.assertCurrent = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    throw new ProvisionFailure('provision_fenced');
  };
  await rejectsCode(fenced.advance(), 'provision_fenced');
  assert.equal(fenced.requests.length, 0);
});

test('async credential pin is awaited before warmup account and model work', async () => {
  const f = fixture('warmup');
  f.context.pinCredentials = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    throw new ProvisionFailure('provision_fenced');
  };
  await rejectsCode(f.advance(), 'provision_fenced');
  assert.equal(f.modelRequest(), undefined);
  assert.equal(f.warms(), 0);
});

test('atomic context handles link, authorization and both 401 invalidations without legacy mutations', async () => {
  for (const stage of ['scim-synced', 'oauth-starting', 'warmup', 'warmup-catalog']) {
    const f = fixture(stage === 'warmup-catalog' ? 'warmup' : stage);
    const mutations: unknown[] = [];
    f.context.claimLoginDispatch = async () => f.context.checkpoint({ stage: 'oauth-dispatch' });
    f.context.mutateCredentials = async mutation => {
      await new Promise<void>(resolve => setImmediate(resolve));
      mutations.push(mutation);
      return true;
    };
    if (stage === 'warmup') f.warmResponse(() => json({}, 401));
    if (stage === 'warmup-catalog') f.modelError(new CopilotApiError('synthetic unauthorized', 401));
    if (stage.startsWith('warmup')) {
      await rejectsCode(f.advance(), 'warmup_http_401');
      assert.equal(f.row().stage, 'synced');
      assert.deepEqual(mutations, [{ type: 'invalidate', expectedToken: 'test-oauth-token' }]);
    } else {
      await f.advance();
      assert.deepEqual(mutations, [stage === 'scim-synced'
        ? { type: 'link', ghLogin: 'alex001_emu' } : { type: 'begin', oauthAttemptId: 'oauth-attempt' }]);
    }
    assert.equal(f.begins(), 0);
    assert.equal(f.invalidations(), 0);
  }
});

test('rejected atomic mutation fences dispatch rather than falling back to a repository write', async () => {
  const f = fixture('oauth-starting');
  f.context.mutateCredentials = async () => false;
  await rejectsCode(f.advance(), 'provision_fenced');
  assert.equal(f.begins(), 0);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.row().stage, 'oauth-starting');
});

test('production adapter requires atomic mutation context before any network access', async () => {
  const f = fixture();
  const production = realProvisioner({ now: async () => Date.now() }, options);
  await rejectsCode(production.step(f.row(), f.context), 'provision_storage_incompatible');
  assert.equal(f.checkpoints.length, 0);
});

test('task age validation uses awaited database time', async () => {
  const f = fixture('oauth-wait');
  f.patch({ task_id: 'task-1' });
  const task = makeTask({ createdAt, status: 'running' });
  const adapter = realProvisioner({ now: async () => Date.parse(createdAt) + 15 * 60 * 1000 }, options, {
    fetch: async input => String(input).includes('/api/tasks/') ? json(task) : json(f.user()),
  });
  await rejectsCode(adapter.step(f.row(), f.context), 'oauth_task_stalled');
});

test('aborting a response body bounds stop and oversized responses are rejected', async () => {
  const f = fixture('warmup');
  let cancelled = false;
  f.warmResponse(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const running = f.advance();
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.controller.abort();
  await assert.rejects(running);
  assert.equal(cancelled, true);
  const large = fixture('warmup');
  large.warmResponse(() => new Response('x'.repeat(1024 * 1024 + 1)));
  await rejectsCode(large.advance(), 'service_response_too_large');
});
