import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enterpriseShareScore,
  planCreations,
  rankEnterprisesForAdmission,
  rankEnterprisesForCreation,
  replenishmentDeficit,
  type AdmissionEnterprise,
  type PoolEnterprise,
} from './poolRanking.js';

const IDS = ['alpha', 'bravo', 'charlie'];

function pool(caps: number[], inventories: number[]): PoolEnterprise[] {
  return caps.map((cap, index) => ({ id: IDS[index]!, cap, inventory: inventories[index]!, eligible: true }));
}

function withIdle(rows: PoolEnterprise[], idle: number[]): AdmissionEnterprise[] {
  return rows.map((row, index) => ({ ...row, eligibleIdle: idle[index]! }));
}

function counts(ids: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of ids) result[id] = (result[id] ?? 0) + 1;
  return result;
}

function admit(rows: AdmissionEnterprise[], caller = 'caller-1'): string[] {
  return rankEnterprisesForAdmission({ enterprises: rows, caller });
}

function firstCreation(rows: PoolEnterprise[], ordinal = 0): string | undefined {
  return rankEnterprisesForCreation({ enterprises: rows, ordinal })[0];
}

test('score is N*C_e - C*N_e over all active enterprises', () => {
  const rows = pool([5, 3, 2], [5, 1, 0]);
  assert.deepEqual(rows.map((row) => enterpriseShareScore(row, rows)), [-20, 8, 12]);
  const empty = pool([500, 300, 200], [0, 0, 0]);
  assert.deepEqual(empty.map((row) => enterpriseShareScore(row, empty)), [0, 0, 0]);
});

test('caps 9/1 with inventory 1/0 picks the small enterprise next', () => {
  assert.equal(firstCreation(pool([9, 1], [1, 0])), 'bravo');
  assert.equal(firstCreation(pool([600, 300, 100], [50, 23, 27])), 'alpha');
});

test('empty pool starts with the largest cap whatever the ordinal', () => {
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    assert.equal(firstCreation(pool([300, 500, 200], [0, 0, 0]), ordinal), 'bravo');
  }
  const order = rankEnterprisesForCreation({ enterprises: pool([300, 500, 200], [0, 0, 0]), ordinal: 0 });
  assert.deepEqual(order, ['bravo', 'alpha', 'charlie']);
});

test('empty pool with caps 500/300/200 and 50 creations registers 25/15/10', () => {
  const plan = planCreations({ enterprises: pool([500, 300, 200], [0, 0, 0]), deficit: 50, ordinal: 0 });
  assert.equal(plan.length, 50);
  assert.deepEqual(counts(plan), { alpha: 25, bravo: 15, charlie: 10 });
});

test('cap-full and unhealthy enterprises are not candidates but stay in the denominator', () => {
  const rows = pool([5, 3, 2], [5, 1, 0]);
  assert.deepEqual(rankEnterprisesForCreation({ enterprises: rows, ordinal: 0 }), ['charlie', 'bravo']);
  rows[2]!.eligible = false;
  assert.deepEqual(rankEnterprisesForCreation({ enterprises: rows, ordinal: 0 }), ['bravo']);
  const blocked = pool([10, 6, 3], [30, 2, 0]);
  blocked[0]!.eligible = false;
  assert.deepEqual(rankEnterprisesForCreation({ enterprises: blocked, ordinal: 0 }), ['bravo', 'charlie']);
  assert.deepEqual(rankEnterprisesForCreation({ enterprises: blocked.slice(1), ordinal: 0 }), ['charlie', 'bravo']);
});

test('over-cap enterprise is skipped for creation and creation stops when every cap is full', () => {
  const rows = pool([2, 1], [3, 0]);
  assert.deepEqual(rankEnterprisesForCreation({ enterprises: rows, ordinal: 0 }), ['bravo']);
  assert.deepEqual(planCreations({ enterprises: rows, deficit: 5, ordinal: 0 }), ['bravo']);
  assert.deepEqual(planCreations({ enterprises: [], deficit: 5, ordinal: 0 }), []);
});

test('planCreations does not mutate its input', () => {
  const rows = pool([5, 5], [0, 0]);
  planCreations({ enterprises: rows, deficit: 4, ordinal: 0 });
  assert.deepEqual(rows.map((row) => row.inventory), [0, 0]);
});

test('creation ties rotate by sorted id and ordinal, independent of input order', () => {
  const rows = pool([5, 5, 5], [1, 1, 1]);
  const reversed = [...rows].reverse();
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    const order = rankEnterprisesForCreation({ enterprises: rows, ordinal });
    assert.deepEqual(order, rankEnterprisesForCreation({ enterprises: reversed, ordinal }));
    assert.equal(order[0], IDS[ordinal % 3]);
  }
});

test('creation tie rotation has no long-run bias over 3000 picks', () => {
  const rows = pool([10_000, 10_000, 10_000], [7, 7, 7]);
  const firsts: string[] = [];
  for (let ordinal = 0; ordinal < 3000; ordinal += 1) firsts.push(firstCreation(rows, ordinal)!);
  for (const count of Object.values(counts(firsts))) assert.ok(Math.abs(count - 1000) <= 1);
  const plan = planCreations({ enterprises: pool([10_000, 10_000, 10_000], [0, 0, 0]), deficit: 3000, ordinal: 17 });
  for (const count of Object.values(counts(plan))) assert.ok(Math.abs(count - 1000) <= 1);
});

test('admission ranks by score and requires eligible idle members', () => {
  const rows = withIdle(pool([5, 3, 2], [5, 1, 0]), [0, 1, 1]);
  assert.deepEqual(admit(rows), ['charlie', 'bravo']);
  rows[0]!.eligibleIdle = 1;
  assert.deepEqual(admit(rows), ['charlie', 'bravo', 'alpha']);
  rows[2]!.eligible = false;
  assert.deepEqual(admit(rows), ['bravo', 'alpha']);
});

test('admission ties are deterministic per caller and independent of input order', () => {
  const rows = withIdle(pool([5, 5, 5], [2, 2, 2]), [1, 1, 1]);
  const reversed = [...rows].reverse();
  for (const caller of ['caller-a', 'caller-b', 'caller-c']) {
    const order = admit(rows, caller);
    assert.deepEqual(order, admit(rows, caller));
    assert.deepEqual(order, admit(reversed, caller));
  }
});

test('admission ties spread roughly uniformly across callers', () => {
  const rows = withIdle(pool([5, 5, 5], [2, 2, 2]), [1, 1, 1]);
  const firsts: string[] = [];
  for (let index = 0; index < 3000; index += 1) {
    firsts.push(admit(rows, `caller-${index}`)[0]!);
  }
  const result = counts(firsts);
  assert.deepEqual(Object.keys(result).sort(), IDS);
  for (const count of Object.values(result)) assert.ok(Math.abs(count - 1000) < 150, `count ${count}`);
});

test('replenishment deficit is max(0, T - I - P) and zero when paused', () => {
  assert.equal(replenishmentDeficit({ idleTarget: 10, readyIdle: 3, inFlight: 2, paused: false }), 5);
  assert.equal(replenishmentDeficit({ idleTarget: 10, readyIdle: 12, inFlight: 0, paused: false }), 0);
  assert.equal(replenishmentDeficit({ idleTarget: 10, readyIdle: 10, inFlight: 0, paused: false }), 0);
  assert.equal(replenishmentDeficit({ idleTarget: 10, readyIdle: 4, inFlight: 9, paused: false }), 0);
  assert.equal(replenishmentDeficit({ idleTarget: 10, readyIdle: 0, inFlight: 0, paused: true }), 0);
});

test('rejects duplicate ids and invalid counts', () => {
  const duplicate = [...pool([1], [0]), ...pool([2], [0])];
  assert.throws(() => rankEnterprisesForCreation({ enterprises: duplicate, ordinal: 0 }), RangeError);
  assert.throws(() => rankEnterprisesForCreation({ enterprises: pool([1.5], [0]), ordinal: 0 }), RangeError);
  assert.throws(() => rankEnterprisesForCreation({ enterprises: pool([1], [-1]), ordinal: 0 }), RangeError);
});
