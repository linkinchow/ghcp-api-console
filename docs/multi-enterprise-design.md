# 多企业（multi-enterprise / multi-slug SSO）重移植设计 · M0

| 项 | 内容 |
| --- | --- |
| 状态 | M0 设计稿，等待评审。本文不修改代码、不授权任何部署或真实 GitHub 操作。 |
| 新基线 | `release/proxy-dockerhub` @ `5bc80d1`：已合入 upstream（GHE.com，`GITHUB_BASE_URL`）、异步 SSO 密码、graceful shutdown、Models 页、统一 `deploy/images/Dockerfile.release`。 |
| 旧实现（只作参考） | `fork/feat/multi-sso-slug`（`8ad76d5..8554d0b`，357 个文件，+40k 行）。设计文档在该分支的 `docs/user-pool-multi-sso-slug-*.md`。 |
| 读者 | 实现 M1–M6 的开发者、评审人。 |

阅读顺序：§1–§2 定范围；§3 配置；§4 数据与迁移；§5 路由与隔离；§6 GitHub/GHE 端点；§7 Console；§8 代码规范；§9 测试；§10 工作分解；§11 发布；§12–§13 风险与待决问题；附录 A 旧文件去向。

---

## 1. 目标与非目标

### 1.1 目标

1. 一套部署（一个 SSO、一个 Login、一个 Console、N 个 Proxy 副本）管理多个 GitHub 企业。每个企业有自己的 slug、shortcode、SAML/SCIM 配置、席位 PAT 和 Models 管理员。
2. **同一部署可混用 github.com 企业和 GHE.com 企业**。所有 GitHub、Copilot 端点按企业配置。
3. 现有单企业部署（SQLite 或 MySQL）**只换镜像即可原地升级**：
   - 启动时执行幂等的运行时迁移；
   - 没有 registry 文件时，从现有环境变量合成 `default` 企业，无需改配置。
4. 账号池（caller-lease 模式）在多个企业之间共享一个全局 idle 目标，按企业 cap 比例补货。调度规则沿用旧分支（§5.8）。
5. 隔离：一个企业的请求、回调、SAML 会话和 Login 任务，不能读写另一个企业的数据。非直连路径缺少 enterpriseId 时报错，不默认落到 `default`。
6. 代码按新规范重写（§8）：可读、无重复。旧分支的离线升级工具与名字目录改动不带入。

### 1.2 非目标

- 合并多套已有部署的数据库（五库合一）。只支持“单企业原地升级，然后显式追加企业”。
- 账号跨企业迁移；按比例自动删号或退席位；按请求量或费用分摊。
- 企业级 RBAC。Console 管理员仍是全局平台管理员；企业下拉框不是权限边界。
- SSO 或 Login 多实例。SAML 会话不再阻碍多实例（§5.5），但 SSO/Login 的数据仍在本地 SQLite。
- 按企业设置 caller 准入。所有 `active` 企业共享同一 caller 群体，前提是客户已授权共享；按 caller 过滤企业需另行设计。
- 失败后换企业重试、绕过 429/Retry-After。
- 扩大名字目录。保持基线 `src/proxy/src/userPool/names.ts` 的 1000×10，即全局 10,000 个名字，所有企业共用。
- 每企业独立的 `INTERNAL_API_TOKEN`。服务间令牌仍全局共用，不宣传为租户隔离。

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| enterprise | 一个被管理的 GitHub 企业，对应 registry 中的一个 profile。 |
| `enterpriseId` | 部署内部的稳定 ID，格式 `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`。出现在 URL、cookie 名和数据库中，**创建后不可更改**。 |
| slug | GitHub 企业 URL 和 API 中的标识（`/enterprises/<slug>`），不等于 enterpriseId。 |
| shortcode | EMU 登录名后缀（`<handle>_<shortcode>`），3–8 位小写字母数字。GHE.com 企业为空串。 |
| profile | 一个企业的完整配置：GitHub 端点、SSO、Login、池、Models 管理员。 |
| registry | 所有 profile 的 JSON 文件，由 `ENTERPRISE_REGISTRY_FILE` 指定。 |
| default 企业 | ID 固定为 **`default`**，保留值。它是升级前单企业部署的那个企业（又称 legacy 企业），所有旧数据都归属它。可以只由环境变量合成。 |
| 直连路径（direct） | `ACCOUNT_ROUTING_MODE=direct` 下“caller identity → 账号”的旧路径，以及按全局 identity 寻址的旧 `/api/accounts*` 管理路由。只有这些路径允许由账号行推导企业，或使用 `DIRECT_MODE_ENTERPRISE_ID`。 |
| 非直连路径 | 池调度、SSO/Login 管理、服务间回调、Models 等。必须显式携带 enterpriseId。 |
| lifecycle state | 企业在 Proxy 中的池状态：`draft` → `active` → `draining`（可回到 `active`）。 |
| `C_e` / `N_e` | 企业 e 的 cap（`max_accounts`），以及池库存（所有已登记成员，含 failed、disabled）。 |
| `T` / `I` / `P` | 全局 idle 目标、全局可租 ready idle、确定的在途补货。 |

---

## 3. 配置模型

### 3.1 原则

- **一个 registry 文件**，挂载到 Proxy、SSO、Login 三个服务（Console 不读，它从 Proxy 获取企业列表）。每个服务都严格校验整个文件，确保三方解析一致；但只解析自己需要的 secret。
- **不再需要 per-profile 内部地址**。旧分支的 `routes.proxyInternalUrl` 等字段删除；服务间地址继续使用 `PROXY_BASE_URL`、`SSO_BASE_URL`、`LOGIN_BASE_URL`。
- **不允许内联 secret**，只允许引用。
- 只有一个格式版本：`"version": 1`。旧分支 v2/v3/v4 的契约、registry hash、迁移回执都不带入。

### 3.2 完整示例：两个企业，其中一个是 GHE.com

```json
{
  "version": 1,
  "enterprises": [
    {
      "id": "default",
      "displayName": "Acme (github.com)",
      "github": {
        "baseUrl": "https://github.com",
        "apiBaseUrl": "https://api.github.com",
        "copilotApiBaseUrl": "https://api.githubcopilot.com",
        "slug": "acme",
        "shortcode": "octo",
        "oauthClientId": "Ov23li8tweQw6odWQebz"
      },
      "sso": {
        "spEntityId": "https://github.com/enterprises/acme",
        "spAcsUrl": "https://github.com/enterprises/acme/saml/consume",
        "scimBaseUrl": "https://api.github.com/scim/v2/enterprises/acme",
        "emailDomain": "acme.example.com",
        "userPrefix": "ghcp",
        "signingCert": { "file": "/certs/idp-cert.pem" },
        "signingKey": { "file": "/certs/idp-key.pem" },
        "sessionSecret": { "env": "SESSION_SECRET" },
        "scimToken": { "env": "SCIM_TOKEN" },
        "seatPat": { "env": "GITHUB_COPILOT_SEAT_PAT" },
        "defaultUserPassword": { "env": "SSO_DEFAULT_USER_PASSWORD" }
      },
      "login": {
        "ssoProvider": "custom",
        "ssoLoginUrl": "http://sso:7001/login",
        "allowedLoginUrls": ["http://sso:7001/login"]
      },
      "pool": {
        "accountDomain": "pool.acme.example.com",
        "initialMaxAccounts": 300
      },
      "modelsAdmin": {
        "githubLogin": "acme-admin_octo",
        "githubUserId": "101",
        "copilotToken": { "file": "/run/secrets/acme/models-admin-token" }
      }
    },
    {
      "id": "contoso-eu",
      "displayName": "Contoso EU (GHE.com)",
      "github": {
        "baseUrl": "https://contoso.ghe.com",
        "apiBaseUrl": "https://api.contoso.ghe.com",
        "copilotApiBaseUrl": "https://copilot-api.contoso.ghe.com",
        "slug": "contoso",
        "shortcode": ""
      },
      "sso": {
        "spEntityId": "https://contoso.ghe.com/enterprises/contoso",
        "spAcsUrl": "https://contoso.ghe.com/enterprises/contoso/saml/consume",
        "scimBaseUrl": "https://api.contoso.ghe.com/scim/v2/enterprises/contoso",
        "emailDomain": "contoso.example.eu",
        "userPrefix": "ghcp",
        "signingCert": { "file": "/run/secrets/contoso/idp-cert.pem" },
        "signingKey": { "file": "/run/secrets/contoso/idp-key.pem" },
        "sessionSecret": { "file": "/run/secrets/contoso/session-secret" },
        "scimToken": { "file": "/run/secrets/contoso/scim-token" },
        "seatPat": { "file": "/run/secrets/contoso/seat-pat" },
        "defaultUserPassword": { "file": "/run/secrets/contoso/default-password" }
      },
      "login": {
        "ssoProvider": "custom",
        "ssoLoginUrl": "http://sso:7001/enterprises/contoso-eu/login",
        "allowedLoginUrls": ["http://sso:7001/enterprises/contoso-eu/login"]
      },
      "pool": {
        "accountDomain": "pool.contoso.example.eu",
        "initialMaxAccounts": 200
      },
      "modelsAdmin": {
        "githubLogin": "contoso-admin",
        "copilotToken": { "env": "CONTOSO_MODELS_ADMIN_TOKEN" }
      }
    }
  ]
}
```

示例中 `default` 的每个字段都和基线环境变量等价。实际部署中 `default` 条目可以省略，或只写部分字段（规则见 §3.5）。

### 3.3 字段说明

| 字段 | 必填 | 默认值 / 推导 | 使用方 |
| --- | --- | --- | --- |
| `id` | 是 | — | 全部 |
| `displayName` | 否 | `id` | Console |
| `github.baseUrl` | 是 | — | 全部。经 `parseGithubBaseUrl` 校验，只接受 origin |
| `github.apiBaseUrl` | 否 | github.com → `https://api.github.com`；`<sub>.ghe.com` → `https://api.<sub>.ghe.com` | SSO（席位、预算），Proxy（`/user` 主体校验、Models） |
| `github.copilotApiBaseUrl` | 否 | github.com → `https://api.githubcopilot.com`；GHE.com → `https://copilot-api.<sub>.ghe.com` | Proxy |
| `github.slug` | SSO 必填；GHE.com 时 Login 也必填 | — | SSO、Login |
| `github.shortcode` | github.com 必填；GHE.com 必须为 `""` 或省略 | — | SSO、Proxy |
| `github.oauthClientId` | 否 | `GITHUB_OAUTH_CLIENT_ID` | Login 设备流 |
| `sso.spEntityId` / `sso.spAcsUrl` | 否 | `<baseUrl>/enterprises/<slug>`、`.../saml/consume` | SSO |
| `sso.scimBaseUrl` | 否 | `<apiBaseUrl>/scim/v2/enterprises/<slug>` | SSO |
| `sso.emailDomain` / `sso.userPrefix` | 否 | 只在首次创建该企业的 `sso_runtime_settings` 行时作为种子 | SSO |
| `sso.signingCert` / `signingKey` / `sessionSecret` | 是 | — | SSO |
| `sso.scimToken` / `seatPat` / `defaultUserPassword` | 否 | 缺失时，对应功能对该企业报 `enterprise_secret_unconfigured` | SSO |
| `login.ssoProvider` | 否 | 不设：由每个任务选择（基线行为，未指定时为 `custom`）；设置后任务必须一致 | Login |
| `login.ssoLoginUrl` | 否 | default 企业取 `SSO_URL`；其他企业取 `<SSO_URL origin>/enterprises/<id>/login` | Login |
| `login.allowedLoginUrls` | 否 | `[ssoLoginUrl]`。最多 16 项；origin 相同且路径整段前缀匹配；query、fragment 被去掉 | Login |
| `login.selectors` | 否 | 全局 `AUTH_*_SELECTOR` | Login |
| `pool.accountDomain` | 池模式必填 | — | Proxy |
| `pool.initialMaxAccounts` | 否 | default 企业取 `POOL_MAX_ACCOUNTS`；其他企业取 `10` | Proxy，只在首次插入 `proxy_enterprises` 行时使用 |
| `modelsAdmin.*` | 否 | 未配置时，该企业的 Models 页显示 `models_admin_not_configured` | Proxy |

### 3.4 Secret 引用

- 格式只有两种：`{ "env": "NAME" }`（`^[A-Z][A-Z0-9_]{0,127}$`）和 `{ "file": "/abs/path" }`（必须是绝对路径）。
- `env` 引用在启动时读取。`file` 引用在使用时读取，并缓存 60 秒，所以轮换挂载的 Secret 不需要重启。Models 管理员 token 沿用基线做法，每次请求重新读取。
- 内容限制：最大 128 KiB；不允许 `\0`；只去掉一个结尾换行。
- 只在需要该 secret 的服务内解析，并且是**懒加载**。某个企业缺 secret 只会让该企业 not ready，不阻塞其他企业，也不阻塞启动。
- secret 值不进日志、DTO 或错误消息。错误消息只给出字段路径，例如 `contoso-eu.sso.scimToken`。

### 3.5 由环境变量合成 default 企业

`default` 企业的配置是 **registry 中的 `default` 条目与环境变量的合并**：

1. 没有 registry 文件：完全由各服务现有的环境变量合成，零配置变更。
2. 有 registry 文件，且没有 `default` 条目：仍由环境变量合成 `default`。
3. 有 registry 文件，且有 `default` 条目：两者合并。
   - 同一字段两边都有值，并且规范化后不相等，就是**启动错误** `enterprise_env_conflict`。错误消息给出变量名和字段路径。
   - 环境变量不会被静默忽略。
4. 合并后缺少必填字段：`default` 标记为 not ready（readiness blocker），启动不失败。
5. 唯一的例外与基线一致：GHE.com 下 `ENTERPRISE_SHORTCODE` 被忽略，只记一次 warning，不算冲突。

各服务的映射如下（只列 per-enterprise 字段；`PORT`、`DB_PATH`、`INTERNAL_API_TOKEN`、`BASE_URL` 等服务级变量保持原样）：

| 服务 | 环境变量 → `default` 字段 |
| --- | --- |
| Proxy（`src/proxy/src/config.ts`、`userPool/config.ts`、`copilot/modelsAdmin.ts`） | `GITHUB_BASE_URL`→`github.baseUrl`；`GITHUB_API_BASE_URL`→`github.apiBaseUrl`；`COPILOT_API_BASE_URL`→`github.copilotApiBaseUrl`；`ENTERPRISE_SHORTCODE`→`github.shortcode`；`POOL_ACCOUNT_EMAIL_DOMAIN`→`pool.accountDomain`；`POOL_MAX_ACCOUNTS`→`pool.initialMaxAccounts`；`MODELS_ADMIN_GITHUB_LOGIN` / `_GITHUB_USER_ID` / `_COPILOT_TOKEN` / `_COPILOT_TOKEN_FILE`→`modelsAdmin.*` |
| SSO（`src/sso/src/config.ts`） | `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`→`github.*`；`SP_ENTITY_ID`、`SP_ACS_URL`、`SCIM_BASE_URL`→`sso.*`；`SCIM_TOKEN`→`sso.scimToken={env}`；`GITHUB_COPILOT_SEAT_PAT`→`sso.seatPat={env}`；`SESSION_SECRET`→`sso.sessionSecret={env}`；`SSO_DEFAULT_USER_PASSWORD`→`sso.defaultUserPassword={env}`；`CERT_DIR`→`sso.signingCert/Key={file: <CERT_DIR>/idp-cert.pem / idp-key.pem}`；`MOCK_GITHUB_BASE_URL` 仍只作为开发用 SCIM/ACS 的回退 |
| Login（`src/login/src/config.ts`） | `GITHUB_BASE_URL`、`ENTERPRISE_SLUG`→`github.*`；`GITHUB_OAUTH_CLIENT_ID`→`github.oauthClientId`；`SSO_URL`→`login.ssoLoginUrl`；`AUTH_*_SELECTOR`→`login.selectors` |

**模板注意**：`docker-compose.yml` 会给 `GITHUB_BASE_URL`、`ENTERPRISE_SHORTCODE` 等变量填默认值。使用 registry 并把 `default` 写进文件时，要清空这些变量，否则会触发冲突错误。M6 会更新 `.env.example` 和 compose 模板。

### 3.6 校验规则（启动时，fail closed）

- 结构：顶层只允许 `version` 和 `enterprises`；未知字段报错。`enterprises` 有 1–32 项。
- 唯一性：`id`、`github.slug + github.baseUrl`（同一 GitHub 实例内）、`pool.accountDomain`、`login.ssoLoginUrl` 不能重复。
- URL：使用共享的 `parseTrustedUrl`。只允许 http/https；拒绝 userinfo、query、fragment、`\`、`%2e`/`%2f`/`%5c` 和 dot segment。路径比较不能用 `startsWith`（`/a` 会误配 `/ab`）。
- GHE.com：`baseUrl` 主机以 `.ghe.com` 结尾时：
  - `shortcode` 必须为空；
  - `slug` 必填；
  - `apiBaseUrl` 和 `copilotApiBaseUrl` 的主机必须属于同一 `<sub>.ghe.com`。
- github.com：`shortcode` 必须匹配 `^[a-z0-9]{3,8}$`；`apiBaseUrl` 默认 `api.github.com`，显式值只能是 http(s) origin（测试 mock 用）。
- 容量：所有 `initialMaxAccounts` 之和，以及运行时所有 cap 之和，都不能超过 `NAME_CAPACITY`（10,000）。
- 不可变身份：每个服务的库中记录了每个企业的 `profile_fingerprint`（§4.2）。如果某企业在库中已有数据，而 fingerprint 变化（例如改了 `baseUrl`、`shortcode` 或 `accountDomain`），启动报 `enterprise_identity_changed`。企业没有数据时允许修改，并更新库中的 fingerprint。
  - Proxy 中“有数据”指该企业已有账号池成员（`inventory_count > 0`）。直连账号从不依赖 `accountDomain` 和 `shortcode`，所以直连部署切换到 caller-lease（首次设置 `POOL_ACCOUNT_EMAIL_DOMAIN`）仍然允许。
- 删除企业：registry 中去掉的企业如果在库中仍有数据，启动报 `enterprise_missing_from_registry`。
- 保留 ID：`default` 只能表示升级前的企业。不能在全新部署中把另一个已有企业改名为 `default`。

### 3.7 加载与 reload

- 每个服务在启动时读取一次 registry，然后 deep-freeze。**不支持热加载**。
- 修改 registry（追加企业、改非身份字段）后，需要重启 Proxy、SSO、Login。可以滚动重启：新增企业在三方都可见、通过 readiness 之前，一直是 `draft`，不会被调度。
- `file` 类 secret 可热轮换（§3.4）。

### 3.8 跨服务一致性（readiness）

- SSO 和 Login 各提供 `GET /internal/enterprises`，返回 `[{ id, githubBaseUrl, slug, shortcode, configured, blockers[] }]`。服务不知道的字段返回 `null`；Login 不知道 shortcode。
- Proxy 的 `clients/enterpriseReadiness.ts` 比对以下内容：
  - 三方都有该 `id`；
  - `githubBaseUrl` 三方相同；
  - `shortcode` 在 Proxy 与 SSO 之间相同；
  - `slug` 在 SSO 与 Login 之间相同（Login 有值时）；
  - 三方都没有 blocker。
- 结果在每个 Proxy 副本内存缓存：ready 缓存 60 秒，not ready 或探测失败只缓存 10 秒（SSO/Login 短暂不可用不会让补货停一分钟）；激活和恢复时强制实时检查。只用于以下场景：激活企业、worker 为该企业补货前的判断、Console 展示。**结果不落库，也不作为“证据 JSON”存储**，旧分支的 `validation_evidence_json` 机制删除。

---

## 4. 数据模型与运行时迁移

### 4.1 迁移原则

1. **幂等、有序、崩溃安全**。
   - 每个步骤是 `{ id, isApplied(db), apply(db) }`。
   - 成功后把步骤 ID 写入 `schema_migrations`。重跑时跳过已记录的步骤；对“DDL 已生效但未记录”的步骤，用 `isApplied` 的 information_schema 或 `pragma_table_info` 检查识别。
   - SQLite：所有步骤在一个 `BEGIN IMMEDIATE` 事务内执行（SQLite DDL 是事务性的）。崩溃会整体回滚。
   - MySQL：DDL 不是事务性的，所以靠逐步 `isApplied` 实现崩溃安全。数据回填用带条件的幂等 `UPDATE`。
2. **MySQL 迁移在现有锁内执行**：`src/proxy/src/db/mysqlMigrationLock.ts` 的 `withMysqlMigrationLock`（`GET_LOCK('ghcp_proxy_schema_migrations')`）。本次新增 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`（默认 30，大表升级时可调高），解决其他副本等锁的问题（§12）。
3. **schema 校验容忍额外索引**。`src/proxy/src/db/mysqlSchema.ts` 的 `validateMysqlSchema` 改为：
   - 要求的索引必须是实际索引的子集；
   - 额外的二级索引（包括 unique）只记 warning；
   - 列、FK、CHECK、类型、排序规则仍严格校验。
4. **旧二进制 fail closed**：
   - MySQL：新列 `enterprise_id` 不带默认值。旧代码 INSERT 会因 strict mode 失败。基线的严格校验也会拒绝新增的列，所以旧副本无法启动。
   - SQLite：用 `BEFORE INSERT` trigger 要求 `enterprise_id` 非空。
5. **单企业的历史数据全部属于 `default`**。升级前只有一个企业，所以统计和事件可以确定回填为 `default`，不需要按文本猜测归属。
6. **不新增 MySQL trigger**，避免扩大 `TRIGGER` 权限需求。基线已有的凭据 fence trigger 保持不变。SQLite 的 trigger 不涉及权限问题。

### 4.2 Proxy

#### 新表 `proxy_enterprises`（SQLite 与 MySQL 同构）

```sql
CREATE TABLE proxy_enterprises (
  id                  VARCHAR(32) NOT NULL,
  state               VARCHAR(16) NOT NULL,
  max_accounts        INT         NOT NULL,
  inventory_count     INT         NOT NULL DEFAULT 0,
  policy_version      INT         NOT NULL DEFAULT 1,
  profile_fingerprint CHAR(64)    NOT NULL,
  created_at          BIGINT      NOT NULL,
  updated_at          BIGINT      NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_proxy_enterprises_state
    CHECK (state IN ('draft', 'active', 'draining')),
  CONSTRAINT chk_proxy_enterprises_cap
    CHECK (max_accounts BETWEEN 1 AND 10000),
  CONSTRAINT chk_proxy_enterprises_inventory
    CHECK (inventory_count >= 0)
)
```

- `profile_fingerprint` = sha256（规范 JSON：`{ id, githubBaseUrl, shortcode, accountDomain }`）。
- `inventory_count` 是 `N_e` 的增量计数器（§5.8）。
- `policy_version` 用于 Console 的 CAS 编辑。

#### 现有表新增列

| 表 | 新增 | 键 / 约束 | 旧行映射 |
| --- | --- | --- | --- |
| `proxy_accounts` | `enterprise_id` | FK→`proxy_enterprises(id)`；`UNIQUE (identity, enterprise_id)`；`INDEX (enterprise_id, updated_at)`。`identity` 仍是全局主键 | `default` |
| `proxy_identity_initializations` | `enterprise_id` | `INDEX (enterprise_id)` | `default` |
| `proxy_request_stats` | `enterprise_id` | `INDEX (enterprise_id, requested_at, id)` | `default` |
| `user_pool_accounts` | `enterprise_id`（冗余，便于建索引） | MySQL：复合 FK `(identity, enterprise_id)`→`proxy_accounts(identity, enterprise_id)`。SQLite：trigger 校验与 `proxy_accounts` 一致。`INDEX (enterprise_id, state)` | `default` |
| `user_pool_events` | `enterprise_id`（可空，全局事件为 NULL） | `INDEX (enterprise_id, at, id)` | 全部回填 `default` |
| `user_pool_settings` | 无新列 | `max_accounts` 列保留但**停用**（只在迁移时读取一次）；`config_fingerprint` 改为 v2（不再包含 per-enterprise 字段） | — |

不变的部分：`user_pool_leases`、`user_pool_holds`、`user_pool_catalog_holds`、`user_pool_catalog_cooldowns` 不加企业列，企业由 member 推导。`user_pool_leases.caller_id` 仍是全局主键，即**每个 caller 全局只有一个租约**。`next_ordinal` 与名字目录保持全局。

#### SQLite 迁移步骤

在 `src/proxy/src/db/migrations.ts` 的 `runMigrations` 末尾追加 `runEnterpriseMigrations(db, seed)`；池表部分在 `UserPoolStore` 构造时执行。使用共享的 `runSqliteMigrations`：每个步骤一个 `BEGIN IMMEDIATE` 事务，成功后写入 `schema_migrations`；步骤只补缺失部分，所以“已生效未记录”时重跑安全：

1. `enterprise-v1/01-create-proxy-enterprises`：建表。
2. `.../02-seed-default`：`INSERT OR IGNORE` 插入 `default`：
   - `state` 取 `active`；
   - `max_accounts` 取 `user_pool_settings.max_accounts`；池表不存在时取 `POOL_MAX_ACCOUNTS`；
   - `inventory_count` 取 `COUNT(*) FROM user_pool_accounts`；
   - `profile_fingerprint` 由当前合成配置计算。
3. `.../03-accounts-enterprise`：
   - `ALTER TABLE proxy_accounts ADD COLUMN enterprise_id TEXT REFERENCES proxy_enterprises(id)`。可空、无默认值，所以 SQLite 允许带 `REFERENCES`。
   - `UPDATE ... SET enterprise_id = 'default' WHERE enterprise_id IS NULL`。
   - 建立 unique 与普通索引。
4. `.../04-accounts-guards`：建两个 trigger：
   - `proxy_accounts_enterprise_required`：`BEFORE INSERT`，`NEW.enterprise_id` 为空时 `RAISE(ABORT, 'enterprise_id_required')`；
   - `proxy_accounts_enterprise_immutable`：`BEFORE UPDATE OF enterprise_id`，值变化时报错。
5. `.../05-initializations-and-stats`：两张表同样执行“加列 → 回填 → 索引 → required trigger”。大量统计行的回填在同一事务内完成。
6. `.../06-pool-accounts`：仅当池表存在时执行。加列、回填，再建 `user_pool_accounts_enterprise_matches` trigger：INSERT 时校验 `NEW.enterprise_id` 等于 `proxy_accounts` 对应行。
7. `.../07-pool-events`：仅当池表存在时执行。
8. 步骤 03 在提交前对 `proxy_accounts` 执行 `PRAGMA foreign_key_check`，非空则回滚并报错。

每次启动还会：`default` 行缺失时补插；执行身份检查（§3.6）；按 `COUNT(*)` 校正 `inventory_count`，有偏差时记录 `enterprise_inventory_drift` 事件。同一 identity 换企业写入在两个后端都失败（`enterprise_id_immutable`）。

新建库直接使用包含新列的 `CREATE TABLE`，迁移步骤的 `isApplied` 会全部为真。

#### MySQL 迁移步骤

在 `src/proxy/src/db/mysqlMigrations.ts` 和 `src/proxy/src/userPool/mysqlMigrations.ts` 中新增 `runMysqlEnterpriseMigrations`，与现有迁移共用锁：

1. 创建 `proxy_enterprises`（`CREATE TABLE IF NOT EXISTS`）。
2. 用 `INSERT IGNORE` 插入 `default`（规则同 SQLite）。
3. `proxy_accounts ADD COLUMN enterprise_id VARCHAR(32) NOT NULL DEFAULT 'default'`。加在末尾，是 INSTANT DDL，不重写行。
4. 建 `UNIQUE (identity, enterprise_id)`、`INDEX (enterprise_id, updated_at)`、FK→`proxy_enterprises`。
5. `ALTER TABLE proxy_accounts ALTER COLUMN enterprise_id DROP DEFAULT`。这是元数据操作；之后不带 `enterprise_id` 的 INSERT 都会失败。
6. `proxy_identity_initializations`、`proxy_request_stats`：重复 3→5 的模式。统计表的索引用 `ALGORITHM=INPLACE, LOCK=NONE` 在线建立。
7. 池表存在时：`user_pool_accounts` 重复 3→5，再加复合 FK；`user_pool_events` 加可空列，并执行 `UPDATE ... SET enterprise_id='default' WHERE enterprise_id IS NULL`。
8. 用新算法重算并写入 `user_pool_settings.config_fingerprint`。在锁内执行；此后旧副本因 fingerprint 不一致无法启动。
9. 每步成功后写入 `schema_migrations`。

#### `MYSQL_AUTO_MIGRATE=false`

- `scripts/proxy-mysql-initial.sql`：由 `src/proxy/src/db/mysqlInitialSql.ts` 的 `renderMysqlInitialSql()` 生成，包含新表和新列，**不含** `default` 行：fingerprint 取决于部署配置，由 Proxy 启动时插入并校验（只需 INSERT/UPDATE 权限）。`mysqlInitialSql.test.ts` 继续做漂移检查。
- 新增生成脚本 `scripts/proxy-mysql-enterprise-upgrade.sql`：只适用于基线 r4 schema 的 DBA 升级，由同一组步骤定义渲染。因外键需要，脚本先插入 fingerprint 为空的 `default` 行，Proxy 下次启动时补全并执行步骤 08。脚本不可重入：中途失败时恢复备份，或用一个开启自动迁移的副本续跑。
- 只读校验 `validatePreparedMysqlSchema` 覆盖新表和新列；不一致时提示应执行哪个脚本。

### 4.3 SSO（SQLite，`src/sso/src/db/migrations.ts`）

SSO 的主键必须变成复合键，所以要用 SQLite 标准重建流程（建新表 → 复制 → 删旧表 → 改名）：

- 先设 `PRAGMA foreign_keys=OFF`，再 `BEGIN IMMEDIATE`；
- 每张表重建后执行 `PRAGMA foreign_key_check`；
- 写入 `schema_migrations` 后提交，再恢复 `foreign_keys=ON`。

重建流程由共享的 `rebuildSqliteTable()` 实现（§8）。

| 表 | 变化 | 旧行映射 |
| --- | --- | --- |
| `schema_migrations`（新） | `id TEXT PRIMARY KEY, applied_at TEXT` | — |
| `sso_enterprises`（新） | `id PK, profile_fingerprint, created_at`。fingerprint 字段为 `{ id, githubBaseUrl, slug, shortcode }` | 插入 `default` |
| `sso_users` | `enterprise_id NOT NULL` FK；主键改为 `(enterprise_id, sso_user)`，**保持基线排序规则（BINARY）**，旧分支改成 NOCASE 的做法不采纳；`INDEX (enterprise_id, gh_login)` | `default` |
| `sso_pool_managed_users` | 主键 `(enterprise_id, sso_user)`，复合 FK→`sso_users` | `default` |
| `sso_runtime_settings` | 主键由 `id=1` 改为 `enterprise_id` | 原 `id=1` 行 → `default` |
| `sso_budget_cache` | 主键 `(enterprise_id, period_key)` | `default` |
| `sso_emu_import_plans` | 加 `enterprise_id NOT NULL`。`sso_emu_import_plan_rows` 通过 `plan_id` 继承，不加列 | `default` |

SAML 会话**不建表**（§5.5）。

### 4.4 Login（SQLite，`src/login/src/db/migrations.ts`）

| 表 | 变化 | 旧行映射 |
| --- | --- | --- |
| `schema_migrations`（新） | 同 SSO | — |
| `login_enterprises`（新） | `id PK, profile_fingerprint, created_at`。fingerprint 字段为 `{ id, githubBaseUrl, slug }` | 插入 `default` |
| `login_tasks` | 加 `enterprise_id`（可空列，FK）→ 回填 → required 与 immutable trigger；`INDEX (enterprise_id, status, created_at)` | `default` |
| `login_task_attempts` | 不变，通过 `task_id` 继承 | — |
| `login_runtime_settings` | 不变，仍是全局（并发度是 Login 进程级资源） | — |

升级时正在运行的任务，交给基线 `src/login/src/tasks/recovery.ts` 的中断恢复处理，不承诺无损续跑。

### 4.5 回滚立场

- **只支持备份恢复，不支持镜像回滚**。迁移后旧镜像在 MySQL 上会被严格校验和 fingerprint 拒绝；在 SQLite 上，INSERT 会被 trigger 拒绝。
- 升级前备份三个服务的数据：Proxy SQLite 文件或 MySQL 库、`sso.sqlite`、`login.sqlite`，以及 Console 的 `admins.json`。
- 回退步骤：停止全部新容器 → 恢复备份 → 启动单企业镜像（r4）。
- 资格测试必须演练“迁移 → 恢复备份 → r4 正常运行”，并断言“r4 直接在已迁移的 MySQL 上启动会失败”（§9.4）。

---

## 5. 请求路由与隔离

### 5.1 企业解析总表

| 请求类别 | 路径形态 | enterpriseId 来源 | 缺失 / 未知时 |
| --- | --- | --- | --- |
| Proxy 公共推理（caller-lease） | `/v1/*` 等，不变 | caller 的 lease → member → `user_pool_accounts.enterprise_id` | 不适用。客户端不带企业 header |
| Proxy 公共推理（direct） | 不变 | 账号行的 `proxy_accounts.enterprise_id`；新 identity 初始化使用 `DIRECT_MODE_ENTERPRISE_ID`（默认 `default`，显式配置） | 不适用 |
| Proxy 管理（新） | `/api/enterprises/:enterpriseId/...` | path | 未知 → 404 `enterprise_not_found` |
| Proxy 管理（全局） | `/api/enterprises`、`/api/user-pool/settings`、`/api/user-pool/overview`、`/api/error-diagnostics` | 无 | — |
| Proxy 管理（旧直连） | `/api/accounts`、`/api/accounts/:identity[...]` | 按全局 identity 查行，响应带 `enterpriseId`。保留一个版本，标记 deprecated | — |
| Proxy 管理（旧池，非直连） | `/api/user-pool/*`（不含 settings 和 overview）、`/api/request-stats` | — | **400 `enterprise_scope_required`** |
| Proxy internal | `/internal/enterprises/:enterpriseId/...` | path，并且必须等于行上的企业 | 不一致 → 404（不暴露另一企业）；旧无作用域路径 → 400 |
| SSO 管理 / internal | `/api/enterprises/:id/...`、`/internal/enterprises/:id/...` | path | 未知 → 404；无作用域 → 400 |
| SSO SAML | default 用根路径 `/metadata` `/sso` `/login` `/logout`；其他企业用 `/enterprises/:id/...` | path | 未知 → 404，不回落 |
| Login 管理 / internal | `/api/enterprises/:id/tasks...` | path，或任务行 | 无作用域 → 400 |

实现方式：企业作用域的路由挂 `requireEnterprise(lookup)` 中间件，校验 `:enterpriseId`（header/query/body 中不一致的企业 ID 返回 400 `enterprise_scope_conflict`），并挂上 `res.locals.enterprise`（frozen profile）。路由处理函数调用 `enterpriseOf(res)` 取值。repository 函数的第一个参数是**必填**的 `EnterpriseId`，没有可选参数，也没有默认值。旧分支中 `SqliteStorage.enterpriseId(id?)`、`resolveEnterpriseScope(registry, undefined)`、`managesSsoUser(..., enterpriseId = this.enterpriseId)` 这类回落方式一律不写。

### 5.2 Proxy 管理路由

- 企业：
  - `GET /api/enterprises`：列表，含 readiness 与池摘要；
  - `PATCH /api/enterprises/:id/pool-policy`：body 为 `{ expectedVersion, maxAccounts?, state? }`。
- 作用域内（Console 只用这一组）：
  - `/accounts[/:identity]`、`/request-stats[/page]`；
  - `/user-pool/{accounts,leases,events,summary}`、`/user-pool/accounts/:identity/:action`、`/user-pool/leases/:id/release`；
  - `/accounts/operations/*`（基线 `src/proxy/src/routes/operationsApi.ts` 的 management operations，选择范围限定在该企业）；
  - `/models`。
- 写路由保留基线保护：`src/proxy/src/accounts/poolGuard.ts` 的 `assertNotPoolManagedAccount`；caller-lease 模式下禁用 token import。

### 5.3 服务间 internal 路由

| 方向 | 路径（新） | 校验 |
| --- | --- | --- |
| Login → Proxy | `POST /internal/enterprises/:id/accounts/:identity/oauth-attempts/:attemptId/prepare` | 行属于 `:id`；沿用基线 attempt CAS（`accounts/loginAuthorization.ts`） |
| Login → Proxy | `PUT /internal/enterprises/:id/accounts/:identity/copilot-oauth-token` | 同上，另加 §5.7 的主体校验 |
| Login → Proxy | `POST /internal/enterprises/:id/accounts/:identity/mark-copilot-oauth-failed` | 同上 |
| Login → Proxy | `GET /internal/enterprises/:id/accounts/:identity/login-task-protection` | 同上（基线 `tasks/poolProtection.ts`） |
| SSO → Proxy | `GET /internal/enterprises/:id/accounts/by-sso-user/:ssoUser/pool-membership` | `sso_user` 只在企业内唯一，所以必须带作用域；查询失败按基线 fail closed，返回 503 |
| SSO → Proxy | `DELETE /internal/enterprises/:id/accounts/by-sso-user/:ssoUser` | 同上 |
| Proxy → SSO | `/api/enterprises/:id/users/ensure`、`/internal/enterprises/:id/users/:u/login-credentials`、seat、SCIM sync 等 | `src/proxy/src/clients/ssoClient.ts` 中所有函数都把 `enterpriseId` 作为必填参数 |
| Proxy → Login | `POST /api/enterprises/:id/tasks`、`GET /api/enterprises/:id/tasks/by-attempt/:attemptId` | `src/proxy/src/clients/loginClient.ts` 同上 |
| Proxy → SSO / Login | `GET /internal/enterprises` | readiness，§3.8 |

升级窗口：新旧版本混跑时，旧版调用无作用域的 internal 路径会得到 400，相应 Login 任务失败，由池 worker 的既有恢复逻辑重新派发。建议首次升级时一次性替换全部镜像（§12）。

### 5.4 公共推理（caller-lease）

`routeUserPool` → `store.acquire(caller)` 选出 member，lease 带回 `enterpriseId`。之后：

- `routes/compatible.ts` 的 `requestAuth` 使用该企业的 `copilotApiBaseUrl`；
- 模型缓存、错误诊断、请求统计都记录 `enterprise_id`。

客户端协议不变，LiteLLM hook 不变。

### 5.5 SSO：按企业的 SAML 路由与持久化会话

**路由**

- default：根路径 `/metadata`、`/sso`、`/login`、`/logout`。IdP entityID、证书和 ACS 全部保持原样，客户不需要改 GitHub 的 IdP 配置。
- 其他企业：`/enterprises/:id/metadata|sso|login|logout`。IdP entityID 为 `<BASE_URL>/enterprises/<id>/metadata`。
- 每个企业有一个 samlify IdP/SP 实例，按 enterpriseId 缓存。registry 不热加载，所以缓存不需要失效。

**AuthnRequest 校验**（从旧分支 `src/sso/src/saml/saml.ts` 移植）

- `Issuer` 必须等于 `spEntityId`；
- `Destination` 如果存在，必须等于本企业的 ssoUrl；
- `AssertionConsumerServiceURL` 如果存在，必须等于 `spAcsUrl`；
- 拒绝 DOCTYPE、ENTITY、PI。

**会话持久化**

- 采用每个企业一个**签名 cookie**，线上格式与基线 `cookie-session` 完全相同（base64 JSON + keygrip `.sig`），所以基线 cookie 可以原样读取。由 `saml/enterpriseSession.ts` 用 `res.cookie` 写出：`cookie-session` 在 TLS 由前置代理终止时写 Secure cookie 会静默失败。不使用旧分支 `src/sso/src/saml/sessionStore.ts` 的进程内存 store。
- 会话状态只在客户端 cookie 中，服务端没有内存状态，所以 SSO 重启后会话仍然有效；多实例共用同一 secret 时也可以工作。

| 企业 | cookie 名 | path | 签名 key |
| --- | --- | --- | --- |
| default | `sso_session`（与基线相同，升级后已有会话继续有效） | `/` | `sso.sessionSecret`（即 `SESSION_SECRET`） |
| 其他 | `sso_session_<id>` | `/enterprises/<id>` | 该企业的 `sso.sessionSecret` |

- cookie 载荷：`{ e: enterpriseId, user?: { ssoUser, createdAt }, pending?: { requestId, relayState, exp } }`。HttpOnly、SameSite=Lax；public base URL 是 https 时加 Secure；Max-Age 8 小时。
- 载荷中的 `e` 必须等于路由所属企业。基线留下的旧 cookie 没有 `e`，只有 default 路由接受。
- `user.createdAt` 必须等于 `sso_users` 行的 `created_at`。用户被删除再重建后，旧 cookie 自动失效。
- `pending` 在 5 分钟后过期，完成一次响应后清除。
- `POST /login` 和 `POST /logout` 校验 `Origin`，并拒绝 `Sec-Fetch-Site: cross-site`（从旧分支移植）。Origin 的 host 等于 `BASE_URL` 的 host 或请求的 Host 头即为同源（内网地址打开登录页仍可用）；没有 Origin 时接受（与基线相同）；`Origin: null` 拒绝。
- 基线 cookie（没有 `e`、没有 `createdAt`）只在 default 路由上接受：用户存在时接受一次并改写为新格式；基线的 pending 字段映射为 5 分钟的 pending。
- 登录时按 `(enterpriseId, ssoUser)` 查用户。另一企业的同名用户无法登录本企业。

### 5.6 SSO 用户、SCIM、席位、预算

- 所有 repository（`src/sso/src/db/usersRepo.ts`、`budgetRepo.ts`、`emuImportPlansRepo.ts`、`runtimeSettingsRepo.ts`）和 `src/sso/src/users/service.ts` 的函数都以 `enterpriseId` 为第一个参数。
- 外部调用：

| 调用 | 端点 | 凭据 |
| --- | --- | --- |
| SCIM（`scim/scimClient.ts`） | `profile.sso.scimBaseUrl` | `scimToken` |
| 席位（`copilot/seats.ts`） | `<apiBaseUrl>/enterprises/<slug>/copilot/...` | `seatPat` |
| 预算（`budget/budgetService.ts`） | `<apiBaseUrl>/enterprises/<slug>/settings/billing/...` | `seatPat` |

  SCIM 的速率与退避状态按企业分开。
- 句柄推导使用 `scim/handle.ts` 的 `normalizeHandle(userName, profile.github.shortcode)`。GHE.com 的 shortcode 为空，句柄限 30 字符。`service.ts` 中的 `stripEnterpriseShortcode` 同样使用该企业的 shortcode。
- 保留基线保护：
  - `usersRepo.ts` 的 `assertNotLocallyPoolManaged`；
  - `service.ts` 的 `assertDestructiveOperationAllowed`，它会调用带作用域的 Proxy pool-membership；
  - 异步 scrypt 密码（`auth/password.ts`）和 `routes/loginCredentials.ts` 的并发上限。
- 事件日志：default 仍写 `SSO_USER_EVENTS_LOG`；其他企业写 `<dir>/<enterpriseId>/<basename>`。
- 企业缺少 `scimToken` 或 `seatPat` 时，相关操作返回 503 `enterprise_secret_unconfigured`（基线为 400 或发出空凭据）。
- 启动时，库中有用户、但 registry 中已不存在的企业，报 `enterprise_missing_from_registry`。
- 外部写请求使用 `redirect: 'error'`。传输失败或 5xx 视为“结果不确定”（从旧分支 `clients/externalFetch.ts` 移植到 shared）。

### 5.7 Login 任务绑定

- 创建任务：Proxy 调用 `POST /api/enterprises/:id/tasks`，body 为 `{ identity, ssoUser, ghLogin, oauthAttemptId, ssoType? }`。
  - profile 设置了 `login.ssoProvider` 时，`ssoType` 必须等于它，或者省略；没有设置时（env 合成的 default 即如此）沿用基线，由任务选择 `custom` 或 `azure`。
  - **body 不能覆盖 `ssoUrl` 或 selector**。需要删除基线 `src/login/src/tasks/runner.ts:31` 的 `payload.ssoUrl ?? config.auth.ssoUrl`。
- 任务行写入 `enterprise_id`。runner 从 profile 构造 `RuntimeAuthConfig`，内容包括：
  - `resolveGithubDeployment(baseUrl, slug)`；
  - `deviceFlowEndpoints()`；
  - `ssoLoginUrl`、`allowedLoginUrls`、`selectors`、`oauthClientId`。
- 重试（`tasks/retry.ts`）继承原任务的 `enterprise_id`，不接受 body 中的作用域。删除和重试仍先经过 `tasks/poolProtection.ts`。
- 允许的登录页：在每次填写 SSO 表单前，检查当前 URL 是否与 `allowedLoginUrls` 中某项匹配：origin 相同，且该项的路径段是当前路径段的**整段前缀**（基线用 `startsWith` 接受子路径，这里保留子路径，但 `/login` 不再匹配 `/loginfoo`）；编码穿越、点段、userinfo 一律拒绝；当前页面的 query 和 fragment 不参与比较。
  - 基线 `SSO_URL` 可能带 query 或 fragment（基线不使用它们），registry 解析 `login.ssoLoginUrl` 和 `allowedLoginUrls` 时去掉这两部分，而不是拒绝，保证原地升级。GitHub 页面用该企业的 `isGitHubUrl(url, deployment)` 判断。
- 回调：使用 §5.3 的带作用域路径。成功回调前，Proxy 按以下顺序校验：
  1. 路径企业 = 行企业；
  2. `copilot_oauth_attempt_id` CAS（基线已有）；
  3. **主体校验**：用新 token 调 `<apiBaseUrl>/user`（基线 `accounts/githubSubject.ts` 的 `verifyGithubSubject`），login 必须与该账号的 `gh_login` 一致（不区分大小写）。
     - 不一致 → 409 `authorization_subject_mismatch`，任务失败；
     - 网络错误 → 503，由 Login 有限次重试回调。
  4. 旧分支的 `proxy_authorization_attempts` 账本和 `account_incarnation` 不带入。理由：基线的 attempt CAS 已经能挡住“删除后重建的账号”收到过期回调（新账号没有该 attempt id），主体校验能挡住跨租户 token 错配；账本需要 5 个 trigger 和额外的 MySQL 权限。

### 5.8 池调度

#### 旧规则（`fork/feat/multi-sso-slug:src/proxy/src/userPool/enterpriseScheduling.ts`，原样保留）

- 只有 `active` 企业参与。记 `C = ΣC_e`，`N = ΣN_e`。
- 分数 `S_e = N × C_e − C × N_e`，即当前库存占比缺口的整数形式。**不用 (N+1) 前瞻，也不用 `N_e/C_e` 利用率**。
- 全部库存为 0 时，按 cap 从大到小选。
- 平局：建号时按排序后的 ID 以 `ordinal % n` 轮转；租号时按 `sha256(caller \0 id)` 排序。最后按 ID 排序兜底。
- 建号候选需满足 `N_e < C_e`。租号候选必须有合格的 idle。
- 全局补货量 `D = max(0, T − I − P)`。全局 pause 优先；`I ≥ T` 时不建号。
- 已有 lease 或 catalog hold 时，保持原企业和原 member，不重新按比例选择。
- `draining` 企业：不新建 lease、不新建 catalog hold、不补货，已有 lease 保留。只有 catalog hold 的 caller 落在 draining 企业时，返回 503 `enterprise_draining`，不换企业。已在开通中的 member 继续完成（外部系统已建用户，中途放弃会留下半成品）。
- 临时不健康的企业不能被选为候选，但仍计入分母。

#### 本次变化

| 方面 | 旧实现 | 新设计 |
| --- | --- | --- |
| 排名函数 | 写在 Proxy 内，两个存储各自拼 SQL | 纯函数 `rankEnterprisesForCreation` / `rankEnterprisesForAdmission`，放在 `src/packages/shared/src/enterprise/poolRanking.ts`，SQLite 与 MySQL 共用 |
| `N_e` | 每次决策 GROUP BY `user_pool_accounts ⋈ proxy_accounts` | `proxy_enterprises.inventory_count` 增量计数：预留 member 时在同一事务内 +1（member 不删除，外键 RESTRICT）；每次启动按 `COUNT(*)` 校正 |
| 建号（`reserveDeficit`） | SQLite 每插入一个成员约做 2 次全表聚合，一个事务内最多约 200 次；MySQL 每批约 64 次 | **每批只做一次聚合**算出 `I`、`P` 和 `D`；锁住 `proxy_enterprises` 行后，用内存计数逐个选择企业并插入 |
| 租号（`admit`） | 每次准入都做一次全量 snapshot | 只读 `proxy_enterprises`（≤ 32 行）来排名，然后按顺序在每个企业内做带索引的单行挑选（MySQL 用 `FOR UPDATE SKIP LOCKED`），无聚合 |
| 生命周期 | `draft`/`validated`/`active`/`draining`，加持久化 evidence JSON 和 identity hash | `draft` → `active` → `draining`（可恢复到 `active`）。激活和恢复时做实时 readiness 检查，不持久化证据 |
| readiness 探测 | worker 每次扫描都发 HTTP 探测，在补货事务之前做 | 每个副本内存缓存 60 秒，在 DB 事务外刷新 |
| 计数漂移 | — | 启动时和每小时做一次 GROUP BY 校正，偏差写入 `user_pool_events`（`enterprise_inventory_drift`） |

- 锁顺序固定：`user_pool_settings` 行 → `proxy_enterprises` 行（按 id 排序）→ member 行。Console 改 cap 与补货使用同样的锁顺序。
- 改 cap 时在事务内校验 `ΣC_e ≤ NAME_CAPACITY`。
- `PATCH /api/user-pool/settings` 只接受 `idle_target`、`lease_seconds`、`paused`。传入 `max_accounts` 返回 409 `use_enterprise_cap`。
- 基线 `GET /api/user-pool`（含成员列表的总览）由 `/api/user-pool/overview`（全局设置与计数）和企业作用域路由取代；旧直连 `/api/accounts*` 保留一个版本，响应带 `Deprecation: true`。

---

## 6. 按企业的 GitHub / GHE 端点

`src/packages/shared/src/enterprise/githubEndpoints.ts` 基于基线 `parseGithubBaseUrl` 和 `src/login/src/auth/githubUrls.ts`（移入 shared），由 profile 一次性算出下表的 frozen 对象。代码中不再出现 `https://github.com` 或 `api.github.com` 字面量，只有默认值推导函数里保留。

| 端点 | 推导 | 使用位置（基线文件 → 改造） |
| --- | --- | --- |
| web base | `github.baseUrl` | Login `HeadlessPlaywrightAuthStrategy.ts` 的 `isGitHubUrl`、`isGitHubSsoInterstitial`、`isGheComSignInPage`；SSO 中 `saml/saml.ts` 的 SP 默认值 |
| GHE.com enterprise SSO 入口 | `<baseUrl>/enterprises/<slug>/sso` | Login `completeEnterpriseSsoLogin` |
| 设备流 | `<baseUrl>/login/device/code`、`<baseUrl>/login/oauth/access_token` | Login `auth/deviceFlow.ts`，使用 `github.oauthClientId` |
| 设备验证页 | `<baseUrl>/login/device` | Login：浏览器始终打开这个计算值；GitHub 返回的 `verification_uri` 不一致时只记 warning。旧分支在 `deviceFlow.ts:34` 和 `HeadlessPlaywrightAuthStrategy.ts:133` 写死了 github.com，不带入 |
| GitHub 允许的主机 | baseUrl 主机及其子域；GHE.com 额外允许 `auth.ghe.com` | Login。旧分支 `HeadlessPlaywrightAuthStrategy.ts:785` 写死的 `url.origin === 'https://github.com'` 不带入 |
| REST API | `github.apiBaseUrl` | SSO `copilot/seats.ts`、`budget/budgetService.ts`；Proxy `accounts/githubSubject.ts`（Models、回调主体校验） |
| SCIM | `sso.scimBaseUrl` | SSO `scim/scimClient.ts` |
| Copilot API | `github.copilotApiBaseUrl` | Proxy：`copilot/copilotAuthManager.ts` 的 `getAuth`；`routes/compatible.ts` 的 `requestAuth`；`userPool/provisioner.ts` 的预热；`copilot/copilotClient.ts` 的 `validateCopilotOauthToken`；`routes/modelsApi.ts` |
| shortcode / 句柄 | `github.shortcode`，GHE.com 为 `""` | SSO `scim/handle.ts` 和 `users/service.ts`；Proxy `copilotAuthManager.stripEnterpriseShortcode` |
| SAML SP | `sso.spEntityId`、`sso.spAcsUrl` | SSO `saml/saml.ts` |

**缓存键必须包含企业**。不同 GitHub 实例的数字用户 ID 可能重复，所以：

- Models 管理员缓存键：`models-admin:<enterpriseId>:<githubUserId>`；
- 按 identity 的模型缓存同样加企业前缀。

---

## 7. Console 变化

1. **企业选择器**放在页头。选项来自 `GET /api/console/proxy/enterprises`，每项显示 `displayName`、GitHub 主机（`github.com` 或 `xxx.ghe.com`）和状态。
   - 选择保存在 URL hash（`#/<page>?e=<id>`），刷新不丢失。
   - UI 首次默认选中 `default`，这只是界面初值；每个 API 调用都显式带 id。
2. **作用域页面**：Accounts、SSO Users、Budgets（AI credits）、Login Tasks、Request Stats、Models、企业池（members、leases、events）。
   - 页面以 `${enterpriseId}:${page}` 为 key 重新挂载。
   - 移植旧分支 `web/lib/scope.ts` 的 `useScopeLifetime`：切换企业时中止进行中的请求，并丢弃迟到的结果。
   - 危险操作的确认框显示企业 ID 与 slug。
3. **全局页面**：
   - Dashboard：每个企业一张卡片。
   - Pool overview：全局设置（idle target、TTL、pause），加企业表。企业表列出：状态、库存/cap、目标占比、实际占比、分数、ready idle、leased、在途、failed/disabled、blocker、名字目录剩余容量。
     - 操作：改 cap（CAS `policy_version`）、Activate（显示三方 readiness 明细）、Drain、Resume。
     - 页面注明：库存不等于账单，占比不等于流量配额。
   - Settings：Login 运行时设置为全局；SSO 运行时设置按企业。
   - Error diagnostics。
4. **Models 页按企业查询**：`GET /api/console/proxy/enterprises/:id/models`。使用该企业的 `modelsAdmin` 和端点，**不回落到池账号或直连账号**（基线语义）。未配置时显示该企业的 `models_admin_not_configured`。参考父仓库未提交的 `src/console/src/web/pages/ModelsPage.tsx`（`ModelsPage({ enterpriseId })`）。
5. **同源保护**：`src/console/src/server/apiProxy.ts` 对**所有**非 GET/HEAD/OPTIONS 的转发请求校验 `Origin` 和 `Sec-Fetch-Site`，包括旧的 `/accounts/:id` PATCH/DELETE、`/login-service/settings/runtime`、`DELETE /error-diagnostics`。`src/console/src/server/index.ts` 中 Console 自身的写接口（password、logout 等）也加同样的检查。旧分支只保护了 `/management*` 和 `/profiles*`。
6. 代码组织：新页面放在 `src/console/src/web/pages/*.tsx`，不再增大 2,362 行的 `App.tsx`。API helper 统一使用 `enterprisePath(service, id)`。

---

## 8. 代码规范与去重

**规范**（适用于所有新增和改写的代码，CI 中用 lint 检查新文件）：

- 行宽 ≤ 120；一行一条语句。
- 函数短小且有名字（目标 ≤ 40 行）。
- SQL 写成多行模板字符串，一个子句一行。
- 不重排无关代码。不在业务代码中引入 `V1`、`V3` 这类版本后缀。

**放入 shared 的模块**（`src/packages/shared/src/`，旧分支中的重复点见附录 A）：

| 模块 | 内容 | 消除的重复 |
| --- | --- | --- |
| `enterprise/registry.ts` | 类型、`parseRegistry`（结构、唯一性、容量） | 旧 `enterprise.ts` 与 `enterpriseV3.ts` 两套解析器 |
| `enterprise/registryFields.ts` | 字段表、单字段校验、`EnterpriseRegistryError` | — |
| `enterprise/registryDefaults.ts` | §3.3 默认值推导、GHE.com/github.com 规则、blockers | — |
| `enterprise/trustedUrl.ts` | `parseTrustedUrl`、`sameTrustedUrl`（按路径段精确比较） | — |
| `enterprise/registryFile.ts` | `loadRegistry({ service, env })`：读文件、与 env 合并、deep-freeze | — |
| `enterprise/defaultFromEnv.ts` | 各服务的 env→default 映射表（§3.5） | — |
| `enterprise/secrets.ts` | `readSecret(ref)`，带 60 秒缓存 | — |
| `enterprise/githubEndpoints.ts` | §6，含从 Login 移入的 `githubUrls.ts`；`defaultApiBaseUrls` 是唯一写公共 API 主机名的地方 | — |
| `enterprise/fingerprint.ts` | `profileFingerprint(fields)`，唯一的 hash 实现 | 旧 `enterpriseRegistryHashV3` 三份、`enterpriseMysqlRegistryHashV3` |
| `enterprise/scope.ts` | `EnterpriseId` 品牌类型、`requireEnterprise(lookup)` 中间件、`enterpriseOf(res)`、`EnterpriseScopeError` | 旧 Proxy、SSO、Login 三份 `enterprise.ts` |
| `enterprise/poolRanking.ts` | §5.8 的纯函数（含按批次分配的 `planCreations`） | — |
| `enterprise/dto.ts` | 企业 DTO：`EnterpriseSummaryDto`、`EnterprisePoolPolicyDto`、`EnterpriseReadinessDto` | — |
| `deepFreeze.ts` | — | 旧 `enterpriseRuntimeV3.ts:40`、`login/db/connection.ts:58` |
| `abort.ts` | `abortable(promise, signal)` | 旧 `abortable` ×2、`untilSignal`、`untilAborted` |
| `boundedResponse.ts` | `readBoundedJson(response, maxBytes)` | 旧 `readResponse`、`readJson` 和一份内联 reader |
| `externalFetch.ts` | `redirect: 'error'`，以及“结果不确定”错误 | — |
| `sqliteService.ts` | `openServiceDb(path)`（WAL、`secure_delete`、`foreign_keys`）、`runSqliteMigrations(steps)`、`rebuildSqliteTable()` | SSO 与 Login 的 `db/connection.ts`，以及各自的 `addColumnIfMissing` |

MySQL 的 schema 定义仍集中在 `src/proxy/src/db/mysqlSchema.ts`，只服务于 Proxy，不搬到 shared。

---

## 9. 测试策略

### 9.1 单元测试（各里程碑内完成）

- registry：解析、默认值推导、冲突、GHE.com 规则（空 shortcode，30 字符句柄）、URL 攻击样例、容量上限、身份变化与企业删除的检测。
- 排名函数：旧设计文档 §5 的例子（空池 500/300/200 → 25/15/10；cap 9/1、库存 1/0 时选 B）；平局轮转无长期偏置。
- 迁移：对“空库 / r4 形态库 / 半途崩溃（每一步之后注入失败）”三种起点，重复执行两次，结果一致。
- 端点：§6 表格逐行断言；对代码库 grep，`https://github.com` 只出现在默认值函数里。

### 9.2 跨租户负面测试（从旧分支移植并改写）

| 旧文件（`fork/feat/multi-sso-slug`） | 新位置 / 要点 |
| --- | --- |
| `src/proxy/src/routes/authorizationV3.test.ts` | `src/proxy/src/routes/internalEnterprise.test.ts`：错企业路径回调返回 404；attempt 过期或错配被拒；主体不一致返回 409 |
| `src/proxy/src/routes/enterpriseManagement.test.ts` | `.../enterprisePolicy.test.ts`：错企业的 list/page/action；CAS；生命周期转换 |
| `src/proxy/src/userPool/enterprisePhase4.sqlite.test.ts`、`mysqlPhase4.test.ts` | `.../storeContract.ts`（见 §9.3）：draining 阻止新 lease 和 catalog hold；事件与成员不串企业 |
| `src/proxy/src/userPool/phase4CreationEligibility.test.ts` | 全局 ordinal；过期的资格判断不能越过 cap 或 drain |
| `src/proxy/src/userPool/enterpriseReadiness.worker.test.ts` | 一个企业挂起，不会饿死其他企业；draft 和 draining 企业不被探测 |
| `src/proxy/src/routes/multiEnterpriseMessagesProtocol.test.ts` | `/v1/messages` 按 lease 所属企业使用对应的 Copilot base URL（一个 github.com、一个 GHE.com） |
| `src/proxy/src/clients/enterpriseReadiness.test.ts` | 错 id、字段不一致、超大或挂起的响应，都 fail closed |
| `src/sso/src/users/enterpriseIsolation.test.ts` | 同名用户的 CRUD、搜索、设置、预算、导入隔离 |
| `src/sso/src/saml/saml.test.ts`、`sessionStore.test.ts` | 按企业的 metadata 和证书；严格 AuthnRequest；cookie 跨企业无效；重建用户后旧 cookie 失效；重启后会话有效（新增） |
| `src/sso/src/users/poolSafety.test.ts` | pool-membership 查询带作用域；查询失败时 fail closed |
| `src/login/src/auth/profileIsolation.test.ts` | allowlist 整段前缀匹配（兄弟前缀拒绝、子路径接受、编码穿越拒绝）；GHE.com 主机判断 |
| `src/login/src/db/poolTaskSafety.test.ts`、`runnerIsolation.test.ts` | body 不能改作用域；重试继承企业；跨企业的变更不会调用 Proxy |
| `src/console/src/server/apiProxy.test.ts` | **所有**写路由都要求同源（含旧 `/accounts/:id`） |
| `src/console/src/web/pages/EnterprisePoolPage.browser.test.ts` | 迟到的读写停留在已确认的作用域；切换企业后草稿重置 |

不移植：所有 `*Phase5*`、`*Stage6*`、`*V3*`、`*V4*` 中验证离线工具、迁移回执、trigger 或 evidence 的用例，以及 `tests/enterprise-phase5`、`tests/enterprise-phase7` 的整套编排。

### 9.3 MySQL / SQLite 一致性

- 新增 `src/proxy/src/userPool/storeContract.ts`，一份场景集同时由 `store.test.ts`（SQLite）和 `mysqlStore.integration.test.ts`（MySQL 8.4，设置 `MYSQL_TEST_URL` 时运行）执行。场景包括：补货批次、cap 边界、draining、计数漂移校正、准入排名、同一 caller 跨副本 gate。
- 两个后端对同一组输入必须给出相同的企业选择序列。

### 9.4 原地升级资格测试（single-slug r4 → multi）

在 `tests/image-release/qualification-run.mjs` 中新增模式 `RELEASE_QUALIFICATION_MODE=multi-upgrade`：

1. 基线镜像使用 `single-slug-164cade-amd64-r4`，沿用现有的 smoke 数据（账号、库存、caller `mysql-smoke-1` 的 lease、统计）。暂停池，保存快照，**备份**。
2. 在同一数据卷上换成 multi 候选镜像，不提供 registry 文件，env 不变。断言：
   - 快照逐字段相等，且新增 `enterprise_id='default'`；
   - 同一 caller 的 6 个协议请求仍绑定同一 lease；
   - 根路径 SAML 登录可用，已有 `sso_session` 仍有效；
   - Login 任务历史完整；
   - `schema_migrations` 包含全部步骤。
3. 用 r4 镜像直接启动在已迁移的 MySQL 上，断言启动失败（严格校验）。
4. 加入 registry，内含 `default`（env 已清空）和一个 GHE mock 企业。滚动重启后新企业为 `draft` → 激活 → 补货 → 推理。执行跨租户负面检查：错企业回调、同名 SSO 用户、cookie 互换。
5. 恢复第 1 步的备份，用 r4 镜像启动，断言恢复到升级前的状态（回滚演练）。
6. 用 SQLite direct 模式的 `tests/image-release/compose.yaml` 做同样的快速升级冒烟。
7. 迁移崩溃演练：MySQL 迁移进行到第 4 步时 kill 容器，重启后迁移继续并完成。

### 9.5 GHE mock 企业

- 扩展 `tests/docker-user-pool/mock-services.mjs`，按 `Host` 分发租户：
  - 现有租户 `local-test`（github.com 形态）；
  - 新租户 `contoso.ghe.com`、`api.contoso.ghe.com`、`copilot-api.contoso.ghe.com`。三个主机名都作为 internal 网络别名指向 mock 容器，不出网。基线 `parseGithubBaseUrl` 接受 http。
- mock 覆盖：SCIM（返回无后缀的 30 字符句柄）、设备流、`/user`、Copilot `/models`、推理、`auth.ghe.com` 重定向。
- 参考旧分支 `tests/enterprise-phase5/mock-provider.mjs` 的故障注入模式（`delay`、`lost-ack`、`429`、`500`），只取需要的部分。

---

## 10. 工作分解

规模按“源码 + 测试”的新增或改写行数粗估。

### M1 共享基础（无行为变化）

- **新增**：`src/packages/shared/src/enterprise/{registry,registryFile,defaultFromEnv,secrets,githubEndpoints,fingerprint,scope,poolRanking}.ts`、`deepFreeze.ts`、`abort.ts`、`boundedResponse.ts`、`externalFetch.ts`、`sqliteService.ts`，以及对应的 `*.test.ts`。
- **修改**：`src/packages/shared/src/index.ts`、`enterprise/dto.ts`（企业 DTO：`EnterpriseSummaryDto`、`EnterprisePoolPolicyDto`、`EnterpriseReadinessDto`）；`src/login/src/auth/githubUrls.ts` 改为从 shared 重导出。
- **验收**：
  - 所有服务在没有 registry 文件时行为不变，全量测试通过；
  - §9.1 中 registry、排名、端点的单元测试全部通过；
  - 新文件无超过 120 字符的行。
- **规模**：约 1.2k 源码 + 1.2k 测试。**依赖**：无。

### M2 Proxy 存储与迁移

- **修改**：
  - `src/proxy/src/db/{migrations,mysqlMigrations,mysqlSchema,mysqlMigrationLock,mysqlInitialSql,sqliteStorage,mysqlStorage,storageTypes,accountsRepo,requestStatsRepo,managementQueries}.ts`；
  - `src/proxy/src/userPool/{store,mysqlStore,mysqlMigrations,storage,paging}.ts`：存储层，计数器维护；调度逻辑在 M5 做。
- **新增**：`src/proxy/src/db/enterpriseMigrations.ts`、`src/proxy/src/db/enterpriseRepo.ts`、`scripts/proxy-mysql-enterprise-upgrade.sql`（生成文件）；**再生成** `scripts/proxy-mysql-initial.sql`。
- **验收**：
  - 对 r4 形态的 SQLite 和 MySQL 库，迁移后快照保真，重跑结果相同，按步骤注入崩溃后能继续；
  - 不带 `enterprise_id` 的 INSERT 在两个后端都失败；
  - `MYSQL_AUTO_MIGRATE=false` 时，用生成的 SQL 建库能通过校验；
  - 额外的二级索引不影响启动。
- **规模**：约 1.5k + 1.5k。**依赖**：M1。

### M3 SSO 多企业

- **修改**：
  - `src/sso/src/{config,server}.ts`；
  - `db/{connection,migrations,usersRepo,budgetRepo,emuImportPlansRepo,runtimeSettingsRepo,eventLog}.ts`；
  - `saml/saml.ts`、`routes/{samlRoutes,usersApi,settingsApi,budgetApi,operationsApi,loginCredentials}.ts`；
  - `users/{service,passwordPolicy,bulkImport}.ts`、`scim/scimClient.ts`、`copilot/seats.ts`、`budget/budgetService.ts`、`clients/proxyClient.ts`。
- **新增**：`src/sso/src/routes/enterprisesInternal.ts`（readiness）、`src/sso/src/saml/enterpriseSession.ts`（签名 cookie 封装）。
- **验收**：
  - 基线测试全部通过（default 行为不变，包括已有 `sso_session` 仍有效）；
  - §9.2 中 SSO 的负面测试全部通过；
  - GHE.com 企业的 SCIM 句柄为无后缀、最长 30 字符；
  - 重启后 SAML 会话有效。
- **规模**：约 1.5k + 1.3k。**依赖**：M1。**可与 M2、M4 并行**。

### M4 Login 多企业

- **修改**：
  - `src/login/src/{config,server}.ts`；
  - `db/{connection,migrations,tasksRepo}.ts`；
  - `routes/{tasksApi,operationsApi,settingsApi}.ts`；
  - `tasks/{queue,runner,retry,delete,poolProtection,recovery}.ts`；
  - `auth/{deviceFlow,HeadlessPlaywrightAuthStrategy}.ts`、`clients/proxyClient.ts`。
- **新增**：`src/login/src/routes/enterprisesInternal.ts`、`src/login/src/auth/loginUrlAllowlist.ts`。
- **验收**：
  - 任务绑定企业后不可改；body 中的 `ssoUrl` 被拒；
  - github.com 与 GHE.com 两个企业的设备流使用各自的端点和 client id；
  - allowlist 测试全部通过；
  - 回调走带作用域的路径。
- **规模**：约 0.8k + 0.9k。**依赖**：M1。**可与 M2、M3 并行**。

### M5 Proxy 路由、调度与授权

- **修改**：
  - `src/proxy/src/{config,server}.ts`；
  - `routes/{adminApi,userPoolApi,internalApi,operationsApi,modelsApi,compatible}.ts`；
  - `copilot/{copilotAuthManager,copilotClient,modelsAdmin}.ts`；
  - `accounts/{loginAuthorization,githubSubject,poolGuard}.ts`；
  - `clients/{ssoClient,loginClient}.ts`；
  - `userPool/{admission,runtime,worker,provisioner,store,mysqlStore}.ts`（调度部分）。
- **新增**：`src/proxy/src/routes/enterprisesApi.ts`、`src/proxy/src/clients/enterpriseReadiness.ts`、`src/proxy/src/userPool/storeContract.ts`。
- **验收**：
  - §9.2 中 Proxy 的负面测试全部通过；
  - §9.3 的一致性场景在两个后端都通过；
  - 补货事务内聚合查询次数 ≤ 1，准入路径无聚合（用查询计数器断言）；
  - 两个企业（github.com + GHE mock）各自使用自己的 Copilot 和 API 端点；
  - Models 不回落到池账号。
- **规模**：约 2k + 2k。**依赖**：M2；客户端契约依赖 M3、M4（可先对 mock 契约开发）。

### M6 Console、发布与资格测试

- **修改**：
  - `src/console/src/server/{apiProxy,index}.ts`；
  - `src/console/src/web/{App.tsx, api/*.ts}`；
  - `pages/{UserPoolPage,ModelsPage}.tsx`；
  - `deploy/images/Dockerfile.release`（`RELEASE_LINE` build arg 和 label）；
  - `tests/image-release/{qualification-prepare,qualification-run,qualification-compose.json,mock.mjs}`、`tests/docker-user-pool/mock-services.mjs`；
  - `.env.example`、`docker-compose.yml`。
- **新增**：
  - `src/console/src/web/pages/{EnterprisePoolPage,EnterpriseSelector}.tsx`、`src/console/src/web/lib/scope.ts`、`src/console/src/web/api/enterprises.ts`；
  - `deploy/enterprise-registry.example.json`；
  - `docs/multi-enterprise-upgrade-guide.md`、`docs/multi-enterprise-registry.md`（都需要加入 `.gitignore` 白名单）。
- **验收**：
  - 浏览器测试覆盖作用域切换、生命周期操作、所有写路由的同源保护；
  - §9.4 的 7 步全部通过并出具报告；
  - 镜像按 §11 打标签，不覆盖 single-slug 标签。
- **规模**：约 1.5k + 1k，另有资格测试脚本约 0.6k。**依赖**：M5（Console 可在 M5 冻结 shared 契约后开始）。

### 并行关系

```text
M1 ──┬── M2 ── M5 ──┐
     ├── M3 ────────┤
     └── M4 ────────┴── M6（Console 部分在 M5 契约冻结后开始；资格测试最后做）
```

- M2、M3、M4 可由三人并行。
- M5 的 SSO/Login 客户端先对 M3/M4 在 `enterprise/dto.ts` 中定好的契约做 mock 开发。
- 每个里程碑单独提交和评审，不一次性合并。

---

## 11. 发布与镜像

- 仍使用单一 `deploy/images/Dockerfile.release`。新增 build arg `RELEASE_LINE=single|multi`，只影响 OCI label 和 `/health` 中的 `releaseLine` 字段。
- 分支：从 `release/proxy-dockerhub`（或其合入的 `main`）切出 `feat/multi-enterprise`。single-slug 发布线继续独立维护。
- Docker Hub 标签与 single-slug **完全分开**：
  - 发布：`linkinchow/ghcp-{proxy,console,sso,login}:multi-<sha7>-amd64`；
  - 资格候选（本地）：`ghcp-release-<component>:multi-<sha7>-amd64-r<N>`。
  - 需要修改 `qualification-prepare.mjs` 中的标签正则。
  - 不推 `latest`，不复用 `single-slug-*`。
- 推送前按记忆中的规则做敏感信息检查；推送由用户单独授权。

---

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 大统计表在线建索引耗时较长 | MySQL 迁移持锁期间，其他副本等锁超时后反复重启 | 新增 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`；升级指南建议先单副本升级，或由 DBA 先执行生成的 SQL；资格测试记录用时 |
| 混跑窗口（K8s 按 Deployment 逐个滚动） | 旧版写入失败；在途 Login 任务失败 | 旧写方 fail closed；建议首次升级用 Recreate 或一次性替换全部镜像；池 worker 会重新派发 |
| 已迁移的 SQLite 被旧镜像打开 | 读取可以，写入被 trigger 拒绝，旧版本出现报错 | 只支持备份恢复；指南中写明 |
| compose 模板默认值与 registry 冲突 | 启动报 `enterprise_env_conflict` | 有意为之（不静默忽略）；M6 更新模板和文档 |
| 不同 GitHub 实例的数字用户 ID 重复 | 缓存串号 | 缓存键加企业前缀（§6） |
| 10,000 个名字由所有企业共享 | cap 合计受限 | 校验 `ΣC_e ≤ 10000`；Console 单独显示名字目录余量 |
| SSO/Login 仍单实例 | 可用性不变 | 非目标；会话已不再是障碍 |

---

## 13. 已决问题（2026-10-17 用户确认）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | 升级前企业的内部 ID | 固定为 `default`。 |
| 2 | 无作用域的旧 `/api`、`/internal` 接口 | 没有外部脚本调用；按设计对非直连路径返回 400，只有旧 `/api/accounts*` 直连路由保留一个版本。 |
| 3 | 首次升级是否允许短暂停机 | 允许：一次性替换四个镜像或使用 Recreate；不做滚动兼容层。 |
| 4 | OpenCode OAuth client id 能否用于 `*.ghe.com` | 暂不决定，等真实环境确认；按企业可覆盖 `oauthClientId`。 |
| 5 | Login 并发是否按企业公平 | 保持全局 FIFO 和全局并发度。 |
| 6 | `MYSQL_AUTO_MIGRATE=false` 的客户 | 由 DBA 执行生成的 `proxy-mysql-enterprise-upgrade.sql`。 |

---

## 附录 A：旧分支文件去向

路径均指 `fork/feat/multi-sso-slug`。“移植”= 逻辑基本保留并按新规范重写；“重写”= 只保留思想；“丢弃”= 不带入。

| 旧文件 / 目录 | 去向 | 说明 |
| --- | --- | --- |
| `src/packages/shared/src/enterprise.ts`（v2 契约） | 重写 → `enterprise/registry.ts` | 单一 version 1；ID 不再是 UUID |
| `.../enterpriseV3.ts` | 重写 → `enterprise/registry.ts`、`scope.ts` | 删除 `allowLegacyOmission`、`legacyEnterpriseId`、per-profile 内部地址；`AuthorizationBinding` 丢弃 |
| `.../enterpriseRuntimeV3.ts` | 重写 → `registryFile.ts`、`secrets.ts`、`deepFreeze.ts` | secret 引用的格式保留 |
| `.../enterpriseRuntimeV4.ts` | 丢弃 → `fingerprint.ts` | — |
| `.../enterprisePoolV4.ts` | 部分移植 → `enterprise/dto.ts` 中的 DTO | `validated` 状态、evidence、`validation_kind` 丢弃 |
| `.../enterpriseStorage.ts`、`enterpriseStorageV3.ts`、`enterpriseStorageV4.ts` | 丢弃 | 离线 schema、回执、trigger 由运行时迁移替代 |
| `.../enterpriseMysql.ts`、`enterpriseMysqlV1.ts`、`V3`、`V4`、`SchemaV3`、`SchemaV4` | 丢弃 | MySQL schema 继续集中在 `src/proxy/src/db/mysqlSchema.ts` |
| `.../enterpriseSqliteV1.ts`、`enterpriseSqliteReadiness.ts` | 丢弃 | 由 `sqliteService.ts` 的迁移加校验替代 |
| `.../poolNames.ts`、`poolNameCatalog.json`；`src/proxy/src/userPool/nameCatalog.json` 与 `names.ts` 的改动；`scripts/generate-pool-name-catalog.mjs`、`scripts/pool-name-tokens.mjs`；`docs/pool-name-catalog-provenance.md` | 丢弃 | 用户决策 4：保持基线 1000×10 |
| `.../contracts.ts`、`httpClient.ts` 的改动 | 按需移植 | 只取企业 DTO |
| `upgrade/default-enterprise/*`、`upgrade/multi-enterprise/*`、`upgrade/multi-enterprise-pool/*` | 丢弃 | 用户决策 2 |
| `upgrade/v1-frozen/*` | 丢弃 | 同上 |
| `upgrade/sqlite-to-mysql/*`、`upgrade/user-pool-mysql/*` 的改动 | 丢弃 | 保持基线 |
| `src/proxy/src/enterprise.ts` | 重写 → shared `scope.ts` 加 Proxy 装配 | 删除 `requestEnterpriseProfile` 的 legacy 回落 |
| `src/proxy/src/accounts/authorization.ts` | 部分移植 → `accounts/loginAuthorization.ts` | 只取 `/user` 主体校验 |
| `src/proxy/src/db/authorizationLedger.ts`、`mysqlAuthorization.ts`、`sqliteAuthorization.ts` | 丢弃 | 由 attempt CAS 加主体校验替代（§5.7） |
| `src/proxy/src/db/copilotOauthTokenImportFence.ts` | 丢弃 | 基线在 caller-lease 模式下禁用 import；direct import 校验行的企业 |
| `src/proxy/src/routes/internalApi.ts` | 重写 | 基线路由加 `/internal/enterprises/:id` 前缀 |
| `src/proxy/src/routes/enterpriseManagement.ts` | 重写 → `routes/enterprisesApi.ts` | 生命周期简化，不保存 evidence |
| `src/proxy/src/routes/adminApi.ts`、`userPoolApi.ts` 的改动 | 重写 | 作用域路由；旧池路由返回 400 |
| `src/proxy/src/clients/enterpriseReadiness.ts` | 重写 | 字段比对加缓存（§3.8） |
| `src/proxy/src/userPool/enterpriseScheduling.ts` | 移植公式 → shared `poolRanking.ts` | `logicalSupplySql`、evidence 和策略记录丢弃 |
| `src/proxy/src/userPool/store.ts`、`mysqlStore.ts` 的改动 | 在基线上重写 | 增量计数器；每批一次聚合；共享排名 |
| `src/proxy/src/userPool/provisioner.ts`、`worker.ts` 的改动 | 重写 | 带企业的补货；readiness 缓存 |
| `src/proxy/src/copilot/copilotAuthManager.ts` 的改动 | 重写 | per-enterprise `copilotApiBaseUrl` 与 shortcode；旧分支中 Copilot 端点仍是全局的 |
| `src/sso/src/enterprise.ts` | 重写 → shared `scope.ts` | — |
| `src/sso/src/saml/saml.ts` | 移植 | 按企业的上下文缓存；严格 AuthnRequest 校验 |
| `src/sso/src/saml/sessionStore.ts` | 丢弃 | 改为按企业签名的 cookie（§5.5） |
| `src/sso/src/routes/samlRoutes.ts` | 重写 | 根路径 default 加 `/enterprises/:id`；Origin 检查 |
| `src/sso/src/users/service.ts`、`db/usersRepo.ts` | 在基线上重写 | 保留基线保护和异步密码；`enterpriseId` 为必填参数 |
| `src/sso/src/users/operationFence.ts` | 暂不移植 | 基线 management operations 已有并发控制，M3 中复评 |
| `src/sso/src/clients/externalFetch.ts` | 移植 → shared `externalFetch.ts` | — |
| `src/sso/src/db/connection.ts`、`src/login/src/db/connection.ts` | 重写 → shared `sqliteService.ts` | — |
| `src/login/src/db/tasksRepo.ts`、`routes/tasksApi.ts`、`tasks/queue.ts`、`tasks/runner.ts` | 在基线上重写 | 只加 `enterprise_id` 绑定；`binding_version`、nonce ledger 和 tombstone 表丢弃 |
| `src/login/src/auth/deviceFlow.ts`、`HeadlessPlaywrightAuthStrategy.ts` 的改动 | 部分移植 | allowlist 改为整段前缀匹配；写死的 github.com 删除 |
| `src/console/src/web/pages/EnterprisePoolPage.tsx` | 重写 | 全局页加企业表；无 validate 步骤 |
| `src/console/src/server/apiProxy.ts` 的同源保护 | 移植并扩大 | 覆盖所有写路由 |
| `src/console/src/web/lib/scope.ts` | 移植 | `useScopeLifetime` |
| `src/console/src/web/api/enterprises.ts` | 重写 | ID 不再是 UUID；不再有 `legacyEnterpriseId` 发现 |
| `tests/enterprise-phase5/*`、`tests/enterprise-phase7/*` | 只作参考 | mock 故障注入和 owner-failover 思路并入 `tests/image-release` |
| `docs/user-pool-multi-sso-slug-*.md` | 只作参考 | 本文替代 |

## 附录 B：旧分支中需要删除的写死 GitHub 地址

- `src/login/src/auth/deviceFlow.ts:34`：`verification_uri !== 'https://github.com/login/device'`
- `src/login/src/auth/HeadlessPlaywrightAuthStrategy.ts:133`：`'https://github.com/login/device'`
- `src/login/src/auth/HeadlessPlaywrightAuthStrategy.ts:785`：`url.origin === 'https://github.com'`
- `src/login/src/config.ts`：设备流端点写死 github.com。基线已改为 `deviceFlowEndpoints()`，以基线为准。
- 测试夹具：`src/login/src/db/enterpriseFixture.ts`、`src/proxy/src/userPool/mysqlPhase4.fixture.ts`。新夹具从 registry 示例生成，同时包含 GHE.com 企业。
