import { useEffect, useRef, useState } from 'react';
import type {
  ProxyErrorDiagnosticDetailDto, ProxyErrorDiagnosticsListResponse, ProxyErrorDiagnosticSummaryDto,
} from '@ghcp/shared';
import {
  clearErrorDiagnostics, downloadErrorDiagnostic, errorDiagnosticsPath, getErrorDiagnostic,
} from '../api/proxy.js';
import { ManagedList, type ManagementColumn } from '../components/ManagedList.js';
import { LoadingState } from '../components/PageState.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog, Dialog } from '../components/ui/dialog.js';
import { formatDate } from '../lib/format.js';

type Notify = (message: string, tone?: 'success' | 'warning' | 'error') => void;
type Diagnostic = ProxyErrorDiagnosticSummaryDto;

const DIAGNOSTIC_PREVIEW_CHARS = 20_000;
const CLEAR_DESCRIPTION = 'Clear all stored proxy error diagnostics of every enterprise, not only the filtered '
  + 'results? This cannot be undone.';
const FILTERS = [
  { key: 'model' as const, label: 'Model' },
  { key: 'status' as const, label: 'HTTP status' },
  { key: 'failureCode' as const, label: 'Failure kind', options: ['http', 'fetch', 'stream'] },
  { key: 'from' as const, label: 'Recorded from', type: 'datetime-local' as const },
  { key: 'to' as const, label: 'Recorded before', type: 'datetime-local' as const },
];

function previewText(value: string): string {
  const truncated = value.length > DIAGNOSTIC_PREVIEW_CHARS;
  const note = truncated ? '\n\n[Preview truncated; download the record for complete data.]' : '';
  return `${value.slice(0, DIAGNOSTIC_PREVIEW_CHARS)}${note}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function bodySizes(record: Diagnostic): string {
  const inbound = formatBytes(record.inboundRequestBodyBytes);
  const sent = formatBytes(record.upstreamRequestBodyBytes);
  return `in ${inbound} / sent ${sent} / received ${formatBytes(record.upstreamResponseBodyBytes)}`;
}

async function download(id: string, notify: Notify): Promise<void> {
  try {
    const result = await downloadErrorDiagnostic(id);
    const url = URL.createObjectURL(result.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = result.filename;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err), 'error');
  }
}

function columns(onDetails: (id: string) => void, onDownload: (id: string) => void): ManagementColumn<Diagnostic>[] {
  return [
    { key: 'time', label: 'Time', nowrap: true, render: (record) => formatDate(record.timestamp) },
    { key: 'enterprise', label: 'Enterprise', nowrap: true, render: (record) => record.enterpriseId ?? 'unknown' },
    { key: 'identity', label: 'Identity', render: (record) => record.identity },
    {
      key: 'path', label: 'Route / model',
      render: (record) => <div>{record.path}<p className="text-xs">{record.model}</p></div>,
    },
    { key: 'failure', label: 'Failure', render: (record) => <Badge>{record.failureKind}</Badge> },
    { key: 'status', label: 'HTTP status', render: (record) => record.status ?? '-' },
    { key: 'sizes', label: 'Body sizes', render: bodySizes },
    {
      key: 'actions', label: 'Actions',
      render: (record) => <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => onDetails(record.id)}>Details</Button>
        <Button size="sm" variant="secondary" onClick={() => onDownload(record.id)}>Download</Button>
      </div>,
    },
  ];
}

/** Process-wide diagnostics; each record names the enterprise whose account failed. */
export function ErrorDiagnosticsPage(props: { notify: Notify }) {
  const [result, setResult] = useState<ProxyErrorDiagnosticsListResponse>();
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [detail, setDetail] = useState<ProxyErrorDiagnosticDetailDto>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string>();
  const detailRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => detailRequest.current?.abort(), []);
  const openDetail = async (id: string) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setSelectedId(id);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      const next = await getErrorDiagnostic(id, controller.signal);
      if (!controller.signal.aborted) setDetail(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      props.notify(err instanceof Error ? err.message : String(err), 'error');
      setSelectedId(undefined);
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  };
  const closeDetail = () => {
    detailRequest.current?.abort();
    setSelectedId(undefined);
    setDetail(undefined);
    setDetailLoading(false);
  };
  const clear = async () => {
    if (clearing) return;
    setClearing(true);
    setClearError(undefined);
    try {
      await clearErrorDiagnostics();
      closeDetail();
      setClearOpen(false);
      setRevision((value) => value + 1);
      props.notify('Diagnostics cleared.');
    } catch (err) {
      setClearError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };
  const openClear = () => {
    setClearError(undefined);
    setClearOpen(true);
  };
  const tableColumns = columns((id) => void openDetail(id), (id) => void download(id, props.notify));
  return <div className="space-y-4">
    {result ? <CollectionBadges result={result} /> : null}
    <ManagedList<Diagnostic, ProxyErrorDiagnosticsListResponse> scope="error-diagnostics" path={errorDiagnosticsPath}
      identify={(record) => record.id} onResult={setResult} refreshKey={revision} filters={FILTERS}
      toolbar={<Button type="button" variant="dangerOutline" disabled={!result?.enabled} onClick={openClear}>
        Clear all diagnostics
      </Button>}
      columns={tableColumns} />
    <Dialog title="Proxy error diagnostic" description={selectedId} open={selectedId !== undefined}
      onClose={closeDetail}>
      {detailLoading ? <LoadingState label="Loading diagnostic..." /> : null}
      {detail ? <DiagnosticDetail detail={detail} onDownload={() => void download(detail.id, props.notify)} /> : null}
    </Dialog>
    <ConfirmDialog open={clearOpen} onClose={() => setClearOpen(false)} onConfirm={clear} busy={clearing}
      error={clearError} title="Clear all diagnostics" confirmLabel="Clear all diagnostics" danger
      description={CLEAR_DESCRIPTION} />
  </div>;
}

function CollectionBadges({ result }: { result: ProxyErrorDiagnosticsListResponse }) {
  return (
    <div className="flex gap-2">
      <Badge tone={result.enabled ? 'success' : 'warning'}>
        {result.enabled ? 'Collection enabled' : 'Collection disabled'}
      </Badge>
      <Badge tone={result.redacted ? 'info' : 'warning'}>
        {result.redacted ? 'Sensitive data redacted' : 'Unredacted records'}
      </Badge>
    </div>
  );
}

function DiagnosticDetail(props: { detail: ProxyErrorDiagnosticDetailDto; onDownload: () => void }) {
  const preClass = 'max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-3 text-xs '
    + 'text-slate-100';
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Enterprise: {props.detail.enterpriseId ?? 'unknown'}</p>
      <pre className={preClass}>{previewText(props.detail.content)}</pre>
      <Button onClick={props.onDownload}>Download complete log</Button>
    </div>
  );
}
