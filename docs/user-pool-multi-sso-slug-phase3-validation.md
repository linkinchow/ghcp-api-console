# 多 SSO／多 slug：第三阶段实现与验证

日期：2026-09-18。分支：`feat/multi-sso-slug`，基线提交8ad76d5之上保留第二阶段与本阶段未提交修改。

**本阶段实现SSO/Login的多企业隔离、Proxy授权回调配套和schema2→3显式迁移。账号池跨企业调度和Console企业管理界面仍未开放。** 当前不是客户生产升级批准；真实MySQL schema3验收仍缺完整执行环境及测试harness。

入口：[第三阶段离线工具](../upgrade/multi-enterprise/README.md) · [总体设计](user-pool-multi-sso-slug-design.md) · [第二阶段历史报告](user-pool-multi-sso-slug-phase2-validation.md)。

## 1. 企业标识与版本

- enterprise是GitHub企业账号；slug是它的URL/API标识，不是enterprise下面的子级。
- schema3把固定UUID作为enterprise_profiles真正主键，slug唯一，shortcode独立保存。保留原企业UUID，不改SSO用户名/NameID、token或lease。
- `legacyEnterpriseId`持久固定，旧无scope入口只代表原企业；不能通过header/body把旧路径切到另一企业，也不依赖profiles数组顺序。
- schema3、contract2、能力`enterprise-isolation-legacy-pool`。v1/v2的冻结DDL、validator、工具保持原版本语义，不通过改全局常量把旧工具变成新工具。
- 配置使用`ENTERPRISE_REGISTRY_FILE`：登记profile数组、registry revision、每企业revision、公开身份与可信地址、Secret引用。Secret原值不进入新增registry、DTO或授权账本。
- registry里的maxAccounts是登记种子，运行时企业表cap仍为权威；身份摘要排除cap，改cap不改身份revision。总cap技术上限仍10000，共用原名称空间。

## 2. SSO隔离

### 数据和外部操作

用户、pool-managed标记、运行设置、预算月份缓存、EMU导入计划/行使用企业复合键及外键。所有查找、OR搜索、分页、计数、容量、密码/角色更新、删除、导入和批量显式传EnterpriseScope。

- A/B相同用户名可以共存，原用户名大小写文本保持；只在企业内匹配，不跨企业“找到就用”。
- SCIM、席位和预算client固定profile的endpoint、slug及Secret；请求不跟随重定向，不借用原企业凭据。
- settings/cache、SCIM pacing与重试按企业隔离；所有异步分支保持原context。
- SSO→Proxy破坏性操作前校验scoped ownership强契约，响应必须带企业、revision与contract2，旧或不明响应不视为安全放行。
- 用户incarnation防止删除重建后迟到操作写回；单实例操作锁加持久operation_fence，未知外部结果不自动重试，重启也不能消除该阻塞。解除需维护核对，未提供自动对账/清除工具。
- 批量任务在接收时捕获各用户实例；排队中同名删除重建，后续行拒绝而不是操作新用户。
- 持久事件及主要users/SCIM/seat/API结构化日志包含企业ID/revision；不新增明文密码/token日志。

### SAML与浏览器

- 新入口`/profiles/:enterpriseId/metadata|sso|login|logout`，每企业独立IdP/SP、证书/私钥、cookie及签名key。
- legacy根入口保留原metadata/entityID、SSO/login/logout、ACS与NameID配置；不为迁移强迫更换GitHub信任。
- AuthnRequest校验Issuer、Destination、ACS、binding、时间，拒绝DTD/entities、超限解压、重复/歧义关键参数；不让RelayState选择企业或目标地址。
- 服务端有界session＋一次性SAML事务，绑定企业/revision/session/nonce/请求；CSRF、重放、多标签页、ForceAuthn、logout按企业处理。
- 单实例内存session是有意边界：进程重启使session失效。不能因此宣称SSO已支持无状态多副本。

## 3. Login与Proxy授权闭环

新任务持久化：企业、enterpriseRevision、账号identity与accountIncarnation、oauthAttemptId、预期GH login/可选可信用户ID。创建前查询Proxy权威绑定，nonce ledger保证幂等：同attempt不重新打开浏览器，异绑定拒绝，删task不删nonce证据。

- 历史任务保留原值并标history-only；不补造其历史incarnation/revision，不允许旧nonce重跑或回调。
- 每任务独立browser/context和AbortController；SSO填凭据前精确检查允许origin/path，不能用简单路径前缀或通用Azure域放行。
- URL/selectors来自可信registry，不允许创建任务请求覆盖。
- 状态CAS支持callback_pending/cancel_requested/uncertain；取消需Proxy权威确认，未知结果不能显示“取消成功”。重启不恢复密码、不盲目重新派发浏览器，仅有界核对20条/30秒，其余需显式reconcile。
- Proxy最终用新token请求固定profile的GitHub `/user`，核对实际主体，再按企业＋revision＋identity＋incarnation＋attempt＋active状态原子消费。callback body不能重新绑定ghLogin。
- success/failure/cancel均是终态；迟到成功不能覆盖取消/失败。成功ACK丢失可由私有结果摘要确认相同payload，不把所有409当成功。
- 账号删除重建更换incarnation；跨企业identity冲突、SSO用户名/已绑定GH主体重绑拒绝，允许原占位账号首次可信填入GH login。
- 旧缺完整绑定的危险token写入callback返回426，不降级为nonce-only。
- MySQL/SQLite实现同一存储契约，但SQLite或SQL模拟结果不等于MySQL服务器事务验收。

Proxy多企业管理/内部账号操作可以显式scope，**pool所有成员、补货、候选、catalog、租约/恢复、cap仍固定legacy企业**。不在本阶段把新企业加入推理分配，不改变429冷却为换企业重试。

## 4. schema2→3与登记

新`upgrade:multi-enterprise`工具保留旧v2入口，支持显式init/preflight/apply/verify/inspect/register：

- SQLite只读standalone源镜像→独占新输出，逐旧列、类型、sequence、receipt、token/hash-salt、lease/generation保真。
- account/user incarnation映射由受保护plan一次生成；apply不重新生成UUID。
- 旧Login终态task的执行字段NULL且history-only，旧nonce写不可删除tombstone；旧导入计划不能凭当前同名用户自动填实例后执行更新。
- MySQL独立v3 checkpoint，不改写v2旧12步证据。未知DDL结果停止，只有明确before/after才能显式resume；不声称DDL可整体rollback。
- register仅追加profile、revision CAS、固定legacy pin；不改旧profile身份/SecretRefs、不复制用户/证书、不开户。SQLite登记后的verify还比对所有既有企业业务行和原profile/cap，不能只看schema就声明保真。
- 三服务无跨库原子事务；部分成功必须保持停流量并检查，不能直接恢复旧版本或自动覆盖失败输出。

## 5. 实际验证结果

全部使用合成数据、loopback、mock，未访问真实GitHub/SCIM/席位/模型或客户DB。

| 验证组 | 已执行结果 |
| --- | --- |
| Proxy完整回归 | **530项：502通过、0失败、28真实MySQL门禁跳过；156.811秒** |
| 追加MySQL授权SQL契约 | **7通过、0失败**；严格状态化SQL模拟，不是真实MySQL |
| Login完整模块 | **32通过、0失败、0跳过；2.671秒** |
| SSO完整模块（含SAML与最后日志scope补丁） | **50通过、0失败、0跳过；44.122秒** |
| 共享v3纯契约 | **7通过**；包含registry、授权绑定、SecretRefs、取消HTTP |
| Console单元回归（含取消确认） | **8通过、0失败；9.248秒**；unknown/已完成不报取消成功 |
| v3迁移工具整组 | **57项：56通过、0失败、1固定skip占位；9.473秒** |
| v2工具兼容整组 | **70项：69通过、0失败、1真实MySQL跳过；10.728秒** |
| 误拒权限后重新批准的三文件 | **9通过**；共享构建和隔离测试实际重跑 |
| 全部组件构建/类型检查 | 通过；shared、Proxy、SSO、Login、Console及全部upgrade项目 |

后续独立SQL契约7项与完整Proxy回归不是同一次运行，不能将其当作一个未经执行的537项全套结果。各定向组与完整组也可能重叠，不相加夸大覆盖。

### 实际浏览器SAML证明

启动真实本地SSO服务，两个profile分别使用临时自签证书、不同密码、相同SSO用户名`same-user`；独立模拟SP实际校验response与assertion双签名、Audience、Issuer、Destination、InResponseTo及RelayState。

实测：

1. A登录生成正确签名并被A的模拟SP接受。
2. 同一浏览器转到B仍需登录，没有复用A会话；A密码在B返回401。
3. B密码登录成功，B证书与B的目标/事务匹配。
4. 注销A后，B仍可完成免密会话SSO，A重新要求登录。
5. B的ForceAuthn重新要求密码。
6. 真实API按路径返回A/B各自同名用户且实例ID不同；旧根入口携B身份拒绝400。Login同样按企业隔离列表，Proxy能力和ownership响应匹配企业/contract2。

浏览器首次暴露一个真实问题：`Referrer-Policy:no-referrer`使Chrome同源表单POST的Origin为null，严格CSRF检查拒绝。改为`same-origin`后得到真实同源Origin并通过，**没有放宽CSRF校验**。增加回归断言。另补带nonce的最小CSS防透明页面在深色预览里不可读；CSP未放开unsafe-inline。

### Console最小兼容

没有新增企业管理UI，只补新任务状态、history任务禁止旧nonce retry、未确认任务禁止删除。实际页面检查uncertain不能删除，history失败任务不能retry但可走受保护删除；cancel API wrapper遇unknown不报告成功。页面无运行时console错误。

## 6. 保留的前期失败与修正

- 新共享RequestRedirect类型不在Node编译库中，改为明确union；类型和测试重新通过。
- agent临时构建缺shared产物、单文件after过早清fixture目录等测试接线错误，修正后模块重跑，不当作应用成功。
- 第一次完整Proxy 526项中428通过、70失败计数、28跳过。来源包括：旧mock没有registry、MySQL边界测试故意跳过init却未注入合成scope、统计fixture无归属主账号、新响应字段未补断言、原pool GH mock含实际GitHub用户名不允许的`.`、旧task缺完整binding/旧非scope路径、原大规模fixture漏incarnation。
- 修复均保留原安全断言，改为真实新契约的合成fixture；没有放宽企业/主体/nonce校验或生产timeout。后续530项完整串行回归零失败。
- 新批量admission实例测试首轮仅null/undefined断言差异，按既有SQLite表示修正后6项企业隔离测试全部通过。
- 用户误拒构建/三文件测试后先停止；用户通过明确确认重新允许后，主会话正常发起执行，9项通过。未绕过权限。

## 7. 不能作为生产保证的边界

1. **真实MySQL schema3验收harness尚未实现，当前新工具文件只是固定skip占位。** 不只是缺环境变量；仍须补真实DDL/trigger/双连接CAS/中断恢复测试并获得专用实例授权。现有Proxy真实MySQL门禁用例也未执行。
2. 尚无真实GitHub enterprise SAML/SCIM/席位/主体校验调用；`/user`用mock验证客户端/服务器拒绝语义，不是客户账号验证。
3. Login的真实GitHub设备流浏览器未执行；SSO浏览器测试是本机真实SAML与模拟SP，不等于GitHub端验收。
4. SSO session/transaction为单进程有界内存存储，重启失效；未知SCIM/席位操作有持久用户fence，需要人工核对才能解除。没有自动安全解除/完整外部对账工具。
5. 三服务维护切换不是原子事务；新版写入后不承诺恢复旧快照无损。SecretRefs与原证书路径需客户自行受控配置，不自动迁移外部信任。
6. 多企业pool补货/分配算法、在线企业管理、Console企业筛选仍阶段4；本阶段pool只legacy，不将新profile混入业务请求。
7. 平台内部token仍服务级权限，不是企业管理员RBAC；企业scope防逻辑串号不代替可信服务认证与网络边界。

## 8. 文件与状态

第二阶段源码已保全为忽略的私有检查点；各agent按该未提交基线增量集成，不覆盖旧成果。工作区既有data文件没有解析原文，按字节校验完整移到系统临时目录保留，不进入Git。

本轮未commit/push/合并main，未创建或部署云资源，未改变真实SSO配置。原始合成测试日志保留在忽略的`.claude/enterprise-phase3-*.log`，不得把私有证据/临时证书加入交付。
