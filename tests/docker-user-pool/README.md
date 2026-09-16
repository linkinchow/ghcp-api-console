# 本地 Docker User Pool 测试环境

本测试环境启动通过生产构建流程生成的真实 Proxy、SSO、Login 和 Console 镜像，并配合**模拟的 GitHub SCIM、席位、Login 任务完成及模型服务**。绝不能提供真实租户凭据。真实 Login 仅进行健康检查、API 和浏览器冒烟验证；Proxy 将任务派发给测试夹具，而非真实 GitHub。

## 准备工作

从当前检出目录构建各个镜像。`NPM_REGISTRY` 为可选参数；公共 npm 不可访问时，将其设为组织批准的受保护包源。不要将凭据放入构建参数、关闭 TLS 校验或绕过软件包发布管控。

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-proxy:local -f src/proxy/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-sso:local -f src/sso/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-login:local -f src/login/Dockerfile .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -t ghcp-pool-smoke-console:local -f src/console/Dockerfile .
```

如果不需要自定义包源，应省略该构建参数，而不是传入空值。Login 还会通过正常安装流程下载 Chromium 和操作系统依赖库。

创建临时自签名的**测试用**签名文件（需要 OpenSSL），以及本地 Compose 配置指针。测试环境已经运行时，不要执行此操作。

```bash
node tests/docker-user-pool/prepare.mjs
```

验证并启动明确指定名称的测试项目；不使用仓库中的 `.env`。

```bash
node tests/docker-user-pool/compose.mjs config --quiet
```

```bash
node tests/docker-user-pool/compose.mjs up --no-build
```

所有应用容器均位于**内部 Docker 网络**，无法直接访问互联网。由于 Docker Desktop 可能无法发布仅连接内部网络的容器端口，一个仅转发到固定目标的小型 HTTP 桥接服务通过第二张网络发布 localhost 端口。该桥接服务只能转发到五个预先指定的内部服务，不支持任意代理目标或 CONNECT。任何应用服务都不连接桥接服务的外部网络。

Console 地址：`http://127.0.0.1:17304/#user-pool`。冒烟测试会初始化管理员 `pool-test-admin`，密码为 `local-pool-console-test-only`。夹具中的所有凭据都是公开的合成测试数据，不适用于非本地部署。

## 检查项目

主冒烟测试要求使用**全新的测试数据卷，且初始 idle target 为零**。它会创建四个测试池账号，绝不能指向已有部署。

```bash
node tests/docker-user-pool/smoke.mjs
```

注入 401 后，夹具最终会刻意保留一个失败成员，并暂停预热。这是预期状态。可通过 Console 的重试和取消暂停操作验证恢复。

持久化检查（在测试的 60 秒租约期限内，及时执行以下三条命令）：

```bash
node tests/docker-user-pool/smoke.mjs prepare-restart
```

```bash
node tests/docker-user-pool/compose.mjs restart proxy
```

```bash
node tests/docker-user-pool/smoke.mjs verify-restart
```

其他检查：

```bash
node tests/docker-user-pool/saml-smoke.mjs
```

```bash
node tests/docker-user-pool/expiry-smoke.mjs
```

SAML 检查验证登录和签名表单生成，**不验证 SP 是否接受签名，也不验证 GitHub OAuth**。到期检查会等待真实的 60 秒租约到期，不修改时钟或数据库。

`litellm/test_user_pool_runtime.py` 支持通过 `GHCP_POOL_TEST_LITELLM_VERSION` 显式指定精确版本重跑。`litellm/test_user_pool_wire.py` 在本地 LiteLLM 镜像中运行，连接 `ghcp-user-pool-smoke_default` 网络，并只读挂载 `litellm` 目录。它验证真实的回调、Router 和网络交互行为，不验证网关入口的数据库认证。

## 真实网关 v1.99.1 与数据库支持的密钥

`compose.gateway.yaml` 增加专用的 PostgreSQL16 实例和官方 LiteLLM v1.99.1，并使用真实的池 Hook。运行时不从公共镜像仓库下载镜像。使用 `launch-gateway.mjs` 启动项目 `ghcp-user-pool-gateway`，使用 localhost 的 17500–17505 端口（Console 为 17504，LiteLLM 为 17505）。它要求已有准备好的测试签名文件和 GHCP 测试镜像。

```bash
node tests/docker-user-pool/launch-gateway.mjs
```

针对网关项目中**全新**的 Proxy、SSO 和模拟服务状态运行：

```bash
node tests/docker-user-pool/gateway-smoke.mjs --confirm-local-fixture --pressure-mode live --other-only-model other-only
```

主运行器执行真实的用户／虚拟密钥增删改查和 HTTP 认证、20 个密钥的突发请求、身份伪造、复用／撤销以及补池验证。如果原版 LiteLLM 拒绝重复别名，运行器以退出码 2 结束（该场景无法通过受支持的 API 构造），这不表示已执行的推理测试失败。JSON 结果区分 PASS／FAIL／BLOCKED／SKIP。退出时会暂停工作器并撤销生成的密钥；除非显式释放，已有租约仍由 TTL 控制。

随后运行无需全新状态的补充检查，覆盖主密钥过滤、其他提供方隔离、显式回退和预算检查：

```bash
node tests/docker-user-pool/gateway-supplement.mjs
```

仅供测试的网关配置关闭 Router 冷却，以隔离账号池容量行为，并包含一个刻意失败的主模型组；不要将这些设置部署为生产路由策略。夹具仍模拟 GitHub、席位、模型和 Login 完成过程。参见[完整报告](../../docs/user-pool-gateway-validation.md)和[场景矩阵](gateway-scenarios.md)。

## 生命周期管理

停止测试环境，但不删除数据：

```bash
node tests/docker-user-pool/compose.mjs stop
```

不要随意执行 `down -v`。如果要重复初始冒烟测试，操作员必须明确只清理这个一次性项目的测试数据卷，或使用另一个单独命名的新项目。不要清理无关的 Docker 资源。本地签名文件以及本地运行、审计和快照文件均由 Git 忽略。
