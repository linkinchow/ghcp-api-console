import { useState } from 'react';
import type { EnterpriseReadinessDto, EnterpriseService } from '@ghcp/shared';
import { ConsoleApiError } from '../api/client.js';
import { githubHost, updatePoolPolicy, type EnterpriseListItem } from '../api/enterprises.js';
import { ErrorState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { blockerCodes, targetState, type LifecycleAction } from '../lib/enterprisePool.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;

interface DialogProps {
  item: EnterpriseListItem;
  notify: Notify;
  onClose: () => void;
  /** Reloads the enterprise list; the dialog keeps reading the latest `item`. */
  onChanged: () => Promise<void>;
}

const POLICY_CONFLICT = 'The pool policy changed in another session. Your draft was not saved. '
  + 'Use “Reload latest policy” to review the current values.';
const SERVICES: EnterpriseService[] = ['proxy', 'sso', 'login'];
const LIFECYCLE_COPY: Record<LifecycleAction, { title: string; confirm: string; effect: string }> = {
  activate: {
    title: 'Activate enterprise',
    confirm: 'Confirm activation',
    effect: 'The pool starts creating accounts and leasing them to new callers for this enterprise. '
      + 'Proxy re-checks Proxy, SSO and Login readiness before it applies the change.',
  },
  drain: {
    title: 'Drain enterprise',
    confirm: 'Confirm drain',
    effect: 'No new leases, catalog holds or account creations use this enterprise. Existing leases continue '
      + 'until they are released or expire. Nothing is deleted.',
  },
  resume: {
    title: 'Resume enterprise',
    confirm: 'Confirm resume',
    effect: 'The enterprise becomes active again after Proxy re-checks Proxy, SSO and Login readiness.',
  },
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCode(error: unknown, code: string): error is ConsoleApiError {
  return error instanceof ConsoleApiError && error.code === code;
}

function EnterpriseIdentity({ item }: { item: EnterpriseListItem }) {
  return (
    <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-sm">
      <dt className="text-slate-500">Enterprise ID</dt><dd className="break-all font-mono">{item.id}</dd>
      <dt className="text-slate-500">Slug</dt><dd className="break-all font-mono">{item.slug ?? '—'}</dd>
      <dt className="text-slate-500">Name</dt><dd className="break-words">{item.displayName}</dd>
      <dt className="text-slate-500">GitHub</dt><dd className="break-all">{githubHost(item.githubBaseUrl)}</dd>
    </dl>
  );
}

/** Edits C_e with CAS on `policyVersion`; a conflict keeps the draft until the operator reloads. */
export function CapDialog(props: DialogProps & { remaining: number }) {
  const pool = props.item.pool!;
  const [baseVersion, setBaseVersion] = useState(pool.policyVersion);
  const [draft, setDraft] = useState(String(pool.maxAccounts));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const max = pool.maxAccounts + props.remaining;
  const reload = () => {
    setBaseVersion(pool.policyVersion);
    setDraft(String(pool.maxAccounts));
    setError(undefined);
  };
  const save = async () => {
    const value = Number(draft);
    if (!/^\d+$/.test(draft) || value < 1 || value > max) {
      setError(`Maximum accounts must be a whole number from 1 to ${max}.`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await updatePoolPolicy(props.item.id, { expectedVersion: baseVersion, maxAccounts: value });
      props.notify(`Cap of ${props.item.id} set to ${value}. Existing accounts are never deleted.`);
      props.onClose();
      await props.onChanged();
    } catch (err) {
      setError(isCode(err, 'policy_version_conflict') ? POLICY_CONFLICT : message(err));
      if (isCode(err, 'policy_version_conflict')) await props.onChanged();
    } finally {
      setSaving(false);
    }
  };
  const newer = pool.policyVersion !== baseVersion;
  return (
    <Dialog open title="Edit enterprise cap" onClose={props.onClose} closeDisabled={saving}
      description="Lowering the cap never deletes accounts; the pool stops creating new ones above it.">
      <div className="space-y-3">
        <EnterpriseIdentity item={props.item} />
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">Enterprise maximum accounts
          <Input type="number" min={1} max={max} step={1} value={draft} disabled={saving}
            onChange={(event) => setDraft(event.target.value)} />
          <span className="text-xs font-normal text-slate-500">
            Up to {max.toLocaleString()}; the name catalog is shared by all enterprises.
          </span>
        </label>
        {newer ? <p className="text-sm text-amber-800">Latest policy: {pool.maxAccounts} accounts.</p> : null}
        {error ? <ErrorState message={error} /> : null}
        <p className="text-xs text-slate-500">Editing policy version {baseVersion}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving || !newer} onClick={reload}>Reload latest policy</Button>
          <Button variant="secondary" disabled={saving} onClick={props.onClose}>Cancel</Button>
          <Button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save cap'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Activate, drain or resume one enterprise; activation failures list the readiness blockers. */
export function LifecycleDialog(props: DialogProps & { action: LifecycleAction }) {
  const copy = LIFECYCLE_COPY[props.action];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [blockers, setBlockers] = useState<{ codes: string[]; hidden: number }>();
  const confirm = async () => {
    const pool = props.item.pool!;
    setSaving(true);
    setError(undefined);
    setBlockers(undefined);
    try {
      const body = { expectedVersion: pool.policyVersion, state: targetState(props.action) };
      await updatePoolPolicy(props.item.id, body);
      props.notify(`${copy.title}: ${props.item.id} is now ${body.state}.`);
      props.onClose();
      await props.onChanged();
    } catch (err) {
      if (isCode(err, 'enterprise_not_ready')) setBlockers(blockerCodes(err.details));
      else setError(isCode(err, 'policy_version_conflict') ? POLICY_CONFLICT : message(err));
      await props.onChanged();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open title={copy.title} description={copy.effect} onClose={props.onClose} closeDisabled={saving}>
      <div className="space-y-3">
        <EnterpriseIdentity item={props.item} />
        {props.action === 'drain' ? null : <ReadinessDetail readiness={props.item.readiness} />}
        {blockers ? <NotReady blockers={blockers} /> : null}
        {error ? <ErrorState message={error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={props.onClose}>Cancel</Button>
          <Button variant={props.action === 'drain' ? 'danger' : 'primary'} disabled={saving}
            onClick={() => void confirm()}>{saving ? 'Working…' : copy.confirm}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function NotReady({ blockers }: { blockers: { codes: string[]; hidden: number } }) {
  const hidden = blockers.hidden ? ` and ${blockers.hidden} other blocker(s)` : '';
  const codes = blockers.codes.length ? blockers.codes.join(', ') : 'none reported';
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      Not changed: the enterprise is not ready in Proxy, SSO and Login. Readiness blockers: {codes}{hidden}.
    </p>
  );
}

function ReadinessDetail({ readiness }: { readiness: EnterpriseReadinessDto | null }) {
  if (!readiness) return <p className="text-sm text-slate-600">Last readiness check: unknown.</p>;
  return (
    <div className="text-sm">
      <p className="mb-1 text-slate-600">
        Last readiness check: {readiness.ready ? 'ready' : `blocked (${readiness.blockers.join(', ')})`}
      </p>
      <ul className="space-y-1">
        {SERVICES.map((service) => <ServiceReadiness key={service} name={service} readiness={readiness} />)}
      </ul>
    </div>
  );
}

function ServiceReadiness(props: { name: EnterpriseService; readiness: EnterpriseReadinessDto }) {
  const row = props.readiness.services[props.name];
  const state = !row ? 'unknown' : row.configured ? 'configured' : 'not configured';
  const blockers = row?.blockers.length ? ` · ${row.blockers.join(', ')}` : '';
  return <li><span className="font-medium">{props.name}</span>: {state}{blockers}</li>;
}
