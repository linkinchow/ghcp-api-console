# 多企业离线存储工具（schema 3 / contract 2）

本目录是独立的第三阶段入口。`upgrade/default-enterprise`、shared 的 v2 模块及旧迁移语义保持不变；此工具只接受**精确 schema 2 → schema 3**，不接受未知、部分、未来结构，也不让服务启动时执行 DDL。

## 操作边界

- Proxy 生产路径为 MySQL；SSO / Login 使用 SQLite。工具也支持 Proxy SQLite 合成验证。
- 必须停止所有 writer、排空登录任务/外部操作/初始化 claim/hold，备份并核验。已有有效 lease、credential generation、ordinal 不清理、不重新创建。
- 三存储没有分布式事务。只有三者 schema/contract、registry 身份摘要和永久 legacy UUID 全部一致且 `ready: true`，才能部署切换。
- profile UUID 是引用主键，slug 唯一。旧用户名原文、NameID、hash/salt、token、SAML 信任地址和证书不能因迁移重写。
- registry 公共配置仅保存 `env` / `file` Secret 引用，不保存 Secret 值。工具不读取 SSO Secret、不生成证书、不创建账号或席位。
- capacity 是数据库 `enterprise_profiles.max_accounts` 的可变权威值。registry 的 `maxAccounts` 只用于新 profile 初始化。`profile_json` 保留初始配置；身份摘要用 `canonicalEnterpriseIdentityRegistryV3`，不包括 seed capacity。修改 seed 不会覆盖已存 cap。

## 命令

所有路径必须为绝对路径。CLI 不加载 `.env`，不会自动寻找真实数据库。

```sh
npm run upgrade:multi-enterprise -- preflight --manifest /private/request.json --plan-out /private/approved-plan.json
npm run upgrade:multi-enterprise -- apply --manifest /private/approved-plan.json
npm run upgrade:multi-enterprise -- verify --manifest /private/approved-plan.json
npm run upgrade:multi-enterprise -- inspect --manifest /private/approved-plan.json
npm run upgrade:multi-enterprise -- init --manifest /private/new-install.json
npm run upgrade:multi-enterprise -- register --manifest /private/register-profile.json
```

`preflight` 要求 `--plan-out`，只独占创建、绝不覆盖 plan；POSIX 使用 `0600`，Windows 请额外使用受限目录 ACL。plan 含凭据派生的 source fidelity 摘要、账号/用户实例映射，**不能放入日志、工单或公开仓库**。stdout 只输出状态和计数，不输出映射/摘要/明文凭据。

plan 格式是严格白名单：

```json
{
  "manifestVersion": 3,
  "sourceSchemaVersion": 2,
  "registry": "替换为完整、通过 parseEnterpriseRegistryV3 的 registry 对象",
  "services": [
    {
      "component": "proxy", "driver": "mysql", "layout": "pool",
      "location": {"host": "127.0.0.1", "port": 3306, "database": "offline_proxy", "connectionEnv": "ENTERPRISE_MYSQL_OFFLINE"},
      "backup": {"reference": "approved-proxy-backup", "sha256": "替换为64位小写十六进制摘要"}
    },
    {
      "component": "sso", "driver": "sqlite", "layout": "sso",
      "source": "/private/sso-schema2.db", "target": "/private/sso-schema3.db",
      "backup": {"reference": "approved-sso-backup", "sha256": "替换为64位小写十六进制摘要"}
    },
    {
      "component": "login", "driver": "sqlite", "layout": "login",
      "source": "/private/login-schema2.db", "target": "/private/login-schema3.db",
      "backup": {"reference": "approved-login-backup", "sha256": "替换为64位小写十六进制摘要"}
    }
  ],
  "attestations": {"writersStopped": true, "externalOperationsDrained": true, "backupVerified": true}
}
```

示例是字段说明，不是可运行配置。不得把参考主机/数据库当作获准操作对象。MySQL 连接串只从明确 `connectionEnv` 读取，并核对 host/port/database；非字面 loopback 必须设置对应 `*_CA_FILE`，验证 TLS 证书和主机身份。

### 初始化

全新数据库用 `init`，不填 `source` / `backup` / source checkpoint。SQLite target 必须不存在；MySQL database 必须为空。pool 初始化需要 `init.pool.settings`（沿用 v2 字段：version、idle_target、lease_seconds、paused、next_ordinal、account_domain、owner、owner_until），且 paused=1 / next_ordinal=0 / owner=null / owner_until=0。MySQL pool 还需要 `init.pool.fingerprint`。cap 取 legacy registry profile 的 seed。

### SQLite 保真及失败处理

source 必须是已独立化的 SQLite 文件：无 `-wal` / `-shm` / `-journal`，文件头 journal mode 为 rollback；拒绝 symlink。**从 bytes 反序列化读取，不让 SQLite 打开 source 路径**。输出在内存中建好、按原类型复制并核验，然后写入 `wx` 独占的新文件。source 前后 bytes 摘要必须一致。

- 所有原业务列、`sqlite_sequence`、原 `enterprise_migration_receipt` 原样保留。
- 原 singleton profile / marker 不能维持原结构，因此其完整类型化原始行进入独立 v3 receipt 的 `source_metadata_json`，与 source 摘要绑定。
- preflight 一次确定 `accountIncarnation` 和 `userIncarnation`，写到受保护 plan；apply/resume 绝不生成新 UUID。再次 preflight 同一个已绑定 plan 会复用已有映射。
- SSO 原用户名 NOCASE 企业内冲突会拒绝，不做 lowercase/NFKC 重命名。导入 preview 的旧 `expected_user_incarnation` 为 NULL；旧 pending_update 不可据当前同名用户补写实例，必须重新 preview。
- Login 只迁移终态 history-only 任务（binding_version=1；新 revision/incarnation/expected subject 字段全部 NULL）。旧 nonce 单独写入不可删除 tombstone，不伪造完整授权绑定；新任务 binding_version=2 使用完整绑定及独立不可删除 nonce ledger。
- 已完整输出只有通过 source/plan/receipt 全量校验才返回 already-complete。部分输出保留为失败证据，工具不覆盖、不猜测修复。人工核验后重新选择新 target，不承诺自动恢复任意部分 SQLite 文件。

### MySQL checkpoint / resume

MySQL 使用独立 `enterprise_upgrade_v3`，不会覆盖 v2 `enterprise_upgrade` 的旧 12 步证据或 `schema_migrations`。DDL 有限阶段逐步核对 metadata、约束、trigger、原列、sequence 和映射，使用同一受限 deadline 与迁移锁。

```sh
npm run upgrade:multi-enterprise -- apply --manifest /private/approved-plan.json --resume
```

只允许原 plan、同一 source checkpoint、同一 incarnation 映射恢复**明确 before/after** 的状态。`unknown`（例如 DDL 发出后连接超时，结果不确定）始终拒绝自动 resume；必须离线人工核对，不通过清除 checkpoint 或重跑 SQL 猜结果。生产前仍需在获准专用 MySQL 实例验证；offline mock/metadata 测试不替代真实 MySQL 验收。

### 离线登记新 profile

`register` manifest 同时包含 `previousRegistry` 和新的 `registry`。revision 只能 old+1，legacy UUID 永久不变；只允许添加 profile，不允许删改既有 ID、slug、公开入口、Secret 引用或 identity 配置。新 profile 仅创建 registry/config 及空默认 settings，不复制用户、凭据、证书，不进入 pool、不自动开户。

SQLite 从旧 schema3 standalone source 写到独占新 target；MySQL 用迁移锁和 registry revision CAS 事务登记。登记后用同一 registration manifest `verify` 配对三服务；SQLite还逐旧企业比较全部原业务行、incarnation、旧receipt和既有profile/cap，新增企业的空设置不混入保真比较。重复旧 revision 登记会拒绝，不能把冲突当成功；若一服务已完成而其它失败，先 inspect / 人工核验，按明确各服务状态处理，本工具不承诺跨服务自动 rollback。

## Runtime / 测试接口

- `validateEnterpriseSqliteV3(db, component, expectedRegistry)` / `validateEnterpriseMysqlV3(connection, 'proxy', expectedRegistry)`：只读 gate，返回 `{registry, legacyEnterpriseId, layout, maxAccounts?}`。
- `initEnterpriseSqliteV3` / `initEnterpriseMysqlV3`：仅显式 offline/test 调用。
- `createEnterpriseSqliteSchemaV3` / `getExpectedEnterpriseSqliteV3`、`enterpriseMysqlSchemaV3` / `getExpectedEnterpriseMysqlV3`：冻结结构描述供合成测试，不用于 runtime 自动修复。
- pool 外键保留，增加 legacy-only INSERT/UPDATE gate；账号 enterprise/incarnation 不可改。授权 attempt 独立保留结果 fingerprint（HMAC/私有摘要）、无明文 token，不随账号删除。

本目录测试只使用合成数据、隔离临时目录和 mock：

```sh
npm run test:upgrade:multi-enterprise
npm run typecheck:upgrade
```

真实 MySQL 验收文件当前只是固定 skip 占位，**尚未实现连接获准实例即可执行的完整真实验收 harness**；后续须补实际 DDL/触发器/双连接竞争/中断恢复测试并获得专用实例授权，不是配置一个环境变量就能转绿。本轮不读取现有环境，不运行 Docker / 云资源。此目录不实现第四阶段多企业 pool 调度，也不承诺运行后无损降级到 schema2。
