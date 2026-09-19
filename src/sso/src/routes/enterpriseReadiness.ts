import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { Router } from 'express';
import {
  apiError, EnterpriseContractError, ENTERPRISE_V3_CAPABILITY, resolveEnterpriseScope,
  type EnterpriseProfileV3, type EnterpriseReadinessV1, type EnterpriseRegistryV3,
} from '@ghcp/shared';
import { enterpriseRegistryHashV3, readEnterpriseSecret } from '@ghcp/shared/enterpriseRuntimeV3';
import { enterpriseProfileIdentityHashV4 } from '@ghcp/shared/enterpriseRuntimeV4';
import { getDb, getValidatedEnterpriseRegistry } from '../db/connection.js';
import { countUsers } from '../db/usersRepo.js';
import { readMaxSsoUsers } from '../db/runtimeSettingsRepo.js';

export function ssoReadiness(registry: EnterpriseRegistryV3, enterpriseId: string,
  readSecret = readEnterpriseSecret): EnterpriseReadinessV1 {
  const { profile } = resolveEnterpriseScope(registry, enterpriseId);
  const blockers: string[] = [];
  if (profile.login.provider !== 'custom') blockers.push('pool_provider_unsupported');
  try {
    const certificate = new X509Certificate(readSecret(profile.sso.signingCertRef));
    const key = createPrivateKey(readSecret(profile.sso.signingKeyRef));
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      || !certificate.publicKey.export({ type: 'spki', format: 'der' })
        .equals(createPublicKey(key).export({ type: 'spki', format: 'der' }))) throw new Error();
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw new Error();
  } catch { blockers.push('saml_signing_material_unavailable'); }
  const required: Array<[keyof EnterpriseProfileV3['sso'], string, number]> = [
    ['sessionSecretRef', 'saml_session_secret_unavailable', 32],
    ['scimTokenRef', 'scim_secret_unavailable', 1],
    ['seatPatRef', 'seat_secret_unavailable', 1],
    ['defaultPasswordRef', 'pool_password_unavailable', 16],
  ];
  for (const [name, code, minimum] of required) {
    try {
      const reference = profile.sso[name];
      if (!reference || typeof reference === 'string' || readSecret(reference).trim().length < minimum) throw new Error();
    } catch { blockers.push(code); }
  }
  return {
    probeVersion: 1, component: 'sso', schemaVersion: 3, contractVersion: 2, capability: ENTERPRISE_V3_CAPABILITY,
    enterpriseId: profile.id, enterpriseRevision: profile.revision, profileIdentitySha256: enterpriseProfileIdentityHashV4(profile),
    registryRevision: registry.registryRevision, registrySha256: enterpriseRegistryHashV3(registry),
    legacyEnterpriseId: registry.legacyEnterpriseId, ready: blockers.length === 0, blockers,
  };
}

export function createEnterpriseReadinessRouter(getRegistry = getValidatedEnterpriseRegistry): Router {
  const router = Router();
  router.get('/profiles/:enterpriseId/readiness', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const registry = getRegistry();
      const scope = resolveEnterpriseScope(registry, req.params.enterpriseId);
      if (Object.keys(req.query).length || req.headers['x-enterprise-id'] !== undefined
        && req.headers['x-enterprise-id'] !== scope.enterpriseId || req.headers['x-enterprise-revision'] !== undefined
        && req.headers['x-enterprise-revision'] !== String(scope.enterpriseRevision)) {
        res.status(400).json(apiError('enterprise_scope_mismatch', 'Enterprise readiness scope does not match.'));
        return;
      }
      res.json(ssoReadiness(registry, scope.enterpriseId));
    } catch (error) {
      const missing = error instanceof EnterpriseContractError && error.code === 'enterprise_not_found';
      res.status(missing ? 404 : 503).json(apiError(missing ? 'enterprise_not_found' : 'enterprise_readiness_unavailable',
        'Enterprise readiness is unavailable.'));
    }
  });
  // Live creation eligibility is intentionally separate from persisted readiness:
  // a full enterprise must still repair/login its existing pool members.
  router.get('/profiles/:enterpriseId/creation-capacity', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const scope = resolveEnterpriseScope(getRegistry(), req.params.enterpriseId);
      if (Object.keys(req.query).length || req.headers['x-enterprise-id'] !== scope.enterpriseId
        || req.headers['x-enterprise-revision'] !== String(scope.enterpriseRevision)) {
        res.status(400).json(apiError('enterprise_scope_mismatch', 'Enterprise capacity scope does not match.'));
        return;
      }
      // getRegistry above refuses an unopened/changed connection; this read-only
      // transaction observes the same current limit used by atomic user creation.
      const db = getDb();
      const capacity = db.transaction(() => {
        const currentUsers = countUsers(scope), maxUsers = readMaxSsoUsers(db, scope);
        if (!Number.isSafeInteger(currentUsers) || currentUsers < 0
          || maxUsers !== null && (!Number.isSafeInteger(maxUsers) || maxUsers < 1)) throw new Error();
        return { enterpriseId: scope.enterpriseId, enterpriseRevision: scope.enterpriseRevision,
          currentUsers, maxUsers, availableSlots: maxUsers === null ? null : Math.max(0, maxUsers - currentUsers),
          canCreate: maxUsers === null || currentUsers < maxUsers };
      })();
      res.json(capacity);
    } catch (error) {
      const missing = error instanceof EnterpriseContractError && error.code === 'enterprise_not_found';
      res.status(missing ? 404 : 503).json(apiError(missing ? 'enterprise_not_found' : 'enterprise_capacity_unavailable',
        'Enterprise creation capacity is unavailable.'));
    }
  });
  return router;
}
