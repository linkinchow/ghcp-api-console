import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type {
  LoginRuntimeSettingsDto, LoginRuntimeSettingsValues, SsoRuntimeSettingsDto, SsoRuntimeSettingsValues,
} from '@ghcp/shared';
import { ListChecks, ShieldCheck, Users } from 'lucide-react';
import { api, ConsoleApiError } from '../api/client.js';
import { getLoginRuntimeSettings, updateLoginRuntimeSettings } from '../api/login.js';
import { getSsoRuntimeSettings, updateSsoRuntimeSettings } from '../api/sso.js';
import { ErrorState, LoadingState } from '../components/PageState.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/card.js';
import { Checkbox } from '../components/ui/checkbox.js';
import { Input } from '../components/ui/input.js';
import { formatDate } from '../lib/format.js';
import { useEnterpriseScope, useScopeLifetime, type EnterpriseScope } from '../lib/scope.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;

const FOOTER_CLASS = 'mt-6 flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center '
  + 'sm:justify-between';
const SSO_NOTE = 'Saved per enterprise in sso.sqlite. Applies to new users, SCIM operations and new sync batches '
  + 'without restarting SSO.';
const LOGIN_NOTE = 'Saved in login.sqlite. Applies to queued work and newly started tasks; running tasks keep their '
  + 'starting snapshot.';

interface SsoSettingsDraft {
  maxSsoUsers: string;
  userPrefix: string;
  emailDomain: string;
  bulkSyncConcurrency: string;
  scimRequestDelayMs: string;
  scimMaxRetries: string;
  scimRetryBaseDelayMs: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ConsoleApiError && error.status === 409;
}

/** SSO runtime settings belong to the selected enterprise; Login settings and the password are global. */
export function SettingsPage(props: { notify: Notify }) {
  const scope = useEnterpriseScope();
  return (
    <div className="space-y-6">
      <SsoRuntimeSettingsCard key={scope.id} scope={scope} notify={props.notify} />
      <LoginRuntimeSettingsCard notify={props.notify} />
      <AdminPasswordCard notify={props.notify} />
    </div>
  );
}

function SettingsSection(props: {
  id: string; title: string; description: string; note: string; icon: ReactNode; busy?: boolean; children: ReactNode;
}) {
  return (
    <Card aria-labelledby={`${props.id}-title`} aria-busy={props.busy}>
      <div className="grid gap-6 xl:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="border-b border-slate-200 pb-5 xl:border-r xl:border-b-0 xl:pr-6 xl:pb-0">
          <span aria-hidden="true" className="mb-3 inline-flex rounded-md bg-slate-100 p-2 text-slate-600">
            {props.icon}
          </span>
          <CardTitle id={`${props.id}-title`}>{props.title}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
          <p className="text-xs leading-relaxed text-slate-500">{props.note}</p>
        </div>
        <div className="min-w-0">{props.children}</div>
      </div>
    </Card>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string };

function SettingsField({ label, hint, ...input }: FieldProps) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
      <Input {...input} id={id} className="w-full" aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-slate-500">{hint}</p> : null}
    </div>
  );
}

function SettingsToggle(props: {
  label: string; description: string; checked: boolean; onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <Checkbox aria-label={props.label} aria-describedby={id} checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-800">{props.label}</span>
        <span id={id} className="mt-1 block text-xs leading-relaxed text-slate-600">{props.description}</span>
      </span>
    </label>
  );
}

function SettingsFooter(props: {
  settings: { version: number; updatedAt: string }; saving: boolean; onSave: () => void;
}) {
  return (
    <div className={FOOTER_CLASS}>
      <p className="text-xs leading-relaxed text-slate-500">
        <span className="font-medium text-slate-700">Version {props.settings.version}</span>
        <span className="block">Updated {formatDate(props.settings.updatedAt)}</span>
      </p>
      <Button className="w-full sm:w-auto" onClick={props.onSave} disabled={props.saving}>
        {props.saving ? 'Saving...' : 'Save and apply'}
      </Button>
    </div>
  );
}

function passwordError(current: string, next: string, confirmation: string): string | undefined {
  if (!current || !next || !confirmation) return 'Current password, new password, and confirmation are required.';
  if (next !== confirmation) return 'New password and confirmation do not match.';
  if (next === current) return 'New password must be different from the current password.';
  return undefined;
}

function AdminPasswordCard(props: { notify: Notify }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    const invalid = passwordError(currentPassword, newPassword, confirmPassword);
    setError(invalid);
    if (invalid) return;
    setSaving(true);
    try {
      await api('/api/console/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      props.notify('Console administrator password changed.');
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection id="settings-password" title="Console administrator password" icon={<ShieldCheck size={20} />}
      description="Secure access to this Console."
      note="Only the currently signed-in administrator is affected. Service credentials are unchanged." busy={saving}>
      {error ? <ErrorState message={error} /> : null}
      <div className="grid gap-4 md:grid-cols-3">
        <SettingsField label="Current password" type="password" autoComplete="current-password"
          value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        <SettingsField label="New password" type="password" autoComplete="new-password"
          hint="Must differ from your current password."
          value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        <SettingsField label="Confirm new password" type="password" autoComplete="new-password"
          value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      </div>
      <div className={FOOTER_CLASS}>
        <p className="text-xs text-slate-500">Your current session stays signed in.</p>
        <Button className="w-full sm:w-auto" onClick={() => void save()} disabled={saving}>
          {saving ? 'Changing...' : 'Change password'}
        </Button>
      </div>
    </SettingsSection>
  );
}

function toSsoSettingsDraft(settings: SsoRuntimeSettingsDto): SsoSettingsDraft {
  return {
    maxSsoUsers: settings.maxSsoUsers === null ? '' : String(settings.maxSsoUsers),
    userPrefix: settings.userPrefix,
    emailDomain: settings.emailDomain,
    bulkSyncConcurrency: String(settings.bulkSyncConcurrency),
    scimRequestDelayMs: String(settings.scimRequestDelayMs),
    scimMaxRetries: String(settings.scimMaxRetries),
    scimRetryBaseDelayMs: String(settings.scimRetryBaseDelayMs),
  };
}

function ssoChanges(draft: SsoSettingsDraft): SsoRuntimeSettingsValues {
  return {
    maxSsoUsers: draft.maxSsoUsers.trim() ? Number(draft.maxSsoUsers) : null,
    userPrefix: draft.userPrefix,
    emailDomain: draft.emailDomain,
    bulkSyncConcurrency: Number(draft.bulkSyncConcurrency),
    scimRequestDelayMs: Number(draft.scimRequestDelayMs),
    scimMaxRetries: Number(draft.scimMaxRetries),
    scimRetryBaseDelayMs: Number(draft.scimRetryBaseDelayMs),
  };
}

/** Keyed by enterprise: switching enterprise discards the draft and drops late responses. */
function SsoRuntimeSettingsCard(props: { scope: EnterpriseScope; notify: Notify }) {
  const lifetime = useScopeLifetime();
  const [settings, setSettings] = useState<SsoRuntimeSettingsDto>();
  const [draft, setDraft] = useState<SsoSettingsDraft>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => {
    const signal = lifetime.beginRead();
    setLoading(true);
    setError(undefined);
    try {
      const next = await getSsoRuntimeSettings(props.scope.id, signal);
      if (!lifetime.current(signal)) return;
      setSettings(next);
      setDraft(toSsoSettingsDraft(next));
    } catch (err) {
      if (lifetime.current(signal)) setError(message(err));
    } finally {
      if (lifetime.current(signal)) setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!settings || !draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const body = { expectedVersion: settings.version, changes: ssoChanges(draft) };
      const next = await updateSsoRuntimeSettings(props.scope.id, body);
      if (!lifetime.active()) return;
      setSettings(next);
      setDraft(toSsoSettingsDraft(next));
      props.notify(`SSO settings of ${props.scope.id} saved and applied.`);
    } catch (err) {
      if (!lifetime.active()) return;
      if (!isVersionConflict(err)) setError(message(err));
      else {
        await load();
        setError('SSO settings changed in another session. The latest values were reloaded.');
      }
    } finally {
      if (lifetime.active()) setSaving(false);
    }
  };
  return (
    <SettingsSection id="settings-sso" title="SSO runtime settings" icon={<Users size={20} />}
      description={`Account defaults and GitHub synchronization of enterprise ${props.scope.id}.`}
      note={SSO_NOTE} busy={loading || saving}>
      {loading ? <LoadingState label="Loading SSO settings..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {settings && draft ? <>
        <SsoSettingsFields draft={draft} onChange={setDraft} />
        <SettingsFooter settings={settings} saving={saving} onSave={save} />
      </> : null}
    </SettingsSection>
  );
}

function SsoSettingsFields(props: { draft: SsoSettingsDraft; onChange: (draft: SsoSettingsDraft) => void }) {
  const { draft } = props;
  const field = (key: keyof SsoSettingsDraft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => props.onChange({ ...draft, [key]: event.target.value }),
  });
  return <>
    <fieldset className="min-w-0">
      <legend className="mb-3 text-sm font-semibold text-slate-900">Account defaults</legend>
      <div className="grid gap-4 md:grid-cols-3">
        <SettingsField label="Maximum SSO users" hint="Leave blank for unlimited." placeholder="Unlimited"
          type="number" min={1} max={1_000_000} {...field('maxSsoUsers')} />
        <SettingsField label="Fallback user prefix" hint="Up to 32 characters." {...field('userPrefix')} />
        <SettingsField label="Default email domain" hint="Domain only, without @." {...field('emailDomain')} />
      </div>
    </fieldset>
    <fieldset className="mt-6 min-w-0 border-t border-slate-200 pt-4">
      <legend className="pr-2 text-sm font-semibold text-slate-900">Synchronization and retries</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Sync EMU concurrency" hint="1-20 concurrent workers." type="number" min={1} max={20}
          {...field('bulkSyncConcurrency')} />
        <SettingsField label="SCIM request delay (ms)" hint="0-60,000 ms between requests." type="number" min={0}
          max={60_000} {...field('scimRequestDelayMs')} />
        <SettingsField label="SCIM max retries" hint="0-10 retries." type="number" min={0} max={10}
          {...field('scimMaxRetries')} />
        <SettingsField label="SCIM retry base delay (ms)" hint="0-60,000 ms for retry backoff." type="number" min={0}
          max={60_000} {...field('scimRetryBaseDelayMs')} />
      </div>
    </fieldset>
  </>;
}

function toLoginSettingsDraft(settings: LoginRuntimeSettingsDto): LoginRuntimeSettingsValues {
  return {
    concurrency: settings.concurrency,
    authTimeoutMs: settings.authTimeoutMs,
    authDebugLogs: settings.authDebugLogs,
    authDebugArtifacts: settings.authDebugArtifacts,
  };
}

/** One Login queue serves every enterprise, so its settings are global. */
function LoginRuntimeSettingsCard(props: { notify: Notify }) {
  const lifetime = useScopeLifetime();
  const [settings, setSettings] = useState<LoginRuntimeSettingsDto>();
  const [draft, setDraft] = useState<LoginRuntimeSettingsValues>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => {
    const signal = lifetime.beginRead();
    setLoading(true);
    setError(undefined);
    try {
      const next = await getLoginRuntimeSettings(signal);
      if (!lifetime.current(signal)) return;
      setSettings(next);
      setDraft(toLoginSettingsDraft(next));
    } catch (err) {
      if (lifetime.current(signal)) setError(message(err));
    } finally {
      if (lifetime.current(signal)) setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!settings || !draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await updateLoginRuntimeSettings({ expectedVersion: settings.version, changes: draft });
      if (!lifetime.active()) return;
      setSettings(next);
      setDraft(toLoginSettingsDraft(next));
      props.notify('Login settings saved and applied.');
    } catch (err) {
      if (!lifetime.active()) return;
      if (!isVersionConflict(err)) setError(message(err));
      else {
        await load();
        setError('Login settings changed in another session. The latest values were reloaded.');
      }
    } finally {
      if (lifetime.active()) setSaving(false);
    }
  };
  return (
    <SettingsSection id="settings-login" title="Login runtime settings" icon={<ListChecks size={20} />}
      description="Configure task execution and diagnostic output for all enterprises."
      note={LOGIN_NOTE} busy={loading || saving}>
      {loading ? <LoadingState label="Loading Login settings..." /> : null}
      {error ? <ErrorState message={error} /> : null}
      {settings && draft ? <>
        <LoginSettingsFields draft={draft} onChange={setDraft} />
        <SettingsFooter settings={settings} saving={saving} onSave={save} />
      </> : null}
    </SettingsSection>
  );
}

function LoginSettingsFields(props: {
  draft: LoginRuntimeSettingsValues; onChange: (draft: LoginRuntimeSettingsValues) => void;
}) {
  const { draft, onChange } = props;
  return <>
    <fieldset className="min-w-0">
      <legend className="mb-3 text-sm font-semibold text-slate-900">Task execution</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsField label="Login concurrency" hint="1-20 tasks at a time." value={draft.concurrency}
          type="number" min={1} max={20}
          onChange={(event) => onChange({ ...draft, concurrency: Number(event.target.value) })} />
        <SettingsField label="Authentication timeout (ms)" hint="5,000-600,000 ms (5 seconds to 10 minutes)."
          value={draft.authTimeoutMs} type="number" min={5_000} max={600_000}
          onChange={(event) => onChange({ ...draft, authTimeoutMs: Number(event.target.value) })} />
      </div>
    </fieldset>
    <fieldset className="mt-6 min-w-0 border-t border-slate-200 pt-4">
      <legend className="pr-2 text-sm font-semibold text-slate-900">Debugging</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsToggle label="Account debug logs" description="Enable per-account debug logs for new tasks."
          checked={draft.authDebugLogs} onChange={(checked) => onChange({ ...draft, authDebugLogs: checked })} />
        <SettingsToggle label="Debug artifacts" description="Save debugging artifacts for new tasks."
          checked={draft.authDebugArtifacts}
          onChange={(checked) => onChange({ ...draft, authDebugArtifacts: checked })} />
      </div>
    </fieldset>
  </>;
}
