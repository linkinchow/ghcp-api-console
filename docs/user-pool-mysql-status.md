# User Pool 多 Proxy＋MySQL：最新进展与待办

## 最新进展与剩余事项（2026-09-15）

**结论：已约定的v4最终验收、v5可观测性增量及四组追加进程测试全部完成。在已测范围内，没有确认但尚未修复的MySQL产品缺陷。** 这不等于目标生产环境或全部故障组合已验收。

### 当前版本

- v4：`2bc12b3`，四项最终验收通过，原分支和镜像保留。
- v5：`356f8f5`，含本机调度诊断；已有`observability-v5`镜像并验证源码对应关系，未push。
- `ghcp-user-pool-resilience-tests`的本次提交仅收录新增/修改的测试和报告，不push、不发布镜像；生产源码仍与v5相同，因此本轮补测不要求生成v6或重建相同生产镜像。

### 还遗留什么

1. **交付收尾：** 本次本地提交收录补测和报告；推送代码、发布镜像、固定客户使用的commit/镜像/部署配置仍需后续授权，本次不执行。
2. **监控与运维接入：** 已有本机诊断信号，尚缺跨副本采集、全局无有效调度者判断/持续时长、告警与处置阈值；需核对健康检查、摘流量/排空、重启策略、LiteLLM精确fallback及请求关联排障。
3. **生产上线门槛：** Rancher跨节点/Service路由及节点故障；实际MySQL部署/TLS，若采用主库HA则验证真实切换；客户数据备份、SQLite→MySQL迁移与回退；授权的小规模真实Login/GitHub链路；SSO/Login/Console单实例恢复及故障处置演练。
4. **非本轮的扩展测试：** 多日稳定、多个热点caller总过载、客户长流式容量/延迟；其余外部SSO/SCIM/seat进程故障边界、count_tokens和更广排列。先定义目标/风险再安排，不重新列为本轮未完成，也不无限追加mock。

SQLite专属失权自动恢复暂缓、非MySQL上线前置项；过渡期及回退仍保留已知风险。Proxy/worker拆容器不是当前必做项。建池故障切换可恢复但不承诺零错误，已有流可能中断，数据库整体故障仍可安全503；这些是明确运行限制，不等于尚有一个已确认无法恢复的代码缺陷。

### 四组追加测试——全部实际通过

v5已提交为`356f8f5`，保留在`ghcp-user-pool-observability`；当前补测分支`ghcp-user-pool-resilience-tests`未修改生产源码，本提交仅收录测试/报告，未push。用户授权新的有界补测及3/5副本复验，不重跑所有历史规模测试。

- 真实SIGSTOP/30秒任期到期/SIGCONT：实际通过，旧owner SQL写拒绝、原task/nonce无重复，最终Ready。
- 3/5独立Proxy副本：两档通过；跨副本绑定/排他、单owner补池、热点caller隔离、owner退出期间持续业务和重选均通过。
- 全目录消费者取消及凭据响应顺序：路由修正版实际5项通过；首轮两项错误码预期失败已核实为夹具假设，原失败记录保留。
- Login真实120秒GET停滞与模拟服务进程重启：修正夹具退出/状态设置后两个实际子场景通过，140.659秒；原两次早期夹具失败记录保留，生产逻辑未改。

逐组数据及失败记录见[v5有界补测报告](user-pool-v5-resilience-tests.md)。客户拟迁移MySQL，SQLite专属自动恢复暂缓，不是此次MySQL上线阻塞项。

下文v4/可观测性历史记录：基于冻结v4提交`2bc12b363e62923ca6c1db0185e42f9ed5c78bf9`（`2bc12b3`）。`ghcp-user-pool-mysql`及已验收v4镜像保持原样，冻结提交已commit、未push。后续分支已实现本机诊断增量，其本地回归和新镜像选择性运行验收已通过；结果单独记录，不沿用冻结v4的验收结论，也不是生产部署授权。

## 一、当前结论

主体实现、已复现缺陷修复及多轮隔离验证已完成。已验收冻结候选为 **caller-isolation-v4**：热点caller不再让同一Proxy池中的其它caller等待其数据库锁；该结论有真实MySQL契约和双Proxy HTTP前后对照支持。后续observability增量另有本地回归和选择性运行验收，不替代或重跑冻结候选完整验收。

冻结v4的四项约定最终回归已全部通过：1803秒持续故障、35秒实际MySQL重启、0→2000建池、2000caller请求负载；独立caller取消安全有界复核已完成且无确认缺陷。明确结论为“本次隔离候选验收通过”，不是全部故障穷尽或生产全系统HA认证。随后对冻结v4实际执行的独立进程routes两例及worker两个接管子场景也已通过；未覆盖的排列和503观测待办见[专项清单](user-pool-mysql-503-todo.md)。

**冻结v4压测已结束；后续observability新镜像的选择性运行验收及独立证据核对均已通过，不是重跑冻结v4最终四项。** 本轮使用3个由真实worker创建的mock成员，MySQL暂停期间双副本诊断仍200、业务安全503，恢复后推理200且hold/cataloghold归零；最终paused1、target0、max8、ttl600。v4此前2000成员/2000活跃测试租约的收尾快照属于历史验收，不混作本轮状态。新增进程夹具未合入冻结提交，已对冻结v4完成上述有限进程验收。独立核对确认双Proxy健康、RestartCount均0、镜像及生产源码hash匹配；原owner仅1条安全`ownership-lost`日志（`storage_unavailable/deadline`），另一副本无此日志。MySQL已运行、解暂停且健康，之前v4-final-load的MySQL卷保留。

## 二、已完成的开发与修复

- SQLite单Proxy保留；MySQL多Proxy共享排他租约、凭据和库存，一个数据库租约选出的调度owner。
- caller使用认证后的LiteLLM virtual-key hash；成功完整推理续租，取消/错误/不完整流不续租；hold、凭据generation、OAuth nonce和任期检查保留。
- 自动SSO→SCIM→席位→Login→warmup流程、401原成员修复、429保留绑定冷却。
- 分页管理、Console并发操作保护、统计归属及离线SQLite→MySQL池迁移。
- 修复批量过期回收、异步迟到/统计拖延、终态槽位观察、启动配置与schema校验等此前审查问题。
- **大规模建池调度堵塞已修复**：Login满槽过滤无效starter，推进下游并保留公平选择。
- **数据库即时断连错误映射已修复**：在驱动边界识别连接故障并安全503，不暴露原始数据库错误；不明COMMIT不重放。
- **热点caller连接占用已修复**：获取数据库连接前按底层pool/caller有界FIFO，1active＋最多32queued；进程1024tickets，原生mysql2队列1024，原5秒预算不变，不串行模型推理。
- 测试桥接已修复响应开始后的断流传播，测试读取/清理有界；这属于夹具修复，不混称产品缺陷。

## 三、测试证据按候选分开

### 已验收冻结候选 caller-isolation-v4

Docker镜像ID（非远端仓库manifest声明）：

```text
sha256:826d609963e0951258621a87334ea2a6e6af91d39280940ae80bf477c3364c3c
```

| 验证 | 结果 |
| --- | --- |
| 完整Proxy本地回归 | 并行测试整合后443tests：418pass、0fail、25条件skip；生产源码未变 |
| 真实MySQL caller/admission/store/lifecycle组合 | 43pass、0fail、0skip；含父包装和离线控制，不与上行简单相加 |
| workspace/upgrade类型检查、部署构建 | 通过 |
| 固定传输/桥接回归 | 9pass、0skip |
| 双Proxy热点caller严格对照 | A锁6.5秒时，B两探针由4915/4907ms降为23/31ms，均200；A仍按原截止503；取消/清理/无重放通过 |
| 新空库HTTP生命周期 | 14阶段全部通过，61.418秒；4轮补池、管理、32成员401恢复；最终32Ready、6个新lease、hold0 |

生命周期报告终点6个lease，之后收尾时自然过期为0，两个快照分别保留。401修复保留成员库存和外部身份，不保证caller再次取得同一member或leaseID。

此前独立取消安全审查中止的记录保留；冻结`2bc12b3`后已完成一次有界只读复核，未发现确认缺陷。该结论不是穷尽审计或额外运行时验证，见[最终资格报告](user-pool-v4-final-qualification.md)。

### 冻结v4最终四项回归——全部通过

| 场景 | 结果 |
| --- | --- |
| 30分钟混合故障 | 1803秒、5095请求、0意外错误，最终hold0 |
| MySQL实际停止/重启 | 停止至start完成35.149秒、双Proxy503、新owner、无需重启Proxy，hold0 |
| 从零建2000成员 | 619.668秒全部Ready，计数/分页及4次跨副本canary通过 |
| 2000caller请求负载 | 25并发、2轮，4022测量HTTP全部成功，租约/统计/hold检查通过 |

同一提交/镜像未更换；完整原始报告及SHA已归档。本次封闭验收结束，不重复列成待测。

### 冻结v4新增独立进程证据与后续增量

- **routes：2pass、0fail、0skip，5.574秒。** 两个独立Node进程、各自缓存、共享隔离MySQL；覆盖目录部分取消＋推理，以及旧凭据ABA/success-first关键顺序。不同PID和随机库清理有证据，不代表全部排列通过。
- **worker：两个实际子场景通过，含父包装TAP3pass、0fail、0skip，66.454秒。** Login受理后真正SIGKILL旧进程，等待真实约30秒owner TTL接管；覆盖原任务/nonce恢复及超龄任务迟到回调保护，不是三个业务场景，也不覆盖所有外部步骤或进程故障。
- **observability后续增量：** 本机诊断生产代码已实现，完整本地回归438pass、0fail、25条件skip，类型检查通过；新镜像选择性运行验收已通过，构建后生产源码未改。MySQL暂停时双副本诊断200（8/7ms）、原owner失权计数0→1且原因`storage_unavailable/deadline`、业务503；解暂停至调度与健康恢复12.282秒，随后推理200、hold/cataloghold0。暂停控制跨度18.322秒包含有意等待12秒及业务约5秒失败预算，不称为纯12秒故障或恢复SLA。全局owner健康判断、跨副本告警和客户SQLite恢复未随此交付。

observability镜像ID为`sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb`。原运行脚本的测试辅助校验后来发现可漏检必填字段；已修正本地严格契约并新增3个通过测试，对已存6份真实快照再次严格校验全部通过，无第二次故障注入。严格脚本本身未在远端重跑；原执行脚本hash和运行报告/事后校验证据分别记录在[后续进度](user-pool-post-v4-progress.md)。不同候选、测试层级和父包装计数不简单相加。

### 历史候选通过，不能移植成v4已重跑

- **从零建2000成员**：scheduler-v2约625.922秒，全部Ready；首轮41分钟仅96Ready的失败保留。
- **最新一次30分钟soak**：storage-error-v3，1807秒、5083请求、0意外错误；Proxy退出/MySQL暂停恢复，hold0及marker唯一。
- **35秒MySQL实际停止/重启**：storage-error-v3＋修复夹具完整通过，无需重启Proxy；最初500和中间夹具断流失败保留。
- **2000预置Ready请求负载**：更早候选4022次HTTP全200；不是从零建池。
- **建池期间owner退出**：严格零错误测试失败一次回调；保留现场恢复至2000Ready通过。这是能恢复，不是故障切换零错误或自动不中断完成。
- 慢Login1/5对照、LiteLLM实际测试virtual-key链路、Console浏览器和合成完整迁移已有分批通过证据，未全部在v4重跑。

## 四、待办：严格对应用户截图的四类清单

用户于2026-09-15明确，本次“待办”特指此前讨论的下列四类，不是泛化的项目发布清单。状态区分：**已修复**、**恢复已验证但仍有限制**、**尚未完整测试**、**尚未在目标环境验收**。

### 1. 不同caller之间的资源隔离不足——已修复并通过针对性验收

- [x] 获取数据库连接前按caller有界排队；不以增加连接或延长超时掩盖。
- [x] 保留跨副本MySQL命名锁、凭据检查和COMMIT不明不重放。
- [x] 真实MySQL验证同caller只有一个SQL等待者、取消项不借连接、B可独立完成。
- [x] 双Proxy严格前后对照：A锁阻塞6.5秒，B由约4915/4907ms降为23/31ms且200；A仍按原预算失败，hold/锁无泄漏。
- [x] 新镜像14阶段业务/补池/管理/401恢复回归通过。

**结论：截图第1项已关闭，不再列作未修复缺陷。** 这是单热点caller对同一底层池的连接占用隔离，不保证全库故障、多caller合计过载或多个独立池的全局公平性。冻结候选独立有界复核及四项同版本最终回归已完成。

### 2. 建池故障切换不是零错误——恢复已验证，限制仍存在

- [x] 调度Proxy退出时出现一次授权回调失败；保留原现场，失败成员经新授权尝试恢复，最终全部Ready。
- [x] 恢复验证未额外新增用户/席位，同一identity+OAuth nonce未重复派发。
- [ ] 不能承诺故障切换期间所有开通任务一次成功；原严格零错误测试仍失败，不能改成“无中断通过”。
- [x] 形成基于状态/关联证据的安全观察、重试与人工核对说明，见[恢复处置原则](user-pool-recovery-triage.md)；确定性组件契约支持其核心行为。
- [ ] 在授权生产等价环境演练人工核对和处置流程，不能因说明已写就声称实地演练完成。

**结论：不是仍有一个已证明无法恢复的代码故障，也不是已实现零错误切换。** 当前可恢复结论有测试证据；是否需要继续优化停机/回调路径须根据可接受的错误与恢复目标决定。

### 3. 还需要补的测试——组件及有限进程用例已通过，其余排列和容量待补

四agent并行开发、主会话整合后，已串行在真实MySQL验证下列组件契约，未改生产代码。详细记录见[四项组合测试报告](user-pool-deterministic-tests.md)。复用同一Node运行时的两个HTTP监听器不等于独立Proxy进程；后续独立Node进程的有限实测另列如下，仍不笼统勾选“全部多副本场景完成”。

- [x] **外部操作已成功、进度未写回时精确切换owner——双驱动确定性组件契约完成。** SSO/SCIM/seat/Login各两屏障＋三种不可见结果，SQLite11＋MySQL11全部通过。可确认步骤GET恢复，不明SSO创建停住人工核对；旧owner实际SQL写入被拒绝。[专项报告](user-pool-owner-side-effects.md)。
  - [x] Login POST已受理、checkpoint未写回的独立worker SIGKILL接管通过；未改DB时钟或缩短租约，真实约30秒TTL后采用原任务/nonce，无第二次POST；超龄任务迟到回调子场景也通过。
  - [x] v5实际SIGSTOP/SIGCONT后旧进程恢复通过：真实30秒任期到期，新owner接管后旧SQL和本地执行均被fence，无重复Login POST。
  - [ ] SSO/SCIM/seat其余副作用边界及传输中断排列仍待验证；不能把Login检查点的进程暂停用例扩大为所有外部步骤验收。
- [x] **目录查询压力＋部分取消＋同时推理——真实HTTP/双驱动组件层完成。** SQLite5＋MySQL2全部通过，catalog hold、模型刷新取消隔离、不续租、响应大小/时间界限均检查。
  - [x] 两个独立Proxy子进程、各自模型缓存、共享MySQL下的GET/HEAD部分取消＋双进程推理关键用例已通过。
  - [x] v5两个独立缓存的全部消费者取消及无清缓存恢复通过，上游真实连接关闭、hold排空、不建租约。
  - [ ] count_tokens及更广压力排列仍未覆盖。
- [x] **旧凭据成功/401交错及替换/ABA——双驱动组件层完成。** 两种替换×两种返回顺序×两驱动，8个实际子场景通过；旧结果不破坏新凭据、不续租、不重放，重新warmup后才可用。
  - [x] 独立进程ABA/success-first顺序已通过，包含旧200/401结果fence和实际worker/provisioner重新warmup后才可用。
  - [x] v5独立进程ABA及A→B的401-first顺序通过，路由组修正夹具预期后5项全部通过。
  - [ ] 其余进程排列及进程退出时组合仍未穷尽。
- [x] **Login轮询连续失败、重试耗尽后恢复——双驱动组件契约完成。** 最终SQLite3＋MySQL3通过；明确终态才释放槽位，running/cancelled/404/关联不符保留，failed/disabled不被自动重试。首次测试时序断言失败保留并修正。
  - [x] v5真实120秒GET无响应超时、独立模拟Login服务进程停止/恢复通过；不改客户端超时，任务无重复POST，失败状态不会自动预热。
  - [ ] 真实Login服务/持久数据库/浏览器的重启及完整自然重试退避耗时未验证；本轮合成IPC任务恢复和显式failed预条件不能替代。
- [ ] **更长时间和代表性生产负载。** 多日稳定、多个热点caller总过载、最大吞吐与客户延迟目标尚未验证。v4本次约定的30分钟/35秒DB重启/2000规模四项已通过，不无限追加mock；容量与长周期目标作为后续专门验收。

### 4. 生产部署层面验收——均未完成

- [ ] **Rancher内部Service、多Proxy跨节点与节点失联。** 同集群和Service DNS已由材料确认，实际Service类型、健康后端、节点分布和故障行为未验收。
- [ ] **MySQL主库HA切换。** 已有同一MySQL容器重启验证，不等于主库提升/HA端点切换；还需TLS、连接恢复与不明COMMIT检查。
- [ ] **客户数据备份、恢复及迁移演练。** 合成迁移已验证，客户一致性备份、回退与维护窗口未演练。
- [ ] **真实Login浏览器、GitHub限流与实际授权耗时。** mock不代替真实链路；只可在单独授权的小规模场景验证，禁止擅自增加真实付费席位。
- [ ] **SSO、Login、Console单实例的恢复方案与可接受影响。** 这是当前架构边界，多Proxy＋MySQL不等于全系统无单点。

这组验收需要相应环境与授权，不能在客户唯一生产环境直接停止Pod/节点做实验。

### 新增：503原因与失权恢复专项待办

- [x] 后续分支实现本机失权原因分类、续约/重选状态及计数和只读诊断接口；438pass、0fail、25条件skip，类型检查通过。
- [x] 新诊断镜像选择性运行验收通过：双副本鉴权/查询拒绝/no-store、数据库暂停时诊断可读/失权原因、恢复后业务与hold排空；6份实际快照事后严格契约重验通过，不声称严格脚本已远端重跑。
- [x] 独立证据核对通过：双Proxy健康且RestartCount均0、预期镜像及源码hash匹配；总计仅1条安全失权日志，位于原owner且为`storage_unavailable/deadline`，另一副本无此日志；MySQL恢复健康，之前v4-final-load的MySQL卷保留。
- [ ] 集群无有效owner判断、持续时长和跨副本告警仍需单独设计与接入。
- [x] 对冻结v4执行routes两例及worker两个SIGKILL/真实TTL接管子场景，实际通过；范围见上节，不覆盖全部进程故障排列。
- [ ] 核对入口健康检查/摘流量/重启策略及LiteLLM精确model-group fallback，避免将所有503当成同一根因或造成重启风暴。
- [ ] 客户SQLite永久失权后的恢复机制尚未实现；客户拟迁移MySQL，该旧版专属修复暂缓、非MySQL上线阻塞项。过渡期和回退仍需说明已知风险，不能称为已修复。

详见[503专项清单与owner解释](user-pool-mysql-503-todo.md)及[本机诊断范围](user-pool-local-diagnostics.md)。本机standby/null快照不表示全局无owner；实现诊断不等于完整告警或恢复机制交付。

### 本轮结论与后续边界

冻结v4四项最终回归、v5可观测性增量以及四组追加进程/网络/3–5副本验证均已实际通过，各自版本与范围分开记录。本轮没有修改v5生产源码，先前失败均已核实为测试夹具/预期并修正，失败证据保留。剩余交付、监控接入、生产环境验收及范围外扩展测试见页首；不把已完成用例重新列为待测。

v4 `2bc12b3`和v5 `356f8f5`已本地提交、未push；本次`ghcp-user-pool-resilience-tests`提交收录新增测试与报告。生产源码对应已验证v5镜像，追加测试不是新的生产版本，也不需要据此重建镜像。

## 五、报告索引

- [v5进程故障与3/5副本追加验收](user-pool-v5-resilience-tests.md)
- [v4之后可观测性与独立进程进度](user-pool-post-v4-progress.md)
- [本机调度诊断接口](user-pool-local-diagnostics.md)
- [冻结v4最终四项回归](user-pool-v4-final-qualification.md)
- [503专项待办与owner解释](user-pool-mysql-503-todo.md)
- [客户SQLite失权恢复评估](user-pool-sqlite-owner-recovery.md)

- [四agent确定性组合测试](user-pool-deterministic-tests.md)
- [外部副作用与owner切换](user-pool-owner-side-effects.md)
- [安全恢复与人工核对原则](user-pool-recovery-triage.md)

- [热点caller实现与严格前后对照](user-pool-caller-isolation.md)
- [扩展测试详细报告](user-pool-extended-test-report.md)
- [扩展场景矩阵](user-pool-extended-test-matrix.md)
- [0→2000真实Worker验收](user-pool-provisioning-2000-test.md)
- [MySQL验证历史](user-pool-mysql-validation.md)
- [架构设计](user-pool-mysql-design.md)／[实施运维](user-pool-mysql-implementation.md)
- [Rancher入口HA待办](user-pool-rancher-ha-todo.md)

所有公开记录仅含合成环境聚合指标，不包含客户标识、订阅/公网IP、真实凭据或私钥。
