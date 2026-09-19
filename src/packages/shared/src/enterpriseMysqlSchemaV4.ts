import { getExpectedEnterpriseMysqlV3, type EnterpriseMysqlTriggerV3 } from './enterpriseMysqlSchemaV3.js';
import type { EnterpriseMysqlLayout } from './enterpriseMysql.js';
import type { TableSchema } from './enterpriseMysqlV1.js';
export const ENTERPRISE_MYSQL_V4_MIGRATION = 'enterprise-schema4-contract2';
export const ENTERPRISE_MYSQL_V4_FINAL_STEP = 15;
const ascii='COLLATE ascii_bin',uuid=`VARCHAR(36) ${ascii}`;
export const ENTERPRISE_MYSQL_V4_TABLES:Record<string,TableSchema> = {
  enterprise_pool_policy:{pool:true,primary:'enterprise_id',columns:{
    enterprise_id:uuid,state:`VARCHAR(16) ${ascii} NOT NULL`,policy_version:'BIGINT NOT NULL',identity_sha256:`CHAR(64) ${ascii} NOT NULL`,
    validation_kind:`VARCHAR(40) ${ascii}`,validation_evidence_json:'TEXT',validated_at:'BIGINT',updated_at:'BIGINT NOT NULL',
  },foreign:[['enterprise_id','enterprise_profiles','id','RESTRICT']],checks:["state IN ('draft', 'validated', 'active', 'draining')",'policy_version >= 1',
    "validation_kind IN ('local_service_readiness_v1', 'migration_preserved_v3')",
    'validated_at >= 0','updated_at >= 0']},
  enterprise_upgrade_v4:{pool:true,primary:'singleton',columns:{
    singleton:'TINYINT',migration_id:`VARCHAR(64) ${ascii} NOT NULL`,database_name:`VARCHAR(64) ${ascii} NOT NULL`,
    manifest_sha256:`CHAR(64) ${ascii} NOT NULL`,backup_reference:'VARCHAR(255) NOT NULL',backup_sha256:`CHAR(64) ${ascii} NOT NULL`,
    registry_sha256:`CHAR(64) ${ascii} NOT NULL`,source_sha256:`CHAR(64) ${ascii} NOT NULL`,layout:`VARCHAR(16) ${ascii} NOT NULL`,
    state:`VARCHAR(16) ${ascii} NOT NULL`,step:'INT NOT NULL',checkpoint_state:`VARCHAR(16) ${ascii} NOT NULL`,evidence_json:'LONGTEXT NOT NULL',migrated_at:'BIGINT NOT NULL',
  },checks:['singleton = 1',"layout IN ('direct', 'pool')","state IN ('applying', 'complete')",`step >= 0 AND step <= ${ENTERPRISE_MYSQL_V4_FINAL_STEP}`,
    "checkpoint_state IN ('before', 'after', 'unknown')",'migrated_at >= 0']},
};
const immutable=(table:string,column:string):EnterpriseMysqlTriggerV3=>({table,timing:'BEFORE',event:'UPDATE',body:`BEGIN
  IF NOT (CAST(OLD.${column} AS BINARY) <=> CAST(NEW.${column} AS BINARY)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_binding_immutable';
  END IF;
END`});
export const ENTERPRISE_MYSQL_V4_TRIGGERS:Record<string,EnterpriseMysqlTriggerV3>={
  enterprise_policy_immutable:immutable('enterprise_pool_policy','enterprise_id'),
  enterprise_policy_no_delete:{table:'enterprise_pool_policy',timing:'BEFORE',event:'DELETE',body:`BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'enterprise_policy_required';
END`},
  enterprise_stats_scope_immutable:immutable('proxy_request_stats','enterprise_id'),
  enterprise_events_scope_immutable:immutable('user_pool_events','enterprise_id'),
};
export function getExpectedEnterpriseMysqlV4(layout:EnterpriseMysqlLayout){
  const {schema,triggers}=getExpectedEnterpriseMysqlV3(layout);
  schema.enterprise_schema.checks=schema.enterprise_schema.checks!.map(c=>c==='schema_version = 3'?'schema_version = 4':c==="capability = 'enterprise-isolation-legacy-pool'"?"capability = 'enterprise-multi-pool'":c);
  for(const table of ['proxy_request_stats',...(layout==='pool'?['user_pool_events']:[])]){
    schema[table].columns.enterprise_id=uuid;
    schema[table].foreign=[...(schema[table].foreign??[]),['enterprise_id','enterprise_profiles','id','RESTRICT']];
    schema[table].indexes=[...(schema[table].indexes??[]),`idx_${table}_enterprise (enterprise_id, ${table==='proxy_request_stats'?'requested_at':'at'} DESC, id DESC)`];
  }
  schema.enterprise_pool_policy=structuredClone(ENTERPRISE_MYSQL_V4_TABLES.enterprise_pool_policy);
  schema.enterprise_upgrade_v4=structuredClone(ENTERPRISE_MYSQL_V4_TABLES.enterprise_upgrade_v4);
  delete triggers.enterprise_pool_legacy_insert;delete triggers.enterprise_pool_legacy_update;
  Object.assign(triggers,structuredClone(ENTERPRISE_MYSQL_V4_TRIGGERS));if(layout!=='pool')delete triggers.enterprise_events_scope_immutable;
  return{schema,triggers};
}
export const enterpriseMysqlSchemaV4=(layout:EnterpriseMysqlLayout)=>getExpectedEnterpriseMysqlV4(layout).schema;
