import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyRequestStatDto,
  ManagementQuery,
  ManagementSummary,
  EnterpriseId,
  EnterpriseLifecycleState,
} from '@ghcp/shared';

export interface ProxyAccountRecord {
  identity: string;
  enterpriseId: EnterpriseId;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  copilotOauthAttemptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountListQuery extends ManagementQuery { }

export interface CreateAccountInput {
  enterpriseId: EnterpriseId;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus?: CopilotOauthStatus;
  copilotOauthAttemptId?: string;
}

export interface ImportCopilotOauthTokenInput {
  enterpriseId: EnterpriseId;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export interface RecordRequestStatInput {
  enterpriseId: EnterpriseId;
  identity: string;
  callerId?: string;
  leaseId?: string;
  ghLogin?: string;
  path: ProxyRequestStatDto['path'];
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

import type { PoolConfig } from '../userPool/config.js';
import type { Awaitable, PoolStore } from '../userPool/storage.js';

/** Reads inside one consistent snapshot; like the storage methods, every read is scoped to an enterprise. */
export type SnapshotReader = Pick<ProxyStorage, 'listAccounts' | 'listRequestStatsPage'>;

/**
 * Enterprise-scoped reads take the enterprise first (design §5.1). Identity-addressed methods stay global: an
 * identity is a global key, and its record names its enterprise.
 */
export interface ProxyStorage {
  userPool(options: PoolConfig): Awaitable<PoolStore>;
  withReadSnapshot<T>(read: (reader: SnapshotReader) => Promise<T>): Promise<T>;
  initialize(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  listAccounts(enterpriseId: EnterpriseId, query?: AccountListQuery): Promise<PageResponse<ProxyAccountRecord>>;
  summarizeAccounts(enterpriseId: EnterpriseId): Promise<ManagementSummary>;
  getAccount(identity: string): Promise<ProxyAccountRecord | undefined>;
  deleteAccount(identity: string): Promise<DeleteProxyAccountResult | undefined>;
  deleteAccountsBySsoUser(enterpriseId: EnterpriseId, ssoUser: string): Promise<DeleteAccountsBySsoUserResult>;
  createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord>;
  importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord>;
  saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
  ): Promise<ProxyAccountRecord | undefined>;
  markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void>;
  /**
   * Switches the account to a new authorization attempt. When `expectedAttemptId` is given (a string
   * or `null`), the switch only happens if the account still points at that attempt, so a stale
   * caller cannot supersede an authorization it does not know about; `undefined` forces the switch.
   */
  beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, expectedAttemptId?: string | null): Promise<boolean>;
  failCopilotOauthAuthorization(identity: string, oauthAttemptId: string): Promise<boolean>;
  invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
  ): Promise<boolean>;

  claimIdentityInitialization(
    enterpriseId: EnterpriseId,
    identity: string,
    claimId: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean>;

  recordRequestStat(input: RecordRequestStatInput): Promise<void>;
  listRequestStats(enterpriseId: EnterpriseId, identity?: string, limit?: number): Promise<ProxyRequestStatDto[]>;
  listRequestStatsPage(enterpriseId: EnterpriseId, query?: ManagementQuery): Promise<PageResponse<ProxyRequestStatDto>>;
  pruneAllRequestStats(): Promise<void>;

  listEnterprises(): Promise<ProxyEnterpriseRecord[]>;
}

/** One `proxy_enterprises` row (design §4.2). */
export interface ProxyEnterpriseRecord {
  id: EnterpriseId;
  state: EnterpriseLifecycleState;
  maxAccounts: number;
  /** N_e: every pool member of the enterprise, maintained incrementally. */
  inventoryCount: number;
  policyVersion: number;
  profileFingerprint: string;
  createdAt: number;
  updatedAt: number;
}
