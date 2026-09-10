# GHCP User Pool — 待办清单

更新日期：2026-09-11。此清单仅记录后续工作，不代表已经开始实现或授权操作真实租户。

## UP-TODO-001 OAuth access token 生命周期与失效恢复

**状态：部分完成。用户后续授权实施Pool模式401后的后台自动重新登录，已通过本地回归和Docker/mock验证；token类型/有效期确认、refresh-token主动刷新及真实租户验收仍待处理。**

### 背景和现状

当前 Login 通过 Device Flow 获取 OAuth `access_token`，Proxy保存并直接使用它。代码没有保存/使用授权响应中的 token 到期信息或 `refresh_token`，没有按到期时间自动刷新凭据的后台机制。

账号池租约的5分钟临时TTL、48小时正式TTL与OAuth token有效期互不等同。Pool运行期401现在会条件失效旧凭据、隔离并自动安排原账号重新授权，hold排空后由worker执行，不再每次要求管理员Retry。每账号一小时最多3轮自动修复，超限或不可恢复情况仍需人工处理。首次401仍返回失败，不等待登录或重放原请求。Direct不变。见[恢复验证](user-pool-oauth-recovery-validation.md)。

### 后续需要确认

- [ ] 在单独获准的测试授权过程中确认实际应用签发的token类型及响应字段，只记录类型/是否存在/到期数值，不记录token或refresh token原文。
- [ ] 核实当前应用是否要求过期型token，区分OAuth应用策略、scope、device code授权窗口和access token有效期；不从“长期没报401”直接认定永不过期。
- [ ] 核实GitHub关于闲置撤销的规则，以及直接调用Copilot端点是否计入该凭据的最后使用时间。当前未确认，不新增定期保活或探测来规避闲置撤销。
- [ ] 根据实际token能力选择方案：支持refresh时安全保存/轮换刷新凭据；不支持时设计受控重新授权。不能假设当前应用一定返回refresh token。
- [x] 实现Pool运行期401后的原账号后台重新登录，加入持久化每账号3轮/小时上限、普通失败退避、可见事件/错误及人工介入；403/429不触发该修复。
- [x] 保留owner、lease、OAuth attempt、credential generation及在途请求保护；原子token失效与任务登记，多个旧请求只安排一次修复。
- [ ] 验证重启恢复、撤销、自然到期、refresh失败及人工介入路径；明确何时保留或释放caller租约。
- [x] 更新设计/实现文档，记录已实现的被动401自动恢复与边界。
- [ ] 单独批准后补充真实token撤销/自然失效的故障验收；不将mock恢复结果视为真实验收。

### 当前不执行的动作

不改OAuth scope、不重新授权真实账号、不读取或输出真实token、不增加定时刷新/保活任务。当前仅实现被动401后的有界恢复，不宣称到期前续期或全部请求无感。

### 相关代码和文档

- [Device Flow响应处理](../src/login/src/auth/deviceFlow.ts)
- [Login任务执行](../src/login/src/tasks/runner.ts)
- [凭据保存与条件失效](../src/proxy/src/db/sqliteStorage.ts)
- [运行期上游错误处理](../src/proxy/src/routes/compatible.ts)
- [账号池状态、Retry与fencing](../src/proxy/src/userPool/store.ts)
- [预热/重新授权阶段](../src/proxy/src/userPool/provisioner.ts)
- [设计文档](user-pool-design.md) · [实现文档](user-pool-implementation.md)

## UP-TODO-002 LiteLLM 429响应与Retry-After传播

**状态：待办，2026-09-09真实网关测试发现，尚未适配。**

Proxy提供 `pool_exhausted` / 上游429和 `Retry-After`，但LiteLLM v1.99.1客户端仍收到429时该header为null，错误body也被包装。需要核实所选版本的响应header钩子/异常映射，将批准的重试建议安全传给客户端，并测试Messages/Chat/Streaming及fallback边界。不能用无限重试或账号轮换绕过限制。

另需按实际部署决定非GHCP路径是否统一剥离客户端自报 `X-User-Identity`；当前hook只在GHCP路径清理/注入，不改变其他provider的原始header语义。

记录：[真实网关端到端报告](user-pool-gateway-validation.md)。此项与OAuth自动修复独立。

## UP-TODO-003 存量成员纳管与客户升级验收

- [ ] 设计受控旧SSO/Proxy/GitHub成员纳管，按实际GitHub成员去重，验证所有权、席位、凭据、在途请求及caller迁移；本版不支持旧账号自动入池。
- [ ] 客户提供确切旧revision、挂载及schema后，在其备份副本上完成direct升级和回滚演练。原用户/密码/已OAuth凭据保留测试不替代现场数据验收。
- [ ] 定义企业总席位/账单预算保护；pool cap仅限制本池库存，不能从pending cancellation直接推导已释放计费额度。

## UP-TODO-004 真实运行与后续运维能力

- [ ] 单独批准后验证真实GitHub五路浏览器登录、更多模型/流式路径、长期容量和压力；本次真实Login并发为1。
- [ ] 完整退池/删除与席位回收流程，区分Disable、Release与真实撤销权限。
- [ ] 超过1000成员/租约的服务端分页与查询，当前页面只在已加载记录内筛选。
- [ ] 多Proxy/分布式存储支持需独立设计；本版仍为单Proxy+SQLite，不直接放大副本数。

### 后续核实的官方资料

- [GitHub OAuth应用授权](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GitHub Token过期与撤销](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)

官方策略可能变化，落实方案时重新核实；这些资料不能替代当前应用实际授权响应的确认。
