# User Pool 页面逐项说明与操作手册

更新：2026-09-11。对应Console左侧 **User pool** 页面，管理员登录后可见。本文使用“4个账号、2个已租出、2个idle、cap5、target2”的通用示例，不包含实际客户账号或key hash。

配套：[设计原理](user-pool-design.md) · [配置与API](user-pool-implementation.md) · [存量Docker升级](user-pool-upgrade-guide.md) · [真实测试过程](user-pool-real-e2e-validation.md)

## 1. 先看懂三个对象

| 对象 | 含义 | 示例 |
| --- | --- | --- |
| Caller | LiteLLM认证后的virtual key对应调用者 | `sha256:<64位hash>` |
| Account / member | 后端实际执行模型请求的GHCP账号 | 合成的姓名账号，拥有SSO/EMU/OAuth/席位 |
| Lease | caller暂时独占member的绑定 | provisional或active，带到期时间 |

**SSO用户名不是hash。** 同一个caller多个会话/请求复用同一租约，不同caller不能同时分到同一池成员。hash不是OAuth token，不授予访问权限；调用还需LiteLLM key认证和Proxy服务密钥。

## 2. 顶部 Default user pool

### Default user pool

本部署只有一个默认池，当前不按team、session或请求参数选择不同池。不是“匿名default账号”，也不是所有人共享一个GHCP身份。

标题旁的 `local` 是Console界面环境标记，**不是可靠的mock/真实环境检测**。本机Console也可能连接真实GitHub服务；操作前看部署配置，不凭这个标签判断是否收费或是否安全。

### Refresh every 10s

勾选后，页面可见且没有管理操作进行时，浏览器约每10秒重新读取概览。它只刷新界面：

- 不代表后台worker每10秒才运行；worker另有 `PREWARM_POLL_SECONDS` 和事件唤醒。
- 不建立或续期caller租约。
- 不意味着每10秒新建一个账号。
- 关闭浏览器后，已启动的worker仍继续运行，除非真正暂停/停止服务。

### Refresh

手动重新读取数据库/API快照。用于查看刚完成的操作或恢复网络错误后的页面。它不是强制重新授权、刷新OAuth token或创建新账号。

### Reconcile now

请求worker进行一次协调检查：回收可安全释放的到期租约、检查库存缺口、推进可执行的预热/修复阶段。它遵守pause、cap、并发、重试时间和在途请求保护。

- 点击成功表示已调度，不保证成员已经Ready。
- paused时不会绕过暂停去开户。
- 没有缺口时不创建账号。
- cap已满时不会强行创建第cap+1个。
- 快速连点不会合法地获得无限并发；任务以数据库和单owner调度器为准。

### Snapshot时间

表示本次显示的数据快照时间，按浏览器本地时区格式化，不是某个账号最后成功调用的时间。若加载失败，可能保留上一次成功快照并显示警告，控制按钮会禁用；先恢复连接再操作。

## 3. Attention needed 黄色提示

| 提示 | 原因 | 应如何判断 |
| --- | --- | --- |
| Prewarming is paused | 勾选暂停并保存 | 现有ready/租约可用，但新开通和自动OAuth修复不继续推进 |
| Low idle capacity | ready_idle低于target | 看是否有provisioning/retry、是否到cap；不是一定故障 |
| No ready idle accounts | 当前没有可立即分配成员 | 新caller可能429；有可用已有租约的caller不需要重新领取idle |
| Account cap reached | total达到/超过max_accounts | 先核对失败/禁用账号、旧席位和预算，不直接提高cap |

黄色提示是操作提示，不等于GitHub实时账单告警。空闲不足时也可能是正常的补池等待，真实登录可能耗时分钟级。

## 4. Account capacity 与七个数字

右上角 **`4 / 5 accounts · Idle target 2`**：

- 第一个4：当前pool inventory总量，含ready、在开通、失败、禁用等。
- 第二个5：池总量上限，不是企业购买席位数。
- target2：尽量维持2个现成idle作为备用，不是最多只能有2个idle。

| 指标 | 计数含义 | 示例值 |
| --- | --- | ---: |
| Ready idle | pool ready、凭据valid且已验证，无租约/在途hold，能立即分给新caller | 2 |
| Active leased | 已由完整成功推理激活的正式租约数 | 2 |
| Provisional | 首次领取后尚未成功升级的临时租约数 | 0 |
| Provisioning | 已登记待执行、正在执行、等待登录/验证的账号数 | 0 |
| Cooling | 暂时冷却的成员，例如上游429 | 0 |
| Failed | 开通、验证、凭据修复失败或被隔离的成员数 | 0 |
| Disabled | 管理员明确禁用的成员数 | 0 |

**不能简单把七个数字相加求总量。** leased/provisional是租约维度，其他多数为成员维度；例如一个成员可以仍有lease并同时cooling。请求排空期间disabled成员也可能仍关联lease。

### Idle账号占不占Copilot seat？

**占。**它已经完成席位分配和登录，只是还没租给caller。leased变idle不会退席位；lease到期或release也不代表Copilot席位取消。

### 为什么target2却可能有4个idle？

先有2个idle，两个caller租走后后台再补2个，总量4。后来旧租约到期，原2个回到idle，空闲就变4。系统不为了降到target2自动删除账号或退席位。

### Pool总量能代表企业总seat吗？

不能。旧池外账号和pending cancellation席位不计入这张pool库存。例：pool4个成员，企业还可能保留6条旧待取消记录，API总记录为10。**计费是否复用由真实策略/账单确定，不能从本页面减出免费额度。**

## 5. Pool settings

### Ready idle target

低水位目标N。worker大致按以下条件登记缺口：

```text
缺口 = max(0, target - ready_idle - 已登记provisioning - 可自动重试的failed)
```

还受cap和命名目录容量约束。等待登录的账号、已排队任务和退避中的可修复成员避免重复计入缺口。

示例：N50、idle30、没有在途任务，预算/cap允许时登记20个候选，再按并发上限推进；不是只补1个，也不是启动20个浏览器。

### Maximum accounts

池inventory硬上限1–10000。失败/禁用成员也占额度，旧池外用户不计入。降低cap不会删除成员或取消已经登记的开通，可能暂时显示 `total > cap`；只阻止继续增长，现有队列的处理看pause状态。

提高cap**不是增加GitHub购买额度**，也不自动知道旧用户席位可否复用。先确认管理员授权和预算。

### Lease TTL (seconds)

正式租约有效期，范围60–2592000秒，默认172800秒=48小时。

- 首次请求领取默认5分钟临时租约；这5分钟由另一个环境变量配置，不是此输入框。
- 完整成功模型调用立即升级/续租，到期时间为本次成功时间+当前正式TTL。
- 失败、断流、模型列表和token counting不续租。
- 修改TTL作用于后续成功续租，不会立刻批量重写所有已有lease到期时间。
- 到期仍有在途hold时先排空，不能把正在使用的账号分给别人。
- **不是OAuth token的有效期**，不会延长GitHub凭据寿命。

### Pause prewarming

勾选后要点击Save and apply才生效。

暂停的是worker后续开通和修复调度，不是caller流量。现有ready成员和有效租约仍可使用；已被外部接受的SSO/Login操作可能完成当前步骤，不应将pause当作撤销所有远程操作。

暂停时，失效token的后台自动重新登录也会延后；不要误以为只停新建、不停修复。最终测试结束后保持暂停，可避免后台继续增加真实账号。

### Editing version

设置的乐观锁版本号，不是软件版本或Git commit。

多人同时修改时，后提交者若基于旧version会得到冲突，当前页面保留草稿并要求刷新审阅，不应盲目覆盖。

### Save and apply

保存target/cap/TTL/pause到Proxy SQLite，随后触发一次worker检查。不需要重启。

灰色的常见原因：没有未保存改动、正在保存/操作、池未启用或数据读取错误。不能只看“有灰色按钮”就判断配置已失败。

### Reload latest settings

把草稿替换成最近读取的服务器设置，丢弃本地尚未保存的改动。发生version冲突时先Refresh，再用它载入最新值，重新决定要改什么。

## 6. Accounts标签：逐列说明

| 列 | 展示内容 | 不要误解成 |
| --- | --- | --- |
| Account | pool成员identity，下方是GH login | 终端用户virtual key或邮箱 |
| State / stage | 综合显示的账号/租约状态；内部阶段；OAuth状态 | 一种状态可以概括所有维度 |
| Caller key hash | 当前承租caller的缩略hash、phase、到期时间 | OAuth token、原始virtual key或累计请求数 |
| Requests | **当前在途请求hold数**，包括相关catalog hold | 历史总请求数、RPM、在线用户数 |
| Recovery / verification | 最近错误、失败attempts、冷却/重试时间、verified/updated | 真实账单和外部实时健康保证 |
| Actions | Disable / Retry / Resume等 | 删除用户/退还席位 |

### State / stage的具体含义

- `Active leased` / `Provisional`：底层成员ready，但存在相应lease。
- `Ready idle`：成员当前可分配。
- `Catalog request`：成员ready、无推理lease，但有模型发现/计数请求hold。
- `Stage: ready · OAuth: valid`：上次验证成功且本地token状态valid；上游仍可能稍后撤销它，不代表永不过期。
- `new`、`sso-creating`、`scim-syncing`、`seat-assigning`、`oauth-starting`、`oauth-dispatch`、`oauth-wait`、`warmup`：用于分段执行和崩溃恢复，不是要求管理员逐个点击。

### Caller key hash红框如何读

```text
sha256:abcd1234…89ef5678
active · expires <日期时间>
```

只是显示缩略，完整值仍存于租约；鼠标悬停可查看完整值。新版在hash旁提供唯一的**无边框复制图标**：悬停或键盘聚焦时提示 `Copy hash`，点击成功后提示 `Copied`，约2秒后自动消失，不保留常驻提示文字或增加行高。复制不带 `sha256:` 的完整64位小写hash，便于在LiteLLM定位对应key，不会复制省略号。Accounts、Leases、Recent events和释放确认框使用相同功能。

页面文字本身保留完整caller ID，只通过CSS缩略显示，因此选中该文字手动复制可取得包含 `sha256:` 的完整71位值。自动剪贴板不可用或权限被拒绝时，会展示并选中完整64位hash的只读输入框，供手动复制；不会误报复制成功。非法或缺失hash不显示复制按钮。

不要截图公开完整hash，它虽不是明文密钥，但可长期关联用户。此修复只涉及Console，无需改Proxy或数据库；旧Console镜像需更新才会出现按钮。

- `Not leased`：当前没有推理lease。
- `Hash unavailable`：存在lease关联但API没有提供合规hash，需排障；不要填默认身份代替。
- key已经在LiteLLM撤销，Proxy租约也可能继续显示；两个系统的撤销不是联动删除。需等TTL或手动release。

### Attempts / Retry eligible after

Attempts是当前开通/修复失败计数，不是总Login次数。到达重试上限、终止错误或需要人工核对的状态，即使重试时间已过也不会自动重试。**`Retry eligible after`只展示时间门槛，不保证届时一定重试。**

- `upstream_unauthorized`：401已使旧token失效并可能排入自动修复。
- `oauth_reauth_limit_reached`：每账号固定小时窗口的自动恢复次数超限，需人工调查。
- `sso_name_conflict` / `sso_creation_ambiguous` / `oauth_dispatch_ambiguous` / `oauth_task_cancelled_unconfirmed`：涉及所有权或外部执行不确定性，不能通过频繁Retry绕过。
- `Verified`为空可能表示未完成warmup或凭据更换后需要重新验证。
- `Updated`是该成员本地状态最后更新时间，不是该用户最近一次成功推理时间；后者看Leases/Request Stats。

## 7. 三种成员操作

### Disable

点击后有确认对话框。禁止新请求使用该成员，已有请求可能继续结束；迟到的成功不能重新启用它。**不删除SSO/EMU、token或席位，也不降低GitHub账单。**

### Retry

对Failed成员发起重新验证/修复。有在途请求时不能执行；某些不确定结果会返回 `manual_reconciliation_required`，需要先确认外部任务和账号所有权。不要为了“清红灯”反复重试。

运行期401已有后台自动修复，所以普通首次401不必立刻人工Retry；但paused、超限或永久权限/密码故障不会被无限自动处理。

### Resume

仅对Disabled成员显示。恢复后先进入预热/验证，不直接变Ready；有请求hold时阻止。它不是GitHub账号的“解除suspended”，更不是重新购买或取消席位。

## 8. Leases标签与Release

显示caller hash、成员/lease ID、phase、assigned time、last success、expires和Release。

- **Assigned**：本次租约何时建立。
- **Last success**：最近一次符合续租条件的完整成功推理。
- **Expires**：当前到期时间，按浏览器本地时区显示。
- **Requests in flight**：关联请求尚未结束，Release禁用/服务端拒绝。
- **Release**：确认后删除当前绑定，后续请求可能领取不同成员；不撤销LiteLLM key、不退席位。

Release只适合明确不再需要保留的租约。即使按钮可点，也意味着你可能改变该caller后续账号归属；不要把它当成无副作用的Refresh。

## 9. Recent events标签

用于解释“为什么这个账号/租约变了”，不是完整上游响应日志。

常见事件：

| 事件 | 含义 |
| --- | --- |
| name_reserved | 预占新候选，可能还没创建GitHub用户 |
| account_ready | 所有开通及warmup完成 |
| lease_acquired | 新caller领取成员 |
| lease_renewed | 成功推理激活/续租 |
| lease_expired / lease_released | 到期回收 / 手动释放 |
| request_finished | 本次请求结束；success或not_renewed不是全部上下文 |
| provision_failed | 开通或修复阶段失败 |
| oauth_reauth_scheduled / oauth_reauth_blocked | 自动重新授权安排 / 超限停止 |
| member_cooling / member_disabled / member_retry | 冷却 / 禁用 / 管理员重试 |
| settings_updated | 配置已保存 |

事件detail会被限制为安全代码，不展示原始token、密码或任意远端错误body。`details_redacted`不表示错误消失，只表示该细节未直接展示。

## 10. 搜索、筛选、分页和上限

- Accounts：按account、GH login、caller hash筛选；状态下拉按页面综合状态过滤。
- Leases：按成员、hash或lease ID检索，状态为active/provisional。
- Events：按动作、成员、hash、lease或detail检索，不提供状态下拉。
- 每页25行，Previous/Next只在已加载记录中分页。
- API当前最多返回1000成员、1000租约、200近期事件。`Showing the first…`提示覆盖范围，不是服务端全库搜索。
- “搜索不到”不代表数据库/企业没有该账号，先看加载上限和是否属于旧池外账号。

## 11. 不在这页调整的参数

| 参数 | 去哪里改 |
| --- | --- |
| Pool账号邮箱域 | 首次初始化前设置 `POOL_ACCOUNT_EMAIL_DOMAIN`；初始化后固定，即使target为0且没有成员也不能直接修改 |
| Warmup模型 | 修改Proxy的 `POOL_WARMUP_MODEL`，重新创建容器以应用新环境 |
| 临时租约TTL | `PROVISIONAL_LEASE_TTL_SECONDS` |
| Proxy预热并发 | `PREWARM_CONCURRENCY`，默认5，允许1–20 |
| Worker保底轮询 | `PREWARM_POLL_SECONDS` |
| Login浏览器任务并发 | Console → Settings → Login concurrency，默认1、上限20，动态生效 |
| SCIM pacing/retry和SSO总用户上限 | Console → Settings → SSO runtime settings |
| 企业全部seat/账单 | GitHub企业Copilot/Billing页面及相关API |
| 完整模型请求历史 | Request Stats（受保留量限制），LiteLLM SpendLogs |

若误改已初始化池的邮箱域，Proxy会因与数据库记录不一致而拒绝启动。恢复原域名值并重新创建Proxy；不要删除卷或手工修改pool表来绕过检查。

## 12. 常见操作流程

### 新环境第一次开池

先确保target0、cap1、未接收真实caller流量；检查域名、模型、SSO、SCIM、席位、网络及预算。SSO剩余用户容量必须足够，保留的旧用户也计入其总用户上限，pool cap不替代该检查。保存target1、解除暂停，观察一个普通账号到Ready。验证一把业务key成功后，才考虑扩大规模。

### 调高idle目标

先确认cap和企业席位预算，再修改target并保存。若paused，保存不会开通；需要明确解除暂停。有缺口时可立即登记多个provisioning，实际浏览器并发以Login设置为准。

### 测试后停止增长

勾选Pause prewarming并保存。它不退出登录、不停止已租用户、不退席位。需要彻底停止调用时，还要管理LiteLLM key/流量入口；不要通过删除SSO用户临时断流。

### 看到 Failed

先读stage/error/attempts，看是否paused、仍有在途请求、token恢复次数超限或SSO/SCIM身份冲突。确认失败原因后决定Retry，不提高cap来掩盖全部失败。

### 老的导入、SSO编辑/删除为什么被拒绝

caller-lease模式拒绝OAuth CSV导入，pool成员不能通过旧独立reauthorize操作并行开启登录。新SSO标记的pool用户也禁止普通入口改密码/email/role、普通Sync GH login、删SSO/EMU、暂停EMU或移除席位；同步仅允许受控create-only的普通user角色。Login任务的独立Retry对pool成员拒绝，尚被pool等待/恢复阶段引用的终态任务不可删除；worker消费结果进入warmup/ready后可清理旧任务。Login无法向配对Proxy确认时拒绝删除/重试，不以丢失恢复证据为代价清空历史。使用pool的Disable/Retry/Resume；这些保护不是完整退池删除工具。非pool用户的破坏性操作还需配对Proxy确认ownership，核对不可用会拒绝，不能通过绕过校验继续删除。

### 老客户升级后找不到旧账号

本页只列已纳入pool inventory的成员。旧SSO/Proxy账号仍可能保留在原页面，但不会自动变成pool成员，也不自动复用旧席位。先按[升级手册](user-pool-upgrade-guide.md)判断是正常边界还是挂错了数据库卷。

**最后提醒：本页的正常绿色/Ready只证明当前本地状态和最近验证结果，不证明整个企业席位额度、所有模型权限、长期token有效性或最终计费均已确认。**
