# SQLite失去owner后持续503：处置与改进评估

日期：2026-09-15。用户确认实际客户仍为SQLite，尚未部署多副本＋MySQL。本次仅代码及已有验证评估，没有连接、更改或重启客户服务，也不修改冻结v4候选。

## 根因可以确定到哪一层

`pool_owner_unavailable`由GHCP Proxy的池owner检查返回，LiteLLM包装为ServiceUnavailableError。不是模型名称无效或Anthropic供应商本身不可用。SQLite worker一旦失权会停止，业务owner guard持续拒绝请求；触发失权的具体根因仍需现场日志（续约异常、锁/磁盘错误、进程长暂停、第二写者等），单凭这条错误不能定论。

LiteLLM另报缺少`ghcp/claude-sonnet-5` fallback，说明这个原始model group没有匹配降级配置。无前缀`claude-sonnet-5`不等于该名称；修fallback只缓解故障，不恢复Proxy owner。日志截断提示不是故障原因。

## 当前冻结MySQL v4是否相同

不是同一故障形态：runtime的`pool_owner_unavailable`只对SqliteStorage且worker非active触发。MySQL standby仍可通过共享库为已有Ready成员处理请求；worker失权不永久设置stopped，而是撤销任期、取消旧步骤，旧工作收敛后用新UUID竞选。数据库命名锁/事务/attempt/generation保护仍存在。

MySQL仍可能丢owner或因数据库不可用返回503；owner全部异常、库存不足或数据库持续故障不会被自动重选魔法解决。冻结v4实际测试已通过MySQL停止约35秒、无需重启Proxy恢复新owner与服务；这不是无限条件自愈承诺。结果见[v4最终资格报告](user-pool-v4-final-qualification.md)。

## 客户SQLite当下恢复

先保存首次`ownership-lost`附近日志，确认仅一个Proxy进程写该库，并确认磁盘/文件权限/SQLite状态正常。若worker已停止且底层问题已恢复，受控重启该Proxy通常可恢复；旧任期未到期时仍可能需要等待。不要清owner、延长租约、删库或重建用户/席位。不能为恢复这一故障强制立即迁移MySQL。

Docker的healthcheck把容器标为unhealthy不会自动触发`on-failure:5`；进程必须非零退出才触发相应策略。Kubernetes也必须区分readiness摘流量和liveness重启，不能直接让所有瞬时数据库故障导致全部Pod重启。

## 推荐的SQLite后续小范围修复（尚未实现）

1. 区分主动停止与不可恢复的SQLite失权事件，记录脱敏原因分类，而不是只有笼统ownership-lost。
2. 失权后立即拒绝新池请求、取消/隔离旧worker上下文，保留全部数据库fence。
3. 执行有界清理后非零退出Proxy，交给已配置的容器管理器重启；不等待不合作的外部任务无限结束。
4. 新进程只能正常申请新owner UUID，不能清表抢占；如果第二实例存在或存储仍坏，应继续拒绝并告警，有限重试/退避避免重启风暴。
5. SSO创建等外部结果不明仍按原规则人工核对，不因重启盲重放。

不要简单删除`stopped=true`或给SQLite打开multiReplica，这会混淆主动shutdown和失权恢复、降低原单实例保护。进程内自动重选也是可选方案，但需要独立任期状态机和旧任务收敛设计；对当前单副本SQLite，受控退出方案边界更清晰。

验证应覆盖事件循环停顿、SQLite续约异常、第二实例仍持租约、清理超时、重启后新任期、旧回调被拒绝、持续故障有限重试，并确认正常MySQL standby绝不触发该退出路径。此修复与冻结MySQL v4分开交付，不在已经通过的候选中悄悄修改。
