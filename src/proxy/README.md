# Proxy 模块说明

`@ghcp/proxy` 是本仓库中面向客户端的 Copilot API 代理服务。它接收本地/内部客户端的 OpenAI、Anthropic Messages、Responses 兼容请求，按 `identity` 维护 OpenCode Copilot OAuth token，并把请求直接转发到 GitHub Copilot 后端。

## 1. 模块定位

Proxy 位于客户端与 GitHub Copilot 后端之间，负责：

- 对外提供 Copilot 兼容 API：`/chat/completions`、`/v1/messages`、`/responses`、`/v1/models`。
- 用本地 API Key 保护公共代理接口，用内部 Token 保护管理/服务间接口。
- 按用户身份（默认请求头 `X-User-Identity`）维护账号、Token 状态和请求统计。
- 分别连接 SSO 服务与 Login 服务：未知身份会触发 SSO 用户确保、EMU 同步，并由 Proxy 创建 Login 任务；手动重新授权 Copilot OAuth 也会创建 Login 任务。
- 单实例默认通过 SQLite 持久化账号、Copilot OAuth token 与最近请求统计；多实例可切换到共享 MySQL 8。
- 对 Copilot 上游 HTTP、网络和流读取错误保存完整诊断现场，并通过 Console 查看、下载或清空。
- 多企业版：一套 Proxy 服务多个 GitHub 企业（github.com 或 GHE.com）。每个账号、池成员和请求统计都属于一个企业，调用 Copilot、GitHub `/user` 和 Models 时使用该企业的端点；管理与服务间接口按企业作用域（第 5 节）；账号池按企业 cap 比例补货并管理企业生命周期（第 5.6 节）。

### 多企业配置来源

Proxy 启动时读取一次企业 registry（`ENTERPRISE_REGISTRY_FILE`，可选）并与环境变量合并：

- **没有 registry**：只有 `default` 企业，完全由 `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`COPILOT_API_BASE_URL`、`ENTERPRISE_SHORTCODE`、`MODELS_ADMIN_*`，以及账号池模式下的 `POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_MAX_ACCOUNTS` 合成，行为与单企业版相同。
- **有 registry**：文件中的企业追加到 `default` 之后。若文件里也写了 `default`，同一字段与环境变量不一致时启动失败（`enterprise_env_conflict`）。GHE.com 下 `ENTERPRISE_SHORTCODE` 被忽略（启动日志打印一次 warning），不算冲突。
- 启动日志为每个企业打印一行 `[proxy] enterprise <id>: GitHub <url>, Copilot <url>`，缺少必填字段时另打印 `is not ready: <blockers>`。
- 企业有账号池成员后，修改其 `github.baseUrl`、`github.shortcode`、`pool.accountDomain` 或从 registry 删除它，Proxy 启动失败（`enterprise_identity_changed` / `enterprise_missing_from_registry`）。

字段、secret 引用和新增企业步骤见 [registry 配置参考](../../docs/multi-enterprise-registry.md)；设计见 [多企业设计](../../docs/multi-enterprise-design.md)。

## 2. 核心功能

| 能力 | 代码位置 | 说明 |
| --- | --- | --- |
| 公共代理鉴权 | `src/auth/apiKey.ts` | 公共 Copilot 兼容接口必须提供 `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>`。 |
| 身份解析 | `src/auth/identityHeader.ts` | 从 `IDENTITY_HEADER` 读取身份；默认必填，关闭后缺省为 `default`。 |
| 内部接口鉴权 | `src/auth/internalAuth.ts` | `/api/*` 与 `/internal/*` 必须提供 `X-Internal-Token`。 |
| 账号初始化 | `src/copilot/copilotAuthManager.ts` | 首次访问未知 `identity` 时异步确保 SSO 用户、同步 GH 登录并分配 Copilot seat、创建账号并排队登录任务；请求先返回 202。 |
| Copilot OAuth 管理 | `src/accounts/copilotOauthTokenImport.ts`、`src/db/accountsRepo.ts` | 支持 `/models` 验证后 CSV 导入、Login 服务写入、失败标记和手动重新授权排队。 |
| 模型与路径校验 | `src/copilot/copilotClient.ts` | 使用 OAuth bearer 读取 `/models`，判断模型是否适用于当前 API 路径；缓存按 identity 隔离 1 小时，失败时可短期使用旧缓存。 |
| 请求转发 | `src/routes/compatible.ts` | 使用 OpenCode headers 转发 JSON/SSE 响应；上游 401 时清除 OAuth token 并要求重新授权。 |
| 请求统计 | `src/db/requestStatsRepo.ts` | 记录路径、模型、成功/失败、失败原因、输入/输出/cache token；按账号保留最近 N 条。 |
| 错误诊断 | `src/diagnostics/*` | 保存原始入站请求、实际转发请求和上游错误响应；使用有界轮转的人类可读日志，可选递归脱敏。 |
| Claude Code 优化 | `src/routes/claudeCodeMode.ts`、`src/routes/claudeCodeCompat.ts`、`src/routes/anthropicModelProfiles.ts` | 可选开启，对 `/v1/messages*` 做 Anthropic/Claude Code 兼容处理、模型规范化和 profile 驱动的 thinking/effort 修正；支持请求头覆盖默认模式。 |

当前提供基于 Node test runner 的认证/迁移/路由测试和 `start:prod` 脚本；Dockerfile 未声明 `EXPOSE`/`HEALTHCHECK`。

## 3. 启动方式

以下命令均从仓库根目录执行。

### 3.1 开发运行

```bash
npm install
npm --workspace @ghcp/shared run build
cp src/proxy/.env.example src/proxy/.env
npm --workspace @ghcp/proxy run start
```

`start` 脚本实际执行 `tsx src/index.ts`。由于 `@ghcp/shared` 的运行时入口是 `dist/index.js`，首次运行前需要先构建 shared；Dockerfile 也执行了这一步。

健康检查：

```bash
curl http://localhost:3000/healthz
# {"status":"ok","service":"proxy","releaseLine":"single"}
curl http://localhost:3000/readyz
# {"status":"ok","service":"proxy","storage":"sqlite"}
```

`releaseLine` 来自镜像构建参数 `RELEASE_LINE`（环境变量 `GHCP_RELEASE_LINE`）；多企业版镜像返回 `"multi"`，本地直接运行未设置时为 `"single"`。

### 3.2 本地构建/运行

```bash
npm --workspace @ghcp/shared run build
npm --workspace @ghcp/proxy run build
(cd src/proxy && node dist/index.js)
```

Package scripts 提供 `start`、`start:prod`、`build`、`typecheck` 和 `test`。构建后直接运行时建议在 `src/proxy` 目录执行，以便 `dotenv` 读取本模块 `.env`；也可以使用 `start:prod` 或显式注入环境变量。

### 3.3 Docker

镜像统一由 `deploy/images/Dockerfile.release` 构建（多阶段：运行层只含本服务和 shared 的编译产物及生产依赖；Tini 作为 PID 1 转发 SIGTERM，工作目录 `/app/src/proxy`，启动命令 `node dist/index.js`）。从仓库根目录构建：

```bash
docker build -f deploy/images/Dockerfile.release --target proxy -t ghcp-proxy .
docker run --rm -p 3000:3000 --env-file src/proxy/.env ghcp-proxy
```

`NPM_REGISTRY` 构建参数可指定组织批准的 npm 源（不要在 URL 中放凭据）。停止时，进行中的请求（含 SSE 流）最多继续 `SHUTDOWN_TIMEOUT_MS`（默认 25000）毫秒；`docker stop` 请配合 `-t 35` 或更长。

## 4. 配置参数

Proxy 通过 `dotenv/config` 读取环境变量。未设置时使用 `src/config.ts` 的默认值；`src/proxy/.env.example` 是面向本模块的示例。

示例默认使用 SQLite，`MYSQL_*` 列为注释可选项，并非废弃变量。切换为 `STORAGE_DRIVER=mysql` 时取消所需项的注释并填写连接信息；`MYSQL_SSL_MODE` 只能填写 `disabled`、`required`、`verify-ca` 中的一个值，不能把选项列表作为值。

| 变量 | 代码默认值 / 示例值 | 必填 | 用途与关系 |
| --- | --- | --- | --- |
| `PORT` | `3000` / `3000` | 否 | HTTP 监听端口。 |
| `LOG_LEVEL` | `info`（shared logger 默认）/ `info` | 否 | 日志级别：`debug`、`info`、`warn`、`error`；无效值回退 `info`。 |
| `STORAGE_DRIVER` | `sqlite` / `sqlite` | 否 | `sqlite` 或 `mysql`；SQLite 只支持单实例，MySQL 用于多 Pod。 |
| `DB_PATH` | `./data/proxy.sqlite` / 同 | SQLite 模式 | SQLite 文件路径；启动时自动创建目录、开启 WAL。 |
| `MYSQL_URL` | 未设置 / 注释占位值 | MySQL 模式 | 所有 Proxy Pod 共享的 MySQL 8 连接 URL。 |
| `MYSQL_AUTO_MIGRATE` | `true` / `true` | 否 | 仅影响 MySQL；`false` 时跳过自动迁移，启动时只读校验管理员预建的表结构（启用用户池时含池表和凭据防护触发器），不执行任何 DDL。见 6.1 节。 |
| `MYSQL_MIGRATION_LOCK_WAIT_SECONDS` | `30` / 未列出 | 否 | 多企业版新增，整数 1–3600。一个副本执行迁移时，其他副本等待迁移锁的秒数；超时后退出，由容器平台重启。首次升级且 `proxy_request_stats` 很大时调高（例如 `600`）。 |
| `ENTERPRISE_REGISTRY_FILE` | 未设置 / 未列出 | 否 | 多企业版新增。企业 registry 的绝对路径（容器内，只读挂载）；必须与 SSO、Login 挂载同一份文件。未设置时只有由环境变量合成的 `default`。 |
| `DIRECT_MODE_ENTERPRISE_ID` | `default` / 未列出 | 否 | 多企业版新增，仅直连模式（`ACCOUNT_ROUTING_MODE=direct`）。新 identity 初始化时归属的企业；必须是 registry 中的企业，格式不合法或不存在时启动失败。旧 `/api/accounts` 列表也使用该企业。 |
| `MYSQL_CONNECTION_LIMIT` | `10` / `10` | 否 | 每个 Proxy Pod 的 MySQL 连接池上限。 |
| `MYSQL_SSL_MODE` | `disabled` / `disabled` | 否 | `disabled`、`required`（加密但不验证 CA）或 `verify-ca`；远程生产数据库应优先使用 `verify-ca`。 |
| `MYSQL_SSL_CA_PATH` | 未设置 / 空 | `verify-ca` 模式 | MySQL CA 证书文件路径。 |
| `IDENTITY_INIT_LEASE_SECONDS` | `900` / `900` | 否 | 多 Pod 首次初始化 identity 的数据库租约时间。 |
| `API_KEY` | 空字符串 / `change-me` | 是 | 公共代理接口的本地 API Key；为空时公共接口无法通过鉴权。 |
| `IDENTITY_HEADER` | `X-User-Identity` / 同 | 否 | 公共请求中用于绑定 proxy 账号的请求头名。 |
| `IDENTITY_HEADER_REQUIRED` | `true` / `true` | 否 | 为 `false` 时缺失身份头会使用 `default`。 |
| `CLAUDE_CODE_OPTIMIZED` | `false` / `true` | 否 | Claude Code 兼容优化和 `/v1/messages/count_tokens` 的默认模式；单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖。 |
| `INTERNAL_API_TOKEN` | 空字符串 / `change-me` | 是 | `/api`、`/internal` 鉴权；同时用于 Proxy 调用 SSO/Login 服务。 |
| `SSO_BASE_URL` | `http://localhost:7001` / 同 | 否 | SSO 服务地址；用于确保用户、读取 SSO 用户、同步 EMU。 |
| `LOGIN_BASE_URL` | `http://localhost:7003` / 同 | 否 | Login 服务地址；用于创建 Copilot OAuth 重新授权任务。 |
| `ENTERPRISE_SHORTCODE` | `octo` / `octo` | 否 | `default` 企业的 shortcode（自动转小写）。初始化身份时从规范化 identity 末尾剥离 `_<shortcode>`，生成 SSO 用户名。GHE.com 模式下忽略（GH login 不带后缀）。 |
| `GITHUB_BASE_URL` | `https://github.com` / 同 | 否 | `default` 企业的 GitHub Web origin；host 以 `.ghe.com` 结尾时为 GHE.com 模式，忽略 `ENTERPRISE_SHORTCODE`。 |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | `2` / `2` | 否 | 每个 identity 保留的请求统计条数；必须为正整数。 |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED` | `true` / `true` | 否 | 是否保存 Copilot 上游失败诊断。关闭后控制台错误摘要仍会输出。 |
| `PROXY_ERROR_DIAGNOSTICS_DIR` | `./data/error-diagnostics` / 同 | 否 | 轮转文本日志目录；Compose 使用 `/data/error-diagnostics`。 |
| `PROXY_ERROR_DIAGNOSTICS_REDACT` | `false` / `false` | 否 | 是否脱敏敏感 headers 和 JSON 字段。默认不脱敏，会保存凭据与完整用户内容。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB` | `50` / `50` | 否 | 单个诊断文件目标上限 MB；必须为正整数。超大单条记录保持完整。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILES` | `5` / `5` | 否 | 包含当前文件在内的最大轮转文件数；必须为正整数。 |
| `PROXY_ERROR_DIAGNOSTICS_SHARED` | `false` / `false` | 否 | 在多 Pod 共用 RWX 根目录时启用实例隔离写入和聚合读取。 |
| `PROXY_INSTANCE_ID` | `HOSTNAME` / 空 | 共享诊断模式 | 当前 Pod 的安全目录标识；Kubernetes 建议通过 Downward API 注入 Pod 名。 |
| `COPILOT_API_BASE_URL` | `https://api.githubcopilot.com` / 同 | 否 | `default` 企业的 Copilot API base URL；GitHub.com 用默认值，GHE.com 为 `https://copilot-api.<sub>.ghe.com`。GHE.com 下未设置时由 `GITHUB_BASE_URL` 推导；显式设置时必须属于同一个 `<sub>.ghe.com`，否则启动失败。 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` / 同 | 否 | `default` 企业的 GitHub REST API；Models 页面用它校验管理员 token 归属，Login 回传 token 时用它调用 `/user` 核对账号身份。GHE.com 为 `https://api.<sub>.ghe.com`，未设置时自动推导，规则同上。 |
| `MODELS_ADMIN_GITHUB_LOGIN` | 空 / 空 | 否 | `default` 企业 Console Models 页面使用的 GitHub 企业管理员登录名（其他企业在 registry 的 `modelsAdmin.*` 配置）；未设置时页面提示未配置。详见 `docs/models-admin-guide.md`。 |
| `MODELS_ADMIN_GITHUB_USER_ID` | 空 / 空 | 否 | 管理员的数字 GitHub 用户 ID（推荐），防止登录名改名复用。 |
| `MODELS_ADMIN_COPILOT_TOKEN_FILE` | 空 / 空 | 否 | 管理员 Copilot OAuth token 的 Secret 文件绝对路径，每次查询重新读取（推荐）。 |
| `MODELS_ADMIN_COPILOT_TOKEN` | 空 / 空 | 否 | 直接提供 token；不能与 `_FILE` 同时设置。 |
| `SHUTDOWN_TIMEOUT_MS` | `25000` / 同 | 否 | 收到 SIGTERM 后，进行中的请求（含 SSE 流）最多继续的毫秒数，之后关闭连接；需小于容器停止宽限期。 |
| `OPENCODE_VERSION` | `1.0.0` / `1.18.4` | 否 | 生成 `User-Agent: opencode/<version>`。 |
| `OPENCODE_USER_AGENT` | 未设置 / 未设置 | 否 | 显式覆盖完整 User-Agent；非空时优先于 `OPENCODE_VERSION`。 |
| `GITHUB_API_VERSION` | `2026-06-01` / 同 | 否 | `X-GitHub-Api-Version` 请求头。 |

### `.env` 与 runtime Settings

Proxy 当前没有 runtime settings 表、Settings 页面字段或 `/api/settings/runtime` 接口；上表全部是启动期环境变量，修改后需要重启 Proxy。密钥、服务地址和数据库连接不会写入业务数据库。

`REQUEST_STATS_PER_ACCOUNT_LIMIT` 是 env-only 的数据保留策略：每次写入统计后清理当前 identity 的旧记录，服务启动时还会对所有 identity 清理一次。代码、Compose fallback、根 `.env.example` 和 `src/proxy/.env.example` 均默认为 `2`。该值必须是正整数。

错误诊断同样是 env-only。默认启用并写入 `diagnostics.log`、`diagnostics.1.log` 等轮转文件；Compose 的目录位于现有 `proxy-data` volume，容器重启后仍保留。每条记录直接列出 headers、格式化后的 JSON/text body、入站请求和实际上游请求的 curl 命令。`PROXY_ERROR_DIAGNOSTICS_REDACT=false` 时，文件会原样包含 API Key、Copilot Authorization、用户 prompt、工具参数和响应内容，必须限制 volume、备份和 Console 管理员权限。设置为 `true` 后会脱敏敏感 headers，并递归脱敏可安全解析的 JSON；无法安全脱敏的非 JSON 或不完整 body 不写正文。

根 `.env` 还包含其他服务的变量，但 Proxy 只读取上表项目。Docker Compose 只会把 `docker-compose.yml` 中 Proxy `environment` 明确列出的变量传入容器。

### 日志等级与错误诊断

`LOG_LEVEL` 是最低控制台日志等级：

| 设置 | 控制台输出 | 推荐场景 |
| --- | --- | --- |
| `debug` | debug、info、warn、error | 短时间排障；会额外打印经过常规 logger 脱敏的入站 headers。 |
| `info` | info、warn、error | 生产默认，能看到常规操作、上游 4xx 和严重故障。 |
| `warn` | warn、error | 只关注异常；仍能看到上游 4xx/5xx。 |
| `error` | error | 仅严重故障；上游 4xx 警告会被隐藏，不建议常态使用。 |

无效值和未设置都按 `info` 处理。完整错误现场是否落盘由 `PROXY_ERROR_DIAGNOSTICS_ENABLED` 独立控制，不要求开启 `debug`；脱敏开关也只影响诊断文件，不改变普通 logger 的脱敏。

## 5. 接口与 API 边界

### 5.1 通用鉴权

公共 Copilot 兼容接口需要：

```http
Authorization: Bearer <API_KEY>
# 或 x-api-key: <API_KEY>
X-User-Identity: <identity>
Content-Type: application/json
X-Claude-Code-Optimized: true|false  # 可选；覆盖 CLAUDE_CODE_OPTIMIZED 默认值
```

内部管理/服务间接口需要：

```http
X-Internal-Token: <INTERNAL_API_TOKEN>
```

`GET /healthz`、`GET /readyz` 不需要鉴权。

### 5.2 健康检查

| 方法 | 路径 | 认证 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 无 | `{ status: "ok", service: "proxy", releaseLine }`；多企业版镜像 `releaseLine` 为 `"multi"`。 |
| `GET` | `/readyz` | 无 | 存储可用时 `{ status: "ok", service: "proxy", storage }`；数据库不可用，或 SQLite 账号池模式下本进程不是池 owner 时返回 `503 { status: "unavailable", service: "proxy" }`。 |

`/readyz` 只检查本副本自身，不检查企业的跨服务就绪状态；企业 readiness 见 5.6 节。

### 5.3 公共 Copilot 兼容接口

| 方法 | 路径 | 认证 | 请求核心结构 | 响应核心结构 |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/models` | API Key + identity | 可选请求头 `X-Cache: false` 强制绕过当前 identity 的内存缓存并禁止 stale fallback | 非优化模式返回 OpenAI/Copilot 风格 `{ object: "list", data: [...] }`。Claude Code 优化模式下只返回支持 `/v1/messages` 的模型，并返回 Anthropic 风格 `{ data: [{ type: "model", id, display_name, max_input_tokens, max_tokens }], has_more, first_id, last_id }`。两种模式的 Claude `id` 均为标准连字符形式，其他模型 ID 不变。 |
| `POST` | `/chat/completions` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持上游 Chat Completions 形状 | 直接返回 Copilot 上游状态、`content-type` 和 body；支持 SSE。 |
| `POST` | `/responses` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持上游 Responses 形状 | 同上。 |
| `POST` | `/v1/messages` | API Key + identity | JSON 对象，必须含 `model: string`；其余字段保持 Anthropic Messages 形状 | 同上；优化模式会做 Claude Code 兼容预处理。 |
| `POST` | `/v1/messages/count_tokens` | API Key + identity | 仅当前请求解析为优化模式时可用；JSON 对象，必须含 `model: string` | 优先转发到上游；若上游返回 404/405/501，则本地估算并返回 `{ input_tokens: number }`。 |
| 任意 | `/v1/files*` | API Key + identity | 当前未提供 Files API | 优化模式下返回 Anthropic 风格 `not_supported`；非优化模式走统一 404。 |

边界说明：

- Proxy 不在 OpenAI/Anthropic/Responses 之间转换请求体；调用方必须发送目标路径对应的 body；非常简单的透传模式。
- 转发前会检查 `body.model` 是否存在、模型是否支持当前路径；不支持时返回 400。
- 上游 401 会清除当前 identity 的 OAuth token 并标记为 `expired`；管理员需要重新授权或导入新 token。403 作为 seat/组织策略错误透传，不清除 token。
- 未知 identity 会触发初始化并返回 202：`{ error: { code: "account_initializing", ... } }`。多企业版中新 identity 在 `DIRECT_MODE_ENTERPRISE_ID` 企业初始化（direct 模式），请求本身不带企业，见 5.6 节。
- 不支持的路径返回 404，并列出当前支持路径。
- 所有 POST 转发都会向 Copilot 发送 `x-initiator`。若入站 `x-initiator` 去除首尾空白并忽略大小写后为 `user` 或 `agent`，Proxy 会优先采用并规范为小写；其他值不会透传，而是回退到请求内容判断。无合法 header 时，Anthropic Messages 的末条 `tool_result`、compact/summary 和自动 `Please continue.`，Chat Completions 的末条 `role:"tool"`，以及 Responses 的末条 `*_call_output` 输入会判为 `agent`，其余请求判为 `user`。该规则同时适用于直接转发和 Claude Code 优化模式。

#### Claude Code 优化模式

当请求解析为 Claude Code 优化模式时，Proxy 将 `/v1/messages` 和 `/v1/messages/count_tokens` 视为 Claude Code 入口，但仍然转发到 Copilot 原生 Anthropic Messages API，不做 Anthropic/OpenAI 大模型协议转换。默认值来自 `CLAUDE_CODE_OPTIMIZED`，单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖。当前优化逻辑包括：

- **模型与路径**：`GET /v1/models` 从当前账号的 Copilot `/models` 读取实时目录；Claude 模型对外使用标准连字符 ID（例如上游 `claude-opus-4.8` 对外为 `claude-opus-4-8`），非 Claude ID 原样保留。所有 POST 入口都同时接受标准 ID 和旧点号 ID，并在路径校验及上游转发前解析为目录中的真实 ID；JSON/SSE 响应中的协议 model 元数据再转回标准 ID。该能力与 Claude Code 优化开关无关。未来点号版本（例如 `claude-opus-5.2`，以及更高主版本）由目录动态生成标准 ID，不使用静态型号白名单；实际可用性始终由实时目录决定，thinking/effort 协议能力仍按独立 profile 处理。优化模式下模型列表只暴露支持 `/v1/messages` 的模型。
- **模型 profile**：`anthropicModelProfiles.ts` 维护 Claude 模型的 thinking/effort 能力。enabled-only 模型会去掉不支持的 `output_config.effort`，并把 `thinking.type=adaptive` 改成合法的 enabled 形态；adaptive-only 模型会把 `thinking.type=enabled` 改成 `adaptive`；预算会限制到 profile 上限并保持 `< max_tokens`，thinking 打开时会把强制工具选择 `any/tool` 改成 `auto`。
- **请求体清理**：递归移除 `cache_control.scope`；删除 Claude Code 注入的易变 `# currentDate` 块；过滤无签名、占位或签名含 `@` 的历史 assistant `thinking` 块；去掉 `"Tool loaded."` 边界消息；合并普通 user message 内的 `tool_result + text`，但含 `tool_reference` 的 ToolSearch result 保持独立 content，避免构造 Copilot 不接受的混合 block；末尾 assistant message 后追加 `Please continue.`；非 `defer_loading` 的 `mcp__ide__executeCode` 会被移除。
- **mid-conversation system**：对多数模型，历史中间位置的 `role:"system"` 会改成 `role:"user"`，并给首个 text block 加 `[Claude Code injected]\n` 前缀；仅 profile 标记可接受且位置合法的模型会保留原 system message。
- **Headers / beta**：转发时使用 OpenCode 风格 header：OAuth `Authorization: Bearer`、`User-Agent: opencode/<version>`、`X-GitHub-Api-Version: 2026-06-01`、`Openai-Intent: conversation-edits` 和 `x-initiator`。`anthropic-version` 默认 `2023-06-01`；`anthropic-beta` 只保留允许的 token，并按请求内容派生 `interleaved-thinking-2025-05-14`、`context-management-2025-06-27`、`advanced-tool-use-2025-11-20`、`token-counting-2024-11-01`；会丢弃 `claude-code-*`、陈旧 prompt-caching 和已知 Copilot 不接受的全局 beta。
- **请求意图**：沿用公共 POST 转发的 `x-initiator` 优先级；合法入站值优先于内容推断。无合法 header 时，普通用户请求发送 `user`，compact、`tool_result` 续轮和自动 continue 发送 `agent`；compact 无论 initiator 是否由 header 覆盖，都会额外发送 `x-interaction-type: conversation-other`。
- **视觉与不支持能力**：请求中出现 image content block 时设置 `Copilot-Vision-Request: true`。`/v1/files*` 返回 Anthropic 风格 `not_supported`；`web_search` / `web_search_*` server tool 会在本地前置拒绝，提示改用支持的模型/账号或 MCP 搜索工具。
- **token count**：`/v1/messages/count_tokens` 复用同一套 body 预处理和前置错误检查，优先转发 Copilot；若上游返回 404/405/501，则用本地 JSON 长度估算 `{ input_tokens }`。
- **SSE**：`/v1/messages` 的 SSE 基本透传，保留 Copilot 扩展字段；仅过滤 Copilot 末尾的 OpenAI 风格 `[DONE]` 事件，避免 Claude Code 按 Anthropic SSE 解析时报错。

当请求解析为非优化模式时，Proxy 不会因为请求来自 Claude Code 就拒绝；`POST /v1/messages` 仍会按 Anthropic Messages 形状直接转发，但不会做 Claude Code body 预处理，也不会开放 `/v1/messages/count_tokens`。

公共兼容接口的主要拒绝/错误返回逻辑：

| 场景 | 返回 |
| --- | --- |
| 缺 API Key | `401 missing_api_key`，提示使用 `Authorization: Bearer` 或 `x-api-key`。 |
| API Key 不匹配 | `401 invalid_api_key`。 |
| 缺 identity header，且 `IDENTITY_HEADER_REQUIRED=true` | `400 missing_identity_header`。 |
| `X-Claude-Code-Optimized` 不是合法布尔值 | `400 invalid_request_error`。 |
| 请求 body 不是 JSON 对象 | `400 invalid_request_error`。 |
| 请求 body 缺少字符串类型 `model` | `400 invalid_request_error`。 |
| `model` 不存在，或不支持当前路径 | `400 invalid_request_error`。 |
| 当前请求解析为非优化模式时请求 `/v1/messages/count_tokens` | `404 invalid_request_error`，并列出当前支持路径。 |
| 请求未支持路径，例如 `/v1/files*` | `404 invalid_request_error`；优化模式下 `/v1/files*` 返回 Anthropic 风格 `not_supported`。 |
| 上游 Copilot 返回 401/403 | 返回对应 `401` / `403`。 |
| 其他上游或转发错误 | 通常返回 `502 api_error`。 |

当 Copilot 上游失败时，Proxy 只在常规控制台输出一行摘要，并提供 `diagnosticId` 与诊断文件关联：

- 上游 HTTP 4xx 使用 `WARN upstream-http-error`。
- 上游 HTTP 5xx、fetch/network/abort 和响应流读取失败使用 `ERROR`。
- 摘要包含 identity、path、model、状态码、上游 URL 和 body 字节数，不输出完整正文。
- 诊断文件记录原始入站 method/URL/raw headers/raw body、转换后实际发送的 URL/headers/body，以及上游 status/headers/body 或异常 stack。
- `/v1/messages/count_tokens` 遇到 404/405/501 后即使成功使用本地估算，也会记录该次上游失败。
- 响应诊断最多捕获 20 MB 并标记截断；入站请求沿用 Express 的 20 MB JSON 上限，压缩请求保存解压前原始字节。

### 5.4 管理接口 `/api/*`

全部要求 `X-Internal-Token`。多企业版把管理接口分为以下几类（`src/server.ts` 的 `mountManagementRouters`）：

| 类别 | 路径 | 说明 |
| --- | --- | --- |
| 全局 | `/api/enterprises`、`/api/enterprises/:enterpriseId/pool-policy`、`/api/user-pool/{overview,settings,diagnostics/local,reconcile}`、`/api/error-diagnostics*` | 不属于某个企业的列表、池全局设置和错误诊断。 |
| 企业作用域 | `/api/enterprises/:enterpriseId/...` | 账号、批量操作、请求统计、池成员和 Models。Console 只使用这一组。 |
| 旧直连账号（deprecated） | `/api/accounts*` | 保留一个版本，响应带 `Deprecation: true`；列表、汇总、导出和导入使用 `DIRECT_MODE_ENTERPRISE_ID` 企业，单个账号按全局 identity 查找，响应中的 `enterpriseId` 指明所属企业。请迁移到作用域路径。 |
| 其他无作用域路径 | 例如 `/api/request-stats`、`/api/accounts/operations/*`、`/api/user-pool/accounts` | `400 enterprise_scope_required`，不会回落到 `default`。 |

作用域校验（shared `requireEnterprise`）：先校验内部 token，再校验 `:enterpriseId` 格式（`^[a-z][a-z0-9-]{0,30}[a-z0-9]$`，否则 `400 invalid_enterprise_id`）；未知企业 `404 enterprise_not_found`；`X-Enterprise-Id` 头、`enterpriseId` query 或 body 字段与路径不一致时 `400 enterprise_scope_conflict`。作用域内未实现的路径返回 `404 not_found`。另一企业的 identity 与不存在的 identity 一样返回 `404 account_not_found`。

#### 全局接口

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/api/enterprises` | 无 | `{ items, nameCapacity }`。每项含 `id`、`displayName`、`githubBaseUrl`、`slug`、`shortcode`（GHE.com 为空串）、`pool`（池策略，直连模式为 `null`）、`readiness`（三方比对结果，探测超过 8 秒时为 `null`）、`poolSummary`、`shareScore`。 |
| `PATCH` | `/api/enterprises/:enterpriseId/pool-policy` | `{ expectedVersion, maxAccounts?, state? }`，`state` 为 `active` 或 `draining` | 更新后的 `EnterprisePoolPolicyDto`。错误见 5.6 节。 |
| `GET` / `PATCH` | `/api/user-pool/settings` | PATCH：`{ expectedVersion, changes }`，`changes` 只接受 `idle_target`、`lease_seconds`、`paused` | 全局池设置。传 `max_accounts` 返回 `409 use_enterprise_cap`（cap 改为按企业设置）；版本冲突 `409 settings_version_conflict`。 |
| `GET` | `/api/user-pool/overview` | 无 | 全局设置、全局计数和上限。 |
| `GET` | `/api/user-pool/diagnostics/local` | 无 | 本副本调度器快照（不读数据库）。 |
| `POST` | `/api/user-pool/reconcile` | 空 body | `202 { scheduled: true }`，唤醒补池。 |
| `GET` | `/api/error-diagnostics?page=&pageSize=` | 分页参数可选，`pageSize` 最大 100 | `ProxyErrorDiagnosticsListResponse`，只返回摘要并指明功能是否开启、是否脱敏。 |
| `GET` | `/api/error-diagnostics/:id` | 诊断 UUID | `ProxyErrorDiagnosticDetailDto`，包含摘要字段和完整人类可读日志；不存在返回 404，功能关闭返回 503。 |
| `GET` | `/api/error-diagnostics/:id/download` | 诊断 UUID | 以 `Content-Disposition: attachment` 下载 `.log` 文本。 |
| `GET` / `POST` | `/api/error-diagnostics/export` | 同列表筛选 | CSV 摘要。 |
| `DELETE` | `/api/error-diagnostics` | `{ confirm: true }` | 原子清空全部轮转文件；未确认返回 400。 |

账号池接口在直连模式下返回 `409 pool_mode_disabled`。错误诊断仍是全局的，不按企业拆分。

#### 企业作用域接口

下表中 `{e}` 表示 `/api/enterprises/:enterpriseId`。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET` | `{e}/accounts?q=&page=&pageSize=&sort=&dir=` | 查询参数可选；`sort` 支持 `identity`、`ssoUser`、`ghLogin`、`copilotOauthStatus`、`createdAt`、`updatedAt`；`dir` 支持 `asc`/`desc` | `PageResponse<ProxyAccountDto>`，每项带 `enterpriseId`，不返回原始 Token。 |
| `GET` | `{e}/accounts/summary` | 无 | 该企业账号聚合。 |
| `GET` / `POST` | `{e}/accounts/export` | GET 导出全部匹配，`scope=page` 导出当前页；POST 导出已选项 | CSV。 |
| `GET` | `{e}/accounts/:identity` | 路径参数 identity | `ProxyAccountDto`；不存在或属于其他企业返回 404。 |
| `DELETE` | `{e}/accounts/:identity` | 路径参数 identity | 删除该 Proxy account、OAuth credential 和 request stats；不删除 SSO/GH 用户。返回 `DeleteProxyAccountResult`。 |
| `POST` | `{e}/accounts/copilot-oauth-token/import` | `{ csvText: string }`；CSV 头必须是 `name,copilotOauthToken`，name 不可重复 | `BatchResult<ImportCopilotOauthTokenRow>`；每个 token 用该企业的 Copilot 地址通过 `/models` 验证后才写入。caller-lease 模式返回 `409 pool_member_managed`。 |
| `GET` | `{e}/accounts/:identity/request-stats?limit=` | `limit` 默认 100 | `ProxyRequestStatDto[]`。 |
| `POST` | `{e}/accounts/:identity/copilot-oauth/reauthorize` | `{ credentialMode: "default", ssoType }` 或 `{ credentialMode: "override", ssoPassword, ssoType }` | 标记 OAuth `refreshing` 并在该企业创建 Login 任务，返回 `ProxyAccountDto`；池成员返回 `409 pool_member_managed`。 |
| `POST` / `GET` | `{e}/accounts/operations/preview`、`/:id/execute`、`/:id`、`/:id/export` | 删除与重新授权批量操作 | 选择范围限定在该企业；预览和结果只在本进程内存中，每个企业各自独立。 |
| `GET` | `{e}/request-stats?limit=` | 只带 `limit` | 该企业最近请求统计数组。 |
| `GET` | `{e}/request-stats?page=&pageSize=&identity=&model=&success=&from=&to=`、`{e}/request-stats/page` | 分页筛选 | `PageResponse<ProxyRequestStatDto>`。 |
| `GET` / `POST` | `{e}/request-stats/export` | 同上 | CSV。 |
| `GET` | `{e}/user-pool/summary`、`{e}/user-pool/accounts`、`{e}/user-pool/leases`、`{e}/user-pool/events` | 无 query | 该企业的池计数、成员、租约和事件。 |
| `GET` | `{e}/user-pool/page/:kind` | `kind` 为 `accounts`、`leases`、`events`，分页筛选 | 该企业的分页列表。 |
| `POST` | `{e}/user-pool/accounts/:identity/:action` | `action` 为 `disable`、`resume`、`retry` | `{ accepted: true }`。 |
| `POST` | `{e}/user-pool/leases/:id/release` | `{ confirm: true }` | `{ released: true }`。 |
| `GET` | `{e}/models?refresh=true\|false` | 只接受 `refresh` | 用该企业配置的 Models 管理员和该企业的 GitHub/Copilot 地址查询模型目录；不回落到池账号或直连账号。未配置时返回 `models_admin_not_configured`。 |

### 5.5 服务间接口 `/internal/*`

全部要求 `X-Internal-Token`，并且必须带企业作用域：`/internal/enterprises/:enterpriseId/...`。无作用域的旧路径（例如 `/internal/accounts/:identity/copilot-oauth-token`）返回 `400 enterprise_scope_required`，所以新旧版本不能混跑。路径企业与账号行所属企业不一致时，按“账号不存在”返回 `404 account_not_found`，不暴露另一企业的数据。

下表中 `{i}` 表示 `/internal/enterprises/:enterpriseId`。

| 方法 | 路径 | 调用方 | 请求 | 响应 |
| --- | --- | --- | --- | --- |
| `POST` | `{i}/accounts/:identity/oauth-attempts/:attemptId/prepare` | Login 重试 | `{ ssoUser, ghLogin, ssoType, previousAttemptId, ... }` | 校验映射、活动授权及密码模式，把账号切换到新 attempt；默认密码经 SSO 内部只读入口解析。池成员返回 409。 |
| `PUT` | `{i}/accounts/:identity/copilot-oauth-token` | Login 成功回传 | `{ oauthAttemptId, copilotOauthToken, ghLogin? }` | 依次校验：路径企业 = 账号企业；attempt 仍为当前且状态为 `refreshing`（否则 `409 stale_oauth_attempt`）；用新 token 调用该企业 `<apiBaseUrl>/user`，login 必须与账号的 `gh_login` 一致（不区分大小写）。不一致返回 `409 authorization_subject_mismatch` 并将该 attempt 标为失败；GitHub 不可达返回 `503 authorization_subject_unavailable`，由 Login 有限次重试。 |
| `POST` | `{i}/accounts/:identity/mark-copilot-oauth-failed` | Login 失败回传 | `{ oauthAttemptId }` | 仅当前 attempt 匹配时将 OAuth 状态置为 `failed`；过期回写被忽略。 |
| `GET` | `{i}/accounts/:identity/login-task-protection?taskId=&oauthAttemptId=` | Login 删除/重试前 | 无 | `{ managed, referenced }`；属于其他企业的 identity 返回 404。 |
| `GET` | `{i}/accounts/by-sso-user/:ssoUser/pool-membership` | SSO 破坏性操作前 | 无 | `{ managed }`；查询失败返回 5xx，SSO 按 fail closed 处理。 |
| `DELETE` | `{i}/accounts/by-sso-user/:ssoUser` | SSO `delete_sso` | 无 | 只删除该企业内该 SSO 用户的账号：`{ ssoUser, matchedAccounts, deletedAccounts, deletedRequestStats }`。 |

Proxy 调用 SSO、Login 时同样使用作用域路径，例如 SSO `/api/enterprises/:id/users/ensure`、`/internal/enterprises/:id/users/:ssoUser/login-credentials`，Login `/api/enterprises/:id/tasks`、`/api/enterprises/:id/tasks/by-attempt/:attemptId`；readiness 探测调用 SSO 和 Login 的 `GET /internal/enterprises`。

### 5.6 企业端点、池策略、生命周期与 readiness

**每个企业的端点**：Copilot 转发、token 导入验证、池成员预热和 Models 使用企业的 `github.copilotApiBaseUrl`；`/user` 身份核对和 Models 管理员校验使用 `github.apiBaseUrl`。github.com 企业默认 `https://api.githubcopilot.com`、`https://api.github.com`；GHE.com 企业默认 `https://copilot-api.<sub>.ghe.com`、`https://api.<sub>.ghe.com`。按 identity 的模型缓存和 Models 管理员缓存都按企业区分。

**公共请求如何确定企业**：请求不带企业。direct 模式按账号行的企业，新 identity 用 `DIRECT_MODE_ENTERPRISE_ID`；caller-lease 模式按租约成员所属企业。已有租约或 catalog hold 保持原企业和原成员。

**池策略（`proxy_enterprises`，仅 caller-lease 模式）**：

| 项 | 说明 |
| --- | --- |
| cap（`max_accounts`） | 每个企业的账号上限，1–10000；所有企业 cap 之和不能超过名字目录容量 10000（`409 name_capacity_exceeded`）。升级后 `default` 的 cap 等于升级前的 `user_pool_settings.max_accounts`。 |
| 补货 | 全局一个 idle 目标（`idle_target`），在 `active` 企业之间按 cap 比例补货：分数 `S_e = N × C_e − C × N_e`，库存占比缺口最大的企业优先。库存（inventory）包含 failed、disabled 成员；**库存占比不等于流量或账单占比**。 |
| `draft` | 新加入 registry 的企业的初始状态，不补货、不分配。 |
| `active` | 参与补货和分配。升级后 `default` 直接为 `active`。 |
| `draining` | 不新建租约和 catalog hold，不补货；已有租约保留；已在开通中的账号继续完成。只有 catalog hold 且落在该企业的调用方收到 `503 enterprise_draining`，不换企业。 |
| 转换 | `draft → active`、`active → draining`、`draining → active`。不能回到 `draft`，`draft` 不能直接排空（`409 invalid_state_transition`）。 |
| CAS | `expectedVersion` 必须等于当前 `policyVersion`，否则 `409 policy_version_conflict`。 |

**readiness**：激活或恢复（`state: "active"`）前，Proxy 实时调用 SSO、Login 的 `GET /internal/enterprises` 并比对：三方都有该企业；`githubBaseUrl` 相同；`shortcode` 在 Proxy 与 SSO 之间相同；`slug` 在 SSO 与 Login 之间相同；三方都没有阻塞项。未就绪返回 `409 enterprise_not_ready`，`details.blockers` 列出阻塞项，例如 `proxy:enterprise_field_missing:pool.accountDomain`、`sso_missing`、`login_unavailable`、`sso_github_base_url_mismatch`、`shortcode_mismatch`、`slug_mismatch`。结果在每个副本内存缓存：就绪 60 秒，未就绪或探测失败 10 秒；只用于激活、补货前判断和 Console 展示，不写数据库。

## 6. 数据结构

### 6.1 SQLite / MySQL 表

`src/db/connection.ts` 根据 `STORAGE_DRIVER` 创建 SQLite provider 或 MySQL 连接池。SQLite 会按 `DB_PATH` 创建目录、启用 WAL 和外键；MySQL 要求 8.x/InnoDB，默认自动迁移，并通过 advisory lock 保证多个 Pod 并发启动时只有一个实例执行 schema migration。两种 provider 暴露相同的异步账号、统计和初始化租约语义。

#### 多企业迁移（自动）

从单企业版 r4 原地升级时，Proxy 在启动、开始监听之前自动执行多企业迁移（步骤记录在 `schema_migrations`，ID 以 `enterprise-v1/` 开头）：

- 新建 `proxy_enterprises` 并插入 `default`（`active`，cap 取升级前的 `user_pool_settings.max_accounts`）。
- `proxy_accounts`、`proxy_identity_initializations`、`proxy_request_stats`，以及账号池表 `user_pool_accounts`、`user_pool_events` 增加 `enterprise_id`，已有行全部回填 `default`。
- 步骤幂等、崩溃安全：SQLite 每步一个事务；MySQL 逐步检查是否已生效，中途中断后重启会继续完成。
- 旧版本按设计**拒绝工作**：MySQL 上 `enterprise_id` 没有默认值，r4 写入失败，且 r4 因 schema 校验和账号池配置指纹无法启动；SQLite 上写入被触发器拒绝。因此首次升级必须四个组件一次性替换，回滚只能恢复备份（见 [多企业版升级指南](../../docs/multi-enterprise-upgrade-guide.md)）。
- MySQL 多副本：第一个副本取得迁移锁执行迁移，其他副本最多等待 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`。建议首次升级先只启动 1 个副本，`/readyz` 正常后再扩容；`proxy_request_stats` 很大时同时调高等待时间和 Kubernetes `startupProbe`。所需权限与 r4 自动迁移相同，不需要新增 `TRIGGER` 权限。

每次启动还会补插缺失的 `default` 行、检查企业身份（见第 1 节），并按实际成员数校正各企业的库存计数，偏差写入 `user_pool_events`（`enterprise_inventory_drift`）。

#### MySQL 低权限运行

当运行账号没有 `CREATE`、`ALTER` 权限时，由管理员提前准备好与当前版本匹配的业务表，并向 Proxy 容器实际注入以下环境变量：

```dotenv
STORAGE_DRIVER=mysql
MYSQL_URL=mysql://proxy_runtime:change-me@mysql:3306/proxy
MYSQL_AUTO_MIGRATE=false
```

关闭自动迁移后，Proxy 启动时**只读校验**表结构，不执行建表、改表、迁移锁或任何写入：

- 业务表（`schema_migrations`、`proxy_enterprises`、`proxy_accounts`、`proxy_request_stats`、`proxy_identity_initializations`）按与自动迁移相同的定义逐项核对：列、类型、可空、排序规则、默认值、主键/唯一键、外键。要求的索引必须存在；额外的二级索引只记 warning。
- 启用用户池（caller-lease 模式）时，额外核对池表和 `user_pool_credential_fence` 凭据防护触发器。

任何不一致都会在监听 HTTP 端口之前报错，并提示应执行的脚本；不会自动修复：

| 情况 | DBA 执行的脚本 |
| --- | --- |
| 全新的空库 | `scripts/proxy-mysql-initial.sql`（已包含多企业的表和列），由 `npm --workspace @ghcp/proxy run mysql:initial-sql` 生成。 |
| 从单企业版 r4 升级 | `scripts/proxy-mysql-enterprise-upgrade.sql`，由 `npm --workspace @ghcp/proxy run mysql:enterprise-upgrade-sql` 生成。先停止全部 Proxy 并备份，用管理员账号执行**一次**，例如 `mysql <Proxy库名> < scripts/proxy-mysql-enterprise-upgrade.sql`。 |

两份脚本都由 `src/db/mysqlInitialSql.ts` 按同一组定义生成，单元测试保证一致，并同时写入迁移记录，以后切回自动迁移也不会重复执行。初始脚本**不含** `default` 行；升级脚本插入的 `default` 行指纹为空。Proxy 启动后用运行时权限（`INSERT`/`UPDATE`）补全 `default` 企业的指纹、cap 和库存计数，并更新账号池配置指纹。升级脚本只适用于 r4 的 schema，且**不可重入**：中途失败时恢复备份后重来，或用 `MYSQL_AUTO_MIGRATE=true` 启动**一个** Proxy 副本完成剩余步骤。

运行账号权限：

- 对本库具备 `SELECT`、`INSERT`、`UPDATE`、`DELETE`（启动时会清理请求统计，因此不是只读模式）。
- 启用用户池时，还需要对 `proxy_accounts` 具备 `TRIGGER` 权限：MySQL 只向持有该权限的账号显示触发器元数据，Proxy 需要据此确认凭据防护触发器存在。

校验在存储初始化时完成，之后 `/readyz` 只检查连接。配置修改后需要重启 Proxy；未设置或为 `true` 时保持自动迁移，SQLite 不受此开关影响。

#### `proxy_enterprises`

| 字段 | 含义 |
| --- | --- |
| `id` | 企业 ID（主键），与 registry 的 `id` 相同。 |
| `state` | `draft`、`active`、`draining`。 |
| `max_accounts` | 该企业的 cap，1–10000。 |
| `inventory_count` | 该企业已登记的池成员数（含 failed、disabled），每次启动按实际行数校正。 |
| `policy_version` | Console 修改 cap / 状态时的 CAS 版本。 |
| `profile_fingerprint` | `{ id, githubBaseUrl, shortcode, accountDomain }` 的 sha256；有池成员后变化即启动失败。 |
| `created_at` / `updated_at` | 毫秒时间戳。 |

#### `proxy_accounts`

| 字段 | 含义 |
| --- | --- |
| `identity` | Proxy 账号主键，来自身份头；全局唯一。 |
| `enterprise_id` | 所属企业，外键指向 `proxy_enterprises`；写入后不可更改，升级前的行为 `default`。 |
| `sso_user` | SSO 用户名，账号初始化/导入时写入。 |
| `gh_login` | GitHub 登录名，可为空。 |
| `copilot_oauth_token` | OpenCode OAuth client 获取的 OAuth token，DTO 不会返回该字段。 |
| `copilot_oauth_status` | `valid`、`expired`、`missing`、`refreshing`、`failed`。 |
| `copilot_oauth_updated_at` | OAuth token 更新时间。 |
| `copilot_oauth_attempt_id` | 当前/最近一次授权代次，用于防止旧任务覆盖新 token。 |
| `created_at` / `updated_at` | ISO 时间戳。 |

#### `proxy_request_stats`

| 字段 | 含义 |
| --- | --- |
| `id` | UUID。 |
| `identity` / `gh_login` | 请求归属账号。 |
| `enterprise_id` | 请求所属企业；管理接口按企业查询。 |
| `requested_at` | 请求时间。 |
| `path` | `/chat/completions`、`/v1/messages`、`/v1/messages/count_tokens`、`/responses`、`/v1/models`。 |
| `model` | 请求中的模型名，可为空。 |
| `success` | 1/0。 |
| `failure_reason` | 失败原因或上游 HTTP 状态。 |
| `input_tokens` / `output_tokens` | 从 JSON/SSE usage 字段解析。 |
| `cache_tokens` / `cache_input_tokens` / `cache_write_tokens` | cache token 统计。 |

索引：`idx_proxy_request_stats_identity_time(identity, requested_at DESC)`。每次写入后会按 `REQUEST_STATS_PER_ACCOUNT_LIMIT` 清理该账号旧记录；服务启动时也会清理一次。

`proxy_identity_initializations` 保存带过期时间和唯一 claim ID 的初始化租约。未知 identity 在调用 SSO、SCIM/seat 和 Login 之前必须先取得租约，因此多个 Proxy Pod 不会重复执行外部副作用；旧 Pod 也不能释放新 Pod 的 claim。

授权栅栏只有 `proxy_accounts.copilot_oauth_attempt_id` 一列，不再有单独的回执表：`begin` 把账号切到新 attempt（Login 重试必须带 `previousAttemptId`，与账号当前 attempt 不一致时返回 `409 authorization_conflict`；Console 的手动/批量重新授权则强制切换，作为账号卡在 `refreshing` 时的恢复入口）；token 写回和失败上报都只在账号仍指向该 attempt 时生效，写回还要求状态仍为 `refreshing`，因此"先取消/失败则拒绝迟到写回，先写回则保持成功"。创建 Login 任务的响应丢失时按 attempt 到 Login 核对；核对不了就把该 attempt 标为失败并返回 `502 login_submission_unconfirmed`，已写回的 token 因 attempt 已清空而不受影响。这些都是单条 UPDATE，不需要事务；删除账号仍在事务中进行，事务遇到 `ER_LOCK_DEADLOCK` / `ER_LOCK_WAIT_TIMEOUT` 会回滚并最多重试 2 次。账号批量操作（`/api/enterprises/:enterpriseId/accounts/operations`）的预览与结果只保存在 Proxy 进程内存中（每个企业各自独立），多实例部署下预览与确认需要落到同一实例，否则确认会返回 `404 operation_not_found` 并提示重新预览。

管理查询补充 `GET {e}/accounts/summary`、完整分页 `GET {e}/request-stats?page=&pageSize=&identity=&model=&success=&from=&to=`，仅 `limit` 的请求仍返回数组（`{e}` 即 `/api/enterprises/:enterpriseId`）。账号支持 OAuth 状态和更新时间筛选；`q`/`model` 中的 `%`、`_` 按字面匹配。Request Stats 的范围始终受 retention 限制。账号 `{e}/accounts/operations` 使用 preview / execute / 查询 / export 处理删除与重新授权，复用单项业务及缓存失效；其错误同样经过 `managementErrorHandler`，与其他管理路由返回一致的错误结构。`reauthorize` 必须显式传 `ssoType`（`custom` 或 `azure`），缺省返回 `400 sso_type_required`。Console 的单账号和批量重新授权对话框默认选择 Custom 并显式传入 `custom`；Proxy 不保存账号所属 SSO 提供方，Azure 账号仍需切换为 Azure 并提供覆盖密码，API 不推断提供方。

Accounts、Request Stats、Error Diagnostics 均有 `GET/POST <资源>/export`：全部匹配、`scope=page` 或 POST 已选范围。SQLite 使用独立只读快照连接，MySQL 使用独立 repeatable-read 事务；按页流式输出，下载断开会释放读取资源。诊断导出仅含摘要，在本地/共享模式下先捕获保留摘要，再一致筛选分页，保留共享 clear cutoff 语义。长下载会延长数据库读快照寿命，应避免同时发起大量全量导出。

服务间 `POST /internal/enterprises/:enterpriseId/accounts/:identity/oauth-attempts/:attemptId/prepare`（见 5.5 节）。prepare 校验映射、活动授权及密码模式；默认密码经 SSO 内部只读入口解析，Console 公共 API 无法调用该入口。

SQLite 是默认的单 Pod 模式，不能把同一个 SQLite 文件以 RWX 方式提供给多个 Proxy Pod。MySQL 模式不包含 identity/token 缓存，每个请求直接按主键读取共享数据库。已有 SQLite 数据切换到 MySQL 使用仓库根目录 `upgrade/sqlite-to-mysql` 的显式工具。

### 6.2 错误诊断文本日志

诊断不写入 SQLite/MySQL。单 Pod 模式由 `ErrorDiagnosticsStore` 串行化 append/rotate/clear。共享模式要求所有 Proxy Pod 挂载同一个 RWX 根目录，每个 `PROXY_INSTANCE_ID` 只写自己的子目录，列表与详情跨实例聚合，并使用共享 clear marker 避免删除其他 Pod 正在写入的文件。两种模式都会忽略进程异常退出留下的不完整记录。每条记录使用明确的 BEGIN/END 标记，正文包含：

- `failureKind`: `http`、`fetch` 或 `stream`；
- identity、兼容 API path、model 和时间；
- 客户端原始 method、URL、按顺序保留并逐行显示的 headers、格式化 body 和 curl；
- 实际发送给 Copilot 的 method、URL、生成后的 headers、格式化 body 和 curl；
- 上游 status、headers、完整或截断的 body；
- transport/stream 异常的 name、message、stack 和 cause。

普通 JSON、text、SSE 等 body 直接以 UTF-8 明文保存，可解析 JSON 会缩进格式化。只有压缩或二进制 body 才标记编码并使用 base64。管理页面直接预览同一文本记录，下载文件与磁盘 `.log` 内容一致。

### 6.3 主要领域对象

| 对象 | 来源 | 用途 |
| --- | --- | --- |
| `ProxyAccountRecord` | `src/db/accountsRepo.ts` | 数据库内部账号记录，包含原始 Token。 |
| `ProxyAccountDto` | `@ghcp/shared` | 对外账号状态 DTO，不包含 `copilot_oauth_token`。 |
| `CopilotAuthContext` | `src/copilot/copilotAuth.ts` | identity、OAuth access token 和 Copilot API endpoint。 |
| `ModelInfo` | `src/copilot/copilotClient.ts` | Copilot `/models` 返回的模型对象，保留额外元数据。 |
| `ProxyRequestStatDto` | `@ghcp/shared` | 请求统计返回结构。 |
| `ProxyErrorDiagnosticRecordDto` | `@ghcp/shared` | 完整错误现场；summary/list DTO 用于 Console 分页。 |
| `BatchResult<T>` / `ImportCopilotOauthTokenRow` | `@ghcp/shared` | CSV 验证并导入 Copilot OAuth token 的批处理结果。 |
| `EnsureSsoUserRequest/Response`、`SsoUserDto` | `@ghcp/shared` | Proxy 调 SSO 服务初始化/查询用户。 |
| `CreateLoginTaskRequest`、`LoginTaskDto` | `@ghcp/shared` | Proxy 调 Login 服务创建登录/刷新任务。 |
| `ApiErrorResponse` | `@ghcp/shared` | 管理/鉴权错误的统一 `{ error: { code, message } }` 结构。 |

## 7. 代码结构

```text
src/proxy/
├── package.json                 # workspace 名称与 scripts
├── Dockerfile                   # Proxy 镜像构建入口
├── .env.example                 # 本模块环境变量示例
├── tsconfig.json                # TS 编译到 dist/
└── src/
    ├── index.ts                 # 进程入口，调用 startServer()
    ├── server.ts                # Express app、路由挂载顺序、404 与启动逻辑
    ├── config.ts                # 环境变量读取、默认值、类型校验
    ├── enterprises.ts           # 加载企业 registry（与 env 合并）、按 id 查找企业及其端点
    ├── logger.ts                # proxy scope logger
    ├── auth/                    # API Key、identity header、internal token 中间件
    ├── routes/
    │   ├── compatible.ts        # 公共 Copilot 兼容 API、转发、统计
    │   ├── claudeCodeCompat.ts  # Claude Code 请求预处理与错误适配
    │   ├── anthropicModelProfiles.ts # Claude 模型规范化与 profile
    │   ├── enterprisesApi.ts    # GET /api/enterprises、PATCH .../pool-policy
    │   ├── enterpriseRoutes.ts  # 企业作用域路由挂载、旧 /api/accounts（deprecated）、无作用域 400
    │   ├── accountsApi.ts       # 账号与请求统计（作用域 / 旧直连两种 scope）
    │   ├── operationsApi.ts     # 账号批量删除/重新授权（按企业）
    │   ├── userPoolApi.ts       # 池全局设置与企业作用域的成员/租约/事件
    │   ├── modelsApi.ts         # 企业 Models 页查询
    │   ├── adminApi.ts          # 全局错误诊断接口
    │   └── internalApi.ts       # /internal/enterprises/:id 服务间回调（含 GitHub 身份核对）
    ├── copilot/
    │   ├── copilotAuth.ts       # Copilot OAuth auth context
    │   ├── copilotAuthManager.ts # 账号初始化、OAuth 状态与重新授权
    │   └── copilotClient.ts     # Copilot 模型列表、路径校验、转发 headers
    ├── clients/                 # SSO/Login 服务 JSON client（均按企业作用域）、跨服务 readiness 探测与缓存；响应丢失时按 attempt 到 Login 核对任务是否已接受
    ├── accounts/                # Copilot OAuth token 验证与 CSV 导入
    ├── diagnostics/             # 错误现场构造、人类可读格式、轮转文本 store 与测试
    └── db/                      # SQLite/MySQL provider、迁移、accounts/stats repo
```

`src/packages/shared/src/contracts.ts` 和 `api.ts` 定义 Proxy 与其他服务共享的 DTO、分页、批处理和错误结构。

SQLite/MySQL 的管理列表筛选和稳定排序共用 `src/db/managementQueries.ts` 的 `managementSql()`，存储实现不再各自维护排序字段映射。Login 提交响应不确定时，客户端仍通过 `getLoginTaskByAttempt()` 核对是否已接受任务；移除未使用的按任务 ID 查询包装不影响服务端查询接口。

## 8. 开发提示

- 看入口：从 `src/index.ts` -> `src/server.ts` 开始，先理解路由挂载顺序：`/healthz`、`/readyz` 无鉴权；`/api/enterprises`、`/api/enterprises/:enterpriseId`、全局 `/api` 路由、`/internal/enterprises/:enterpriseId` 走内部鉴权，其余无作用域的 `/api`、`/internal` 返回 400；其余公共请求先 API Key 再 identity。
- 排查企业：启动日志的 `[proxy] enterprise <id>: ...` 行列出每个企业的 GitHub/Copilot 地址和阻塞项；企业未就绪时看 `GET /api/enterprises` 中的 `readiness.blockers`。
- 排查账号初始化：看 `copilotAuthManager.getAuth()`；未知 identity 的第一次请求通常返回 202，同时后台创建 SSO/Login 流程。
- 排查转发失败：先从控制台错误摘要取得 `diagnosticId`，在 Console **Error Diagnostics** 查看/下载现场，再看 `compatible.ts` 的 `handleForward()`、`forwardAuthenticated()` 和 `copilotClient.assertModelSupportsPath()`。
- 排查 Claude Code：确认 `CLAUDE_CODE_OPTIMIZED=true`，再看 `claudeCodeCompat.ts` 的 body 预处理、token count fallback 和 Files/WebSearch 错误适配。
- 排查数据：优先查看管理接口 `/api/enterprises/<id>/accounts`、`/api/enterprises/<id>/request-stats`，企业状态看 `/api/enterprises`；不要在响应中暴露数据库内的原始 Token。
- 扩展新 Copilot 路径时，至少同步更新 `COPILOT_FORWARD_PATHS`、`compatible.ts` 路由、模型路径推断、`ProxyRequestStatDto.path`、SQLite/MySQL 统计语义和本文档。
- 新增配置时，同时更新 `config.ts`、`src/proxy/.env.example` 和本 README；若配置影响其他服务，也要检查 shared contracts 或调用客户端。
- 本模块提供 `test` 脚本；改代码后运行 `npm --workspace @ghcp/proxy run test` 和 `npm --workspace @ghcp/proxy run typecheck`，涉及 shared 类型时也运行 shared typecheck。
- MySQL 集成测试使用 `MYSQL_TEST_URL` 并通过 `npm --workspace @ghcp/proxy run test:mysql` 执行；该账号需要迁移权限。可额外设置 `MYSQL_TEST_RUNTIME_URL`，指向同一测试库的低权限账号，仅授予三张业务表的读写权限、不授予 `CREATE`、`ALTER` 或迁移历史表权限，以验证关闭迁移后的初始化和业务操作。测试会清理三张业务表，必须使用专用测试库，不能连接业务数据库。
