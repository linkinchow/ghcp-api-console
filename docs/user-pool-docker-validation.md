# User Pool——Docker与真实HTTP链路验证

日期：2026-09-09。分支：`ghcp-user-pool`。本轮后续验证解决了最初报告中Docker守护进程和LiteLLM运行时不可用的阻塞。**这仍是使用测试替身的本地验证，不是真实GitHub验收。**

## 构建问题的定位与解决

首次Docker干净构建在下载依赖时失败：访问公共npm时出现`ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`。宿主npm已配置批准的受保护包源，但Docker中的`npm ci`不会继承宿主配置。通过批准包源查询包元数据成功；其可选`/-/ping`接口返回404，不能用它判断连通性。

四个Dockerfile已支持构建时`NPM_REGISTRY`并经Compose传入，公开项目仍保留通常的默认包源。本地构建仅显式传入获批源，没有关闭TLS校验、使用第三方镜像源或绕过发布隔离；未把凭据写入镜像／构建参数，也未改写锁文件。

| 生产Dockerfile | 通过批准包源的干净构建 |
| --- | --- |
| Proxy | 通过 |
| SSO | 通过 |
| Console | 通过 |
| Login（包括Chromium安装） | 通过 |

中间曾使用缓存的Linux依赖进行离线镜像试验，该方案已被替代。容器验证使用干净构建的Proxy／SSO／Console镜像；实际Login服务最初使用离线产物做健康检查，随后换为干净构建的Login镜像并重新验证。干净Login镜像可成功启动Chromium，临时离线辅助文件已移除。

## 隔离测试拓扑

项目名`ghcp-user-pool-smoke`，使用专用可丢弃数据卷和合成凭据，不使用租户`.env`或证书。实际运行的应用包括：

- 生产Proxy代码、SQLite和预热worker。
- 生产SSO用户API、SCIM客户端、席位集成及签名代码。
- 生产Console鉴权、API转发和前端构建产物。
- 生产Login健康／只读API及已安装的Chromium。

本地夹具提供有状态的**GitHub SCIM、Copilot席位API、Login任务完成／回调和模型API**。模拟Login通过真实HTTP回调，携带实际授权attempt ID写入token；不会直接写Proxy存储。

应用与mock容器只连接内部Docker网络。固定目标的本地转发桥暴露宿主端口，用于浏览器／API测试；仅转发桥另接一个非内部网络，它不是开放转发代理。由于实际Login的GitHub device-flow端点不能在本地替换，没有向其派发真实登录任务。未操作真实GitHub、Azure或客户环境。

## 已执行集成检查

主smoke完成4账号、4次SCIM创建、4次付费席位**夹具模拟分配**、4次成功token回调及31次模型夹具请求：

- 真实服务健康、Proxy readiness、未鉴权拒绝，以及Console鉴权后的服务转发。
- 空池target从0到2，执行实际SSO创建、严格SCIM create-only、席位API、Login回调和模型预热。
- 精确key hash分别排他映射到不同成员；重复或并发调用复用同一成员。
- Messages、Chat Completions及Responses的JSON／SSE使用标准模型ID，并向上游发送实际原始ID。
- 池耗尽返回429；自动补池达到空闲目标且不超过总cap4。
- 上游429保留归属／冷却，不续租、不遍历其他成员。
- HTTP500、SSE流内错误及提前EOF均不续租，也不重放请求。
- 请求在途时禁止手动释放；断连会取消上游。
- HTTP401只使实际选中成员失效／隔离，不重放请求。
- 实际重启Proxy容器后，settings、lease ID、凭据和库存保留，没有重复开通。
- 真实等待60秒租约到期后回收归属，新隔离租约复用库存，没有继续创建账号。

## 真实应用与LiteLLM检查

- 浏览器成功登录运行中的Console，打开User pool，通过表单取消暂停，并对刻意失败的成员执行行内重试。真实worker经夹具重新授权，使4账号全部恢复Ready idle。
- 375px移动端视口无页面水平溢出或告警；已检查桌面截图和实际DOM。
- 实际SSO容器从`/sso`进入密码登录，生成带签名的SAML POST表单，subject、本地ACS和RelayState符合预期；未验证SP验签或GitHub设备授权。
- 使用本地已有**LiteLLM 1.94.2**镜像，在禁网条件下，**5项实际鉴权模型／回调／Router测试全部通过**，包括进入和离开GHCP的fallback。
- 真实LiteLLM ProxyLogging／Router通过HTTP向运行中的Docker Proxy发送**JSON和SSE请求**，active lease中出现受信任hash，伪造身份被覆盖；上游模型输出仍由本地夹具提供。
- 该HTTP链路测试注入服务端已认证的`UserAPIKeyAuth`测试对象，不等于认证了LiteLLM入口HTTP key鉴权／数据库、预算／计费或原生Messages／Responses适配器。

## 当时剩余的发布门槛

1. 经批准的真实租户SAML／SCIM／席位／OAuth／模型验收，以及更长时间的运行观察。
2. 客户实际LiteLLM镜像／配置、真实virtual-key数据库鉴权及计费验收。
3. 依赖修复／审查：此次干净构建的生产依赖审计报告**4项公告（3高危、1中危）**，涉及`@xmldom/xmldom`、`brace-expansion`、`multer`和`qs`，提示有可用修复。当时未自动升级依赖；存在公告不证明可以利用，但发布前仍须审查。
4. 初版已有边界：单Proxy／SQLite，不对同一请求执行401重放，Console列表有界，以及非幂等开通结果不明时由操作员核对。

复现文件位于[Docker测试夹具](../tests/docker-user-pool/README.md)。测试栈运行时，本地Console地址为`http://127.0.0.1:17304/#user-pool`。本轮未commit、push或部署客户环境。
