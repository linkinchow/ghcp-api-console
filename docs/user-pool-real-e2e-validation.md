# GHCP User Pool 真实环境完整测试报告

**测试日期：2026-09-10**

**代码分支：`ghcp-user-pool`（测试时改动尚未提交、推送）**
**范围：自带SSO接入GitHub.com EMU、真实自动预热、LiteLLM真实调用及消费后的自动补池。**

> **结论：功能闭环通过，不能据此宣称席位计费约束或所有生产场景验收通过。**
>
> 本次完成4个新普通池账号的真实开通、席位分配、OAuth登录与warmup；两把不同LiteLLM virtual key成功调用不同成员，并触发后台补池。最终池为4个账号：2个active lease、2个ready idle，0失败。
>
> 两个需要特别保留的结论：
> 1. **本次真实环境的Proxy预热阶段并发和Login并发均为1。**两个补充账号的Login任务先后执行，未验证真实GitHub五路并行登录。
> 2. **GitHub席位API最终列出10条记录：6条原有待取消＋4条新非待取消分配。**没有验证账单不增加；若“总seat不超过7”指API总记录数，则该口径未满足。

本文是本次现场测试的总报告，替代先前仅描述消耗/补池的简版。单账号阶段保留在[单账号真实预热记录](user-pool-real-canary-validation.md)。客户企业标识、实际邮箱/账号、原始hash、token、密码及签名私钥不写入公开报告；对应现场证据保存在Git和Docker构建上下文均排除的私有目录。

## 1. 测试目标

按顺序验证：

1. 将已授权的测试企业SAML登录入口接到新的自带SSO。
2. 区分本地SSO建用户、GitHub SCIM创建EMU、Copilot席位分配和OAuth授权，逐段确认真实可用性。
3. 从空账号池自动预热1个普通账号，不靠人工配合其登录。
4. 先提高池最大账号数，再提高idle目标，观察是否自动登记缺口并完成新账号开通。
5. 用两把真实数据库virtual key经LiteLLM调用GHCP，验证hash到账号的排他映射。
6. 消耗现有2个idle后，观察是否自动登记并完成2个新idle，不手工创建、不点击Reconcile。
7. 对照测试前后数据，确认原管理员、原席位关联未被替换、删除或恢复；明确实际席位记录变化。

本次不是旧客户升级演练，不执行存量账号入池迁移，也不删除旧用户。

## 2. 环境与真实/mock边界

### 2.1 实际调用链

```text
测试客户端：两把独立LiteLLM virtual key
    │ POST /v1/responses，model=gpt-5.6-sol
    ▼
LiteLLM v1.99.1 + PostgreSQL
    │ 真实key认证、模型路由、用量/SpendLogs
    │ X-User-Identity: sha256:<已认证key hash>
    ▼
真实测试Proxy + SQLite
    │ caller lease → member identity → OAuth access token
    │ POST /responses
    ▼
真实GitHub Copilot上游模型

后台worker
    ├─ 真实本地SSO用户库
    ├─ GitHub企业SCIM API
    ├─ GitHub企业Copilot席位API
    ├─ Login：真实Device Flow + Playwright + SAML
    └─ OAuth回写和真实模型warmup后入池
```

**本报告中的开户、席位、Login和模型调用均为真实链路，不使用fake Login完成或mock模型输出。**这与此前17304/17404/17504等隔离mock测试不同，不能把这些环境的配置和结果混用。

### 2.2 服务与本机入口

项目名为 `ghcp-sso-preflight`，沿用准备阶段的名字，但后续已按授权启用真实服务连接。

| 组件 | 本次用途/入口 |
| --- | --- |
| SSO | 浏览器入口 `http://sso.localhost:7001` |
| Console | `http://localhost:17704` |
| Proxy | 本机 `http://127.0.0.1:17700`，容器内 `http://proxy:3000` |
| Login | 本机管理入口17703，容器内7003 |
| LiteLLM | 官方镜像v1.99.1，本机 `http://127.0.0.1:17705` |
| PostgreSQL | LiteLLM专用数据库，无直接宿主机发布端口 |
| SQLite | Proxy池状态、SSO用户、Login任务分别保存在对应持久卷 |

本机Chrome把 `sso.localhost` 作为回环入口。Login与SSO共享network namespace，使Login内Chromium使用相同URL也能访问SSO。重建SSO时相应重建共享网络的Login，保留原卷。

SSO、Login、Proxy后续获得执行授权范围内外部操作所需的网络；LiteLLM通过内部网络访问Proxy和数据库。所有宿主机测试端口绑定回环地址。没有将真实密钥装入其他mock测试项目。

**运行限制：**企业SAML入口指向这台电脑；休眠、关闭Docker或改变本机地址可能中断该入口。测试结束后必须明确保留运行或按管理员批准的方案恢复旧入口，不能把本机临时地址视为长期生产部署。

## 3. 凭据、配置与保护

### 3.1 凭据分工

| 配置 | 来源和用途 |
| --- | --- |
| `API_KEY` | 为新Proxy自行生成；LiteLLM使用它访问Proxy |
| `INTERNAL_API_TOKEN` | 新栈自行生成，组件内部管理认证 |
| `SESSION_SECRET` | 新栈生成，保持SSO/Console会话稳定 |
| `SSO_DEFAULT_USER_PASSWORD` | 新栈生成，用于自动创建的普通池成员；不使用GitHub管理员密码 |
| `SCIM_TOKEN` | 同事提供的有效SCIM凭据；真实查询和同步均通过 |
| `GITHUB_COPILOT_SEAT_PAT` | 旧值失效，用户生成新PAT后提供；只含 `manage_billing:copilot` |
| SAML签名证书/私钥 | 新栈生成；GitHub只登记公钥证书，不发送私钥 |
| LiteLLM Master/数据库/签名密钥 | 本次真实测试网关单独生成，不复用公开mock密钥 |

原始来源文件未被自动覆盖，运行配置另存私有目录。真实token从文件载入容器前后做一致性检查，只报告是否相同，不打印原文。SQL、报告和常规控制台输出不导出原始key或OAuth token。

### 3.2 关键配置变化

| 项目 | 初始准备 | 单账号验收 | 双用户消耗与补池 |
| --- | ---: | ---: | ---: |
| 持久化最大池账号数 | 2，开通前收紧 | 1 | 5 |
| 持久化idle目标 | 0 | 1 | 2 |
| 预热暂停 | 开启 | 执行期间关闭，完成后开启 | 执行期间关闭，完成后开启 |
| `PREWARM_CONCURRENCY` | 1 | 1 | **1** |
| Login runtime concurrency | 1 | 1 | **1** |
| 正式租约TTL | 172800秒 | 172800秒 | 172800秒 |
| Warmup模型 | 准备值、不允许调用 | `gpt-5.6-sol` | `gpt-5.6-sol` |

运行期target/cap/pause通过版本化管理API持久化；不能只看Compose环境种子值推断实际设置。此前把Login设为5并跑五个本地浏览器的是另一套mock环境，不适用于本表。

## 4. 完整操作经过

### 阶段A：本机SSO准备与GitHub切换

- 创建全新SSO、Proxy、Login、Console数据卷和签名材料，没有把mock用户库当成真实企业数据库。
- 初期禁用SCIM、席位和模型上游，保持target0/paused，避免在身份配置未完成时自动开通。
- 验证本机浏览器及Login内Chromium均可访问新SSO登录地址；metadata的Issuer和Sign-on URL一致。
- 用户与企业管理员在GitHub侧完成SAML配置切换并报告测试成功。该配置变更由用户操作，不是通过自动化替其修改。
- 用户在自己的Console创建本地管理员用户，再尝试Sync GH login。

### 阶段B：SCIM同步失败定位和启用

第一次Sync显示 `fetch failed`。核对运行配置后确认：准备阶段SCIM仍指向禁用端点、token尚未装入，**不是已证明SCIM token失效**。

经用户要求启用后：

1. 载入真实SCIM endpoint和token，开放对应服务网络。
2. 重建SSO及共享网络的Login，保留证书、会话和数据卷。
3. 真实只读SCIM GET Users返回200。
4. 用户再次点击Sync，成功得到真实EMU login、SCIM ID，状态active。

该管理员用户用于现场SSO验证，不被自动接管为池成员；后续所有池账号均为普通 `user`。

### 阶段C：席位PAT排障

| 检查 | 旧席位PAT | 新席位PAT |
| --- | --- | --- |
| 文件与容器载入一致性 | 一致，无多余空白 | 一致 |
| GitHub `/user` | 401 `Bad credentials` | 200 |
| 企业Copilot席位列表 | 401 | 200 |
| SCIM token | 独立验证正常，无需更换 | 未更换 |
| 实际席位分配 | 未执行 | 成功 |

旧PAT为什么失效没有进一步确证，不能归因于更换SSO，也不能把401直接说成缺少管理员scope。新PAT仅选择 `manage_billing:copilot`，实际完成企业席位读取和本次分配，**本次不需要整个 `admin:enterprise`**。这一结果不外推为所有GitHub接口或企业策略的最小权限保证。

### 阶段D：首个普通池账号真实预热

先确认池为空、没有在途Login任务，持久化cap1/target0/paused。配置批准的账号邮箱域名和warmup模型，完成只读外部基线记录后，设置target1并解除暂停。

worker自行完成：

```text
预占候选 → 创建普通SSO用户 → SCIM create-only创建EMU
→ 分配1个席位 → 派发1个Login任务
→ GitHub用户名页 → 企业SSO → 本地SSO登录 → 返回GitHub
→ Device Flow授权确认 → token轮询成功 → 回写Proxy
→ gpt-5.6-sol模型验证 → Ready idle
```

结果：1个新账号active、席位assigned、OAuth valid、pool ready。约146秒从预占到Ready，其中Login任务约126秒；没有人工干预该池成员登录。完成后暂停。

### 阶段E：旧席位状态核对及授权澄清

首个池账号开通前席位API列出6条旧分配；开通后为7条。用户希望将总seat控制在7以内并复用旧席位，后续核对发现原6条都带 `pending_cancellation_date=2026-09-30`。

- 没有重复发送取消请求，没有删除或恢复旧EMU。
- 用户明确表示这些待取消席位可立即重新分配且不产生额外计费。
- 本次后续执行采用“限制新增池账号及非待取消分配”的口径，但**没有通过账单证明这就是GitHub实际计费口径**。
- 这不是技术上把旧席位关联转移给新账号：旧关联未改，新账号新增了自己的分配记录。

“复用旧账号”与“认为旧席位额度可用于新账号”是不同方案；本次执行后者，并未实现前者。席位结果及约束偏差见第8节。

### 阶段F：调整cap和idle目标

真实测试LiteLLM启动，创建两个独立User及virtual key。key不设置业务 `ghcp_identity`，仅允许测试模型。

1. 初始状态total1/idle1/无lease、paused。
2. 将cap从1改为5，仍暂停；没有新增账号。
3. 解除暂停，此时idle目标仍1且已满足。
4. 把idle目标从1改为2。
5. 约84ms后首次观测到total2、idle1、provisioning1。
6. 新账号自动完成真实EMU、席位、登录和warmup，最终idle2。

没有手工创建成员、手工同步EMU、手工分配席位或点击Reconcile来推进这一段。

### 阶段G：LiteLLM消耗idle与自动补池

两把真实virtual key并发发送小额请求：

```json
{
  "model": "gpt-5.6-sol",
  "input": "Reply OK",
  "max_output_tokens": 16,
  "stream": false
}
```

入口为LiteLLM `/v1/responses`，后端配置 `openai/gpt-5.6-sol`，由其调用Proxy `/responses`。没有自动fallback和客户端重试。

- 两个请求均HTTP200，Responses状态 `completed`。
- Proxy使用 `sha256:` + 对原始virtual key做一次SHA-256的hex值查租约，两个caller分配不同成员。
- 两次成功后租约升级active，正式TTL48小时。
- 每250ms采样池状态，实际观测idle从2变0。
- 消耗期间自动登记2个补充账号，total4，leased2，provisioning2。
- 两个补充账号依次完成Login和warmup，最终idle恢复2。

## 5. 时间线与“立即触发”的准确含义

以下为保留快照和Login任务记录的北京时间（UTC+8）：

| 时间 | 事件 |
| --- | --- |
| 16:37:53左右 | 首个池成员预占 |
| 16:38:18 | 首个Login任务开始阶段 |
| 16:40:24 | 首个Login任务success |
| 16:40:39 | 首个成员warmup完成，Ready |
| 17:06:19.921 | 提高idle目标后首次观测第2个账号已登记 |
| 17:08:19.852 | 两个idle全部就绪 |
| 17:08:25.751 | 两个key调用期间观测idle0，同时已登记补池账号 |
| 17:08:33.182–17:10:20.134 | 补充账号A的Login实际运行 |
| 17:10:20.159–17:11:52.058 | 补充账号B的Login实际运行 |
| 17:12:03.140 | 两个补充账号均Ready，idle恢复2 |
| 17:12:04.727 | 结果记录完成，暂停及测试key撤销完成 |

- 84ms是更新idle目标到首次观测新任务的时间，不是所有开户步骤耗时。
- 5897ms是从客户端发起LiteLLM请求到首次观测补池记录，包含网关/网络和采样间隔，不能解释为worker固定等6秒。
- “立即触发”表示开始调度/登记任务，不表示新账号立即可调用；登录和上游生效需要时间。
- **两个补充账号的任务创建时间相近，但实际Login运行时间不重叠。真实浏览器并发仍为1。**

## 6. 实际推理、租约和计费记录

| 项目 | 请求1 | 请求2 |
| --- | --- | --- |
| Virtual key | 不同业务key | 不同业务key |
| HTTP | 200 | 200 |
| Responses状态 | completed | completed |
| 模型 | gpt-5.6-sol | gpt-5.6-sol |
| 输入tokens | 8 | 8 |
| 输出tokens | 5 | 5 |
| 总tokens | 13 | 13 |
| 成员 | 成员1 | 成员2，与成员1不同 |
| 租约 | active，48小时 | active，48小时 |

真实PostgreSQL `LiteLLM_SpendLogs`按模型组/deployment记录2条成功调用，累计spend为 **0.000264美元**。这是LiteLLM所用价格表的记账结果，不是已核对的GitHub实际账单金额。

该金额只对应这两次经LiteLLM的业务请求；worker直接做的warmup不经过LiteLLM，不能用此值表示整个测试的所有模型成本。本次完整测试共有4个成员达到warmup成功（首个单账号阶段1个＋扩展阶段3个）。

Console红框的caller hash不是OAuth token，`active`和到期时间表示账号租约；`Requests=0`表示没有在途请求，不表示历史调用数为0。

## 7. 最终池状态及收尾

| 指标 | 完成时数值 |
| --- | ---: |
| Total pool accounts | 4 |
| Ready idle | 2 |
| Active leased | 2 |
| Provisional | 0 |
| Provisioning | 0 |
| Cooling / Failed / Disabled | 均为0 |
| Maximum accounts | 5 |
| Idle target | 2 |
| Formal lease TTL | 172800秒 |
| Paused | 1 |

测试完成后暂停worker，不再自动扩容，也暂不推进自动OAuth修复。撤销本次生成的两把测试key，但没有通过撤销key联动删除Proxy租约；保留的两条租约会按TTL或管理员明确操作释放。没有有效测试key仍在持续调用，不能把active lease数当作当前在线用户数。

账号和真实席位保留，没有自动缩池或删除。Idle成员同样占用席位。表中状态是测试完成时快照，不承诺永久不变。

## 8. 席位记录、计费及约束偏差

| 时间点 | API全部席位记录 | 原有待取消记录 | 非待取消分配 |
| --- | ---: | ---: | ---: |
| 首个池账号开通前 | 6 | 6（之后核对确认） | 0 |
| 首个池账号Ready后 | 7 | 6 | 1 |
| 本轮扩展/补池完成 | **10** | **6** | **4** |

**完整过程新建4个池账号并分配4条新席位，其中本轮扩展新增3条；旧6条关联和取消日期未改变。**

必须明确：

1. 功能验收通过，但**API `total_seats` 不在7以内，最终是10**。若最初约束是此字段≤7，则未满足，不能用“非待取消只有4”改写结果。
2. 用户确认旧待取消席位额度可复用，这是执行时的业务前提，不是本次接口测试独立验证出的GitHub计费规则。
3. 没有查验最终账单或期间计费人数，**不能承诺没有额外计费，也不能从pending字段计算应付金额**。
4. 当前 `POOL_MAX_ACCOUNTS`只限制池成员数量，不限制整个企业的已分配/待取消/计费席位总量；不是企业级预算保护。
5. 原6个旧账号没有被重新纳管入池，也没有被新账号逐一替代。当前代码为新成员创建流程，不具备自动旧账号纳管能力。
6. 在明确后续计费/复用策略前，不再扩容；不要用删除EMU用户来试图强制释放席位。

## 9. 原有用户保护证据

- 本地原管理员记录在操作前后逐字段一致，没有改角色、密码、邮箱或关联。
- 首次canary的SCIM读取可见1名既有用户；对该读取范围内的旧ID、用户名、active状态做了前后比对。
- 已读取的原6条席位关联全部保留，pending cancellation日期未改。
- 没有执行针对旧用户的SCIM DELETE/PATCH/恢复操作，也没有执行删除或重复取消席位操作。

用户曾说明旧EMU暂停，但不能把“读取范围内比较一致”表述为已经独立核实所有不可见的旧身份属性、历史登录状态或账户所有权。仅按实际获取的基线和执行操作报告。

## 10. 问题、修正和未验证范围

### 本次发现并解决

- 准备阶段禁用SCIM导致首次Sync失败：确认运行配置后按授权启用，而非误换有效SCIM token。
- 席位PAT `Bad credentials`：重新取得有效的最小用途PAT；认证/查询/分配实际验证通过。
- 应用配置与宿主机文件不一致的风险：修改环境后重建容器，保留数据卷与签名材料，不能只执行restart。
- 最初把待取消记录和可用额度混为一谈：后续按字段分开报告，保留计费未核实结论。
- 之前测试环境Login=5与真实环境Login=1混淆：按实际runtime和任务时间明确纠正。

### 未验证／未实现，不能由本次成功外推

- 原6个旧账号的安全纳管、去重、恢复登录、保留席位并入池。
- 旧客户数据库升级演练及存量调用者迁移。
- 真实五路并行浏览器授权、持续高负载、数据库吞吐/P95/P99性能。
- 本次真实模型的流式、工具调用及所有其他模型协议；此前mock协议测试不是本次真实验收。
- 对真实token主动撤销后的自动恢复；当前恢复功能只在本地/mock专门验证过，未为测试故意撤销此批真实凭据。
- 最终GitHub账单、待取消席位立即复用的计费效果及总计费人数上限。
- LiteLLM默认透传 `Retry-After`：已知v1.99.1未透传，仍为独立待办。
- 生产级网络、长期SSO入口和完整依赖安全验收。

## 11. 证据索引与复现限制

| 记录 | 内容 |
| --- | --- |
| [单账号报告](user-pool-real-canary-validation.md) | 第一名真实普通池成员的完整自动预热 |
| [模型池设计](user-pool-design.md) | 身份、租约、状态和并发语义 |
| [实现与运维](user-pool-implementation.md) | 配置、数据表、接口和运行方式 |
| [LiteLLM接入说明](user-pool-litellm.md) | 可信hash、filter与选中后注入 |
| [mock网关报告](user-pool-gateway-validation.md) | 更广的伪造、权限、突发和预算测试，不与本次真实结果混淆 |
| [并发报告](user-pool-concurrency-validation.md) | 并发5的mock/local-browser证据，本次真实配置为1 |
| [OAuth恢复报告](user-pool-oauth-recovery-validation.md) | 401后自动重新授权及其验证边界 |

私有现场证据（不提交/不公开）：

- `.local-sso/real-canary-before.json`、`real-canary-result.json`：首个账号外部基线/结果。
- `.local-sso/real-e2e-before.json`、`real-e2e-result.json`：实际池状态时间序列、映射、席位分类及保护断言。
- `.local-sso/real-e2e-response-summary.json`：两次业务状态和usage。
- SSO/Proxy/Login持久化卷中的账号、事件和任务记录。
- 真实LiteLLM PostgreSQL中的User/Key历史及SpendLogs。
- `.local-sso/active.env`、签名私钥和测试key文件：敏感材料，只在本机受保护保存，不复制进报告。

**不要直接重新运行现场脚本来复现本文**：它们会创建真实账号、分配真实席位并调用模型，而且初始库存假设已经不成立。下一轮需先检查当前状态、确定账号/席位预算和旧账号复用方案，再单独授权。本次文档整理不更改运行配置、不执行新调用或席位操作，不提交或推送代码。
