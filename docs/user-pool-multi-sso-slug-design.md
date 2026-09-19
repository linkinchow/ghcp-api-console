# 多 SSO／多 slug：第一阶段设计

日期：2026-09-18。功能分支：`feat/multi-sso-slug`。代码基线：`8ad76d547c9d067aac79f99391859cc67dcd7b44`。

**状态：本文保留总体设计。第二至四阶段实现已完成；第五阶段在隔离Azure环境执行真实MySQL8.4.11迁移/恢复/并发与三Proxy mock全栈验证，实际范围见[第五阶段报告](user-pool-multi-sso-slug-phase5-validation.md)。** Proxy schema4，SSO/Login schema3，授权contract2、registry JSON3。没有执行客户部署、生产数据库迁移或真实GitHub多企业开户/席位/模型验收，不构成生产批准。NGINX 独立分支不纳入本方案。

配套：[迁移、升级与回退设计](user-pool-multi-sso-slug-migration-plan.md) · [本阶段验证记录](user-pool-multi-sso-slug-design-validation.md)。

## 1. 已确定的目标与范围

一套部署管理多个已获授权的企业来源：

- 多副本 Proxy，共享一个 MySQL 写主库和一个全局 caller 租约空间；保留 SQLite 单进程功能兼容。
- **一个租户化的 SSO 服务、一个 Login 服务、一个 Console**。不要求每企业再维护一套 SSO/Proxy/Login/Console。
- SSO、Login 起步仍各单实例、各自 SQLite；Console 继续使用持久化 admins.json。本次不顺带将它们改成分布式服务。
- 一个企业 profile 对应一个 GitHub slug、EMU shortcode 和一份独立 SSO/SCIM/SAML 配置。不是任意多对多的 SSO 关联模型。
- caller 来源仍是 LiteLLM 认证后的 `X-User-Identity: sha256:<64位小写hash>`；不要求 LiteLLM 选择企业，不从用户自报 header、邮箱或 slug 决定归属。
- 只允许客户明确授权共享 caller 群体的企业进入同一个可分配集合。若不同企业的用户/模型授权范围不同，必须先实现相应服务端授权过滤，不能默认共享。

### 容量配置只有两类

1. 每企业 `max_accounts`：企业库存上限，同时决定目标库存比例。
2. 全局 `idle_target`：全局可用备用账号低水位。沿用现有 API/存储字段名 `idle_target`；讨论中的 target_idle 是同一概念，不新增第二个可写字段。

**没有独立 weight，没有每企业 idle target，也没有第二个可编辑的全局业务 cap。** 总 cap 为企业 cap 的派生合计。TTL、全局暂停、健康/安全状态保留，它们不是新的比例参数。

### 不包含

- 五套现有完整部署自动并库；此次只从当前单企业部署升级，再显式接入新企业。
- 现有账号跨企业迁移、按比例自动删除账号或退席位。
- 按请求量、Token、费用精确分摊；永久 key→企业归属。
- 失败后换企业重试、绕过 429/Retry-After、企业授权或席位规则。
- 企业管理员 RBAC、SSO/Login 多副本队列、全局名称容量扩容。

## 2. 术语与计数口径

| 符号 | 定义 |
| --- | --- |
| `C_e` | 企业 e 的 max_accounts，正整数 |
| `N_e` | 企业 e 全部已登记池成员数，包括 new/provisioning/ready/leased/cooling/failed/disabled |
| `E` | 配置上允许参与新分配的企业集合；草稿/排空企业不在其中 |
| `C` | E 中 cap 合计 |
| `N` | E 中库存合计 |
| `I` | E 中真正可用于新租约的全局 ready idle；不包含其他 caller 的有效 hold、冷却或未验证成员 |
| `P` | E 中已登记且有明确推进/恢复路径、预计可补入 I 的去重成员数 |
| `T` | 全局 idle_target |

`N_e` 不能只等于页面上的 leased + idle：部分不可用成员仍可能持有收费席位。建号预登记也必须立即计入 N_e，否则并发/重复调度可能超 cap。

N_e 是**库存管理和防重复开户口径**，不是实际账单。任务可能尚未分配席位，已失败成员可能仍有席位，旧池外用户和外部购买记录也不在池库存里。应将“池库存”与“已观察席位/外部账单”分别展示，不宣称两者精确相等。

### P 的约束

P 必须是可检查的成员集合，而不是模糊加总：

- 包括允许继续执行的已登记预热任务、符合既有重试规则的修复任务。
- 不重复计算同一成员；不把已经属于 I 的成员再次计入 P。
- 有现存有效 lease 或其他 caller hold 的成员，不承诺稍后成为备用；不能拿它填当前备用缺口。
- 永久失败、disabled、企业排空/禁止推进、需要人工核对的未决外部副作用不算确定补货。
- 可安全即时回收的到期成员先回收再算 I；仍有 hold 的成员不能预支。
- 任务退避、超限和不确定状态沿用有界状态机；不因本地超时就把旧外部建号当作未发生再创建替代账号。

现有 SQLite/MySQL 的 deficit 细节不同，实现阶段必须先统一集合语义并作双后端对照测试，不照搬某个聚合数后声称一致。

## 3. 建号调度算法

### 3.1 全局开关优先

全局暂停时不新增库存。否则先协调可安全回收状态，计算：

```text
需要登记数量 D = max(0, T - I - P)
```

- I≥T 时一定不补建，不能为企业比例好看额外开户。
- I<T 但 I+P≥T 时等待已登记任务，不重复补建。
- T=0 不主动建号，但不阻止使用已有 idle。
- 超额 idle 不自动删除/禁用、不退席位；正常回收、修复和已派发任务的有界推进仍按安全规则处理。

### 3.2 用库存比例缺口选择企业

对每一个待登记成员，企业目标比例是 `p_e = C_e / C`。N>0时，建号和绑号统一按**当前**占比缺口从高到低选择：

```text
占比缺口 δ_e = C_e / C - N_e / N
等价账号缺口 d_e = N × p_e - N_e
等价整数分数 S_e = N × C_e - C × N_e
```

采用整数分数避免浮点边界差异；共同乘数C×N为正，因此排序与当前占比差严格一致。N=0时实际占比尚无定义，首个登记按cap从大到小选择，同cap再打破平局；首个登记后即按统一公式逐次重算。

**不使用(N+1)的前瞻目标替代当前占比。** 例如cap9/1、库存1/0时，当前比例不足的是B；前瞻公式可能继续选A。用户选定的是建号和绑号使用同一当前占比标准，因此这里优先B，并接受小库存下整数账号带来的暂时比例偏差。

候选企业还必须满足：N_e<C_e、允许补货、身份配置完整、SSO用户容量/外部退避等检查允许。首选不能建号则尝试下一候选；没有候选就停止，并记录具体原因。

**不将算法替换成 `N_e/C_e` 最小。** cap 利用率与库存比例缺口是不同策略，在不等 cap、整数和既有失衡状态下可能有不同排序。第一版实现、测试、文档均固定上述公式。

短暂健康失败、cap 已满只影响本次候选资格，不把对应企业从目标比例分母中偷偷移除；否则故障会暗中修改期望分布。显式启用/排空才改变 E。该策略并不保证不可用企业期间仍维持目标比例。

### 3.3 登记事务

每登记一个成员，在同一个短数据库事务内：

1. 校验 worker tenure/owner fence 和配置版本。
2. 在统一补货协调锁下重算全局缺口、企业分数和 cap。
3. 消耗一个全局名称 ordinal，检查既有账号冲突。
4. 插入 Proxy 主账号和带不可变 enterprise_id 的池成员/任务意图。
5. 立即更新本轮库存与补货计数，然后再考虑下一个。

事务里不访问 SSO/GitHub/Login，不等待浏览器。管理端 cap/参与状态修改与补货登记使用一致锁序；有界批次避免长期占用锁。崩溃恢复依靠已登记意图、owner、attempt 和 generation，不重复创建外部对象。

建号同分可用稳定轮转/事务内顺序打散；这只是打破平局，不另引入权重。测试需覆盖配置顺序不能长期造成可见偏置。

## 4. 新 caller 的租号算法

### 4.1 不可覆盖的安全顺序

1. 执行鉴权、caller 冷却及既有准入限制。
2. 有有效 lease：继续原企业、原成员，不重新按比例选择。
3. 无 lease 但有该 caller 的 catalog hold：按现有绑定约束只考虑它固定的成员；不可因比例切企业。固定成员冷却/失效按原语义返回429/503。若所属企业已进入draining，拒绝创建新的推理lease（拟定503 enterprise_draining），让已有catalog请求正常排空，不能改选另一企业绕过该hold。
4. 完全无绑定：进入企业候选排序。

已过期但仍有有效 hold 的绑定不能释放给其他 caller；现有请求可按原完成判定续租，新请求的 lease_draining 行为不变。

### 4.2 企业排序与成员选择

在 E 中、授权/健康允许且确有合格 idle 的企业内，按：

```text
绑号缺口 d_e = N × p_e - N_e
等价整数分数 S_e = N × C_e - C × N_e
```

由高到低选企业；企业内再按原有稳定成员规则选择并锁定。首选企业没有合格 idle 或候选被其他请求占用，可有界尝试下一候选。全部无可用候选时沿用池耗尽/不可用响应，不在推理请求里同步等待完整开户。

- 达到 cap **不禁止出租现有 idle**。
- 企业总数 N_e 在 idle→leased 时不变，绑号不直接纠正比例。
- 在同一库存快照下，比例不足企业的多个 idle 可能连续被租出。这是预期行为，不伪称 lease/流量严格按 cap 比例分摊。
- 同分用 caller hash 与企业 ID 的稳定散列打散；重试不能靠随机轮换逃离冷却/绑定保护。
- 该优先级先消耗比例不足企业的备用；后续产生全局缺口时，worker 才通过新增库存逐渐纠偏。

### 4.3 多 Proxy 并发

保留同 caller 的 MySQL 跨进程 gate，以及成员行锁、锁后校验、唯一租约/hold约束。不同 caller 不必为“比例”共抢一把全局租约锁：**绑号不改变 N_e，安全占用才必须原子化。** 企业配置版本和资格需在提交前验证。

企业库存可以在并发建号时变化，允许短窗口按一致快照近似排序，不能承诺每个瞬间严格公平。不能用各 Proxy 长期私有缓存冒充全局权威。catalog、旧 lease、credential pin、cooldown 的安全约束高于分数。

## 5. 行为例子

### 5.1 空池初始化

A/B/C cap=500/300/200，T=50，无在途任务。按逐个登记和重算，预期库存为25/15/10；没有额外的企业 idle 配置。

### 5.2 TTL 回收

A/B cap相等，库存80/20。A有40个lease到期并安全释放：A的idle增加40，但库存仍80/20。若全局idle足够，worker不建号，不为修正80/20额外增加B。

### 5.3 增加新企业

A库存100、idle20，T=10。新增B，cap100、库存0。B虽然比例不足，但全局idle足够，所以不建号。新caller先使用A现有idle；消耗到低于T时才给B登记补货。

没有新的库存需求时，B可以长期为0。这是“先复用已持有库存”的明确选择，不是故障，也不承诺固定时间内趋于目标比例。

### 5.4 降低 cap

A库存100，cap从100降至50：不删除成员、不迁移lease、不禁用idle，只停止A进一步建号并显示超cap状态。新配置会改变后续目标比例。若总库存已经明显超过新cap合计，不承诺可达新比例。

### 5.5 cap 与命名目录

多个企业共同使用现有全局10000个名称位置；**不是每企业10000**。保留全局 identity/ordinal/next_ordinal，不给旧账号加企业前缀。企业cap合计初版不得超过目录理论容量；实际可用名称还受历史冲突和已消耗ordinal影响，不能仅按10000减当前库存推算。

目录耗尽时显示独立阻塞原因，不重用名字或降低保护。若将来需要更大容量，应另做身份/名称空间版本设计。

## 6. 企业身份与配置模型

### 6.1 单一配置权威，分服务最小可见范围

- Proxy共享存储：稳定 enterprise_id、展示名、不可变slug/shortcode/账号邮箱域、max_accounts、配置revision、调度状态及可信配置引用；是库存与调度权威。
- SSO SQLite：同enterprise_id的SAML/SCIM/用户配置及受控Secret引用；是企业身份源和用户状态权威。
- Login SQLite：企业路由配置revision及任务的明确企业归属；只获取执行所需的凭据/配置，不拥有调度权威。
- Console：展示/提交明确作用域的管理操作；前端选择企业不改变服务端全局变量。

一个逻辑profile在不同服务的投影通过显式接入流程校验ID、身份信息及revision；不是多个可互相覆盖的企业注册表。

**第二阶段标识澄清：** 本文中的default是“迁移前原企业”的角色称呼，不是客户的slug，也不是最终持久化ID。内部enterprise_id采用生成后固定的UUID，slug保存GitHub真实企业标识，shortcode单独保存EMU用户名后缀。客户按真实slug识别企业；不会将它改名为default。第二阶段能力名为`enterprise-single-profile`，仅允许这一条原企业记录；第三阶段完成隔离后才开放更多企业。

GitHub.com的shortcode是3–8位字母数字，创建企业后不可更改；slug用于企业URL/API，两者不能相互推导。当前契约采用小写形式；非GitHub.com环境的规则需另行核对支持范围。

### 6.2 新企业接入生命周期

`draft → validated → active → draining` 为拟议管理状态：

- draft：登记配置、Secret引用和cap，不参与调度、不开户。
- validated：各服务身份、可信地址、SAML/SCIM配置及配置revision一致；生产环境中的实际外部验证须单独获准。
- active：管理员明确启用，进入E；仍只有全局库存缺口才补建。
- draining：停止新增租约和补货，保留成员与现有绑定，按现有健康/授权规则服务和排空；不把它等同撤销上游权限。只有catalog hold而无lease的caller不得在排空企业新建推理lease，也不得携此在途绑定切换企业；已存在的推理lease不在此步骤强制迁移。

状态仅控制安全生命周期，不增加权重/企业idle参数。cap为正整数；不以cap=0或Secret缺失表达暂停/排空。紧急凭据撤销和已有disable语义保持明确，不能隐式放行。

有成员后，enterprise_id、企业身份映射和成员归属不可通过普通表单改变。Secret轮换与改slug/SSO身份不同：前者需受控revision/缓存失效，后者需要专门迁移，不在第一版提供。

### 6.3 Secret 与信任边界

SCIM token、席位/预算PAT、SAML私钥、默认用户密码、会话密钥等由受控Secret或文件挂载注入；数据库/DTO只保存必要引用和状态，不返回原值。SSO证书/签名密钥按企业独立；平台服务间token即便继续共用，也不能被宣传成企业级安全隔离。

可信服务地址、profile路径和回调目标只能来自配置注册表；禁止caller/普通请求body给任意URL。协议、host、允许路径都需校验；profile路径不能用简单startsWith（/a会误匹配/ab）。根路径默认SSO不能接受任意其他profile入口。

## 7. 数据结构与跨服务隔离

### Proxy

- 所有 `proxy_accounts` 增加不可变 enterprise_id：包含default的历史direct账号，不能只给pool表加归属后留下回调/删除歧义。
- pool成员通过主账号继承同一企业；如inventory中冗余enterprise_id用于索引，需数据库约束/事务一致性保证两处一致。
- 全局identity保持不变；现有pool的 identity==sso_user==accountName(ordinal) 第一版可继续保留，新企业使用全局不冲突ordinal。direct用户的同名问题由企业作用域解析，不修改旧identity。
- lease/hold仍通过全局identity关联，不为迁移重建lease ID。统计/事件提供企业字段；历史可通过账号映射补全，已删除账号的遗留记录只能标为default/未知来源，不凭文本猜归属。
- settings保留全局idle/TTL/pause/owner/next_ordinal。原可写全局max_accounts迁为default企业cap；多企业模式下旧写接口明确拒绝，不能悄悄改第一家企业。

### SSO

- 由SAML单例改为按profile获取不可变IdP/SP上下文；禁止修改全局config后异步复用。
- 用户逻辑唯一键为 `(enterprise_id, normalized_sso_user)`；SCIM/GH映射、pool-managed标记、导入计划、预算缓存、运行设置、速率/退避状态均带企业作用域。
- SSO当前是出站SCIM客户端，不新增一个无关的SCIM接收端。
- default原公开URL、entityID、ACS配置、证书、私钥、NameID/用户名全部保留。新增企业使用例如 `/profiles/:id/metadata|sso|login|logout` 的显式入口。
- SAML入口绑定企业，校验Issuer/Destination/ACS等；RelayState、邮箱域不能反向选择企业。
- cookie/session绑定企业和用户；pending SAML请求采用限时、一次性的事务标识，避免跨企业/多标签页覆盖。旧无profile会话只允许default或要求重新登录，不在新企业复用。
- 自动匹配、导入、查名、删除必须先限定企业；找不到不能去另一企业“找到就用”。

### Login 与回调

- 继续每task独立browser/context；持久化enterprise_id、预期成员、可信路由revision、oauthAttemptId和账号incarnation引用，不落盘明文密码。
- 同一授权尝试幂等创建task；同尝试不同绑定拒绝。
- retry继承原企业和身份绑定，不允许body用任意ssoUrl/selectors把任务改到另一企业。
- 取消标志不是浏览器已经停止；保留未决外部副作用和在途名额，确认终止/旧nonce失效前不重投。
- 成功/失败回调核对路径企业、task、数据库成员归属、账号incarnation和oauthAttemptId；成功还校验实际获得的GitHub主体与预期一致。旧nonce、重放、错企业、已删除重建账号的迟到结果拒绝。
- generation仍负责凭据变化/在途hold隔离，不直接替代账号incarnation；保留worker owner/attempt/stage/generation所有既有fence。
- 内部token只证明来自受信服务，不能让body中的profile覆盖数据库归属。

### 旧入口兼容

旧无企业SSO/管理/direct入口只指向default，不提供跨企业猜测/查找；显式profile API遇未知企业不降级default。caller-lease推理入口保持原格式，由全局池选择企业，不增加客户端企业header。

兼容旧URL不等于兼容旧服务进程混跑。首次升级必须整体按新契约配对，详见迁移方案。

## 8. Console 范围

- 全局设置只保留一个idle目标、TTL和全局pause；cap总和只读。
- 企业表显示：名称/slug/状态、库存/cap、目标占比、实际库存占比、缺口、ready idle、leased/provisional、预热/修复、failed/disabled/cooling及阻塞原因。
- 名称目录容量单独显示，不冒充总cap余量；库存不是账单、比例不是流量配额，界面必须注明。
- Accounts/Leases/Events/Request Stats/Login Tasks/SSO Users及危险操作确认均明确企业归属；过滤、搜索、分页总数在服务端实现。
- 仍是全局平台管理员，不把企业下拉框当作RBAC。保留admins.json与单实例运维。
- DTO不包含Secret；共享包统一企业/池契约，禁止Console和Proxy各自演化出不一致字段。

## 9. 实现阶段与验收门槛

| 阶段 | 交付 | 阶段门槛 |
| --- | --- | --- |
| 1 设计与迁移方案 | 本文、迁移设计、算术验证记录 | 区分已确定规则与尚未实现能力；不修改运行数据 |
| 2 企业基础结构 | shared契约、企业注册/default映射、SQLite/MySQL归属约束和显式迁移工具 | 合成旧数据逐字段保真；未知/错企业fail closed；名称容量保持 |
| 3 SSO/Login流程 | 单SSO多profile、用户/会话/SCIM隔离、task与回调fence | 跨企业同名、错入口、错nonce、迟到回调、取消不确定性测试通过 |
| 4 调度与Console | 上述唯一cap比例算法、全局缺口、企业管理/过滤/解释 | 两存储一致、多Proxy不超cap、不双租、不跨企业失败重试；浏览器交互验证 |
| 5 隔离全栈/迁移演练 | mock外部系统、真实本地服务与专用DB、升级及恢复报告 | default保真、接入新企业、TTL回收、配置变更、停服恢复和外部失败矩阵 |
| 6 发布准备 | 固定SHA、镜像构建指引、实际迁移工具操作手册 | 用户单独授权commit/push、部署及任何真实外部操作 |

开发中基础结构先保持single-profile且预热暂停；在SSO/Login隔离和跨服务配置revision未全部通过前，不打开第二企业的实际操作。第二阶段保留SSO原用户名主键，完整复合键、跨企业同名及SAML/SCIM/会话隔离属于第三阶段，不能将第二阶段增加归属字段视为已经完成这些能力。

本轮验证重点是客户实际使用的Proxy MySQL与SSO/Login SQLite。Proxy SQLite保留已有兼容基础，但其结果不能替代真实MySQL迁移、事务和并发验收。

阶段5只使用隔离数据库和mock。真实GitHub EMU/SCIM、席位、模型及云资源操作需新的明确授权，不继承历史有限测试授权。

## 10. 本次核对的源码入口

- [MySQL库存、准入与补货](../src/proxy/src/userPool/mysqlStore.ts)
- [SQLite租约、schema及补货](../src/proxy/src/userPool/store.ts)
- [MySQL严格schema校验](../src/proxy/src/db/mysqlSchema.ts)
- [全局10000名称目录](../src/proxy/src/userPool/names.ts)
- [跨服务provisioner与恢复fence](../src/proxy/src/userPool/provisioner.ts)
- [SAML单例](../src/sso/src/saml/saml.ts)与[会话路由](../src/sso/src/routes/samlRoutes.ts)
- [SSO用户匹配与管理](../src/sso/src/users/service.ts)
- [Login任务API](../src/login/src/routes/tasksApi.ts)与[浏览器SSO地址校验](../src/login/src/auth/HeadlessPlaywrightAuthStrategy.ts)
- [Console内部转发](../src/console/src/server/apiProxy.ts)与[共享DTO](../src/packages/shared/src/contracts.ts)

这些链接描述基线约束，不表示相关文件已完成多企业修改。
