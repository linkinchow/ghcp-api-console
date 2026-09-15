export type PoolList = 'accounts' | 'leases' | 'events';
export interface PoolPageQuery {
  page: number;
  pageSize: number;
  q?: string;
  state?: string;
}
export interface PoolPage {
  items: unknown[];
  total: number;
  page: number;
  pageSize: number;
}

export function poolPageSql(kind: PoolList, input: PoolPageQuery, now: number): {
  countSql: string; itemsSql: string; values: unknown[];
} {
  const { page, pageSize, q = '', state = '' } = input;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || q.length > 255) {
    throw new Error('Invalid pool pagination');
  }
  const held = `(SELECT COUNT(*) FROM user_pool_holds h WHERE h.lease_id = l.lease_id AND h.expires_at > ${now})
    + (SELECT COUNT(*) FROM user_pool_catalog_holds h WHERE h.member_identity = p.identity AND h.expires_at > ${now})`;
  const displayState = `CASE WHEN p.state <> 'ready' THEN p.state WHEN l.phase IS NOT NULL THEN l.phase
    WHEN (${held}) > 0 THEN 'catalog' ELSE 'ready_idle' END`;
  const definitions = {
    accounts: {
      from: 'user_pool_accounts p JOIN proxy_accounts a ON a.identity=p.identity LEFT JOIN user_pool_leases l ON l.member_identity=p.identity',
      select: `p.*, a.gh_login, a.copilot_oauth_status, l.caller_id, l.phase, l.expires_at, (${held}) AS active_requests`,
      search: ['p.identity', 'a.gh_login', 'l.caller_id'], state: displayState, order: 'p.ordinal',
      states: ['ready_idle', 'active', 'provisional', 'provisioning', 'cooling', 'failed', 'disabled', 'catalog'],
    },
    leases: {
      from: 'user_pool_leases l JOIN user_pool_accounts p ON p.identity=l.member_identity',
      select: `l.*, (${held}) AS active_requests`, search: ['l.member_identity', 'l.caller_id', 'l.lease_id'],
      state: 'l.phase', order: 'l.assigned_at DESC, l.lease_id', states: ['active', 'provisional'],
    },
    events: {
      from: 'user_pool_events e', select: 'e.*',
      search: ['e.action', 'e.identity', 'e.caller_id', 'e.lease_id', 'e.detail'],
      state: '', order: 'e.id DESC', states: [],
    },
  };
  const d = definitions[kind];
  if (!d || state && !(d.states as string[]).includes(state)) throw new Error('Invalid pool state');
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (q) {
    const pattern = `%${q.replace(/[!%_]/g, '!$&')}%`;
    conditions.push(`(${d.search.map(column => `LOWER(${column}) LIKE LOWER(?) ESCAPE '!'`).join(' OR ')})`);
    values.push(...d.search.map(() => pattern));
  }
  if (state) { conditions.push(`(${d.state}) = ?`); values.push(state); }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  return {
    countSql: `SELECT COUNT(*) AS total FROM ${d.from}${where}`,
    itemsSql: `SELECT ${d.select} FROM ${d.from}${where} ORDER BY ${d.order} LIMIT ? OFFSET ?`,
    values,
  };
}
