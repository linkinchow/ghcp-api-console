import type {
  CopilotOauthStatus,
  AuthorizationBinding,
  DeleteProxyAccountResult,
  PageResponse,
  ProxyAccountDto,
} from '@ghcp/shared';
import { getStorage, initializeStorage } from './connection.js';
import type {
  AccountListQuery,
  CreateAccountInput,
  DeleteAccountsBySsoUserResult,
  ImportCopilotOauthTokenInput,
  ProxyAccountRecord,
} from './storageTypes.js';

export type {
  AccountListQuery,
  DeleteAccountsBySsoUserResult,
  ProxyAccountRecord,
} from './storageTypes.js';

export async function listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
  await initializeStorage();
  return getStorage().listAccounts(query);
}

export async function getAccount(identity: string, enterpriseId?: string): Promise<ProxyAccountRecord | undefined> {
  await initializeStorage();
  return getStorage().getAccount(identity, enterpriseId);
}

export async function deleteAccount(identity: string, enterpriseId?: string, expectedAccountIncarnation?: string): Promise<DeleteProxyAccountResult | undefined> {
  await initializeStorage();
  return getStorage().deleteAccount(identity, enterpriseId, expectedAccountIncarnation);
}

export async function deleteAccountsBySsoUser(ssoUser: string, enterpriseId?: string): Promise<DeleteAccountsBySsoUserResult> {
  await initializeStorage();
  return getStorage().deleteAccountsBySsoUser(ssoUser, enterpriseId);
}

export async function createAccount(input: CreateAccountInput): Promise<ProxyAccountRecord> {
  await initializeStorage();
  return getStorage().createAccount(input);
}

export async function getCopilotOauthTokenImportFence(identity: string, enterpriseId?: string) {
  await initializeStorage();
  return getStorage().getCopilotOauthTokenImportFence(identity,enterpriseId);
}

export async function importCopilotOauthToken(input: Omit<ImportCopilotOauthTokenInput,'expectedAccount'> & Partial<Pick<ImportCopilotOauthTokenInput,'expectedAccount'>>): Promise<ProxyAccountRecord> {
  await initializeStorage();
  // Trusted in-process callers have no external validation gap. CSV validators
  // must pass their earlier snapshot instead of recapturing at write time.
  const storage = getStorage();
  const expectedAccount = input.expectedAccount ?? await storage.getCopilotOauthTokenImportFence(input.identity,input.enterpriseId);
  return storage.importCopilotOauthToken({...input,expectedAccount});
}

export async function saveCopilotOauthToken(
  identity: string,
  oauthAttemptId: string,
  copilotOauthToken: string,
  ghLogin?: string,
): Promise<ProxyAccountRecord | undefined> {
  await initializeStorage();
  return getStorage().saveCopilotOauthToken(identity, oauthAttemptId, copilotOauthToken, ghLogin);
}

export async function markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
  await initializeStorage();
  await getStorage().markCopilotOauthStatus(identity, status);
}

export async function beginCopilotOauthAuthorization(identity: string, oauthAttemptId: string, enterpriseId?: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().beginCopilotOauthAuthorization(identity, oauthAttemptId, enterpriseId);
}

export async function failCopilotOauthAuthorization(identity: string, oauthAttemptId: string, binding?: AuthorizationBinding): Promise<boolean> {
  await initializeStorage();
  return getStorage().failCopilotOauthAuthorization(identity, oauthAttemptId, binding);
}

export async function invalidateCopilotOauthToken(
  identity: string,
  expectedToken: string,
  status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
): Promise<boolean> {
  await initializeStorage();
  return getStorage().invalidateCopilotOauthToken(identity, expectedToken, status);
}

export async function claimIdentityInitialization(
  identity: string,
  claimId: string,
  leaseSeconds: number,
): Promise<boolean> {
  await initializeStorage();
  return getStorage().claimIdentityInitialization(identity, claimId, leaseSeconds);
}

export async function releaseIdentityInitialization(identity: string, claimId: string): Promise<boolean> {
  await initializeStorage();
  return getStorage().releaseIdentityInitialization(identity, claimId);
}

export function toAccountDto(account: ProxyAccountRecord): ProxyAccountDto {
  return {
    enterpriseId: account.enterpriseId,
    accountIncarnation: account.accountIncarnation,
    identity: account.identity,
    ssoUser: account.ssoUser,
    ghLogin: account.ghLogin,
    copilotOauthStatus: account.copilotOauthStatus,
    copilotOauthUpdatedAt: account.copilotOauthUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
