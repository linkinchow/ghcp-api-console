import { migrateSqlitePoolToMysql, safeError } from './migrate.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let sqlitePath: string | undefined;
  let dryRun = false;
  let confirmOfflineSource = false;
  let confirmEmptyTarget = false;
  for (let index = 0; index < args.length; index++) {
    switch (args[index]) {
      case '--help': case '-h':
        console.log(`Usage: npm run upgrade:user-pool-mysql -- --sqlite <backup.sqlite> [--dry-run]

  --dry-run                 Source-only preflight; no MySQL connection or schema writes
  --confirm-offline-source  Confirm old writers stopped, traffic and external jobs drained
  --confirm-empty-target    Confirm dedicated empty MySQL 8 target, with all target services stopped

Import requires BOTH confirmations. MYSQL_URL is accepted only from the environment.
TLS: MYSQL_SSL_MODE=disabled|required|verify-ca; nonlocal requires verify-ca and
MYSQL_SSL_CA_PATH. Provide POOL_WARMUP_MODEL and intended runtime pool options;
initialize() seeds their deployment fingerprint without any external requests.
See upgrade/user-pool-mysql/README.md before cutover.`);
        return;
      case '--sqlite':
        if (sqlitePath || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid arguments');
        sqlitePath = args[++index];
        break;
      case '--dry-run': dryRun = true; break;
      case '--confirm-offline-source': confirmOfflineSource = true; break;
      case '--confirm-empty-target': confirmEmptyTarget = true; break;
      default:
        // Never echo argv: an unsupported option/value might contain a connection URL or secret.
        throw new Error('Invalid arguments');
    }
  }
  if (!sqlitePath) throw new Error('Invalid arguments');
  const result = await migrateSqlitePoolToMysql({ sqlitePath, dryRun, confirmOfflineSource, confirmEmptyTarget });
  console.log(JSON.stringify(result)); // Counts only; never paths, domains, callers, credentials or driver errors.
  console.log(result.dryRun ? 'Source preflight passed; target was not inspected or modified.' : 'Import verified. Target pool remains paused with no owner. Keep old SQLite writers stopped.');
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error && error.message === 'Invalid arguments'
    ? 'Invalid arguments. Use --help; connection URLs are not accepted as CLI options.' : safeError(error));
  process.exitCode = 1;
});
