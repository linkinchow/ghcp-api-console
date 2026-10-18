import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Locator, Page } from 'playwright';
import type { SsoProvider } from '@ghcp/shared';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
const { config } = await import('../config.js');
const { HeadlessPlaywrightAuthStrategy } = await import('./HeadlessPlaywrightAuthStrategy.js');
const { resolveGithubDeployment } = await import('./githubUrls.js');
const { AccountLogger } = await import('../tasks/accountLogger.js');

const LOGIN = 'http://sso.test:7001/enterprises/contoso-eu/login';
const PASSWORD = 'fixture-password-do-not-log';

interface Candidate {
  description: string;
  create(page: Page): Locator;
}

/** The private steps under test; the browser itself is never launched here. */
interface StrategyInternals {
  fillSsoField(page: Page, candidates: Candidate[], value: string, label: string): Promise<void>;
  isSsoUrl(url: string): boolean;
}

function strategyFor(provider: SsoProvider, directory: string) {
  const logger = AccountLogger.create(directory, 'same-user', true, `credential-${provider}`, undefined, [PASSWORD]);
  const strategy = new HeadlessPlaywrightAuthStrategy(
    {
      ...config.auth,
      github: resolveGithubDeployment('https://contoso.ghe.com', 'contoso'),
      ssoProvider: provider,
      ssoLoginUrl: LOGIN,
      allowedLoginUrls: [LOGIN],
      selectors: {},
      timeoutMs: 1_000,
      debugLogs: true,
      debugArtifacts: false,
    },
    { githubUsername: 'same-user', ssoUsername: 'same-user', ssoPassword: PASSWORD },
    logger,
  );
  return { internals: strategy as unknown as StrategyInternals, logger };
}

/** A page whose URL moves to `navigatesTo` while the input is awaited, as a redirect would. */
function fakePage(start: string, navigatesTo: string): { page: Page; candidate: Candidate; fills: () => number } {
  let current = start;
  let fills = 0;
  const locator = {
    waitFor: async () => { current = navigatesTo; },
    fill: async () => { fills++; },
  } as unknown as Locator;
  const page = { url: () => current } as unknown as Page;
  return { page, candidate: { description: 'password', create: () => locator }, fills: () => fills };
}

test('credentials are typed only while the page is still an allowed login page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'login-credential-'));
  try {
    const { internals, logger } = strategyFor('custom', directory);
    assert.equal(internals.isSsoUrl(`${LOGIN}?RelayState=x`), true);
    assert.equal(internals.isSsoUrl(`${LOGIN}foo`), false);
    const stays = fakePage(LOGIN, `${LOGIN}?step=2`);
    await internals.fillSsoField(stays.page, [stays.candidate], PASSWORD, 'SSO password');
    assert.equal(stays.fills(), 1);
    for (const target of [`${LOGIN}foo`, 'http://sso.test:7001/enterprises/other/login', 'https://evil.test/login']) {
      const moved = fakePage(LOGIN, target);
      await assert.rejects(internals.fillSsoField(moved.page, [moved.candidate], PASSWORD, 'SSO password'),
        { code: 'untrusted_sso_credential_url' }, target);
      assert.equal(moved.fills(), 0, target);
    }
    assert.equal(readFileSync(logger.path, 'utf8').includes(PASSWORD), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Azure keeps the baseline Microsoft sign-in hosts, but no other host', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'login-credential-'));
  try {
    const { internals } = strategyFor('azure', directory);
    const microsoft = fakePage(LOGIN, 'https://login.microsoftonline.com/tenant/oauth2/authorize');
    await internals.fillSsoField(microsoft.page, [microsoft.candidate], PASSWORD, 'Azure password');
    assert.equal(microsoft.fills(), 1);
    const other = fakePage(LOGIN, 'https://login.microsoftonline.com.evil.test/tenant');
    await assert.rejects(internals.fillSsoField(other.page, [other.candidate], PASSWORD, 'Azure password'),
      { code: 'untrusted_sso_credential_url' });
    assert.equal(other.fills(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
