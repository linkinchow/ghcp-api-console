# 多企业账号池离线工具（Proxy schema 3 → 4）

## 边界

本目录只把 **Proxy** 存储升级到 schema4 / contract2 / `enterprise-multi-pool`。可信 registry 文件仍为 JSON version3；SSO/Login 存储仍为 schema3 / contract2。本工具不会重建 incarnation，不开户、不申请席位、不调用 GitHub、不读取 Secret 值，也不会自动启动服务或创建数据库。

旧 `upgrade/default-enterprise/`、`upgrade/multi-enterprise/` 的 v1→2→3 格式、receipt 与迁移步骤不改写。先完成旧版本迁移，再使用本工具。运行时 validator 只读且 fail-closed，不执行自动 DDL。

## 维护前提

1. 停止三个服务的所有写入并核验备份。Proxy 池必须已经 `paused=1`、owner 已到期、无未确认外部操作、活动授权、identity claim 或 hold。不能为了通过预检把未知结果直接清空；先人工核对。
2. SQLite 源必须是无 WAL/SHM/journal 的独立文件；目标是全新、不存在的路径。本工具独占创建目标，不覆盖源或已有不受信目标。
3. MySQL 是既有、明确指定的专用连接。用户自行预建数据库和备份；工具不 `CREATE/DROP DATABASE`。非 loopback 连接要求显式 CA、主机校验；数字 loopback 还核对真实 socket peer。此迁移程序不是“允许连接客户库”的授权。
4. 清楚区分库存 cap 与账单、业务 pause 与维护 pause。工具保留数据库里已有 cap、ordinal、next_ordinal、凭据、lease、generation、incarnation 和旧 receipt 的所有原列。迁移过程中不替换原配置 fingerprint。

## Manifest

结构为 `manifestVersion:4, sourceSchemaVersion:3, registry:{version:3,...}, services:[proxy,sso,login], attestations`。三个 attestation 都必须严格为 true：`writersStopped`、`externalOperationsDrained`、`backupVerified`。未知字段拒绝；特别不接受 `accountIncarnations` / `userIncarnations` 映射。

每个 SQLite 服务指定：

```json
{
  "component": "proxy",
  "driver": "sqlite",
  "layout": "pool",
  "source": "C:/offline/proxy-v3.sqlite",
  "target": "C:/offline/proxy-v4.sqlite",
  "backup": { "reference": "offline-proxy-backup", "sha256": "64位小写SHA256" }
}
```

Proxy layout 为 `direct` 或 `pool`；SSO/Login layout 分别为 `sso` / `login`。执行升级时 SSO/Login 只验证 schema3 并逐字节复制到新目标，不改变 schema、不新增 nonce/incarnation。

Proxy MySQL 服务指定 `driver:"mysql"`、layout 和 `location:{host,port,database,connectionEnv}`。`connectionEnv` 必须以 `ENTERPRISE_MYSQL_` 开头；该变量只包含与 manifest 完全匹配的 mysql URL，不接受 URL query/fragment。可使用 `${connectionEnv}_CA_FILE`。不读取 `.env`、`MYSQL_URL` 或运行时配置。程序化调用默认环境为空；CLI 只读取 manifest 点名的变量。

## 命令

在仓库根目录使用已有依赖运行（不下载工具）：

```sh
npx --no-install tsx upgrade/multi-enterprise-pool/index.ts preflight --manifest /absolute/input.json --plan-out /absolute/protected-plan.json
npx --no-install tsx upgrade/multi-enterprise-pool/index.ts apply --manifest /absolute/protected-plan.json
npx --no-install tsx upgrade/multi-enterprise-pool/index.ts verify --manifest /absolute/protected-plan.json
npx --no-install tsx upgrade/multi-enterprise-pool/index.ts inspect --manifest /absolute/protected-plan.json
```

预检只读，并把源 hash / 原列 hash 写入新建的受保护 plan（`wx`、0600）；标准输出仅安全状态，不打印凭据、原始 profile、identity 映射或源摘要。三个服务不是分布式原子事务：若中断，不启用运行时；保持停写，逐服务检查并完成验证。

- SQLite 已有目标只在 receipt、manifest、源 hash、每个原列的值及 SQLite 存储类型、回填归属均匹配时认可。未知/半成品目标不得自动覆盖。
- MySQL 沿用同一个迁移锁和总 deadline，新增独立 `enterprise_upgrade_v4`。每个步骤持久化 `before → unknown → after`。只有精确 `before/after` 检查点允许显式 `--resume`；`unknown` 永远拒绝自动推断或重放，需要人工核对/备份恢复。不能因为存在 marker 就宣称完成。
- MySQL 逐列使用 `HEX(CAST(... AS BINARY))` 摘要验证原字节，并保留事件 AUTO_INCREMENT；完成后运行时校验 receipt 的格式和绑定，不把日常业务行变化误当迁移失败。离线 `verify` 则要求仍与迁移源一致，因此应在恢复写入前执行。

## 新装与追加登记

`init` 不允许 source/backup/source hash。三个目标必须为空/不存在；Proxy pool init 需要 `init.pool.settings`（version、idle_target、lease_seconds、paused、next_ordinal、account_domain、owner、owner_until），MySQL 另需要原配置格式的 fingerprint。强制 `paused:1`、`next_ordinal:0`、`owner:null`、`owner_until:0`。所有 profile 均为 `draft`；idle_target 允许 0..10000，不要求小于已启用 cap。

`register` 使用 `previousRegistry` 与新 registry：revision 必须恰好 +1，legacy pin 不变，旧 profile JSON 完全不变，只允许追加。SQLite 指向各服务当前源及新目标；MySQL 仍在原库内受锁执行。Proxy 使用 v4 注册；SSO/Login 使用冻结的 v3 注册。旧 cap、policy、校验证据、NULL 历史归属、所有业务行与 receipt 不重写；新企业 policy 为 draft。实际数据库旧 cap 加新增 cap 不得超过 10000；不能以 registry seed cap 覆盖数据库权威值。

新装/新登记需管理员进行内部只读配置校验，再显式 activate。内部配置就绪不是 GitHub 实际验收。3→4 迁移只对 legacy 企业保留 active，并以 immutable receipt + `migration_preserved_v3` 标明来源；其余已有企业均为 draft。

## 历史归属

在 `proxy_request_stats` 和 `user_pool_events` 增加可空持久 `enterprise_id`，只引用 profile（不引用会删除的账号）。回填仅使用精确二进制 identity 关联，且历史时间必须可解析、不早于当前 account.created_at；不存在账号、时间不明或明显早于重建账号的历史行仍为 NULL。保留全部旧列，不按用户名、错误信息或 legacy 默认猜测。新 scope 列不可被更新重分配；删除账号不会通过 FK 级联删除事件归属。

## 测试与真实 MySQL 安全门

合成测试：

```sh
npx --no-install tsc -p upgrade/multi-enterprise-pool/tsconfig.json
node --import tsx --test --test-concurrency=1 upgrade/multi-enterprise-pool/storage.test.ts upgrade/multi-enterprise-pool/contracts.test.ts upgrade/multi-enterprise-pool/sqlite.test.ts upgrade/multi-enterprise-pool/mysql.test.ts upgrade/multi-enterprise-pool/mysqlHarness.test.ts
```

`mysql.test.ts` 是 SQL/metadata 模拟，不是 MySQL8 实库验收。真实测试位于本目录及旧 `multi-enterprise/mysql.integration.test.ts`，默认禁用。只有另行授权、预先提供的 **空** loopback MySQL8 schema 才可设置以下三个变量：

- `GHCP_ENTERPRISE_MYSQL_TEST_ALLOW_DDL=1`
- `GHCP_ENTERPRISE_MYSQL_TEST_SCHEMA=ghcp_enterprise_test_<专用名称>`
- `GHCP_ENTERPRISE_MYSQL_TEST_URL=mysql://...@127.0.0.1:端口/ghcp_enterprise_test_<专用名称>`（或 `[::1]`）

三者不全或错误 opt-in 明确失败；禁用时在 mysql2 / schema 运行时代码导入前跳过，零连接。不读取任何部署 `.env`/`MYSQL_URL`，拒绝 DNS、数字 IP 简写、socketPath、非 loopback peer、非空 schema。只清理本轮已确认创建且名称受控的表/触发器；拒绝非空库时不清理，遇未知对象留待人工检查。不会新建 Docker、云或数据库资源。

本轮没有实库授权；**没有执行真实 MySQL**。实库测试程序的存在、SQL 模拟通过，都不能作为真实并发、DDL 或中断恢复已验收的结论。
