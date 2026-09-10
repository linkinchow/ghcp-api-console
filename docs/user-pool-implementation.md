# GHCP User Pool — 实现与运维文档

更新日期：2026-09-11

分支：`ghcp-user-pool`
范围：Docker fork，单 Proxy + SQLite；不修改 AKS 部署。

> 本文描述当前实现和配置方式，替代早期 key alias、100×100 命名和串行预热说明。已加入有限并发、401自动恢复及真实Responses/补池测试结果；默认值、mock配置与真实测试配置分别说明。旧客户请先阅读[存量Docker升级手册](user-pool-upgrade-guide.md)，不要直接覆盖数据卷或开启pool。

配套：[设计文档](user-pool-design.md) · [待办清单](user-pool-todo.md) · [LiteLLM 详细接入契约](user-pool-litellm.md)

## 1. 当前实现摘要

- Caller：已认证 LiteLLM key hash，header 固定为 `sha256:<64位小写hex>`，不使用 alias/email。
- 路由：单默认池，排他 caller lease；无 HRW、session ID、team pool。
- 租约：首次默认300秒 provisional，完整成功后立即升级/续租，正式默认172800秒。
- 无空闲：429 `pool_exhausted` + `Retry-After`，不在请求路径为 caller 开户。
- 预热：计算完整缺口、事务内预占候选、最多5个并发阶段（可配置1–20）。
- 命名：1,000个固定合成基础姓名 × 后缀 `00..09`；邮箱域名参数化。
- Login：独立的运行时并发设置，代码默认1、上限20；mock浏览器测试设为5，真实端到端测试仍为1。
- Token：Pool请求401后有界后台自动重新授权，失败超限才要求人工Retry；Direct不变。未实现expires_in主动刷新或refresh-token grant。

## 2. 代码模块与数据表

| 模块 | 职责 |
| --- | --- |
| [config.ts](../src/proxy/src/userPool/config.ts) | pool opt-in、配置校验、caller hash 格式 |
| [names.ts](../src/proxy/src/userPool/names.ts) / [nameCatalog.json](../src/proxy/src/userPool/nameCatalog.json) | 稳定姓名目录、ordinal 到候选账号名 |
| [store.ts](../src/proxy/src/userPool/store.ts) | SQLite 原子分配、预占、holds、generation、配置及事件 |
| [worker.ts](../src/proxy/src/userPool/worker.ts) | 单 owner、缺口登记、有限并发阶段调度、退避与停止 |
| [provisioner.ts](../src/proxy/src/userPool/provisioner.ts) | SSO、SCIM、席位、OAuth 任务和模型 warmup |
| [runtime.ts](../src/proxy/src/userPool/runtime.ts) | 启停、请求身份替换、超时和请求结束处理 |
| [compatible.ts](../src/proxy/src/routes/compatible.ts) | 协议转发、上游错误、成功判定和调用统计 |
| [responseCompletion.ts](../src/proxy/src/userPool/responseCompletion.ts) | JSON/SSE 完成与错误识别 |
| [userPoolApi.ts](../src/proxy/src/routes/userPoolApi.ts) | 内部管理 API、校验与安全 DTO |
| [UserPoolPage.tsx](../src/console/src/web/pages/UserPoolPage.tsx) | Console 管理页面 |
| [user_pool_hook.py](../litellm/user_pool_hook.py) | 认证阶段捕获 hash、选定 deployment 后注入 |

SQLite 使用 WAL、foreign keys、busy timeout，关键写操作用 immediate transaction。外部网络操作不放在事务中。

| 表 | 用途 |
| --- | --- |
| `user_pool_settings` | version、idle_target、max_accounts、lease_seconds、paused、名称游标、owner |
| `user_pool_accounts` | 成员、ordinal、state/stage、worker attempt、OAuth attempt、任务、重试、verified_at、generation |
| `user_pool_leases` | caller 唯一、member 唯一、lease ID、phase、成功与到期时间 |
| `user_pool_holds` | 推理在途请求、绝对截止时间、凭据 generation |
| `user_pool_catalog_holds` | 不建立 caller 租约的模型发现/token counting 在途保护 |
| `user_pool_events` | 分配、续租、到期、预热和管理事件，不存密码/token |

凭据字段仍在 `proxy_accounts`。SQLite request stats 新增 `caller_id` / `lease_id`，对外为 `callerId` / `leaseId`；`identity` 始终表示实际成员。

## 3. Proxy 配置及生效方式

| 环境变量 | 默认值 | 范围/约束 | 生效方式 |
| --- | --- | --- | --- |
| `ACCOUNT_ROUTING_MODE` | `direct` | `direct` / `caller-lease` | Proxy 启动读取 |
| `STORAGE_DRIVER` | `sqlite` | pool 只支持 SQLite | Proxy 启动读取 |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | 空 | pool 必填合法域名 | 启动校验，必须与已存库存域一致 |
| `POOL_WARMUP_MODEL` | 空 | pool 必填、成员实际可用 | Proxy 启动读取 |
| `READY_IDLE_TARGET` | `10` | 0–10000，不超过 cap | 首次建池种子，之后使用管理 API |
| `POOL_MAX_ACCOUNTS` | `100` | 1–10000，所有成员状态计入 | 首次建池种子，之后使用管理 API |
| `CALLER_LEASE_TTL_SECONDS` | `172800` | 60–2592000 | 首次建池种子，之后使用管理 API |
| `PROVISIONAL_LEASE_TTL_SECONDS` | `300` | 10–3600 | Proxy 启动读取 |
| `PREWARM_POLL_SECONDS` | `5` | 1–3600 | Proxy 启动读取 |
| `PREWARM_CONCURRENCY` | `5` | 1–20，并发账号阶段数 | Proxy 启动读取 |
| `POOL_EXHAUSTED_RETRY_AFTER_SECONDS` | `30` | 1–3600 | Proxy 启动读取 |
| `POOL_REQUEST_TIMEOUT_SECONDS` | `120` | 5–600，请求/预热步骤有界超时 | Proxy 启动读取 |

改环境变量后要使 Proxy **重新读取新环境**。Docker Compose 中单纯 `restart` 不会更新已有容器的环境变量，应通过重新创建容器应用配置。修改 `PREWARM_CONCURRENCY` 不要求修改源码，也不要求额外 SSO 副本。

注意：已持久化的 target/cap/正式TTL/pause 不会被每次启动的环境变量覆盖。要改变已有池的这些设置，请在 User pool 页面或管理 API 保存。直接模式忽略 pool-only 配置，不启动预热。

## 4. Login 并发独立配置

路径：**Console → Settings → Login runtime settings → Login concurrency → Save and apply**。

- 默认1，允许1–20，存储在 Login 的 `login_runtime_settings`，不是 Proxy 的表。
- 保存动态生效并触发队列调度，不需要重启；重启后保留。
- 调低不杀死正在执行的任务，而是限制后续任务入场。
- 没有用于此值的 Login concurrency 环境变量，不能只设置 `PREWARM_CONCURRENCY` 期待它同步变化。

也可调用 Login 服务 API（需要 `X-Internal-Token`）：

```http
GET /api/settings/runtime
```

取得当前 `version` 后：

```http
PATCH /api/settings/runtime
Content-Type: application/json
X-Internal-Token: <内部服务令牌>

{"expectedVersion":1,"changes":{"concurrency":5}}
```

`expectedVersion: 1` 仅作示例，必须使用实时读取值。Console bridge 地址是 `/api/console/login-service/settings/runtime`，使用管理员会话认证。

本地并发验证环境已设 Login=5，10个测试任务的浏览器峰值为5；使用的是本地页面和注入 runner，不是10次真实 GitHub 授权。真实登录的 CPU/内存、SCIM节流和成功率仍需实测。当前 Login 任务年龄上限15分钟包含排队时间，大批量补池应同时评估 Login 队列容量。

## 5. 请求与预热执行逻辑

### 5.1 请求链路

1. 验证 Proxy 服务密钥及 caller header，pool 模式要求精确 hash 格式。
2. 推理从 store 领取/复用 caller 租约；模型发现和 count_tokens 使用 catalog hold。
3. `req.identity` 替换为所选成员，读取该成员有效凭据，不进入 caller 的自动开户逻辑。
4. 根据成员实时模型目录处理 canonical model ID 和支持的协议路径。
5. 执行上游请求，处理超时、断开、流式错误和 backpressure。
6. 完整成功并满足租约/凭据 fence 时 promote/renew；失败只清理请求 hold，不续租。
7. 返回429容量信号不代表 LiteLLM 自动 fallback。示例未启用自动重试/fallback，显式策略不得以换 GHCP 账号绕过限流。

### 5.2 并发调度

启动、周期检查、请求及管理事件唤醒 scheduler。一次计算缺口：

```text
max(0, idle_target - ready_idle - provisioning - retryable_failed)
```

在总量/命名容量允许范围内一次登记缺口。`provisioning` 已经包含排队、执行和等待状态，不再额外加一次 active Map 数量。可重试 failed 包含未来退避任务，避免它恢复后叠加不必要的替代账号。

运行中的 identity 放入内存 Map 防止并行执行同一账号。阶段进展后尽快继续；无进展/等待结果时持久化下一次 `retry_at` 并让出槽位。定时检查保底，唤醒合并避免递归热点。所有步骤保留 owner/attempt/generation 检查和独立 AbortController。

暂停后不派发新阶段，但不保证取消已被 SSO/Login 接受的远程动作。降低目标或 cap 不删除已预占工作，已有工作恢复后继续完成。

### 5.3 预热阶段及安全护栏

正常阶段：

```text
new → sso-created → scim-synced → synced
    → oauth-starting → oauth-wait → warmup → ready
```

外部写操作之前还会持久化 `sso-creating`、`scim-syncing`、`seat-assigning`、`oauth-dispatch` 等意图阶段，用于崩溃/响应丢失恢复。

- `POST /api/users` 创建明确的 SSO 用户及 `${identity}@${POOL_ACCOUNT_EMAIL_DOMAIN}`。
- `POST /api/users/batch` 用 `sync_emu`、`createOnly: true`、`assignCopilotSeat: false`。批量路由的失败可能在HTTP200的 rows内，必须检查行状态。冲突不 lookup/adopt/update 现有 GitHub 用户。
- `POST /api/users/:identity/copilot-seat` 显式分配席位。
- `POST /api/users` 使用 `poolManaged:true`，为新成员创建ownership标记；必须配置至少16字符强随机 `SSO_DEFAULT_USER_PASSWORD`，pool创建禁止用户名密码回退，不重置既有direct用户密码。新标记成员不可从普通SSO编辑入口修改身份/密码。
- `POST /api/users/:identity/login-credentials` 使用 `expectedCreatedAt`、`expectedEmail` 只读取得既有用户可验证的已知密码；不 ensure、不重建、不重置。
- `POST /api/tasks` 使用独立 `oauthAttemptId`；只在相符回调成功且 token valid 后继续。部署时显式设置 `LOGIN_SSO_URL` 为GitHub实际跳转的custom SSO origin和登录路径（通常为 `${SSO_PUBLIC_BASE_URL}/login`）；内部服务地址不能替代另一个公网域名的页面识别规则。URL是启动配置，改变后需重新创建Login，不存在对应的持久化Settings字段。
- 通过 `/api/tasks/:id` 或受限分页检索恢复原任务，不盲目重复 POST。Login删除终态任务前向配对Proxy核对引用；当前OAuth attempt/任务仍在等待消费时拒绝删除，warmup/ready后允许清理历史。独立Retry对pool成员拒绝；查询失败或旧Proxy缺少接口时返回503，不修改任务。
- 新标记pool成员禁止普通SSO Sync以及提升企业角色；仅允许worker的create-only、普通user角色路径，不能用旧页面绕过同名冲突保护。
- 模型验证依据 capabilities 选择协议，必须得到非空成功 assistant 输出才 ready。
- 普通失败递增重试次数、有界退避；3次失败或终止错误停止自动推进。
- Pool模式拒绝旧OAuth CSV导入，避免将同一实际账号token复制进不同pool成员；旧独立reauthorize也由pool恢复控制替代。
- SSO破坏性操作先检查本地标记或Proxy的只读 `/internal/accounts/by-sso-user/:ssoUser/pool-membership`，不允许先删席位/EMU再等Proxy外键报错；核对不可用时fail closed。
- catalog请求得到429后持久化短暂caller冷却记录，即使请求hold清理也不能马上换成员；模型cache不再以stale fallback掩盖429。
- Pool运行期401使用 `recoverUnauthorized(held, expectedToken)` 在同一SQLite事务中核对hold/generation/旧token、清空凭据并安排 `failed → synced` 的自动修复，重置旧OAuth/task标识；hold排空后才可派发Login。相同旧token的并发401只安排一次，不能覆盖新token。
- `reauth_count` / `reauth_window_at` 两个附加列持久化一小时内最多3轮运行期自动修复；超限记录 `oauth_reauth_limit_reached` 并停止自动拾取。每轮普通失败有界退避/3次上限仍保留，pause会推迟修复。管理员可明确Retry，但持续401不会无限重新发起浏览器。
- warmup的模型目录或推理401同样退回synced并使旧token条件失效，避免反复用失效token验证。这里只重新授权原账号，不重建SSO、SCIM或重复分配席位；不是refresh-token grant。

## 6. 管理 API 和 Console

逐字段、按钮、状态和常见操作说明见[User Pool页面操作手册](user-pool-console-guide.md)。

Proxy 管理前缀：`/api/user-pool`，必须携带 `X-Internal-Token`。Console 前缀：`/api/console/proxy/user-pool`，必须有管理员会话。

| 方法/路径（相对前缀） | 作用 |
| --- | --- |
| `GET /` | 概览、设置、成员、租约和近期事件 |
| `GET /accounts` | 有界成员列表 |
| `GET /leases` | 有界租约列表 |
| `GET /events` | 有界近期事件 |
| `PATCH /settings` | 乐观版本更新 target/cap/正式TTL/pause |
| `POST /reconcile` | 触发检查，202表示已调度，不表示预热完成 |
| `POST /accounts/:identity/disable` | 禁止成员新使用 |
| `POST /accounts/:identity/retry` | 重试失败成员 |
| `POST /accounts/:identity/resume` | 恢复禁用成员，重新验证后才能使用 |
| `POST /leases/:id/release` | 确认释放，没有在途请求才允许 |

设置请求示例：

```json
{
  "expectedVersion": 8,
  "changes": {
    "idle_target": 50,
    "max_accounts": 100,
    "lease_seconds": 172800,
    "paused": 0
  }
}
```

版本来自实时响应；`paused` 使用0/1，不是boolean。释放租约请求必须为 `{"confirm":true}`。版本冲突、成员在用等返回409；pool未启用返回409 `pool_mode_disabled`。

成员最多加载1,000条、租约1,000条、近期事件200条；UI过滤/分页仅覆盖已加载数据。不要用原 Proxy Accounts 删除动作管理池生命周期：池成员有外键保护，使用 disable。界面概览同时展示账号状态和租约阶段，数字不能机械相加。

## 7. LiteLLM 配置

详细配置见 [hook说明](user-pool-litellm.md) 和 [示例YAML](../litellm/config.user-pool.example.yaml)。

- hook读取服务端已认证 hash，不从 alias/email/user metadata 取身份。
- `GHCP_POOL_API_BASES` 是 **LiteLLM 进程环境变量**，用于匹配实际选定 deployment URL。
- Chat兼容入口使用 `http://proxy:3000`，不要误填 `/v1` 后变成 `/v1/chat/completions`；目录接口仍为 `/v1/models`。
- 不在virtual key metadata写pool名称，也不在部署模型参数里写静态 caller header。
- 默认示例没有 retry/fallback，不通过429轮换账号。
- 已验证 LiteLLM v1.99.1 真实HTTP网关、数据库User/Virtual Key、Messages/Chat JSON/SSE、hash映射、突发补池及基本spend/key预算；详见[真实网关验收](user-pool-gateway-validation.md)。Responses已在真实 `gpt-5.6-sol` 非流式链路完成两用户调用和自动补池，见[完整真实报告](user-pool-real-e2e-validation.md)；真实流式、Prompt Cache、Team预算及生产冷却策略尚未完整覆盖。

## 8. Docker 启用和包源

默认 Compose 不启用账号池。启用会创建账号并分配付费席位，必须先核实许可、租户管理权限、SAML/SCIM配置和预算。

1. 从同一release构建匹配的 **Proxy、SSO、Login、Console四个服务**；Login面向用户的授权流程不变，但其任务/回调必须支持OAuth attempt关联。不要将新Proxy与未知旧SSO/Login混用。
2. 使用单Proxy、持久化SQLite卷。将Proxy入口限制给可信gateway；禁止把服务密钥分发给终端用户。
3. 私有 `.env` 示例（占位值不能直接用于真实开通）：

```dotenv
ACCOUNT_ROUTING_MODE=caller-lease
STORAGE_DRIVER=sqlite
POOL_ACCOUNT_EMAIL_DOMAIN=pool.example.com
SSO_DEFAULT_USER_PASSWORD=<至少16字符的强随机密码，不等于用户名>
POOL_WARMUP_MODEL=<账号实际可用的模型ID>
READY_IDLE_TARGET=0
POOL_MAX_ACCOUNTS=100
CALLER_LEASE_TTL_SECONDS=172800
PREWARM_POLL_SECONDS=5
PREWARM_CONCURRENCY=5
```

首次 target=0 方便管理员确认配置后再提高水位；不是运行时默认值。已有数据库可能保留非零 target，必须检查持久化设置。

先渲染检查：

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.user-pool.yml config --quiet
```

确认授权和配置后启动（会执行真实外部操作，不可带真实凭据做mock测试）：

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.user-pool.yml up -d --build
```

要求 Compose 2.24.4+ 支持 `!override`。Pool overlay固定SQLite、单副本、标准身份header、本机Proxy端口，并关闭Proxy错误诊断以避免原始请求/凭据留存。它不代替网络隔离，不要把不可信容器加入相同服务网络。

Docker `npm ci` 不继承宿主机 npm 设置。受管设备需通过 `NPM_REGISTRY` 构建参数/Compose配置使用组织获批包源。不要在URL/构建参数放认证令牌，不关闭TLS校验，不绕过包隔离等待策略。公开模板不写死组织内部地址。Login还需正常安装Playwright浏览器与系统依赖。

## 9. 当前验证和本地示例值

| 项目 | 已执行结果 |
| --- | --- |
| 完整workspace typecheck / deployment build | 通过 |
| OAuth恢复及最终并发保护后的Proxy回归 | 167通过，0失败，1项MySQL集成跳过；最终发布复验见[检查记录](user-pool-release-checklist.md) |
| Compose契约 | 3通过 |
| 四个服务干净Docker构建 | 通过；并发修改后再次构建Proxy通过 |
| Docker预热/租约/故障/TTL/重启 | 本地mock验证通过 |
| 20账号并发预热 | 20全部ready，实际HTTP并发峰值5，无重复任务 |
| LiteLLM v1.99.1真实网关 | 主套件34通过/0失败/1 blocked；1项fallback skip由后续6项补充通过覆盖；[详情](user-pool-gateway-validation.md) |
| Login concurrency=5 | 10个本地页面任务全部完成，浏览器峰值5；重启持久化通过 |

本地新的并发测试Console为 `http://127.0.0.1:17404/`：最近验证使用 target20/cap20、正式TTL60秒、Proxy阶段并发5、Login并发5。**这些是本地演示值，不是生产默认值；实际当前状态以UI/API为准。**原17304测试项目独立，未同步修改Login配置。

此前mock与本地浏览器测试用于广泛故障/并发覆盖；2026-09-10又完成4名真实普通池成员的SCIM/seat/OAuth/warmup，以及两把真实LiteLLM key的Responses调用和idle消耗后补池。真实Login并发为1，没有验证五路真实登录；待取消席位计费没有核实，不是全面生产验收。正式上线仍需客户旧卷迁移演练、真实流式/其他模型、长期运行与计费预算核对。

验证报告：[初始回归](user-pool-validation.md) · [Docker](user-pool-docker-validation.md) · [并发及Login=5](user-pool-concurrency-validation.md)。可复用脚本见 [Docker harness](../tests/docker-user-pool/README.md)。

## 10. 运维、回滚和延期事项

- 配置变更冲突时先刷新版本，不覆盖其他管理员修改。
- 维护时停止新流量、暂停预热、等待在途请求排空，使用一致性SQLite备份；保护数据库中的凭据。
- 不用 `down -v` 作为常规回滚，不自动退席位或删SSO用户。
- 回到direct/旧镜像前先停发pool hash，恢复direct映射；否则旧逻辑可能按hash自动开户。
- token实际有效期和主动刷新继续在 [UP-TODO-001](user-pool-todo.md) 跟踪；其中401失效后的有界自动重新登录已实现，见[恢复验证](user-pool-oauth-recovery-validation.md)。
- 当前没有保存/使用OAuth的 `expires_in`、`refresh_token`；长期使用并不构成“永不过期”的保证。闲置撤销规则、Copilot调用是否更新最后使用时间等仍需核实，本版不新增探测/保活任务。
- 401隔离成员自动修复，不把浏览器登录阻塞在当前请求中；当前请求仍可能失败，下一次调用是否可用由ready库存决定。自动修复超限、权限/密码或不确定外部任务等情况仍需人工介入。
- 依赖安全与最终发布状态见[发布检查记录](user-pool-release-checklist.md)。不要将历史阶段报告中的“未提交/未真实验证”当成当前发布结论；按固定commit和所需客户验收范围交付。
