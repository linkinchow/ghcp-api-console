import { randomUUID } from 'node:crypto';
import {
  INTERNAL_AUTH_HEADER,
  type SsoUserLoginCredentialsResponse,
  type LoginTaskDto,
  type PageResponse,
  type SsoUserDto,
} from '@ghcp/shared';
import { config } from '../config.js';
import { loadProxyEnterpriseProfile, loadProxyEnterpriseRegistry } from '../enterprise.js';
import { probeEnterpriseCreationCapacity, probeEnterpriseReadiness } from '../clients/enterpriseReadiness.js';
import type { EnterpriseProfileV3 } from '@ghcp/shared';
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
  assertCanAdvance?(): Awaitable<void>;
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
  eligibleEnterprises?(signal: AbortSignal, owner: string): Promise<readonly string[]>;
  step(row: ProvisionInventory, context: ProvisionContext): Promise<ProvisionPatch>;
  /** Observe only: never retry, cancel, begin OAuth, warm up, or modify credentials. */
  reconcileLoginReservation?(row: ProvisionInventory, context: LoginReservationContext): Promise<LoginReservationOutcome | undefined>;
}

interface ProvisionDependencies {
  enterpriseProfile: (enterpriseId: string) => EnterpriseProfileV3;
  verifyReadiness: (profile: EnterpriseProfileV3, signal: AbortSignal) => Promise<void>;
  creationCapacity: (profile: EnterpriseProfileV3, signal: AbortSignal) => Promise<boolean>;
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
  store: Pick<PoolStore, 'now'> & Partial<Pick<PoolStore, 'enterprisePolicies'>>,
  options: PoolConfig,
  dependencies: Partial<ProvisionDependencies> = {},
): ProvisionAdapter {
  const deps = {
    enterpriseProfile: loadProxyEnterpriseProfile,
    verifyReadiness: async (profile: EnterpriseProfileV3, signal: AbortSignal) => {
      await probeEnterpriseReadiness(loadProxyEnterpriseRegistry(), profile.id, config.internalApiToken, { signal });
    },
    creationCapacity: (profile: EnterpriseProfileV3, signal: AbortSignal) => probeEnterpriseCreationCapacity(
      profile, config.internalApiToken, { signal, fetch: dependencies.fetch }),
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    // Reads may use either storage driver. Production writes use the atomic context.
    getAccount: (identity: string, enterpriseId?: string) => getStorage().getAccount(identity, enterpriseId),
    resolveModel: resolveCopilotModel,
    executeRequest: executePreparedCopilotRequest,
    ...dependencies,
  };
  const profileFor = (row: ProvisionInventory): EnterpriseProfileV3 => {
    if (!row.enterprise_id || !row.enterprise_revision) throw new ProvisionFailure('enterprise_scope_missing', true);
    const profile = deps.enterpriseProfile(row.enterprise_id);
    if (profile.id !== row.enterprise_id || profile.revision !== row.enterprise_revision) {
      throw new ProvisionFailure('enterprise_scope_mismatch', true);
    }
    return profile;
  };
  const email = (row: ProvisionInventory) => `${row.identity}@${profileFor(row).accountDomain}`;
  const readiness = new Map<string, number>();
  let readinessOwner: string | undefined;
  let readinessOffset = 0;
  async function readyForCreation(signal: AbortSignal, owner: string): Promise<readonly string[]> {
    signal.throwIfAborted();
    if (readinessOwner !== owner) { readiness.clear(); readinessOffset = 0; readinessOwner = owner; }
    // The scan deadline is separate from owner cancellation: a slow peer must not
    // erase successful peers. The worker retains an outer watchdog for bad adapters.
    const scan = new AbortController();
    const scanSignal = AbortSignal.any([signal, scan.signal]);
    const deadline = setTimeout(() => scan.abort(), Math.min(options.requestTimeoutMs, 4000));
    deadline.unref();
    const eligible: string[] = [];
    try {
      const policies = await untilSignal(Promise.resolve(store.enterprisePolicies!()), scanSignal);
      const active = policies.filter(policy => policy.state === 'active');
      const offset = active.length ? readinessOffset % active.length : 0;
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(4, active.length) }, async () => {
        while (index < active.length && !scanSignal.aborted) {
          const policy = active[(offset + index++) % active.length]!;
          // A bounded scan must not starve healthy profiles behind a hung prefix.
          // Advance only this owner's cursor; scheduling scores remain unchanged.
          if (readinessOwner === owner) readinessOffset = (offset + index) % active.length;
          const probe = new AbortController();
          const probeSignal = AbortSignal.any([scanSignal, probe.signal]);
          const timeout = setTimeout(() => probe.abort(), Math.min(options.requestTimeoutMs, 1000));
          timeout.unref();
          try {
            const profile = deps.enterpriseProfile(policy.enterpriseId);
            if (profile.login.provider !== 'custom') continue;
            if ((readiness.get(profile.id) ?? 0) <= performance.now()) {
              await untilSignal(deps.verifyReadiness(profile, probeSignal), probeSignal);
              probeSignal.throwIfAborted();
              if (readinessOwner !== owner) continue;
              readiness.set(profile.id, performance.now() + 15000);
            }
            // Capacity is deliberately not cached with readiness. Direct SSO users
            // can consume it without any pool policy/evidence change.
            if (await untilSignal(deps.creationCapacity(profile, probeSignal), probeSignal)) {
              probeSignal.throwIfAborted();
              if (readinessOwner === owner) eligible.push(profile.id);
            }
          } catch {
            // Failed/timed-out profiles are not candidates; healthy peers survive.
          } finally { clearTimeout(timeout); probe.abort(); }
        }
      }));
    } catch {
      // An unavailable policy list has no eligible profiles; a scan timeout keeps
      // only already completed, identity-checked probes, never late completions.
    } finally { clearTimeout(deadline); scan.abort(); }
    signal.throwIfAborted();
    return readinessOwner === owner ? eligible : [];
  }
  async function assertDispatch(row: ProvisionInventory, context: ProvisionContext): Promise<void> {
    await context.assertCurrent();
    await context.assertCanAdvance?.();
    const profile = profileFor(row);
    if (profile.login.provider !== 'custom') throw new ProvisionFailure('pool_provider_unsupported', true);
    if ((readiness.get(profile.id) ?? 0) <= performance.now()) {
      try { await deps.verifyReadiness(profile, context.signal); }
      catch { throw new ProvisionFailure('enterprise_readiness_unavailable'); }
      readiness.set(profile.id, performance.now() + 15000);
    }
    await context.assertCurrent();
    await context.assertCanAdvance?.();
  }

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
    row: ProvisionInventory,
    context: LoginReservationContext,
    service: 'sso' | 'login',
    path: string,
    body?: unknown,
  ): Promise<T> {
    await context.assertCurrent();
    const profile=profileFor(row);
    const baseUrl=service==='sso'?profile.routes.ssoInternalUrl:profile.routes.loginInternalUrl;
    const scopedPath=path.replace(/^\/api(?=\/)/,`/api/profiles/${encodeURIComponent(profile.id)}`);
    const response = await deps.fetch(`${baseUrl.replace(/\/+$/, '')}${scopedPath}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        [INTERNAL_AUTH_HEADER]: config.internalApiToken,
        'x-enterprise-id':profile.id,
        'x-enterprise-revision':String(profile.revision),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: context.signal,
      redirect: 'error',
    });
    try {
      await context.assertCurrent();
      if (!response.ok) {
        // Only this authoritative rejection proves POST /users did not create a
        // user. Unknown/non-JSON/redirected responses remain ambiguous.
        if (service === 'sso' && path === '/api/users' && body !== undefined
          && response.status === 409 && !response.redirected) {
          const rejection = await readJson(response, context.signal) as { error?: { code?: unknown } } | null;
          await context.assertCurrent();
          if (rejection?.error?.code === 'sso_user_limit_reached') throw new ProvisionFailure('sso_user_limit_reached');
        }
        throw new ProvisionFailure(`${service}_http_${response.status}`);
      }
      if (response.redirected) throw new ProvisionFailure('service_invalid_response');
      const payload = await readJson(response, context.signal);
      await context.assertCurrent();
      return payload as T;
    } catch (error) {
      void response.body?.cancel().catch(() => {});
      throw error;
    }
  }

  function checkUser(row: ProvisionInventory, user: SsoUserDto, creating = false): SsoUserDto {
    if (!user || user.enterpriseId !== row.enterprise_id || !user.userIncarnation
      || user.ssoUser !== row.identity || user.email !== email(row) || user.role !== 'user'
      || !Number.isFinite(Date.parse(user.createdAt))) {
      throw new ProvisionFailure(creating ? 'sso_creation_ambiguous' : 'sso_identity_changed', true);
    }
    if (!creating && (!row.sso_created_at || user.createdAt !== row.sso_created_at)) {
      throw new ProvisionFailure('sso_identity_changed', true);
    }
    return user;
  }

  async function knownUser(row: ProvisionInventory, context: ProvisionContext): Promise<SsoUserDto> {
    return checkUser(row, await request<SsoUserDto>(row, context, 'sso', `/api/users/${encodeURIComponent(row.identity)}`));
  }

  function checkEntitlement(user: SsoUserDto): void {
    if (user.emuStatus !== 'active' || !user.ghLogin || !user.ghScimId || user.copilotSeatStatus !== 'assigned') {
      throw new ProvisionFailure('entitlement_not_ready');
    }
  }

  async function accountFor(row: ProvisionInventory, context: LoginReservationContext, user?: SsoUserDto): Promise<ProxyAccountRecord> {
    await context.assertCurrent();
    const account = await deps.getAccount(row.identity, row.enterprise_id);
    await context.assertCurrent();
    if (!account || account.identity !== row.identity || account.ssoUser !== row.identity
      || account.enterpriseId !== profileFor(row).id
      || user && account.ghLogin && account.ghLogin !== user.ghLogin) {
      throw new ProvisionFailure('proxy_identity_changed', true);
    }
    return account;
  }

  function checkTask(row: ProvisionInventory, task: LoginTaskDto, ghLogin: string): LoginTaskDto {
    if (!task || !task.id || row.task_id && task.id !== row.task_id
      || task.identity !== row.identity || task.ssoUser !== row.identity
      || task.ghLogin !== ghLogin || task.oauthAttemptId !== row.oauth_attempt_id || task.ssoType !== 'custom'
      || task.enterpriseId !== profileFor(row).id || task.enterpriseRevision !== profileFor(row).revision
      || task.expectedGhLogin !== ghLogin || !task.accountIncarnation) {
      throw new ProvisionFailure('oauth_task_mismatch', true);
    }
    return task;
  }

  async function findTask(row: ProvisionInventory, context: LoginReservationContext, ghLogin: string): Promise<LoginTaskDto | undefined> {
    let found: LoginTaskDto | undefined;
    for (let page = 1; page <= MAX_TASK_PAGES; page++) {
      const result = await request<PageResponse<LoginTaskDto>>(row, context, 'login',
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
        await request(row, context, 'sso', `/api/users/${encodeURIComponent(row.identity)}`);
        throw new ProvisionFailure('sso_name_conflict', true);
      } catch (error) {
        if (!(error instanceof ProvisionFailure && error.code === 'sso_http_404')) throw error;
      }
      // POST /users has no idempotency key. A crash from this point requires manual
      // reconciliation, even if a later GET happens to find the expected name/email.
      await assertDispatch(row, context);
      row = await context.checkpoint({ stage: 'sso-creating', sso_created_at: null });
      try {
        const user = checkUser(row, await request<SsoUserDto>(row, context, 'sso', '/api/users', {
          ssoUser: row.identity, email: email(row), role: 'user', poolManaged: true,
        }), true);
        return { stage: 'sso-created', sso_created_at: user.createdAt };
      } catch (error) {
        context.signal.throwIfAborted();
        if (error instanceof ProvisionFailure && error.code === 'sso_user_limit_reached') {
          // A confirmed non-creation may retry the SAME globally reserved name
          // through operator Retry, not manual ambiguity reconciliation. Exhaust
          // automatic retries so a full SSO enterprise cannot claim logical P and
          // suppress healthy peers, or later recover beyond the global target.
          // Never delete inventory or refund ordinals.
          await context.checkpoint({ stage: 'new', sso_created_at: null });
          throw new ProvisionFailure('sso_user_limit_reached', true);
        }
        throw new ProvisionFailure('sso_creation_ambiguous', true);
      }
    }
    if (row.stage === 'sso-creating') throw new ProvisionFailure('sso_creation_ambiguous', true);

    if (row.stage === 'sso-created' || row.stage === 'scim-syncing') {
      const existing = await knownUser(row, context);
      if (existing.emuStatus === 'active' && existing.ghLogin && existing.ghScimId) return { stage: 'scim-synced' };
      // Never replay a timed-out side effect while the SSO service may still be doing it.
      if (row.stage === 'scim-syncing') throw new ProvisionFailure('scim_sync_unconfirmed');
      await assertDispatch(row, context);
      row = await context.checkpoint({ stage: 'scim-syncing' });
      const result = await request<{ rows: { ssoUser: string; status: string; user?: SsoUserDto }[] }>(
        row, context, 'sso', '/api/users/batch', {
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
        await assertDispatch(row, context);
        row = await context.checkpoint({ stage: 'seat-assigning' });
        user = checkUser(row, await request<SsoUserDto>(row, context, 'sso',
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
      await assertDispatch(row, context);
      if (!row.oauth_attempt_id) throw new ProvisionFailure('oauth_attempt_missing', true);
      const user = await knownUser(row, context);
      checkEntitlement(user);
      const account = await accountFor(row, context, user);
      const credentials = await request<SsoUserLoginCredentialsResponse>(row, context, 'sso',
        `/api/users/${encodeURIComponent(row.identity)}/login-credentials`, {
          expectedCreatedAt: row.sso_created_at, expectedEmail: email(row),
        });
      checkUser(row, credentials.user);
      if (!credentials.passwordForLogin) throw new ProvisionFailure('sso_password_unavailable', true);
      if (account.copilotOauthAttemptId !== row.oauth_attempt_id || account.copilotOauthStatus !== 'refreshing') {
        await mutate(row, context, { type: 'begin', oauthAttemptId: row.oauth_attempt_id });
      }
      // Persist dispatch before POST; recovery observes the bound attempt instead of
      // replaying a request whose external outcome is still unknown.
      if (context.claimLoginDispatch) {
        const admitted = await context.claimLoginDispatch(options.loginMaxPending ?? 5);
        if (!admitted) return {};
        row = admitted;
      } else {
        if (context.mutateCredentials) throw new ProvisionFailure('provision_storage_incompatible', true);
        row = await context.checkpoint({ stage: 'oauth-dispatch' });
      }
      const profile = profileFor(row);
      const task = checkTask(row, await request<LoginTaskDto>(row, context, 'login', '/api/tasks', {
        enterpriseId: profile.id, enterpriseRevision: profile.revision,
        identity: row.identity, ssoUser: row.identity, expectedGhLogin: user.ghLogin,
        accountIncarnation: account.accountIncarnation,
        ssoPassword: credentials.passwordForLogin, oauthAttemptId: row.oauth_attempt_id, ssoType: 'custom',
      }), user.ghLogin!);
      return { stage: 'oauth-wait', task_id: task.id };
    }

    if (row.stage === 'oauth-dispatch' || row.stage === 'oauth-wait') {
      if (!row.oauth_attempt_id) throw new ProvisionFailure('oauth_attempt_missing', true);
      const user = await knownUser(row, context);
      checkEntitlement(user);
      const task = row.task_id
        ? checkTask(row, await request<LoginTaskDto>(row, context, 'login', `/api/tasks/${encodeURIComponent(row.task_id)}`), user.ghLogin!)
        : await findTask(row, context, user.ghLogin!);
      // A bounded read-only retry allows an accepted POST to become visible. It must
      // never convert an uncertain dispatch into a new OAuth attempt.
      if (!task) throw new ProvisionFailure('oauth_dispatch_unconfirmed');
      const taskAccount=await accountFor(row,context,user);
      if (task.accountIncarnation!==taskAccount.accountIncarnation) throw new ProvisionFailure('oauth_task_mismatch',true);
      const createdAt = Date.parse(task.createdAt);
      const now = await store.now();
      if (!Number.isFinite(createdAt) || createdAt > now + 60000) throw new ProvisionFailure('oauth_task_invalid', true);
      if (task.status === 'cancelled') {
        // Contract-2 cancellation is terminal only after Proxy authority closed
        // the exact binding. Legacy task history must never release a live slot.
        if (task.bindingVersion !== 2) throw new ProvisionFailure('oauth_task_cancelled_unconfirmed', true);
        await context.checkpoint({ stage: 'synced', task_id: null, oauth_attempt_id: null });
        throw new ProvisionFailure('oauth_login_cancelled');
      }
      if (row.stage === 'oauth-dispatch') return { stage: 'oauth-wait', task_id: task.id };
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
        // Cancellation requests/uncertain closure are not terminal confirmation.
        // Never create a replacement while the authority outcome is unknown.
        throw new ProvisionFailure('oauth_task_stalled', true);
      }
      if (!['pending', 'running', 'callback_pending', 'cancel_requested', 'uncertain'].includes(task.status)) throw new ProvisionFailure('oauth_task_invalid', true);
      return {};
    }

    if (row.stage === 'warmup' || row.stage === 'ready') {
      await assertDispatch(row, context);
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
    ...(store.enterprisePolicies ? { eligibleEnterprises: readyForCreation } : {}),
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
        ? checkTask(row, await request<LoginTaskDto>(row, observation, 'login', `/api/tasks/${encodeURIComponent(row.task_id)}`), account.ghLogin)
        : await findTask(row, observation, account.ghLogin);
      await observation.assertCurrent();
      if (task && task.accountIncarnation!==account.accountIncarnation) throw new ProvisionFailure('oauth_task_mismatch',true);
      // Contract-2 cancelled is an authority-confirmed terminal outcome; map it
      // to the existing failed-release transition (preserves attempts/operator
      // state). cancel_requested, uncertain and legacy cancellation retain slots.
      if (task?.status === 'cancelled' && task.bindingVersion === 2) return 'failed';
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

function untilSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
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
