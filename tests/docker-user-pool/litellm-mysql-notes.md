# 隔离 LiteLLM–MySQL 网关验证说明

本文是**仅适用于测试夹具的产物**，并非生产部署指南。它在 HAProxy/共享 MySQL 测试夹具中加入真实的、经过身份验证的 LiteLLM v1.99.1 HTTP 网关，不更改生产身份钩子或 Proxy 逻辑。

## 哪些是真实的，哪些是合成的

- 真实组件包括固定版本的 LiteLLM 服务器、标准 HTTP 虚拟密钥身份验证、Router、PostgreSQL 密钥记录、现有的 `litellm/user_pool_hook.py`、HAProxy，以及共享 MySQL 的两个真实 Proxy 进程。
- 合成内容包括网关用户/密钥、提供方密钥、成员 OAuth 令牌、GitHub/SCIM/席位/Login 响应，以及推理输出。不使用真实模型或账户凭据；无需调用外部提供方。
- 静态主密钥**仅用于管理身份验证**。测试特意验证了使用它进行池推理会收到 403；不会将其误称为虚拟密钥。
- 原生虚拟密钥持久化需要 LiteLLM 支持的 PostgreSQL 数据库，该数据库与 Proxy 的 MySQL 相互独立。使用现有的 `postgres:16` 镜像和一个全新的一次性卷。不要直接插入身份验证数据行，也不要安装伪造的身份验证回调。

## Compose 服务约定

上层测试夹具的 `compose.stability.yaml` 负责服务生命周期。所有网关/模型/数据库服务**仅**接入 `isolated`（`internal: true`）；只有现有的固定目标桥接器接入预览网络。不发布 Postgres/网关端口，也不挂载 Docker 套接字、主机凭据或生产 `.env`。

`gateway-postgres`：

- 镜像为 `postgres:16`。
- `POSTGRES_USER=pool_gateway`、`POSTGRES_PASSWORD=mysql-fixture-gateway-db-only`、`POSTGRES_DB=litellm_mysql_fixture`。
- 一次性命名卷为 `gateway-pg-data:/var/lib/postgresql/data`。
- 健康检查为 `pg_isready -U pool_gateway -d litellm_mysql_fixture`。

`litellm`：

- 镜像为 `ghcr.io/berriai/litellm:v1.99.1`（本地已可用）。
- 命令为 `["--config", "/fixtures/config.yaml", "--port", "7000", "--num_workers", "1"]`。
- 等待 `gateway-postgres` 健康；运行器还会独立等待 `/health/readiness` 返回 `db=connected`，并确认 Proxy/MySQL 角色健康。
- 挂载 `tests/docker-user-pool/litellm-mysql-config.yaml:/fixtures/config.yaml:ro`。
- 挂载**现有的** `litellm/user_pool_hook.py:/fixtures/user_pool_hook.py:ro`。
- 环境变量：

```text
DATABASE_URL=postgresql://pool_gateway:mysql-fixture-gateway-db-only@gateway-postgres:5432/litellm_mysql_fixture
LITELLM_MASTER_KEY=sk-mysql-fixture-gateway-master-only
LITELLM_SALT_KEY=mysql-fixture-gateway-salt-only
GHCP_POOL_API_BASES=http://pool-lb:8080
GHCP_PROXY_API_KEY=mysql-fixture-api-only
LITELLM_LOCAL_MODEL_COST_MAP=True
LITELLM_TELEMETRY=False
PYTHONPATH=/fixtures
```

上述明文凭据仅属于这个隔离的一次性测试夹具，绝不可复用于部署。选择本地费用映射可避免获取远程模型目录；未知的合成模型费用可能触发警告，也不能据此证明定价/预算正确。

运行器使用的桥接目标：

| 主机回环端口 | 固定目标 | 用途 |
|---|---|---|
| 18100 | proxy:3000 | 读取成员/租约状态，并释放运行器拥有的租约 |
| 18101 | proxy2:3000 | 独立读取同一条共享 MySQL 租约 |
| 18102 | mock:8002 | 测试夹具计数器/标记；通往真实 Login 任务的只读桥接 |
| 18103 | litellm:7000 | 真实网关 HTTP 身份验证与推理 |
| 18107 | pool-lb:8082 | HAProxy `/stats;csv` 业务计数器 |

每个目标都必须提供桥接器的 `/__mysql/manifest`，其中项目为 `ghcp-user-pool-mysql-test`，数据库为 `ghcp_pool_mysql_test`，MySQL 端口为 33184，且服务角色必须正确（18107 对应 `pool-lb`）。清单用于标识测试夹具路由，并非容器网络隔离的密码学证明。

## 初始化与执行

通过获准的预览工具，使用上层测试夹具启动器启动服务，**不要**用本测试脚本启动服务。镜像会执行其正常且受支持的数据库初始化；无需在主机上安装软件包或下载依赖。随后，测试通过标准 API 初始化密钥：

1. 使用主密钥身份验证调用 `POST /user/new`，创建带有随机运行前缀的 `internal_user`，并设置 `auto_create_key=false`、`send_invite_email=false`。
2. 使用主密钥身份验证调用 `POST /key/generate`，设置用户绑定、模型允许列表、一小时有效期及合成运行元数据。
3. 使用主密钥身份验证调用 `/key/info?key=<sha256>`，验证持久化的用户/模型范围；使用虚拟密钥身份验证调用 `/v2/user/info`，验证实际的 `internal_user` 角色。原始密钥材料始终留在内存中，绝不会放入 URL 或报告。
4. 在 `finally` 中，按哈希调用 `POST /key/delete`，撤销每一个生成的密钥，不受租约清理错误影响。仅释放属于本次运行中原始密钥精确哈希的租约。合成用户审计行保留在一次性数据库中。

运行前：停止并发的长稳测试/请求；恢复两个后端；暂停工作进程，确保至少有三个就绪且空闲的成员、没有正在预配的成员，且**现有活动/暂定租约数为零**。成员库存不必为空，也不必恰好只有三个成员。如果长稳测试使用了较短的 TTL，应先等待过期/协调完成，再暂停。运行器绝不会更改全局池设置或预配账户。

```sh
node tests/docker-user-pool/litellm-mysql-smoke.mjs --confirm-local-fixture
```

不支持覆盖 URL、凭据、环境或服务。`--help` 不执行任何 I/O。退出码 0 表示所有必需断言和清理均已通过；前置条件不满足、缺少记录台账、传输结果存在歧义或运行时发生变化时，都会按失败处理并拒绝继续。以 `LITELLM_MYSQL_REPORT` 打印的报告路径是新建的操作系统临时目录，并非受版本控制的输出产物。

## 证据与防重放检查

- 密钥缺失/无效且带有伪造身份头的请求、使用管理主密钥的请求、使用模型受限密钥的请求，以及使用已撤销缓存密钥的请求，均被拒绝，且不会产生模拟上游活动或消耗成员库存。
- 密钥 A 和 B 是真实、互不相同、由数据库持久化的虚拟密钥。首次为 B 分配时，会将 A 的身份注入请求头/请求体及 `ghcp_identity` 元数据以进行伪造；B 必须获得其自身 `sha256(raw-key)` 对应的租约/成员。复用时还会测试请求头变体及嵌套覆盖容器。
- 针对 A 串行发送六个请求，混合使用 Messages 和 Chat、JSON 和 SSE、bearer 和 `x-api-key`。通过两个直连 Proxy API 必须都能看到同一租约/成员。
- 在这六次调用之前和之后，分别读取每个服务器的 HAProxy `hrsp_2xx` 计数器。两个服务器的计数都必须增加，增量之和必须恰好为六。在测量区间内，不得发生池读取、目录查询或其他负载均衡器请求。健康检查不计入业务 `hrsp_2xx`。这能证明两个后端都处理了同一个经过身份验证的调用方的请求，而不依赖 LiteLLM 保留任意响应头。
- 每个成功的池请求都包含唯一的 `POOL_TEST` 标记。模拟推理必须显示恰好一次已完成的尝试，且成员、线上传输的原始模型值、流标志和 HTTP 状态均正确。运行器、LiteLLM 配置和 HAProxy 配置中均没有推理 POST 重试。
- 非池路由 `other-only` 不得收到钩子注入的身份，也不得分配任何池成员。
- 回退从 `http://mock:8002/other` 开始，使用刻意无效的合成提供方密钥。稳定性模拟服务必须在需要身份验证的 `/__mysql/gateway-state` 中，以 `{fixture:true, primaryAttempts:[{marker,status:503,identityHeaderPresent:false}]}` 记录被拒绝的主路径尝试。单次回退调用必须产生恰好一条这样的主路径记录，以及恰好一条成功的真实 Proxy→模拟服务记录，后者须使用为新调用方分配的成员。仅有最终成功响应不足以作为证据。
- 真实 Login 任务列表仅供读取，且必须保持为空；SCIM、席位、任务和回调计数不得变化。

## 离线验证

```sh
node --test tests/docker-user-pool/litellm-mysql-smoke.test.mjs
```

五项仅依赖内置模块的运行器测试，在不发起网络调用的情况下，验证精确的双后端计数、哈希身份、SSE 终止标记/带内错误、输出脱敏，以及帮助行为/缺少确认时的拒绝行为。

现有的可选回调测试也已使用实际固定镜像，以**一次性**进程运行；参数为 `--network none`，以只读方式挂载 `litellm/`，并设置 `PYTHONPATH=/fixtures`、`GHCP_POOL_API_BASES=http://proxy.test:3000`、`LITELLM_LOCAL_MODEL_COST_MAP=True`、`LITELLM_TELEMETRY=False` 和 `PYTHONDONTWRITEBYTECODE=1`：

```text
python -m unittest test_user_pool_runtime -v
Ran 5 tests — OK
```

第二次一次性 `--network none` 检查将新 YAML 加载到固定版本的真实 Router 和现有钩子中，验证了其中的三个模型及精确的、仅允许负载均衡器的允许列表。这仅是配置/回调证据，**不是** HTTP 身份验证的证明。完整网关结果应在实际执行测试夹具后，保存在运行器的 JSON 中。

## 明确的限制

本说明不声称已完成真实 GitHub/SAML/SCIM 验收、真实席位分配、模型推理、真实密钥材料、网关 Postgres 重启持久性、定价/预算核算或 TLS 暴露的验证。HAProxy/共享 MySQL 长稳测试、中断/恢复和调度器故障转移，仍由上层验证负责。原生默认日志可能包含合成请求元数据；这些隔离测试夹具日志应与一次性卷一同保留和销毁，不要将其视为生产就绪的日志脱敏证据。
