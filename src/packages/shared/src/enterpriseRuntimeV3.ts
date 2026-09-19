import { statSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { EnterpriseContractError } from './enterprise.js';
import { canonicalEnterpriseIdentityRegistryV3, parseEnterpriseRegistryV3, type EnterpriseRegistryV3, type SecretReference } from './enterpriseV3.js';

export function readEnterpriseRegistryFile(path = process.env.ENTERPRISE_REGISTRY_FILE): EnterpriseRegistryV3 {
  if (!path || !isAbsolute(path)) throw new EnterpriseContractError('enterprise_registry_file_required');
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error();
    return deepFreeze(parseEnterpriseRegistryV3(JSON.parse(readFileSync(path, 'utf8'))));
  } catch (error) {
    if (error instanceof EnterpriseContractError) throw error;
    throw new EnterpriseContractError('enterprise_registry_file_invalid');
  }
}

export function readEnterpriseSecret(reference: SecretReference | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!reference) throw new EnterpriseContractError('enterprise_secret_unconfigured');
  try {
    let value: string | undefined;
    if ('env' in reference) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reference.env)) throw new Error();
      value = env[reference.env];
    } else {
      if (!isAbsolute(reference.file)) throw new Error();
      // Mounted secret files may be symlinks; their paths are trusted deployment configuration.
      value = readFileSync(reference.file, 'utf8');
    }
    if (!value || Buffer.byteLength(value) > 128 * 1024 || value.includes('\0')) throw new Error();
    return value;
  } catch { throw new EnterpriseContractError('enterprise_secret_unavailable'); }
}

export function enterpriseRegistryHashV3(registry: EnterpriseRegistryV3): string {
  return createHash('sha256').update(canonicalEnterpriseIdentityRegistryV3(registry)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
