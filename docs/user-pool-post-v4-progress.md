# v4之后：可观测性与独立进程验证

日期：2026-09-15。用户授权多agent并行推进下一轮。已建立后续分支`ghcp-user-pool-observability`，基于冻结提交`2bc12b3`；`ghcp-user-pool-mysql`及已验收v4镜像保持原样。本轮不push，不操作客户环境、真实GitHub/付费席位或本机Docker。

## 本轮限定范围

| 并行任务 | 交付边界 | 实际状态 |
| --- | --- | --- |
| worker失权可观测性 | 脱敏原因分类、本地状态/计数快照及回归；不改owner规则、TTL、重试、readiness或SQLite退出行为 | 已实现，完整本地回归438pass/0fail/25条件skip、类型检查通过；生产增量独立只读复核无确认问题；新镜像选择性运行验收及独立证据核对通过，构建后生产源码未改 |
| 独立进程路由关键用例 | 两个独立Node子进程、各自缓存、共享隔离MySQL，catalog部分取消/推理与凭据ABA关键顺序 | 冻结v4实际MySQL运行2pass/0fail/0skip，5.574秒；不同PID与随机库清理有证据 |
| 独立worker接管关键用例 | Login受理后真正SIGKILL旧进程，原nonce任务恢复；超龄任务/迟到结果保护 | 冻结v4实际2个子场景通过，含父包装TAP3pass/0fail/0skip，66.454秒；真实约30秒任期等待 |

主会话负责整合、报告及顺序执行共享Azure/MySQL测试。各agent只修改独立文件，不在同一环境并发注入故障。两组进程用例已对冻结v4实际执行通过；438pass/25skip及新镜像的选择性运行验收属于observability生产增量，不沿用v4的最终回归标签，也未重跑冻结最终四项。

### 实际通过范围与未测边界

- **routes两例：** GET/HEAD目录partial-body响应、部分消费者取消与双进程推理；旧凭据A→B→A、旧200先于401释放、generation fence和实际worker/provisioner重新warmup后的准入。仅ABA/success-first顺序，不覆盖所有消费者取消、count_tokens、其它替换/返回顺序或进程退出组合。详见[路由进程用例](../tests/user-pool-process/README.routes.md)。
- **worker两个子场景：** Login已受理但checkpoint未写回时SIGKILL旧进程，不修改DB时钟或缩短租约；真实TTL后接管原task/nonce且无第二次POST。另一个子场景覆盖超龄running任务及迟到回调/旧观察结果保护。TAP3包括父包装，不是三个业务场景。SSO/SCIM/seat副作用、长停顿后旧进程恢复、网络GET停滞/服务重启和真实上游不在本轮范围。详见[worker进程用例](../tests/user-pool-process/README.worker.md)。
- 两组均使用隔离MySQL及独立Node子进程，但不是部署入口、所有进程排列或全系统HA认证；新诊断镜像运行证据单独列于下节。

## observability新镜像：选择性运行验收通过

镜像ID（非远端仓库manifest声明）：

```text
sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb
```

本轮新建3个由真实worker创建的mock成员，整体32.976秒，生产源码在该镜像构建后未改。

| 验证 | 实际结果 |
| --- | --- |
| 双副本诊断接口边界 | 两边均验证缺失/错误鉴权401、额外查询400及no-store |
| MySQL暂停时诊断 | 两边均200，8ms/7ms；无需数据库可继续读取本机快照 |
| owner失权信号 | 原owner转standby，ownershipLosses由0→1，`storage_unavailable/deadline`；另一standby仍0，竞争未被误计为失权 |
| 同期业务失败 | 安全503，`pool_storage_unavailable` |
| 解暂停后恢复 | 至调度及健康恢复12.282秒；后续推理200；holds0、catalogHolds0 |
| 最终设置 | paused1、target0、max8、ttl600 |

暂停控制跨度为18.322秒，包含有意等待12秒和业务请求约5秒失败预算，不能简写为“仅暂停12秒”。解暂停后的12.282秒是本轮测量值，不是固定接管SLA。

### 独立运行证据与最终健康核对——完成

- 双Proxy均健康且RestartCount为0，精确预期镜像匹配，验证本次恢复期间无容器重启；不是仅依据夹具未发restart命令。
- 两个运行容器各自的3个生产源码文件均逐文件对照增量manifest完成hash核对，匹配本次构建源码。
- 两个副本总计恰好1条`ownership-lost`日志，来自原owner，字段符合安全allowlist且原因`storage_unavailable/deadline`；另一副本无此日志。
- MySQL运行、已解暂停且健康，之前v4-final-load的MySQL卷保留。
- 最终健康快照为3ReadyIdle、0lease、paused1、target0；10分钟测试租约自然过期，不是人为清除租约。preview已停止，无后台测试。

独立证据保存在`.claude/post-v4-observability-evidence-result.json`，逐容器源码hash及最终健康补充保存在`.claude/post-v4-observability-final-result.json`；公开文档仅记录上述安全汇总。

这只是新镜像的选择性诊断/数据库暂停恢复验收，不是重跑冻结v4最终四项，也不是全局告警或全部503问题已解决。

### 原运行脚本与事后严格校验

- **真实执行版本：** 原运行脚本SHA-256为`5e88bc4b34eedb27b8517ce5cece29af6d1652942e2bda1547dae5340b9fd4cd`，本节运行数据来自它实际执行产生的报告。
- **审查发现与本地修正：** 测试辅助`keys()`只排除额外字段、允许缺少必填字段。新增`local-diagnostics-contract.mjs`严格必填字段/allowlist/数值和时间校验，新增3个测试全部通过；父运行脚本已调用严格helper。该问题属于测试校验不足，不冒称已发现生产接口缺陷；3个测试结果与此前438pass/25skip分开记录，不合称重跑了完整回归。
- **已存证据重验：** 全部6份已存真实快照（双副本各before/during/after）使用严格契约重新验证成功，结果存于`.claude/post-v4-observability-contract-proof.json`。无第二次故障注入，**修正后的严格运行脚本未在远端重跑**，不能把事后校验写成新的远端执行。

## 完整证据本地归档

完整执行日志和报告已本地归档；以下仅记录相对路径和SHA-256，不粘贴原始运行标识、环境端点或凭据，不作为公开日志下载承诺。

| 执行组/证据 | 本地归档 | SHA-256 |
| --- | --- | --- |
| 冻结v4 routes完整日志 | `.claude/post-v4-routes-full.log` | `1a6aaa63987db510a999f46d28390f0895c70f063810ca54c2b9bb2516ae6bf2` |
| 冻结v4 worker完整日志 | `.claude/post-v4-worker-full.log` | `7a6328f89a35c72f200ad484ec31cef269edb6b5e0cde62ed5573cde2deb1eb5` |
| 新镜像诊断完整日志 | `.claude/post-v4-observability-full.log` | `f422a741b3410a26ae2c1e6f9d0f960794dfab46207697f22417d2e3f478895d` |
| 新镜像原运行报告 | `.claude/post-v4-observability-full-report.json` | `e1e67801bdafa72520151fc8edea235958cc961ce0ec1396b0e931dd424555b5` |
| 已存6快照事后严格校验 | `.claude/post-v4-observability-contract-proof.json` | `198ed55f751185bcd8bebc5f34e08c680abe65578ab6d13e7c02b032412885dd` |
| 独立运行证据核对 | `.claude/post-v4-observability-evidence-result.json` | `fee04bf800808e63c103465266fb348e617d8cbc3b65ea8746d035fa040bb9f7` |

## 非本轮内容

不拆Proxy/worker容器、不改变SQLite失权后停止策略、不引入全局监控平台或直接改LiteLLM fallback、不访问Rancher生产环境。全局无有效owner判断和跨副本告警规则需单独设计；一个本地worker处于standby或诊断返回null不代表整个集群没有owner。客户SQLite不可恢复失权后的受控恢复机制尚未实现，诊断增量不关闭该独立交付项。

## 本轮收口与结果纪律

本机诊断实现、本地回归、新镜像选择性运行验收、独立运行证据/逐容器源码核对及冻结v4两组有限进程用例均已通过，本轮限定范围全部完成，不再列运行验收或RestartCount/日志核对为待办，不新增目标。其余进程排列、全局告警、客户SQLite恢复及生产HA门槛仍是范围外的独立事项。

- 每组实际完成后报告；准备、类型检查、skip、真实MySQL、实际独立进程执行与事后契约校验分别标注。
- 捕获到的产品或测试问题保留记录，不放宽不重复POST/旧凭据fence/无重放断言。
- 任何与v4不同的生产改动只进入后续分支，形成明确增量结论，不无限扩展测试。
