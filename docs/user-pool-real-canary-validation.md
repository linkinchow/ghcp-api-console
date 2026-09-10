# 单账号真实预热验收

> 本文保留首个真实账号验收时的阶段性结果；后续LiteLLM真实调用、扩展补池、席位统计和实际Login并发说明，统一见[真实环境完整测试报告](user-pool-real-e2e-validation.md)。下方“尚未执行”是本阶段结束时的状态，不是后续完整测试的最终状态。

日期：2026-09-10。范围：经授权的GitHub.com EMU测试企业，只创建1个普通池账号、分配1个Copilot席位，并使用 `gpt-5.6-sol` 做小额模型warmup。本报告不包含企业标识、真实账号邮箱、token或密码；详细快照仅保存在Git/Docker构建上下文均忽略的私有目录。

## 结果

**一个真实账号的无人值守预热闭环通过。此次不是mock Login、SCIM、席位或模型响应。**

| 环节 | 实际结果 |
| --- | --- |
| 新席位PAT认证 | GitHub `/user` 返回200 |
| 企业席位读取 | 返回200；PAT scopes为 `manage_billing:copilot` |
| 本地SSO创建 | 普通 `user`，使用已批准池邮箱域名 |
| 真实SCIM创建 | 新EMU active，已有身份不接管 |
| 真实席位分配 | 新成员assigned；分配记录从6条变7条 |
| Login | 仅1条任务，success；真实Playwright/Device Flow授权完成 |
| Token回写 | Proxy OAuth状态valid |
| 模型warmup | 配置模型 `gpt-5.6-sol` 验证成功，成员进入ready |
| 最终池状态 | total=1，ready_idle=1，failed=0，lease=0 |
| 收尾 | target=1、cap=1、paused=1，停止继续预热 |

从首次候选预占到ready约146秒；其中Login任务约126秒。该时长仅是这一次测试，不是性能承诺或并发容量指标。warmup使用代码中的小额请求参数（输出上限16），没有额外发起业务推理请求。

## 边界和保护

- 开始前池为空，先将持久化cap设为1、target设0、paused设1，配置载入验证后才开启target1。
- 保留旧SSO地址、签名证书、应用密钥和数据卷；只替换失效的席位PAT，原SCIM token不变。
- 预检真实SCIM读取可见1名既有用户，席位API可见6条既有分配；操作后对照可见原用户ID/用户名/active状态，以及既有席位关联均保留。本地既有管理员记录完全一致。
- 未对旧的暂停用户执行恢复、删除或改名，未移除原席位。不能把席位记录数当作空闲额度，计费以实际GitHub政策和账单为准。
- 使用更窄的 `manage_billing:copilot` PAT实际完成了本次企业席位读写，不需要为了这次测试勾选整个 `admin:enterprise`。不外推为所有API、租户策略的统一最小权限保证。
- 一次真实warmup成功只证明所选账号/模型/路径可用，不证明全部模型、所有用户或长时间运行均成功。

## 尚未执行

- 使用该真实账号的LiteLLM key-hash业务请求、流式与用量链路（此前在mock上游环境验证过）。
- 多账号真实并发开通、真实限流和长期运行测试。
- 人为撤销真实token后自动重新授权的故障测试（此前Docker/mock已验证）。
- 旧客户存量账号入池迁移。

私有原始结果：`.local-sso/real-canary-before.json`、`.local-sso/real-canary-result.json`。Console当前在本机 `http://localhost:17704/#user-pool`；SAML入口仍依赖本机Docker，不应在没有回退安排时关闭。
