# 本机调度诊断接口：后续增量

日期：2026-09-15。分支`ghcp-user-pool-observability`，不是冻结v4的一部分。

## 接口范围

新增 `GET /api/user-pool/diagnostics/local`，使用原内部API鉴权，响应`Cache-Control: no-store`；禁止额外查询参数。只读本进程worker内存快照，不调用getUserPool、不初始化/查询数据库、不触发tick或抢占租约。

返回外层 `scope: local_process`、观察时间及`localScheduler`；有池配置但worker尚未存在时为null，不代表整个集群无owner。池模式关闭时返回原风格409；未知内部异常统一安全500，不暴露错误全文。

快照包含本机owner/standby/stopped、任期年龄、最近成功续约的时间/年龄、竞选尝试/取得所有权/失权计数、最后一次失权的allowlist原因与时间。字段从worker构造起计数，进程重启后重置；不包含owner UUID、caller、成员、token、数据库地址或原始错误信息。

原因区分：本地任期超时、续约被拒绝、连接/SQL截止导致存储不可用、其它存储操作失败。初次未拿到owner不等于失权；持续竞争不逐次输出错误日志，避免风暴。

## 不代表什么

- 不表示集群唯一owner一定存在，不提供数据库权威全局健康判断。
- 经负载均衡读取时可能落到另一副本，应在运维采集里结合Pod/实例标签；不要据一次standby快照重启实例。
- 不改变SQLite失权停止、MySQL重新竞选、TTL、SQL预算、推理/hold或readyz语义。
- 尚未接入监控平台或定义客户告警阈值；该功能提供安全信号，不能称完整告警系统已部署。

## 验证状态

本机诊断生产代码已在后续分支实现；完整本地回归438pass、0fail、25条件skip，类型检查通过，生产增量独立只读复核无确认问题。新镜像`sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb`的**选择性运行验收已通过**，构建后生产源码未改；不是重跑冻结v4最终四项。

- 新建3个由真实worker驱动的mock成员；双副本接口均验证缺失/错误鉴权401、额外查询参数400及no-store。
- MySQL暂停期间双副本诊断仍200，用时8/7ms。原owner转standby，失权计数0→1，原因`storage_unavailable`、子类`deadline`；另一standby失权计数仍0，不能把持续竞选误计为失权。同期业务返回安全503 `pool_storage_unavailable`。
- 暂停控制跨度18.322秒包含有意等待12秒及业务约5秒失败预算；解暂停至调度与健康恢复12.282秒，随后推理200，hold/cataloghold均0。整体32.976秒；这些是本次测量，不是恢复SLA。最终paused1、target0、max8、ttl600。
- 独立证据核对已完成：双Proxy健康且RestartCount均0，精确预期镜像匹配；两个运行容器各自的3个生产源码文件均已按增量manifest独立hash核对一致。原owner只有1条安全allowlist字段的`ownership-lost`日志，原因`storage_unavailable/deadline`；另一副本无此日志。
- MySQL已运行、解暂停且健康，之前v4-final-load的MySQL卷保留。最终健康快照为3ReadyIdle、0lease、paused1、target0（10分钟测试租约自然过期）；preview已停止，无后台测试。完整日志及独立证据见[后续进度](user-pool-post-v4-progress.md)。

### 执行脚本与事后严格校验分开

实际运行的原脚本SHA-256为`5e88bc4b34eedb27b8517ce5cece29af6d1652942e2bda1547dae5340b9fd4cd`。审查发现测试辅助`keys()`允许缺少必填字段，属于测试校验不足，不是已确认的生产接口缺陷。新增本地`local-diagnostics-contract.mjs`严格校验及3个测试全部通过，父运行脚本已接入严格helper；保存的全部6份真实运行快照也已通过必填字段、allowlist和数值/时间严格重验。

这是原运行结果上的**事后契约校验**，无第二次故障注入，不声称修正后的严格脚本已远端运行。原始报告、严格重验结果及各自SHA-256见[后续进度](user-pool-post-v4-progress.md)。

冻结v4的独立进程routes两例及worker两个SIGKILL/真实约30秒TTL接管子场景已另行实际通过；这些结果属于冻结v4，不是本诊断增量运行的替代证据，也不覆盖所有进程排列。本轮实现及限定验收收口；全局owner健康判断、跨副本告警及客户SQLite失权恢复仍是独立未交付项。
