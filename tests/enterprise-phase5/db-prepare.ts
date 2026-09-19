import { args, insist, loadDbGate, resultPath, SCHEMAS, safeError, validatePeer, writePrivate } from './db-gate.js';

export const APPLICATION_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRIGGER'] as const;
/** MySQL exposes trigger definitions only with TRIGGER; it also permits trigger
 * CREATE/DROP. This is explicitly DDL-capable, not a read-only metadata privilege.
 * Scope remains the single run application schema, with no global/ALL/SUPER grant. */
export function applicationGrant(schema: string): string {
  insist(['ghcp_enterprise_test_phase5_app', 'ghcp_enterprise_test_phase5_chain'].includes(schema), 'application_grant_schema_not_owned');
  return `GRANT ${APPLICATION_PRIVILEGES.join(',')} ON \`${schema}\`.* TO ?@?`;
}
export async function prepareDatabases(input = args()): Promise<void> {
  const state = await loadDbGate(input.state, input.inspect, input.service ?? 'mysql');
  resultPath(state, input.output);
  insist(['mysql', 'mysql-restore'].includes(input.service ?? 'mysql'), 'invalid_service');
  const restore = input.service === 'mysql-restore';
  const { createConnection } = await import('mysql2/promise');
  const c = await createConnection({ host: '127.0.0.1', port: restore ? state.database.restoreHostPort : state.database.hostPort,
    user: 'root', password: state.database.rootPassword, connectTimeout: 5000, multipleStatements: false });
  try {
    validatePeer(c);
    const [server] = await c.query<any[]>('SELECT VERSION() AS version,CURRENT_USER() AS principal');
    insist(/^8\.4\./.test(server[0]?.version) && server[0]?.principal?.startsWith('root@'), 'owned_mysql84_root_required');
    // New-instance assertion precedes every CREATE. No IF NOT EXISTS, repair or DROP.
    const [existing] = await c.query<any[]>('SHOW DATABASES');
    insist(existing.every(row => ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(row.Database)), 'server_has_preexisting_user_schemas');
    const [users] = await c.query<any[]>('SELECT User FROM mysql.user WHERE User=?', [state.database.username]);
    insist(users.length === 0, 'application_user_already_exists');
    const schemas = restore ? ['ghcp_enterprise_test_phase5_chain'] : SCHEMAS;
    for (const name of schemas) await c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    if (!restore) {
      await c.query('CREATE USER ?@? IDENTIFIED BY ?', [state.database.username, '%', state.database.password]);
      await c.query(applicationGrant(state.database.name), [state.database.username, '%']);
    }
    writePrivate(input.output, { status: 'PASS', syntheticOnly: true, runId: state.runId, service: input.service ?? 'mysql',
      mysqlVersion: server[0].version, schemas, rootOwnershipVerified: true, existingSchemaPolicy: 'reject-before-create',
      applicationPrivilegeScope: restore ? null : { schema: state.database.name, privileges: APPLICATION_PRIVILEGES,
        triggerPrivilegeIncludesCreateDrop: true, metadataOnlyPrivilege: false, globalPrivilegesGranted: false,
        metadataVisibilityAfterSchemaInit: 'NOT_EXECUTED_BY_PREPARE_requires_post_init_application_validator' } });
  } finally { await c.end().catch(() => c.destroy()); }
}
if (process.argv[1]?.endsWith('db-prepare.ts')) prepareDatabases().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
