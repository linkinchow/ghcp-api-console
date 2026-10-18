import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { config } from './config.js';
import { loginRuntimeSettings } from './db/runtimeSettingsRepo.js';
import { HeadlessPlaywrightAuthStrategy } from './auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from './auth/deviceFlow.js';
import { enterpriseAuthConfig, enterpriseDeviceFlowClient } from './auth/enterpriseAuth.js';
import {
  findLoginEnterprise,
  readyLoginEnterprise,
  resolveSsoType,
  type ReadyLoginEnterprise,
} from './enterprises.js';
import { AccountLogger } from './tasks/accountLogger.js';

/** The SSO provider, login page, allowlist and selectors always come from the enterprise registry. */
interface DebugLoginOptions {
  enterpriseId: string;
  ghLogin: string;
  ssoUser: string;
  ssoPassword: string;
  /** Only when the profile leaves `login.ssoProvider` open; otherwise it must match the profile. */
  ssoType?: string;
  debugLogs?: boolean;
  debugArtifacts?: boolean;
  headless?: boolean;
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  const runtimeSettings = loginRuntimeSettings.getSnapshot();
  const debugLogs = options.debugLogs ?? runtimeSettings.authDebugLogs;
  const enterprise = debugEnterprise(options.enterpriseId);
  const logger = AccountLogger.create(config.logDir, options.ssoUser, debugLogs);
  const ssoType = resolveSsoType(enterprise, options.ssoType);
  const authConfig = enterpriseAuthConfig(enterprise, ssoType, {
    timeoutMs: runtimeSettings.authTimeoutMs,
    debugLogs,
    debugArtifacts: options.debugArtifacts ?? runtimeSettings.authDebugArtifacts,
    headless: options.headless,
  });
  const account = `ghLogin=${options.ghLogin}, ssoUser=${options.ssoUser}, ssoType=${ssoType}`;
  console.error(`[login-token] starting login for enterprise=${enterprise.id}, ${account}`);
  console.error(`[login-token] account log: ${logger.path}`);

  const token = await loginWithDeviceFlow(
    new HeadlessPlaywrightAuthStrategy(
      authConfig,
      {
        githubUsername: options.ghLogin,
        ssoUsername: options.ssoUser,
        ssoPassword: options.ssoPassword,
      },
      logger,
    ),
    logger,
    enterpriseDeviceFlowClient(enterprise),
  );

  console.error('[login-token] login succeeded; raw Copilot OAuth token follows on stdout');
  console.log(token);
}

function debugEnterprise(id: string): ReadyLoginEnterprise {
  const enterprise = findLoginEnterprise(id);
  if (!enterprise) throw new Error(`Enterprise "${id}" is not in the enterprise registry.`);
  return readyLoginEnterprise(enterprise);
}

function readOptions(args: string[]): DebugLoginOptions {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }

  const values = parseArgs(args);
  const options: DebugLoginOptions = {
    enterpriseId: values.enterpriseId ?? env('LOGIN_ENTERPRISE_ID') ?? DEFAULT_ENTERPRISE_ID,
    ghLogin: readRequired(values.ghLogin ?? env('LOGIN_GH_LOGIN'), 'ghLogin', '--gh-login or LOGIN_GH_LOGIN'),
    ssoUser: readRequired(values.ssoUser ?? env('LOGIN_SSO_USER'), 'ssoUser', '--sso-user or LOGIN_SSO_USER'),
    ssoPassword: readRequired(values.ssoPassword ?? env('LOGIN_SSO_PASSWORD'), 'ssoPassword', '--sso-password or LOGIN_SSO_PASSWORD'),
    ssoType: (values.ssoType ?? env('LOGIN_SSO_TYPE'))?.toLowerCase(),
    debugLogs: values.debugLogs,
    debugArtifacts: values.debugArtifacts,
    headless: values.headless,
  };
  return options;
}

interface ParsedArgs {
  enterpriseId?: string;
  ghLogin?: string;
  ssoUser?: string;
  ssoPassword?: string;
  ssoType?: string;
  debugLogs?: boolean;
  debugArtifacts?: boolean;
  headless?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const values: ParsedArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--enterprise':
        values.enterpriseId = readArgValue(args, ++i, arg);
        break;
      case '--sso-type':
        values.ssoType = readArgValue(args, ++i, arg);
        break;
      case '--gh-login':
        values.ghLogin = readArgValue(args, ++i, arg);
        break;
      case '--sso-user':
        values.ssoUser = readArgValue(args, ++i, arg);
        break;
      case '--sso-password':
        values.ssoPassword = readArgValue(args, ++i, arg);
        break;
      case '--debug-logs':
        values.debugLogs = true;
        break;
      case '--debug-artifacts':
        values.debugArtifacts = true;
        break;
      case '--headful':
        values.headless = false;
        break;
      case '--headless':
        values.headless = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}".\n${usage()}`);
    }
  }
  return values;
}

function readArgValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}.`);
  return value;
}

function readRequired(value: string | undefined, label: string, source: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required. Provide ${source}.`);
  return trimmed;
}

function env(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function usage(): string {
  return `Usage:
  npm run login:token -- --gh-login <gh-login> --sso-user <sso-user> --sso-password <password> \\
    [--enterprise <id>] [--sso-type custom|azure]

Environment alternatives:
  LOGIN_GH_LOGIN=<gh-login>
  LOGIN_SSO_USER=<sso-user>
  LOGIN_SSO_PASSWORD=<password>
  LOGIN_ENTERPRISE_ID=<id>   (default: default)
  LOGIN_SSO_TYPE=custom|azure

The login page, allowlist and selectors come from the enterprise's registry profile
(login.ssoLoginUrl, login.allowedLoginUrls, login.selectors). --sso-type (default custom) applies only when
the profile does not set login.ssoProvider; otherwise it must be omitted or equal that provider.

Debug flags:
  --headful           Show browser window.
  --debug-logs       Enable verbose account log.
  --debug-artifacts  Save Playwright traces/screenshots on failure.

The command prints only the raw Copilot OAuth token to stdout. Progress and log path go to stderr.`;
}

main().catch((err: unknown) => {
  console.error(`[login-token] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
