# Proxy SQLite 到 MySQL 升级

此升级需要显式执行：Proxy 启动时绝不会自动将 SQLite 数据复制到 MySQL。

## 迁移前准备

1. 源库须为 r4（单企业）schema，或已完成多企业迁移的 schema。更早的版本先用 `STORAGE_DRIVER=sqlite` 启动一次当前版本的 Proxy，完成 SQLite 迁移。
2. 停止 Proxy 和 Login，防止复制期间写入账号、OAuth 回调和请求统计数据。
3. 在服务保持停止的状态下，备份 `proxy.sqlite` 以及同目录下可能存在的 `proxy.sqlite-wal` 和 `proxy.sqlite-shm` 文件。
4. 创建一个空的 MySQL 8 数据库，并创建一个遵循最小权限原则的应用用户；该用户需要在 schema 迁移期间具备创建和修改表的权限。
5. 远程或生产环境的 MySQL 连接必须启用 TLS。

## 企业配置

工具按 Proxy 启动时的同一规则，从**当前进程环境**计算 `default` 企业（`ENTERPRISE_REGISTRY_FILE`、`GITHUB_BASE_URL`、`ENTERPRISE_SHORTCODE` 等），并用它创建目标 schema。必须使用 Proxy 切换后将要使用的同一配置运行本工具，包括预检。

- r4 源：所有账号和统计归入 `default`。
- 多企业源：源 `default` 的身份指纹必须与当前环境一致，否则拒绝；同时复制其容量、状态和策略版本。源中只能有 `default` 企业，且不能有池成员（User Pool 数据请用 `upgrade/user-pool-mysql`）。部分完成迁移的源会被拒绝。

## 迁移预检

试运行会以只读方式打开 SQLite，验证必需字段、检查 MySQL 版本，并报告目标表中是否已有数据。试运行不会创建 schema，也不会复制数据行。

```bash
npm run upgrade:sqlite-to-mysql -- \
  --sqlite /path/to/proxy.sqlite \
  --mysql-url 'mysql://user:password@mysql.example/ghcp_proxy' \
  --dry-run
```

## 执行迁移

```bash
npm run upgrade:sqlite-to-mysql -- \
  --sqlite /path/to/proxy.sqlite \
  --mysql-url 'mysql://user:password@mysql.example/ghcp_proxy'
```

该工具会创建当前版本的 MySQL schema，拒绝向非空目标库迁移，在一个事务中复制 `proxy_accounts`、`proxy_request_stats`（含 `enterprise_id`）及 `default` 企业设置，并在提交前校验目标表行数、各行企业归属和 `proxy_enterprises`。工具不会修改 SQLite 源数据库，也不会输出 OAuth token 或 MySQL URL。

如果命令在提交前失败，请修复报告的问题，并针对同一个空目标库重新运行。如果工具报告目标库非空，请勿手动合并数据库；应恢复或重新创建一个空目标库后再运行。

## 切换与验证

1. 为 Proxy 配置 `STORAGE_DRIVER=mysql`、`MYSQL_URL`、连接池参数和生产环境 TLS 参数。
2. 启动一个 Proxy Pod，并等待其 `/readyz` 检查成功。
3. 在 Console 中核对账号总数并抽查少量 OAuth 状态，期间不要暴露 token 值。
4. 将 Proxy 扩容到多个 Pod，并确认每个 Pod 的 `/readyz` 检查均成功。
5. 重新启动 Login。

如需回滚，请停止 Proxy 和 Login，恢复已备份的 SQLite 文件，将 `STORAGE_DRIVER` 切换回 `sqlite`，并且只运行一个 Proxy Pod。切换后仅写入 MySQL 的数据不会自动复制回 SQLite。
