// Executes inside the existing local Login container. Real queue and Chromium,
// but an injected local-page runner: no GitHub/OAuth tasks or database rows.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LoginQueue } from '/app/src/login/dist/tasks/queue.js';
import { loginRuntimeSettings } from '/app/src/login/dist/db/runtimeSettingsRepo.js';
import { chromium } from '/app/node_modules/playwright/index.mjs';

const concurrency = loginRuntimeSettings.getSnapshot().concurrency;
assert.equal(concurrency, 5);
const tasks = new Map();
const launched = new Set();
const browsers = new Set();
const errors = [];
let active = 0, peakTasks = 0, peakBrowsers = 0, completed = 0;
let peakContainerBytes = 0;
const gates = [0, 1].map(() => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release, ready: 0 };
});
const startedAt = Date.now();
const queue = new LoginQueue({
  getConcurrency: () => loginRuntimeSettings.getSnapshot().concurrency,
  createTask: input => {
    const task = { ...input, id: `local-browser-${tasks.size}`, status: 'pending', attempts: 0, createdAt: new Date().toISOString() };
    tasks.set(task.id, task);
    return task;
  },
  getTask: id => tasks.get(id),
  markCancelled: id => tasks.get(id),
  markCopilotOauthFailed: async () => { errors.push('Unexpected callback attempt'); },
  runLoginTask: async task => {
    let browser;
    try {
      assert.equal(launched.has(task.id), false);
      launched.add(task.id);
      task.status = 'running';
      peakTasks = Math.max(peakTasks, ++active);
      assert.ok(active <= 5);
      browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
      browsers.add(browser);
      peakBrowsers = Math.max(peakBrowsers, browsers.size);
      const context = await browser.newContext();
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      await page.setContent(`<h1>${task.id}</h1><input aria-label="Local input"><button>Submit</button><output></output><script>document.querySelector('button').onclick=()=>document.querySelector('output').textContent=document.querySelector('input').value</script>`);
      await page.getByLabel('Local input').fill(task.identity);
      await page.getByRole('button', { name: 'Submit' }).click();
      assert.equal(await page.locator('output').textContent(), task.identity);
      const batch = Number(task.id.split('-').at(-1)) < 5 ? 0 : 1;
      const gate = gates[batch];
      if (++gate.ready === 5) {
        assert.equal(browsers.size, 5);
        if (batch === 0) assert.equal(launched.size, 5, 'Second batch must remain queued');
        try { peakContainerBytes = Math.max(peakContainerBytes, Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8'))); } catch { /* cgroup v1 */ }
        console.log(`PASS batch ${batch + 1}: five separate Chromium instances active, queue bound enforced`);
        setTimeout(gate.release, 2000);
      }
      await gate.promise;
      task.status = 'success';
    } catch (error) {
      errors.push(error.message);
      gates.forEach(gate => gate.release());
      task.status = 'failed';
    } finally {
      if (browser) { await browser.close(); browsers.delete(browser); }
      active--;
      completed++;
    }
  },
});

try {
  for (let i = 0; i < 10; i++) queue.enqueue({ identity: `local-browser-user-${i}`, ssoUser: `local-browser-user-${i}`, ghLogin: `local-browser-user-${i}_test`, oauthAttemptId: `local-browser-attempt-${i}`, ssoType: 'custom', ssoPassword: 'unused-local-test' });
  const deadline = Date.now() + 90000;
  while (completed < 10 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(completed, 10, 'Browser queue test timed out');
  assert.deepEqual(errors, []);
  assert.equal(peakTasks, 5);
  assert.equal(peakBrowsers, 5);
  assert.ok([...tasks.values()].every(task => task.status === 'success'));
  console.log(JSON.stringify({ result: 'PASS', configuredConcurrency: concurrency, tasks: 10, completed, peakTasks, peakBrowsers, peakContainerMiB: Math.round(peakContainerBytes / 1024 / 1024), durationMs: Date.now() - startedAt, liveGitHubRequests: 0, persistedTestTasks: 0 }));
} finally {
  gates.forEach(gate => gate.release());
  await Promise.all([...browsers].map(browser => browser.close().catch(() => {})));
}
