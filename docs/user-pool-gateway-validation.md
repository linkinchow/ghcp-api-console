# User Pool — LiteLLM v1.99.1 真实网关端到端测试

日期：2026-09-09。分支：`ghcp-user-pool`。隔离项目：`ghcp-user-pool-gateway`。本报告针对真实运行的LiteLLM HTTP网关和数据库，不再只是构造认证对象调用Router函数。

## 1. 环境和测试边界

| 组件 | 本轮实际运行内容 |
| --- | --- |
| LiteLLM | 官方 `ghcr.io/berriai/litellm:v1.99.1`，镜像内版本核实为1.99.1 |
| LiteLLM数据库 | 独立PostgreSQL16卷，实际User/Virtual Key创建、认证、撤销和SpendLogs |
| GHCP Proxy | 当前有限并发User Pool代码、SQLite、真实HTTP路由/租约/worker |
| SSO | 真实服务、真实本地SSO用户入库、SCIM客户端和席位调用 |
| GitHub/席位/model上游 | 本地stateful mock，非真实GitHub用户/付费席位/模型 |
| Login completion | mock任务+实际HTTP OAuth attempt回调到Proxy；真实Login不接收可执行任务 |
| Console | 真实管理员登录、API bridge和账号池页面 |

应用仅接内部Docker网络。固定目标bridge在localhost发布17500–17505；没有向真实客户环境发请求，没有读取客户`.env`，没有修改参考项目或其线上配置。

运行地址（服务运行时）：

- GHCP Console：`http://127.0.0.1:17504/#user-pool`
- LiteLLM gateway：`http://127.0.0.1:17505`
- Proxy管理/推理测试：`http://127.0.0.1:17500`

该项目与原17304/17404隔离项目独立。测试账号和密钥仅供本地，不能作为交付凭据。OAuth access token自动续期仍为延期事项，未因本次测试实现。

## 2. 与透明路由参考设计的对照

### 保留的部分

用户仍填写 `model=claude-opus-5`，无 `ghcp/` 前缀。GHCP作为deployment参与路由：

```yaml
model_list:
  - model_name: claude-opus-5
    litellm_params:
      model: anthropic/claude-opus-5
      api_base: http://proxy:3000
      api_key: os.environ/GHCP_PROXY_API_KEY
      max_retries: 0
    model_info:
      id: pool-claude-opus-5
```

价格使用v1.99.1内置标准provider/model条目，没有保留早期1.94.2预检的合成价格。

### 必须改变的部分

1. 原filter检查 `metadata.ghcp_identity`，没有预绑定就排除GHCP。Pool模式必须取消此条件，否则新用户无法首次领取idle。
2. filter改为检查可信业务key身份；并不向Proxy提前检查lease，也不按全局idle=0移除GHCP，避免影响已有租约用户。
3. deployment hook注入 `X-User-Identity: sha256:<hash>`，不读取旧identity metadata。用户已明确选择保留此前缀。
4. LiteLLM模型组权限并不自动区分组内GHCP/其他provider权限。当前约定所有获准调用该组的普通业务key可使用默认池；更细的provider准入属于独立策略。

### 为什么实现用了三个回调

两个**路由职责**仍是filter与选中后注入。另保留 `async_pre_call_hook` 只接收真实认证对象、确认 `via_virtual_key` / 非session / 非Master别名并捕获可信hash。它不按模型前缀路由，不注入header，也不从用户metadata兜底。

参考文件提出只从已验证内部metadata取hash、保留两个方法；当前实现选择认证对象作为信任源，以便可靠区分业务key和其他身份。不能把“字段为64位”当成来源或类型证明。详见[hook说明](user-pool-litellm.md)。

## 3. 基础参数和判据

- 初始ready-idle目标5、总量上限20；预热阶段并发5。
- 测试正式租约3600秒，避免测试期间正常到期干扰身份判定。
- 每个请求唯一marker，mock记录实际成员、model、stream和结果，不记录token/password。
- 用Proxy `callerKeyHash`核对字符串 `"sha256:" + SHA256(raw_virtual_key).hexdigest()`：对原始key只做一次SHA-256，再加前缀；不做二次hash。
- 同时核对lease ID、member identity、SSO/SCIM/seat/Login callback计数及数据库SpendLogs，不靠响应ID前缀判断后端。
- Response cache关闭。Router自动retry=0。此压力harness显式关闭deployment cooldown，以单独观测pool容量；不把该设置推荐到生产，也不据此宣称生产熔断行为已验收。

## 4. 已执行测试矩阵

主套件结果：**34项PASS、0项FAIL、1项BLOCKED、1项SKIP**。SKIP为当时未配fallback，后来由补充套件完成；保留原始报告，不回写成全绿。

| 场景 | 操作与核对 | 结果 |
| --- | --- | --- |
| 真实网关/DB | readiness确认DB connected，调用实际 `/user/new`、`/key/generate`、`/key/info` | 通过 |
| 空库预热 | target从0改5，真实SSO与mock SCIM/seat/Login/model全部完成 | 5个ready，通过 |
| 无业务metadata | 不填 `ghcp_identity` 的新key首次调用 | 成功分配idle，通过 |
| 身份稳定 | 同key重复及8并发请求 | 同hash、member、lease稳定 |
| 不同key隔离 | 第二把key首次请求携带伪造受害者header | 使用自己的hash和不同成员 |
| 修改alias | `/key/update`改alias后再次调用 | hash/lease/member不变 |
| 同alias两把key | 尝试通过正式API生成重复alias | API400；该构造BLOCKED，没有DB绕过 |
| Messages认证 | x-api-key和Bearer，各覆盖JSON/SSE | 通过 |
| Chat兼容入口 | `/v1/chat/completions` Bearer，JSON/SSE | 通过 |
| canonical目录 | 当前模型和5.2连字符别名可见，目录请求不建lease | 通过 |
| 旧metadata误绑定 | key metadata填另一成员identity | 被忽略，仍按自身hash |
| HTTP身份头伪造 | 客户端X-User-Identity及大小写变体 | 服务端hash覆盖 |
| Body header伪造 | headers/extra_headers/default_headers/extra_body | Messages和Chat均通过 |
| Metadata伪造 | metadata/litellm_metadata的user_api_key_hash等 | 不能冒用其他caller |
| 嵌套参数伪造 | litellm_params/optional_params/provider_specific_header/请求快照 | 不能改实际成员 |
| 无效key | 未签发key三种认证/入口组合 | 401，无新lease/上游调用 |
| 撤销key | 先prime auth cache再delete，含已成功使用key | 401，不复用或续租 |
| 模型权限 | other-only key访问GHCP模型组 | 403，不消费idle |
| 20新用户突发 | 20个不同User/Virtual Key，真实HTTP同时进入 | 见下一节 |
| cap耗尽 | 20个已租出后第21个新caller | 429，不超额开通 |
| 释放复用 | 释放5个自有lease | 5个ready恢复，未新建/退席位 |
| 安全DTO | Proxy/mock输出不含原始key、OAuth token、密码 | 通过 |
| 真实Login零任务 | 全程只读检查任务列表 | 0任务，未触发真实GitHub授权 |

补充套件6项通过：

- Master Key访问GHCP-only模型组403，不分配lease。
- Master Key访问同名共享组时filter移除GHCP，仍能调用非GHCP deployment。
- 普通key调用other-only，无hook注入的hash，不消费池成员。
- 故意失败的主deployment fallback到GHCP，仍按原认证hash取得lease。
- 小预算key一次请求spend=0.000045后超过0.00001预算，后续请求429阻断。
- 实际Messages usage 4输入+1输出，与内置单价计算值匹配。

## 5. 突发用户、补池和上限实测

压力开始前释放功能测试租约，恢复5个idle，开启worker；20把不同业务key一起发请求。每轮只重试明确 `pool_exhausted` 的用户，不重试成功请求、不把其他错误猜成缺号。

| 轮次 | 本轮请求数 | 成功200 | pool_exhausted 429 | 该轮结束时总量/状态 |
| --- | ---: | ---: | ---: | --- |
| 首次突发 | 20 | 5 | 15 | 总量10：5 leased + 5 provisioning |
| 补池后重试1 | 15 | 5 | 10 | 总量15：10 leased + 5 provisioning |
| 补池后重试2 | 10 | 5 | 5 | 总量20：15 leased + 5 provisioning |
| 补池后重试3 | 5 | 5 | 0 | 总量20：20 leased，无provisioning |
| 超上限新用户 | 1 | 0 | 1 | 仍总量20，不增加 |

第一轮约1.35秒结束时，worker已经登记5个新的provisioning，说明不只是等管理员操作，也不是必须等下一次长期定时任务。随后每轮自动恢复5个idle，再由测试客户端有界重试。

**这不意味着突发20个都能马上成功。**初始只有5个现成账号，另外15个首次应明确429；预热耗时决定恢复速度。N是备用库存目标，cap是总量约束。若N=50/idle30/无在途工作，worker会登记20个；本测试N=5，所以每消费一批库存就补目标5。

最终20把key有20个唯一hash、20个唯一成员、20个有效lease。mock计数为20次SCIM创建、20次席位分配、20次Login派发/成功回调，没有重复创建或按hash直接创建SSO用户名。

## 6. 实际计费与用量归属

不是通过返回ID推测后端，而是读实际PostgreSQL `LiteLLM_SpendLogs`：

- `model_group = claude-opus-5`
- `model_id = pool-claude-opus-5`
- `model`多为 `anthropic/claude-opus-5`（原生路径少量行保留裸模型名）
- `api_key`为业务key hash，`user`为创建key时的测试User ID
- 成功请求输入4、输出1，spend均为0.000045；失败行spend为0

核算：`4 × 0.000005 + 1 × 0.000025 = 0.000045`美元。仅验证LiteLLM镜像价格表/usage/记账链路，不承诺真实Copilot账单按此结算。Team预算、Prompt Cache写/读费用和不同模型仍需单独测试。

## 7. 实际发现与限制

1. **Retry-After未透传：**1.99.1返回客户端429，但上游 `Retry-After: 7`在客户端为null。pool_exhausted也有相同包装问题。Proxy实现正确不等于网关默认保留此header，后续单独适配。
2. **同alias测试受限：**普通key创建API拒绝重复alias。没有通过DB插入制造不可支持数据；离线hook测试覆盖相同alias不影响hash，真实HTTP覆盖不同key隔离及alias改名。
3. **非GHCP原始header：**hook不注入可信hash，但若客户端自行传 `extra_headers.X-User-Identity`，LiteLLM仍可能把这个用户自报值发给非GHCP后端。统一出口清理属于另一个规则，不能宣称当前已做。
4. **只验证两个推理入口：**本轮Messages和Chat JSON/SSE通过；网关Responses、Prompt Cache、Team预算和长期压力尚未完整覆盖。
5. **冷却条件：**harness关闭Router cooldown以观察补池；生产启用cooldown时的整组/单deployment行为仍需验收。
6. **OAuth不是真实：**fake Login完成+真实回调不是Device Flow/Playwright真实SAML授权。真实模型响应也未调用；实际Github账号及paid seat没有创建。

## 8. 复现文件与收尾

- [独立gateway Compose overlay](../tests/docker-user-pool/compose.gateway.yaml)
- [透明模型/deployment配置](../tests/docker-user-pool/gateway-config.yaml)
- [启动脚本](../tests/docker-user-pool/launch-gateway.mjs)
- [主端到端测试](../tests/docker-user-pool/gateway-smoke.mjs)
- [过滤/fallback/预算补充测试](../tests/docker-user-pool/gateway-supplement.mjs)
- [fixture](../tests/docker-user-pool/mock-services.mjs)
- [原始场景清单及操作约束](../tests/docker-user-pool/gateway-scenarios.md)

主套件需全新Proxy/SSO/mock状态；不能对已有测试库存直接重跑初始空库阶段。原始结果写入gitignored `local-gateway-results.json`；补充结果另存，原始key不写报告。套件结束暂停worker并撤销自己创建的key，保留账号及审计数据；key撤销不会自动等同于Proxy租约立即释放，租约按其TTL或管理员操作处理。

本轮使用官方镜像而非重新编译LiteLLM源码；已核实版本为1.99.1。未提交/推送，没有修改隔壁LiteLLM项目或客户环境。
