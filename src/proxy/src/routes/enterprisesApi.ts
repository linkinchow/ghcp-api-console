import { Router, type Request, type Response } from 'express';
import {
  ACCOUNT_NAME_CAPACITY,
  apiError,
  enterpriseShareScore,
  requireEnterprise,
  type EnterpriseLifecycleState,
  type EnterprisePoolPolicyDto,
  type EnterpriseReadinessDto,
  type EnterpriseSummaryDto,
  type PoolEnterprise,
  type UpdateEnterprisePoolPolicyRequest,
} from '@ghcp/shared';
import { enterpriseReadiness, type ReadinessRequest } from '../clients/enterpriseReadiness.js';
import type { ProxyEnterpriseRecord } from '../db/storageTypes.js';
import { findProxyEnterprise, proxyEnterprises, type ProxyEnterprise } from '../enterprises.js';
import { UserPoolError } from '../userPool/config.js';
import { getUserPool, wakePool } from '../userPool/runtime.js';
import type { PoolStore } from '../userPool/storage.js';
import { requestEnterprise } from './requestEnterprise.js';

type EnterpriseStore = Pick<PoolStore, 'enterprisePolicies' | 'updateEnterprisePolicy' | 'counts'>;

export interface EnterprisesApiDependencies {
  getStore: () => Promise<EnterpriseStore | undefined>;
  enterprises: () => readonly ProxyEnterprise[];
  readiness: (enterpriseId: string, request?: ReadinessRequest) => Promise<EnterpriseReadinessDto>;
  wake: () => void | Promise<void>;
}

/** One row of `GET /api/enterprises`: the shared summary plus the Proxy's pool view of the enterprise. */
export interface ProxyEnterpriseSummary extends EnterpriseSummaryDto {
  /** Pool member counts of this enterprise; `null` outside pool mode. */
  poolSummary: Record<string, number> | null;
  /** S_e = N × C_e − C × N_e among active enterprises (design §5.8); `null` unless active. */
  shareScore: number | null;
}

const STATES: readonly EnterpriseLifecycleState[] = ['draft', 'active', 'draining'];
const POLICY_KEYS = new Set(['expectedVersion', 'maxAccounts', 'state', 'enterpriseId']);
const LIST_READINESS_TIMEOUT_MS = 8000;

const POLICY_ERRORS: Record<string, { status: number; message: string }> = {
  pool_mode_disabled: { status: 409, message: 'User pool is disabled. Configure ACCOUNT_ROUTING_MODE=caller-lease.' },
  invalid_pool_policy: { status: 400, message: 'Provide expectedVersion and a valid maxAccounts and/or state.' },
  enterprise_not_found: { status: 404, message: 'The enterprise has no pool policy.' },
  policy_version_conflict: { status: 409, message: 'The pool policy changed in another session. Reload it.' },
  name_capacity_exceeded: { status: 409, message: 'The caps of all enterprises would exceed the name catalog.' },
  invalid_state_transition: { status: 409, message: 'This lifecycle transition is not allowed.' },
  enterprise_not_ready: { status: 409, message: 'The enterprise is not ready in Proxy, SSO and Login.' },
};

/** `GET /api/enterprises` and `PATCH /api/enterprises/:enterpriseId/pool-policy` (design §5.2). */
export function createEnterprisesApiRouter(overrides: Partial<EnterprisesApiDependencies> = {}): Router {
  const deps: EnterprisesApiDependencies = {
    getStore: getUserPool,
    enterprises: proxyEnterprises,
    readiness: (id, request) => enterpriseReadiness.readiness(id, request),
    wake: wakePool,
    ...overrides,
  };
  const router = Router();
  router.get('/', (_req, res) => listEnterprises(deps, res));
  router.patch('/:enterpriseId/pool-policy', requireEnterprise(findProxyEnterprise), (req, res) => {
    return updatePolicy(deps, req, res);
  });
  return router;
}

async function listEnterprises(deps: EnterprisesApiDependencies, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const store = await deps.getStore();
  const policies = store ? await store.enterprisePolicies() : [];
  const enterprises = deps.enterprises();
  const readiness = await Promise.all(enterprises.map((enterprise) => listReadiness(deps, enterprise.id)));
  const items: ProxyEnterpriseSummary[] = [];
  for (const [index, enterprise] of enterprises.entries()) {
    const policy = policies.find((row) => row.id === enterprise.id);
    items.push({
      ...summaryOf(enterprise),
      pool: policy ? policyDto(policy) : null,
      readiness: readiness[index] ?? null,
      poolSummary: store && policy ? await store.counts(enterprise.id) : null,
      shareScore: policy ? shareScore(policy, policies) : null,
    });
  }
  res.json({ items, nameCapacity: ACCOUNT_NAME_CAPACITY });
}

/** Console listing never waits for a hung peer beyond its deadline; unknown readiness is shown as `null`. */
async function listReadiness(deps: EnterprisesApiDependencies, id: string): Promise<EnterpriseReadinessDto | null> {
  try {
    return await deps.readiness(id, { signal: AbortSignal.timeout(LIST_READINESS_TIMEOUT_MS) });
  } catch {
    return null;
  }
}

function summaryOf(enterprise: ProxyEnterprise): EnterpriseSummaryDto {
  const { github } = enterprise.profile;
  return {
    id: enterprise.id,
    displayName: enterprise.profile.displayName,
    githubBaseUrl: github.baseUrl,
    slug: github.slug ?? null,
    shortcode: enterprise.endpoints.shortcode,
    pool: null,
    readiness: null,
  };
}

function shareScore(policy: ProxyEnterpriseRecord, policies: readonly ProxyEnterpriseRecord[]): number | null {
  if (policy.state !== 'active') return null;
  const active = policies.filter((row) => row.state === 'active').map(poolEnterprise);
  return enterpriseShareScore(poolEnterprise(policy), active);
}

function poolEnterprise(policy: ProxyEnterpriseRecord): PoolEnterprise {
  return { id: policy.id, cap: policy.maxAccounts, inventory: policy.inventoryCount, eligible: true };
}

function policyDto(policy: ProxyEnterpriseRecord): EnterprisePoolPolicyDto {
  return {
    enterpriseId: policy.id,
    state: policy.state,
    maxAccounts: policy.maxAccounts,
    inventory: policy.inventoryCount,
    policyVersion: policy.policyVersion,
    updatedAt: new Date(policy.updatedAt).toISOString(),
  };
}

/**
 * CAS update of one enterprise's cap and lifecycle state. Activating a draft or resuming a draining enterprise
 * requires a live readiness comparison; the cached one is not enough (design §3.8, §5.8).
 */
async function updatePolicy(deps: EnterprisesApiDependencies, req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const enterprise = requestEnterprise(res);
  try {
    const request = readPolicyRequest(req.body);
    const store = await deps.getStore();
    if (!store) throw new UserPoolError(409, 'pool_mode_disabled');
    if (request.state === 'active') await assertActivatable(deps, store, enterprise);
    const { expectedVersion, ...changes } = request;
    const updated = await store.updateEnterprisePolicy(enterprise.id, expectedVersion, changes);
    await deps.wake();
    res.json(policyDto(updated));
  } catch (error) {
    sendPolicyError(res, error);
  }
}

function readPolicyRequest(body: unknown): UpdateEnterprisePoolPolicyRequest {
  const invalid = new UserPoolError(400, 'invalid_pool_policy');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !POLICY_KEYS.has(key))) throw invalid;
  const { expectedVersion, maxAccounts, state } = record;
  if (!isInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER)) throw invalid;
  if (maxAccounts === undefined && state === undefined) throw invalid;
  if (maxAccounts !== undefined && !isInteger(maxAccounts, 1, ACCOUNT_NAME_CAPACITY)) throw invalid;
  if (state !== undefined && !STATES.includes(state as EnterpriseLifecycleState)) throw invalid;
  return {
    expectedVersion,
    ...(maxAccounts === undefined ? {} : { maxAccounts: maxAccounts as number }),
    ...(state === undefined ? {} : { state: state as EnterpriseLifecycleState }),
  };
}

class EnterpriseNotReadyError extends UserPoolError {
  constructor(readonly blockers: readonly string[]) {
    super(409, 'enterprise_not_ready');
  }
}

async function assertActivatable(
  deps: EnterprisesApiDependencies,
  store: EnterpriseStore,
  enterprise: ProxyEnterprise,
): Promise<void> {
  const current = (await store.enterprisePolicies()).find((row) => row.id === enterprise.id);
  if (current?.state === 'active') return;
  const readiness = await deps.readiness(enterprise.id, { fresh: true });
  if (!readiness.ready) throw new EnterpriseNotReadyError(readiness.blockers);
}

function sendPolicyError(res: Response, error: unknown): void {
  const known = error instanceof UserPoolError && Object.hasOwn(POLICY_ERRORS, error.code);
  if (!known) {
    res.status(500).json(apiError('pool_operation_failed', 'Pool policy update failed. Check Proxy health and retry.'));
    return;
  }
  const { status, message } = POLICY_ERRORS[error.code]!;
  const details = error instanceof EnterpriseNotReadyError ? { blockers: error.blockers } : undefined;
  res.status(status).json(apiError(error.code, message, details));
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
