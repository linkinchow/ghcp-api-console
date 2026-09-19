import { enterpriseId } from '@ghcp/shared';
import { AccountScopeError, type RequestStatListQuery } from './storageTypes.js';

export function requestStatsPageSql(input: RequestStatListQuery): {
  where: string; values: Array<string | number>; page: number; pageSize: number;
} {
  const page = input.page ?? 1, pageSize = input.pageSize ?? 25;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !Number.isSafeInteger(pageSize)
    || pageSize < 1 || pageSize > 100 || input.success !== undefined && typeof input.success !== 'boolean') {
    throw new AccountScopeError('invalid_request_stats_query');
  }
  const conditions = ['s.enterprise_id=?'];
  const values: Array<string | number> = [enterpriseId(input.enterpriseId)];
  for (const field of ['identity', 'model'] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || !input[field] || input[field].length > 255) {
      throw new AccountScopeError('invalid_request_stats_query');
    }
    conditions.push(`s.${field}=?`); values.push(input[field]);
  }
  if (input.success !== undefined) { conditions.push('s.success=?'); values.push(input.success ? 1 : 0); }
  if (input.q !== undefined) {
    if (typeof input.q !== 'string' || input.q.length > 255) throw new AccountScopeError('invalid_request_stats_query');
    if (input.q) {
      const columns = ['s.identity', 's.gh_login', 's.model', 's.caller_id', 's.failure_reason'];
      const pattern = `%${input.q.replace(/[!%_]/g, '!$&')}%`;
      conditions.push(`(${columns.map(column => `LOWER(${column}) LIKE LOWER(?) ESCAPE '!'`).join(' OR ')})`);
      values.push(...columns.map(() => pattern));
    }
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, values, page, pageSize };
}
