import type {
  CopilotOauthStatus,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyRequestStatDto,
  AuthorizationBinding,
  AuthorizationOutcome,
  EnterprisePoolPolicyRecord,
} from '@ghcp/shared';

export interface AuthorizationAttempt {
  binding: AuthorizationBinding;
  status: AuthorizationOutcome;
  /** Private persistence evidence; never serialize this record directly to HTTP. */
  resultFingerprint?: string;
  resultSubject?: VerifiedGithubSubject;
  failureReason?: string;
}
export interface AuthorizationResult {
  binding: AuthorizationBinding;
  status: Exclude<AuthorizationOutcome, 'active'>;
  outcome: 'applied' | 'already-succeeded' | 'already-failed' | 'already-cancelled';
}
export interface VerifiedGithubSubject { login: string; id: string }
export class AccountScopeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AccountScopeError'; }
}


export interface ProxyAccountRecord {
  enterpriseId: string;
  accountIncarnation: string;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  copilotOauthAttemptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountListQuery {
  enterpriseId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'copilotOauthStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface CreateAccountInput {
  enterpriseId?: string;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthStatus?: CopilotOauthStatus;
  copilotOauthAttemptId?: string;
}

export interface CopilotOauthTokenImportFence {
  /** Null proves absence; undefined must never mean absence. */
  accountIncarnation: string | null;
  oauthAttemptId: string | null;
  /** Immutable ledger size also detects a competing attempt that already finished. */
  authorizationAttempts: number;
}

export interface ImportCopilotOauthTokenInput {
  enterpriseId?: string;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
  /** External validators must capture this before their first external await. */
  expectedAccount: CopilotOauthTokenImportFence;
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export interface RequestStatListQuery {
  enterpriseId: string;
  page?: number;
  pageSize?: number;
  q?: string;
  identity?: string;
  model?: string;
  success?: boolean;
}

export interface RecordRequestStatInput {
  enterpriseId?: string;
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

export interface ProxyStorage {
  userPool(options: PoolConfig): Awaitable<PoolStore>;
  initialize(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;

  enterprisePolicies(): Promise<EnterprisePoolPolicyRecord[]>;
  listAccounts(query?: AccountListQuery): Promise<PageResponse<ProxyAccountRecord>>;
  getAccount(identity: string, enterpriseId?: string): Promise<ProxyAccountRecord | undefined>;
  deleteAccount(identity: string, enterpriseId?: string, expectedAccountIncarnation?: string): Promise<DeleteProxyAccountResult | undefined>;
  deleteAccountsBySsoUser(ssoUser: string, enterpriseId?: string): Promise<DeleteAccountsBySsoUserResult>;
  createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord>;
  getCopilotOauthTokenImportFence(identity: string, enterpriseId?: string): Promise<CopilotOauthTokenImportFence>;
  importCopilotOauthToken(input: ImportCopilotOauthTokenInput): Promise<ProxyAccountRecord>;
  saveCopilotOauthToken(
    identity: string,
    oauthAttemptId: string,
    copilotOauthToken: string,
    ghLogin?: string,
    binding?: AuthorizationBinding,
  ): Promise<ProxyAccountRecord | undefined>;
  markCopilotOauthStatus(identity: string, status: CopilotOauthStatus, enterpriseId?: string): Promise<void>;
  beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, enterpriseId?: string): Promise<boolean>;
  failCopilotOauthAuthorization(identity: string, oauthAttemptId: string, binding?: AuthorizationBinding): Promise<boolean>;
  invalidateCopilotOauthToken(
    identity: string,
    expectedToken: string,
    status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
    enterpriseId?: string,
  ): Promise<boolean>;

  claimIdentityInitialization(identity: string, claimId: string, leaseSeconds: number, enterpriseId?: string): Promise<boolean>;
  releaseIdentityInitialization(identity: string, claimId: string, enterpriseId?: string): Promise<boolean>;

  getAuthorizationAttempt(enterpriseId: string, identity: string, oauthAttemptId: string): Promise<AuthorizationAttempt | undefined>;
  beginAuthorizationAttempt(binding: AuthorizationBinding): Promise<AuthorizationAttempt>;
  completeAuthorizationAttempt(binding: AuthorizationBinding, token: string, subject: VerifiedGithubSubject): Promise<AuthorizationResult>;
  endAuthorizationAttempt(binding: AuthorizationBinding, status: 'failed' | 'cancelled', reason?: string): Promise<AuthorizationResult>;

  recordRequestStat(input: RecordRequestStatInput): Promise<void>;
  listRequestStats(identity?: string, limit?: number,enterpriseId?:string): Promise<ProxyRequestStatDto[]>;
  pageRequestStats(query: RequestStatListQuery): Promise<PageResponse<ProxyRequestStatDto>>;
  pruneAllRequestStats(): Promise<void>;
}
