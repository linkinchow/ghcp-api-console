import type Database from 'better-sqlite3';
import { openServiceDb } from '@ghcp/shared';
import { config } from '../config.js';
import { loginEnterprises } from '../enterprises.js';
import { loginEnterpriseSeed } from './enterpriseRepo.js';
import { runMigrations } from './migrations.js';

let db: Database.Database | undefined;

/** Opens the database once; migrations and the enterprise identity checks (design §3.6) fail closed. */
export function getDb(): Database.Database {
  if (!db) db = openMigratedDb();
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

function openMigratedDb(): Database.Database {
  const opened = openServiceDb(config.dbPath);
  try {
    runMigrations(opened, loginEnterprises().map((enterprise) => loginEnterpriseSeed(enterprise.profile)));
  } catch (error) {
    opened.close();
    throw error;
  }
  return opened;
}
