# 迁移后两个真实账号建号验证

日期：2026-09-16。本次用户已查看迁移后的MySQL三副本UI，并明确授权新增两个真实账号及必要授权/预热。不是性能测试，不操作客户生产环境。

## 开始前

- 原4个真实账号迁入MySQL并保持Ready，统计2条、事件25条，迁移前后逐字段校验。
- 用户请求将100k扩展撤回；8个相关文件逐一与原提交一致，100k专用测试删除。10k相关50项回归、完整Proxy438pass/0fail/25条件skip、迁移63pass/0fail/1数据库入口skip、类型检查通过。运行副本上限一直为10000，没有部署100k。
- SSO/Login原始数据库备份完成：SSO5用户（1管理员/4普通成员），Login4成功任务、0待处理任务。
- 用户要求Prewarm5、Login concurrency2、Login pending2。Login并发通过版本化管理API更新；另两项受MySQL配置指纹保护，新增只允许并发字段变化的离线维护工具并通过31项离线测试及真实隔离MySQL正反配置校验。
- 维护时暂停并排空、停止三个Proxy和Login/SSO、确认owner到期，只CAS更新fingerprint，逐表内容校验其它字段不变；三个Proxy配置统一后启动。数据库和旧配置另有私有备份。此流程不是盲目覆盖hash或禁用校验。
- 首个合成维护验证脚本误复用缓存store，导致旧配置拒绝断言失败；更换为新storage实例后正反启动校验通过，真实池在验证完成前未改fingerprint。

## 两账号边界

- 保留原4成员；pool cap6、idle target6，SSO总cap7（包含原管理员）。
- 预热并发5、Login浏览器并发2、持久Login占槽上限2。
- 只解除暂停一次，不调用批量导入或独立Login重试；发现失败先暂停保留现场，不换名再建。
- 完成后重新暂停；不额外新增账号、不删旧成员或外部席位。

## 实际结果——通过

- 总执行114.099秒，恰好新增两个真实普通池成员；最终6ReadyIdle、0provisioning/failed/leased/hold/cataloghold。
- 两个新成员均完成SSO、SCIM、席位、真实OAuth和模型warmup；SSO记录分别为active和seat assigned。未尝试新增第三个。
- 两条新Login任务均第一次执行成功（任务attempts=1），任务持续约89.236秒和91.784秒，时间区间重叠，确认浏览器并发2实际生效。池成员失败尝试计数0，不将任务执行次数1误称重试。
- 原四个账号完整凭据行和库存行在结束时与开始前完全一致；旧账号、历史任务未重建，未删除席位。
- 结束通过管理API重新暂停：settings version13、idleTarget6、cap6、leaseTTL172800、paused1。Prewarm5、Login concurrency2、pending2保留为用户指定值。
- 本次实际证明“迁移后继续真实建号及预热”链路，不包含额外业务推理压测、计费账单核对或Rancher跨节点HA。
- 完整私有报告SHA-256：`bdd7b8cdffb8dbeafd7f08119783b0920e435cea58e5258cfe868e259d8063cb`。账号标识、外部URL及凭据留在本机受保护证据中，不写入公开报告。
