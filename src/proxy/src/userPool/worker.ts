import { randomUUID } from 'node:crypto';
import { HttpApiError } from '@ghcp/shared';
import { Logger } from '../logger.js';
import {
  ProvisionFailure,
  isExhaustedLoginReservation,
  type LoginReservationContext,
  type LoginReservationOutcome,
  type ProvisionAdapter,
  type ProvisionContext,
  type ProvisionInventory,
} from './provisioner.js';
import type { Awaitable, PoolStore } from './storage.js';
import { MysqlConnectionError, MysqlDeadlineError } from './mysqlDeadline.js';

/** Every remote operation is awaited; writes check the supplied fence in their transaction. */
export interface PrewarmStore extends Pick<PoolStore,
  'now' | 'claimOwner' | 'releaseOwner' | 'reclaim' | 'settings' | 'pending' | 'reserveDeficit' | 'hasHolds'
  | 'event' | 'inventory' | 'update' | 'fail' | 'mutateWorkerCredential'> {
  claimLoginDispatch?: PoolStore['claimLoginDispatch'];
  /** At most 100 rows, ordered stably; only exhausted failed/disabled dispatch/wait rows. */
  listLoginReservations?(): Awaitable<ProvisionInventory[]>;
  /** Atomic owner/expiry, full row fence, unpaused and no-holds check. Preserve state,
   * attempts and errors; move to warmup (success) / synced (failed), clear task/nonce,
   * increment generation. Never change Proxy credentials or automatically retry. */
  releaseLoginReservation?(identity: string, fence: ProvisionInventory, owner: string, outcome: LoginReservationOutcome): Awaitable<boolean>;
  /** Unlike election, renewal must reject an already expired lease. Required for multiple replicas. */
  renewOwner?(owner: string): Awaitable<boolean>;
}

const HEARTBEAT_MS = 5000;
const OWNER_TTL_MS = 30000;
interface Tenure { id: string; renewedAt: number }
export interface PrewarmWorkerOptions {
  multiReplica?: boolean;
  /** Diagnostic timestamps only; never used for tenure/lease decisions or SQL. */
  wallClockNow?: () => number;
}
export type OwnershipLossReason = 'local_tenure_expired' | 'renewal_rejected'
  | 'storage_unavailable' | 'storage_operation_failed';
export interface OwnershipLoss {
  readonly reason: OwnershipLossReason;
  readonly storageFailure?: 'deadline' | 'connection';
}
export interface PrewarmWorkerSnapshot {
  /** This worker instance in this process only; never cluster health or routing readiness. */
  readonly scope: 'local_process';
  /** owner means locally unexpired, NOT verified database ownership. Before start: standby. */
  readonly state: 'owner' | 'standby' | 'stopped';
  readonly observedAtUnixMs: number;
  /** Request-start age of the current tenure's last claim/renewal; may exceed the TTL. */
  readonly localTenureAgeMs: number | null;
  /** Accepted renewal response time, not the lease deadline (a claim is not a renewal). */
  readonly lastSuccessfulRenewalAtUnixMs: number | null;
  readonly lastSuccessfulRenewalAgeMs: number | null;
  /** Cumulative since construction. Renewals, including SQLite's fallback, are not claims. */
  readonly claimAttempts: number;
  readonly ownershipAcquisitions: number;
  /** Recorded loss transitions only; an observational read never records a loss. */
  readonly ownershipLosses: number;
  readonly lastOwnershipLoss: (OwnershipLoss & { readonly atUnixMs: number }) | null;
}

export class PrewarmWorker {
  private tenure?: Tenure;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private reservationController?: AbortController;
  private reservationTask?: Promise<void>;
  private lastReservationPoll = -Infinity;
  private reservationOffset = 0;
  private scheduling?: Promise<Promise<void>[]>;
  private ownership?: Promise<boolean>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private wake?: ReturnType<typeof setImmediate>;
  private started = false;
  private stopped = false;
  private claimAttempts = 0;
  private ownershipAcquisitions = 0;
  private ownershipLosses = 0;
  private lastSuccessfulRenewal?: { atUnixMs: number; atMonotonicMs: number };
  private lastOwnershipLoss?: OwnershipLoss & { atUnixMs: number };
  private readonly wallClockNow: () => number;
  private readonly logger = new Logger('user-pool');

  constructor(
    private readonly store: PrewarmStore,
    private readonly adapter: ProvisionAdapter,
    private readonly pollMs: number,
    private readonly concurrency = 5,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly options: PrewarmWorkerOptions = {},
  ) {
    if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid prewarm poll interval');
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error('Invalid prewarm concurrency');
    if (options.multiReplica && !store.renewOwner) throw new Error('Multi-replica pool requires fenced owner renewal');
    this.wallClockNow = options.wallClockNow ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Pool worker has stopped');
    if (this.starting) return this.starting;
    if (this.started) return;
    this.starting = (async () => {
      if (!await this.ensureOwner() && !this.options.multiReplica) {
        throw new Error('Another Proxy owns the SQLite user pool');
      }
      if (this.stopped) return;
      this.started = true;
      // Heartbeats also run for standby replicas, independently of reconciliation and HTTP.
      this.heartbeat = setInterval(() => { void this.ensureOwner(); }, HEARTBEAT_MS);
      this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
      this.heartbeat.unref();
      this.timer.unref();
      void this.tick();
    })().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Pure local observation: no SQL, election, expiry transition, abort or logging.
   * A locally expired tenure is shown as standby until normal execution fences it;
   * loss counters/timestamps only change when that transition actually happens. */
  snapshot(): PrewarmWorkerSnapshot {
    const now = this.monotonicNow();
    const localTenureAgeMs = this.tenure ? Math.max(0, now - this.tenure.renewedAt) : null;
    return {
      scope: 'local_process',
      state: this.stopped ? 'stopped' : localTenureAgeMs !== null && localTenureAgeMs < OWNER_TTL_MS ? 'owner' : 'standby',
      observedAtUnixMs: this.wallClockNow(),
      localTenureAgeMs,
      lastSuccessfulRenewalAtUnixMs: this.lastSuccessfulRenewal?.atUnixMs ?? null,
      lastSuccessfulRenewalAgeMs: this.lastSuccessfulRenewal ? Math.max(0, now - this.lastSuccessfulRenewal.atMonotonicMs) : null,
      claimAttempts: this.claimAttempts,
      ownershipAcquisitions: this.ownershipAcquisitions,
      ownershipLosses: this.ownershipLosses,
      lastOwnershipLoss: this.lastOwnershipLoss ? { ...this.lastOwnershipLoss } : null,
    };
  }

  /** Local scheduler status only. Routing readiness must check storage, not require ownership. */
  isActive(): boolean {
    return this.tenure !== undefined && this.isCurrentTenure(this.tenure);
  }

  /** Await ordinary steps launched by this tick, not independent terminal observations. */
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

  /** Drain the current bounded observation batch without scheduling another one. */
  async waitForObservations(): Promise<void> {
    await this.reservationTask;
  }

  private requestTick(): void {
    if (!this.started || this.stopped || this.wake) return;
    this.wake = setImmediate(() => {
      this.wake = undefined;
      void this.tick();
    });
    this.wake.unref();
  }

  private async schedule(): Promise<Promise<void>[]> {
    if (!await this.ensureOwner()) return [];
    const tenure = this.tenure;
    if (!tenure || !this.isCurrentTenure(tenure)) return [];
    const storage = <T>(operation: () => Awaitable<T>) => this.storageOperation(tenure, operation);
    await storage(() => this.store.reclaim());
    if (!this.isCurrentTenure(tenure)) return [];
    if ((await storage(() => this.store.settings())).paused) {
      this.reservationController?.abort(new ProvisionFailure('provision_fenced'));
      return [];
    }
    if (!this.isCurrentTenure(tenure)) return [];
    // Login GETs can take the full request deadline. They must not hold the ordinary
    // scheduler single-flight or consume its provisioning concurrency slots.
    this.observeLoginReservations(tenure);
    await storage(() => this.store.reserveDeficit(tenure.id));
    const launched: Promise<void>[] = [];
    const excluded = [...this.active.keys()];
    while (this.isCurrentTenure(tenure) && this.active.size < this.concurrency) {
      const row = await storage(() => this.store.pending(excluded));
      if (!row || excluded.includes(row.identity)) break;
      excluded.push(row.identity);
      if (await storage(() => this.store.hasHolds(row.identity))) continue;
      if (!this.isCurrentTenure(tenure)) break;
      const controller = new AbortController();
      // Capture the tenure, never look up a replacement owner inside this step's callbacks.
      const promise = Promise.resolve().then(() => this.advance(row, controller, tenure))
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

  private observeLoginReservations(tenure: Tenure): void {
    if (this.reservationTask || !this.isCurrentTenure(tenure)
      || !this.store.listLoginReservations || !this.store.releaseLoginReservation || !this.adapter.reconcileLoginReservation) return;
    const now = this.monotonicNow();
    // Completion-triggered scheduler wakes must not hammer unresolved Login tasks.
    if (now - this.lastReservationPoll < this.pollMs) return;
    this.lastReservationPoll = now;
    const controller = new AbortController();
    this.reservationController = controller;
    // Bound the whole batch, including selection and assertions, not just the HTTP.
    const deadline = setTimeout(() => controller.abort(new ProvisionFailure('provision_timeout')),
      this.adapter.stepTimeoutMs ?? 120000);
    deadline.unref();
    this.reservationTask = untilAborted(
      Promise.resolve().then(() => this.reconcileLoginReservations(tenure, controller.signal)), controller.signal,
    ).catch(() => {
      // Storage failures already fence ownership. Timeouts/aborts retain reservations.
    }).finally(() => {
      clearTimeout(deadline);
      controller.abort(new ProvisionFailure('provision_fenced'));
      this.reservationController = undefined;
      this.reservationTask = undefined;
      this.requestTick();
    });
  }

  private async reconcileLoginReservations(tenure: Tenure, batchSignal: AbortSignal): Promise<void> {
    const storage = async <T>(operation: () => Awaitable<T>): Promise<T> => {
      batchSignal.throwIfAborted();
      if (!this.isCurrentTenure(tenure)) throw new ProvisionFailure('provision_fenced');
      const result = await this.storageOperation(tenure, operation);
      batchSignal.throwIfAborted();
      return result;
    };
    const rows = (await storage(() => this.store.listLoginReservations!())).slice(0, 100);
    if (!rows.length) { this.reservationOffset = 0; return; }
    const offset = this.reservationOffset % rows.length;
    const batch = [...rows.slice(offset), ...rows.slice(0, offset)].slice(0, 10);
    this.reservationOffset = (offset + batch.length) % rows.length;
    await Promise.all(batch.map(async row => {
      if (!isExhaustedLoginReservation(row) || this.active.has(row.identity) || !this.isCurrentTenure(tenure)) return;
      const controller = new AbortController();
      const signal = AbortSignal.any([batchSignal, controller.signal]);
      const context: LoginReservationContext = {
        signal,
        assertCurrent: async () => {
          signal.throwIfAborted();
          if (!await this.renewTenure(tenure)) throw new ProvisionFailure('provision_fenced');
          const latest = await storage(() => this.store.inventory(row.identity));
          const paused = (await storage(() => this.store.settings())).paused;
          const held = await storage(() => this.store.hasHolds(row.identity));
          signal.throwIfAborted();
          if (!this.isCurrentTenure(tenure) || paused || held || !latest || !isExhaustedLoginReservation(latest)
            || latest.state !== row.state || latest.attempts !== row.attempts || latest.generation !== row.generation
            || latest.attempt_id !== row.attempt_id || latest.stage !== row.stage || latest.task_id !== row.task_id
            || latest.oauth_attempt_id !== row.oauth_attempt_id || latest.sso_created_at !== row.sso_created_at) {
            throw new ProvisionFailure('provision_fenced');
          }
        },
      };
      try {
        await context.assertCurrent();
        const outcome = await untilAborted(this.adapter.reconcileLoginReservation!(row, context), signal);
        if (outcome !== 'success' && outcome !== 'failed') return;
        await context.assertCurrent();
        await storage(() => this.store.releaseLoginReservation!(row.identity, row, tenure.id, outcome));
      } catch {
        // Read errors, missing/ambiguous tasks and stale owners retain the reservation.
        // They must never charge another provisioning attempt or reset operator state.
      } finally {
        // Fence retained callbacks as soon as this row finishes, not only the batch.
        controller.abort(new ProvisionFailure('provision_fenced'));
      }
    }));
  }

  private isCurrentTenure(tenure: Tenure): boolean {
    if (this.stopped || this.tenure !== tenure) return false;
    // A blocked event loop or delayed database response must not resurrect local execution.
    if (this.monotonicNow() - tenure.renewedAt >= OWNER_TTL_MS) {
      this.loseOwnership(tenure, { reason: 'local_tenure_expired' });
      return false;
    }
    return true;
  }

  private async ensureOwner(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.tenure) return this.renewTenure(this.tenure);
    if (this.ownership) return this.ownership;
    // Abort races drain the local steps first; their retained contexts stay fenced forever.
    if (this.active.size || this.reservationTask) return false;
    this.claimAttempts++;
    const candidate: Tenure = { id: randomUUID(), renewedAt: this.monotonicNow() };
    this.ownership = (async () => {
      try {
        if (!await this.store.claimOwner(candidate.id)) {
          if (!this.options.multiReplica) this.stopped = true;
          return false;
        }
        if (this.stopped || this.monotonicNow() - candidate.renewedAt >= OWNER_TTL_MS) {
          await this.store.releaseOwner(candidate.id);
          if (!this.options.multiReplica) this.stopped = true;
          return false;
        }
        this.tenure = candidate;
        this.ownershipAcquisitions++;
        return true;
      } catch {
        if (!this.options.multiReplica) this.stopped = true;
        return false;
      }
    })().finally(() => { this.ownership = undefined; });
    return this.ownership;
  }

  private async renewTenure(tenure: Tenure): Promise<boolean> {
    if (!this.isCurrentTenure(tenure)) return false;
    if (this.ownership) {
      await this.ownership;
      return this.isCurrentTenure(tenure);
    }
    const requestedAt = this.monotonicNow();
    this.ownership = (async () => {
      try {
        // Only legacy synchronous SQLite stores may use claim for renewal. Remote stores
        // must have the DB predicate owner = ? AND owner_until > DB_NOW in renewOwner.
        const renewed = await (this.store.renewOwner
          ? this.store.renewOwner(tenure.id) : this.store.claimOwner(tenure.id));
        if (!renewed) {
          this.loseOwnership(tenure, { reason: 'renewal_rejected' });
          return false;
        }
        if (!this.isCurrentTenure(tenure)) return false;
        // Use request start, not response time: network latency cannot extend our deadline.
        tenure.renewedAt = requestedAt;
        this.lastSuccessfulRenewal = { atUnixMs: this.wallClockNow(), atMonotonicMs: this.monotonicNow() };
        return true;
      } catch (error) {
        this.loseOwnership(tenure, ownershipStorageFailure(error));
        return false;
      }
    })().finally(() => { this.ownership = undefined; });
    return this.ownership;
  }

  private loseOwnership(tenure: Tenure, loss: OwnershipLoss): void {
    if (this.tenure !== tenure) return;
    this.tenure = undefined;
    this.ownershipLosses++;
    this.lastOwnershipLoss = { ...loss, atUnixMs: this.wallClockNow() };
    if (!this.options.multiReplica) {
      this.stopped = true;
      this.clearTimers();
    }
    for (const { controller } of this.active.values()) controller.abort(new ProvisionFailure('provision_fenced'));
    this.reservationController?.abort(new ProvisionFailure('provision_fenced'));
    // One log per lost local tenure, never per failed standby poll. No error objects,
    // messages, SQL operations, identities or owner UUIDs enter diagnostic fields.
    this.logger.error('ownership-lost', this.options.multiReplica ? 'Pool worker is standby' : 'Pool worker stopped', {
      scope: 'local_process', state: this.stopped ? 'stopped' : 'standby', ...this.lastOwnershipLoss,
      lastSuccessfulRenewalAtUnixMs: this.lastSuccessfulRenewal?.atUnixMs ?? null,
      claimAttempts: this.claimAttempts, ownershipAcquisitions: this.ownershipAcquisitions, ownershipLosses: this.ownershipLosses,
    });
  }

  private async storageOperation<T>(tenure: Tenure, operation: () => Awaitable<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.loseOwnership(tenure, ownershipStorageFailure(error));
      throw new ProvisionFailure('provision_fenced');
    }
  }

  private async advance(row: ProvisionInventory, controller: AbortController, tenure: Tenure): Promise<void> {
    const storage = <T>(operation: () => Awaitable<T>) => this.storageOperation(tenure, operation);
    if (!this.isCurrentTenure(tenure) || (await storage(() => this.store.settings())).paused) return;
    let current = await storage(() => this.store.inventory(row.identity));
    if (!current || current.attempt_id !== row.attempt_id || current.stage !== row.stage
      || current.generation !== row.generation || await storage(() => this.store.hasHolds(row.identity))) return;
    const identity = current.identity;
    const attempt = current.attempt_id;
    if (!this.isCurrentTenure(tenure)) return;
    if (current.state === 'failed') {
      const previous = current;
      if (!await storage(() => this.store.update(identity, { state: 'provisioning' }, previous, tenure.id))) return;
      current = await storage(() => this.store.inventory(identity));
      if (!current || current.stage !== previous.stage || current.generation !== previous.generation + 1) return;
    }
    if (!current || current.state !== 'provisioning' || current.attempt_id !== attempt) return;

    let credentialGeneration: number | undefined;
    const deadline = setTimeout(() => controller.abort(new ProvisionFailure('provision_timeout')),
      this.adapter.stepTimeoutMs ?? 120000);
    deadline.unref();
    const readCurrent = async (checkSignal = true): Promise<ProvisionInventory> => {
      if (checkSignal) controller.signal.throwIfAborted();
      if (!await this.renewTenure(tenure)) throw new ProvisionFailure('provision_fenced');
      const latest = await storage(() => this.store.inventory(identity));
      const held = await storage(() => this.store.hasHolds(identity));
      if (checkSignal) controller.signal.throwIfAborted();
      if (!this.isCurrentTenure(tenure) || !latest || latest.state !== 'provisioning' || latest.attempt_id !== attempt
        || latest.stage !== current!.stage || held
        || credentialGeneration !== undefined && latest.generation !== credentialGeneration) {
        throw new ProvisionFailure('provision_fenced');
      }
      return latest;
    };
    const context: ProvisionContext = {
      signal: controller.signal,
      assertCurrent: async () => { await readCurrent(); },
      pinCredentials: async () => { credentialGeneration = (await readCurrent()).generation; },
      credentialsInvalidated: async () => {
        if (credentialGeneration === undefined) throw new ProvisionFailure('provision_fenced');
        credentialGeneration++;
        await readCurrent();
      },
      mutateCredentials: async (mutation) => {
        const fence = await readCurrent();
        if (mutation.type === 'invalidate' && credentialGeneration === undefined) throw new ProvisionFailure('provision_fenced');
        if (!await storage(() => this.store.mutateWorkerCredential(identity, fence, tenure.id, mutation))) {
          throw new ProvisionFailure('provision_fenced');
        }
        // Conditional invalidation changes exactly one generation. Never repin from a
        // later read: a concurrent replacement (including ABA) belongs to a different warmup.
        if (mutation.type === 'invalidate') credentialGeneration!++;
        await readCurrent();
        return true;
      },
      claimLoginDispatch: async (limit) => {
        if (!this.store.claimLoginDispatch) throw new ProvisionFailure('provision_storage_incompatible', true);
        const fence = await readCurrent();
        const claimed = await storage(() => this.store.claimLoginDispatch!(identity, fence, tenure.id, limit));
        if (!claimed) { await readCurrent(); return undefined; }
        const saved = await storage(() => this.store.inventory(identity));
        controller.signal.throwIfAborted();
        if (!this.isCurrentTenure(tenure) || !saved || saved.attempt_id !== attempt
          || saved.stage !== 'oauth-dispatch' || saved.generation !== fence.generation) throw new ProvisionFailure('provision_fenced');
        current = saved;
        return saved;
      },
      checkpoint: async (patch) => {
        const fence = await readCurrent();
        if (!await storage(() => this.store.update(identity, patch, fence, tenure.id))) throw new ProvisionFailure('provision_fenced');
        const saved = await storage(() => this.store.inventory(identity));
        controller.signal.throwIfAborted();
        if (!this.isCurrentTenure(tenure) || !saved || saved.attempt_id !== attempt
          || credentialGeneration !== undefined && saved.generation !== credentialGeneration) {
          throw new ProvisionFailure('provision_fenced');
        }
        current = saved;
        // Fail closed if an old store silently ignores a required persisted field.
        if (Object.entries(patch).some(([key, value]) => saved[key as keyof ProvisionInventory] !== value)) {
          throw new ProvisionFailure('provision_storage_incompatible', true);
        }
        return saved;
      },
    };
    try {
      await context.assertCurrent();
      const patch = await untilAborted(this.adapter.step(current, context), controller.signal);
      const progressed = Object.entries(patch).some(([key, value]) => current![key as keyof ProvisionInventory] !== value);
      const now = await storage(() => this.store.now());
      await context.checkpoint({ ...patch, retry_at: patch.retry_at ?? now + (progressed ? 0 : this.pollMs) });
      if (patch.state === 'ready') await storage(() => this.store.event('account_ready', identity));
    } catch (error) {
      // Never let a late callback elect a new owner or charge another attempt/generation.
      if (!this.isCurrentTenure(tenure) || error instanceof ProvisionFailure && error.code === 'provision_fenced') return;
      let latest: ProvisionInventory;
      try { latest = await readCurrent(false); } catch { return; }
      const code = failureCode(error);
      // Terminal retry exhaustion belongs to the failure transaction. A Login callback
      // may increment generation immediately afterwards; no second write may be needed.
      await storage(() => this.store.fail(identity, code, latest, tenure.id,
        error instanceof ProvisionFailure && error.terminal));
    } finally {
      clearTimeout(deadline);
      // Retained callbacks must not outlive a successfully returned/failed adapter either.
      controller.abort(new ProvisionFailure('provision_fenced'));
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
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.clearTimers();
    const tenure = this.tenure;
    this.tenure = undefined;
    for (const { controller } of this.active.values()) controller.abort();
    this.reservationController?.abort();
    this.stopping = (async () => {
      // Pending elections clean up their own UUID. Awaiting them prevents shutdown from
      // leaking an owner whose claim completed after stop began.
      await this.ownership;
      await this.starting;
      await this.scheduling;
      await this.waitForObservations();
      await Promise.all([...this.active.values()].map(({ promise }) => promise));
      if (tenure) await this.store.releaseOwner(tenure.id);
    })();
    return this.stopping;
  }
}

function ownershipStorageFailure(error: unknown): OwnershipLoss {
  // Only trusted storage wrappers get an availability tag. Never echo an arbitrary
  // code/name/message/cause (even an allowlist-looking code can be application data).
  if (error instanceof MysqlDeadlineError) return { reason: 'storage_unavailable', storageFailure: 'deadline' };
  if (error instanceof MysqlConnectionError) return { reason: 'storage_unavailable', storageFailure: 'connection' };
  return { reason: 'storage_operation_failed' };
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
