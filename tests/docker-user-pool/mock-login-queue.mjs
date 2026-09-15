// Synthetic authorization scheduler only; never launches a browser or external login.
export class MockLoginQueue {
  constructor({ concurrency = 1, delayMs = 0, complete, maxTasks = 10000 }) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20
      || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000 || typeof complete !== 'function') throw new Error('invalid_mock_login_queue');
    this.concurrency = concurrency; this.delayMs = delayMs; this.complete = complete; this.maxTasks = maxTasks;
    this.pending = []; this.active = 0; this.peakActive = 0; this.accepted = 0; this.finished = 0; this.failed = 0;
    this.waitMs = 0; this.maxWaitMs = 0;
  }
  enqueue(task) {
    if (this.accepted >= this.maxTasks) throw new Error('mock_login_task_limit');
    this.accepted++; task.status = 'pending'; this.pending.push({ task, queuedAt: Date.now() });
    queueMicrotask(() => this.drain());
  }
  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const { task, queuedAt } = this.pending.shift();
      this.active++; this.peakActive = Math.max(this.peakActive, this.active);
      const waited = Date.now() - queuedAt; this.waitMs += waited; this.maxWaitMs = Math.max(this.maxWaitMs, waited);
      task.status = 'running'; task.startedAt = new Date().toISOString();
      void (async () => {
        try {
          if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs));
          await this.complete(task); this.finished++;
        } catch { this.failed++; task.status = 'failed'; task.error = 'mock_login_completion_failed'; }
        finally { this.active--; this.drain(); }
      })();
    }
  }
  snapshot() {
    return { concurrency: this.concurrency, delayMs: this.delayMs, active: this.active, peakActive: this.peakActive,
      pending: this.pending.length, accepted: this.accepted, finished: this.finished, failed: this.failed,
      totalWaitMs: this.waitMs, maxWaitMs: this.maxWaitMs };
  }
}
