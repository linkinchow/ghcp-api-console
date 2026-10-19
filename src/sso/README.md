# SSO 模块说明

`@ghcp/sso` 是本仓库中的自定义 SSO/EMU 管理服务。它维护本地 SSO 用户，作为 SAML IdP 完成登录，调用 GitHub SCIM 创建/更新 EMU 用户，管理 Copilot seat，并缓存 Copilot AI Credits 用量。服务对外有两类入口：浏览器/SAML 公开路由（每个企业一组），以及带内部令牌、按企业作用域的 `/api`、`/internal` 路由。

> 本文只基于 `src/sso` 代码、`src/packages/shared` contracts、`package.json`、`.env.example`、`Dockerfile` 和 `tsconfig.json`。代码中没有的能力会标注“当前未提供/未配置”。

## 1. 模块定位

SSO 模块负责“本地 SSO 用户 ↔ GitHub Enterprise Managed User(EMU)”之间的身份桥接：

- **本地身份源**：在 SQLite 中保存 `ssoUser`、密码哈希、email、角色、GH SCIM/登录名、Copilot seat 状态。
- **SAML IdP**：向 GitHub Enterprise 返回 SAMLResponse，NameID/username 使用 `ssoUser`。
- **SCIM provisioning**：通过 GitHub SCIM API 创建、更新、暂停、删除 EMU 用户，并保存 `ghLogin` / `ghScimId`。
- **Copilot 管理**：通过 GitHub Enterprise Copilot selected users API 分配/移除 seat，并查询 AI Credits 用量。
- **与 proxy 联动**：提供 `/api/enterprises/:enterpriseId/users/ensure` 供内部服务确保 SSO 用户存在；删除 SSO 用户时会调用 `PROXY_BASE_URL` 的内部清理接口删除该企业的 proxy 账号和请求统计。
- **多企业**：一个 SSO 进程为多个 GitHub 企业（github.com 或 GHE.com）充当 IdP。每个企业有独立的 SAML 地址、签名证书、会话 cookie、SCIM/席位/预算端点与凭据、SSO 用户和 runtime settings；同名 SSO 用户在不同企业互不相干。不配置 registry 时只有由环境变量合成的 `default` 企业，行为与单企业版相同。

当前未提供/未配置：

- 不直接获取或保存 GitHub OAuth token。
- 不直接调用 login 服务。
- 没有后台自动对账、自动重试队列或定时任务；跨系统一致性依赖显式 API 操作和重试。

### 多企业配置来源

SSO 启动时读取一次企业 registry（`ENTERPRISE_REGISTRY_FILE`，可选，必须与 Proxy、Login 挂载同一份文件），并与环境变量合并：

- `default` 企业由 `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`、`SP_ENTITY_ID`、`SP_ACS_URL`、`SCIM_BASE_URL`、`SCIM_TOKEN`、`GITHUB_COPILOT_SEAT_PAT`、`SESSION_SECRET`、`SSO_DEFAULT_USER_PASSWORD`、`CERT_DIR` 合成。registry 中也写了 `default` 时，同一字段与环境变量不一致即启动失败（`enterprise_env_conflict`）。
- 其他企业只来自 registry：`github.*`、`sso.*`（`spEntityId`、`spAcsUrl`、`scimBaseUrl`、`emailDomain`、`userPrefix`），secret 只能写引用 `{ "env": "NAME" }` 或 `{ "file": "/abs/path" }`：`sso.signingCert`、`sso.signingKey`、`sso.sessionSecret`（必填，缺失时企业未就绪），`sso.scimToken`、`sso.seatPat`、`sso.defaultUserPassword`（可选）。`file` 引用读取后缓存 60 秒，轮换 SCIM token、席位 PAT 等挂载的 Secret 不需要重启；但签名证书和私钥在该企业第一次处理 SAML 请求时载入并在进程内保留，轮换后需重启 SSO。
- 企业已有 SSO 用户后，修改其 `github.baseUrl`、`github.slug`（不区分大小写）、`github.shortcode`，或从 registry 删除它，SSO 启动失败（`enterprise_identity_changed` / `enterprise_missing_from_registry`）。
- 启动日志为每个企业打印 GitHub 地址、GH login 规则和 SAML metadata 地址。

字段说明和新增企业步骤见 [registry 配置参考](../../docs/multi-enterprise-registry.md)。

## 2. 核心功能

### SAML 登录

- `GET /metadata` 输出 IdP metadata。
- `GET /sso` 解析 GitHub 发来的 Redirect binding `SAMLRequest`，把待处理请求（`InResponseTo` / `RelayState`，5 分钟有效）保存到该企业的签名会话 cookie。AuthnRequest 的 `Issuer` 必须等于该企业的 SP entityID，`Destination`、`AssertionConsumerServiceURL` 如果存在也必须匹配；无效请求返回 `400` 纯文本错误。
- `GET /login` / `POST /login` 提供简单 HTML 登录表单，按 `(企业, ssoUser)` 查找本地 `sso_users` 并用 scrypt 密码哈希校验；另一企业的同名用户无法登录本企业。
- 登录成功后生成 POST binding SAMLResponse，自动提交到 SP ACS。
- SAMLResponse 中包含 `username`、`full_name`、`emails` attributes。

**按企业的 SAML 地址**（`src/routes/samlRoutes.ts`）：

| 企业 | 路由 | IdP entityID（metadata 地址） | GitHub 侧 Sign on URL |
| --- | --- | --- | --- |
| `default` | 根路径 `/metadata`、`/sso`、`/login`、`/logout`（与单企业版相同） | `<BASE_URL>/metadata` | `<BASE_URL>/sso` |
| 其他企业 | `/enterprises/<id>/metadata`、`/sso`、`/login`、`/logout` | `<BASE_URL>/enterprises/<id>/metadata` | `<BASE_URL>/enterprises/<id>/sso` |

升级后 `default` 的 IdP entityID、证书和 ACS 都不变，GitHub 侧已有的 IdP 配置**不需要修改**。未知企业的 `/enterprises/<id>/...` 返回 `404 enterprise_not_found`，不会回落到 `default`。每个企业使用自己的 `sso.signingCert` / `sso.signingKey` 签名。

**会话 cookie**（`src/saml/enterpriseSession.ts`）：会话只保存在签名 cookie 中，服务端不保存状态，所以 SSO 重启后会话仍有效。格式与单企业版的 `cookie-session` 相同（base64 JSON + `.sig` 签名），升级前的会话继续有效。

| 企业 | cookie 名 | path | 签名密钥 |
| --- | --- | --- | --- |
| `default` | `sso_session`、`sso_session.sig` | `/` | `SESSION_SECRET`（`sso.sessionSecret`） |
| 其他企业 | `sso_session_<id>`、`sso_session_<id>.sig` | `/enterprises/<id>` | 该企业的 `sso.sessionSecret` |

- HttpOnly、`SameSite=Lax`、有效期 8 小时；`BASE_URL` 为 https 时带 Secure（TLS 在前置代理终止时也能写入）。用户和 Login 浏览器应通过该 https 地址访问登录页。
- cookie 载荷记录所属企业，跨企业互换或伪造的 cookie 无效；载荷还记录用户的 `created_at`，用户被删除再重建后旧 cookie 自动失效。
- **同源规则**：`POST /login`、`POST /logout`（各企业路径同样适用）拒绝 `Sec-Fetch-Site: cross-site`、`Origin: null`，以及 host 既不是 `BASE_URL` 的 host 也不是请求 Host 头的 `Origin`，返回 `403` 纯文本；没有 `Origin` 头时接受（与单企业版相同）。比较只看 host，不看协议，因此 TLS 在前置代理终止时不受影响。

### 用户管理

- 创建、查询、分页搜索、修改本地 SSO 用户。
- `ensure` 根据 `identity` / `preferredSsoUser` 生成或复用 `ssoUser`；新用户使用 `SSO_DEFAULT_USER_PASSWORD`，未配置时使用 `ssoUser`。
- CSV 导入支持 `ssoUser` 或 `ssoUser,password`；省略密码时只为新用户应用默认密码，已有用户保持不变。
- 删除本地 SSO 用户当前只通过 batch 的 `delete_sso` 操作提供。

#### 密码修改与 Login

SSO 数据库只保存 scrypt 密码哈希和 salt，不能还原用户的明文密码。`POST /users/ensure` 处理已有用户时，只会依次验证当前 `SSO_DEFAULT_USER_PASSWORD` 和该用户的 `ssoUser`；匹配时才返回 `passwordForLogin`。因此，通过 Console、`PATCH /users/:ssoUser` 或 CSV 导入将密码修改为其他值后，SSO 仍可使用新密码完成 SAML 登录，但不能把该密码自动提供给 Login，未知 identity 的自动初始化会因缺少密码而失败。管理员需要在 Console 的 **Reauthorize Copilot OAuth** 中重新输入新密码。

### SCIM / EMU

- `sync_emu`：将本地 `ssoUser` 同步到 GitHub SCIM，保存 `ghScimId`、`ghLogin`，并标记 `emuStatus=active`。
- enterprise role 可由请求显式传入；未传时本地 `role=admin` 映射为 `enterprise_owner`，其他映射为 `user`。
- `suspend_emu`：PATCH SCIM user 的 `active=false`，并标记 `emuStatus=suspended`。
- `delete_emu`：移除 Copilot seat、删除 SCIM user，并将本地 EMU 信息重置为 `not_synced`。
- 反向导入：从 SCIM 拉取用户并完整分页读取 Enterprise Copilot seats 生成 preview plan，apply 时同步本地身份映射、企业直接席位状态和待取消日期。组织或团队来源不计入直接席位。
- SCIM 请求支持节流和对 `429`、`5xx`、带 `retry-after` 的 `403` 重试。

### Copilot seats 与 AI Credits

- `sync_emu` 默认只同步 GH login；请求显式传入 `assignCopilotSeat=true` 时才会继续尝试分配 Copilot seat。
- 可单独调用 assign/remove seat API；变更受理后通过企业级 `GET /enterprises/{enterprise}/members/{username}/copilot` 回读 `{ total_seats, seats }` 确认状态。
- 正常状态为 `assigned`、`pending_cancellation`、`unassigned`。取消接口只返回 `seats_cancelled` 数量，不代表立即失去权限；待取消日期来自 GH 的 `pending_cancellation_date`，保存为 `copilotSeatPendingCancellationDate`（`YYYY-MM-DD`），Console 显示 `cancell at <日期>`。不推算下个月 1 号、不进行本地时区换算。
- 这里只跟踪**企业直接分配**的席位：排除有 `organization` 或 `assigning_team` 来源的记录。因此 `unassigned` 不代表账号不能通过组织或团队使用 Copilot。
- 到期后保持最后确认状态；使用 **Import from GH** 或再次 **Remove seat** 确认未分配后，才写 `unassigned` 并清除日期。没有按时钟自动失效或后台对账。**Assign seat** 确认恢复后写 `assigned` 并清除日期。
- seat 状态写入 `sso_users.copilot_seat_*`。失败保留已有的 assigned/pending_cancellation/unassigned 快照并记录错误；尚无已确认状态时，变更失败记录 `assign_failed` / `remove_failed`。变更已受理但回读失败时，保留状态、日期和上次成功同步时间，API/批量结果明确报告“请求已受理、同步失败”；不会猜日期或返回虚假的成功。
- Import from GH 的预览、存储行、分页结果及 apply 都携带状态与日期；仅日期变化也会更新。Apply 使用**预览时快照**，席位变更后需重新 Preview；查询失败不会生成全员未分配的计划。
- AI Credits 刷新会查询 GitHub billing usage summary，固定使用 `sku=copilot_ai_unit`，缓存上月和本月用量。
- seat 月成本固定按 `19 * assignedSeatCount` 估算；数量包含最后同步的 assigned 和 pending_cancellation 直接席位，即使日期已过也要确认未分配后才扣除。这是可能滞后的本地估算，不是 GitHub 账单。

升级时 SQLite 自动为用户与导入行增加 `copilot_seat_pending_cancellation_date`。旧的未应用预览会标为 conflict，要求重新 Preview；已应用历史保留。升级后应重新执行一次全量 Import from GH 校正旧二态数据，不通过数据库迁移猜测旧 `unassigned` 是否实际待取消。

仅 Remove seat 不删除 SSO/GH/Proxy 记录或作废 OAuth token；删除/暂停 GH 用户仍有其独立的权限影响。Proxy 未知 identity 初始化继续按原逻辑显式分配席位，因此仍可能恢复待取消的直接席位，本次不增加阻止该行为的策略。

### 与 proxy 的边界

SSO 与 proxy 的代码级关系：

1. 内部服务可调用 `POST /api/enterprises/:enterpriseId/users/ensure` 获取或创建该企业的 `ssoUser`。
2. `delete_sso` 删除时调用 `DELETE {PROXY_BASE_URL}/internal/enterprises/:enterpriseId/accounts/by-sso-user/:ssoUser`，并携带同一个 `X-Internal-Token`；只删除同一企业的 proxy 账号。
3. `delete_sso`、`delete_emu`、`suspend_emu`、`remove_copilot`（含单独 seat DELETE API）在任何 seat、SCIM、proxy 删除或本地修改之前，先检查本地 pool 标记；未标记用户必须调用只读 `GET {PROXY_BASE_URL}/internal/enterprises/:enterpriseId/accounts/by-sso-user/:ssoUser/pool-membership`（`ssoUser` 只在企业内唯一，因此必须带企业），使用同一个 `X-Internal-Token`，要求成功 JSON 响应 `{ "managed": boolean }`。`managed=true` 返回安全错误 `pool_member_managed`。此查询覆盖旧版本创建但尚无本地标记的 pool 用户；它不会自动收编或修改用户。

**可用性约束**：上述破坏性操作对未标记的普通用户也必须做 proxy 预检；proxy 不可用、超时、404 或响应格式不正确时，以 `pool_membership_unavailable` 拒绝操作，绝不先删除 seat 再依赖 proxy 外键拦截。单独 seat API 分别返回 409 / 503；batch 保持现有 200 响应并在失败行 `detail` 中返回安全错误代码。上线前先部署 proxy 查询接口。

#### Pool 管理用户

- 内部 `POST /api/enterprises/:enterpriseId/users` 可选 `poolManaged: true`。创建前要求环境配置 `SSO_DEFAULT_USER_PASSWORD` 去除首尾空白后至少 16 字符，且不能等于用户名（忽略大小写）；只使用该配置密码，不接受不同的自定义密码，角色必须为 `user`。未配置/弱密码返回 `400 pool_password_policy`，不会创建用户或标记。省略该标志或传 `false` 保持普通创建的原有密码策略。
- 用户与 `sso_pool_managed_users`（主键 `(enterprise_id, sso_user)`，复合外键指向 `sso_users`，`ON DELETE RESTRICT`）标记在同一 SQLite 事务内创建。migration 不标记或修改旧用户。标记不进入普通用户 DTO，普通创建/查询也不返回密码或 token。
- 本地标记在 proxy 无连接或 provisioning 尚未创建 pool membership 时仍生效。对已标记用户，密码/email/role PATCH、CSV 密码更新、EMU 反向导入的本地身份更新也会拒绝，避免破坏 worker 的身份所有权。标记不能通过普通 PATCH 移除。
- **有意限定**：本地 PATCH/CSV 更新只检查本地标记，不对所有普通编辑增加跨服务依赖。因此无标记的历史 pool 用户仍需单独核对并回填本地所有权标记，才能保护其本地编辑；其破坏性操作已由只读 proxy 预检保护。该预检不是跨服务事务，不能代替 proxy 侧自身的成员删除保护。

当前未提供：SSO 侧没有主动同步 proxy 中已存在账号的 `ghLogin`。

## 3. 启动方式

所有命令从仓库根目录执行。

### 开发运行

```bash
npm install
npm --workspace @ghcp/shared run build
npm run start:sso
```

`start:sso` 实际执行 `npm --workspace @ghcp/sso run start`，而 SSO 的 `start` 脚本是 `tsx src/index.ts`。默认监听 `http://localhost:7001`。

建议先根据 `src/sso/.env.example` 配置环境变量。`default` 企业的 SAML 从 `CERT_DIR` 读取 `idp-cert.pem` 和 `idp-key.pem`（其他企业为 registry 的 `sso.signingCert` / `sso.signingKey`）。多企业版在用到时才读取证书：缺失时服务仍会启动，但该企业的 SAML 路由无法工作，readiness 显示 `enterprise_secret_unconfigured` 阻塞项。

### 本地构建/检查

```bash
npm --workspace @ghcp/sso run typecheck
npm --workspace @ghcp/sso run build
```

`@ghcp/sso` 提供 `start`、`start:prod`、`typecheck`、`build` 和 `test` 脚本。

### Docker

镜像统一由 `deploy/images/Dockerfile.release` 构建（多阶段：运行层只含本服务和 shared 的编译产物及生产依赖；Tini 作为 PID 1 转发 SIGTERM，工作目录 `/app/src/sso`，启动命令 `node dist/index.js`）。从仓库根目录构建：

```bash
docker build -f deploy/images/Dockerfile.release --target sso -t ghcp-sso .
docker run --rm -p 7001:7001 --env-file src/sso/.env.example ghcp-sso
```

真实运行时请替换示例密钥，并挂载/设置 `DB_PATH`、`CERT_DIR` 指向可写数据库目录和证书目录。Dockerfile 本身未声明 `EXPOSE`/`HEALTHCHECK`；仓库根 `docker-compose.yml` 已配置端口、卷、依赖和健康检查。

## 4. 配置参数

`src/sso/src/config.ts` 使用 `dotenv/config` 读取环境变量；`.env.example` 是示例值，不代表生产可用值。

`MOCK_GITHUB_BASE_URL` 仍用于本地 fallback，并未废弃；示例已显式设置 `SCIM_BASE_URL` 和 `SP_ACS_URL`，因此将它列为注释可选项。

| 变量 | 默认值 | 何时必填 | 用途/关系 |
|---|---:|---|---|
| `PORT` | `7001` | 否 | Express 监听端口。 |
| `LOG_LEVEL` | `info` | 否 | 由 shared logger 读取：`debug` / `info` / `warn` / `error`。 |
| `DB_PATH` | `./data/sso.sqlite` | 否 | SQLite 文件路径；启动时自动建目录、执行 migration。 |
| `INTERNAL_API_TOKEN` | 空字符串 | `/api` 必填 | `/api` 认证令牌；为空时所有内部 API 都会返回 401。也用于调用 proxy。 |
| `BASE_URL` | `http://localhost:7001` | SAML 正确对外访问时必填 | 生成 IdP metadata 中的 entityID、SSO URL、Logout URL（其他企业在其后加 `/enterprises/<id>`）；同时决定会话 cookie 是否带 Secure，以及登录/登出表单的同源判断。 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 删除 SSO 用户并清理 proxy 时必填 | `delete_sso` 时回调 proxy 内部删除接口。 |
| `MOCK_GITHUB_BASE_URL` | `http://localhost:8002` | 本地/mock 场景 | `SCIM_BASE_URL` 为空时作为 SCIM fallback；`SP_ACS_URL` 为空时作为 mock ACS fallback。 |
| `SESSION_SECRET` | `dev-secret-change-me` | 真实环境必填 | `default` 企业 SAML 会话 cookie（`sso_session`）的签名密钥；其他企业使用 registry 的 `sso.sessionSecret`。 |
| `SSO_DEFAULT_USER_PASSWORD` | 未设置 | 否 | `default` 企业新用户默认密码；未设置时使用 `ssoUser`。只从环境变量读取，不进入 DB 或 Console。其他企业使用 registry 的 `sso.defaultUserPassword`，规则相同。 |
| `SSO_USER_EVENTS_LOG` | `./data/sso-user-events.log` | 否 | 追加写入部分用户事件。`default` 写该文件；其他企业写 `<同目录>/<enterpriseId>/<同文件名>`。 |
| `ENTERPRISE_SLUG` | `acme` | GitHub/SCIM/Copilot 场景必填 | `default` 企业的 GitHub Enterprise slug；用于 SCIM fallback、Copilot seat、AI Credits、默认 SP entityID。 |
| `ENTERPRISE_SHORTCODE` | `octo` | GitHub.com GH login fallback 时必填 | `default` 企业的 shortcode（自动转小写）。SCIM 响应无 `githubLogin` 时生成 `<normalized>_<shortcode>`（总长 ≤39）；`ensure` 也会剥离该后缀。GHE.com 模式（`GITHUB_BASE_URL` 为 `*.ghe.com`）下忽略：shortcode 被隐藏，GHE.com API 拒绝带后缀的用户名，GH login 直接为 `<normalized>`（≤30 字符）。 |
| `GITHUB_BASE_URL` | `https://github.com` | GHE.com 必填 | `default` 企业的 GitHub Web origin；host 以 `.ghe.com` 结尾时为 GHE.com 模式（忽略 `ENTERPRISE_SHORTCODE`）。也用于 `SP_ENTITY_ID` 的兜底值。 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | Copilot/API 调用时 | `default` 企业 Copilot seat 和 AI Credits 的 GitHub API 根地址；GHE.com 为 `https://api.<sub>.ghe.com`，未设置时由 `GITHUB_BASE_URL` 推导；显式设置时必须属于同一个 `<sub>.ghe.com`，否则启动失败。 |
| `GITHUB_COPILOT_SEAT_PAT` | 未设置 | Copilot seat / AI Credits 必填 | `default` 企业的 Bearer token；代码不在启动时强校验，调用相关功能时校验。 |
| `SCIM_BASE_URL` | 空字符串 | 真实 SCIM 必填 | `default` 企业的 GitHub SCIM base URL；为空时使用 `MOCK_GITHUB_BASE_URL/scim/v2/enterprises/{ENTERPRISE_SLUG}`。GHE.com 为 `https://api.<sub>.ghe.com/scim/v2/enterprises/<slug>`。 |
| `SCIM_TOKEN` | 空字符串 | SCIM 调用必填 | `default` 企业的 SCIM Bearer token；代码不在启动时强校验。 |
| `CERT_DIR` | `../../certs` | SAML 必填 | `default` 企业的签名证书目录，必须有 `idp-cert.pem`、`idp-key.pem`。`.env.example` 示例为 `../../certs`。其他企业使用 registry 的 `sso.signingCert` / `sso.signingKey`。 |
| `SP_ENTITY_ID` | 空字符串 | 真实 GitHub SAML 建议配置 | `default` 企业的 SP entityID；为空时 fallback 为 `{GITHUB_BASE_URL}/enterprises/{ENTERPRISE_SLUG}`。GHE.com 为 `https://<sub>.ghe.com/enterprises/<slug>`。 |
| `SP_ACS_URL` | 空字符串 | 真实 GitHub SAML 必填 | `default` 企业的 ACS；为空时 fallback 到 mock GitHub ACS。GHE.com 为 `https://<sub>.ghe.com/enterprises/<slug>/saml/consume`。 |
| `ENTERPRISE_REGISTRY_FILE` | 未设置 | 添加企业时 | 多企业版新增。企业 registry 的绝对路径（容器内，只读挂载），必须与 Proxy、Login 使用同一份文件。未设置时只有 `default`。修改后需重启。 |

用户上限、用户名 fallback、默认邮箱域、SCIM 限流/重试和 `sync_emu` 并发保存在 `sso_runtime_settings`，**每个企业一行**，通过 Console Settings 页面（按页头选择的企业）保存后对下一次操作生效。

### `.env` 与 runtime Settings

环境变量负责端口、内部密钥、服务/GitHub/SCIM 地址、PAT、SAML 证书、SQLite/事件日志路径和默认密码等部署配置，启动时读取，修改后要重启 SSO。Runtime Settings 保存在 `sso.sqlite`，通过 Console **Settings** 或 `GET/PATCH /api/enterprises/:enterpriseId/settings/runtime` 管理，按企业分别保存，无需重启。

| Setting | 默认值 | 合法范围 | 生效语义 |
| --- | ---: | --- | --- |
| `maxSsoUsers` | `null` | `null` 或整数 `1..1000000` | 限制 SSO 用户总数；`null` 不限。创建、ensure、CSV 导入和导入计划 apply 都受限，降低上限不会删除现有用户。 |
| `userPrefix` | `user` | 规范化后必须含字母或数字，最长 32 字符 | identity 不能生成可用用户名或最终碰撞 fallback 时使用；不重命名现有用户。 |
| `emailDomain` | `customsso.com` | 合法 hostname | 新用户未显式提供 email，以及 EMU 导入缺少主 email 时使用；不修改现有 email。 |
| `bulkSyncConcurrency` | `3` | 整数 `1..20` | 新 `sync_emu` 批处理的并发；其他批处理保持串行。 |
| `scimRequestDelayMs` | `250` | 整数 `0..60000` | 当前 SSO 进程内 SCIM 请求之间的最小间隔。 |
| `scimMaxRetries` | `3` | 整数 `0..10` | 可重试响应/网络错误的最大重试次数；`0` 表示不重试。 |
| `scimRetryBaseDelayMs` | `1000` | 整数 `0..60000` | SCIM 指数退避基础延迟；响应 `Retry-After` 可决定更长等待。 |

Settings 更新使用 `expectedVersion` 乐观锁；版本落后返回 `409 settings_version_conflict`。首次 migration 使用上表代码默认值，不读取旧 `.env`；升级前的设置归入 `default`。新增企业首次创建设置行时，`emailDomain`、`userPrefix` 可由 registry 的 `sso.emailDomain`、`sso.userPrefix` 提供初值，之后在 Console 修改。`SSO_DEFAULT_USER_PASSWORD` 始终是 env-only：它是敏感启动配置，不会显示或保存到 Settings。

Runtime settings snapshot 当前缓存在进程内；多个 SSO 实例共享同一 SQLite 时，其他实例不会自动收到某一实例保存的设置，需要额外的跨进程失效机制或重启。

## 5. 接口与 API 边界

### 认证规则

- `/healthz` 和各企业的 SAML 路由（`/metadata`、`/sso`、`/login`、`/logout` 及 `/enterprises/<id>/...` 下的同名路由）不需要 `X-Internal-Token`。
- 所有 `/api/*`、`/internal/*` 路由都需要请求头：`X-Internal-Token: <INTERNAL_API_TOKEN>`。
- 管理与服务间接口全部按企业作用域：`/api/enterprises/:enterpriseId/...`、`/internal/enterprises/:enterpriseId/...`。无作用域的旧路径（例如 `/api/users`、`/api/settings/runtime`、`/internal/users/:ssoUser/login-credentials`）返回 `400 enterprise_scope_required`，不会回落到 `default`。`:enterpriseId` 格式不合法返回 `400 invalid_enterprise_id`，未知企业返回 `404 enterprise_not_found`；header、query 或 body 中的 `enterpriseId` 与路径不一致返回 `400 enterprise_scope_conflict`。作用域内未实现的路径返回 `404 not_found`。
- JSON 错误响应统一为 `{ "error": { "code": string, "message": string, ... } }`。
- JSON body 限制为 `5mb`；URL encoded body 限制为 `1mb`。

### 公开/SAML 路由

下表中 `{s}` 对 `default` 为空（根路径），对其他企业为 `/enterprises/<id>`。

| 方法 | 路径 | 认证 | 请求核心 | 响应核心 |
|---|---|---|---|---|
| `GET` | `/healthz` | 无 | 无 | `{ status: "ok", service: "sso", releaseLine }`；多企业版镜像 `releaseLine` 为 `"multi"` |
| `GET` | `{s}/metadata` | 无 | 无 | 该企业的 SAML IdP metadata XML |
| `GET` | `{s}/sso` | 该企业的会话 cookie | `SAMLRequest?`, `RelayState?` query | 未登录跳 `{s}/login`；已登录返回自动提交到 ACS 的 HTML；AuthnRequest 无效返回 400 纯文本 |
| `GET` | `{s}/login` | 无 | 无 | HTML 登录表单 |
| `POST` | `{s}/login` | 同源检查 | form: `username`, `password` | 登录失败 401 HTML；跨站请求 403；成功后返回 SAML POST HTML 或登录状态 HTML |
| `POST` | `{s}/logout` | 同源检查 | 无 | 清除该企业的会话 cookie，重定向 `{s}/login`；跨站请求 403 |

### 用户与 EMU API

下表路径均以 `/api/enterprises/:enterpriseId` 为前缀，只读写该企业的用户。

| 方法 | 路径 | 请求核心 | 响应核心 |
|---|---|---|---|
| `POST` | `/users/ensure` | `{ identity, preferredSsoUser? }` | `EnsureSsoUserResponse`：`{ user, passwordForLogin?, created }` |
| `GET` | `/settings/runtime` | 无 | `SsoRuntimeSettingsDto`，包含设置、`version`、`updatedAt`。 |
| `PATCH` | `/settings/runtime` | `{ expectedVersion, changes }` | 保存 runtime settings；校验失败返回 400，版本冲突返回 409。 |
| `GET` | `/users/capacity` | 无 | `{ current, limit, remaining, reached }`。 |
| `GET` | `/users` | query: `q?`, `page?`, `pageSize?`, `sort?`, `dir?` | `PageResponse<SsoUserDto>` |
| `POST` | `/users` | `{ ssoUser, password?, email?, role? }` | `201 SsoUserDto` |
| `POST` | `/users/import` | `{ csvText }` | `BatchResult<{ line, ssoUser, status, detail }>` |
| `POST` | `/users/batch` | `{ operation, ssoUsers, enterpriseRole? }` | `BatchResult<SsoUserBatchRow>` |
| `POST` | `/users/emu/import` | `{ ssoUser?, dryRun? }` | `BatchResult<ImportEmuUserRow>` |
| `POST` | `/users/emu/import/plans` | `{ ssoUser? }` | `ImportEmuPlanDto` |
| `GET` | `/users/emu/import/plans/:planId` | path: `planId` | `ImportEmuPlanDto` |
| `GET` | `/users/emu/import/plans/:planId/rows` | query: `status?`, `page?`, `pageSize?` | `PageResponse<ImportEmuUserRow>` |
| `POST` | `/users/emu/import/plans/:planId/apply` | path: `planId` | `ImportEmuPlanDto` |
| `DELETE` | `/users/emu/import/plans/:planId` | path: `planId` | `204 No Content` |
| `GET` | `/users/:ssoUser` | path: `ssoUser` | `SsoUserDto` |
| `PATCH` | `/users/:ssoUser` | `{ password?, email?, role? }` | `SsoUserDto` |
| `POST` | `/users/:ssoUser/login-credentials` | `{ expectedCreatedAt, expectedEmail }` | 账号池开通时供 Proxy 取 pool 用户的登录密码；用户不符合预期所有权时返回 `409 user_ownership_mismatch`。 |
| `POST` | `/users/:ssoUser/copilot-seat` | path: `ssoUser` | `SsoUserDto` |
| `DELETE` | `/users/:ssoUser/copilot-seat` | path: `ssoUser` | `SsoUserDto` |

`/users/batch.operation` 当前支持：`sync_emu`、`suspend_emu`、`delete_emu`、`delete_sso`、`assign_copilot`、`remove_copilot`。`enterpriseRole` 仅允许 `user` 或 `enterprise_owner`；`assignCopilotSeat` 为可选 boolean，仅用于让 `sync_emu` 在同步成功后继续分配 seat，默认 `false`。

`GET /users` 的 `sort` 当前支持 `ssoUser`、`email`、`role`、`emuStatus`、`createdAt`；`dir` 支持 `asc` / `desc`；`pageSize` 最大 100。

EMU import row 状态当前支持：`pending_create`、`pending_update`、`created`、`updated`、`skipped`、`conflict`、`failed`。

### AI Credits API

路径以 `/api/enterprises/:enterpriseId` 为前缀，查询和缓存按企业分开。

| 方法 | 路径 | 请求核心 | 响应核心 |
|---|---|---|---|
| `GET` | `/ai-credits/usage` | 无 | `AiCreditsUsageDto`；缓存缺失返回 404 |
| `POST` | `/ai-credits/usage/refresh` | 无 | 重新查询 GitHub、写入缓存并返回 `AiCreditsUsageDto` |

### 服务间接口与 readiness

| 方法 | 路径 | 调用方 | 说明 |
|---|---|---|---|
| `POST` | `/internal/enterprises/:enterpriseId/users/:ssoUser/login-credentials` | Proxy（解析默认 SSO 登录密码） | 见文末“异步管理与默认登录凭据”。 |
| `GET` | `/internal/enterprises` | Proxy readiness 探测 | `[{ id, githubBaseUrl, slug, shortcode, configured, blockers }]`。`blockers` 包括 registry 缺失字段（例如 `enterprise_field_missing:github.shortcode`）和读不到的必需 secret（`enterprise_secret_unconfigured:sso.signingCert`、`sso.signingKey`、`sso.sessionSecret`），只给出字段路径，不含值。 |

Proxy 用这些结果判断企业能否激活；Console **Pool overview** 中显示为带 `sso:` 前缀的阻塞项。

### 按企业的外部端点与 secret

| 功能 | 端点 | 凭据 |
|---|---|---|
| SCIM（`src/scim/scimClient.ts`） | 企业的 `sso.scimBaseUrl`，默认 `<apiBaseUrl>/scim/v2/enterprises/<slug>` | `sso.scimToken`（`default`：`SCIM_TOKEN`） |
| Copilot 席位（`src/copilot/seats.ts`） | `<apiBaseUrl>/enterprises/<slug>/...` | `sso.seatPat`（`default`：`GITHUB_COPILOT_SEAT_PAT`） |
| AI Credits（`src/budget/budgetService.ts`） | `<apiBaseUrl>/enterprises/<slug>/settings/billing/...` | `sso.seatPat` |
| SAML 签名 | — | `sso.signingCert`、`sso.signingKey`（`default`：`CERT_DIR` 下的 `idp-cert.pem`、`idp-key.pem`） |

- `apiBaseUrl` 默认：github.com 为 `https://api.github.com`，GHE.com 为 `https://api.<sub>.ghe.com`。SCIM 的速率与退避状态按企业分开。
- GH login 推导使用该企业的 shortcode：github.com 为 `<normalized>_<shortcode>`；GHE.com 企业 shortcode 为空，GH login 为 `<normalized>`（≤30 字符）。
- 某企业缺少 `sso.scimToken` 或 `sso.seatPat` 时，只影响该企业的对应功能，错误信息只给出字段路径（例如 `contoso-ghe.sso.seatPat is not configured.`），不含值。用户 API（`/users...`）把该错误映射为 `503 enterprise_secret_unconfigured`；AI Credits 刷新失败统一返回 `400 ai_credits_refresh_failed`。缺少 `sso.defaultUserPassword` 时与单企业版相同，回退为用户名（账号池模式下创建 pool 用户会被 `pool_password_policy` 拒绝）。

## 6. 数据结构

### SQLite 表

| 表 | 主键/索引 | 主要字段 | 作用 |
|---|---|---|---|
| `schema_migrations` | `id` PK | `applied_at` | 多企业迁移步骤记录；每步单独事务，可重入。 |
| `sso_enterprises` | `id` PK | `profile_fingerprint`, `created_at` | 已登记企业及身份指纹（`{ id, githubBaseUrl, slug, shortcode }`）；企业已有用户后指纹变化即启动失败。 |
| `sso_users` | `(enterprise_id, sso_user)` PK；`(enterprise_id, gh_login)` 索引 | `password_hash`, `salt`, `email`, `role`, `gh_login`, `gh_scim_id`, `emu_status`, `copilot_seat_status`, `copilot_seat_pending_cancellation_date`, `copilot_seat_last_operation`, `copilot_seat_last_error`, `copilot_seat_updated_at`, `created_at`, `updated_at` | 本地 SSO 用户和外部身份映射。 |
| `sso_runtime_settings` | `enterprise_id` PK（升级前的 `id=1` 行归 `default`） | `max_sso_users`, `user_prefix`, `email_domain`, `bulk_sync_concurrency`, SCIM delay/retry 字段、`version`, `updated_at` | 持久化 Console runtime settings 和乐观锁版本。 |
| `sso_budget_cache` | `(enterprise_id, period_key)` PK | `year`, `month`, `quantity`, `unit_type`, `raw_json`, `fetched_at` | AI Credits 月度用量缓存。 |
| `sso_emu_import_plans` | `id` PK | `enterprise_id`, `sso_user`, `status`, `created_at`, `updated_at`, `applied_at` | SCIM 反向导入 preview/apply 计划。 |
| `sso_emu_import_plan_rows` | `(plan_id, row_index)` PK；`(plan_id,status,row_index)` 索引 | `sso_user`, `email`, `gh_login`, `gh_scim_id`, `emu_status`, `copilot_seat_status`, `copilot_seat_pending_cancellation_date`, `status`, `detail`, `action` | 导入计划明细。 |

当前未配置：`gh_login`、`gh_scim_id` 没有数据库唯一索引；重复绑定主要依赖业务逻辑检查。

多企业迁移：升级时 SSO 在启动时自动重建上述表，主键加入 `enterprise_id`，已有行全部归 `default`；`sso_pool_managed_users` 主键为 `(enterprise_id, sso_user)`，`sso_emu_import_plan_rows` 通过 `plan_id` 继承企业。`sso_user` 的大小写比较规则不变。SAML 会话不建表（只在 cookie 中）。

### 主要领域对象

- `SsoUserRecord`：数据库用户记录，等于 `SsoUserDto` 加上 `passwordHash`、`salt`。
- `ScimUserResource`：SCIM 用户资源，包含 `id`、`userName`、`externalId`、`emails`、`roles`、`active`、`githubLogin`。
- `ProvisionResult`：SCIM 同步结果 `{ scimId, ghLogin }`。
- `ImportEmuPlanDto` / `ImportEmuUserRow`：包含 SCIM 身份与 Copilot seat 状态的反向导入计划及行结果。
- `AiCreditsUsageDto`：上月、本月、预计本月用量、已分配 seat 数、seat 月成本。
- `BatchResult<T>` / `PageResponse<T>`：共享的批处理和分页响应壳。

### shared contracts 中本模块使用的类型

来自 `src/packages/shared/src/contracts.ts` 和 `api.ts`：

- `SsoUserDto`
- `EnsureSsoUserResponse`
- `SsoUserBatchRequest`、`SsoUserBatchOperation`、`SsoUserBatchRow`
- `ImportEmuUsersRequest`、`CreateImportEmuPlanRequest`
- `ImportEmuPlanDto`、`ImportEmuPlanSummary`、`ImportEmuUserRow`
- `AiCreditsUsageDto`、`AiCreditsPeriodUsageDto`
- `BatchResult<T>`、`BatchSummary`、`PageResponse<T>`
- `ApiErrorResponse`、`INTERNAL_AUTH_HEADER`（值为 `X-Internal-Token`）

## 7. 代码结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | 入口，只调用 `startServer()`。 |
| `src/server.ts` | 创建 Express app，注册 body parser、各企业 SAML 路由、企业作用域的 `/api`、`/internal` 路由、无作用域 400 和 404。 |
| `src/config.ts` | 服务级环境变量（端口、DB、内部 token、`BASE_URL`、`PROXY_BASE_URL`、事件日志）。 |
| `src/enterprises.ts` | 加载企业 registry（与 env 合并）、按 id 查找企业、读取企业 secret。 |
| `src/routes/enterpriseRoutes.ts` | `/api/enterprises/:id`、`/internal/enterprises/:id` 路由挂载与无作用域拒绝。 |
| `src/routes/enterprisesInternal.ts` | `GET /internal/enterprises` readiness。 |
| `src/saml/enterpriseSession.ts` | 每个企业的签名会话 cookie（兼容单企业版 `sso_session`）。 |
| `src/routes/samlRoutes.ts` | 各企业的 SAML metadata、SSO、登录、登出 HTML 路由及同源检查。 |
| `src/saml/saml.ts` | SAML IdP/SP 配置、证书读取、AuthnRequest 解析、SAMLResponse 构造。 |
| `src/routes/usersApi.ts` | 用户、batch、EMU import、Copilot seat API 参数校验和响应封装。 |
| `src/routes/settingsApi.ts` | Runtime settings 读取、校验、乐观锁更新。 |
| `src/users/service.ts` | 用户生命周期、SCIM 同步、导入计划、batch、proxy 清理的核心业务逻辑。 |
| `src/users/bulkImport.ts` | 简单 CSV 解析，支持 header、去重和错误收集。 |
| `src/scim/scimClient.ts` | SCIM create/update/list/suspend/delete、鉴权、重试、节流。 |
| `src/scim/handle.ts` | 从 `ssoUser` 和 enterprise shortcode 推导 GH login；GHE.com 模式下不带后缀。 |
| `src/copilot/seats.ts` | GitHub Copilot selected users assign/remove，以及 Enterprise seat 列表分页查询。 |
| `src/budget/budgetService.ts` | AI Credits usage 查询、缓存和投影计算。 |
| `src/routes/budgetApi.ts` | AI Credits cache 读取/刷新 API。 |
| `src/db/*` | SQLite 连接、migration、用户/settings repo、预算 cache repo、导入计划 repo、事件日志。 |
| `src/auth/*` | 内部 token middleware、scrypt 密码哈希和校验。 |
| `src/clients/proxyClient.ts` | 调用 proxy 带企业作用域的内部接口：删除清理和 pool-membership 预检。 |

## 8. 开发提示

- 新人定位入口：`src/index.ts` → `src/server.ts` → 对应 `routes/*` → `users/service.ts` → `db/*` 或外部 client。
- 新增内部 API：放到 `routes/enterpriseRoutes.ts` 挂载的企业作用域 router（会经过 `requireInternalToken` 和 `requireEnterprise`），处理函数用 `requestEnterprise(res)` 取企业，repository 函数以企业 ID 为第一个参数；如需新 DTO，同步更新 shared contracts。
- 新增公开 SAML 行为：从 `routes/samlRoutes.ts` 和 `saml/saml.ts` 开始，注意每个企业的会话 cookie（`saml/enterpriseSession.ts`）与证书读取。
- 修改 SQLite 结构：更新 `db/migrations.ts`，同时更新对应 repo 的 row mapper 和 shared DTO。
- 调试 SCIM：设置 `LOG_LEVEL=debug`，并在 Console Settings 中检查 SCIM delay、max retries 和 retry base delay。
- 调试 Copilot/AI Credits：确认 `GITHUB_COPILOT_SEAT_PAT`、`GITHUB_API_BASE_URL`、`ENTERPRISE_SLUG`（其他企业为 registry 的 `sso.seatPat`、`github.apiBaseUrl`、`github.slug`）；相关功能调用时才会校验 PAT。
- 调试 SAML：确认 `BASE_URL`、`SP_ENTITY_ID`、`SP_ACS_URL`、`CERT_DIR`（其他企业为 registry 的 `sso.*`）；启动日志会打印每个企业的 metadata 地址，SP 地址缺失时打印 `SAML is not configured`；证书、私钥或 session secret 读不到时，该企业在 readiness 中显示 `enterprise_secret_unconfigured:sso.*` 阻塞项。
- 调试企业：`GET /internal/enterprises`（需内部 token）查看每个企业的 `blockers`。
- `sync_emu` 批量操作使用 Console Settings 中的并发值，其他破坏性批量操作保持串行。

## 异步管理与默认登录凭据

Users 查询支持 `status`（EMU 状态）、`role`、`seatStatus`、更新时间 `from/to` 和稳定排序；`GET /api/enterprises/:enterpriseId/users/summary` 返回该企业全部保留用户的真实聚合。`GET /api/enterprises/:enterpriseId/users/export` 导出一致快照的全部匹配项，`scope=page` 导出当前页；POST 同一路径传 `{ selection }` 导出至多 1000 个已选目标。

`/api/enterprises/:enterpriseId/users/operations` 提供 `POST /preview`、`POST /:id/execute`、`GET /:id` 和 `GET /:id/export`。选择可以是 `{ ids }` 或 `{ query, excludedIds }`；每批至多 1000，预览冻结目标并在 10 分钟后过期，执行时重新校验。预览与结果只保存在 SSO 进程内存中（结果在结束后保留约 1 小时），重复确认同一预览返回当前状态而不会再执行；浏览器关闭不停止已接受的工作，进程重启后批次状态丢失、不自动重放，以用户列表为准。业务仍复用 `runSsoUserBatch`，`sync_emu` 保留 runtime 并发与 SCIM 节流/重试，删除等操作保持串行和既有级联顺序。同步的 `POST /api/enterprises/:enterpriseId/users/batch` 保持兼容。

`POST /internal/enterprises/:enterpriseId/users/:ssoUser/login-credentials` 只允许携带内部认证的服务调用，使用 `Cache-Control: no-store`。它沿用既有默认密码候选策略，只验证现有用户的摘要，不创建用户、不重置密码；已改密或未知默认值返回 `409 password_override_required`。摘要校验在工作线程池异步执行，整个进程（所有企业合计）最多同时处理 4 个请求，繁忙时返回 `429 default_credentials_busy` 和 `Retry-After: 1`，不会无界排队阻塞普通 API。密码只向协调登录的 Proxy 返回，不进入 Console 转发路径、批次数据或导出。
