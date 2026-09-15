# 多Proxy＋MySQL：503原因、调度失权与恢复待办

更新：2026-09-15。503问题已纳入User Pool多副本＋MySQL待办。冻结v4（提交`2bc12b3`）及已验收镜像未改；后续分支`ghcp-user-pool-observability`已实现本机诊断增量，本地回归、新镜像选择性运行验收及独立证据核对均已通过，构建后生产源码未改。本轮有限进程用例另对冻结v4实际执行通过，不混作新镜像重跑冻结最终四项，也不操作客户环境。

## 1. 先区分三种“归属/资格”

- **调度owner**：哪个Proxy目前可以负责后台开户、授权、warmup和修复。全池只有一个有效调度任期；不是用户身份或Copilot账号。
- **caller成员租约**：哪个LiteLLM调用者正在排他使用哪个成员。由共享MySQL保存，各健康Proxy均可执行受保护的领取/校验。
- **请求hold**：一次已获准请求对成员的短期占用保护，避免请求未结束就回收成员。

调度owner资格失效不等于caller租约全部丢失，也不等于成员凭据被删除。但当前执行请求的进程如果同时停顿/退出，该连接仍可能中断。

## 2. 当前已经知道和验证的事实

### 客户现有SQLite事故

客户确认仍为SQLite。`pool_owner_unavailable`表示worker不再有有效调度资格、SQLite业务guard拒绝请求。触发失权的具体原因未由这条LiteLLM消息证实，需要首次失权附近的Proxy/SQLite/宿主日志。

SQLite失权后持续停止、需受控恢复的改进尚未实现，单独见[SQLite恢复评估](user-pool-sqlite-owner-recovery.md)。不要把这个已知模式直接登记成MySQL v4存在相同永久停止缺陷。

### 冻结MySQL v4

- 非owner的健康Proxy可以通过共享MySQL使用Ready成员；调度失权本身不会触发SQLite专属`pool_owner_unavailable`分支。
- worker失权后退回standby，旧任务被取消/隔离；符合条件后使用新UUID争取新任期，不复活旧任期。
- 已在同一冻结候选验证30分钟故障混合流量、35秒MySQL实际重启、自主恢复和hold排空。数据库故障期允许安全503/断流，不保证零错误。
- 已修复即时MySQL连接错误的500/502原始错误泄露，存储连接故障/截止统一返回安全503。
- 热点caller连接占用已有界隔离，但全库故障、多caller总过载仍会影响服务。
- 新增独立进程routes两例实际MySQL运行2pass、0fail、0skip，5.574秒；worker两个实际SIGKILL/真实约30秒TTL接管子场景通过，含父包装TAP3pass、0fail、0skip，66.454秒。它们不是全部进程故障排列。

依据：[冻结v4最终回归](user-pool-v4-final-qualification.md)与[后续进度及日志摘要](user-pool-post-v4-progress.md)。这证明测试条件下恢复有效，不证明所有网络分区/进程故障下都能按固定时间接管。

### 后续observability增量：选择性运行验收通过

新镜像`sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb`使用3个真实worker创建的mock成员。双副本诊断接口均验证缺失/错误鉴权401、额外查询400及no-store；MySQL暂停期间诊断仍200（8/7ms），原owner转standby、失权计数0→1、原因`storage_unavailable/deadline`，另一个standby失权计数仍0。业务请求同时安全503 `pool_storage_unavailable`。解暂停至调度与健康恢复12.282秒，后续推理200、hold/cataloghold0；最终paused1、target0、max8、ttl600。

暂停控制跨度18.322秒包含有意等待12秒和业务约5秒失败预算；整体32.976秒，不把这些测量值承诺为恢复SLA。独立证据核对确认双Proxy健康、RestartCount均0、精确预期镜像及生产源码hash匹配；两个副本总计仅1条`ownership-lost`日志，在原owner上且只有安全allowlist字段、原因`storage_unavailable/deadline`，另一副本无此日志。MySQL已运行、解暂停且健康，之前v4-final-load的MySQL卷保留。

原脚本必填字段检查不足属于测试辅助缺陷；本地严格契约修正后新增3测试通过，并对6份已存真实快照严格重验通过，无第二次故障注入。严格脚本未远端重跑；执行脚本hash、事后校验证据、完整日志与独立核对结果在[后续进度](user-pool-post-v4-progress.md)分别记录。

## 为什么SQLite worker失权会挡住正常LLM请求

不是模型请求必须同步等待worker。当前SQLite路径在分配账号/转发前调用owner guard，把“本机worker有有效调度资格”作为允许业务请求的条件；所以失权停止后，已有Ready库存也被入口拒绝。这是旧单实例设计的保守耦合，不等于理论上SQLite所有推理必须依赖建号worker。

多Proxy＋MySQL路径已拆分：只有后台开户/修复需要调度owner，正常推理由共享数据库中的caller/member/hold事务和凭据校验保护。因此单纯调度资格切换不应令健康非owner实例拒绝所有业务。不要直接删除SQLite检查来修复，必须连同单写者保护、租约/凭据安全和旧worker生命周期一起验证。

“某一步建号失败”和“整个worker失去调度资格”也不同。前者一般进入该成员的重试/失败状态，不直接使全池业务503；后者才触发当前SQLite全池owner guard。

## 3. 新增待办：503可定位、恢复可观察、不会误恢复

### 3.1 错误分层与可观测性

- [x] 后续分支已实现ownership-lost脱敏原因分类：本地任期超时、续约被拒绝、连接/SQL截止导致存储不可用、其它存储操作失败。不记录token、caller原值或任意驱动错误全文。
- [x] 已实现本机worker状态/任期年龄、最近成功续约时间、失权/竞选计数及只读`GET /api/user-pool/diagnostics/local`。这是本进程内存快照，不是summary API新增的全局权威字段；进程重启后计数重置。完整本地回归438pass、0fail、25条件skip，类型检查通过。
- [x] 新诊断镜像选择性运行验收已通过：双副本接口契约、MySQL暂停时诊断可读与安全业务503、恢复后调度/推理及hold排空。原执行脚本与事后严格快照校验分开记录，不声称修正后的严格脚本已远端运行。
- [x] 本次运行日志和容器RestartCount独立核对通过：双副本健康、RestartCount均0、镜像/源码hash匹配；全程仅原owner有1条安全失权日志，另一副本无；MySQL恢复健康，先前v4-final-load的MySQL卷保留。
- [ ] 集群无有效调度者判断、持续时长、跨副本采集和告警阈值需单独设计、接入和验收。一次本机standby/null快照不表示全局无owner；本机诊断信号不等于完整告警系统。
- [ ] 区分API层：`pool_owner_unavailable`（当前SQLite保护）、`pool_storage_unavailable`（连接/预算/资源不可用）、成员暂不可用等503；池耗尽/冷却是429，不能全部归到“没owner”。
- [ ] 将LiteLLM model group、Proxy请求关联ID和安全错误码贯通排障；精确核对`ghcp/claude-sonnet-5`与无前缀组的fallback，不能将备用路由当作owner恢复。

本机诊断的接口、安全边界和验证状态见[接口说明](user-pool-local-diagnostics.md)。

### 3.2 进程级恢复与故障隔离

- [x] 冻结v4独立worker两个子场景已实际通过：Login受理、checkpoint未写回时SIGKILL旧进程；新进程先standby，等待真实约30秒TTL后接管原任务/nonce、无第二次POST。另一个子场景验证超龄任务及迟到回调/旧观察结果保护。TAP3包含父包装，不是三个业务场景。
- [x] 冻结v4独立routes两个用例已实际通过：各自模型缓存、共享MySQL下的GET/HEAD目录部分取消＋双进程推理，以及旧凭据ABA/success-first顺序与重新warmup准入。
- [x] v5真实SIGSTOP/30秒任期到期/SIGCONT验证旧worker恢复后不能越权写入；新owner沿用原任务/nonce。独立路由全消费者取消及ABA/A→B的401-first补充顺序实际通过。
- [x] v5三/五独立Proxy副本复验通过：单owner、全副本服务、跨副本排他和热点隔离；owner SIGKILL后存活副本在真实选主间隙持续成功推理。
- [x] Login真实120秒网络GET停滞和独立模拟服务进程重启两个子场景通过；原任务/nonce、failed操作员状态和无重复POST检查保留，显式retry后才预热。
- [ ] 其它SSO/SCIM/seat副作用边界及更广排列未穷尽。上述用例不替代跨节点HA、实际Login持久存储或真实浏览器。详见[v5有界补测](user-pool-v5-resilience-tests.md)。
- [ ] 完整故障隔离组合仍需按目标补齐。已有冻结v4数据库实际重启/恢复证据、本轮MySQL健康时worker接管证据，以及新诊断镜像的数据库暂停/恢复观测证据；但不能据此声称已验证所有“调度切换期间健康副本持续推理”和“数据库整体不可用”排列。继续区分健康副本服务、有界安全失败、恢复后重新竞选及不盲目重放。
- [ ] 明确无调度者期间的库存影响：Ready尚足时服务可继续，库存耗尽/凭据需修复时失败增加；定义可接受的调度恢复目标与告警阈值，不承诺仅凭30秒租约就30秒内恢复。
- [ ] 核对负载均衡摘除条件及终止排空。readiness摘流量、liveness重启和Docker restart策略不是一回事；不能对所有数据库短故障同时重启全部Proxy。

### 3.3 客户SQLite旧版本恢复（暂缓，非MySQL上线阻塞项）

客户拟升级多Proxy＋MySQL，不为此先开发SQLite专属自动恢复；过渡期及回退方案需保留故障取证和受控恢复步骤。以下旧版本工作未实现，不等于已修复，也不纳入本轮MySQL补测。

- [ ] 日志取证、确认单写者、检查锁/磁盘/资源停顿；尚未取得客户现场根因证据。
- [ ] 单独评估并实现不可恢复失权后的有界清理和受控非零退出/有限重启机制；保持旧任期fence，不删owner、不简单取消stopped保护。本机诊断增量未实现该恢复机制。
- [ ] 验证正常MySQL standby不会触发SQLite退出路径；不在冻结v4上直接混入热修复。

## 4. 风险与上线门槛

| 情况 | 预期影响 | 必须守住的边界 |
| --- | --- | --- |
| A失去调度资格，B与MySQL健康 | 补池/修复可能短暂停顿；B可处理可用成员的请求 | 只有有效owner执行后台写步骤，旧任务不越权 |
| A进程被杀或停顿 | A上的现有流可能中断，B可接新的请求，取决于入口摘除 | 不重放不明结果的推理，hold按保护规则排空 |
| MySQL整体不可用 | 多个Proxy都可能503，进行中的流可能中断 | 不凭内存猜租约/凭据归属，不能为避免503而绕过共享库 |
| 无调度者且Ready不足/凭据需修复 | 请求可因耗尽或成员不可用失败 | 告警和恢复，不盲建替代用户/席位 |

Rancher跨节点、实际MySQL主库HA、客户备份恢复、真实上游及SSO/Login/Console单实例恢复方案仍是独立生产上线门槛。不要把“非owner可服务”理解成“不需要数据库、不会503、已有流永不中断”。

## 5. 本次状态

v5本机诊断、选择性运行验收及后续四组有界进程测试均已通过，包括旧worker暂停恢复、Login真实超时/模拟服务重启、目录取消/凭据顺序、3/5副本故障期间服务。当前没有确认但尚未修复的MySQL同型永久失权缺陷；不把仍可能发生的安全503说成全部消失。全局告警/请求关联/入口恢复配置、目标生产环境验收仍待交付，更多排列按目标另排。客户拟迁移MySQL，SQLite专属自动恢复暂缓、非MySQL上线阻塞项。最新版本、提交状态和剩余事项见[状态总览](user-pool-mysql-status.md)。
