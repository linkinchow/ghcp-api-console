# 进程级路由验证：冻结 v4 基线与 v5 后续验证

## V5 后续验证（主控方修正后运行：5 项通过）

修正后的套件已在真实隔离 MySQL 上通过：**5 项通过 / 0 项失败 / 0 项跳过，12.612 秒**。全部五对子进程均已退出，全部五个同级测试数据库均已删除。修正后日志的 SHA-256：`5b433f6955dea962cb6badb80f12624a53bcfcfb48481c0f9092cc03e41b3ce8`。生产源码保持不变；下文保留首次失败运行的记录。

主控方首次报告的数据库引擎运行结果：**3 项通过 / 2 项失败，12.320 秒**，全部五对子进程均已退出，随机同级测试数据库均已删除。新增的全部目录消费者取消用例在 2.307 秒内通过。两个 401 先完成的用例均执行到了请求完成后的准入探测，但因夹具预期收到 503、实际收到 429 而失败。生产准入逻辑会将未经验证的 ready 库存回收为 `failed/warmup`，递增代际并使租约过期。当两个旧占用均已释放时，它会删除该租约，因此不再有可用的 ready 成员：准确的安全拒绝响应是 **429 `pool_exhausted`**，不同于基线中仍保留有效占用时的 **503 `member_unavailable`**。本次仅针对测试的修正现已断言该准确错误码、failed/warmup 状态、`credential_not_verified`、代际 +1、租约过期事件及删除、占用为零且无上游流量，同时保留所有准入前的过期 200/401 代际围栏断言。本地修正检查：noEmit 通过；离线防护检查 **4 项通过**；v5 测试发现 **5 项跳过 / 0 项数据库引擎测试通过**；空白字符检查和生产代码未变检查均通过。**随后，修正后的五用例数据库引擎重跑已通过，如上所述。**

生产目标版本：`356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`。此次仅针对测试的后续验证新增**三个**场景，保留原有两个基线测试主体，仅更改现有 `routes.*` 测试框架文件及本 README。不需要更改生产代码、工作器启动器、suspend/login-network/replicas 套件、包脚本或部署。

### 套件选择与限定覆盖范围

此前没有路由专用的冻结启动器：直接调用 `routes.mysql.test.ts`。现有 `worker-run.mjs` 单独固定于 v4，**不得**用于本套件。路由测试入口现在明确选择：

- 未设置 `MYSQL_POOL_PROCESS_ROUTES_SUITE`，或值为 `baseline`：仅运行原有两个历史用例；不据此宣称新增 v5 验证已通过。
- `MYSQL_POOL_PROCESS_ROUTES_SUITE=v5`：恰好运行**五个**用例（两个基线 + 三个后续用例）。在现有破坏性夹具准入检查之后、加载测试框架之前，限时只读 Git 预检要求 `src/proxy` 和 `src/packages/shared` 与生产目标版本匹配，并拒绝未跟踪的生产文件。它比较源码内容而非 HEAD，因此允许仅含测试变更的后续提交，同时拒绝旧版或被修改的生产代码。未知或空的套件选择会被明确拒绝。

新增场景如下：

1. **跨两个进程取消所有目录消费者。** 四个 GET/HEAD 消费者加入两个独立的、仅返回部分响应体的缓存刷新。通过已提交的 SQL 占用记录屏障分阶段取消：一个本地存活消费者保持其流打开；最后一个本地消费者中止该流，而另一个 PID 的流仍保持打开；随后最后一个远端消费者中止自己的流。两个模拟响应都必须在未放行响应体的情况下提前关闭，全部目录占用均须释放。不清除任何缓存，由另一调用方触发两次全新刷新，随后命中两份成功缓存。不允许发生推理、租约创建或续期。仅放行新响应的操作使用已观测到的模拟调用游标；尝试放行旧的已取消响应仍会失败。
2. **ABA，旧 401 先于旧 200 完成。** 请求分别阻塞在不同 PID 上，SQL 证明两个请求 ID 都固定在原代际。通过生产凭据写入将 A → B → A 轮换。旧 401 完成并释放其对应占用时，旧 200 仍保持阻塞；SQL 必须保留有效的替换凭据、未变的库存及租约，且重新认证和续期事件均为零。只有此后才放行 200。在**两个**旧请求都完成之前，不执行准入、回收或工作器操作，因此这些操作无法掩盖旧代际围栏。重新验证使用实际工作器和预配器，并在网络响应层阻塞预热请求；就绪之前不得准入，不得重放推理，随后须建立新的活动租约。
3. **A → B，旧 401 先于旧 200 完成。** 复用同样的限时调度和准确代际检查，但验证替换后的预热和推理使用 B 令牌。这只是一个额外的轮换变体，并非穷尽矩阵。

下文所述的严格 localhost/root/随机同级数据库限制、环境隔离、子进程退出、SQL 看门狗、请求与屏障以及清理控制保持完整。测试控制允许列表额外允许 `rotate-ab`。生产环境原有的 5 秒占用心跳保持不变：两个旧请求都必须在它触发前完成；在这些屏障处不得并行运行数据库引擎套件或暂停调试器。下文历史 v4 记录中的数量和耗时不构成这些新增场景的验证结果。

### 命令与实际本地测试报告

在检出目录根目录使用现有依赖运行（无需安装）。如果依赖从上级目录解析，请使用该处已安装的 TypeScript 可执行文件，如下方本地检查所示。

```sh
node "$(node -p "require.resolve('typescript/bin/tsc')")" -p tests/user-pool-process/tsconfig.routes.json
node --check tests/user-pool-process/routes.offline.test.mjs
node --import tsx --test tests/user-pool-process/routes.offline.test.mjs

env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  -u MYSQL_POOL_PROCESS_ROUTES_SUITE \
  node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
  MYSQL_POOL_PROCESS_ROUTES_SUITE=v5 \
  node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts

node --import tsx --input-type=module -e "const s = await import('./tests/user-pool-process/routes.safety.ts'); await s.assertV5Production(); console.log('PASS: read-only production match to ' + s.v5ProductionRef)"
git diff --check
```

2026-09-15 在 Node `v24.14.0` 上的实际本地结果：

| 检查 | 实际结果 |
| --- | --- |
| routes 严格 TypeScript noEmit 检查 | 通过，退出码 0 |
| 离线 MJS 语法检查 | 通过，退出码 0 |
| 离线 URL/显式授权防护、套件选择、源码预检桩、副作用哨兵 | **4 项通过 / 0 项失败 / 0 项跳过**，退出码 0 |
| 默认/baseline 测试发现，移除数据库引擎显式授权 | **0 项通过 / 0 项失败 / 2 项跳过**，退出码 0 |
| 显式 v5 测试发现，移除数据库引擎显式授权 | **0 项通过 / 0 项失败 / 5 项跳过**，退出码 0 |
| 实际只读检查生产代码与 `356f8f5` 匹配 | 通过，退出码 0 |
| 差异中的空白字符检查 | 通过，退出码 0 |
| V5 真实 MySQL 路由执行 | **本地未执行；当时等待主控方在 Azure 数据库引擎上运行** |

离线源码预检测试使用 Git 桩来覆盖匹配、漂移和未跟踪源码等结果；上方独立的实际 Git 检查则验证当前检出目录。入口副作用哨兵覆盖两种套件选择及无效选择，在 Git/进程启动、监听器或套接字创建以及 fetch 之前拒绝不安全或缺失的配置。跳过的测试发现和离线通过均不计作 MySQL/进程验收。此次准备工作未执行云端操作、Docker、MySQL 夹具、提交或推送。

### 仅供主控方执行的 v5 数据库引擎命令（本地未执行）

使用 Azure 测试主机**回环接口**上的指定一次性数据库引擎，生产源码须与目标版本匹配，并具备完整的本次后续测试框架及现有依赖。URL 仅提供凭据和一次性数据库标记；其中指定的数据库绝不会被选中或更改。通过获准的环境设置实际的合成测试/一次性数据库密码；不要在报告中写入凭据。

```sh
MYSQL_POOL_PROCESS_ROUTES_SUITE=v5 \
MYSQL_POOL_PROCESS_ROUTES_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

验收要求出现 v5 生产代码匹配提示、**5 项未跳过的通过 / 0 项失败**、不同 PID 的诊断信息、全部五个用例随机同级数据库成功删除的证据，以及退出码 0。仅运行基线并通过两项不覆盖此次后续验证。主控方应将本套件与其他一次性数据库引擎套件串行执行，并报告完整的失败 TAP/子进程启动诊断；不得修改生产围栏以使测试通过。仍未覆盖的项目包括 count_tokens、穷尽的竞态/取消组合、进程死亡与故障转移、真实上游、部署以及长时间运行行为。

## 历史冻结 v4 验证（两个用例通过）

基线：`2bc12b363e62923ca6c1db0185e42f9ed5c78bf9`（冻结 v4）。
这八个测试框架文件在审计前从已准备的工作树原样复制，随后仅在本测试目录内进行加固。此前的准备和审计仅执行了离线检查；之后主控方在冻结基线上，针对一次性真实 MySQL 顺序运行了两个用例。**实际结果：2 项通过 / 0 项失败 / 0 项跳过，5.574 秒**，并提供了不同子进程 PID 及随机同级数据库成功清理的证据。冻结的生产模块和 npm 脚本均未修改。这是有限范围的进程路由验证，不是对后续可观测性镜像的运行时验收。

## 范围

两个有限用例，每个用例使用一个全新随机数据库和两个独立 Node 子进程：

1. 跨两个进程的四个 GET/HEAD 目录请求，分别收到两份独立缓存且仅返回部分响应体的上游响应。取消一个请求；其余本地及远端消费者必须继续。混入来自两个子进程的推理请求，观测 SQL 排他所有权及占用清理，并断言目录流量不能提升或续期租约，而成功推理可以。后续命中缓存的目录流量必须保持租约时间戳不变。
2. 一个使用旧凭据的 200 和一个使用旧凭据的 401，分别来自不同 PID，在外部模拟服务处阻塞。通过生产仓储写入将 A → B → A 轮换。在准入/回收**之前**放行 200，以免掩盖代际围栏缺陷，然后放行 401。断言不会发生旧代际续期、凭据失效、重新认证事件或重放。使用实际工作器和预配器重新验证替换凭据，并在网络响应层阻塞预热请求；验证就绪之前不得准入，随后须建立新的活动租约。

仅包含 ABA/成功响应先完成的顺序；这不是完整的组件测试排列矩阵。第一个用例测试取消一个部分响应体消费者，而非取消所有消费者。已覆盖 GET/HEAD；未覆盖 count_tokens。不据此宣称所有者故障转移、进程死亡、部署、真实上游或长时间稳定性已得到验证。

预期行为源自 `src/proxy/src/routes/userPoolCatalogPressure.mysql.test.ts` 和 `src/proxy/src/routes/userPoolCredentialRace.test.ts`，但此处监听器**不**共享运行时或模块缓存：两者均在独立操作系统进程中执行 `routes.child.ts`。就绪消息断言 PID 和实例 ID 各不相同。目录和推理的网络观测断言请求来自预期的子进程 PID。

## 安全与架构

- 要求全部三个显式输入：`MYSQL_POOL_PROCESS_ROUTES_TEST=1`、`MYSQL_POOL_TEST_DISPOSABLE=1` 和 `MYSQL_TEST_URL`。
- MySQL URL 必须使用 `mysql:`、字面用户名 `root`、回环地址（`127.0.0.1`、`localhost` 或 `[::1]`）、`/ghcp_pool_test_[a-z0-9_]+`，且不得包含查询参数或片段。这些输入不使用默认值或 dotenv 来源。
- 传入的数据库绝不会被选中、迁移、写入或删除。其 URL 为全新的 `ghcp_pool_test_<32 random hex>` 同级数据库提供凭据。只创建和删除该同级数据库。
- 主进程不导入任何生产运行时、存储或配置。数据库 DDL 之后的 SQL **仅限 SELECT**。获准的合成测试数据准备及凭据写入通过子进程 0 中的生产 API 执行。就绪状态由生产工作器和预配器建立，而非直接由夹具写入 `verified_at`。
- 子进程获得允许列表中的操作系统环境以及显式合成测试配置，使用经断言不存在的随机 `DOTENV_CONFIG_PATH`，不继承 Node 选项，也不使用真实服务端点。产品路由使用真实 MySQL 存储。父进程将子进程的 `TSX_TSCONFIG_PATH` 固定为 `tsconfig.routes.json`：`@ghcp/shared` 解析到当前检出目录的源码，而非上级工作区构建后的 dist。子进程会断言该解析结果；生产代理导入仍相对于当前检出目录。
- 唯一的 fetch 注入位于各子进程边界：检查精确的临时模拟服务源地址、限制路径和令牌、附加 PID，然后调用原生 fetch。它**不会**返回在进程内伪造的 Response。禁止重定向。主进程到子进程、子进程到模拟服务的 HTTP 均为真实且独立的网络请求。
- 临时模拟服务位于测试父进程内、两个代理进程之外。它以流式方式返回部分 JSON 目录、阻塞推理响应、跟踪套接字提前关闭，并在显式屏障处放行响应。只接受已注册的子进程 PID、预期的方法和路径、合成 OAuth 令牌及合成的内部 SSO 请求头；放行已取消响应会失败，而不是让其悄然消失。
- 子代理监听器挂载生产认证、身份、池准入及兼容路由。不启动部署入口。另一个仅限 127.0.0.1 的测试控制监听器要求提供夹具专属的随机 bearer 能力凭据，并遵守精确的允许列表（`state`、`seed`、`rotate-aba`、`tick`、`clear-cache`）。未引入产品调试端点或共享源码变更。
- 缓存等待者观测包装 `AbortSignal.addEventListener`，但不改变订阅语义。主进程 SQL 快照用于确定持久化结果；不模拟任何 SQL 结果。每个子进程保有自己的上下文、缓存和运行时状态。
- 请求、屏障、SQL、启动和关闭均有时限。每个用例的测试超时为 100 秒；每个子进程在生产导入和初始化**之前**设置 110 秒生命周期上限，父进程另设 115 秒终止上限。用例在 `finally` 中关闭，并通过幂等测试清理钩子覆盖设置失败。清理会中止并排空已跟踪的客户端及控制请求，请求子进程优雅关闭，必要时升级为强制终止，关闭模拟服务，并仅在两个子进程都退出后删除同级数据库。子进程非零退出、被强制终止或数据库删除失败都会导致清理失败。清理成功时打印准确的已删除同级数据库名称。整个测试父进程被强制终止时，可能需要手动清理一次性数据库。
- ABA 请求必须在轮换后、生产环境未变的 5 秒占用心跳围栏触发前完成。不要在该屏障处暂停，也不要并发运行重负载套件。心跳导致的取消表示本次运行失败或未通过验证，不能据此禁用生产围栏或向其插入观测代码。

## 离线验证（无需 MySQL，可安全运行）

从本工作树根目录运行，使用已安装的现有依赖；本次准备工作不得安装或修改共享依赖。

```sh
node node_modules/typescript/bin/tsc -p tests/user-pool-process/tsconfig.routes.json
node --check tests/user-pool-process/routes.offline.test.mjs
node --import tsx --test tests/user-pool-process/routes.offline.test.mjs
env -u MYSQL_POOL_PROCESS_ROUTES_TEST -u MYSQL_POOL_TEST_DISPOSABLE -u MYSQL_TEST_URL \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

如果工作树从上级目录解析依赖，请使用已安装的 TypeScript 可执行文件的实际路径，而不是 `node_modules/typescript/bin/tsc`。

审计后的离线验证：严格 TypeScript 检查通过；MJS 语法检查通过；2 项离线准入防护测试通过；未提供专用显式授权时，数据库引擎测试发现报告 **0 项通过 / 2 项跳过**。离线防护将套接字、监听器、fetch 和进程启动入口替换为会抛错的哨兵，验证已显式启用但缺少必要输入或输入不安全时，会在尝试任何副作用之前拒绝。这些是防护和跳过结果，**不是数据库引擎结果**。

## 显式数据库引擎命令（已完成运行；供获准重跑参考）

从精确冻结基线的检出目录运行，加入这八个文件，使用已安装的现有依赖，并确保已有可用的**回环地址一次性 root MySQL 端点**。主控方可以在其指定的 Azure 测试主机上运行；Node 父进程、两个代理子进程、模拟服务和 root MySQL 端点必须全部位于该测试主机的回环接口上。不要提供 Azure 公网或 FQDN MySQL URL，也不要放宽准入防护。

```sh
MYSQL_POOL_PROCESS_ROUTES_TEST=1 MYSQL_POOL_TEST_DISPOSABLE=1 \
MYSQL_TEST_URL='mysql://root:DISPOSABLE_PASSWORD@127.0.0.1:3306/ghcp_pool_test_optin' \
node --import tsx --test --test-concurrency=1 tests/user-pool-process/routes.mysql.test.ts
```

不要将其指向生产环境或任何共享的非一次性服务器。本脚本不会启动 Docker 或预配服务器。未提供专用 `MYSQL_POOL_PROCESS_ROUTES_TEST` 输入时，两个用例会被明确跳过；一旦提供该输入，错误的显式授权，或缺失/不安全的一次性数据库授权及 URL 输入都会被明确拒绝。不要把跳过运行误当作验证通过。不需要 `.env`、继承的产品环境、真实 GitHub 或真实 Login/SSO 凭据。子进程源码固定由测试框架设置，因此数据库引擎命令无需额外的 `TSX_TSCONFIG_PATH` 输入。

主控方验收要求恰好两项未跳过的通过、各用例不同子进程 PID 的诊断信息、两个同级数据库成功清理及删除的诊断信息，以及退出码 0。已完成的冻结 v4 运行符合这些标准。任何单独获准的重跑都必须在共享一次性数据库引擎上保持串行；应将完整的失败 TAP/子进程启动诊断回传，以便仅修复测试框架，而不是修改生产代际或心跳围栏。

## 已完成运行的证据与剩余限制

完整执行日志在本地归档于 `.claude/post-v4-routes-full.log`，SHA-256 为 `1a6aaa63987db510a999f46d28390f0895c70f063810ca54c2b9bb2516ae6bf2`。本文档仅发布汇总结果及校验和，不发布原始运行时标识符、端点或凭据。上文早期的离线防护和跳过结果仍是独立的准备阶段记录；不计入两项数据库引擎测试通过结果。

“范围”一节描述的两个有限用例均已通过；该节的所有排除项仍然适用。尤其是，这并未验证全部取消或凭据排列、进程死亡/故障转移组合、真实上游或部署高可用性。后续可观测性镜像已构建，正在通过预览启动，但**尚未通过运行时验收**；参见 [v4 后续进展](../../docs/user-pool-post-v4-progress.md)。
