import { randomUUID } from 'node:crypto';
import { resolveEnterpriseScope, type EnterpriseRegistryV3, type AuthorizationBinding } from '@ghcp/shared';
import { AccountScopeError, type AuthorizationAttempt, type AuthorizationResult, type VerifiedGithubSubject } from './storageTypes.js';
import { beginSqliteAttempt, finishSqliteAttempt, getSqliteAttempt } from './sqliteAuthorization.js';
import { assertImportFence, importFence, IMPORT_FENCE_SQL, type ImportFenceRow } from './copilotOauthTokenImportFence.js';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import BetterSqlite3 from 'better-sqlite3';
import {
  newRequestId,
  nowIso,
  pageResponse,
  type CopilotOauthStatus,
  type DeleteProxyAccountResult,
  type PageResponse,
  type ProxyRequestStatDto,
} from '@ghcp/shared';
import { EnterpriseStorageError } from '@ghcp/shared/enterpriseStorage';
import { validateEnterpriseSqliteV4 } from '@ghcp/shared/enterpriseStorageV4';
import { enterprisePolicyFromRow } from '../userPool/enterpriseScheduling.js';
import { requestStatsPageSql } from './requestStatsPaging.js';
import { loadProxyEnterpriseRegistry } from '../enterprise.js';
import type { EnterpriseProfile } from '@ghcp/shared';
import { UserPoolStore } from '../userPool/store.js';
import type { PoolConfig } from '../userPool/config.js';
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

interface AccountRow {
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

interface StatRow {
  enterprise_id?: string | null;
  id: string;
  identity: string;
  caller_id?: string;
  lease_id?: string;
  gh_login?: string;
  requested_at: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: 0 | 1;
  failure_reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cache_input_tokens?: number;
  cache_write_tokens?: number;
}

export class SqliteStorage implements ProxyStorage {
  private db?: Database.Database;
  private poolStore?: UserPoolStore;
  private registry?: EnterpriseRegistryV3;

  userPool(options: PoolConfig): UserPoolStore {
    return this.poolStore ??= new UserPoolStore(this.database(), options, this.registry);
  }

  constructor(
    private readonly path: string,
    private readonly requestStatsPerAccountLimit: number,
    private readonly expectedRegistry?: EnterpriseRegistryV3,
    /** An explicitly initialized database may be injected by isolated tests; validation is never skipped. */
    private readonly existingDatabase?: Database.Database,
  ) {}

  async initialize(): Promise<void> {
    if (this.db) return;
    const expected = this.expectedRegistry ?? loadProxyEnterpriseRegistry();
    if (!this.existingDatabase && (this.path === ':memory:' || !existsSync(this.path))) {
      throw new EnterpriseStorageError('enterprise_init_required');
    }
    if (!this.existingDatabase) {
      // Never open a rejected database read/write: SQLite may checkpoint WAL on close.
      // A missing shared-memory index or hot rollback journal needs offline handling.
      if (existsSync(this.path + '-journal') || (existsSync(this.path + '-wal') && !existsSync(this.path + '-shm'))) {
        throw new EnterpriseStorageError('enterprise_offline_backup_required');
      }
      const probe = new BetterSqlite3(this.path, { readonly: true, fileMustExist: true });
      try {
        probe.pragma('foreign_keys = ON');
        validateEnterpriseSqliteV4(probe, 'proxy', expected);
      } finally { probe.close(); }
    }
    const db = this.existingDatabase ?? new BetterSqlite3(this.path, { fileMustExist: true });
    try {
      // Connection-only settings precede the read-only gate. No DDL, seed or journal change on rejection.
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      const state = validateEnterpriseSqliteV4(db, 'proxy', expected);
      db.pragma('journal_mode = WAL');
      this.registry = state.registry;
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async ping(): Promise<void> {
    this.database().prepare('SELECT 1').get();
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.poolStore = undefined;
  }

  async enterprisePolicies() {
    return (this.database().prepare(`SELECT p.*, e.max_accounts FROM enterprise_pool_policy p
      JOIN enterprise_profiles e ON e.id=p.enterprise_id ORDER BY p.enterprise_id`).all() as Record<string, unknown>[])
      .map(enterprisePolicyFromRow);
  }

  async listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
    const q = query.q?.trim();
    const where = 'WHERE enterprise_id = ?' + (q ? ' AND (identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?)' : '');
    const args = [this.enterpriseId(query.enterpriseId), ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])];
    const sort = sortColumn(query.sort);
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const total = (this.database()
      .prepare(`SELECT COUNT(*) AS count FROM proxy_accounts ${where}`)
      .get(...args) as { count: number }).count;
    const rows = this.database()
      .prepare(`SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as AccountRow[];
    return pageResponse(rows.map(mapAccountRow), total, page, pageSize);
  }

  private enterpriseId(id?: string): string {
    if (!this.registry) throw new Error('SQLite storage has not been initialized.');
    return resolveEnterpriseScope(this.registry, id).enterpriseId;
  }

  async getAccount(identity: string, enterpriseId?: string): Promise<ProxyAccountRecord | undefined> {
    const row = this.database().prepare('SELECT * FROM proxy_accounts WHERE enterprise_id=? AND identity=?')
      .get(this.enterpriseId(enterpriseId), identity) as AccountRow | undefined;
    return row ? mapAccountRow(row) : undefined;
  }

  async deleteAccount(identity: string, enterpriseId?: string, expectedAccountIncarnation?: string): Promise<DeleteProxyAccountResult | undefined> {
    const id = this.enterpriseId(enterpriseId), target = identity.trim();
    return this.database().transaction(() => {
      const account = this.database().prepare('SELECT account_incarnation FROM proxy_accounts WHERE enterprise_id=? AND identity=?')
        .get(id, target) as { account_incarnation: string } | undefined;
      if (!account) return undefined;
      if (expectedAccountIncarnation !== undefined && account.account_incarnation !== expectedAccountIncarnation) {
        throw new AccountScopeError('account_incarnation_mismatch');
      }
      this.database().prepare("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='account_deleted',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'").run(nowIso(), id, target);
      const deletedRequestStats = this.database().prepare('DELETE FROM proxy_request_stats WHERE identity=?').run(target).changes;
      this.database().prepare('DELETE FROM proxy_accounts WHERE enterprise_id=? AND identity=?').run(id, target);
      return { identity: target, deletedRequestStats };
    }).immediate();
  }

  async deleteAccountsBySsoUser(ssoUser: string, enterpriseId?: string): Promise<DeleteAccountsBySsoUserResult> {
    const id = this.enterpriseId(enterpriseId), target = ssoUser.trim();
    return this.database().transaction(() => {
      const accounts = this.database().prepare('SELECT identity FROM proxy_accounts WHERE enterprise_id=? AND lower(sso_user)=lower(?)')
        .all(id, target) as { identity: string }[];
      let deletedRequestStats = 0;
      for (const { identity } of accounts) {
        this.database().prepare("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='account_deleted',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'").run(nowIso(), id, identity);
        deletedRequestStats += this.database().prepare('DELETE FROM proxy_request_stats WHERE identity=?').run(identity).changes;
      }
      const deletedAccounts = this.database().prepare('DELETE FROM proxy_accounts WHERE enterprise_id=? AND lower(sso_user)=lower(?)').run(id, target).changes;
      return { ssoUser: target, matchedAccounts: accounts.length, deletedAccounts, deletedRequestStats };
    }).immediate();
  }

  async createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
    const id = this.enterpriseId(input.enterpriseId), now = nowIso();
    this.database().transaction(() => {
      const existing = this.database().prepare('SELECT enterprise_id,sso_user,gh_login FROM proxy_accounts WHERE identity=?').get(input.identity) as { enterprise_id: string; sso_user:string; gh_login:string|null } | undefined;
      if (existing && existing.enterprise_id !== id) throw new AccountScopeError('identity_enterprise_collision');
      if (existing && (existing.sso_user!==input.ssoUser || input.ghLogin!==undefined && existing.gh_login!==null && existing.gh_login!==input.ghLogin)) throw new AccountScopeError('account_subject_immutable');
      this.database().prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET sso_user=excluded.sso_user,
        gh_login=COALESCE(excluded.gh_login,proxy_accounts.gh_login),updated_at=excluded.updated_at WHERE proxy_accounts.enterprise_id=excluded.enterprise_id`)
        .run(id,randomUUID(),input.identity,input.ssoUser,input.ghLogin ?? null,input.copilotOauthStatus ?? 'missing',now,now);
    }).immediate();
    if (input.copilotOauthAttemptId) await this.beginCopilotOauthAuthorization(input.identity,input.copilotOauthAttemptId,id);
    return (await this.getAccount(input.identity,id))!;
  }

  async getCopilotOauthTokenImportFence(identity: string, enterpriseId?: string) {
    const id = this.enterpriseId(enterpriseId);
    return importFence(this.database().prepare(IMPORT_FENCE_SQL).get(id,identity,identity) as ImportFenceRow,id);
  }

  async importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord> {
    const id = this.enterpriseId(input.enterpriseId), now = nowIso();
    return this.database().transaction(() => {
      const current = importFence(this.database().prepare(IMPORT_FENCE_SQL).get(id,input.identity,input.identity) as ImportFenceRow,id);
      assertImportFence(input.expectedAccount,current);
      const existing = this.database().prepare('SELECT enterprise_id,sso_user,gh_login FROM proxy_accounts WHERE identity=?').get(input.identity) as { enterprise_id: string; sso_user:string; gh_login:string|null } | undefined;
      if (existing && existing.enterprise_id !== id) throw new AccountScopeError('identity_enterprise_collision');
      if (existing && (existing.sso_user!==input.ssoUser || input.ghLogin!==undefined && existing.gh_login!==null && existing.gh_login!==input.ghLogin)) throw new AccountScopeError('account_subject_immutable');
      this.database().prepare(`INSERT INTO proxy_accounts(enterprise_id,account_incarnation,identity,sso_user,gh_login,copilot_oauth_token,copilot_oauth_status,copilot_oauth_updated_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'valid',?,?,?) ON CONFLICT(identity) DO UPDATE SET sso_user=excluded.sso_user,gh_login=COALESCE(excluded.gh_login,proxy_accounts.gh_login),
        copilot_oauth_token=excluded.copilot_oauth_token,copilot_oauth_status='valid',copilot_oauth_updated_at=excluded.copilot_oauth_updated_at,
        copilot_oauth_attempt_id=NULL,updated_at=excluded.updated_at WHERE proxy_accounts.enterprise_id=excluded.enterprise_id`)
        .run(id,randomUUID(),input.identity,input.ssoUser,input.ghLogin ?? null,input.copilotOauthToken,now,now,now);
      this.database().prepare("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='token_imported',updated_at=? WHERE enterprise_id=? AND identity=? AND account_incarnation=? AND oauth_attempt_id=? AND status='active'")
        .run(now,id,input.identity,current.accountIncarnation,current.oauthAttemptId);
      return mapAccountRow(this.database().prepare('SELECT * FROM proxy_accounts WHERE enterprise_id=? AND identity=?').get(id,input.identity) as AccountRow);
    }).immediate();
  }

  /** Contract-1 callback has no incarnation proof and is deliberately not accepted. */
  async saveCopilotOauthToken(_identity: string,_oauthAttemptId: string,_token: string,_ghLogin?: string,_binding?: AuthorizationBinding): Promise<ProxyAccountRecord | undefined> {
    throw new AccountScopeError('authorization_binding_required');
  }

  async markCopilotOauthStatus(identity: string,status: CopilotOauthStatus,enterpriseId?: string): Promise<void> {
    this.database().prepare('UPDATE proxy_accounts SET copilot_oauth_status=?,updated_at=? WHERE enterprise_id=? AND identity=?')
      .run(status,nowIso(),this.enterpriseId(enterpriseId),identity);
  }

  async beginCopilotOauthAuthorization(identity: string,oauthAttemptId: string,enterpriseId?: string): Promise<boolean> {
    const id = this.enterpriseId(enterpriseId), account = await this.getAccount(identity,id);
    if (!account) return false;
    if (!account.ghLogin) throw new AccountScopeError('expected_github_subject_required');
    await this.beginAuthorizationAttempt({ enterpriseId:id,enterpriseRevision:resolveEnterpriseScope(this.registry!,id).enterpriseRevision,
      identity,accountIncarnation:account.accountIncarnation,oauthAttemptId,expectedGhLogin:account.ghLogin });
    return true;
  }

  async failCopilotOauthAuthorization(_identity: string,_oauthAttemptId: string,binding?: AuthorizationBinding): Promise<boolean> {
    if (!binding) throw new AccountScopeError('authorization_binding_required');
    await this.endAuthorizationAttempt(binding,'failed'); return true;
  }

  async invalidateCopilotOauthToken(identity: string,expectedToken: string,status: 'expired'|'failed',enterpriseId?: string): Promise<boolean> {
    const id = this.enterpriseId(enterpriseId), now = nowIso();
    return this.database().transaction(() => {
      const changed = this.database().prepare(`UPDATE proxy_accounts SET copilot_oauth_token=NULL,copilot_oauth_status=?,
        copilot_oauth_updated_at=?,copilot_oauth_attempt_id=NULL,updated_at=? WHERE enterprise_id=? AND identity=? AND copilot_oauth_token=? AND copilot_oauth_status='valid'`)
        .run(status,now,now,id,identity,expectedToken).changes > 0;
      if (changed) this.database().prepare("UPDATE proxy_authorization_attempts SET status='cancelled',failure_reason='token_invalidated',updated_at=? WHERE enterprise_id=? AND identity=? AND status='active'").run(now,id,identity);
      return changed;
    }).immediate();
  }

  async claimIdentityInitialization(identity: string,claimId: string,leaseSeconds: number,enterpriseId?: string): Promise<boolean> {
    const id = this.enterpriseId(enterpriseId), now = nowIso(), expires = new Date(Date.now()+leaseSeconds*1000).toISOString();
    return this.database().transaction(() => {
      const account = this.database().prepare('SELECT enterprise_id FROM proxy_accounts WHERE identity=?').get(identity) as { enterprise_id:string } | undefined;
      if (account && account.enterprise_id !== id) throw new AccountScopeError('identity_enterprise_collision');
      return this.database().prepare(`INSERT INTO proxy_identity_initializations(enterprise_id,identity,claim_id,lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET claim_id=excluded.claim_id,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
        WHERE proxy_identity_initializations.enterprise_id=excluded.enterprise_id AND proxy_identity_initializations.lease_expires_at<=excluded.updated_at`)
        .run(id,identity,claimId,expires,now,now).changes > 0;
    }).immediate();
  }

  async releaseIdentityInitialization(identity: string,claimId: string,enterpriseId?: string): Promise<boolean> {
    return this.database().prepare('DELETE FROM proxy_identity_initializations WHERE enterprise_id=? AND identity=? AND claim_id=?')
      .run(this.enterpriseId(enterpriseId),identity,claimId).changes > 0;
  }

  async getAuthorizationAttempt(enterpriseId: string,identity: string,oauthAttemptId: string): Promise<AuthorizationAttempt|undefined> {
    return getSqliteAttempt(this.database(),this.enterpriseId(enterpriseId),identity,oauthAttemptId);
  }

  private assertBindingRevision(binding: AuthorizationBinding): void {
    if (resolveEnterpriseScope(this.registry!,binding.enterpriseId).enterpriseRevision !== binding.enterpriseRevision) throw new AccountScopeError('enterprise_revision_mismatch');
  }

  async beginAuthorizationAttempt(binding: AuthorizationBinding): Promise<AuthorizationAttempt> {
    this.assertBindingRevision(binding);
    return beginSqliteAttempt(this.database(),binding);
  }

  async completeAuthorizationAttempt(binding: AuthorizationBinding,token: string,subject: VerifiedGithubSubject): Promise<AuthorizationResult> {
    this.assertBindingRevision(binding);
    return finishSqliteAttempt(this.database(),binding,'succeeded',token,subject);
  }

  async endAuthorizationAttempt(binding: AuthorizationBinding,status: 'failed'|'cancelled',reason?: string): Promise<AuthorizationResult> {
    this.assertBindingRevision(binding);
    return finishSqliteAttempt(this.database(),binding,status,undefined,undefined,reason);
  }

  async recordRequestStat(input: RecordRequestStatInput): Promise<void> {
    const enterprise = input.enterpriseId === undefined
      ? (this.database().prepare('SELECT enterprise_id FROM proxy_accounts WHERE identity=?').get(input.identity) as { enterprise_id: string } | undefined)?.enterprise_id ?? null
      : this.enterpriseId(input.enterpriseId);
    this.database()
      .prepare(`
        INSERT INTO proxy_request_stats (
          id, identity, gh_login, requested_at, path, model, success, failure_reason,
          input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens, caller_id, lease_id, enterprise_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newRequestId(),
        input.identity,
        input.ghLogin,
        nowIso(),
        input.path,
        input.model,
        input.success ? 1 : 0,
        input.failureReason,
        input.inputTokens,
        input.outputTokens,
        input.cacheTokens,
        input.cacheInputTokens,
        input.cacheWriteTokens,
        input.callerId,
        input.leaseId,
        enterprise,
      );
    this.pruneStats(input.identity);
  }

  async listRequestStats(identity?: string, limit = 100,enterpriseId?:string): Promise<ProxyRequestStatDto[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 1000));
    const rows=this.database().prepare(`SELECT s.* FROM proxy_request_stats s
      WHERE s.enterprise_id=? ${identity?'AND s.identity=?':''} ORDER BY s.requested_at DESC,s.id DESC LIMIT ?`)
      .all(this.enterpriseId(enterpriseId),...(identity?[identity]:[]),boundedLimit);
    return (rows as StatRow[]).map(mapStatRow);
  }

  async pageRequestStats(query: RequestStatListQuery): Promise<PageResponse<ProxyRequestStatDto>> {
    const parsed = requestStatsPageSql({ ...query, enterpriseId: this.enterpriseId(query.enterpriseId) });
    return this.database().transaction(() => {
      const total = (this.database().prepare(`SELECT COUNT(*) AS n FROM proxy_request_stats s ${parsed.where}`)
        .get(...parsed.values) as { n: number }).n;
      const rows = this.database().prepare(`SELECT s.* FROM proxy_request_stats s ${parsed.where}
        ORDER BY s.requested_at DESC,s.id DESC LIMIT ? OFFSET ?`)
        .all(...parsed.values, parsed.pageSize, (parsed.page - 1) * parsed.pageSize) as StatRow[];
      return pageResponse(rows.map(mapStatRow), total, parsed.page, parsed.pageSize);
    })();
  }

  async pruneAllRequestStats(): Promise<void> {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE id IN (
          SELECT id
          FROM (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY identity
                ORDER BY requested_at DESC, id DESC
              ) AS retention_rank
            FROM proxy_request_stats
          )
          WHERE retention_rank > ?
        )
      `)
      .run(this.requestStatsPerAccountLimit);
  }

  private pruneStats(identity: string): void {
    this.database()
      .prepare(`
        DELETE FROM proxy_request_stats
        WHERE identity = ?
          AND id NOT IN (
            SELECT id FROM proxy_request_stats
            WHERE identity = ?
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
          )
      `)
      .run(identity, identity, this.requestStatsPerAccountLimit);
  }

  private database(): Database.Database {
    if (!this.db) throw new Error('SQLite storage has not been initialized.');
    return this.db;
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
    copilotOauthUpdatedAt: row.copilot_oauth_updated_at ?? undefined,
    copilotOauthAttemptId: row.copilot_oauth_attempt_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStatRow(row: StatRow): ProxyRequestStatDto {
  return {
    enterpriseId: row.enterprise_id ?? undefined,
    id: row.id,
    identity: row.identity,
    callerId: row.caller_id ?? undefined,
    leaseId: row.lease_id ?? undefined,
    ghLogin: row.gh_login,
    requestedAt: row.requested_at,
    path: row.path,
    model: row.model,
    success: row.success === 1,
    failureReason: row.failure_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    cacheInputTokens: row.cache_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
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
