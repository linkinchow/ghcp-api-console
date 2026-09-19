# 企业 schema 2 离线工具

本工具只交付**单 profile 基础结构**，不代表已完成多租户隔离。企业内部 ID 为小写 UUIDv4；`slug` 是真实唯一企业 slug；`shortcode` 是真实的 3–8 位小写字母数字 EMU shortcode。没有字面 `default` ID。能力标识为 `enterprise-single-profile`，数据库 schema **2**，服务契约 **1**。

## 支持范围与部署约束

仅支持精确基线 `8ad76d547c9d067aac79f99391859cc67dcd7b44`：

- Proxy MySQL direct 或完整 pool。
- SSO、Login SQLite。
- 保留既有 Proxy SQLite direct/pool 的初始化、迁移与门禁支持。

完整验证列、默认值、主键/唯一键、CHECK、外键、索引、trigger 及完成 marker。未知旧版、缺约束、额外对象、部分迁移、未来版本均拒绝。旧 SQLite→MySQL/importer 工具仍输出冻结 v1，之后必须执行本企业迁移。运行时只校验，不执行 DDL、seed 或自动补表。

Node 专用子路径 `@ghcp/shared/enterpriseStorage` 提供 `validateEnterpriseSqlite(db, component, expectedProfile?)`、异步 `validateEnterpriseMysql(connection,'proxy',expectedProfile?)`，以及仅用于离线工具/合成夹具的显式 `initEnterpriseSqlite`/`initEnterpriseMysql`。这些实现不会导入服务环境配置，也不会加入浏览器共享入口。

## 操作前提

1. 停止全部 writer、调度 worker、Login 浏览器任务及外部 SSO/SCIM 操作；数据库检查不能代替操作者证明。
2. 暂停 pool，释放或等待 owner 到期，排空 inference/catalog holds 与初始化 claims；先人工核实未决 OAuth/Login 意图，不要删除证据来绕过预检。
3. 独立备份并演练恢复，包含 Console 管理员恢复材料。MySQL DDL **不能用事务 rollback 撤回**。
4. SQLite 输入必须为一致的 **standalone rollback-journal 备份**，没有 `-wal/-shm/-journal`。不得复制活跃 WAL 库、删除边车或以 `immutable` 忽略 WAL。本工具读取备份字节并反序列化到内存，不用 SQLite 打开源路径。
5. 一个 manifest 配对 Proxy/SSO/Login，使用显式绝对路径。不得含密码、token、私钥或连接串；未知字段拒绝。SQLite 目标必须为新路径。

大小写歧义预检采用保守的 NFKC+小写碰撞拒绝规则；它不等于运行时 SQLite/MySQL 字符比较语义，也不会自动规范化、改名或合并任何身份。

## Manifest 示例

以下全部是合成值。备份 SHA-256 必须替换为真实**备份文件**摘要，不要照抄示例零值。

```json
{
  "manifestVersion": 1,
  "baseline": "8ad76d5",
  "profile": {
    "id": "84bdc214-ad8b-484f-9419-3d82b63d07c4",
    "slug": "synthetic-enterprise",
    "shortcode": "synth",
    "accountDomain": "fixture.invalid",
    "revision": 1,
    "routes": {
      "proxyInternalUrl": "http://127.0.0.1:14101",
      "ssoInternalUrl": "http://127.0.0.1:14102",
      "loginInternalUrl": "http://127.0.0.1:14103",
      "ssoPublicUrl": "https://sso.fixture.invalid"
    }
  },
  "services": [
    {
      "component": "proxy", "driver": "mysql", "layout": "pool",
      "location": {
        "host": "127.0.0.1", "port": 3306,
        "database": "synthetic_dedicated_database",
        "connectionEnv": "ENTERPRISE_MYSQL_MIGRATION"
      },
      "backup": { "reference": "verified-proxy-backup", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
    },
    {
      "component": "sso", "driver": "sqlite", "layout": "sso",
      "source": "/absolute/backups/sso-v1.sqlite",
      "target": "/absolute/new/sso-v2.sqlite",
      "backup": { "reference": "verified-sso-backup", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
    },
    {
      "component": "login", "driver": "sqlite", "layout": "login",
      "source": "/absolute/backups/login-v1.sqlite",
      "target": "/absolute/new/login-v2.sqlite",
      "backup": { "reference": "verified-login-backup", "sha256": "0000000000000000000000000000000000000000000000000000000000000000" }
    }
  ],
  "attestations": { "writersStopped": true, "externalOperationsDrained": true, "backupVerified": true }
}
```

MySQL 连接串仅放到 `location.connectionEnv` 指定的进程环境变量。**不加载 `.env`**；URI host/port/database 必须匹配 manifest。不带 CA 仅允许字面 `127.0.0.1` 或 `[::1]`，且实际 TCP peer 也必须为 loopback，拒绝 socketPath。其它主机（含 `localhost` 名称）必须设置 `<connectionEnv>_CA_FILE`，验证证书与主机名。不要在命令行传密码。

第一次预检不要求填写 MySQL `sourceSha256`。使用 `--plan-out` 独占创建受保护计划文件；所有组件预检成功后，工具才把逻辑快照摘要写入新文件（创建权限 `0600`；Windows 还需受限目录 ACL）。摘要不打印到 stdout。该计划本身是绑定后的 manifest，后续 apply/verify 都使用它。它绑定来源、目标、profile、版本、外部备份引用与摘要；来源改变必须重新评审计划，不能忽略冲突。

可选 `admins`：`{"path":"/absolute/admins.json","backup":{"reference":"verified-admins","sha256":"..."}}`。严格只读校验结构、可恢复管理员及备份摘要，绝不修改文件，不输出用户名/hash/salt。

若 Proxy 使用 SQLite，其 service 形状与 SSO 相同，只需 `component:"proxy"`、`layout:"direct"` 或 `"pool"`。不执行跨引擎转换。

## 实际命令

在仓库根目录执行；不启动服务，也不调用 GitHub/SSO 外部 API。

```sh
npm run upgrade:default-enterprise -- preflight --manifest /absolute/draft.json --plan-out /absolute/protected/approved-plan.json
npm run upgrade:default-enterprise -- apply --manifest /absolute/protected/approved-plan.json
npm run upgrade:default-enterprise -- verify --manifest /absolute/protected/approved-plan.json
npm run upgrade:default-enterprise -- inspect --manifest /absolute/protected/approved-plan.json
# 必须先 inspect 并人工判断，才允许显式恢复已知 MySQL checkpoint：
npm run upgrade:default-enterprise -- apply --manifest /absolute/protected/approved-plan.json --resume
```

纯 SQLite manifest 已有源备份摘要，可不带 `--plan-out`；使用它仍可产生受保护审阅副本。已有计划文件绝不覆盖。

三组件全部完成且 canonical profile 完全一致，才返回 `ready:true`。没有跨库事务；后续组件失败不会撤销此前已完成组件。任何错误均保持停止流量，逐组件 inspect。

SQLite apply 独占创建新文件，逐字段保留所有旧值（包括凭据、hash/salt、nonce、时间、generation、version、`sqlite_sequence`），前后确认源 SHA-256 未变；归属以 INSERT 回填，不执行凭据 UPDATE，故不会触发 credential fence。cap 从旧 settings 搬到唯一 `enterprise_profiles.max_accounts`，settings 不再有实体 cap。相同输入与 receipt 的已完成输出仅验证并返回 already-complete，不写业务数据。失败目标保留为**未批准证据**，不得部署或自动覆盖。

MySQL 原库维护态迁移使用锁、deadline 和每步 checkpoint，保留冻结 v1 列的逐列摘要并验证。未知 driver/commit 结果停止；只对绑定一致、结构和数据均匹配的明确 before/after 阶段提供显式恢复。初始化 checkpoint 表的建表确认丢失可能留下未绑定空表，此情况要求人工检查，不猜测恢复。不能将 DDL 的 rollback 宣传成撤销。

## 首次空库初始化

```sh
npm run upgrade:default-enterprise -- init --manifest /absolute/init-manifest.json
npm run upgrade:default-enterprise -- verify --manifest /absolute/init-manifest.json
```

SQLite init service 省略 `source/backup`，目标必须不存在。MySQL init service 必须提供 `init`（direct 为 `{}`），并**省略 `backup/sourceSha256`**，不需要伪造备份或摘要。任何非空 schema 拒绝初始化。

pool 初始化的 `init` 示例：

```json
{
  "maxAccounts": 20,
  "pool": {
    "settings": {
      "version": 1, "idle_target": 2, "lease_seconds": 172800, "paused": 1,
      "next_ordinal": 0, "account_domain": "fixture.invalid", "owner": null, "owner_until": 0
    }
  }
}
```

MySQL 还必须在 `pool` 添加原 PoolConfig 算出的 64 位 `fingerprint`；不能把企业 profile 加入该哈希。SQLite 基线没有该实体列，迁移不凭空制造。运行时从 profile 表读取唯一 cap，不能用初始化种子覆盖持久化 cap。

## 启动配置与分期限制

工具manifest不是服务profile文件。将manifest中的`profile`对象单独保存为受控JSON文件，三服务的`ENTERPRISE_PROFILE_FILE`指向相同内容（各Pod可有不同挂载路径）。企业内部UUID只生成一次并保留，不能每次启动重新生成；slug/shortcode使用现有真实值。

- Proxy：保留数据库连接与服务Secret；SSO_BASE_URL、LOGIN_BASE_URL、ENTERPRISE_SHORTCODE必须匹配profile。caller-lease模式的POOL_ACCOUNT_EMAIL_DOMAIN也必须匹配accountDomain。
- SSO：BASE_URL、PROXY_BASE_URL、ENTERPRISE_SLUG、ENTERPRISE_SHORTCODE与profile一致。保留原证书/私钥、SP配置和SSO SQLite；运行时emailDomain仍是原独立设置，不擅自改成池域。
- Login：PROXY_BASE_URL、SSO_URL与profile一致，保留原SQLite和进程级并发配置。
- Console：保留admins.json、Secret及各服务地址，DTO新增企业归属不会要求重新初始化管理员。

初始化pool必须显式`paused:1`，工具拒绝以未暂停状态初始化。维护验证通过后是否开放业务、解除暂停是另一个操作，不由工具代办。旧settings API在本阶段仅适配这一家企业，cap只有企业表一个权威；第二企业创建和比例调度尚未开放。

SSO仍保留原sso_user主键和单profile SAML上下文；Login展示的enterpriseRevision来自不可变profile投影，并不是历史task配置快照或账号世代证明。完整多企业隔离在下一阶段实现。

## 验证与未覆盖边界

```sh
npm run test:upgrade:default-enterprise
npm run typecheck:upgrade
```

测试只用合成隔离数据。真实 MySQL 必须有显式 opt-in、字面 loopback 与专用测试库，否则报告 **SKIP**；不会启动 Docker、云资源、浏览器或真实服务。离线 metadata/故障注入测试不替代真实 MySQL DDL 演练，生产批准前仍需专用实例集成测试与恢复演练。

本工具不会自动恢复流量。旧 binary 不保证拒绝 v2，维护访问隔离不可省略。完整多 profile SAML/SCIM/session、SSO复合身份键、账号 incarnation/任务幂等及跨企业冲突仍属于后续阶段，不列为本阶段已完成。
