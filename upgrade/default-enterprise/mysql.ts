import { createHash } from 'node:crypto';
import { canonicalEnterpriseProfile, parseEnterpriseProfile, type EnterpriseProfile } from '../../src/packages/shared/src/enterprise.js';
import { MYSQL_SCHEMA, mysqlCreateTable, validateMysqlTables, type TableSchema } from '../../src/packages/shared/src/enterpriseMysqlV1.js';
import { ENTERPRISE_MYSQL_TABLES, ENTERPRISE_MYSQL_TRIGGERS, ENTERPRISE_MYSQL_FINAL_STEP, ENTERPRISE_MYSQL_LOCK,
  MYSQL_FENCE_TRIGGER, EnterpriseMysqlError, enterpriseMysqlSchema, enterpriseMysqlObjects, enterpriseMysqlProfileHash,
  enterpriseMysqlCreateTrigger, mysqlEnterpriseRows, requireEnterpriseMysql, validateEnterpriseMysql,
  validateEnterpriseMysqlShape, validateEnterpriseMysqlHistory, insertEnterpriseMysqlMarker, withEnterpriseMysqlDeadline,
  type MysqlConnection, type EnterpriseMysqlLayout, type EnterpriseMysqlTrigger } from '../../src/packages/shared/src/enterpriseMysql.js';

export interface EnterpriseMysqlPreflight {
  database: string; layout: EnterpriseMysqlLayout; maxAccounts?: number; counts: Record<string, number>;
  /** Internal plan binding only. Never include credential-derived digests in human reports. */
  sourceSha256: string;
}
export interface EnterpriseMysqlApplyOptions {
  migrationId: string; confirmOffline: boolean; confirmBackup: boolean; confirmDrained: boolean;
  expectedSourceSha256: string; manifestSha256: string; backupReference: string; backupSha256: string;
  expectedDatabase: string; resume?: boolean; deadlineMs?: number; layout?: EnterpriseMysqlLayout;
}
export interface EnterpriseMysqlMigrationResult extends EnterpriseMysqlPreflight { migrationId: string; resumed: boolean }
interface Evidence { counts: Record<string, number>; columns: Record<string, Record<string, string>>; maxAccounts?: number; eventSequence: string | null }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const requireSafe: typeof requireEnterpriseMysql = requireEnterpriseMysql;

async function databaseName(c: MysqlConnection): Promise<string> {
  const rows = await mysqlEnterpriseRows(c, 'SELECT DATABASE() AS name, @@autocommit AS autocommit, @@foreign_key_checks AS foreign_keys');
  requireSafe(rows.length === 1 && typeof rows[0].name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(rows[0].name)
    && Number(rows[0].autocommit) === 1 && Number(rows[0].foreign_keys) === 1,
  'enterprise_mysql_session_not_dedicated');
  return rows[0].name;
}
function sourceTables(layout: EnterpriseMysqlLayout) { return enterpriseMysqlSchema(layout, 1); }
function stageSchema(layout: EnterpriseMysqlLayout, step: number): Record<string, TableSchema> {
  const schema = sourceTables(layout);
  schema.enterprise_upgrade = ENTERPRISE_MYSQL_TABLES.enterprise_upgrade;
  if (step >= 1) schema.enterprise_profiles = ENTERPRISE_MYSQL_TABLES.enterprise_profiles;
  if (step >= 3) {
    schema.proxy_accounts.columns.enterprise_id = `VARCHAR(36) COLLATE ascii_bin${step >= 5 ? ' NOT NULL' : ''}`;
    schema.proxy_accounts.indexes!.push('idx_proxy_accounts_enterprise (enterprise_id)');
    schema.proxy_accounts.foreign = [['enterprise_id', 'enterprise_profiles', 'id', 'RESTRICT']];
  }
  if (step >= 6 && layout === 'pool') delete schema.user_pool_settings.columns.max_accounts;
  if (step >= 10) schema.enterprise_schema = ENTERPRISE_MYSQL_TABLES.enterprise_schema;
  return schema;
}
function stageTriggers(layout: EnterpriseMysqlLayout, step: number): Record<string, EnterpriseMysqlTrigger> {
  return { ...(layout === 'pool' ? { user_pool_credential_fence: MYSQL_FENCE_TRIGGER } : {}),
    ...(step >= 7 ? { enterprise_profile_immutable: ENTERPRISE_MYSQL_TRIGGERS.enterprise_profile_immutable } : {}),
    ...(step >= 8 ? { enterprise_profile_no_delete: ENTERPRISE_MYSQL_TRIGGERS.enterprise_profile_no_delete } : {}),
    ...(step >= 9 ? { enterprise_account_immutable: ENTERPRISE_MYSQL_TRIGGERS.enterprise_account_immutable } : {}) };
}
async function snapshot(c: MysqlConnection, layout: EnterpriseMysqlLayout, capRemoved = false): Promise<Evidence> {
  const evidence: Evidence = { counts: {}, columns: {}, eventSequence: null };
  for (const [table, definition] of Object.entries(sourceTables(layout))) {
    const columns = Object.keys(definition.columns);
    const expressions = columns.map(column => table === 'user_pool_settings' && column === 'max_accounts' && capRemoved
      ? `(SELECT HEX(CAST(max_accounts AS BINARY)) FROM enterprise_profiles WHERE singleton=1) AS \`${column}\``
      : `HEX(CAST(\`${column}\` AS BINARY)) AS \`${column}\``);
    // Hex conversion is on the server, avoiding timezone, BIGINT and credential encoding conversions in the driver.
    const rows = await mysqlEnterpriseRows(c, `SELECT ${expressions.join(',')} FROM \`${table}\` ORDER BY BINARY \`${definition.primary}\``);
    evidence.counts[table] = rows.length;
    evidence.columns[table] = Object.fromEntries(columns.map(column => [column, digest(JSON.stringify(rows.map(row => row[column])))]));
  }
  if (layout === 'pool') {
    const settings = await mysqlEnterpriseRows(c, capRemoved ? 'SELECT max_accounts FROM enterprise_profiles' : 'SELECT max_accounts FROM user_pool_settings');
    requireSafe(settings.length === 1, 'enterprise_mysql_settings');
    evidence.maxAccounts = Number(settings[0].max_accounts);
    const sequence = await mysqlEnterpriseRows(c, "SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_pool_events'");
    evidence.eventSequence = sequence[0].AUTO_INCREMENT === null ? null : String(sequence[0].AUTO_INCREMENT);
  }
  return evidence;
}
async function assertDrained(c: MysqlConnection, layout: EnterpriseMysqlLayout, profile: EnterpriseProfile, movedCap?: number): Promise<number | undefined> {
  for (const table of ['proxy_identity_initializations', ...(layout === 'pool' ? ['user_pool_holds', 'user_pool_catalog_holds'] : [])]) {
    const rows = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table}`);
    requireSafe(Number(rows[0].n) === 0, 'enterprise_mysql_not_drained');
  }
  const accounts = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM proxy_accounts WHERE copilot_oauth_attempt_id IS NOT NULL
    OR copilot_oauth_status NOT IN ('valid','expired','missing','failed')
    OR (copilot_oauth_status='valid' AND (copilot_oauth_token IS NULL OR LENGTH(copilot_oauth_token)=0 OR copilot_oauth_updated_at IS NULL))`);
  requireSafe(Number(accounts[0].n) === 0, 'enterprise_mysql_unresolved_oauth');
  if (layout === 'direct') return undefined;
  const settings = await mysqlEnterpriseRows(c, 'SELECT *, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS server_now FROM user_pool_settings');
  requireSafe(settings.length === 1, 'enterprise_mysql_settings');
  const s = settings[0];
  const cap = movedCap ?? Number(s.max_accounts);
  requireSafe(Number(s.id) === 1 && Number(s.paused) === 1 && Number(s.owner_until) <= Number(s.server_now)
    && Number(s.version) >= 1 && Number.isInteger(cap) && cap >= 1 && cap <= 10000
    && Number(s.idle_target) >= 0 && Number(s.idle_target) <= cap
    && Number(s.lease_seconds) >= 60 && Number(s.lease_seconds) <= 2592000
    && Number(s.next_ordinal) >= 0 && Number(s.next_ordinal) <= 10000 && s.account_domain === profile.accountDomain
    && isHash(s.config_fingerprint), 'enterprise_mysql_settings_not_drained');
  const inventory = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM user_pool_accounts p LEFT JOIN proxy_accounts a ON a.identity=p.identity
    WHERE a.identity IS NULL OR p.state='provisioning' OR p.ordinal < 0 OR p.ordinal >= ?
      OR p.stage NOT IN ('new','sso-created','scim-synced','synced','warmup','ready')
      OR p.last_error REGEXP 'ambiguous|unconfirmed|stalled|sso_name_conflict|oauth_task_invalid'
      OR ((p.task_id IS NOT NULL OR p.oauth_attempt_id IS NOT NULL OR p.state IN ('ready','cooling')) AND NOT
        (p.state IN ('ready','cooling') AND p.stage='ready' AND p.verified_at IS NOT NULL AND p.sso_created_at IS NOT NULL
          AND a.gh_login IS NOT NULL AND LENGTH(a.gh_login)>0 AND a.copilot_oauth_status='valid'
          AND ((p.task_id IS NULL AND p.oauth_attempt_id IS NULL) OR (p.task_id IS NOT NULL AND p.oauth_attempt_id IS NOT NULL))))`, [Number(s.next_ordinal)]);
  requireSafe(Number(inventory[0].n) === 0, 'enterprise_mysql_unresolved_provisioning');
  // FKs may have been disabled historically. Validate references instead of trusting metadata alone.
  for (const [table, definition] of Object.entries(sourceTables(layout))) {
    for (const [column, target, reference] of definition.foreign ?? []) {
      const rows = await mysqlEnterpriseRows(c, `SELECT COUNT(*) AS n FROM ${table} a LEFT JOIN ${target} b ON a.${column}=b.${reference} WHERE b.${reference} IS NULL`);
      requireSafe(Number(rows[0].n) === 0, 'enterprise_mysql_orphan');
    }
  }
  return cap;
}
async function preflight(c: MysqlConnection, profile: EnterpriseProfile, expectedLayout?: EnterpriseMysqlLayout): Promise<EnterpriseMysqlPreflight & { evidence: Evidence }> {
  const database = await databaseName(c);
  const names = await enterpriseMysqlObjects(c);
  const layout = names.some(name => name.startsWith('user_pool_')) ? 'pool' : 'direct';
  requireSafe(!expectedLayout || layout === expectedLayout, 'enterprise_mysql_layout');
  await validateEnterpriseMysqlShape(c, sourceTables(layout), stageTriggers(layout, 0));
  await validateEnterpriseMysqlHistory(c, layout);
  const maxAccounts = await assertDrained(c, layout, profile);
  const evidence = await snapshot(c, layout);
  return { database, layout, ...(maxAccounts === undefined ? {} : { maxAccounts }), counts: evidence.counts,
    sourceSha256: digest(JSON.stringify(evidence)), evidence };
}
/** Read-only offline source preflight. No lock, SET, transaction, DDL, repair or external call. */
export async function preflightEnterpriseMysql(connection: MysqlConnection, profile: EnterpriseProfile,
  layout?: EnterpriseMysqlLayout): Promise<EnterpriseMysqlPreflight> {
  profile = parseEnterpriseProfile(profile);
  return withEnterpriseMysqlDeadline(connection, async c => {
    const { evidence: _, ...result } = await preflight(c, profile, layout); return result;
  });
}

/** Inspection does not classify a malformed marker as a completed migration. */
export async function inspectEnterpriseMysql(connection: MysqlConnection): Promise<{ state: 'empty' | 'v1' | 'v2' | 'partial'; layout?: EnterpriseMysqlLayout }> {
  return withEnterpriseMysqlDeadline(connection, async c => {
    const names = await enterpriseMysqlObjects(c);
    if (names.length === 0) return { state: 'empty' };
    if (names.includes('enterprise_schema')) {
      try { const result = await validateEnterpriseMysql(c, 'proxy'); return { state: 'v2', layout: result.layout }; }
      catch (error) { if (error instanceof EnterpriseMysqlError && ['enterprise_mysql_deadline', 'enterprise_mysql_statement_outcome_unknown'].includes(error.code)) throw error; return { state: 'partial' }; }
    }
    if (names.includes('enterprise_upgrade') || names.includes('enterprise_profiles')) return { state: 'partial' };
    const layout = names.some(name => name.startsWith('user_pool_')) ? 'pool' : 'direct';
    try { await validateEnterpriseMysqlShape(c, sourceTables(layout), stageTriggers(layout, 0)); await validateEnterpriseMysqlHistory(c, layout); }
    catch { return { state: 'partial' }; }
    return { state: 'v1', layout };
  });
}

async function validateStage(c: MysqlConnection, profile: EnterpriseProfile, layout: EnterpriseMysqlLayout, step: number, expected: Evidence): Promise<void> {
  await validateEnterpriseMysqlShape(c, stageSchema(layout, step), stageTriggers(layout, step));
  await validateEnterpriseMysqlHistory(c, layout);
  if (step >= 1) {
    const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_profiles');
    requireSafe(step === 1 ? rows.length === 0 : rows.length === 1 && Number(rows[0].singleton) === 1 && rows[0].id === profile.id
      && rows[0].slug === profile.slug && rows[0].profile_json === canonicalEnterpriseProfile(profile)
      && Number(rows[0].revision) === profile.revision && (rows[0].max_accounts === null ? undefined : Number(rows[0].max_accounts)) === expected.maxAccounts,
    'enterprise_mysql_checkpoint_profile');
  }
  if (step >= 3) {
    const rows = await mysqlEnterpriseRows(c, step === 3 ? 'SELECT COUNT(*) AS n FROM proxy_accounts WHERE enterprise_id IS NOT NULL'
      : 'SELECT COUNT(*) AS n FROM proxy_accounts WHERE enterprise_id IS NULL OR BINARY enterprise_id <> BINARY ?', step === 3 ? [] : [profile.id]);
    requireSafe(Number(rows[0].n) === 0, 'enterprise_mysql_checkpoint_accounts');
  }
  if (step === 10) requireSafe((await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_schema')).length === 0, 'enterprise_mysql_checkpoint_marker');
  if (step >= 11) {
    const markers = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_schema');
    requireSafe(markers.length === 1 && markers[0].profile_sha256 === enterpriseMysqlProfileHash(profile)
      && markers[0].layout === layout && markers[0].state === 'complete', 'enterprise_mysql_checkpoint_marker');
  }
  const actualEvidence = await snapshot(c, layout, step >= 6);
  requireSafe(same(actualEvidence, expected), 'enterprise_mysql_source_changed');
  // Resume must re-check maintenance state too, not only the original column digests.
  await assertDrained(c, layout, profile, step >= 6 ? expected.maxAccounts : undefined);
}
async function runStep(c: MysqlConnection, step: number, profile: EnterpriseProfile, layout: EnterpriseMysqlLayout, evidence: Evidence): Promise<void> {
  if (step === 1) await c.query(mysqlCreateTable('enterprise_profiles', ENTERPRISE_MYSQL_TABLES));
  else if (step === 2) await c.query('INSERT INTO enterprise_profiles (singleton,id,slug,profile_json,revision,max_accounts) VALUES (1,?,?,?,?,?)',
    [profile.id, profile.slug, canonicalEnterpriseProfile(profile), profile.revision, evidence.maxAccounts ?? null]);
  else if (step === 3) await c.query(`ALTER TABLE proxy_accounts ADD COLUMN enterprise_id VARCHAR(36) COLLATE ascii_bin NULL,
    ADD INDEX idx_proxy_accounts_enterprise (enterprise_id), ADD CONSTRAINT fk_proxy_accounts_enterprise_id
    FOREIGN KEY (enterprise_id) REFERENCES enterprise_profiles(id) ON DELETE RESTRICT`);
  else if (step === 4) await c.query('UPDATE proxy_accounts SET enterprise_id=?', [profile.id]);
  else if (step === 5) await c.query('ALTER TABLE proxy_accounts MODIFY enterprise_id VARCHAR(36) COLLATE ascii_bin NOT NULL');
  else if (step === 6) { if (layout === 'pool') await c.query('ALTER TABLE user_pool_settings DROP COLUMN max_accounts'); }
  else if (step >= 7 && step <= 9) {
    const name = ['enterprise_profile_immutable', 'enterprise_profile_no_delete', 'enterprise_account_immutable'][step - 7];
    await c.query(enterpriseMysqlCreateTrigger(name, ENTERPRISE_MYSQL_TRIGGERS[name]));
  } else if (step === 10) await c.query(mysqlCreateTable('enterprise_schema', ENTERPRISE_MYSQL_TABLES));
  else if (step === 11) await insertEnterpriseMysqlMarker(c, profile, layout);
}

/** Read-only completion verification, including every frozen source column and all plan/backup bindings. */
export async function verifyEnterpriseMysqlMigration(connection: MysqlConnection, profile: EnterpriseProfile,
  options: Omit<EnterpriseMysqlApplyOptions, 'confirmOffline' | 'confirmBackup' | 'confirmDrained' | 'resume'>): Promise<EnterpriseMysqlMigrationResult> {
  profile = parseEnterpriseProfile(profile);
  return withEnterpriseMysqlDeadline(connection, async c => {
    const database = await databaseName(c);
    requireSafe(database === options.expectedDatabase, 'enterprise_mysql_database_mismatch');
    const result = await validateEnterpriseMysql(c, 'proxy', profile);
    const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade');
    requireSafe(rows.length === 1, 'enterprise_mysql_checkpoint_missing_manual_inspection_required');
    const row = rows[0];
    requireSafe(row.migration_id === options.migrationId && row.database_name === database
      && row.manifest_sha256 === options.manifestSha256 && row.backup_reference === options.backupReference
      && row.backup_sha256 === options.backupSha256 && row.source_sha256 === options.expectedSourceSha256
      && row.profile_sha256 === enterpriseMysqlProfileHash(profile) && row.layout === result.layout
      && (!options.layout || options.layout === result.layout) && row.state === 'complete'
      && Number(row.step) === ENTERPRISE_MYSQL_FINAL_STEP && row.checkpoint_state === 'after', 'enterprise_mysql_checkpoint_binding');
    let evidence: Evidence;
    try { evidence = JSON.parse(row.evidence_json); } catch { throw new EnterpriseMysqlError('enterprise_mysql_checkpoint_evidence'); }
    requireSafe(digest(JSON.stringify(evidence)) === options.expectedSourceSha256, 'enterprise_mysql_checkpoint_evidence');
    await validateStage(c, profile, result.layout, ENTERPRISE_MYSQL_FINAL_STEP, evidence);
    return { database, layout: result.layout, counts: evidence.counts, ...(result.maxAccounts === undefined ? {} : { maxAccounts: result.maxAccounts }),
      sourceSha256: options.expectedSourceSha256, migrationId: options.migrationId, resumed: false };
  }, options.deadlineMs ?? 60000);
}

/** Explicit in-place maintenance migration. MySQL DDL commits independently; never claim whole-upgrade rollback. */
export async function applyEnterpriseMysql(connection: MysqlConnection, profile: EnterpriseProfile,
  options: EnterpriseMysqlApplyOptions): Promise<EnterpriseMysqlMigrationResult> {
  profile = parseEnterpriseProfile(profile);
  requireSafe(options.confirmOffline === true && options.confirmBackup === true && options.confirmDrained === true, 'enterprise_mysql_maintenance_required');
  requireSafe(/^[a-zA-Z0-9_-]{1,64}$/.test(options.migrationId) && /^[a-zA-Z0-9_-]{1,64}$/.test(options.expectedDatabase)
    && isHash(options.expectedSourceSha256) && isHash(options.manifestSha256) && isHash(options.backupSha256)
    && typeof options.backupReference === 'string' && options.backupReference.length >= 1 && options.backupReference.length <= 255
    && !/[\x00-\x1f\x7f]/.test(options.backupReference), 'enterprise_mysql_invalid_plan');
  return withEnterpriseMysqlDeadline(connection, async c => {
    let locked = false;
    let failed = false;
    try {
      const database = await databaseName(c);
      requireSafe(database === options.expectedDatabase, 'enterprise_mysql_database_mismatch');
      const lock = await mysqlEnterpriseRows(c, 'SELECT GET_LOCK(?, 5) AS acquired', [ENTERPRISE_MYSQL_LOCK]);
      if (Number(lock[0]?.acquired) !== 1) {
        if (lock[0]?.acquired !== 0 && lock[0]?.acquired !== '0') c.destroy();
        throw new EnterpriseMysqlError('enterprise_mysql_lock_unavailable');
      }
      locked = true;
      let names = await enterpriseMysqlObjects(c);
      // Bound server-side metadata/row lock waits as well as the client deadline. Never change settings in read-only preflight/gates.
      await c.query('SET SESSION lock_wait_timeout=5, innodb_lock_wait_timeout=5');
      let evidence: Evidence;
      let layout: EnterpriseMysqlLayout;
      let step = 0;
      let resumed = false;
      if (!names.includes('enterprise_upgrade')) {
        requireSafe(!options.resume, 'enterprise_mysql_resume_without_checkpoint');
        const source = await preflight(c, profile, options.layout);
        requireSafe(source.sourceSha256 === options.expectedSourceSha256, 'enterprise_mysql_source_changed');
        evidence = source.evidence; layout = source.layout;
        await c.query(mysqlCreateTable('enterprise_upgrade', ENTERPRISE_MYSQL_TABLES));
      } else {
        requireSafe(options.resume, 'enterprise_mysql_resume_required');
        resumed = true;
        await validateMysqlTables(c, { enterprise_upgrade: ENTERPRISE_MYSQL_TABLES.enterprise_upgrade });
        const checkpoints = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade');
        requireSafe(checkpoints.length === 1, 'enterprise_mysql_checkpoint_missing_manual_inspection_required');
        const checkpoint = checkpoints[0];
        requireSafe(checkpoint.migration_id === options.migrationId && checkpoint.database_name === database
          && checkpoint.manifest_sha256 === options.manifestSha256 && checkpoint.backup_reference === options.backupReference
          && checkpoint.backup_sha256 === options.backupSha256 && checkpoint.source_sha256 === options.expectedSourceSha256
          && checkpoint.profile_sha256 === enterpriseMysqlProfileHash(profile) && ['direct', 'pool'].includes(checkpoint.layout)
          && (!options.layout || options.layout === checkpoint.layout) && ['applying', 'complete'].includes(checkpoint.state)
          && ['before', 'after', 'unknown'].includes(checkpoint.checkpoint_state), 'enterprise_mysql_checkpoint_binding');
        layout = checkpoint.layout;
        try { evidence = JSON.parse(checkpoint.evidence_json); } catch { throw new EnterpriseMysqlError('enterprise_mysql_checkpoint_evidence'); }
        requireSafe(digest(JSON.stringify(evidence)) === options.expectedSourceSha256, 'enterprise_mysql_checkpoint_evidence');
        step = Number(checkpoint.step);
        requireSafe(Number.isInteger(step) && step >= 0 && step <= ENTERPRISE_MYSQL_FINAL_STEP, 'enterprise_mysql_checkpoint_step');
        if (checkpoint.state === 'complete') {
          requireSafe(step === ENTERPRISE_MYSQL_FINAL_STEP && checkpoint.checkpoint_state === 'after', 'enterprise_mysql_checkpoint_step');
          await validateEnterpriseMysql(c, 'proxy', profile);
          await validateStage(c, profile, layout, step, evidence);
          return { database, layout, counts: evidence.counts, maxAccounts: evidence.maxAccounts,
            sourceSha256: options.expectedSourceSha256, migrationId: options.migrationId, resumed };
        }
        if (checkpoint.checkpoint_state === 'after') await validateStage(c, profile, layout, step, evidence);
        else {
          requireSafe(step >= 1, 'enterprise_mysql_checkpoint_step');
          // Explicit resume only. Prove exact recognized before/after state, never blindly rerun uncertain SQL.
          let provenAfter = false;
          try { await validateStage(c, profile, layout, step, evidence); provenAfter = true; }
          catch (error) {
            if (error instanceof EnterpriseMysqlError && ['enterprise_mysql_deadline', 'enterprise_mysql_statement_outcome_unknown'].includes(error.code)) throw error;
          }
          if (!provenAfter) { await validateStage(c, profile, layout, step - 1, evidence); step--; }
          await c.query("UPDATE enterprise_upgrade SET step=?,checkpoint_state='after',state=? WHERE singleton=1",
            [step, step === ENTERPRISE_MYSQL_FINAL_STEP ? 'complete' : 'applying']);
        }
      }
      names = await enterpriseMysqlObjects(c);
      const rows = await mysqlEnterpriseRows(c, 'SELECT * FROM enterprise_upgrade');
      if (rows.length === 0) {
        await c.query(`INSERT INTO enterprise_upgrade (singleton,migration_id,database_name,manifest_sha256,backup_reference,backup_sha256,
          profile_sha256,source_sha256,layout,state,step,checkpoint_state,evidence_json) VALUES (1,?,?,?,?,?,?,?,?,'applying',0,'after',?)`,
        [options.migrationId, database, options.manifestSha256, options.backupReference, options.backupSha256,
          enterpriseMysqlProfileHash(profile), options.expectedSourceSha256, layout, JSON.stringify(evidence)]);
      }
      await validateStage(c, profile, layout, step, evidence);
      for (let next = step + 1; next <= ENTERPRISE_MYSQL_FINAL_STEP; next++) {
        await c.query("UPDATE enterprise_upgrade SET step=?,checkpoint_state='before' WHERE singleton=1", [next]);
        // Persist 'unknown' BEFORE any independently committing DDL/DML. An interrupted acknowledgment is never retried in this invocation.
        await c.query("UPDATE enterprise_upgrade SET checkpoint_state='unknown' WHERE singleton=1");
        await runStep(c, next, profile, layout, evidence);
        await validateStage(c, profile, layout, next, evidence);
        await c.query(`UPDATE enterprise_upgrade SET checkpoint_state='after',state=? WHERE singleton=1`, [next === ENTERPRISE_MYSQL_FINAL_STEP ? 'complete' : 'applying']);
      }
      await validateEnterpriseMysql(c, 'proxy', profile);
      return { database, layout, counts: evidence.counts, ...(evidence.maxAccounts === undefined ? {} : { maxAccounts: evidence.maxAccounts }),
        sourceSha256: options.expectedSourceSha256, migrationId: options.migrationId, resumed };
    } catch (error) {
      failed = true;
      if (error instanceof EnterpriseMysqlError) throw error;
      throw new EnterpriseMysqlError('enterprise_mysql_migration_failed_inspect_checkpoint');
    } finally {
      if (locked) {
        try {
          const released = await mysqlEnterpriseRows(c, 'SELECT RELEASE_LOCK(?) AS released', [ENTERPRISE_MYSQL_LOCK]);
          if (Number(released[0]?.released) !== 1) throw new Error();
        } catch {
          c.destroy();
          if (!failed) throw new EnterpriseMysqlError('enterprise_mysql_lock_release_unknown');
        }
      }
    }
  }, options.deadlineMs ?? 60000);
}
