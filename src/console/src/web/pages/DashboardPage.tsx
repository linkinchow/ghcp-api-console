import { useCallback, useEffect, useState } from 'react';
import type { ManagementSummary } from '@ghcp/shared';
import { RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { githubHost, listEnterprises, type EnterpriseListItem } from '../api/enterprises.js';
import { loginPath } from '../api/login.js';
import { getAccountsSummary } from '../api/proxy.js';
import { ssoPath } from '../api/sso.js';
import { ErrorState, LoadingState } from '../components/PageState.js';
import { Badge } from '../components/ui/badge.js';
import { Button, ButtonLink } from '../components/ui/button.js';
import { Card, CardTitle } from '../components/ui/card.js';
import { hashFor } from '../lib/hashState.js';
import { useScopeLifetime } from '../lib/scope.js';
import { enterpriseState } from './EnterpriseSelector.js';

type SummaryResult = { value?: ManagementSummary; error?: string };

interface EnterpriseCardData {
  accounts: SummaryResult;
  users: SummaryResult;
  tasks: SummaryResult;
}

function settled(result: PromiseSettledResult<ManagementSummary>): SummaryResult {
  if (result.status === 'fulfilled') return { value: result.value };
  return { error: result.reason instanceof Error ? result.reason.message : String(result.reason) };
}

async function loadCard(id: string, signal: AbortSignal): Promise<EnterpriseCardData> {
  const [accounts, users, tasks] = await Promise.allSettled([
    getAccountsSummary(id, signal),
    api<ManagementSummary>(`${ssoPath(id)}/users/summary`, { signal }),
    api<ManagementSummary>(`${loginPath(id)}/tasks/summary`, { signal }),
  ]);
  return { accounts: settled(accounts), users: settled(users), tasks: settled(tasks) };
}

/** One card per enterprise with its accounts, users, failed tasks, pool state and readiness. */
export function DashboardPage() {
  const lifetime = useScopeLifetime();
  const [items, setItems] = useState<EnterpriseListItem[]>();
  const [cards, setCards] = useState<Record<string, EnterpriseCardData>>({});
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<string>();
  const load = useCallback(async () => {
    const signal = lifetime.beginRead();
    setLoading(true);
    try {
      const list = await listEnterprises(signal);
      const loaded = await Promise.all(list.items.map((item) => loadCard(item.id, signal)));
      if (!lifetime.current(signal)) return;
      setItems(list.items);
      setCards(Object.fromEntries(list.items.map((item, index) => [item.id, loaded[index]!])));
      setError(undefined);
      setCheckedAt(new Date().toLocaleTimeString());
    } catch (err) {
      if (lifetime.current(signal)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (lifetime.current(signal)) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-slate-600">
          {checkedAt ? `Last checked ${checkedAt}` : 'Loading overview...'}
        </span>
        <Button variant="secondary" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh dashboard
        </Button>
      </div>
      {loading && !items ? <LoadingState label="Loading dashboard..." /> : null}
      {error ? <ErrorState message={`Enterprise overview unavailable: ${error}`} /> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {items?.map((item) => <EnterpriseCard key={item.id} item={item} data={cards[item.id]} />)}
      </div>
    </div>
  );
}

function EnterpriseCard(props: { item: EnterpriseListItem; data?: EnterpriseCardData }) {
  const { item, data } = props;
  const failed = data?.tasks.value ? data.tasks.value.counts.failed ?? 0 : undefined;
  return (
    <Card aria-label={`Enterprise ${item.id}`} className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle className="mb-0">{item.displayName}</CardTitle>
          <p className="break-all text-xs text-slate-500">{item.id} · {githubHost(item.githubBaseUrl)}</p>
        </div>
        <div className="flex flex-wrap gap-1"><Badge>{enterpriseState(item)}</Badge><ReadinessBadge item={item} /></div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Proxy accounts" result={data?.accounts} value={data?.accounts.value?.total} />
        <Metric label="SSO users" result={data?.users} value={data?.users.value?.total} />
        <Metric label="Failed tasks" result={data?.tasks} value={failed} />
        <PoolMetric item={item} />
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        <ButtonLink variant="secondary" size="sm" href={hashFor('accounts', item.id)}>Accounts</ButtonLink>
        <ButtonLink variant="secondary" size="sm" href={hashFor('tasks', item.id, 'status=failed')}>
          Failed tasks
        </ButtonLink>
        <ButtonLink variant="secondary" size="sm" href={hashFor('stats', item.id, 'success=false')}>
          Failed requests
        </ButtonLink>
      </div>
    </Card>
  );
}

function ReadinessBadge({ item }: { item: EnterpriseListItem }) {
  if (!item.readiness) return <Badge tone="muted">readiness unknown</Badge>;
  if (item.readiness.ready) return <Badge tone="success">ready</Badge>;
  return <Badge tone="danger" title={item.readiness.blockers.join(', ')}>not ready</Badge>;
}

function Metric(props: { label: string; result?: SummaryResult; value?: number }) {
  const shown = props.result?.error ? 'Unavailable' : props.value?.toLocaleString() ?? '-';
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-600">{props.label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-slate-950" title={props.result?.error}>{shown}</dd>
    </div>
  );
}

function PoolMetric({ item }: { item: EnterpriseListItem }) {
  const value = item.pool ? `${item.pool.inventory} / ${item.pool.maxAccounts}` : '-';
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-600">Pool inventory / cap</dt>
      <dd className="text-xl font-semibold tabular-nums text-slate-950">{value}</dd>
    </div>
  );
}
