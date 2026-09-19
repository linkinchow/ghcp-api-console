# 多 SSO／多 slug：迁移、升级与回退设计

日期：2026-09-18。基线：`8ad76d547c9d067aac79f99391859cc67dcd7b44`。分支：`feat/multi-sso-slug`。

**本文为总体迁移设计，不是生产升级批准。** 依次保留[v1→2工具](../upgrade/default-enterprise/README.md)、[schema2→3工具](../upgrade/multi-enterprise/README.md)、[Proxy3→4及混合版本登记工具](../upgrade/multi-enterprise-pool/README.md)。最终存储为Proxy4＋SSO/Login3，授权contract2、registry JSON3。实际隔离MySQL8.4.11迁移、恢复、并发与mock全栈验证见[第五阶段报告](user-pool-multi-sso-slug-phase5-validation.md)，操作步骤见[升级指南](user-pool-multi-sso-slug-upgrade-guide.md)。未执行真实GitHub多企业或客户部署；不得用手工SQL/修改fingerprint代替工具。

配套：[系统与容量调度设计](user-pool-multi-sso-slug-design.md) · [本阶段验证记录](user-pool-multi-sso-slug-design-validation.md)。

## 1. 升级结论

1. 此次需要配对升级 **Proxy全部副本、SSO、Login、Console**，不是仅Console镜像升级。
2. 首次从单企业结构进入多企业结构，采用维护窗口，停止新准入、排空在途执行、停止旧写入方后迁移。
3. **不承诺新旧版本共库混跑或零停机。** 既有600秒超时和Console-only升级流程不能直接用于此次schema/身份路由变更。
4. 租约可原样保留，不需要等待全部active lease到期，不批量Release、不重绑caller。
5. 迁移只增加default企业归属及必要约束，不能自动开户、分配席位、重登账号或调用真实模型。
6. 一套SSO进程原生管理多个profile，旧default公开SSO入口/签名身份保持不变，不退回每企业一套SSO的运维模型。

## 2. 现有数据如何映射

### default profile

- 从客户原来的有效企业配置创建唯一原企业profile，内部ID采用一次生成并固定的UUID；真实slug和shortcode原样登记。本文default仅指原企业角色，不是字面数据库ID或替代slug。
- 原池持久化max_accounts完整映射为default.max_accounts。
- 原全局idle_target、lease_seconds等设置保留；维护期间pause/准入变更另行记录，不能把临时维护值冒充原业务设置。
- 新企业先登记为draft，cap由管理员显式提供；不能把旧cap复制N份、自动均分或自动启用。

### 必须保真的字段

| 数据 | 保留要求 |
| --- | --- |
| Proxy主账号（含旧direct） | identity、sso_user、GH绑定、token字节、状态、时间、oauthAttemptId等保持；仅回填default归属和必要世代元数据 |
| Pool成员 | identity、ordinal、stage、attempt、generation、verified_at、恢复/错误证据、名额占用保持 |
| caller leases | ID、caller hash、member、phase、assigned/last_success/expires时间保持 |
| holds/cooldowns | 不通过删字段“通过预检”；先安全排空hold，保留冷却语义与原截止时间 |
| 全局调度 | next_ordinal及名称目录顺序保持；不按企业从0重算 |
| SSO用户 | 旧用户名/NameID、密码hash和salt、邮箱、SCIM/GH映射、创建时间、席位观察状态、pool-managed标记保持 |
| Login | task ID、日志关联、nonce、任务历史/不确定状态保持；不声称内存队列可无损恢复 |
| 统计/事件 | 保留现有内容及保留策略；企业归属只按可靠关联回填，不根据错误文本/用户名猜测 |
| Console | admins.json、密码hash/salt、角色、enabled及实际挂载保持，不触发重新初始化 |

实际schema升级可能引入新约束/新世代字段；迁移器必须记录其确定性生成方式，并证明不会改变上述业务标识和凭据。凭据fence触发器不得把“补企业列”当作凭据更新；不能为了迁移临时关闭所有保护而不恢复验证。

### SSO表不是简单加一列

当前sso_user是单企业主键。多企业同名用户需要复合逻辑唯一键及正确外键/索引，通常需受控重建SQLite表。**分期执行：第二阶段single-profile基础保留旧主键，只增加严格单企业归属；第三阶段与全部查询和SAML/SCIM/会话隔离同步完成复合键迁移。** 回填原企业时逐字段复制，校验大小写规范化冲突、孤立引用与现存多identity关联；发现冲突应中止并出具安全报告，不静默合并。

### 不是五库合一工具

本文不授权自动合并五套既有部署。多个来源可能拥有相同全局identity、ordinal、用户名或不同凭据，不能既保留全部旧主键、又无映射地合并。未来若要导入其他已有企业，需要单独的来源ID/别名映射与全部引用迁移设计。

## 3. 配置和公开入口的兼容

- default保留现有公开base URL、metadata/entityID、SSO/login/logout地址、SP ACS、签名证书及私钥。不要求客户仅为迁移default而重新配置GitHub信任。
- 新企业有独立显式profile入口及签名/SCIM配置，接入由管理员执行，不从请求body选择企业。
- 旧无profile管理/SSO/direct接口只作用default；新接口未知profile应拒绝，不回落default。
- 老caller-lease推理客户端仍发送原caller hash格式；无需LiteLLM新增企业选路hook。NGINX路由不在本次发布依赖中。
- 原全局可写max_accounts接口在多企业启用后明确拒绝，返回使用企业cap接口的可操作错误；不能悄悄只改default。
- 单企业池原名额上限迁为default cap，总cap为各企业cap合计；共享10000名称目录仍是独立技术边界。

企业profile配置投影跨Proxy/SSO/Login核对ID、身份映射、revision和能力版本。未一致的企业保持不可调度；default-first测试通过不代表新企业路由已经安全。

## 4. 为什么不能让旧版本混跑

源码核对结果：

| 基线8ad76d5路径 | 加入多企业schema后是否可靠拒绝 |
| --- | --- |
| MySQL caller-lease新启动 | 已知pool表增加列/约束会触发严格schema校验；fingerprint也可能阻止初始化，但必须用实际旧binary测试 |
| MySQL direct新启动 | 不走完整pool校验/fingerprint，不能依赖上一行的保护 |
| 已运行的旧Proxy | 不会每次事务重查启动schema/fingerprint，不能靠增加版本行驱逐 |
| SQLite旧Proxy | 没有同等最高schema版本/fingerprint拒绝；新增列或表不足以阻止旧代码写入 |
| 旧SSO/Login | 不理解profile，可能把缺失字段当default，不能与新任务混用 |

新增schema_version/能力版本只约束读得懂它的新代码，**不能让旧binary突然具备版本检查能力**。settings.version当前是乐观锁，不是schema版本。

可靠切换边界包括：停止所有旧写入进程、控制自动拉起、隔离旧数据访问、核对配对镜像和配置。必要时新数据文件/新DB账号及权限隔离由客户DBA审批后执行；不能为了省事擅自撤销生产权限。

首次迁移采用单向维护切换，而非让旧Pod与新Pod通过普通RollingUpdate交替访问新schema。若以后要求更低停机，需要先交付并验证一个认识新协议/版本门禁的过渡版本，而不是临场猜测兼容性。

## 5. 迁移工具的设计要求

新增显式版本化工具，不改宽现有严格白名单以“接收任意schema”。应提供：

1. **纯只读预检**：识别来源精确schema、持久化设置、服务数据和配置映射；输出只含计数/安全标识的报告，不访问GitHub。
2. **维护态验证**：无仍可执行的旧writer、在途hold/claim、未确认外部任务；冷却与历史证据完整；不能只靠paused=true。
3. **备份校验**：确认一致备份、恢复演练证据、源/目标标识，拒绝覆盖未知已有目标。
4. **显式执行**：绑定来源/目标/schema版本/配置revision/维护授权；不得隐式启动服务或解除预热暂停。
5. **可恢复进度**：MySQL DDL不具备整个跨表/跨服务事务原子性；分阶段记录checkpoint，完成前禁止应用启动。SQLite各库也不是跨库事务。
6. **重复/部分执行检查**：相同已完成迁移应可识别；参数变化、半完成状态、不明提交必须停止核查，不能简单重跑。
7. **逐字段保真**：账号/凭据/lease/名字/任务/SSO hash等精确比较，内部比对不将原值打印到报告。
8. **结构验证**：FK、唯一键、索引、触发器、profile归属、版本门禁均正确；原凭据fence/持有者保护不可丢失。
9. **离线输出**：报告区分设计值、实际迁移结果和未执行测试，不输出连接串、Secret、完整token或用户敏感资料。

现有 [caller-lease SQLite→MySQL importer](../upgrade/user-pool-mysql/migrate.ts) 严格校验表/字段/trigger、paused、owner、holds、外部任务及凭据保真；这些原则保留，但它不是新的多企业迁移器。新增归属后需要明确v1/v2分支及导入顺序。

不得以只拷accounts/stats的旧direct迁移工具替代。此次也不要求已经使用MySQL的客户再次迁移数据库引擎；结构升级和SQLite→MySQL是两个维度，不捆绑执行。

## 6. 维护窗口操作顺序（设计，不含待实现命令）

### A. 维护前准备

- 固定新旧源码SHA、客户自建镜像digest、配对服务版本，提前完成构建；不在切流时临时构建。
- 记录实际数据库驱动、挂载、Service selector、HPA、工作负载副本数、所有后台writer及自动拉起机制。
- 用脱敏/合成副本演练迁移和恢复，估计实际所需维护时间。不能因推理上限600秒就宣称窗口一定10分钟；登录/SCIM可能更长或结果未知。
- 预先接好维护入口，让新请求收到明确临时不可用/Retry-After；不盲目重放已发送的模型请求。
- 留存当前全局target/cap/TTL/pause、企业身份配置与公开SAML信任参数；敏感值用认可的受控方式备份，不写进Git报告。

### B. 排空与备份

1. 暂停补货及管理写入，入口停止新的业务/目录准入。
2. 让已有推理/流式请求按原deadline完成，观察hold和catalog hold实际归零；不要只靠Service切换推断连接已经结束。
3. 检查SSO/SCIM/席位/Login任务及回调；确认已完成、已安全终止或明确人工处理。取消数据库任务不等于浏览器停止。
4. 停所有源writer/scheduler，防止旧实例被控制器拉起；无法确认外部任务状态时停止升级，不清nonce/hold来过预检。
5. 对Proxy、SSO、Login状态取得一致维护点备份，保留Console管理员文件、Secret/证书恢复材料与配置。SQLite需使用一致备份机制，不能只复制活跃.db而漏WAL。

**不等待48小时lease TTL，不主动释放现有租约，不改变expires_at。** 维护期间时间仍前进，已经自然到期的lease按恢复后的正常逻辑处理，不偷偷延长。

### C. 迁移与静态验证

1. 用新工具执行预检；报告必须确认default映射、原cap归属、孤立引用/同名冲突和名称目录状态。
2. 在停写条件下按经演练顺序迁移各存储；保留原备份，不覆盖不明目标。
3. 离线逐字段比对及完整schema检查；验证各服务profile revision一致，默认SAML端点和签名身份未变。
4. 完成前禁止新应用接入目标，不让某个已迁移服务提前处理回调。
5. 提交/DDL结果不明时停在维护态，核查checkpoint及实际数据，不宣布成功或重新盲跑。

### D. default-only 启动与验收

1. 业务仍关闭、预热仍暂停，先启配对的新SSO/Login、一个Proxy及Console，明确使用新数据/配置。
2. 检查启动是否触发owner、reclaim、统计裁剪等写入并记录。**启动应用就可能越过“纯迁移无新写入”的回退边界。**
3. 核对default总库存、cap、ready/lease/cooldown、任务状态、账号/用户归属、SAML metadata、管理员登录和配置状态。
4. 不因看到ready就自动新建真实账号或调用模型。生产验收的外部登录/推理需客户另行明确批准和限定。
5. 验收通过后扩新版Proxy副本，确认共享DB/配置一致，不混回旧版本。
6. 分别批准开放业务、恢复原预热状态；两者是不同动作，不隐含执行。

### E. 新企业接入

default稳定后逐个接入draft企业，配置独立Secret/SAML/SCIM信息及显式cap，通过配对校验后由管理员启用。即使启用，仍只有全局idle缺口才触发新建；现有idle充足时新企业库存为0是正常结果。

## 7. 回退边界

| 时点 | 可以承诺什么 | 禁止的捷径 |
| --- | --- | --- |
| 执行迁移前 | 恢复原维护设置，使用原数据及旧版本 | 不需清账号/租约 |
| 迁移完成但尚无新版运行时写入、无外部副作用 | 停止新进程，按已验证一致备份恢复各服务与旧配置，再启动旧版本 | 不直接让旧镜像读取新schema |
| 新版已启动/写入，仍仅default | 先停写、保存当前数据并核对差异；只有经验证的当前数据降级/恢复工具才能承诺保真 | 不把“未开放业务”当无写入；不直接覆盖旧快照声称无损 |
| 已有非default成员/任务或其他企业外部副作用 | 暂停新增/排空相应企业，优先修复前进；专门迁移/对账后再讨论降级 | 不删除enterprise_id、改fingerprint、重新绑定旧lease或恢复快照抹去证据 |
| 事务提交或外部操作结果未知 | 保持维护/安全暂停，核查实际状态与关联ID | 不自动重跑/开户/分席位，不声称已回滚 |

恢复数据库不会撤销已创建GitHub用户、SCIM修改或席位。任何接受数据回退损失的灾难恢复决定必须由客户明确做出，不能冒充无损回退。

## 8. 恢复材料清单

- Proxy完整DB一致备份/PITR点：主账号凭据、pool inventory/leases/events/stats、恢复字段、schema和迁移记录。
- SSO SQLite：用户hash/salt、SCIM/GH映射、pool标记、席位观察、运行设置、预算/导入计划。
- Login SQLite及必要受保护日志：任务、nonce、运行设置；不声称备份包含内存密码和正在运行的浏览器。
- Console admins.json，记录实际ADMINS_FILE及权限/挂载。
- 原SAML证书/私钥、SCIM/PAT、密码策略、session/internal secrets的受控恢复路径；仅保存Secret名称不够。
- 新旧镜像digest、配置revision、公开URL/entity/ACS、Service/HPA/副本及PVC信息。

材料放客户认可的长期受保护位置；不放Git、不把实际Secret放ConfigMap、不公开包含用户/密钥的原始测试证据。必须做恢复演练，而不只确认备份文件存在。

## 9. 上线前必须通过的测试

- SQLite/MySQL旧数据到default归属的精确保真，旧direct账号不自动变pool成员。
- SSO复合唯一键迁移、大小写冲突、同名不同企业、密码hash/证书/NameID保真。
- Login pending/running/取消/重启不确定任务、幂等nonce、错企业/旧回调/删除重建账号保护。
- MySQL DDL中断、重复执行、不明commit、schema版本不符、部分服务迁移恢复。
- 实际8ad76d5旧binary的SQLite/MySQL、direct/caller-lease、新启动/已运行兼容矩阵，诚实报告不能靠软件阻止的路径。
- 多Proxy并发补货/cap修改不超限，lease/catalog并发不双租、不跨企业重试。
- 原default旧入口/API/客户端兼容；未知profile不降级；Secret不进入Console/日志/报告。
- 全套备份恢复及维护窗口演练。测试全部先用隔离DB和mock，真实环境另获授权。

以上为总体上线验收清单，不是所有客户拓扑均已验证的声明。第五阶段已执行隔离MySQL8.4.11完整迁移链、v4备份恢复、并发、故障注入、旧storage classes兼容及迁移后应用验证；精确范围见第五阶段报告。完整旧HTTP binary/所有SQLite兼容矩阵、客户自己的维护/恢复演练及真实GitHub多企业冒烟仍不可由这些结果代替。
