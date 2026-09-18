# LiteLLM → 五套 GHCP 的固定 hash 路由

这是独立的 NGINX 入口组件，不改动 Proxy、SSO、Login、账号池或 LiteLLM 数据库。每个后端地址代表一套独立账号池的 Kubernetes Service，不是单个 Pod。

## 1. 固定映射

NGINX 读取 `X-User-Identity: sha256:<64位小写十六进制hash>`，按 **hash 的第一位**（不是字符串 `sha256:` 的第一位）选择：

| 首位 | 后端 | 理论 key 占比 |
| --- | --- | --- |
| `0–3` | GHCP Proxy 1 的 Service | 25% |
| `4–6` | GHCP Proxy 2 的 Service | 18.75% |
| `7–9` | GHCP Proxy 3 的 Service | 18.75% |
| `a–c` | GHCP Proxy 4 的 Service | 18.75% |
| `d–f` | GHCP Proxy 5 的 Service | 18.75% |

这不是轮询或一致性哈希，也不是按请求量/费用调度。后端映射不变时，同一个 key 固定访问同一套池。一个人持有多把 key 仍是多个 caller；换 key 可能改变归属。每套 Service 内部可继续使用多个共享该池 MySQL 的 Proxy 副本。

```text
LiteLLM（认证并注入 hash）
        │
        ▼
NGINX ClusterIP Service → NGINX 副本 1 / 2（同一配置）
        │
        ├─ 0–3 → ghcp-proxy.pool1 → 该池 Proxy 副本 → MySQL 数据库 1
        ├─ 4–6 → ghcp-proxy.pool2 → 该池 Proxy 副本 → MySQL 数据库 2
        ├─ 7–9 → ghcp-proxy.pool3 → 该池 Proxy 副本 → MySQL 数据库 3
        ├─ a–c → ghcp-proxy.pool4 → 该池 Proxy 副本 → MySQL 数据库 4
        └─ d–f → ghcp-proxy.pool5 → 该池 Proxy 副本 → MySQL 数据库 5
```

## 2. 文件及准备

- [nginx.conf.template](nginx.conf.template)：完整的 NGINX 配置模板。
- [backends.example.json](backends.example.json)：五个端点及允许来源的示例。
- [render.py](render.py)：只生成配置，不安装依赖、不启动服务、不覆盖已有文件。
- [kubernetes.template.yaml](kubernetes.template.yaml)：2 个 NGINX 副本、ClusterIP、入口 NetworkPolicy 和 PDB。
- [test_config.py](test_config.py)：离线配置契约测试。
- [runtime_check.py](runtime_check.py)：预览工具启动的真实 NGINX/回环模拟后端功能验证。

复制 JSON 到私有发布目录，按实际情况填写。后端必须是 **HTTP Service 的 `host:port`**，不带 `http://`、路径、凭据或 NGINX 参数。五个地址必须不同。支持 DNS、IPv4、带方括号的 IPv6；DNS 必须在 NGINX Pod 内可解析。本版不配置 HTTPS 上游，若客户要求跨网络 TLS/mTLS，不能直接套用本模板。

`trustedCidrs` 必须填写 **NGINX 实际看到的 LiteLLM 出口地址/网段**。示例 `192.0.2.10/32` 是不可直接用于生产的文档地址。Pod IP、节点 IP、NAT 出口要按客户网络确认。不得填写 `0.0.0.0/0` 或 `::/0`；生成器会拒绝。

从仓库根目录离线生成：

```bash
python deploy/user-pool-hash-router/render.py --config <私有目录>/backends.json --output <私有目录>/nginx.conf
```

输出路径必须尚不存在。每次生成新版本文件，核对后经原发布流程更新。配置没有密钥，但真实内网拓扑仍应私下保存。

先用客户拟部署的 NGINX Linux 镜像执行配置检查，再上线。镜像需包含普通 HTTP proxy/map/access 模块，支持非 root UID 101 和 `/bin/sh`；模板直接运行 nginx，不执行镜像入口脚本。选客户批准的补丁版本并固定镜像摘要。本地功能测试不等于该 Linux 镜像或 K8s 的验收。

## 3. Kubernetes 安装顺序

先创建配置 ConfigMap（名称和 namespace 与模板实际值一致）：

```bash
kubectl -n <namespace> create configmap <router-configmap> --from-file=nginx.conf=<私有目录>/nginx.conf
```

资源已存在时，通过原 Helm/GitOps/发布流程更新，不删除重建。填写 YAML 所有 `REPLACE_*`，尤其是镜像摘要、namespace、ConfigMap、LiteLLM 来源 namespace/Pod 标签。先审核 NetworkPolicy，确认 CNI 支持执行它，再发布；不要先开放入口后补安全规则。

```bash
kubectl apply -f <私有目录>/hash-router.yaml
```

```bash
kubectl -n <namespace> rollout status deployment/ghcp-hash-router
```

模板部署两个 NGINX 副本，避免只放一个代理进程成为新增单点；跨节点调度约束是偏好，不保证节点资源不足时仍分散。资源请求/限制仅为起步示例，没有生产容量保证。

- `/healthz` 只证明 NGINX 进程可响应，不代表五套 GHCP 全部健康，不会向后端发测试请求。
- 对五套后端应分别监控，不因为某套池不健康就重分配到其他池。
- 配置通过 `subPath` 挂载，不热更新；更新后需按发布流程重建 NGINX Pod。示例提供优雅退出窗口，但不能保证所有长流永不中断。
- Service DNS 在加载配置时解析；使用稳定的非 Headless ClusterIP Service。Service 地址变化需要重新加载/发布。任何一个主机名启动时无法解析都可能阻止 NGINX 启动；不要把某套不存在的服务当作可忽略占位。

## 4. LiteLLM 怎么接

把相关 GHCP deployment 的 `api_base` 改成新 NGINX 的 Service 根地址，同时把身份 Hook 的 `GHCP_POOL_API_BASES` 改成同一地址。例如：

```dotenv
GHCP_POOL_API_BASE=http://ghcp-hash-router.gateway.svc.cluster.local:8080
GHCP_POOL_API_BASES=http://ghcp-hash-router.gateway.svc.cluster.local:8080
```

如果 deployment 显式设置了 `base_url`，必须一并核对，因为它优先于 `api_base`。只列五个最终后端、不列 NGINX 地址，会导致身份 Hook 无法识别实际出站目标。

保留现有 hash 身份 Hook，或使用已经单独配置的灰度 Hook；不要重新使用旧 metadata 身份绑定 Hook，也不要两个身份 Hook 同时注册。NGINX 不生成 hash、不验证 LiteLLM virtual key，也不修改 identity。

**与前面的首位灰度叠加时：**如果灰度 Hook 当前仅允许 `0` 开头进入 GHCP，那么到达该 NGINX 的请求只会命中第 1 套池。这是两个规则叠加后的预期结果，不是其他四个 upstream 失效。

### API_KEY

本版原样传递 `Authorization` 和 `X-API-Key`，不改写服务密钥。因此，LiteLLM 使用的 GHCP 服务密钥必须能被所选的五套 Proxy 接受；最简单的本版接入前提是五套 Proxy 使用同一个受保护的业务 API_KEY，并仅允许可信网关访问。**不同后端使用不同 API_KEY 的映射不在本版内，不能把它们放进公开配置或直接拿用户的 virtual key 充当服务密钥。**

Proxy 优先校验非空 `X-API-Key`，再看 Bearer Authorization；两者冲突可能返回 401。`INTERNAL_API_TOKEN` 无需统一给此入口，也不会被 NGINX 转发。

## 5. 信任与隔离

- `sha256:` 格式正确不等于请求已认证。NGINX 只信任 LiteLLM 已验证并覆盖的身份头。格式缺失/错误返回 400；重复身份头在测试中被拒绝。
- 来源 CIDR 和 K8s NetworkPolicy 共同限制入口。NGINX 不采信客户端 `X-Forwarded-For` 来判定可信源。
- 实际五套 GHCP 也要限制来源，不能让客户端绕过此入口携带服务密钥任意选择池。其他 NetworkPolicy 规则是叠加的，已有宽泛允许规则会扩大可达范围，须统一检查。
- CIDR 若覆盖普通用户 Pod，并不能单独证明请求来自 LiteLLM；必须配合准确的 Pod/namespace 规则。跨不可信网络应使用经过验证的 TLS/服务身份，不把此 HTTP 内网模板当成 mTLS 方案。
- 访问日志默认关闭，避免 URI 查询参数、身份等落入访问日志。错误日志仍需受保护，可能包含内部地址或请求路径；未宣称完整的日志脱敏。

## 6. 转发与故障语义

允许的原生 Proxy 业务路由：

| 方法 | 路径 |
| --- | --- |
| GET / HEAD | `/v1/models` |
| POST | `/v1/messages` |
| POST | `/v1/messages/count_tokens` |
| POST | `/chat/completions` |
| POST | `/responses` |

本版不改写 URL；`/v1/chat/completions` 和 `/v1/responses` 不是当前 GHCP 注册的原生路径，不能自行加 `/v1`。保留请求方法、正文、查询参数及响应状态。其他路径/方法返回 404；管理 `/api`、回调 `/internal` 不转发。

每套 SSO/Login/Console 的 `PROXY_BASE_URL` **继续指向自己的 Proxy Service**。内部回调基于成员和授权任务，不能经过这里按业务 key hash 分配。

- `proxy_next_upstream off`：不重试、不切其他池，没有 backup 后端或错误跳转。
- 429/401/5xx 原样返回；`Retry-After` 在该 NGINX 层保留。LiteLLM 是否继续向终端透传，仍取决于其版本和配置。
- 所选后端连接失败可能返回 502，等待超时可能返回 504；后端开始流式响应后失败，不重新生成另一份响应。
- 关闭响应缓冲、代理缓存和压缩，支持 SSE 增量输出；客户端断开时关闭对应上游，不另发请求。
- 连接超时 5 秒，读写/发送空闲超时 300 秒；这些不是总请求时限。请求体上限 16MiB。应与客户模型/上传需求核对，不能不加说明地降低已有入口限制。
- 固定映射不改变池本身 429、租约、凭据围栏行为，也不会自动扩池。

## 7. 配置变更与验证边界

同一批 NGINX 必须使用相同映射。修改某个 hash 范围或把某个 endpoint 指向另一套池，可能让已有 key 换池；旧租约不会自动释放。替换的是同一池的 Service/Proxy 副本则不同。不要在故障时临时把池 5 改指池 1。

该路由实现只提供入口亲和性，不是跨五个数据库的唯一租约约束，也不保证请求量/金额按 key 比例分布。使用和企业归属需符合客户授权，不用于跨账号/企业绕过限流。

离线测试：

```bash
python -m unittest discover -s deploy/user-pool-hash-router -p 'test_config.py' -v
```

真实运行检查需已有受信任的 NGINX 二进制，只能由预览工具启动 `runtime_check.py --nginx <绝对路径> --confirm-local-fixture`，默认状态端口 18129、路由端口 18128。五个模拟端口由系统分配，全部为回环地址；不提供真实后端选项。它会执行 `nginx -t`、启动自己的 NGINX、验证并关闭其 NGINX 和模拟监听器，状态页面最多保留约 180 秒。失败证据保存在新建的操作系统临时目录，不覆盖旧报告。

实际结果与未覆盖边界见[测试报告](validation.md)。本次不创建云资源、不配置客户 endpoint、不操作真实用户/席位或真实模型。
