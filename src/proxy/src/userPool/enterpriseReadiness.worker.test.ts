import assert from 'node:assert/strict';
import test from 'node:test';
import type { EnterpriseId, EnterpriseLifecycleState } from '@ghcp/shared';
import type { ProxyEnterpriseRecord } from '../db/storageTypes.js';
import type { PoolConfig } from './config.js';
import { realProvisioner } from './provisioner.js';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

// Creation eligibility (design §3.8, §5.8): only active enterprises are probed, outside any transaction, and a
// hung enterprise only removes itself from the round.
const options: PoolConfig = {
  enabled: true, accountDomain: 'pool.example.test', idleTarget: 2, maxAccounts: 10,
  leaseSeconds: 600, provisionalSeconds: 30, pollMs: 10000, retryAfterSeconds: 30,
  warmupModel: 'test-warmup-model', requestTimeoutMs: 1000,
};

function policy(id: string, state: EnterpriseLifecycleState): ProxyEnterpriseRecord {
  return {
    id: id as EnterpriseId, state, maxAccounts: 10, inventoryCount: 0, policyVersion: 1,
    profileFingerprint: 'f'.repeat(64), createdAt: 1, updatedAt: 1,
  };
}

const POLICIES = [
  policy('default', 'active'), policy('contoso-eu', 'active'), policy('hung-co', 'active'),
  policy('draft-co', 'draft'), policy('draining-co', 'draining'),
];

function provisioner(isReady: (id: string, signal: AbortSignal) => Promise<boolean>) {
  const probed: string[] = [];
  const adapter = realProvisioner({ now: () => Date.now(), enterprisePolicies: () => POLICIES }, options, {
    readinessDeadlineMs: 50,
    isReady: async (id, signal) => {
      probed.push(id);
      return isReady(id, signal);
    },
  });
  return { adapter, probed };
}

const hangs = () => new Promise<boolean>(() => undefined);

test('a hung enterprise does not starve the others, and draft or draining ones are never probed', async () => {
  const { adapter, probed } = provisioner(async (id) => id === 'hung-co' ? hangs() : id === 'default');
  const started = Date.now();
  const eligible = await adapter.eligibleEnterprises!(new AbortController().signal);
  assert.deepEqual(eligible, ['default']);
  assert.ok(Date.now() - started < 2000, 'the hung enterprise is bounded by its own deadline');
  assert.deepEqual([...probed].sort(), ['contoso-eu', 'default', 'hung-co']);
});

test('a readiness failure counts as not ready, never as ready', async () => {
  const { adapter } = provisioner(async (id) => {
    if (id === 'contoso-eu') throw new Error('peer unreachable');
    return true;
  });
  assert.deepEqual(await adapter.eligibleEnterprises!(new AbortController().signal), ['default', 'hung-co']);
});

interface FakeStore {
  store: PrewarmStore;
  reserved: Array<readonly string[]>;
}

function fakeStore(): FakeStore {
  const reserved: Array<readonly string[]> = [];
  const store = {
    now: () => Date.now(), claimOwner: () => true, renewOwner: () => true, releaseOwner: () => undefined,
    reclaim: () => undefined, settings: () => ({ paused: 0 }), pending: () => undefined,
    enterprisePolicies: () => POLICIES,
    reserveDeficit: (_owner: string, eligible: readonly string[]) => { reserved.push(eligible); return 0; },
  } as unknown as PrewarmStore;
  return { store, reserved };
}

test('the worker reserves only for ready enterprises while one enterprise hangs', async (t) => {
  const { adapter } = provisioner(async (id) => id === 'hung-co' ? hangs() : true);
  const { store, reserved } = fakeStore();
  const worker = new PrewarmWorker(store, adapter, 60000);
  t.after(() => worker.stop());
  await worker.tick();
  assert.deepEqual(reserved, [['default', 'contoso-eu']]);
});

test('without any ready enterprise the worker creates nothing', async (t) => {
  const { adapter } = provisioner(async () => false);
  const { store, reserved } = fakeStore();
  const worker = new PrewarmWorker(store, adapter, 60000);
  t.after(() => worker.stop());
  await worker.tick();
  assert.deepEqual(reserved, [[]]);
});

test('stopping the worker aborts a hanging eligibility round before any reservation', async () => {
  let signal: AbortSignal | undefined;
  const { store, reserved } = fakeStore();
  const worker = new PrewarmWorker(store, {
    step: async () => ({}),
    eligibleEnterprises: (ownerSignal) => {
      signal = ownerSignal;
      return new Promise(() => undefined);
    },
  }, 60000);
  const tick = worker.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await worker.stop();
  await tick;
  assert.equal(signal?.aborted, true);
  assert.deepEqual(reserved, []);
});
