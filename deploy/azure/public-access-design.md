# 公网访问开关：设计与取舍

适用：GHCP Proxy 多企业版 `multi-f43f27e-amd64-r3` 的 Azure 部署（本目录）。实现：`infra/main.bicep` 的 `publicAccess` 参数、`infra/modules/app-gateway.bicep`、`infra/modules/waf-policy.bicep`，以及渲染脚本对 `SSO_PUBLIC_BASE_URL` / `CONSOLE_PUBLIC_BASE_URL` 的处理。

**默认仍然是仅内网**：`publicAccess` 的四个端点开关（`sso`、`console`、`litellm`、`proxy`）都是 `false`，不创建 Application Gateway、公网 IP 和 WAF 策略。

## 1. 结论

| 端点 | 能否对外 | 方式 | 默认来源限制 |
| --- | --- | --- | --- |
| SSO 的 SAML 页面 | **通常不需要对外**（第 2.1 节）；`publicAccess.sso` 只用于少见情况：公司网络 / VPN 之外的人必须经本 IdP 登录 EMU 企业 | App GW WAF_v2 → SSO 内部负载均衡 | 只放行 `allowedSourceCidrs` + VNet；`ssoAllowAnySource: true` 才对任意来源开放 |
| Console | 可以（`publicAccess.console`），仅管理员 | 同上 | 只放行 `allowedSourceCidrs` + VNet；**没有**“任意来源”选项 |
| LiteLLM | 可以（`publicAccess.litellm`） | App GW WAF_v2 → LiteLLM 内部负载均衡；只放行推理路径 | 只放行 `litellmAllowedSourceCidrs`（或 `allowedSourceCidrs`）+ VNet；`litellmAllowAnySource: true` 才放开 |
| Proxy | **默认不开放，也不推荐**；`publicAccess.proxy`（默认 `false`）只用于 LiteLLM 在另一个网络、且无法用 Private Link / VNet 对等 / VPN 互联的情况 | App GW WAF_v2 → Proxy 内部负载均衡；只放行公开的推理路径；建议 App GW mutual TLS | **必须**给出 `proxyAllowedSourceCidrs`（只填 LiteLLM 出口 IP）；没有“任意来源”选项 |

推荐方案：**由 Bicep 完整管理的 Application Gateway WAF_v2，后端是 AKS 内部负载均衡**（第 3 节方案 C）。开发者在 VNet 外时开放 LiteLLM，而不是 Proxy（第 4 节）。

## 2. 每个端点由谁访问

| 端点 | 谁访问 | 说明 |
| --- | --- | --- |
| SSO `/sso`、`/metadata`、`/login`、`/logout`（`default` 企业在根路径，其他企业在 `/enterprises/<id>/...`） | Login Pod 内的无头 Chromium（集群内）；内网 / VPN 中管理员的浏览器 | 见第 2.1 节。SSO 的 WAF 只会看到 `GET /sso?SAMLRequest=...&RelayState=...`、登录表单 `POST /login` 和 `/metadata`。 |
| SSO `/api/...`、`/internal/...` | Proxy、Console、Login（集群内 Service） | 内部管理接口（`INTERNAL_API_TOKEN`），永远不经 App GW：WAF 先按路径允许列表拦截，再显式拦截这两个前缀。 |
| Console | 管理员 | 初始化前第一个打开 Console 的人可以创建管理员，所以**先用 `kubectl port-forward` 初始化，再开放**（README 第 6 节）。只允许管理网段。 |
| Proxy | LiteLLM（服务端调用） | 见第 4 节，不对外。 |
| LiteLLM | 开发者工具、内部应用 | 用 LiteLLM virtual key 认证，身份 Hook 由 key hash 生成 `X-User-Identity`。 |

### 2.1 SSO 通常不需要公网（已按代码核对）

账号池模式下，SAML 登录由 Login Pod 内的无头 Chromium 完成：

1. Login 打开 GitHub 的设备授权 / 登录页（`login/src/auth/HeadlessPlaywrightAuthStrategy.ts`）；GitHub 识别出 EMU 账号后，把**这个集群内的浏览器**重定向到 IdP 的 Sign on URL（`GET <SSO_PUBLIC_BASE_URL>/sso?SAMLRequest=...`，HTTP-Redirect 绑定）。
2. 浏览器在 SSO 的登录页（`<SSO_PUBLIC_BASE_URL>/login`，即 Login 的 `SSO_URL`；Login 只在允许的登录 URL 上填写密码）提交池用户的密码。
3. SSO 返回一个自动提交的表单，把 `SAMLResponse` 经同一个浏览器 **POST 到 GitHub 的 ACS**（`sso/src/routes/samlRoutes.ts` 中 `<form method="post" action="${acsUrl}">`，HTTP-POST 绑定）。

因此：

- **GitHub 服务端从不连接 SSO**（没有服务器到服务器的 SAML 调用）；SCIM 是 SSO **出站**调用 GitHub API（`sso/src/scim/scimClient.ts`，`SCIM_BASE_URL` → `api.github.com` 或 `api.<子域>.ghe.com`），经 NAT 出口；
- SAML 元数据与签名证书是**在 GitHub 的 SAML 设置中粘贴**的（Sign on URL、Issuer、公钥证书），GitHub 不会来抓取 `/metadata`；
- SSO 只需要被两类浏览器访问到：**Login Pod**（`SSO_PUBLIC_BASE_URL` 在集群内可解析：内部负载均衡 IP、内网 DNS 或 `hostAliases`）；以及**内网 / VPN 中管理员的浏览器**——配置或测试 GitHub SAML 时，或某个 EMU 用户（例如设置企业用的首个管理员）在 GitHub 网页上登录时，GitHub 会把这个人的浏览器重定向到 SSO。

`SSO_PUBLIC_BASE_URL` 名字里虽然有 PUBLIC，要求只是这两类浏览器都能访问且同源（`guidance/network-deployment.md` 第 1、2 节）。纯集群内地址（`http://ghcp-sso.<namespace>.svc.cluster.local:7001`）Login 能用，但管理员的浏览器打不开，所以默认用 SSO 的内部负载均衡地址。**`publicAccess.sso` 只用于少见情况**：公司网络 / VPN 之外的人必须经本 IdP 登录 EMU 企业（例如没有 VPN 的外部管理员）。与代码核对时没有发现与上述描述不一致之处；补充一点：除 `/sso`、`/login` 外，管理员浏览器也会访问 `/logout`，其他企业的路径在 `/enterprises/<id>/` 下，这些都已在 WAF 路径允许列表中。

## 3. 方案比较

| 维度 | A. App GW WAF_v2 + AGIC | B. Application Gateway for Containers（AGC）+ WAF | **C. App GW WAF_v2（Bicep）→ 内部负载均衡** | D. Front Door Premium + Private Link | E. 公网 LoadBalancer Service |
| --- | --- | --- | --- | --- | --- |
| WAF（OWASP / 托管规则） | 有 | 有（AGC 的 WAF 策略） | 有（DRS 2.1 + Bot Manager） | 有（Front Door WAF） | **无** |
| 按路径放行 / 拦截 | Ingress 路径 + WAF 自定义规则 | HTTPRoute + WAF | WAF 自定义规则（本模板使用） | 路由规则 + WAF | **无**（四层） |
| 后端保持私有 | 是（直接到 Pod / Service） | 是（关联子网） | 是（内部负载均衡 IP） | 是（Private Link Service → 内部负载均衡） | 否 |
| 600 秒推理与 SSE | 后端超时可配，关闭响应缓冲 | 支持 SSE；超时按其文档 | `requestTimeout` 最大 86400 秒；关闭响应缓冲；公网 IP 空闲超时 4–30 分钟 | **源站响应超时上限 240 秒**（Front Door 限制文档），无法覆盖 600 秒非流式推理；HTTP keep-alive 90 秒 | 取决于应用 |
| TLS 证书 | Key Vault | Key Vault / Secret | Key Vault（版本无关 URI，自动轮换） | 托管证书或 Key Vault | 只能在应用内终止，四个服务都只监听 HTTP |
| 谁管理配置 | AGIC 控制器改写整个 App GW；Bicep 再部署会与它冲突（漂移） | ALB Controller（集群内）+ Gateway API 资源 | **全部在 Bicep 中**，一次 `azd provision` 生效，可审查 | Bicep；配置全球下发约 15 分钟 | Service 注解 |
| 对集群的依赖 | 需要在集群中运行控制器 | 需要 ALB Controller、委派子网 | 只需要内部负载均衡 Service（已在组件中） | 需要 Private Link Service 注解 | 无 |
| VNet 内客户端（Login） | 可加私网前端 | 以 AGC 文档为准 | 私网前端与公网前端共用 443 和主机名 | 需要另外的内网入口 | — |
| 复用 LiteLLM 集群 / VNet | 一个 App GW 只能由一个 AGIC 管理 | 可共用 | 可共用，后端地址显式配置 | 可共用 | — |
| 地域可用性 | 广泛 | 有限的地域列表（见其 overview） | 广泛 | 全球服务；世纪互联运营的 Azure 中国不提供 Standard / Premium（以官方为准） | 广泛 |
| 固定成本量级 | App GW WAF_v2 | AGC + WAF | App GW WAF_v2 | Front Door Premium 基础费 + WAF | 极低 |

取舍：

- **C 胜出的原因**：三个固定主机名的入口，不需要 Ingress / Gateway API 的动态路由；全部配置在 Bicep 中可审查、可重放；`requestTimeout`、公网 IP 空闲超时、响应缓冲都能满足 600 秒推理和 SSE；同一个 App GW 的私网前端还能让 Login 的 Chromium 用对外主机名访问 SSO（同源要求）。
- **不选 A（AGIC）**：AGIC 会按集群 Ingress 改写 App GW 的整份配置，和 Bicep 管理的监听器、WAF 策略、证书互相覆盖；微软新的容器入口功能集中在 AGC。
- **不选 B（AGC）**：功能上可行（WAF、SSE、Gateway API），但需要在集群内运行 ALB Controller 并维护 Gateway / HTTPRoute 资源，配置分散在 Bicep 和集群两处；地域列表有限；与 LiteLLM 共用时还要协调同一个控制器。客户已有 AGC 平台时可以评估迁移，WAF 规则（第 5 节）可以照搬。
- **不选 D（Front Door）作为默认**：240 秒的源站响应超时不能覆盖非流式推理的 600 秒上限（`POOL_INFERENCE_TIMEOUT_SECONDS`）；只开放 SSO / Console 且用户分布在全球时，Front Door 是合理的替代（它的 WAF 同样支持本文的自定义规则），但要另外解决 Login 的内网访问路径。
- **不选 E**：没有 WAF、没有路径过滤、应用只监听 HTTP，等于把内部管理接口直接放到公网。

## 4. Proxy：为什么默认不开放，必须跨网络时怎么做

### 4.1 Proxy 的认证模型

Proxy 的业务接口先校验调用方，再信任身份头（`src/proxy/src/server.ts` 中 `requireApiKey` → `requireIdentityHeader`）：

1. `requireApiKey`（`src/proxy/src/auth/apiKey.ts`）：请求必须带**共享的** `API_KEY`，写在 `Authorization: Bearer <key>` 或 `x-api-key: <key>` 中（LiteLLM 侧是 `GHCP_PROXY_API_KEY`），否则 401。比较是普通的字符串不等（`!==`），不是常量时间比较。
2. 之后 Proxy **信任** `X-User-Identity`（`IDENTITY_HEADER`，默认必填）作为调用方身份，按它分配排他租约和池账号（`docs/user-pool-litellm.md` 第 1 节）：

```http
Authorization: Bearer <独立Proxy服务密钥>
X-User-Identity: sha256:<鉴权确认的64位小写hex hash>
```

所以真实的风险模型是：**持有这一个共享 API key 的任何人，都可以冒用任意用户身份**——填写别人的 `sha256:<hash>` 就会拿到别人的租约和池账号、消耗企业的 Copilot 席位与额度，审计记录也会记到被冒用者名下。没有按调用方区分的凭据，没有 mTLS，也没有来源绑定。LiteLLM 的身份 Hook 正是这条信任链的另一半：只认服务端标记为业务 virtual key 的认证结果，清理请求中所有伪造的身份头，再注入真实的 key hash（`docs/user-pool-litellm.md` 第 2、4 节）。另外，业务接口（`/v1/messages`、`/v1/messages/count_tokens`、`/chat/completions`、`/responses`、`/v1/models`）与内部管理接口（`/api/...`、`/internal/...`，由 `INTERNAL_API_TOKEN` 保护）、健康检查（`/healthz`、`/readyz`）在**同一个端口**。

### 4.2 默认与推荐：不开放 Proxy，开放 LiteLLM

- `publicAccess.proxy` 默认 `false`；Proxy 只在集群内（ClusterIP）提供服务。
- **开发者在 VNet 外**：开放 **LiteLLM**（`publicAccess.litellm`）。LiteLLM 有按用户的 virtual key、预算、模型权限与审计；App GW 还会删除外部请求携带的 `X-User-Identity`（纵深防御）。
- **LiteLLM 与 GHCP 在同一个 AKS 集群**（复用 AKS）：`http://ghcp-proxy.<namespace>.svc.cluster.local:3000`，并启用 NetworkPolicy 只放行 LiteLLM 的 namespace / Pod（README 第 6 节第 4 步）。

### 4.3 Proxy 必须跨网络边界时（例如 LiteLLM 在另一个 VNet 或另一朵云）

按优先顺序：

1. **私网互联**：Private Link（Proxy 内部负载均衡 + Private Link Service，需另行配置）、VNet 对等或 VPN / ExpressRoute。LiteLLM 经 `components/azure-proxy-ilb` 的内部负载均衡访问 Proxy，来源只放行 LiteLLM 节点子网（`GHCP_PROXY_ILB=true`、`GHCP_PROXY_ILB_ALLOWED_CIDRS`）。
2. **只能走公网时**，打开 `publicAccess.proxy`，模板同时强制 / 提供以下控制：
   - **来源允许列表**：`proxyAllowedSourceCidrs` 必填，只填 LiteLLM 的出口 IP（preprovision 对宽于 `/28` 的网段给出警告），VNet 之外的其他来源一律拦截；没有“任意来源”选项（为空时 WAF 只放行 VNet，相当于不对外）。
   - **路径允许列表**：只放行公开的推理路径 `/v1/messages`（含 `/v1/messages/count_tokens`）、`/chat/completions`、`/responses`、`/v1/models`，其余（`/api/*`、`/internal/*`、`/healthz`、`/readyz` 等）全部拦截，`/api`、`/internal` 另有一条显式拦截规则。
   - **TLS**：App GW 终止 TLS（Key Vault 证书）。**建议同时启用 App GW mutual TLS**：在 `proxyClientCaCertificate` 中给出签发 LiteLLM 客户端证书的 CA（公开证书），Proxy 的两个监听器使用 `mutual-tls` SSL 配置，没有该 CA 签发的客户端证书时 TLS 握手直接失败（在 API key 之前多一道与网络位置无关的凭据）。需要确认 LiteLLM 所用版本能为这个 deployment 配置客户端证书；不能时可以在 LiteLLM 出口加一个负责 mTLS 的转发代理。
   - **API key**：`API_KEY` 由部署生成（48 字节随机数，`ghcp-proxy-api-key`），只保存在 Key Vault；按固定周期轮换（README 第 6 节第 6 步：写入新值 → 同时更新 LiteLLM 的 `GHCP_PROXY_API_KEY` → 重启 Proxy；Proxy 只接受一个 key，轮换期间有短暂的失败窗口，应安排在低峰期）。
   - 请求体不做托管规则检查（提示词误报，同 LiteLLM），`X-User-Identity` **不**被删除（Proxy 需要它）。
3. 即使做到以上全部，**来自 LiteLLM 的身份头仍然无法被 Proxy 独立验证**：任何能以 LiteLLM 的出口 IP + 客户端证书 + API key 发起请求的一方都能冒用身份。因此这只是“缩小持有凭据的范围”，不是根本解决。

### 4.4 产品层面的加固方向（未实现，供后续版本评估）

- **签名的身份头**：LiteLLM 身份 Hook 用共享密钥对 `X-User-Identity` + 时间戳（+ 请求方法、路径）做 HMAC 签名，Proxy 校验签名和时间窗口，拒绝重放；泄露 `API_KEY` 不再等于可以冒用身份。
- **按 LiteLLM 实例区分的 key**：Proxy 接受多个 key，并记录每个请求用的是哪个 key；单个实例泄露时只吊销它，也支持无中断轮换。
- **常量时间比较**：`requireApiKey` 改用 `crypto.timingSafeEqual`（先比较长度），消除计时侧信道。

## 5. WAF 策略

每个对外端点一个 WAF 策略（挂在该端点的两个监听器上），托管规则 **Microsoft_DefaultRuleSet 2.1**（OWASP CRS 3.3 系）+ **Microsoft_BotManagerRuleSet 1.1**，默认 `Prevention`。首次开启可以把 `publicAccess.wafMode` 设为 `Detection` 观察一段时间（日志在 Log Analytics 的 `AGWFirewallLogs` / `AzureDiagnostics`），确认没有误报后切回 `Prevention`。

| 端点 | 自定义规则（优先级） | 托管规则排除项 | 请求体检查 |
| --- | --- | --- | --- |
| SSO | 10：来源不在允许列表则拦截（`ssoAllowAnySource` 时省略）；20：路径不以 `/sso`、`/metadata`、`/login`、`/logout`、`/enterprises/` 开头则拦截；30：`/api`、`/internal` 开头拦截；40：同一来源每分钟 `POST .../login` 超过 60 次拦截（限速，防暴力破解） | 参数名 `SAMLRequest`、`RelayState`、`SigAlg`、`Signature`（deflate + base64 的任意字符）、`password` | 开，128 KB |
| Console | 10：来源允许列表（不可省略）；40：登录限速（30 次/分钟） | `password`、`currentPassword`、`newPassword` | 开，1 MB（CSV / JSON 导入） |
| LiteLLM | 10：来源允许列表（`litellmAllowAnySource` 时省略）；20：路径不在推理允许列表则拦截（默认 `/v1/`、`/chat/completions`、`/completions`、`/embeddings`、`/responses`、`/messages`、`/models`、`/health/liveliness`；LiteLLM 管理界面 `/ui`、`/key/*`、`/user/*`、`/team/*`、`/model/*` 等不对外） | — | **关**：提示词中大量代码、SQL、HTML 片段会大面积误报，且常超过 WAF 的检查上限；托管规则仍检查 URI、查询参数和请求头 |
| Proxy（默认关闭） | 10：来源只允许 `proxyAllowedSourceCidrs` + VNet（不可省略）；20：路径不以 `/v1/messages`、`/chat/completions`、`/responses`、`/v1/models` 开头则拦截；30：`/api`、`/internal` 开头拦截。可选 mutual TLS（第 4.3 节） | — | 关（同 LiteLLM） |

- 路径匹配先 `UrlDecode` 再 `Lowercase`（Express 路由默认不区分大小写，`%2F` 等编码不能绕过）。
- 来源判断使用 `RemoteAddr`（TCP 对端），不使用可伪造的 `X-Forwarded-For`。VNet 地址空间总是在允许列表中（Login 的 Chromium、VNet 内的管理员经私网前端访问）。
- 响应头改写：所有端点加 `Strict-Transport-Security`、去掉 `X-Powered-By`；LiteLLM 端点额外删除请求头 `X-User-Identity`（Proxy 端点不删，Proxy 需要它）。
- SSE：WAF 只检查请求，不检查流式响应；App GW 的响应缓冲已关闭，事件逐块转发。
- 遇到误报时优先加**精确的排除项**（某个参数名对某条规则），不要把整个策略切到 `Detection`。

## 6. TLS 证书

- 证书存放在本部署的 Key Vault：证书对象（推荐，可配合 Key Vault 的自动续期）或 `contentType` 为 `application/x-pkcs12` 的机密（不带密码的 PFX，base64）。默认名称 `ghcp-public-tls`，多个端点可以共用一张 SAN / 通配符证书，也可以在 `publicAccess.certificateNames` 中分别指定。
- App GW 使用自己的用户分配托管标识（`id-<环境>-appgw`，Key Vault Secrets User）经私有终结点读取证书；引用的是**版本无关**的机密 URI，Key Vault 中更新证书后 App GW 在其轮询周期内自动换用。
- **开启开关之前证书必须已经在 Key Vault 中**，否则 App GW 创建失败。角色分配刚创建时可能还没生效，首次部署偶尔需要重跑一次 `azd provision`。
- TLS 策略 `AppGwSslPolicy20220101S`（TLS 1.2 起）；监听器要求 SNI。App GW 到后端是 VNet 内的 HTTP（四个服务都只监听 HTTP）。要求端到端 TLS 时需要在后端前加 TLS 终止（例如 sidecar），不在本模板范围内。

## 7. 超时与长连接

| 环节 | 设置 | 原因 |
| --- | --- | --- |
| Proxy → Copilot | `POOL_INFERENCE_TIMEOUT_SECONDS` 最大 600（可选；不进入指纹） | 推理请求上限 |
| App GW 后端 `requestTimeout` | SSO 60 秒、Console 120 秒、**LiteLLM / Proxy 900 秒** | 覆盖 600 秒推理 + LiteLLM 自身开销 |
| App GW 公网 IP TCP 空闲超时 | 15 分钟（参数 `GHCP_APPGW_IDLE_TIMEOUT_MINUTES`，4–30） | 非流式请求在完成前没有任何字节；默认 4 分钟会切断 |
| 内部负载均衡（AKS `LoadBalancer` Service）TCP 空闲超时 | Proxy 内部负载均衡 15 分钟（注解 `service.beta.kubernetes.io/azure-load-balancer-tcp-idle-timeout: "15"`，`components/azure-proxy-ilb`）；**LiteLLM 的内部负载均衡由 LiteLLM 部署管理，需要加同样的注解** | Azure 负载均衡规则默认 4 分钟并发送 TCP RST。实测：没有这个注解时，经 App GW 的 300 秒非流式请求在 268 秒被重置，App GW 返回 502（SSE 不受影响，流中持续有数据） |
| App GW HTTP/2 | **关闭** | App GW v2 前端的 HTTP/2 连接空闲超时固定 180 秒、不可配置（App GW FAQ） |
| App GW 私网前端 | TCP 空闲超时固定 5 分钟、不可配置（App GW FAQ） | VNet 内的长时间非流式调用应直接用 LiteLLM 自己的内部负载均衡，不经 App GW 私网前端 |
| App GW 响应缓冲 | 关闭（`enableResponseBuffering: false`） | SSE 逐块转发；WAF_v2 的请求缓冲无法关闭（WAF 需要完整请求） |
| NAT Gateway 空闲超时 | 15 分钟 | Proxy 到 Copilot 的出站连接同样可能长时间无数据 |
| 连接排空 | App GW 后端设置 60 秒 | 与 Pod 的 `terminationGracePeriodSeconds: 45` 配合，滚动更新时不截断进行中的请求 |

## 8. 对外地址：`SSO_PUBLIC_BASE_URL` 与 `CONSOLE_PUBLIC_BASE_URL`

- 渲染脚本按开关设置：
  - SSO 对外时 `SSO_PUBLIC_BASE_URL=https://<SSO 主机名>`；仅内网时 `http://<SSO 内部负载均衡 IP>:7001`；`GHCP_SSO_PUBLIC_BASE_URL` 可以显式覆盖（例如内网 DNS 名）。SSO 的 `BASE_URL` 与 Login 的 `SSO_URL` 都由它生成（base 已保证同源）。
  - Console 对外时 `CONSOLE_PUBLIC_BASE_URL=https://<Console 主机名>`（Console 的写操作只接受同源请求）；仅内网时为空。
- **Login 必须能访问同一个地址**：SSO 对外时，渲染脚本给 Login Pod 加 `hostAliases`，把 SSO 主机名解析到 App GW 的私网前端（不依赖 VNet 的 DNS 设置）；同时（默认）为每个对外主机名创建一个只在 VNet 内生效的私有 DNS 区域（split-horizon），VNet 内的其他客户端也走私网前端。启用 NetworkPolicy 时另加 Login → App GW 私网前端 443 的放行。
- **`SSO_PUBLIC_BASE_URL` 是 IdP 身份的一部分**：GitHub SAML 设置中的 Sign on URL（`<地址>/sso`）和 Issuer（`<地址>/metadata`）都来自它。从内网切换到公网（或换主机名）后，必须在 GitHub 企业的 SAML 设置中同步修改并重新测试登录；SSO 数据库中的用户不受影响。因此**建议在第一次配置 GitHub SAML 之前就决定 SSO 的最终主机名**。
- App GW 不改写 `Host`（`pickHostNameFromBackendAddress: false`），后端看到的就是对外主机名，SSO 的同源检查和 Console 的同源检查都基于它。

## 9. 健康探测

| 后端 | 探测 | 说明 |
| --- | --- | --- |
| SSO（内部负载均衡 :7001） | `GET /healthz`，Host 为对外主机名，200–399 | 不访问数据库 |
| Console（:7004） | `GET /healthz` | 同上 |
| LiteLLM（`litellmBackend.port`，默认 4000） | `GET /health/liveliness`（`litellmBackend.probePath` 可改） | LiteLLM 的存活探测，不调用上游模型 |
| Proxy（`publicAccess.proxy`，Proxy 内部负载均衡 :3000） | App GW `GET /readyz`；Azure 负载均衡对每个 Pod 也探测 `/readyz` | 会 ping MySQL，与 Pod 的 readinessProbe 一致；对外路径允许列表不包含它 |

探测请求不经过 WAF。SSO、Login、Console 是单副本 + `Recreate`，滚动更新期间有几十秒不可用，App GW 在此期间返回 502；Proxy 的可用性不受影响。

## 10. DNS

- 公网 DNS（客户的域名服务）：把每个对外主机名的 A 记录指向输出 `APPGW_PUBLIC_IP`（或 CNAME 到客户自己的名字）。
- VNet 内：默认创建与主机名同名的私有 DNS 区域（例如区域 `sso.example.com`，根 A 记录 → App GW 私网前端 IP），链接到本 VNet。VNet 使用自定义 DNS 服务器时，需要在那里转发或添加相同记录。
- 证书的主机名必须与之匹配；不要用 IP 地址或 `*.cloudapp.azure.com` 对外。

## 11. 开关参数与操作

参数（`azd env set GHCP_PUBLIC_ACCESS '<JSON>'`，类型定义见 `infra/types.bicep`）：

```json
{
  "sso": false,
  "console": true,
  "litellm": false,
  "allowedSourceCidrs": ["203.0.113.0/24"],
  "hostNames": { "console": "console.example.com" },
  "certificateNames": { "console": "ghcp-public-tls" },
  "wafMode": "Prevention"
}
```

SSO 确需对外时（第 2.1 节的少见情况）再加 `"sso": true` 与 `"hostNames": { "sso": "sso.example.com" }`。

LiteLLM 另需 `"litellm": true`、`"hostNames": { "litellm": "llm.example.com" }`、`"litellmBackend": { "address": "<LiteLLM 内部负载均衡 IP>", "port": 4000 }`，可选 `litellmAllowedSourceCidrs`、`litellmAllowedPathPrefixes`、`litellmAllowAnySource`。

Proxy（不推荐，第 4.3 节）需要 `"proxy": true`、`"hostNames": { "proxy": "proxy.example.com" }`、`"proxyAllowedSourceCidrs": ["198.51.100.7/32"]`（LiteLLM 出口 IP），建议再加 `"proxyClientCaCertificate": "<客户端 CA 证书的 base64>"`。渲染脚本随之自动启用 Proxy 内部负载均衡，来源只放行 App GW 子网。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sso` / `console` / `litellm` | `false` | 三个推荐可开放的端点 |
| `proxy` | `false` | 不推荐；需要 `proxyAllowedSourceCidrs`，建议 `proxyClientCaCertificate` |
| `allowedSourceCidrs` | `[]` | SSO、Console（以及未单独配置时的 LiteLLM）的来源允许列表；VNet 总是放行 |
| `litellmAllowedSourceCidrs` / `proxyAllowedSourceCidrs` | 无 | LiteLLM / Proxy 各自的来源列表 |
| `ssoAllowAnySource` / `litellmAllowAnySource` | `false` | 显式同意对任意来源开放（Console、Proxy 没有这个选项） |
| `hostNames` / `certificateNames` | 无 / `ghcp-public-tls` | 每个端点的对外主机名与 Key Vault 证书名 |
| `litellmBackend` | 无 | `{ address, port = 4000, probePath = /health/liveliness }` |
| `litellmAllowedPathPrefixes` | 推理路径 | LiteLLM 放行的路径前缀 |
| `wafMode` | `Prevention` | 或 `Detection` |
| `splitHorizonDns` | `true` | VNet 内把对外主机名解析到 App GW 私网前端 |

**开启**：

1. 把证书写入 Key Vault（README 第 5.2 节）。
2. `azd env set GHCP_PUBLIC_ACCESS '...'`；`azd provision`（preprovision 先校验 JSON：主机名、CIDR、后端、未知键）。
3. 公网 DNS 指向 `APPGW_PUBLIC_IP`。
4. 如果 SSO 地址变化：postprovision 会重新渲染并部署（`SSO_PUBLIC_BASE_URL` 改变，SSO / Login 重启），然后在 GitHub 中更新 SAML 设置并测试登录。
5. 验证：允许列表外的地址访问返回 403；`/api/...` 返回 403；SSO 登录、SAML 测试成功；LiteLLM 只有推理路径可用。

**关闭**：把对应端点设为 `false` 并 `azd provision`，监听器会被移除；**但 Bicep 的增量部署不会删除已经存在的 App GW、公网 IP、WAF 策略**。所有端点都关闭后，手工删除它们（README 第 7 节给出命令），再把 `SSO_PUBLIC_BASE_URL` 改回内网地址并同步 GitHub SAML 设置。

## 12. 待确认

- 客户的管理员 / 开发者出口网段（`allowedSourceCidrs`、`litellmAllowedSourceCidrs`）。
- 对外主机名、证书来源（企业 CA / 公共 CA）、DNS 由谁维护。
- SSO 是否真的需要对外：如果所有管理员都在 VPN 内，保持仅内网更简单。
- LiteLLM 的部署位置（同集群 / 同 VNet 另一个集群 / 另一个 VNet / 另一朵云），决定是否需要 `azure-proxy-ilb`、VNet 对等或私网互联；只有私网互联不可行时才考虑 `publicAccess.proxy`，并确认 LiteLLM 能否出示 mTLS 客户端证书、出口 IP 是否固定。
- 是否把第 4.4 节的产品加固（签名身份头、按实例的 key、常量时间比较）列入后续版本。
- 是否已有统一的入口平台（AGC、Front Door、第三方 WAF）需要沿用。
