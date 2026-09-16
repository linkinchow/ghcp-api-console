# v5 SIGSTOP/SIGCONT owner 到期进程验收

仅用于测试。源码基线恰好为 `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`（父分支 `ghcp-user-pool-resilience-tests`）。添加这些文件前，已确认隔离实现检出目录在该 HEAD 上没有变更。`suspend-run.mjs` 会拒绝其他 HEAD 或对生产/复用辅助源码的更改。现有 `worker-*` 辅助代码仅读取/复用，绝不修改；**冻结 v4 的 worker 启动器保持不变**，且不是本测试的入口。

## 命令

从确切基线的检出目录运行，并在其上叠加这些新增测试文件；要求 Node 22+，且工作区依赖（包括 `tsx`、`typescript`、`mysql2`）已就绪。不要加载 dotenv、提供 NODE_OPTIONS 或使用真实服务凭据。

```sh
node tests/user-pool-process/suspend-run.mjs --typecheck
node tests/user-pool-process/suspend-run.mjs --gate-check
```

实际验收**仅限 Linux**，且需有 procfs 以验证内核状态 `T`。Windows 无法执行此测试；类型检查和离线防护均不代表 SIGSTOP/MySQL 测试通过。在 Linux 上，单独准备可丢弃的本地 MySQL，并使用模拟、可丢弃凭据，仅导出以下显式启用变量：

```sh
export MYSQL_POOL_SUSPEND_TEST=1
export MYSQL_POOL_PROCESS_TEST=1
export MYSQL_POOL_TEST_DISPOSABLE=1
export MYSQL_TEST_URL='mysql://root:DISPOSABLE_TEST_PASSWORD@127.0.0.1:3306/ghcp_pool_test_marker'
node tests/user-pool-process/suspend-run.mjs --run
```

URL 从环境读取，绝不作为子进程参数传递，也不打印。账号必须为 `root`，协议为 `mysql:`，主机名为回环字面值（`localhost`、`127.0.0.1`、`[::1]`），数据库标记为 `ghcp_pool_test_[a-z0-9_]+`，不带选项或片段。仅创建/迁移/删除随机同级数据库 `ghcp_pool_test_<32 hex>`；绝不打开标记数据库。使用真正可丢弃的本地实例，而不是通往真实服务的端口转发/隧道。此测试工具不启动 MySQL、Docker、Azure 或任何真实提供商服务。预计运行时间为 **35–90 秒**，包括真实的 30 秒 owner 租约到期等待；测试超时上限为 140s，启动器看门狗时限为 160s。

## 证据与断言

1. 父进程植入一个已同步的模拟账号，此后直到清理 DROP 前仅执行有界 SELECT。两个 IPC 子进程构造真实 MySQL 存储、`PrewarmWorker`（多副本）及 `realProvisioner`。仅将账号读取依赖连接到子进程的 MySQL 存储；fetch 包装器计数并转交真实 HTTP 调用。现有 `WorkerMock` 在动态回环端口监听，在两个子进程之外保留任务状态，且不对 POST 去重。
2. 旧 worker 恰好执行一次 Login POST。仅用于测试的屏障在真实存储更新前立即拦截由此产生的 `oauth-wait` 检查点，位置在任何 SQL 事务/锁之外。父进程发送真实 `SIGSTOP`，并确认 `/proc/<child pid>/stat` 为 `T`。Owner 行仍剩余生产 30s 租约中的 25–30s。不伪造时钟、不直接变更 owner、不缩短租约，也不停止 worker。
3. 继任者先报告待命，然后仅在数据库自然到期后使用不同 UUID 取得所有权。记录数据库时间和实际经过的墙钟时间。它搜索并找到原始任务/nonce，随后被阻挡在自身的检查点。清单保持为**完全相同的原始行**，使 owner 成为唯一不匹配的防护条件。
4. 父进程发送 `SIGCONT`。旧 worker 原始保留调用携带其原始行防护条件/旧 owner，调用**真实 SQL 支撑的存储更新**。它必须返回 false，且清单和凭据完全不变。这验证的是存储事务的 owner 拒绝，而非伪造存储返回值，也不仅仅是继任者更改行代次/阶段而导致的拒绝。快照诊断必须报告 `local_tenure_expired`、一次所有权获取、一次丢失、非活动/待命。保留上下文的断言/检查点调用必须被拒绝，且不得再执行其他存储更新或 HTTP 操作。
5. 释放继任者检查点；其成功执行。继任者使用原始 nonce 执行模拟仓储 OAuth 回调（不是 HTTP 回调路由验收）。父进程将模拟任务标为成功；继任者执行真实模型查询/预热，并以原始尝试次数/任务/nonce 达到 ready。恰好一次 Login POST、一次凭据重置请求、一次模型 GET、一次预热 POST。旧进程在额外调度周期中继续存活并保持待命，不增加步骤、提供商 HTTP、检查点调用或所有权获取。

TAP 诊断包含基线、同级数据库、PID、两个 owner UUID、到期/取得所有权的数据库时间戳、墙钟等待时间、保留 SQL 结果、本地丢失快照、模拟 nonce/任务 ID 及计数。不包含凭据或 MySQL URL。

## 生命周期与清理

全新且受允许列表约束的子进程环境会丢弃继承的提供商密钥、代理变量及 NODE_OPTIONS；在导入生产代码前，dotenv 路径即设为空设备。模拟源地址固定为动态分配的回环监听器。连接/查询截止时间、有界观测、子进程生命周期计时器以及 **SIGSTOP 期间仍继续运行的父进程侧看门狗**共同限制测试夹具。清理始终先发送 SIGCONT，再终止各个归本测试工具所有的 ChildProcess，并在 DROP 前等待其真实退出事件。不使用进程组终止、PID 发现/终止、`pkill`、`taskkill` 或全局重置。中断处理器执行相同清理。无法确认子进程退出时，会拒绝 DROP 并报告同级数据库以供检查。与任何进程测试工具一样，若整个父进程被 SIGKILL 或机器失联，则无法运行清理处理器；此时应检查报告的可丢弃同级数据库。

## 本地测试报告

实现平台：Windows 11。已执行本地检查：

- `--typecheck`：通过（修正首次运行中仅涉及测试的断言类型收窄错误后）；最终 noEmit 检查无诊断信息。
- `--gate-check`：通过，4 项离线检查、0 项失败、1 项有意跳过的实际运行验收。验证严格门禁、环境/同级数据库隔离、加载器/网络启动前的安全拒绝、确切 v5 基线及未更改的冻结 v4 启动器。
- 范围检查：恰好这六个新增文件；无已跟踪文件变更。

Windows 实现者未运行实际 Linux SIGSTOP/TTL/MySQL 验收。父级随后在获准的隔离 Linux/MySQL 主机上执行了验收：**1 项通过、0 项失败、0 项跳过**，34.808 秒。自然接管耗时 30.092 秒；保留的旧 SQL 检查点在行防护条件相同、数据不变的情况下返回 false。原始 Login POST 次数为一，预热次数为一，最终状态为 Ready。生产源码仍与 v5 完全一致。

执行日志 SHA-256：`30f2cf6e424eabe854e04e3a05c498c35b459da5cee6c9a7731e7f7397df9766`。见[有界韧性测试报告](../../docs/user-pool-v5-resilience-tests.md)。离线门禁与 Linux 验收结果分别计数。
