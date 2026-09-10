import { Router, type Request, type Response } from 'express';
import { requireInternalToken } from '../auth/internalAuth.js';
import { getUserPool, wakePool } from '../userPool/runtime.js';
import { UserPoolError } from '../userPool/config.js';
import { NAME_CAPACITY } from '../userPool/names.js';
import type { PoolSettings, UserPoolStore } from '../userPool/store.js';

type AdminStore = Pick<UserPoolStore, 'settings' | 'counts' | 'accounts' | 'leases' | 'events'
  | 'updateSettings' | 'inventory' | 'disable' | 'retry' | 'release' | 'hasHolds'>;
interface Dependencies {
  getStore: () => Promise<AdminStore | undefined>;
  wake: () => void | Promise<void>;
}

const LIST_LIMITS = { accounts: 1000, leases: 1000, events: 200 } as const;
const SETTINGS_LIMITS = { maxAccounts: NAME_CAPACITY, minLeaseSeconds: 60, maxLeaseSeconds: 2_592_000 } as const;
const CALLER_HASH = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACCOUNT_STATES = ['ready', 'provisioning', 'cooling', 'failed', 'disabled'];
const STAGES = ['new', 'sso-creating', 'sso-created', 'scim-syncing', 'scim-synced', 'seat-assigning', 'synced', 'oauth-starting', 'oauth-dispatch', 'oauth-wait', 'warmup', 'ready'];
const EVENT_ACTIONS = new Set([
  'settings_updated', 'lease_expired', 'lease_acquired', 'lease_renewed', 'lease_released',
  'member_quarantined', 'member_cooling', 'member_disabled', 'member_retry', 'member_resumed',
  'name_reserved', 'provision_failed', 'account_ready', 'request_finished',
  'oauth_reauth_scheduled', 'oauth_reauth_blocked',
]);
const SAFE_DETAILS = new Set([
  'success', 'not_renewed', 'credential_not_valid', 'credential_not_verified', 'sso_creation_ambiguous', 'sso_name_conflict',
  'oauth_task_cancelled_unconfirmed', 'oauth_dispatch_ambiguous', 'sso_identity_changed', 'scim_or_seat_failed', 'gh_login_missing',
  'sso_password_unavailable', 'oauth_login_failed', 'oauth_task_stalled', 'entitlement_not_ready',
  'unknown_provision_stage', 'service_unavailable', 'provision_timeout', 'provision_fenced',
  'provision_storage_incompatible', 'proxy_identity_changed', 'oauth_task_mismatch', 'oauth_task_list_invalid',
  'oauth_task_search_limit', 'scim_sync_unconfirmed', 'scim_not_ready', 'seat_assignment_unconfirmed',
  'oauth_attempt_missing', 'oauth_dispatch_unconfirmed', 'oauth_callback_unconfirmed', 'oauth_task_invalid',
  'warmup_invalid_response', 'warmup_credential_changed', 'warmup_model_unavailable', 'service_invalid_response', 'service_response_too_large',
  'service_invalid_json', 'upstream_unauthorized', 'entitlement_denied', 'oauth_reauth_limit_reached',
]);
const ERROR_MESSAGES: Record<string, string> = {
  pool_mode_disabled: 'User pool is disabled. Configure ACCOUNT_ROUTING_MODE=caller-lease on the Proxy to use it.',
  invalid_pool_settings: 'Provide valid pool settings: idle target must not exceed the account cap; TTL must be 60–2592000 seconds; paused must be 0 or 1.',
  settings_version_conflict: 'Pool settings changed in another session. Reload the latest values before saving.',
  invalid_request: 'The request contains unsupported fields or invalid values.',
  invalid_member_identity: 'Provide a valid pool account identity.',
  invalid_lease_id: 'Provide a valid lease ID.',
  confirmation_required: 'Set confirm to true to release a lease.',
  member_not_found: 'Pool account was not found.',
  lease_not_found: 'Lease was not found. Refresh the list; it may already have expired.',
  lease_in_use: 'This lease has requests in flight. Wait for them to finish before releasing it.',
  member_in_use: 'This account is provisioning or has requests in flight. Wait before retrying.',
  invalid_member_state: 'Resume is only available for disabled accounts; retry is only available for failed accounts.',
  manual_reconciliation_required: 'This account has an ambiguous provisioning result. Resolve it manually before retrying.',
  action_not_found: 'Pool action was not found.',
  pool_operation_failed: 'Pool operation failed. Check Proxy health and retry.',
};

/** The router also authenticates itself so an alternate mount cannot expose pool administration. */
export function createUserPoolApiRouter(dependencies: Partial<Dependencies> = {}): Router {
  const { getStore, wake } = { getStore: getUserPool, wake: wakePool, ...dependencies };
  const router = Router();
  router.use('/user-pool', requireInternalToken, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const handle = (operation: (req: Request, res: Response, store: AdminStore) => void | Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        if (Object.keys(req.query).length) throw new UserPoolError(400, 'invalid_request');
        const store = await getStore();
        if (!store) throw new UserPoolError(409, 'pool_mode_disabled');
        await operation(req, res, store);
      } catch (error) {
        sendError(res, error);
      }
    };

  router.get('/user-pool', handle((_req, res, store) => {
    // counts() reclaims expired leases before the associated lists are read.
    const counts = countsDto(store.counts());
    const accounts = store.accounts().slice(0, LIST_LIMITS.accounts).map(accountDto);
    res.json({
      enabled: true,
      poolId: 'default',
      observedAt: Date.now(),
      settings: settingsDto(store.settings()),
      counts,
      accounts,
      leases: store.leases().slice(0, LIST_LIMITS.leases).map((lease) => leaseDto(lease, store.hasHolds(lease.member_identity))),
      events: store.events().slice(0, LIST_LIMITS.events).map(eventDto),
      limits: SETTINGS_LIMITS,
      listLimits: LIST_LIMITS,
    });
  }));

  router.get('/user-pool/accounts', handle((_req, res, store) => {
    const counts = countsDto(store.counts());
    res.json({ items: store.accounts().slice(0, LIST_LIMITS.accounts).map(accountDto), total: counts.total, limit: LIST_LIMITS.accounts });
  }));
  router.get('/user-pool/leases', handle((_req, res, store) => {
    const counts = countsDto(store.counts());
    res.json({
      items: store.leases().slice(0, LIST_LIMITS.leases).map((lease) => leaseDto(lease, store.hasHolds(lease.member_identity))),
      total: counts.leased + counts.provisional,
      limit: LIST_LIMITS.leases,
    });
  }));
  router.get('/user-pool/events', handle((_req, res, store) => {
    res.json({ items: store.events().slice(0, LIST_LIMITS.events).map(eventDto), limit: LIST_LIMITS.events });
  }));

  router.patch('/user-pool/settings', handle(async (req, res, store) => {
    const { expectedVersion, changes } = readSettingsPatch(req.body);
    const settings = store.updateSettings(expectedVersion, changes);
    await wake();
    res.json(settingsDto(settings));
  }));
  router.post('/user-pool/reconcile', handle(async (req, res) => {
    requireEmptyBody(req.body);
    await wake();
    res.status(202).json({ scheduled: true });
  }));
  router.post('/user-pool/accounts/:identity/:action', handle(async (req, res, store) => {
    requireEmptyBody(req.body);
    const identity = String(req.params.identity);
    const action = String(req.params.action);
    if (identity !== identity.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._@+-]{0,253}$/.test(identity)) throw new UserPoolError(400, 'invalid_member_identity');
    if (!['disable', 'resume', 'retry'].includes(action)) throw new UserPoolError(404, 'action_not_found');
    const account = store.inventory(identity);
    if (!account) throw new UserPoolError(404, 'member_not_found');
    if (action === 'disable') {
      store.disable(identity);
    } else {
      if (account.state !== (action === 'resume' ? 'disabled' : 'failed')) throw new UserPoolError(409, 'invalid_member_state');
      // Retry revalidates entitlement and credentials; a resumed account is not immediately ready.
      store.retry(identity);
    }
    await wake();
    res.json({ accepted: true });
  }));
  router.post('/user-pool/leases/:id/release', handle(async (req, res, store) => {
    if (!isRecord(req.body) || req.body.confirm !== true) throw new UserPoolError(400, 'confirmation_required');
    if (Object.keys(req.body).some((key) => key !== 'confirm')) throw new UserPoolError(400, 'invalid_request');
    const id = String(req.params.id);
    if (id.length !== 36 || !UUID.test(id)) throw new UserPoolError(400, 'invalid_lease_id');
    store.release(id);
    await wake();
    res.json({ released: true });
  }));
  router.use('/user-pool', (_req, res) => {
    res.status(404).json({ error: { code: 'action_not_found', message: ERROR_MESSAGES.action_not_found } });
  });
  return router;
}

export const userPoolApiRouter = createUserPoolApiRouter();

function readSettingsPatch(body: unknown): { expectedVersion: number; changes: Partial<PoolSettings> } {
  const invalid = () => new UserPoolError(400, 'invalid_pool_settings');
  if (!isRecord(body) || Object.keys(body).some((key) => !['expectedVersion', 'changes'].includes(key))
    || !integerInRange(body.expectedVersion, 1, Number.MAX_SAFE_INTEGER) || !isRecord(body.changes)) throw invalid();
  const changes = body.changes;
  if (!Object.keys(changes).length || Object.keys(changes).some((key) => !['idle_target', 'max_accounts', 'lease_seconds', 'paused'].includes(key))) throw invalid();
  if (('idle_target' in changes && !integerInRange(changes.idle_target, 0, NAME_CAPACITY))
    || ('max_accounts' in changes && !integerInRange(changes.max_accounts, 1, NAME_CAPACITY))
    || ('lease_seconds' in changes && !integerInRange(changes.lease_seconds, SETTINGS_LIMITS.minLeaseSeconds, SETTINGS_LIMITS.maxLeaseSeconds))
    || ('paused' in changes && changes.paused !== 0 && changes.paused !== 1)) throw invalid();
  return { expectedVersion: body.expectedVersion as number, changes: changes as Partial<PoolSettings> };
}

function requireEmptyBody(body: unknown): void {
  if (body !== undefined && (!isRecord(body) || Object.keys(body).length)) throw new UserPoolError(400, 'invalid_request');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function timestamp(value: unknown): number | null { return typeof value === 'number' && value > 0 && Number.isFinite(value) ? value : null; }
function callerHash(value: unknown): string | null { return typeof value === 'string' && value.length === 71 && CALLER_HASH.test(value) ? value : null; }
function enumValue(value: unknown, allowed: string[]): string { return typeof value === 'string' && allowed.includes(value) ? value : 'unknown'; }
function safeDetail(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' && (SAFE_DETAILS.has(value) || /^(?:service|sso|login|warmup)_http_[1-5][0-9]{2}$/.test(value)) ? value : 'details_redacted';
}

function settingsDto(settings: PoolSettings) {
  return {
    version: settings.version,
    idle_target: settings.idle_target,
    max_accounts: settings.max_accounts,
    lease_seconds: settings.lease_seconds,
    paused: settings.paused,
  };
}
function countsDto(counts: Record<string, number>) {
  return {
    total: number(counts.total), ready_idle: number(counts.ready_idle), leased: number(counts.leased),
    provisional: number(counts.provisional), provisioning: number(counts.provisioning),
    cooling: number(counts.cooling), failed: number(counts.failed), disabled: number(counts.disabled),
  };
}
function accountDto(value: unknown) {
  const row = isRecord(value) ? value : {};
  return {
    identity: text(row.identity) ?? '', ordinal: number(row.ordinal),
    state: enumValue(row.state, ACCOUNT_STATES), stage: enumValue(row.stage, STAGES),
    ghLogin: text(row.gh_login), oauthStatus: enumValue(row.copilot_oauth_status, ['valid', 'missing', 'refreshing', 'expired', 'failed']),
    attempts: number(row.attempts), retryAt: timestamp(row.retry_at), lastError: safeDetail(row.last_error),
    updatedAt: timestamp(row.updated_at), cooldownUntil: timestamp(row.cooldown_until), verifiedAt: timestamp(row.verified_at),
    callerKeyHash: callerHash(row.caller_id), leasePhase: row.phase == null ? null : enumValue(row.phase, ['active', 'provisional']),
    leaseExpiresAt: timestamp(row.expires_at), activeRequests: number(row.active_requests),
  };
}
function leaseDto(value: unknown, inUse: boolean) {
  const row = isRecord(value) ? value : {};
  return {
    leaseId: text(row.lease_id) ?? '', memberIdentity: text(row.member_identity) ?? '',
    callerKeyHash: callerHash(row.caller_id), phase: enumValue(row.phase, ['active', 'provisional']),
    assignedAt: timestamp(row.assigned_at), lastSuccessAt: timestamp(row.last_success_at), expiresAt: timestamp(row.expires_at),
    inUse,
  };
}
function eventDto(value: unknown) {
  const row = isRecord(value) ? value : {};
  return {
    id: number(row.id), at: timestamp(row.at), action: typeof row.action === 'string' && EVENT_ACTIONS.has(row.action) ? row.action : 'other',
    identity: text(row.identity), callerKeyHash: callerHash(row.caller_id), leaseId: text(row.lease_id), detail: safeDetail(row.detail),
  };
}
function sendError(res: Response, error: unknown): void {
  const known = error instanceof UserPoolError && Object.hasOwn(ERROR_MESSAGES, error.code);
  const code = known ? error.code : 'pool_operation_failed';
  if (known && error.retryAfter > 0) res.setHeader('Retry-After', error.retryAfter);
  res.status(known ? error.status : 500).json({ error: { code, message: ERROR_MESSAGES[code] } });
}
