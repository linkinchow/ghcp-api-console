// 跨模块共用的参数类型。

@export()
@description('公网访问开关。默认全部 false = 仅内网；任一为 true 时创建 Application Gateway WAF_v2（公网 IP + 私网前端），后端始终是内网地址。')
type publicAccessConfig = {
  @description('SSO 的 SAML 页面（/sso、/metadata、/login、/logout 及 /enterprises/<id>/...）经 App GW 对外。/api、/internal 始终被 WAF 拦截。')
  sso: bool

  @description('Console 管理界面经 App GW 对外。只放行 allowedSourceCidrs（以及 VNet 内部），不支持对全网开放。')
  console: bool

  @description('LiteLLM 经 App GW 对外，只放行推理路径。需要 litellmBackend。开发者在 VNet 外时用它，而不是开放 Proxy。')
  litellm: bool

  @description('Proxy 经 App GW 对外（默认 false，不推荐）：只用于 LiteLLM 在另一个网络且无法私网互联的情况。持有共享 API_KEY 的任何人都能冒用任意 X-User-Identity，见 public-access-design.md 第 4 节。必须同时给出 proxyAllowedSourceCidrs；建议 proxyClientCaCertificate（mTLS）。')
  proxy: bool?

  @description('允许访问 Proxy 的来源：只填 LiteLLM 的出口 IP（例如 a.b.c.d/32）。proxy 为 true 时必填。')
  proxyAllowedSourceCidrs: string[]?

  @description('可选但强烈建议：签发 LiteLLM 客户端证书的 CA 证书（公开证书，PEM 去掉首尾行后的 base64，或 DER 的 base64）。给出后 Proxy 监听器要求 TLS 客户端证书（App GW mutual TLS）。')
  proxyClientCaCertificate: string?

  @description('允许访问已开放端点的来源网段（管理员 / 办公网 / VPN 出口），CIDR 格式。VNet 地址空间总是放行。为空时 Console 只能从 VNet 内访问；SSO、LiteLLM 见下面的 *AllowAnySource。')
  allowedSourceCidrs: string[]

  @description('只用于 LiteLLM 的来源网段（开发者出口）；为空时沿用 allowedSourceCidrs。')
  litellmAllowedSourceCidrs: string[]?

  @description('显式同意 SSO 对任意来源开放（默认 false，只放行 allowedSourceCidrs + VNet）。')
  ssoAllowAnySource: bool?

  @description('显式同意 LiteLLM 对任意来源开放（默认 false）。LiteLLM 仍要求 virtual key。')
  litellmAllowAnySource: bool?

  @description('对外主机名（必须是客户自己的域名，证书与之匹配）。启用的端点必填。')
  hostNames: {
    sso: string?
    console: string?
    litellm: string?
    proxy: string?
  }?

  @description('Key Vault 中 TLS 证书的名称（证书对象，或 contentType 为 application/x-pkcs12 的机密）。可以多个端点共用一张 SAN / 通配符证书。默认 ghcp-public-tls。')
  certificateNames: {
    sso: string?
    console: string?
    litellm: string?
    proxy: string?
  }?

  @description('LiteLLM 后端（通常是 LiteLLM 自己的内部负载均衡）。')
  litellmBackend: {
    @description('内网 IP 或可在 VNet 内解析的主机名。')
    address: string
    port: int?
    @description('健康探测路径，默认 /health/liveliness（LiteLLM 的存活探测，不访问上游模型）。')
    probePath: string?
  }?

  @description('LiteLLM 监听器放行的路径前缀；默认只放行推理与模型列表路径，管理界面和管理 API 不对外。')
  litellmAllowedPathPrefixes: string[]?

  @description('WAF 模式。默认 Prevention；首次上线可用 Detection 观察误报，再切回 Prevention。')
  wafMode: ('Prevention' | 'Detection')?

  @description('同时在 VNet 内为对外主机名创建私有 DNS 区域（split-horizon），解析到 App GW 私网前端。默认 true。')
  splitHorizonDns: bool?
}

@export()
@description('已有私有 DNS 区域的资源 ID（与 LiteLLM 等共用 VNet 时复用；为空则新建并链接到本 VNet）。')
type existingPrivateDnsZones = {
  acr: string?
  keyVault: string?
  mysql: string?
}
