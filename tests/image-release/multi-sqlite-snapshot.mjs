// Logical, value-hashed dump of one service SQLite database, run inside a shipped image with its own
// better-sqlite3: `node /qualification/multi-sqlite-snapshot.mjs <proxy|sso|login> <db path>`.
// Rows are reported per column as SHA-256 hashes so tokens and password hashes never leave the container.
// Migration ids and trigger names are reported in clear (they are code constants). Prints one JSON line.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const [component, path] = process.argv.slice(2);
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
try {
  if (!['proxy', 'sso', 'login'].includes(component) || !/^\/data\/[a-z]+\.sqlite$/.test(path ?? '')) {
    throw new Error('invalid_arguments');
  }
  const Database = createRequire(`/app/src/${component}/package.json`)('better-sqlite3');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const logicalTables = {};
    const enterprise = {};
    for (const name of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(name).map((row) => row.name);
      const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
      logicalTables[name] = {
        columns,
        rows: rows.map((row) => Object.fromEntries(columns.map((column) => [column, hash(row[column])]))),
      };
      if (columns.includes('enterprise_id')) {
        enterprise[name] = {
          total: rows.length,
          default: rows.filter((row) => row.enterprise_id === 'default').length,
          missing: rows.filter((row) => row.enterprise_id === null || row.enterprise_id === '').length,
        };
      }
    }
    const migrations = tables.includes('schema_migrations')
      ? db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => row.id)
      : [];
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all()
      .map((row) => row.name);
    const integrity = db.pragma('integrity_check', { simple: true });
    console.log(JSON.stringify({ snapshot: true, component, logicalTables, enterprise, migrations, triggers,
      integrity }));
  } finally {
    db.close();
  }
} catch (error) {
  console.log(JSON.stringify({ snapshot: false, component, error: error?.code ?? 'snapshot_failed' }));
  process.exitCode = 1;
}
