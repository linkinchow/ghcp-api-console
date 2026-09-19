// The final dispatch claim remains authoritative; this filter only avoids work
// that cannot progress and prioritizes consumers that release scarce capacity.
export const LOGIN_CAPACITY_SQL = `(p.stage <> 'oauth-starting' OR
  (SELECT COUNT(*) FROM user_pool_accounts occupied WHERE occupied.stage IN ('oauth-dispatch','oauth-wait')) < ?)`;

const PROGRESS_ORDER = `CASE p.stage
  WHEN 'warmup' THEN 0 WHEN 'ready' THEN 0
  WHEN 'oauth-wait' THEN 1 WHEN 'oauth-dispatch' THEN 2
  WHEN 'oauth-starting' THEN 3 WHEN 'synced' THEN 4
  WHEN 'seat-assigning' THEN 5 WHEN 'scim-synced' THEN 6
  WHEN 'scim-syncing' THEN 7 WHEN 'sso-created' THEN 8
  WHEN 'sso-creating' THEN 9 ELSE 10 END`;

export class PendingSelection {
  private selections = 0;

  orderSql(): string {
    // One in four selections uses age alone, so continuously arriving downstream
    // work cannot starve earlier stages. No persisted ownership depends on this.
    return `${this.selections === 3 ? '' : `${PROGRESS_ORDER}, `}p.retry_at, p.updated_at, p.ordinal`;
  }

  selected(): void { this.selections = (this.selections + 1) % 4; }
}
