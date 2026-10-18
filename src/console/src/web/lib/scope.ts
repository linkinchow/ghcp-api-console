import { createContext, useContext, useEffect, useRef } from 'react';

/** The enterprise a scoped page works on. `slug` is `null` when unknown (list unavailable or unset). */
export interface EnterpriseScope {
  id: string;
  slug: string | null;
  displayName: string;
}

export const EnterpriseScopeContext = createContext<EnterpriseScope | undefined>(undefined);

/** The enterprise of the surrounding scoped page; throws outside one instead of guessing `default`. */
export function useEnterpriseScope(): EnterpriseScope {
  const scope = useContext(EnterpriseScopeContext);
  if (!scope) throw new Error('This view requires a selected enterprise.');
  return scope;
}

/** `undefined` on global pages. */
export function useOptionalEnterpriseScope(): EnterpriseScope | undefined {
  return useContext(EnterpriseScopeContext);
}

/** Shown in destructive confirmations so the operator sees which enterprise is affected. */
export function scopeText(scope: EnterpriseScope): string {
  return `Enterprise ${scope.id} (slug ${scope.slug ?? 'unknown'}).`;
}

/**
 * Each mounted, keyed page owns its reads and pending mutation callbacks. Switching enterprise remounts the
 * page, which aborts the read in flight; `active()` and `current(signal)` drop results that arrive later.
 */
export function useScopeLifetime() {
  const alive = useRef(true);
  const read = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  return {
    active: () => alive.current,
    beginRead: () => {
      read.current?.abort();
      const controller = new AbortController();
      read.current = controller;
      return controller.signal;
    },
    current: (signal: AbortSignal) => alive.current && !signal.aborted && read.current?.signal === signal,
  };
}

export type ScopeLifetime = ReturnType<typeof useScopeLifetime>;
