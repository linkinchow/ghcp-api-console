import { NAME_CAPACITY } from './names.js';

export interface PoolConfig {
  enabled: boolean;
  /** Legacy configuration only. Caller identities are authenticated key hashes, not emails. */
  callerDomain?: string;
  accountDomain: string;
  idleTarget: number;
  maxAccounts: number;
  leaseSeconds: number;
  provisionalSeconds: number;
  pollMs: number;
  prewarmConcurrency?: number;
  retryAfterSeconds: number;
  warmupModel: string;
  requestTimeoutMs: number;
}

export function readPoolConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const mode = env.ACCOUNT_ROUTING_MODE ?? 'direct';
  if (!['direct', 'caller-lease'].includes(mode)) throw new Error('Invalid ACCOUNT_ROUTING_MODE');

  const defaults: PoolConfig = {
    enabled: mode === 'caller-lease',
    accountDomain: '',
    idleTarget: 10,
    maxAccounts: 100,
    leaseSeconds: 172800,
    provisionalSeconds: 300,
    pollMs: 5000,
    prewarmConcurrency: 5,
    retryAfterSeconds: 30,
    warmupModel: '',
    requestTimeoutMs: 120000,
  };
  // In direct mode, even stale/invalid pool-only environment variables have no effect.
  if (!defaults.enabled) return defaults;
  if ((env.STORAGE_DRIVER ?? 'sqlite') !== 'sqlite') {
    throw new Error('Caller lease mode requires single-instance SQLite');
  }

  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = env[key];
    if (raw !== undefined && (!/^\d+$/.test(raw) || raw.trim() !== raw)) throw new Error(`Invalid ${key}`);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const accountDomain = (env.POOL_ACCOUNT_EMAIL_DOMAIN ?? '').trim().toLowerCase();
  const labels = accountDomain.split('.');
  if (accountDomain.length > 253 || labels.length < 2
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z]{2,63}$/.test(labels.at(-1)!)) {
    throw new Error('POOL_ACCOUNT_EMAIL_DOMAIN must be an email domain');
  }
  const idleTarget = integer('READY_IDLE_TARGET', defaults.idleTarget, 0, NAME_CAPACITY);
  const maxAccounts = integer('POOL_MAX_ACCOUNTS', defaults.maxAccounts, 1, NAME_CAPACITY);
  if (idleTarget > maxAccounts) throw new Error('Idle target exceeds pool account cap');
  const warmupModel = env.POOL_WARMUP_MODEL?.trim() ?? '';
  if (!warmupModel) throw new Error('POOL_WARMUP_MODEL is required in caller-lease mode');

  return {
    ...defaults,
    accountDomain,
    idleTarget,
    maxAccounts,
    warmupModel,
    leaseSeconds: integer('CALLER_LEASE_TTL_SECONDS', defaults.leaseSeconds, 60, 2592000),
    provisionalSeconds: integer('PROVISIONAL_LEASE_TTL_SECONDS', defaults.provisionalSeconds, 10, 3600),
    pollMs: integer('PREWARM_POLL_SECONDS', defaults.pollMs / 1000, 1, 3600) * 1000,
    prewarmConcurrency: integer('PREWARM_CONCURRENCY', defaults.prewarmConcurrency!, 1, 20),
    retryAfterSeconds: integer('POOL_EXHAUSTED_RETRY_AFTER_SECONDS', defaults.retryAfterSeconds, 1, 3600),
    requestTimeoutMs: integer('POOL_REQUEST_TIMEOUT_SECONDS', defaults.requestTimeoutMs / 1000, 5, 600) * 1000,
  };
}

export class UserPoolError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter = 0) {
    super(code);
    this.name = 'UserPoolError';
  }
}

/** Validate the exact wire format; never lowercase, trim, hash, or alias untrusted input. */
export function normalizeCaller(value: string, _legacyDomain?: string): string {
  if (typeof value !== 'string' || value.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new UserPoolError(403, 'invalid_caller_identity');
  }
  return value;
}
