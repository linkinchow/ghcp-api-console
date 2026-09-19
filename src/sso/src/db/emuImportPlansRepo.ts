import type { EnterpriseScope, ImportEmuPlanDto, ImportEmuPlanStatus, ImportEmuPlanSummary, ImportEmuUserRow, ImportEmuUserStatus, PageResponse } from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import { getScopeProfile } from '../enterprise.js';
import { getDb } from './connection.js';

export type EmuImportAction = 'create' | 'update' | 'skip';

export interface EmuImportPlanRowRecord extends ImportEmuUserRow {
  rowIndex: number;
  action?: EmuImportAction;
  expectedUserIncarnation?: string;
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
  expected_user_incarnation?: string;
  plan_id: string;
  row_index: number;
  sso_user: string;
  email?: string;
  gh_login?: string;
  gh_scim_id?: string;
  emu_status?: ImportEmuUserRow['emuStatus'];
  copilot_seat_status?: ImportEmuUserRow['copilotSeatStatus'];
  status: ImportEmuUserStatus;
  detail: string;
  action?: EmuImportAction;
}

export function createEmuImportPlanRecord(input: { id: string; ssoUser?: string; rows: Omit<EmuImportPlanRowRecord, 'rowIndex'>[] }, scope: EnterpriseScope): ImportEmuPlanDto {
  getScopeProfile(scope);
  const now = nowIso();
  getDb().transaction(() => {
    getDb()
      .prepare('INSERT INTO sso_emu_import_plans (enterprise_id, id, sso_user, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(scope.enterpriseId, input.id, input.ssoUser, 'planned', now, now);
    const insertRow = getDb().prepare(`
      INSERT INTO sso_emu_import_plan_rows (
        enterprise_id, plan_id, row_index, sso_user, email, gh_login, gh_scim_id, emu_status, copilot_seat_status,
        status, detail, action, expected_user_incarnation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    input.rows.forEach((row, index) => {
      insertRow.run(
        scope.enterpriseId,
        input.id,
        index + 1,
        row.ssoUser,
        row.email,
        row.ghLogin,
        row.ghScimId,
        row.emuStatus,
        row.copilotSeatStatus,
        row.status,
        row.detail,
        row.action,
        row.expectedUserIncarnation,
        now,
        now,
      );
    });
  })();
  return requireEmuImportPlan(input.id, scope);
}

export function requireEmuImportPlan(planId: string, scope: EnterpriseScope): ImportEmuPlanDto {
  getScopeProfile(scope);
  const row = getDb().prepare('SELECT * FROM sso_emu_import_plans WHERE enterprise_id = ? AND id = ?').get(scope.enterpriseId, planId) as PlanRow | undefined;
  if (!row) throw new Error(`EMU import plan "${planId}" was not found.`);
  return toPlanDto(row, scope);
}

export function listEmuImportPlanRows(planId: string, query: { status?: ImportEmuUserStatus; page?: number; pageSize?: number }, scope: EnterpriseScope): PageResponse<ImportEmuUserRow> {
  requireEmuImportPlan(planId, scope);
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 100), 500));
  const where = query.status ? 'WHERE enterprise_id = ? AND plan_id = ? AND status = ?' : 'WHERE enterprise_id = ? AND plan_id = ?';
  const args = query.status ? [scope.enterpriseId, planId, query.status] : [scope.enterpriseId, planId];
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM sso_emu_import_plan_rows ${where}`).get(...args) as { count: number }).count;
  const rows = getDb()
    .prepare(`SELECT * FROM sso_emu_import_plan_rows ${where} ORDER BY row_index ASC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as RowRecord[];
  return pageResponse(rows.map(toImportRow), total, page, pageSize);
}

export function listPendingEmuImportPlanRows(planId: string, scope: EnterpriseScope): EmuImportPlanRowRecord[] {
  requireEmuImportPlan(planId, scope);
  const rows = getDb()
    .prepare(`
      SELECT * FROM sso_emu_import_plan_rows
      WHERE enterprise_id = ? AND plan_id = ? AND status IN ('pending_create', 'pending_update')
      ORDER BY row_index ASC
    `)
    .all(scope.enterpriseId, planId) as RowRecord[];
  return rows.map(toPlanRowRecord);
}

export function updateEmuImportPlanRow(planId: string, row: EmuImportPlanRowRecord, scope: EnterpriseScope): void {
  getScopeProfile(scope);
  getDb()
    .prepare(`
      UPDATE sso_emu_import_plan_rows
      SET email = ?, gh_login = ?, gh_scim_id = ?, emu_status = ?, copilot_seat_status = ?,
          status = ?, detail = ?, action = ?, updated_at = ?
      WHERE enterprise_id = ? AND plan_id = ? AND row_index = ?
    `)
    .run(
      row.email,
      row.ghLogin,
      row.ghScimId,
      row.emuStatus,
      row.copilotSeatStatus,
      row.status,
      row.detail,
      row.action,
      nowIso(),
      scope.enterpriseId,
      planId,
      row.rowIndex,
    );
}

export function markEmuImportPlanApplied(planId: string, scope: EnterpriseScope): ImportEmuPlanDto {
  getScopeProfile(scope);
  const now = nowIso();
  getDb()
    .prepare("UPDATE sso_emu_import_plans SET status = 'applied', applied_at = COALESCE(applied_at, ?), updated_at = ? WHERE enterprise_id = ? AND id = ?")
    .run(now, now, scope.enterpriseId, planId);
  return requireEmuImportPlan(planId, scope);
}

export function deleteEmuImportPlanRecord(planId: string, scope: EnterpriseScope): boolean {
  requireEmuImportPlan(planId, scope);
  return getDb().transaction(() => {
    getDb().prepare('DELETE FROM sso_emu_import_plan_rows WHERE enterprise_id = ? AND plan_id = ?').run(scope.enterpriseId, planId);
    const result = getDb().prepare('DELETE FROM sso_emu_import_plans WHERE enterprise_id = ? AND id = ?').run(scope.enterpriseId, planId);
    return result.changes > 0;
  })();
}

function toPlanDto(row: PlanRow, scope: EnterpriseScope): ImportEmuPlanDto {
  return {
    enterpriseId: scope.enterpriseId,
    enterpriseRevision: scope.enterpriseRevision,
    planId: row.id,
    ssoUser: row.sso_user,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    summary: summarizeEmuImportPlan(row.id, scope),
  };
}

function summarizeEmuImportPlan(planId: string, scope: EnterpriseScope): ImportEmuPlanSummary {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS count FROM sso_emu_import_plan_rows WHERE enterprise_id = ? AND plan_id = ? GROUP BY status')
    .all(scope.enterpriseId, planId) as { status: ImportEmuUserStatus; count: number }[];
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
    status: row.status,
    detail: row.detail,
  };
}

function toPlanRowRecord(row: RowRecord): EmuImportPlanRowRecord {
  return {
    ...toImportRow(row),
    rowIndex: row.row_index,
    action: row.action,
    expectedUserIncarnation: row.expected_user_incarnation,
  };
}
