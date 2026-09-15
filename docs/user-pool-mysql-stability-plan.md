# MySQL User Pool 稳定性与故障验收计划

更新：2026-09-14。分支 `ghcp-user-pool-mysql`，基线 `da76eb1`。本文件记录用户已同意继续的**隔离验收**，不是生产部署/真实上游调用授权；不commit、不push。

## scheduler-v2调度修复检查点（历史）

`oauth-starting` 满槽跳过、三次下游优先/一次最老合格任务的选择策略已实现，不改变 POST 前原子 claim。全 Proxy 330 tests/325pass/0fail/5DBskip、workspace+upgrade typecheck通过；实际 MySQL scheduler/pool/admission/recovery 45pass/0skip。真实 Worker 异步回归及旧排序负向对照完成。

新镜像 `ghcp-pool-mysql-proxy:scheduler-v2`：`sha256:4d0dd72555aa2e44d8b5cc1684313e97e748f3ef50b2115d87d099c745d2dced`，两副本启动均核对精确digest。首轮从零建池的96 Ready失败现场保留，新验收使用全新空卷；结果见 [自动建池报告](user-pool-provisioning-2000-test.md)。它与下面32分钟持续请求场景独立，不替换其历史镜像或结论。

## 前一候选已完成的验证（历史）

审查8个故障断言对应修复及SQL/DDL/startup/schema/N+1/catalog/page20改进已落源码与正式回归，详见 [修复记录](user-pool-mysql-production-review.md)、[验证报告](user-pool-mysql-validation.md)。

- Proxy323通过/0失败/4个独立引擎入口跳过；这些入口另跑repository1、pool/admission38、恢复5、迁移66，均通过。
- SSO31/Login12/Console6、Linux浏览器4、离线hook+Compose23、类型检查/构建通过。
- 修复版双Proxy实际HTTP、owner退出接管、健康后重启保留数据通过。
- 修复版2000合成caller、25并发、2轮4022HTTP全部200；最终2000排他active租约、hold0。不是性能SLO。
- 候选Proxy镜像digest `sha256:2b3e3cd1b18f237031ac83d71850f3682f2f23e01d69ec9646ff0db920abf686`；Console `sha256:9e62e23899ae92b4f2bf186dd517e325162cd90045d4ce4f12e0e3cc4ff5828b`。

## 运行边界与权限范围

仅仓库文件/临时合成数据、固定测试Compose project/前缀资源及loopback端口。允许为本次验收创建和启停**测试**容器/网络、短时暂停或断开**测试**MySQL、停止并恢复**测试**Proxy、读取测试日志和聚合指标、运行测试及必要镜像构建。保留旧卷和历史证据，不执行全局prune/down -v，不停止其他项目。

所有SSO/SCIM/席位/OAuth完成/模型响应均用隔离mock或合成fixture。不得访问真实EMU/客户端点、读取真实部署env/cert/db、修改SSO或创建/撤销真实席位。测试服务无外部上游访问；LB固定后端，不能提供任意转发或Docker socket控制。包源仅公司批准的npm feed，不绕过TLS/最低发布时间策略。新镜像/依赖无法取得则明确记录阻塞，不以替换真实环境解决。

桌面/组织策略可能仍对单次工具另问授权；本计划不承诺消除全部弹窗，也不请求任意Bash权限。

## 执行顺序与通过条件

1. **可信LB隔离链路**：增加实际HAProxy，两个Proxy作为固定后端，以readyz摘除/恢复；业务与内部路径分流、禁推理重试。SSO/Login/mock回调和Console指向LB。验证原第一Proxy离线期间新mock开户回调可到第二Proxy，且不重复副作用。
2. **完整LiteLLM集成**：固定已有v1.99.1镜像，合成virtual key上下文、真实hook/router/Proxy调用链、mock模型。验证伪造身份头被覆盖、缺失身份拒绝、fallback和跨Proxy绑定。明确是否包含真实virtual-key认证HTTP入口，不把单纯mock auth对象称为完整网关鉴权。
3. **持续负载**：资源观察完成后，无构建/其他重负载并行地运行至少30分钟。混合JSON、数秒至接近请求期限的SSE、取消、401/429/到期；记录每阶段请求/预期错误与意外错误、延迟、CPU/内存/连接/hold及最终一致性。合成账号上限2000、客户端并发有界、mock记录有界，测试总时长有上限。不得以“所有HTTP必须200”判断故障阶段。
4. **带流量故障**：在有界短故障窗口退出测试Proxy、暂停/断开测试数据库；持续观察时检查fail-closed、无跨caller共享、无自动重放、连接/hold恢复和新请求正常。finally恢复本次暂停/退出的测试资源，失败日志保留。数据库主从/主库提升HA不在本机单MySQL场景覆盖。
5. **合成离线迁移演练**：独立SQLite备份→预检→空MySQL导入→同parser配置的双Proxy+LB验证账号/token/lease/统计；保持paused防开户。检查retention、TTL不重置、旧writer停止及失败处理边界。客户真实备份需另行授权。
6. **收尾**：运行受影响回归、更新设计/实施/验证与本计划中的实际完成状态，保存接续和日志；不提交/推送。将生产资源/SLO/远程TLS/DBHA/客户备份等未验收项单独列出。

## Rancher / NGINX 新增待办

用户补充客户环境是Rancher，并要求记录改用NGINX。已单独记录 [Rancher入口HA与NGINX待办](user-pool-rancher-ha-todo.md)。当前HAProxy只是隔离验证实现，不在本轮持续测试中途替换。优先分析同集群ClusterIP Service是否已能承担内部多Proxy分流；若需NGINX入口，必须连同多副本跨节点及外部LB/VIP冗余一起验收，单台NGINX仍是单点。未访问客户集群。

## 当前执行状态

- **2026-09-15扩展组合及最新候选通过**：新增MySQL生命周期契约、14阶段业务/补池/管理/32成员401恢复通过。实际DB重启发现即时断连500/502，限定修复后完整Proxy368pass/7条件skip和实际MySQL组合47pass/0skip通过；测试桥接断流修复后35秒DB重启完整通过。最新storage-error-v3镜像1807秒/5083请求/0意外错误持续故障测试通过。此前失败保留；后续caller-isolation-v4已通过获取连接前caller有界队列解决单热点caller占连接问题，严格对照B23/31ms200及新镜像14阶段生命周期通过，范围见[caller隔离报告](user-pool-caller-isolation.md)。逐项见[扩展测试报告](user-pool-extended-test-report.md)。

- **调度修复后从零建池通过**：新空卷真实Worker自动创建2000合成成员，625.922秒全部Ready；最终SCIM/seat/Login/callback各2000、每成员恰好一次warmup，0失败/重试/冲突。双副本全量分页及4次跨副本canary通过，lease/hold最终0，Worker已暂停。首轮41分28秒仅96Ready失败保留；后续owner退出的严格零错误测试失败一次回调，保留现场恢复通过；慢Login1/5对照均已通过。详见 [0→2000报告](user-pool-provisioning-2000-test.md)。

- **较早候选Azure分机持续验收已通过（历史）**：上传267文件源码包至独立服务/压测VM并校验hash，云端build和smoke通过。6并发实际1942秒、4809请求、0意外错误；70次cooling、254次延迟SSE、401修复、自然到期、Proxy退出和MySQL暂停恢复均通过。最终hold/cataloghold0、无重复上游marker。旧本机失败保留；硬件/运行时/分机及网关profile共同变化，不是单变量A/B。详见 [Azure验证](user-pool-azure-test-environment.md)。

下面各项本地历史结论不覆盖上方最新通过记录。

- **LB通过**：实际HAProxy分离business/internal路径；第一Proxy停止、健康检查确实摘除后，第二Proxy正常服务并完成新增第4个合成成员的OAuth回调；恢复后两个后端重新接流量。夹具最初只修改了callback初始化白名单、遗漏发送时白名单，已修正且换新隔离卷重跑；早于health摘除发送的503/502失败保留，不归为业务重试通过。
- **完整网关通过**：真实LiteLLM v1.99.1+独立PostgreSQL，经HTTP创建5把实际virtual key，验证缺失/无效/撤销key、master非virtualkey、模型权限、伪造hash覆盖、其它provider不注入。6次同key请求由两个HAProxy后端各处理3次，始终同member/lease；fallback为1次主路由503及1次pool成功，未重放。5把生成key已撤销，原部署无任何变更。
- **持续负载仍未通过（已恢复权限并重跑）**：保留前次1402秒的续租快照失败。等待前一hold排空后重跑，约114秒流量时出现1秒冷却探测晚于冷却结束的错误预期（停止清理总137秒），已把测试注入改为10秒并检查数据库观测仍在冷却期，未改产品冷却逻辑。再次运行949秒流量/997秒总时长、2454请求后失败：2193成功、118取消、74预期错误；35次冷却绑定检查通过，但非故障窗口有63个意外HTTP状态（503）、6个传输/流错误、2个资源采样失败及后续停止检查。Proxy退出已恢复，数据库暂停阶段未到达。出现SQLdeadline、owner丢失及Docker采样超时，尚不能区分主机资源抖动和代码/数据库瓶颈；没有最终marker/hold全量核对，不满足30分钟验收。新增安全responseCode记录，未放宽错误标准。
- **合成完整迁移演练通过**：只读SQLite3成员/2活跃租约/106统计→随机空MySQL目标→同一MySQL卷下双Proxy+HAProxy实际启动→12次三个协议JSON/SSE。原token哈希、leaseID、启动时TTL均保持；启动retention106→103，请求后109并核对精确历史存活记录；没有开户/授权/席位调用，源SQLite字节未变。使用新SSO/Login/Console合成卷，保留原MySQL及旧失败数据卷。客户真实备份尚未授权或测试。

可复现入口与权限边界见 [stability harness说明](../tests/docker-user-pool/README.stability.md)。
