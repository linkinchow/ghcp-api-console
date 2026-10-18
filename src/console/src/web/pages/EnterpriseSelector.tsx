import { useCallback, useEffect, useRef, useState } from 'react';
import { githubHost, listEnterprises, type EnterpriseList, type EnterpriseListItem } from '../api/enterprises.js';
import { Select } from '../components/ui/select.js';

export interface EnterpriseListState {
  list?: EnterpriseList;
  error?: string;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Loads `GET /api/console/proxy/enterprises`; only the latest request may update the state. */
export function useEnterpriseList(): EnterpriseListState {
  const [list, setList] = useState<EnterpriseList>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const request = useRef<AbortController | undefined>(undefined);
  const reload = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await listEnterprises(controller.signal);
      if (controller.signal.aborted) return;
      setList(next);
      setError(undefined);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => request.current?.abort();
  }, [reload]);
  return { list, error, loading, reload };
}

export function enterpriseState(item: EnterpriseListItem): string {
  return item.pool?.state ?? 'direct';
}

function optionLabel(item: EnterpriseListItem): string {
  return `${item.displayName} · ${githubHost(item.githubBaseUrl)} · ${enterpriseState(item)}`;
}

/** Header selector. The value lives in the URL hash; the parent writes it on change. */
export function EnterpriseSelector(props: {
  items?: readonly EnterpriseListItem[];
  value: string;
  onChange: (enterpriseId: string) => void;
}) {
  const items = props.items ?? [];
  const known = items.some((item) => item.id === props.value);
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-slate-600">
      <span className="shrink-0 font-medium">Enterprise</span>
      <Select aria-label="Enterprise" className="min-w-0 max-w-full lg:max-w-sm" value={props.value}
        onChange={(event) => props.onChange(event.target.value)}>
        {known ? null : <option value={props.value}>{props.value} · not in the enterprise list</option>}
        {items.map((item) => <option key={item.id} value={item.id}>{optionLabel(item)}</option>)}
      </Select>
    </label>
  );
}
