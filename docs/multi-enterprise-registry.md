# 多企业 registry 配置参考

适用于多企业版本线（镜像 tag `multi-*`，`/healthz` 返回 `"releaseLine": "multi"`）。升级步骤见 [多企业版升级指南](multi-enterprise-upgrade-guide.md)；设计依据见 [设计文档](multi-enterprise-design.md) §3。

## 1. 概念

| 名称 | 含义 |
| --- | --- |
| registry | 一个 JSON 文件，列出部署管理的所有 GitHub 企业。路径由 `ENTERPRISE_REGISTRY_FILE` 指定（容器内绝对路径），**只读挂载到 Proxy、SSO、Login 三个服务**。Console 不读它，企业列表从 Proxy 获取。 |
| `enterpriseId` | 部署内部的企业 ID，格式 `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`。出现在 URL、cookie 名和数据库中，**创建后不能修改**。它不是 GitHub 的 slug。 |
| `default` 企业 | 保留 ID，即升级前的那个企业，所有旧数据都归它。没有 registry 时完全由现有环境变量合成。 |

- **不需要多个企业时不要配置 registry**：升级后由环境变量合成 `default`，行为与单企业版相同。
- 每个服务在**启动时**读取一次并严格校验整个文件（三方解析结果一致），**不支持热加载**。修改文件后需重启 Proxy、SSO、Login。
- 文件中**不能写 secret 的值**，只能写引用（第 4 节）。所以 registry 本身可以放在 ConfigMap 里，secret 放在 Secret 中单独挂载。

## 2. 文件格式

```json
{
  "version": 1,
  "enterprises": [
    { "id": "default", "github": { "baseUrl": "https://github.com", "slug": "fabrikam", "shortcode": "fab" } },
    { "id": "contoso-ghe", "github": { "baseUrl": "https://contoso.ghe.com", "slug": "contoso" }, "...": "..." }
  ]
}
```

- 顶层只允许 `version`（固定为 `1`）和 `enterprises`（1–32 项）。**任何未知字段都会导致启动失败**；JSON 不支持注释。
- 完整示例：[`deploy/enterprise-registry.example.json`](../deploy/enterprise-registry.example.json)（一个 github.com 的 `default` 加一个 GHE.com 企业，全部为占位值）。仓库测试会用共享解析器加载这个示例。
- 校验失败时服务不启动，错误码为 `enterprise_registry_invalid`，消息给出字段路径（例如 `contoso-ghe.github.shortcode must be empty on GHE.com.`），不包含任何 secret 值。

## 3. 字段

“阻塞项”表示字段缺失时服务仍会启动，但该企业**未就绪**（第 6 节），不能被激活或补货。

| 字段 | 必填 | 默认值 / 规则 | 使用方 |
| --- | --- | --- | --- |
| `id` | 是 | 见第 1 节 | 全部 |
| `displayName` | 否 | `id` | Console |
| `github.baseUrl` | 是 | 只能是 origin（`https://github.com` 或 `https://<子域>.ghe.com`），不能带路径 | 全部 |
| `github.apiBaseUrl` | 否 | github.com → `https://api.github.com`；GHE.com → `https://api.<子域>.ghe.com`。可带路径（例如经网关） | SSO（SCIM、席位、预算），Proxy（`/user` 校验、Models） |
| `github.copilotApiBaseUrl` | 否 | github.com → `https://api.githubcopilot.com`；GHE.com → `https://copilot-api.<子域>.ghe.com` | Proxy |
| `github.slug` | SSO 必填；GHE.com 时 Login 也必填（阻塞项） | 同一 GitHub 实例内不能重复（不区分大小写） | SSO、Login |
| `github.shortcode` | github.com 必填（Proxy、SSO 阻塞项）；GHE.com 必须为 `""` 或省略 | 3–8 位小写字母数字（自动转小写） | SSO、Proxy |
| `github.oauthClientId` | 否 | 环境变量 `GITHUB_OAUTH_CLIENT_ID`，未设置时为内置的 OpenCode client ID | Login 设备授权 |
| `sso.spEntityId` / `sso.spAcsUrl` | 否 | `<baseUrl>/enterprises/<slug>`、`<baseUrl>/enterprises/<slug>/saml/consume` | SSO |
| `sso.scimBaseUrl` | 否 | `<apiBaseUrl>/scim/v2/enterprises/<slug>` | SSO |
| `sso.emailDomain` / `sso.userPrefix` | 否 | 只在首次创建该企业的 SSO 运行时设置时作为初值，之后在 Console 的 SSO 设置中修改 | SSO |
| `sso.signingCert` / `sso.signingKey` / `sso.sessionSecret` | 是（阻塞项） | secret 引用；文件不存在或为空也是阻塞项 | SSO |
| `sso.scimToken` / `sso.seatPat` / `sso.defaultUserPassword` | 否 | secret 引用。缺失时相关操作对该企业返回 503 `enterprise_secret_unconfigured` | SSO |
| `login.ssoProvider` | 否 | `custom` 或 `azure`。不设置：每个登录任务自行选择（与单企业版相同）；设置后任务必须一致 | Login |
| `login.ssoLoginUrl` | 否 | `default` 取 `SSO_URL`；其他企业取 `<SSO_URL 的 origin>/enterprises/<id>/login`。`custom` 类型缺失时为阻塞项；query 和 fragment 会被去掉 | Login |
| `login.allowedLoginUrls` | 否 | `[ssoLoginUrl]`；1–16 项，必须包含 `ssoLoginUrl`。浏览器只在 origin 相同、路径按整段前缀匹配的页面填写 SSO 凭据（`/login` 不匹配 `/loginfoo`） | Login |
| `login.selectors.<名称>` | 否 | 对应的全局 `AUTH_*_SELECTOR`（例如 `ssoUsernameInput` ↔ `AUTH_SSO_USERNAME_INPUT_SELECTOR`） | Login |
| `pool.accountDomain` | 账号池模式必填（Proxy 阻塞项） | 池账号邮箱域名；不同企业不能重复 | Proxy |
| `pool.initialMaxAccounts` | 否 | `default` 取 `POOL_MAX_ACCOUNTS`（账号池模式）或 100；其他企业为 10。**只在 Proxy 首次登记该企业时使用**，之后在 Console 修改 cap | Proxy |
| `modelsAdmin.githubLogin` / `githubUserId` / `copilotToken` | 否 | 该企业 Models 页使用的管理员（含义同 [Models 使用指南](models-admin-guide.md)）。未配置时 Models 页显示 `models_admin_not_configured`，不会回退到池账号 | Proxy |

全局规则：

- 唯一：`id`、同一 `baseUrl` 下的 `slug`、`pool.accountDomain`、`login.ssoLoginUrl`。
- URL 只接受 http/https，拒绝 userinfo、query、fragment、反斜杠、编码的 `.`/`/`/`\` 和 `.`、`..` 路径段（`login.*` 的 query、fragment 被去掉而不是拒绝）。
- GHE.com（`baseUrl` 主机以 `.ghe.com` 结尾）：`shortcode` 为空，`apiBaseUrl` 和 `copilotApiBaseUrl` 必须属于同一个 `<子域>.ghe.com`。SSO 生成的 GitHub 登录名不带后缀，最长 30 个字符。
- 容量：所有企业的 `initialMaxAccounts` 之和、以及运行时所有 cap 之和都不能超过 10,000（全部企业共用一个账号名目录）。

## 4. Secret 引用

| 格式 | 说明 |
| --- | --- |
| `{ "env": "NAME" }` | 读取该服务的环境变量。`NAME` 匹配 `^[A-Z][A-Z0-9_]{0,127}$`。修改需重启。 |
| `{ "file": "/abs/path" }` | 读取容器内的绝对路径。使用时读取并缓存 60 秒，**轮换挂载的 Secret 不需要重启**。 |

- 内容最大 128 KiB，不允许 NUL 字节，只去掉一个结尾换行；空文件视为未配置。
- 只在需要它的服务中、需要时才读取。某个企业缺少 secret 只影响该企业，不影响其他企业和服务启动。
- 日志、接口和错误消息中只出现字段路径（例如 `contoso-ghe.sso.scimToken`），不出现值或来源。
- 文件路径是**容器内**路径。示例约定 `/run/secrets/<enterpriseId>/<名称>`：Compose 用 `docker-compose.enterprise-registry.yml` 把主机目录 `ENTERPRISE_SECRETS_DIR` 挂到 `/run/secrets`；Kubernetes 用每个企业一个 Secret 卷。SSO 需要 `sso.*` 的文件，Proxy 需要 `modelsAdmin.copilotToken` 的文件，Login 不读 secret。

## 5. `default` 企业与环境变量

| 情况 | `default` 的来源 |
| --- | --- |
| 没有 registry 文件 | 完全由各服务现有的环境变量合成，零配置变更。 |
| 有 registry，但没有 `default` 条目（**推荐**） | 仍由环境变量合成；文件只列出新增的企业。 |
| 有 registry，且有 `default` 条目 | 文件条目与环境变量合并。同一字段两边都有值且不相同 → **启动失败** `enterprise_env_conflict`；缺少的必填字段 → 阻塞项。 |

例外：GHE.com 下 `ENTERPRISE_SHORTCODE` 被忽略（启动日志打印一次 warning），不算冲突。空字符串视为未设置。

各服务读取的环境变量（只列企业相关的；`PORT`、`DB_PATH`、`INTERNAL_API_TOKEN`、`BASE_URL` 等服务级变量不变）：

| 服务 | 环境变量 → `default` 字段 |
| --- | --- |
| Proxy | `GITHUB_BASE_URL`→`github.baseUrl`；`GITHUB_API_BASE_URL`→`github.apiBaseUrl`；`COPILOT_API_BASE_URL`→`github.copilotApiBaseUrl`；`ENTERPRISE_SHORTCODE`→`github.shortcode`；`MODELS_ADMIN_GITHUB_LOGIN` / `_GITHUB_USER_ID`→`modelsAdmin.*`；`MODELS_ADMIN_COPILOT_TOKEN_FILE`→`modelsAdmin.copilotToken={file}`（优先），否则 `MODELS_ADMIN_COPILOT_TOKEN`→`{env}`。仅账号池模式：`POOL_ACCOUNT_EMAIL_DOMAIN`→`pool.accountDomain`，`POOL_MAX_ACCOUNTS`→`pool.initialMaxAccounts` |
| SSO | `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`→`github.*`；`SP_ENTITY_ID`、`SP_ACS_URL`、`SCIM_BASE_URL`→`sso.*`；`SCIM_TOKEN`、`GITHUB_COPILOT_SEAT_PAT`、`SESSION_SECRET`、`SSO_DEFAULT_USER_PASSWORD`→`sso.scimToken` / `seatPat` / `sessionSecret` / `defaultUserPassword`（均为 `{env}` 引用）；`CERT_DIR`→`sso.signingCert/Key={file: <CERT_DIR>/idp-cert.pem、idp-key.pem}` |
| Login | `GITHUB_BASE_URL`、`ENTERPRISE_SLUG`→`github.*`；`GITHUB_OAUTH_CLIENT_ID`→`github.oauthClientId`；`SSO_URL`→`login.ssoLoginUrl`；`AUTH_*_SELECTOR`→`login.selectors.*` |

在 registry 中写 `default` 时：

1. 文件里写了的字段，对应环境变量**留空**或**与文件相同**。仓库的 `docker-compose.yml` 已把 `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`COPILOT_API_BASE_URL`、`ENTERPRISE_SHORTCODE`、`GITHUB_OAUTH_CLIENT_ID` 的默认值改为空（空值时服务使用相同的内置默认值），只需在 `.env` 中把它们设为空。
2. 以下变量在模板中不能留空，文件中**省略对应字段或写相同的值**：`ENTERPRISE_SLUG`、`SP_ENTITY_ID`、`SP_ACS_URL`、`SCIM_BASE_URL`、`SCIM_TOKEN`、`SESSION_SECRET`（Console 也使用，文件中写 `{ "env": "SESSION_SECRET" }` 或省略）、`CERT_DIR`（Compose 固定为 `/certs`，文件中写 `/certs/idp-cert.pem`、`/certs/idp-key.pem` 或省略）、`LOGIN_SSO_URL`、账号池模式下的 `POOL_ACCOUNT_EMAIL_DOMAIN` 和 `POOL_MAX_ACCOUNTS`（必须是数字，所以 `default` 不要写 `pool.initialMaxAccounts`，或写相同的值）。
3. 冲突时的错误示例：`ENTERPRISE_SHORTCODE conflicts with default.github.shortcode in ENTERPRISE_REGISTRY_FILE; unset one or make them equal.`

## 6. 就绪检查（readiness）

Proxy 比对三个服务对同一企业的配置：三方都有该 `id`；`githubBaseUrl` 相同；`shortcode` 在 Proxy 与 SSO 之间相同；`slug` 在 SSO 与 Login 之间相同；三方都没有阻塞项。结果显示在 Console **User pool → Pool overview** 的企业表（Blockers 列）。

| 阻塞项（示例） | 含义 |
| --- | --- |
| `proxy:enterprise_field_missing:pool.accountDomain` | Proxy 缺少必填字段。前缀 `sso:`、`login:` 表示对应服务。 |
| `sso:enterprise_secret_unconfigured:sso.signingKey` | SSO 读不到该 secret（文件不存在、为空或环境变量未设置）。 |
| `sso_missing` / `login_missing` | 该服务的 registry 中没有这个企业（通常是还没重启该服务）。 |
| `sso_unavailable` / `login_unavailable` / `*_invalid_response` | 无法访问该服务的 `/internal/enterprises`，或响应无效。 |
| `sso_github_base_url_mismatch`、`shortcode_mismatch`、`slug_mismatch` | 三个服务看到的配置不一致（通常是三个服务挂载了不同版本的文件）。 |

- 每个 Proxy 副本内存缓存结果：就绪 60 秒，未就绪或探测失败 10 秒。**激活和恢复时强制实时检查**。
- 结果只用于激活、补货前判断和 Console 展示，不写入数据库。

## 7. 生命周期与 Console 操作（账号池模式）

| 状态 | 行为 |
| --- | --- |
| `draft` | 新加入 registry 的企业的初始状态。不补货、不分配。 |
| `active` | 参与全局补货和分配。升级后 `default` 直接为 `active`。 |
| `draining` | 不新建租约和 catalog hold，不补货；**已有租约保留**。只有 catalog hold、落在该企业的调用方收到 503 `enterprise_draining`（不换企业）。已在开通中的账号继续完成。 |

允许的转换：`draft → active`（激活）、`active → draining`（排空）、`draining → active`（恢复）。不能回到 `draft`，`draft` 不能直接排空。

Console **User pool → Pool overview → Enterprises** 表中的操作：

- **Edit cap**：修改该企业的 cap（`max_accounts`）。带版本号（CAS），别人先改过时提示重新加载；所有 cap 之和不能超过 10,000。
- **Activate** / **Resume**：先显示三方 readiness 明细，Proxy 实时检查通过才会执行；未就绪返回 409 `enterprise_not_ready` 并列出阻塞项。
- **Drain**：排空。

对应接口：`GET /api/enterprises`、`PATCH /api/enterprises/<id>/pool-policy`（body `{ "expectedVersion": n, "maxAccounts"?: n, "state"?: "active" | "draining" }`）。账号池调度按 cap 占比补货，**库存占比不等于流量或账单占比**。

其他说明：

- Console 页头的 **Enterprise** 选择器决定企业作用域页面（SSO Users、AI Credits Usage、Request Stats、Proxy Accounts、Models、Login Tasks 等）显示哪个企业。它**不是权限边界**：所有 Console 管理员都能管理所有企业。
- 直连模式（`ACCOUNT_ROUTING_MODE=direct`）不使用生命周期。已有账号按账号所属企业路由；新 identity 归属 `DIRECT_MODE_ENTERPRISE_ID`（默认 `default`，必须是 registry 中的企业）。

## 8. 企业身份不可变

每个服务在数据库中记录企业的身份指纹。企业**已有数据后**，指纹变化会导致该服务启动失败（`enterprise_identity_changed`）；没有数据时允许修改。

| 服务 | 身份字段 | “已有数据”指 |
| --- | --- | --- |
| Proxy | `id`、`github.baseUrl`、`github.shortcode`、`pool.accountDomain` | 该企业有账号池成员 |
| SSO | `id`、`github.baseUrl`、`github.slug`（不区分大小写）、`github.shortcode` | 该企业有 SSO 用户 |
| Login | `id`、`github.baseUrl`、`github.slug` | 该企业有登录任务 |

出现该错误时，把字段改回原值再启动。其他字段（显示名、URL 覆盖、secret 引用、选择器等）可以修改，重启三个服务后生效。直连账号不依赖 `shortcode` 和 `accountDomain`，所以直连部署首次启用账号池（首次设置 `POOL_ACCOUNT_EMAIL_DOMAIN`）不受影响。

## 9. 新增企业

1. **GitHub 侧准备**（每个企业）：企业 slug；SCIM token；用于席位和预算的 PAT；可选的 Models 管理员 token。在 GitHub 企业的 SAML 设置中填写本部署的 IdP：
   - Sign on URL：`<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso`
   - Issuer：`<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata`
   - 公钥证书：该企业的 `sso.signingCert`（`<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata` 中也能看到）

   `default` 保持根路径（`/sso`、`/metadata`），已有企业的 GitHub IdP 配置**不需要修改**。
2. **准备 secret**：为新企业生成独立的签名证书和私钥（可参考 `scripts/gen-certs.sh`，设置 `CERT_DIR` 指向新目录），以及独立的 session secret；写入 Secret 或主机目录，只读挂载到 SSO（和 Proxy，若使用 Models token 文件）。
3. **编辑 registry**：追加企业条目（从示例复制），确认 `id`、`slug`、`shortcode`、`pool.accountDomain` 无误，这几个字段有数据后不能修改。首次使用时同时把 `ENTERPRISE_REGISTRY_FILE` 挂载到三个服务（Compose：`docker-compose.enterprise-registry.yml`）。
4. **重启 Proxy、SSO、Login**。可以逐个重启：新企业在三方都可见并就绪之前一直是 `draft`，不会被调度；已有企业不受影响。
5. **检查 readiness**：在 Pool overview 查看新企业的 Blockers，按第 6 节逐项处理。
6. **设置 cap 并激活**：Edit cap（所有企业之和 ≤ 10,000），然后 Activate。
7. **验证**：观察该企业的账号开通（SSO 用户 → SCIM → 席位 → Login 任务 → ready），并用测试调用方确认推理正常。GHE.com 首次接入请先在预发布环境验证（见升级指南第 10 节）。

## 10. 移除企业

- Proxy 中有账号池成员、SSO 中有用户、或 Login 中有任务的企业，从 registry 删除后对应服务**启动失败**（`enterprise_missing_from_registry`）。账号池成员不会被删除，所以**开通过账号的企业实际上不能从 registry 移除**，请用 **Drain** 停用（必要时把 cap 调到最小）。
- 误加、且从未产生数据的企业（仍为 `draft`，没有 SSO 用户和 Login 任务）可以直接删除条目，然后重启三个服务。
- `default` 不能移除：没有 `default` 条目时它总由环境变量合成。
