import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ConsoleApiError } from '../api/client.js';
import {
  getUserPoolOverview, reconcileUserPool, releaseUserPoolLease, updateUserPoolAccount, updateUserPoolSettings,
  type UserPoolAccount, type UserPoolAccountAction, type UserPoolEvent, type UserPoolLease,
  type UserPoolLimits, type UserPoolOverview, type UserPoolSettings,
} from '../api/userPool.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { formatCallerKeyHash, parsePoolSettingsDraft, poolDate, poolSettingsDraft, poolWarnings } from '../lib/userPool.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
type Tab = 'accounts' | 'leases' | 'events';
type Confirmation = { kind: 'release'; lease: UserPoolLease } | { kind: 'disable'; account: UserPoolAccount };
const PAGE_SIZE = 25;
const selectClass = 'rounded-md border border-slate-300 bg-white px-3 py-2 text-sm';
const stateLabels: Record<string, string> = {
  ready_idle: 'Ready idle', active: 'Active leased', provisional: 'Provisional',
  provisioning: 'Provisioning', cooling: 'Cooling', failed: 'Failed', disabled: 'Disabled', catalog: 'Catalog request',
};

export function UserPoolPage({ notify }: { notify: Notify }) {
  const [data, setData] = useState<UserPoolOverview>();
  const [loading, setLoading] = useState(true);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tab, setTab] = useState<Tab>('accounts');
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const request = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (background = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!background) setLoading(true);
    try {
      const next = await getUserPoolOverview(controller.signal);
      if (controller.signal.aborted) return;
      setData(next);
      setDisabled(false);
      setError(undefined);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ConsoleApiError && err.code === 'pool_mode_disabled') {
        setDisabled(true);
        setData(undefined);
        setConfirmation(undefined);
        setError(undefined);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!autoRefresh || busy) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true);
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, busy, load]);

  const perform = async (key: string, action: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(key);
    request.current?.abort();
    setActionError(undefined);
    try {
      await action();
      setConfirmation(undefined);
      notify(success);
      await load();
    } catch (err) {
      setActionError(errorMessage(err));
      if (err instanceof ConsoleApiError && err.code === 'pool_mode_disabled') await load();
    } finally {
      setLoading(false);
      setBusy(undefined);
    }
  };
  const accountAction = (account: UserPoolAccount, action: UserPoolAccountAction) => {
    void perform(`${action}:${account.identity}`, () => updateUserPoolAccount(account.identity, action),
      action === 'disable' ? `${account.identity} disabled. No new requests will use this account.` : `${account.identity} queued for revalidation.`);
  };
  const warnings = data ? poolWarnings(data.counts, data.settings) : [];
  const search = query.trim().toLowerCase();
  const accounts = data?.accounts.filter((account) => (!state || accountState(account) === state)
    && `${account.identity} ${account.ghLogin ?? ''} ${account.callerKeyHash ?? ''}`.toLowerCase().includes(search)) ?? [];
  const leases = data?.leases.filter((lease) => (!state || lease.phase === state)
    && `${lease.memberIdentity} ${lease.callerKeyHash ?? ''} ${lease.leaseId}`.toLowerCase().includes(search)) ?? [];
  const events = data?.events.filter((event) => `${event.action} ${event.identity ?? ''} ${event.callerKeyHash ?? ''} ${event.leaseId ?? ''} ${event.detail ?? ''}`.toLowerCase().includes(search)) ?? [];
  const total = tab === 'accounts' ? accounts.length : tab === 'leases' ? leases.length : events.length;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  const start = (currentPage - 1) * PAGE_SIZE;
  const controlsDisabled = Boolean(busy) || disabled || Boolean(error);

  return (
    <div className="user-pool space-y-5">
      <Card>
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <CardTitle className="mb-1">Default user pool</CardTitle>
            <CardDescription className="mb-0">
              One exclusive account per authenticated LiteLLM caller key. Caller key hashes use <code>sha256:&lt;64 hex characters&gt;</code>, never an alias or email.
            </CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
              Refresh every 10s
            </label>
            <Button variant="secondary" disabled={loading || Boolean(busy)} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
            <Button disabled={!data || controlsDisabled} onClick={() => void perform('reconcile', reconcileUserPool, 'Reconciliation scheduled. The worker still respects pause and account limits.')}>
              {busy === 'reconcile' ? 'Scheduling…' : 'Reconcile now'}
            </Button>
          </div>
        </div>
        {data ? <p className="mt-3 text-xs text-slate-500">Snapshot {poolDate(data.observedAt)}. Reconcile requests a worker pass; it does not wait for provisioning to finish.</p> : null}
      </Card>

      {disabled ? (
        <Card>
          <CardTitle>User pool is disabled</CardTitle>
          <p className="max-w-3xl text-sm text-slate-600">The Proxy is running without caller-lease routing. Set <code>ACCOUNT_ROUTING_MODE=caller-lease</code> and its required pool configuration on the Proxy, then refresh this page. Pool controls are unavailable in direct mode.</p>
        </Card>
      ) : null}
      {loading && !data ? <p role="status" className="text-sm text-slate-600">Loading user pool…</p> : null}
      {error ? <ErrorNotice>{error}{data ? ' The last successful snapshot is shown; controls are disabled until refresh succeeds.' : ' Check Proxy connectivity and use Refresh to retry.'}</ErrorNotice> : null}
      {actionError && !confirmation ? <ErrorNotice>{actionError}</ErrorNotice> : null}

      {data ? (
        <>
          {warnings.length ? (
            <section aria-label="Pool warnings" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-slate-800">
              <h3 className="font-semibold">Attention needed</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </section>
          ) : null}
          <section aria-label="Pool overview" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 text-sm">
              <h3 className="font-semibold text-slate-950">Account capacity</h3>
              <span>{data.counts.total.toLocaleString()} / {data.settings.max_accounts.toLocaleString()} accounts · Idle target {data.settings.idle_target.toLocaleString()}</span>
            </div>
            <dl className="grid grid-cols-2 divide-x divide-slate-200 sm:grid-cols-4 xl:grid-cols-7">
              {([
                ['Ready idle', data.counts.ready_idle, 'Ready to assign to a new caller key'],
                ['Active leased', data.counts.leased, 'Leases activated by a successful inference'],
                ['Provisional', data.counts.provisional, 'Reserved; no successful inference yet'],
                ['Provisioning', data.counts.provisioning, 'SSO, seat, login, or warmup in progress'],
                ['Cooling', data.counts.cooling, 'Temporarily unavailable'],
                ['Failed', data.counts.failed, 'Provisioning or credential recovery required'],
                ['Disabled', data.counts.disabled, 'Excluded by an administrator'],
              ] as const).map(([label, value, description]) => (
                <div key={label} className="min-w-0 px-4 py-4" title={description}>
                  <dt className="text-sm text-slate-600">{label}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-950">{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500">Lease counts can overlap cooling or disabled accounts while requests finish; these counts are not a sum of total inventory.</p>
          </section>

          <PoolSettingsEditor settings={data.settings} limits={data.limits} disabled={controlsDisabled} notify={notify}
            onBusy={(saving) => setBusy(saving ? 'settings' : undefined)} onRefresh={() => load()} />

          <Card className="min-w-0">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <nav aria-label="User pool lists" className="flex flex-wrap gap-2">
                {(['accounts', 'leases', 'events'] as const).map((value) => (
                  <Button key={value} variant={tab === value ? 'primary' : 'secondary'} aria-pressed={tab === value}
                    onClick={() => { setTab(value); setState(''); setPage(1); }}>
                    {value === 'accounts' ? 'Accounts' : value === 'leases' ? 'Leases' : 'Recent events'}
                  </Button>
                ))}
              </nav>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input aria-label="Search pool records" className="w-full sm:w-80" value={query} placeholder="Account, caller key hash, or lease ID"
                  onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
                {tab !== 'events' ? (
                  <select aria-label="Filter pool state" className={selectClass} value={state} onChange={(event) => { setState(event.target.value); setPage(1); }}>
                    <option value="">All states</option>
                    {(tab === 'leases' ? ['active', 'provisional'] : Object.keys(stateLabels)).map((value) => <option key={value} value={value}>{stateLabels[value]}</option>)}
                  </select>
                ) : null}
              </div>
            </div>
            <p className="my-3 text-xs text-slate-500">
              {tab === 'accounts' ? `Showing the first ${data.accounts.length} of ${data.counts.total} accounts (limit ${data.listLimits.accounts}).`
                : tab === 'leases' ? `Showing the latest ${data.leases.length} of ${data.counts.leased + data.counts.provisional} leases (limit ${data.listLimits.leases}).`
                  : `Latest ${data.events.length} events (up to ${data.listLimits.events}); older events are not shown.`}
              {' '}Search and filters apply to loaded records only.
            </p>
            {tab === 'accounts' ? <AccountsTable accounts={accounts.slice(start, start + PAGE_SIZE)} disabled={controlsDisabled}
              onAction={(account, action) => action === 'disable' ? (setActionError(undefined), setConfirmation({ kind: 'disable', account })) : accountAction(account, action)} /> : null}
            {tab === 'leases' ? <LeasesTable leases={leases.slice(start, start + PAGE_SIZE)} disabled={controlsDisabled}
              onRelease={(lease) => { setActionError(undefined); setConfirmation({ kind: 'release', lease }); }} /> : null}
            {tab === 'events' ? <EventsTable events={events.slice(start, start + PAGE_SIZE)} /> : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
              <p>{total ? `${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total} matching records` : 'No matching records'}</p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</Button>
                <span>Page {currentPage} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span>
                <Button variant="secondary" disabled={currentPage * PAGE_SIZE >= total} onClick={() => setPage(currentPage + 1)}>Next</Button>
              </div>
            </div>
          </Card>
        </>
      ) : null}
      {confirmation ? <PoolConfirmation value={confirmation} busy={Boolean(busy)} error={actionError}
        onClose={() => { if (!busy) { setConfirmation(undefined); setActionError(undefined); } }}
        onConfirm={() => confirmation.kind === 'disable' ? accountAction(confirmation.account, 'disable')
          : void perform(`release:${confirmation.lease.leaseId}`, () => releaseUserPoolLease(confirmation.lease.leaseId), 'Lease released. The caller key may acquire a different account on its next request.')} /> : null}
    </div>
  );
}

function PoolSettingsEditor(props: {
  settings: UserPoolSettings; limits: UserPoolLimits; disabled: boolean; notify: Notify;
  onBusy: (saving: boolean) => void; onRefresh: () => Promise<void>;
}) {
  const [base, setBase] = useState(props.settings);
  const [draft, setDraft] = useState(() => poolSettingsDraft(props.settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!dirty) {
      setBase(props.settings);
      setDraft(poolSettingsDraft(props.settings));
    }
  }, [props.settings, dirty]);

  const reload = () => { setBase(props.settings); setDraft(poolSettingsDraft(props.settings)); setDirty(false); setError(undefined); };
  const save = async () => {
    if (saving || props.disabled) return;
    setError(undefined);
    let changes;
    try { changes = parsePoolSettingsDraft(draft, props.limits); }
    catch (err) { setError(errorMessage(err)); return; }
    setSaving(true);
    props.onBusy(true);
    try {
      const next = await updateUserPoolSettings(base.version, changes);
      setBase(next);
      setDraft(poolSettingsDraft(next));
      setDirty(false);
      props.notify('Pool settings saved. Changes apply to future provisioning and lease renewals.');
      await props.onRefresh();
    } catch (err) {
      if (err instanceof ConsoleApiError && err.code === 'settings_version_conflict') {
        await props.onRefresh();
        setError('Settings changed in another session. Your draft was not saved. Use “Reload latest settings” to discard it and review the current values.');
      } else setError(errorMessage(err));
    } finally {
      setSaving(false);
      props.onBusy(false);
    }
  };
  return (
    <Card>
      <CardTitle>Pool settings</CardTitle>
      <CardDescription>Keep an idle reserve without exceeding the account cap. Lowering limits never deletes accounts. Lease TTL is renewed only after successful inference.</CardDescription>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={props.disabled || saving} className="space-y-4">
          <legend className="sr-only">Capacity and lease settings</legend>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Ready idle target
              <Input type="number" min={0} max={props.limits.maxAccounts} step={1} required value={draft.idleTarget}
                onChange={(event) => { setDraft({ ...draft, idleTarget: event.target.value }); setDirty(true); }} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Maximum accounts
              <Input type="number" min={1} max={props.limits.maxAccounts} step={1} required value={draft.maxAccounts}
                onChange={(event) => { setDraft({ ...draft, maxAccounts: event.target.value }); setDirty(true); }} />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Lease TTL (seconds)
              <Input type="number" min={props.limits.minLeaseSeconds} max={props.limits.maxLeaseSeconds} step={1} required value={draft.leaseSeconds}
                onChange={(event) => { setDraft({ ...draft, leaseSeconds: event.target.value }); setDirty(true); }} />
              <span className="text-xs font-normal text-slate-500">{props.limits.minLeaseSeconds}–{props.limits.maxLeaseSeconds.toLocaleString()} seconds</span>
            </label>
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={draft.paused} onChange={(event) => { setDraft({ ...draft, paused: event.target.checked }); setDirty(true); }} />
            <span>Pause prewarming<span className="block text-xs text-slate-500">Stops new provisioning work, not caller traffic. In-flight provisioning may finish its current step.</span></span>
          </label>
        </fieldset>
        {error ? <div className="mt-3"><ErrorNotice>{error}</ErrorNotice></div> : null}
        {dirty && base.version !== props.settings.version ? <p className="mt-3 text-sm text-amber-800">Newer settings are available (version {props.settings.version}). Your draft still uses version {base.version}.</p> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-xs text-slate-500">Editing version {base.version}{dirty ? ' · Unsaved changes' : ''}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={reload} disabled={!dirty || props.disabled || saving}>Reload latest settings</Button>
            <Button type="submit" disabled={!dirty || props.disabled || saving}>{saving ? 'Saving…' : 'Save and apply'}</Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

function AccountsTable(props: { accounts: UserPoolAccount[]; disabled: boolean; onAction: (account: UserPoolAccount, action: UserPoolAccountAction) => void }) {
  return <PoolTable label="Pool accounts" headers={['Account', 'State / stage', 'Caller key hash', 'Requests', 'Recovery / verification', 'Actions']}>
    {props.accounts.map((account) => <tr key={account.identity}>
      <td><p className="font-medium">{account.identity}</p><p className="text-xs text-slate-500">{account.ghLogin ?? 'GH login not provisioned'}</p></td>
      <td><StateLabel value={accountState(account)} /><p className="mt-1 text-xs text-slate-500">Stage: {account.stage} · OAuth: {account.oauthStatus}</p></td>
      <td><CallerHash value={account.callerKeyHash} missing={account.leasePhase ? 'Hash unavailable' : 'Not leased'} />
        {account.leasePhase ? <p className="mt-1 text-xs text-slate-500">{account.leasePhase} · expires {poolDate(account.leaseExpiresAt)}</p> : null}</td>
      <td className="tabular-nums">{account.activeRequests}</td>
      <td className="text-xs">
        {account.lastError ? <p className="mb-1 break-words font-medium">{account.lastError}</p> : null}
        <p>Attempts: {account.attempts}</p>
        {account.state === 'cooling' ? <p>Cooling until {poolDate(account.cooldownUntil)}</p> : null}
        {account.state === 'failed' ? <p>Retry eligible after {poolDate(account.retryAt)}</p> : null}
        <p>Verified: {poolDate(account.verifiedAt)}</p><p className="text-slate-500">Updated: {poolDate(account.updatedAt)}</p>
      </td>
      <td><div className="flex flex-wrap gap-2">
        {account.state === 'disabled' ? <Button variant="secondary" disabled={props.disabled || account.activeRequests > 0} onClick={() => props.onAction(account, 'resume')}>Resume</Button> : (
          <>
            {account.state === 'failed' ? <Button variant="secondary" disabled={props.disabled || account.activeRequests > 0} onClick={() => props.onAction(account, 'retry')}>Retry</Button> : null}
            <Button variant="dangerOutline" disabled={props.disabled} onClick={() => props.onAction(account, 'disable')}>Disable</Button>
          </>
        )}
      </div></td>
    </tr>)}
    {!props.accounts.length ? <EmptyRow columns={6}>No accounts match. An empty pool will provision toward its idle target when prewarming is enabled.</EmptyRow> : null}
  </PoolTable>;
}
function LeasesTable(props: { leases: UserPoolLease[]; disabled: boolean; onRelease: (lease: UserPoolLease) => void }) {
  return <PoolTable label="Caller leases" headers={['Caller key hash', 'Account / lease', 'Phase', 'Assigned / last success', 'Expires', 'Actions']}>
    {props.leases.map((lease) => <tr key={lease.leaseId}>
      <td><CallerHash value={lease.callerKeyHash} missing="Hash unavailable" /></td>
      <td><p className="font-medium">{lease.memberIdentity}</p><code className="text-xs" title={lease.leaseId}>{lease.leaseId.slice(0, 8)}…{lease.leaseId.slice(-8)}</code></td>
      <td><StateLabel value={lease.phase} />{lease.inUse ? <p className="mt-1 text-xs">Requests in flight</p> : null}</td>
      <td className="text-xs"><p>{poolDate(lease.assignedAt)}</p><p className="mt-1 text-slate-500">Last success: {poolDate(lease.lastSuccessAt)}</p></td>
      <td className="text-xs">{poolDate(lease.expiresAt)}</td>
      <td><Button variant="dangerOutline" disabled={props.disabled || lease.inUse} title={lease.inUse ? 'Wait for requests in flight to finish.' : 'Release this exclusive caller lease.'}
        onClick={() => props.onRelease(lease)}>Release</Button></td>
    </tr>)}
    {!props.leases.length ? <EmptyRow columns={6}>No leases match. A lease is assigned when an authenticated caller key first uses the pool.</EmptyRow> : null}
  </PoolTable>;
}
function EventsTable({ events }: { events: UserPoolEvent[] }) {
  return <PoolTable label="Recent pool events" headers={['Time', 'Event', 'Account', 'Caller key hash', 'Lease', 'Detail']}>
    {events.map((event) => <tr key={event.id}>
      <td className="text-xs">{poolDate(event.at)}</td><td>{event.action.replaceAll('_', ' ')}</td><td>{event.identity ?? '—'}</td>
      <td><CallerHash value={event.callerKeyHash} /></td><td><code className="text-xs" title={event.leaseId ?? undefined}>{event.leaseId ? `${event.leaseId.slice(0, 8)}…${event.leaseId.slice(-8)}` : '—'}</code></td>
      <td className="text-xs">{event.detail ?? '—'}</td>
    </tr>)}
    {!events.length ? <EmptyRow columns={6}>No recent events match this search.</EmptyRow> : null}
  </PoolTable>;
}
function PoolTable({ label, headers, children }: { label: string; headers: string[]; children: ReactNode }) {
  return <div className="max-h-[65vh] overflow-auto rounded-md border border-slate-200" tabIndex={0} role="region" aria-label={label}>
    <table className="pool-table w-full text-left text-sm"><caption className="sr-only">{label}</caption>
      <thead className="sticky top-0 z-10 bg-slate-50"><tr>{headers.map((header) => <th key={header} scope="col" className="whitespace-nowrap px-3 py-3 text-xs font-semibold text-slate-600">{header}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  </div>;
}
function EmptyRow({ columns, children }: { columns: number; children: ReactNode }) { return <tr><td colSpan={columns} className="py-8 text-center text-slate-500">{children}</td></tr>; }
function CallerHash({ value, missing = '—' }: { value: string | null; missing?: string }) {
  const formatted = formatCallerKeyHash(value);
  return formatted ? <code className="whitespace-nowrap text-xs" title={value!} aria-label={value!}>{formatted}</code> : <span className="text-xs text-slate-500">{missing}</span>;
}
function StateLabel({ value }: { value: string }) {
  return <span className="inline-flex rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-800">{stateLabels[value] ?? value}</span>;
}
function accountState(account: UserPoolAccount): string {
  return account.state === 'ready' ? account.leasePhase ?? (account.activeRequests > 0 ? 'catalog' : 'ready_idle') : account.state;
}
function ErrorNotice({ children }: { children: ReactNode }) { return <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{children}</p>; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The pool request failed. Refresh and try again.'; }

function PoolConfirmation(props: { value: Confirmation; busy: boolean; error?: string; onClose: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const release = props.value.kind === 'release';
  return <dialog ref={dialog} aria-labelledby="pool-confirm-title" aria-describedby="pool-confirm-description"
    onCancel={(event) => { event.preventDefault(); props.onClose(); }}
    className="m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-xl overflow-auto rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-slate-950/40">
    <h2 id="pool-confirm-title" className="text-lg font-semibold">{release ? 'Release caller lease?' : 'Disable pool account?'}</h2>
    <div id="pool-confirm-description" className="mt-3 space-y-3 text-sm text-slate-600">
      {props.value.kind === 'release' ? <>
        <p>Release the exclusive lease for <strong>{props.value.lease.memberIdentity}</strong>. The caller key may receive a different account on its next request. This operation is rejected while requests are in flight.</p>
        <p>Caller key hash: <CallerHash value={props.value.lease.callerKeyHash} missing="Hash unavailable" /></p>
        <p className="break-all">Lease ID: {props.value.lease.leaseId}</p>
      </> : <p>Disable <strong>{props.value.account.identity}</strong> for new requests. In-flight requests may finish. This does not delete the account or remove its Copilot seat. Resume revalidates the account before it becomes available.</p>}
    </div>
    {props.error ? <div className="mt-4"><ErrorNotice>{props.error}</ErrorNotice></div> : null}
    <div className="mt-5 flex justify-end gap-2">
      <Button autoFocus variant="secondary" disabled={props.busy} onClick={props.onClose}>Cancel</Button>
      <Button variant="danger" disabled={props.busy} onClick={props.onConfirm}>{props.busy ? 'Working…' : release ? 'Release lease' : 'Disable account'}</Button>
    </div>
  </dialog>;
}
