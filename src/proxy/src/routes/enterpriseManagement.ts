import { Router, type Request, type Response } from 'express';
import {
  apiError, EnterpriseContractError, enterprisePoolPolicyDto, resolveEnterpriseScope,
  type EnterprisePoolPolicyRecord, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1,
} from '@ghcp/shared';
import { config } from '../config.js';
import { requireInternalToken } from '../auth/internalAuth.js';
import { getStorage, initializeStorage } from '../db/connection.js';
import { loadProxyEnterpriseRegistry, requestEnterpriseProfile, requireEnterpriseRequest } from '../enterprise.js';
import { EnterpriseReadinessError, probeEnterpriseReadiness } from '../clients/enterpriseReadiness.js';
import { getUserPool, wakePool } from '../userPool/runtime.js';
import { UserPoolError } from '../userPool/config.js';
import type { PoolStore } from '../userPool/storage.js';

interface Dependencies {
  registry: () => EnterpriseRegistryV3;
  policies: () => Promise<EnterprisePoolPolicyRecord[]>;
  pool: () => Promise<PoolStore | undefined>;
  probe: (registry: EnterpriseRegistryV3, id: string) => Promise<EnterpriseValidationEvidenceV1>;
  wake: () => void | Promise<void>;
}

export function createEnterpriseManagementRouter(overrides: Partial<Dependencies> = {}): Router {
  const dependencies: Dependencies = {
    registry: loadProxyEnterpriseRegistry,
    policies: async () => { await initializeStorage(); return getStorage().enterprisePolicies(); },
    pool: getUserPool,
    probe: (registry, id) => probeEnterpriseReadiness(registry, id, config.internalApiToken),
    wake: wakePool,
    ...overrides,
  };
  const router = Router();
  router.use(['/management', '/profiles/:enterpriseId/pool-policy'], requireInternalToken, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  const handle = (operation: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      if (Object.keys(req.query).length) throw new UserPoolError(400, 'invalid_request');
      await operation(req, res);
    } catch (error) { sendError(res, error); }
  };
  const pool = async () => {
    const store = await dependencies.pool();
    if (!store) throw new UserPoolError(409, 'pool_mode_disabled');
    return store;
  };

  router.get('/management/enterprises', handle(async (_req, res) => {
    const registry = dependencies.registry();
    const policies = await dependencies.policies();
    res.json({ enabled: Boolean(await dependencies.pool()), legacyEnterpriseId: registry.legacyEnterpriseId,
      enterprises: policies.map(policy => enterprisePoolPolicyDto(resolveEnterpriseScope(registry, policy.enterpriseId).profile, policy)) });
  }));
  router.get('/management/pool/summary', handle(async (_req, res) => { res.json(await (await pool()).enterpriseOverview()); }));
  router.get('/management/pool/settings', handle(async (_req, res) => { res.json(await (await pool()).settings()); }));
  router.patch('/management/pool/settings', handle(async (req, res) => {
    const body = strictObject(req.body, ['expectedVersion', 'changes']);
    const expected = version(body.expectedVersion);
    const changes = strictObject(body.changes, [], ['idle_target', 'lease_seconds', 'paused']);
    if (!Object.keys(changes).length) throw new UserPoolError(400, 'invalid_pool_settings');
    const result = await (await pool()).updateSettings(expected, changes);
    await dependencies.wake(); res.json(result);
  }));

  router.use('/profiles/:enterpriseId/pool-policy', requireEnterpriseRequest);
  router.get('/profiles/:enterpriseId/pool-policy', handle(async (req, res) => {
    const profile = requestEnterpriseProfile(req);
    const policy = await (await pool()).enterprisePolicy(profile.id);
    if (!policy) throw new UserPoolError(404, 'enterprise_not_found');
    res.json(enterprisePoolPolicyDto(profile, policy));
  }));
  router.patch('/profiles/:enterpriseId/pool-policy', handle(async (req, res) => {
    const profile = requestEnterpriseProfile(req);
    const body = strictObject(req.body, ['expectedVersion', 'maxAccounts']);
    const maxAccounts = version(body.maxAccounts);
    if (maxAccounts > 10000) throw new UserPoolError(400, 'invalid_enterprise_cap');
    const policy = await (await pool()).updateEnterprisePolicy(profile.id, version(body.expectedVersion), { type: 'cap', maxAccounts });
    await dependencies.wake(); res.json(enterprisePoolPolicyDto(profile, policy));
  }));
  router.post('/profiles/:enterpriseId/pool-policy/:action', handle(async (req, res) => {
    const profile = requestEnterpriseProfile(req);
    const action = String(req.params.action);
    if (!['validate', 'activate', 'drain'].includes(action)) throw new UserPoolError(404, 'action_not_found');
    const body = strictObject(req.body, action === 'validate' ? ['expectedVersion'] : ['expectedVersion', 'confirm']);
    if (action !== 'validate' && body.confirm !== true) throw new UserPoolError(400, 'confirmation_required');
    const expected = version(body.expectedVersion), store = await pool();
    const current = await store.enterprisePolicy(profile.id);
    if (!current) throw new UserPoolError(404, 'enterprise_not_found');
    if (current.policyVersion !== expected) throw new UserPoolError(409, 'enterprise_policy_version_conflict');
    const evidence = action === 'drain' ? undefined : await dependencies.probe(dependencies.registry(), profile.id);
    if (evidence) evidence.checkedAt = await store.now();
    const change = action === 'drain' ? { type: 'drain' as const }
      : { type: action as 'validate' | 'activate', evidence: evidence! };
    const updated = await store.updateEnterprisePolicy(profile.id, expected, change);
    await dependencies.wake(); res.json(enterprisePoolPolicyDto(profile, updated));
  }));
  return router;
}

function strictObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserPoolError(400, 'invalid_request');
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new UserPoolError(400, 'invalid_request');
  }
  return row;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new UserPoolError(400, 'invalid_request');
  return value as number;
}
function sendError(res: Response, error: unknown): void {
  if (error instanceof UserPoolError) {
    res.status(error.status).json({ error: { code: error.code, message: 'Enterprise pool operation was not applied.',
      ...(error instanceof EnterpriseReadinessError ? { details: { blockers: error.blockers } } : {}) } });
  } else if (error instanceof EnterpriseContractError) {
    res.status(error.code === 'enterprise_not_found' ? 404 : 409).json(apiError(error.code, 'Enterprise configuration does not match.'));
  } else res.status(503).json(apiError('enterprise_management_unavailable', 'Enterprise management is unavailable.'));
}

export const enterpriseManagementRouter = createEnterpriseManagementRouter();
