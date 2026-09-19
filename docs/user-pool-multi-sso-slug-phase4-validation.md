# 多 SSO／多 slug：第四阶段实现与验证

日期：2026-09-18—2026-09-19。分支：`feat/multi-sso-slug`。基线提交：`8ad76d547c9d067aac79f99391859cc67dcd7b44`。

**本阶段实现多企业账号池调度、企业 cap／生命周期管理、Console 企业选择与服务端过滤，以及显式 Proxy schema3→4 工具。** 以下测试使用合成数据、隔离 SQLite、SQL 模拟、loopback 服务和 mock；不是客户生产升级批准。未执行真实 MySQL 或真实 GitHub/SCIM/席位/模型调用。

入口：[系统设计](user-pool-multi-sso-slug-design.md) · [总体迁移设计](user-pool-multi-sso-slug-migration-plan.md) · [第四阶段离线工具](../upgrade/multi-enterprise-pool/README.md) · [第三阶段历史报告](user-pool-multi-sso-slug-phase3-validation.md)。

## 1. 版本与持久化

| 范围 | 本阶段版本 |
| --- | --- |
| Proxy SQLite／MySQL，direct／pool | schema4，contract2，`enterprise-multi-pool` |
| SSO／Login SQLite | schema3，contract2，保持第三阶段身份隔离 |
| `ENTERPRISE_REGISTRY_FILE` JSON | version3，不把调度状态塞进身份配置 |
| 授权回调绑定 | contract2，企业/revision/账号incarnation/attempt/预期GitHub主体 |

- 企业 UUID 主键、唯一真实 slug、EMU shortcode 不变；不修改已有账号 identity、NameID、token、租约ID、ordinal或generation。
- `enterprise_profiles.max_accounts` 是唯一可写cap权威；registry里的 `maxAccounts` 仍只是登记种子。
- 新增 `enterprise_pool_policy`，保存状态、cap/状态共同CAS版本及严格的校验证据。企业身份摘要排除cap和全局registry revision；服务配对仍核对当前registry摘要/revision和永久legacy pin。
- 新版运行时只校验，不自动建表/迁移。旧v1/v2/v3 schema与工具保持原语义；Proxy v3不得直接读取v4。
- pool事件、请求统计增加持久企业归属。历史回填仅接受精确identity关联且时间不早于当前账号创建时间；未知保留NULL，不按名字/错误文本猜企业。原列保真。

## 2. 调度规则的实际落地

只有每企业 `max_accounts` 和一个全局 `idle_target`，没有独立weight、每企业idle目标或第二个可编辑全局cap。

1. `N_e` 计所有已登记池成员，包括leased、idle、预热、cooling、failed、disabled；它是库存，不是精确账单。
2. 先计算真正可租idle `I` 与去重可推进供给 `P`，全局登记缺口为 `max(0,T-I-P)`。有足够idle时不为平衡比例额外建号。
3. 对显式active企业，建号与无绑定caller准入均使用**当前**比例分数 `N*C_e-C*N_e`；不改成 `(N+1)` 前瞻式或最小cap利用率。
4. N=0先按cap大小；每登记一名成员重算。建号同分使用UUID顺序和ordinal轮转，准入同分使用caller＋企业UUID稳定散列，不依赖registry数组顺序。
5. 临时不可用和cap满的active企业仍在目标比例分母；候选资格单独过滤。cap满仍可出租已有idle。降cap不删除成员、不退席位、不驱逐租约。
6. 已有有效lease优先，其次catalog亲和绑定，再选择新企业。TTL回收改变idle而不改变库存；429和失败不触发同次请求换账号/换企业重放。
7. 原租约按既有失败/过期规则完整安全释放后，后续独立新准入可以重新选择企业。没有新增永久失败绑定，也没有修改原凭据故障释放语义。
8. 保留全局10000名称目录；目录剩余位置单独展示，不把cap余量当成可用名字数量。

SQLite和MySQL共用评分及逻辑供给谓词：不把有有效lease/hold、未来冷却、人工核对或未知外部结果的成员当作确定idle补货；物理清理滞后不应制造重复登记。概览为只读逻辑快照，不能通过读页面触发全池reclaim。

## 3. 生命周期与执行安全

- 新装和离线新增企业默认draft，必须内部配置校验，再显式activate；校验本身不会启用企业。
- `active → draining` 停新绑定、新库存和新的闲置预热，不驱逐健康的既有lease或正在完成的请求。catalog-only绑定在排空企业不能新建推理lease，也不能绕开亲和关系选择其他企业。
- 重新启用需要重校验与显式激活。仍有效lease所需的修复、已持久化外部意图的有界观察可继续；若凭据故障按原规则已经安全释放lease，不保留一条虚构的修复租约。
- SSO/Login探针只读取已初始化并验证的存储与本地配置材料，返回安全摘要及阻塞代码；没有GitHub请求、开户、分配席位、Login派发或自动初始化。Console明确这不是外部授权验收。
- Proxy owner补货登记前与新外部执行前使用可信配置中的内部探针，严格匹配版本、企业、registry，限时/限响应体、不跟随重定向。补货只从本轮就绪企业中选候选，但不改变active目标比例分母；短暂就绪缓存最长15秒，owner更替清空缓存。SQL登记意图与实际外部操作不是跨服务原子事务。
- `Inventory`/`HeldLease` 携持久企业/revision，scope贯穿预热、OAuth、观察、凭据写入、模型请求和统计。旧direct缺scope仍固定原企业，不扩大成任意企业全局查找。
- 保留owner tenure、attempt、incarnation、generation、caller gate、hold和提交结果未知保护。MySQL准入不为公平性争用全局settings锁；最终选中企业policy共享锁与排空操作互斥。
- 管理policy排他锁期间不锁账号/hold、不写入或裁剪pool events，避免反向锁序；补货继续使用短settings协调事务。

### 复核发现并修复的排空竞态

最初在外部操作前检查企业状态，但检查与持久化 `sso-creating`／`scim-syncing`／`seat-assigning` 意图之间可能发生drain。合成重现确认排空后仍可发出一次新POST。

修复把这三个**新意图状态迁移**的资格检查放进同一存储事务。MySQL保持settings→policy共享锁→Proxy凭据锁顺序；排空先提交则checkpoint拒绝，不增加失败重试次数；意图先提交则作为已准入工作允许有界完成。事务不跨HTTP持锁，完成和观察不被错误阻断。新增13项回归覆盖两后端模拟、worker和真实provisioner逻辑。

## 4. Console 与管理接口

- 全局池页：派生总cap/active cap、I/P/缺口、目录容量、各企业库存/比例/分数/状态/阻塞原因。
- 企业策略页：正整数cap（1..10000，登记cap合计≤10000）、版本化保存、配置校验、显式激活/排空及确认。
- SSO用户、Proxy账号、Login任务、池成员/lease/events、请求统计按明确企业路径读取；过滤/分页总数在服务端完成。请求统计是**保留记录**，不是全生命周期账单统计。
- 用户界面显示真实slug，UUID用于请求绑定；企业选择不是企业管理员RBAC。SSO设置按企业，Login并发与池idle/TTL/pause仍全局。
- scope切换清空selection/对话框/页码及旧响应，异步返回不能覆盖另一企业页面。危险操作捕获企业和已显示的账号/用户incarnation；取消/重试沿用第三阶段确认语义。
- Console新增管理写入同源保护，继续使用原admins.json；窄化支持保留浏览器Host及same-origin Fetch Metadata的TLS终止，不信任任意forwarded headers。
- 新增管理错误的安全blocker代码展示，不显示原始Secret/URL/外部错误正文。
- 身份、可信地址、Secret引用登记仍离线；没有在线任意URL/私钥编辑、自动企业删除或SSO/Login多副本重构。

## 5. 实际测试结果

主工作区串行运行；外部环境变量清理，MySQL显式门禁关闭。定向组与完整组可能重叠，不相加夸大覆盖。

| 验证组 | 实际结果 |
| --- | --- |
| Proxy最终完整回归（含checkpoint、内部就绪补货门禁及多企业运行时闭环） | **617项：588通过、0失败、29跳过；126.293秒** |
| SSO完整模块 | **56通过、0失败、0跳过；43.272秒** |
| Login完整模块 | **36通过、0失败、0跳过；16.047秒** |
| Console单元 | **13通过、0失败；4.496秒** |
| Console离线Edge浏览器 | **19通过、0失败；350.958秒** |
| v4工具 | **36项：34通过、0失败、2真实MySQL门禁跳过；7.568秒** |
| v3工具回归 | **58项：56通过、0失败、2真实MySQL门禁跳过；20.945秒** |
| v2工具回归 | **70项：69通过、0失败、1真实MySQL门禁跳过；26.111秒** |
| 部署组件构建＋全部upgrade类型检查 | 通过 |

重点新用例包括：9/1、600/300/100反例，空池50库存分配，cap满出租、降cap、I/P排除、并发SQLite租号/登记、SQL锁序与CAS、错scope/HeldLease、未知commit、排空外部意图竞态、1205条统计分页、跨企业同名、迟到UI响应和陈旧incarnation。

### 多企业预热与推理的运行时闭环

新增合成运行时测试使用真实SQLite4、PrewarmWorker、realProvisioner与compatible HTTP路由，SSO/Login/模型传输全部mock。两active企业并发预热分别使用自己的accountDomain、路径、完整授权绑定；cap9/1且库存A1/B0时优先登记B，已有全局idle充足时不追加库存。真实loopback `/v1/messages` 请求使用非原企业B的合成token，同caller后续请求保持B成员，保留的请求统计归属B。另验证owner更替清空内部就绪缓存，未就绪企业不能成为新登记候选，但仍保留目标比例分母。

### 真实本地服务与浏览器

使用新的隔离临时目录，实际运行当前Proxy/SSO/Login/Console与拒绝所有外部操作的本地mock。五个服务只绑定loopback，进程包装器拒绝非允许地址及浏览器子进程。没有启动Docker、云资源或真实MySQL。合成企业A/B各2个ready成员（各1个lease、1个idle），全局paused=1、idle_target=0。

实测：

1. 全局显示A/B cap8/4、库存2/2，目标66.7%/33.3%、实际50%/50%，分数8/-8；I=2、P=0、D=0。
2. 页面把A cap改6，策略版本3→4；总cap变10、目标60%/40%、分数4/-4；库存和原lease均未改变。
3. A经明确确认执行drain→内部校验→activate，版本最终7；SSO/Login真实内部探针成功，不访问mock的GitHub/SCIM/模型路由。
4. SSO页面切A/B，相同用户名显示各自email/企业；切换后没有另一企业行残留。
5. B请求统计实际分页35条，第一页25、第二页10；企业A记录不混入。池页只列B的2个成员、1个lease和1个idle。
6. 375px手机宽度未出现页面级横向溢出；宽表使用自身滚动。完成后恢复viewport，并停止本轮五个预览服务。
7. 登录前401及预览启动探测的连接重试为预期；登录后上述管理请求均200，服务无错误日志。

原始合成日志/检查点只保留在忽略的`.claude/phase4-*`及临时目录，不作为公开交付内容。

## 6. 迁移与实库资格边界

- v4工具支持明确3→4预检/新目标/逐列保真/验证，SQLite混合复制SSO/Login3，MySQL新增独立checkpoint；不改v2/v3receipt、不重生成incarnation。
- 迁移只为原企业保留active兼容状态并有receipt佐证；其他企业draft。新装paused，离线登记只追加draft，不重置旧cap/证据/业务行。
- 三服务没有分布式事务；部分成功必须保持维护态，不自动恢复旧版本或覆盖未知输出。
- 第三阶段的真实MySQL固定skip占位已替换为**可执行opt-in测试代码**，另增加v4与双连接竞争测试；默认禁用时零连接。要求预先提供的空、专用数字loopback schema、明确DDL许可及真实socket peer校验；不新建数据库/Docker/云资源，不借用部署MYSQL_URL。
- **这些实库用例本阶段全部未执行。** SQL模拟/SQLite并发/测试代码存在，不能代替真实MySQL8 DDL、触发器、双连接事务、故障注入与备份恢复验收。仍是上线前阻塞项。
- 未验证真实GitHub SAML/SCIM/席位、device flow或模型；继承第三阶段单实例SSO/Login、内存SSO会话重启失效、未知外部操作需人工对账的边界。

## 7. 失败记录与交付状态

- 首次完整Proxy回归574项：469通过、76失败、29跳过。涉及旧schema3初始化、旧全局cap写入、缺失企业字段/readiness/SSO incarnation夹具、SQL matcher与旧read-count触发reclaim断言。保留安全断言，按新契约修正夹具后完整回归归零。
- 第一轮主工作区浏览器命令从仓库根目录执行，既有测试按workspace相对路径找不到 `dist/web/index.html`；保留失败日志，改为Console workspace工作目录后19项全部通过。没有修改应用代码掩盖测试路径问题。
- 新版执行意图与排空竞态按第3节修复并验证；不借机修改既有凭据故障的租约释放行为。
- 第二、三阶段源码已保全为私有211文件检查点，各agent只按明确文件所有权提交增量给主工作区，并核对目标hash，没有覆盖旧阶段成果。
- **未commit、push、合并main或部署。** HEAD/main/fork-main仍为8ad76d5；NGINX独立分支未合并。
