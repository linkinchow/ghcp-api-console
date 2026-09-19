import {
  INTERNAL_AUTH_HEADER, parseEnterpriseReadinessV1, parseEnterpriseValidationEvidenceV1, resolveEnterpriseScope,
  type EnterpriseProfileV3, type EnterpriseReadinessV1, type EnterpriseRegistryV3, type EnterpriseValidationEvidenceV1,
} from '@ghcp/shared';
import { enterpriseRegistryHashV3 } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { UserPoolError } from '../userPool/config.js';

export class EnterpriseReadinessError extends UserPoolError {
  constructor(code: string, readonly blockers: string[] = []) { super(503, code); }
}

export async function probeEnterpriseReadiness(registry: EnterpriseRegistryV3, enterpriseId: string, internalToken: string,
  dependencies: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<EnterpriseValidationEvidenceV1> {
  const scope = resolveEnterpriseScope(registry, enterpriseId);
  if (!internalToken) throw new EnterpriseReadinessError('enterprise_readiness_auth_required');
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(dependencies.timeoutMs ?? 5000)])
    : AbortSignal.timeout(dependencies.timeoutMs ?? 5000);
  const registrySha256 = enterpriseRegistryHashV3(registry);
  const profileIdentitySha256 = enterpriseProfileIdentityHashV4(scope.profile);
  const expected = { enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision,
    registryRevision: registry.registryRevision, registrySha256, profileIdentitySha256, legacyEnterpriseId: registry.legacyEnterpriseId };
  const fetcher = dependencies.fetch ?? fetch;
  const probes = await Promise.all((['sso', 'login'] as const).map(async component => {
    const base = component === 'sso' ? scope.profile.routes.ssoInternalUrl : scope.profile.routes.loginInternalUrl;
    let probe: EnterpriseReadinessV1;
    try {
      const response = await abortable(fetcher(`${base}/internal/profiles/${encodeURIComponent(scope.enterpriseId)}/readiness`, {
        method: 'GET', redirect: 'error', signal, headers: {
          Accept: 'application/json', [INTERNAL_AUTH_HEADER]: internalToken,
          'x-enterprise-id': scope.enterpriseId, 'x-enterprise-revision': String(scope.enterpriseRevision),
        },
      }), signal);
      if (!response.ok || response.redirected) {
        void response.body?.cancel().catch(() => {});
        throw new Error();
      }
      probe = parseEnterpriseReadinessV1(await readResponse(response, signal));
    } catch { throw new EnterpriseReadinessError('enterprise_readiness_unavailable', [`${component}_readiness_unavailable`]); }
    if (probe.component !== component || probe.schemaVersion !== 3 || probe.capability !== 'enterprise-isolation-legacy-pool'
      || (Object.keys(expected) as Array<keyof typeof expected>).some(key => probe[key] !== expected[key])) {
      throw new EnterpriseReadinessError('enterprise_readiness_mismatch', [`${component}_configuration_mismatch`]);
    }
    if (!probe.ready) throw new EnterpriseReadinessError('enterprise_readiness_blocked', probe.blockers);
    return probe;
  }));
  signal.throwIfAborted();
  return parseEnterpriseValidationEvidenceV1({ version: 1, ...expected, checkedAt: Date.now(), sso: probes[0], login: probes[1] });
}

/** Volatile admission information only: never cache or persist this as readiness evidence. */
export async function probeEnterpriseCreationCapacity(profile: EnterpriseProfileV3, internalToken: string,
  dependencies: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<boolean> {
  if (!internalToken) throw new EnterpriseReadinessError('enterprise_readiness_auth_required');
  const signal = AbortSignal.any([...(dependencies.signal ? [dependencies.signal] : []),
    AbortSignal.timeout(dependencies.timeoutMs ?? 5000)]);
  try {
    const response = await abortable((dependencies.fetch ?? fetch)(
      `${profile.routes.ssoInternalUrl.replace(/\/+$/, '')}/internal/profiles/${encodeURIComponent(profile.id)}/creation-capacity`, {
        method: 'GET', redirect: 'error', signal, headers: {
          Accept: 'application/json', [INTERNAL_AUTH_HEADER]: internalToken,
          'x-enterprise-id': profile.id, 'x-enterprise-revision': String(profile.revision),
        },
      }), signal);
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new Error();
    }
    const value = await readResponse(response, signal);
    signal.throwIfAborted();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const data = value as Record<string, unknown>;
    const keys = ['enterpriseId', 'enterpriseRevision', 'currentUsers', 'maxUsers', 'availableSlots', 'canCreate'];
    if (Object.keys(data).length !== keys.length || Object.keys(data).some(key => !keys.includes(key))
      || data.enterpriseId !== profile.id || data.enterpriseRevision !== profile.revision
      || !Number.isSafeInteger(data.currentUsers) || (data.currentUsers as number) < 0) throw new Error();
    if (data.maxUsers === null) {
      if (data.availableSlots !== null || data.canCreate !== true) throw new Error();
      return true;
    }
    if (!Number.isSafeInteger(data.maxUsers) || (data.maxUsers as number) < 1
      || data.availableSlots !== Math.max(0, (data.maxUsers as number) - (data.currentUsers as number))
      || data.canCreate !== ((data.currentUsers as number) < (data.maxUsers as number))) throw new Error();
    return data.canCreate as boolean;
  } catch { throw new EnterpriseReadinessError('enterprise_creation_capacity_unavailable'); }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > 32768) {
    void response.body?.cancel().catch(() => {});
    throw new Error('readiness_response_size');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('readiness_response_missing');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.length;
      if (length > 32768) throw new Error('readiness_response_size');
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
