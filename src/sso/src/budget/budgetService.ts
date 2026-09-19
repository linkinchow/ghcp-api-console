import type { EnterpriseScope } from '@ghcp/shared';
import type { AiCreditsPeriodUsageDto, AiCreditsUsageDto } from '@ghcp/shared';
import { nowIso } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';
import { countAssignedCopilotSeats, getAiCreditsUsagePeriod, saveAiCreditsUsagePeriod, type AiCreditsUsageCacheRecord } from '../db/budgetRepo.js';

const AI_CREDITS_SKU = 'copilot_ai_unit';
const SEAT_PRICE_PER_MONTH = 19;

interface BillingUsageSummary {
  timePeriod?: {
    year?: number;
    month?: number;
  };
  enterprise?: string;
  usageItems?: BillingUsageItem[];
}

interface BillingUsageItem {
  sku?: string;
  grossQuantity?: number;
  unitType?: string;
}

interface Period {
  year: number;
  month: number;
}

export function readAiCreditsUsage(now = new Date(), scope: EnterpriseScope): AiCreditsUsageDto | undefined {
  const current = currentPeriod(now);
  const last = previousPeriod(current);
  const currentUsage = getAiCreditsUsagePeriod(current.year, current.month, scope);
  const lastUsage = getAiCreditsUsagePeriod(last.year, last.month, scope);
  if (!currentUsage || !lastUsage) return undefined;
  return toUsageDto(lastUsage, currentUsage, now, scope);
}

export async function refreshAiCreditsUsage(now = new Date(), scope: EnterpriseScope): Promise<AiCreditsUsageDto> {
  const current = currentPeriod(now);
  const last = previousPeriod(current);
  const [lastUsage, currentUsage] = await Promise.all([
    fetchAndSaveAiCreditsUsage(last, scope),
    fetchAndSaveAiCreditsUsage(current, scope),
  ]);
  return toUsageDto(lastUsage, currentUsage, now, scope);
}

async function fetchAndSaveAiCreditsUsage(period: Period, scope: EnterpriseScope): Promise<AiCreditsUsageCacheRecord> {
  if (!readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)) throw new Error('GITHUB_COPILOT_SEAT_PAT is required to query AI Credits usage.');
  const url = new URL(`${getScopeProfile(scope).sso.githubApiBaseUrl.replace(/\/+$/, '')}/enterprises/${encodeURIComponent(getScopeProfile(scope).slug)}/settings/billing/usage/summary`);
  url.searchParams.set('year', String(period.year));
  url.searchParams.set('month', String(period.month));
  url.searchParams.set('sku', AI_CREDITS_SKU);
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${readEnterpriseSecret(getScopeProfile(scope).sso.seatPatRef)}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  });
  if (!res.ok) throw new Error(`GitHub AI Credits usage query failed: ${res.status}`);
  const rawJson = (await res.json()) as BillingUsageSummary;
  if (rawJson.enterprise !== undefined && rawJson.enterprise !== getScopeProfile(scope).slug) throw new Error('AI Credits enterprise response mismatch.');
  if ((rawJson.timePeriod?.year !== undefined && rawJson.timePeriod.year !== period.year) || (rawJson.timePeriod?.month !== undefined && rawJson.timePeriod.month !== period.month)) throw new Error('AI Credits period response mismatch.');
  const items = (rawJson.usageItems ?? []).filter((item) => item.sku === AI_CREDITS_SKU);
  const quantity = items.reduce((sum, item) => sum + numberOrZero(item.grossQuantity), 0);
  return saveAiCreditsUsagePeriod({
    year: rawJson.timePeriod?.year ?? period.year,
    month: rawJson.timePeriod?.month ?? period.month,
    quantity,
    unitType: items[0]?.unitType,
    rawJson,
    fetchedAt: nowIso(),
  }, scope);
}

function toUsageDto(lastMonth: AiCreditsUsageCacheRecord, currentMonth: AiCreditsUsageCacheRecord, now: Date, scope: EnterpriseScope): AiCreditsUsageDto {
  const assignedSeatCount = countAssignedCopilotSeats(scope);
  return {
    enterpriseId: scope.enterpriseId,
    enterprise: getScopeProfile(scope).slug,
    lastMonth: toPeriodDto(lastMonth),
    currentMonth: toPeriodDto(currentMonth),
    projectedCurrentMonthQuantity: projectCurrentMonthQuantity(currentMonth.quantity, now),
    assignedSeatCount,
    assignedSeatMonthlyCost: assignedSeatCount * SEAT_PRICE_PER_MONTH,
    seatPricePerMonth: SEAT_PRICE_PER_MONTH,
    fetchedAt: latestIso(lastMonth.fetchedAt, currentMonth.fetchedAt),
  };
}

function toPeriodDto(usage: AiCreditsUsageCacheRecord): AiCreditsPeriodUsageDto {
  return {
    year: usage.year,
    month: usage.month,
    quantity: usage.quantity,
    unitType: usage.unitType,
    fetchedAt: usage.fetchedAt,
  };
}

function currentPeriod(now: Date): Period {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function previousPeriod(period: Period): Period {
  return period.month === 1 ? { year: period.year - 1, month: 12 } : { year: period.year, month: period.month - 1 };
}

function projectCurrentMonthQuantity(quantity: number, now: Date): number {
  const elapsedDays = Math.max(1, now.getUTCDate());
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return quantity / elapsedDays * daysInMonth;
}

function latestIso(left: string | undefined, right: string | undefined): string {
  if (!left) return right ?? nowIso();
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
