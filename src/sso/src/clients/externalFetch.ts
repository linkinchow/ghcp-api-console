import { ExternalOperationUncertainError } from '../users/operationFence.js';

/** No redirects with credentials. A failed mutation transport is never blindly retried. */
export async function externalFetch(url: string | URL, init: RequestInit): Promise<Response> {
  const mutation = init.method !== undefined && !['GET', 'HEAD'].includes(init.method.toUpperCase());
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (mutation && response.status >= 500) {
      await response.body?.cancel();
      throw new ExternalOperationUncertainError();
    }
    return response;
  } catch (error) {
    if (mutation) throw new ExternalOperationUncertainError();
    throw new Error('External read request failed.');
  }
}

export async function mutationJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new ExternalOperationUncertainError(); }
}
