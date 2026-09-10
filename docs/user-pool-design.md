# GHCP User Pool — 设计文档

更新日期：2026-09-11

分支：`ghcp-user-pool`
适用范围：Docker 版本，单 Proxy 进程、SQLite、单一默认账号池。

> 本文按当前实现更新，替代早期邮箱key alias、100个基础姓名和串行预热描述。已完成本地广泛回归与4个新成员的真实SCIM/seat/OAuth/warmup、两key真实Responses和自动补池；不是全部生产场景/计费约束验收。OAuth401后台修复已实现，主动refresh-token及真实撤销故障验收仍待处理。存量用户不自动入池，升级前阅读[客户升级手册](user-pool-upgrade-guide.md)。

配套：[实现与运维文档](user-pool-implementation.md) · [待办清单](user-pool-todo.md) · [LiteLLM 集成细节](user-pool-litellm.md)

## 1. 目标与边界

面向真实终端用户，约定每人一把独立 LiteLLM virtual key。用户不再预先绑定固定 SSO 账号，而是在首次调用时领取一个已预热的 GHCP 账号；租约有效期间排他使用，长时间没有成功调用后回收，供其他用户后续使用。

- **动态 1:1**：一个 caller 最多一个当前租约，一个池账号最多租给一个 caller。
- 同一 caller 的多个会话和并发请求使用同一租约，无需客户端传 session ID。
- 不引入 HRW、team pool、会话池或多个用户同时共享同一账号。
- 一个部署只有一个默认池，调用方不能指定池成员。
- “一人一 key”由身份发放和管理制度保证，软件不能从 key 判断是否被多人共享。
- 账号池是 opt-in；默认 `ACCOUNT_ROUTING_MODE=direct` 保持原有直连身份路由。
- 本版不支持多 Proxy 副本、跨主机共享 SQLite、MySQL 账号池或 AKS 账号池改造。

## 2. 整体架构

```text
终端用户
  │ 使用自己的 virtual key
  ▼
LiteLLM：认证、模型访问控制及自身预算/计费
  │ 选定 GHCP deployment 后注入 caller hash
  │ 使用独立 Proxy service API key
  ▼
GHCP Proxy：caller → 排他租约 → 已预热账号
  │ 使用成员的 OAuth access token 调用上游
  ▼
GitHub Copilot 模型接口

Proxy 内部后台 worker
  ├─ SQLite：缺口、账号、租约、在途保护、阶段与事件
  ├─ SSO：创建用户、SCIM EMU、分配 Copilot 席位
  ├─ Login：Device Flow + Playwright 授权及 token 回写
  └─ 最小模型调用验证成功后，将成员置为 ready
```

SSO 单副本不意味着开户必须串行。一个 Proxy 调度器可以并发推进多个账号；SQLite 仅串行执行短写事务，外部 HTTP 和浏览器等待不占用数据库事务。

## 3. Caller 身份：key hash，而不是 alias

可信 LiteLLM hook 只从已认证 `UserAPIKeyAuth.token` / `hashed_token` 读取 **64 位小写十六进制 SHA-256 hash**。字段同时存在时必须一致；缺失或格式错误，在选定 GHCP 后拒绝请求，不回退到 alias、邮箱、任意 metadata 或客户端传入的身份。

```http
Authorization: Bearer <独立的Proxy服务密钥>
X-User-Identity: sha256:<64位小写十六进制key hash>
```

- LiteLLM 中保存的 hash 不含前缀，hook 自动添加 `sha256:`；不对 hash 再计算一次 SHA-256。
- Proxy 当前要求 header 带此前缀；直接填 64 位 hash 不符合契约。
- 只改 alias 不改变租约；相同 alias 的不同 key 不会共享租约。
- key 轮换会产生新 caller，不自动继承旧租约；旧 key 应撤销，并明确处理其旧租约。
- 不再要求 caller 邮箱域名。池账号邮箱域名是另一项配置。

Hook 在早期认证回调确认真实 `UserAPIKeyAuth` 的业务key标记并捕获可信hash；路由前filter排除不具备可信身份的GHCP候选，但不要求预绑定metadata或已有租约；选中deployment后才检查GHCP URL、清理支持的header覆盖位置并注入可信值。两个路由职责保留，额外认证回调只确认来源，不按模型前缀路由。其他后端不被强制添加GHCP身份，但客户端自报header的统一出口清理不在本hook范围内。具体版本、认证类型及实测见[集成文档](user-pool-litellm.md)。

**安全前提：**Proxy 只供可信 gateway/管理员网络访问；终端用户不能获得 Proxy 服务密钥。`X-User-Identity` 和 hash 本身不是认证凭据，也不是额外授权机制。

## 4. 租约分配与续期

### 4.1 首次领取

1. 验证 caller 和请求基本格式。
2. 在 SQLite 原子事务中检查已有租约。
3. 没有可用的已有租约时，领取一个 ready-idle 成员。
4. 建立默认 **5 分钟 provisional 临时租约**，从领取开始即排他使用。
5. 完整成功的模型调用立即将租约升级为正式 TTL，默认 **48 小时**；不需要等满 5 分钟。

临时租约避免首次失败、试探性请求或随后放弃的用户白占 48 小时；失败不立即释放，则有利于短期重试和同一 caller 的并发稳定性。特殊凭据故障仍会隔离成员。

### 4.2 正式租约

- 每次完整成功的推理，将到期时间更新为“本次成功时间 + 正式 TTL”。
- 失败请求不续期；已有 active 租约不会因为一次普通失败降回 provisional。
- HTTP 200 不等于流式成功：还要检查协议完成事件，排除断流、提前 EOF 和 in-band error。
- `/v1/models` 和 token counting 使用请求级 catalog hold，不创建或续期 caller 推理租约。
- 到期租约在没有在途请求保护时回收。仍有请求使用的账号不能分给其他用户；过期但在排空的租约也不能无限接收新请求。
- 用 lease ID、请求 hold、凭据 generation 隔离迟到结果，避免旧请求续期或失效新凭据。

**租约 TTL 只决定账号归属，不会延长 GitHub OAuth token 寿命。**

## 5. 账号状态和水位

| 指标 | 含义 |
| --- | --- |
| Ready idle | 已验证、OAuth valid、无租约和在途 hold，可以分配 |
| Active leased | 正式租约数 |
| Provisional | 尚未成功升级的临时租约数 |
| Provisioning | 已登记待开通、执行中或等待外部结果的账号 |
| Cooling | 受到上游限流，暂不可接受新请求 |
| Failed | 开通/验证失败或凭据故障的账号 |
| Disabled | 管理员禁用的账号 |

账号状态与租约阶段分别保存。例如有租约的账号可能同时 cooling，所以不能简单相加这一排指标。

`READY_IDLE_TARGET=N` 是低水位目标，不是空闲数上限，也不是任何时刻的可用性保证。租约回收后空闲数可能大于 N；系统不自动删除多出的账号或退还席位。`POOL_MAX_ACCOUNTS` 是**池内库存**上限，失败和禁用成员也占用总量；它不统计池外旧账号，不是企业总席位或账单人数上限。待取消seat与新分配可能同时出现在API里，不能据此推导免费复用。

## 6. 自动预热与有限并发

### 6.1 何时触发

Worker 在 Proxy 进程内运行，无需独立 CronJob：

- 启动时检查；
- 默认每 5 秒检查，由 `PREWARM_POLL_SECONDS` 配置；
- 请求取得账号/结束、管理设置变化、Reconcile now 会主动唤醒；
- 步骤完成后尽快补充可执行工作，不等待其他慢任务。

### 6.2 如何计算缺口

```text
缺口 = max(0, N - ready_idle - provisioning - 可自动重试的failed数量)
实际新增 = min(缺口, max_accounts - 当前总量, 剩余可用命名候选)
```

可自动重试的失败账号即使在退避期也计入未来供给，防止反复建替代账号后原任务又恢复，造成过量开通。需人工处理、重试耗尽的失败账号不计入未来供给，但仍占总量上限。

**例：N=50、ready-idle=30、无在途开通或待重试任务，且总量允许：一次登记20个待补账号，默认最多同时推进5个账号步骤。**不是只补一个，也不是一次启动20个浏览器。

### 6.3 两个独立的并发限制

| 配置 | 默认值 | 范围 | 生效方式 |
| --- | ---: | --- | --- |
| Proxy `PREWARM_CONCURRENCY` | 5 | 1–20 | 环境变量；重建或重新创建 Proxy 进程/容器应用新配置 |
| Login `concurrency` | 1 | 1–20 | Console Settings / Login runtime API；保存动态生效 |

- Proxy 每个账号最多执行一个阶段，同时执行阶段数不超过配置。
- 等待 Login 结果的轮询会持久化下次检查时间并让出槽位；退避任务也不阻塞其他账号。
- Login 限制的是 active 登录任务，每个任务通常创建一个浏览器；不等于 Chromium OS 子进程数。
- mock并发验证环境把Login从默认1调到5；真实新账号/补池测试的Proxy和Login并发均为1，两个补充Login任务串行执行，不能将两种证据混用。
- SCIM 自身的节流/重试仍然有效；提高 Proxy 并发不意味着取消上游限流。
- Login 队列可能积累超过5个待执行任务。当前15分钟任务年龄检查包含排队时间，需要结合登录耗时和资源配置容量；本轮没有新增队列深度控制。

暂停仅阻止后续阶段调度，已被外部接受的操作可能继续完成。降低 N/总量上限不删除已登记任务；恢复后继续推进已有队列，可能产生高于新目标的空闲数量。

### 6.4 命名和开通流程

- 固定内置 **1,000 个唯一合成基础姓名 × `00..09` = 10,000 个候选**，不是旧版100×100。
- 示例：`firstname.lastname00@pool.example.com`。
- 域名由 `POOL_ACCOUNT_EMAIL_DOMAIN` 指定，不包含客户名称或硬编码客户域名。
- 使用持久化 ordinal，不重排姓名表，不重复使用已预占候选。
- 先预占本地记录，再执行 SSO 创建、SCIM create-only、席位分配、Login 授权、模型验证。
- 新pool用户创建显式带poolManaged标记，SSO要求至少16字符且不等于用户名的强随机默认密码；不沿用direct的用户名密码回退。ownership标记阻止普通管理入口直接修改pool身份/密码、普通SCIM同步/提升企业角色或删除外部资源；SCIM只保留create-only的普通user路径。
- Login的终态任务在当前pool OAuth dispatch/wait恢复仍依赖它时不可删除；消费结果进入warmup/ready后可清理。独立Login Retry不能并行重开pool授权，必须通过pool受控恢复。删除/重试前的Proxy核对失败会拒绝管理操作，不丢弃恢复证据。
- 同名 SSO/SCIM 冲突不能接管或覆盖其他账号。
- 读取登录密码必须验证既有用户的创建时间/邮箱，不调用可能重建用户的 ensure 路径；不能恢复任意自定义密码时拒绝，不重置密码。
- 模型 warmup 根据实时 capabilities 选择 Messages、Chat Completions 或 Responses，不 hardcode 模型名单。
- OAuth 回调、worker 阶段和凭据验证分别使用持久化标识防止重启或迟到结果覆盖新状态。

## 7. 错误、重试和 fallback

### 无空闲账号

新 caller 无成员可分配时，Proxy 返回：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
Content-Type: application/json

{"type":"error","error":{"type":"rate_limit_error","code":"pool_exhausted","message":"pool_exhausted"}}
```

30秒是默认建议等待时间，可配置，不保证届时可用。已有有效租约的用户不因池里没有空闲账号而无法继续使用自己的成员。

**LiteLLM 不会仅凭429自动开启 fallback。**当前示例默认没有自动重试/fallback；需要显式配置有界重试或切到获准的其他后端，并确认模型、费用和数据边界。v1.99.1实际HTTP测试还发现网关未透传上游 `Retry-After`，因此不能把Proxy响应契约直接当成客户端收到的完整契约；见[网关验收](user-pool-gateway-validation.md)。

### 上游错误

| 情况 | 当前处理 |
| --- | --- |
| 401 | 条件失效实际成员 token、隔离账号；不在同一请求换号重放 |
| 403 | 返回错误供调查，不遍历账号 |
| 上游429 / member_cooling | 保留绑定、执行冷却；不轮换 GHCP 账号规避限流 |
| 5xx / 网络失败 | 不续租、不遍历账号 |
| 流式中断 / in-band error | 不续租，已输出后不重放 |
| 模型不存在/不支持路径 | 返回错误，不偷偷替换已绑定账号 |

普通预热失败有退避和重试上限；不确定的创建/派发先核对持久化阶段和任务，不盲目重复开通。

**Pool模式的401现在会原子地使实际旧token失效并安排后台重新授权。**旧请求hold排空后，由worker使用原SSO用户及席位重新登录，回调和warmup成功后恢复ready；不用每次手工Retry。当前请求仍返回401，不等待浏览器、不换号重放；失效租约按原隔离规则释放，下一次请求可领取其他ready成员，不保证继续原成员。暂停预热也会暂停该修复。每个账号一小时窗口最多自动启动3轮运行期401修复，各轮内部失败仍受3次/退避上限控制，持续故障最终要求人工检查。403、429不触发此自动登录路径；并非到期前主动刷新。

## 8. Console、审计及兼容

Console 提供水位、成员/租约/事件列表、target/cap/TTL/pause 设置、reconcile、retry/disable/resume 和确认释放租约。管理 API 受内部令牌保护，Console bridge 受管理员登录保护，DTO 不返回 token 或密码。

- 配置用 `expectedVersion` 防止并发覆盖。
- 成员仍有请求时不能强行释放或重新授权。
- 统计的 `identity` 保持“实际成员”含义，新增 `callerId` 和 `leaseId` 便于追溯。
- 页面最多加载1,000个账号、1,000条租约、200条近期事件，筛选/分页只针对已加载数据。
- UI 每10秒刷新与 worker 的5秒轮询、租约续期无关。
- 回滚到 direct 前必须停止发送池 hash 并恢复 direct 身份映射，否则旧模式可能把 hash 当新身份自动开户。

## 9. 存量客户升级兼容

升级软件保持direct时，已知OAuth结构的旧用户/映射/凭据可按迁移规则保留；更早双token结构会清空旧凭据，启动统计裁剪和旧任务重启处理也需提前评估。保留原卷、证书、密钥并做副本演练，不修改GitHub IdP。

切换caller-lease是另一阶段：旧SSO/Proxy账号不自动加入user_pool inventory，旧seat不自动转给新成员。旧header用户名/邮箱在pool模式拒绝，不存在同一入口自动猜测direct/hash的混合模式。两个Proxy identity若指向同一SSO/GitHub账号，不是两个可独占成员，未来纳管必须去重。当前没有旧账号纳管或旧caller绑定导入API。

见[详细升级与回滚步骤](user-pool-upgrade-guide.md)。需要原账号/席位复用的客户不能直接启用新建池来满足此要求。

## 10. 验证状态和未完成事项

已验证：本地自动化回归、四个正式镜像构建、真实容器HTTP/mock闭环、20个账号并发预热、Proxy重启与实际TTL回收、LoginQueue两批共10个本地浏览器任务（峰值5）。新增LiteLLM v1.99.1真实HTTP网关/Postgres/User/Virtual Key测试，覆盖Messages/Chat JSON/SSE、伪造/撤销/模型权限、20新用户突发及补池、SpendLogs与基本key预算；详见[网关报告](user-pool-gateway-validation.md)。

另已完成[真实环境完整测试](user-pool-real-e2e-validation.md)：4个新普通成员真实SCIM、席位、OAuth及warmup，两把真实key调用 `gpt-5.6-sol` Responses并触发补池。真实Login并发1，席位API最终10条（6待取消+4新分配），未核实账单不增加。旧账号纳管/升级副本演练、真实并发5、真实流式/更多模型、长期容量和主动token刷新仍未由这些测试证明。

OAuth有效期/refresh-token优化仍待确认，401后有界自动重新授权已实现，详见[自动恢复验证](user-pool-oauth-recovery-validation.md)；依赖安全与最终复验结果以[发布检查记录](user-pool-release-checklist.md)为准。预热会提前消耗付费席位，启用前仍须确认服务账号使用、顺序复用、管理权限及预算符合授权和许可要求。

验证记录：[初始回归](user-pool-validation.md) · [Docker 联调](user-pool-docker-validation.md) · [并发与 Login=5 验证](user-pool-concurrency-validation.md)
