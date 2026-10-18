import { useCallback, useEffect, useState } from 'react';
import { ConsoleApiError } from '../api/client.js';
import { githubHost, listEnterprises, type EnterpriseList, type EnterpriseListItem } from '../api/enterprises.js';
import { getUserPoolOverview, reconcileUserPool, type UserPoolOverview } from '../api/userPool.js';
import { ErrorState, LoadingState } from '../components/PageState.js';
import { PoolSettingsEditor } from '../components/PoolSettingsEditor.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/card.js';
import {
  enterpriseShares, formatShare, lifecycleActions, nameCapacityRemaining, poolCount, type EnterpriseShares,
  type LifecycleAction,
} from '../lib/enterprisePool.js';
import { useScopeLifetime } from '../lib/scope.js';
import { poolDate, poolWarnings } from '../lib/userPool.js';
import { CapDialog, LifecycleDialog } from './EnterprisePolicyDialogs.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
type Editing = { kind: 'cap'; id: string } | { kind: 'lifecycle'; id: string; action: LifecycleAction };

const ACTION_LABELS: Record<LifecycleAction, string> = { activate: 'Activate', drain: 'Drain', resume: 'Resume' };
const HEADERS = [
  'Enterprise', 'State', 'Inventory / cap', 'Target share', 'Actual share', 'Score', 'Ready idle', 'Leased',
  'In flight', 'Failed / disabled', 'Blockers', 'Actions',
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Global pool overview (design §7): process-wide settings plus one row per enterprise with its lifecycle,
 * cap and scheduling shares. Members, leases and events are on the enterprise-scoped Pool members page.
 */
export function EnterprisePoolPage({ notify }: { notify: Notify }) {
  const lifetime = useScopeLifetime();
  const [overview, setOverview] = useState<UserPoolOverview>();
  const [list, setList] = useState<EnterpriseList>();
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [editing, setEditing] = useState<Editing>();

  // Dialog and settings callbacks may settle after the page unmounted; they must not read or notify then.
  const notifyActive: Notify = (text, tone) => {
    if (lifetime.active()) notify(text, tone);
  };
  const load = useCallback(async () => {
    if (!lifetime.active()) return;
    const signal = lifetime.beginRead();
    setLoading(true);
    const [pool, enterprises] = await Promise.allSettled([getUserPoolOverview(signal), listEnterprises(signal)]);
    if (!lifetime.current(signal)) return;
    applyOverview(pool);
    if (enterprises.status === 'fulfilled') setList(enterprises.value);
    const failure = [pool, enterprises].find(isUnexpectedFailure);
    setError(failure ? message(failure.reason) : undefined);
    setLoading(false);
  }, []);
  const applyOverview = (result: PromiseSettledResult<UserPoolOverview>) => {
    const off = result.status === 'rejected' && isPoolDisabled(result.reason);
    setDisabled(off);
    if (result.status === 'fulfilled') setOverview(result.value);
    if (off) setOverview(undefined);
  };
  useEffect(() => { void load(); }, [load]);

  const reconcile = async () => {
    setBusy('reconcile');
    try {
      await reconcileUserPool();
      notifyActive('Reconciliation scheduled. The worker still respects pause and account caps.');
    } catch (err) {
      if (lifetime.active()) setError(message(err));
    } finally {
      if (lifetime.active()) setBusy(undefined);
    }
  };
  const closeEditing = () => setEditing(undefined);
  const editingItem = list?.items.find((item) => item.id === editing?.id);
  return (
    <div className="space-y-5">
      <PoolOverviewHeader overview={overview} loading={loading} busy={Boolean(busy)} disabled={disabled}
        onRefresh={() => void load()} onReconcile={() => void reconcile()} />
      {disabled ? <PoolDisabledNotice /> : null}
      {loading && !list ? <LoadingState label="Loading pool overview…" /> : null}
      {error ? <ErrorState message={`${error} Use Refresh to retry.`} /> : null}
      {overview ? <PoolWarnings overview={overview} /> : null}
      {overview ? (
        <PoolSettingsEditor settings={overview.settings} limits={overview.limits} disabled={Boolean(busy)}
          notify={notifyActive} onBusy={(saving) => setBusy(saving ? 'settings' : undefined)} onRefresh={load} />
      ) : null}
      {list ? <EnterprisePoolTable list={list} disabled={Boolean(busy) || disabled} onEdit={setEditing} /> : null}
      <ShareNote />
      {editing?.kind === 'cap' && editingItem && list ? (
        <CapDialog item={editingItem} remaining={nameCapacityRemaining(list)} notify={notifyActive}
          onClose={closeEditing} onChanged={load} />
      ) : null}
      {editing?.kind === 'lifecycle' && editingItem ? (
        <LifecycleDialog item={editingItem} action={editing.action} notify={notifyActive}
          onClose={closeEditing} onChanged={load} />
      ) : null}
    </div>
  );
}

function isPoolDisabled(error: unknown): boolean {
  return error instanceof ConsoleApiError && error.code === 'pool_mode_disabled';
}

function isUnexpectedFailure(result: PromiseSettledResult<unknown>): result is PromiseRejectedResult {
  return result.status === 'rejected' && !isPoolDisabled(result.reason);
}

function PoolOverviewHeader(props: {
  overview?: UserPoolOverview; loading: boolean; busy: boolean; disabled: boolean;
  onRefresh: () => void; onReconcile: () => void;
}) {
  const counts = props.overview?.counts;
  return (
    <Card>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="max-w-3xl">
          <CardTitle className="mb-1">Pool overview</CardTitle>
          <CardDescription className="mb-0">
            One exclusive account per authenticated LiteLLM caller key, drawn from the enterprises below.
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={props.loading || props.busy} onClick={props.onRefresh}>
            {props.loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button disabled={!props.overview || props.busy || props.disabled} onClick={props.onReconcile}>
            Reconcile now
          </Button>
        </div>
      </div>
      {counts && props.overview ? (
        <p className="mt-3 text-xs text-slate-500">
          All enterprises: {counts.total.toLocaleString()} accounts, {counts.ready_idle.toLocaleString()} ready idle,
          {' '}{counts.leased.toLocaleString()} leased. Snapshot {poolDate(props.overview.observedAt)}.
        </p>
      ) : null}
    </Card>
  );
}

function PoolDisabledNotice() {
  return (
    <Card>
      <CardTitle>User pool is disabled</CardTitle>
      <p className="max-w-3xl text-sm text-slate-600">
        The Proxy is running without caller-lease routing. Set <code>ACCOUNT_ROUTING_MODE=caller-lease</code> and
        its required pool configuration on the Proxy, then refresh this page.
      </p>
    </Card>
  );
}

function PoolWarnings({ overview }: { overview: UserPoolOverview }) {
  const warnings = poolWarnings(overview.counts, overview.settings);
  if (!warnings.length) return null;
  return (
    <section aria-label="Pool warnings" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <h3 className="font-semibold">Attention needed</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </section>
  );
}

function ShareNote() {
  return (
    <p className="text-xs text-slate-500">
      Inventory counts pool accounts registered for an enterprise; it is not a billing figure. Target and actual
      shares steer which enterprise receives new accounts; they are not traffic quotas.
    </p>
  );
}

function EnterprisePoolTable(props: { list: EnterpriseList; disabled: boolean; onEdit: (editing: Editing) => void }) {
  const shares = enterpriseShares(props.list.items);
  const remaining = nameCapacityRemaining(props.list);
  return (
    <Card className="min-w-0">
      <CardTitle>Enterprises</CardTitle>
      <p className="mb-3 text-sm text-slate-600">
        Name catalog: {remaining.toLocaleString()} of {props.list.nameCapacity.toLocaleString()} names remain
        for cap increases across all enterprises.
      </p>
      <div className="max-h-[65vh] overflow-auto rounded-md border border-slate-200" role="region"
        aria-label="Enterprise pool table" tabIndex={0}>
        <table className="pool-table w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50"><tr>{HEADERS.map(headerCell)}</tr></thead>
          <tbody>
            {props.list.items.map((item) => (
              <EnterpriseRow key={item.id} item={item} shares={shares.get(item.id)} disabled={props.disabled}
                onEdit={props.onEdit} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function headerCell(header: string) {
  return <th key={header} scope="col" className="whitespace-nowrap px-3 py-3 text-xs font-semibold">{header}</th>;
}

function EnterpriseRow(props: {
  item: EnterpriseListItem; shares?: EnterpriseShares; disabled: boolean; onEdit: (editing: Editing) => void;
}) {
  const { item } = props;
  const count = (key: string) => poolCount(item, key)?.toLocaleString() ?? '—';
  return (
    <tr data-enterprise={item.id}>
      <td>
        <p className="font-medium">{item.displayName}</p>
        <p className="text-xs text-slate-500">{item.id} · {githubHost(item.githubBaseUrl)}</p>
      </td>
      <td><StateBadge item={item} /></td>
      <td className="tabular-nums">{item.pool ? `${item.pool.inventory} / ${item.pool.maxAccounts}` : '—'}</td>
      <td className="tabular-nums">{formatShare(props.shares?.target ?? null)}</td>
      <td className="tabular-nums">{formatShare(props.shares?.actual ?? null)}</td>
      <td className="tabular-nums">{item.shareScore ?? '—'}</td>
      <td className="tabular-nums">{count('ready_idle')}</td>
      <td className="tabular-nums">{count('leased')}</td>
      <td className="tabular-nums">{count('provisioning')}</td>
      <td className="tabular-nums">{`${count('failed')} / ${count('disabled')}`}</td>
      <td><ReadinessCell item={item} /></td>
      <td><RowActions item={item} disabled={props.disabled} onEdit={props.onEdit} /></td>
    </tr>
  );
}

function StateBadge({ item }: { item: EnterpriseListItem }) {
  const state = item.pool?.state;
  const tone = state === 'active' ? 'success' : state === 'draining' ? 'warning' : 'default';
  return <Badge tone={tone}>{state ?? 'no pool policy'}</Badge>;
}

function ReadinessCell({ item }: { item: EnterpriseListItem }) {
  if (!item.readiness) return <span className="text-xs text-slate-500">Readiness unknown</span>;
  if (item.readiness.ready) return <span className="text-xs text-slate-600">None</span>;
  return <span className="break-words text-xs text-red-700">{item.readiness.blockers.join(', ')}</span>;
}

function RowActions(props: { item: EnterpriseListItem; disabled: boolean; onEdit: (editing: Editing) => void }) {
  const { item } = props;
  if (!item.pool) return <span className="text-xs text-slate-500">—</span>;
  const label = `${item.displayName} (${item.id})`;
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={props.disabled} aria-label={`Edit cap of ${label}`}
        onClick={() => props.onEdit({ kind: 'cap', id: item.id })}>Edit cap</Button>
      {lifecycleActions(item.pool.state).map((action) => (
        <Button key={action} size="sm" variant={action === 'drain' ? 'dangerOutline' : 'secondary'}
          disabled={props.disabled} aria-label={`${ACTION_LABELS[action]} ${label}`}
          onClick={() => props.onEdit({ kind: 'lifecycle', id: item.id, action })}>
          {ACTION_LABELS[action]}
        </Button>
      ))}
    </div>
  );
}
