import { readEnterpriseMysqlTestGate, type EnterpriseMysqlTestGate } from '../../upgrade/multi-enterprise-pool/mysqlHarness.js';

/** An ordinary enterprise integration opt-in must not enable this qualification. */
export function readNameCatalogTestGate(env: NodeJS.ProcessEnv = process.env): EnterpriseMysqlTestGate {
  const explicit = env.GHCP_ENTERPRISE_NAME_CATALOG_TEST;
  if (explicit === undefined) return { enabled: false };
  if (explicit !== '1') throw new Error('mysql_name_catalog_explicit_gate_required');
  const gate = readEnterpriseMysqlTestGate(env);
  if (!gate.enabled) throw new Error('mysql_name_catalog_empty_schema_gate_required');
  return gate;
}
