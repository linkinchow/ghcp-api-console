import assert from 'node:assert/strict';
import test from 'node:test';
import { deepFreeze } from './deepFreeze.js';

test('freezes nested objects and arrays and returns the same reference', () => {
  const value = { a: { b: [1, { c: 'x' }] }, d: [[2]] };
  const frozen = deepFreeze(value);
  assert.equal(frozen, value);
  for (const node of [value, value.a, value.a.b, value.a.b[1], value.d, value.d[0]]) {
    assert.ok(Object.isFrozen(node));
  }
  assert.throws(() => {
    (value.a.b[1] as { c: string }).c = 'y';
  }, TypeError);
});

test('handles cycles, primitives, typed arrays and symbol keys', () => {
  const cyclic: { self?: unknown; bytes: Uint8Array; [key: symbol]: object } = { bytes: new Uint8Array([1]) };
  const hidden = Symbol('hidden');
  cyclic.self = cyclic;
  cyclic[hidden] = { inner: true };
  deepFreeze(cyclic);
  assert.ok(Object.isFrozen(cyclic));
  assert.ok(Object.isFrozen(cyclic[hidden]));
  assert.equal(Object.isFrozen(cyclic.bytes), false);
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze('text'), 'text');
});

test('does not invoke getters', () => {
  let calls = 0;
  const get = () => {
    calls += 1;
    return {};
  };
  const value = Object.defineProperty({}, 'lazy', { get, enumerable: true });
  deepFreeze(value);
  assert.equal(calls, 0);
  assert.ok(Object.isFrozen(value));
});
