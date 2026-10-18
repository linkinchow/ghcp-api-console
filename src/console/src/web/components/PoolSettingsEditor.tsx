import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ConsoleApiError } from '../api/client.js';
import { updateUserPoolSettings, type UserPoolLimits, type UserPoolSettings } from '../api/userPool.js';
import { parsePoolSettingsDraft, poolSettingsDraft, type UserPoolSettingsDraft } from '../lib/userPool.js';
import { ErrorState } from './PageState.js';
import { Button } from './ui/button.js';
import { Card, CardDescription, CardTitle } from './ui/card.js';
import { Input } from './ui/input.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;

const CONFLICT = 'Settings changed in another session. Your draft was not saved. '
  + 'Use “Reload latest settings” to discard it and review the current values.';

interface Props {
  settings: UserPoolSettings;
  limits: UserPoolLimits;
  disabled: boolean;
  notify: Notify;
  onBusy: (saving: boolean) => void;
  onRefresh: () => Promise<void>;
}

/** Global pool settings (idle target, lease TTL, pause), saved with CAS on `version`. */
export function PoolSettingsEditor(props: Props) {
  const [base, setBase] = useState(props.settings);
  const [draft, setDraft] = useState(() => poolSettingsDraft(props.settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (dirty) return;
    setBase(props.settings);
    setDraft(poolSettingsDraft(props.settings));
  }, [props.settings, dirty]);

  const edit = (changes: Partial<UserPoolSettingsDraft>) => {
    setDraft({ ...draft, ...changes });
    setDirty(true);
  };
  const reload = () => {
    setBase(props.settings);
    setDraft(poolSettingsDraft(props.settings));
    setDirty(false);
    setError(undefined);
  };
  const save = async () => {
    if (saving || props.disabled) return;
    setError(undefined);
    let changes;
    try { changes = parsePoolSettingsDraft(draft, props.limits); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return; }
    setSaving(true);
    props.onBusy(true);
    try {
      const next = await updateUserPoolSettings(base.version, changes);
      if (!mounted.current) return;
      setBase(next);
      setDraft(poolSettingsDraft(next));
      setDirty(false);
      props.notify('Pool settings saved. Changes apply to future provisioning and lease renewals.');
      await props.onRefresh();
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ConsoleApiError && err.code === 'settings_version_conflict') {
        await props.onRefresh();
        if (mounted.current) setError(CONFLICT);
      } else setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setSaving(false);
      props.onBusy(false);
    }
  };
  const locked = props.disabled || saving;
  const newer = dirty && base.version !== props.settings.version;
  return (
    <Card>
      <CardTitle>Global pool settings</CardTitle>
      <CardDescription>
        Shared by every enterprise. Account caps are set per enterprise below. Lowering limits never deletes
        accounts. Lease TTL is renewed only after successful inference.
      </CardDescription>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={locked} className="space-y-4">
          <legend className="sr-only">Idle target, lease and pause settings</legend>
          <div className="grid gap-4 md:grid-cols-2">
            <NumberField label="Ready idle target" min={0} max={props.limits.maxAccounts} value={draft.idleTarget}
              onChange={(idleTarget) => edit({ idleTarget })} />
            <NumberField label="Lease TTL (seconds)" min={props.limits.minLeaseSeconds}
              max={props.limits.maxLeaseSeconds} value={draft.leaseSeconds}
              onChange={(leaseSeconds) => edit({ leaseSeconds })}
              hint={`${props.limits.minLeaseSeconds}–${props.limits.maxLeaseSeconds.toLocaleString()} seconds`} />
          </div>
          <PauseToggle checked={draft.paused} onChange={(paused) => edit({ paused })} />
        </fieldset>
        {error ? <div className="mt-3"><ErrorState message={error} /></div> : null}
        {newer ? <NewerNotice latest={props.settings.version} draft={base.version} /> : null}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <p className="text-xs text-slate-500">Editing version {base.version}{dirty ? ' · Unsaved changes' : ''}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={reload} disabled={!dirty || locked}>
              Reload latest settings
            </Button>
            <Button type="submit" disabled={!dirty || locked}>{saving ? 'Saving…' : 'Save and apply'}</Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

function NumberField(props: {
  label: string; min: number; max: number; value: string; hint?: ReactNode; onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">{props.label}
      <Input type="number" min={props.min} max={props.max} step={1} required value={props.value}
        onChange={(event) => props.onChange(event.target.value)} />
      {props.hint ? <span className="text-xs font-normal text-slate-500">{props.hint}</span> : null}
    </label>
  );
}

function PauseToggle(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm text-slate-700">
      <input type="checkbox" className="mt-1" checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)} />
      <span>Pause prewarming<span className="block text-xs text-slate-500">
        Stops new provisioning work, not caller traffic. In-flight provisioning may finish its current step.
      </span></span>
    </label>
  );
}

function NewerNotice(props: { latest: number; draft: number }) {
  return (
    <p className="mt-3 text-sm text-amber-800">
      Newer settings are available (version {props.latest}). Your draft still uses version {props.draft}.
    </p>
  );
}
