import { randomUUID } from 'node:crypto';
import { HttpApiError } from '@ghcp/shared';
import { Logger } from '../logger.js';
import {
  ProvisionFailure,
  type ProvisionAdapter,
  type ProvisionContext,
  type ProvisionInventory,
  type ProvisionPatch,
} from './provisioner.js';
import type { InventoryFence, UserPoolStore } from './store.js';

/** The optional owner fence is checked in the same transaction as each write. */
export interface PrewarmStore extends Pick<UserPoolStore,
  'now' | 'claimOwner' | 'releaseOwner' | 'reclaim' | 'settings' | 'pending' | 'reserveDeficit' | 'hasHolds' | 'event'> {
  inventory(identity: string): ProvisionInventory | undefined;
  update(identity: string, patch: ProvisionPatch, expected?: InventoryFence, owner?: string): boolean;
  fail(identity: string, code: string, expected?: InventoryFence, owner?: string): void;
}

const HEARTBEAT_MS = 5000;
const OWNER_TTL_MS = 30000;

export class PrewarmWorker {
  private readonly owner = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private scheduling?: Promise<Promise<void>[]>;
  private wake?: ReturnType<typeof setImmediate>;
  private started = false;
  private stopped = false;
  private ownsPool = false;
  private renewedAt = 0;
  private readonly logger = new Logger('user-pool');

  constructor(
    private readonly store: PrewarmStore,
    private readonly adapter: ProvisionAdapter,
    private readonly pollMs: number,
    private readonly concurrency = 5,
  ) {
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid prewarm poll interval');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error('Invalid prewarm concurrency');
  }

  start(): void {
    if (this.stopped) throw new Error('Pool worker has stopped');
    if (this.timer) return;
    if (!this.renewOwner()) throw new Error('Another Proxy owns the SQLite user pool');
    this.started = true;
    // Ownership must stay alive even when reconciliation is slower than its 30s lease.
    this.heartbeat = setInterval(() => this.renewOwner(), HEARTBEAT_MS);
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.heartbeat.unref();
    this.timer.unref();
    void this.tick();
  }

  isActive(): boolean {
    return this.ownsPool && this.renewOwner();
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.scheduling) {
      this.scheduling = Promise.resolve().then(() => this.schedule())
        .catch(() => {
          this.logger.error('reconcile-failed', 'Pool reconciliation failed; inspect storage health');
          return [];
        })
        .finally(() => { this.scheduling = undefined; });
    }
    const launched = await this.scheduling;
    await Promise.all(launched);
  }

  private requestTick(): void {
    if (!this.started || this.stopped || this.wake) return;
    this.wake = setImmediate(() => {
      this.wake = undefined;
      void this.tick();
    });
    this.wake.unref();
  }

  private schedule(): Promise<void>[] {
    if (this.stopped || !this.renewOwner()) return [];
    this.store.reclaim();
    if (this.store.settings().paused) return [];
    this.store.reserveDeficit(this.owner);
    const launched: Promise<void>[] = [];
    const excluded = [...this.active.keys()];
    while (this.active.size < this.concurrency) {
      const row = this.store.pending(excluded);
      if (!row || excluded.includes(row.identity)) break;
      excluded.push(row.identity);
      if (this.store.hasHolds(row.identity)) continue;
      const controller = new AbortController();
      // Register before entering the adapter, even if it completes synchronously.
      const promise = Promise.resolve().then(() => this.advance(row, controller))
        .catch(() => this.logger.error('reconcile-failed', 'Pool account step failed; inspect storage health'))
        .finally(() => {
          this.active.delete(row.identity);
          this.requestTick();
        });
      this.active.set(row.identity, { controller, promise });
      launched.push(promise);
    }
    return launched;
  }

  private renewOwner(): boolean {
    if (this.stopped) return false;
    try {
      // Do not revive an expired owner after a blocked event loop: outstanding work is stale.
      if (this.ownsPool && performance.now() - this.renewedAt >= OWNER_TTL_MS) {
        this.loseOwnership();
        return false;
      }
      if (!this.store.claimOwner(this.owner)) {
        this.loseOwnership();
        return false;
      }
      this.ownsPool = true;
      this.renewedAt = performance.now();
      return true;
    } catch {
      this.loseOwnership();
      return false;
    }
  }

  private loseOwnership(): void {
    this.stopped = true;
    this.clearTimers();
    for (const { controller } of this.active.values()) controller.abort();
    this.logger.error('ownership-lost', 'Pool worker stopped');
  }

  private async advance(row: ProvisionInventory, controller: AbortController): Promise<void> {
    if (this.stopped || this.store.settings().paused || !this.renewOwner()) return;
    let current = this.store.inventory(row.identity);
    if (!current || current.attempt_id !== row.attempt_id || this.store.hasHolds(current.identity)) return;
    const identity = current.identity;
    const attempt = current.attempt_id;
    if (current.state === 'failed') {
      if (!this.store.update(identity, { state: 'provisioning' }, current, this.owner)) return;
      current = this.store.inventory(identity)!;
    }
    if (current.state !== 'provisioning') return;

    let credentialGeneration: number | undefined;
    const deadline = setTimeout(() => controller.abort(new ProvisionFailure('provision_timeout')),
      this.adapter.stepTimeoutMs ?? 120000);
    deadline.unref();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!this.renewOwner()) throw new ProvisionFailure('provision_fenced');
      const latest = this.store.inventory(identity);
      if (!latest || latest.state !== 'provisioning' || latest.attempt_id !== attempt
        || latest.stage !== current!.stage || this.store.hasHolds(identity)
        || credentialGeneration !== undefined && latest.generation !== credentialGeneration) {
        throw new ProvisionFailure('provision_fenced');
      }
    };
    const context: ProvisionContext = {
      signal: controller.signal,
      assertCurrent,
      pinCredentials: () => {
        assertCurrent();
        credentialGeneration = this.store.inventory(identity)!.generation;
      },
      credentialsInvalidated: () => {
        if (credentialGeneration === undefined) throw new ProvisionFailure('provision_fenced');
        credentialGeneration++;
        assertCurrent();
      },
      checkpoint: (patch) => {
        assertCurrent();
        const fence = this.store.inventory(identity)!;
        if (!this.store.update(identity, patch, fence, this.owner)) throw new ProvisionFailure('provision_fenced');
        const saved = this.store.inventory(identity)!;
        // Fail closed if an old store silently ignores a required persisted field.
        if (Object.entries(patch).some(([key, value]) => saved[key as keyof ProvisionInventory] !== value)) {
          throw new ProvisionFailure('provision_storage_incompatible', true);
        }
        current = saved;
        return saved;
      },
    };
    try {
      assertCurrent();
      const patch = await untilAborted(this.adapter.step(current, context), controller.signal);
      const progressed = Object.entries(patch).some(([key, value]) => current![key as keyof ProvisionInventory] !== value);
      context.checkpoint({ ...patch, retry_at: patch.retry_at ?? this.store.now() + (progressed ? 0 : this.pollMs) });
      if (patch.state === 'ready') this.store.event('account_ready', identity);
    } catch (error) {
      // Disable, operator retry, shutdown, or another owner must fence both success and failure.
      if (this.stopped || !this.renewOwner()) return;
      const latest = this.store.inventory(identity);
      if (!latest || latest.state !== 'provisioning' || latest.attempt_id !== attempt
        || credentialGeneration !== undefined && latest.generation !== credentialGeneration
        || this.store.hasHolds(identity) || error instanceof ProvisionFailure && error.code === 'provision_fenced') return;
      const code = failureCode(error);
      this.store.fail(identity, code, latest, this.owner);
      if (error instanceof ProvisionFailure && error.terminal) {
        this.store.update(identity, { attempts: 3 }, this.store.inventory(identity), this.owner);
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.wake) clearImmediate(this.wake);
    this.wake = undefined;
    this.timer = undefined;
    this.heartbeat = undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    for (const { controller } of this.active.values()) controller.abort();
    // The abort race bounds shutdown even if an adapter fails to cooperate. Its context
    // remains aborted, so late results and subsequent checkpoints cannot mutate inventory.
    await this.scheduling;
    await Promise.all([...this.active.values()].map(({ promise }) => promise));
    if (this.ownsPool) this.store.releaseOwner(this.owner);
    this.ownsPool = false;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof ProvisionFailure) return error.code;
  if (error instanceof HttpApiError && Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
    return `service_http_${error.status}`;
  }
  return 'service_unavailable';
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
