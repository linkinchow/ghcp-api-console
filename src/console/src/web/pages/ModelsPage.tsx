import { useEffect, useRef, useState } from 'react';
import type { AdminModelsResponse, ProxyModelDto } from '@ghcp/shared';
import { ConsoleApiError } from '../api/client.js';
import { getAdminModels } from '../api/models.js';
import { Button } from '../components/ui/button.js';
import { Card, CardDescription, CardTitle } from '../components/ui/card.js';
import { Dialog } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Select } from '../components/ui/select.js';
import { useEnterpriseScope } from '../lib/scope.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
type ModelView = 'all' | 'messages';

const ADMIN_SOURCE_ERRORS: Record<string, string> = {
  models_admin_not_configured: 'No GitHub enterprise admin is configured for the model catalog of this enterprise.',
  models_admin_credential_missing: 'The configured GitHub enterprise admin credential is unavailable.',
  models_admin_identity_mismatch: 'The credential does not belong to the configured GitHub enterprise admin.',
  models_upstream_authorization_rejected: 'Copilot rejected the configured GitHub enterprise admin.',
  models_admin_configuration_invalid: 'The GitHub enterprise admin configuration is invalid.',
};

function errorMessage(error: unknown, enterpriseId: string): string {
  if (error instanceof ConsoleApiError && error.status === 401) {
    return 'Your console session may have expired. Reload the console and sign in again.';
  }
  if (error instanceof ConsoleApiError && ADMIN_SOURCE_ERRORS[error.code]) {
    const advice = 'Ask your operator to correct it, then refresh. '
      + 'No pool account or other enterprise is used instead.';
    return `Enterprise ${enterpriseId}: ${ADMIN_SOURCE_ERRORS[error.code]} ${advice}`;
  }
  return error instanceof Error ? error.message : 'Unable to load models. Try again.';
}

function formatLimit(value: number | undefined): string {
  return value === undefined ? 'Unknown' : value.toLocaleString();
}

function matches(model: ProxyModelDto, view: ModelView, search: string): boolean {
  if (view === 'messages' && !model.supportedPaths.includes('/v1/messages')) return false;
  const needle = search.trim().toLowerCase();
  return [model.id, model.upstreamId, model.name ?? ''].some((value) => value.toLowerCase().includes(needle));
}

/** The catalog of the selected enterprise's admin; the page remounts when the enterprise changes. */
export function ModelsPage({ notify }: { notify: Notify }) {
  const scope = useEnterpriseScope();
  const [catalog, setCatalog] = useState<AdminModelsResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ModelView>('all');
  const [details, setDetails] = useState<ProxyModelDto>();
  const [manualCopy, setManualCopy] = useState<string>();
  const inFlight = useRef<AbortController | undefined>(undefined);

  async function load(refresh: boolean) {
    // Only the latest request may update the page; an earlier one is cancelled.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setCatalog(undefined);
    setError(undefined);
    setDetails(undefined);
    setManualCopy(undefined);
    setLoading(true);
    try {
      const result = await getAdminModels(scope.id, refresh, controller.signal);
      if (!controller.signal.aborted) setCatalog(result);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err, scope.id));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    return () => inFlight.current?.abort();
  }, []);

  async function copyId(id: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(id);
      setManualCopy(undefined);
      notify('Model ID copied.', 'success');
    } catch {
      setManualCopy(id);
      notify('Clipboard unavailable. Select and copy the model ID manually.', 'warning');
    }
  }

  const filtered = catalog?.models.filter((model) => matches(model, view, search)) ?? [];
  const resetSelection = () => {
    setDetails(undefined);
    setManualCopy(undefined);
  };

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Model catalog of {scope.displayName}</CardTitle>
            <CardDescription>
              The actual Copilot /models catalog of the GitHub enterprise admin configured for enterprise
              {' '}<code>{scope.id}</code>, not Proxy configuration.
            </CardDescription>
          </div>
          <Button variant="secondary" disabled={loading} onClick={() => void load(true)}>
            {loading ? 'Loading models…' : 'Refresh models'}
          </Button>
        </div>
        <p className="mt-3 text-sm text-slate-600">No pool accounts are queried. Credentials stay on the server.</p>
        {loading ? <p role="status" className="mt-3 text-sm">Loading the catalog…</p> : null}
        {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
        {catalog ? (
          <CatalogSummary
            catalog={catalog}
            shown={filtered.length}
            search={search}
            view={view}
            onSearch={(value) => { setSearch(value); resetSelection(); }}
            onView={(value) => { setView(value); resetSelection(); }}
          />
        ) : null}
      </Card>

      {catalog ? (
        <ModelsTable catalog={catalog} models={filtered} onCopy={(id) => void copyId(id)} onDetails={setDetails} />
      ) : null}

      {manualCopy !== undefined ? <ManualCopy value={manualCopy} /> : null}

      <Dialog
        title={details ? `Model details: ${details.id}` : 'Model details'}
        description={catalog ? `Enterprise admin: ${catalog.adminLogin}. Sanitized upstream metadata.` : undefined}
        open={Boolean(details)}
        onClose={() => setDetails(undefined)}
      >
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 text-xs [overflow-wrap:anywhere]">
          {details ? JSON.stringify(details.details, null, 2) : ''}
        </pre>
      </Dialog>
    </div>
  );
}

function CatalogSummary(props: {
  catalog: AdminModelsResponse;
  shown: number;
  search: string;
  view: ModelView;
  onSearch: (value: string) => void;
  onView: (value: ModelView) => void;
}) {
  const { catalog } = props;
  return (
    <>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-slate-500">Enterprise admin</dt>
          <dd className="break-all font-semibold">{catalog.adminLogin}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Fetched at</dt>
          <dd className="break-all"><time dateTime={catalog.fetchedAt}>{catalog.fetchedAt}</time> · {catalog.cacheStatus}</dd>
        </div>
      </dl>
      <CacheNotice status={catalog.cacheStatus} />
      <p className="mt-2 text-xs text-slate-500">
        Default view for API callers: {catalog.defaultView === 'messages' ? 'Messages-compatible' : 'All models'}.
        This page starts with all models. Availability can differ per account.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Search models
          <Input className="mt-1 block w-full" type="search" value={props.search} placeholder="Model ID, upstream ID or name"
            onChange={(event) => props.onSearch(event.target.value)} />
        </label>
        <label className="block text-sm font-medium">
          Model view
          <Select className="mt-1 w-full" value={props.view} onChange={(event) => props.onView(event.target.value as ModelView)}>
            <option value="all">All models</option>
            <option value="messages">Messages-compatible</option>
          </Select>
        </label>
      </div>
      <p className="mt-3 text-sm text-slate-600">{props.shown} of {catalog.models.length} models</p>
      <p className="mt-1 text-xs text-slate-500">
        Supported API paths may include Proxy compatibility inference; they are not an upstream guarantee. Missing limits are unknown, not zero.
      </p>
    </>
  );
}

function CacheNotice({ status }: { status: AdminModelsResponse['cacheStatus'] }) {
  if (status === 'fresh') return null;
  const text = status === 'stale'
    ? 'Stale catalog: the latest upstream fetch failed, so this is an older snapshot, not a live availability guarantee.'
    : 'Cached catalog: fetched at the time above. Refresh to request the latest catalog.';
  return <p role="status" className="mt-2 text-sm text-amber-800">{text}</p>;
}

function ModelsTable(props: {
  catalog: AdminModelsResponse;
  models: ProxyModelDto[];
  onCopy: (id: string) => void;
  onDetails: (model: ProxyModelDto) => void;
}) {
  if (!props.catalog.models.length) {
    return <Card><p className="text-sm text-slate-600">The enterprise admin returned an empty model catalog. Refresh to check again.</p></Card>;
  }
  if (!props.models.length) {
    return <Card><p className="text-sm text-slate-600">No models match this search and view. Clear the search or choose All models.</p></Card>;
  }
  const headings = ['Model / upstream ID', 'Supported API paths', 'Context window', 'Max output tokens', 'Details'];
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto" role="region" aria-label="Models" tabIndex={0}>
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>{headings.map((label) => <th className="whitespace-nowrap p-3" key={label}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {props.models.map((model) => (
              <tr key={model.id} className="border-t border-slate-200 align-top">
                <td className="p-3">
                  <div className="flex items-start gap-2">
                    <code className="max-w-sm break-all font-semibold">{model.id}</code>
                    <Button variant="ghost" size="sm" aria-label={`Copy model ID ${model.id}`} onClick={() => props.onCopy(model.id)}>Copy</Button>
                  </div>
                  {model.name ? <p className="mt-1 break-words">{model.name}</p> : null}
                  <p className="mt-1 break-all text-xs text-slate-500">Upstream: {model.upstreamId}</p>
                </td>
                <td className="p-3 text-xs">
                  {model.supportedPaths.length
                    ? model.supportedPaths.map((path) => <code key={path} className="block whitespace-nowrap">{path}</code>)
                    : 'Unknown'}
                </td>
                <td className="p-3 tabular-nums">{formatLimit(model.contextWindow)}</td>
                <td className="p-3 tabular-nums">{formatLimit(model.maxOutputTokens)}</td>
                <td className="p-3">
                  <Button variant="secondary" aria-label={`Details for ${model.id}`} onClick={() => props.onDetails(model)}>Details</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ManualCopy({ value }: { value: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [value]);
  return (
    <Card>
      <label className="block text-sm">
        Clipboard unavailable. Select and copy the model ID manually.
        <textarea ref={field} aria-label="Model ID for manual copy" readOnly value={value} rows={2}
          onFocus={(event) => event.currentTarget.select()}
          className="mt-2 block w-full rounded border border-slate-300 p-2 font-mono text-sm" />
      </label>
    </Card>
  );
}
