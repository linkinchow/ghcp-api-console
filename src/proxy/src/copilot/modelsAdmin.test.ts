import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ModelsAdminError, resolveModelsAdmin, type ModelsAdminErrorCode } from './modelsAdmin.js';

function failsWith(code: ModelsAdminErrorCode, resolve: () => unknown): void {
  assert.throws(resolve, (error: unknown) => error instanceof ModelsAdminError && error.code === code && error.message === code);
}

test('nothing configured is "not configured", not an error about a specific setting', () => {
  failsWith('models_admin_not_configured', () => resolveModelsAdmin({}, {}));
  failsWith('models_admin_not_configured', () => resolveModelsAdmin({}, { MODELS_ADMIN_COPILOT_TOKEN: '' }));
});

test('the token comes from the environment variable when no file is configured', () => {
  const env = { MODELS_ADMIN_COPILOT_TOKEN: 'synthetic-env-token' };
  assert.deepEqual(resolveModelsAdmin({ githubLogin: 'admin_synthetic', githubUserId: '123' }, env), {
    githubLogin: 'admin_synthetic', githubUserId: '123', accessToken: 'synthetic-env-token',
  });
  assert.deepEqual(resolveModelsAdmin({ githubLogin: 'admin_synthetic' }, env), {
    githubLogin: 'admin_synthetic', accessToken: 'synthetic-env-token',
  });
});

test('a mounted token file is re-read on every call so rotation needs no restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'models-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'token');
  const settings = { githubLogin: 'admin_synthetic', tokenFile };

  writeFileSync(tokenFile, 'synthetic-mounted-token\n');
  assert.equal(resolveModelsAdmin(settings, {}).accessToken, 'synthetic-mounted-token');
  writeFileSync(tokenFile, 'synthetic-rotated-token');
  assert.equal(resolveModelsAdmin(settings, {}).accessToken, 'synthetic-rotated-token');

  for (const content of ['', '\n', 'white space', 'two\nlines', 'a'.repeat(128 * 1024 + 1)]) {
    writeFileSync(tokenFile, content);
    failsWith('models_admin_credential_missing', () => resolveModelsAdmin(settings, {}));
  }
  failsWith('models_admin_credential_missing', () => resolveModelsAdmin({ ...settings, tokenFile: join(dir, 'missing') }, {}));
});

test('invalid identity settings or ambiguous token sources are configuration errors', () => {
  const env = { MODELS_ADMIN_COPILOT_TOKEN: 'synthetic-env-token' };
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin({ githubUserId: '1' }, env));
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin({ githubLogin: 'admin\nunsafe' }, env));
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin({ githubLogin: 'admin', githubUserId: '0' }, env));
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin({ githubLogin: 'admin', tokenFile: 'relative-token' }, {}));
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin({ githubLogin: 'admin', tokenFile: '/run/secret/token' }, env));
  failsWith('models_admin_credential_missing', () => resolveModelsAdmin({ githubLogin: 'admin' }, { MODELS_ADMIN_COPILOT_TOKEN: '' }));
});
