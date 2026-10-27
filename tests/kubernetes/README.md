# deploy/kubernetes 的 kind 端到端验证

在本机 kind 集群上按全新部署流程验证 [`deploy/kubernetes/`](../../deploy/kubernetes/README.md)。只用 mock 和合成凭据：GitHub、GHE.com、SCIM、Copilot 都是集群内的 `tests/docker-user-pool/mock-services.mjs`，MySQL 是 kind Docker 网络上的一个容器；不访问真实 GitHub、Copilot 或模型，不拉取应用镜像（使用本地候选镜像 `multi-3d6db1a-amd64-r3`，用 `kind load docker-image` 加载；r3 尚未发布，测试 overlay 用本地 tag 替换 base 中的 r2 digest）。Docker Desktop 上只验证功能，不评估性能。

## 文件

| 文件 | 用途 |
| --- | --- |
| `kind-e2e.mjs` | 执行器：`setup`（建 kind 集群、加载镜像）、`run`（阶段 A、B）、`clean`（删除测试 namespace 和 MySQL 容器）、`teardown`（再删除集群、kubeconfig 和镜像 tag） |
| `overlays/kind-ghe/` | 阶段 A：客户的 `ghe-com` overlay + `network-policy` 组件，指向 mock 的 `fixture.ghe.com` |
| `overlays/kind-dba/` | 阶段 B：客户的 `github-com` overlay + 全部四个组件（Ingress 只被 API server 接受，kind 没有 Ingress 控制器） |
| `overlays/kind-shared/` | 两个阶段共用的测试补丁（Component）：本地镜像 tag、mock 主机名的 `hostAliases`、NetworkPolicy 占位值、到 mock 的出站 |
| `fixtures/mock.yaml` | mock（namespace `ghcp-e2e-mock`，固定 ClusterIP `10.96.200.20`） |
| `fixtures/clients.yaml` | `ghcp-e2e-caller/litellm-sim`（扮演另一个 namespace 中的 LiteLLM，以及缺失的 Ingress 控制器）和 `ghcp-e2e-outsider/outsider`（策略不放行的 namespace） |
| `fixtures/driver.mjs` | 在上述 Pod 内发 HTTP 请求的小工具，只允许集群内地址 |

## 运行

前提：Docker、kubectl、kind、openssl；本地已有 `ghcp-release-{proxy,sso,login,console}:multi-3d6db1a-amd64-r3`（与 `overlays/kind-shared` 和 `kind-e2e.mjs` 中的 `TAG` 一致）、`node:22-bookworm-slim@sha256:efd0ab57…`、`mysql:8.4`。

```bash
export KIND_E2E_KUBECONFIG=<仓库>/.claude/kind/kubeconfig   # 只给这个集群用，绝不是 ~/.kube/config
export KIND_BIN=<kind 可执行文件>                           # 默认 kind
node tests/kubernetes/kind-e2e.mjs setup
node tests/kubernetes/kind-e2e.mjs run       # 报告：.claude/kind-e2e-run-<时间>/report.json
node tests/kubernetes/kind-e2e.mjs clean     # 可重复 run
node tests/kubernetes/kind-e2e.mjs teardown
```

- 每次 kubectl 调用都显式传 `--kubeconfig` 和 `--context kind-<集群名>`；脚本拒绝默认 kubeconfig，并确认 API server 是 `127.0.0.1` 上的 kind 节点。
- 每次 `run` 新建 MySQL 容器（`--require-secure-transport=ON`、`--log-bin-trust-function-creators=1`）和全部测试 namespace；存在时拒绝运行。失败时保留现场，诊断（Pod、事件、日志）写到运行目录的 `diagnostics/`。
- 合成凭据与证书每次随机生成，只写在运行目录（`.claude/` 不入库）。

## 断言

阶段 A（`ghcp-e2e-ghe`，GHE.com，MySQL 自动迁移，NetworkPolicy 生效）：启动门禁拦截未放行的配置 → 放行后全部就绪 → `/healthz` 的 `releaseLine` 为 `multi` → 两个 Proxy `/readyz` 为 mysql → 以 UID 1000 运行且根文件系统只读 → 迁移 ID 完整 → 只有 `default` 且 active、三方就绪无阻塞 → Proxy 到 MySQL 的连接走 TLS（verify-ca）→ Console 首次初始化（跨站 403、重复 400）与登录 → 池从 0 开到 2 个 Ready idle（真实 SSO + 真实 Login 的 Chromium + mock GHE.com）→ 同一调用方 6 个请求（3 种协议 × JSON/SSE）交替打到两个副本，都落在同一个成员，租约在两个副本一致；第二个调用方拿到另一个成员；错误 key 401、非 hash 身份 403 → SSO 根路径 `/metadata` 与 `/login` + `/sso` 的 SAML 流程 → NetworkPolicy：别的 namespace 访问不到 Proxy/SSO/Console，LiteLLM namespace 访问不到 Login，Proxy 出站到别的 namespace 被拒 → Proxy 两次 `rollout restart`，期间一个调用方持续经 Service 请求：复用长连接的客户端（模拟 LiteLLM）和每个请求新建连接的客户端都必须**零失败**（不允许任何连接级错误或 HTTP 错误），两个旧 Pod 都必须在 SIGTERM 后 5 秒内 `shutdown complete`、且没有 `closing their connections` 强制关闭日志（r3 修复，见 `deploy/kubernetes/README.md` 第 10.1 节；失败请求会连同它相对每个旧 Pod SIGTERM 的时间写进报告，不做任何容忍）（运行时跟踪新旧 Proxy Pod 的日志、采样 MySQL 会话与锁等待，写到运行目录）→ 再依次重启 SSO、Login、Console：7 个旧容器都以退出码 0（`Completed`）结束且在宽限期内 → 重启后 Console 管理员、调用方租约仍在 → 删除 SSO、Login Pod 后 PVC 与数据保留。

阶段 B（`ghcp-e2e-dba`，github.com 形态，全部组件）：DBA 在客户端默认会话中执行 `scripts/proxy-mysql-initial.sql`（CHECK 字面量只有 utf8mb4）→ 运行账号只有 DML + TRIGGER → 两个 Proxy 以 `MYSQL_AUTO_MIGRATE=false` 就绪 → Proxy 启动没有 DDL（表结构指纹不变，只补写 `02-seed-default`、`08-pool-config-fingerprint`）→ 只有 `default` 且就绪 → 空池时两个副本都返回 429 `pool_exhausted` 和配置的 `Retry-After` → SSO `/metadata` → Ingress 对象被 API server 接受。
