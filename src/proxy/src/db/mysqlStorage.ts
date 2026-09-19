import { randomUUID } from 'node:crypto';
import { resolveEnterpriseScope, type EnterpriseRegistryV3, type AuthorizationBinding } from '@ghcp/shared';
import { AccountScopeError, type AuthorizationAttempt, type AuthorizationResult, type VerifiedGithubSubject } from './storageTypes.js';
import { beginMysqlAttempt, finishMysqlAttempt, getMysqlAttempt } from './mysqlAuthorization.js';
import { assertImportFence, importFence, IMPORT_FENCE_SQL, type ImportFenceRow } from './copilotOauthTokenImportFence.js';
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
  type PageResponse,
  type ProxyRequestStatDto,
} from '@ghcp/shared';
import { validateEnterpriseMysqlV4 } from '@ghcp/shared/enterpriseMysqlV4';
import { enterprisePolicyFromRow } from '../userPool/enterpriseScheduling.js';
import { requestStatsPageSql } from './requestStatsPaging.js';
import { loadProxyEnterpriseRegistry } from '../enterprise.js';
import type { EnterpriseProfile } from '@ghcp/shared';
import { MysqlPoolStore } from '../userPool/mysqlStore.js';
import type { PoolConfig } from '../userPool/config.js';
import { leaseMysqlConnection, MysqlDeadline } from '../userPool/mysqlDeadline.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
  ProxyStorage,
  RecordRequestStatInput,
  RequestStatListQuery,
} from './storageTypes.js';

interface AccountRow extends RowDataPacket {
  enterprise_id: string;
  account_incarnation: string;
  identity: string;
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
  enterprise_id: string | null;
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

export class MysqlStorage implements ProxyStorage {
  private poolStore?: Promise<MysqlPoolStore>;

  userPool(options: PoolConfig): Promise<MysqlPoolStore> {
    return this.poolStore ??= (async () => {
      const store = new MysqlPoolStore(this.pool, options, this.registry ?? this.expectedRegistry);
      await store.initialize();
      return store;
    })().catch((error: unknown) => {
      this.poolStore = undefined;
      throw error;
    });
  }

  constructor(
    private readonly pool: Pool,
    private readonly requestStatsPerAccountLimit: number,
    private readonly expectedRegistry?: EnterpriseRegistryV3,
  ) {}

  private registry?: EnterpriseRegistryV3;

  async initialize(): Promise<void> {
    const expected = this.expectedRegistry ?? loadProxyEnterpriseRegistry();
    const lease = await leaseMysqlConnection(this.pool, new MysqlDeadline(30000, 30000));
    try {
      const state = await validateEnterpriseMysqlV4(lease.connection, 'proxy', expected);
      this.registry = state.registry;
    } finally { lease.release(); }
    await this.ping();
  }

  private enterpriseId(id?: string): string {
    if (!this.registry) throw new Error('MySQL storage has not been initialized.');
    return resolveEnterpriseScope(this.registry,id).enterpriseId;
  }

  async ping(): Promise<void> {
    await this.execute('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async enterprisePolicies() {
    const [rows] = await this.execute<RowDataPacket[]>(`SELECT p.*, e.max_accounts FROM enterprise_pool_policy p
      JOIN enterprise_profiles e ON e.id=p.enterprise_id ORDER BY p.enterprise_id`);
    return rows.map(enterprisePolicyFromRow);
  }

  async listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const q = query.q?.trim();
    const where = 'WHERE enterprise_id=?' + (q
      ? ' AND (LOWER(identity) LIKE LOWER(?) OR LOWER(sso_user) LIKE LOWER(?) OR LOWER(gh_login) LIKE LOWER(?))'
      : '');
    const args = [this.enterpriseId(query.enterpriseId), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])];
    const sort = sortColumn(query.sort);
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const [countRows] = await this.execute<Array<RowDataPacket & { count: number }>>(
      `SELECT COUNT(*) AS count FROM proxy_accounts ${where}`,
      args,
    );
    const [rows] = await this.execute<AccountRow[]>(
      `SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`,
      [...args, pageSize, (page - 1) * pageSize],
    );
    return pageResponse(rows.map(mapAccountRow), Number(countRows[0]?.count ?? 0), page, pageSize);
  }

  async getAccount(identity: string, enterpriseId?: string): Promise<ProxyAccountRecord | undefined> {
    const [rows] = await this.execute<AccountRow[]>('SELECT * FROM proxy_accounts WHERE enterprise_id=? AND identity=?',
      [this.enterpriseId(enterpriseId),identity]);
    return rows[0] ? mapAccountRow(rows[0]) : undefined;
  }

  async deleteAccount(identity: string, enterpriseId?: string, expectedAccountIncarnation?: string): Promise<DeleteProxyAccountResult | undefined> {
    const id=this.enterpriseId(enterpriseId),target=identity.trim();
    return this.transaction(async connection => {
      const [rows]=await connection.execute<RowDataPacket[]>('SELECT account_incarnation FROM proxy_accounts WHERE enterprise_id=? AND identity=? FOR UPDATE',[id,target]);
      if (rows.length===0) return undefined;
      if (expectedAccountIncarnation !== undefined && rows[0]!.account_incarnation !== expectedAccountIncarnation) {
        throw new AccountScopeError('account_incarnation_mismatch');
      }
      await connection.execute("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='account_deleted',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'",[mysqlTimestamp(nowIso()),id,target]);
      const [stats]=await connection.execute<ResultSetHeader>('DELETE FROM proxy_request_stats WHERE identity=?',[target]);
      await connection.execute('DELETE FROM proxy_accounts WHERE enterprise_id=? AND identity=?',[id,target]);
      return {identity:target,deletedRequestStats:stats.affectedRows};
    });
  }

  async deleteAccountsBySsoUser(ssoUser: string,enterpriseId?: string): Promise<DeleteAccountsBySsoUserResult> {
    const id=this.enterpriseId(enterpriseId),target=ssoUser.trim();
    return this.transaction(async connection => {
      const [accounts]=await connection.execute<Array<RowDataPacket & {identity:string}>>('SELECT identity FROM proxy_accounts WHERE enterprise_id=? AND LOWER(sso_user)=LOWER(?) FOR UPDATE',[id,target]);
      let deletedRequestStats=0;
      for (const {identity} of accounts) {
        await connection.execute("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='account_deleted',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'",[mysqlTimestamp(nowIso()),id,identity]);
        const [result]=await connection.execute<ResultSetHeader>('DELETE FROM proxy_request_stats WHERE identity=?',[identity]);
        deletedRequestStats+=result.affectedRows;
      }
      const [result]=await connection.execute<ResultSetHeader>('DELETE FROM proxy_accounts WHERE enterprise_id=? AND LOWER(sso_user)=LOWER(?)',[id,target]);
      return {ssoUser:target,matchedAccounts:accounts.length,deletedAccounts:result.affectedRows,deletedRequestStats};
    });
  }

  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    await this.writeAccount(input);
    if (input.copilotOauthAttemptId) await this.beginCopilotOauthAuthorization(input.identity,input.copilotOauthAttemptId,input.enterpriseId);
    return (await this.getAccount(input.identity,input.enterpriseId))!;
  }

  async getCopilotOauthTokenImportFence(identity: string, enterpriseId?: string) {
    const id = this.enterpriseId(enterpriseId);
    const [rows] = await this.execute<Array<RowDataPacket & ImportFenceRow>>(IMPORT_FENCE_SQL,[id,identity,identity]);
    return importFence(rows[0]!,id);
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const id = this.enterpriseId(input.enterpriseId), now = mysqlTimestamp(nowIso());
    const expected = input.expectedAccount;
    if (!expected) throw new AccountScopeError('token_import_fence_required');
    return this.transaction(async connection => {
      // Reserve an absent global identity without ever modifying a concurrent insert.
      // A random incarnation proves this transaction, not affectedRows/CLIENT_FOUND_ROWS,
      // created the row. A rejected reservation is rolled back with the transaction.
      const reserved = expected.accountIncarnation === null ? randomUUID() : undefined;
      if (reserved) {
        await connection.execute(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,created_at,updated_at)
          VALUES (?,?,?,?,?,'missing',?,?) ON DUPLICATE KEY UPDATE identity=identity`,
        [id,reserved,input.identity,input.ssoUser,input.ghLogin??null,now,now]);
      }
      const [rows] = await connection.execute<AccountRow[]>('SELECT * FROM proxy_accounts WHERE identity=? FOR UPDATE',[input.identity]);
      const account = rows[0];
      if (account && account.enterprise_id !== id) throw new AccountScopeError('identity_enterprise_collision');
      // Current reads after the account lock avoid repeatable-read snapshot drift.
      // Authorization begin/finish and delete all lock the account before the ledger.
      const [attempts] = await connection.execute<RowDataPacket[]>('SELECT oauth_attempt_id FROM proxy_authorization_attempts WHERE enterprise_id=? AND identity=? FOR UPDATE',[id,input.identity]);
      assertImportFence(expected,{
        accountIncarnation: reserved && account?.account_incarnation === reserved ? null : account?.account_incarnation ?? null,
        oauthAttemptId: account?.copilot_oauth_attempt_id ?? null,
        authorizationAttempts: attempts.length,
      });
      if (!account) throw new AccountScopeError('stale_token_import');
      if (account.sso_user !== input.ssoUser || input.ghLogin !== undefined && account.gh_login !== null && account.gh_login !== input.ghLogin) throw new AccountScopeError('account_subject_immutable');
      const [changed] = await connection.execute<ResultSetHeader>(`UPDATE proxy_accounts SET gh_login=COALESCE(?,gh_login),copilot_oauth_token=?,copilot_oauth_status='valid',copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=?
        WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND copilot_oauth_attempt_id <=> ?`,
      [input.ghLogin??null,input.copilotOauthToken,now,now,id,input.identity,account.account_incarnation,expected.oauthAttemptId]);
      if (changed.affectedRows !== 1) throw new AccountScopeError('stale_token_import');
      await connection.execute("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='token_imported',updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND oauth_attempt_id=? AND status='active'",
        [now,id,input.identity,account.account_incarnation,expected.oauthAttemptId]);
      const [saved] = await connection.execute<AccountRow[]>('SELECT * FROM proxy_accounts WHERE enterprise_id=? AND identity=?',[id,input.identity]);
      return mapAccountRow(saved[0]!);
    });
  }

  private async writeAccount(input: CreateAccountInput): Promise<void> {
    const id=this.enterpriseId(input.enterpriseId),now=mysqlTimestamp(nowIso());
    await this.transaction(async connection => {
      // Reserve global identity without changing an existing owner's account. The row
      // lock then proves scope before any payload update (including concurrent inserts).
      await connection.execute(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE identity=identity`,
      [id,randomUUID(),input.identity,input.ssoUser,input.ghLogin??null,input.copilotOauthStatus??'missing',now,now]);
      const [rows]=await connection.execute<RowDataPacket[]>('SELECT enterprise_id,sso_user,gh_login FROM proxy_accounts WHERE identity=? FOR UPDATE',[input.identity]);
      if (rows[0]?.enterprise_id!==id) throw new AccountScopeError('identity_enterprise_collision');
      if (rows[0].sso_user!==input.ssoUser || input.ghLogin!==undefined && rows[0].gh_login!==null && rows[0].gh_login!==input.ghLogin) throw new AccountScopeError('account_subject_immutable');
      await connection.execute('UPDATE proxy_accounts SET sso_user=?,gh_login=COALESCE(?,gh_login),updated_at=? WHERE enterprise_id=? AND identity=?',
        [input.ssoUser,input.ghLogin??null,now,id,input.identity]);
    });
  }

  async saveCopilotOauthToken(_identity: string,_oauthAttemptId: string,_token: string,_ghLogin?: string,_binding?: AuthorizationBinding): Promise<ProxyAccountRecord | undefined> {
    throw new AccountScopeError('authorization_binding_required');
  }

  async markCopilotOauthStatus(identity: string,status: CopilotOauthStatus,enterpriseId?: string): Promise<void> {
    await this.execute('UPDATE proxy_accounts SET copilot_oauth_status=?,updated_at=? WHERE enterprise_id=? AND identity=?',
      [status,mysqlTimestamp(nowIso()),this.enterpriseId(enterpriseId),identity]);
  }

  async beginCopilotOauthAuthorization(identity: string,oauthAttemptId: string,enterpriseId?: string): Promise<boolean> {
    const id=this.enterpriseId(enterpriseId),account=await this.getAccount(identity,id);
    if (!account) return false;
    if (!account.ghLogin) throw new AccountScopeError('expected_github_subject_required');
    await this.beginAuthorizationAttempt({enterpriseId:id,enterpriseRevision:resolveEnterpriseScope(this.registry!,id).enterpriseRevision,
      identity,accountIncarnation:account.accountIncarnation,oauthAttemptId,expectedGhLogin:account.ghLogin});
    return true;
  }

  async failCopilotOauthAuthorization(_identity: string,_oauthAttemptId: string,binding?: AuthorizationBinding): Promise<boolean> {
    if (!binding) throw new AccountScopeError('authorization_binding_required');
    await this.endAuthorizationAttempt(binding,'failed'); return true;
  }

  async invalidateCopilotOauthToken(identity: string,expectedToken: string,status: 'expired'|'failed',enterpriseId?: string): Promise<boolean> {
    const id=this.enterpriseId(enterpriseId),now=mysqlTimestamp(nowIso());
    return this.transaction(async connection => {
      const [changed]=await connection.execute<ResultSetHeader>(`UPDATE proxy_accounts SET copilot_oauth_token=NULL,copilot_oauth_status=?,
        copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND copilot_oauth_token=? AND copilot_oauth_status='valid'`,
        [status,now,now,id,identity,expectedToken]);
      if (changed.affectedRows>0) await connection.execute("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='token_invalidated',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'",[now,id,identity]);
      return changed.affectedRows>0;
    });
  }

  async claimIdentityInitialization(identity: string,claimId: string,leaseSeconds: number,enterpriseId?: string): Promise<boolean> {
    const id=this.enterpriseId(enterpriseId),now=mysqlTimestamp(nowIso()),expires=mysqlTimestamp(new Date(Date.now()+leaseSeconds*1000).toISOString());
    return this.transaction(async connection => {
      const [accounts]=await connection.execute<RowDataPacket[]>('SELECT enterprise_id FROM proxy_accounts WHERE identity=? FOR UPDATE',[identity]);
      if (accounts[0] && accounts[0].enterprise_id!==id) throw new AccountScopeError('identity_enterprise_collision');
      await connection.execute(`INSERT INTO proxy_identity_initializations(enterprise_id,identity,claim_id,lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE identity=identity`,[id,identity,claimId,expires,now,now]);
      const [claims]=await connection.execute<RowDataPacket[]>('SELECT enterprise_id,claim_id,lease_expires_at FROM proxy_identity_initializations WHERE identity=? FOR UPDATE',[identity]);
      if (claims[0]?.enterprise_id!==id) return false;
      if (claims[0]?.claim_id===claimId) return true;
      const [changed]=await connection.execute<ResultSetHeader>('UPDATE proxy_identity_initializations SET claim_id=?,lease_expires_at=?,updated_at=? WHERE enterprise_id=? AND identity=? AND lease_expires_at<=?',
        [claimId,expires,now,id,identity,now]);
      return changed.affectedRows===1;
    });
  }

  async releaseIdentityInitialization(identity: string,claimId: string,enterpriseId?: string): Promise<boolean> {
    const [result]=await this.execute<ResultSetHeader>('DELETE FROM proxy_identity_initializations WHERE enterprise_id=? AND identity=? AND claim_id=?',
      [this.enterpriseId(enterpriseId),identity,claimId]);
    return result.affectedRows>0;
  }

  async getAuthorizationAttempt(enterpriseId: string,identity: string,oauthAttemptId: string): Promise<AuthorizationAttempt|undefined> {
    return getMysqlAttempt({execute:this.execute},this.enterpriseId(enterpriseId),identity,oauthAttemptId);
  }

  private assertBindingRevision(binding: AuthorizationBinding): void {
    if (resolveEnterpriseScope(this.registry!,binding.enterpriseId).enterpriseRevision!==binding.enterpriseRevision) throw new AccountScopeError('enterprise_revision_mismatch');
  }

  async beginAuthorizationAttempt(binding: AuthorizationBinding): Promise<AuthorizationAttempt> {
    this.assertBindingRevision(binding);
    return this.transaction(connection=>beginMysqlAttempt(connection,binding));
  }

  async completeAuthorizationAttempt(binding: AuthorizationBinding,token: string,subject: VerifiedGithubSubject): Promise<AuthorizationResult> {
    this.assertBindingRevision(binding);
    return this.transaction(connection=>finishMysqlAttempt(connection,binding,'succeeded',token,subject));
  }

  async endAuthorizationAttempt(binding: AuthorizationBinding,status: 'failed'|'cancelled',reason?: string): Promise<AuthorizationResult> {
    this.assertBindingRevision(binding);
    return this.transaction(connection=>finishMysqlAttempt(connection,binding,status,undefined,undefined,reason));
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    const enterprise = input.enterpriseId === undefined ? null : this.enterpriseId(input.enterpriseId);
    await this.execute(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens, caller_id, lease_id, enterprise_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, (SELECT enterprise_id FROM proxy_accounts WHERE identity=?)))
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
      enterprise,
      input.identity,
    ]);
    await this.pruneStats(input.identity);
  }

  async listRequestStats(identity?: string,limit=100,enterpriseId?:string):Promise<ProxyRequestStatDto[]> {
    const boundedLimit=Math.max(1,Math.min(limit,1000));
    const [rows]=await this.execute<StatRow[]>(`SELECT s.* FROM proxy_request_stats s
      WHERE s.enterprise_id=? ${identity?'AND s.identity=?':''} ORDER BY s.requested_at DESC,s.id DESC LIMIT ?`,
      [this.enterpriseId(enterpriseId),...(identity?[identity]:[]),boundedLimit]);
    return rows.map(mapStatRow);
  }

  async pageRequestStats(query: RequestStatListQuery): Promise<PageResponse<ProxyRequestStatDto>> {
    const parsed = requestStatsPageSql({ ...query, enterpriseId: this.enterpriseId(query.enterpriseId) });
    return this.transaction(async connection => {
      const [counts] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM proxy_request_stats s ${parsed.where}`, parsed.values);
      const [rows] = await connection.execute<StatRow[]>(`SELECT s.* FROM proxy_request_stats s ${parsed.where}
        ORDER BY s.requested_at DESC,s.id DESC LIMIT ? OFFSET ?`, [...parsed.values, parsed.pageSize, (parsed.page - 1) * parsed.pageSize]);
      return pageResponse(rows.map(mapStatRow), Number(counts[0]!.n), parsed.page, parsed.pageSize);
    });
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

  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
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
      if (committing) lease.destroy();
      else if (!lease.destroyed) {
        try { await connection.rollback(); }
        catch { lease.destroy(); }
      }
      throw err;
    } finally {
      lease.release();
    }
  }
}

function mapAccountRow(row: AccountRow): ProxyAccountRecord {
  return {
    enterpriseId: row.enterprise_id,
    accountIncarnation: row.account_incarnation,
    identity: row.identity,
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

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    enterpriseId: row.enterprise_id ?? undefined,
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sortColumn(sort: AccountListQuery['sort']): string {
  switch (sort) {
    case 'identity':
      return 'identity';
    case 'ssoUser':
      return 'sso_user';
    case 'ghLogin':
      return 'gh_login';
    case 'copilotOauthStatus':
      return 'copilot_oauth_status';
    case 'createdAt':
      return 'created_at';
    default:
      return 'updated_at';
  }
}
