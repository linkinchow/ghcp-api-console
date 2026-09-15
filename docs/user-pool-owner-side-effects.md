# 外部副作用与调度owner切换：确定性验收

日期：2026-09-15。当前生产候选caller-isolation-v4。本轮仅新增隔离测试和运维说明，不操作真实GitHub/SSO/席位/模型，不commit/push。

## 目标与边界

对应用户指定待办第3类第1项：外部操作已经成功、但库存进度尚未保存时切换owner。随机停止Proxy和正常建池不能替代明确卡住这些边界。

本轮使用真实Worker、真实Provisioner及真实SQLite/MySQL存储；外部HTTP依赖为受控mock。测试在外部副作用记录已创建、HTTP响应尚未返回，或adapter结果已返回、最终库存update尚未执行时设屏障。只在本测试随机数据库里结束旧任期，要求后继worker通过真实claim获取新任期；释放旧操作后验证数据库fence拒绝旧写入。它不是实际生产Pod崩溃或真实GitHub服务验收。

## 场景与正确预期

| 外部步骤 | 已持久化意图 | 切换后的安全预期 |
| --- | --- | --- |
| SSO创建 | sso-creating，创建时间尚未保存 | sso_creation_ambiguous，停止自动重试；不得仅凭同名用户存在而自动采纳 |
| SCIM同步 | scim-syncing，已有SSO创建标记 | 查询同一SSO用户；若active及GH/SCIM绑定明确，推进而不重复POST；未确认时保持不明状态 |
| 席位分配 | seat-assigning，已有GH身份 | 查询同一用户席位；明确assigned可继续，不重复分配POST；未确认时不得重新创建 |
| Login派发 | oauth-dispatch，独立OAuth nonce已保存 | 搜索匹配identity/nonce的原任务，不能重复POST；回调凭据和成功warmup之后才Ready |

每步分别覆盖“响应未返回”和“进度写入未执行”。旧owner迟到的checkpoint、凭据写入或失败处理不得覆盖后继状态，不能扣除后继重试次数。Login任务必须按identity＋OAuth nonce计数，不只核对任务总数；席位以调用次数计数，避免mock的幂等集合隐藏重复POST。

## 通过标准

- 屏障确实到达目标阶段后才切换，不使用随机sleep制造概率性竞态。
- 数据库新owner已取得并推进/安全失败之后，才释放旧操作。
- 所有外部写调用次数和关联值符合预期；无同尝试重复派发，无自动采纳SSO不明结果。
- 可确认步骤安全继续；无法确认步骤不盲目重放。只读重试不算重复外部写。
- 迟到旧操作不改后继状态、凭据、nonce、attempts；无holder/连接遗留。
- MySQL仅loopback、明确disposable开关、随机测试前缀sibling数据库，不修改当前HTTP测试池。

## 已由本轮契约核对的处置原则（生产人工演练未完成）

1. 先观察持久化stage、last_error、attempts及外部记录关联；不要直接清stage、nonce、owner或手动将成员设为Ready。
2. `sso_creation_ambiguous`：自动创建已停止，单凭同名/同邮箱不能证明归属。保留证据，人工核对创建归属；不得反复POST、删除再建或自动采纳现有用户。现有retry会拒绝需要人工核对的记录，不意味着已提供自动导入/修复工具。
3. `scim_sync_unconfirmed` / `seat_assignment_unconfirmed`：新owner先读同一用户及创建标记/外部绑定。未确认时保持原意图阶段，允许有界只读重查，不重发写操作；确认后再由正常worker继续。
4. `oauth_dispatch_unconfirmed`：只搜索原identity＋OAuth nonce任务。找不到不代表POST没执行；不能另起nonce绕过。多个匹配任务属于歧义，不自动选其中一个。
5. 旧owner的HTTP操作即使完成，也必须受数据库owner/attempt/stage/generation fence约束。旧响应被拒绝不是新任务失败，不应扣后继的重试预算。

本节不授权真实账号或席位变更；实际运维指令应在测试和部署方审批后另行形成。

## 实际结果：22项通过，未改生产代码

本地先执行SQLite11pass/MySQL11条件skip；随后在Azure发生器对隔离MySQL运行同一文件，**SQLite11＋真实MySQL11＝22pass、0fail、0skip**，总17.368秒。每个MySQL用例新建并删除自己的随机sibling库，不修改前置HTTP池（32ReadyIdle、0lease/hold，暂停）。

| 场景 | SQLite | MySQL | 验证结果 |
| --- | --- | --- | --- |
| SSO成功，HTTP响应未回／最终update未执行 | 2通过 | 2通过 | 保留sso-creating，明确人工核对，attempts3，retry拒绝manual_reconciliation_required；无后继HTTP采纳或POST |
| SCIM成功，两个屏障 | 2通过 | 2通过 | 同一SSO创建标记和明确SCIM绑定，只GET恢复，无第二次SCIM POST |
| 席位成功，两个屏障 | 2通过 | 2通过 | 同一用户assigned后继续，实际fenced账号关联，无第二次seat POST |
| Login受理成功，两个屏障 | 2通过 | 2通过 | 搜索原identity＋nonce任务，保存原taskID，原回调和warmup后Ready，无重复begin/POST |
| SCIM／席位／Login结果暂不可见 | 3通过 | 3通过 | 原stage/nonce保留，attempts1有界退避，没有重新POST |

旧任期先在测试库强制到期、新worker通过真实claim取得不同UUID，后继先推进或安全失败，再放开旧操作。真实store.update返回false；另外使用后继最新行fence加旧owner调用update/fail，排除“仅因stage/generation不匹配”这一解释；跟踪真实SQL确认没有账户/事件DML。旧响应不扣重试次数、不覆盖凭据和进度。可确认步骤完成真实存储nonce回调和真实provisioner warmup，SSO歧义按设计不Ready。

源测试：`src/proxy/src/userPool/ownerSideEffects.test.ts`。完整云端日志`/opt/ghcp-test/results/owner-side-effects.log`；SHA-256：`6d1eed8fae2c1bb531366569a961e0efa701f7162c252c322b0ae834c0c09ef1`。模拟的owner到期是确定性注入，不是实际等待30秒或停止OS进程；HTTP外部依赖是受控mock，不是实际SSO/Login服务。

## 结论

用户待办3.1的四步骤、两边界及三种不可见结果已取得双驱动确定性契约证据。未发现需要修改生产代码的新缺陷。生产进程崩溃、真实远端服务一致性及人工处置落地演练不由此自动验收。上方处置原则与本轮观察一致，可作为运维说明依据，但不授权手工改数据库或真实外部资源。
