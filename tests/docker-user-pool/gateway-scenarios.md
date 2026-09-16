# 真实本地网关冒烟测试场景

## 范围与安全

`gateway-smoke.mjs` 是一个独立的 Node **22+** 运行器，仅使用内置模块和 `fetch`。它先测试**由数据库支持的真实 LiteLLM 入站 HTTP 身份验证和虚拟密钥管理**，再针对本地 SCIM、席位、OAuth 回调、模型发现和推理测试夹具，测试真实的 Proxy/SSO 账号池行为。它不会实例化假的 `UserAPIKeyAuth` 对象，也不会将哈希直接注入网关推理请求。

运行器**不会**启动 Docker、修改 Compose/钩子/产品代码、调用外部模型 API、直接访问 Postgres，或将真实 Login 任务入队、取消或重试。运行器对真实 Login、SSO 和 Console 仅执行只读操作。账号池工作进程的请求必须使用**模拟** Login 端点。必须提供 `--confirm-local-fixture`。未提供时，运行器既不发出任何 HTTP 请求，也不写入报告。

运行器的全部六个目标地址必须是互不相同、以字面量形式指定的回环 HTTP 源地址（`127.0.0.1` 或 `[::1]`）；带凭据、路径、查询参数、片段、非回环主机的 URL，以及重定向，均会被拒绝。这是客户端防护措施，**不能证明容器出站流量已隔离**。在外部准备的 Docker 栈必须采用仅可访问模拟服务的网络配置。切勿将这些端口指向通过端口转发暴露的生产服务。使用全新的可丢弃数据卷，且不要并发运行其他测试。

默认源地址：

| 服务 | 源地址 | 运行器操作 |
|---|---|---|
| LiteLLM | `http://127.0.0.1:17505` | 就绪检查、目录身份验证、真实密钥 CRUD、推理 |
| Proxy | `http://127.0.0.1:17500` | 就绪检查、账号清单/目录、带版本的账号池设置、协调、释放本轮持有的租约 |
| SSO | `http://127.0.0.1:17501` | 健康检查及确认初始用户列表为空 |
| Mock | `http://127.0.0.1:17502` | 仅执行健康检查和经过身份验证的 `/test/state` 读取 |
| 真实 Login | `http://127.0.0.1:17503` | 健康检查和经过身份验证的任务列表读取；任务列表必须始终完全为空 |
| Console | `http://127.0.0.1:17504` | 仅执行健康检查；无需创建管理员或登录 |

## 命令与准备契约

**单独**准备并启动服务栈。在已复制这两个文件的仓库中运行：

```sh
node --check tests/docker-user-pool/gateway-smoke.mjs
node tests/docker-user-pool/gateway-smoke.mjs --help
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture
```

另起一次使用全新服务栈的运行，可以测试实时补充与首轮突发请求之间的竞争：

```sh
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture --pressure-mode live
```

服务栈必需配置：

- 真实 LiteLLM 及已连接的 Postgres 数据库。`/health/readiness` 必须返回 HTTP 200 和 `db: "connected"`。
- GHCP 模型组为 `claude-opus-5`，部署提供商为 `anthropic/claude-opus-5`，根地址为 `api_base: http://proxy:3000`，使用独立的 Proxy 服务密钥，并为该确切基地址配置身份回调。
- 禁用推理响应缓存、主模型组上的重试/回退，以及相互冲突的身份/URL 回调。主要成功调用每次都必须产生**恰好一次**带标记的模拟推理。不要启用按密钥或按请求设置的端点或凭据覆盖。
- Proxy 采用 `caller-lease` 模式，初始设置为 `READY_IDLE_TARGET=0`，账号清单为空，且没有租约。SSO 和模拟服务也必须为空。运行器会设置 `idle_target=5`、`max_accounts=20`、`lease_seconds=3600`，并在后续切换 `paused`。使用较长的 TTL 是为了有意将租约过期排除在压力测试结果之外；整个活动测试阶段的时限为 15 分钟。
- 模拟服务同时公布原始模型名 `claude-opus-5` 和旧版原始模型名 `claude-opus-5.2`，接受前者用于推理，返回 `OK`，并保留 `POOL_TEST:{"id":"..."}` 请求标记。Proxy 目录必须包含 `claude-opus-5` 和规范化的旧版模型名 `claude-opus-5-2`，而不是原始模型名 `claude-opus-5.2`。
- 将模拟服务的 SCIM/席位阶段延迟设为约 **150 ms**，有助于观察工作进程并发情况。正确性依据观察到的状态/计数器，而不是假定的精确延迟、精确并发峰值或定时休眠。
- 真实 Login 必须全程保持**零任务**。Proxy 账号池工作进程的 Login 基地址必须指向模拟服务。
- 目标仓库现有的 `.gitignore` 规则 `/tests/docker-user-pool/local-*.json` 覆盖该报告。用于独立编写的工作树可能没有这条尚未提交的忽略规则：执行前请先复制到共享目标仓库，或由协调负责人确保报告已被忽略。本实现不修改 `.gitignore`。

密钥仅从环境变量读取，不通过 CLI 参数读取：

| 变量 | 本地测试默认值 |
|---|---|
| `GATEWAY_MASTER_KEY` | `sk-local-gateway-master-test-only` |
| `GATEWAY_PROXY_KEY` | `local-pool-proxy-test-only` |
| `GATEWAY_INTERNAL_TOKEN` | `local-pool-internal-test-only` |

非敏感 CLI 选项也接受通过 `GATEWAY_<UPPER_SNAKE_CASE_FLAG>` 设置，例如 `GATEWAY_LITELLM_URL`、`GATEWAY_WAIT_MS`。CLI 值优先。`--help` 列出了支持的调节选项；主要选项包括 `--initial-idle`、`--cap`、`--burst`、`--wait-ms`、`--request-ms`、`--poll-ms`、`--retry-rounds` 和 `--pressure-mode paused|live`。要求 `initial-idle >= 4`、`initial-idle < cap` 且 `burst == cap`。最小值为四，是为了在三个功能测试调用方占用账号后仍有空闲供给，从而使无效/已撤销密钥测试有实际意义。默认值仍为五/二十/二十。

模型协调使用显式选项，绝不虚构部署名称：

```sh
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture \
  --model claude-opus-5 --raw-model claude-opus-5 \
  --legacy-model claude-opus-5-2 --legacy-raw-model claude-opus-5.2
```

- `--other-only-model <configured-other-group>` 创建一个允许模型**仅**包含该组的密钥，然后断言两种 GHCP 入站协议都会在使用任何租约/上游之前将其拒绝。它并不声称验证了其他提供商的推理或出站请求头生命周期。
- `--fallback-model <configured-fallback-into-ghcp-group>` 授予现有密钥访问权限，并通过 Chat 请求该组，然后检查最终 GHCP 尝试是否使用相同的可信哈希/成员。测试夹具必须保证主调用确定性失败，然后转入 GHCP。此测试证明最终 GHCP 身份，**但其本身不能证明第一段调用失败**；若要扩展该断言，须先就主提供商的测试夹具计数器另行约定契约。
- 未提供某个选项时，对应场景会明确标为 `SKIP`，而不是暗示通过。此运行器不提供从 GHCP 回退到其他提供商的验证认证。

## 已实现的场景与验收标准

### 1. 本地测试夹具与密钥管理契约

1. 按条件轮询健康/就绪状态；断言数据库已连接、`fixture: true`、Proxy 账号清单/租约为空、SSO 用户为空、模拟服务的用户/席位/任务/推理为空、没有待处理的故障控制，且真实 Login 任务数为零。遇到脏状态时拒绝运行，而不是将其重置。
2. 使用当前 `expectedVersion` 对账号池设置发起 PATCH。断言版本递增，且每项设置都被正确回显。轮询直到恰好达到配置的空闲目标数量，且这些账号均已完全就绪、通过验证、OAuth 有效并不再处于预配中状态；在功能测试用例开始前暂停补充。
3. 检查账号清单中的每个账号都对应一次 SCIM 创建、席位分配、模拟 OAuth 任务和成功回调；SCIM 冲突/更新/删除以及失败回调的次数均为零。检查模拟用户名/任务的唯一性、模型发现、席位，以及与 Proxy 成员身份的精确对应关系。
4. 通过以主密钥认证的 `POST /key/generate` 生成各个密钥，传入 `key_alias`、`models`、`duration: "2h"`，以及**不含 `ghcp_identity`** 的测试元数据。要求返回的原始密钥互不相同。对确切的 UTF-8 原始密钥计算小写 SHA256，并在前面加上 `sha256:`。如果返回了 `token`，则要求它等于预期的数据库哈希。
5. 通过以主密钥认证的 `GET /key/info?key=<hash>` 读取每个密钥；不将原始密钥放入查询字符串/访问日志。要求存储的别名/模型权限/测试元数据符合预期，且除明确的投毒用例外不含 `ghcp_identity`。
6. 尝试使用重复的 `key_alias` 调用真实 `/key/generate`。如果允许，两个密钥必须分配到各自独立的调用方/成员。如果原版 LiteLLM 以可识别的 HTTP 400/409 别名唯一性错误拒绝重复，则将观察到的拒绝记为通过，同时**将必需的同别名隔离用例记为 `BLOCKED`**。随后使用具有唯一别名的第二个密钥继续执行独立用例。绝不修改 Postgres、通过未记录的途径更改别名，或将不同别名的结果误标为同别名验证。

### 2. 协议与动态租约行为

7. 使用合法调用方哈希直接对 Proxy 进行经过身份验证的目录发现，必须显示当前及规范化的旧版模型 ID，且**不创建租约**。推理本身仍然只通过 LiteLLM 进行。
8. 使用第一个真实虚拟密钥，调用 `/v1/messages` 的 JSON 和 SSE 模式并以 `x-api-key` 认证，再以 Bearer 重复这两种调用，然后以 Bearer 调用 `/v1/chat/completions` 的 JSON 和 SSE 模式：**六种必需组合**，每次推理均使用 `max_tokens: 16`。
9. JSON 必须具有正确的 Messages/Chat 封装结构、非空模型、`OK` 和终止原因。SSE 在有限时限和大小限制内完整读取；解析帧，要求有 Messages 的开始/终止事件，或 Chat 的结束原因及 `[DONE]`，拼接文本增量，并拒绝任何流内错误，即使 HTTP 为 200。旧版原始模型拼写不得泄漏到返回结果中。
10. 每次成功请求后，等待占用释放；要求在 `sha256(raw-key)` 下恰好有一个活动租约、有效的续期时间戳，以及匹配的账号 DTO。模拟服务中带标记的请求必须匹配该租约的成员、预期原始模型、流式模式、状态 200 及完整完成结果。普通请求必须恰好出现一次，以检测意外的推理重放。
11. 对同一个密钥同时发送八个请求，混合使用两条路由和各种流式模式。所有请求都必须保留最初的成员和租约 ID。第二个不同密钥的**首次分配**请求中包含伪造的受害者 HTTP 请求头和正文请求头，但仍必须选择其自身的不同成员。
12. 使用 `POST /key/update {key, key_alias}` 重命名第一个密钥；要求重命名后的别名已持久化，且后续推理中的确切原始密钥哈希、成员和租约 ID 均保持稳定。

### 3. 身份与认证攻击

13. 生成第三个密钥，使其存储的 `metadata.ghcp_identity` 指向受害者成员。它的首个请求仍必须按自身的确切原始密钥哈希获取租约，绝不能使用受害者。读取数据库元数据，证明投毒设置确实已持久化。
14. 分别在 Messages 和 Chat 上，独立测试每个伪造位置：入站 `X-User-Identity`、正文中大小写变体的 `headers`、`extra_headers`、`default_headers`、嵌套的 `extra_body`、`metadata`、`litellm_metadata`、`litellm_params`/`optional_params`、`provider_specific_header` 和 `proxy_server_request`。在元数据中加入伪造的哈希、别名，以及 `user_api_key_dict` 的令牌/哈希令牌数据。预期推理在可信密钥映射下成功；攻击被静默忽略是安全的，适配器错误则报告为覆盖失败的用例，成员/哈希发生变化则为失败。这些测试不会尝试可能逃逸测试夹具的 URL 或凭据覆盖攻击。
15. 在补充暂停且仍有空闲容量时，分别使用 Messages 的 x-api-key/Bearer 和 Chat 的 Bearer 发送未签发的密钥。要求返回 401/403、租约身份/续期快照逐字节保持不变、空闲数和总数不变，且没有新增模拟推理。
16. 生成一个有效但未使用的密钥，通过 `/v1/models` 对其进行身份验证，以预热网关缓存而不获取租约，然后通过 `POST /key/delete {keys:[<hash>]}` 撤销。要求响应确认删除。立即重复上述三种拒绝调用——不要轮询等待撤销最终生效。断言没有分配或上游派发。
17. 撤销一个**此前使用过的**密钥，并重复拒绝检查。其现有 Proxy 租约可以保留到过期/手动释放时，但不得被使用或续期。这将网关密钥撤销与 Proxy 租约回收区分开来。
18. 如果显式提供了仅限其他模型的组，则对被拒绝访问 GHCP 的受模型限制的真实密钥执行同样的不消耗资源断言。
19. 如果显式提供了回退组，则验证其最终 GHCP 调用段使用相同的哈希/成员，但受上述限制约束。

### 4. 公平的不同密钥压力测试与补充

20. 保持工作进程暂停，等待所有请求结束，**仅释放本轮运行的功能测试租约**，并按哈希撤销功能测试密钥。要求在压力测试前恢复原先五个就绪空闲账号，且没有租约。不要让准备阶段的调用方抢占突发容量，也不要通过提高上限来掩盖此问题。
21. 生成**二十个由数据库支持的全新且互不相同的虚拟密钥**，每个都不含身份元数据。在一轮 `Promise.allSettled` 中启动它们的推理 fetch 请求；混合使用 Messages/Chat 和 JSON/SSE。这一轮中不存在隐藏的 SDK 或运行器推理重试。
22. 默认暂停场景：要求恰好五个不同调用方成功、十五个调用方遇到耗尽，且突发期间不发生预配。**不要求**每个耗尽 HTTP 响应都恰好为 429：LiteLLM 可能转换传输状态。候选响应必须为包含已知 `pool_exhausted` 代码的非 2xx，且没有租约、没有模拟标记。报告观察到的状态分布直方图。未知的身份验证/适配器/限流/传输错误均为失败，而不是可重试的耗尽。
23. 实时首轮突发模式：允许预配在请求期间完成。要求成功数不得超过初始空闲供给**加上截至该轮结束时观察到的、新验证通过的就绪成员数**。在所有抽样账号清单中断言唯一性和容量上限。当工作进程可能抢先完成时，不要声称恰好有十五次拒绝。
24. 取消工作进程暂停，**不发送推理请求**，轮询实际就绪空闲账号清单，直到目标恢复，或物理上可用的剩余容量已就绪。验证预配活动已全部结束。这证明的是自主补充，而不是由请求触发的预配。
25. 仅重试之前已确认耗尽的密钥；绝不重新发送成功密钥的请求来改善计数。每轮重试都同时发起，轮数有限（`--retry-rounds`，默认 20），重新对照确切租约/模拟身份进行检查，并且可能再次产生实测的耗尽。不重试任意状态错误或传输失败。
26. 要求全部二十个密钥最终都有成功映射，恰好有二十个不同的活动租约和成员，临时/失败/预配中条目均为零，且每次总览观察都满足 `total <= cap`。保存假名化的密钥标签/哈希/成员/租约映射、各轮计数/状态，以及观察到的最大总数。在二十个活动调用方且上限为二十时，空闲数为零是正确状态，而不是补充失败。
27. 生成第二十一个真实密钥，要求确认耗尽，且没有上游请求或账号增加。在达到上限时执行一次协调，并重新检查预配计数器；运行器不会放宽上限。
28. 释放五个本轮持有的压力测试租约。要求在总量仍处于同一上限时恢复五个就绪空闲账号，保留密钥的映射不变，且没有新增 SCIM/席位/OAuth 预配。这是容量复用，与步骤 24 的自主创建分别标注。
29. 断言最终模拟计数器/唯一性符合预期，Proxy 账号清单或模拟状态中没有原始密钥或 OAuth 令牌，且真实 Login 任务数为零。

## 输出、失败行为与清理

- 控制台输出行带有 `PASS`、`FAIL`、`BLOCKED`、`SKIP`，以及仅含数值的 `OBSERVED` 突发直方图。所有 API 正文、提示词、请求头、Cookie 和任意远程错误文本均不打印。
- `tests/docker-user-pool/local-gateway-results.json` 写在脚本旁，在支持的平台上使用 `0600` 权限。它包含标签、耗时、明确的限制、安全的计数/状态、有界观察记录和假名化的租约映射——**绝不包含原始虚拟密钥、服务凭据或响应正文**。每个获取到的原始密钥都会向脱敏器登记。哈希虽然无法直接用于身份验证，但仍属于敏感的假名化 ID。
- 运行时失败会生成结构化报告，并仍尝试暂停可丢弃环境中的工作进程，撤销所有已知的已生成密钥。关键契约失败后，依赖它的阶段会停止；其他独立的功能攻击测试会继续，以暴露多个失败。任何 catch 块都不会插入任意 fetch/错误正文。
- 退出码 **0** 表示所有必需场景通过；**1** 表示至少有一个失败；**2** 表示某个必需用例受阻（目前为禁止重复别名），且没有其他失败。缺少可选组时会明确跳过，不会导致失败。
- 清理不会销毁账号/SSO 用户、操作 Docker 或释放未知调用方。它会暂停预配、撤销本轮持有的密钥，并再次检查真实 Login。压力测试成功创建的账号和剩余租约证据会有意保留以供检查；再次运行前，须在外部销毁可丢弃数据卷。脏状态下的重跑会被拒绝。
- 请求正文（包括 SSE）受 4 MiB 和 `--request-ms` 限制；就绪/补充/占用等待均基于条件并设有时限。SIGINT/SIGTERM 以及 15 分钟活动运行时限会中止 fetch 请求，并进入有界清理流程。绝不打印原始响应错误。SIGKILL/进程崩溃无法保证清理；请在外部销毁可丢弃环境。

## 已验证的源码契约与待协调缺口

### 当前 Proxy 与测试夹具源码

- `src/proxy/src/routes/userPoolApi.ts`：GET `/api/user-pool` 字段为 `enabled`、`poolId`、`settings`、`counts`、`accounts`、`leases`、`events`；PATCH `/settings` 的正文为 `{expectedVersion,changes}`；paused 为数值 0/1；POST `/leases/:leaseId/release` 要求 `{confirm:true}`；POST `/reconcile` 使用 `{}` 并返回 202。
- 使用的计数字段为 `total`、`ready_idle`、`leased`、`provisional`、`provisioning`、`cooling`、`failed`、`disabled`。账号字段包括 `identity`、`ordinal`、`state`、`ghLogin`、`oauthStatus`、`verifiedAt`、`callerKeyHash`、`leasePhase` 和 `activeRequests`。租约字段包括 `leaseId`、`memberIdentity`、`callerKeyHash`、`phase`、`lastSuccessAt`、`expiresAt` 和 `inUse`。
- `tests/docker-user-pool/mock-services.mjs`：`/test/state` 需要 `X-Internal-Token`；计数器、推理 `marker/identity/model/status/stream/outcome`、用户、席位、任务和 `fixture` 均与运行器匹配。**编写时，它只公布原始模型名 `claude-opus-5.2`**。负责协调的模拟服务负责人必须添加原始模型名 `claude-opus-5`，同时保留旧版 5.2。如果缺少必需的测试夹具模型契约，此运行器会有意失败；它不会改用真实上游。
- `src/login/src/routes/tasksApi.ts`：GET `/api/tasks?page=1&pageSize=100` 返回 `{items,total,...}`。不会发起可执行任务的 Login 调用。

### 原版 LiteLLM API

已检查公开标签 `v1.94.2` 的源码：

- [`key_management_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.94.2/litellm/proxy/management_endpoints/key_management_endpoints.py)：`generate_key_fn` / `_common_key_generation_helper`；POST `/key/generate` 返回 `key`（原始密钥），并可能返回 `token`（数据库哈希）。`key_alias` 是显示别名，而不是用于模型重映射的 `aliases` 对象。
- 同一文件：POST `/key/update` 接受 `{key,key_alias}`；GET `/key/info` 通过 `_hash_token_if_needed` 接受原始或哈希密钥，加载数据库行，并在较新的代码中移除 `info.token`。因此运行器从不依赖 `info.token` 的存在。
- 同一文件中的 `delete_key_fn`：POST `/key/delete` 接受包含原始密钥**或哈希**的 `keys`，并返回 `deleted_keys`。运行器始终按哈希删除，而不是使用有歧义的重复别名。
- 同一文件中的 `_enforce_unique_key_alias`：重复的非 null 别名会抛出 HTTP 400，并附带别名唯一性消息。所检查的实现**没有关闭唯一性检查的开关**。因此，对于此原版版本，所要求的同别名测试属于兼容性阻塞项，而不是修改数据库行或削弱身份验证的理由。仍会测试实际运行时行为，而不是根据源码作出假定。
- [`_health_endpoints.py`](https://github.com/BerriAI/litellm/blob/v1.94.2/litellm/proxy/health_endpoints/_health_endpoints.py)：`/health/readiness` 暴露最少的 `status`/`db` 信息；要求数据库已连接。不要改用 `/health` 模型探测。
- [虚拟密钥文档](https://docs.litellm.ai/docs/proxy/virtual_keys)提供 CRUD 用法；确切的运行时响应仍通过断言验证，并以安全方式报告失败。

### 在真实网关运行前明确尚未证实的事项

1. 原生 `/v1/messages`（x-api-key 和 Bearer）必须在实际选定的 LiteLLM 版本上经过早期已认证钩子和最终 Anthropic 部署钩子。项目现有的线路测试仅验证了注入认证的 Chat 路径；此处的失败是真实的路由/生命周期缺口，而不是让运行器另走回退路径的机会。
2. `db: connected` 加上原版密钥 CRUD 证明了由数据库支持的身份验证，但不能独立证明数据库引擎为 Postgres、重启持久性、迁移、费用结算，或多个网关副本之间的缓存行为。Compose 负责人必须确定引擎/网络拓扑；重启/记账测试需要单独的契约。
3. 回退的主尝试计数器、向外回退的请求头作用域，以及其他提供商的成功/无变更检查，需要明确的非 GHCP 模拟 API/计数器契约。目前仅通过可选参数实现了最终 GHCP 身份和模型权限拒绝检查。
4. 网关和基础设施**日志**不在 Node 脱敏器的覆盖范围内。保持 LiteLLM 调试关闭，并限制/脱敏管理和请求日志。运行器在 URL 和删除正文中使用哈希，但无法保证上游对生成/更新响应的日志记录是安全的。
5. 工作进程各阶段的并发观察结果只作报告，不会断言其等于猜测的工作进程限制。精确的工作进程并行度、崩溃恢复，以及真实 SAML/SCIM/Copilot 验收仍属于独立测试。
