# 安全恢复与人工核对：测试支持的操作原则

日期：2026-09-15。适用于当前User Pool状态机的排障原则，不是修改真实数据库、创建/删除账号或增加席位的授权。外部系统身份、凭据、任务标识不得写入公开工单。

## 先判断“结果已确认”还是“结果不明”

排障前记录池stage、state、attempts、last_error及对应外部操作的关联证据，必要时通过支持的管理API暂停新增调度。暂停不终止已在途操作，也不撤销外部已接受的请求；不要据此立即清理账号。

| 阶段/错误 | 自动处理与人工边界 | 不应执行 |
| --- | --- | --- |
| `sso-creating` / `sso_creation_ambiguous` | 没有保存可证明归属的创建回执，终态失败并要求人工核对；retry拒绝该记录。对照创建时间、身份归属及外部审计后，另行制定受控处置，不自动采纳同名用户 | 重复POST；改stage/创建时间后冒充确认；删用户重新建 |
| `scim-syncing` / `scim_sync_unconfirmed` | 若同一SSO用户、创建标记及SCIM/GH绑定明确可读，则正常推进；否则保留意图并有界只读重查，不能断言没有创建 | 再次createOnly POST；自动采纳旧SCIM用户；修改身份绑定绕过 |
| `seat-assigning` / `seat_assignment_unconfirmed` | 同一用户明确显示已assigned即可继续；不能确认则保留原意图。核对需区分“没有响应”与“没有分配成功” | 重复增加席位、换用户掩盖或擅自撤销席位 |
| `oauth-dispatch` / `oauth_dispatch_unconfirmed` | 只搜索原identity＋OAuth nonce；匹配且唯一的原任务可恢复，结果不明保留槽位 | 换nonce再POST；将404/超时当作不存在；清除关联解除保护 |
| Login明确`failed` | 在确认该任务及关联后，正常状态机可开始新的授权尝试，仍是原成员；这不等于重放原失败推理 | 重新创建用户或席位；用旧nonce重复派发 |
| Login `running`/`pending`/`cancelled`或关联不匹配 | 没有可证明终止的结果；保留占位和关联。cancelled只是任务数据库标记，不证明浏览器已停止 | 自动释放占位后并行派发替代浏览器任务 |

## owner切换和旧响应

MySQL新任期取得后，旧owner的checkpoint/失败处理不能改账户或事件。当前确定性双驱动测试覆盖外部响应未回及最终update未执行两边界；可确认SCIM/seat/Login以GET恢复，SSO不明则安全停止。测试证明状态机保护，不代表外部系统恰好一次执行或故障期间零错误。

不要手工延长旧owner租约、清owner行或修改generation以让迟到回执通过。凭据回调必须满足对应nonce；旧nonce被拒绝可能是正确保护，应先核对当前尝试而不是重放。

## 验收与未完成工作

已验证的细节见[owner专项报告](user-pool-owner-side-effects.md)和[四项组合测试](user-pool-deterministic-tests.md)。这份说明将“安全重试”和“结果不明”区分清楚，但真实客户环境中的人工核对、授权变更、备份恢复与升级回退演练尚未完成；本项目目前没有自动修复任意SSO歧义记录的工具。
