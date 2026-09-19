import { useEffect, useState } from 'react';
import type { EnterprisePoolOverviewDto, EnterprisePoolPolicyDto, GlobalPoolSettingsDto } from '@ghcp/shared';
import { ConsoleApiError, safeErrorBlockers } from '../api/client.js';
import { getEnterprisePolicy, getGlobalPoolSummary, transitionEnterprise, updateEnterpriseCap, updateGlobalPoolSettings } from '../api/enterprises.js';
import { useScopeLifetime } from '../lib/scope.js';
import { poolDate } from '../lib/userPool.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/card.js';
import { Input } from '../components/ui/input.js';
import { Dialog } from '../components/ui/dialog.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed. Refresh before trying again.';
function policyErrorMessage(error: unknown): string {
  const blockers = safeErrorBlockers(error);
  return `${message(error)}${blockers.length ? ` Configuration blockers: ${blockers.join(', ')}. Resolve these in the offline service configuration, then validate again.` : ''}`;
}
const percent = (value: number | null) => value === null ? 'Not participating' : `${(value * 100).toFixed(1)}%`;

export function GlobalPoolPage(props: { enabled: boolean; notify: Notify; onSelect: (id: string) => void }) {
  const lifetime = useScopeLifetime();
  const [data, setData] = useState<EnterprisePoolOverviewDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (!props.enabled || !lifetime.active()) return;
    const signal = lifetime.beginRead();
    setLoading(true);
    try {
      const result = await getGlobalPoolSummary(signal);
      if (!lifetime.current(signal)) return;
      setData(result); setError(undefined);
    } catch (err) { if (lifetime.current(signal)) setError(message(err)); }
    finally { if (lifetime.current(signal)) setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  if (!props.enabled) return <PoolDisabled />;
  return <div className="space-y-5">
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><CardTitle>Global enterprise pool</CardTitle><CardDescription>All registered enterprises. Inventory is not a bill, and inventory proportions are not request-volume quotas.</CardDescription></div>
        <Button variant="secondary" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh global pool'}</Button>
      </div>
      <p className="max-w-3xl text-sm text-slate-600">One shared idle target and lease TTL. Each enterprise owns its account cap; registered failed, cooling, disabled and in-progress members still count toward inventory. Identity and Secret registration remain offline.</p>
    </Card>
    {error ? <ErrorNotice>{error} {data ? 'Showing the last snapshot; writes are disabled until refresh succeeds.' : ''}</ErrorNotice> : null}
    {loading && !data ? <p role="status">Loading global pool…</p> : null}
    {data ? <>
      <Card>
        <CardTitle>Shared supply and name catalog</CardTitle>
        <dl className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6 text-sm">
          <Figure label="Eligible idle" value={data.supply.eligibleIdle} />
          <Figure label="Pending supply (deduplicated)" value={data.supply.pendingSupply} />
          <Figure label="Global supply deficit" value={data.supply.deficit} />
          <Figure label="Name positions remaining" value={data.names.remainingPositions} />
          <Figure label="Name catalog capacity" value={data.names.capacity} />
          <Figure label="Next name ordinal" value={data.names.nextOrdinal} />
        </dl>
        <p className="mt-4 text-xs text-slate-500">Server snapshot {poolDate(data.observedAt)}. Supply excludes unsafe or blocked work; catalog positions are not calculated from inventory or caps.</p>
        <Blockers reasons={data.blockedReasons} />
      </Card>
      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto" role="region" aria-label="Enterprise inventory policies" tabIndex={0}>
          <table className="w-full text-left text-sm"><caption className="px-4 py-3 text-left font-semibold">Enterprise inventory and scheduling</caption>
            <thead className="bg-slate-50 text-xs text-slate-600"><tr>{['Enterprise / state', 'Inventory / cap', 'Target / actual share', 'Share deficit / score', 'Eligible idle / pending', 'Leased / provisional', 'Provisioning / cooling', 'Failed / disabled', 'Blockers'].map(value => <th className="whitespace-nowrap p-3" key={value}>{value}</th>)}</tr></thead>
            <tbody>{data.enterprises.map(item => <tr key={item.enterpriseId} className="border-t border-slate-200 align-top">
              <td className="p-3"><button className="text-left font-semibold underline underline-offset-4" onClick={() => props.onSelect(item.enterpriseId)}>{item.slug}</button><p className="mt-1 text-xs">{item.shortcode} · {item.state}</p></td>
              <td className="p-3 tabular-nums">{item.counts.total.toLocaleString()} / {item.maxAccounts.toLocaleString()}{item.overCap ? <p className="mt-1 text-xs font-semibold">Over cap · no automatic deletion</p> : null}</td>
              <td className="p-3 tabular-nums">{percent(item.targetShare)} / {percent(item.actualShare)}</td>
              <td className="p-3 tabular-nums">{item.shareDeficit === null ? '—' : `${(item.shareDeficit * 100).toFixed(1)} pp`} / {item.score.toLocaleString()}</td>
              <td className="p-3 tabular-nums">{item.eligibleIdle} / {item.pendingSupply}</td>
              <td className="p-3 tabular-nums">{item.counts.leased} / {item.counts.provisional}</td>
              <td className="p-3 tabular-nums">{item.counts.provisioning} / {item.counts.cooling}</td>
              <td className="p-3 tabular-nums">{item.counts.failed} / {item.counts.disabled}</td>
              <td className="max-w-xs break-words p-3 text-xs">{item.blockedReasons.length ? item.blockedReasons.join(', ') : 'None'}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="border-t border-slate-200 p-3 text-xs text-slate-500">Shares and scores are server-authoritative, based on active-enterprise inventory and caps. They are read-only, not editable weights. Lease and recovery counts may overlap.</p>
      </Card>
      <GlobalSettingsEditor key="settings" settings={data.settings} disabled={Boolean(error) || loading} notify={props.notify} onRefresh={load} />
    </> : null}
  </div>;
}

export function EnterprisePolicyPage(props: { enterpriseId: string; enabled: boolean; notify: Notify }) {
  const lifetime = useScopeLifetime();
  const [policy, setPolicy] = useState<EnterprisePoolPolicyDto>();
  const [draft, setDraft] = useState('');
  const [draftVersion, setDraftVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{ enterpriseId: string; slug: string; expectedVersion: number; action: 'activate' | 'drain' }>();
  const load = async (replaceDraft = false) => {
    if (!props.enabled || !lifetime.active()) return;
    const signal = lifetime.beginRead();
    setLoading(true);
    try {
      const next = await getEnterprisePolicy(props.enterpriseId, signal);
      if (!lifetime.current(signal)) return;
      if (next.enterpriseId !== props.enterpriseId) throw new Error('Enterprise policy scope mismatch. No change is allowed.');
      setPolicy(next); setReadError(undefined);
      if (!dirty || replaceDraft) { setDraft(String(next.maxAccounts)); setDraftVersion(next.policyVersion); setDirty(false); }
    } catch (err) { if (lifetime.current(signal)) setReadError(message(err)); }
    finally { if (lifetime.current(signal)) setLoading(false); }
  };
  useEffect(() => { void load(true); }, []);
  const perform = async (action: () => Promise<EnterprisePoolPolicyDto>, success: string) => {
    if (busy || loading || readError || !policy) return;
    setBusy(true); setError(undefined);
    try {
      const next = await action();
      if (!lifetime.active()) return;
      if (next.enterpriseId !== props.enterpriseId) throw new Error('Enterprise policy scope mismatch. Refresh before continuing.');
      setPolicy(next); setDraft(String(next.maxAccounts)); setDraftVersion(next.policyVersion); setDirty(false); setConfirmation(undefined);
      props.notify(success);
    } catch (err) {
      if (!lifetime.active()) return;
      if (err instanceof ConsoleApiError && err.status === 409) {
        setConfirmation(undefined);
        await load(false);
        if (!lifetime.active()) return;
        setError('Policy changed or this transition was rejected. Your draft was not saved. Reload and review the latest policy; nothing is retried automatically.');
      } else setError(policyErrorMessage(err));
    } finally { if (lifetime.active()) setBusy(false); }
  };
  if (!props.enabled) return <PoolDisabled />;
  const disabled = busy || loading || Boolean(readError);
  return <div className="space-y-4">
    <Card>
      <div className="flex flex-wrap justify-between gap-3"><div><CardTitle>Enterprise pool policy</CardTitle><CardDescription>Identity, trusted routes, Secret references and enterprise UUID are registered offline and cannot be edited here.</CardDescription></div><Button variant="secondary" disabled={busy || loading} onClick={() => void load(false)}>Refresh policy</Button></div>
      {loading && !policy ? <p role="status">Loading enterprise policy…</p> : null}
      {readError ? <ErrorNotice>{readError}</ErrorNotice> : null}
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {policy ? <>
        <dl className="my-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div><dt className="text-slate-500">Enterprise</dt><dd className="font-semibold">{policy.slug} ({policy.shortcode})</dd></div>
          <div><dt className="text-slate-500">Lifecycle</dt><dd className="font-semibold">{policy.state}</dd></div>
          <div><dt className="text-slate-500">Policy / identity revision</dt><dd>{policy.policyVersion} / {policy.enterpriseRevision}</dd></div>
          <div><dt className="text-slate-500">Validation</dt><dd>{policy.validationKind ?? 'Not validated'}<p>{policy.validatedAt === null ? '—' : poolDate(policy.validatedAt)}</p></dd></div>
        </dl>
        <form className="max-w-xl space-y-3 border-t border-slate-200 pt-4" onSubmit={event => {
          event.preventDefault();
          const cap = Number(draft);
          if (!/^\d+$/.test(draft) || !Number.isSafeInteger(cap) || cap < 1 || cap > 10000) { setError('Account cap must be a whole number from 1 to 10000.'); return; }
          const captured = { enterpriseId: props.enterpriseId, expectedVersion: draftVersion, cap };
          void perform(() => updateEnterpriseCap(captured.enterpriseId, captured.expectedVersion, captured.cap), 'Enterprise account cap saved. Existing accounts and leases are retained.');
        }}>
          <label className="block text-sm font-medium">Enterprise maximum accounts<Input aria-label="Enterprise maximum accounts" className="mt-1" type="number" min={1} max={10000} step={1} required disabled={disabled} value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); }} /></label>
          <p className="text-xs text-slate-600">Lowering this cap blocks new inventory above the limit; it never deletes accounts, removes seats or evicts existing leases. No per-enterprise idle target or weight exists.</p>
          {dirty && draftVersion !== policy.policyVersion ? <p role="status" className="text-sm text-amber-800">Draft version {draftVersion}; current policy version {policy.policyVersion}. Reload before saving.</p> : null}
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || !dirty || draftVersion !== policy.policyVersion}>Save enterprise cap</Button><Button variant="secondary" type="button" disabled={disabled || !dirty} onClick={() => { setDraft(String(policy.maxAccounts)); setDraftVersion(policy.policyVersion); setDirty(false); setError(undefined); }}>Reload latest policy</Button></div>
        </form>
        <section className="mt-5 space-y-3 border-t border-slate-200 pt-4" aria-label="Enterprise lifecycle">
          <h3 className="font-semibold">Validate, activate or drain</h3>
          <p className="max-w-3xl text-sm text-slate-600">Internal configuration validation is read-only service readiness, not real GitHub acceptance. Activate requires validation and explicit confirmation. Drain stops new leases and new inventory, while existing leases and in-flight work remain protected.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={disabled || dirty || policy.state === 'active'} onClick={() => { const captured = { id: props.enterpriseId, version: policy.policyVersion }; void perform(() => transitionEnterprise(captured.id, captured.version, 'validate'), 'Internal service configuration validated. This is not real GitHub acceptance.'); }}>Validate configuration</Button>
            <Button disabled={disabled || dirty || policy.state !== 'validated'} onClick={() => setConfirmation({ enterpriseId: props.enterpriseId, slug: policy.slug, expectedVersion: policy.policyVersion, action: 'activate' })}>Activate enterprise</Button>
            <Button variant="dangerOutline" disabled={disabled || dirty || policy.state !== 'active'} onClick={() => setConfirmation({ enterpriseId: props.enterpriseId, slug: policy.slug, expectedVersion: policy.policyVersion, action: 'drain' })}>Drain enterprise</Button>
          </div>
        </section>
      </> : null}
    </Card>
    <Dialog title={confirmation?.action === 'drain' ? 'Drain this enterprise?' : 'Activate this enterprise?'} open={Boolean(confirmation)} onClose={() => { if (!busy) setConfirmation(undefined); }} description={confirmation ? `${confirmation.slug} · ${confirmation.enterpriseId} · policy version ${confirmation.expectedVersion}` : undefined}>
      <p className="text-sm text-slate-600">{confirmation?.action === 'drain' ? 'Stop new admission and inventory creation in this enterprise. Existing leases and in-flight work are not evicted. Re-enabling requires fresh validation and explicit activation.' : 'Allow this validated enterprise to participate in new caller admission and inventory creation. Internal readiness does not prove real GitHub authorization.'}</p>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={() => setConfirmation(undefined)}>Cancel</Button><Button disabled={disabled} onClick={() => { if (!confirmation) return; const captured = confirmation; void perform(() => transitionEnterprise(captured.enterpriseId, captured.expectedVersion, captured.action), captured.action === 'drain' ? 'Enterprise draining. Existing leases are preserved.' : 'Enterprise activated.'); }}>{busy ? 'Working…' : confirmation?.action === 'drain' ? 'Confirm drain' : 'Confirm activation'}</Button></div>
    </Dialog>
  </div>;
}

function GlobalSettingsEditor(props: { settings: GlobalPoolSettingsDto; disabled: boolean; notify: Notify; onRefresh: () => Promise<void> }) {
  const lifetime = useScopeLifetime();
  const [base, setBase] = useState(props.settings);
  const [idle, setIdle] = useState(String(base.idle_target));
  const [ttl, setTtl] = useState(String(base.lease_seconds));
  const [paused, setPaused] = useState(base.paused === 1);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const reset = (value: GlobalPoolSettingsDto) => { setBase(value); setIdle(String(value.idle_target)); setTtl(String(value.lease_seconds)); setPaused(value.paused === 1); setDirty(false); setError(undefined); };
  useEffect(() => { if (!dirty) reset(props.settings); }, [props.settings, dirty]);
  const save = async () => {
    if (saving || props.disabled) return;
    if (!/^\d+$/.test(idle) || Number(idle) > 10000 || !/^\d+$/.test(ttl) || Number(ttl) < 60 || Number(ttl) > 2592000) { setError('Idle target must be 0–10000; lease TTL must be 60–2592000 whole seconds.'); return; }
    const captured = { version: base.version, changes: { idle_target: Number(idle), lease_seconds: Number(ttl), paused: (paused ? 1 : 0) as 0 | 1 } };
    setSaving(true); setError(undefined);
    try {
      const next = await updateGlobalPoolSettings(captured.version, captured.changes);
      if (!lifetime.active()) return;
      reset(next); props.notify('Global pool settings saved.'); await props.onRefresh();
    } catch (err) {
      if (!lifetime.active()) return;
      if (err instanceof ConsoleApiError && err.status === 409) { await props.onRefresh(); if (lifetime.active()) setError('Global settings changed. Your draft was not saved; reload the latest settings and review before saving.'); }
      else setError(message(err));
    } finally { if (lifetime.active()) setSaving(false); }
  };
  return <Card>
    <CardTitle>Global pool settings</CardTitle>
    <CardDescription>Applies to every enterprise. Caps below are read-only sums; edit each enterprise cap on its policy page.</CardDescription>
    <dl className="mb-4 flex flex-wrap gap-6 text-sm"><Figure label="Registered total cap (derived)" value={props.settings.max_accounts} /><Figure label="Active total cap (derived)" value={props.settings.active_max_accounts} /></dl>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={props.disabled || saving} className="space-y-4">
        <legend className="sr-only">Global idle target, lease TTL and pause</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">Global idle target<Input type="number" min={0} max={10000} step={1} required value={idle} onChange={event => { setIdle(event.target.value); setDirty(true); }} /></label>
          <label className="text-sm font-medium">Global lease TTL (seconds)<Input type="number" min={60} max={2592000} step={1} required value={ttl} onChange={event => { setTtl(event.target.value); setDirty(true); }} /></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paused} onChange={event => { setPaused(event.target.checked); setDirty(true); }} />Pause global prewarming</label>
        <p className="max-w-3xl text-xs text-slate-600">Idle target may exceed active capacity; the server reports the blocker. Pause stops new provisioning, not caller traffic. TTL renews only after successful inference.</p>
      </fieldset>
      {error ? <ErrorNotice>{error}</ErrorNotice> : null}
      {dirty && base.version !== props.settings.version ? <p className="mt-3 text-sm text-amber-800">New settings version {props.settings.version}; your draft uses version {base.version}.</p> : null}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4"><p className="text-xs text-slate-500">Global settings version {base.version}</p><div className="flex gap-2"><Button type="button" variant="secondary" disabled={!dirty || saving || props.disabled} onClick={() => reset(props.settings)}>Reload latest settings</Button><Button type="submit" disabled={!dirty || saving || props.disabled || base.version !== props.settings.version}>{saving ? 'Saving…' : 'Save global settings'}</Button></div></div>
    </form>
  </Card>;
}
function Figure(props: { label: string; value: number }) { return <div><dt className="text-xs text-slate-600">{props.label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums text-slate-950">{props.value.toLocaleString()}</dd></div>; }
function Blockers({ reasons }: { reasons: string[] }) { return reasons.length ? <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm"><h3 className="font-semibold">Scheduling blockers</h3><ul className="mt-1 list-disc pl-5">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div> : null; }
function ErrorNotice({ children }: { children: React.ReactNode }) { return <p role="alert" className="my-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{children}</p>; }
function PoolDisabled() { return <Card><CardTitle>Pool management is disabled</CardTitle><CardDescription>This deployment uses direct account routing. Enterprise discovery and scoped account management remain available; opening this page does not enable the pool.</CardDescription></Card>; }
