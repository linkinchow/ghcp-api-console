# 四项确定性并发／故障组合测试

日期：2026-09-15。用户授权并行推进原待办第3类第1–4项。生产候选为caller-isolation-v4；各agent只拥有独立测试文件，主会话统一整合，真实MySQL验证串行执行，避免污染同一测试环境。所有外部服务均mock，真实数据库仅随机隔离测试库；不连接真实GitHub/客户环境、不commit/push。

## 当前分工和验收层次

| 场景 | 独立测试文件 | 目标 | 状态 |
| --- | --- | --- | --- |
| 外部副作用成功后切换owner | `ownerSideEffects.test.ts` | SSO/SCIM/seat/Login，两种屏障＋不可见结果控制；旧owner写入被拒绝，不盲重放 | SQLite11＋实际MySQL11全部通过；确定性同进程双worker契约 |
| 目录查询压力＋部分取消＋推理 | `userPoolCatalogPressure.test.ts`、`.mysql.test.ts` | hold、模型刷新等待者独立取消、caller隔离、无目录续租 | SQLite HTTP5＋真实MySQL HTTP2＝7项通过；非独立进程 |
| 旧凭据成功／401交错 | `userPoolCredentialRace.test.ts` | 真实路由/hold/凭据generation，替换或ABA后旧结果不能破坏新凭据或续租 | SQLite4＋MySQL4子场景通过；TAP含2父包装合计10pass/0skip |
| Login轮询故障耗尽后恢复 | `loginPollingRecovery.test.ts` | 普通重试到终态观察，确知终态才放槽，未知任务保留，故障后恢复 | 首轮失败保留；最终强化后SQLite3＋MySQL3＝6pass/0skip |

测试代码完成、SQLite通过、MySQL条件跳过、真实MySQL执行通过分别记录。若使用同一Node进程内两个HTTP app，只能证明共享数据库和真实路由组合，不将其称作两个独立Pod/进程缓存隔离。生产进程级故障测试另列，不因有4个agent就自动完成。

## 实际结果与覆盖边界

### A：外部副作用与owner切换

22项全部通过（SQLite11＋MySQL11），17.368秒。四种步骤×HTTP响应未回/最终update未执行两种屏障，再加3种外部结果不可见控制。真实数据库拒绝旧owner写入；SSO未确认创建停在人工核对状态，SCIM/seat/Login明确可查时只GET恢复，最终正常warmup。详情及操作原则见[owner专项](user-pool-owner-side-effects.md)。

这是强制过期测试库owner租约＋同进程两个真实worker，不是实际停Pod；对于客户端传输、独立进程和外部服务崩溃边界仍须单独验证。

### B：目录压力、部分取消与混合推理

Azure实际执行7项、0fail/0skip，10.470秒：SQLite5项与MySQL2项。SQLite覆盖24并发GET/HEAD/count、一名等待者取消、全部取消后重试、8MiB上限及5秒HTTP截止；MySQL覆盖12目录＋8推理的混合共享刷新、取消后真实SQLhold删除、caller排他性、目录不续租，以及9个部分响应等待者全部取消后的新请求恢复。

两HTTP监听器共享同一Node运行时和模型缓存；两个监听地址不等于两个独立Proxy进程。初始成员凭据是显式合成测试语料，不是从零建池证据。部分日志中的abort/大小上限/超时属于主动注入，不等于用例失败。

### C：旧凭据200／401顺序与ABA

Azure实际执行SQLite4＋MySQL4子场景，含2个父包装共10pass/0skip，5.617秒。A→B和A→B→A分别按成功先回/401先回；第一条旧响应在重新admission/reclaim前完成，以真实凭据generation而非已失败状态验证fence。旧401不破坏新token、不新增reauth；旧200不续租；旧hold排空前不得warmup，重新验证后才允许新lease和新请求，无失败推理重放。

使用真实路由、数据库触发器、Worker/provisioner warmup；凭据替换通过合成测试中的repository写入，不能当作生产管理API允许随意替换受管成员。仍是同进程两个HTTP监听器，独立进程cache差异未覆盖。

### D：Login轮询耗尽后的终态恢复

SQLite3项已通过；首次实际MySQL3项均在“观察期间新增SSO应为5”的断言失败，实际增量为6。MySQL测试用加速retry_at而不是SQLite的多次时钟tick，因此早期预留的第6个starter可能尚未创建，不能把总数增量固定为5。现改为检查精确五个新identity在屏障前不存在、观察阻塞时全部创建，同时保留总7个用户、6个oauth-starting和每个POST不重复断言。仅改测试，首次失败日志保留；修正后实际双驱动6pass/0fail/0skip，15.048秒。独立有界复核另发现mock内assert.fail可能被后台观察器吞掉，已显式记录禁止的warmup调用和mock断言错误，并在外层验证为空。最终强化版实际SQLite3＋MySQL3，**6pass/0fail/0skip，15.144秒**，没有修改生产代码。

场景包括503与传输拒绝（未声称实际等待网络超时）、三次重试耗尽、普通lane和独立观察lane、running/cancelled/404/503/关联不匹配时保留槽位、明确成功/失败后放槽给其他starter，以及凭据回调generation改变后的旧观察拒绝。SQLite使用模拟时钟，MySQL仅加速随机测试库retry_at和观察周期，不是实际30/60秒退避耗时测试。

### 整体回归

四组五个新测试文件整合后，本地完整Proxy443tests/418pass/0fail/25条件skip，workspace和两套upgrade类型检查通过。MySQL入口逐组单独执行，不把默认skip计为pass，组合套件父包装与已有用例不能简单累计成独立场景总数。对50份生产源码的前后SHA校验未发现改动，本轮未修产品代码。

## 证据与后续

云端日志均保存在发生器`/opt/ghcp-test/results/`，本地私有证据目录保存完整日志与SHA核对：

| 日志 | SHA-256 |
| --- | --- |
| `owner-side-effects.log` | `6d1eed8fae2c1bb531366569a961e0efa701f7162c252c322b0ae834c0c09ef1` |
| `catalog-pressure.log` | `e6a159cc5bcb81040116ac97aa302d77c6a227f2cfc813f7842a7142f60e6ffc` |
| `credential-race.log` | `51f9166697cf462175f4ee1d25101e61580832bcd8724e6cb9fafe067312352a` |
| `login-polling-recovery.log`（首次失败） | `91cee3c291076683a8cdbd574bdfab3390b7fd702b1c902fa4eea00add1fa664` |
| `login-polling-recovery-final.log`（最终通过） | `974d4206ca357982e2283df94aaf6f44244a995ed7dbfd2f1ae2147a020bd211` |

本轮A/B/C/D最终组件契约均通过。A为22项、B为7项、C为8个子场景加2父包装、D为6项；不要把父包装当额外故障场景。没有执行独立OS进程/Pod的同样确定性组合，也没有新增真实上游、长时间/容量或生产HA结论。

- 原待办与最新候选范围：[最新进展](user-pool-mysql-status.md)。
- 外部步骤的安全恢复/人工核对预期：[owner副作用专项](user-pool-owner-side-effects.md)。
- 历史已通过的规模/持续/热点隔离不得移植成这四项已通过。
