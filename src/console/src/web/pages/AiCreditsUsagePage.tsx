import { useEffect, useState } from 'react';
import type { AiCreditsUsageDto } from '@ghcp/shared';
import { RefreshCw } from 'lucide-react';
import { readAiCreditsUsage, refreshAiCreditsUsage } from '../api/sso.js';
import { ErrorState, Info, LoadingState, MetricCard } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Card, CardTitle } from '../components/ui/card.js';
import { formatDate } from '../lib/format.js';
import { useEnterpriseScope, useScopeLifetime } from '../lib/scope.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;

function periodLabel(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}

function formatAiUnits(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCurrency(value: number): string {
  return value.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** AI Credits of the selected enterprise; a cached read falls back to one refresh when nothing is cached. */
export function AiCreditsUsagePage(props: { notify: Notify }) {
  const scope = useEnterpriseScope();
  const lifetime = useScopeLifetime();
  const [usage, setUsage] = useState<AiCreditsUsageDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const fetchUsage = async (refresh: boolean, signal: AbortSignal) => {
    if (refresh) return refreshAiCreditsUsage(scope.id, signal);
    try {
      return await readAiCreditsUsage(scope.id, signal);
    } catch {
      return refreshAiCreditsUsage(scope.id, signal);
    }
  };
  const load = async (refresh = false) => {
    const signal = lifetime.beginRead();
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchUsage(refresh, signal);
      if (!lifetime.current(signal)) return;
      setUsage(next);
      if (refresh) props.notify(`AI Credits usage of ${scope.id} refreshed.`);
    } catch (err) {
      if (lifetime.current(signal)) setError(message(err));
    } finally {
      if (lifetime.current(signal)) setLoading(false);
    }
  };
  useEffect(() => { void load(false); }, []);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <CardTitle className="mb-1">AI Credits Usage</CardTitle>
            <p className="text-sm text-slate-600">
              Copilot AI Credits consumption of {scope.displayName} from GitHub billing usage summary.
            </p>
          </div>
          <Button variant="secondary" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Refreshing...' : 'Refresh usage'}
          </Button>
        </div>
      </Card>
      {loading && !usage ? <LoadingState label="Loading AI Credits usage..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {usage ? <UsageDetails usage={usage} /> : null}
    </div>
  );
}

function UsageDetails({ usage }: { usage: AiCreditsUsageDto }) {
  const seatCost = `${formatCurrency(usage.seatPricePerMonth)} x ${usage.assignedSeatCount} seat(s). `
    + 'Local estimate, not a GitHub invoice.';
  return <>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <MetricCard title={`${periodLabel(usage.lastMonth)} usage`} value={formatAiUnits(usage.lastMonth.quantity)}
        detail={usage.lastMonth.unitType ?? 'AI Credits'} />
      <MetricCard title={`${periodLabel(usage.currentMonth)} usage`}
        value={formatAiUnits(usage.currentMonth.quantity)} detail={usage.currentMonth.unitType ?? 'AI Credits'} />
      <MetricCard title="Projected this month" value={formatAiUnits(usage.projectedCurrentMonthQuantity)}
        detail="Based on daily average so far" />
      <MetricCard title="Assigned seats" value={usage.assignedSeatCount}
        detail="Last-synced enterprise direct seats, including pending cancellations; may be stale." />
      <MetricCard title="Seat monthly cost" value={formatCurrency(usage.assignedSeatMonthlyCost)} detail={seatCost} />
    </div>
    <Card>
      <div className="grid gap-3 text-sm md:grid-cols-3">
        <Info label="Enterprise" value={usage.enterprise} />
        <Info label="Last fetched" value={formatDate(usage.fetchedAt)} />
        <Info label="Source" value="GitHub billing usage summary / copilot_ai_unit" />
      </div>
    </Card>
  </>;
}
