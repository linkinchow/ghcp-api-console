import { useEffect, useRef, useState } from 'react';

/** Keep the stored reason intact; only the collapsed presentation is shortened. */
export function RequestFailure({ reason }: { reason?: string | null }) {
  return reason ? <FailureDetail key={reason} reason={reason} /> : <span>-</span>;
}

function FailureDetail({ reason }: { reason: string }) {
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (manualCopy) {
      if (details.current) details.current.open = true;
      fallback.current?.focus();
      fallback.current?.select();
    }
  }, [manualCopy]);

  const copy = async () => {
    setCopied(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(reason);
      setManualCopy(false);
      setCopied(true);
    } catch {
      setManualCopy(true);
      if (details.current) details.current.open = true;
      fallback.current?.focus();
      fallback.current?.select();
    }
  };

  return (
    <div className="relative flex w-96 max-w-full items-start gap-1 whitespace-normal">
      <details ref={details} className="min-w-0 flex-1">
        <summary className="cursor-pointer rounded text-slate-700 focus-visible:outline-2 focus-visible:outline-blue-600" title="Expand full failure reason">
          <span className="inline-block max-w-[calc(100%-1.5rem)] truncate align-bottom">{reason}</span>
        </summary>
        <pre className="mt-2 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 font-mono text-xs text-slate-700 [overflow-wrap:anywhere]">{reason}</pre>
        {/\[ref: [0-9a-f-]{36}\]/i.test(reason) ? <p className="mt-1 text-xs text-slate-500">Reference IDs correlate with server logs, not necessarily a saved diagnostic file.</p> : null}
        {manualCopy ? (
          <label className="mt-2 block text-xs text-slate-600">
            Clipboard unavailable. Select and copy the full reason manually.
            <textarea ref={fallback} aria-label="Full failure reason for manual copy" readOnly value={reason} rows={4} onFocus={(event) => event.currentTarget.select()} className="mt-1 block w-full resize-y rounded border border-slate-300 p-2 font-mono text-xs" />
          </label>
        ) : null}
      </details>
      <button type="button" onClick={() => void copy()} aria-label={copied ? 'Copied failure reason' : 'Copy full failure reason'} title={copied ? 'Copied' : 'Copy full failure reason'} className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-blue-600">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" /></>}
        </svg>
      </button>
      <span role="status" className="sr-only">{copied ? 'Failure reason copied.' : ''}</span>
    </div>
  );
}
