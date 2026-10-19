# User Pool 页面逐项说明与操作手册

更新：2026-10-19，对应多企业版本线（镜像 tag `multi-*`）。账号池在Console中分为两个页面，管理员登录后可见：

- **Pool overview**（全局）：全局池设置、所有企业的汇总，以及每个企业的cap、生命周期和就绪状态。
- **Pool members**（按企业）：页头所选企业的成员、租约和事件。

本文使用“4个账号、2个已租出、2个idle、cap5、target2”的通用示例，企业名使用 `default`、`contoso-ghe` 等占位值，不包含实际客户账号或key hash。只有一个企业（`default`）时，所有说明同样适用，只是企业表只有一行。

配套：[设计原理](user-pool-design.md) · [配置与API](user-pool-implementation.md) · [存量Docker升级](user-pool-upgrade-guide.md) · [真实测试过程](user-pool-real-e2e-validation.md) · [仅升级Console：完整hash复制](user-pool-console-upgrade-guide.md) · [HTTP错误详情与定位](user-pool-http-error-details.md) · [多企业registry配置](multi-enterprise-registry.md) · [多企业版升级](multi-enterprise-upgrade-guide.md)

## 1. 先看懂三个对象

| 对象 | 含义 | 示例 |
| --- | --- | --- |
| Caller | LiteLLM认证后的virtual key对应调用者 | `sha256:<64位hash>` |
| Account / member | 后端实际执行模型请求的GHCP账号，属于且只属于一个企业 | 合成的姓名账号，拥有SSO/EMU/OAuth/席位 |
| Lease | caller暂时独占member的绑定 | provisional或active，带到期时间 |

**SSO用户名不是hash。** 同一个caller多个会话/请求复用同一租约，不同caller不能同时分到同一池成员。hash不是OAuth token，不授予访问权限；调用还需LiteLLM key认证和Proxy服务密钥。caller不指定企业：首次领取时由调度选择企业，之后保持在原企业和原成员上（见第5.3节）。

## 2. 企业选择器与页面作用域

页头的 **Enterprise** 选择器决定企业作用域页面显示哪个企业。每项显示 `显示名 · GitHub主机（github.com 或 xxx.ghe.com） · 状态`，状态为池生命周期（`draft` / `active` / `draining`），直连模式显示 `direct`。

| 类型 | 页面 | 说明 |
| --- | --- | --- |
| 全局 | Dashboard、Pool overview、Error Diagnostics | 不显示选择器，一次展示所有企业 |
| 企业作用域 | SSO Users、AI Credits Usage、Request Stats、Proxy Accounts、Models、Pool members、Login Tasks | 只显示和操作所选企业的数据 |
| 混合 | Settings、Diagnostics | Settings 中 SSO 运行时设置按企业，Login 运行时设置和管理员密码为全局；Diagnostics 检查企业列表和所选企业的各服务接口 |

- 所选企业保存在URL hash中（`#/<page>?e=<enterpriseId>`），刷新、复制链接后不丢失。hash中没有企业时界面默认选 `default`，但每个请求都显式带企业ID，服务端不会替你回落到 `default`。
- 切换企业会重新加载页面：进行中的读取被取消，迟到的结果被丢弃；列表筛选、选择和未保存的草稿属于原企业，不会带到新企业。
- hash中的企业不在Proxy的企业列表中时，作用域页面显示 `Enterprise "<id>" is not configured in Proxy. Choose an enterprise.`，不会改为显示其他企业。企业列表暂时读取失败时，页头显示警告，作用域页面仍按所选ID请求。
- 危险操作的确认框会显示 `Enterprise <id> (slug <slug>).`，确认前核对企业。
- **选择器不是权限边界**：所有Console管理员都能管理所有企业。

标题旁的 `local` 是Console界面环境标记，**不是可靠的mock/真实环境检测**。本机Console也可能连接真实GitHub服务；操作前看部署配置，不凭这个标签判断是否收费或是否安全。

### Console写操作的同源校验

Console的所有写操作（保存设置、改cap、激活、禁用、释放等）只接受来自Console本身页面的请求：跨站请求、`Origin: null` 或 `Sec-Fetch-Site: cross-site` 返回 403 `cross_site_request_rejected`。Console前面有会改写 `Host` 头的反向代理时，设置 `CONSOLE_PUBLIC_BASE_URL` 为用户在浏览器中访问的Console地址（例如 `https://console.example.com`），否则正常操作也可能被拒绝。不带 `Origin` 的非浏览器客户端仍可调用。

## 3. Dashboard：每个企业一张卡片

Dashboard是全局页面，每个企业一张卡片：

| 内容 | 含义 |
| --- | --- |
| 显示名、`id · GitHub主机` | 企业身份 |
| 状态徽章 | 池生命周期（`draft` / `active` / `draining`），直连模式为 `direct` |
| 就绪徽章 | `ready`；`not ready`（悬停显示阻塞项）；`readiness unknown`（本次未能完成三方比对） |
| Proxy accounts / SSO users / Failed tasks | 该企业的Proxy账号数、SSO用户数、失败的Login任务数；某个服务读取失败时显示 `Unavailable` |
| Pool inventory / cap | 该企业已登记的池成员数 / 该企业cap；非池模式显示 `-` |
| Accounts / Failed tasks / Failed requests | 跳到该企业的对应页面，并带上筛选条件 |

Refresh dashboard只重新读取，不触发补池或重新授权。

## 4. Pool overview（全局）

### 4.1 页头：Refresh、Reconcile now与汇总

页头显示所有企业合计的 `All enterprises: <total> accounts, <ready idle> ready idle, <leased> leased. Snapshot <时间>.`

**Refresh**：手动重新读取全局设置、汇总和企业表。它不是强制重新授权、刷新OAuth token或创建新账号。

**Reconcile now**：请求worker进行一次协调检查：回收可安全释放的到期租约、检查库存缺口、推进可执行的预热/修复阶段。它遵守pause、各企业cap与生命周期、并发、重试时间和在途请求保护。

- 点击成功表示已调度，不保证成员已经Ready。
- paused时不会绕过暂停去开户。
- 没有缺口时不创建账号。
- 某企业已达到cap、或不是 `active` 时，不会为它创建账号。
- 快速连点不会合法地获得无限并发；任务以数据库和单owner调度器为准。

**Snapshot时间**表示本次显示的数据快照时间，按浏览器本地时区格式化，不是某个账号最后成功调用的时间。

直连模式（`ACCOUNT_ROUTING_MODE=direct`）下页面显示 **User pool is disabled**，设置和企业操作不可用。

### 4.2 Attention needed 黄色提示

提示针对**整个池**（所有企业合计）：

| 提示 | 原因 | 应如何判断 |
| --- | --- | --- |
| Prewarming is paused | 勾选暂停并保存 | 现有ready/租约可用，但新开通和自动OAuth修复不继续推进 |
| Low idle capacity | 合计ready_idle低于target | 看是否有provisioning/retry、各企业是否到cap、是否没有 `active` 企业；不是一定故障 |
| No ready idle accounts | 当前没有可立即分配成员 | 新caller可能429；有可用已有租约的caller不需要重新领取idle |

各企业是否到cap在企业表的 **Inventory / cap** 列查看（单企业版的 Account cap reached 提示已移到企业表）。黄色提示是操作提示，不等于GitHub实时账单告警。空闲不足时也可能是正常的补池等待，真实登录可能耗时分钟级。

### 4.3 Global pool settings

所有企业共用的设置。**账号cap不在这里，按企业在企业表中设置。**

#### Ready idle target

全局低水位目标N（0–10000）。worker大致按以下条件登记缺口：

```text
缺口 = max(0, target - ready_idle - 已登记provisioning - 可自动重试的failed)
```

上式各项都是**所有企业合计**。缺口再按第5.3节的规则逐个分给 `active` 且未到cap的企业，并受命名目录容量约束。等待登录的账号、已排队任务和退避中的可修复成员避免重复计入缺口。

示例：N50、idle30、没有在途任务，预算/cap允许时登记20个候选，再按并发上限推进；不是只补1个，也不是启动20个浏览器。

#### Lease TTL (seconds)

正式租约有效期，范围60–2592000秒，默认172800秒=48小时。

- 首次请求领取默认5分钟临时租约；这5分钟由另一个环境变量配置，不是此输入框。
- 完整成功模型调用立即升级/续租，到期时间为本次成功时间+当前正式TTL。
- 失败、断流、模型列表和token counting不续租。
- 修改TTL作用于后续成功续租，不会立刻批量重写所有已有lease到期时间。
- 到期仍有在途hold时先排空，不能把正在使用的账号分给别人。
- **不是OAuth token的有效期**，不会延长GitHub凭据寿命。

#### Pause prewarming

勾选后要点击Save and apply才生效，作用于所有企业。

暂停的是worker后续开通和修复调度，不是caller流量。现有ready成员和有效租约仍可使用；已被外部接受的SSO/Login操作可能完成当前步骤，不应将pause当作撤销所有远程操作。

暂停时，失效token的后台自动重新登录也会延后；不要误以为只停新建、不停修复。最终测试结束后保持暂停，可避免后台继续增加真实账号。只想停掉某一个企业时用该企业的 **Drain**（第4.4节），不要用全局暂停。

#### Editing version

设置的乐观锁版本号，不是软件版本或Git commit。

多人同时修改时，后提交者若基于旧version会得到冲突，当前页面保留草稿并要求刷新审阅，不应盲目覆盖。

#### Save and apply

保存target/TTL/pause到Proxy数据库（SQLite或MySQL），随后触发一次worker检查。不需要重启。

灰色的常见原因：没有未保存改动、正在保存/操作、池未启用或数据读取错误。不能只看“有灰色按钮”就判断配置已失败。

#### Reload latest settings

把草稿替换成最近读取的服务器设置，丢弃本地尚未保存的改动。发生version冲突时先Refresh，再用它载入最新值，重新决定要改什么。

### 4.4 Enterprises：企业表

表上方显示命名目录剩余容量：`Name catalog: <剩余> of 10,000 names remain for cap increases across all enterprises.` 所有企业共用一个账号名目录，**所有企业cap之和不能超过10,000**。

| 列 | 含义 | 不要误解成 |
| --- | --- | --- |
| Enterprise | 显示名，下方 `id · GitHub主机` | GitHub slug（slug在操作对话框中显示） |
| State | `draft` / `active` / `draining`；直连模式或没有池策略时显示 `no pool policy` | 就绪状态 |
| Inventory / cap | 该企业已登记的池成员总数（含开通中、失败、禁用）/ 该企业cap | 企业购买的席位数、账单数量 |
| Target share | 该企业cap占所有 `active` 企业cap之和的比例 | 流量配额 |
| Actual share | 该企业库存占所有 `active` 企业库存之和的比例 | 请求量或计费占比 |
| Score | 调度分数（第5.3节），只对 `active` 企业显示；越大越优先补货 | 健康评分 |
| Ready idle / Leased | 该企业当前可分配成员数 / 正式租约数 | — |
| Provisioning | 该企业正在开通（provisioning）的成员数 | 在途推理请求数 |
| Failed / disabled | 该企业失败 / 管理员禁用的成员数 | — |
| Blockers | Proxy、SSO、Login三方对该企业配置的比对结果：`None` 表示就绪；列出阻塞项代码；`Readiness unknown` 表示本次未能在时限内完成比对 | 账号级错误 |
| Actions | Edit cap，以及按状态出现的 Activate / Drain / Resume | 删除企业 |

**库存不等于账单，占比不等于流量配额。** Target / Actual share只决定新账号补给哪个企业。

阻塞项含义和处理见 [registry配置参考](multi-enterprise-registry.md) 第6节，常见的有 `proxy:enterprise_field_missing:pool.accountDomain`、`sso:enterprise_secret_unconfigured:sso.signingKey`、`sso_missing` / `login_missing`（该服务还没加载这个企业，通常是没重启）、`*_mismatch`（三个服务挂载了不同版本的registry）。

#### Edit cap

修改该企业的账号上限（1到“当前cap+剩余名额”）。

- 对话框显示企业ID、slug、名称、GitHub主机，以及正在编辑的策略版本（CAS）。别人先改过时保存失败并提示 `The pool policy changed in another session`，草稿保留；点 **Reload latest policy** 载入最新值再决定。
- 降低cap**不删除成员**、不取消已登记的开通，可能暂时显示库存大于cap；只阻止该企业继续增长。
- 提高cap**不是增加GitHub购买额度**，也不自动知道旧用户席位可否复用。先确认该企业的管理员授权、席位和预算。
- 超过命名目录容量返回 409 `name_capacity_exceeded`。

#### Activate / Drain / Resume

| 操作 | 出现条件 | 效果 |
| --- | --- | --- |
| Activate | `draft` | 变为 `active`，开始为该企业补货并给新caller分配其成员 |
| Drain | `active` | 变为 `draining`：不新建租约和catalog hold、不补货；**已有租约保留**直到释放或到期；已在开通中的成员继续完成；不删除任何东西 |
| Resume | `draining` | 恢复为 `active` |

- Activate和Resume的对话框先显示上一次三方readiness明细（proxy / sso / login 各自是否已配置及阻塞项）。确认后Proxy会**实时**重新比对，未就绪时不修改，返回 409 `enterprise_not_ready` 并在对话框列出阻塞项。
- `draft` 不能直接Drain，任何状态都不能回到 `draft`。
- 落在 `draining` 企业、只有catalog hold的caller会收到 503 `enterprise_draining`，不会被换到其他企业。
- 开通过账号的企业不能从registry移除（服务会启动失败）；不再使用时用Drain，必要时把cap调到最小。

新企业加入registry并重启Proxy、SSO、Login后，初始状态为 `draft`、cap默认10。按 [registry配置参考](multi-enterprise-registry.md) 第9节逐项清除阻塞项后，再设置cap并Activate。

## 5. Pool members（按企业）

页面标题为 `Pool members of <企业名>`，只显示所选企业的成员、租约和事件。cap、生命周期和全局设置在Pool overview。

### 5.1 Refresh every 10s与Refresh

勾选 **Refresh every 10s** 后，页面可见且没有管理操作进行时，浏览器约每10秒重新读取。它只刷新界面：

- 不代表后台worker每10秒才运行；worker另有 `PREWARM_POLL_SECONDS` 和事件唤醒。
- 不建立或续期caller租约。
- 不意味着每10秒新建一个账号。
- 关闭浏览器后，已启动的worker仍继续运行，除非真正暂停/停止服务。

**Refresh** 手动重新读取。若加载失败，可能保留上一次成功快照并显示警告，控制按钮会禁用；先恢复连接再操作。

### 5.2 Account capacity与七个数字

顶部 **`<N> accounts in this enterprise`** 是该企业当前pool inventory总量，含ready、在开通、失败、禁用等。该企业的cap和全局target在Pool overview查看。

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

#### Idle账号占不占Copilot seat？

**占。**它已经在所属企业完成席位分配和登录，只是还没租给caller。leased变idle不会退席位；lease到期或release也不代表Copilot席位取消。

#### 为什么target2却可能有4个idle？

先有2个idle，两个caller租走后后台再补2个，总量4。后来旧租约到期，原2个回到idle，空闲就变4。系统不为了降到target2自动删除账号或退席位。

#### Pool总量能代表企业总seat吗？

不能。旧池外账号和pending cancellation席位不计入这张pool库存。例：pool4个成员，企业还可能保留6条旧待取消记录，API总记录为10。**计费是否复用由真实策略/账单确定，不能从本页面减出免费额度。**

### 5.3 caller落在哪个企业

调度只在 `active` 企业之间进行，规则对所有存储（SQLite、MySQL）相同：

- **补货**：全局缺口逐个分给分数最高、且库存未到cap的 `active` 企业。分数 `S = N × C_e − C × N_e`（`C`、`N` 为所有 `active` 企业的cap之和与库存之和），即“按cap比例还差多少”；结果是各企业库存逐渐接近cap比例。
- **新caller领取**：在有合格idle成员的 `active` 企业中按同样的比例选择；分数相同时按caller hash稳定排序。
- **已有租约或catalog hold的caller**：保持原企业和原成员，不重新按比例选择。
- 暂时未就绪的企业不会被选中，但仍计入比例分母。

所以库存占比只反映账号分布，不等于每个企业实际承担的流量或账单。

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

只是显示缩略，完整值仍存于租约；鼠标悬停可查看完整值。hash旁有唯一的**无边框复制图标**：悬停或键盘聚焦时提示 `Copy hash`，点击成功后提示 `Copied`，约2秒后自动消失，不保留常驻提示文字或增加行高。复制不带 `sha256:` 的完整64位小写hash，便于在LiteLLM定位对应key，不会复制省略号。Accounts、Leases、Recent events和释放确认框使用相同功能。

页面文字本身保留完整caller ID，只通过CSS缩略显示，因此选中该文字手动复制可取得包含 `sha256:` 的完整71位值。自动剪贴板不可用或权限被拒绝时，会展示并选中完整64位hash的只读输入框，供手动复制；不会误报复制成功。非法或缺失hash不显示复制按钮。

不要截图公开完整hash，它虽不是明文密钥，但可长期关联用户。

- `Not leased`：当前没有推理lease。
- `Hash unavailable`：存在lease关联但API没有提供合规hash，需排障；不要填默认身份代替。
- key已经在LiteLLM撤销，Proxy租约也可能继续显示；两个系统的撤销不是联动删除。需等TTL或手动release。

### Attempts / Retry eligible after

Attempts是当前开通/修复失败计数，不是总Login次数。到达重试上限、终止错误或需要人工核对的状态，即使重试时间已过也不会自动重试。**`Retry eligible after`只展示时间门槛，不保证届时一定重试。**

- `upstream_unauthorized`：401已使旧token失效并可能排入自动修复。
- `oauth_reauth_limit_reached`：每账号固定小时窗口的自动恢复次数超限，需人工调查。
- `sso_name_conflict` / `sso_creation_ambiguous` / `oauth_dispatch_ambiguous` / `oauth_task_cancelled_unconfirmed`：涉及所有权或外部执行不确定性，不能通过频繁Retry绕过。
- `enterprise_not_ready` / `enterprise_not_found`：成员所属企业当前未就绪或不在registry中；先在Pool overview处理该企业的阻塞项。
- `Verified`为空可能表示未完成warmup或凭据更换后需要重新验证。
- `Updated`是该成员本地状态最后更新时间，不是该用户最近一次成功推理时间；后者看Leases/Request Stats。

## 7. 三种成员操作

操作只作用于所选企业的成员；用另一企业的路径操作该成员会得到“未找到”，不会误改。

### Disable

点击后有确认对话框（显示企业ID和slug）。禁止新请求使用该成员，已有请求可能继续结束；迟到的成功不能重新启用它。**不删除SSO/EMU、token或席位，也不降低GitHub账单。**

### Retry

对Failed成员发起重新验证/修复。有在途请求时不能执行；某些不确定结果会返回 `manual_reconciliation_required`，需要先确认外部任务和账号所有权。不要为了“清红灯”反复重试。

运行期401已有后台自动修复，所以普通首次401不必立刻人工Retry；但paused、超限或永久权限/密码故障不会被无限自动处理。

### Resume

仅对Disabled成员显示。恢复后先进入预热/验证，不直接变Ready；有请求hold时阻止。它不是GitHub账号的“解除suspended”，更不是重新购买或取消席位；也不是企业级的Resume（企业级在Pool overview）。

## 8. Leases标签与Release

显示caller hash、成员/lease ID、phase、assigned time、last success、expires和Release。

- **Assigned**：本次租约何时建立。
- **Last success**：最近一次符合续租条件的完整成功推理。
- **Expires**：当前到期时间，按浏览器本地时区显示。
- **Requests in flight**：关联请求尚未结束，Release禁用/服务端拒绝。
- **Release**：确认后删除当前绑定，后续请求可能领取不同成员，**也可能落到另一个企业**；不撤销LiteLLM key、不退席位。

Release只适合明确不再需要保留的租约。即使按钮可点，也意味着你可能改变该caller后续账号归属；不要把它当成无副作用的Refresh。

## 9. Recent events标签

用于解释“为什么这个账号/租约变了”，不是完整上游响应日志。只显示所选企业的事件。

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
| settings_updated | 全局设置已保存 |
| enterprise_policy_updated | 该企业的cap或生命周期已修改 |
| enterprise_inventory_drift | 启动或每小时校正时发现该企业库存计数与实际成员数不一致，已按实际值修正 |

事件detail会被限制为安全代码，不展示原始token、密码或任意远端错误body。`details_redacted`不表示错误消失，只表示该细节未直接展示。

## 10. 搜索、筛选和分页

- Accounts：按account、GH login、caller hash检索；状态下拉按页面综合状态过滤。
- Leases：按成员、hash或lease ID检索，状态为active/provisional。
- Events：按动作、成员、hash、lease或detail检索，不提供状态下拉。
- 搜索和筛选在服务端执行，范围是所选企业中仍保留的记录；每页25行，用Previous/Next翻页。
- “搜索不到”先确认页头选的是不是该成员所属企业，再看是否属于旧池外账号。

## 11. 不在这页调整的参数

| 参数 | 去哪里改 |
| --- | --- |
| 企业cap、生命周期 | Pool overview → Enterprises（Edit cap / Activate / Drain / Resume） |
| Pool账号邮箱域 | 按企业：registry的 `pool.accountDomain`；`default` 可用 `POOL_ACCOUNT_EMAIL_DOMAIN`。该企业有池成员后固定，不能修改 |
| 新企业的初始cap | registry的 `pool.initialMaxAccounts`（只在首次登记该企业时使用）；之后在企业表修改 |
| Warmup模型 | 修改Proxy的 `POOL_WARMUP_MODEL`，重新创建容器以应用新环境 |
| 临时租约TTL | `PROVISIONAL_LEASE_TTL_SECONDS` |
| Proxy预热并发 | `PREWARM_CONCURRENCY`，默认5，允许1–20 |
| Worker保底轮询 | `PREWARM_POLL_SECONDS` |
| Login浏览器任务并发 | Console → Settings → Login runtime settings（全局，所有企业共用一个Login队列），默认1、上限20，动态生效 |
| SCIM pacing/retry和SSO总用户上限 | Console → Settings → SSO runtime settings（按所选企业） |
| Models管理员 | registry的 `modelsAdmin`；`default` 可用 `MODELS_ADMIN_*` 环境变量，见 [Models使用指南](models-admin-guide.md) |
| 企业全部seat/账单 | 各企业的GitHub Copilot/Billing页面及相关API |
| 完整模型请求历史 | Request Stats（按企业，受保留量限制），LiteLLM SpendLogs |

若误改已有池成员企业的邮箱域（或 `id`、`github.baseUrl`、`github.shortcode`），Proxy会以 `enterprise_identity_changed` 拒绝启动。恢复原值并重新创建Proxy；不要删除卷或手工修改pool表来绕过检查。

## 12. 常见操作流程

### 新环境第一次开池（或新企业第一次开池）

先确保全局target0（或保持暂停）、该企业cap1、未接收真实caller流量；检查该企业的域名、模型、SSO、SCIM、席位、网络及预算。SSO剩余用户容量必须足够，保留的旧用户也计入其总用户上限，pool cap不替代该检查。新企业在Pool overview清除阻塞项并Activate；然后保存target1、解除暂停，观察一个普通账号到Ready。验证一把业务key成功后，才考虑扩大规模。

有其他 `active` 企业时，新企业Activate后会按cap比例优先补货，但新caller的分配仍取决于各企业是否有ready idle成员。GHE.com企业目前只在mock环境验证过，首次接入真实GHE.com请先在预发布环境完成上述步骤。

### 调高idle目标

先确认各 `active` 企业的cap和席位预算，再修改target并保存。若paused，保存不会开通；需要明确解除暂停。有缺口时可立即登记多个provisioning，实际浏览器并发以Login设置为准。

### 停用一个企业

在企业表对该企业Drain。已有租约继续服务到释放或到期；不补货、不分配新caller。需要彻底停止该企业的调用时，还要处理已有租约（Pool members → Leases → Release，或等待TTL）。

### 测试后停止增长

勾选Pause prewarming并保存（全局）。它不退出登录、不停止已租用户、不退席位。需要彻底停止调用时，还要管理LiteLLM key/流量入口；不要通过删除SSO用户临时断流。

### 看到 Failed

先读stage/error/attempts，看是否paused、仍有在途请求、token恢复次数超限、SSO/SCIM身份冲突或企业未就绪。确认失败原因后决定Retry，不提高cap来掩盖全部失败。

### 老的导入、SSO编辑/删除为什么被拒绝

caller-lease模式拒绝OAuth CSV导入，pool成员不能通过旧独立reauthorize操作并行开启登录。新SSO标记的pool用户也禁止普通入口改密码/email/role、普通Sync GH login、删SSO/EMU、暂停EMU或移除席位；同步仅允许受控create-only的普通user角色。Login任务的独立Retry对pool成员拒绝，尚被pool等待/恢复阶段引用的终态任务不可删除；worker消费结果进入warmup/ready后可清理旧任务。Login无法向配对Proxy确认时拒绝删除/重试，不以丢失恢复证据为代价清空历史。使用pool的Disable/Retry/Resume；这些保护不是完整退池删除工具。非pool用户的破坏性操作还需配对Proxy确认ownership，核对不可用会拒绝，不能通过绕过校验继续删除。以上保护都按企业判断。

### 老客户升级后找不到旧账号

升级到多企业版后，升级前的全部数据归入 `default` 企业：先确认页头选的是 `default`。本页只列已纳入pool inventory的成员。旧SSO/Proxy账号仍可能保留在原页面，但不会自动变成pool成员，也不自动复用旧席位。先按[多企业版升级指南](multi-enterprise-upgrade-guide.md)和[升级手册](user-pool-upgrade-guide.md)判断是正常边界还是挂错了数据库卷。

**最后提醒：本页的正常绿色/Ready只证明当前本地状态和最近验证结果，不证明整个企业席位额度、所有模型权限、长期token有效性或最终计费均已确认。**
