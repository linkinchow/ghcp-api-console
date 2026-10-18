import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { deepFreeze } from '../deepFreeze.js';
import {
  defaultFromEnv,
  fallbackFields,
  registryOptionsFromEnv,
  type EnvDefault,
  type ServiceEnv,
} from './defaultFromEnv.js';
import { canonicalJson } from './fingerprint.js';
import {
  readRegistryEntries,
  resolveRegistry,
  type ProfileEntry,
  type Registry,
  type RegistryService,
} from './registry.js';
import { EnterpriseRegistryError, type ProfileFields } from './registryFields.js';
import { DEFAULT_ENTERPRISE_ID } from './scope.js';

export const REGISTRY_FILE_VARIABLE = 'ENTERPRISE_REGISTRY_FILE';

export interface LoadRegistryOptions {
  service: RegistryService;
  env: ServiceEnv;
  readFile?: (path: string) => string;
}

/**
 * Loads the registry once at startup (design §3.5, §3.7). Without ENTERPRISE_REGISTRY_FILE, or when the file
 * has no `default` entry, `default` comes from the service's environment; otherwise the entry and the
 * environment are merged and must agree. The result is deep-frozen; there is no hot reload.
 */
export function loadRegistry(options: LoadRegistryOptions): Registry {
  const { service, env } = options;
  const fileEntries = readRegistryFile(env, options.readFile ?? readUtf8);
  const fileDefault = fileEntries.find((entry) => entry.id === DEFAULT_ENTERPRISE_ID);
  const registryBaseUrl = fileDefault?.fields.get('github.baseUrl');
  const envDefault = defaultFromEnv(service, env, {
    registryBaseUrl: typeof registryBaseUrl === 'string' ? registryBaseUrl : undefined,
  });
  const merged = mergeEnvFields(fileDefault?.fields ?? new Map(), envDefault);
  const defaultEntry: ProfileEntry = {
    id: DEFAULT_ENTERPRISE_ID,
    fields: new Map([...fallbackFields(service, env, merged), ...merged]),
  };
  const entries = fileDefault
    ? fileEntries.map((entry) => (entry === fileDefault ? defaultEntry : entry))
    : [defaultEntry, ...fileEntries];
  const registry = resolveRegistry(entries, registryOptionsFromEnv(service, env));
  return deepFreeze({ ...registry, warnings: envDefault.warnings });
}

function readRegistryFile(env: ServiceEnv, readFile: (path: string) => string): ProfileEntry[] {
  const path = env[REGISTRY_FILE_VARIABLE]?.trim();
  if (!path) return [];
  if (!isAbsolute(path)) throw invalidFile('must be an absolute path');
  let json: unknown;
  try {
    json = JSON.parse(readFile(path));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidFile('must contain valid JSON');
    throw error;
  }
  return readRegistryEntries(json);
}

/** Environment values fill the registry's `default` entry; a differing value on both sides is a startup error. */
function mergeEnvFields(registryFields: ProfileFields, envDefault: EnvDefault): ProfileFields {
  const merged: ProfileFields = new Map(registryFields);
  for (const [path, value] of envDefault.fields) {
    const registryValue = merged.get(path);
    if (registryValue !== undefined && canonicalJson(registryValue) !== canonicalJson(value)) {
      const variable = envDefault.sources.get(path) ?? 'an environment variable';
      throw new EnterpriseRegistryError(
        'enterprise_env_conflict',
        `default.${path}`,
        `${variable} conflicts with default.${path} in ${REGISTRY_FILE_VARIABLE}; unset one or make them equal.`,
      );
    }
    merged.set(path, value);
  }
  return merged;
}

function invalidFile(reason: string): EnterpriseRegistryError {
  return new EnterpriseRegistryError(
    'enterprise_registry_invalid',
    REGISTRY_FILE_VARIABLE,
    `${REGISTRY_FILE_VARIABLE} ${reason}.`,
  );
}

function readUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}
