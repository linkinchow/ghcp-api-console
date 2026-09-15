# User Pool：MySQL 与多 Proxy 设计

状态：**2026-09-15 当前候选为 caller-isolation-v4，已完成已复现缺陷修复及所列隔离测试**；独立取消安全审查未完成，当前候选仍需补同版本持续/规模复验，不是客户环境验收或生产部署授权。基线：`da76eb1`；分支：`ghcp-user-pool-mysql`。最新进展和待办见[状态总览](user-pool-mysql-status.md)，历史失败见[生产前审查](user-pool-mysql-production-review.md)，逐项结果见[验证记录](user-pool-mysql-validation.md)，部署见[实施文档](user-pool-mysql-implementation.md)。

## 1. 目标与边界

保留 `direct`，保留 SQLite 单 Proxy；新增 MySQL 8/InnoDB 下多个 Proxy 共享一个排他账号池。SQLite 与 MySQL 保持 caller hash、租约、Cooling、401 恢复的业务语义。MySQL 是池状态和凭据的权威数据源，不引入 Redis、池凭据缓存或新的队列架构。

**SSO、Login、Console 仍各一个实例，保留各自的数据卷和证书。** 只扩容 Proxy；不把这些服务的 SQLite 文件挂到多个实例，也不把多 Proxy 称为全系统高可用。外部 MySQL 写主库、负载均衡器及其可用性由部署方负责，本阶段不提供 MySQL HA 或 LB 服务。

所有开发、回归、迁移演练和压测只用合成账号、合成凭据、隔离数据库及本地 mock。禁止访问真实租户、读取运行环境凭据来驱动测试、访问真实 GitHub/SCIM/Copilot、创建真实 EMU、分配/撤销席位、撤销真实 token 或调用真实模型。已有部署及数据卷不变。

## 2. 架构与配置一致性

多个路由 Proxy 连接**同一个 MySQL 写主库的同一个数据库**，各自进行身份校验、租约 admission、上游转发与 finish。一个通过数据库租约当选的 worker 推进补池/凭据恢复；其他 Proxy 为可服务的 standby，周期竞争调度权。SQLite 保留单 owner fail-fast，不能通过共享文件扩容。

启动完成前必须成功初始化 storage、池 schema 和配置。**先完成 pool fingerprint 校验，再执行统计裁剪，最后启动 worker**；不兼容配置不能先裁剪共享统计。schema migrations/初始化 seed 本身仍可能写入，不是全部启动零写入承诺。 运行中的 `/readyz` 检查 storage 连通性；MySQL standby 不因缺少本机调度所有权而被判不就绪，SQLite 仍检查本机 owner。`/healthz` 只表示 HTTP 进程存活。readiness 不是库存充足、Login 可用或端到端上游健康的证明，也不在每次探测时重新验证配置 fingerprint。

SSO、Login 的内部调用/回调和 Console 的 Proxy 请求使用统一的 `PROXY_CLUSTER_BASE_URL`，由可信 LB 路由到任意健康 Proxy，保留 `/api`、`/internal` 路径及内部鉴权。已认证的业务网关使用同一组后端，不依赖会话粘滞。所有副本使用相同服务密钥、池域、上游及池配置；不要让回调继续指向某一个旧 Proxy。

### 2.1 MySQL 持久化配置约束

`MysqlPoolStore.initialize()` 持久化并核对 `account_domain` 和 SHA-256 `config_fingerprint`。fingerprint 对 `PoolConfig` 中除 `idleTarget`、`maxAccounts`、`leaseSeconds`、`enabled` 和旧 `callerDomain` 外的**全部不变量选项**排序后计算。当前包括：

- `POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_WARMUP_MODEL`；
- `PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`；
- `PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`（默认 **5**）；
- `POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS`。

`READY_IDLE_TARGET`、`POOL_MAX_ACCOUNTS`、`CALLER_LEASE_TTL_SECONDS` 只在首次初始化时作为种子；以后以共享 settings 为准，通过带版本号的管理操作修改 `idle_target`、`max_accounts`、`lease_seconds` 和 `paused`。

**fingerprint 不是“副本之间当时一致即可”的提示，而是现有数据库的不可变初始化约束。** 即使重启全部副本或池为空，单改环境变量也不会更新已持久化的 fingerprint。域名、模型、并发、Login 上限或其他不变量的变化，需要事先审查的持久化配置变更/迁移与一致性 rollout 方案；当前管理 API 不提供自动改写 fingerprint 的操作。不得删 settings 行或手改 hash 绕过保护。以后新增不变量也必须纳入旧数据库的升级计划。

fingerprint 先规范化 programmatic `PoolConfig` 的可选 `prewarmConcurrency`/`loginMaxPending` 默认值为 5，验证范围后再排序 hash；省略值与实际 parser 默认配置等价，null/无效值拒绝。实际 importer → `readPoolConfig` 启动已有隔离回归。已部署的完整 parser 配置 hash 不变；旧开发候选以省略字段生成的 hash 不自动改写，须离线重新演练或另行审查迁移，不能手改 hash 绕过。

## 3. 存储、时间与事务边界

显式可 await 的 `PoolStore` 契约支持跨驱动调用。SQLite 保留同步事务实现，由适配层提供同样能力；MySQL 不通过内存快照复制全库后写回，也不假装远程数据库是同步 SQLite。

### 3.1 分配互斥与成员级完成事务

MySQL admission在借连接前使用本地有界caller FIFO：同一底层连接池的所有store/wrapper共享，每caller最多一个active admission、32个等待者，进程总active+queued ticket上限1024；溢出返回安全503。catalog与推理共用caller gate，但finish/heartbeat/worker及已获准推理不经过它。整个队列、mysql2获取连接、GET_LOCK、事务和释放共用原5秒SQL预算。取消本地等待直接移除；mysql2已排队获取不能强制移除，因此持有本地ticket直到迟到连接释放，避免同caller继续放大驱动队列。原生mysql2共享池queueLimit也设1024，包含direct存储调用，不影响fingerprint。它解决已复现的单热点caller连接占用，不替代下面的跨副本数据库锁，也不保证全库不可用或多caller总负载过高时仍可服务。实现和前后对照见[caller隔离报告](user-pool-caller-isolation.md)。

MySQL 使用独立连接、`READ COMMITTED`。请求 admission 先取得基于“数据库名＋完整caller”的SHA-256命名锁，再开始事务，不获取全局settings行锁；相同caller的目录和推理串行收敛，不同caller可以并行。新成员候选先按池索引读取，再锁 `proxy_accounts` 行（`FOR UPDATE SKIP LOCKED`），锁后重新检查状态、凭据、lease及catalog占用，有限次数重选；不能将锁前发现的空闲当作已获得所有权。

库存预占、后台回收和管理变更仍使用settings行作为协调入口，再锁成员。admission仅清理本caller及候选成员，不进行全池扫描；后台按候选成员锁定后处理过期记录。**后台每次最多处理 32 个候选，成员处理累计约 1 秒后在成员边界提前结束并提交；单次 SQL/事务硬预算仍 5 秒。** 进程内循环游标跳过长期 hold/被锁前缀，成员锁使用 SKIP LOCKED；游标不是租约权威，重启后从头仍安全。计数可能短暂包含尚未清理的到期行。补池 deficit 计入可惰性复用的过期成员及未处理的凭据重验成员，避免批次回收未完成就额外开户。 请求完成与续租只锁自身成员；等待成员锁后必须复读租约，避免消费等待前的过期快照。命名锁释放失败或结果不明确时销毁连接，不把可能持锁的连接还回池；已确认commit不能因释放失败而自动重放。

hold 心跳是单条数据库一致性读取，不获取全局写锁；纯事件写入使用独立事务。凭据只在当前事务已锁定期间复用读取结果，事务结束立即丢弃，更新凭据时清除，不是跨请求 token 缓存。回收通过 verification/cooling 索引选择候选；凭据 trigger 保证变更清除 verification。空闲选择从有序池索引开始，领取时更新成员排序时间，避免每次从已租出的旧前缀开始扫描。MySQL 请求唤醒最多合并一秒，降低重复协调写入。

本版保留调度/库存与管理协调锁，不声称增加 Proxy 就能线性增加吞吐。MySQL `reserveDeficit()` **每个事务最多预留 32 个成员**，由后续调度继续补足缺口。禁止把 SSO/SCIM/Login/模型 HTTP 操作放进数据库事务。

### 3.2 数据库时间与有界 SQL

所有权、租约、冷却、hold、重试和验证等池时间使用数据库计算的 epoch 毫秒整数。MySQL 使用 `UTC_TIMESTAMP(3)` 的 epoch 差值，不依赖 Proxy 主机时钟或 MySQL session 时区；SQLite 使用 SQL 时间函数。进程内的调度任期保护和 SQL 超时采用单调时钟，管理 DTO 的 `observedAt` 只是观察时间，不是租约依据。identity/token 比较采用 binary 语义，配合外键、唯一约束及索引。

`mysqlDeadline.ts` 对 **MySQL 池存储的每个 connection/transaction 操作**提供最长 **5 秒**的单调时钟总预算（不超过传入的 request timeout）。同一预算涵盖连接池排队/获取连接、SQL 与锁等待、commit、必要 rollback、有限重试及重试间隔；不是每条语句重新获得 5 秒，也不因上层请求默认 120 秒而延长。基础 schema 和 pool schema 各自通过共享 migration helper 执行，每个入口 60 秒预算覆盖获取连接、GET_LOCK、DDL/校验及 RELEASE_LOCK；不确定锁响应销毁连接。seed 及运行期 pool 事务仍为 5 秒。

通用 `MysqlStorage`（account、stats、ping）的每次独立 SQL 获取连接及执行也受 5 秒预算，删除事务共享一个 5 秒预算，不明 commit 不 rollback/replay。多个独立 SQL 组成的 repository 方法不共享一个方法级 5 秒预算，例如 stats INSERT 与 retention 各有预算。离线 importer 整个复制过程没有统一 5 秒预算。

即时数据库连接拒绝/重置/关闭与SQL预算到期都按存储不可用处理。在响应头发送前返回安全503；已经开始的SSE不能改写HTTP状态，hold验证失败时中止流，不伪造成功终止事件。只在 `leaseMysqlConnection` 的MySQL驱动边界将明确连接故障包装为安全 `MysqlConnectionError`，持有的失效socket先销毁；runtime及兼容API返回脱敏 `503 pool_storage_unavailable` 和 `Retry-After: 1`。通用SQL/配置错误、锁冲突和上游网络错误不借此重新分类；不新增事务或推理重试。目录失败恢复中的二次数据库错误也进入同一安全响应路径。实测发现和复测边界见[扩展测试报告](user-pool-extended-test-report.md)。

- 排队超时后若连接迟到，释放该未使用的连接；观察迟到的 promise 结果，避免遗留拒绝。
- 已取得连接上的远程操作超时，先销毁该连接再报告超时，不把可能仍执行 SQL 的 socket 放回池中，也不在已销毁连接上排队 rollback。
- 仅在 commit 之前发生已知死锁/锁等待错误、且 rollback 已确认时，最多再重试两次；仍受同一个 5 秒预算约束。
- 连接断开、超时或 commit 结果不明不自动重放事务。commit 报错后的 rollback 成功也不能证明先前 commit 未生效；不能据此重试外部副作用。
- admission 用 savepoint 分隔回收与领取：预期耗尽/冷却错误可撤销领取部分，但保留已经完成的过期回收/隔离。

## 4. 请求不变量

- caller 最多一个租约，member 最多租给一个 caller；同 caller 的 catalog 和 inference 收敛到同一成员。
- 只有已验证且 OAuth valid 的 ready 成员可用；catalog/counting 不新建或续期正式租约。
- 默认 provisional 为 300 秒，完整成功推理升级/续期 48 小时（共享 lease settings 可调）；失败、断流或仅 HTTP 200 不足以续租。
- hold 有绝对 request deadline 和 10 秒排空宽限。响应结束/断开立即停止本地定时器并中止请求 signal；若上游尚未确认结束则保留 hold 直到操作结束或持久化截止，不因本地取消提前复用。上游完整读取后标记 `upstreamComplete`，成功下游完成即可及时续租、释放 hold，不再等待响应后的统计写入。迟到账户读取会再次检查 abort，禁止继续转发。
- 数据库不健康时新请求 fail closed；既有请求的 hold 检查失败则中止本地上游连接，不能保证撤回上游已接受的计算。
- 429 保持绑定，冷却期间拒绝新使用，不换成员；无正式租约的 catalog caller 也持久化冷却。
- 401 按 hold、token、generation 条件失效并安排**既有成员**重授权；此恢复路径不创建新账号/新席位，不重放原请求。
- 正常安装的凭据 trigger 变更递增 generation，旧请求/旧 warmup 不能验证或失效新凭据，包括 token 值相同的 ABA 替换。启动和 importer 共用标准 schema 定义，验证关键类型/二进制 collation、完整主键/唯一键、外键动作、必要索引/CHECK 及 trigger body；异常拒绝，不自动修复未知自定义 schema。

## 5. 调度任期与外部副作用

owner 每次任期使用新 UUID；数据库租约 30 秒，约每 5 秒续约。DB 续约只允许尚未过期的原 owner。本地使用从续约请求开始计时的单调时钟保护任期，迟到响应或 event loop 停顿不能复活旧工作。续约失败或池存储操作失败会撤销本地执行资格并 abort active stages/观察任务；MySQL 回到 standby，SQLite 停止 worker。接管时间不是 30 秒内服务恢复的 SLA，仍受轮询、DB 和进程健康影响。

checkpoint/fail 及 worker 凭据写入在同一事务检查 owner、attempt、stage/generation。受控操作包含 GH login 关联、beginAuthorization 和条件 token invalidation；OAuth 回调另用当前独立 OAuth attempt 校验。不能用异步写入前后各 assert 一次替代原子 fencing。

外部写步骤先持久化意图，再执行 HTTP。新 owner 遇到意图阶段只查询/恢复，不盲目重复创建用户或 Login POST。SSO 创建和 Login 派发无全局幂等保证，结果不明仍可能需要人工核对；不承诺 external exactly-once。消费者 wake 只加速本地 worker；跨副本变更由 owner 周期读取共享状态发现，`reconcile` 返回 accepted 不等于已经完成处理。

## 6. Login 背压与终态槽位回收

`PREWARM_CONCURRENCY`（默认 5，范围 1–20）控制账号步骤并发；Login 浏览器并发是另一层限制。`POOL_LOGIN_MAX_PENDING`（默认 **5**，范围 1–100）限制池内 `oauth-dispatch`/`oauth-wait` 的持久化占位总数，不是只统计 Login 当前运行的浏览器，也不覆盖非池 Login 任务。

派发前在 owner/row fence 和 settings 锁下计数并占位；满额时保留在 `oauth-starting` 等待，不 POST 新任务、不消耗一次失败尝试。未明确结束的 failed/disabled 占位也计入上限。普通任务有 15 分钟年龄保护，但超龄只会进入受保护失败状态，不证明浏览器已经终止。

普通待执行选择先检查持久化 Login 容量：满额时跳过 `oauth-starting`，包括 failed/disabled 的不明占位；避免先做 SSO/凭据读取再发现无法派发。共享 `scheduling.ts` 让 SQLite/MySQL 使用同一策略：三次优先选择更靠近完成的阶段（warmup/ready、oauth-wait、oauth-dispatch等），第四次仅按 `retry_at,updated_at,ordinal` 选择最老的合格任务，避免持续下游工作饿死前序阶段。计数器只影响进程内选择顺序，不是持久化所有权。due、hold、pause和人工核对错误过滤不变；容量筛选只是提示，最终仍由 POST 前的原子 claim 决定能否派发。暂停只阻止新调度，已在途普通步骤仍可能完成。

为避免已结束的任务永久占槽，worker 在未暂停且持有有效任期时进行只读终态观察：

1. 从稳定顺序的**至多 100 条**候选中轮转，每个 poll 最多观察 **10 条**；完成触发的 wake 不绕过 poll 间隔。
2. 候选必须在 dispatch/wait，且是 `disabled` 或 `failed` 且 `attempts >= 3`。检查当前 Proxy 身份、Login task/独立 OAuth attempt 关联，不重新调用 SSO 开通或 entitlement，不开始新 OAuth、warmup 或取消任务。
3. 只有明确匹配的 Login **`success` 或 `failed`** 才释放槽位。`pending`、`running`、`cancelled`、404/未找到、读失败、重复/不匹配或结果不明均保留槽位。Login 的 cancelled 是数据库标记，不是 Playwright 已停止的证明。
4. 释放在事务内再次检查有效 owner、完整记录 fence、未暂停及无 hold。成功任务移到 `warmup`，失败任务移到 `synced`；清除 task/OAuth nonce，generation 加一，**保留 failed/disabled 状态、attempts、last_error 及人工重试保护，不修改 Proxy 凭据**。

这只释放背压容量，不自动让成员 ready，不替用户点击 retry/resume，也不自动解除需要人工核对的错误。观察失败不再扣重试次数。

终态失败在一次 fenced `fail(..., terminal=true)` 事务内写入失败状态和 attempts>=3，不再在回调可能插入的第二步补写重试耗尽。观察是独立 single-flight 批次，覆盖候选读取/检查/HTTP 的绝对超时，不占普通步骤并发、不阻塞正常调度；pause、停机和任期丢失都会中止，`stop()` 等待观察结束，迟到上下文保持 fenced。旧开发候选已经留下的人工核对失败不自动改状态或重试，需受控处理。

## 7. 管理分页与可观测性

已有管理端点均需内部服务鉴权，Console 通过自己的管理会话转发：

- `GET /api/user-pool/summary`：settings、counts、limits 等摘要，列表为空；新版 Console 不必先拉全量列表。
- `GET /api/user-pool/page/{accounts|leases|events}`：服务端 `page` 默认 1，`pageSize` 默认 **25**、范围 1–100，`q` 最长 255 字符，支持各列表允许的 `state`；返回 `items/total/page/pageSize`。计数和过滤在服务端执行。
- 旧 `/api/user-pool` overview 及 `/accounts`、`/leases`、`/events` 保留：accounts/leases 各最多 **1000** 条，events 最多 **200** 条。它们不因新分页而变成完整导出，不能用旧数组长度验收 2000 成员库存。

当前 summary DTO **不保证提供 scheduler owner、active/standby 或全局 hold 总数**；不能因为这些字段缺失就认定没有 owner，也不要把监控目标写成已有 API 能力。storage mode 可由 `/readyz` 获取；管理列表/事件、每成员 activeRequests、worker 安全日志及经授权的只读数据库观察用于排障。记录数、锁竞争和 SQL deadline 失败应纳入运维观察，但不使用 caller/token 作为公开高基数标签，不输出凭据或完整身份。

## 8. SQLite → MySQL 池迁移

使用专用 [离线 pool 迁移工具](../upgrade/user-pool-mysql/README.md)，不是旧 `upgrade/sqlite-to-mysql` direct 工具。**维护窗口、无零停机保证、不双写、不通过重新开户或分配新席位完成迁移。**

源须先暂停补池、停止新业务、排空推理/catalog 和所有已派发外部任务，停止旧 Proxy 与可能写回源的服务。备份必须是经确认一致的**独立 rollback-journal SQLite 副本**；不能裸拷贝仍有未合并 WAL 的主文件。工具 readonly/query_only 读取单一快照，拒绝 WAL 格式以及 `-wal`、`-shm`、`-journal` sidecar；如需转换 journal mode，只处理离线可丢弃备份，不修改运行/原始库。

预检拒绝未暂停源、有效 owner、任何 hold（即使已过期）、identity initialization claim、provisioning/refreshing、未结束 OAuth 回调及不明外部意图。failed/disabled 上未解决的 Login 证据也不能直接导入；只有已验证 ready/cooling、stage ready 且凭据有效、回调已结束的历史 task/OAuth 关联符合保留条件。不清空安全字段来绕过 busy 检查。

迁移 accounts/凭据、含 caller/lease 归属的 stats、settings/version/domain/next ordinal、inventory/generation/recovery 字段、lease、catalog cooldown 和 events。保留 TTL 及历史时间，不续租；owner 清除，目标强制暂停预热。目标须独占空库，dry-run 只读源且不连接 MySQL。

目标 advisory lock 覆盖空库检查至结束；DDL 和初始化 seed 不与数据导入原子提交，失败后可能保留。导入 DML 在一个 serializable 事务中，settings mutex 优先，锁定空表检查、复制并读回比较全部字段/计数/关系（含内部凭据相等性）后 commit。结果不明的 commit 或未确认 rollback 必须在维护状态下私下检查，不盲目重试。

先启动一个 MySQL Proxy、保持暂停，核对数据和 LB 回调路由后再扩大后端。旧 SQLite 绝不同 MySQL 同时接流量。MySQL 一旦有写入，旧快照就不能直接作为回滚目标；需要另行安排一致性核对及维护方案。SSO/Login/Console 数据卷、认证材料和证书原样保留。

## 9. 验证门槛与当前状态

以下是验收要求，不是已通过声明：

1. SQLite/direct 全量回归；异步 admission/cleanup、凭据 fence、Login 槽位观察、分页与 Console 回归。
2. 隔离的真实 MySQL 多连接契约：caller 竞争、catalog 交叉、cap/32 条预留、TTL/DB 时间、冷却、401、generation/ABA、stale callback、删除保护、锁竞争，以及覆盖排队、SQL、commit、rollback 和迟到结果的 deadline 测试。
3. 至少两个实际 Proxy 进程/容器 + 共享测试 MySQL + 本地 mock：跨副本一致性、唯一 owner、owner 退出/重启/续约失败后的接管及旧 checkpoint 拒绝。具体覆盖边界以报告为准。
4. 2000 成员/key 的合成 HTTP 压测，包含流式、回收、统计及管理分页。记录机器/配额、mock 延迟、并发、持续时间、吞吐、延迟、错误与最终一致性；不以账号数替代吞吐，不承诺生产性能。
5. 全新空库真实 Worker 自动推进 0→2000，不预置 Ready；核对每一步外部 mock 计数、最终凭据/Ready、分页及跨副本 canary。它与预置成员的请求压测是独立门槛，修复与最新结果见 [自动建池验收](user-pool-provisioning-2000-test.md)。
6. 当前源码 Docker 构建、隔离与无真实凭据/外部调用检查；未跑/受阻项明确保留。

旧租约列表通过同一 SQL 返回 hold 计数，不再逐租约并发 N+1 查询。Console mutation/配置保存及随后的刷新期间锁定列表 tab/search/filter/page，过期加载和卸载后的响应不能覆盖页面。

模型目录刷新按 identity/凭据/endpoint 的哈希区分，各调用者独立取消，仅最后一个等待者取消才中止共享请求；30 秒刷新截止、8 MiB 响应上限，旧凭据 snapshot 退休而不打断已有等待者。这里只缓存模型目录，不缓存池租约/凭据授权决定。

实际结果见 [验证报告](user-pool-mysql-validation.md) 和 [生产前审查修复记录](user-pool-mysql-production-review.md)。历史失败保留，新增故障回归和正常路径分别验收。已修复不等于客户资源、长流/DB主库故障、LB或客户备份演练完成，也不授权真实上游操作。
