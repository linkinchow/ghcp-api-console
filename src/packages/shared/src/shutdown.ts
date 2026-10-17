import type { Server } from 'node:http';

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;
/** Extra time for releasing storage after connections were force-closed, before a hard exit. */
const RELEASE_GRACE_MS = 5_000;

export interface GracefulShutdownOptions {
  server: Server;
  service: string;
  /** Runs as soon as shutdown starts, e.g. to stop picking up queued background work. */
  onShutdownStart?: () => void;
  /** Closes storage and background workers once HTTP requests have drained. */
  release?: () => void | Promise<void>;
  /** How long in-flight requests (including SSE streams) may run before connections are closed. */
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
  /** Injected by tests; defaults to process.exit. */
  exit?: (code: number) => void;
}

export interface GracefulShutdown {
  /** Runs the same sequence a signal would; resolves after `exit` was called. */
  shutdown(reason: string): Promise<void>;
  /** Removes the signal handlers (tests that start several servers). */
  dispose(): void;
}

/** Reads SHUTDOWN_TIMEOUT_MS; keep it below the orchestrator's grace period minus any preStop delay. */
export function readShutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`SHUTDOWN_TIMEOUT_MS must be a non-negative integer number of milliseconds, got "${raw}".`);
  }
  return value;
}

/**
 * On SIGTERM/SIGINT: stop accepting connections, let in-flight requests finish, then release
 * resources and exit 0. Requests still running after `timeoutMs` have their connections closed.
 * A second signal, or a release that hangs, exits 1 immediately so the process never lingers
 * until the orchestrator sends SIGKILL.
 */
export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
  const { server, service, onShutdownStart, release } = options;
  const timeoutMs = options.timeoutMs ?? readShutdownTimeoutMs();
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let running: Promise<void> | undefined;

  const run = async (reason: string): Promise<void> => {
    console.log(`[${service}] ${reason} received, draining in-flight requests (up to ${timeoutMs} ms)`);
    try {
      onShutdownStart?.();
    } catch (error) {
      console.error(`[${service}] shutdown start hook failed`, error);
    }
    const drainTimer = setTimeout(() => {
      console.warn(`[${service}] requests still running after ${timeoutMs} ms; closing their connections`);
      server.closeAllConnections();
    }, timeoutMs);
    const hardExitTimer = setTimeout(() => {
      console.error(`[${service}] shutdown did not finish in time; exiting`);
      exit(1);
    }, timeoutMs + RELEASE_GRACE_MS);
    drainTimer.unref();
    hardExitTimer.unref();

    let exitCode = 0;
    try {
      await closeServer(server);
    } catch (error) {
      console.error(`[${service}] failed to close HTTP server`, error);
      exitCode = 1;
    } finally {
      clearTimeout(drainTimer);
    }
    try {
      await release?.();
    } catch (error) {
      console.error(`[${service}] failed to release resources`, error);
      exitCode = 1;
    }
    clearTimeout(hardExitTimer);
    console.log(`[${service}] shutdown complete`);
    exit(exitCode);
  };

  const shutdown = (reason: string): Promise<void> => {
    if (running) {
      console.log(`[${service}] ${reason} received again; exiting now`);
      exit(1);
      return running;
    }
    running = run(reason);
    return running;
  };

  const handlers = signals.map((signal) => {
    const handler = () => { void shutdown(signal); };
    process.on(signal, handler);
    return [signal, handler] as const;
  });

  return {
    shutdown,
    dispose: () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
