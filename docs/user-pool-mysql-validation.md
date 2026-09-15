# MySQL 多 Proxy User Pool 验证记录

日期：2026-09-15。当前未提交候选`caller-isolation-v4`，分支`ghcp-user-pool-mysql`，基线`da76eb1`。热点caller隔离严格对照、真实MySQL契约和新空库生命周期通过；独立取消安全审查未完成，v4尚未重跑30分钟soak、0→2000及2000caller请求负载。未commit/push、未部署客户环境；最新进展与待办见[状态总览](user-pool-mysql-status.md)，历史审查见[修复记录](user-pool-mysql-production-review.md)。

## 2026-09-15 四agent确定性组合验证（生产源码不变）

新增5个测试文件，四组最终实际通过：owner副作用22项、catalog7项、凭据竞态8子场景＋2父包装、Login轮询6项。MySQL均用严格opt-in随机隔离库，外部mock，不称独立OS进程验收。Login首轮MySQL计数断言失败3项保留，修正为身份集合检查并增强禁止调用记录后最终通过。生产源码50文件SHA未变；整合后完整Proxy443tests/418pass/0fail/25条件skip，workspace与upgrade类型检查通过。完整层次及日志SHA见[确定性测试报告](user-pool-deterministic-tests.md)，安全处置见[恢复原则](user-pool-recovery-triage.md)。

## 2026-09-15 热点caller连接隔离

新增本地有界caller gate，数据库命名锁仍为跨副本权威；5秒预算包含本地等待、获取连接与事务。完整Proxy394pass/0fail/8条件skip、实际MySQL组合43pass/0skip、类型检查/部署构建通过。新caller-isolation-v4镜像严格HTTP对照：热点caller命名锁6.5秒时，另caller两副本探针从约4915/4907ms降为23/31ms且200；A仍约5秒503，取消/marker/hold/锁清理通过。新空库14阶段生命周期61.418秒全部通过。完整证据和限制见[caller隔离报告](user-pool-caller-isolation.md)；此前30分钟soak不属于此新镜像。

## 2026-09-15 扩展组合与实际数据库重启

逐项结果、镜像归属、首次失败与修复复测见[扩展测试报告](user-pool-extended-test-report.md)，待测清单见[扩展矩阵](user-pool-extended-test-matrix.md)。新增真实MySQL两项生命周期契约及两项回调回归通过；14阶段HTTP组合完成多轮补池、管理操作、32成员401恢复和最终排空。实际数据库重启发现即时连接错误的500/502映射缺口，限定修复后完整Proxy368pass/0fail/7条件skip及workspace类型检查通过。新镜像已使DB中断时两副本返回503；首次复测仍因测试桥接断流问题失败，夹具修复及两项真实HTTP回归通过后，第三轮完整MySQL重启通过（停止至start完成35.172秒，故障/恢复核对40.956秒，Proxy无需重启，新owner、hold0）。storage-error-v3镜像30分钟soak完整通过：1807秒5083请求、0意外错误，最终hold/cataloghold0、上游客户端marker唯一。

## 0→2000真实补池流程（修复版新空库已通过）

首轮新空Azure测试库、不seed Ready，真实Worker/SSO/MySQL、mock外部链路执行约41分28秒后主动暂停：库存/SSO/SCIM/席位均2000，但仅96Ready，106Login任务均已成功，另5warmup/5oauth-wait/1894oauth-starting。没有failed/冲突/重试错误；mockLogin几乎无排队。确认阶段选择对Login容量不敏感，满槽starter反复轮转拖延完成观察/warmup，属于此前小池和预置2000压测未覆盖的规模性调度缺陷。现已修复容量筛选及3优先/1最老公平选择；首轮失败保留，**不能把前次持续请求通过当成大规模从零建池通过**。新空卷完整结果见 [0→2000报告](user-pool-provisioning-2000-test.md)。

### 修复版完整建池结果

新空卷 `azure-provision-2000-v2`、相同prewarm5/pending5/mockLogin1及50ms延迟，真实Worker自动建池 **625.922秒**、总验收 **634.760秒**，**2000成员全部Ready且凭据有效/verified**；SSO/SCIM/seat/Login POST/成功回调各2000，逐成员warmup恰好一次，0failed/重试/冲突。双副本各20页及SSO全量分页通过；2caller跨2Proxy的4次canary全部成功、4条统计归属正确，释放测试租约后lease/hold/cataloghold全部0。299次SQL观察、11次资源采样，owner未变，没有注入故障。最终Worker暂停，旧失败卷保留。该结果不是真实浏览器耗时、最大吞吐或Rancher/DB主库HA认证。

### 调度修复后的验证检查点

- 全Proxy **330 tests/325pass/0fail/5DBskip**；全workspace和两套upgrade类型检查通过。
- 实际云端随机隔离MySQL scheduler/pool/admission/recovery **45pass/0fail/0skip**，包含本次两驱动积压契约与前一候选的安全回归；父包装/嵌套/离线场景不重复相加。
- 真实Worker+realProvisioner、异步SQLite包装、2000starter积压回归通过；旧排序负向对照失败；最终原子claim在五lane争一slot时无超限。
- 新Proxy镜像 `sha256:4d0dd72555aa2e44d8b5cc1684313e97e748f3ef50b2115d87d099c745d2dced`，两副本已核对运行digest；旧卷保留，新建池使用不同空卷，不把旧候选负载或soak归给新镜像。


## Azure 分机持续验收（2026-09-14 已通过的独立场景）

完整场景、时间线、错误分类和资源指标见 [Azure独立测试报告](user-pool-azure-test-report.md)。

已在全新Azure服务VM（D8s_v5/32GiB/PremiumSSDv2）和独立压测VM（D2s_v5/8GiB）完成测试，源码上传hash一致、生产逻辑未改。本机Docker保持关闭。分机smoke通过；完整6并发soak实际流量 **1942秒、4809请求、0意外错误**。正常完成4392、主动取消242、预期错误/管理采样176；管理计数不是互斥HTTP结果，不能直接相加。HTTP状态200=4636、401=1、429=140、503=32，故障内断流/503正确拒绝而非伪装成功。

70次冷却绑定检查、254次延迟SSE、一次401原成员恢复、自然到期及两次故障均通过。Proxy退出至恢复39.1秒、MySQL暂停至恢复14.8秒；最终12成员/6租约、hold/cataloghold0。4809已发marker对应4707唯一上游marker（其它因拒绝/故障未到上游），无自动重放，最终租约归属和mock记录核对通过。

正常JSON P50约16.2ms、P95约22.1–22.8ms、P99约26.1–26.4ms，仅小型mock且非吞吐上限。服务/发生器分机、Linux/磁盘/Node版本等共同变化，本轮未启动LiteLLM网关profile；不能量化环境因素占比或覆盖客户Rancher/DB主库HA。详细配置与边界见 [Azure测试环境](user-pool-azure-test-environment.md)。以下本地失败作为历史证据保留，不再表示此规定场景从未完成。

## 稳定性扩展阶段（本地历史）

实际HAProxy健康摘除/恢复及第一Proxy离线时新增合成成员回调通过；真实LiteLLM v1.99.1+独立PostgreSQL的HTTP virtual-key鉴权、伪造头覆盖、撤销、双后端各3次/同租约、一次503主路由+一次pool fallback通过，生成5把测试key已撤销。

**30分钟持续测试尚未通过**：约1402秒、4133次请求后，429前后租约快照断言失败；3812次成功、208次取消、114个按注入窗口分类的预期错误，另有1个业务断言失败及随后的停止检查失败。此前Proxy停止/恢复约40.1秒、MySQL暂停至恢复约14.8秒，测试后均已恢复。无最终上游marker/排空验收，因此不把局部指标称为整体通过。

同租约事件显示cooling之前约114ms有正常成功续租；测试基线已改为等待前一请求hold排空。用户重新授权后在新`stability-v3`完成smoke并两次重跑：

1. 基线修正版本总137秒即停止：测试仅注入1秒冷却，而探测约2秒后才到上游，返回200时冷却已过；这是额外的测试时间窗口缺陷。保留该失败，注入改为10秒，并增加数据库观测时冷却尚未结束的断言，产品冷却实现未改。
2. 10秒冷却版本实际流量949秒、总997秒、2454次请求，**仍失败**。2193成功、118取消、74预期错误；35次冷却绑定检查通过，未重现之前两项冷却断言。错误计数73包含63个意外HTTP状态（503）、6个传输/流错误、2个资源快照失败、1个夹具传输错误及停止检查。非故障窗口出现pool SQLdeadline、owner丢失，Docker资源采样也超时；根因未确认，不能全部归于测试或电脑。Proxy退出约37.9秒后恢复，MySQL暂停阶段尚未开始；最终marker一致性/hold核对未完成，不能标记30分钟通过。

最新runner为失败响应补充脱敏`responseCode`，不放宽预期错误窗口；本轮没有修改生产源码、放宽SQLdeadline或改变并发标准。旧数据与失败报告保留。此前几分钟pilot也不计通过。

**合成完整迁移已通过**：新生成只读SQLite备份3有效账号、2活跃租约、106统计，经原importer导入随机空MySQL；启动两个实际Proxy经HAProxy服务，保留原凭据哈希、绑定/leaseID、启动TTL，12次JSON/SSE均成功；统计按retention106→103→109，精确历史保留集合核对通过；没有重新开户，源文件字节不变。为符合空fixture断言仅更换SSO/Login/Console辅助合成卷，保持同一MySQL卷中的导入目标，旧卷未删除。真实客户备份、Rancher入口/节点故障和DB主库HA仍未验收。详见 [稳定性计划](user-pool-mysql-stability-plan.md)。

用户补充目标环境是Rancher，并要求记录NGINX替换待办；见 [Rancher入口高可用待办](user-pool-rancher-ha-todo.md)。当前HAProxy验证不等于Rancher/NGINX节点级HA验收，生产代码/镜像在本扩展阶段未改。

## 2026-09-14 修复版最新结果

- 新 Proxy 镜像 `ghcp-pool-mysql-proxy:production-fix`：`sha256:2b3e3cd1b18f237031ac83d71850f3682f2f23e01d69ec9646ff0db920abf686`；Console `ghcp-pool-mysql-console:production-fix`：`sha256:9e62e23899ae92b4f2bf186dd517e325162cd90045d4ce4f12e0e3cc4ff5828b`。六个关键 Proxy 源码 SHA-256 与镜像一致，构建使用批准的包源，零漏洞报告。
- 最终普通 Proxy **323 passed、0 failed、4 skipped**；四个独立引擎入口随后单独验证。通用MySQL repository **1**、pool/admission **38**、恢复 **5**、迁移 **66** passed，零失败零skip。数字含父包装/嵌套和离线故障用例，不简单相加。
- 新回归覆盖慢stats及时续租、断连停止heartbeat/迟到不转发、错误配置先于retention拒绝、SQL/DDL及不明commit/lock清理、原子终态fail/回调、慢观察隔离、默认配置一致、坏schema拒绝。2000集中到期在busy/held前缀下最终全部排空；约304秒为该隔离场景总时间，不是生产恢复SLA。
- SSO31/Login12/Console6、LinuxChromium页面4（分页/过滤/乱序/mutation/卸载）、离线hook+Compose23、workspace typecheck/build通过。宿主LiteLLM固定版本运行时此前缺依赖5skip，未冒称本轮通过。
- 新独立 `production-fix-smoke` 数据集完成双Proxy实际HTTP smoke、正常mock预热3成员、目录/JSON/SSE/429/取消/hold保护、原owner退出后的standby接管和共享凭据保留。重启后第一次健康检查过早返回502；确认两台ready后复验通过，不称重启零中断。
- 新 `production-fix-load` 数据集：2000合成成员/caller、25并发、2轮4000推理+22管理/目录，**4022全部HTTP200，0错误**。第一轮135.444秒/14.77成功请求每秒，第二轮85.099秒/23.50每秒。JSON P50约1.08–1.10秒、P95约3.21–3.35秒；SSE P50约1.09–1.13秒、P95约2.86–2.92秒。383次SQL采样、最高26hold，最终2000active唯一caller/member/lease、hold/catalog hold为0。
- 负载新断言精确比较accounts page20第1900–1999 ordinal及identity，并将leases page20与数据库同排序offset结果逐项比较，不仅检查数量。跨副本lease/member不变、stats归属、上游不重复、catalog不续租、零开户/授权计数均通过。
- 负载期间没有并发构建或其他测试；仍是同机Docker Desktop、双Proxy各10连接、MySQL8.4、本地20ms mock、Node24.14.0，无服务独占资源配额。此轮首轮吞吐低于历史caller-lock结果，未做受控性能A/B，不能声称修复提升QPS或达到客户SLO。

以下保留 **2026-09-13 caller-lock 修复前的验证历史**；其中“本轮/最新/当前工作区”均指历史时点，不指上方修复版。

## 安全范围

所有新测试只使用合成账号、虚构 OAuth token、独立 MySQL 数据库及本地 mock 上游。没有访问真实 GitHub/SCIM/Copilot，没有创建真实 EMU、添加/撤销席位或调用真实模型。本次电脑重启后的续验没有启动、停止或修改原真实 SSO 项目。

此前六套历史 mock 容器曾停止以降低资源竞争，卷保留。各轮测试使用不同的命名卷，旧失败数据未删除；本轮分别使用 `reboot-caller-smoke` 和 `reboot-caller-load` 数据集。Proxy、SSO、Login、mock、MySQL 仅在 internal 网络；固定目标 bridge 单独接入预览网络，端口仅发布到 loopback。

## 版本与证据

- 实际运行的两台 Proxy 均使用 `ghcp-pool-mysql-proxy:caller-lock`，镜像 ID：`sha256:201bc7be4c0ee490968496e6c7f232384ec1e3c052112f3118c445528016db88`。
- 核对了镜像内 `mysqlStore.ts`、`mysqlDeadline.ts`、`runtime.ts`、`worker.ts`、`provisioner.ts`、`compatible.ts` 的 SHA-256，与当前工作区对应源码一致。没有把旧 `:check` 镜像结果当作 caller-lock 结果。
- caller 锁只读复核已完成，未发现可确认的跨 caller 共享、冷却绕过、旧凭据 admission 或锁泄漏阻塞；静态复核不替代测试。
- 原始日志保留在本地私有会话目录，不纳入公开 Git；本文件只记录聚合指标和合成环境信息。

## 功能与回归

- 本次重启后全 workspace typecheck 通过。
- 最新完整 Proxy 回归：**256 通过、0 失败、3 跳过**。跳过的是普通 MySQL repository、pool MySQL、caller admission MySQL 三个独立集成入口；不计作通过。
- caller-lock 真实 MySQL 两套契约的已保存结果：**38 通过、0 失败、0 跳过**。包括原 pool 契约 22 项与 caller admission 契约/故障注入 16 项（含嵌套计数）。覆盖同 caller 目录/推理收敛、不同 caller 排他、无关设置/成员锁不阻塞分配、过期与排空、禁用竞态、凭据隔离、数据库范围命名锁及释放失败处理。
- 迁移的此前验证：49 项通过，含只读源预检、实际 MySQL 导入、并发导入互斥、校验失败回滚和不明 commit；不把它表述为本轮负载的一部分。
- SSO31、Login12、Console6、Linux Chromium 页面交互1、LiteLLM离线hook17及固定v1.99.1回调5、Compose6均有此前通过记录；Windows Edge 曾卡在浏览器退出，不改写为通过。
- 本轮实际 Console 镜像已登录，User Pool 能加载共享数据和分页说明。截图及 HTTP 证据已保存。
- 四个 Dockerfile 均完成过构建；caller-lock Proxy 重试构建成功，npm审计0项告警。组织批准包源曾发生网络超时，没有切镜像站、关闭TLS或绕过审核。

不同批次有重复覆盖，不把上述数字相加宣传为单次全套验收。以后若继续修改生产源码，应复验受影响路径。

## 最新镜像双 Proxy 与故障接管

本轮重新创建空测试数据集，实际 worker 开通3个合成成员（SSO真实组件，GitHub/席位/Login完成/模型响应均mock）。验证通过：

- 两副本连接同一 MySQL，只有一个有效调度 owner，设置版本冲突正确拒绝。
- Messages、Chat、Responses 的 JSON/SSE 和 canonical model ID 正常。
- 同 caller 并发/轮流访问两副本保持同一成员；不同 caller 不共享成员。
- 池耗尽不访问上游；429持久化冷却跨副本生效，不因有备用成员而换号，不续租。
- 流式 hold 可被另一副本看到，跨副本释放被拒绝；客户端取消后 mock 观察到断连且 hold 排空。
- 停止第一台 Proxy 后，第二台取得新的调度 owner、续约并继续用原 lease/凭据服务，没有重复开通。
- 恢复第一台及重启两台 Proxy 后，共享设置、成员、有效绑定和凭据保留。

fixture 的内部回调固定指向第一台 Proxy；停机窗口仅验证已有租约服务与调度接管，不验证第一台离线时的新开户回调。生产必须按实施文档提供可信 LB，并单独验收健康摘除和回调路径；本轮没有验收客户 LB、MySQL 主库故障切换或长时间网络分区。

## 2000 成员、25 并发：本轮通过

环境：电脑重启后的 Windows Docker Desktop，Linux VM报告12逻辑CPU、约15.53 GiB内存上限；没有逐服务独占资源配额。双Proxy各10个MySQL连接，MySQL8.4，固定20ms本地mock，宿主压测程序Node v24.14.0。负载期间未同时跑构建/其它回归。

预置2000个合成ready成员及2000个caller hash，worker暂停、idle target0。每个caller调用两轮，第二轮改由另一台Proxy接收；混合三个协议的JSON/SSE。此负载不经过真实LiteLLM virtual-key认证，也不执行自动开户；这些能力分开验证。

| 项目 | 结果 |
| --- | --- |
| 推理请求 | 4000次，全部成功 |
| 管理/模型目录请求 | 22次，全部成功 |
| HTTP总数 | **4022次，全部200，0错误** |
| 第一轮：2000次首次绑定调用 | 53.798秒，37.18次成功推理/秒 |
| 第二轮：2000次跨副本复用 | 79.310秒，25.22次成功推理/秒 |
| JSON请求延迟 | 各协议P50约467–478ms，P95约1.76–1.82s，P99约4.28–4.33s |
| SSE请求延迟 | 各协议P50约908–920ms，P95约3.71–3.75s，P99约5.75–6.05s |
| SQL状态采样 | 241次，最高观察到37个hold，无采样不变量失败 |
| 最终状态 | 2000个active排他租约，hold及catalog hold为0 |

额外断言通过：跨副本没有转绑/lease ID变化、上游marker不重复且完整结束、每条请求统计的caller/lease/member对应正确、page20返回total=2000及100条记录、目录查询不续租。**page20断言未比较具体记录身份或与page1的不重叠，不能声称已证明精确第1901–2000条；UI搜索第2000成员是单独证据。** 压力阶段mock SCIM创建/授权派发/回调计数均为0，未创建任何真实账号或席位。

37个hold不等于37个压测工作线程：HTTP响应返回后持久化finish可能仍在清理，采样可短暂高于25个客户端工作线程。最终已全部排空。

这是一次规定负载的功能/一致性和错误率通过，不是吞吐上限，也未定义或满足客户延迟SLO。SSE为短小mock回复，不代表真实长文本生成。后续应在接近客户CPU/磁盘/网络的独立环境复测。

## 历史失败结果保留

以下均在新caller级admission完整压测前执行。每轮目标为25并发、两轮4000推理，但第一轮失败后未继续：

| 迭代 | 第一轮推理数 | 第一轮耗时 | 成功推理/秒 | HTTP/传输检查错误 |
| --- | ---: | ---: | ---: | ---: |
| 初始全池锁 | 2000 | 538.093s | 2.93 | 426 |
| 无锁heartbeat、索引回收和唤醒合并 | 2000 | 320.722s | 5.88 | 114 |
| 成员级finish事务 | 2000 | 272.732s | 7.24 | 26 |
| 分配索引排序优化与启动预算分离 | 2000 | 395.173s | 4.23 | 330 |

此前5并发基线也曾失败：第一轮364.415秒，5.48成功推理/秒，2008次HTTP中2次500，未完成第二轮。

旧慢语句统计确认全局settings分配锁是主要等待点，另有回收扫描、idle选择filesort及重复写事务。本版改成database/caller命名锁和成员行锁、候选复查/局部回收。运行期SQL预算仍5秒，没有用放宽业务超时换取通过；DDL独立60秒预算。

**电脑重启、背景进程负载和代码都发生变化，所以不能把新旧吞吐差额全部归功于caller锁优化，也不能把旧失败改写成通过。**当前结论仅为最新镜像在所述环境、规定负载下通过。

## 发布边界

当前为本地开发分支，未commit/push。**前次审查缺陷已按上方修复版记录关闭，不应将历史失败当作仍未修复，也不应将修复测试当作客户环境放行。** 仍需客户实际资源负载/SLO、受信LB及MySQL可用性验证，和客户备份副本的授权迁移演练。配置fingerprint运维变更、SSO/Login/Console高可用、池外旧成员纳管、真正无停机迁移、真实GitHub并发/费用验证仍不在本轮交付。
