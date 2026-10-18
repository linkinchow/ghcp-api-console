import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_GITHUB_BASE_URL, parseRegistry } from '@ghcp/shared';
import { findProxyEnterprise, setProxyEnterprisesForTesting, type ProxyEnterprise } from '../enterprises.js';
import { ModelsAdminError, resolveModelsAdmin, type ModelsAdminErrorCode } from './modelsAdmin.js';

const TOKEN_VARIABLE = 'MODELS_ADMIN_FIXTURE_TOKEN';

function enterprise(modelsAdmin?: Record<string, unknown>): ProxyEnterprise {
  const github = { baseUrl: DEFAULT_GITHUB_BASE_URL, shortcode: 'octo' };
  const profile = { id: 'default', github, ...(modelsAdmin ? { modelsAdmin } : {}) };
  setProxyEnterprisesForTesting(parseRegistry({ version: 1, enterprises: [profile] }, { service: 'proxy' }));
  return findProxyEnterprise('default')!;
}

function failsWith(code: ModelsAdminErrorCode, resolve: () => unknown): void {
  assert.throws(resolve, (error: unknown) => {
    return error instanceof ModelsAdminError && error.code === code && error.message === code;
  });
}

test.afterEach(() => {
  delete process.env[TOKEN_VARIABLE];
  setProxyEnterprisesForTesting(undefined);
});

test('nothing configured is "not configured", not an error about a specific setting', () => {
  failsWith('models_admin_not_configured', () => resolveModelsAdmin(enterprise()));
  failsWith('models_admin_not_configured', () => resolveModelsAdmin(enterprise({ githubUserId: '1' })));
});

test('the token comes from the enterprise secret reference', () => {
  process.env[TOKEN_VARIABLE] = 'synthetic-env-token';
  const copilotToken = { env: TOKEN_VARIABLE };
  const withId = enterprise({ githubLogin: 'admin_synthetic', githubUserId: '123', copilotToken });
  assert.deepEqual(resolveModelsAdmin(withId), {
    githubLogin: 'admin_synthetic', githubUserId: '123', accessToken: 'synthetic-env-token',
  });
  assert.deepEqual(resolveModelsAdmin(enterprise({ githubLogin: 'admin_synthetic', copilotToken })), {
    githubLogin: 'admin_synthetic', accessToken: 'synthetic-env-token',
  });
});

test('a mounted token file is re-read on every call so rotation needs no restart', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'models-admin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'token');
  const admin = enterprise({ githubLogin: 'admin_synthetic', copilotToken: { file } });

  writeFileSync(file, 'synthetic-mounted-token\n');
  assert.equal(resolveModelsAdmin(admin).accessToken, 'synthetic-mounted-token');
  writeFileSync(file, 'synthetic-rotated-token');
  assert.equal(resolveModelsAdmin(admin).accessToken, 'synthetic-rotated-token');

  for (const content of ['', '\n', 'white space', 'two\nlines', 'a'.repeat(128 * 1024 + 1)]) {
    writeFileSync(file, content);
    failsWith('models_admin_credential_missing', () => resolveModelsAdmin(admin));
  }
  const missing = enterprise({ githubLogin: 'admin_synthetic', copilotToken: { file: join(dir, 'missing') } });
  failsWith('models_admin_credential_missing', () => resolveModelsAdmin(missing));
});

test('a token without a valid admin identity is a configuration error', () => {
  process.env[TOKEN_VARIABLE] = 'synthetic-env-token';
  const copilotToken = { env: TOKEN_VARIABLE };
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin(enterprise({ copilotToken })));
  const badId = enterprise({ githubLogin: 'admin', githubUserId: '0', copilotToken });
  failsWith('models_admin_configuration_invalid', () => resolveModelsAdmin(badId));
  delete process.env[TOKEN_VARIABLE];
  const unset = enterprise({ githubLogin: 'admin', copilotToken });
  failsWith('models_admin_credential_missing', () => resolveModelsAdmin(unset));
});
