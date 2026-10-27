# 发布镜像资格验证

验证 `deploy/images/Dockerfile.release` 构建出的四个镜像能否发布。只使用合成数据、mock 外部服务和本地 MySQL 容器；不连接真实 GitHub、Copilot、SSO，不推送镜像。Docker Desktop 上只验证功能，不评估性能。

## 文件

| 文件 | 用途 |
| --- | --- |
| `compose.yaml`、`mock.mjs`、`verify.mjs` | SQLite 直连模式的快速冒烟：健康检查、合成凭据导入、`/v1/messages` JSON/SSE 与缺少 beta 头时的 400、SSO/Login/Console 基本接口。 |
| `ghe-compose.yaml`、`ghe-e2e.mjs` | GHE.com 模式全链路：真实 SSO（SAML IdP）+ 真实 Login（Chromium 设备授权）+ Proxy 账号池，mock（`tests/docker-user-pool/mock-ghe.mjs`）扮演 `*.ghe.com` 各主机。驱动容器的退出码即结果。 |
| `qualification-compose.json` | MySQL 8.4 + 双 Proxy（caller-lease）+ SSO/Login/Console + mock + 本机回环 bridge 的完整环境。 |
| `qualification-prepare.mjs` | 新建一次运行目录（`.claude/release-qualification-run-<uuid>/`）：复制并适配 `tests/docker-user-pool` 的 smoke 与 mock、写入合成证书和 MySQL 初始化脚本；多企业模式下另外生成 Compose 文件、registry 与合成 secret 文件。 |
| `qualification-run.mjs` | 执行资格验证。默认模式：基线镜像 → 候选镜像 → 基线镜像（同一数据卷原地升级再回滚）；`RELEASE_QUALIFICATION_MODE=candidate-fresh`：候选镜像全新库；`multi-upgrade` / `multi-upgrade-sqlite`：多企业原地升级；`multi-fresh` / `multi-fresh-dba` / `multi-fresh-sqlite`：多企业镜像的全新单企业部署（见下文，都委托给 `qualification-multi-run.mjs`）。 |
| `qualification-verify-runtime.mjs` | 在每个运行中的容器里执行：Tini/npm/工作目录、依赖版本与行为、better-sqlite3、Login 内 Chromium、持久化数据摘要（SSO、Login 表按列哈希）等。第三个参数 `scoped` 用于多企业镜像（管理 API 走 `/api/enterprises/default/...`，并断言无作用域路径返回 400）；可选第四个参数是 SSO 用户数（默认 3）。内部 token 取容器自己的 `INTERNAL_API_TOKEN`，所以 MySQL 与 SQLite 两套合成环境都能用。 |
| `qualification-dependency.mjs` | 基线与候选的依赖补丁行为对照（独立、离线容器内执行）。 |
| `qualification-multi-lib.mjs` | 多企业资格验证的纯函数：步骤计划与断言清单、registry、Compose 生成、隔离规则、cookie 签名、表对比等。没有 Docker/网络访问。 |
| `qualification-multi-lib.test.mjs` | 上述纯函数的 `node --test`；若 `src/packages/shared/dist` 已构建，还会用产品自己的 `loadRegistry` 校验 step 4 的 registry（无 env 冲突、无 blocker、`default` 身份指纹不变）。 |
| `qualification-multi-run.mjs` | 多企业资格验证执行器（§9.4 第 1–5、7 步：MySQL；第 6 步：SQLite；以及全新部署的三个模式）。 |
| `multi-probe.mjs` | 在 mock 容器内执行的内网 HTTP 探针（SSO、Login 从不对外发布端口）。 |
| `multi-sqlite-snapshot.mjs` | 在已发布镜像内用其自带 better-sqlite3 输出 SQLite 逻辑快照（按列哈希；迁移 ID、trigger 名明文）。 |
| `multi-volume-copy.mjs` | 在无网络的一次性 helper 容器（已缓存的 node 镜像）内备份/恢复服务数据卷，保留属主、权限、时间并比对清单。 |
| `multi-controller.mjs` | 本机回环 HTTP 控制器（端口 18821），通过 preview 工具启动，串行执行 prepare + run。 |
| `idle-target-cap-check.mjs` | 独立检查：全局 `READY_IDLE_TARGET` 大于 `default` 企业上限（`POOL_MAX_ACCOUNTS`）时，候选 Proxy 能启动，设置 API 也接受更大的 `idle_target`（SQLite 无网络 + internal 网络上的一次性 MySQL）。可选 `RELEASE_QUALIFICATION_CONTROL_TAG` 指定旧的多企业标签作为对照（必须拒绝启动）。输入：`RELEASE_QUALIFICATION_PROJECT`、`RELEASE_QUALIFICATION_CANDIDATE_TAG`、`RELEASE_QUALIFICATION_MYSQL_IMAGE`、`RELEASE_QUALIFICATION_ISOLATED_SUBNET`；报告以 JSON 输出到 stdout；全部通过时只删除自己创建的容器、网络和卷，失败时停止并保留。 |

| `shutdown-keepalive-check.mjs`、`shutdown-keepalive-fixture.mjs` | 独立检查：四个镜像在 `docker stop`（SIGTERM）时如何对待 keep-alive 连接（共享的 `src/packages/shared/src/shutdown.ts`），见下文“停止时的长连接检查”。 |

`tests/docker-user-pool/mock-services.mjs` 按 `Host` 分发租户（设计 §9.5）：原有 `local-test`（github.com 形态）租户行为不变；`MOCK_GHE_TENANTS` 增加 GHE.com 租户（`contoso.ghe.com` 网页与设备流、`api.contoso.ghe.com` 的 SCIM/席位/`/user`、`copilot-api.contoso.ghe.com` 的 models/推理），每个租户独立的用户、席位、token、任务和计数，别的租户的凭据一律 401。GHE.com 句柄无后缀且不超过 30 字符；数字用户 ID 在每个租户都从 1001 开始（故意重复，覆盖 §6 的缓存键要求）。fake Login 同时支持 `/api/tasks`（单企业）和 `/api/enterprises/:id/tasks`（带作用域的回调 `/internal/enterprises/:id/...`）。设置 `MOCK_LOGIN_READINESS_URL=http://login:7003` 时，Proxy 经 `LOGIN_BASE_URL`（即 mock）读取的 `GET /internal/enterprises` 转发给真实 Login。`mysql-bridge.mjs` 的 mock 模式转发时保留原始 `Host`。`mock-services.tenants.test.mjs` 在本机子进程中验证这些行为（不需要 Docker）。

## 运行（单企业 single-slug）

每次运行必须使用**新的** Compose 项目名和未被占用的子网；脚本拒绝复用已存在的项目或卷。

```bash
export RELEASE_QUALIFICATION_PROJECT=ghcp-release-qualification-<唯一后缀>
export RELEASE_QUALIFICATION_CANDIDATE_TAG=single-slug-<7位提交>-amd64-r<N>
export RELEASE_QUALIFICATION_CERTS_DIR=<含 idp-cert.pem / idp-key.pem 的合成证书目录>
export RELEASE_QUALIFICATION_MYSQL_IMAGE=<本地已缓存的 mysql:8.4 镜像 ID 或带 digest 的引用>
export RELEASE_QUALIFICATION_ISOLATED_SUBNET=10.244.x.0/24
export RELEASE_QUALIFICATION_INGRESS_SUBNET=10.244.y.0/24
node tests/image-release/qualification-prepare.mjs   # 输出 RELEASE_QUALIFICATION_STATE <run.json 路径>
RELEASE_QUALIFICATION_CONFIRM=$RELEASE_QUALIFICATION_PROJECT node tests/image-release/qualification-run.mjs <run.json 路径>
```

结果写入运行目录的 `qualification-report.json`。

## 多企业原地升级资格验证（设计 §9.4）

两个模式，都是 **single-slug r4 → multi 候选** 的原地升级：

| 模式 | 环境 | 覆盖步骤 |
| --- | --- | --- |
| `RELEASE_QUALIFICATION_MODE=multi-upgrade` | MySQL 8.4 + 两个 Proxy 副本（caller-lease）+ SSO/Login/Console + mock + 回环 bridge | §9.4 第 1、2、3、4、5、7 步 |
| `RELEASE_QUALIFICATION_MODE=multi-upgrade-sqlite` | SQLite 直连（`compose.yaml` 的同构生成版）+ SSO/Login/Console + mock，无对外端口 | §9.4 第 6 步 |

### 输入（环境变量，不读 `.env`）

| 变量 | 说明 |
| --- | --- |
| `RELEASE_QUALIFICATION_MODE` | `multi-upgrade` 或 `multi-upgrade-sqlite`。 |
| `RELEASE_QUALIFICATION_PROJECT` | 全新的项目名，`ghcp-release-qualification-<后缀>`；`RELEASE_QUALIFICATION_CONFIRM` 必须等于它。 |
| `RELEASE_QUALIFICATION_CANDIDATE_TAG` | 本地候选标签 `multi-<sha7>-amd64-r<N>`（§11）；四个组件 `ghcp-release-{proxy,sso,login,console}` 都必须已在本地。 |
| `RELEASE_QUALIFICATION_BASELINE_TAG` | 可选，默认 `single-slug-164cade-amd64-r4`（必须是 single-slug 标签）。 |
| `RELEASE_QUALIFICATION_CERTS_DIR` | 合成 IdP 证书目录（`idp-cert.pem`、`idp-key.pem`，有效期内且配对）。 |
| `RELEASE_QUALIFICATION_MYSQL_IMAGE` | MySQL 模式必填：本地已缓存的 mysql:8.4（镜像 ID，或 `mysql:8.4[@sha256:…]`）。 |
| `RELEASE_QUALIFICATION_ISOLATED_SUBNET` / `RELEASE_QUALIFICATION_INGRESS_SUBNET` | 未使用的 `10.x.y.0/24`；SQLite 模式只用 isolated。 |
| `RELEASE_QUALIFICATION_BUDGET_MINUTES` | 可选，总时限（MySQL 默认 50 分钟，SQLite 默认 20 分钟；清理另有 5 分钟）。 |
| `RELEASE_QUALIFICATION_STATS_DOUBLINGS` | 可选，第 7 步把 `proxy_request_stats` 翻倍的次数（默认 10，约 ×1024；每次复制换一个 identity，保证每个 identity 不超过保留上限）。 |

镜像与依赖：不构建、不拉取；`node:22-bookworm-slim@sha256:efd0ab57…`（mock、bridge、helper）和 mysql 镜像必须已缓存。

```bash
RELEASE_QUALIFICATION_MODE=multi-upgrade node tests/image-release/qualification-run.mjs --plan   # 只打印步骤计划，不碰 Docker
RELEASE_QUALIFICATION_MODE=multi-upgrade node tests/image-release/qualification-prepare.mjs
RELEASE_QUALIFICATION_MODE=multi-upgrade RELEASE_QUALIFICATION_CONFIRM=$RELEASE_QUALIFICATION_PROJECT \
  node tests/image-release/qualification-run.mjs <run.json 路径>
```

### prepare 生成的内容（都在运行目录里）

- `base.compose.json`：由 `qualification-compose.json` 生成。去掉各服务的“按企业”环境变量（Proxy：`COPILOT_API_BASE_URL`、`ENTERPRISE_SHORTCODE`、`POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_MAX_ACCOUNTS`；SSO：`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`、`GITHUB_API_BASE_URL`、`SCIM_BASE_URL`、`SP_ENTITY_ID`、`SP_ACS_URL`、`CERT_DIR`；Login：`SSO_URL`、`GITHUB_OAUTH_CLIENT_ID`）；mock 增加 `contoso.ghe.com`、`api.contoso.ghe.com`、`copilot-api.contoso.ghe.com` 三个 internal 网络别名和租户配置；`proxy2` 展开为完整定义（不用 `extends`）。
- `legacy.compose.json`：把上述变量原样加回。`base + legacy` 渲染后的环境与 r4 资格验证完全一致（单元测试和 preflight 都会比对），用于第 1、2、3、5、7 步——即“不提供 registry、env 不变”。
- `registry.compose.json`：给 proxy、proxy2、sso、login 加 `ENTERPRISE_REGISTRY_FILE=/registry/registry.json` 和只读挂载 `/registry`，用于第 4 步。被去掉的变量此时不存在，满足 §3.5 的冲突规则；`default` 的 secret 用 `{ "env": … }` 引用仍保留的 `SESSION_SECRET`、`SCIM_TOKEN` 等。
- `registry/registry.json`：`default`（逐项重述 r4 的身份字段，指纹不变；另把 `github.apiBaseUrl` 指向 mock，供 Proxy 回调主体校验 `/user`）+ `contoso-eu`（GHE.com mock：`http://contoso.ghe.com:8002`，`shortcode: ""`，`initialMaxAccounts: 2`，secret 全部是 `/registry/contoso/*` 文件引用）。`registry/contoso/*` 是合成 secret。
- `fixtures/`：smoke、bridge、mock（含 `mock-ghe.mjs`）、探针、快照、卷复制脚本。
- SQLite 模式只生成 `sqlite.compose.json`（与 `compose.yaml` 的服务环境逐项一致，单元测试比对）。

### 步骤与断言（MySQL，`multi-upgrade`）

断言名即 `qualification-report.json` 中 `stepResults[].assertions[].name`；计划里的每个断言都必须通过（`planCoverage.complete`），否则整体不通过。

1. **preflight**：项目、卷、备份卷都不存在；`legacy` 与 `registry` 两种渲染都满足隔离规则（服务集合固定、应用只在 internal 网络、无端口、不覆盖 CMD、bridge 只绑 127.0.0.1、卷都属于本项目、mock 别名、`/registry` 只读）；r4 与候选共 8 个镜像、mysql、node 都在本地；候选镜像保持 Tini/CMD/WORKDIR；候选 Proxy 在旧模板命令覆盖下能启动并干净退出。
2. **step1（r4 基线）**：r4 启动，原样运行 `mysql-smoke.mjs run`（两副本、真实 SSO、mock SCIM/席位/回调、三种协议、租约、冷却、hold）；`lease_seconds` 提到 7200 并续租两个 caller；Console 登录；用池用户在 SSO 根路径登录得到 r4 的 `sso_session` cookie，并在 r4 上验证 `/sso` 返回 SAMLResponse，记录 `/metadata` 的 entityID 与证书；容器内运行时检查；暂停并排空后取逻辑快照（r4 列清单的哈希、schema、迁移 ID、事件最大 ID）；停止应用；`mysqldump`（`--single-transaction --routines --triggers --set-gtid-purged=OFF`）写到 `backups/mysql.sql`；helper 容器把 SSO/Login/Console/Proxy 卷复制到 `<project>_qualification-backup` 卷并比对清单。
3. **step2（候选，同一卷，无 registry，env 不变）**：渲染环境与 r4 相等；基础设施容器未重建；快照中设置（除 `config_fingerprint`）、凭据、成员、租约、统计全部不变；`config_fingerprint` 被改写为 v2；`schema_migrations` 含 `enterprise-v1/01…08` 且保留旧 ID；四张表 `enterprise_id` 全为 `default`，升级前的事件也全部回填；`enterprise_id` 为 NOT NULL 且无默认值，并用 `pool_load` 账号实际插入一行不带 `enterprise_id` 的统计，必须被拒（`ER_NO_DEFAULT_FOR_FIELD`）；`proxy_enterprises` 只有 `default`（active，cap 等于原 `max_accounts`，库存 3）；新的调度 owner 接管并续期；Console 旧会话有效、`/api/console/proxy/enterprises` 与作用域 summary 可用、无作用域 summary 返回 400；运行时检查（`scoped`）；SSO/Login 每个旧表的每个旧值都保留（仅允许 `sso_runtime_settings.id` 按设计删除）；根 `/metadata` 的 entityID 和证书不变；r4 的 `sso_session` 在候选上仍能换出 SAMLResponse；根路径重新登录写出 `e: "default"` 的新格式 cookie；Login 任务历史（本资格验证为 0 个真实任务）与表保留；同一 caller 的 6 个请求（3 协议 × JSON/SSE，两副本交替）绑定同一租约，新统计行 `enterprise_id='default'`；`/healthz` 的 `releaseLine`（候选为空或 `multi`，r4 为空或 `single`）。
4. **step3**：在已迁移的 MySQL 上用 r4 Proxy 镜像起一个一次性容器（同网络、同环境）：必须非 0 退出、从未打印 `listening`；schema、迁移 ID、`config_fingerprint` 不被它改动；候选两副本仍就绪。
5. **step4（registry + GHE mock 企业）**：按 SSO → Login → proxy → proxy2 → Console 滚动重启到 registry 阶段；容器环境中没有被清空的变量、有 `ENTERPRISE_REGISTRY_FILE` 和只读 `/registry`；`default` 的 `profile_fingerprint` 不变；`contoso-eu` 在两个副本上都是 `draft`（cap 2、库存 0）；三方 readiness 为 ready 且无 blocker；用过期 `expectedVersion` 激活返回 409 `policy_version_conflict`；正确版本激活成功（版本 +1）；全局设置带 `max_accounts` 返回 409 `use_enterprise_cap`；`idle_target=3` 后补货只进入 `contoso-eu`（2 个成员、`proxy_accounts`/`user_pool_accounts` 的企业都是 `contoso-eu`、库存计数 2/3、默认租户 SCIM 计数不变）；GHE 租户的句柄无后缀且 ≤30、回调全部走 `/internal/enterprises/contoso-eu/...` 且 Proxy 在 `api.contoso.ghe.com` 上做了 `/user` 主体校验；新 caller 落到 `contoso-eu` 后 6 个协议请求全部打到 `copilot-api.contoso.ghe.com`，统计行 `enterprise_id='contoso-eu'`。跨租户负面检查：错企业路径的 token 回调、prepare、login-task-protection 都是 404 且账号行不变；错企业的账号查询、成员 disable、租约 release 都是 404 且租约/成员不变；未知企业在 Proxy/SSO/Login/SAML 上都是 404；在 `contoso-eu` 建同名 SSO 用户后两边各自独立（不同 `createdAt`/`ghLogin`，跨企业密码互不通用）；cookie 互换（`sso_session` ↔ `sso_session_contoso-eu`）被拒、各自原 cookie 有效；用已知合成 secret 伪造的 cookie：`e` 与路由不符、或用别的企业的 secret 签名，都被拒（对照组：正确伪造的 default cookie 有效，证明负例有意义）；Proxy、SSO、Login、Console 的无作用域路径都返回 400 `enterprise_scope_required`；默认企业的账号、租约、mock 计数未被触动。
6. **step5（回滚演练）**：候选应用干净退出（退出码 0）；`DROP DATABASE` + 导入 step1 的 dump（库级授权保留）；helper 把备份卷复制回各服务卷并比对清单；r4 启动；快照与 step1 **完全**相同（含 schema、迁移 ID、`config_fingerprint`），没有任何 `enterprise_id` 列或 `enterprise-v1/*` 迁移；新 owner 接管；SSO/Login 表与 step1 逐表逐列逐值相同、Console 管理员文件相同；step1 的 Console 会话和 r4 `sso_session` 仍有效；同一租约 6 个协议请求。
7. **step7（迁移崩溃演练）**：停止 r4；把统计表翻倍到约 ×1024（每份换 identity，避免启动时的保留清理超时；记录用时）；root 会话对 `proxy_request_stats` 持 `LOCK TABLES … READ`；只启动候选 `proxy`；观察到 `ALTER TABLE proxy_request_stats …` 在等 metadata lock，且此时只记录了 01–04；`SIGKILL` 该容器（退出码 137）；结束它遗留的 MySQL 会话（等同连接断开）并释放锁；确认 05 未记录、统计表还没有 `enterprise_id`；重启 `proxy` 后 01–08 全部记录、回填完整、fail-closed 仍成立；其余候选服务启动，同一租约 6 个协议请求通过。

### 步骤与断言（SQLite，`multi-upgrade-sqlite`，第 6 步）

- **preflight**：新项目、隔离渲染、镜像在本地。
- **step6-baseline**：r4 直连模式；在 SSO 建用户、导入合成 OAuth token、JSON/SSE 推理各一次、SSO 根路径登录、Console 初始化；三个库的逻辑快照；停止并备份卷。
- **step6-candidate**：候选在同一卷上启动（env 不变）；`proxy_accounts`/`proxy_request_stats` 与 SSO/Login 所有旧值保留（其他 Proxy 表的差异只记录）；所有带 `enterprise_id` 的表全部为 `default`；Proxy 01–05、SSO 01–05、Login 01–03 迁移 ID；fail-closed trigger 存在；推理成功且新统计为 `default`；旧 `/api/accounts` 可用并带 `Deprecation: true`；无作用域的 request-stats、SSO users、Login tasks 为 400，作用域版本为 200；r4 的 SSO cookie 和 Console 会话有效。
- **step6-r4-on-migrated**：r4 Proxy 在已迁移的 SQLite 上启动（或启动失败）并尝试推理与导入新账号；离线快照中没有任何 `enterprise_id` 为空的行，行数不变（写入被 trigger 拒绝）。
- **step6-restore**：恢复备份卷，r4 启动，三个库与 step6-baseline 完全相同，推理和 SSO cookie 正常。

### 证据

- `qualification-report.json`：`plan`、每步 `stepResults`（断言名、通过与否、哈希/计数/状态码等证据，不含 token、密码或 cookie 值）、`images`（ID、CMD、ENTRYPOINT、OCI/release-line 标签）、`planCoverage`、`failure`/`failedStep`、`cleanup`。
- `logs/NNN.json`：每条 docker 命令的参数与输出（可能含合成 token，只留在运行目录）；`logs/mysql-smoke.json`。
- `backups/mysql.sql`、`secrets.json`（合成 cookie）、`failure-detail.json`（失败时）。
- 失败时只停止本项目容器，容器、网络、卷（含 `<project>_qualification-backup`）和 helper 容器（`<project>-helper-N`、`<project>-r4-on-migrated`、`<project>-legacy-command`）都保留供排查。

### 已知限制与发现

- 本资格验证中真实 Login 任务数为 0，“Login 任务历史完整”只能比对 Login 各表（包括空的 `login_tasks`）与运行时设置。
- **发现**：r4 的 Login 环境通常没有 `ENTERPRISE_SLUG`。把 `default` 写进共享 registry 并带上 `github.slug` 后，Login 的 `default` 指纹会变化；Login 只在没有任务时接受（否则启动报 `enterprise_identity_changed`）。有历史 Login 任务的客户在升级指南里需要特别说明（单元测试固定了这一行为）。
- Windows 主机上 `CERT_DIR` 按主机路径解析，单元测试中的“env 与 registry 相等时静默合并”只在 POSIX 下比较 `CERT_DIR`。
- **观察（r4 已有，非回归）**：MySQL 模式下 Proxy 启动时的 `pruneAllRequestStats` 走 5 秒语句时限。若统计表里大量行超出每账号保留上限（例如约 11 万行全部挂在 3 个 identity 上），启动会以 `POOL_SQL_TIMEOUT` 失败。正常运行时每次写入都会按账号清理，不会积压；第 7 步的放大因此每份复制都换 identity。
- 第 7 步用 `LOCK TABLES proxy_request_stats READ` 让迁移确定地停在 05 内（01–04 已记录）。必须先结束被杀副本遗留的 MySQL 会话、再释放表锁，否则排队中的 `ALTER` 会在“崩溃”之后完成（这本身也是可恢复的“已生效未记录”状态，但不是本步要断言的那个）。
- 项目名必须匹配 `ghcp-release-qualification-[a-z0-9-]+`（prepare 校验）。

## 多企业镜像的全新单企业部署资格验证

全新部署：空数据库、空卷、**没有** enterprise registry 文件，`default` 企业由各服务的环境变量合成。只用候选镜像（不需要 r4 基线镜像），输入变量、prepare/run 命令、证据和安全边界与上文相同（`RELEASE_QUALIFICATION_BASELINE_TAG` 不使用）。

| 模式 | 环境 | 说明 |
| --- | --- | --- |
| `multi-fresh` | MySQL 8.4（空库）+ 两个 Proxy 副本（caller-lease）+ SSO/Login/Console + mock + 回环 bridge | Proxy 自动迁移（不设置 `MYSQL_AUTO_MIGRATE`，即默认 `true`）。 |
| `multi-fresh-dba` | 同上 | DBA 路径：先只启动 MySQL 和 mock，用 root 以 `--default-character-set=utf8mb4` 执行 `scripts/proxy-mysql-initial.sql`（只把库名 `ghcp_proxy` 换成本环境的库名），把运行账号的 `GRANT ALL` 换成脚本头部写明的最小权限（库级 `SELECT, INSERT, UPDATE, DELETE` + `proxy_accounts` 上的 `TRIGGER`），两个副本都设 `MYSQL_AUTO_MIGRATE=false`。 |
| `multi-fresh-sqlite` | SQLite 直连（与 `multi-upgrade-sqlite` 相同的生成 Compose）+ SSO/Login/Console + mock，无对外端口 | 直连模式只有 `/v1/messages`（mock 只实现这一条）。 |

prepare 生成：MySQL 模式为 `fresh.compose.json`（即 `qualification-compose.json`，`proxy2` 展开，mock 增加 `MOCK_LOGIN_READINESS_URL`；两个 Proxy 增加 `GITHUB_API_BASE_URL=http://mock:8002`，DBA 模式另加 `MYSQL_AUTO_MIGRATE=false`；其余服务环境与 r4 资格验证逐项相同，单元测试比对）；SQLite 模式为 `sqlite.compose.json`。fresh 模式不生成 `registry/` 目录。

为什么 Proxy 要加 `GITHUB_API_BASE_URL`：多企业版 Proxy 在 Login 回传 token 时用 `default` 的 GitHub REST API 调 `GET /user` 核对账号身份（设计 §5.7）。r4 资格验证环境只给 SSO 设了这个变量，Proxy 因而使用默认的 `https://api.github.com`；隔离网络访问不到它，回调一律 503，成员三次重试后以 `oauth_login_failed` 失败，补货达不到空闲目标。升级资格验证不会遇到，因为它的 `default` 没有新补货，第 4 步的 registry 也显式写了 `apiBaseUrl`。

```bash
RELEASE_QUALIFICATION_MODE=multi-fresh-dba node tests/image-release/qualification-run.mjs --plan
```

### 步骤与断言（MySQL：`multi-fresh` 30 条，`multi-fresh-dba` 34 条）

1. **preflight**：项目、卷不存在；渲染结果满足隔离规则、没有任何服务引用 registry（`ENTERPRISE_REGISTRY_FILE` 或 `/registry` 挂载）、`MYSQL_AUTO_MIGRATE` 与模式一致；四个候选镜像、mysql、node 在本地；候选镜像保持 Tini/CMD/WORKDIR；旧模板命令覆盖下能启动并干净退出。
2. **fresh-dba-schema**（仅 DBA）：库里只有 fixture 表；执行初始脚本后业务表齐全，`schema_migrations` 恰为脚本写入的 ID（缺 `02-seed-default`、`08-pool-config-fingerprint`，由 Proxy 用运行时权限补），`proxy_enterprises` 为空；`SHOW GRANTS` 没有任何 DDL 权限。
3. **fresh-start**：全部服务健康；五个应用的 `/healthz` 都是 `releaseLine: "multi"`；`schema_migrations` 恰为 r4 的 3 个 ID + `enterprise-v1/01…08`，SSO 01–05、Login 01–03 齐全；（DBA）Proxy 启动前后 schema 指纹不变、Proxy 只补写了 02 和 08；`enterprise_id` NOT NULL 无默认值且不带它的插入被拒；`proxy_enterprises` 只有 `default`（active、cap = `POOL_MAX_ACCOUNTS`、库存 0），两个副本的 `GET /api/enterprises` 都只列出它；SSO、Login 的企业表也只有 `default`；单一调度 owner 并续期。
4. **fresh-console**：`/api/console/setup` 初始为未初始化 → 创建管理员 201 → 再次创建 400；登录成功、错误密码与匿名 401；Console 读企业列表（只有 `default`）、`default` 的池概览、SSO 用户、Login 任务、请求统计，无作用域的 Console 转发返回 400，未登录 401。
5. **fresh-pool**：初始 `idle_target=0`、池与 mock 为空；经 `proxy2` 把 `idle_target` 设为 3 后，经 mock SCIM/席位/Login/Copilot 补到 3 个 ready idle（SCIM 创建、任务、回调各 3 次，无失败），随后暂停补货；账号与成员都属于 `default`，Login 任务都走 `/api/enterprises/default/tasks`，SSO 有 3 个用户。
6. **fresh-caller**：新 caller 的 SSE 请求被 mock 挂住时，从另一副本看到 `provisional` 租约；取消后同一 caller 的 6 个请求（3 协议 × JSON/SSE，两副本交替）全部打到同一成员；租约在两副本上都是 `active`、`leaseId` 不变；统计行 6 条成功、都是 `default`；第二个 caller 拿到另一个成员。
7. **fresh-scope**：`/api/enterprises/default/...`（Proxy 账号、统计、池概览/租约/事件，SSO 用户，Login 任务）都是 200；无作用域的 Proxy 统计、池、`/internal/...`，SSO 用户与内部接口，Login 任务都返回 400 `enterprise_scope_required`。
8. **fresh-sso**：根路径 `/login` 登录得到 `e: "default"` 的 `sso_session`，错误密码 401；`/sso` 用该会话返回 SAMLResponse、匿名重定向到 `/login`；`/metadata` 的证书就是运行目录里的合成证书。
9. **fresh-runtime**：每个应用跑 `qualification-verify-runtime.mjs <service> candidate scoped <SSO 用户数>`。
10. **fresh-stop**：停止全部应用，退出码都是 0。

**发现（r2，DBA 路径）**：官方 mysql 镜像里的 `mysql` 客户端在 POSIX locale 下默认 latin1 会话。用它直接执行初始脚本时，CHECK 约束里的字符串字面量带 `_latin1` 前缀（例如 ``(`state` in (_latin1'draft',…))``），r2 Proxy 在 `MYSQL_AUTO_MIGRATE=false` 下只接受 `_utf8mb4`/`_ascii`，启动失败：`Unsupported MySQL schema: proxy_enterprises check constraints`。因此本模式显式用 utf8mb4 会话执行脚本，并断言 CHECK 字面量的字符集只有 `utf8mb4`。升级脚本 `proxy-mysql-enterprise-upgrade.sql` 含同样的 CHECK，预计有同样的问题（未在镜像级验证）。

### 步骤与断言（SQLite：`multi-fresh-sqlite` 23 条）

preflight（4）→ fresh-start（健康、`releaseLine`、Proxy 01–05 / SSO 01–05 / Login 01–03、fail-closed trigger、三个库的企业表都只有 `default`，`GET /api/enterprises` 只列出 `default` 且 `pool: null`）→ fresh-console（3，同上）→ fresh-direct（作用域 API 建 SSO 用户并导入合成 OAuth token；`/v1/messages` JSON 与 SSE；统计行都是 `default`；旧 `/api/accounts` 带 `Deprecation: true`）→ fresh-scope（2）→ fresh-sso（3）→ fresh-runtime（1）→ fresh-stop（1）。

## 停止时的长连接检查（`shutdown-keepalive-check.mjs`）

验证共享的优雅停止在镜像里的实际行为（r3 修复的问题，背景见 `deploy/kubernetes/README.md` 第 10.1 节）。一个 internal 网络（显式子网）上运行候选的四个服务（SQLite 直连，环境与 `compose.yaml` 相同、凭据为合成值）、一个 mock（`shutdown-keepalive-fixture.mjs mock`：慢的 `/v1/messages` JSON；SSE 与 CSV 导出一直持续，直到客户端在 SIGTERM 之后调用 `/release`，再过 2 秒结束）和每个服务一个客户端容器（`shutdown-keepalive-fixture.mjs client`，原始 HTTP/1.1 套接字，能看到每个连接上的响应头、FIN 与 RST）。不发布端口，不构建、不拉取镜像，不访问任何外部地址。

对每个服务，客户端先建立：A 一个空闲的 keep-alive 连接（约每秒发一个很短的请求，使它不会先触发服务的 5 秒 keep-alive 超时）；B 一个正在进行中的请求（JSON 请求体只上传了一半，响应头尚未发出：Proxy 为 `/v1/messages`，SSO 为作用域的建用户，Login 为取消不存在的任务（404），Console 为错误密码登录（401））；C 一个响应头已发出的流（Proxy 为 SSE，Console 为经 Console 转发的 CSV 导出；SSO、Login 没有流式接口，只检查 A、B）。然后执行 `docker stop -t 60`；编排脚本看到服务日志里的 `SIGTERM received, draining` 后在客户端容器里建一个标记文件，客户端随即新建连接 D、调用 mock 的 `/release`、补完 B 的请求体、等 C 结束。因此无论 Docker Desktop 多慢送达信号，SIGTERM 时 B 一定在进行中、C 一定在传输中。

候选必须满足（每个服务分别断言）：A 立即被关闭（FIN 时间与服务日志中 draining 行的时间差在 -200 ms 到 1 秒之间，两者都取自 Docker Desktop VM 的时钟）；D 被拒绝（`ECONNREFUSED`）；B 的响应状态正确且带 `Connection: close`，响应结束后 1 秒内收到 FIN；C 在 SIGTERM 前已收到响应头、完整结束（SSE 的 `message_stop` / CSV 末行）且结束后 1 秒内收到 FIN；容器退出码 0、`docker stop` 用时小于 15 秒（排空时限 `SHUTDOWN_TIMEOUT_MS` 默认 25 秒），日志有 `shutdown complete`、没有 `closing their connections`。

可选对照 `RELEASE_QUALIFICATION_CONTROL_TAG`（例如 `multi-4922a4a-amd64-r2`）必须表现出旧行为：B 的响应不带 `Connection: close`，连接保持打开并能在 SIGTERM 之后继续复用；C 结束后连接也能复用；直到 25 秒排空时限才以 `closing their connections` 强制关闭。这证明检查本身有区分能力。

```bash
export RELEASE_QUALIFICATION_PROJECT=ghcp-release-qualification-<唯一后缀>
export RELEASE_QUALIFICATION_CANDIDATE_TAG=multi-<sha7>-amd64-r<N>
export RELEASE_QUALIFICATION_CONTROL_TAG=multi-4922a4a-amd64-r2      # 可选
export RELEASE_QUALIFICATION_ISOLATED_SUBNET=10.x.y.0/24             # 未使用的子网
export RELEASE_QUALIFICATION_CERTS_DIR=<合成 IdP 证书目录>             # 只给 SSO 启动用
node tests/image-release/shutdown-keepalive-check.mjs > report.json
```

报告（stdout 的 JSON）包含每个连接相对排空时刻的响应头时间、完成时间、FIN/错误时间，以及容器退出码、`docker stop` 用时和相关日志行。所有容器和网络都以 `<project>` 为前缀、带 `ghcp.qualification=<project>` 标签，结束后全部保持停止状态，不删除。

## 控制器（preview 工具）

协调者通过 `.claude/launch.json` 启动 `multi-controller.mjs`（端口 18821，只绑定 127.0.0.1，拒绝非回环 Host 和任何带 `Origin` 的请求）。示例配置：

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "multi-qualification-controller",
      "runtimeExecutable": "node",
      "runtimeArgs": ["tests/image-release/multi-controller.mjs"],
      "port": 18821,
      "env": {
        "RELEASE_QUALIFICATION_CANDIDATE_TAG": "multi-<sha7>-amd64-r<N>",
        "RELEASE_QUALIFICATION_CERTS_DIR": "<合成证书目录>",
        "RELEASE_QUALIFICATION_MYSQL_IMAGE": "mysql:8.4@sha256:<digest>",
        "RELEASE_QUALIFICATION_ISOLATED_SUBNET": "10.244.x.0/24",
        "RELEASE_QUALIFICATION_INGRESS_SUBNET": "10.244.y.0/24",
        "RELEASE_QUALIFICATION_SQLITE_SUBNET": "10.244.z.0/24"
      }
    }
  ]
}
```

- `POST /run`，body `{"mode":"<模式>"}`（上文五个多企业模式之一），可选 `isolatedSubnet`/`ingressSubnet` 覆盖子网（每次运行都要未用过的子网；SQLite 模式只用 `RELEASE_QUALIFICATION_SQLITE_SUBNET`）。项目名自动生成：`ghcp-release-qualification-multi-{m|s|fm|fd|fs}-<时间戳>`。同一时间只运行一个。
- `GET /status`：每次运行的阶段、当前步骤、最近的步骤/断言事件、报告摘要（`pass`、`failure`、`failedStep`、`planCoverage`）。
- `GET /plan?mode=…`：步骤计划（不碰 Docker）；`GET /report?id=…`：完整报告。
- `POST /stop`：在运行目录写 `stop.request`，执行器在 2 秒内中止并照常停止本项目容器（Windows 上不依赖信号）。
- 控制器日志：`.claude/multi-controller-<id>.log`。

## 安全边界

- 只启动、停止（step7 中 `kill` 一个本项目的 proxy 容器）本项目的容器；从不执行 `down`、`rm`、`prune` 或删除卷，失败时保留现场供排查。helper 容器与备份卷以 `<project>` 为前缀、带 `ghcp.qualification=<project>` 标签，执行完保持停止状态。
- 应用容器只连接 internal 网络；只有 bridge 绑定 `127.0.0.1` 端口；helper 容器 `--network none`。
- 不读取 `.env`，清除继承的 `COMPOSE_*`、`DOCKER_HOST`、`MYSQL_URL` 以及所有“按企业”变量；所有凭据均为合成值；报告中不写 token、密码、cookie 值。
- 不构建、不拉取镜像；只用本地已有的 r4、候选、mysql、node 镜像。
