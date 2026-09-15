# User Pool 扩展测试报告

版本说明：本文主要记录scheduler-v2与storage-error-v3的分批测试。当前caller-isolation-v4的严格隔离与61.418秒生命周期复验见[caller隔离报告](user-pool-caller-isolation.md)；最新进展和用户指定四类待办见[状态总览](user-pool-mysql-status.md)。本文30分钟结果不能算作v4已重跑。

日期：2026-09-15。分支 `ghcp-user-pool-mysql`，基线 `da76eb1` 上未提交候选。测试只使用已授权的隔离AzureVM、合成数据与mock上游；未操作真实GitHub/EMU、付费席位、客户SSO或真实模型，未commit/push。

## 执行环境与证据边界

两VM分工：服务VM运行Docker中的双Proxy/MySQL8.4/SSO/Login/Console/mock/HAProxy，发生器VM通过固定私网bridge发请求与只读SQL观察。保留历史卷；新场景使用新具名卷，不直接写Ready来绕过预热。真实Login浏览器不运行，授权完成通过mock任务调用真实Proxy回调。

调度候选：`sha256:4d0dd72555aa2e44d8b5cc1684313e97e748f3ef50b2115d87d099c745d2dced`。后续数据库连接错误修复的新镜像及复测结果单独记录，不将旧镜像结果归到新镜像。

## 1. 环境恢复与8成员预热：通过

公司策略关机后VM已授权启动，但测试容器未自动启动、mock内存状态和`/tmp`合成配置丢失。保留旧卷，重新生成合成配置并移到持久测试目录，新卷启动；首次缺env、随后合成SQL0600导致MySQL非root读取失败均记录为夹具恢复失败，不归因于业务逻辑。仅修正测试文件为0644，没有放宽业务SQL预算。

新空库真实Worker生成8成员，SSO/SCIM/seat/Login/callback/warmup完整流程，全部Ready；后续暂停补池，私网桥接健康。

## 2. 新增事务和回调恢复契约：通过

实际执行4项、4pass、0fail、0skip：
- MySQL：4个并发设置/预留请求在真实settings行锁上等待，只有一个CAS更新胜出；pause/shrink/resume后的预留遵守串行预算，cap下降不删除已有成员/租约。
- MySQL：全池凭据变更在多个inference/catalog hold下，先修未占用成员，部分hold排空不能开始修复，最后hold排空后每原成员仅恢复一次且不新增账号。该契约用注入warmup适配器，完整外部链路另见第3节。
- SQLite实际存储及真实Worker/provisioner：回调写入前失败、写入后确认丢失两种情况，均通过新nonce恢复原成员，旧成功/失败回调不得覆盖或撤销新凭据。

## 3. 业务请求与多轮补池、管理和全池401：通过

同一连续HTTP场景共14阶段，全部通过，**56.032秒**。旧候选调度镜像，prewarm5/pending5、mockLogin1/100ms；空库存开始，无Ready seeding。

- 4轮增长：8→14→20→26→32，每轮新增6成员；每轮都有12次在补池期间完成的业务请求，并以SQL在请求前后证明仍有provisioning，而非只在两轮间发canary。
- 6个初始caller租约一直保留到明确注入全池401前。
- cap降到12（当时已有26成员）不删除库存、不驱逐caller；暂停/恢复、cap耗尽429、stale CAS409、非法cap400、disable/resume/retry按契约处理。
- 3次跨副本held-release返回409，取消且SQLhold排空后才释放。
- 全32成员同时401：旧lease失效并在hold排空后删除，不续租、不重放；原32inventory/SSO/GH身份完成修复，新增请求形成新的32个排他lease epoch。不是承诺401前后永远同lease。
- 最终32verifiedReady、6个新epoch租约、26idle、hold/cataloghold0、provisioning0，Worker暂停。
- SCIM新增32、席位新增32；65次授权/成功回调=初始32＋一次手动恢复＋全池32恢复；66次warmup另含一次disable/resume重验。
- 216次推理请求，207个上游标记唯一，9个拒绝在到达上游前完成；统计校验208行。HTTP总442（含管理/观察），cleanup3；预期失败计数51含鉴权/管理/业务错误，不与推理状态简单相加。

报告SHA-256：`44dc5ee745297f658dfee748945e1d8fa31f0dd05322fd5ab486cc3ceaedf7ae`。完整报告在发生器 `/opt/ghcp-test/results/matrix-lifecycle-report.json` 和本地私有证据目录均已保存，SHA-256一致；公开文档只列聚合结果，不表示隔离数据库或mock没有合成身份。

| 连续场景阶段 | 耗时 | 结果 |
| --- | ---: | --- |
| 空fixture、鉴权与CAS预检 | 0.270秒 | 通过；5次预期拒绝 |
| 初始8成员预热及三协议canary | 6.180秒 | 通过 |
| 第一轮8→14补池 | 4.501秒 | 通过；12次补池中成功请求 |
| 第二轮14→20补池 | 3.987秒 | 通过；12次补池中成功请求 |
| 第三轮20→26补池 | 4.119秒 | 通过；12次补池中成功请求 |
| 暂停、cap降到12、安全释放 | 9.680秒 | 通过；库存26不删除 |
| 扩容设置及新增8个caller绑定 | 0.165秒 | 通过；该阶段不新建8个成员 |
| 第四轮26→32补池 | 3.919秒 | 通过；12次补池中成功请求 |
| cap耗尽 | 5.693秒 | 通过；额外caller两次被拒绝 |
| disable/resume及失败成员retry | 6.146秒 | 通过；原成员恢复、新lease epoch |
| 全32成员401 | 0.717秒 | 通过；32次401、6次耗尽拒绝 |
| cap内原成员自动修复 | 9.411秒 | 通过；32个新请求建立新epoch |
| 两轮释放、保留6个新epoch | 1.128秒 | 通过；释放26个租约 |
| 最终身份、统计、marker核对 | 0.114秒 | 通过；hold/cataloghold0 |

这些是同一连续场景的阶段耗时，不是14次独立运行，不能相加替代总墙钟56.032秒。401修复保留原成员库存和外部身份，不保证每个caller之后重新取得原member；自动修复本身不创建caller租约。

## 4. MySQL真实重启：发现问题、修复后完整通过

真实SSE已到上游且存在持久hold后停止MySQL。新请求返回**500而非安全503**，测试即停止、finally恢复MySQL；因此这轮没有完成35秒中断及后续恢复，不算通过。

独立4个driver边界回归复现：ECONNREFUSED/ECONNRESET发生于admission返回500HTML，发生于已admit后的凭据读取返回502并带原始message，缺少pool_storage_unavailable和Retry-After。

限定修复：仅在MySQL驱动调用边界识别连接故障并包装安全错误，销毁已失效socket；runtime/compatible统一安全503，models错误恢复中的二次数据库故障也归入同一路径。保留通用SQL/应用错误及上游网络错误，不新增重试，COMMIT不明仍不重放。独立源码复核无确认问题。修复后全Proxy375total/368pass/0fail/7条件skip、workspace+upgrade typecheck通过。

新镜像：`sha256:fcd525ebb30f92fa353a6b24ff1992837b99f22b2aab3a8ecc56d8f620f2db95`（`storage-error-v3`）。修复后源码又实际执行MySQL scheduler/pool/admission/recovery/lifecycle组合，**47pass/0fail/0skip**（包含父包装和少量离线控制，不称47个独立数据库故障）。第一次新镜像复测两个Proxy均503、MySQL中断35.148秒后健康，但流客户端结束等待超时，整项仍失败。事后SQLhold/cataloghold均0，上游对应held流约5秒后已经cancelled；证明服务端已清理，不能将客户端悬挂等同于DBhold泄漏。

已确认测试桥接只pipe上游响应，未传递响应开始后的aborted/error/incomplete-close，可能留住下游连接；测试脚本finally还有对同一stream的无界等待。只修夹具传播和报告/清理边界，补真实HTTP断流回归后再执行，原失败保留。不能推断为何客户端fetch60秒abort没有及时settle，需诊断记录，不归为未经证实的Node缺陷。

修复桥接后，两项本地真实HTTP回归通过：正常EOF保留，部分响应后断流必须销毁下游而非挂住。第三轮实际数据库重启 **完整通过**：MySQL容器停止至start命令完成35.172秒，故障、健康恢复及检查40.956秒；两个Proxy故障期均503，恢复后不重启Proxy即成功服务，新有效owner任期生效；共享settings及本测试一个基准active lease的member、leaseID、expires_at和last_success_at在中断后保持，之后成功请求正常续租并显式释放该租约；最终hold/cataloghold0。SSE收到20块892字节后约5.023秒以socket错误中断，未出现message_stop，无客户端abort或fallbackcancel，4个上游marker唯一。原500和streamtimeout两轮失败均归档。通过报告已下载并校验，SHA-256：`e318c4c707839d7d56ffcd35c9397d23a7eec78119b7db44066dec208f36d436`。

## 5. 先前扩展测试结果

- 慢Login1/5，120成员、每任务1秒：128.313秒／48.514秒，各任务/回调数正确、无超槽或遗留队列。
- 建池owner退出严格零错误测试失败一次回调；保留504Ready现场恢复到2000Ready，467.841秒，2001任务中2000成功＋1旧失败，identity/nonce不重复。这证明恢复，不是无中断。
- 热caller32并发＋另caller2请求，取消16个：短锁其余18成功；长锁其余18约5.05秒安全503，迟到清理、无上游重放、锁释放和恢复探针通过。但另caller也503，**当时共享连接资源隔离不足**。后续`caller-isolation-v4`已实施获取连接前的有界caller队列，独立严格对照及生命周期回归通过，见[caller隔离报告](user-pool-caller-isolation.md)。本文30分钟结果仍属于storage-error-v3，不归到后续镜像。

## 6. 本轮构建与服务回归

- storage-error-v3源码检查点：375tests，368pass，0fail，7条件数据库入口skip。真实MySQL另执行组合47pass/0skip，覆盖有重叠，不把两者相加。
- 全workspace与两套upgrade类型检查、部署build通过。
- SSO31、Login12、Console6全部通过；本轮不包含再次运行Console浏览器套件，其4项历史证据另列。
- 合成离线迁移：49tests/48pass/0fail/1真实数据库入口skip；不是重新完成历史66项MySQL迁移验收。
- 固定私网传输、mockLogin队列和HTTP桥接断流：12pass/0skip。

## 7. storage-error-v3镜像30分钟混合故障持续测试：通过

在独立新卷、固定资源配额、`storage-error-v3`镜像及修复后的测试桥接上执行。先完成新镜像HTTP smoke，再实际运行 **1807秒（30分7秒）**，含准备/最终校验总1858.202秒，6并发、12个mock真实预热成员。测量期间无并行云端build或其它压测；本机Azure管理读取曾超时，恢复的仅是监控，没有重启测试或重置时钟。

| 指标 | 结果 |
| --- | ---: |
| 客户端请求 | 5083 |
| 完整成功 | 4653 |
| 主动取消 | 257 |
| 预期请求失败 | 173 |
| 预期错误总计（另含一次管理采样） | 174 |
| 意外错误 | **0** |
| 429及冷却绑定检查 | 68组 |
| 延迟SSE完整成功 | 273 |
| 401及原成员恢复 | 1组 |
| 非活跃caller自然到期 | 1 |
| SQL观察／资源采样 | 1793／32 |
| 最高同时hold | 8 |
| 最终成员／lease／hold／cataloghold | 12／6／0／0 |

Proxy停止至恢复控制窗口39.440秒，停机期间survivor成功服务97次；MySQL暂停/恢复控制窗口14.542秒（主动暂停12秒，另含操作与恢复耗时）。故障及恢复宽限窗口内允许相应503/断流，不把它们算正常成功；窗口外无意外错误。SSE发生故障后不得伪造成功终止，取消和失败不续租。

HTTP响应头统计200=4914、401=1、429=136、503=32；200包括后来取消/不完整的流，不等于完整成功。最终两个Proxy各11个PIDs、约64.3/63.2MiB，MySQL连接19、最大已用26。半小时内存净变化约10.6/18.3MiB（两Proxy），这里只是本轮样本差，不证明无泄漏或多日稳态。

5083个已发客户端marker中，4983唯一marker到达上游，100个未到上游，未见客户端请求重放。背景warmup1次；总SCIM创建12、Login任务/成功回调13（含一次401修复），没有额外建号。该轮活跃caller没有观察到自然lease切换（0），另有一次401相关新epoch，不能将此前soak的10次自然切换移植到本轮。

报告位于发生器 `/opt/ghcp-test/results/matrix-soak-report.json`；SHA-256：`9aecfb2e16dd6c9b3fea11afcaf0407c703728eeb4afc51344046be07b984000`。旧候选32分钟测试和本轮各自独立保留。结束后另一次健康/hold核对通过，已将Worker暂停且target=0；此时原60秒租约自然到期，实际现场为12ReadyIdle、0lease/hold/cataloghold。该收尾快照与报告完成瞬间的6lease分别记录，不相互覆盖。

## 尚未完成与限制

修复后完整MySQL重启、最新镜像30分钟混合持续测试均已通过；首轮500和第二轮夹具断流失败保留。Rancher跨节点、MySQL主库HA提升、真实浏览器/GitHub限流、客户备份均未在本夹具覆盖。单次通过不证明最大容量、多日稳定或所有故障组合。进一步确定性外部副作用时点、目录取消压力、旧凭据响应交错等见[测试矩阵](user-pool-extended-test-matrix.md)。
