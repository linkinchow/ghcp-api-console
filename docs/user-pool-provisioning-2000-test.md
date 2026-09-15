# User Pool 0→2000 自动开通 mock 验收

日期：2026-09-14。用户已授权在隔离Azure测试环境执行，不使用真实GHE/EMU/席位/模型。首轮发现规模性调度问题；容量感知/公平选择修复及回归已完成，新空卷复验结果见下文。历史2000账号HTTP压测直接seed Ready，不是本场景。

## 方法

- 两个实际Proxy实例、真实SSO和MySQL；全新独立测试卷，源用户/库存/lease/token为空。
- 通过支持的SSO运行时设置API设定合成用户上限2000；通过Pool CAS设置target=cap=2000并解除暂停。
- Worker自行预留名称并推进SSO创建、mockSCIM、mock席位、mockLogin任务、真实OAuth回调保存、真实warmup处理和Ready状态。测试发生器不直接INSERT库存、凭据或Ready记录。
- `PREWARM_CONCURRENCY=5`、`POOL_LOGIN_MAX_PENDING=5`。mockLogin增加明确有界队列：初轮并发1、每次授权模拟延迟50ms；记录active/pending/peak/wait/finished。此快速延迟仅用于大规模正确性验收，不能当作真实浏览器/GitHub耗时。
- 普通Login容器存在但不启动浏览器；请求发给mockLogin。所有应用/数据库/mock只在Docker internal网络，发生器在独立AzureVM通过固定私网bridge访问。

## 通过条件

1. 最终2000唯一成员全部ready、stage ready、credential valid、verified存在，未超过cap；SSO/mockSCIM/seat/Login/callback/warmup数量逐项核对。
2. 无重复开通/派发或永久占槽，无隐式采纳旧账号；发生失败时保留状态与计数，不通过seed或直接改状态掩盖。
3. 观察SQL状态、阶段分布、进度、资源和mockLogin排队；无进展或总deadline超限报告失败并暂停补池。
4. 列表分页覆盖实际第2000条；完成后两个合成caller跨两个Proxy进行canary，验证排他租约/凭据和hold排空，不增加账号。
5. 首轮快速正常流程完成后，才考虑额外在开通过程退出owner或延长mockLogin耗时的对照；未执行的模式不能称通过。

## 首轮结果：未通过，主动暂停保留现场

Azure分机真实执行约 **2488秒（41分28秒）** 后发现大规模调度堵塞，主动通过CAS设置`paused=1,idle_target=0`冻结测试。runner因设置变更退出，报告`provision_settings_changed`；这不是原先业务自行报错或达到2小时deadline。**未完成2000 Ready，不算通过。**

| 最终项目 | 数值 |
| --- | ---: |
| 真实Worker预留库存 | 2000 |
| 真实SSO合成用户 | 2000 |
| mock SCIM用户／席位 | 2000／2000 |
| mock Login派发／成功回调 | 106／106 |
| 完整warmup／Ready | **96／96** |
| oauth-starting / oauth-wait / warmup | 1894／5／5 |
| failed / 重试错误 / 冲突 | 0／0／0 |
| 正式caller lease / hold | 0／0 |
| mock Login排队累计等待 | 4ms，单任务最高1ms |
| mock Login active峰值 / 最终pending | 1／0 |

没有直接写Ready，2000库存是在真实Worker的预留事务中产生。Login尚未接收的1894个账号不是“正在Login排队”；它们在Proxy调度层等待。

## 新发现：阶段调度与背压产生队头阻塞

首轮版本的 `mysqlStore.pending()` 把所有阶段按 `retry_at,updated_at,ordinal` 混在同一队列选取，不排除已无Login容量的 `oauth-starting`，也不优先处理释放容量的 `oauth-wait` 或完成Ready的 `warmup`。

五个授权任务已经mock成功回调，但其持久化stage仍为oauth-wait；只有Worker再次处理它们并推进warmup时，Login占槽才释放。同时，大量更早到期的oauth-starting继续被调度：执行SSO/凭据读取和owner/fence检查后才发现槽位满，返回空patch、更新retry_at并再次轮转。结果，释放槽位的后续步骤需要等大量无效尝试走过，warmup又排在后面。

最终 **106完成授权 = 96Ready + 5warmup + 5oauth-wait**，且mockLoginpending0，支持“Proxy阶段选择/槽位释放形成长队列轮转”而非“Login串行执行饱和”。固定积压下可能最终推进，不称绝对永久死锁；但进展随积压放大，当前大规模从零补池不合格。

源码位置：[mysqlStore.pending](../src/proxy/src/userPool/mysqlStore.ts:358)、[worker步骤完成调度](../src/proxy/src/userPool/worker.ts:405)、[provisioner OAuth阶段](../src/proxy/src/userPool/provisioner.ts:279)。大量无效步骤还重复进行SQL fencing/owner续约与settings门锁竞争，增加额外开销。不能通过增加真实席位、删除fence或提高SQLdeadline掩盖。

## 已完成的调度修复与回归

- SQLite/MySQL共享容量筛选：持久化dispatch/wait名额满时跳过oauth-starting，包含failed/disabled的不明占位。
- 三次优先处理更靠近完成的阶段，第四次按retry_at/updated_at/ordinal选最老合格任务；保留due、hold、pause、人工错误和任期/凭据校验。
- 选择只作提示，Login POST前原子claim仍为最终容量限制。不提前写dispatch、不删除fence、不修改schema或运行期SQLdeadline。
- 2000starter+满槽+warmup的SQLite及真实MySQL选择契约通过；真实Worker+realProvisioner、异步存储及mock外部依赖回归证明下游Ready和五个并发任务争一个空位。旧age-only排序负向对照按预期失败。
- 全Proxy **330 tests/325pass/0fail/5DBskip**；全workspace+upgrade typecheck通过。云端随机隔离MySQL scheduler/pool/admission/recovery **45pass/0fail/0skip**，不是将默认skip改写成pass。

## 修复版新空卷验收

使用独立新卷 `azure-provision-2000-v2`，旧96Ready现场及数据卷保留。两个Proxy均核对新镜像 `ghcp-pool-mysql-proxy:scheduler-v2` 的精确digest：

```text
sha256:4d0dd72555aa2e44d8b5cc1684313e97e748f3ef50b2115d87d099c745d2dced
```

修复的三份生产源文件和选择契约通过前后SHA校验上传，两台VM相同；新增Worker测试本机通过、不包含在该镜像来源包中，但不改变生产代码。并发/队列仍为prewarm5、pending5、mockLogin1/50ms，不以加资源或改超时取得结果。

**通过。** Azure任务于2026-09-14 **15:04:33–15:15:07 UTC**执行，exit0。自动建池阶段 **625.922秒（10分25.922秒）**，含前后检查总 **634.760秒**，平均约 **3.20 Ready/秒**。这是50ms合成Login下的正确性验收，不是实际GitHub/browser建号速度或生产容量承诺。

| 修复版最终项目 | 结果 |
| --- | ---: |
| 库存／真实SSO合成用户／mock SCIM／mock席位 | 各2000 |
| mock Login POST／成功回调／完成任务 | 各2000 |
| 经过完整warmup、凭据有效且verified的Ready | **2000** |
| failed／重试错误／SCIM冲突／失败回调 | 全部0 |
| 剩余dispatch／wait／warmup | 全部0 |
| mock Login并发峰值／结束时active和pending | 1／0和0 |
| mock Login累计排队／最高单次排队 | 1576ms／56ms |
| SQL观察轮次／资源采样 | 299／11 |
| 最终lease／hold／catalog hold | 全部0 |

逐成员核对唯一identity、SSO、ordinal、task、SCIM/seat归属，以及**每个成员恰好一次完整warmup**。两个Proxy各遍历20页，完整检查2000条及最后一页；SSO也遍历全量分页，不只看total。2个caller各跨两副本请求，共4次全部成功、独占不同成员，同caller lease/member不变，4条统计归属正确；最终通过管理API释放2个测试租约。mock推理总数2004=2000warmup+4canary；目录查询2002不等于warmup重复。

资源采样最大值：主调度Proxy约75.7MiB/42.40% CPU，另一Proxy44.7MiB/9.18%，MySQL509.2MiB/55.54%；MySQL最大已用连接10。CPU为Docker样本值，不是持续平均或容量极限。owner保持同一任期，无故障注入；这次没有同时运行构建或其它重型测试。

测试结束已暂停Worker，target/cap保留2000，2000Ready现场及旧失败卷都保留。收尾再次验证各服务健康，两个Proxy日志的error级条目及SQLdeadline相关关键词均为0；不是全系统永久无错误保证。完整原始报告位于测试发生器的 `/opt/ghcp-test/results/provision-2000-v2-report.json`，日志同目录 `provision-2000-v2.log`。报告SHA-256：

```text
7f3b8698f64ef4aa8a5d8cb832471f442dd8f95d1bd951eeb357233415402240
```

**结论：首轮暴露的普通阶段调度堵塞已修复，并通过完整新空库0→2000验收。** 不把旧41分钟/96Ready失败改写为成功，不外推真实上游耗时。可选开通过程owner退出、慢Login1/5对照仍未执行；Rancher节点级HA和MySQL主库故障不由本测试覆盖。云资源仍按既有生命周期计费。
