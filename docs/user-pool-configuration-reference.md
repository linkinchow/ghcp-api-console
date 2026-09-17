# User Pool 生产配置完整清单与默认值

核对日期：2026-09-17。依据当前源码配置解析器、运行时 Settings、Compose 和 LiteLLM 接入代码；**不是客户当前部署值**。没有读取客户 `.env`、Secret 或数据库。本文用于逐项评审，不代表推荐直接修改全部默认值。

## 1. 先区分默认值和生效方式

- **启动配置**：进程启动时读取，改环境变量后需重新创建容器/Pod。修改宿主机 `.env` 不会自动更新已有容器。
- **首次种子**：只有首次创建数据库设置行时使用；已有数据库以持久化值为准。
- **在线 Settings**：通过带 `expectedVersion` 的 API/UI 修改并持久化；不是环境变量。
- **MySQL 池不变量**：写入配置指纹。已有池不能只改环境变量重启，所有副本必须一致且与数据库指纹匹配。
- **Compose 输入**：只控制 YAML 插值；只有被 environment/ports/volumes 引用的值才会生效。
- **源码常量**：没有生产环境变量入口，修改需要代码变更和验证。

布尔值通常接受大小写不敏感的 `1/true/yes/on`、`0/false/no/off`；前后空格或空值可能被拒绝。池数值要求十进制数字和安全整数，不能写单位、负数、小数或科学记数法。普通 Proxy 正整数解析没有显式业务上限，不等于任意大值都合理。

## 2. User Pool：优先评审

仅 `ACCOUNT_ROUTING_MODE=caller-lease` 时使用池参数。设置为 direct 时池专用参数被忽略。

| 变量 | 代码默认值 | 允许范围 | 含义 | 修改方式 |
| --- | --- | --- | --- | --- |
| `ACCOUNT_ROUTING_MODE` | `direct` | `direct` / `caller-lease`，精确小写 | direct 按原 identity 取账号；caller-lease 按可信 key hash 分配排他成员 | 启动配置；不是数据库迁移开关 |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | 无可用默认，启用池时必填 | 合法域名，最多253字符；小写标准化 | 新池成员邮箱域名，不是 caller 身份 | MySQL 不变量；SQLite 也校验已保存域名 |
| `READY_IDLE_TARGET` | `10` | 0–10000，且不大于 cap | 希望维持的就绪空闲储备 | 首次种子；已有池改 UI 的 Ready idle target |
| `POOL_MAX_ACCOUNTS` | `100` | 1–10000 | 全部池成员增长上限，包括非 Ready 状态；降低不删号 | 首次种子；已有池改 UI 的 Maximum accounts |
| `CALLER_LEASE_TTL_SECONDS` | `172800`秒，48小时 | 60–2592000秒，最多30天 | 完整成功推理后的正式租约 TTL | 首次种子；已有池改 UI 的租约 TTL |
| `PROVISIONAL_LEASE_TTL_SECONDS` | `300`秒 | 10–3600秒 | 新 caller 尚未完整成功时的临时租约期限 | MySQL 不变量 |
| `PREWARM_POLL_SECONDS` | `5`秒 | 1–3600秒 | 后台周期轮询间隔；另有事件唤醒 | MySQL 不变量 |
| `PREWARM_CONCURRENCY` | `5` | 1–20 | 单个活跃调度器同时执行的账号阶段数，不是浏览器数量 | MySQL 不变量；现有离线工具可受控调整 |
| `POOL_LOGIN_MAX_PENDING` | `5` | 1–100 | 池中尚未明确结束的 Login 派发/等待预留上限，不是 Login 实际并发 | MySQL 不变量；现有离线工具可受控调整 |
| `POOL_EXHAUSTED_RETRY_AFTER_SECONDS` | `30`秒 | 1–3600秒 | `pool_exhausted` 的 Retry-After；也用于缺少有效上游时间时的默认冷却 | MySQL 不变量 |
| `POOL_WARMUP_MODEL` | 无可用默认，启用池时必填 | 非空模型名 | 新账号凭据验证所用模型；模型必须实际可用 | MySQL 不变量 |
| **`POOL_INFERENCE_TIMEOUT_SECONDS`** | **未设置，回退到旧请求时限** | **5–600秒，需包含本次改动的新版镜像** | **只控制Messages/Chat/Responses真实推理请求的总时限与hold；不改变目录、count_tokens或后台预算** | **启动配置，独立于PoolConfig和MySQL指纹；仅支持该参数的新镜像生效** |
| **`POOL_REQUEST_TIMEOUT_SECONDS`** | **`120`秒** | **5–600秒** | **从进入池准入到完整响应结束的总截止时间，包含等待和流式输出；持续收到数据不会重置计时**。还用于 hold 和后台预配请求预算 | **MySQL 不变量，当前离线并发工具不能调整此项** |

### 2.1 关于请求超时的准确解释

当前 120 秒默认是应用主动设置，不是 Copilot、MySQL 或 NGINX 要求。到期后主动中止请求：未发响应头时返回 504 `pool_request_timeout`，已经流式输出时中止连接，日志可出现 `Pool request deadline exceeded` 或 `Upstream stream failed (...): Pool request deadline exceeded`。

例如第20秒开始输出、之后每秒都有数据，若第120秒仍未结束，也会被截断。不是“连续120秒没有输出”的空闲超时。部分输出可能已经产生上游用量，不可视为未执行而自动重放。

- 不设置：仍为120秒，不会无限等待。
- `0`：配置错误，不是无限。
- `3600`：当前超过600上限，配置错误；目前未实现一小时配置。
- 600秒上限是本项目保守边界，不是外部技术硬限制或已验证最佳值。
- 调大参数同时影响后台预配/HTTP等待和占用截止时间，不能只把它当作浏览器或模型流的独立选项。
- 对已上线MySQL，推荐兼容版Proxy使用独立 `POOL_INFERENCE_TIMEOUT_SECONDS=600`，旧 `POOL_REQUEST_TIMEOUT_SECONDS` 保留原值，不改指纹或停库。该能力包含在本次源码提交，Proxy回归及Azure真实新旧共库Messages长流、MySQL专项验证通过；客户需从该版本构建新镜像，旧镜像不支持。详见[600秒生产操作手册](user-pool-request-timeout-change-plan.md)。
- 现有 MySQL 池改旧参数值会遇到指纹不匹配。当前维护工具只支持 `PREWARM_CONCURRENCY` 和 `POOL_LOGIN_MAX_PENDING`，不支持该旧超时；不得手工改指纹或清 owner/hold 强行通过。
- 即使未来支持调整，LiteLLM、SDK、前置代理和进程关闭时限仍可能更短，必须一并核对。

### 2.2 已持久化的池设置

| API/数据库字段 | 初始值 | 可修改范围 | 实际作用 |
| --- | --- | --- | --- |
| `idle_target` | 上面的种子，默认10 | 0–10000，≤max_accounts | 在线补池目标，不是保证立刻有这么多空闲 |
| `max_accounts` | 默认100 | 1–10000，≥idle_target | 限制继续增长，不自动删号缩池 |
| `lease_seconds` | 默认172800 | 60–2592000秒 | 用于后续成功请求续租，不立即统一改写旧到期时间 |
| `paused` | `0` | 0/1 | 暂停新的补池/修复调度，不停止正常推理，不保证已开始的阶段立即终止 |
| `version` | `1` | 非手工配置项 | 乐观并发版本；提交旧版本返回409 |

这四个业务设置在 User pool 页面修改；不要以为改启动 env 会覆盖迁入的数据。域名、临时 TTL、轮询、两个并发、耗尽 Retry-After、预热模型、请求总时限属于 MySQL 指纹不变量。

依据：[池配置](../src/proxy/src/userPool/config.ts)、[请求总时限](../src/proxy/src/userPool/runtime.ts)、[MySQL 初始化/指纹](../src/proxy/src/userPool/mysqlStore.ts)、[现有并发维护工具](../upgrade/user-pool-mysql/reconfigure-concurrency.ts)。

## 3. Proxy 通用启动配置

| 变量 | 代码默认值 | 范围/要求 | 用途 |
| --- | --- | --- | --- |
| `PORT` | `3000` | 1–65535 | HTTP 监听端口 |
| `STORAGE_DRIVER` | `sqlite` | sqlite/mysql | 仅选择 Proxy 存储；不会自动迁移数据，也不迁移 SSO/Login |
| `DB_PATH` | `./data/proxy.sqlite` | 可写路径 | SQLite 文件；MySQL 模式不使用它 |
| `API_KEY` | 空 | 生产必配的服务密钥 | LiteLLM→Proxy 业务鉴权；空值不代表关闭鉴权 |
| `INTERNAL_API_TOKEN` | 空 | 生产必配的共享内部密钥 | Proxy/SSO/Login/Console 内部鉴权 |
| `IDENTITY_HEADER` | `X-User-Identity` | 请求头名称 | caller/direct 身份头；修改它不会自动修改 LiteLLM Hook |
| `IDENTITY_HEADER_REQUIRED` | `true` | 布尔 | 缺 identity 是否拒绝；false 的 direct 默认 identity 不符合池 hash 格式 |
| `IDENTITY_INIT_LEASE_SECONDS` | `900`秒 | 正整数 | 旧 direct 账号初始化数据库认领期，防止重复初始化，不是池租约 |
| `CLAUDE_CODE_OPTIMIZED` | `false` | 布尔 | Claude Code 兼容默认开关，可由对应请求头覆盖；影响模型目录/兼容处理及 count_tokens |
| `SSO_BASE_URL` | `http://localhost:7001` | 实际内部服务根地址 | Proxy 调用 SSO，不带 `/api` |
| `LOGIN_BASE_URL` | `http://localhost:7003` | 实际内部服务根地址 | Proxy 调用 Login，不带 `/api` |
| `ENTERPRISE_SHORTCODE` | `octo` | 企业实际短码 | GitHub EMU 用户名关联后缀 |
| **`REQUEST_STATS_PER_ACCOUNT_LIMIT`** | **`2`** | 正整数，0无效 | 每个账号保留最近请求统计条数；启动和写入都会删超额历史，不是页面显示条数 |
| `COPILOT_API_BASE_URL` | `https://api.githubcopilot.com` | 上游 API 根地址 | 模型目录、验证、推理和预热 |
| `OPENCODE_VERSION` | `1.0.0` | 非空版本字符串，无semver校验 | 构造默认 User-Agent，不控制本应用版本 |
| `OPENCODE_USER_AGENT` | `opencode/<OPENCODE_VERSION>` | 非空字符串优先 | 显式覆盖整个上游 User-Agent |
| `GITHUB_API_VERSION` | `2026-06-01` | API版本字符串 | 上游版本请求头，不保证任意日期受支持 |
| `LOG_LEVEL` | `info` | debug/info/warn/error；无效回退info | 四组件共享的结构化日志等级 |

caller-lease 启动要求 API_KEY、INTERNAL_API_TOKEN 非空。普通字符串多数不校验 URL；解析通过不等于可连接。相对路径按进程工作目录解析。

## 4. MySQL 连接配置

| 变量 | 代码默认值 | 范围/要求 | 用途 |
| --- | --- | --- | --- |
| `MYSQL_URL` | 未设置 | mysql 模式必填 | 完整连接串，包含用户名、URL编码密码、主机、端口和数据库；用 Secret 管理 |
| `MYSQL_CONNECTION_LIMIT` | `10` | 正整数，没有额外数值上限 | 每个 Proxy 的连接池上限；不是并发用户数或流数量 |
| `MYSQL_SSL_MODE` | `disabled` | disabled/required/verify-ca | disabled不加密；required加密但不验证证书；verify-ca使用CA验证证书 |
| `MYSQL_SSL_CA_PATH` | 未设置 | verify-ca必填可读文件路径 | 容器内的MySQL CA文件，与SAML证书不同 |

多个独立池可使用一个MySQL实例、多个数据库；同一池的副本必须使用同一个库。需要汇总所有池、副本及滚动增量的连接额度。不要使用读副本/读写分离地址替代统一写主库。

这些是运行时配置。迁移器对非本机连接更严格：必须 verify-ca，且显式校验主机名；其默认连接数3、允许3–100。不要将两者的默认值混淆。当前 Proxy 的 verify-ca 不能描述为已实现完整主机名验证。

依据：[Proxy 配置](../src/proxy/src/config.ts)、[MySQL 连接](../src/proxy/src/db/connection.ts)。

## 5. Proxy 错误诊断

| 变量 | 代码默认值 | 范围/要求 | 用途和评审重点 |
| --- | --- | --- | --- |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED` | `true` | 布尔 | 保存错误诊断；可能包含请求/响应内容 |
| `PROXY_ERROR_DIAGNOSTICS_DIR` | `./data/error-diagnostics` | 可写目录 | 诊断文件位置，不随 DB_PATH 自动改变 |
| **`PROXY_ERROR_DIAGNOSTICS_REDACT`** | **`false`** | 布尔 | 是否脱敏；生产应特别审查默认不脱敏的风险 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB` | `50` | 正整数，实际单位MiB | 单文件轮转阈值；超大单条记录可能超出阈值 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILES` | `5` | 正整数 | 包括当前文件的保留数量；共享模式按实例目录轮转 |
| `PROXY_ERROR_DIAGNOSTICS_SHARED` | `false` | 布尔 | 共享卷场景按实例隔离目录，不会替你创建共享存储 |
| `PROXY_INSTANCE_ID` | HOSTNAME，否则proxy | 路径安全标识，最终≤120字符 | 共享诊断实例标识，需要每个写入者唯一 |
| `HOSTNAME` | 未设置时回退proxy | 通常容器平台注入 | PROXY_INSTANCE_ID 的后备来源 |

共享实例标识会标准化；路径分隔符、`..`、空或过长结果被拒绝。User Pool Compose overlay 和客户K8s模板明确关闭诊断并开启脱敏，**不等于应用代码默认值已经改变**。

## 6. SSO 启动环境变量

| 变量 | 代码默认值 | 要求/含义 |
| --- | --- | --- |
| `PORT` | `7001` | 1–65535，HTTP监听 |
| `DB_PATH` | `./data/sso.sqlite` | SSO独立SQLite，需要持久卷 |
| `BASE_URL` | `http://localhost:7001` | 公开IdP地址，生成metadata/SSO/logout地址；生产填实际HTTPS入口 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 该套池自己的内部Proxy地址，不走按业务hash分流的网关 |
| `INTERNAL_API_TOKEN` | 空 | 内部鉴权密钥，生产必配 |
| `SESSION_SECRET` | `dev-secret-change-me` | Session签名密钥，生产必须替换 |
| `SSO_DEFAULT_USER_PASSWORD` | 未设置 | 普通新用户缺省可能退回用户名；池用户要求配置值trim后至少16字符、不能等于用户名。密钥配置，不是Settings |
| `SSO_USER_EVENTS_LOG` | `./data/sso-user-events.log` | 用户事件追加日志，需安排保留和轮转 |
| `ENTERPRISE_SLUG` | `acme` | GitHub企业标识，生产不能沿用示例 |
| `ENTERPRISE_SHORTCODE` | `octo` | 企业用户短码 |
| `GITHUB_API_BASE_URL` | `https://api.github.com` | GitHub API根地址 |
| `GITHUB_COPILOT_SEAT_PAT` | 未设置 | 席位及AI Credits接口凭据，相关操作必配 |
| `SCIM_BASE_URL` | 空；下游回退到mock地址 | 实际企业SCIM地址，生产必须显式填写 |
| `SCIM_TOKEN` | 空 | SCIM Bearer凭据，相关操作必配 |
| `CERT_DIR` | `../../certs` | 需含 idp-cert.pem 和 idp-key.pem，保护私钥 |
| `SP_ENTITY_ID` | 空；有效回退 `https://github.com/enterprises/<slug>` | SAML服务提供方标识 |
| `SP_ACS_URL` | 空；有效回退mock consume地址 | SAML断言目标，生产必须填实际值 |
| `MOCK_GITHUB_BASE_URL` | `http://localhost:8002` | 开发mock回退地址，不是生产上游替代值 |
| `LOG_LEVEL` | `info` | 共享日志等级 |

依据：[SSO 配置](../src/sso/src/config.ts)。

### 6.1 SSO Settings：首次默认，在线修改

| API/UI字段 | 数据库字段 | 首次默认 | 范围 | 用途 |
| --- | --- | --- | --- | --- |
| `maxSsoUsers` | max_sso_users | `null` | null或1–1000000 | SSO用户总量上限；null无上限，降低不删旧用户 |
| `userPrefix` | user_prefix | `user` | 标准化后非空，最多32字符 | 缺省用户名生成前缀，不改变旧用户名 |
| `emailDomain` | email_domain | `customsso.com` | 合法域名，最多253字符 | 普通用户缺省邮箱域名，不改变旧数据 |
| `bulkSyncConcurrency` | bulk_sync_concurrency | `3` | 1–20 | 批量sync_emu并发，不是Pool阶段并发 |
| `scimRequestDelayMs` | scim_request_delay_ms | `250`ms | 0–60000ms | 同一SSO进程的SCIM请求启动间距；不是集群全局限速 |
| `scimMaxRetries` | scim_max_retries | `3`次重试 | 0–10 | 默认最多4次尝试，处理部分网络/限流/服务端错误 |
| `scimRetryBaseDelayMs` | scim_retry_base_delay_ms | `1000`ms | 0–60000ms | 没有Retry-After时指数退避，指数等待上限30000ms |

上游 Retry-After 替代指数等待，不受30000ms指数上限限制。SCIM fetch 没有单独的环境变量总超时，这些参数不能等同为请求超时。已有Settings不会被环境变量重置。

依据：[SSO Settings](../src/sso/src/db/runtimeSettingsRepo.ts)、[SCIM客户端](../src/sso/src/scim/scimClient.ts)。

## 7. Login 启动环境变量

| 变量 | 代码默认值 | 要求/用途 |
| --- | --- | --- |
| `PORT` | `7003` | 1–65535，HTTP监听 |
| `DB_PATH` | `./data/login.sqlite` | Login任务独立SQLite，需持久化 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 该套池自己的OAuth回调根地址 |
| `INTERNAL_API_TOKEN` | 空 | 内部鉴权/回调密钥 |
| `LOG_DIR` | `./logs/login` | 按账号记录Login日志 |
| `GITHUB_OAUTH_CLIENT_ID` | `Ov23li8tweQw6odWQebz` | Device Flow公开客户端标识，不是秘密 |
| `GITHUB_OAUTH_SCOPE` | `read:user` | 申请的OAuth scope |
| `OPENCODE_VERSION` | `1.0.0` | 默认User-Agent版本 |
| `OPENCODE_USER_AGENT` | `opencode/<version>` | 显式值覆盖默认User-Agent |
| `SSO_URL` | 未设置 | 默认预期SSO登录地址，任务值可覆盖 |
| `SSO_PROVIDER` | `custom` | custom/azure，大小写标准化；任务ssoType优先 |
| `AZURE_STAY_SIGNED_IN` | `false` | 是否选择Azure保持登录 |
| `AUTH_HEADLESS` | `true` | Chromium无头运行 |
| `AUTH_DEBUG_ARTIFACT_DIR` | `.auth-debug` | 调试产物目录；单独配置目录不等于启用产物 |
| `LOG_LEVEL` | `info` | 共享日志等级 |

### 7.1 浏览器选择器覆盖

以下15项均**默认未设置**。填写合法浏览器选择器后优先尝试，然后使用内置后备定位；任务 `selectorOverrides` 比环境变量优先。一般无需调整，仅页面变化时验证后覆盖。

| 环境变量 | 对应控件 |
| --- | --- |
| `AUTH_DEVICE_CODE_INPUT_SELECTOR` | Device Code输入 |
| `AUTH_DEVICE_CODE_SUBMIT_SELECTOR` | Device Code提交 |
| `AUTH_GITHUB_LOGIN_INPUT_SELECTOR` | GitHub用户名输入 |
| `AUTH_GITHUB_LOGIN_SUBMIT_SELECTOR` | GitHub登录提交 |
| `AUTH_GITHUB_SSO_SUBMIT_SELECTOR` | GitHub企业SSO入口 |
| `AUTH_GITHUB_AUTHORIZE_SUBMIT_SELECTOR` | GitHub授权确认 |
| `AUTH_SSO_USERNAME_INPUT_SELECTOR` | 自定义SSO用户名 |
| `AUTH_SSO_PASSWORD_INPUT_SELECTOR` | 自定义SSO密码 |
| `AUTH_SSO_SUBMIT_SELECTOR` | 自定义SSO提交 |
| `AUTH_AZURE_USERNAME_INPUT_SELECTOR` | Azure用户名 |
| `AUTH_AZURE_NEXT_SUBMIT_SELECTOR` | Azure下一步 |
| `AUTH_AZURE_PASSWORD_INPUT_SELECTOR` | Azure密码 |
| `AUTH_AZURE_SIGN_IN_SUBMIT_SELECTOR` | Azure登录 |
| `AUTH_AZURE_STAY_SIGNED_IN_YES_SELECTOR` | Azure保持登录“是” |
| `AUTH_AZURE_STAY_SIGNED_IN_NO_SELECTOR` | Azure保持登录“否” |

### 7.2 Login Settings：首次默认，在线修改

| API/UI字段 | 数据库字段 | 首次默认 | 范围 | 用途 |
| --- | --- | --- | --- | --- |
| `concurrency` | concurrency | `1` | 1–20 | 实际浏览器任务并发，调低不终止已运行任务 |
| `authTimeoutMs` | auth_timeout_ms | `60000`ms | 5000–600000ms | Playwright动作、导航和相关等待的超时；**不是整次OAuth任务总时限，也不是模型请求时限** |
| `authDebugLogs` | auth_debug_logs | `false` | 布尔 | 新启动任务的详细认证日志 |
| `authDebugArtifacts` | auth_debug_artifacts | `false` | 布尔 | 新启动任务的trace/截图等，可能包含敏感内容 |

正在执行的任务保留启动时快照，新任务使用最新Settings。GitHub device token轮询遵循上游expires_in/interval，不受authTimeoutMs统一封顶；浏览器启动也不是该参数控制。任务历史没有独立自动保留数量设置。

SSO/Login Settings缓存和Login队列是进程内的，不因共用SQLite就成为多副本分布式服务，因此仍保持单实例。

依据：[Login 配置](../src/login/src/config.ts)、[Login Settings](../src/login/src/db/runtimeSettingsRepo.ts)。

## 8. Console 启动配置

| 变量 | 代码默认值 | 要求/用途 |
| --- | --- | --- |
| `PORT` | `7004` | 1–65535，HTTP监听 |
| `ADMINS_FILE` | `./data/admins.json` | 管理员JSON文件，含密码hash和权限；错挂空卷会重新出现初始化流程 |
| `SESSION_SECRET` | `dev-secret-change-me` | Cookie签名密钥，生产必须替换 |
| `INTERNAL_API_TOKEN` | 空 | Console访问各服务内部API的共享密钥 |
| `PROXY_BASE_URL` | `http://localhost:3000` | 本套池Proxy内部根地址 |
| `SSO_BASE_URL` | `http://localhost:7001` | SSO内部根地址 |
| `LOGIN_BASE_URL` | `http://localhost:7003` | Login内部根地址 |
| `LOG_LEVEL` | `info` | 共享日志等级 |

没有通过环境变量配置初始管理员账号/密码的入口，初次由UI/API设置。Session有效期8小时是源码固定值，不是上述变量之一。

依据：[Console配置](../src/console/src/server/config.ts)。

## 9. LiteLLM 接入配置

这些值配置在 **LiteLLM**，不是 GHCP Proxy。

| 变量/设置 | 默认 | 用途 |
| --- | --- | --- |
| `GHCP_POOL_API_BASES` | 无；缺失时Hook启动失败 | 逗号分隔的GHCP实际出站根地址，精确匹配URL。前面有NGINX时填NGINX入口 |
| `GHCP_POOL_API_BASE` | YAML没有默认 | 模型配置示例的api_base；不是Hook自己读取的变量 |
| `GHCP_PROXY_API_KEY` | 无 | LiteLLM访问GHCP业务接口的服务密钥，不是virtual key |
| `ALLOWED_HASH_PREFIXES` | 源码常量 `"0"` | 灰度按hash首位放行；012为0/1/2，空为不放行，全16字符为全放行。**不是环境变量，不热加载** |
| `callbacks` | 示例显式设置 | 原身份Hook或灰度Hook二选一，不能再同时装旧metadata Hook |
| `cache` | 示例false | 关闭完整响应缓存；不是上游Prompt Cache开关 |
| `set_verbose` | 示例false | 不启用LiteLLM详细调试 |
| `turn_off_message_logging` | 示例true | 控制消息日志 |
| `num_retries` / 模型 `max_retries` | 示例0 | 不自动重试推理 |
| `fallbacks` / `context_window_fallbacks` / `content_policy_fallbacks` | 示例空列表 | 不自动启用回退；不要盲目覆盖其他提供方的策略 |

只列本项目接入涉及的LiteLLM设置，不声称穷尽整个上游LiteLLM软件的配置。灰度Hook的真实运行修正/测试状态见[灰度说明](user-pool-litellm-canary.md)。

## 10. Compose、构建和K8s专用输入

下面不与前面的应用环境变量重复计数。

| 输入 | 默认/要求 | 用途 |
| --- | --- | --- |
| `PROXY_PORT` | 3000 | Compose宿主机映射端口，容器PORT仍3000 |
| `SSO_PORT` / `LOGIN_PORT` / `CONSOLE_PORT` | 7001 / 7003 / 7004 | 各服务宿主机映射端口 |
| `SSO_PUBLIC_BASE_URL` | Compose必填 | 映射为SSO的BASE_URL |
| `SSO_CERT_DIR` | ./certs | 宿主机证书目录，挂到容器/certs |
| `LOGIN_SSO_URL` | http://sso:7001/login | 映射为Login SSO_URL |
| `LOGIN_SSO_PROVIDER` | custom | 映射为Login SSO_PROVIDER |
| `PROXY_CLUSTER_BASE_URL` | MySQL overlay必填 | SSO/Login/Console使用的同一池内部负载均衡地址 |
| `PROXY_REPLICAS` | MySQL overlay为2 | Compose副本数，不是池数量 |
| `MYSQL_DATABASE` | 本地MySQL overlay为ghcp_proxy | 容器数据库首次初始化名；托管MySQL由DBA建库 |
| `MYSQL_USER` | 本地overlay为ghcp_proxy | 本地镜像初始数据库用户 |
| `MYSQL_PASSWORD` | 本地overlay为ghcp_proxy_local | **测试示例密码，生产不能用** |
| `MYSQL_ROOT_PASSWORD` | 本地overlay为ghcp_root_local | **测试示例密码，生产不能用** |
| `MYSQL_PORT` | 本地overlay为3306 | MySQL容器宿主机发布端口，不会自动改MYSQL_URL |
| `NPM_REGISTRY` | Dockerfile为https://registry.npmjs.org/ | 构建包源；本环境应使用批准的https://packagefeedproxy.microsoft.io/npm/ |
| `npm_config_registry` | NPM_REGISTRY | Dockerfile构建参数，交给npm校验 |
| `npm_config_fetch_retries` | 2 | 构建时npm重试次数 |
| `npm_config_fetch_timeout` | 60000ms | 构建时npm获取包超时 |
| `npm_config_loglevel` | warn | 构建时npm日志等级 |
| `CUSTOMER_PAUSED_DATABASE_APPROVED` | K8s模板为BLOCKED | 操作员导入后确认门禁，确认后设字符串true；不是数据库pause设置，不会自动检查目标库 |

**默认差异：**

- `CLAUDE_CODE_OPTIMIZED`：代码false，根Compose和示例true。
- `OPENCODE_VERSION`：代码/Compose回退1.0.0，根和Proxy示例1.18.4，Login示例1.84.0；必须核对实际部署，不同来源不是同一个默认。
- Compose把路径改为/data、/logs、/certs，把服务URL改为容器DNS；代码localhost默认不适合服务分容器部署。
- 根`.env`里的GHCP_POOL_API_BASE(S)没有转发给独立LiteLLM，不能据此认定网关已配置。
- Login选择器和AZURE_STAY_SIGNED_IN没有被根Compose自动透传，单独加到宿主机.env不会生效。
- `src/proxy/.env.example` 当前把 MYSQL_SSL_MODE 写成 `disabled | required | verify-ca`，这是列举字符串，**不能直接作为变量值运行**，必须选择一个模式。

## 11. 新增NGINX路由组件的配置面

尚未提交的独立组件配置，不是GHCP应用env：

| 设置 | 当前模板值 | 说明 |
| --- | --- | --- |
| backends | 必填5个独立host:port | 每套独立池的Service，不带协议/路径 |
| trustedCidrs | 必填明确来源CIDR | 配合NetworkPolicy；禁止0.0.0.0/0和::/0 |
| hash范围 | 0–3/4–6/7–9/a–c/d–f | 固定到五个后端，不按负载重分配 |
| worker_connections | 512 | 单worker连接预算，入站和上游都占连接；不是用户容量 |
| listen | 8080 | NGINX内部监听 |
| client_max_body_size | 16m | 请求体上限 |
| client_body_timeout | 60s | 读取请求体空闲超时 |
| keepalive_timeout | 65s | 客户端空闲keepalive连接超时 |
| proxy_connect_timeout | 5s | 建立上游连接超时 |
| proxy_read_timeout / proxy_send_timeout / send_timeout | 各300s | 相邻读/写操作的空闲超时，不是总请求时限 |
| worker_shutdown_timeout | 300s | NGINX优雅退出上限 |
| upstream keepalive | 32 | 每upstream每worker保留空闲连接数量，不是总连接限制 |
| replicas | K8s模板2 | 路由器副本；五个后端池与其无关 |

## 12. 不是可配置环境变量的关键边界

以下是当前源码常量，避免继续误认为都能通过env改：

- 名字容量1000基础名×10后缀＝10000。
- 账号池租约/hold心跳约5秒；hold绝对截止时间外10秒清理宽限。
- MySQL普通操作共享5秒预算；DDL/迁移启动上限60秒；mysql2原生队列上限1024。
- 本地同caller准入最多32个排队、进程保留票据最多1024。
- Proxy进程收到关闭信号后约25秒强制关闭剩余连接；仅增大K8s grace period不会自动延长它。
- SSO和Login的SQLite/runtime缓存、Login进程内队列仍要求各单实例。
- Console Session约8小时；Login任务历史没有自动保留条数设置。

## 13. 建议优先审查的默认值

1. **POOL_REQUEST_TIMEOUT_SECONDS=120**：真实长流可能被截断，优先评估总时限与空闲时限是否应分离；MySQL修改需维护路径。
2. **REQUEST_STATS_PER_ACCOUNT_LIMIT=2**：排查历史通常不足；增大前确认存储/查询成本，所有Proxy统一。
3. **诊断默认开启且不脱敏**：生产按实际模板关闭或启用脱敏并控制访问/保留。
4. **MYSQL_SSL_MODE=disabled**：生产显式配置verify-ca，避免误用裸代码默认。
5. **SSO maxSsoUsers=null**：没有SSO总量护栏，需与已批准库存容量一起规划。
6. **Login concurrency=1** 与两个Pool并发默认5：职责不同，需按浏览器资源和观察结果协调，不是全都设成同一个数。
7. **示例域名、默认Session密钥、普通用户密码回退**：不能当作生产可接受值。

本文只完成源码盘点，没有修改这些默认值、客户配置或数据库指纹。测试专用变量、调试CLI输入和上游依赖的全部通用环境变量不列入生产清单。
