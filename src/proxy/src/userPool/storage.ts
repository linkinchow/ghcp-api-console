import type { Inventory, UserPoolStore } from './store.js';

export type Awaitable<T> = T | Promise<T>;

/** SQLite completes locally; callers must also support remote, asynchronous stores. */
export type PoolStore = {
  [K in keyof UserPoolStore]: UserPoolStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Awaitable<R> : UserPoolStore[K];
};

export type WorkerCredentialMutation =
  | { type: 'link'; ghLogin: string }
  | { type: 'begin'; oauthAttemptId: string }
  | { type: 'invalidate'; expectedToken: string };

export type WorkerCredentialFence = Pick<Inventory, 'attempt_id' | 'generation' | 'stage'>;
