# Phase7 专项测试入口

这些是隔离验收脚本，不是生产运维命令。只有用户明确授权的主执行者可以使用Docker/数据库入口；默认保持真实GitHub和客户环境不可达。

- `migration-qualification.mjs`：最终公开CLI迁移链、逐阶段dump、第二实例恢复、名字兼容门禁、追加企业。默认plan-only；执行还需三个显式环境门禁及新run精确拥有的数据库。
- `name-gate.ts`、`upgrade/multi-enterprise-pool/nameCatalog.integration.test.ts`：名字目录9项真实MySQL资格，只接受专用额外门禁，不能由其他普通MySQL测试开关顺带启用。
- `concurrency.integration.test.ts`：真实MySQL两个企业cap总和、同policy CAS、cap/drain/owner竞争、全局Login名额。
- `scale.integration.test.ts`：100profile持久化、100个合成库存名字、cap/drain、重启的有界功能检查，不创建真实用户，不是吞吐基准。
- `mixed-health.integration.test.ts`：真实MySQL100profile结合注入式readiness/capacity延迟，验证健康尾部企业的实际登记与准入；不是100企业真实外部服务全栈。
- `process-crash.mjs`＋`process-probe.ts`：每case独立新init夹具，精确ID终止/启动实际Login、SSO或Proxy owner。480秒硬上限，失败保留私有证据并尝试暂停、重启同一容器。
- `inflight.ts`：新init夹具上真实SSE请求在响应头前延迟，排空A时B继续、在途release拒绝、A的401不切到B；120秒上限。不是中途断流/慢读者测试。
- `console-run.mjs`＋`console-browser.mjs`：两浏览器上下文对真实Console/API的合成管理写入，精确容器归属和网络隔离，详见[浏览器说明](README.browser.md)。

## 状态与来源

复用`tests/enterprise-phase5/prepare.ts`的state形状和`ghcp-enterprise-phase5-<runId>`资源标签，不表示结果属于第五阶段。每轮绑定HEAD、当前未提交源码摘要、镜像ID及精确容器归属；后续只读测试脚本挂载另留hash receipt。

新测试里，纯逻辑/SQL模拟、真实MySQL、真实浏览器与进程终止是不同层级。测试文件存在、gate跳过或计划输出均不能计为实测通过。Node父测试和子测试计数不应叠加当作独立业务场景数。

真实GitHub设备流、客户数据库、客户Kubernetes/TLS/HA拓扑不由这些内部mock场景代替。进程故障默认不保证LB零中断：它必须先从健康检查中移除死backend；不允许为了测试成功给推理POST开启重试。owner场景使用明确存活副本证明业务继续，再通过有界GET验证LB恢复，发新的唯一marker请求，而不是重放原失败请求。最新实际执行结果以[专项验收报告](../../docs/user-pool-multi-sso-slug-final-qualification.md)为准。
