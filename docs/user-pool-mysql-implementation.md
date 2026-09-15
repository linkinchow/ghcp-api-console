# User Pool MySQL 多 Proxy 实施与运维文档

状态：**2026-09-15 当前候选caller-isolation-v4已完成本报告列出的实现与隔离验证；未发布、未完成客户生产验收。** 独立取消安全审查和同版本持续/规模复验仍待完成。基线`da76eb1`，分支`ghcp-user-pool-mysql`；最新进展与待办见[状态总览](user-pool-mysql-status.md)。本文不授权真实租户访问、迁移、开户或模型调用。设计见[设计文档](user-pool-mysql-design.md)，迁移见[专用importer文档](../upgrade/user-pool-mysql/README.md)，历史证据见[验证记录](user-pool-mysql-validation.md)。

## 1. 当前交付范围与验收边界

| 模块 | 当前代码职责 | 最新隔离验收 |
| --- | --- | --- |
| storage/runtime/admission | 异步双驱动、有限hold、迟到禁止转发、借连接前caller有界队列 | v4 Proxy394通过/0失败/8条件skip；严格跨caller隔离HTTP通过 |
| mysqlStore/deadline/schema/migration lock | caller/member锁、有界队列/回收、共享5秒预算、schema验证 | v4 MySQL caller/admission/store/lifecycle组合43通过/0skip；历史集中到期验证独立保留 |
| worker/provisioner | 原子终态失败、独立观察、满槽starter过滤、3优先/1最老选择及原子派发 | v4新空库14阶段生命周期61.418秒通过；0→2000为scheduler-v2历史通过 |
| 管理API/Console/catalog | joined hold计数、server paging、mutation控件锁、独立取消的目录合并 | v4生命周期管理操作通过；Linux浏览器4项为历史通过 |
| 离线 importer | 规范化配置、标准schema拒绝、原子DML与不明commit保护 | MySQL迁移66项为历史通过；客户备份未演练 |
| Docker fixture | v4镜像、双Proxy共享MySQL，历史候选证据保留 | 双副本镜像ID核对、严格隔离和生命周期通过；v4持续/规模测试待补 |

只扩容 Proxy；**SSO、Login、Console 各保持一个实例**。MySQL HA、SSO/Login/Console 多副本、在线跨库双写、零停机迁移、池外旧账号纳管和真实 GitHub 规模/付费验证不在本阶段。caller级admission互斥、成员级完成事务和无全局锁的心跳读取，详见设计第3.1节；增加Proxy不代表吞吐线性扩展。

## 2. 部署前准备

以下检查针对经批准的新部署或维护窗口，不是要求本任务访问现有环境。

1. **版本与回退材料**：确认采用 [生产前审查修复版](user-pool-mysql-production-review.md) 的同一份源码/镜像，记录不可变版本或 digest；完成客户资源/LB/数据库/备份演练审批及回滚计划后再 cutover。不要使用旧 SQLite 或旧 caller-lock 测试镜像替代最新 MySQL 修复版。
2. **外部 MySQL**：部署方提供 MySQL 8/InnoDB 写主库、专用数据库、账号、备份和监控。每个 Proxy 指向同一写端点及同一数据库，不接只读副本。初次启动要有应用 migrations 所需 DDL/trigger 和运行时 DML 权限；离线 importer 的权限另见第 6 节。
3. **连接与 TLS**：安全注入 `MYSQL_URL`，不要把含凭据的 URL 放在命令参数、工单或日志。`MYSQL_CONNECTION_LIMIT` 默认每 Proxy 10；容量预算按副本数累加，还需给迁移/运维留余量。远程 MySQL 使用 `MYSQL_SSL_MODE=verify-ca` 和受信 CA 文件。普通 Proxy 配置虽允许 disabled/required，生产不能把它们当作证书验证；required 只加密、不验证信任。
4. **已有服务**：保留 SSO/Login/Console 的实例数、卷、证书、会话材料、企业配置和 Login 配置。迁移时复用原 Compose project 名，不能因为改 project 名而悄悄创建空的 SSO/Login/Console 卷。不运行 `down -v` 或全局 prune。
5. **认证边界**：Proxy 3000 只对可信网关/LB/内部服务网络开放。业务网关认证调用者后生成 `sha256:<64 位小写十六进制>` 的稳定 caller key hash，覆盖客户端提供的 `X-User-Identity`，使用 Proxy 服务 `API_KEY`。hash 不是授权凭证；不能让终端用户凭任意 hash 和共享 Proxy key 直接访问。
6. **内部调用**：各服务使用同一 `INTERNAL_API_TOKEN`，内部 HTTP 头为 `X-Internal-Token`。SSO、Login、Console 的 `PROXY_BASE_URL` 都应由 overlay 设置为统一 `PROXY_CLUSTER_BASE_URL`，包括 OAuth 成功/失败回调、membership/protection 查询及 Console 管理调用。
7. **业务入口与健康**：部署方必须实际提供可达的可信 LB、后端发现、逐副本 `/readyz` 探测、路径转发、流式超时和网络 ACL。只设置 `PROXY_REPLICAS=2` 或一个 DNS 名称不构成这些能力。不要依赖 sticky session，不自动重放推理或有副作用的内部请求。

### 2.1 必须统一的池配置

| 配置 | 默认/范围 | MySQL 生效方式 |
| --- | --- | --- |
| `ACCOUNT_ROUTING_MODE` / `STORAGE_DRIVER` | `caller-lease` / `mysql` | 由新 overlay 固定 |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | 必填；例如 `pool.example.test` | 持久化域名 + fingerprint |
| `POOL_WARMUP_MODEL` | 必填；使用该部署已批准且可用的模型 ID | fingerprint；填写本身不执行 warmup |
| `READY_IDLE_TARGET` | 10；0–10000 且不超过 cap | 仅首次 seed，以后改共享 `idle_target` |
| `POOL_MAX_ACCOUNTS` | 100；1–10000 | 仅首次 seed，以后改共享 `max_accounts` |
| `CALLER_LEASE_TTL_SECONDS` | 172800；60–2592000 | 仅首次 seed，以后改共享 `lease_seconds` |
| `PROVISIONAL_LEASE_TTL_SECONDS` | 300；10–3600 | fingerprint |
| `PREWARM_POLL_SECONDS` | 5；1–3600 | fingerprint |
| `PREWARM_CONCURRENCY` | 5；1–20 | fingerprint |
| `POOL_LOGIN_MAX_PENDING` | **5**；1–100 | fingerprint；池 dispatch/wait 总占槽上限 |
| `POOL_EXHAUSTED_RETRY_AFTER_SECONDS` | 30；1–3600 | fingerprint |
| `POOL_REQUEST_TIMEOUT_SECONDS` | 120；5–600 | fingerprint；不把 SQL 预算提高到该值 |

同一数据库的 fingerprint 校验上述全部不变量选项，而不只域名。默认值也属于有效配置；所有副本、迁移进程必须使用一致值。以后新增不变量也要纳入升级计划。

**不变量不能通过“改所有副本 env，再重启”直接修改。** 现有 fingerprint 会拒绝不一致启动；域名/模型/并发/Login 上限等变化须有专门审查的持久化配置变更与 rollout/迁移方案。当前 API 只支持版本化修改 target/cap/lease/paused，不自动改 fingerprint。不能删除 settings 或手工改 hash 绕过；不要沿用只针对 SQLite 的“修改 warmup env 即可”建议。

## 3. Compose overlay、CA 挂载与可信 LB

### 3.1 文件顺序及其实际效果

使用 `docker-compose.yml` + **`docker-compose.user-pool-mysql.yml`** + 部署方的最后一层 override。**不要同时使用 `docker-compose.user-pool.yml`**，它用于 SQLite 单 Proxy。`docker-compose.mysql.yml` 也不是这里所需的外部生产数据库/LB 方案。

MySQL pool overlay：

- 强制 caller-lease/MySQL 和必要身份头，默认两个 Proxy；
- 把 SSO/Login/Console 指向 `PROXY_CLUSTER_BASE_URL`；
- 使用 `ports: !override []` 移除 Proxy 固定 host 3000 端口，避免 scale 端口冲突；Proxy 仍在容器网络监听 3000；
- 使用 `volumes: !override []` 清除 Proxy 的 SQLite 数据卷及**此前所有 Proxy volume 挂载**；
- 关闭 Proxy error diagnostics 并启用脱敏；
- **不创建 MySQL，不创建 LB，不提供公网入口，也不改变 SSO/Login/Console 的单实例/卷。** 基础 Compose 中其他服务的 host ports 仍在，必须按部署安全要求限制。

需要支持 `!override` 的 Docker Compose v2（2.24.4 或更高）。CA 即使已在较早文件挂载，也会被清空；因此必须在**MySQL overlay 之后的最后 customer override**恢复只读 CA。不能只设置 `MYSQL_SSL_CA_PATH` 而不挂文件。

以下片段属于部署方私下维护的示例 override，不是仓库已经提供的 LB 服务。CA 源路径通过安全配置给定，容器内路径与 env 一致；不要重新挂回 `proxy-data`。

```yaml
services:
  proxy:
    environment:
      MYSQL_SSL_MODE: verify-ca
      MYSQL_SSL_CA_PATH: /run/mysql-ca/ca.pem
    volumes:
      - ${MYSQL_CA_FILE:?set an approved CA file path}:/run/mysql-ca/ca.pem:ro
```

### 3.2 一个可实施的私网 LB 示例

若已有可信 LB，按本节路由/探测要求配置它即可，不必再叠加一个。若选择与应用同一 Compose 网络的 HAProxy，可在上述**同一个最后 override**中合并下列服务/网络片段，并把下一段配置保存到受控 `haproxy.cfg`。合并 `proxy` 字段，不写重复 YAML key；此处仅为 operator 模板，镜像须按发布流程审核并固定 digest。

```yaml
services:
  proxy:
    networks:
      default:
        aliases:
          - pool-proxy.example.test
  proxy-lb:
    image: haproxy:3.0
    restart: unless-stopped
    volumes:
      - ${POOL_LB_CONFIG_FILE:?set the reviewed HAProxy config path}:/usr/local/etc/haproxy/haproxy.cfg:ro
    networks:
      default:
        aliases:
          - proxy-lb.example.test
    # Deliberately no published host ports. Only trusted private-network clients connect.
```

HAProxy 配置示例（最多发现 20 个 Proxy 地址，这是示例后端槽位数，不是已验证容量）：

```text
global
    maxconn 2048

defaults
    mode http
    timeout connect 5s
    timeout client 650s
    timeout server 650s
    timeout check 5s
    retries 0

resolvers docker
    nameserver dns 127.0.0.11:53
    resolve_retries 3
    timeout resolve 1s
    timeout retry 1s
    hold valid 5s

frontend trusted_business
    bind :8080
    acl supported_path path -i /v1/models /v1/messages /v1/messages/count_tokens /chat/completions /responses
    http-request deny unless supported_path
    default_backend pool_proxies

frontend trusted_internal
    bind :8081
    acl internal_path path_beg /api/ /internal/
    http-request deny unless internal_path
    default_backend pool_proxies

backend pool_proxies
    balance roundrobin
    option httpchk
    http-check send meth GET uri /readyz ver HTTP/1.1 hdr Host pool-proxy.example.test
    http-check expect status 200
    default-server inter 2s fall 3 rise 2
    server-template proxy 1-20 pool-proxy.example.test:3000 check resolvers docker init-addr libc,none
```

配置与网络契约：

- 内部服务设置 `PROXY_CLUSTER_BASE_URL=http://proxy-lb.example.test:8081`，不带 `/api` 后缀。可信业务网关的 Proxy root 使用 `http://proxy-lb.example.test:8080`；两个 listener 使用同一组 MySQL Proxy 后端，不需要 callback owner 粘滞。
- 8080 只允许模型路径；8081 仅允许 `/api/`、`/internal/`，由 Proxy 再校验 `X-Internal-Token`。两者都不是公网鉴权入口。路径 ACL 本身不是身份认证，服务 token 必须仍由 Proxy 验证。
- 示例不向 host 发布任何 LB port。业务网关必须实际接入这个受控网络（或使用部署方审核的私网连接/服务发现）。外部 LB 不能凭空访问 Compose 私网地址；采用外部设备时要另行提供可路由后端网络及 ACL，不能为图方便开放所有 Proxy host ports。
- 若客户现有 overlay 已覆盖网络，保留应用互通并将 LB 和 Proxy 加入同一个受控网络。不要复制共享文件或扩容 SSO/Login/Console 来解决 DNS/回调问题。
- 私网示例不做 TLS termination；跨不可信网络必须由部署方提供受信 TLS/mTLS 及访问控制，不把内部 token 明文送过公网。SSO 的公开 URL/证书由原部署维护。
- 保留请求路径、业务服务鉴权和可信 caller hash；不要在公网入口透传客户端指定的内部 token/身份头。不要对流式响应开启全量缓冲；客户端/server idle timeout 应大于配置的最长请求时间。示例 650 秒不是性能承诺。
- 对每个后端探测 `/readyz`，失败即摘除。`/healthz` 不能替代 DB readiness。不要把“非 scheduler owner”作为摘除条件；MySQL standby 应接流量。LB 自身的监控/冗余仍由部署方负责。
- 不配置自动重试/redispatch 来掩盖不明的推理/开通请求结果；不记录鉴权头、请求体、caller 全值或 token。上述 LB 配置本身也必须在隔离环境验证，不能把示例等同于已验收配置。

### 3.3 可重复的 Compose 命令前缀

从发布 checkout 的仓库根目录操作。`DEPLOY_ENV_FILE`、`POOL_OVERRIDE_FILE`、`COMPOSE_PROJECT` 由运维安全提供；现有部署必须使用原 project 名。不要打印展开后的 secret 配置；`config --quiet` 只校验，不展示值。

```sh
pool_compose() {
  docker compose --env-file "$DEPLOY_ENV_FILE" --project-name "$COMPOSE_PROJECT" \
    -f docker-compose.yml -f docker-compose.user-pool-mysql.yml \
    -f "$POOL_OVERRIDE_FILE" "$@"
}
pool_compose config --quiet
```

先私下审核合并结果：仅 Proxy scale、Proxy host ports 为空、CA 挂载存在、SSO/Login/Console 原卷不变、三者使用统一 LB URL、所有 Proxy 同一 MySQL 和 fingerprint 配置。若使用自己的外部 LB，后续命令去掉示例 `proxy-lb` 服务；**不要去掉 LB 这个前置条件**。已有镜像必须与验收版本一致；`--no-build --pull never` 避免 cutover 时临时拉取或构建不同版本，镜像准备在维护前另行完成。

## 4. 新建空池的启用顺序

1. 完成第 2–3 节并 provision 专用空 MySQL。首次启动先统一设置 **`READY_IDLE_TARGET=0`**，避免默认 target 10 立即触发真实补池；保留已批准的 domain/model/invariants，设置合理 cap。新 settings 默认未暂停，target 0 只是安全 bootstrap，不能替代已有池的 pause。
2. 在关闭业务入口的条件下，先启动一个 Proxy 及单实例依赖。使用示例 LB 时：

   ```sh
   pool_compose up -d --no-build --pull never --scale proxy=1 sso login proxy proxy-lb console
   pool_compose ps
   ```

3. 确认 Proxy 已完成 schema/fingerprint 初始化、容器 `/readyz` 健康且报告 `storage: mysql`，LB 对该后端检查通过，Console 可从 LB 获取摘要。新池库存应为空；不要用真实推理/补池作为未经授权的健康探测。
4. 在 Console 暂停预热，保存版本化 settings。无 Console 时，使用已批准的内部管理客户端先 `GET /api/user-pool/summary` 获取 `settings.version`，再 `PATCH /api/user-pool/settings`，body 为 `{"expectedVersion":<最新版本>,"changes":{"paused":1}}`。示例中的版本占位符必须替换；遇 409 重新读取，不强制覆盖。
5. 业务入口仍关闭，扩大 Proxy：

   ```sh
   pool_compose up -d --no-build --pull never --no-deps --scale proxy=2 proxy
   ```

   同时把受控部署配置中的 `PROXY_REPLICAS` 保持为预期值，后续命令使用一致 `--scale`。验证每个后端 readiness、LB DNS/健康摘除/回调路径，以及同一配置、同一个共享池。owner 不必出现在管理 summary 中，观察方式见第 7 节。
6. 在获得真实开通/席位/warmup 的**独立授权**之前保持 target 0 且 paused。正式启用时通过共享 settings 设置 target/cap、解除暂停并观察实际 ready 库存，然后开放网关流量。提高 target 或解除暂停可能触发真实 EMU/席位/模型活动，它们不是“测试命令”。不通过手写 ready/假 token 跳过生产验证。

## 5. 常规变更、扩容与维护

- **仅扩容/替换 Proxy**：不改变 fingerprint 配置或 MySQL 目标；先确认连接预算、CA 和 LB 后端发现，再逐个加入/摘除。对待退役 Proxy 先停止 LB 新 admission 并排空已有请求；进程强制关闭可能中断流，不能承诺无中断 rollout。
- **target/cap/lease/paused**：通过 Console 或版本化 settings API 修改，所有副本共享；改 env 不覆盖已有 settings。下调 cap 不等于删除已有账号或退席位。
- **domain/model/并发/Login 上限等不变量**：按第 2.1 节另行规划持久化变更和 rollout，不做普通 env reload。SSO/Login/Console 回调始终保留同一 LB root，不在变更中指向旧 SQLite 或单独某个 Proxy。
- **维护暂停**：pause 阻止新补池步骤/终态槽位观察，不是停止业务 admission 的开关，也不证明已经派发的外部操作全部结束。迁移/备份必须另行关闭网关入口并排空、停止写进程。
- **MySQL 故障**：新池请求 fail closed，hold 检查失败会中止本地流；不要切换到旧 SQLite 或通过重试上游请求假装恢复。确认数据库写主库、连接池饱和/锁竞争及 commit 不明结果后再恢复。
- **备份**：分别维护 MySQL 和单实例 SSO/Login/Console 的备份/证书保管策略；恢复必须考虑 OAuth 外部任务、账户与 lease 的一致性。MySQL 备份本身不包含另外三个服务的数据。

## 6. 现有 SQLite caller-lease 池的离线迁移

**不保证零停机。** 本流程复用现有账号、OAuth 凭据、租约和单实例服务；迁移程序不发 SSO/SCIM/Login/GitHub/席位/模型请求，不需要通过新增席位“搬池”。旧 `upgrade:sqlite-to-mysql` direct 工具不能替代此流程，它没有完整 pool 语义。专用工具也不是把任意 direct 账号自动纳管成池成员的工具。

### 6.1 维护前与源库封存

1. 先在合成环境演练。记录受控版本、源 schema、池配置（尤其 domain、warmup 及全部 fingerprint 不变量）、target/cap/lease/paused、数据计数和回滚责任人；不在报告中粘贴 caller、凭据或客户标识。
2. 暂停补池，关闭新的业务 admission，排空所有推理/catalog、已派发 Login、SSO 创建/SCIM/席位操作及回调。取消 Login 任务并不证明浏览器已停止；不明结果先依正式运维流程核对。paused 或停止 Proxy 单独一项都不足以满足迁移条件。
3. 停止所有旧 Proxy writer/scheduler 及任何可能回调修改源的服务，确保 owner 不再有效；保留原部署文件、卷、证书、凭据及原始 SQLite。源必须 paused 且不 busy：无任何 hold（过期的也不行）、无 identity init claim、无 provisioning/refreshing、无未结束 account OAuth attempt 或未确认外部意图。failed/disabled 上未解决的 task/nonce 也需先核对，不能清空字段骗过 importer。
4. 用批准的 SQLite 一致性备份方式生成**独立离线副本**。不能只复制运行库的 main 文件而丢掉未合并 WAL。输入须 rollback-journal 格式，且无 `-wal`、`-shm`、`-journal` sidecar。若备份仍为 WAL 模式，在确认一致性的前提下仅对可丢弃备份制作新独立副本或转 `journal_mode=DELETE`；**不在原始/运行数据库上做此转换，不简单删除 sidecar**。
5. 工具以 readonly/query_only 和单一读事务校验 schema、integrity、foreign keys、各表数据和值关系，不修改/升级源；验证 SQLite 标准 credential trigger 定义。MySQL target/runtime 共用标准DDL，检查关键类型/二进制collation、完整主键/唯一键、FK动作、必要index/CHECK、trigger body。未知自定义结构拒绝，不能依赖自动重建/修复。保留上游已知无marker的TEXT token collation升级，已有marker后偏离则拒绝。
6. **统计保留策略**：记录并统一 `REQUEST_STATS_PER_ACCOUNT_LIMIT`（默认每账号 2 条），按业务要求单独归档历史。importer 保存统计不代表 runtime 永久保留；启动和新请求都会执行 retention。启动现先校验 pool fingerprint，再 prune，再启动 worker；错误配置不裁剪统计，正常启动仍按保留策略裁剪。

### 6.2 只读预检与目标导入

在受控离线副本上先执行 source-only dry-run（路径仅为示例）：

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite --dry-run
```

它不连接 MySQL、不加载 `.env`、不检查/写目标，只输出表计数。dry-run 通过不是外部任务确已停止的证明。

准备目标：

- 外部专用**空** MySQL 8/InnoDB 数据库；停掉所有指向目标的应用，不让 Proxy 提前补池。禁止混入另一环境或已有 pool 数据。
- migration 账号具备建 schema、DML、校验与 advisory lock 权限；内建连接池 `MYSQL_CONNECTION_LIMIT` 3–100，默认 3。programmatic 注入池至少三个连接。
- 安全环境注入 `MYSQL_URL`；工具拒绝 `--mysql-url` 和 URL query overrides，不读取 `.env`。不要把密码/连接串写在参数或执行记录中。
- 对非 loopback 目标必须 `MYSQL_SSL_MODE=verify-ca` 且 `MYSQL_SSL_CA_PATH` 指向**迁移进程可读的** CA。此时不是容器内路径，除非迁移进程确实在挂有该文件的容器内。disabled/required 只允许 loopback。
- 注入正式部署的 `POOL_WARMUP_MODEL` 及全部不变量，包括 `POOL_LOGIN_MAX_PENDING`；backup 提供 domain 和可变 settings，显式冲突域名会拒绝。未指定的不变量使用当前 `readPoolConfig` 默认值。导入 seed 的 fingerprint 必须与后续每个 Proxy 完全一致，不能用临时模型值先导入再改 env。

确认隔离后运行：

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite \
  --confirm-offline-source --confirm-empty-target
```

两个确认旗标是运维声明，不会替操作者停止外部服务。工具保留 accounts/真实 OAuth 凭据、caller/lease stats、settings/version/next ordinal、inventory/generation/recovery、lease/cooldown/events；TTL 不续期，历史时间不刷新。只有已结清且经过验证的 ready/cooling 历史 Login 关联可保留，详细条件见 importer 文档。owner 清除、owner deadline 归零，目标强制 paused。

### 6.3 失败处理与切换

- importer 持有 target advisory lock；在一个 serializable DML 事务内锁 settings、确认空表、复制并读回比对所有字段/关系/计数，包括不输出到日志的凭据相等性。**DDL 和初始化 seed 可在失败后保留**，不能把“一个 DML 事务”误读为目标完全不留痕。
- `commit_outcome_unknown` 或 `rollback_unconfirmed` 后维持维护状态，私下检查目标；不要盲目重跑、删库、恢复源流量或同时启用两边。工具不自动重试写入，也不合并非空目标。成功导入即使源为空也不能当成未使用目标重跑。
- 成功后按第 3 节的 **MySQL overlay + 最后 CA/LB override**，启动一个 MySQL Proxy，保留 imported paused。此时移除旧 SQLite pool overlay；不删除旧 Proxy SQLite 卷，只是不再把它挂给新 Proxy。
- SSO/Login/Console 仍是原单实例和原卷，统一重配 Proxy root 到 LB。确认它们没有指向旧 Proxy/SQLite 的回调地址。业务入口先保持关闭，核对 `storage: mysql`、列表总数/分页、settings/domain、lease deadline、凭据保留验证摘要和内部调用路由。不要用创建新账号/席位“证明迁移成功”。
- 通过经批准的验收后扩为两个或更多 Proxy，确认 LB 每个后端 readiness 和同一共享池，再按业务批准计划解除暂停/开放流量。预热恢复可能新增账号/席位，是迁移以外的独立操作。
- **禁止旧 SQLite 与 MySQL 同时接流量。** 在目标完全未发生新写入前可在维护窗口放弃 cutover、返回受保护源；目标一旦有写入（包括启动后的 scheduler/reclaim 写入），旧快照就可能过时。切后回滚需要另行一致性核对/反向迁移计划，不能直接切回旧文件。无法确定写入边界时按已写入处理。

## 7. 日常观察、管理接口与排障

所有 `/api/user-pool` 管理接口需 `X-Internal-Token`；Console 在 `/api/console/proxy/user-pool` 下以已认证管理会话转发。不要把此 token 发给浏览器外的普通调用者或作为公开请求示例。

- `GET /api/user-pool/summary`：共享 settings/counts/limits，列表为空。当前 DTO 不保证提供 owner/active/standby/全局 hold 数。字段缺失不是“没有 scheduler”的证据；这个 endpoint 实际存在，也不是旧全量 overview。
- `GET /api/user-pool/page/accounts?page=1&pageSize=25`（leases/events 同样路径）：服务端默认 **25**、最多 **100**，返回过滤后的 `total`；支持 `q`（最长 255）及各列表允许的 `state`。大库存检查用分页和 total，不把旧数组上限当总量。
- 兼容 overview `GET /api/user-pool` 和旧 `/accounts`、`/leases`、`/events` 仍有 **1000/1000/200** 上限，未被删除，也未变成无界导出。
- `PATCH /api/user-pool/settings` 使用最新 `expectedVersion`；reconcile 只唤醒本机 worker，不保证立即唤醒远端 owner，最终由轮询发现共享变更。
- disable/retry/resume 不等于删账号、撤 OAuth、撤 key 或退席位；release 需显式确认且不能释放仍有 hold 的 lease。不要通过数据库手改状态绕过这些保护。

| 现象 | 应检查/处理 | 不应做 |
| --- | --- | --- |
| 新副本启动提示 pool configuration differs | MySQL 数据库/域名、所有 fingerprint 不变量及迁移所用值 | 删 settings、改 hash 或只换该副本 env |
| `/healthz` 正常而 readiness/业务失败 | DB 网络、CA 实际挂载、写主库、连接预算；LB 使用 `/readyz` | 只看存活就恢复流量，或因 standby 摘除后端 |
| SQL deadline/连接池排队/锁竞争 | 每池操作 5 秒总预算，包含 queue/commit/rollback/retry；单 settings 锁竞争和 DB 状态 | 提高 120 秒 request timeout 以为会加长 SQL 预算；自动重放 commit 不明的请求 |
| 补池暂不推进 | paused、owner lease、retry_at、阶段分布、cap与持久化Login占槽；满槽starter应跳过，普通wait/warmup应得到优先处理 | 凭summary无owner字段判无owner；手动开启多worker或清槽绕过原子claim |
| Login 上限满且有 failed/disabled dispatch/wait | 未暂停有效 owner 每 poll 从最多 100 条候选轮转观察最多 10 条；只匹配 success/failed 才释放 | 把 cancelled、404、超时当作已停止，清 nonce 或重复 POST |
| 终态占槽已释放但成员仍 failed/disabled | 这是设计：保留 state/attempts/error，success 移 warmup、failed 移 synced；按保护规则处理人工 retry/resume | 认定释放容量会自动 ready、自动重试或新建席位 |
| 401/429 后请求失败 | 401 为既有成员重授权且不 replay；429 保持绑定/冷却 | 为同 caller 换账号规避冷却，或把原请求重放当故障恢复 |

需要 owner/hold 细节时使用安全 worker 日志和经授权的**只读**数据库观察，如在受控客户端检查 singleton `user_pool_settings.owner/owner_until` 与 DB 当前时间、hold 计数；不要修改 owner 来“测试接管”。对外仅报告必要聚合，不输出凭据、caller 全值或高基数标识。`/readyz` 的通用 MySQL ping 现同样有单次获取连接/SQL 5秒预算，但它仍不是完整端到端健康证明。

## 8. 测试政策与验证记录

### 8.1 严格安全边界

- **所有测试数据均为 synthetic**；禁止访问真实租户、EMU、SCIM、席位管理、真实 OAuth 或真实模型。真实 MySQL 测试仅表示数据库引擎真实，不代表账号/上游真实。
- 不启动、重建、停止原真实环境，不读取其 env、证书、账号、SQLite 或 volume。使用独立本地 MySQL/临时目录/隔离 mock 网络，禁止上游出网。
- 历史2000成员HTTP负载预置合成Ready和假token；另有独立 [0→2000自动建池](user-pool-provisioning-2000-test.md) 从空库存由真实Worker完成mock预热，不直接写Ready。两种测试都不是客户导入工具，也不是绕过生产warmup的操作指南。
- 清理只针对明确验证过的 disposable 测试库/project。拒绝未知/非测试/非空导入目标，不做全局 Docker prune，不以解除安全门禁换取测试通过。
- 不提交客户名称、标识、URL、密码、真实 hash 或凭据；本文域名仅使用 example 域。不要把生产配置复制为测试配置。

### 8.2 可复现入口（并非已执行声明）

使用已安装依赖、未加载部署凭据的隔离测试 shell。完整命令、源码状态、退出码和 skip 情况要由实际执行者记录。

```sh
npm run typecheck:deploy
npm --workspace @ghcp/proxy test
npm run test:upgrade:user-pool-mysql
```

- 最新deadline/worker/slot/paging及`scheduling.worker.test.ts`真实Worker异步推进回归在Proxy套件内；`scheduling.test.ts`同时提供SQLite与opt-in MySQL积压选择契约，MySQL使用下条相同门禁。不能把integration的skipped计为passed。
- `src/proxy/src/userPool/mysqlStore.integration.test.ts` 需显式 `MYSQL_POOL_TEST_DISPOSABLE=1` 和 `MYSQL_TEST_URL`；URL 仅允许 loopback、`ghcp_pool_test_*` 测试名称，不允许 URL query。测试创建/删除随机 sibling 数据库，不使用应用 `MYSQL_URL`，只准独立 disposable MySQL。
- importer MySQL 测试需 `RUN_USER_POOL_MIGRATION_MYSQL_TESTS=1` 与 `USER_POOL_MIGRATION_TEST_MYSQL_URL`，loopback 数据库名称门禁为 `user_pool_migration_test`；创建/删除随机后缀库，不使用 `MYSQL_URL`。默认离线迁移测试只用临时合成 SQLite。
- 多 Proxy smoke/failover/load 入口与隔离限制见 [MySQL harness](../tests/docker-user-pool/README.mysql.md)。这是独立 test overlay，不能和部署 overlay 混用，也不能把测试端口/合成数据工具搬到现有环境。实际启动、stop-owner/restart、load、清理都需单独按门禁执行；语法校验不等于 runtime 通过。

最新扩展测试另发现即时MySQL连接故障曾绕过deadline错误映射，返回500/502。现在由驱动边界限定识别并返回安全503，不暴露数据库原始消息，不改变重试策略。类型检查和完整Proxy回归已通过，实际故障复测与夹具断流问题按轮次记录于[扩展测试报告](user-pool-extended-test-report.md)。

### 8.3 当前验证状态

热点caller隔离已实现：借MySQL连接前的同caller FIFO（1active＋最多32queued，进程1024tickets）与5秒共享预算，原生共享池queueLimit1024。原数据库命名锁保留，推理本身不串行化。实际双Proxy热点锁6.5秒时，B探针由修复前约4.91秒降为23/31ms且200；取消、hold、重放和队列恢复检查通过。新检查点本地Proxy394pass/8条件skip、真实MySQL组合43pass/0skip（组合范围不同，不与旧47项直接比大小）、类型检查/部署构建通过。最新验证及限制见[caller隔离报告](user-pool-caller-isolation.md)。下面的storage-error-v3结果属于此前候选。

此前storage-error-v3连接错误修复检查点：完整Proxy375tests/368pass/0fail/7条件skip，workspace与两套upgrade类型检查通过；隔离MySQL scheduler/pool/admission/recovery/lifecycle组合47pass/0fail/0skip，含父包装及少量离线控制，不与完整Proxy计数累加。旧调度镜像14阶段HTTP生命周期通过，新storage-error-v3镜像第三轮真实MySQL重启通过；30分钟soak已完整通过（1807秒、5083请求、0意外错误）。以下325/45为此前检查点，最新完整范围见[扩展报告](user-pool-extended-test-report.md)。

调度修复后：全Proxy **330 tests/325pass/0fail/5DBskip**，全workspace与两套upgrade typecheck通过；云端随机隔离MySQL的scheduler/pool/admission/recovery合计 **45pass/0fail/0skip**。真实Worker+realProvisioner异步回归通过，旧排序负向对照失败。新Proxy镜像构建及双副本精确digest核对完成；新空库0→2000的最终结果见 [建池报告](user-pool-provisioning-2000-test.md)。

前一候选结论见 [生产前审查修复记录](user-pool-mysql-production-review.md)：8个失败断言对应问题已修复且补入正式回归。当时typecheck/build、Proxy323通过/4个独立DB入口跳过；独立MySQL repository1、pool/admission38、恢复5、迁移66、Linux浏览器4、SSO31/Login12/Console6、离线hook+Compose23通过。两款镜像构建及双Proxy smoke/接管/健康后重启通过。这些是此前分批证据，不是全部在最新调度镜像重跑；客户环境验收仍未进行。

以下为更早的电脑重启后验证，原记录保留在 [MySQL验证记录](user-pool-mysql-validation.md)，不是已覆盖最新故障复现：

- caller锁正确性只读复核，未发现可确认阻塞；不是无漏洞保证。
- 全workspace类型检查通过；完整Proxy回归256通过、0失败、3个独立数据库集成入口跳过。此前caller-lock真实MySQL两套契约合计38项通过。
- 最新双Proxy实际HTTP smoke、停止第一实例的接管、恢复/重启验证通过，绑定和凭据保留，无重复开通。
- 2000合成成员、25并发、两轮4000推理及22管理/目录请求全部HTTP200，零错误。首轮53.798秒，次轮79.310秒；page20、跨副本排他租约、统计归属及最终hold排空检查通过。
- 原四轮25并发和5并发失败结果完整保留；本轮主机重启/背景负载和代码同时改变，不将全部改善归因于单项代码优化。
- 迁移49项及SSO31/Login12/Console6、Linux页面、Compose6、LiteLLM17+5、四镜像构建和audit通过结果为此前分批证据，不与本轮简单相加。
- 未连接真实GitHub/SCIM/Copilot，未创建真实EMU或添加席位；未修改/恢复原真实SSO项目。

这不是生产吞吐上限、客户延迟SLO或MySQL/LB高可用验收。当前分支未commit/push，客户实际副本迁移和代表性资源验证仍需单独授权。
