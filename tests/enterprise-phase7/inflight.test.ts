import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLeaseStable, assertNoProvisionReplay, INFLIGHT_HARD_LIMIT_MS } from './inflight.js';

test('inflight stable-lease checks reject identity enterprise and assignment replacement',()=>{
  const before={leaseId:'l',memberIdentity:'m',enterpriseId:'a',callerKeyHash:'sha256:synthetic',assignedAt:1,expiresAt:2,inUse:true};
  assertLeaseStable(before,{...before,expiresAt:3,inUse:false});
  for(const field of ['leaseId','memberIdentity','enterpriseId','callerKeyHash','assignedAt'])assert.throws(()=>assertLeaseStable(before,{...before,[field]:'changed'}));
  assert.throws(()=>assertLeaseStable(before,undefined));assert.equal(INFLIGHT_HARD_LIMIT_MS,120000);
});
test('inflight no-replay compares both enterprises independently and permits only inference progress',()=>{
  const before={enterprises:['a','b'].map(enterpriseId=>({enterpriseId,counts:{'scim-create':1,'seat-assign':1,authorize:1,inference:1}}))};
  const after=structuredClone(before);after.enterprises[1].counts.inference++;assertNoProvisionReplay(before,after,['a','b']);
  for(const index of [0,1])for(const key of ['scim-create','seat-assign','authorize'] as const){const changed=structuredClone(before);changed.enterprises[index].counts[key]++;assert.throws(()=>assertNoProvisionReplay(before,changed,['a','b']));}
});
