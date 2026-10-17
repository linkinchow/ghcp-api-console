import { createHash } from 'node:crypto';

/**
 * Pool scheduling across enterprises (design §5.8). Callers pass only `active` enterprises:
 * every row counts in the denominators C = ΣC_e and N = ΣN_e, while `eligible: false`
 * (temporarily unhealthy) only removes the row from the candidate list.
 */
export interface PoolEnterprise {
  id: string;
  /** C_e: the enterprise cap (`max_accounts`). */
  cap: number;
  /** N_e: every registered member, including failed and disabled ones. */
  inventory: number;
  eligible: boolean;
}

export interface AdmissionEnterprise extends PoolEnterprise {
  /** Ready idle members a caller could lease right now. */
  eligibleIdle: number;
}

export interface CreationRankingInput {
  enterprises: readonly PoolEnterprise[];
  /** Global account ordinal of the creation; rotates ties. */
  ordinal: number;
}

export interface AdmissionRankingInput {
  enterprises: readonly AdmissionEnterprise[];
  caller: string;
}

export interface ReplenishmentInput {
  /** T: global ready idle target. */
  idleTarget: number;
  /** I: global leasable ready idle members. */
  readyIdle: number;
  /** P: in-flight supply that will certainly become idle. */
  inFlight: number;
  paused: boolean;
}

export interface CreationPlanInput {
  enterprises: readonly PoolEnterprise[];
  deficit: number;
  /** Ordinal of the first creation; creation `i` uses `ordinal + i`. */
  ordinal: number;
}

interface PoolTotals {
  capacity: number;
  inventory: number;
}

type TieOrder = (a: string, b: string) => number;

export function rankEnterprisesForCreation(input: CreationRankingInput): string[] {
  assertEnterprises(input.enterprises);
  const rotation = rotationRanks(input.enterprises, input.ordinal);
  const candidates = input.enterprises.filter((row) => row.eligible && row.inventory < row.cap);
  return rankCandidates(input.enterprises, candidates, (a, b) => rotation.get(a)! - rotation.get(b)!);
}

export function rankEnterprisesForAdmission(input: AdmissionRankingInput): string[] {
  assertEnterprises(input.enterprises);
  const hashes = new Map(input.enterprises.map((row) => [row.id, callerHash(input.caller, row.id)]));
  const candidates = input.enterprises.filter((row) => row.eligible && row.eligibleIdle > 0);
  return rankCandidates(input.enterprises, candidates, (a, b) => compareText(hashes.get(a)!, hashes.get(b)!));
}

/** D = max(0, T − I − P); a global pause wins over everything. */
export function replenishmentDeficit(input: ReplenishmentInput): number {
  if (input.paused) return 0;
  return Math.max(0, input.idleTarget - input.readyIdle - input.inFlight);
}

/**
 * Chooses an enterprise for each of `deficit` creations, re-ranking after every pick with the
 * picked enterprise's inventory raised by one. Stops early once no enterprise is below its cap.
 */
export function planCreations(input: CreationPlanInput): string[] {
  const enterprises = input.enterprises.map((row) => ({ ...row }));
  const byId = new Map(enterprises.map((row) => [row.id, row]));
  const plan: string[] = [];
  while (plan.length < input.deficit) {
    const [next] = rankEnterprisesForCreation({ enterprises, ordinal: input.ordinal + plan.length });
    if (next === undefined) break;
    byId.get(next)!.inventory += 1;
    plan.push(next);
  }
  return plan;
}

/**
 * S_e = N × C_e − C × N_e is C × N × (C_e / C − N_e / N) without division: how far the
 * enterprise's current share of inventory falls short of its share of capacity. It deliberately
 * uses the current inventory, not an (N + 1) look-ahead, and not cap utilisation N_e / C_e.
 */
export function enterpriseShareScore(enterprise: PoolEnterprise, enterprises: readonly PoolEnterprise[]): number {
  const totals = poolTotals(enterprises);
  return shareScore(enterprise, totals);
}

function rankCandidates(
  enterprises: readonly PoolEnterprise[],
  candidates: readonly PoolEnterprise[],
  tieOrder: TieOrder,
): string[] {
  const totals = poolTotals(enterprises);
  const primary = totals.inventory === 0 ? byCapDescending : byScoreDescending(totals);
  return [...candidates]
    .sort((a, b) => primary(a, b) || tieOrder(a.id, b.id) || compareText(a.id, b.id))
    .map((row) => row.id);
}

function byCapDescending(a: PoolEnterprise, b: PoolEnterprise): number {
  return b.cap - a.cap;
}

function byScoreDescending(totals: PoolTotals): (a: PoolEnterprise, b: PoolEnterprise) => number {
  return (a, b) => shareScore(b, totals) - shareScore(a, totals);
}

function shareScore(enterprise: PoolEnterprise, totals: PoolTotals): number {
  return totals.inventory * enterprise.cap - totals.capacity * enterprise.inventory;
}

function poolTotals(enterprises: readonly PoolEnterprise[]): PoolTotals {
  let capacity = 0;
  let inventory = 0;
  for (const row of enterprises) {
    capacity += row.cap;
    inventory += row.inventory;
  }
  return { capacity, inventory };
}

/** Sorted ids rotated left by `ordinal % n`, so ties never depend on registry order. */
function rotationRanks(enterprises: readonly PoolEnterprise[], ordinal: number): Map<string, number> {
  const ids = enterprises.map((row) => row.id).sort(compareText);
  const count = ids.length;
  const offset = count === 0 ? 0 : ((ordinal % count) + count) % count;
  return new Map(ids.map((id, index) => [id, (index - offset + count) % count]));
}

function callerHash(caller: string, id: string): string {
  return createHash('sha256').update(`${caller}\0${id}`).digest('hex');
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function assertEnterprises(enterprises: readonly PoolEnterprise[]): void {
  const ids = new Set<string>();
  for (const row of enterprises) {
    if (ids.has(row.id)) throw new RangeError(`duplicate enterprise ${row.id}`);
    if (!isCount(row.cap) || !isCount(row.inventory)) throw new RangeError(`invalid pool counts for ${row.id}`);
    ids.add(row.id);
  }
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
