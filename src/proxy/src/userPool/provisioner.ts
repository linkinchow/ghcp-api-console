import { randomUUID } from 'node:crypto';
import {
  INTERNAL_AUTH_HEADER,
  type SsoUserLoginCredentialsResponse,
  type LoginTaskDto,
  type PageResponse,
  type SsoUserDto,
} from '@ghcp/shared';
import { config } from '../config.js';
import type { getAccount, beginCopilotOauthAuthorization, invalidateCopilotOauthToken } from '../db/accountsRepo.js';
import {
  prepareCopilotRequest,
  executePreparedCopilotRequest,
  resolveCopilotModel,
  CopilotModelPathError,
  CopilotApiError,
  type CopilotApiPath,
  type ResolvedCopilotModel,
} from '../copilot/copilotClient.js';
import { getStorage } from '../db/connection.js';
import type { CreateAccountInput, ProxyAccountRecord } from '../db/storageTypes.js';
import type { PoolConfig } from './config.js';
import type { Inventory } from './store.js';
import type { Awaitable, PoolStore, WorkerCredentialMutation } from './storage.js';

/** Separate aliases keep the adapter contract readable without duplicating the persisted schema. */
export type ProvisionInventory = Inventory;
export type ProvisionPatch = Partial<ProvisionInventory>;

export class ProvisionFailure extends Error {
  readonly code: string;

  constructor(code: string, readonly terminal = false) {
    // Never persist arbitrary service messages, which can contain credentials or task logs.
    const safeCode = /^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : 'service_unavailable';
    super(safeCode);
    this.name = 'ProvisionFailure';
    this.code = safeCode;
  }
}

export interface ProvisionContext {
  signal: AbortSignal;
  assertCurrent(): Awaitable<void>;
  /** Fence a warmup against credential writes, including ABA token replacement. */
  pinCredentials(): Awaitable<void>;
  /** Legacy injected test adapters only; production invalidation updates its pin atomically. */
  credentialsInvalidated?(): Awaitable<void>;
  /** The worker applies owner/attempt/stage/generation checks in the credential transaction. */
  mutateCredentials?(mutation: WorkerCredentialMutation): Awaitable<boolean>;
  claimLoginDispatch?(limit: number): Awaitable<ProvisionInventory | undefined>;
  checkpoint(patch: ProvisionPatch): Awaitable<ProvisionInventory>;
}

export type LoginReservationContext = Pick<ProvisionContext, 'signal' | 'assertCurrent'>;
export type LoginReservationOutcome = 'success' | 'failed';

export interface ProvisionAdapter {
  readonly stepTimeoutMs?: number;
  step(row: ProvisionInventory, context: ProvisionContext): Promise<ProvisionPatch>;
  /** Observe only: never retry, cancel, begin OAuth, warm up, or modify credentials. */
  reconcileLoginReservation?(row: ProvisionInventory, context: LoginReservationContext): Promise<LoginReservationOutcome | undefined>;
}

interface ProvisionDependencies {
  fetch: typeof fetch;
  getAccount: typeof getAccount;
  createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord>;
  beginAuthorization: typeof beginCopilotOauthAuthorization;
  invalidateToken: typeof invalidateCopilotOauthToken;
  resolveModel: typeof resolveCopilotModel;
  executeRequest: typeof executePreparedCopilotRequest;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const LOGIN_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TASK_PAGES = 10;

export function realProvisioner(
  store: Pick<PoolStore, 'now'>,
  options: PoolConfig,
  dependencies: Partial<ProvisionDependencies> = {},
): ProvisionAdapter {
  const deps = {
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    // Reads may use either storage driver. Production writes use the atomic context.
    getAccount: (identity: string) => getStorage().getAccount(identity),
    resolveModel: resolveCopilotModel,
    executeRequest: executePreparedCopilotRequest,
    ...dependencies,
  };
  const email = (row: ProvisionInventory) => `${row.identity}@${options.accountDomain}`;

  async function mutate(row: ProvisionInventory, context: ProvisionContext, mutation: WorkerCredentialMutation): Promise<boolean> {
    await context.assertCurrent();
    if (context.mutateCredentials) {
      if (!await context.mutateCredentials(mutation)) throw new ProvisionFailure('provision_fenced');
      return true;
    }
    // Only explicitly injected test dependencies may use the old non-atomic fixture API.
    // Missing mutation support must never silently fall through to a real repository write.
    if (mutation.type === 'link' && dependencies.createAccount) {
      await dependencies.createAccount({ identity: row.identity, ssoUser: row.identity, ghLogin: mutation.ghLogin });
      return true;
    }
    if (mutation.type === 'begin' && dependencies.beginAuthorization) {
      if (!await dependencies.beginAuthorization(row.identity, mutation.oauthAttemptId)) {
        throw new ProvisionFailure('proxy_identity_changed', true);
      }
      return true;
    }
    if (mutation.type === 'invalidate' && dependencies.invalidateToken) {
      const invalidated = await dependencies.invalidateToken(row.identity, mutation.expectedToken, 'expired');
      if (invalidated) await context.credentialsInvalidated?.();
      return invalidated;
    }
    throw new ProvisionFailure('provision_storage_incompatible', true);
  }

  async function request<T>(
    context: LoginReservationContext,
    service: 'sso' | 'login',
    path: string,
    body?: unknown,
  ): Promise<T> {
    await context.assertCurrent();
    const baseUrl = service === 'sso' ? config.ssoBaseUrl : config.loginBaseUrl;
    const response = await deps.fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        [INTERNAL_AUTH_HEADER]: config.internalApiToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: context.signal,
      redirect: 'error',
    });
    try {
      await context.assertCurrent();
      if (!response.ok) throw new ProvisionFailure(`${service}_http_${response.status}`);
      const body = await readJson(response, context.signal);
      await context.assertCurrent();
      return body as T;
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
  }

  function checkUser(row: ProvisionInventory, user: SsoUserDto, creating = false): SsoUserDto {
    if (!user || user.ssoUser !== row.identity || user.email !== email(row) || user.role !== 'user'
      || !Number.isFinite(Date.parse(user.createdAt))) {
      throw new ProvisionFailure(creating ? 'sso_creation_ambiguous' : 'sso_identity_changed', true);
    }
    if (!creating && (!row.sso_created_at || user.createdAt !== row.sso_created_at)) {
      throw new ProvisionFailure('sso_identity_changed', true);
    }
    return user;
  }

  async function knownUser(row: ProvisionInventory, context: ProvisionContext): Promise<SsoUserDto> {
    return checkUser(row, await request<SsoUserDto>(context, 'sso', `/api/users/${encodeURIComponent(row.identity)}`));
  }

  function checkEntitlement(user: SsoUserDto): void {
    if (user.emuStatus !== 'active' || !user.ghLogin || !user.ghScimId || user.copilotSeatStatus !== 'assigned') {
      throw new ProvisionFailure('entitlement_not_ready');
    }
  }

  async function accountFor(row: ProvisionInventory, context: LoginReservationContext, user?: SsoUserDto): Promise<ProxyAccountRecord> {
    await context.assertCurrent();
    const account = await deps.getAccount(row.identity);
    await context.assertCurrent();
    if (!account || account.identity !== row.identity || account.ssoUser !== row.identity
      || user && account.ghLogin && account.ghLogin !== user.ghLogin) {
      throw new ProvisionFailure('proxy_identity_changed', true);
    }
    return account;
  }

  function checkTask(row: ProvisionInventory, task: LoginTaskDto, ghLogin: string): LoginTaskDto {
    if (!task || !task.id || row.task_id && task.id !== row.task_id
      || task.identity !== row.identity || task.ssoUser !== row.identity
      || task.ghLogin !== ghLogin || task.oauthAttemptId !== row.oauth_attempt_id || task.ssoType !== 'custom') {
      throw new ProvisionFailure('oauth_task_mismatch', true);
    }
    return task;
  }

  async function findTask(row: ProvisionInventory, context: LoginReservationContext, ghLogin: string): Promise<LoginTaskDto | undefined> {
    let found: LoginTaskDto | undefined;
    for (let page = 1; page <= MAX_TASK_PAGES; page++) {
      const result = await request<PageResponse<LoginTaskDto>>(context, 'login',
        `/api/tasks?q=${encodeURIComponent(row.identity)}&page=${page}&pageSize=100`);
      if (!Array.isArray(result.items) || !Number.isSafeInteger(result.total) || result.total < 0) {
        throw new ProvisionFailure('oauth_task_list_invalid');
      }
      for (const task of result.items) {
        if (task.identity !== row.identity || task.oauthAttemptId !== row.oauth_attempt_id) continue;
        checkTask(row, task, ghLogin);
        if (found && found.id !== task.id) throw new ProvisionFailure('oauth_dispatch_ambiguous', true);
        found = task;
      }
      if (page * 100 >= result.total) return found;
    }
    throw new ProvisionFailure('oauth_task_search_limit', true);
  }

  async function step(row: ProvisionInventory, context: ProvisionContext): Promise<ProvisionPatch> {
    await context.assertCurrent();
    if (row.stage === 'new') {
      try {
        await request(context, 'sso', `/api/users/${encodeURIComponent(row.identity)}`);
        throw new ProvisionFailure('sso_name_conflict', true);
      } catch (error) {
        if (!(error instanceof ProvisionFailure && error.code === 'sso_http_404')) throw error;
      }
      // POST /users has no idempotency key. A crash from this point requires manual
      // reconciliation, even if a later GET happens to find the expected name/email.
      row = await context.checkpoint({ stage: 'sso-creating', sso_created_at: null });
      try {
        const user = checkUser(row, await request<SsoUserDto>(context, 'sso', '/api/users', {
          ssoUser: row.identity, email: email(row), role: 'user', poolManaged: true,
        }), true);
        return { stage: 'sso-created', sso_created_at: user.createdAt };
      } catch {
        context.signal.throwIfAborted();
        throw new ProvisionFailure('sso_creation_ambiguous', true);
      }
    }
    if (row.stage === 'sso-creating') throw new ProvisionFailure('sso_creation_ambiguous', true);

    if (row.stage === 'sso-created' || row.stage === 'scim-syncing') {
      const existing = await knownUser(row, context);
      if (existing.emuStatus === 'active' && existing.ghLogin && existing.ghScimId) return { stage: 'scim-synced' };
      // Never replay a timed-out side effect while the SSO service may still be doing it.
      if (row.stage === 'scim-syncing') throw new ProvisionFailure('scim_sync_unconfirmed');
      row = await context.checkpoint({ stage: 'scim-syncing' });
      const result = await request<{ rows: { ssoUser: string; status: string; user?: SsoUserDto }[] }>(
        context, 'sso', '/api/users/batch', {
          operation: 'sync_emu', ssoUsers: [row.identity], assignCopilotSeat: false, createOnly: true,
        });
      const item = result.rows?.[0];
      if (result.rows?.length !== 1 || item?.ssoUser !== row.identity || item.status !== 'success' || !item.user) {
        throw new ProvisionFailure('scim_sync_unconfirmed');
      }
      const user = checkUser(row, item.user);
      if (user.emuStatus !== 'active' || !user.ghLogin || !user.ghScimId) throw new ProvisionFailure('scim_sync_unconfirmed');
      return { stage: 'scim-synced' };
    }

    if (row.stage === 'scim-synced' || row.stage === 'seat-assigning') {
      let user = await knownUser(row, context);
      if (user.emuStatus !== 'active' || !user.ghLogin || !user.ghScimId) throw new ProvisionFailure('scim_not_ready');
      if (user.copilotSeatStatus !== 'assigned') {
        if (row.stage === 'seat-assigning') throw new ProvisionFailure('seat_assignment_unconfirmed');
        row = await context.checkpoint({ stage: 'seat-assigning' });
        user = checkUser(row, await request<SsoUserDto>(context, 'sso',
          `/api/users/${encodeURIComponent(row.identity)}/copilot-seat`, {}));
      }
      checkEntitlement(user);
      await accountFor(row, context, user);
      await context.assertCurrent();
      await mutate(row, context, { type: 'link', ghLogin: user.ghLogin! });
      await context.assertCurrent();
      return { stage: 'synced' };
    }

    if (row.stage === 'synced') {
      const user = await knownUser(row, context);
      checkEntitlement(user);
      await accountFor(row, context, user);
      // A worker attempt fences inventory; a separate nonce fences the Login callback.
      return { stage: 'oauth-starting', oauth_attempt_id: randomUUID(), task_id: null };
    }

    if (row.stage === 'oauth-starting') {
      if (!row.oauth_attempt_id) throw new ProvisionFailure('oauth_attempt_missing', true);
      const user = await knownUser(row, context);
      checkEntitlement(user);
      const account = await accountFor(row, context, user);
      const credentials = await request<SsoUserLoginCredentialsResponse>(context, 'sso',
        `/api/users/${encodeURIComponent(row.identity)}/login-credentials`, {
          expectedCreatedAt: row.sso_created_at, expectedEmail: email(row),
        });
      checkUser(row, credentials.user);
      if (!credentials.passwordForLogin) throw new ProvisionFailure('sso_password_unavailable', true);
      if (account.copilotOauthAttemptId !== row.oauth_attempt_id || account.copilotOauthStatus !== 'refreshing') {
        await mutate(row, context, { type: 'begin', oauthAttemptId: row.oauth_attempt_id });
      }
      // Persist before POST, never after. Recovery only searches; the Login API does
      // not deduplicate POSTs carrying the same oauthAttemptId.
      if (context.claimLoginDispatch) {
        const admitted = await context.claimLoginDispatch(options.loginMaxPending ?? 5);
        if (!admitted) return {};
        row = admitted;
      } else {
        if (context.mutateCredentials) throw new ProvisionFailure('provision_storage_incompatible', true);
        row = await context.checkpoint({ stage: 'oauth-dispatch' });
      }
      const task = checkTask(row, await request<LoginTaskDto>(context, 'login', '/api/tasks', {
        identity: row.identity, ssoUser: row.identity, ghLogin: user.ghLogin,
        ssoPassword: credentials.passwordForLogin, oauthAttemptId: row.oauth_attempt_id, ssoType: 'custom',
      }), user.ghLogin!);
      return { stage: 'oauth-wait', task_id: task.id };
    }

    if (row.stage === 'oauth-dispatch' || row.stage === 'oauth-wait') {
      if (!row.oauth_attempt_id) throw new ProvisionFailure('oauth_attempt_missing', true);
      const user = await knownUser(row, context);
      checkEntitlement(user);
      const task = row.task_id
        ? checkTask(row, await request<LoginTaskDto>(context, 'login', `/api/tasks/${encodeURIComponent(row.task_id)}`), user.ghLogin!)
        : await findTask(row, context, user.ghLogin!);
      // A bounded read-only retry allows an accepted POST to become visible. It must
      // never convert an uncertain dispatch into a new OAuth attempt.
      if (!task) throw new ProvisionFailure('oauth_dispatch_unconfirmed');
      const createdAt = Date.parse(task.createdAt);
      const now = await store.now();
      if (!Number.isFinite(createdAt) || createdAt > now + 60000) throw new ProvisionFailure('oauth_task_invalid', true);
      if (row.stage === 'oauth-dispatch') return { stage: 'oauth-wait', task_id: task.id };
      if (task.status === 'cancelled') throw new ProvisionFailure('oauth_task_cancelled_unconfirmed', true);
      if (task.status === 'failed') {
        await context.checkpoint({ stage: 'synced', task_id: null, oauth_attempt_id: null });
        throw new ProvisionFailure('oauth_login_failed');
      }
      if (task.status === 'success') {
        const account = await accountFor(row, context, user);
        if (account.copilotOauthStatus !== 'valid' || !account.copilotOauthToken || account.copilotOauthAttemptId) {
          throw new ProvisionFailure('oauth_callback_unconfirmed');
        }
        return { stage: 'warmup' };
      }
      if (now - createdAt >= LOGIN_TASK_TIMEOUT_MS) {
        // Login cancellation only marks its DB row, it does not stop Playwright. Do not
        // create a concurrent replacement for a stalled task or reset its stage.
        throw new ProvisionFailure('oauth_task_stalled', true);
      }
      if (!['pending', 'running'].includes(task.status)) throw new ProvisionFailure('oauth_task_invalid', true);
      return {};
    }

    if (row.stage === 'warmup' || row.stage === 'ready') {
      const user = await knownUser(row, context);
      checkEntitlement(user);
      await context.pinCredentials();
      const account = await accountFor(row, context, user);
      if (!account.copilotOauthToken || account.copilotOauthStatus !== 'valid') {
        await context.checkpoint({ stage: 'synced', task_id: null, oauth_attempt_id: null });
        throw new ProvisionFailure('credential_not_valid');
      }
      const auth = { identity: account.identity, accessToken: account.copilotOauthToken, api: config.copilotApiBaseUrl };
      let resolved: ResolvedCopilotModel | undefined;
      let path: CopilotApiPath = '/v1/messages';
      for (const candidate of ['/v1/messages', '/chat/completions', '/responses'] as const) {
        try {
          resolved = await deps.resolveModel(auth, candidate, options.warmupModel, undefined, context.signal);
          path = candidate;
          break;
        } catch (error) {
          if (error instanceof CopilotApiError && error.status === 401) {
            await context.checkpoint({ stage: 'synced', task_id: null, oauth_attempt_id: null });
            await mutate(row, context, { type: 'invalidate', expectedToken: account.copilotOauthToken });
            throw new ProvisionFailure('warmup_http_401');
          }
          if (!(error instanceof CopilotModelPathError)) throw error;
        }
      }
      if (!resolved) throw new ProvisionFailure('warmup_model_unavailable');
      await context.assertCurrent();
      const prepared = prepareCopilotRequest(auth, path, {
        model: resolved.upstreamId, stream: false,
        ...(path === '/responses'
          ? { input: 'Reply OK', max_output_tokens: 16 }
          : { messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 16 }),
      });
      const response = await deps.executeRequest(prepared, context.signal);
      try {
        await context.assertCurrent();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401) {
          await context.checkpoint({ stage: 'synced', task_id: null, oauth_attempt_id: null });
          await mutate(row, context, { type: 'invalidate', expectedToken: account.copilotOauthToken });
        }
        throw new ProvisionFailure(`warmup_http_${response.status}`);
      }
      const body = await readJson(response, context.signal);
      if (!validWarmupResponse(body, path)) throw new ProvisionFailure('warmup_invalid_response');
      const latest = await accountFor(row, context, user);
      if (latest.copilotOauthStatus !== 'valid' || latest.copilotOauthToken !== account.copilotOauthToken
        || latest.copilotOauthUpdatedAt !== account.copilotOauthUpdatedAt) {
        throw new ProvisionFailure('warmup_credential_changed');
      }
      await context.assertCurrent();
      return { stage: 'ready', state: 'ready', last_error: null, verified_at: await store.now(), attempts: 0, retry_at: 0 };
    }
    throw new ProvisionFailure('unknown_provision_stage', true);
  }

  return {
    stepTimeoutMs: options.requestTimeoutMs,
    async reconcileLoginReservation(row, context) {
      if (!isExhaustedLoginReservation(row) || !row.oauth_attempt_id) return undefined;
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.requestTimeoutMs)]);
      const observation: LoginReservationContext = {
        signal,
        assertCurrent: async () => { signal.throwIfAborted(); await context.assertCurrent(); signal.throwIfAborted(); },
      };
      // The persisted Proxy identity is sufficient for task ownership. Do not require
      // another SSO/entitlement call: those outages may have exhausted the poll retries.
      const account = await accountFor(row, observation);
      if (!account.ghLogin) return undefined;
      const task = row.task_id
        ? checkTask(row, await request<LoginTaskDto>(observation, 'login', `/api/tasks/${encodeURIComponent(row.task_id)}`), account.ghLogin)
        : await findTask(row, observation, account.ghLogin);
      await observation.assertCurrent();
      // cancelled is only a DB marker in Login, not proof that Playwright stopped.
      // A successful task releases capacity, not the failed/disabled retry protection.
      return task?.status === 'success' || task?.status === 'failed' ? task.status : undefined;
    },
    async step(row, context) {
      if (!context.mutateCredentials && Object.keys(dependencies).length === 0) {
        throw new ProvisionFailure('provision_storage_incompatible', true);
      }
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.requestTimeoutMs)]);
      return step(row, {
        ...context,
        signal,
        assertCurrent: async () => { signal.throwIfAborted(); await context.assertCurrent(); signal.throwIfAborted(); },
        pinCredentials: async () => { signal.throwIfAborted(); await context.pinCredentials(); signal.throwIfAborted(); },
        mutateCredentials: context.mutateCredentials && (async (mutation) => {
          signal.throwIfAborted();
          const result = await context.mutateCredentials!(mutation);
          signal.throwIfAborted();
          return result;
        }),
        checkpoint: async (patch) => {
          signal.throwIfAborted();
          const saved = await context.checkpoint(patch);
          signal.throwIfAborted();
          return saved;
        },
      });
    },
  };
}

export function isExhaustedLoginReservation(row: ProvisionInventory): boolean {
  return (row.stage === 'oauth-dispatch' || row.stage === 'oauth-wait')
    && (row.state === 'disabled' || row.state === 'failed' && row.attempts >= 3);
}

function validWarmupResponse(value: unknown, path: CopilotApiPath): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.error) return false;
  const nonempty = (text: unknown): boolean => typeof text === 'string' && Boolean(text.trim());
  if (path === '/chat/completions') {
    return Array.isArray(body.choices) && body.choices.some((choice) => choice?.message?.role === 'assistant' && nonempty(choice.message.content));
  }
  if (path === '/responses') {
    return body.status === 'completed' && Array.isArray(body.output) && body.output.some((item) =>
      item?.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)
      && item.content.some((part: Record<string, unknown>) => part?.type === 'output_text' && nonempty(part.text)));
  }
  return body.type === 'message' && body.role === 'assistant' && Array.isArray(body.content)
    && body.content.some((item) => item?.type === 'text' && nonempty(item.text));
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ProvisionFailure('service_invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ProvisionFailure('service_response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof SyntaxError) throw new ProvisionFailure('service_invalid_json');
    throw error;
  } finally {
    signal.removeEventListener('abort', aborted);
    reader.releaseLock();
  }
}
