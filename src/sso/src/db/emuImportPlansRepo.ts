import type {
  EnterpriseId,
  ImportEmuPlanDto,
  ImportEmuPlanStatus,
  ImportEmuPlanSummary,
  ImportEmuUserRow,
  ImportEmuUserStatus,
  PageResponse,
} from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import type Database from 'better-sqlite3';
import { getDb } from './connection.js';

export type EmuImportAction = 'create' | 'update' | 'skip';

export interface EmuImportPlanRowRecord extends ImportEmuUserRow {
  rowIndex: number;
  action?: EmuImportAction;
}

export interface NewEmuImportPlan {
  id: string;
  ssoUser?: string;
  rows: Omit<EmuImportPlanRowRecord, 'rowIndex'>[];
}

export interface EmuImportPlanRowsQuery {
  status?: ImportEmuUserStatus;
  page?: number;
  pageSize?: number;
}

interface PlanRow {
  id: string;
  sso_user?: string;
  status: ImportEmuPlanStatus;
  created_at: string;
  updated_at: string;
  applied_at?: string;
}

interface RowRecord {
  plan_id: string;
  row_index: number;
  sso_user: string;
  email?: string;
  gh_login?: string;
  gh_scim_id?: string;
  emu_status?: ImportEmuUserRow['emuStatus'];
  copilot_seat_status?: ImportEmuUserRow['copilotSeatStatus'];
  copilot_seat_pending_cancellation_date?: string | null;
  status: ImportEmuUserStatus;
  detail: string;
  action?: EmuImportAction;
}

/** Rows are reachable only through a plan of the same enterprise. */
const PLAN_IN_ENTERPRISE = `
  EXISTS (
    SELECT 1
    FROM sso_emu_import_plans p
    WHERE p.id = sso_emu_import_plan_rows.plan_id
      AND p.enterprise_id = ?
  )
`;

export function createEmuImportPlanRecord(enterpriseId: EnterpriseId, input: NewEmuImportPlan): ImportEmuPlanDto {
  const db = getDb();
  db.transaction(() => {
    insertPlan(db, enterpriseId, input);
    insertPlanRows(db, input);
  })();
  return requireEmuImportPlan(enterpriseId, input.id);
}

export function requireEmuImportPlan(enterpriseId: EnterpriseId, planId: string): ImportEmuPlanDto {
  const row = getDb().prepare(`
    SELECT *
    FROM sso_emu_import_plans
    WHERE enterprise_id = ?
      AND id = ?
  `).get(enterpriseId, planId) as PlanRow | undefined;
  if (!row) throw new Error(`EMU import plan "${planId}" was not found.`);
  return toPlanDto(row);
}

export function listEmuImportPlanRows(
  enterpriseId: EnterpriseId,
  planId: string,
  query: EmuImportPlanRowsQuery = {},
): PageResponse<ImportEmuUserRow> {
  requireEmuImportPlan(enterpriseId, planId);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 100), 500));
  const where = query.status ? 'plan_id = ? AND status = ?' : 'plan_id = ?';
  const args = query.status ? [planId, query.status] : [planId];
  const total = (getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM sso_emu_import_plan_rows
    WHERE ${where}
  `).get(...args) as { count: number }).count;
  const rows = getDb().prepare(`
    SELECT *
    FROM sso_emu_import_plan_rows
    WHERE ${where}
    ORDER BY row_index ASC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize) as RowRecord[];
  return pageResponse(rows.map(toImportRow), total, page, pageSize);
}

export function listPendingEmuImportPlanRows(enterpriseId: EnterpriseId, planId: string): EmuImportPlanRowRecord[] {
  requireEmuImportPlan(enterpriseId, planId);
  const rows = getDb().prepare(`
    SELECT *
    FROM sso_emu_import_plan_rows
    WHERE plan_id = ?
      AND status IN ('pending_create', 'pending_update')
    ORDER BY row_index ASC
  `).all(planId) as RowRecord[];
  return rows.map(toPlanRowRecord);
}

export function updateEmuImportPlanRow(enterpriseId: EnterpriseId, planId: string, row: EmuImportPlanRowRecord): void {
  getDb().prepare(`
    UPDATE sso_emu_import_plan_rows
    SET email = ?, gh_login = ?, gh_scim_id = ?, emu_status = ?, copilot_seat_status = ?,
        copilot_seat_pending_cancellation_date = ?, status = ?, detail = ?, action = ?, updated_at = ?
    WHERE plan_id = ?
      AND row_index = ?
      AND ${PLAN_IN_ENTERPRISE}
  `).run(
    row.email,
    row.ghLogin,
    row.ghScimId,
    row.emuStatus,
    row.copilotSeatStatus,
    row.copilotSeatPendingCancellationDate,
    row.status,
    row.detail,
    row.action,
    nowIso(),
    planId,
    row.rowIndex,
    enterpriseId,
  );
}

export function markEmuImportPlanApplied(enterpriseId: EnterpriseId, planId: string): ImportEmuPlanDto {
  const now = nowIso();
  getDb().prepare(`
    UPDATE sso_emu_import_plans
    SET status = 'applied', applied_at = COALESCE(applied_at, ?), updated_at = ?
    WHERE enterprise_id = ?
      AND id = ?
  `).run(now, now, enterpriseId, planId);
  return requireEmuImportPlan(enterpriseId, planId);
}

export function deleteEmuImportPlanRecord(enterpriseId: EnterpriseId, planId: string): boolean {
  requireEmuImportPlan(enterpriseId, planId);
  const db = getDb();
  return db.transaction(() => {
    db.prepare(`
      DELETE FROM sso_emu_import_plan_rows
      WHERE plan_id = ?
    `).run(planId);
    const result = db.prepare(`
      DELETE FROM sso_emu_import_plans
      WHERE enterprise_id = ?
        AND id = ?
    `).run(enterpriseId, planId);
    return result.changes > 0;
  })();
}

function insertPlan(db: Database.Database, enterpriseId: EnterpriseId, input: NewEmuImportPlan): void {
  const now = nowIso();
  db.prepare(`
    INSERT INTO sso_emu_import_plans (enterprise_id, id, sso_user, status, created_at, updated_at)
    VALUES (?, ?, ?, 'planned', ?, ?)
  `).run(enterpriseId, input.id, input.ssoUser, now, now);
}

function insertPlanRows(db: Database.Database, input: NewEmuImportPlan): void {
  const now = nowIso();
  const insertRow = db.prepare(`
    INSERT INTO sso_emu_import_plan_rows (
      plan_id, row_index, sso_user, email, gh_login, gh_scim_id, emu_status, copilot_seat_status,
      copilot_seat_pending_cancellation_date, status, detail, action, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  input.rows.forEach((row, index) => {
    insertRow.run(
      input.id,
      index + 1,
      row.ssoUser,
      row.email,
      row.ghLogin,
      row.ghScimId,
      row.emuStatus,
      row.copilotSeatStatus,
      row.copilotSeatPendingCancellationDate,
      row.status,
      row.detail,
      row.action,
      now,
      now,
    );
  });
}

function toPlanDto(row: PlanRow): ImportEmuPlanDto {
  return {
    planId: row.id,
    ssoUser: row.sso_user,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    summary: summarizeEmuImportPlan(row.id),
  };
}

function summarizeEmuImportPlan(planId: string): ImportEmuPlanSummary {
  const rows = getDb().prepare(`
    SELECT status, COUNT(*) AS count
    FROM sso_emu_import_plan_rows
    WHERE plan_id = ?
    GROUP BY status
  `).all(planId) as { status: ImportEmuUserStatus; count: number }[];
  const counts = new Map(rows.map((row) => [row.status, row.count]));
  const pendingCreate = counts.get('pending_create') ?? 0;
  const pendingUpdate = counts.get('pending_update') ?? 0;
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    pendingCreate,
    pendingUpdate,
    created: counts.get('created') ?? 0,
    updated: counts.get('updated') ?? 0,
    skipped: counts.get('skipped') ?? 0,
    conflict: counts.get('conflict') ?? 0,
    failed: counts.get('failed') ?? 0,
    actionable: pendingCreate + pendingUpdate,
  };
}

function toImportRow(row: RowRecord): ImportEmuUserRow {
  return {
    rowIndex: row.row_index,
    ssoUser: row.sso_user,
    email: row.email,
    ghLogin: row.gh_login,
    ghScimId: row.gh_scim_id,
    emuStatus: row.emu_status,
    copilotSeatStatus: row.copilot_seat_status,
    copilotSeatPendingCancellationDate: row.copilot_seat_pending_cancellation_date ?? undefined,
    status: row.status,
    detail: row.detail,
  };
}

function toPlanRowRecord(row: RowRecord): EmuImportPlanRowRecord {
  return {
    ...toImportRow(row),
    rowIndex: row.row_index,
    action: row.action,
  };
}
