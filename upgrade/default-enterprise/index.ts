import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { runEnterpriseCommand, safeEnterpriseToolError, type EnterpriseCommand } from './commands.js';
import { insist } from './manifest.js';

const HELP = `Offline enterprise schema2 / contract1 tool (baseline 8ad76d5)
Usage: npm run upgrade:default-enterprise -- <init|preflight|apply|verify|inspect> --manifest <absolute.json> [--resume] [--plan-out <absolute.json>]
--resume is explicit MySQL known-checkpoint recovery; it never retries an unresolved commit.
SQLite apply always writes a new exclusive output and never changes the standalone source backup.
No .env is loaded. Credentials, business values, hashes, and connection strings are not printed.
`;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(HELP); return; }
  const command = args.shift() as EnterpriseCommand;
  insist(['init', 'preflight', 'apply', 'verify', 'inspect'].includes(command), 'enterprise_invalid_command');
  let manifestPath: string | undefined, planOut: string | undefined, resume = false;
  while (args.length) {
    const option = args.shift();
    if (option === '--manifest' && manifestPath === undefined) manifestPath = args.shift();
    else if (option === '--resume' && !resume) resume = true;
    else if (option === '--plan-out' && planOut === undefined) {
      planOut = args.shift(); insist(planOut, 'enterprise_plan_output_path_required');
    }
    else insist(false, 'enterprise_invalid_argument');
  }
  insist(manifestPath && isAbsolute(manifestPath), 'enterprise_absolute_manifest_required');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const result = await runEnterpriseCommand(command, manifest, { resume, planOut });
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, code: safeEnterpriseToolError(error), ready: false }) + '\n');
  process.exitCode = 1;
});
