import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { clearSecretCache, readSecret, SECRET_MAX_BYTES, SecretError, type SecretErrorCode } from './secrets.js';

const FIELD = 'contoso-eu.sso.scimToken';
const FILE = resolve('/run/secrets/contoso/scim-token');

function fails(read: () => string, code: SecretErrorCode, hidden: string[] = []): void {
  assert.throws(read, (error: unknown) => {
    if (!(error instanceof SecretError)) return false;
    assert.equal(error.code, code);
    assert.equal(error.field, FIELD);
    assert.ok(error.message.startsWith(`${FIELD} `));
    for (const value of hidden) assert.ok(!error.message.includes(value));
    return true;
  });
}

test('env references are read on every call', () => {
  const env: Record<string, string | undefined> = { SCIM_TOKEN: 'first' };
  assert.equal(readSecret({ env: 'SCIM_TOKEN' }, { field: FIELD, env }), 'first');
  env.SCIM_TOKEN = 'second\n';
  assert.equal(readSecret({ env: 'SCIM_TOKEN' }, { field: FIELD, env }), 'second');
  fails(() => readSecret({ env: 'MISSING' }, { field: FIELD, env }), 'enterprise_secret_unconfigured');
  fails(() => readSecret({ env: 'SCIM_TOKEN' }, { field: FIELD, env: { SCIM_TOKEN: '' } }),
    'enterprise_secret_unconfigured');
});

test('file references are cached for 60 seconds', () => {
  clearSecretCache();
  let now = 1_000;
  let reads = 0;
  let content = 'first';
  const readFile = () => {
    reads += 1;
    return content;
  };
  const options = { field: FIELD, env: {}, now: () => now, readFile };
  assert.equal(readSecret({ file: FILE }, options), 'first');
  content = 'rotated';
  now += 59_999;
  assert.equal(readSecret({ file: FILE }, options), 'first');
  now += 1;
  assert.equal(readSecret({ file: FILE }, options), 'rotated');
  assert.equal(reads, 2);
  assert.equal(readSecret({ file: FILE }, { ...options, maxAgeMs: 0 }), 'rotated');
  assert.equal(reads, 3);
  clearSecretCache();
});

test('exactly one trailing newline is removed', () => {
  const read = (content: string) => readSecret({ env: 'S' }, { field: FIELD, env: { S: content } });
  assert.equal(read('value\n'), 'value');
  assert.equal(read('value\r\n'), 'value');
  assert.equal(read('value\n\n'), 'value\n');
  assert.equal(read('  value  '), '  value  ');
  fails(() => read('\n'), 'enterprise_secret_unconfigured');
});

test('content limits: at most 128 KiB and no NUL; errors carry only the field path', () => {
  clearSecretCache();
  const fromFile = (content: Buffer | string) => readSecret({ file: FILE }, {
    field: FIELD, env: {}, maxAgeMs: 0, readFile: () => content,
  });
  assert.equal(fromFile(Buffer.alloc(SECRET_MAX_BYTES, 'a')).length, SECRET_MAX_BYTES);
  fails(() => fromFile(Buffer.alloc(SECRET_MAX_BYTES + 1, 'a')), 'enterprise_secret_invalid');
  fails(() => fromFile('top\0secret'), 'enterprise_secret_invalid', ['top', 'secret', FILE]);
  const env = { S: 'nul\0value' };
  fails(() => readSecret({ env: 'S' }, { field: FIELD, env }), 'enterprise_secret_invalid', ['nul']);
});

test('file references must be absolute; unreadable files are reported without their path', () => {
  clearSecretCache();
  const options = { field: FIELD, env: {} };
  fails(() => readSecret({ file: 'relative/token' }, options), 'enterprise_secret_invalid', ['relative']);
  const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
  const throwing = (error: Error) => () => { throw error; };
  fails(() => readSecret({ file: FILE }, { ...options, readFile: throwing(missing) }),
    'enterprise_secret_unconfigured', [FILE]);
  fails(() => readSecret({ file: FILE }, { ...options, readFile: throwing(denied) }),
    'enterprise_secret_invalid', [FILE]);
});

test('the default reader reads real files and stops past the size limit', () => {
  clearSecretCache();
  const dir = mkdtempSync(join(tmpdir(), 'ghcp-secrets-'));
  try {
    const small = join(dir, 'small');
    const large = join(dir, 'large');
    writeFileSync(small, 'from-disk\n');
    writeFileSync(large, Buffer.alloc(SECRET_MAX_BYTES * 2, 'a'));
    assert.equal(readSecret({ file: small }, { field: FIELD, env: {} }), 'from-disk');
    fails(() => readSecret({ file: large }, { field: FIELD, env: {} }), 'enterprise_secret_invalid');
    fails(() => readSecret({ file: join(dir, 'absent') }, { field: FIELD, env: {} }), 'enterprise_secret_unconfigured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    clearSecretCache();
  }
});
