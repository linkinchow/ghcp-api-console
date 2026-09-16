# 冻结 v4 的 worker 进程/owner 故障验证

**状态：实际可丢弃 MySQL 进程验收已通过——两个子用例，TAP 共 3 项通过 / 0 项失败 / 0 项跳过（含父级包装测试），66.454 秒。** 两个子用例都使用了真实 SIGKILL 和实际约 30 秒的 owner TTL 等待。这不是三个业务用例，也不覆盖进程故障的所有组合。

冻结源码提交：`2bc12b363e62923ca6c1db0185e42f9ed5c78bf9`。
仅 `worker*.ts`、`worker*.mjs` 和本 README 属于此测试工具。它不修改生产源码、包脚本、配置、路由测试夹具或 Docker。
本测试工具基于冻结 v4 运行；它不验证后续的可观测性生产代码增量，该增量的镜像正在通过预览启动，运行时验收仍待完成。

## 两个已执行用例

两个用例均启动两个**独立 Node 子进程**，各自使用真实的 `PrewarmWorker`、`realProvisioner`、`MysqlPoolStore` 和 `MysqlStorage`。HTTP 使用真实 `fetch`、真实模型解析器和真实预热请求代码。模拟 SSO/Login/模型 HTTP 服务器位于**父测试进程**中，通过 `listen(0, '127.0.0.1')` 绑定动态分配的端口。该确切源地址仅传给其自身的子进程；任务和捕获的请求台账不随子进程终止而丢失。它不对 Login POST 去重。控制屏障是进程内/IPC 测试夹具控制，不是生产调试 HTTP API。

1. **Login POST 已被接受，检查点被阻挡，owner 被终止。** 植入一个已同步的模拟成员（刻意将 SSO/SCIM/席位创建排除在范围之外）。真实 worker 创建 nonce，开始授权并预留 Login 槽位。Login 恰好接受一次 POST 并返回任务。测试夹具包装器在 owner 的 `oauth-wait` 检查点写入 SQL 前将其阻挡。父进程验证已持久化的 `oauth-dispatch`、原始 nonce 及空任务 ID，然后发送 `SIGKILL` 并等待真实子进程退出事件。此故障不使用 `worker.stop()`、`releaseOwner`、SQL owner 替换、时钟覆盖或租约截短。继任者先证明自身处于待命状态，等待真实的 **30 秒数据库 owner TTL**，使用新的 owner UUID 取得所有权，按身份查询 Login，并接管**原始任务和 nonce，不发起第二次 POST**。随后，使用正确 nonce 的仓储回调允许执行真实 HTTP 预热并达到 `ready`。错误/重放 nonce 的回调不能覆盖凭据。
2. **长时间运行的 Login 任务与迟到回调安全性。** 重复相同的真实 POST 接受/owner 终止/恢复序列，但外部模拟任务在创建时就已是 16 分钟前的任务。继任者必须以 `oauth_task_stalled` 进入终止失败状态，保留任务/nonce 和 Login 槽位，且不进行预热。阻挡一条包含旧 `running` 任务的终态观测 GET 响应。通过真实 `MysqlStorage.saveCopilotOauthToken` 递交匹配的迟到回调，将外部任务标为成功，并释放已捕获的旧响应，同时阻挡下一条新的成功响应。子进程 IPC 必须证明旧代次的观测已完成；SQL 必须仍与回调后的失败行完全一致。只有此后才释放新的响应。它可以释放槽位，但状态/尝试次数/错误仍为 `failed`/`3`/`oauth_task_stalled`；不发生自动重试或预热。这可防止新的响应快速释放槽位而掩盖陈旧响应缺陷。

第二个用例测试停滞任务的回调安全性，**不是**请求截止时间相关的网络挂起/重启用例。SSO 创建结果不明确及网络挂起重启场景尚未实现。回调接受验证在真实仓储的 nonce 防护边界进行，而非经过生产 HTTP 回调路由；路由测试夹具由另一项工作负责。不启动真实 Login 服务、SSO 服务、浏览器自动化或上游提供商。检查点包装器仅阻挡一次 `store.update` 调用，绝不伪造数据库内容、切换 owner 或更改生产代码。

## 安全执行

使用 Node 22+，且项目依赖已就绪（`tsx`、TypeScript、`mysql2` 及已构建的 `@ghcp/shared`）。这些命令不执行安装/构建。启动器要求真实 Git 检出目录：`git rev-parse HEAD` 必须恰好为冻结 SHA，且 `git diff --exit-code <SHA> -- src/proxy src/packages/shared` 必须成功。远程运行器应恢复冻结的 Git bundle/检出目录；不含 Git 元数据的源码归档会被有意拒绝。不要绕过此防护。启动器要求现有共享依赖构建产物与检出内容匹配；解析到上级工作区的已构建包并不能证明构建具有封闭性。

从冻结工作树根目录运行：

```sh
node --check tests/user-pool-process/worker-run.mjs
node tests/user-pool-process/worker-run.mjs --typecheck
node tests/user-pool-process/worker-run.mjs --gate-check
```

`--typecheck` 使用带 `noEmit` 的 TypeScript API，包括生产 Express 类型扩展。即使调用 shell 中已有 MySQL 显式启用变量，`--gate-check` 也会移除它们，运行不使用套接字的 URL/环境安全测试，并将进程验收套件报告为**已跳过**。两种模式都不访问 MySQL，也不启动 HTTP。不要将其通过的门禁测试算作进程验收。

实际验收运行必须针对已运行的、可丢弃的**本地** MySQL 服务器单独显式启用。仅通过进程环境提供凭据；不要将其放入 argv、加载 `.env`/`production.env`，或使用生产服务器。所需环境变量：

- `MYSQL_POOL_PROCESS_TEST=1`
- `MYSQL_POOL_TEST_DISPOSABLE=1`
- `MYSQL_TEST_URL`：`mysql:` URL，用户名必须恰好为 `root`，主机名必须恰好为 `localhost`、`127.0.0.1` 或 `[::1]`，数据库标记为 `ghcp_pool_test_[a-z0-9_]+`。不得包含查询参数或片段。Root 必须能够创建/删除隔离数据库并安装常规表结构/触发器。

随后运行：

```sh
node tests/user-pool-process/worker-run.mjs --run
```

**绝不选择、迁移、清空或删除** URL 中指定的数据库。测试套件仅生成一个名为 `ghcp_pool_test_<32 random hex>` 的随机同级数据库，两个用例共用它，并在 `finally` 中仅删除该同级数据库。会打印随机名称，以便父进程中断后进行人工清理。绝不使用通配符删除。普通失败清理会先终止剩余子进程，再关闭模拟套接字/连接池并删除同级数据库。突然终止父进程可能留下该可丢弃同级数据库；子进程在 IPC 断连时退出，且具有 120s 的绝对生命周期。并发测试套件的模拟端口及随机同级数据库名相互独立；不存在共享固定端口的测试夹具。运行器设有 300s 的硬性看门狗时限，普通用例/套件清理使用有界等待，关闭连接池前会销毁已跟踪的 MySQL 连接，且仅向此测试工具创建的真实 `ChildProcess` 句柄发送 SIGKILL。若未确认某个 worker 已退出，则拒绝 DROP。硬性看门狗终止/操作系统中断可能留下同级数据库，需要按确切名称人工清理；绝不能声称破坏性中断能够干净清理。

启动器/子进程使用环境变量允许列表，丢弃继承的提供商凭据/代理变量/`NODE_OPTIONS`，抑制子进程 stdout/stderr，并在导入生产代码前将 `DOTENV_CONFIG_PATH` 设为操作系统空设备。凭据为固定模拟值；HTTP URL 使用父进程拥有的动态回环端口。唯一可从外部配置的网络目标是受门禁约束的本地 MySQL 端点。启动器在启动任何测试/worker 或建立数据库连接前验证全部三个显式启用条件及完整 URL；子进程独立重新验证其随机数据库和模拟源地址。启动器使用 `spawn(process.execPath, ..., { shell: false })`；worker 使用 `fork(worker-child.ts, [], { execArgv: ['--import', 'tsx'] })`（不使用 shell，也不通过 argv 传递凭据）。全部七个测试工具路径均为普通文件，而非符号链接。不要直接启动测试/子进程文件；应使用启动器，确保提交/环境防护生效。

预算：两个用例，各自包含真实的约 30s 租约等待；每个用例超时 100s，套件超时 240s，IPC/SQL 轮询及清理均有界。不人为更改数据库时钟。在正常本地 MySQL 上，预期成功运行通常约需 65–90 秒。清理可能额外增加有限时间；强制中断父进程不保证移除随机同级数据库。

## 证据及当前验证的确切限制

成功的实际运行会输出 TAP 诊断，包含父进程/被终止进程/继任进程 PID、操作系统退出结果、旧/新 owner UUID、数据库到期/取得所有权时间、原始 nonce 和任务 ID、HTTP 任务 POST/GET 台账、预热次数及最终状态。证据不包含密码、令牌、数据库 URL 或连接错误详情。在干净关闭前，SQL 和子进程 IPC 必须一致确认新继任者为当前有效 owner。错误 nonce 和重放回调的拒绝、阶段/尝试次数/代次防护、槽位保留/释放以及没有第二次 Login POST 都通过断言验证，而不只是记录日志。

准备阶段历史：在 Windows 上使用 Node **v24.14.0** 进行本地准备。准备期间未启动 Docker，未访问云，也未尝试在本地运行 MySQL 引擎测试（该环境不可用）。其语法、TypeScript `noEmit`、无套接字门禁及跳过验收的结果仍属于离线证据，不是进程验收通过记录。

父级随后完成了针对冻结 v4、经显式启用的可丢弃真实 MySQL 运行：**两个实际子用例通过；TAP 3 项通过 / 0 项失败 / 0 项跳过包含父级包装测试；耗时 66.454 秒**。两次实际 SIGKILL/退出及真实约 30 秒 TTL 等待均已完成。独立继任者恢复了原始任务/nonce，未发起第二次 Login POST；正常恢复与老化任务/迟到回调子用例分别达到了预期 ready/failed 状态。该运行验证了该运行器上的常规表结构设置、HTTP 恢复、陈旧观测防护及实际运行清理。它并不认证所有授权配置，也不认证 Windows 和 POSIX 两种平台上的所有终止/退出行为。

完整执行日志已在本地归档至 `.claude/post-v4-worker-full.log`，SHA-256 为 `7a6328f89a35c72f200ad484ec31cef269edb6b5e0cde62ed5573cde2deb1eb5`。此处仅发布汇总结果及该校验和，不发布原始运行时标识符、端点或凭据。独立的路由结果及可观测性增量状态见 [v4 后续进展](../../docs/user-pool-post-v4-progress.md)。

上述所有范围排除项仍然成立：不包含 SSO/SCIM/席位副作用进程矩阵、网络挂起/服务重启用例、接管后长时间暂停的旧进程恢复、生产 HTTP 回调路由验收，也不构成真实上游或部署高可用性声明。后续本地诊断实现不提供全局 owner 告警或客户 SQLite owner 丢失恢复；其新镜像尚未通过运行时验收。
