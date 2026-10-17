/** Proxy pool lifecycle (§5.8): draft → active → draining, and draining → active on resume. */
export type EnterpriseLifecycleState = 'draft' | 'active' | 'draining';

export type EnterpriseService = 'proxy' | 'sso' | 'login';

/** One row of `GET /internal/enterprises` from SSO or Login (§3.8); `null` when the service does not know. */
export interface EnterpriseServiceReadinessDto {
  id: string;
  githubBaseUrl: string | null;
  slug: string | null;
  shortcode: string | null;
  configured: boolean;
  blockers: string[];
}

/** Proxy's cross-service comparison, cached per replica for 60 seconds and never persisted. */
export interface EnterpriseReadinessDto {
  enterpriseId: string;
  ready: boolean;
  /** Mismatches and service blockers, e.g. `sso_missing`, `github_base_url_mismatch`. */
  blockers: string[];
  services: Record<EnterpriseService, EnterpriseServiceReadinessDto | null>;
  checkedAt: string;
}

export interface EnterprisePoolPolicyDto {
  enterpriseId: string;
  state: EnterpriseLifecycleState;
  /** C_e. */
  maxAccounts: number;
  /** N_e: every registered member, including failed and disabled ones. */
  inventory: number;
  /** CAS version for `PATCH /api/enterprises/:id/pool-policy`. */
  policyVersion: number;
  updatedAt: string;
}

export interface UpdateEnterprisePoolPolicyRequest {
  expectedVersion: number;
  maxAccounts?: number;
  state?: EnterpriseLifecycleState;
}

export interface EnterpriseSummaryDto {
  id: string;
  displayName: string;
  githubBaseUrl: string;
  slug: string | null;
  /** Empty for GHE.com enterprises. */
  shortcode: string;
  /** `null` outside pool mode. */
  pool: EnterprisePoolPolicyDto | null;
  readiness: EnterpriseReadinessDto | null;
}
