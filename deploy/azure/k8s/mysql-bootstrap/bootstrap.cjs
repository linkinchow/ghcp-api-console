'use strict';
// MySQL 账号初始化（在集群内以 Job 运行，见 kustomization.yaml）。只输出状态，不输出任何密码。
// 可重复执行：库已存在时只核对字符集；账号已存在时重设为 Key Vault 中的密码并补齐授权。
const fs = require('node:fs');
const { createRequire } = require('node:module');

// 脚本挂载在 /opt/bootstrap，mysql2 在 Proxy 镜像的 /app/node_modules 中。
const requireFromProxy = createRequire(process.env.GHCP_PROXY_PACKAGE_JSON || '/app/src/proxy/package.json');

const AUTO_MIGRATE_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER';
const DML_PRIVILEGES = 'SELECT, INSERT, UPDATE, DELETE';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`missing environment variable ${name}`);
  if (String(value).includes('REPLACE_')) throw new Error(`${name} still contains a REPLACE_ placeholder`);
  return String(value);
}

function readSecretFile(file) {
  const value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!value) throw new Error(`secret file ${file} is empty`);
  return value;
}

/** Validates the inputs; returns the statements to run (values bound as parameters, never interpolated). */
function plan(env) {
  const database = env.database;
  const user = env.proxyUser;
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error('MYSQL_DATABASE must match [A-Za-z0-9_]{1,64}');
  if (!/^[A-Za-z0-9_]{1,32}$/.test(user)) throw new Error('MYSQL_PROXY_USER must match [A-Za-z0-9_]{1,32}');
  if (!/^[A-Za-z0-9.%/_:-]{1,255}$/.test(env.proxyHost)) throw new Error('MYSQL_PROXY_USER_HOST has unexpected characters');
  if (!['auto-migrate', 'dba-schema'].includes(env.mode)) throw new Error('GHCP_MYSQL_MODE must be auto-migrate or dba-schema');
  const privileges = env.mode === 'auto-migrate' ? AUTO_MIGRATE_PRIVILEGES : DML_PRIVILEGES;
  return [
    ['CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ? REQUIRE SSL', [user, env.proxyHost, env.proxyPassword]],
    ['ALTER USER ?@? IDENTIFIED BY ? REQUIRE SSL', [user, env.proxyHost, env.proxyPassword]],
    [`GRANT ${privileges} ON ??.* TO ?@?`, [database, user, env.proxyHost]],
  ];
}

async function main() {
  const env = {
    host: required('MYSQL_HOST'),
    port: Number(process.env.MYSQL_PORT || 3306),
    admin: required('MYSQL_ADMIN_USER'),
    database: required('MYSQL_DATABASE', 'ghcp_proxy'),
    proxyUser: required('MYSQL_PROXY_USER', 'ghcp_proxy'),
    proxyHost: required('MYSQL_PROXY_USER_HOST', '%'),
    mode: required('GHCP_MYSQL_MODE', 'auto-migrate'),
    adminPassword: readSecretFile(required('MYSQL_ADMIN_PASSWORD_FILE', '/mnt/secrets-store/mysql-admin-password')),
    proxyPassword: readSecretFile(required('MYSQL_PROXY_PASSWORD_FILE', '/mnt/secrets-store/ghcp-mysql-proxy-password')),
    ca: fs.readFileSync(required('MYSQL_SSL_CA_PATH', '/run/mysql-ca/ca.pem'), 'utf8'),
  };
  const statements = plan(env);
  const mysql = requireFromProxy('mysql2/promise');
  // 完整校验证书链与主机名（服务器 FQDN 经私有 DNS 解析到私有终结点，证书主机名仍然匹配）。
  const connection = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.admin,
    password: env.adminPassword,
    ssl: { ca: env.ca, rejectUnauthorized: true },
    connectTimeout: 20000,
  });
  try {
    const [variables] = await connection.query(
      "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version', 'require_secure_transport', 'log_bin', " +
      "'log_bin_trust_function_creators', 'character_set_server', 'collation_server')");
    const settings = Object.fromEntries(variables.map((row) => [row.Variable_name, row.Value]));
    console.log(`[mysql-bootstrap] server ${JSON.stringify(settings)}`);
    const [[ssl]] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    console.log(`[mysql-bootstrap] admin session TLS: ${ssl?.Value || 'none'}`);
    if (env.mode === 'auto-migrate' && settings.log_bin === 'ON' && settings.log_bin_trust_function_creators !== 'ON') {
      throw new Error('log_bin_trust_function_creators is OFF: Proxy auto-migration cannot create its trigger. ' +
        'Set it to ON (Bicep mysqlTrustFunctionCreators) or use GHCP_MYSQL_MODE=dba-schema.');
    }

    const [schemas] = await connection.query(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation ' +
      'FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [env.database]);
    if (schemas.length === 0) {
      await connection.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', [env.database]);
      console.log(`[mysql-bootstrap] created database ${env.database} (utf8mb4)`);
    } else if (schemas[0].charset !== 'utf8mb4') {
      throw new Error(`database ${env.database} uses ${schemas[0].charset}; Proxy requires utf8mb4`);
    } else {
      console.log(`[mysql-bootstrap] database ${env.database}: ${schemas[0].charset} / ${schemas[0].collation}`);
    }

    for (const [sql, values] of statements) await connection.query(sql, values);
    console.log(`[mysql-bootstrap] account ${env.proxyUser}@${env.proxyHost} ready (${env.mode}, REQUIRE SSL)`);
    if (env.mode === 'dba-schema') {
      console.log('[mysql-bootstrap] dba-schema: run scripts/proxy-mysql-initial.sql as administrator, then ' +
        `GRANT TRIGGER ON ${env.database}.proxy_accounts TO the Proxy account (deploy/kubernetes/README.md section 3.2)`);
    }
  } finally {
    await connection.end();
  }
}

module.exports = { plan, AUTO_MIGRATE_PRIVILEGES, DML_PRIVILEGES };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mysql-bootstrap] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
