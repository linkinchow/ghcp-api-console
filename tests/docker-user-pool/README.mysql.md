# 隔离的多 Proxy MySQL 测试夹具

此测试框架用于验证**两个实际的 Proxy 容器共用一个 MySQL 8.4 数据库**的场景。SSO、Login 和 Console 均使用实际的应用镜像。仅模拟 SCIM、席位分配、OAuth 完成流程和推理。它绝不会预配 GitHub 用户或调用真实模型。

## 安全要求与前置条件

- 固定的 Compose 项目：`ghcp-user-pool-mysql-test`。不会操作其他项目的容器或卷。
- 镜像：`ghcp-pool-mysql-proxy:check`（两个副本）、`ghcp-pool-mysql-sso:check`、`ghcp-pool-mysql-login:check`、`ghcp-pool-mysql-console:check`、`mysql:8.4`、`node:22-bookworm-slim`。
- **从包含当前 MySQL 实现的检出目录**构建应用镜像，而非过时的工作树。Compose 构建上下文相对于此测试夹具目录。启动器的 `build` 操作会先构建一次 Proxy，然后构建 SSO/Login/Console。
- 需要 Node 22、Docker Compose v2、PATH 中可用的 OpenSSL，以及仓库中已安装的 `mysql2` 依赖。测试不会执行 `npx`、安装依赖或拉取镜像。`up` 使用 `--no-build --pull never`；缺少的镜像须另行准备。MySQL 镜像拉取受阻意味着运行时测试受阻，而非测试通过。
- 所有应用服务和 MySQL **仅**连接到 `internal: true` 网络。只有目标固定的桥接服务会加入预览网络并发布回环端口。它没有 Docker 套接字、主机网络、任意转发目标、可执行命令的 HTTP 端点或可写的主机绑定挂载。
- 此测试夹具中的所有凭据均为公开的合成凭据，仅供测试使用。不会读取任何已有的 `.env`、`.env.example`、`local-run.json`、部署目录或证书。应用镜像不会挂载这些文件。请勿在此使用真实凭据。
- `launch-mysql.mjs` 会通过操作系统的 `mkdtemp` 创建一个唯一目录，其中包含有效期为两天的自签名 SSO 证书、空的 Compose 环境变量文件以及合成的 MySQL 初始化 SQL。OpenSSL 会直接启动，不经过 shell。绝不会覆盖已有文件。打印的 `MYSQL_FIXTURE_STATE` 路径所指的文件包含配置路径，但不包含密码。请保留此路径以供生命周期操作使用；临时目录按设计不会自动删除。

发布的端口（仅由桥接服务发布）：

| 回环端口 | 目标 |
| --- | --- |
| 18100 | Proxy 1，服务名为 `proxy` |
| 18101 | Proxy 2，服务名为 `proxy2` |
| 18102 | 模拟测试夹具及只读的 SSO/Login 检查接口 |
| 18104 | Console |
| 33184 | 通往测试 MySQL 的固定 TCP 桥接服务 |

每个 HTTP 根路径都会暴露 `/__mysql/manifest`，用于标识此项目和测试夹具。在进行任何更改之前，脚本会验证这些清单，**同时**验证实际应用的健康状态/就绪状态响应。Proxy 的 `/readyz` 必须报告 `storage: mysql`；模拟服务自身的健康状态必须报告 `fixture: true`。实际 SSO/Login 的健康状态和列表通过只读的 `18102/__mysql/{sso,login}/...` 路由转发；无法通过这些路由提交真实的 Login 任务。

## 通过预览启动

父会话负责管理 `.claude/launch.json`，并使用 `preview_start` 启动服务器。合适的配置条目如下：

```json
{
  "name": "user-pool-mysql-test",
  "runtimeExecutable": "node",
  "runtimeArgs": ["tests/docker-user-pool/launch-mysql.mjs", "up"],
  "port": 18104
}
```

请勿通过 Bash 运行服务器。启动器会保持附着于 `docker compose up`，并转发终止信号。这不会改变原有的 SQLite 测试框架。

若只需准备文件而不启动容器，请使用 `node tests/docker-user-pool/launch-mysql.mjs prepare`。能够访问软件包和基础镜像后，可独立使用 `build` 操作。若要复用已生成的目录，请追加 `--state=/absolute/path/to/run.json`。未提供状态参数时，`prepare`、`build` 和 `up` 每次都会创建一个新目录。不会隐式查找状态。

生命周期操作始终要求显式指定状态路径：

```text
node tests/docker-user-pool/launch-mysql.mjs stop-owner --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs start-owner --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs restart-replicas --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs down --state=/absolute/path/to/run.json
node tests/docker-user-pool/launch-mysql.mjs destroy --state=/absolute/path/to/run.json
```

脚本本身绝不会重启容器。`down` 会保留测试卷。从冒烟测试切换到负载测试时，优先使用新的 `POOL_MYSQL_VOLUME_SET`（小写字母、数字和连字符，最多 32 个字符）：这样会选择一组带固定前缀的独立测试卷，同时保留之前的证据。每次生命周期操作都应使用相同的值。`recreate` 启动操作会重建所有测试夹具进程，包括内存中的模拟服务；仅更换数据库卷不会重置模拟状态。`destroy` 会删除当前选中的一次性卷组，必须由操作人员明确决定执行。更换卷组前，请先停止预览并释放测试夹具桥接服务的端口；绝不要删除其他项目的卷。

## HTTP 冒烟测试与故障转移

仅在预览报告整个服务栈健康后，才运行此一次性测试：

```text
node tests/docker-user-pool/mysql-smoke.mjs run
```

全新运行要求 Proxy、SSO、真实 Login 和模拟服务的存量均为空，且初始空闲目标为零。测试执行以下步骤：

1. 检查健康状态、经认证的测试夹具标识以及两个 MySQL 就绪状态；以只读方式检查 SQL 单例/迁移、存活的调度器所有者及续期。
2. 检查跨副本的设置版本冲突；使用实际 SSO 和模拟 SCIM → 席位 → 假 Login 回调 → 模型目录/预热，通过真实工作进程将账户预热至两个。冒烟测试不会预先填充源系统存量或 SQL READY 记录。保持不变的测试夹具回调有意指向 `http://proxy:3000`；Proxy 2 可以推进工作并使用共享凭据。
3. 检查规范模型目录，以及 Messages、Chat Completions 和 Responses 上的 JSON/SSE；同一调用方的并发请求和交替访问副本的请求最终使用同一租约/成员。不同调用方独占各自的成员；资源耗尽时的请求不会到达上游。
4. 自主补充一个备用成员；上游 429 会将冷却状态持久化并在副本间共享，**即使存在备用成员**，也不会续期、重放或轮换。
5. 检查保持中的 Responses 流、SQL 占用记录的可见性、通过另一个副本释放租约时被拒绝、客户端取消、上游断连，以及占用记录完全清空。
6. 检查模拟预配/回调次数精确匹配、SQL 租约唯一性及占用记录数量有界。不会打印身份、调用方哈希、凭据或原始 SQL 错误。

测试结束后会保持预配暂停，并打印唯一的 `MYSQL_SMOKE_SNAPSHOT` 路径。快照包含哈希、计数器和到期时间，不含身份/令牌。如果需要更多时间，`prepare-failover` 会创建新快照并为健康的测试调用方续期；可通过第三个参数显式传入新的快照路径。文件采用排他创建方式，而非覆盖已有文件。

对于从全新状态开始的所有者故障转移：

1. `proxy2` 最初依赖 `proxy` 就绪，因此 `proxy` 是初始调度器所有者。请勿在此流程之前执行接管。
2. 在 `run` 或 `prepare-failover` 之后，让父会话**仅停止 `proxy`**，使用 `stop-owner` 和启动器状态执行此操作。保持 MySQL、模拟服务、SSO、Login、Console 和 `proxy2` 运行。重启后立即恢复并不足以满足要求。
3. 在快照的 600 秒租约有效期内，运行 `node tests/docker-user-pool/mysql-smoke.mjs verify-failover /absolute/snapshot.json`。
4. 验证要求 Proxy 1 确实不可用，最多等待 45 秒以观察到不同的存活所有者哈希，检查所有权续期，并通过 Proxy 2 使用同一份已持久化的租约/凭据提供服务，且不重新预配。在固定的回调目标停机期间，不会尝试预配。
5. 让父会话执行 `start-owner`；两个副本均健康后，运行 `node tests/docker-user-pool/mysql-smoke.mjs verify-restart /absolute/snapshot.json`。同一模式也可用于在 `restart-replicas` 后验证两个副本。

调度器观测使用**仅有 SELECT 权限**的 `pool_observer` MySQL 用户，绝不会抢占或更新所有权。持久化的单例所有者、稳定续期和精确的副作用次数，是此场景的验证证据，并不能证明所有栅栏防护失效模式均已覆盖。命名 DDL 锁的交错执行、过期检查点、数据库分区以及结果不确定的外部副作用，需要单独的集成/工作进程测试套件验证。观测用户没有 TRIGGER 权限，因此无法检查凭据栅栏触发器的定义；测试改为检查启动时的迁移标记。

## 有界的 2,000 成员 HTTP 负载测试

请使用**全新的空卷组并重建模拟服务进程**，而不是沿用冒烟测试的三成员存量。这是一项需要显式启用、在主机上通过 Node 一次性运行的测试，不是服务器：

```sh
POOL_MYSQL_LOAD_CONFIRM=ghcp-user-pool-mysql-test node tests/docker-user-pool/mysql-load.mjs
```

可选参数：`--concurrency=25 --iterations=2`。并发数限定为 1–100；默认使用 25 个并发工作单元，对 2,000 个不同调用方执行两轮请求（4,000 次推理请求）。轮数限定为 2–4；包括管理/目录检查在内的 HTTP 实测请求总数保持在 10,000 以下。不会通过重试增加请求数。每个调用方的下一轮请求会使用另一个副本。请求交替使用全部三种受支持的协议，包括流式 Responses，并使用一个规范的已知模拟模型。

脚本**不提供主机、端口、数据库名或密码覆盖选项**：它只连接 `127.0.0.1:33184` 上的 `ghcp_pool_mysql_test` 数据库，检查数据库的合成测试夹具标记和 HTTP 清单，并要求确认环境变量的值精确匹配。`MYSQL_URL`、`MYSQL_TEST_URL` 和部署凭据均会被忽略。它不会截断或删除任何数据，并拒绝非空存量；重新运行需要全新项目。独立的 `pool_load` 用户仅对此数据库拥有 SELECT/INSERT/UPDATE 权限，没有 DDL 或删除权限。

填充数据前，脚本会通过共享的带版本设置暂停两个工作进程，并将空闲目标设为零。它在共享设置锁的保护下，插入恰好 2,000 条明显为合成数据的 READY 凭据/存量记录，然后仅在模拟适配器中注册这些合成令牌槽位。**只有负载测试数据集**会绕过预配流程；不应发生任何 SCIM/席位/Login 调用。原有的 `mock-services.mjs` 继续处理完整的真实工作进程冒烟测试链路，保持不变。适配器设置了固定的 20ms 上游延迟，以便观测持久化的占用记录。

负载报告包含 HTTP 阶段实际耗时、每秒成功请求数、状态/错误计数、各协议 JSON/SSE 的 p50/p95/p99 延迟、SQL 占用记录采样和管理页面延迟。它验证超出旧有 1,000 行上限的第 20 页、2,000 个活跃独占租约及其跨副本保持不变的调用方/成员分配、唯一的上游标记（无重放）、归属到调用方/租约的请求统计、无孤立或截止时间无效的占用记录，以及最终占用记录完全清空。仅打印数值聚合结果和固定标签。运行失败时会打印部分测量结果，并标记 `passed: false`；绝不会将数据填充时间计入推理吞吐量。

这些结果衡量的是本机、Docker、MySQL、池事务和微小的本地合成响应，而非真实模型延迟、GitHub 容量或生产吞吐量。此测试夹具有意不承诺吞吐量阈值。JavaScript/YAML 语法验证通过并不意味着运行时验证通过。

[生产审查与修复](../../docs/user-pool-mysql-production-review.md)记录了最初的失败以及 2026-09-14 的修复。另有回归测试覆盖同时到期、延迟 SQL、终态回调和 UI 排序；仅正常负载测试成功并不能验证这些情况。负载测试现在会断言第 20 页的账户身份/序号精确对应 1900–1999，并使用相同的数据库排序/偏移量比较租约 ID。新增的 `mysqlRecovery.integration.test.ts` 使用相同的一次性回环安全门禁，验证完整的 2,000 租约积压清理、列表前部被占用/繁忙时的公平性、无不必要补充，以及运行时解析器一致性。客户基础设施/SLO 验收仍须单独进行。

## 真实工作进程从 0 → 2,000 的预配测试

`mysql-provision-load.mjs` **不是** `mysql-load.mjs`：它绝不会预先填充 READY 存量、注册合成凭据、修改 SQL 或调用账户重试。它从零开始，请求真实的共享调度器通过实际 SSO → 模拟 SCIM/席位 → 排队的模拟 Login 回调 → 真实 Proxy 目录/预热验证，预配全部 2,000 个成员。真实 Login 保持运行但为空；不会调用真实浏览器 Login 或外部模型。

运行前，操作人员必须准备**全新的空 MySQL/SSO/Login 卷组，并重建内存中的模拟服务**。运行器会拒绝任何非空的存量、租约、请求/目录占用记录、冷却记录、身份初始化认领记录、请求统计和池事件；它绝不会通过删除或重置数据来通过安全门禁。合成负载适配器必须已取消注册。启动时，运行时空闲目标须为**零**。请使用当前的预配测试夹具配置，两个 Proxy 均设置 `PREWARM_CONCURRENCY=5`、`POOL_LOGIN_MAX_PENDING=5`，快速模拟 Login 队列设置为**并发数 1、延迟 50ms**。报告会记录队列的实际配置，并校验其并发数和待处理预留数量上限。

此运行器要求稳定性测试夹具提供经过身份认证、目标固定的 SSO 运行时设置桥接接口、`/test/counts` 及 `loginQueue` 诊断信息，以及 `stability-control.mjs` 资源快照。缺少这些能力时，它会按安全默认原则拒绝运行。在进行任何修改之前，会先读取并打印 SSO 上限，然后通过受支持的 `PATCH /api/settings/runtime`，使用 `expectedVersion` 和 `changes.maxSsoUsers` 将其精确设为 2,000。当前源码默认值为 **null/无限制**，而非假定的 1,000；已有镜像若配置了 1,000 的上限，会被检测到，而不会被静默忽略。不会编辑 SSO 数据库，也不会使用不受支持的环境变量上限。共享池设置通过其带版本的 API 更改为 `idle_target=2000`、`max_accounts=2000`、`paused=0`。

在隔离的 Azure **负载虚拟机**上，操作人员建立现有的 mysql-smoke 回环桥接服务，并验证固定的 SSH 强制命令密钥/主机密钥后，先执行**不注入故障**的首轮测试：

```sh
POOL_AZURE_SPLIT_FIXTURE=1 \
POOL_MYSQL_PROVISION_CONFIRM=ghcp-user-pool-mysql-test \
node tests/docker-user-pool/mysql-provision-load.mjs --members=2000
```

确认值必须精确匹配。HTTP/MySQL 目标、测试夹具标记、数据库名和观测用户凭据继承自 `mysql-smoke.mjs`；不提供目标/凭据覆盖选项，也不加载 `.env`。在分离模式下，资源快照和可选故障控制通过现有的固定 `stability-control.mjs` SSH 包装器执行，而不是任意 SSH/Docker 命令。本地模式仅操作该控制器的固定测试夹具容器。运行器不会启动任何服务。请勿对部署环境运行它，也不要与其他测试同时运行。

等待时间上限为两小时（另加有界的清理时间）。它每两秒轮询汇总、仅含计数的模拟状态、SSO 数量和**仅执行 SELECT 的** SQL，每 30 秒输出安全的进度信息，每 60 秒通过固定控制器采集容器/MySQL 指标。只有阶段/计数的向前推进才会重置 180 秒的停滞计时器；调度器续期不会重置。任何失败账户、预配失败事件、回调失败、SCIM 冲突、重复/超限计数或无进展时间段，都会使运行失败；不会用盲目重试掩盖问题。读取响应体时会限制大小，其中最终 `/test/state` 的上限为 4MiB（进度轮询期间绝不获取此端点）。

成功要求全部 2,000 条存量记录均处于 `ready`/阶段 `ready`，已通过验证且具有非空的有效 OAuth 凭据，身份/SSO/序号/任务关联唯一，SSO/模拟用户和席位数量精确匹配，恰好有 2,000 个 Login 任务和成功回调，且每个身份均完成一次完整预热。令牌和身份仅在内存中检查，绝不写入报告；SQL 返回凭据有效性布尔值，而不是令牌字节。两个 Proxy 的完整分页存量以及**实际第 20 页**都会与 SQL 比对，而不是信任被截断的旧列表。最后，两个不同调用方各自通过**每个** Proxy 发出一次请求（共四次金丝雀探测），以证明独占绑定稳定、归属统计精确、占用记录完全清空，且没有新增账户。这两个租约会通过受支持的 API 释放。最终池中有 2,000 个就绪的空闲成员，没有租约/占用记录，并保留四条金丝雀探测统计。

对于**单独的一次全新运行**，可选的 `--failover --failover-after=500` 会在至少 500 个成员就绪后仅停止 Proxy 1，验证不同的存活调度器所有者，并验证**在 Proxy 1 持续停机期间**仍有新增 READY 进展，然后恢复它。这需要稳定性测试的 LB 回调路由（基础测试夹具将回调固定到 Proxy 1，无法证明其停机期间仍在进行实时预配）。此模式仍要求冲突、失败和重复副作用次数均为零；在结果不明确的阶段发生中断，确实可能导致这项严格测试失败，而且绝不会自动修复。如果运行过快，在所请求的故障得以实际触发前就已完成，则不能算作故障转移测试通过。不会注入 MySQL 暂停故障。

`--members=2..1999` 仅用于较小规模的诊断；报告会显式设置 `full2000: false`，这些运行**不能**作为 2,000 成员的验证证据。默认值恰好为 2,000。打印的 `MYSQL_PROVISION_REPORT` 指向主机操作系统临时位置下的一个新目录，其中包含 `report.json` 和 `progress.jsonl`，创建时不会覆盖已有文件。它们仅包含固定标签以及聚合的计数/耗时/资源数据，不含令牌、密码、身份、调用方哈希、任务记录或原始传输/SQL 错误。成功后工作进程保持暂停。失败或中断时，运行器会先暂停共享工作进程并将空闲目标设为零，再恢复由它停止的 Proxy 1；它不会恢复预配、删除账户，也不会恢复低于新增存量数量的先前 SSO 上限。清理失败会报告为失败，不会被隐藏。请保留隔离环境中的证据，并在再次全新运行前由操作人员明确作出决定。

仅进行离线语法验证（不联网，不启动 Docker 或服务器）：

```sh
node --check tests/docker-user-pool/mysql-provision-load.mjs
```

## 独立的 MySQL 集成测试

端口 33184 也可用于单独授权的集成测试。当前集成测试套件要求 URL 的路径名以 `ghcp_pool_test_` 开头，并会创建/删除一个随机的同级数据库；**不要修改其安全门禁，使其指向此测试框架正在使用的池数据库**。仅在该明确限定范围的测试套件中使用合成 root 账户（密码位于 `compose.mysql.yaml`，而非运行时租户状态中）。冒烟/负载测试的观测用户绝不使用 root。请勿在测量负载的同时运行集成测试套件。

## 离线验证

`node --check` 可以在不打开套接字的情况下验证全部四个 `.mjs` 文件。请离线将 `compose.mysql.yaml` 解析为 YAML；Compose 配置验证需要预先准备好的临时测试夹具目录。不要仅为了检查语法就执行冒烟/负载/启动操作中的网络活动。
