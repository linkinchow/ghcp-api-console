import Database from 'better-sqlite3';
import { DEFAULT_ENTERPRISE_ID } from '@ghcp/shared';
import { runMigrations } from '../../src/proxy/src/db/migrations.js';
import type { EnterpriseSeed } from '../../src/proxy/src/db/enterpriseSeed.js';
import { canonicalSql } from '../../src/proxy/src/db/mysqlSchema.js';
import type { PoolConfig } from '../../src/proxy/src/userPool/config.js';
import { UserPoolStore } from '../../src/proxy/src/userPool/store.js';

export interface SchemaObject { name: string; type: string; tbl_name: string; sql: string | null }

/** `single-enterprise`: as r4 left it, without `proxy_enterprises`; `multi-enterprise`: migrated (design §4.2). */
export type SourceShape = 'single-enterprise' | 'multi-enterprise';

/** Placeholders: the schema objects do not depend on the enterprise identity or the pool options. */
const REFERENCE_SEED: EnterpriseSeed = { id: DEFAULT_ENTERPRISE_ID, fingerprint: '0'.repeat(64), maxAccounts: 20 };
const REFERENCE_POOL: PoolConfig = { enabled: true, accountDomain: 'fixture.invalid', idleTarget: 2, maxAccounts: 20,
  leaseSeconds: 172800, provisionalSeconds: 300, pollMs: 5000, retryAfterSeconds: 30,
  warmupModel: 'unused-offline', requestTimeoutMs: 120000 };
/** Fresh tables declare `enterprise_id` inline; r4 tables never had it. */
const ENTERPRISE_COLUMN_SQL = /,\s*enterprise_id TEXT(?: REFERENCES proxy_enterprises\(id\))?/g;

export function schemaObjects(db: Database.Database): SchemaObject[] {
  return db.prepare(`
    SELECT name, type, tbl_name, sql
    FROM sqlite_schema
    ORDER BY name
  `).all() as SchemaObject[];
}

/**
 * A fresh Proxy schema, built by the application migrations on an empty in-memory database only: never on a
 * source or output. No runtime, server or worker is instantiated.
 */
export function referenceSchema(shape: SourceShape): SchemaObject[] {
  const db = new Database(':memory:');
  try {
    runMigrations(db, REFERENCE_SEED);
    new UserPoolStore(db, REFERENCE_POOL);
    const objects = schemaObjects(db);
    return shape === 'multi-enterprise' ? objects : withoutEnterprises(objects);
  } finally {
    db.close();
  }
}

/** Canonical SQL of every trigger the shape requires, by name. */
export function referenceTriggers(shape: SourceShape): Map<string, string> {
  const triggers = referenceSchema(shape).filter((object) => object.type === 'trigger' && object.sql !== null);
  return new Map(triggers.map((object) => [object.name, canonicalSql(object.sql!)]));
}

/** Creates the given objects (e.g. a reference schema for synthetic fixtures): tables, then indexes, then triggers. */
export function createSchema(db: Database.Database, objects: readonly SchemaObject[]): void {
  for (const type of ['table', 'index', 'trigger']) {
    for (const object of objects) {
      if (object.type === type && object.sql !== null && !object.name.startsWith('sqlite_')) db.exec(object.sql);
    }
  }
}

/**
 * The single-enterprise (r4) schema: the same objects without `proxy_enterprises`, the `enterprise_id` columns and
 * their indexes and guard triggers. The r4 migrations created exactly this text (canonically compared).
 */
function withoutEnterprises(objects: SchemaObject[]): SchemaObject[] {
  return objects
    .filter((object) => object.tbl_name !== 'proxy_enterprises' && !object.name.includes('enterprise'))
    .map((object) => object.type === 'table' && object.sql !== null
      ? { ...object, sql: object.sql.replace(ENTERPRISE_COLUMN_SQL, '') }
      : object);
}
