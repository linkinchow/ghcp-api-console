import assert from 'node:assert/strict';
import test from 'node:test';
import { realProvisioner } from './provisioner.js';
import { readPoolConfig } from './config.js';
import { fixtureProfile } from '../test/enterpriseFixtures.js';
import type { EnterprisePoolPolicyRecord } from '@ghcp/shared';
import { PrewarmWorker, type PrewarmStore } from './worker.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

const options = readPoolConfig({ ACCOUNT_ROUTING_MODE: 'caller-lease', POOL_ACCOUNT_EMAIL_DOMAIN: 'accounts.example.test', POOL_WARMUP_MODEL: 'synthetic', READY_IDLE_TARGET: '0' });
const first = fixtureProfile(options), second = { ...first, id: 'b0000000-0000-4000-8000-000000000002', slug: 'second' };
function policies(): EnterprisePoolPolicyRecord[] {
  return [first, second].map(profile => ({ enterpriseId: profile.id, state: 'active', policyVersion: 1, maxAccounts: 10,
    identitySha256: 'a'.repeat(64), validationKind: 'migration_preserved_v3', validationEvidence: null, validatedAt: 1, updatedAt: 1 }));
}

test('creation probe excludes unavailable peers, caches briefly and refreshes on owner change', async () => {
  const calls: string[] = [];
  const adapter = realProvisioner({ now: () => Date.now(), enterprisePolicies: policies }, options, {
    creationCapacity: async () => true,
    enterpriseProfile: id => id === first.id ? first : second,
    verifyReadiness: async profile => { calls.push(profile.id); if (profile.id === second.id) throw new Error('synthetic outage'); },
  });
  assert.deepEqual(await adapter.eligibleEnterprises!(AbortSignal.timeout(1000), 'owner-a'), [first.id]);
  assert.equal(calls.length, 2);
  assert.deepEqual(await adapter.eligibleEnterprises!(AbortSignal.timeout(1000), 'owner-a'), [first.id]);
  assert.equal(calls.filter(id => id === first.id).length, 1);
  assert.deepEqual(await adapter.eligibleEnterprises!(AbortSignal.timeout(1000), 'owner-b'), [first.id]);
  assert.equal(calls.filter(id => id === first.id).length, 2);
});

test('a hung profile preserves healthy creation eligibility in the worker and never caches a late success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve!: () => void;
  const hung = new Promise<void>(done => { resolve = done; });
  const calls: string[] = [];
  const adapter = realProvisioner({ now: Date.now, enterprisePolicies: policies }, options, {
    enterpriseProfile: id => id === first.id ? first : second, creationCapacity: async () => true,
    verifyReadiness: async profile => { calls.push(profile.id); if (profile.id === second.id) await hung; },
  });
  const reserved: string[][] = [];
  let currentOwner = '';
  const store = {
    claimOwner: () => true, renewOwner: () => true, releaseOwner: () => {}, reclaim: () => {},
    settings: () => ({ paused: 0 }), pending: () => undefined,
    reserveDeficit: (owner: string, eligible: string[]) => { currentOwner = owner; reserved.push(eligible); return 0; },
  } as unknown as PrewarmStore;
  const worker = new PrewarmWorker(store, adapter, 10000); t.after(() => worker.stop());
  const tick = worker.tick(); await flush(); t.mock.timers.tick(1000); await tick;
  assert.deepEqual(reserved, [[first.id]]);
  resolve(); await flush();
  assert.deepEqual(await adapter.eligibleEnterprises!(new AbortController().signal, currentOwner), [first.id, second.id]);
  assert.equal(calls.filter(id => id === first.id).length, 1, 'healthy peer remains cached in this tenure');
  assert.equal(calls.filter(id => id === second.id).length, 2, 'timed-out peer late completion did not populate cache');
});

test('profile concurrency stays at four and the overall scan returns partial results by four seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const profiles = Array.from({ length: 30 }, (_, n) => ({ ...first, id: `profile-${n}` }));
  let running = 0, max = 0, calls = 0;
  const adapter = realProvisioner({ now: Date.now, enterprisePolicies: () => profiles.map(profile => ({ ...policies()[0]!, enterpriseId: profile.id })) }, options, {
    enterpriseProfile: id => profiles.find(profile => profile.id === id)!, creationCapacity: async () => true,
    verifyReadiness: async (profile, signal) => {
      running++; calls++; max = Math.max(max, running);
      if (profile.id === profiles[0]!.id) { running--; return; }
      signal.addEventListener('abort', () => { running--; }, { once: true });
      return new Promise<void>(() => {});
    },
  });
  const result = adapter.eligibleEnterprises!(new AbortController().signal, 'owner'); await flush();
  for (let wave = 0; wave < 4; wave++) { t.mock.timers.tick(1000); await flush(); }
  assert.deepEqual(await result, [profiles[0]!.id]);
  assert.equal(max, 4); assert.equal(running, 0); assert.ok(calls < profiles.length);
});

test('bounded scans rotate past a permanently hung prefix so healthy tail profiles are eventually eligible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const profiles = Array.from({ length: 20 }, (_, n) => ({ ...first, id: `profile-${n}` }));
  const seen = new Set<string>();
  const adapter = realProvisioner({ now: Date.now, enterprisePolicies: () => profiles.map(profile => ({ ...policies()[0]!, enterpriseId: profile.id })) }, options, {
    enterpriseProfile: id => profiles.find(profile => profile.id === id)!, creationCapacity: async () => true,
    verifyReadiness: async profile => { seen.add(profile.id); if (profiles.indexOf(profile) < 16) await new Promise<void>(() => {}); },
  });
  const scan = async (owner: string) => {
    const result = adapter.eligibleEnterprises!(new AbortController().signal, owner); await flush();
    for (let wave = 0; wave < 4; wave++) { t.mock.timers.tick(1000); await flush(); }
    return result;
  };
  assert.deepEqual(await scan('owner'), []);
  assert.deepEqual([...(await scan('owner'))].sort(), profiles.slice(16).map(profile => profile.id).sort());
  assert.equal(seen.size, 20);
  assert.deepEqual(await scan('new-owner'), [], 'new owner resets the cursor and cached readiness');
});

test('owner cancellation discards partial success; worker stop aborts a hanging eligibility adapter', async t => {
  const controller = new AbortController();
  const adapter = realProvisioner({ now: Date.now, enterprisePolicies: policies }, options, {
    enterpriseProfile: id => id === first.id ? first : second, creationCapacity: async () => true,
    verifyReadiness: async profile => { if (profile.id === second.id) await new Promise<void>(() => {}); },
  });
  const rejected = assert.rejects(adapter.eligibleEnterprises!(controller.signal, 'owner'));
  await flush(); controller.abort(); await rejected;
  let signal!: AbortSignal, reserves = 0;
  const worker = new PrewarmWorker({ claimOwner: () => true, releaseOwner: () => {}, reclaim: () => {},
    settings: () => ({ paused: 0 }), reserveDeficit: () => { reserves++; return 0; },
  } as unknown as PrewarmStore, { step: async () => ({}), eligibleEnterprises: async ownerSignal => {
    signal = ownerSignal; return new Promise<readonly string[]>(() => {});
  } }, 10000);
  t.after(() => worker.stop());
  const tick = worker.tick(); await flush(); await worker.stop(); await tick;
  assert.equal(signal.aborted, true); assert.equal(reserves, 0);
});

test('capacity is read each scan independently from cached readiness, and unknown/full peers are not candidates', async () => {
  let full = true, probes = 0, reads = 0;
  const adapter = realProvisioner({ now: Date.now, enterprisePolicies: policies }, options, {
    enterpriseProfile: id => id === first.id ? first : second,
    verifyReadiness: async () => { probes++; },
    creationCapacity: async profile => { reads++; if (profile.id === second.id) throw new Error('unknown'); return !full; },
  });
  assert.deepEqual(await adapter.eligibleEnterprises!(new AbortController().signal, 'owner'), []);
  full = false;
  assert.deepEqual(await adapter.eligibleEnterprises!(new AbortController().signal, 'owner'), [first.id]);
  assert.equal(probes, 2); assert.equal(reads, 4);
});

test('draft/draining profiles are not probed and cancellation never returns successful eligibility', async () => {
  const adapter = realProvisioner({ now: () => Date.now(), enterprisePolicies: () => policies().map(policy => ({ ...policy, state: 'draining' })) }, options, {
    enterpriseProfile: () => first, verifyReadiness: async () => { throw new Error('must not call'); },
  });
  assert.deepEqual(await adapter.eligibleEnterprises!(AbortSignal.timeout(1000), 'owner-a'), []);
  const controller = new AbortController(); controller.abort();
  const active = realProvisioner({ now: () => Date.now(), enterprisePolicies: policies }, options, {
    enterpriseProfile: () => first, verifyReadiness: async () => {},
  });
  await assert.rejects(active.eligibleEnterprises!(controller.signal, 'owner-a'));
});
