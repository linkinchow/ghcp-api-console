import type { EnterpriseScope, AiCreditsPeriodUsageDto } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { getDb } from './connection.js';

interface AiCreditsUsageRow {
  period_key: string;
  year: number;
  month: number;
  quantity: number;
  unit_type?: string;
  raw_json: string;
  fetched_at: string;
}

export interface AiCreditsUsageCacheRecord extends AiCreditsPeriodUsageDto {
  rawJson: unknown;
}

export function getAiCreditsUsagePeriod(year: number, month: number, scope: EnterpriseScope): AiCreditsUsageCacheRecord | undefined {
  getScopeProfile(scope);
  const row = getDb().prepare('SELECT * FROM sso_budget_cache WHERE enterprise_id = ? AND period_key = ?').get(scope.enterpriseId, periodKey(year, month)) as AiCreditsUsageRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function saveAiCreditsUsagePeriod(input: AiCreditsUsageCacheRecord, scope: EnterpriseScope): AiCreditsUsageCacheRecord {
  getScopeProfile(scope);
  getDb()
    .prepare(`
      INSERT INTO sso_budget_cache (
        enterprise_id, period_key, year, month, quantity, unit_type, raw_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(enterprise_id, period_key) DO UPDATE SET
        year = excluded.year,
        month = excluded.month,
        quantity = excluded.quantity,
        unit_type = excluded.unit_type,
        raw_json = excluded.raw_json,
        fetched_at = excluded.fetched_at
    `)
    .run(
      scope.enterpriseId,
      periodKey(input.year, input.month),
      input.year,
      input.month,
      input.quantity,
      input.unitType,
      JSON.stringify(input.rawJson),
      input.fetchedAt,
    );
  return input;
}

export function countAssignedCopilotSeats(scope: EnterpriseScope): number {
  getScopeProfile(scope);
  return (getDb().prepare("SELECT COUNT(*) AS count FROM sso_users WHERE enterprise_id = ? AND copilot_seat_status = 'assigned'").get(scope.enterpriseId) as { count: number }).count;
}

function mapRow(row: AiCreditsUsageRow): AiCreditsUsageCacheRecord {
  return {
    year: row.year,
    month: row.month,
    quantity: row.quantity,
    unitType: row.unit_type,
    rawJson: JSON.parse(row.raw_json) as unknown,
    fetchedAt: row.fetched_at,
  };
}

function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}
