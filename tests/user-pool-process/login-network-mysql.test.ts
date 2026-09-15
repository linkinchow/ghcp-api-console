import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { enabled, CREATED_AT, OAUTH_TOKEN, options, pause, SUITE_MS, until, type Proof, type Task } from './login-network-common.js';
import { Fixture, type Process } from './login-network-harness.js';
import type { Inventory } from '../../src/proxy/src/userPool/store.js';

const selected = enabled(process.env); // Before dynamic imports, DB, processes or listeners.
const slotIdentity = (row: Inventory) => ({ attempt: row.attempt_id, nonce: row.oauth_attempt_id, taskId: row.task_id });
const taskPosts = (children: Process[]) => children.flatMap(child => child.messages)
  .filter(message => message.kind === 'http' && message.method === 'POST' && message.path === '/api/tasks').length;

async function seed(f: Fixture): Promise<Inventory> {
  const row = await f.store.reserve(); assert.ok(row);
  await f.storage.createAccount({ identity: row.identity, ssoUser: row.identity, ghLogin: `${row.identity}_synthetic` });
  assert.equal(await f.store.update(row.identity, { stage: 'synced', sso_created_at: CREATED_AT }), true);
  return (await f.store.inventory(row.identity))!;
}
async function startWorker(f: Fixture, login: string): Promise<Process> {
  const worker = f.process('worker', login);
  const started = await worker.message('started');
  assert.equal(started.pid, worker.child.pid); assert.notEqual(started.pid, process.pid);
  assert.equal(started.snapshot!.requestTimeoutMs, 120000);
  assert.equal(started.snapshot!.state, 'owner'); return worker;
}
async function startLogin(f: Fixture, extra: Record<string, unknown> = {}): Promise<{ server: Process; origin: string }> {
  const server = f.process('server'); server.child.send({ kind: 'init', port: 0, ...extra });
  const listening = await server.message('listening'); assert.equal(listening.pid, server.child.pid);
  assert.notEqual(listening.pid, process.pid); return { server, origin: listening.origin! };
}
async function unchanged(f: Fixture, identity: string, expected: Inventory, servers: Process[], posts: number): Promise<void> {
  assert.deepEqual(await f.store.inventory(identity), expected);
  assert.equal(await f.slots(), 1); assert.equal(taskPosts(servers), posts);
}
async function finish(f: Fixture, identity: string, task: Task, server: Process, login: string, worker: Process) {
  // Repository nonce fence only, not the real Login callback HTTP route.
  const before = (await f.store.inventory(identity))!;
  const account = await f.storage.getAccount(identity);
  assert.equal(await f.storage.saveCopilotOauthToken(identity, randomUUID(), OAUTH_TOKEN, task.ghLogin), undefined);
  assert.deepEqual(await f.storage.getAccount(identity), account);
  assert.ok(await f.storage.saveCopilotOauthToken(identity, task.oauthAttemptId, OAUTH_TOKEN, task.ghLogin));
  await server.command('success', { taskId: task.id });
  const released = await until(async () => {
    const row = (await f.store.inventory(identity))!;
    return row.stage === 'warmup' && row.oauth_attempt_id === null ? row : undefined;
  }, 'read-only success releases capacity', f.signal);
  assert.equal(released.state, 'failed'); assert.equal(released.attempts, 3);
  assert.equal(released.last_error, before.last_error); assert.equal(released.retry_at, before.retry_at);
  assert.equal(released.attempt_id, before.attempt_id); assert.equal(released.task_id, null);
  assert.equal(released.generation, before.generation + 2, 'Callback fence plus read-only capacity release');
  assert.equal(await f.slots(), 0);
  const warmups = f.upstream.warmups;
  for (let cycle = 0; cycle < 3; cycle++) {
    await pause(options.pollMs);
    assert.deepEqual(await f.store.inventory(identity), released);
    assert.equal(f.upstream.warmups, warmups, 'No implicit retry or warmup of failed operator state');
  }
  await worker.stop();
  f.upstream.reset(identity, 0);
  await f.store.retry(identity); // Explicit operator action, not a hidden fixture auto-retry.
  const retry = (await f.store.inventory(identity))!;
  assert.notEqual(retry.attempt_id, before.attempt_id);
  const resumed = await startWorker(f, login);
  const ready = await until(async () => {
    const row = (await f.store.inventory(identity))!; return row.state === 'ready' ? row : undefined;
  }, 'explicit retry reaches ready', f.signal, 15000);
  assert.equal(ready.stage, 'ready'); assert.equal(ready.attempts, 0); assert.ok(ready.verified_at);
  assert.equal(f.upstream.warmups, 1); assert.equal(f.upstream.modelGets, 1);
  assert.equal(await f.slots(), 0);
  const finalAccount = await f.storage.getAccount(identity);
  assert.equal(await f.storage.saveCopilotOauthToken(identity, task.oauthAttemptId, 'synthetic-stale-token', task.ghLogin), undefined);
  assert.deepEqual(await f.storage.getAccount(identity), finalAccount);
  await resumed.stop();
  return { released, ready, explicitOperatorRetry: true, warmups: f.upstream.warmups };
}

test('real MySQL Worker/Provisioner Login network fault acceptance', {
  skip: selected ? false : 'UNRUN: explicit MYSQL_POOL_LOGIN_NETWORK_TEST=1 and disposable loopback MySQL required',
  timeout: SUITE_MS,
}, async suite => {
  for (const restart of [false, true]) {
    let completed = false;
    await suite.test(restart ? 'independent wire-server death/restart preserves accepted task, GET-only recovery' :
      'actual 120-second client timeout closes silent task GET; independent ordinary work progresses',
    { timeout: restart ? 90000 : 230000 }, async t => {
      const f = new Fixture(t.signal);
      t.after(() => f.cleanup());
      const began = performance.now();
      try {
        await f.init();
        if (restart) {
          const settings = await f.store.settings();
          await f.store.updateSettings(settings.version, { idle_target: 1, max_accounts: 1 });
        }
        const first = await seed(f);
        let second: Inventory | undefined;
        if (!restart) {
          second = await seed(f);
          // Eligible warmup needs no Login capacity. Seed it disabled until GET is demonstrably in flight.
          await f.store.update(second.identity, { state: 'disabled', stage: 'warmup' });
          const nonce = randomUUID();
          assert.ok(await f.storage.beginCopilotOauthAuthorization(second.identity, nonce));
          assert.ok(await f.storage.saveCopilotOauthToken(second.identity, nonce, OAUTH_TOKEN, `${second.identity}_synthetic`));
        }
        f.upstream.reset(first.identity, 0);
        const initial = await startLogin(f, { holdPost: restart });
        const servers = [initial.server];
        let liveServer = initial.server;
        let worker = await startWorker(f, initial.origin);
        const accepted = await initial.server.message('accepted'); const task = accepted.task!;
        assert.equal(taskPosts(servers), 1); assert.equal(task.identity, first.identity);
        let original: Inventory;
        let preRecovery: Inventory;
        let timeoutEvidence: Proof | undefined;
        let ordinaryReady: Inventory | undefined;
        if (restart) {
          original = (await f.store.inventory(first.identity))!;
          assert.equal(original.stage, 'oauth-dispatch'); assert.equal(original.task_id, null);
          assert.equal(original.oauth_attempt_id, task.oauthAttemptId);
          assert.equal(await f.slots(), 1);
          // The accepted POST has no response. Kill the independent wire process, not the worker.
          await initial.server.kill();
          assert.ok(initial.server.signal === 'SIGKILL' || process.platform === 'win32' && initial.server.code !== 0);
          await until(async () => (await f.store.inventory(first.identity))?.state === 'failed', 'dead Login POST failure', t.signal);
          await worker.stop();
          const failed = (await f.store.inventory(first.identity))!;
          assert.equal(failed.attempts, 1); assert.deepEqual(slotIdentity(failed), slotIdentity(original));
          // Establish exhausted operator state explicitly; do NOT accelerate persisted retries or clocks.
          await f.store.fail(first.identity, 'synthetic_operator_failure', failed, undefined, true);
          preRecovery = (await f.store.inventory(first.identity))!;
          const credentialsBeforeObservation = await f.storage.getAccount(first.identity);
          worker = await startWorker(f, initial.origin);
          const readError = await worker.message('observation-end');
          assert.equal(readError.reason, 'request-failed', 'Connection refusal is a separate restart observation, NOT timeout coverage');
          await unchanged(f, first.identity, preRecovery, servers, 1);
          const replacement = await startLogin(f, { port: Number(new URL(initial.origin).port), tasks: [task] });
          liveServer = replacement.server; servers.push(liveServer);
          assert.equal(replacement.origin, initial.origin);
          assert.notEqual(liveServer.child.pid, initial.server.child.pid);
          assert.deepEqual((await liveServer.message('listening')).tasks, [task], 'Accepted identity restored from parent IPC ledger');
          const get = await liveServer.message('get-start');
          assert.equal(get.task!.id, task.id); assert.equal(get.task!.oauthAttemptId, task.oauthAttemptId);
          assert.ok(liveServer.messages.some(message => message.kind === 'http' && message.method === 'GET' && message.path === '/api/tasks'));
          for (let cycle = 0; cycle < 3; cycle++) { await pause(options.pollMs); await unchanged(f, first.identity, preRecovery, servers, 1); }
          assert.deepEqual(await f.storage.getAccount(first.identity), credentialsBeforeObservation,
            'Recovery GETs must not begin authorization or mutate credentials');
          assert.equal(f.upstream.warmups, 0);
        } else {
          await until(async () => (await f.store.inventory(first.identity))?.task_id === task.id, 'real POST checkpoint', t.signal);
          await worker.stop();
          original = (await f.store.inventory(first.identity))!;
          assert.equal(original.stage, 'oauth-wait'); assert.equal(original.oauth_attempt_id, task.oauthAttemptId);
          await f.store.fail(first.identity, 'synthetic_operator_failure', original, undefined, true);
          preRecovery = (await f.store.inventory(first.identity))!;
          await liveServer.command('mode', { stallGets: true });
          const serverOffset = liveServer.messages.length;
          f.upstream.reset(second!.identity, 0); // Reuse existing upstream mock read-only; Login lives elsewhere.
          worker = await startWorker(f, initial.origin);
          const get = await liveServer.message('get-start', serverOffset);
          const observation = await worker.message('observation-start');
          assert.equal(get.task!.id, task.id); assert.equal(get.task!.oauthAttemptId, task.oauthAttemptId);
          await liveServer.command('mode', { stallGets: false }); // Future GETs only; current socket remains silent.
          const disabledWarmup = (await f.store.inventory(second!.identity))!;
          assert.equal(disabledWarmup.state, 'disabled'); assert.equal(disabledWarmup.stage, 'warmup');
          // updateTx deliberately rejects ALL writes to disabled rows. Use the real
          // operator retry operation, which preserves warmup and rotates only this
          // unrelated member's attempt/generation; do not bypass the disabled fence.
          await f.store.retry(second!.identity);
          ordinaryReady = await until(async () => {
            const row = (await f.store.inventory(second!.identity))!; return row.state === 'ready' ? row : undefined;
          }, 'unrelated warmup during stalled reservation GET', t.signal, 15000);
          assert.notEqual(ordinaryReady.attempt_id, disabledWarmup.attempt_id);
          assert.equal(ordinaryReady.stage, 'ready'); assert.equal(ordinaryReady.attempts, 0);
          assert.equal(f.upstream.warmups, 1); assert.equal(f.upstream.modelGets, 1);
          assert.equal(liveServer.messages.some(message => message.kind === 'get-abort' && message.id === get.id), false);
          await unchanged(f, first.identity, preRecovery, servers, 1);
          const snapshot = await worker.command('snapshot');
          assert.equal(snapshot.snapshot!.state, 'owner'); assert.equal(snapshot.snapshot!.ownershipLosses, 0);
          // Nothing is killed/stopped/released until production timeout closes the actual socket.
          timeoutEvidence = await until(async () => {
            worker.healthy(); liveServer.healthy();
            await unchanged(f, first.identity, preRecovery, servers, 1);
            return liveServer.messages.find(message => message.kind === 'get-abort' && message.id === get.id);
          }, 'actual production HTTP abort', t.signal, options.requestTimeoutMs + 15000, 1000);
          assert.equal(timeoutEvidence.headersSent, false, 'No response or headers were sent');
          assert.ok(timeoutEvidence.at! > get.at!);
          assert.ok(timeoutEvidence.elapsedMs! >= 118000 && timeoutEvidence.elapsedMs! <= 135000,
            'Wire GET consumed the 120s production budget (up to 2s pre-GET DB setup tolerance)');
          const end = await worker.message('observation-end');
          assert.ok(end.elapsedMs! >= 118000 && end.elapsedMs! <= 135000);
          assert.ok(['provision_timeout', 'TimeoutError'].includes(end.reason!));
          assert.equal(end.generation, observation.generation);
          const afterTimeout = await worker.command('snapshot');
          assert.equal(afterTimeout.snapshot!.state, 'owner'); assert.equal(afterTimeout.snapshot!.ownershipLosses, 0);
          assert.deepEqual(await f.store.inventory(second!.identity), ordinaryReady);
          await unchanged(f, first.identity, preRecovery, servers, 1);
          t.diagnostic(JSON.stringify({ productionRequestTimeoutMs: options.requestTimeoutMs, getStart: get, wireAbort: timeoutEvidence,
            workerObservation: end, unrelatedReady: ordinaryReady.identity, workerSnapshot: afterTimeout.snapshot }));
        }
        assert.equal((await f.storage.getAccount(first.identity))!.copilotOauthAttemptId, task.oauthAttemptId);
        const result = await finish(f, first.identity, task, liveServer, initial.origin, worker);
        assert.equal(taskPosts(servers), 1, 'No duplicate POST across timeout, restart, terminal release or explicit retry');
        const remote = await liveServer.command('snapshot');
        assert.equal(remote.tasks!.length, 1); assert.equal(remote.tasks![0].id, task.id);
        assert.equal(remote.tasks![0].oauthAttemptId, task.oauthAttemptId);
        assert.deepEqual(f.upstream.errors, []);
        const http = servers.flatMap(server => server.messages.filter(message => message.kind === 'http'));
        assert.ok(http.every(message => message.method === 'GET' || message.method === 'POST' && message.path === '/api/tasks'));
        t.diagnostic(JSON.stringify({ case: restart ? 'wire-process-restart' : 'silent-wire-timeout',
          database: f.sibling.database, parentPid: process.pid, wirePids: servers.map(server => server.child.pid),
          workerPids: f.children.filter(child => !servers.includes(child)).map(child => child.child.pid),
          elapsedMs: Math.round(performance.now() - began), taskId: task.id, nonce: task.oauthAttemptId,
          original, preRecovery, taskPosts: taskPosts(servers), http, timeoutEvidence, ...result,
          limitations: 'Synthetic loopback wire process; not actual Login service/browser. Callback repository layer only.' }));
        completed = true;
      } finally { await f.cleanup(); }
    });
    if (!completed || suite.signal.aborted) break;
  }
});
