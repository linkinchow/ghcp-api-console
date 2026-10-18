import type { AiCreditsPeriodUsageDto, AiCreditsUsageDto } from '@ghcp/shared';
import { externalFetch, nowIso } from '@ghcp/shared';
import {
  countAssignedCopilotSeats,
  getAiCreditsUsagePeriod,
  saveAiCreditsUsagePeriod,
  type AiCreditsUsageCacheRecord,
} from '../db/budgetRepo.js';
import type { SsoEnterprise } from '../enterprises.js';
import { requireSsoSecret } from '../enterpriseSecrets.js';

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

export function readAiCreditsUsage(enterprise: SsoEnterprise, now = new Date()): AiCreditsUsageDto | undefined {
  const current = currentPeriod(now);
  const last = previousPeriod(current);
  const currentUsage = getAiCreditsUsagePeriod(enterprise.id, current.year, current.month);
  const lastUsage = getAiCreditsUsagePeriod(enterprise.id, last.year, last.month);
  if (!currentUsage || !lastUsage) return undefined;
  return toUsageDto(enterprise, lastUsage, currentUsage, now);
}

export async function refreshAiCreditsUsage(enterprise: SsoEnterprise, now = new Date()): Promise<AiCreditsUsageDto> {
  const current = currentPeriod(now);
  const last = previousPeriod(current);
  const [lastUsage, currentUsage] = await Promise.all([
    fetchAndSaveAiCreditsUsage(enterprise, last),
    fetchAndSaveAiCreditsUsage(enterprise, current),
  ]);
  return toUsageDto(enterprise, lastUsage, currentUsage, now);
}

async function fetchAndSaveAiCreditsUsage(
  enterprise: SsoEnterprise,
  period: Period,
): Promise<AiCreditsUsageCacheRecord> {
  const res = await externalFetch(usageSummaryUrl(enterprise, period), {
    headers: {
      Authorization: `Bearer ${requireSsoSecret(enterprise, 'seatPat')}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  });
  if (!res.ok) throw new Error(`GitHub AI Credits usage query failed: ${res.status} ${await res.text()}`);
  const rawJson = (await res.json()) as BillingUsageSummary;
  const items = (rawJson.usageItems ?? []).filter((item) => item.sku === AI_CREDITS_SKU);
  const quantity = items.reduce((sum, item) => sum + numberOrZero(item.grossQuantity), 0);
  return saveAiCreditsUsagePeriod(enterprise.id, {
    year: rawJson.timePeriod?.year ?? period.year,
    month: rawJson.timePeriod?.month ?? period.month,
    quantity,
    unitType: items[0]?.unitType,
    rawJson,
    fetchedAt: nowIso(),
  });
}

/** `<apiBaseUrl>/enterprises/<slug>/settings/billing/usage/summary` of the enterprise (design §5.6). */
function usageSummaryUrl(enterprise: SsoEnterprise, period: Period): URL {
  const { apiBaseUrl, slug } = enterprise.endpoints;
  if (!slug) throw new Error(`${enterprise.id}.github.slug is not configured.`);
  const url = new URL(`${apiBaseUrl}/enterprises/${encodeURIComponent(slug)}/settings/billing/usage/summary`);
  url.searchParams.set('year', String(period.year));
  url.searchParams.set('month', String(period.month));
  url.searchParams.set('sku', AI_CREDITS_SKU);
  return url;
}

function toUsageDto(
  enterprise: SsoEnterprise,
  lastMonth: AiCreditsUsageCacheRecord,
  currentMonth: AiCreditsUsageCacheRecord,
  now: Date,
): AiCreditsUsageDto {
  const assignedSeatCount = countAssignedCopilotSeats(enterprise.id);
  return {
    enterprise: enterprise.endpoints.slug ?? enterprise.id,
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
