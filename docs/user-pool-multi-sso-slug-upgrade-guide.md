# 多企业账号池升级操作指南

> **本指南不是已批准的生产发布说明。** 当前版本化工具已在隔离MySQL8.4.11和mock全栈中执行迁移、恢复、并发及运行验收，具体结果、失败修正和未覆盖范围见[第五阶段报告](user-pool-multi-sso-slug-phase5-validation.md)；发布审查修复、5,000名字扩充及修复版实库/全栈复测见[第六阶段报告](user-pool-multi-sso-slug-phase6-validation.md)。发布时仍需固定并批准实际源码/镜像、客户备份和维护窗口；未提交源码不能仅用HEAD识别。合成mock不能替代真实GitHub企业SAML、SCIM、席位、OAuth device-flow与模型端验收。

## 1. 版本配对与适用范围

| 层 | 旧精确基线 | 中间阶段 | 本次目标 |
| --- | --- | --- | --- |
| Proxy 存储 | schema1，旧单企业 direct/pool | schema2 / contract1 → schema3 / contract2 | **schema4 / contract2**，`enterprise-multi-pool` |
| SSO / Login 存储 | schema1，SQLite | schema2 / contract1 | **schema3 / contract2** |
| 企业配置 | 旧单企业环境配置 | 单 profile → registry | **registry JSON version3**，不是 version4 |
| 部署组件 | 旧版配套 | 不接业务的离线中间状态 | Proxy、SSO、Login、Console 四组件同一批准源码配对 |

v1 入口仅接受精确基线 `8ad76d547c9d067aac79f99391859cc67dcd7b44` 的结构。未知旧版、额外表/约束、部分升级、未来版本或缺失 trigger/FK/CHECK/index 都应停止，不允许“尽量兼容”。已有旧 SQLite→MySQL/importer 仍输出冻结 schema1，不能跳过后续企业迁移。本指南的生产池路径为 Proxy MySQL，SSO/Login SQLite；Proxy SQLite 的离线支持不构成多副本共享 SQLite 部署方案。

升级批准记录必须配对保存：

- 源 HEAD、是否 dirty、实际 source bundle SHA256（未提交源码不能仅用 HEAD 指代）；
- 同源构建的 Proxy / SSO / Login / Console 镜像 ID 与不可变 digest；
- 迁移 tooling 的源码/依赖锁文件来源；正常生产镜像通常不含 upgrade/tests/tsx，不能假定可在其中直接执行 CLI；
- MySQL 实际版本与连接目标、manifest / registry revision、备份引用与校验值、操作者及时间。

不要把本文示例中的路径、数据库名或占位值照抄到客户环境。下面命令均需已获准的维护会话；CLI 不替操作者取得生产权限。

### 名字目录：5,000 × 2，仍为全局一万个

本候选保留原1,000个名字及顺序，追加4,000个覆盖F–Z的合成组合，改为5,000个 base × `00–01`，总量仍为10,000；所有企业共用同一 cursor，不能跨企业重复分配。来源和可复现生成说明见[名字目录文档](pool-name-catalog-provenance.md)。

**扩大列表会改变 ordinal≥1000 的生成规则，不能只凭“当前账号少”判断可升级。** 本候选对最终V4迁移预检和启动增加只读兼容检查。原始前缀账号与cursor≤1000且映射一致可采用新目录；旧高序号账号、未知别名或消耗历史有歧义时返回 `name_catalog_upgrade_required`，不改名、不重编号、不回拨cursor。升级前在隔离备份上完成整个迁移预检链；原库保持不变，失败时保留旧运行版本，另做身份保真的迁移方案。此限制不允许在客户库手改identity或ordinal来通过检查。

### MySQL 运行账号：trigger 可见性与权限取舍

当前 Proxy 的精确 schema validator 会用**实际运行账号**读取 trigger metadata。只给 `SELECT` / `INSERT` / `UPDATE` / `DELETE`，不保证该账号能看见 `INFORMATION_SCHEMA.TRIGGERS`；“查询成功但返回零行”可能是权限过滤，不是库内真的没有 trigger。第五阶段隔离环境已观察到同一库 root 可见 13 个 trigger、DML 运行账号可见 0 个，而两者均可见 19 张表；DML账号实际启动校验拒绝，仅在该测试schema追加TRIGGER后完整validator通过。该结果只证明当前实现与该测试MySQL版本的权限要求，不授权客户生产环境自动授予权限。

本实现需要运行账号具有目标业务 schema 范围的 `TRIGGER` 权限，使完整 trigger metadata 可见，并与业务 DML 权限一起经过部署审核。**`TRIGGER` 不是只读 metadata 权限：它同时允许在获授权范围内 `CREATE TRIGGER` / `DROP TRIGGER`。** 即使正常应用代码只读校验，这一数据库权限仍扩大了运行账号被滥用时的能力，必须由客户 DBA / 安全负责人明确评审；不得以“只为读取 metadata”为由隐瞒 DDL 能力。

- 权限仅限定批准的 Proxy 业务 schema；不自动升级为全局权限、`ALL PRIVILEGES`、`SUPER` 或 root。离线迁移账号与长期运行账号分离，逐一评审各自用途。
- 本文和测试夹具**不会替客户自动授权**。正式部署前由 DBA 核对服务器版本、认证账号/角色、实际 schema 范围和组织策略，形成显式授权记录；测试库的 grant 不能照搬为客户库操作许可。
- 必须在真实完整 schema 上，以与 Proxy 相同的运行凭据执行只读精确 validator，并检查表、约束、索引和全部 trigger 可见性；root 校验通过、空库建好或连接测试通过都不能代替这一检查。
- 若组织不允许运行账号拥有此 DDL 能力，应将当前发布视为部署阻塞，审阅独立设计方案，而不是跳过 trigger 检查、降低 validator 要求或改用生产 root 运行。若上线后撤销该权限，也需要重新验证其对服务 gate 的影响。

## 2. Service / LB 是默认多 Proxy 入口

多 Proxy 共享 **同一个写库** 和相同 registry/池不变量；SSO、Login、Console 各单实例。普通 Kubernetes Service 或普通 round-robin LB 即可作为 Proxy 入口，不要求每个 caller 的请求固定到同一 Pod。租约、hold、credential fence 与 owner 状态由数据库协调，不靠进程内 hash 分片。

- 配置 `profile.routes.proxyInternalUrl` 为稳定的内部 Service/LB；所有四组件使用一致的服务路由与 Secret。
- Proxy 的 ready gate 通过之后才入流量；SSO/Login 就绪仍需配对 registry/schema，不能以 HTTP 进程活着代替。
- 边缘与内部 LB 都不得在响应错误、超时、断连后自动重放推理 POST；应用返回的 429 不应通过换账号重试，未知结果也不能盲目重放。
- **不依赖独立 NGINX hash-router 分支，不需要先合并它。** 若已有其他路由层，单独核对其超时、retry、redispatch 和同源行为。
- Console 经反向代理时保留实际浏览器 Host（含端口）与正确 Origin，不通过伪造同源绕过管理写入检查。内部管理 token 不暴露给浏览器。

## 3. 维护与备份：业务 pause 不等于停写

1. 先记录现有 global pool settings、企业 cap、lease 数量/TTL、账号数量和 ordinal/next_ordinal、管理员文件摘要。保留原 registry/环境、证书/私钥、SP entity/ACS、Secret、数据库连接及旧镜像配对。
2. 通过受认证管理界面/API 暂停池补货，再关闭入口并停止 **所有** Proxy writer/worker、Login 任务、SSO 外部操作及 Console 管理写入。仅 `paused=1` 不是离线维护边界，运行中的进程仍可能写统计/完成记录。
3. 等待或明确结束 owner、inference/catalog holds、identity claim 和活动授权；对已经发出的 SCIM/席位/OAuth 操作逐一核对结果。未知结果不能删除任务/nonce/checkpoint 来变成“已排空”。
4. 有效 caller lease 可以保留，不批量 release、不删账号、不重建账号 incarnation；**无须等 48 小时 TTL 到期**。真正需要排空的是活动工作、hold、owner 与未决外部操作，不是所有持久租约。
5. 在无 writer 状态取得 MySQL 一致完整备份（包括数据、约束、索引、trigger、metadata/receipt）并记录 SHA256。按部署的备份制度恢复到第二个全新隔离目标核验；别覆盖唯一副本。
6. 使用 SQLite 官方 backup API 或经过核验的一致备份方式，得到无 `-wal/-shm/-journal` 的 **standalone rollback-journal 文件**。不能直接复制活动主文件、删除边车或用 immutable 忽略 WAL。SSO/Login 原文件保留；每阶段 target 都用全新路径。
7. 备份 Console `admins.json`（原 hash/salt/启用状态）及恢复材料；升级不要求重置管理员、重置所有 SSO 密码或更换 SAML 签名证书。

只有这些事实真的成立，manifest 的 `writersStopped`、`externalOperationsDrained`、`backupVerified` 才能填 `true`。MySQL DDL 不是可由事务 rollback 撤销的操作。

## 4. 准备三个独立 manifest

在权限受限目录中分阶段生成；plan 带 credential 派生摘要与实例映射，不放日志、工单、源码仓库。所有文件路径使用绝对路径，目标不能预先存在。三个服务必须一起描述；这不提供跨存储分布式事务。

| 步骤 | 输入 manifest 的必要顶层信息 | 输出 |
| --- | --- | --- |
| 1→2 | `manifestVersion:1`, `baseline:"8ad76d5"`, 原企业 `profile`, `services`, `attestations` | schema2，单 profile contract1 |
| 2→3 | `manifestVersion:3`, `sourceSchemaVersion:2`, `registry`, `services`, `attestations` | 三服务 schema3，contract2 |
| Proxy 3→4 | `manifestVersion:4`, `sourceSchemaVersion:3`, 相同 JSON3 `registry`, `services`, `attestations` | Proxy4；SSO/Login3 只校验并复制到新目标 |

详尽字段与可审阅示例分别见：

- [default-enterprise 格式](../upgrade/default-enterprise/README.md)
- [multi-enterprise 格式](../upgrade/multi-enterprise/README.md)
- [multi-enterprise-pool 格式](../upgrade/multi-enterprise-pool/README.md)

MySQL service 的真实形状为 `component:"proxy",driver:"mysql",layout:"pool",location:{host,port,database,connectionEnv},backup:{reference,sha256}`。`connectionEnv` 以 `ENTERPRISE_MYSQL_` 开头，只从该明确环境变量读取 URI，URI 的 host/port/database 必须完全匹配 manifest；不能带 query/fragment。不加载 `.env`，不用默认 `MYSQL_URL`。非字面 loopback（包括 `localhost` 或容器 DNS）必须提供对应 `<connectionEnv>_CA_FILE` 并验证 TLS 主机身份；无 TLS 仅允许数值 `127.0.0.1`/`[::1]` 且实际 TCP peer 确实是 loopback。密码不放命令行或 manifest。

SQLite service 包含 `component/driver/layout/source/target/backup`。每阶段 source 是真实备份文件；先取得该阶段成功输出的新备份，再准备下一阶段 manifest，不能复用第一阶段的 backup hash。

registry 要点：

- 原企业 UUID 只生成/批准一次，`legacyEnterpriseId` 永久 pin；真实 slug/shortcode 唯一，原有用户名/NameID/证书/信任地址保持不变。
- legacy 保留 `/sso`、`/login`、`/logout` 根入口；新企业使用 `/profiles/<UUID>/...`，不能把同名用户当作跨企业同一个人。
- `sso` 保存 signing cert/key/session/SCIM/PAT/default-password 的 `file` 或 `env` 引用，不内嵌 Secret 值。所有服务挂载同一可信 registry 内容，Secret 路径由部署系统提供。
- 2→3 preflight 一次生成 account/user incarnation 映射并写入受保护 plan；apply/resume 不重抽 UUID。Proxy3→4 **不接受也不重新生成**这些映射。
- registry 的 `maxAccounts` 是新 profile seed。已有 cap 的权威是数据库，不能改 seed 企图重设原企业库存。

## 5. 执行真实版本化命令：1→2→3→Proxy4

在已校验的源码/tooling 根目录，使用已安装并锁定的依赖。环境变量通过组织批准的 Secret 注入机制配置，不在 shell 历史里写密码。以下 `/private/upgrade/...` 都需替换为真实的新文件路径。

```sh
# schema1 → schema2
npm run upgrade:default-enterprise -- preflight --manifest /private/upgrade/v2-request.json --plan-out /private/upgrade/v2-approved-plan.json
npm run upgrade:default-enterprise -- apply --manifest /private/upgrade/v2-approved-plan.json
npm run upgrade:default-enterprise -- verify --manifest /private/upgrade/v2-approved-plan.json
npm run upgrade:default-enterprise -- inspect --manifest /private/upgrade/v2-approved-plan.json

# 上一步逐服务 ready 后，保存新备份，形成 v3-request；不要开放运行时写入。
npm run upgrade:multi-enterprise -- preflight --manifest /private/upgrade/v3-request.json --plan-out /private/upgrade/v3-approved-plan.json
npm run upgrade:multi-enterprise -- apply --manifest /private/upgrade/v3-approved-plan.json
npm run upgrade:multi-enterprise -- verify --manifest /private/upgrade/v3-approved-plan.json
npm run upgrade:multi-enterprise -- inspect --manifest /private/upgrade/v3-approved-plan.json

# 再保存 schema3 备份；最后仅 Proxy 升4，SSO/Login 保持3。
npm run upgrade:multi-enterprise-pool -- preflight --manifest /private/upgrade/v4-request.json --plan-out /private/upgrade/v4-approved-plan.json
npm run upgrade:multi-enterprise-pool -- apply --manifest /private/upgrade/v4-approved-plan.json
npm run upgrade:multi-enterprise-pool -- verify --manifest /private/upgrade/v4-approved-plan.json
npm run upgrade:multi-enterprise-pool -- inspect --manifest /private/upgrade/v4-approved-plan.json
```

不要用 `init` 代替迁移。`init` 仅适用于全新空 schema 和不存在的 SQLite target；初始池强制 paused、无 owner、next_ordinal=0，V4 所有 profile Draft。

每步检查 exit code、每组件状态、registry pairing 与 apply/verify 的 `ready:true`。`preflight`/`inspect` 是诊断命令，并不以 `ready:true` 表示可恢复业务；不能只看 marker 或只看进程退出成功。保存逐原列/原类型保真、lease、generation、密码 hash/salt、ordinal、sequence、schema/trigger、receipt 证据。Console 文件和 SAML 材料另行核对。离线 verify 在恢复写入 **之前**执行；运行时已写入后，业务行变化可能让旧 source fidelity 校验不再成立，不能据此假装迁移前状态未变。

## 6. 失败、恢复与回退界线

- 三个存储不具备原子切换：某服务成功、另一个失败时，继续保持维护隔离，逐服务 inspect。不要启动半迁移集群，也不要重复运行不明 SQL。
- V3/V4 MySQL checkpoint 的 `unknown`（例如 DDL 发出后 ACK 丢失、COMMIT 结果未知）**拒绝自动 resume**。只有原 plan、绑定不变且精确 before/after 已证明的状态，才由操作者使用相应 `apply ... --resume`。不清 checkpoint、不改 marker、不编辑 receipt，不把“再次执行没有报错”当证明。
- V2 使用其冻结的精确 before/after 证明规则；不能把后期的恢复语义反向套入旧工具，也不能统一承诺任意断点续跑。
- SQLite 已有 target 只有完整 receipt/source/plan/原列校验匹配才认可；未知或半成品保留为失败证据，选择新的隔离 target 或从已验证备份恢复，不覆盖源/目标。
- 恢复演练把 dump/SQLite 放到新的隔离实例/文件路径。尽可能维持原 database name，以满足 receipt 绑定；若定位变化被工具拒绝，应按受审阅恢复方案处理，不能改 receipt 通过验证。

回退分三种情况：

1. **仅离线迁移、尚未启动新版写入**：可选择完整已验证的升级前备份与旧四组件配套恢复，仍需维护窗口及逐项校验；MySQL不是简单镜像回退。
2. **新版已启动/发生任意运行时写入**：不提供通用无损降级。优先保留当前库/证据，修复向前；恢复旧备份意味着丢弃备份后的写入，必须由业务方明确批准。
3. **新增企业已经产生外部账号/席位**：数据库回滚不撤销外部系统操作，先核对并协调外部状态，不能用旧库覆盖来“消除”副作用。

旧 binary 并不保证在所有 direct/caller-lease 冷启动或已运行路径上自行拒绝新版 schema。停旧 writer、撤销旧入口/连接访问是实际安全边界，不能仅依赖新版 validator。

## 7. 切换、追加企业与管理 API

1. 仍保持业务 pause，部署同源四组件及相同 JSON3 registry，绑定批准的新 SQLite 目标；所有 Proxy 指向同一写库并使用同一原 PoolConfig fingerprint 不变量。运行时只校验，不做自动 DDL。
2. 检查每副本 readiness、SSO/Login 配对、Console 原管理员登录和原企业 cap/lease/凭据/证书保真。3→4 仅 legacy policy 保留 active（`migration_preserved_v3`）；其他企业 Draft，不等同于已真实 GitHub 验收。
3. 新增企业先再次进入维护边界，准备 `previousRegistry` 与只追加 profile 的新 `registry`；registryRevision 恰好 +1，既有 profile 原样不变，legacy UUID 不变，所有 Secret/证书均属于新企业，不能复制原企业凭据。
4. 用 V4 `register`，再用同一 registration manifest verify/inspect；SQLite 使用独占的新目标，MySQL 在已绑定库内 CAS/锁保护登记。成功后更新四组件挂载并重启校验。已有 cap、lease 与账号不移动；新 policy 为 Draft。

```sh
npm run upgrade:multi-enterprise-pool -- register --manifest /private/upgrade/register-approved.json
npm run upgrade:multi-enterprise-pool -- verify --manifest /private/upgrade/register-approved.json
npm run upgrade:multi-enterprise-pool -- inspect --manifest /private/upgrade/register-approved.json
```

管理路由以下均带 `/api` 前缀、内部认证且不公开。推荐 Console 操作；如使用受保护自动化，必须读当前 version 后 CAS 写入，不重放冲突请求：

| 操作 | 方法与路径 | 请求字段 |
| --- | --- | --- |
| 总览 / 全局设置 | GET `/api/management/enterprises`、GET `/api/management/pool/settings` | 无 query |
| 全局 pause / idle / TTL | PATCH `/api/management/pool/settings` | `expectedVersion`, `changes:{paused,idle_target,lease_seconds}` 的所需子集 |
| 企业 policy | GET `/api/profiles/<UUID>/pool-policy` | 无 query |
| 设置 cap | PATCH 同上 | `expectedVersion`, `maxAccounts` |
| 配置校验 | POST 同上加 `/validate` | `expectedVersion` |
| 显式启用 / 排空 | POST 同上加 `/activate` 或 `/drain` | `expectedVersion`, `confirm:true` |

registry 是各进程生命周期内固定的可信配置；更新文件本身不会热加载。离线登记后必须配对重启全部服务，不能只重启一个 Proxy。

SSO 创建容量是独立的实时检查，不写入已保存的 validate/activate 证据。某企业已达到 SSO 用户上限时，不再作为新开户候选，但已有成员的登录、修复和正常租用不因此被当作配置失败。若容量检查后又被并发 direct 用户占满，权威的 `sso_user_limit_reached` 拒绝会让已登记成员保留同一名字/ordinal 并安全失败，不计可靠 pending supply；容量恢复后由管理员显式 Retry，不自动无限提交或清理库存。readiness 完整数据库校验在启动时执行；运行中只读核对已验证连接、FK、schema 版本及 registry/profile/完成标记，不周期扫描全部业务历史。

validate/activate 的证据是本地服务配置就绪，**不是 GitHub 端认证证明**。Draft → Validated → Active；drain 后重新 validate 再 activate。解除全局 pause 是单独批准动作。全局 idle 目标与可用总 cap 是不同概念；新增企业不因存在就立即建号，只有真实缺口参与比例补货。cap 下调不删已有账号、不移租约；draining 停止新供应/新租约，既有租约的允许工作按存储 fence 继续处理。TTL 策略变更不是迁移凭据/清租约的理由。

## 8. 上线签核清单

- [ ] 备份恢复、版本化迁移、精确 validator、完整原列/身份/lease 保真已有 **实际**证据。
- [ ] 已知 before/after、unknown、丢 ACK、连接中断的实际测试口径与模拟注入区分清楚。
- [ ] 多 Proxy / Service、真实 SSO/Login callback、错企业/旧 incarnation、cap/比例/排空、429 不重放、owner 接管通过规定验收；未跑项明确 SKIP/阻塞。
- [ ] Console 同源写入、企业筛选、统计及管理员保真已检查。
- [ ] 真实 GitHub/企业配置未验证项明确列出，不用 mock 结果替代。
- [ ] 四组件镜像和 source bundle 配对、结果/备份保留位置、旧 writer 隔离与回退批准人齐全。
- [ ] 最多 10 分钟功能稳定性窗口不称作 48 小时稳定性、吞吐容量或生产可靠性承诺。
