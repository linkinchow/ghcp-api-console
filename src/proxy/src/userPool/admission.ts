import type { Awaitable } from './storage.js';
import { UserPoolError } from './config.js';

/** Late admission may have committed a hold; it must be released, never forwarded. */
export async function boundedAdmission<T>(operation: () => Awaitable<T>, signal: AbortSignal,
  cleanup: (value: T) => Promise<void>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let ended = false;
    const aborted = () => {
      if (ended) return;
      ended = true;
      reject(new UserPoolError(504, 'pool_request_timeout'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => {
      // The request can disconnect after this wrapper returns, before its deferred
      // operation starts. Do not create a hold (or join a driver queue) in that gap.
      signal.throwIfAborted();
      return operation();
    }).then(value => {
      if (ended || signal.aborted) {
        void cleanup(value).catch(() => {});
        return;
      }
      ended = true;
      resolve(value);
    }, error => {
      if (!ended) { ended = true; reject(error); }
    }).finally(() => signal.removeEventListener('abort', aborted));
  });
}
