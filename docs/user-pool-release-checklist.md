# User Pool 发布前检查记录

更新：2026-09-11。交付分支：`ghcp-user-pool`。本文件记录本次发布候选的验证，不是客户原卷升级已经验收的证明。发布只推送fork功能分支，不合并main、不改upstream、不自动部署客户环境。

## 交付文档

- [设计](user-pool-design.md)：hash、排他租约、有限并发、401恢复、旧用户边界。
- [实现与运维](user-pool-implementation.md)：配置、API、默认值与生效方式。
- [客户存量Docker升级手册](user-pool-upgrade-guide.md)：direct升级→pool切换、备份/挂载/回滚、所需参数、旧账号不入池。
- [User Pool页面操作说明](user-pool-console-guide.md)：每个字段、数字、按钮、列表、暂停和席位区别。
- [完整真实测试报告](user-pool-real-e2e-validation.md)：真实4账号/2key/补池，Login并发1，席位API10条与账单未核实。
- [依赖安全修复](user-pool-dependency-validation.md)：生产及构建工具补丁，审计结果。

## 最终验证结果

| 检查 | 结果 |
| --- | --- |
| 全workspace typecheck（含upgrade工具） | 通过 |
| Deployment build（Shared/Proxy/SSO/Login/Console） | 通过 |
| Proxy测试 | **172通过、0失败、1项MySQL集成跳过** |
| SSO测试 | **31通过** |
| Login测试 | **12通过** |
| Console测试 | **6通过** |
| Console本地浏览器测试（Microsoft Edge） | **1通过** |
| LiteLLM hook离线测试 | **17通过** |
| LiteLLM v1.99.1真实runtime回调测试，禁网/mock响应 | **5通过** |
| Compose契约/必填密码验证 | **4通过** |
| 全量npm audit与生产audit | **0 vulnerabilities** |
| 四个Dockerfile镜像构建 | **全部通过** |
| fresh-volume最终镜像mock HTTP smoke | **9个检查组通过** |
| 实际Proxy容器重启持久化 | **通过** |
| 池成员SSO管理操作前置拒绝 | **删除SSO/EMU、暂停EMU、移除席位及普通Sync共5类均拒绝，mock外部状态未变** |
| Console最终镜像实际登录/页面 | **通过** |
| 文档链接、代码空白及公开字面量检查 | **通过** |
| 真实私有凭据与候选公开文件比对 | **无匹配，未输出凭据值** |

自动化测试合计 **248通过、0失败、1跳过**，另有表中容器检查组。MySQL跳过因为未提供 `MYSQL_TEST_URL`，不表示SQLite pool功能漏跑。历史真实网关报告另记录过重复alias场景blocked和后续fallback补测，不将历史blocked重写成通过。

构建使用 `NPM_REGISTRY` 指向已批准保护源；锁文件保留标准可移植URL和校验过的SHA-512 integrity，不嵌入组织包源或认证信息。Proxy/SSO构建曾因包下载长时间无输出而停止/重试，最终四个Dockerfile统一每次fetch超时60秒、最多2次重试；这是单次下载限制，不是整次build的总超时。未关闭TLS或绕过包审核。

最终复验使用 `ghcp-user-pool-release-resume`，端口17900–17904和全新独立卷，四个容器均使用最后构建的镜像；此前 `ghcp-user-pool-release`（17800–17804）的结果不替代本次复验。两个mock项目都与真实SSO/seat项目完全分离。没有为了最终check新建真实用户、分配席位、撤销真实token或调用真实模型。Console实际登录及User Pool数据加载通过；登录前 `/api/console/me` 的401为预期认证探测。

## 发布复核修复

1. 新pool用户创建显式 `poolManaged:true`，强制SSO默认密码至少16个非首尾空白字符且不同于用户名；direct既有密码行为不被批量重写。
2. SSO持久化pool ownership标记，阻止普通入口修改pool密码/身份。删除SSO/EMU、暂停EMU、移除席位在外部调用前检查本地标记或配对Proxy；不再先删除外部资源再依赖Proxy FK报错。核对不可用时拒绝。
3. caller-lease模式禁用旧OAuth CSV导入，防止同一实际凭据复制到不同pool成员破坏排他性；独立管理员重授权对pool成员拒绝。
4. 无lease的catalog请求上游429后保留caller冷却记录；清理请求hold不会立即换到另一个成员。模型缓存不以stale fallback隐藏429。
5. 新增既有OAuth双identity别名及token字段保留、SSO用户名/哈希/席位关联保留测试；仍要求客户实际备份副本演练。
6. 新标记pool成员拒绝旧SSO普通Sync及非user企业角色，防止通过旧管理页绕过create-only冲突保护。
7. Login终态任务在pool恢复仍引用任务/attempt期间拒绝删除，结果消费后允许清理；pool成员独立Login Retry拒绝，保护查询不可用时503 fail closed。新增SSO、Proxy和Login回归。
8. 升级/UI文档补充空池域名也不可直接修改、SSO剩余用户容量检查、实际Login重定向URL要求，以及回退direct必须移除pool overlay并保留私网入口保护。

这些最终保护在真实测试之后补充；已通过最终unit/mock容器回归，但没有对真实租户再次执行有副作用的验证。

## 发布范围检查

- [x] 固定在`ghcp-user-pool`，确认fork远端，未覆盖main。
- [x] `.env*`真实凭据、`.local-sso`、certs、私钥、SQLite/日志和`.claude`会话文件排除。
- [x] 会话专用SSO准备脚本移入私有目录，不作为客户通用工具发布。
- [x] 公开文档不包含客户名称、实际企业/邮箱/hash或凭据。
- [x] 构建上下文排除私有目录，客户需要的`.env.example`仍由Git跟踪。
- [x] 原客户SSO地址/签名证书/数据库不在此次发布操作中修改。

实际提交SHA与远端一致性以本次git提交/推送验证记录为准；客户部署前固定release SHA，不自动跟随未验收更新。

## 未解决的产品边界

- **旧账号不自动纳管入池；旧direct header不兼容pool入口。**这是明确功能限制，不是迁移遗漏后悄悄忽略。
- 未对客户实际旧revision、定制schema、原始数据备份完成现场迁移演练；按升级手册先测副本。
- Pool cap不是企业seat/账单上限，pending cancellation不代表已免费释放。
- 真实预热Login并发1；并发5来自本地浏览器/mock测试。
- LiteLLM `Retry-After`透传仍未适配，OAuth主动refresh-token未实现。
- 暂停预热也暂停后台恢复；失败上限/未知密码/不确定Login仍需人工检查。
- 完整退池删除、跨多Proxy分布式池、旧成员导入、超过列表上限的服务端分页不在本版。
- 全量audit为0是当时公告数据库结果，不是无漏洞保证或许可/计费认证。
