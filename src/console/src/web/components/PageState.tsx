import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from './ui/card.js';

export function LoadingState(props: { label: string }) {
  return (
    <p role="status" className="flex min-h-10 items-center gap-2 text-sm text-slate-600">
      <Loader2 size={16} className="animate-spin" />
      {props.label}
    </p>
  );
}

export function ErrorState(props: { message: string }) {
  const className = 'break-words rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700';
  return <p role="alert" className={className}>{props.message}</p>;
}

export function MetricCard(props: { title: string; value: string | number; detail: string; error?: string }) {
  const detailClass = `mt-2 break-words text-sm ${props.error ? 'text-red-600' : 'text-slate-600'}`;
  return (
    <Card>
      <p className="text-sm font-medium text-slate-600">{props.title}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-950">{props.error ? '-' : props.value}</p>
      <p className={detailClass}>{props.error ?? props.detail}</p>
    </Card>
  );
}

export function Info(props: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{props.label}</p>
      <div className="mt-1 break-words text-sm text-slate-950">{props.value}</div>
    </div>
  );
}
