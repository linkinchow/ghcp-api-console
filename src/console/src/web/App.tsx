import type {
  BatchResult, ImportCopilotOauthTokenRow, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUserStatus,
  LoginTaskDto, ProxyAccountDto, ProxyRequestStatDto, SsoType, SsoUserCapacityDto, SsoUserDto,
} from '@ghcp/shared';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertTriangle, BarChart3, Boxes, Building2, Eye, EyeOff, KeyRound, Layers, LayoutDashboard, ListChecks,
  Loader2, Lock, LogOut, RefreshCw, Settings as SettingsIcon, ShieldCheck, UserRound, Users, Wallet,
} from 'lucide-react';
import { api } from './api/client.js';
import { DEFAULT_ENTERPRISE, isEnterpriseId } from './api/enterprises.js';
import { loginPath } from './api/login.js';
import {
  getProxyAccount, importCopilotOauthTokens, listRequestStats, proxyPath, reauthorizeCopilotOauth,
} from './api/proxy.js';
import {
  applyEmuImportPlan,
  createEmuImportPlan,
  createSsoUser,
  deleteEmuImportPlan,
  getSsoUserCapacity,
  importSsoUsers,
  listEmuImportPlanRows,
  patchSsoUser,
  runSsoUserBatch,
  ssoPath,
} from './api/sso.js';
import { LoginTaskDetails, QueueOverview } from './components/LoginTaskDetails.js';
import { clearListSelections, CopyValue, ManagedList, resetManagedListState } from './components/ManagedList.js';
import { ErrorState, Info, LoadingState } from './components/PageState.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { Card, CardTitle } from './components/ui/card.js';
import { ConfirmDialog, Dialog } from './components/ui/dialog.js';
import { Checkbox } from './components/ui/checkbox.js';
import { Dropdown } from './components/ui/dropdown.js';
import { Input } from './components/ui/input.js';
import { Notification, NotificationProvider } from './components/ui/notification.js';
import { Select } from './components/ui/select.js';
import { Table, Th, Td } from './components/ui/table.js';
import { Textarea } from './components/ui/textarea.js';
import { formatCopilotSeat, formatDate, formatNumber, statusTone, tokenTotal } from './lib/format.js';
import { hashFor, readHash } from './lib/hashState.js';
import { EnterpriseScopeContext, scopeText, useEnterpriseScope, type EnterpriseScope } from './lib/scope.js';
import { RequestFailure } from './components/RequestFailure.js';
import { AiCreditsUsagePage } from './pages/AiCreditsUsagePage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { EnterprisePoolPage } from './pages/EnterprisePoolPage.js';
import { EnterpriseSelector, useEnterpriseList, type EnterpriseListState } from './pages/EnterpriseSelector.js';
import { ErrorDiagnosticsPage } from './pages/ErrorDiagnosticsPage.js';
import { ModelsPage } from './pages/ModelsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { UserPoolPage } from './pages/UserPoolPage.js';

interface SetupState {
  initialized: boolean;
}

type Page = 'dashboard' | 'users' | 'budgets' | 'stats' | 'accounts' | 'models' | 'pool-overview' | 'user-pool'
  | 'tasks' | 'settings' | 'error-diagnostics' | 'diagnostics';
/** `enterprise` pages remount per enterprise; `mixed` pages hold global and per-enterprise sections. */
type PageScope = 'enterprise' | 'global' | 'mixed';
type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
interface PageEntry { id: Page; label: string; description: string; icon: typeof LayoutDashboard; scope: PageScope }
const pageViews = new Map<Page, string>();
const EMU_IMPORT_ROW_STATUSES: (ImportEmuUserStatus | '')[] = ['', 'pending_create', 'pending_update', 'created', 'updated', 'skipped', 'conflict', 'failed'];


const pages: PageEntry[] = [
  {
    id: 'dashboard', label: 'Dashboard', scope: 'global', icon: LayoutDashboard,
    description: 'Health and signals of every enterprise.',
  },
  {
    id: 'users', label: 'SSO Users', scope: 'enterprise', icon: Users,
    description: 'Create, import, sync, suspend, and manage SSO accounts.',
  },
  {
    id: 'budgets', label: 'AI Credits Usage', scope: 'enterprise', icon: Wallet,
    description: 'Review enterprise AI Credits consumption and Copilot seat cost.',
  },
  {
    id: 'stats', label: 'Request Stats', scope: 'enterprise', icon: BarChart3,
    description: 'Review request failures and input/output/cache token usage.',
  },
  {
    id: 'accounts', label: 'Proxy Accounts', scope: 'enterprise', icon: KeyRound,
    description: 'Inspect identity mappings and refresh GitHub or Copilot tokens.',
  },
  {
    id: 'models', label: 'Models', scope: 'enterprise', icon: Boxes,
    description: 'Browse the Copilot model catalog of the enterprise admin.',
  },
  {
    id: 'pool-overview', label: 'Pool overview', scope: 'global', icon: Building2,
    description: 'Global pool settings, enterprise caps and lifecycle.',
  },
  {
    id: 'user-pool', label: 'Pool members', scope: 'enterprise', icon: Layers,
    description: 'Manage pool accounts, exclusive caller leases, and account recovery.',
  },
  {
    id: 'tasks', label: 'Login Tasks', scope: 'enterprise', icon: ListChecks,
    description: 'Monitor automatic login and GitHub-token refresh tasks.',
  },
  {
    id: 'settings', label: 'Settings', scope: 'mixed', icon: SettingsIcon,
    description: 'Change the Console password and update runtime service settings.',
  },
  {
    id: 'error-diagnostics', label: 'Error Diagnostics', scope: 'global', icon: AlertTriangle,
    description: 'Inspect complete Copilot upstream failure snapshots.',
  },
  {
    id: 'diagnostics', label: 'Diagnostics', scope: 'mixed', icon: Activity,
    description: 'Check console-to-service API connectivity.',
  },
];
export function App() {
  const [initialized, setInitialized] = useState<boolean | undefined>();
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string>();
  const wasAuthed = useRef(authed);
  wasAuthed.current = authed;

  useEffect(() => {
    void api<SetupState>('/api/console/setup')
      .then((state) => setInitialized(state.initialized))
      .catch((err: Error) => setError(err.message));
    void api('/api/console/me').then(() => setAuthed(true)).catch(() => undefined);
  }, []);

  useEffect(() => {
    const expired = () => {
      if (wasAuthed.current) setError('Your Console session expired. Sign in again to return to the current view.');
      // Selections survive unmounting by design; they must not survive a change of operator.
      resetManagedListState();
      setAuthed(false);
    };
    window.addEventListener('console-session-expired', expired);
    return () => window.removeEventListener('console-session-expired', expired);
  }, []);

  if (initialized === undefined) return (
    <AuthScreen>
      <div className="flex flex-col items-center gap-3 text-slate-500">
        <Loader2 className="animate-spin" size={28} />
        <p className="text-sm">Loading console...</p>
      </div>
    </AuthScreen>
  );
  if (!initialized) return <AuthForm mode="setup" onDone={() => { setInitialized(true); setAuthed(true); }} />;
  if (!authed) return <>
    <AuthForm mode="login" onDone={() => { setAuthed(true); setError(undefined); }} />
    {error ? <p role="alert" className="fixed inset-x-4 bottom-4 mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 shadow-lg">{error}</p> : null}
  </>;
  return <AdminApp onLogout={() => { setAuthed(false); setError(undefined); }} />;
}

function AuthForm(props: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setSaving(true);
    try {
      await api(`/api/console/${props.mode}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <AuthScreen>
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-white"><ShieldCheck size={22} /></div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">GHCP Production Console</p>
          <h1 className="text-xl font-semibold text-slate-950">{props.mode === 'setup' ? 'Initialize Console' : 'Admin Login'}</h1>
          <p className="text-sm text-slate-500">{props.mode === 'setup' ? 'Create the first administrator account to get started.' : 'Sign in to manage accounts, tokens, and service operations.'}</p>
        </div>
        {error ? <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-col gap-3">
          <label className="text-xs font-medium text-slate-600">
            Username
            <div className="relative mt-1">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <Input className="w-full pl-9" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Username" autoComplete="username" />
            </div>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Password
            <div className="relative mt-1">
              <Lock className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <Input
                className="w-full pl-9 pr-9" value={password} onChange={(event) => setPassword(event.target.value)}
                placeholder="Password" type={showPassword ? 'text' : 'password'}
                autoComplete={props.mode === 'setup' ? 'new-password' : 'current-password'}
              />
              <button
                type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((value) => !value)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <Button type="submit" disabled={saving} className="mt-2 justify-center">
            {saving ? <Loader2 className="animate-spin" size={16} /> : null}
            {saving ? 'Working...' : props.mode === 'setup' ? 'Create admin' : 'Sign in'}
          </Button>
        </div>
      </form>
    </AuthScreen>
  );
}

function AuthScreen(props: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-white to-slate-200 p-6">
      {props.children}
    </main>
  );
}

interface Location {
  page: Page;
  /** From the hash; the UI shows `default` when it is absent. */
  enterpriseId: string;
}

/** Neither field while the enterprise list is still loading. */
type ScopeResolution = { scope?: EnterpriseScope; problem?: string };

function readLocation(): Location {
  const state = readHash(window.location.hash);
  const page = pages.some((entry) => entry.id === state.page) ? state.page as Page : 'dashboard';
  return { page, enterpriseId: state.enterpriseId ?? DEFAULT_ENTERPRISE };
}

/** The selected enterprise, never replaced by another one: an unknown id blocks the scoped page. */
function resolveScope(id: string, enterprises: EnterpriseListState): ScopeResolution {
  if (!isEnterpriseId(id)) return { problem: `"${id}" is not a valid enterprise ID. Choose an enterprise.` };
  if (!enterprises.list && !enterprises.error) return {};
  const item = enterprises.list?.items.find((entry) => entry.id === id);
  if (item) return { scope: { id, slug: item.slug, displayName: item.displayName } };
  if (enterprises.list) return { problem: `Enterprise "${id}" is not configured in Proxy. Choose an enterprise.` };
  return { scope: { id, slug: null, displayName: id } };
}

const PAGE_VIEWS: Record<Page, (notify: Notify) => ReactNode> = {
  dashboard: () => <DashboardPage />,
  users: (notify) => <UsersPage notify={notify} />,
  budgets: (notify) => <AiCreditsUsagePage notify={notify} />,
  stats: () => <RequestStatsPage />,
  accounts: (notify) => <ProxyAccountsPage notify={notify} />,
  models: (notify) => <ModelsPage notify={notify} />,
  'pool-overview': (notify) => <EnterprisePoolPage notify={notify} />,
  'user-pool': (notify) => <UserPoolPage notify={notify} />,
  tasks: (notify) => <LoginTasksPage notify={notify} />,
  settings: (notify) => <SettingsPage notify={notify} />,
  'error-diagnostics': (notify) => <ErrorDiagnosticsPage notify={notify} />,
  diagnostics: () => <DiagnosticsPage />,
};

/**
 * Scoped pages are keyed by `${enterpriseId}:${page}`, so switching enterprise unmounts the old page: its reads are
 * aborted and late responses are dropped. Settings keeps its global cards and keys its SSO card itself.
 */
function PageContent(props: { entry: PageEntry; resolution: ScopeResolution; notify: Notify }) {
  const { entry, resolution } = props;
  const content = PAGE_VIEWS[entry.id](props.notify);
  if (entry.scope === 'global') return <>{content}</>;
  if (resolution.problem) return <ErrorState message={resolution.problem} />;
  if (!resolution.scope) return <LoadingState label="Loading enterprises..." />;
  const key = entry.id === 'settings' ? entry.id : `${resolution.scope.id}:${entry.id}`;
  return (
    <EnterpriseScopeContext.Provider key={key} value={resolution.scope}>{content}</EnterpriseScopeContext.Provider>
  );
}

function AdminApp(props: { onLogout: () => void }) {
  const [location, setLocation] = useState<Location>(() => readLocation());
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'warning' | 'error' }>();
  const header = useRef<HTMLElement>(null);
  const enterprises = useEnterpriseList();
  const { page, enterpriseId } = location;
  const lastEnterprise = useRef(enterpriseId);

  useEffect(() => {
    const element = header.current;
    if (!element) return;
    const update = () => document.documentElement.style.setProperty('--console-header-height', `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--console-header-height'); };
  }, []);

  useEffect(() => {
    const onHash = () => {
      const next = readLocation();
      // Selections are drafts of one enterprise, whichever way the hash changed.
      if (next.enterpriseId !== lastEnterprise.current) clearListSelections();
      lastEnterprise.current = next.enterpriseId;
      pageViews.set(next.page, window.location.hash);
      setLocation(next);
    };
    pageViews.set(readLocation().page, window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const notify: Notify = (message, tone = 'success') => {
    setToast({ message, tone });
  };
  useEffect(() => {
    if (!toast || toast.tone !== 'success') return;
    const timer = window.setTimeout(() => setToast(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigate = (next: Page) => {
    const saved = pageViews.get(next);
    const keep = saved !== undefined && (readHash(saved).enterpriseId ?? DEFAULT_ENTERPRISE) === enterpriseId;
    window.location.hash = keep ? saved : hashFor(next, enterpriseId);
    setLocation(readLocation());
  };
  // A new enterprise starts the page from a clean hash: list filters and drafts belong to the old one.
  const selectEnterprise = (next: string) => {
    window.location.hash = hashFor(page, next);
  };

  const current = pages.find((entry) => entry.id === page) ?? pages[0]!;
  const CurrentIcon = current.icon;
  const resolution = resolveScope(enterpriseId, enterprises);
  return (
    <div className="console-admin min-h-screen bg-slate-50"><NotificationProvider>
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-slate-200 bg-white p-4 lg:block">
        <div className="flex items-center gap-2 px-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white"><ShieldCheck size={18} /></div>
          <div>
            <h1 className="text-base font-bold leading-tight text-slate-950">GHCP API Console</h1>
            <p className="text-xs text-slate-500">provided by openfuture</p>
          </div>
        </div>
        <nav className="mt-6 flex flex-col gap-1">
          {pages.map((entry) => {
            const Icon = entry.icon;
            const active = entry.id === page;
            return (
              <button
                key={entry.id}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
                onClick={() => navigate(entry.id)}
              >
                <Icon size={16} className={active ? 'text-white' : 'text-slate-400'} />
                {entry.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 lg:pl-64">
        <header ref={header} className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-4 py-4 backdrop-blur lg:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CurrentIcon size={20} className="text-slate-500" />
                <h2 className="text-2xl font-semibold text-slate-950">{current.label}</h2>
                <Badge tone="info">local</Badge>
              </div>
              <p className="text-sm text-slate-600">{current.description}</p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              {current.scope === 'global' ? null : (
                <EnterpriseSelector items={enterprises.list?.items} value={enterpriseId} onChange={selectEnterprise} />
              )}
              <Select aria-label="Management page" className="max-w-full lg:hidden" value={page} onChange={(event) => navigate(event.target.value as Page)}>
                {pages.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </Select>
              <Button variant="secondary" onClick={async () => { await api('/api/console/logout', { method: 'POST' }); resetManagedListState(); props.onLogout(); }}><LogOut size={16} /> Logout</Button>
            </div>
          </div>
          {enterprises.error && current.scope !== 'global' ? <EnterpriseListWarning error={enterprises.error} /> : null}
        </header>
        <main className="min-w-0 p-4 lg:p-6">
          <PageContent entry={current} resolution={resolution} notify={notify} />
        </main>
      </div>
      {toast ? <Notification tone={toast.tone} onClose={() => setToast(undefined)}>{toast.message}</Notification> : null}
    </NotificationProvider></div>
  );
}

function EnterpriseListWarning(props: { error: string }) {
  return (
    <p role="status" className="mt-2 text-xs text-amber-800">
      Enterprise list unavailable ({props.error}). Requests still name the selected enterprise explicitly.
    </p>
  );
}

function UsersPage(props: { notify: Notify }) {
  const scope = useEnterpriseScope();
  const [revision, setRevision] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [emuImportOpen, setEmuImportOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState<SsoUserDto>();
  const [capacity, setCapacity] = useState<SsoUserCapacityDto>();
  const [capacityError, setCapacityError] = useState<string>();
  const [assignCopilot, setAssignCopilot] = useState(false);
  const capacityRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => capacityRequest.current?.abort(), []);
  const reload = async () => { setRevision((value) => value + 1); };
  return <div className="space-y-4">
    {capacityError ? <ErrorState message={capacityError} /> : null}
    <p className="text-xs text-slate-600">Copilot seats show enterprise direct assignments only, not organization or team access. States reflect the last GitHub sync; use Import from GH or Remove seat to confirm a cancellation after its date.</p>
    <ManagedList<SsoUserDto>
      scope="users" path={`${ssoPath(scope.id)}/users`} identify={(user) => user.ssoUser} refreshKey={revision}
      onNotify={props.notify}
      followSubmittedActions
      onResult={() => {
        capacityRequest.current?.abort();
        const controller = new AbortController();
        capacityRequest.current = controller;
        void getSsoUserCapacity(scope.id, controller.signal).then((value) => {
          if (!controller.signal.aborted) { setCapacity(value); setCapacityError(undefined); }
        }).catch((err: Error) => { if (!controller.signal.aborted) setCapacityError(`User capacity may be stale: ${err.message}`); });
      }}
      filters={[
        { key: 'status', label: 'GH status', options: ['active', 'suspended', 'deleted', 'not_synced'] },
        { key: 'seatStatus', label: 'Copilot seat', options: ['unknown', 'assigned', 'pending_cancellation', 'unassigned', 'assign_failed', 'remove_failed'] },
        { key: 'role', label: 'Role', options: ['user', 'admin'] },
      ]}
      toolbar={<>
        {capacity ? <span className="mr-auto text-xs text-slate-600">{capacity.current} / {capacity.limit ?? 'unlimited'} users{capacity.reached ? ' · Capacity reached' : ''}</span> : null}
        <Button type="button" variant="secondary" onClick={() => setBatchOpen(true)} disabled={!capacity || capacity.reached}>Batch create</Button>
        <Dropdown label="Import">
          <Button type="button" variant="ghost" onClick={() => setImportOpen(true)}>Import CSV</Button>
          <Button type="button" variant="ghost" onClick={() => setEmuImportOpen(true)}>Import from GH</Button>
        </Dropdown>
        <Button type="button" onClick={() => setCreateOpen(true)} disabled={!capacity || capacity.reached}>Create user</Button>
      </>}
      selectionOptions={<label className="flex items-center gap-2 text-xs text-slate-600"><Checkbox checked={assignCopilot} onChange={(event) => setAssignCopilot(event.target.checked)} />Assign seat when syncing GH login</label>}
      actions={[
        { id: 'sync_emu', label: 'Sync GH login', options: { assignCopilotSeat: assignCopilot } },
        { id: 'assign_copilot', label: 'Assign seat' }, { id: 'remove_copilot', label: 'Remove seat', danger: true },
        { id: 'suspend_emu', label: 'Suspend GH login' }, { id: 'delete_emu', label: 'Delete GH login', danger: true },
        { id: 'delete_sso', label: 'Delete SSO users', danger: true },
      ]}
      columns={[
        { key: 'user', label: 'SSO user', sort: 'ssoUser', render: (user) => <CopyValue value={user.ssoUser} /> },
        { key: 'email', label: 'Email', sort: 'email', render: (user) => <span className="break-all">{user.email}</span> },
        { key: 'role', label: 'Role', sort: 'role', render: (user) => <Badge>{user.role}</Badge> },
        { key: 'gh', label: 'GH login', render: (user) => user.ghLogin ?? '-' },
        { key: 'status', label: 'Status', sort: 'emuStatus', render: (user) => <Badge tone={statusTone(user.emuStatus)}>{user.emuStatus}</Badge> },
        { key: 'seat', label: 'Copilot seat', render: (user) => <CopilotSeatCell user={user} /> },
        { key: 'updated', label: 'Updated', nowrap: true, render: (user) => formatDate(user.updatedAt) },
        { key: 'actions', label: 'Actions', render: (user) => <Button size="sm" variant="secondary" onClick={() => setEditing(user)}>Edit</Button> },
      ]}
    />
    <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} onDone={async () => { setCreateOpen(false); await reload(); props.notify('SSO user created.'); }} />
    <ImportUsersDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
    <ImportEmuUsersDialog open={emuImportOpen} onClose={() => setEmuImportOpen(false)} onDone={reload} />
    <BatchCreateDialog open={batchOpen} remaining={capacity?.remaining ?? null} onClose={() => setBatchOpen(false)} onDone={async () => { setBatchOpen(false); await reload(); }} />
    <EditUserDialog user={editing} onClose={() => setEditing(undefined)} onDone={async () => { setEditing(undefined); await reload(); }} />
  </div>;
}





function CopilotSeatCell(props: { user: SsoUserDto }) {
  const updated = props.user.copilotSeatUpdatedAt ? formatDate(props.user.copilotSeatUpdatedAt) : undefined;
  return (
    <div className="flex max-w-48 items-center gap-1.5">
      <Badge tone={statusTone(props.user.copilotSeatStatus)} title={updated}>
        {formatCopilotSeat(props.user.copilotSeatStatus, props.user.copilotSeatPendingCancellationDate)}
      </Badge>
      {props.user.copilotSeatLastError ? (
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-50 text-xs font-bold text-red-700"
          title={props.user.copilotSeatLastError}
          aria-label={props.user.copilotSeatLastError}
        >
          !
        </span>
      ) : null}
    </div>
  );
}



function RequestStatsPage() {
  const scope = useEnterpriseScope();
  return <div className="space-y-3">
    <p className="text-sm text-slate-600">Searches all retained requests, not only the latest 1000. Records already removed by retention are not included.</p>
    <ManagedList<ProxyRequestStatDto> scope="stats" path={`${proxyPath(scope.id)}/request-stats`}
      identify={(stat) => stat.id}
      filters={[
        { key: 'identity', label: 'Exact identity' }, { key: 'model', label: 'Model' },
        { key: 'success', label: 'Success', options: ['true', 'false'] },
      ]}
      columns={[
        { key: 'time', label: 'Requested', sort: 'requestedAt', nowrap: true, render: (stat) => formatDate(stat.requestedAt) },
        { key: 'identity', label: 'Identity / GH login', sort: 'identity', render: (stat) => <div>{stat.identity}<p className="text-xs text-slate-600">{stat.ghLogin}</p></div> },
        { key: 'path', label: 'Path', render: (stat) => stat.path },
        { key: 'model', label: 'Model', sort: 'model', render: (stat) => stat.model ?? '-' },
        { key: 'outcome', label: 'Outcome', sort: 'success', render: (stat) => <Badge tone={stat.success ? 'success' : 'danger'}>{stat.success ? 'success' : 'failed'}</Badge> },
        { key: 'input', label: 'Input', sort: 'inputTokens', align: 'right', render: (stat) => formatNumber(stat.inputTokens) },
        { key: 'output', label: 'Output', sort: 'outputTokens', align: 'right', render: (stat) => formatNumber(stat.outputTokens) },
        { key: 'cacheInput', label: 'Cache input', align: 'right', defaultHidden: true, render: (stat) => formatNumber(stat.cacheInputTokens) },
        { key: 'cacheWrite', label: 'Cache write', align: 'right', defaultHidden: true, render: (stat) => formatNumber(stat.cacheWriteTokens) },
        { key: 'total', label: 'Total tokens', align: 'right', render: (stat) => formatNumber(tokenTotal(stat.inputTokens, stat.outputTokens, statCacheTokens(stat))) },
        { key: 'failure', label: 'Failure', render: (stat) => <RequestFailure reason={stat.failureReason} /> },
      ]}
    />
  </div>;
}

function ProxyAccountsPage(props: { notify: Notify }) {
  const scope = useEnterpriseScope();
  const [revision, setRevision] = useState(0);
  const [detail, setDetail] = useState<ProxyAccountDto>();
  const [reauthorizing, setReauthorizing] = useState<ProxyAccountDto>();
  const [importOpen, setImportOpen] = useState(false);
  const reload = async () => { setRevision((value) => value + 1); };
  return <div className="space-y-4">
    <ManagedList<ProxyAccountDto> scope="accounts" path={`${proxyPath(scope.id)}/accounts`}
      identify={(account) => account.identity} refreshKey={revision} onNotify={props.notify}
      filters={[
        { key: 'status', label: 'OAuth status', options: ['valid', 'expired', 'missing', 'refreshing', 'failed'] },
      ]}
      toolbar={<Button type="button" variant="secondary" onClick={() => setImportOpen(true)}>Import Copilot OAuth tokens</Button>}
      actions={[{ id: 'reauthorize', label: 'Reauthorize selected' }, { id: 'delete', label: 'Delete selected', danger: true }]}
      columns={[
        { key: 'identity', label: 'Identity', sort: 'identity', render: (account) => <CopyValue value={account.identity} /> },
        { key: 'user', label: 'SSO user', sort: 'ssoUser', render: (account) => account.ssoUser },
        { key: 'gh', label: 'GH login', sort: 'ghLogin', render: (account) => account.ghLogin ?? '-' },
        { key: 'oauth', label: 'Copilot OAuth', sort: 'copilotOauthStatus', render: (account) => <StatusWithDate status={account.copilotOauthStatus} date={account.copilotOauthUpdatedAt} /> },
        { key: 'updated', label: 'Updated', sort: 'updatedAt', nowrap: true, render: (account) => formatDate(account.updatedAt) },
        { key: 'actions', label: 'Actions', render: (account) => <div className="flex items-center gap-2"><Button size="sm" variant="secondary" onClick={() => setDetail(account)}>Details</Button><Button size="sm" variant="secondary" onClick={() => setReauthorizing(account)}>Reauthorize</Button></div> },
      ]}
    />
    <ProxyAccountDetailDialog account={detail} onClose={() => setDetail(undefined)} />
    <CopilotOauthReauthorizationDialog account={reauthorizing} onClose={() => setReauthorizing(undefined)} onDone={async () => { setReauthorizing(undefined); await reload(); props.notify('Reauthorization queued. Follow the account in Login Tasks.'); }} />
    <ImportCopilotOauthTokensDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={reload} />
  </div>;
}



function ImportCopilotOauthTokensDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [csvText, setCsvText] = useState('name,copilotOauthToken\n');
  const [result, setResult] = useState<BatchResult<ImportCopilotOauthTokenRow>>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const importResult = await importCopilotOauthTokens(scope.id, csvText);
      setResult(importResult);
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Import Copilot OAuth tokens"
      description="CSV format: name,copilotOauthToken. Tokens must come from the OpenCode OAuth client and are validated against Copilot /models before storage."
      open={props.open}
      onClose={props.onClose}
    >
      <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
        Create missing SSO users manually before importing. Validated tokens overwrite existing credentials and are never echoed back.
      </div>
      <Textarea aria-label="Copilot OAuth tokens CSV" value={csvText} onChange={(event) => setCsvText(event.target.value)} className="h-56 w-full font-mono" />
      {result ? (
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">Batch {result.batchId}: {result.summary.success} success, {result.summary.failed} failed</p>
          <ul className="mt-2 max-h-52 space-y-2 overflow-auto">
            {result.rows.map((row) => (
              <li key={`${row.line}-${row.name}`} className="border-t border-slate-200 py-2">
                <div className="flex flex-wrap items-center gap-2"><span>Line {row.line}: {row.name || '-'}</span><Badge tone={statusTone(row.status)}>{row.status}</Badge></div>
                <p className="mt-1 break-words text-xs text-slate-600">{row.detail}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Import" />
    </Dialog>
  );
}

function LoginTasksPage(props: { notify: Notify }) {
  const scope = useEnterpriseScope();
  const [detail, setDetail] = useState<LoginTaskDto>();
  const [queueRevision, setQueueRevision] = useState(0);
  const [queueLoading, setQueueLoading] = useState(false);
  const [snapshotAt, setSnapshotAt] = useState(Date.now);
  const refreshQueue = () => setQueueRevision((value) => value + 1);
  return <div className="space-y-4">
    <QueueOverview refreshKey={queueRevision} onLoadingChange={setQueueLoading} />
    <ManagedList<LoginTaskDto> scope="tasks" path={`${loginPath(scope.id)}/tasks`} identify={(task) => task.id}
      onRowDetails={setDetail} onNotify={props.notify}
      onRefresh={refreshQueue} onMutation={refreshQueue} refreshDisabled={queueLoading} onResult={() => setSnapshotAt(Date.now())}
      filters={[
        { key: 'status', label: 'Status', multiple: true, options: ['pending', 'running', 'cancelling', 'success', 'failed', 'cancelled'] },
        { key: 'minAttempts', label: 'Min executions', type: 'number' }, { key: 'failureCode', label: 'Failure code' },
        { key: 'minWaitSeconds', label: 'Waiting at least (s)', type: 'number' }, { key: 'minRunSeconds', label: 'Running at least (s)', type: 'number' },
      ]}
      toolbar={<TaskQuickFilters enterpriseId={scope.id} />}
      actions={[
        { id: 'retry', label: 'Retry failed tasks', rowLabel: 'Retry', canRun: (task) => task.status === 'failed' && task.stage !== 'deleting' },
        { id: 'cancel', label: 'Cancel selected', rowLabel: 'Cancel', canRun: (task) => task.status === 'pending' || task.status === 'running' },
        { id: 'delete', label: 'Delete terminal tasks', rowLabel: 'Delete', danger: true, canRun: (task) => ['failed', 'success', 'cancelled'].includes(task.status) && task.stage !== 'deleting' },
      ]}
      columns={[
        { key: 'id', label: 'Task', render: (task) => <div className="flex items-center gap-2"><span className="whitespace-nowrap font-mono text-xs">{task.id}</span><CopyValue value={task.id} compact /></div> },
        { key: 'identity', label: 'Identity', nowrap: true, render: (task) => task.identity },
        { key: 'user', label: 'SSO / GH login', nowrap: true, render: (task) => <div>{task.ssoUser}<p className="text-xs text-slate-600">{task.ghLogin}</p></div> },
        { key: 'status', label: 'Status / stage', sort: 'status', render: (task) => <div><Badge tone={statusTone(task.status)}>{task.status}</Badge><p className="mt-1 text-xs">{task.stage}</p></div> },
        { key: 'attempts', label: 'Executions', sort: 'attempts', align: 'right', defaultHidden: true, render: (task) => task.attempts },
        { key: 'failure', label: 'Failure', render: (task) => task.failureReason ? <details><summary className="max-w-xs cursor-pointer truncate" title={task.failureReason}>{task.failureReason}</summary><p className="whitespace-pre-wrap break-words">{task.failureReason}</p></details> : '-' },
        { key: 'queued', label: 'Queued', sort: 'queuedAt', nowrap: true, render: (task) => formatDate(task.queuedAt ?? task.createdAt) },
        { key: 'duration', label: 'Execution time', align: 'right', render: (task) => task.startedAt ? `${Math.max(0, Math.round(((task.finishedAt ? Date.parse(task.finishedAt) : snapshotAt) - Date.parse(task.startedAt)) / 1000))}s` : '-' },
        { key: 'finished', label: 'Finished', sort: 'finishedAt', defaultHidden: true, nowrap: true, render: (task) => formatDate(task.finishedAt) },
      ]}
    />
    <LoginTaskDetails task={detail} onClose={() => setDetail(undefined)} />
  </div>;
}







function TaskQuickFilters(props: { enterpriseId: string }) {
  return <>
    <span className="mr-auto text-xs text-slate-600">Manual snapshots · Durations as of last refresh</span>
    <a className="ui-filter-chip" href={hashFor('tasks', props.enterpriseId, 'status=failed')}>Failed tasks</a>
    <a className="ui-filter-chip" href={hashFor('tasks', props.enterpriseId, 'status=pending,running,cancelling')}>
      Active tasks
    </a>
  </>;
}

function DiagnosticsPage() {
  const scope = useEnterpriseScope();
  const [results, setResults] = useState<{ name: string; ok: boolean; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const checks = [
    { name: 'Enterprise list', path: '/api/console/proxy/enterprises' },
    { name: 'Proxy accounts', path: `${proxyPath(scope.id)}/accounts` },
    { name: 'SSO users', path: `${ssoPath(scope.id)}/users` },
    { name: 'Login tasks', path: `${loginPath(scope.id)}/tasks` },
    { name: 'Request stats', path: `${proxyPath(scope.id)}/request-stats` },
  ];

  const run = async () => {
    setLoading(true);
    const next = await Promise.all(checks.map(async (check) => {
      try {
        await api(check.path);
        return { name: check.name, ok: true, message: 'OK' };
      } catch (err) {
        return { name: check.name, ok: false, message: (err as Error).message };
      }
    }));
    setResults(next);
    setLoading(false);
  };

  useEffect(() => {
    void run();
  }, []);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle className="mb-1">Service connectivity</CardTitle>
          <p className="text-sm text-slate-600">
            Confirms console proxy routes and internal service token alignment for enterprise {scope.id}.
          </p>
        </div>
        <Button variant="secondary" disabled={loading} onClick={run}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Run checks</Button>
      </Card>
      {loading && !results.length ? <LoadingState label="Running diagnostics..." /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {results.map((result) => (
          <Card key={result.name}>
            <div className="flex items-center justify-between">
              <CardTitle className="mb-0">{result.name}</CardTitle>
              <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'OK' : 'Failed'}</Badge>
            </div>
            <p className={`mt-3 break-words text-sm ${result.ok ? 'text-slate-600' : 'text-red-600'}`}>{result.message}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateUserDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [ssoUser, setSsoUser] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await createSsoUser(scope.id, { ssoUser, password: password || undefined, email: email || undefined, role });
      setSsoUser('');
      setPassword('');
      setEmail('');
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Create SSO user" description="Password defaults to SSO user when left blank." open={props.open} onClose={props.onClose}>
      <FormGrid>
        <Label text="SSO user"><Input value={ssoUser} onChange={(event) => setSsoUser(event.target.value)} /></Label>
        <Label text="Password"><Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" /></Label>
        <Label text="Email"><Input value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create user" />
    </Dialog>
  );
}

function EditUserDialog(props: { user?: SsoUserDto; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.user) return;
    setEmail(props.user.email);
    setRole(props.user.role);
    setPassword('');
    setError(undefined);
  }, [props.user]);

  const submit = async () => {
    if (!props.user) return;
    setSaving(true);
    setError(undefined);
    try {
      await patchSsoUser(scope.id, props.user.ssoUser, { email, role, password: password || undefined });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={`Edit ${props.user?.ssoUser ?? ''}`} description="Leave password blank to keep the current password." open={Boolean(props.user)} onClose={props.onClose}>
      <FormGrid>
        <Label text="Email"><Input value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
        <Label text="New password"><Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Save changes" />
    </Dialog>
  );
}

function ImportUsersDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [csvText, setCsvText] = useState('ssoUser,password\n');
  const [result, setResult] = useState<ReactNode>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const importResult = await importSsoUsers(scope.id, csvText);
      setResult(
        <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium">Batch {importResult.batchId}: {importResult.summary.success} success, {importResult.summary.failed} failed</p>
          <ul className="mt-2 max-h-52 space-y-2 overflow-auto">
            {importResult.rows.map((row) => <li key={`${row.line}-${row.ssoUser}`} className="border-t border-slate-200 py-2">
              <div className="flex flex-wrap items-center gap-2"><span>Line {row.line}: {row.ssoUser || '-'}</span><Badge tone={statusTone(row.status)}>{row.status}</Badge></div>
              <p className="mt-1 break-words text-xs text-slate-600">{row.detail}</p>
            </li>)}
          </ul>
        </div>,
      );
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Import SSO users" description="CSV format: ssoUser or ssoUser,password. Existing users get password updates." open={props.open} onClose={props.onClose}>
      <Textarea aria-label="SSO users CSV" value={csvText} onChange={(event) => setCsvText(event.target.value)} className="h-56 w-full font-mono" />
      {result}
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Import" />
    </Dialog>
  );
}

function ImportEmuUsersDialog(props: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [ssoUser, setSsoUser] = useState('');
  const [plan, setPlan] = useState<ImportEmuPlanDto>();
  const [rows, setRows] = useState<ImportEmuUserRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowPage, setRowPage] = useState(1);
  const [rowPageSize, setRowPageSize] = useState(() => {
    try { const value = Number(localStorage.getItem('console.emu-import.pageSize') ?? 25); return [10, 25, 50, 100].includes(value) ? value : 25; }
    catch (err) { console.warn('Cannot restore import page size', err); return 25; }
  });
  const rowRequest = useRef<AbortController | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<ImportEmuUserStatus | ''>('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState<'preview' | 'apply' | 'rows' | 'delete'>();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const loadRows = async (planId: string, nextPage = rowPage, nextStatus = statusFilter, nextSize = rowPageSize) => {
    rowRequest.current?.abort();
    const controller = new AbortController();
    rowRequest.current = controller;
    setSaving('rows');
    setError(undefined);
    try {
      const query = { page: nextPage, pageSize: nextSize, status: nextStatus };
      const result = await listEmuImportPlanRows(scope.id, planId, query, controller.signal);
      setRows(result.items);
      setRowTotal(result.total);
      setRowPage(result.page);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      if (rowRequest.current === controller) setSaving(undefined);
    }
  };

  useEffect(() => () => rowRequest.current?.abort(), []);

  const preview = async () => {
    setSaving('preview');
    setError(undefined);
    try {
      const nextPlan = await createEmuImportPlan(scope.id, { ssoUser: ssoUser.trim() || undefined });
      setPlan(nextPlan);
      setStatusFilter('');
      await loadRows(nextPlan.planId, 1, '');
    } catch (err) {
      setError((err as Error).message);
      setSaving(undefined);
    }
  };

  const applyPlan = async () => {
    if (!plan) return;
    setSaving('apply');
    setError(undefined);
    try {
      const nextPlan = await applyEmuImportPlan(scope.id, plan.planId);
      setPlan(nextPlan);
      await loadRows(nextPlan.planId, rowPage, statusFilter);
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
      setSaving(undefined);
    }
  };

  const deletePlan = async () => {
    if (!plan) return;
    setSaving('delete');
    setError(undefined);
    try {
      await deleteEmuImportPlan(scope.id, plan.planId);
      setPlan(undefined);
      setRows([]);
      setRowTotal(0);
      setRowPage(1);
      setStatusFilter('');
      setDeleteOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  const resetSsoUser = (value: string) => {
    setSsoUser(value);
    setPlan(undefined);
    setRows([]);
    setRowTotal(0);
    setRowPage(1);
  };
  const changeStatusFilter = (value: ImportEmuUserStatus | '') => {
    setStatusFilter(value);
    if (plan) void loadRows(plan.planId, 1, value);
  };
  const actionable = (plan?.summary.actionable ?? 0) > 0;

  return (
    <><Dialog
      title="Import SSO users from GH"
      description="Preview GitHub SCIM and enterprise direct Copilot seats, including cancellation dates. Apply uses this snapshot; preview again after seat changes. Organization/team access is excluded. Leave SSO user blank to scan all users."
      open={props.open}
      onClose={props.onClose}
    >
      <Label text="SSO user">
        <Input value={ssoUser} onChange={(event) => resetSsoUser(event.target.value)} placeholder="Optional; blank imports all" />
      </Label>
      {plan ? (
        <EmuImportResult
          plan={plan}
          rows={rows}
          rowTotal={rowTotal}
          rowPage={rowPage}
          rowPageSize={rowPageSize}
          statusFilter={statusFilter}
          loadingRows={saving === 'rows'}
          onStatusFilter={changeStatusFilter}
          onPage={(nextPage) => loadRows(plan.planId, nextPage, statusFilter)}
          onPageSize={(size) => {
            setRowPageSize(size);
            try { localStorage.setItem('console.emu-import.pageSize', String(size)); }
            catch (err) { console.warn('Cannot save import page size', err); setError('Page size could not be saved in this browser.'); }
            void loadRows(plan.planId, 1, statusFilter, size);
          }}
        />
      ) : null}
      <footer className="mt-5 flex flex-col gap-3">
        {error ? <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          {plan ? (
            <Button variant="dangerOutline" onClick={() => { setError(undefined); setDeleteOpen(true); }} disabled={Boolean(saving)}>
              Delete plan data
            </Button>
          ) : null}
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button variant="secondary" onClick={preview} disabled={Boolean(saving)}>
            {saving === 'preview' ? 'Previewing...' : 'Preview alignment'}
          </Button>
          <Button onClick={applyPlan} disabled={Boolean(saving) || !actionable}>
            {saving === 'apply' ? 'Applying...' : 'Apply safe changes'}
          </Button>
        </div>
      </footer>
    </Dialog>
    <ConfirmDialog open={props.open && deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={deletePlan} busy={saving === 'delete'} error={error}
      title="Delete import plan data" confirmLabel="Delete plan data" danger
      description={`${scopeText(scope)} ${DELETE_PLAN_WARNING}`} /></>
  );
}

const DELETE_PLAN_WARNING = 'Delete this GH import plan data? This only removes preview/apply rows and does not '
  + 'delete SSO users or GH logins.';

function EmuImportResult(props: {
  plan: ImportEmuPlanDto;
  rows: ImportEmuUserRow[];
  rowTotal: number;
  rowPage: number;
  rowPageSize: number;
  statusFilter: ImportEmuUserStatus | '';
  loadingRows: boolean;
  onStatusFilter: (status: ImportEmuUserStatus | '') => void;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const summary = props.plan.summary;
  return (
    <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
      <p className="font-medium">Plan {props.plan.planId}: {summary.actionable} actionable, {summary.skipped} skipped, {summary.conflict} conflict, {summary.failed} failed</p>
      <div className="mt-2 grid gap-2 text-xs md:grid-cols-4">
        <Info label="Pending create" value={formatNumber(summary.pendingCreate)} />
        <Info label="Pending update" value={formatNumber(summary.pendingUpdate)} />
        <Info label="Created/updated" value={`${formatNumber(summary.created)} / ${formatNumber(summary.updated)}`} />
        <Info label="Total rows" value={formatNumber(summary.total)} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Select aria-label="Import row status" value={props.statusFilter} onChange={(event) => props.onStatusFilter(event.target.value as ImportEmuUserStatus | '')}>
          {EMU_IMPORT_ROW_STATUSES.map((status) => <option key={status || 'all'} value={status}>{status || 'all statuses'}</option>)}
        </Select>
        <span className="text-xs text-slate-500">{props.loadingRows ? 'Loading rows...' : `${formatNumber(props.rowTotal)} row(s)`}</span>
      </div>
      <ul className="mt-2 max-h-52 space-y-2 overflow-auto">
        {props.rows.map((row, index) => (
          <li key={`${row.ghScimId ?? row.ssoUser}-${row.status}-${index}`} className="border-t border-slate-200 py-2">
            <div className="flex flex-wrap items-center gap-2"><span>#{row.rowIndex ?? '-'} {row.ssoUser || '-'}</span><Badge tone={statusTone(row.status)}>{row.status}</Badge></div>
            <p className="mt-1 break-words text-xs text-slate-600">{row.detail}</p>
            {row.ghLogin ? <p className="mt-1 text-xs text-slate-600">GH login: {row.ghLogin}</p> : null}
            {row.copilotSeatStatus ? <p className="text-xs text-slate-600">Direct Copilot seat: {formatCopilotSeat(row.copilotSeatStatus, row.copilotSeatPendingCancellationDate)}</p> : null}
          </li>
        ))}
        {props.rows.length === 0 ? <li className="text-slate-500">No rows match this filter.</li> : null}
      </ul>
      <Pagination page={props.rowPage} total={props.rowTotal} pageSize={props.rowPageSize} onPage={props.onPage} onPageSize={props.onPageSize} />
    </div>
  );
}

function BatchCreateDialog(props: { open: boolean; remaining: number | null; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const [prefix, setPrefix] = useState('user');
  const [start, setStart] = useState(1);
  const [count, setCount] = useState(5);
  const [role, setRole] = useState<'user' | 'admin'>('user');
  const [syncAfterCreate, setSyncAfterCreate] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const preview = Array.from({ length: Math.max(0, Math.min(count, 20)) }, (_, index) => `${prefix}${start + index}`);

  const submit = async () => {
    if (props.remaining !== null && count > props.remaining) {
      setError(`Only ${props.remaining} SSO user slot(s) remain.`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const createdSsoUsers: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const ssoUser = `${prefix}${start + index}`;
        await createSsoUser(scope.id, { ssoUser, role });
        createdSsoUsers.push(ssoUser);
      }
      const sync = { operation: 'sync_emu' as const, ssoUsers: createdSsoUsers };
      if (syncAfterCreate && createdSsoUsers.length > 0) await runSsoUserBatch(scope.id, sync);
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Batch create SSO users" description="Generate a predictable set of local SSO accounts." open={props.open} onClose={props.onClose}>
      <FormGrid>
        <Label text="Prefix"><Input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></Label>
        <Label text="Start index"><Input type="number" value={start} onChange={(event) => setStart(Number(event.target.value))} /></Label>
        <Label text="Count"><Input type="number" min={1} max={props.remaining === null ? 500 : Math.min(500, props.remaining)} value={count} onChange={(event) => setCount(Number(event.target.value))} /></Label>
        <Label text="Role"><RoleSelect value={role} onChange={setRole} /></Label>
      </FormGrid>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Checkbox checked={syncAfterCreate} onChange={(event) => setSyncAfterCreate(event.target.checked)} />
        Sync each user to GH login after creation
      </label>
      <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
        <p className="font-medium">Preview</p>
        <p className="mt-1">{preview.join(', ')}{count > preview.length ? ` ... +${count - preview.length} more` : ''}</p>
        {props.remaining !== null ? <p className="mt-2">{props.remaining} SSO user slot(s) remaining.</p> : null}
      </div>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create users" />
    </Dialog>
  );
}

function CopilotOauthReauthorizationDialog(props: { account?: ProxyAccountDto; onClose: () => void; onDone: () => Promise<void> }) {
  const scope = useEnterpriseScope();
  const passwordHelpId = useId();
  const [ssoPassword, setSsoPassword] = useState('');
  const [usingDefault, setUsingDefault] = useState(true);
  const [ssoType, setSsoType] = useState<SsoType>('custom');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSsoPassword('');
    setUsingDefault(true);
    setSsoType('custom');
    setError(undefined);
  }, [props.account]);

  const submit = async () => {
    if (!props.account) return;
    if ((!usingDefault && !ssoPassword) || (usingDefault && ssoType === 'azure')) {
      setError('Provide a password override for this account. Azure cannot use the local default password.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await reauthorizeCopilotOauth(scope.id, props.account.identity, usingDefault
        ? { credentialMode: 'default', ssoType }
        : { credentialMode: 'override', ssoPassword, ssoType });
      await props.onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title="Reauthorize Copilot OAuth" description="Creates a new login task. Default passwords are resolved by SSO; overrides apply only to this authorization and are not stored." open={Boolean(props.account)} onClose={props.onClose}>
      <FormGrid>
        <div className="min-w-0 space-y-1 md:col-span-2">
          <label className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              <Checkbox checked={!usingDefault} disabled={ssoType === 'azure'} aria-describedby={passwordHelpId} onChange={(event) => { setUsingDefault(!event.target.checked); setSsoPassword(''); }} />
              <span className="min-w-0 break-all font-mono">{props.account?.identity}</span>
            </span>
            <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-900">Use a custom password instead of the default password</span>
          </label>
          <p id={passwordHelpId} className="text-xs text-slate-600">When unchecked, the default password resolved by SSO is used. When selected, enter the password for this account.{ssoType === 'azure' ? ' Azure requires a custom password for this account.' : ''}</p>
        </div>
        <Label text="SSO type">
          <Select value={ssoType} onChange={(event) => { setSsoType(event.target.value as SsoType); if (event.target.value === 'azure') setUsingDefault(false); }}>
            <option value="custom">Custom</option>
            <option value="azure">Azure</option>
          </Select>
        </Label>
        {!usingDefault ? <Label text="SSO password override"><Input type="password" autoComplete="new-password" value={ssoPassword} onChange={(event) => setSsoPassword(event.target.value)} /></Label> : null}
      </FormGrid>
      <DialogActions error={error} saving={saving} onCancel={props.onClose} onSubmit={submit} submitLabel="Create reauthorization task" />
    </Dialog>
  );
}



function ProxyAccountDetailDialog(props: { account?: ProxyAccountDto; onClose: () => void }) {
  const scope = useEnterpriseScope();
  const [stats, setStats] = useState<ProxyRequestStatDto[]>([]);
  const [snapshot, setSnapshot] = useState<ProxyAccountDto>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const identity = props.account?.identity;
  useEffect(() => { setStats([]); setSnapshot(props.account); setUpdatedAt(undefined); setError(undefined); }, [identity]);

  useEffect(() => {
    if (!identity) return;
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      getProxyAccount(scope.id, identity, controller.signal),
      listRequestStats(scope.id, { identity, limit: 20 }, controller.signal),
    ]).then(([account, requests]) => {
      if (controller.signal.aborted) return;
      setSnapshot(account); setStats(requests); setError(undefined); setUpdatedAt(new Date().toLocaleTimeString());
    }).catch((err: Error) => { if (!controller.signal.aborted) setError(`Account details may be stale: ${err.message}`); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [identity, revision]);

  return (
    <Dialog title={`Account ${props.account?.identity ?? ''}`} description="Identity mapping, token status, and recent request stats." open={Boolean(props.account)} onClose={props.onClose}>
      {snapshot && props.account ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-600">{updatedAt ? `Updated ${updatedAt}` : 'Not refreshed'}{error ? ' · stale' : ''}</span>
            <Button variant="secondary" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh details</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Info label="Header identity" value={snapshot.identity} />
            <Info label="SSO user" value={snapshot.ssoUser} />
            <Info label="GH login" value={snapshot.ghLogin ?? '-'} />
            <Info label="Copilot OAuth" value={<Badge tone={statusTone(snapshot.copilotOauthStatus)}>{snapshot.copilotOauthStatus}</Badge>} />
            <Info label="OAuth updated" value={formatDate(snapshot.copilotOauthUpdatedAt)} />
          </div>
          {error ? <ErrorState message={error} /> : null}
          <div className="max-h-96 overflow-auto rounded border border-slate-200">
            <RequestStatsTable stats={stats} />
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function RequestStatsTable(props: { stats: ProxyRequestStatDto[] }) {
  return (
    <Table compact>
      <thead>
        <tr>
          <Th>Identity</Th>
          <Th>Path</Th>
          <Th>Model</Th>
          <Th>Outcome</Th>
          <Th className="text-right">Total</Th>
          <Th>Failure</Th>
        </tr>
      </thead>
      <tbody>
        {props.stats.map((stat) => {
          const cache = statCacheTokens(stat);
          const total = tokenTotal(stat.inputTokens, stat.outputTokens, cache);
          return (
            <tr key={stat.id}>
              <Td>{stat.identity}</Td>
              <Td>{stat.path}</Td>
              <Td>{stat.model ?? '-'}</Td>
              <Td><Badge tone={stat.success ? 'success' : 'danger'}>{stat.success ? 'success' : 'failed'}</Badge></Td>
              <Td className="text-right tabular-nums">{formatNumber(total)}</Td>
              <Td><RequestFailure reason={stat.failureReason} /></Td>
            </tr>
          );
        })}
        {props.stats.length === 0 ? <EmptyRow colSpan={6} label="No request stats found." /> : null}
      </tbody>
    </Table>
  );
}

function statCacheTokens(stat: ProxyRequestStatDto): number | undefined {
  return stat.cacheTokens ?? tokenTotal(stat.cacheInputTokens, stat.cacheWriteTokens);
}

function StatusWithDate(props: { status: string; date?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={statusTone(props.status)}>{props.status}</Badge>
      {props.date ? <span className="text-xs text-slate-500">{props.date.startsWith('expires ') ? props.date : formatDate(props.date)}</span> : null}
    </div>
  );
}

function DialogActions(props: { error?: string; saving: boolean; submitLabel: string; onCancel: () => void; onSubmit: () => void | Promise<void> }) {
  return (
    <footer className="mt-5 flex flex-col gap-3">
      {props.error ? <p className="rounded bg-red-50 p-3 text-sm text-red-700">{props.error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={props.onCancel}>Cancel</Button>
        <Button onClick={props.onSubmit} disabled={props.saving}>{props.saving ? 'Working...' : props.submitLabel}</Button>
      </div>
    </footer>
  );
}

function RoleSelect(props: { value: 'user' | 'admin'; onChange: (role: 'user' | 'admin') => void }) {
  return (
    <Select value={props.value} onChange={(event) => props.onChange(event.target.value as 'user' | 'admin')}>
      <option value="user">User</option>
      <option value="admin">Admin</option>
    </Select>
  );
}

function FormGrid(props: { children: ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2">{props.children}</div>;
}

function Label(props: { text: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-sm font-medium text-slate-700"><span>{props.text}</span>{props.children}</label>;
}

function EmptyRow(props: { colSpan: number; label: string }) {
  return <tr><td colSpan={props.colSpan} className="px-3 py-8 text-center text-sm text-slate-500">{props.label}</td></tr>;
}

function Pagination(props: { page: number; total: number; pageSize: number; onPage: (page: number) => void; onPageSize?: (size: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 py-3 text-xs text-slate-600">
      <span>Page {props.page} of {totalPages}, {props.total} total</span>
      {props.onPageSize ? <label className="flex items-center gap-2">Rows <Select aria-label="Rows per page" value={props.pageSize} onChange={(event) => props.onPageSize?.(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</Select></label> : null}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>Previous</Button>
        <Button size="sm" variant="secondary" disabled={props.page >= totalPages} onClick={() => props.onPage(props.page + 1)}>Next</Button>
      </div>
    </div>
  );
}
