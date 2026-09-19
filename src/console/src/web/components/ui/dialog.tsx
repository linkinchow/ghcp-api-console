import { useId, type ReactNode } from 'react';
import { Button } from './button.js';

export function Dialog(props: { title: string; description?: string; open: boolean; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-950">{props.title}</h2>
            {props.description ? <p className="mt-1 text-sm text-slate-600">{props.description}</p> : null}
          </div>
          <Button variant="ghost" onClick={props.onClose} aria-label="Close dialog">Close</Button>
        </header>
        {props.children}
      </section>
    </div>
  );
}
