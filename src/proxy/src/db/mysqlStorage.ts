import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';
import {
  newRequestId,
  nowIso,
  pageResponse,
  type CopilotOauthStatus,
  type DeleteProxyAccountResult,
  type EnterpriseId,
  type EnterpriseLifecycleState,
  type PageResponse,
  type ProxyRequestStatDto,
  type ManagementQuery,
  type ManagementSummary,
} from '@ghcp/shared';
import {
  prepareMysqlEnterprises,
  runMysqlMigrations,
  syncMysqlEnterprises,
  validateMysqlTables,
} from './mysqlMigrations.js';
import { MYSQL_MIGRATION_LOCK_WAIT } from './mysqlMigrationLock.js';
import { requireDefaultSeed, type EnterpriseSeed } from './enterpriseSeed.js';
import { managementSql } from './managementQueries.js';
import { MysqlPoolStore } from '../userPool/mysqlStore.js';
import type { PoolConfig } from '../userPool/config.js';
import { leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
  ProxyEnterpriseRecord,
  ProxyStorage,
  RecordRequestStatInput,
  SnapshotReader,
} from './storageTypes.js';

interface AccountRow extends RowDataPacket {
  identity: string;
  enterprise_id: string;
  sso_user: string;
  gh_login: string | null;
  copilot_oauth_token: string | null;
  copilot_oauth_status: CopilotOauthStatus;
  copilot_oauth_updated_at: string | null;
  copilot_oauth_attempt_id: string | null;
  created_at: string;
  updated_at: string;
}

interface StatRow extends RowDataPacket {
  caller_id: string | null;
  lease_id: string | null;
  id: string;
  identity: string;
  gh_login: string | null;
  requested_at: string;
  path: ProxyRequestStatDto['path'];
  model: string | null;
  success: number | boolean;
  failure_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_tokens: number | null;
  cache_input_tokens: number | null;
  cache_write_tokens: number | null;
}

interface EnterpriseRow extends RowDataPacket {
  id: string;
  state: EnterpriseLifecycleState;
  max_accounts: number;
  inventory_count: number;
  policy_version: number;
  profile_fingerprint: string;
  created_at: number | string;
  updated_at: number | string;
}

const SNAPSHOT_READ_DEADLINE_MS = 30_000;

/**
 * Upserts must not move an identity to another enterprise. Assigning NULL to the NOT NULL column fails the whole
 * statement (strict mode), so a mismatch leaves the row untouched, like the SQLite immutability trigger.
 */
const KEEP_ENTERPRISE_SQL = 'enterprise_id = IF(enterprise_id = VALUES(enterprise_id), enterprise_id, NULL)';

export class MysqlStorage implements ProxyStorage {
  private poolStore?: Promise<MysqlPoolStore>;

  userPool(options: PoolConfig): Promise<MysqlPoolStore> {
    return this.poolStore ??= (async () => {
      const store = new MysqlPoolStore(this.pool, options, this.autoMigrate, this.migrationLockWaitSeconds);
      await store.initialize();
      return store;
    })().catch((error: unknown) => {
      this.poolStore = undefined;
      throw error;
    });
  }

  async withReadSnapshot<T>(read: (reader: SnapshotReader) => Promise<T>): Promise<T> {
    // Snapshot reads page through whole tables for exports, so they get a longer budget than single statements.
    const lease = await leaseMysqlConnection(this.pool, new MysqlDeadline(SNAPSHOT_READ_DEADLINE_MS, SNAPSHOT_READ_DEADLINE_MS));
    const { connection } = lease;
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      return await read({
        listAccounts: (enterpriseId, query) => this.listAccounts(enterpriseId, query, connection),
        listRequestStatsPage: (enterpriseId, query) => this.listRequestStatsPage(enterpriseId, query, connection),
      });
    } finally {
      try {
        if (!lease.destroyed) await connection.rollback();
      } catch {
        lease.destroy();
      } finally {
        lease.release();
      }
    }
  }

  /**
   * `seeds`: every registry enterprise, `default` first.
   * `migrationLockWaitSeconds`: MYSQL_MIGRATION_LOCK_WAIT_SECONDS.
   */
  constructor(
    private readonly pool: Pool,
    private readonly requestStatsPerAccountLimit: number,
    private readonly autoMigrate: boolean,
    private readonly seeds: readonly EnterpriseSeed[],
    private readonly migrationLockWaitSeconds: number = MYSQL_MIGRATION_LOCK_WAIT.defaultSeconds,
  ) { }

  async initialize(): Promise<void> {
    const seed = requireDefaultSeed(this.seeds);
    if (this.autoMigrate) {
      await runMysqlMigrations(this.pool, seed, this.migrationLockWaitSeconds);
    } else {
      await validateMysqlTables(this.pool);
      await prepareMysqlEnterprises(this.pool, seed, this.migrationLockWaitSeconds);
    }
    await syncMysqlEnterprises(this.pool, this.seeds, this.migrationLockWaitSeconds);
    await this.ping();
  }

  async ping(): Promise<void> {
    await this.execute('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listAccounts(
    enterpriseId: EnterpriseId,
    query: AccountListQuery = {},
    connection: Pick<Pool, 'execute'> = { execute: this.execute },
  ): Promise<PageResponse<ProxyAccountRecord>> {
    let page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const { where, args, order } = managementSql('accounts', enterpriseId, query, mysqlTimestamp);
    const [countRows] = await connection.execute<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM proxy_accounts ${where}`,
      args,
    );
    const total = Number(countRows[0]?.count ?? 0);
    page = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const [rows] = await connection.execute<AccountRow[]>(
      `SELECT * FROM proxy_accounts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    return pageResponse(rows.map(mapAccountRow), total, page, pageSize);
  }

  async summarizeAccounts(enterpriseId: EnterpriseId): Promise<ManagementSummary> {
    const [rows] = await this.execute<Array<RowDataPacket & { status: string; count: number }>>(`
      SELECT copilot_oauth_status AS status, COUNT(*) AS count
      FROM proxy_accounts
      WHERE enterprise_id = ?
      GROUP BY copilot_oauth_status
    `, [enterpriseId]);
    return { total: rows.reduce((total, row) => total + Number(row.count), 0), counts: Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])), updatedAt: nowIso() };
  }

  async getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
    const [rows] = await this.execute<AccountRow[]>(
      'SELECT * FROM proxy_accounts WHERE identity = ?',
      [identity],
    );
    return rows[0] ? mapAccountRow(rows[0]) : undefined;
  }

  async deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined> {
    const target = identity.trim();
    if (!target) return undefined;
    return this.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT 1 FROM proxy_accounts WHERE identity = ? FOR UPDATE',
        [target],
      );
      if (rows.length === 0) return undefined;
      const [statsResult] = await connection.execute<ResultSetHeader>(
        'DELETE FROM proxy_request_stats WHERE identity = ?',
        [target],
      );
      const [accountResult] = await connection.execute<ResultSetHeader>(
        'DELETE FROM proxy_accounts WHERE identity = ?',
        [target],
      );
      if (accountResult.affectedRows !== 1) throw new Error(`Failed to delete Proxy account "${target}".`);
      return { identity: target, deletedRequestStats: statsResult.affectedRows };
    });
  }

  /** `sso_user` is unique only within an enterprise (design §5.3). */
  async deleteAccountsBySsoUser(enterpriseId: EnterpriseId, ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
    const target = ssoUser.trim();
    if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
    return this.transaction(async (connection) => {
      const [accounts] = await connection.execute<Array<RowDataPacket & { identity: string }>>(`
        SELECT identity
        FROM proxy_accounts
        WHERE enterprise_id = ?
          AND LOWER(sso_user) = LOWER(?)
        FOR UPDATE
      `, [enterpriseId, target]);
      const identities = accounts.map((account) => account.identity);
      let deletedRequestStats = 0;
      if (identities.length > 0) {
        const placeholders = identities.map(() => '?').join(', ');
        const [statsResult] = await connection.execute<ResultSetHeader>(
          `DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`,
          identities,
        );
        deletedRequestStats = statsResult.affectedRows;
      }
      const [accountResult] = await connection.execute<ResultSetHeader>(`
        DELETE FROM proxy_accounts
        WHERE enterprise_id = ?
          AND LOWER(sso_user) = LOWER(?)
      `, [enterpriseId, target]);
      return {
        ssoUser: target,
        matchedAccounts: accounts.length,
        deletedAccounts: accountResult.affectedRows,
        deletedRequestStats,
      };
    });
  }

  /** An existing identity never moves to another enterprise; trying fails with `enterprise_id_immutable`. */
  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    const now = mysqlTimestamp(nowIso());
    await this.upsertAccount(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_status, copilot_oauth_attempt_id, created_at, updated_at,
        enterprise_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        ${KEEP_ENTERPRISE_SQL},
        sso_user = VALUES(sso_user),
        gh_login = COALESCE(VALUES(gh_login), gh_login),
        updated_at = VALUES(updated_at)
    `, [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      input.copilotOauthStatus ?? 'missing',
      input.copilotOauthAttemptId ?? null,
      now,
      now,
      input.enterpriseId,
    ]);
    return (await this.getAccount(input.identity))!;
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const now = mysqlTimestamp(nowIso());
    await this.upsertAccount(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, copilot_oauth_token, copilot_oauth_status,
        copilot_oauth_updated_at, created_at, updated_at, enterprise_id
      ) VALUES (?, ?, ?, ?, 'valid', ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        ${KEEP_ENTERPRISE_SQL},
        sso_user = VALUES(sso_user),
        gh_login = COALESCE(VALUES(gh_login), gh_login),
        copilot_oauth_token = VALUES(copilot_oauth_token),
        copilot_oauth_status = 'valid',
        copilot_oauth_updated_at = VALUES(copilot_oauth_updated_at),
        copilot_oauth_attempt_id = NULL,
        updated_at = VALUES(updated_at)
    `, [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      input.copilotOauthToken,
      now,
      now,
      now,
      input.enterpriseId,
    ]);
    return (await this.getAccount(input.identity))!;
  }

  private async upsertAccount(sql: string, values: Parameters<Pool['execute']>[1]): Promise<void> {
    try {
      await this.execute(sql, values);
    } catch (error) {
      if (isBadNullError(error)) throw new Error('enterprise_id_immutable', { cause: error });
      throw error;
    }
  }

  async saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined> {
    const now = mysqlTimestamp(nowIso());
    // The status guard makes "cancel wins": once Login marked the attempt failed, a token that
    // arrives late for the same attempt is refused instead of silently reviving it.
    const [result] = await this.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = ?, gh_login = COALESCE(?, gh_login),
          copilot_oauth_status = 'valid', copilot_oauth_updated_at = ?,
          copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ? AND copilot_oauth_status = 'refreshing'
    `, [copilotOauthToken, ghLogin ?? null, now, now, identity, oauthAttemptId]);
    return result.affectedRows > 0 ? this.getAccount(identity) : undefined;
  }

  async markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
    await this.execute(
      'UPDATE proxy_accounts SET copilot_oauth_status = ?, updated_at = ? WHERE identity = ?',
      [status, mysqlTimestamp(nowIso()), identity],
    );
  }

  async beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, expectedAttemptId?: string | null): Promise<boolean> {
    // `<=>` is MySQL's NULL-safe equality, so `null` matches an account without an attempt.
    const guard = expectedAttemptId === undefined ? '' : ' AND copilot_oauth_attempt_id <=> ?';
    const args = expectedAttemptId === undefined ? [] : [expectedAttemptId];
    const [result] = await this.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'refreshing', copilot_oauth_attempt_id = ?, updated_at = ?
      WHERE identity = ? ${guard}
    `, [oauthAttemptId, mysqlTimestamp(nowIso()), identity, ...args]);
    return result.affectedRows > 0;
  }

  async failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean> {
    const [result] = await this.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_status = 'failed', updated_at = ?
      WHERE identity = ? AND copilot_oauth_attempt_id = ?
    `, [mysqlTimestamp(nowIso()), identity, oauthAttemptId]);
    return result.affectedRows > 0;
  }

  async invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean> {
    const now = mysqlTimestamp(nowIso());
    const [result] = await this.execute<ResultSetHeader>(`
      UPDATE proxy_accounts
      SET copilot_oauth_token = NULL, copilot_oauth_status = ?,
          copilot_oauth_updated_at = ?, copilot_oauth_attempt_id = NULL, updated_at = ?
      WHERE identity = ? AND copilot_oauth_token = ? AND copilot_oauth_status = 'valid'
    `, [status, now, now, identity, expectedToken]);
    return result.affectedRows > 0;
  }

  async claimIdentityInitialization(
    enterpriseId: EnterpriseId,
    identity: string,
    claimId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const now = mysqlTimestamp(nowIso());
    const leaseExpiresAt = mysqlTimestamp(new Date(Date.now() + leaseSeconds * 1000).toISOString());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [inserted] = await this.execute<ResultSetHeader>(`
          INSERT IGNORE INTO proxy_identity_initializations (
            identity, claim_id, lease_expires_at, created_at, updated_at, enterprise_id
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [identity, claimId, leaseExpiresAt, now, now, enterpriseId]);
        if (inserted.affectedRows === 1) return true;
        const [updated] = await this.execute<ResultSetHeader>(`
          UPDATE proxy_identity_initializations
          SET claim_id = ?, lease_expires_at = ?, updated_at = ?, enterprise_id = ?
          WHERE identity = ? AND lease_expires_at <= ?
        `, [claimId, leaseExpiresAt, now, enterpriseId, identity, now]);
        return updated.affectedRows === 1;
      } catch (err) {
        if (!isRetryableMysqlLockError(err) || attempt === 2) throw err;
        await sleep((attempt + 1) * 10);
      }
    }
    return false;
  }

  async releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
    const [result] = await this.execute<ResultSetHeader>(
      'DELETE FROM proxy_identity_initializations WHERE identity = ? AND claim_id = ?',
      [identity, claimId],
    );
    return result.affectedRows > 0;
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    await this.execute(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens, caller_id, lease_id,
        enterprise_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      newRequestId(),
      input.identity,
      input.ghLogin ?? null,
      mysqlTimestamp(nowIso()),
      input.path,
      input.model ?? null,
      input.success ? 1 : 0,
      input.failureReason ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cacheTokens ?? null,
      input.cacheInputTokens ?? null,
      input.cacheWriteTokens ?? null,
      input.callerId ?? null,
      input.leaseId ?? null,
      input.enterpriseId,
    ]);
    await this.pruneStats(input.identity);
  }

  async listRequestStats(enterpriseId: EnterpriseId, identity?: string, limit = 100): Promise<ProxyRequestStatDto[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const identityFilter = identity ? 'AND identity = ?' : '';
    const [rows] = await this.execute<StatRow[]>(`
      SELECT *
      FROM proxy_request_stats
      WHERE enterprise_id = ?
        ${identityFilter}
      ORDER BY requested_at DESC, id DESC
      LIMIT ?
    `, [enterpriseId, ...(identity ? [identity] : []), boundedLimit]);
    return rows.map(mapStatRow);
  }

  async listRequestStatsPage(
    enterpriseId: EnterpriseId,
    query: ManagementQuery = {},
    connection: Pick<Pool, 'execute'> = { execute: this.execute },
  ): Promise<PageResponse<ProxyRequestStatDto>> {
    const { where, args, order } = managementSql('requests', enterpriseId, query, mysqlTimestamp);
    const [counts] = await connection.execute<Array<RowDataPacket & { count: number }>>(`SELECT COUNT(*) AS count FROM proxy_request_stats ${where}`, args);
    const total = Number(counts[0]?.count ?? 0);
    const pageSize = Math.max(1, Math.min(query.pageSize ?? 25, 100));
    const page = Math.min(Math.max(1, query.page ?? 1), Math.max(1, Math.ceil(total / pageSize)));
    const [rows] = await connection.execute<StatRow[]>(`SELECT * FROM proxy_request_stats ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize]);
    return pageResponse(rows.map(mapStatRow), total, page, pageSize);
  }

  async listEnterprises(): Promise<ProxyEnterpriseRecord[]> {
    const [rows] = await this.execute<EnterpriseRow[]>(`
      SELECT *
      FROM proxy_enterprises
      ORDER BY id
    `);
    return rows.map(mapEnterpriseRow);
  }

  async pruneAllRequestStats(): Promise<void> {
    await this.execute(`
      DELETE stats
      FROM proxy_request_stats AS stats
      JOIN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY identity
              ORDER BY requested_at DESC, id DESC
            ) AS retention_rank
          FROM proxy_request_stats
        ) AS ranked_stats
        WHERE retention_rank > ?
      ) AS stale_stats ON stale_stats.id = stats.id
    `, [this.requestStatsPerAccountLimit]);
  }

  private async pruneStats(identity: string): Promise<void> {
    await this.execute(`
      DELETE FROM proxy_request_stats
      WHERE identity = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM proxy_request_stats
            WHERE identity = ?
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
          ) AS retained_proxy_request_stats
        )
    `, [identity, identity, this.requestStatsPerAccountLimit]);
  }

  private readonly execute: Pool['execute'] = (async (...args: unknown[]) => {
    const lease = await leaseMysqlConnection(this.pool, new MysqlDeadline());
    try { return await Reflect.apply(lease.connection.execute, lease.connection, args); }
    finally { lease.release(); }
  }) as Pool['execute'];

  /**
   * Runs `operation` in one transaction. Deadlocks and lock-wait timeouts roll back and retry a
   * bounded number of times: every caller performs a single idempotent unit of work, so replaying
   * the callback on a fresh transaction is safe and beats surfacing a transient InnoDB error.
   * Each attempt leases its connection under a fresh deadline.
   */
  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const lease = await leaseMysqlConnection(this.pool, new MysqlDeadline());
      const { connection } = lease;
      let committing = false;
      try {
        await connection.beginTransaction();
        const result = await operation(connection);
        committing = true;
        await connection.commit();
        return result;
      } catch (err) {
        // A failed COMMIT has an unknown outcome: drop the socket and never replay the work.
        if (committing) {
          lease.destroy();
          throw err;
        }
        if (!lease.destroyed) {
          try { await connection.rollback(); }
          catch { lease.destroy(); }
        }
        if (!isRetryableMysqlLockError(err) || attempt === 2) throw err;
        await sleep((attempt + 1) * 25);
      } finally {
        lease.release();
      }
    }
  }
}

function mapAccountRow(row: AccountRow): ProxyAccountRecord {
  return {
    identity: row.identity,
    enterpriseId: row.enterprise_id as EnterpriseId,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    copilotOauthToken: row.copilot_oauth_token ?? undefined,
    copilotOauthStatus: row.copilot_oauth_status,
    copilotOauthUpdatedAt: mysqlTimestampToIso(row.copilot_oauth_updated_at),
    copilotOauthAttemptId: row.copilot_oauth_attempt_id ?? undefined,
    createdAt: mysqlTimestampToIso(row.created_at)!,
    updatedAt: mysqlTimestampToIso(row.updated_at)!,
  };
}

function mapEnterpriseRow(row: EnterpriseRow): ProxyEnterpriseRecord {
  return {
    id: row.id as EnterpriseId,
    state: row.state,
    maxAccounts: Number(row.max_accounts),
    inventoryCount: Number(row.inventory_count),
    policyVersion: Number(row.policy_version),
    profileFingerprint: row.profile_fingerprint,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    id: row.id,
    identity: row.identity,
    callerId: row.caller_id ?? undefined,
    leaseId: row.lease_id ?? undefined,
    ghLogin: row.gh_login ?? undefined,
    requestedAt: mysqlTimestampToIso(row.requested_at)!,
    path: row.path,
    model: row.model ?? undefined,
    success: row.success === 1 || row.success === true,
    failureReason: row.failure_reason ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    cacheTokens: row.cache_tokens ?? undefined,
    cacheInputTokens: row.cache_input_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
  };
}

function mysqlTimestamp(value: string): string {
  return value.slice(0, 23).replace('T', ' ');
}

function mysqlTimestampToIso(value: string | null): string | undefined {
  if (!value) return undefined;
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}

function isRetryableMysqlLockError(err: unknown): boolean {
  if (!(err instanceof Error) || !('code' in err)) return false;
  return err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT';
}

function isBadNullError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ER_BAD_NULL_ERROR';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
