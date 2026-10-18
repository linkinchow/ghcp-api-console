import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBoolean } from './config.js';

test('boolean settings accept the documented spellings and reject anything else', () => {
  assert.equal(readBoolean(undefined, true), true);
  assert.equal(readBoolean(undefined, false), false);
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) assert.equal(readBoolean(value, false), true, value);
  for (const value of ['false', 'FALSE', '0', 'no', 'off']) assert.equal(readBoolean(value, true), false, value);
  for (const value of ['', 'invalid']) assert.throws(() => readBoolean(value, true), /Invalid boolean/, value);
});

// One child process proves config.ts wires MYSQL_AUTO_MIGRATE to readBoolean with the default `true`.
// Each case used to start its own child; a dozen cold tsx starts made the suite flaky under load.
test('MYSQL_AUTO_MIGRATE defaults to true and is read from the environment', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(readAutoMigrateInChild(directory, undefined), 'true');
  assert.equal(readAutoMigrateInChild(directory, 'off'), 'false');
});

function readAutoMigrateInChild(directory: string, value: string | undefined): string {
  const configUrl = new URL('./config.js', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    '--input-type=module',
    '--eval', `const { config } = await import(${JSON.stringify(configUrl)}); console.log(config.mysqlAutoMigrate);`,
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: join(directory, 'missing.env'),
      STORAGE_DRIVER: 'mysql',
      MYSQL_URL: 'mysql://test:test@127.0.0.1/proxy_test',
      ...(value === undefined ? {} : { MYSQL_AUTO_MIGRATE: value }),
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
