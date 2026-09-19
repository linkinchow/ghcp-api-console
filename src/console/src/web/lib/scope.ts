import { useEffect, useRef } from 'react';

/** Each mounted, keyed page owns its reads and pending mutation callbacks. */
export function useScopeLifetime() {
  const alive = useRef(true);
  const read = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; read.current?.abort(); };
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
