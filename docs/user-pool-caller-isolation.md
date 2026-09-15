# 热点 caller 数据库连接隔离

日期：2026-09-15。仅隔离mock开发/测试，未commit/push，不操作真实GitHub/席位/模型或客户环境。

## 已确认问题

两个Proxy各10个MySQL连接。一个caller的数据库命名锁阻塞时，32个同caller请求可占用共享连接，另外caller的请求也在约5秒后503。无串号/重放/锁泄漏，但故障影响不局限于热点caller。

## 本次目标

- 在获取MySQL连接前，对同caller admission串行排队；队列和键数有界，取消/超时从队列清理。
- 仍保留数据库命名锁和事务作为跨副本最终排他保护；本地队列不代替持久化一致性。
- 本地排队、获取连接、命名锁和事务共享现有5秒总预算，不重置计时、不提高SQLdeadline。
- 只串行admission，不限制该caller已获准后并发推理；finish/heartbeat/管理与worker不排在caller队列后。
- 不缓存租约或凭据，不引入Redis；不承诺所有不同caller的流量峰值都被隔离。

## 验证门槛

1. 无外部依赖的队列契约：同键FIFO、不同键并行、等待取消、超时和迟到释放、队列/全局边界、空键回收、异常不漏permit。
2. 真实MySQL：同caller同时等待仅有限连接，第二caller可完成；跨副本命名锁不删除；未知COMMIT不重放。
3. 实际双Proxy HTTP：同caller32并发+半数取消，DB锁1.5秒和6.5秒两阶段。另caller两次探针必须200且不等热点锁释放（最多2秒）；A超时/排队拒绝必须有界。未获准/已取消请求不达上游、无重放、最终hold和命名锁排空。
4. 完整Proxy/类型检查、最新镜像核对；受影响常规请求与生命周期回归不退化。

## 实现约束

本地gate按实际底层mysql2连接池共享，同一pool的多个Promise wrapper或store不能各放行一个热点caller。每caller最多32个排队者，进程内所有gate合计1024个active/queued ticket；队列溢出安全503和Retry-After，不持久化新配置或改fingerprint。

mysql2的getConnection队列无法公开取消：已提交给驱动的请求即使客户端取消，本地permit仍保留到迟到连接被释放，以免同caller再次挤入驱动队列。取消不得转发业务或留下hold；尚在本地等待的请求直接移除。运行时mysql2池的原生排队上限也从无限改为1024；只在getConnection边界把其Queue limit reached错误转换为安全存储不可用。该原生上限适用于Proxy共享池（包括direct的存储调用），不是仅caller-lease队列。不同caller不共享串行gate，但全连接池/数据库不可用时仍可能共同失败，不承诺任意负载下始终成功。

## 修复前严格复现

相同环境`storage-error-v3`镜像，12Ready且Worker暂停；严格验收保留32个热点caller请求、16次取消、1.5/6.5秒命名锁阻塞。短锁时B两个探针200但延迟1599/1521ms；长锁时B最终200但延迟4915/4907ms，失败码`other_caller_isolation_latency_exceeded`。这不是隔离改善：B仍等到热点连接释放才完成。清理通过，没有未获准请求转发或遗留租约。

## 当前验证

本地整合后完整Proxy默认执行：402tests/394pass/0fail/8条件数据库入口skip，全workspace与upgrade类型检查通过。实现工作目录首次默认并发运行有5个时间相关失败，原日志保留；同样断言限制测试文件并发后通过，父工作区默认并发再次全通过，没有放宽业务截止或断言。不能仅凭重跑将首次失败解释为已确定的主机问题。

新增真实MySQL契约已执行通过：底层pool共享的两个store、12个同caller的推理/catalog请求、真实GET_LOCK只有一个SQL等待者；取消队列项不获取连接，B在1秒内领取和finish；全池占用后的取消、迟到连接释放、队列+SQL共享预算与3个连接全部恢复。真实MySQL契约及原有admission/store/lifecycle组合已执行：**43tests/43pass/0fail/0skip**（含父包装及离线控制，不是43个独立数据库场景）。验证实际GET_LOCK仅一个A等待者、B领取及finish低于1秒、取消项无新连接/hold/FIFO不被破坏、队列加SQL共享1800ms预算及全部3个连接恢复。

新Docker镜像ID：`sha256:826d609963e0951258621a87334ea2a6e6af91d39280940ae80bf477c3364c3c`，标签`caller-isolation-v4`。严格双Proxy HTTP复测及新空库生命周期已通过，见下文。最新进展与待办见[状态总览](user-pool-mysql-status.md)。

## 修复后双Proxy严格验收：通过

相同具名数据库卷、mock与资源配额，仅更新两Proxy镜像；相同32个A请求、16次取消，B在A开始150ms后分别从两副本发出请求。

| A命名锁阻塞 | 修复前B两探针 | 修复后B两探针 |
| --- | --- | --- |
| 1.5秒 | 1599／1521ms，200 | **66／84ms，200** |
| 6.5秒 | 4915／4907ms，200但超过2秒门槛 | **23／31ms，200** |

长锁时A的16个未取消请求约5.02秒返回安全503，没有延长SQL预算；B在A锁仍由外部测试连接持有时就已成功。两阶段全部通过延迟清理＋零hold静默窗、所有marker唯一、取消/503请求未达上游、自己的租约释放与命名锁清理。两阶段各2个后续恢复探针也通过。

前后完整报告已保存并下载核对，组合证据SHA-256：`d989d1263b01c347559533d8cde34a0e34c28d4528d1d2756380875da880b536`。

该对照验证已复现的热点caller连接占用问题被隔离，不外推为任意故障下B始终成功，也不称全局公平调度或生产延迟SLO。

## 新镜像生命周期回归：通过

全新空卷`caller-isolation-lifecycle`，实际运行61.418秒，14个连续阶段全部通过。4轮8→14→20→26→32，每轮12次补池中成功请求；cap下降/耗尽、暂停/恢复、disable/resume/retry、held-release拒绝、全32成员401后原身份修复及新排他lease均通过。

446次HTTP（含管理/观察）、216次推理、171完整成功、51预期错误计数（含管理，不可直接相加）。207个上游marker唯一、9个推理在上游前被拒绝；最终32Ready/6个新lease/26idle、hold/cataloghold0、Worker暂停target0。SCIM/seat各32，授权65、warmup66符合原预期，没有因本地队列导致额外开通或修复。报告SHA-256：`a206cdfde95dec3fb77adb42e1419fec1f83358e7494c3556e502d09323338f7`。

## 结论与限制

已复现的单热点caller在同一连接池占满等待连接、拖慢其他caller的问题，已通过严格前后对照和真实MySQL契约验证解决。全库不可用、很多不同caller同时过载、多个独立连接池或跨副本总容量仍需容量规划；本地gate不提供全局租户配额。32排队和1024总ticket是内存/连接保护上限，超限安全503，不保证每个请求都排到服务。

独立取消安全审查未完成，因长时间未返回已停止，不能把这项记为审查通过；本报告的通过结论来自列出的实际测试和父会话代码核对。收尾健康检查通过，Worker暂停target0；60秒以上后原测试lease已自然到期，现场32ReadyIdle、lease/hold/cataloghold0，与验收结束瞬间6lease分别记录。

当前`caller-isolation-v4`通过本报告列出的契约、HTTP隔离和生命周期场景；之前storage-error-v3的30分钟soak、旧版本0→2000及2000caller请求负载并未在本镜像全部重跑，不能借用其镜像归属。本分支未commit/push，未操作真实上游。
