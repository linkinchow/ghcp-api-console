# LiteLLM User Pool 身份接入

更新：2026-09-09。当前实施/HTTP验收基线：**LiteLLM v1.99.1**。此前1.94.2验证仅为历史记录，不代表旧镜像支持当前新增的认证类型检查。详细结果见[真实网关端到端报告](user-pool-gateway-validation.md)。

## 1. 模型与身份契约

终端用户使用个人数据库 virtual key，模型名无需 `ghcp/` 前缀。模型组示例：

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

使用正确provider和标准model ID，不为协议兼容而把Claude统统配置成OpenAI provider。当前v1.99.1内置表中包含该模型；实际部署必须核实所用镜像价格表和上游目录，不能推断所有新模型都有价格。`api_base` 使用根地址，provider自行追加 `/v1/messages`。

Proxy最终收到：

```http
Authorization: Bearer <独立Proxy服务密钥>
X-User-Identity: sha256:<鉴权确认的64位小写hex hash>
```

前缀由hook添加，不修改LiteLLM数据库hash、不二次hash。终端不填写header，不需要 `metadata.ghcp_identity`。原字段保留也不参与身份选择。key改alias不改hash，换key则是新caller；同key的多个会话使用同一排他租约。

## 2. 两个路由职责，三个回调阶段

原透明路由的两个职责保留，但过滤依据改变：**不再要求预先绑定GHCP identity**。否则所有新用户都进不了池。

| 回调 | 当前职责 |
| --- | --- |
| `async_pre_call_hook` | 接收真正的 `UserAPIKeyAuth`，确认认证类型，捕获可信hash到请求级ContextVar；不在此注入header，不按模型前缀选后端 |
| `async_filter_deployments` | 路由前：没有可信业务key身份时排除GHCP候选；有hash不要求已有lease/metadata绑定；非GHCP候选保留 |
| `async_pre_call_deployment_hook` | 选中后：只对匹配的GHCP URL清理伪造覆盖位置并注入 `sha256:<hash>`；缺可信身份则403 |

**为何没有严格缩为两个回调？**参考设计通过内部 `metadata.user_api_key_hash` 取值，但两个路由hook本身没有完整认证对象，不能仅凭64位格式证明它是数据库业务key而非Master/JWT/自定义认证。当前保留认证阶段回调，以实际对象的服务端标记确认来源和类型，再由两个路由hook消费。它不是旧的 `ghcp/*` 前缀兜底逻辑，也不是另一套metadata身份来源。

v1.99.1中 `via_virtual_key` 是服务端设置的标记，普通构造输入会被剥离。Hook要求此标记为true、拒绝session token，再验证 `token` / `hashed_token`。存在多份hash必须一致。如果auth对象带 `api_key`，它必须也是一致的hash；Master Key使用的稳定别名不符合要求。这里不会读取部署kwargs中的 `api_key` 作为caller，因为那个值可能是上游服务凭据。

本轮实际HTTP证明：普通数据库key无需identity metadata即可调用；Master只能走共享组中的非GHCP候选，GHCP-only组403。JWT/自定义认证没有完整HTTP部署验收，当前不启用这些路径；不支持的身份缺少可信标记时拒绝。

## 3. 路由与授权边界

需要按 key hash 首位逐步开放 GHCP 时，参见[灰度准入 Hook](user-pool-litellm-canary.md)。这是可选替换回调，默认身份 Hook 的全量业务 key 行为不变；新灰度功能的验证状态在独立说明中记录。

- LiteLLM正常执行key的模型访问和预算限制。模型组权限通常不是组内provider级权限。
- 当前单租户默认池的约定是：被授权访问该模型组的普通业务key可使用其中的GHCP deployment。若需要“同组某些key只能走其他provider”，仍需独立服务端deployment准入策略，不能把hash当权限。
- `GHCP_POOL_API_BASES` 明确列出GHCP根地址，精确匹配scheme/host/port/path（去尾斜杠），不按模型名或域名子串猜测。
- 缺allowlist时启动失败。只把此hook装到需要pool的网关；旧direct环境不可接收hash触发旧自动开户。
- filter不向Proxy查“是否已有映射”，也不预占账号。已有映射复用、新caller领取idle均在Proxy完成。
- filter不以瞬时idle=0排除所有GHCP请求，否则会误挡已有租约用户。新caller缺号由Proxy明确429处理。

## 4. 身份覆盖与隔离

GHCP路径清理大小写变体身份header，覆盖 `headers` / `extra_headers`，并清理已支持的 `default_headers`、`extra_body`、`litellm_params`、`optional_params`、`provider_specific_header`、请求快照等位置。copy-on-write避免污染Router共享deployment参数。缓存OpenAI client在GHCP路径清空，避免持久默认header覆盖。

当前不从 `metadata.user_api_key_hash`、`user_api_key_metadata.ghcp_identity`、客户端token/user/alias字段兜底。Prompts和工具内容不递归重写。真实网关Messages/Chat两条入口的多种伪造测试已通过。

非GHCP路径不新增可信caller hash、不消费池账号，也不改变它原来的header语义。**实测：客户端自己在 `extra_headers` 传入的身份header仍可能由LiteLLM发给非GHCP后端。**这不是hook泄露认证hash，但如需禁止这种用户自定义header，应另行加统一出口header规则，不能把“不注入”描述成“所有身份header都绝不转发”。

## 5. 429、fallback和价格

- Proxy直接返回429和 `Retry-After`；该信号本身不启用LiteLLM fallback。
- 本版示例保持0自动重试、无自动fallback；测试harness另有明确的故障主路由用于验证fallback进入GHCP，不作为生产建议。
- v1.99.1真实HTTP实测：上游429仍映射为客户端429，但错误会重新包装，`Retry-After` **未透传**。依赖此header的客户端退避策略还需要网关适配/单独验收；不能承诺默认透传。详见[待办](user-pool-todo.md)。
- 上游429不换GHCP账号规避限流；不对已输出流自动重放。容量不足时只能按批准的有界策略重试或转其他合规后端。
- Response cache保持关闭；Prompt cache与完整响应缓存不同。本轮不证明上游Prompt Cache的跨身份隔离或共享。
- 实测内置 `claude-opus-5` 输入单价5e-6/输出2.5e-5美元每token，mock的4输入+1输出记录spend=0.000045；这是镜像表计算值，不是Copilot账单承诺。

## 6. 配置和版本

挂载 [user_pool_hook.py](../litellm/user_pool_hook.py)，注册 `user_pool_hook.proxy_handler_instance`，保持它在其他修改header/URL的callback之后。不要再同时装旧metadata identity注入hook，避免相互覆盖。

```dotenv
GHCP_POOL_API_BASE=http://proxy:3000
GHCP_POOL_API_BASES=http://proxy:3000
GHCP_PROXY_API_KEY=<Proxy_API_KEY对应值>
```

`GHCP_POOL_API_BASE`供YAML使用，`GHCP_POOL_API_BASES`供hook匹配，都属于LiteLLM进程配置。示例：[config.user-pool.example.yaml](../litellm/config.user-pool.example.yaml)。不要复制测试专用的冷却禁用、测试Master Key或故障provider配置到生产。

## 7. 已执行验证与范围

- 离线hook测试17项通过，覆盖hash、来源类型、filter、并发ContextVar、伪造和URL匹配。
- v1.99.1真实runtime callback/Router测试5项通过（禁网，mock model）。
- 真实LiteLLM服务+Postgres建立User/Virtual Key，经HTTP调用真实Proxy/SSO及mock上游：主套件34通过、0失败、1 blocked；原主套件1个fallback skip已由补充测试覆盖。
- 普通API拒绝同名alias，无法通过该API构造相同alias的两把key；没有改DB绕过。hash身份不依赖alias仍有离线测试，改alias及不同key隔离有真实HTTP证据。
- Messages x-api-key/Bearer、Chat Bearer、JSON/SSE、20不同key突发、自动补池、耗尽、撤销和模型权限均已测试。
- 真实SpendLogs、User归属、非零计费、key小预算超限阻断通过；不是仅检查函数返回价格。

所有GitHub SCIM/席位/model响应和Login completion均为本地fixture。真实SSO入库和Proxy OAuth回调实际执行；并不代表真实GitHub Device Flow/SAML、付费席位或真实模型质量验收。Responses、Prompt Cache、team预算、生产冷却策略及长期负载仍需额外覆盖。
