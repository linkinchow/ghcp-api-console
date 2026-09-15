# MySQL User Pool 生产前审查与修复

最新检查点（2026-09-15）：caller-isolation-v4已通过本地394项、真实MySQL组合43项、双Proxy严格隔离及14阶段生命周期。独立取消安全审查已停止且未完成，不能沿用此前审查结论；v4持续/2000规模场景待复验。进展与用户指定待办见[状态总览](user-pool-mysql-status.md)。以下数据库错误修复及其持续测试是storage-error-v3的历史记录。

## 2026-09-15 实际数据库故障补充修复

扩展测试发现即时MySQL连接拒绝/重置不属于deadline异常，admission返回500、凭据读取返回502且可能含原始错误消息。已在MySQL驱动边界限定识别连接故障、先销毁失效连接，再由runtime/compatible返回安全503；models失败恢复中的二次数据库错误也受控。没有增加事务或推理重试，COMMIT结果不明仍不重放。

修复后Proxy368pass/0fail/7条件skip、workspace类型检查及build通过；实际MySQL组合47pass/0skip。测试桥接的post-header断流遗漏另外修复（非产品逻辑），第三轮35秒MySQL重启完整通过，最新镜像1807秒5083请求持续故障测试0意外错误。完整证据、首轮失败和覆盖边界见[扩展报告](user-pool-extended-test-report.md)。热点caller占用共享连接影响其他caller的问题已由后续caller-isolation-v4修复，并通过严格前后对照与新镜像生命周期复验；该版本的独立范围和全局过载限制见[caller隔离报告](user-pool-caller-isolation.md)。

## 2026-09-14 后续大规模建池调度修复

此前 0→2000 真实 Worker 验收在 2488 秒后主动暂停，仅 96 Ready；满额 `oauth-starting` 被反复选择，拖延普通授权完成观察和 warmup。这与下表“失败/禁用任务的慢终态观察”是不同问题。现已在双驱动 pending 选择中加入容量过滤，以及三次下游优先、一次最老合格任务的公平排序；最终原子派发、due/hold/owner/credential fences不变。

修复后全 Proxy **330 tests / 325 passed / 0 failed / 5 DB skipped**，全工作区及两套 upgrade 类型检查通过。云端独立随机 MySQL 库的 scheduler/pool/admission/recovery 合计 **45 passed / 0 failed / 0 skipped**。新增真实 Worker+realProvisioner 异步存储回归验证积压推进和五lane争一slot；旧排序负向对照按预期失败。新 Proxy 镜像已构建并在双副本验证精确 digest，新的空卷自动建池结果集中记录于 [0→2000报告](user-pool-provisioning-2000-test.md)，不把此前 soak 或本段回归冒充该验收。

## 2026-09-14 前一候选的生产前审查修复

**前次审查的 8 个失败安全断言对应代码问题已修复，并补入正式回归。** 另完成通用 MySQL/基础 DDL deadline、启动 retention 顺序、旧管理接口 N+1、目录刷新合并和 page20 精确记录校验。未 commit/push、未部署生产、未访问真实 GitHub/席位/模型。

| 前次问题 | 修复与证据 |
| --- | --- |
| 成功响应被 stats 拖住续租；断连后 heartbeat 存活 | `upstreamComplete` 区分上游结束与响应后统计；断连立即停止定时器；迟到查询禁止转发；`userPoolAsync.test.ts` 3项通过 |
| 通用 SQL/基础 DDL 不受预算控制 | 通用单条 SQL acquisition+execute 5秒、删除事务5秒；两个 migration 入口各60秒；不确定连接/锁销毁；deadline/fault 测试通过 |
| 大量到期回收零进展 | 每批最多32且处理约1秒后提交，游标跳过busy/held前缀；2000全部排空，并验证活跃hold不提前释放 |
| 回收未完成就额外补池 | deficit包括可惰性复用的过期成员及待重验成员；2000凭据变更后的库存不会错误增至新账号 |
| 终态回调导致隐形占槽 | fail和attempts>=3原子提交；真实MySQL回调插入后仍进入观察集合 |
| 慢观察堵住正常调度 | 独立single-flight观察，有界且保留任期/pause/stop fencing；deferred GET与生命周期回归通过 |
| 默认配置fingerprint不一致 | 统一规范化可选并发默认值；实际parser cutover通过；旧开发省略字段hash不自动重写 |
| 错误trigger/schema被接受 | 共享标准DDL及校验器验证trigger body、关键类型/collation、主键/唯一/FK/CHECK/index；14个engine负向/兼容子场景通过 |
| UI mutation乱序覆盖tab | mutation及follow-up refresh期间锁列表控件；4项Linux Chromium回归含100条分页/过滤/乱序/卸载通过 |
| 旧管理接口N+1与catalog并发重复 | hold计数joined SQL；目录按成员/凭据/endpoint共享刷新，独立取消、最后等待者离开才abort，30秒/8MiB上限及旧snapshot退休 |

本轮最终普通 Proxy **323 passed / 0 failed / 4 skipped**（四个引擎入口单独执行）；独立 MySQL repository **1**、pool/admission **38**、新恢复套件 **5**、迁移 **66**，均零失败零跳过。恢复套件中完整2000集中到期+busy/held/凭据重验场景耗时约304秒，包含宿主数据库往返和当时资源竞争，不是生产恢复SLA。SSO31/Login12/Console6、离线hook+Compose23、workspace typecheck/build通过。新Proxy/Console Docker镜像构建通过；新双Proxy HTTP smoke、standby接管及等待readiness后的重启验证通过。正常负载最终指标见 [验证记录](user-pool-mysql-validation.md)。

修复过程中保留失败日志：增加joined hold计数后旧deepEqual断言需分别验证hold变化与租约时间不变；真实MySQL的CHECK_CLAUSE带转义字面量，验证器增加狭窄格式解析而不放宽语义；新1秒回收软批次不能假定每批恒32，测试改为验证有限多批最终进展。首次restart验证在readiness之前得到502，等待健康后通过，不当作无中断重启承诺。

历史开发数据不自动修复：旧省略字段fingerprint、已存在的人工核对/attempts1占槽需受控离线处理。生产放行仍需客户资源/SLO、受信LB回调/健康摘除、数据库HA及授权备份演练。下面保留**2026-09-13修复前审查原始结论**，其中“当前/尚未修复”仅指当时对象，不覆盖上方最新结果。

## 修复前结论与范围

**当时的候选存在已复现的上线阻塞，不建议直接用于真实生产。** 原 caller-lock 双 Proxy smoke 和 2000 caller 正常负载通过仍成立，但不能覆盖批量到期、慢数据库、回调竞态及 UI 乱序。该轮仅审查、隔离复现、既有套件复跑和文档校准，尚未修改生产逻辑。

对象：`ghcp-user-pool-mysql` 未提交工作区，HEAD `da76eb1`；上游比较对象是本地已取得的 `upstream/main` `c8715cb`，未拉取远端新版本。所有账号、token、源 SQLite 和 MySQL 均为合成测试数据；真实 MySQL 只表示数据库引擎真实。没有真实 GitHub/EMU/SCIM/席位/模型操作，没有访问或更改现有真实 SSO 环境。

关联：[设计](user-pool-mysql-design.md)、[实施](user-pool-mysql-implementation.md)、[历史验证](user-pool-mysql-validation.md)、[迁移工具](../upgrade/user-pool-mysql/README.md)。

## `await` 专项结论

上游 `ProxyStorage` 已显式返回 `Promise`，不是将 SQLite 同步接口直接接到 MySQL 后仍按同步代码调用。审查了 account repository、授权初始化、OAuth 回调、统计、storage 初始化，以及新增 pool admission/finish、worker、provisioner、迁移和 Console 数据加载。

- `return getStorage().getAccount(identity)` 位于 `async` 函数中，是合法的 Promise 传递，不是漏 `await`。使用结果、判断成功、生成 DTO 的调用点需要等待，已检查相关链路。
- 授权初始化有意后台执行，同时保留 prepared/completed Promise 和错误处理，不能仅因 `void` 就判错。
- 类型感知静态检查覆盖 Proxy 47、SSO 25、Login 18、Console 22 个生产源码文件；没有发现直接把 Promise 当 if 条件的候选。浮动表达式候选经复核包括保存供后续 await 的 Promise、显式双分支 `.then` 等，不据此报漏 await。
- **未发现可确认的简单漏 await，不代表异步安全。** 实际复现了已经 await、但等待了不该阻塞续租的统计操作，或把一次逻辑状态变更拆成两个事务的错误。
- 上游通用 MySQL account/stat SQL 和基础 migration 使用未受本分支 `MysqlDeadline` 包装的原始连接操作。这是继承边界；新 pool 与其共享连接池，新增请求生命周期使后果更明显。上游也不能仅凭类型检查认定具备完整超时/断网隔离。

静态扫描不是完整 Promise lint，也不能证明所有异常分支。SSO/Login/Console 的存储并未改成 MySQL，不能把本轮结论外推至 AKS PostgreSQL 实现。

## 已执行的失败复现

以下断言表达应有行为；**8 个断言失败是发现缺陷的证据，不是通过**。复现脚本和原始日志保存在本地私有审查目录，不包含真实凭据；未加入正常回归以免将未修复失败伪装成发布完成。

### 1. 成功响应被统计写入拖过续租期限

位置：[compatible.ts](../src/proxy/src/routes/compatible.ts:371)、[runtime.ts](../src/proxy/src/userPool/runtime.ts:137)。

响应已经成功发送，路由仍 await `recordRequestStat`，`operationActive` 因此保持 true，finish 不执行。合成延迟统计 Promise，推进测试数据库时钟越过请求 deadline，再释放统计操作，实际租约仍为 **provisional**，未升级 active。

修复验收要求：上游完整成功/下游完成和统计持久化分开；统计慢或失败不能取消已完成业务的及时续租，同时不得提前解除仍在上游执行的 hold。

### 2. 客户端断开后，阻塞的账户查询使 heartbeat 继续存活

位置：[runtime.ts](../src/proxy/src/userPool/runtime.ts:137)、[compatible.ts](../src/proxy/src/routes/compatible.ts:306)、[mysqlStorage.ts](../src/proxy/src/db/mysqlStorage.ts:112)。

注入未完成的账户查询，客户端断开后等待 5.5 秒，heartbeat 次数仍由 **1 增至 2**。退出时释放测试 Promise 才正常清理。持久化 hold 虽有截止时间，本地 interval 和占用的通用数据库连接并未因此自动结束。

修复验收要求：有界通用数据库获取/查询、失联连接销毁、断开后本地定时器终止、迟到结果禁止再次转发；不能只用 Promise.race 返回错误却继续复用仍执行 SQL 的连接。

上述两个复现使用合成 SQLite 状态及延迟异步适配来确定路由时序，不冒称已做 TCP 黑洞/物理网络分区。MySQL 原始调用不接受 AbortSignal/操作预算的事实另由源码确认。

### 3. 2000 个同时过期租约，回收连续超时且零进展

位置：[mysqlStore.ts](../src/proxy/src/userPool/mysqlStore.ts:588)。

在独立随机 MySQL 8.4 数据库预置 2000 个到期租约，不注入额外 SQL 延迟。每次 `reclaim()` 读取全部候选并在同一事务逐成员处理：

| 回收轮次 | 耗时 | 结果 | 剩余租约 |
| --- | ---: | --- | ---: |
| 1 | 5063 ms | `POOL_SQL_TIMEOUT`，回滚 | 2000 |
| 2 | 5056 ms | `POOL_SQL_TIMEOUT`，回滚 | 2000 |

正常压测使用 3600 秒租期并在到期前完成，因此没有覆盖这一场景。此问题影响后台回收及调用同一回收路径的统计/管理操作。caller 局部 admission 可回收其成员，不等于后台一定能消化积压。

修复验收要求：有界、公平、能跳过忙成员的回收批次，每批提交进展；同时到期、持续新增到期、活跃 hold/cooling 混合情况下不能饥饿或提前复用。不能靠增加运行期 5 秒预算掩盖无界批次。

### 4. Login 终态失败与 OAuth 回调之间留下不可观察的占槽

位置：[worker.ts](../src/proxy/src/userPool/worker.ts:382)、[mysqlStore.ts](../src/proxy/src/userPool/mysqlStore.ts:108)。

真实 MySQL 测试在 `fail()` 提交后、worker 的终态复读之前写入合成成功凭据，触发 generation 增加。第二步 attempts=3 的 fence 因此拒绝更新。实际记录为：

```text
state=failed
stage=oauth-wait
attempts=1
last_error=oauth_task_cancelled_unconfirmed
terminal-observation eligible rows=0
```

正常 pending 排除该人工核对错误，终态观察却只选 failed attempts>=3，导致这个占槽两边都不处理。Login 上限为 1 时可阻塞整个后续派发。测试只直接写合成回调，不启动真实 Login/GitHub。

修复验收要求：原子持久化终态失败，或使受保护终态记录永远不会落入两个处理集合之外；保留完整 generation/attempt/owner 检查，不通过取消 fencing 解决。

### 5. 慢终态观察阻塞正常补池调度

位置：[worker.ts](../src/proxy/src/userPool/worker.ts:118)。

调度先 await 整批终态 Login 观察，再获取普通 pending。在纯合成 adapter 中保留一个观察 Promise 未完成，另一个正常成员已经到期可执行；等待期间实际 step 次数 **0**，预期为 1，释放观察后才继续。

默认观察超时可达 120 秒；owner 续约独立运行，因此可能出现 owner 看似健康但补池停滞。修复应将有界只读观察与普通调度隔离，确保停止/失去任期时两者都可终止，避免引入重叠观察和无界任务。

### 6. 省略可选默认值的 programmatic 配置与实际启动 fingerprint 不一致

位置：[mysqlStore.ts](../src/proxy/src/userPool/mysqlStore.ts:54)、[migrate.ts](../upgrade/user-pool-mysql/migrate.ts:243)。

以省略 `loginMaxPending` 的合法 `PoolConfig` 初始化，再用 `readPoolConfig` 的实际默认值（5）初始化相同数据库，得到 **Pool configuration differs between Proxy replicas**。两者业务含义相同，但 raw object hash 不同。programmatic importer 直接传递此对象，现有迁移集成测试又重复使用同一个手写对象，因此没有测试真实 parser cutover。

这不表示使用同一真实 env parser 的 CLI 默认路径必然失败。修复应规范化并验证有效默认值，再测试 importer → 实际 runtime parser；还需明确旧 fingerprint 的兼容/迁移策略，不能直接手改生产 hash。

### 7. 同名空操作 credential trigger 被启动检查接受

位置：[mysqlMigrations.ts](../src/proxy/src/userPool/mysqlMigrations.ts:80)、[migrate.ts](../upgrade/user-pool-mysql/migrate.ts:234)。

在独立测试库把已安装 trigger 替换为同名、同 AFTER UPDATE 元数据的空操作版本。`initialize()` **未拒绝**，随后凭据变更的 generation **0 → 0**。当前检查确认名称、表、时机和事件，不验证 trigger body。目标 importer 检查同样不足；缺失唯一约束、类型/排序规则变化也不在其完整校验范围内。

这是自定义/受损 schema 的拒绝能力缺口，不表示正常原版 migrations 会自动产生坏 trigger，也不是低权限调用者可以更改 trigger。修复验收应验证关键约束/二进制语义及 fence 定义，覆盖空目标、已初始化空目标和重启；源 trigger 的“标准定义”声明也需有相应证据。

### 8. 管理操作完成后的旧加载覆盖当前 tab

位置：[UserPoolPage.tsx](../src/console/src/web/pages/UserPoolPage.tsx:85)。

在无网络的 Linux Chromium 中使用当前构建产物，延迟 Accounts 页的 Reconcile 响应，切到 Leases 并成功显示租约，然后完成旧操作。观测请求顺序 **accounts、leases、accounts**；当前 tab 仍为 Leases，却显示 No leases match，Release 按钮由 1 变为 0。

已有 browser 回归使用即时响应，未覆盖该乱序。修复应使用当前查询状态刷新，或在 mutation 期间禁用 tab/filter/page；还要覆盖 settings 保存和中途卸载。

## 源码确认、尚未单独执行故障注入的差异

1. **启动前清历史的顺序**：[server.ts](../src/proxy/src/server.ts:121) 在 pool fingerprint 校验前执行 `pruneAllRequestStats()`。配置最终被拒绝的副本仍可能先删共享统计；迁移保存的统计首次启动也受 retention（默认每账号 2 条）裁剪。须先验证 pool，再进行有意的保留策略；不能提前启动 worker 来交换顺序。文档现已提示保留策略，不把程序实现称为已修复。
2. **基础 DDL 不在 60 秒 wrapper 内**：60 秒仅覆盖 `MysqlPoolStore.initialize` 的 pool schema 部分。继承的 `runMysqlMigrations` 原始 acquisition/DDL 无同样预算；RELEASE_LOCK 抛错会跳过 `connection.release()`，不确定锁响应也没有完整销毁策略。GET_LOCK 的服务器等待 30 秒不是全部 SQL/网络预算。文档已缩小原过宽声明。
3. **旧管理接口 N+1 查询**：overview/leases 对最多 1000 个租约分别并发 `hasHolds()`，虽然新版页面用分页接口，旧接口仍会竞争连接池。需要 joined count/批量化及压力测试，不把一次管理查询成功称为无影响。
4. **模型目录刷新不合并**：传入 request AbortSignal 时不复用 `refreshPromise`，pool 路径均传 signal。冷缓存同成员并发会产生重复 catalog 请求；这是保护独立取消的当前设计取舍，需在保留取消隔离的前提下验证/改进，不直接恢复共享单个请求 signal。

## 本轮实际复跑结果

| 验证 | 本轮结果 |
| --- | --- |
| 部署 workspace typecheck、build | 通过 |
| Proxy 全套（普通环境） | 256 passed、0 failed、3 skipped |
| 上游通用 MySQL repository 独立入口 | 1 passed、0 failed、0 skipped |
| 两套 pool/admission MySQL 契约及故障注入 | 38 passed、0 failed、0 skipped |
| SQLite→MySQL pool 迁移集成 | 49 passed、0 failed、0 skipped |
| 迁移默认离线入口 | 45 passed、0 failed、1 skipped（上行单独跑集成） |
| SSO / Login / Console 单元 | 31 / 12 / 6 passed |
| 当前 Console 构建的既有 Linux Chromium 页面回归 | 1 passed；首次入口因 Vite 清空 tsc 测试输出未运行，转译原测试后在无网络容器通过 |
| LiteLLM 离线 hook + Compose | 23 passed（17+6） |
| 宿主 LiteLLM 固定版本 runtime 入口 | 5 skipped，宿主未安装该 Python distribution；不计为通过 |
| npm audit（批准的包源） | 0 vulnerabilities |
| 新增故障/乱序复现 | **8 个安全断言失败，见上文，未修复** |

38 是 node:test 报告计数，包含 25 个实际 DB 子场景、2 个父包装和 11 个离线故障用例，不是 38 个独立真实 DB 场景。各 suite 有重叠，不能简单相加为单次测试总量。

本轮不重复正常 2000 caller 压测：生产源码未改变，历史通过保留；优先用该规模覆盖此前遗漏的集中到期，结果失败。没有重建应用 Docker 镜像，也没有验证客户 LB/MySQL HA、真实长流、远程 TLS、实际客户备份或生产性能上限。

## 文档校准与发布门槛

原文过宽之处已收窄：60 秒 DDL 范围、请求清理有界性、终态占槽观察覆盖、programmatic fingerprint、custom target schema 拒绝能力、迁移后统计 retention、rollback 必须以“目标无新写入”而不是“未开放流量”为界。

page20 负载脚本只断言 total=2000、items.length=100；没有证明具体返回第 1901–2000 条或与 page1 不重叠。UI 手动搜索第 2000 个合成成员是另一条独立证据。未将这一覆盖差异写成已修复分页代码。

生产放行必须先关闭上述已复现阻塞，加入可重复回归，再重新冻结候选并复跑双 Proxy、正常负载、集中到期/慢 SQL/回调故障及迁移后实际启动。客户资源、LB/DB 故障切换和迁移演练仍需独立授权；审查通过或修复代码都不授权真实开户、席位或模型消费。
