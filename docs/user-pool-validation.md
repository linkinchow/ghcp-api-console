# User Pool——本地验证报告

日期：2026-09-09。分支：`ghcp-user-pool`。范围仅为Docker fork、单Proxy进程和SQLite。本报告记录**最初一次本地自动化验证通过**，不是生产验收。**后续Docker构建、容器／HTTP链路及运行时结果见[Docker验证](user-pool-docker-validation.md)，这些后续结果已解决下文较早的Docker／LiteLLM阻塞。** 本次未操作真实租户、GitHub、Azure或付费席位；当时改动尚未提交，未push或部署客户环境。

## 已交付行为

- 精确的已认证LiteLLM key hash（`sha256:<64 lowercase hex>`）映射到一个排他GHCP成员，不使用alias／邮箱／team／session路由。
- 新推理请求领取5分钟临时租约；完整成功后升级／续租，TTL可配置，默认48小时。
- 在途hold、绝对截止时间、凭据generation和owner隔离，防止迟到完成或失效凭据续租／重新分配活跃成员。
- 模型目录和token counting使用请求级hold，不创建或续期caller租约。
- 串行预热按空闲目标和账号总cap维护库存，姓名空间为1,000个合成基础姓名×10种后缀。阶段包含SSO、严格create-only SCIM、付费席位、Login回调和模型输出验证。
- 只读获取SSO登录凭据时校验已记录用户的创建时间／邮箱，不创建或重置用户；SCIM冲突不能用于接管既有GitHub身份。
- Console支持计数、设置／暂停、协调、成员禁用／重试／恢复、确认后释放租约，以及有界账号／租约／事件列表。
- 标准Claude模型ID和direct路由继续由回归测试覆盖；预热可按实际模型能力选择Messages、Chat Completions或Responses。
- HTTP429保留绑定／冷却，不轮换账号；HTTP401隔离选中成员并返回失败，**不自动重放**。

## 已执行检查

| 检查项 | 结果 |
| --- | --- |
| 全工作区类型检查，包括升级工具 | 通过 |
| 全工作区生产构建 | 通过 |
| Proxy测试 | 145通过、0失败、1项MySQL集成测试跳过 |
| SSO测试 | 21通过、0失败 |
| Login测试 | 7通过、0失败 |
| Console测试 | 6通过、0失败 |
| 使用已安装Microsoft Edge的离线Console浏览器回归 | 1通过、0失败 |
| LiteLLM hook离线测试 | 15通过、0失败 |
| Docker Compose渲染／契约测试 | 3通过、0失败 |
| 真实LiteLLM运行时测试 | 5项跳过，固定版本依赖不可用 |
| 空白格式校验 | 通过 |
| 修改／新增交付文件中的已知客户标识、凭据字面量和私有端点扫描 | 未命中；这是启发式扫描，不是专业秘密扫描认证 |

**合计：198通过、0失败、6跳过。** 核心SQLite测试使用实际并行数据库连接；浏览器测试在本地拦截网络请求。运行时依赖安装受到包源／TLS访问限制，没有绕过TLS校验。

## 集成mock生命周期

`src/proxy/src/userPool/e2e.test.ts`使用实际SQLite账号池存储、真实预热worker／provisioner和Express推理路径，SSO／Login／Copilot响应由测试替身提供：

1. 从空库存、空闲目标2开始。
2. 创建两个合成SSO用户，严格创建EMU身份、分配模拟席位、执行模拟Login回调并验证模型输出。
3. 确认两个Ready idle成员。
4. 用两个不同hash发送请求，确认成员排他、重复调用映射稳定及标准模型ID。
5. 在前两个成员仍被租用时，通过协调使另外两个空闲成员Ready。
6. 推进测试时钟超过active TTL，回收租约，并为第三个caller复用既有成员，总库存不增加。

这证明本地编排与状态集成，不覆盖真实SAML／Playwright、GitHub传播延迟或提供方策略。

## 当时已知的发布门槛与限制

- Docker Desktop的Linux引擎未运行，`dockerDesktopLinuxEngine`命名管道不存在。Compose渲染通过，但**未执行镜像构建或容器启动smoke**。
- LiteLLM hook已对照1.81.14源码审查并完成离线测试；实际安装的LiteLLM回调／Router和最终HTTP链路仍未验证。最初支持的集成契约为异步Proxy／Router Chat Completions，原生Messages／Responses网关适配器未认证。
- 真实SAML、SCIM传播、权益、OAuth及上游模型调用需要另行授权的租户验收。
- 仅支持单Proxy进程和SQLite；当时不支持多副本／MySQL账号池。
- Console最多加载1,000账号、1,000租约和200条最近事件，过滤／分页只作用于已加载记录。
- 未实现同一请求在401后更换账号／重放；隔离成员的hold排空后，后续caller请求可选择Ready成员。
- 非幂等外部操作结果不明时，在有界重试后停止并要求核对；刻意不提供账号／席位删除和自动缩池。
- 默认密码策略未变；不能取得的既有自定义密码会被拒绝，而不是重置。
- Proxy、SSO和Console须从此分支配套重新构建，因为预热使用新增的SSO鉴权安全端点。

参见[设计](user-pool-design.md)、[配置与运维](user-pool-implementation.md)、[LiteLLM集成](user-pool-litellm.md)。
