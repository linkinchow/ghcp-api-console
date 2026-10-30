# 迁移指南：单企业版 → 新环境中的多企业版

本指南适用于：现有**单企业版**（r4，或更早的 MySQL 账号池版本，见第 1.2 节；多个 Proxy 副本 + MySQL），要迁移到**另一套新环境**里的**多企业版**（同样是多个 Proxy 副本 + MySQL），并在迁移后继续添加更多企业（多 slug）。

- 原环境不升级、不改动：数据**复制**到新环境，在新环境里完成 r4 → 多企业版的迁移。这与[多企业版升级指南](multi-enterprise-upgrade-guide.md)（原地升级）的数据迁移是同一过程，只是发生在一份数据副本上；那份指南里的配置变化、行为变化、DBA 脚本说明同样适用。
- 迁移后，原企业成为新环境的 `default` 企业：池账号、席位、SSO 用户、调用方租约（caller key hash 与账号的绑定）全部保留，用户无感知。其他企业在迁移验证通过后再添加（第 9 节）。
- 新环境的部署见[新部署指南](multi-enterprise-new-deployment-guide.md)和 [`deploy/kubernetes/`](../deploy/kubernetes/README.md)（Azure 见 `deploy/azure/`）。
- 文中的主机名、库名、账号都是占位值；实际值和导出的数据不要写进仓库、工单或截图。

## 0. 先决定：迁移还是重新开户

| 新环境管理的 GitHub 企业 | 做法 |
| --- | --- |
| **同一个企业**（同一 slug） | **按本文迁移数据**。同一企业只能有一个 SAML 身份提供方，新旧两套不能同时运行；不迁移数据时，原来由 SCIM 创建的池账号会成为新 SSO 无法登录、却仍占用 Copilot 席位的“孤儿”，重新开户还会遇到席位到账期末才释放（重叠计费）和 EMU 用户名仍被占用的问题 |
| 另一个企业 | 不需要迁移：原企业的账号继续由原环境管理，新环境在新企业里开户（按新部署指南） |

## 1. 前提

- 新环境使用当前多企业版镜像（digest 见[发布验证记录](multi-enterprise-release-validation.md)最新一节），四个组件同一版本。至少用 r4（`multi-ea1a29e-amd64-r4`）：r3 及更早的多企业版、单企业版 r4 及更早版本中，上游超过 300 秒才返回响应头的非流式请求都会以 502 失败（第 2.1 节 `POOL_INFERENCE_TIMEOUT_SECONDS` 一行）。
- 需要一个维护窗口：从停原环境到新环境验证通过，期间经 LiteLLM 到 GHCP 的请求不可用（其他模型后端不受影响）。时长主要取决于 MySQL 导出、导入和迁移，请先用一份数据副本演练（第 11 节）。
- **新旧两套任何时候都不能同时运行**，否则两套 SSO / Proxy 会同时修改 GitHub 上的用户和席位。
- 原环境的 Proxy 副本数不限：多副本 + MySQL 的 r4 正是资格测试覆盖的形态（两个 Proxy 副本）。

### 1.1 确认原环境的版本

经过验证的路径是**单企业版 r4 → 多企业版**。先确认原环境是哪个版本：

| 方法 | 能看出什么 |
| --- | --- |
| Pod 实际运行的镜像（命令见表下） | 与 Docker Hub 上 r4 的 digest 比对（`linkinchow/ghcp-proxy` 上唯一的单企业版 tag 是 `single-slug-164cade-amd64-r4`） |
| 镜像标签 `org.opencontainers.image.revision` | 用 `deploy/user-pool-mysql-customer/build-images.mjs` 构建的镜像带有源码提交（40 位 SHA，tag 本身也是这个 SHA）；同目录的 `build-manifest.json` 也记录了提交与镜像 ID。手工 `docker build` 的镜像没有这个标签 |
| 运行形态 | 早于 r4 的镜像以 npm 启动（`WORKDIR /app`，Rancher 模板里有 `command: [node, src/proxy/dist/index.js]`）；r4 及以后以 Tini 为 PID 1，镜像内没有 npm |
| 环境变量 | Login 容器中有 `SSO_PROVIDER`（Compose 里由 `LOGIN_SSO_PROVIDER` 传入）→ 早于 r4；有 `MYSQL_AUTO_MIGRATE`、`SHUTDOWN_TIMEOUT_MS` → r4 |
| SSO / Login 的 SQLite | `sso_users` 有 `copilot_seat_pending_cancellation_date` 列、Login 有 `login_task_attempts` 表 → 至少运行过 r4 |

查看 Pod 实际运行的镜像（显式指定原集群的 context 与 namespace）：

```bash
kubectl --context <原集群 context> -n <namespace> get pods -o custom-columns=POD:.metadata.name,IMAGE:.status.containerStatuses[*].imageID
```

`/healthz` 和 MySQL 的 `schema_migrations` 无法区分 r4 与更早的账号池版本（r4 及以前 `/healthz` 只有 `status`、`service`；`schema_migrations` 从 MySQL 账号池首个版本到 r4 都是同样 3 条记录）。

### 1.2 原环境早于 r4 时

- **MySQL 账号池版本**（源码提交 `2bc12b3`，2026-09-15 及以后，包括用 `build-images.mjs` 交付的版本）：Proxy 的 MySQL 表结构从那时到 r4 基本没有变化，r4 会自动处理两种旧形状（统计表补列、token 列排序规则）。**在新环境里多走一步**：第 4 节恢复数据后，先用 **r4** 镜像启动一次（账号池在备份前已暂停，暂停状态保存在数据库里，r4 启动后不会开户），确认 `/readyz` 正常、Console 数据完整，再按第 5 节换成多企业版。SSO / Login 的 SQLite 由 r4 在启动时自动补列，只进不退。
  - 这样做的原因：经过资格测试的是“r4 之前的基线 → r4”和“r4 → 多企业版”这两段；直接从更早的版本跳到多企业版在代码上大概率可行，但没有验证过，不推荐。
  - r4 的配置变化见 [r4 升级指南](user-pool-release-upgrade-guide.md)第 4 节（例如删除 Login 的 `SSO_PROVIDER` / `LOGIN_SSO_PROVIDER`；Proxy 不要再覆盖启动命令 `command: [node, src/proxy/dist/index.js]`）。影响账号池配置指纹的 Proxy 环境变量保持不变（第 2.1 节）。

  **r4 中转的边界**（容易误解，单独说明）：

  - **原环境不需要升级到 r4，也不要改动。** r4 只在新环境里、对恢复过来的数据副本运行一次，作用是把旧数据先迁成 r4 的形状；原环境的数据始终不变，回退依据仍是它（第 10 节）。
  - **中转期间不对外服务**：GitHub 企业的 SAML 设置和 LiteLLM 都保持原样、仍指向（已停止的）原环境，第 6 节的切换在换成多企业版并验证之后才做；不要恢复预热；r4 只在新环境内部被检查。r4 镜像带有 CVE-2026-111181（body-parser，r4 未缓解），所以中转结束后不要让 r4 继续运行或对外开放。
  - **步骤**：四个服务都换成 r4 镜像（`single-slug-164cade-amd64-r4`，按 digest 引用，见 r4 升级指南第 2 节）→ 按 SSO → Login → Proxy（先 1 个副本）→ Console 启动 → 确认 `/readyz` 正常、`schema_migrations` 有 3 条记录、Console 中账号数与原环境一致 → 再启动其余 Proxy 副本 → **停止四个服务并再备份一次新环境的数据**（作为多企业版迁移失败时的回退点；新库的备份命令见第 3 节，库级账号要加 `--no-tablespaces`）→ 按第 5 节换成多企业版。
  - 整个中转通常只需几分钟到十几分钟，包含在同一个维护窗口内。
- **未提交源码构建的内部测试镜像**（例如 2026-09-14 前后的 `production-fix`、`check` 等 tag）：没有对应的提交，表结构无法从 git 核对。先把备份恢复到一个隔离的临时库，与 r4 的 `scripts/proxy-mysql-initial.sql` 建出的结构比对；结构不同时 r4 会以 `Unsupported MySQL schema` 拒绝启动，需要单独评估。
- **PostgreSQL / Redis 的旧版**（迁移到本 fork 之前的 Azure AKS 部署）：**没有迁移路径**，仓库中也没有 PostgreSQL → MySQL 的数据工具。只能在新环境全新部署（同一 GitHub 企业时注意第 0 节所说的孤儿账号与席位问题），或另行开发数据导出工具。

## 2. 准备新环境（不要启动应用）

按新部署指南部署新环境，但**四个服务保持不启动**：副本数为 0，或保持启动门禁（`GHCP_CONFIG_APPROVED` 不是 `true`）。

新环境用本仓库的 Azure 部署（`deploy/azure`，azd + Bicep）时，配置、机密、恢复（MySQL 只能经私有终结点访问，SQLite 文件要放进 AKS 数据盘）和启动按 [deploy/azure README 第 8.7 节](../deploy/azure/README.md) 进行：`hooks/Restore-GhcpData.ps1` 在集群内完成第 4 节的恢复。完整的执行清单（需要准备的信息、迁移当天的步骤、验证与回退）见[执行手册：迁移到 Azure 上的多企业版](multi-enterprise-migrate-to-azure.md)。

> **不要用空库先启动新环境。** 账号池一旦启用，就会通过 SCIM 在真实企业中新开账号，与原环境的账号冲突。

### 2.1 必须与原环境完全相同的配置

| 配置 | 服务 | 原因 |
| --- | --- | --- |
| `ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`（GHE.com 则为 `GITHUB_BASE_URL`） | Proxy、SSO、Login | 企业身份；有数据后不能修改（新部署指南第 4 节） |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | Proxy | 企业身份的一部分 |
| 账号池的其他 Proxy 参数（`POOL_WARMUP_MODEL`、`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_CONCURRENCY`、`PREWARM_POLL_SECONDS`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` 等） | Proxy | 它们写进 MySQL 中的账号池配置指纹；与原值不同时 Proxy 以 `Pool configuration differs between Proxy replicas` 拒绝启动。最稳妥：**原样复制原 Proxy 的全部非机密环境变量**。idle 目标、cap、租约时长不在指纹中，它们本来就保存在数据库里 |
| `POOL_REQUEST_TIMEOUT_SECONDS`（默认 120） | Proxy | 账号池上游请求时限，**属于账号池配置指纹**：与原值不同时 Proxy 拒绝启动。即使已用下一行把推理时限调大，这个值也保持原样 |
| `POOL_INFERENCE_TIMEOUT_SECONDS`（原环境设置过时，例如 600） | Proxy | 三条推理路径（`/v1/messages`、`/chat/completions`、`/responses`）的单独总时限（`bf38374` 起提供），**不在指纹中**。原环境设置过就必须带到新环境，否则长请求又会在 `POOL_REQUEST_TIMEOUT_SECONDS` 处被截断；原环境没有设置则不设。**行为变化**：原环境（`bf38374`、单企业版 r4 等）中，上游超过 300 秒才返回响应头的**非流式**请求实际在约 300 秒失败（Node 内置 fetch 的默认响应头超时），设成 600 也不起作用；多企业版 r4 起按本参数执行。迁移后这类请求可以真正运行到设定的时限，LiteLLM 与业务客户端的超时要覆盖它（[推理超时验证报告](user-pool-inference-timeout-validation.md)“非流式 300 秒上限”一节）。流式请求不受影响 |
| `GITHUB_API_BASE_URL`（SSO 上设置过非默认值时，例如 GHE.com 或代理地址） | Proxy（多企业版阶段） | 多企业版 Proxy 在 Login 回传 token 时调用 `<API 地址>/user` 核对账号身份。原 Proxy 没有这个变量时，换成多企业版时给 Proxy 加上与 SSO 相同的值（升级指南第 6 节），否则补号全部失败。不在指纹中 |
| `SSO_DEFAULT_USER_PASSWORD` | SSO | 每个池账号的 SSO 密码就是它；改了之后所有已有池账号登录失败 |
| SAML 签名证书与私钥 | SSO | 沿用则 GitHub 侧证书不用改 |
| SCIM token、Copilot 席位 PAT | SSO | 企业级凭据，沿用 |

可以更换：`API_KEY`（同时更新 LiteLLM）、`INTERNAL_API_TOKEN`、`SESSION_SECRET`（更换后已登录的 Console / SSO 会话失效，需要重新登录）。

### 2.2 新环境的 MySQL

- 专用空库，`utf8mb4`（`utf8mb4_0900_ai_ci`）。
- 运行账号权限与原环境相同：自动迁移方式需要 DDL 权限；DBA 方式只需 `SELECT, INSERT, UPDATE, DELETE` 加 `proxy_accounts` 上的 `TRIGGER`（新部署指南第 3 节）。
- 开启 binlog 的 MySQL（MySQL 8.4 默认开启；托管 MySQL 如 Azure Database for MySQL 也是）上，非 SUPER 账号创建触发器需要 `log_bin_trust_function_creators=ON`，**导入备份时同样需要**（导入文件里有 `CREATE TRIGGER`）。否则导入在触发器处以 `ERROR 1419 ... You do not have the SUPER privilege and binary logging is enabled` 失败。MySQL 8.4 上设置时会提示该变量已弃用（警告 1287），目前仍然生效。

建库与账号示例（管理员会话执行；库名、账号、来源网段是占位值）：

```sql
CREATE DATABASE `<新库名>` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- 导入用的库级管理员（托管 MySQL 的管理员通常也没有 SUPER / SET_ANY_DEFINER）
CREATE USER '<导入账号>'@'<来源网段>' IDENTIFIED BY '<密码>';
GRANT ALL PRIVILEGES ON `<新库名>`.* TO '<导入账号>'@'<来源网段>';
-- Proxy 运行账号，自动迁移方式（MYSQL_AUTO_MIGRATE=true，第 5 节第 1 步需要）
CREATE USER '<proxy_user>'@'<来源网段>' IDENTIFIED BY '<密码>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON `<新库名>`.* TO '<proxy_user>'@'<来源网段>';
-- DBA 方式（MYSQL_AUTO_MIGRATE=false）只授予：
--   GRANT SELECT, INSERT, UPDATE, DELETE ON `<新库名>`.* TO '<proxy_user>'@'<来源网段>';
--   GRANT TRIGGER ON `<新库名>`.`proxy_accounts` TO '<proxy_user>'@'<来源网段>';
-- 自建 MySQL 上（托管 MySQL 在服务器参数里设置）：
SET PERSIST log_bin_trust_function_creators = ON;
```

DBA 方式下缺少 `proxy_accounts` 上的 `TRIGGER` 时，Proxy 看不到触发器元数据，以 `Unsupported MySQL schema: credential fence is missing` 拒绝启动（演练中实测）。

## 3. 停止原环境并备份

1. **暂停账号池**：在原环境 Console 的 **User pool** 页暂停预热，等进行中的登录任务结束（Login Tasks 页没有运行中的任务）。
2. **停止全部四个服务**，所有 Proxy 副本都要停（Kubernetes / Rancher 缩到 0，确认旧 Pod 全部退出）。
3. **备份**（与升级指南第 4 节相同）：

| 数据 | 方法 |
| --- | --- |
| Proxy 的 MySQL 库 | `mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 --set-gtid-purged=OFF <库名> > proxy.sql`。**必须带 `--triggers`**：账号池依赖触发器 `user_pool_credential_fence`。用只有库级权限的账号（例如 Proxy 运行账号）导出时再加 `--no-tablespaces`，否则会打印 `Access denied; you need ... the PROCESS privilege(s) ... when trying to dump tablespaces`（退出码仍为 0，表数据照常导出，但不要把这条错误当成导出失败或忽略其他错误）。确认文件末尾有 `-- Dump completed` |
| SSO | `sso.sqlite` 连同同目录的 `-wal`、`-shm` 文件（建议复制整个卷），以及 `sso-user-events.log`。**早于 r4 的镜像停止时不做 WAL 检查点**（停止退出码为 1），数据可能全部还在 `-wal` 里：演练中 `sso.sqlite` 只有 4 KB 的空壳，7 个用户都在 `sso.sqlite-wal`。只复制 `.sqlite` 会丢失全部数据 |
| Login | `login.sqlite` 连同 `-wal`、`-shm`（同上） |
| Console | `admins.json` |
| 配置 | 原环境的 ConfigMap、Secret、Deployment 清单，以及当前四个镜像的 digest |

导出命令示例（在能访问原集群的跳板机上执行，显式指定 context 与 namespace；Secret 只列键名，确需连值导出时文件必须加密保存）：

```bash
kubectl --context <原集群 context> -n <namespace> get deploy,svc,configmap,pvc -o yaml > config-export.yaml
kubectl --context <原集群 context> -n <namespace> get secret -o custom-columns=NAME:.metadata.name,KEYS:.data --no-headers
```

SQLite 与 Console 文件按“整个卷”复制，服务停止后再复制。Docker / Compose 上演练使用的命令（无网络的一次性容器，只读挂载原卷）：

```bash
docker run --rm --network none -v <原 SSO 卷>:/from:ro -v <备份目录>/sso:/to <任一含 cp 的镜像> cp -a /from/. /to/
# Login、Console 同样处理；复制后对备份目录做 sha256sum 清单，恢复后再比对
```

Kubernetes 上原 Pod 已缩到 0，可以临时起一个只挂载该 PVC、不对外的 Pod，用 `kubectl exec <pod> -- tar -C /data -cf - . > sso-data.tar` 打包后删除该 Pod（未在 Kubernetes 上演练）。

备份完成后，**原环境保持停止**，作为回退的依据（第 10 节）。

## 4. 恢复到新环境

### 4.1 MySQL

**① 处理触发器的 `DEFINER`。** 导出文件中的触发器带有原库账号作为定义者，形如 ``/*!50017 DEFINER=`<原账号>`@`<主机>`*/``。导入账号与它不同、又没有 `SUPER` 或 `SET_ANY_DEFINER` 权限（托管 MySQL 的管理员通常没有）时，导入以 `ERROR 1227 ... you need (at least one of) the SUPER or SET_ANY_DEFINER privilege(s)` 失败——**即使新库里已经建了同名账号也一样**（演练中实测）。可行的做法（三种导入方式都在演练中成功；定义者不存在时的运行期失败是 MySQL 的既有行为，未单独演练）：

- **推荐：去掉 `DEFINER` 子句**，触发器以导入账号为定义者：

  ```bash
  sed -E 's#/\*!50017 DEFINER=`[^`]*`@`[^`]*`\*/ ##' proxy.sql > proxy.nodefiner.sql
  grep -c DEFINER proxy.nodefiner.sql   # 应为 0；只有触发器那一行被改动（可用 diff 确认）
  ```

  之后**不要删除导入账号**：触发器以定义者的权限执行，定义者不存在时对 `proxy_accounts` 的更新会失败。
- 或者在新库中创建同名账号，并**用这个账号本身执行导入**（定义者等于当前账号时不需要额外权限）。
- 有 `SUPER` / `SET_ANY_DEFINER` 的账号（例如自建 MySQL 的 root）可以直接导入原文件，但定义者账号必须在新库中存在。

导入失败会留下已经建好的部分表（演练中失败后库里留下 1 张表）。重试前先 `DROP DATABASE` 再按第 2.2 节重建空库，不要在半导入的库上重试。

**② 以 utf8mb4 会话导入：**

```bash
mysql --default-character-set=utf8mb4 -h <新主机> -u <导入账号> -p <新库名> < proxy.nodefiner.sql
```

导出文件中没有 `USE <库名>`，新库可以与原库不同名。

**③ 授予运行账号权限**（第 2.2 节的 SQL）。自动迁移方式授予 DDL 清单；全部迁移完成后可以改用 DBA 方式的最小权限并设 `MYSQL_AUTO_MIGRATE=false`（演练中两个多企业版 Proxy 用最小权限正常启动并服务）。

**④ 核对：** 表数量，`proxy_accounts`、`user_pool_accounts`、`user_pool_leases` 的行数与原库一致；`information_schema.TRIGGERS` 中有 `user_pool_credential_fence`（`DEFINER` 为导入账号）。可在原库（备份时）和新库分别执行下面的语句，结果应完全相同：

```sql
CHECKSUM TABLE proxy_accounts, user_pool_accounts, user_pool_leases, user_pool_settings, schema_migrations;
```

### 4.2 SQLite 与 Console 文件

把 `sso.sqlite`（含 `-wal`、`-shm`）、`login.sqlite`（含 `-wal`、`-shm`）、`admins.json` 分别复制到新环境 SSO、Login、Console 的数据卷（容器内默认 `/data/`）。文件属主改为 UID/GID `1000`（`deploy/kubernetes/` 的 Pod 以 1000 运行，并设置 `fsGroup`）。

- 早于 r4 的镜像以 root 运行，备份出的文件属主是 `0:0`，`admins.json` 的权限是 `600`。不改属主时，以 1000 运行的新服务：SSO 启动失败（`SQLITE_READONLY`）；Console **能启动且 `/healthz` 返回 200**，但所有页面接口返回 500（`EACCES ... /data/admins.json`）——健康检查发现不了，必须实际登录 Console 核对。
- **卷的根目录也要属于 1000**：SQLite 需要在同目录创建 `-wal`、`-shm`。Login 的日志卷（`/logs`）同样。
- 命令示例（服务停止时执行，一次性容器，无网络）：

  ```bash
  docker run --rm --network none -v <新 SSO 卷>:/data -v <备份目录>/sso:/backup:ro <任一含 cp 的镜像> \
    sh -c 'cp -a /backup/. /data/ && chown -R 1000:1000 /data && ls -lan /data'
  ```

  Kubernetes 上 `fsGroup` 通常会在挂载时把卷内文件的属组改为 1000 并加上组读写，但 `fsGroupChangePolicy: OnRootMismatch` 只在卷根目录不匹配时才执行，且不是所有卷类型都支持（未在 Kubernetes 上演练）。最稳妥的做法仍是复制时直接 `chown -R 1000:1000 /data`（例如在临时 Pod 中）。

## 5. 启动新环境

演练中的顺序是 SSO → Login → Proxy（1 个副本）→ Console → 其余 Proxy 副本；SSO、Login 的 SQLite 迁移在它们启动时完成。

1. **先只启动一个 Proxy 副本**（`MYSQL_AUTO_MIGRATE=true`，默认）。它取得迁移锁，把原数据迁移为多企业结构并全部归入 `default`；`/readyz` 返回就绪后再继续。日志中**没有单独的“迁移完成”行**：Proxy 在迁移完成后才打印 `[proxy] enterprise default ...` 和 `listening`，以 `/readyz` 与下面第 3 步的 `schema_migrations` 为准。库较大时调高 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`（升级指南第 5.1 节）。
   - DBA 方式：由 DBA 以 utf8mb4 会话执行本版本的 `scripts/proxy-mysql-enterprise-upgrade.sql`，再以 `MYSQL_AUTO_MIGRATE=false` 启动（升级指南第 5.2 节）。
2. 启动 Console。
3. 检查迁移记录完整，然后把 Proxy 扩到目标副本数：

   ```sql
   SELECT id FROM schema_migrations ORDER BY id;
   -- 原有 3 条 + enterprise-v1/01-create-proxy-enterprises、02-seed-default、03-accounts-enterprise、
   -- 04-accounts-guards、05-initializations-and-stats、06-pool-accounts、07-pool-events、08-pool-config-fingerprint，共 11 条
   SELECT id, state, max_accounts, inventory_count FROM proxy_enterprises;   -- default / active / 原 max_accounts / 原账号数
   ```

## 6. 切换外部依赖

- **GitHub 企业的 SAML 设置**：新环境的 SSO 对外地址与原来不同时，把 Sign on URL 改为 `<新 SSO_PUBLIC_BASE_URL>/sso`、Issuer 改为 `<新 SSO_PUBLIC_BASE_URL>/metadata`（`default` 企业使用根路径）。签名证书沿用则不用改。SCIM 是 SSO 主动调用 GitHub，无需修改。
- **LiteLLM**：把 GHCP 部署的 `GHCP_POOL_API_BASE`（及 `GHCP_POOL_API_BASES`）指向新 Proxy；更换了 `API_KEY` 时同步更新 `GHCP_PROXY_API_KEY`。身份 Hook / 灰度 Hook 不变。

## 7. 验证（先不恢复预热）

1. 四个服务 `/healthz` 返回 `releaseLine: "multi"`。
2. Console 能用原管理员登录；**Pool overview** 中 `default` 为 `active`，账号数、Ready idle、Leased 与停机前一致；**Pool members** 的 Leases 与原环境一致。
3. 用一个已有调用方的 key 经 LiteLLM 发请求：落在他原来的账号上（Pool members 中按 key hash 搜索）。
4. 用一个新调用方的 key 发请求：分到一个空闲账号。
5. 以上正常后，在 **Pool overview** 取消 **Pause prewarming**，观察补号（新账号经 SSO SAML 登录成功，说明 GitHub 侧 SAML 配置已指向新 SSO）。

## 8. 原环境下线

新环境稳定运行一段时间（建议至少覆盖一个租约周期，默认 48 小时）后，再删除原环境的工作负载。在此之前**不要启动原环境**。原环境的数据卷与 MySQL 备份按客户的保留策略保存。

## 9. 添加其他企业

迁移验证通过后，按[升级指南第 11 节](multi-enterprise-upgrade-guide.md)或[新部署指南第 10 节](multi-enterprise-new-deployment-guide.md)添加：编写 registry → 重启 Proxy、SSO、Login → 新企业以 `draft` 出现 → 在 GitHub 侧为该企业配置 SAML（`<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso`）→ Console 中设置 cap 并 **Activate**。不需要数据库迁移。

## 10. 回退

原环境的数据在整个过程中没有被修改，所以回退不需要恢复任何东西：

1. 停止新环境的四个服务。
2. GitHub 企业的 SAML 设置改回原 SSO 地址；LiteLLM 的 GHCP 地址改回原 Proxy。
3. 启动原环境（r4），在 Console 中取消暂停预热。

注意：新环境运行期间开出的新池账号、产生的新租约只存在于新环境的数据库中，回退后原环境不知道它们（它们在 GitHub 上仍存在）。所以第 7 节验证期间保持预热暂停，确认无误后再恢复，可以把这种情况减到最少。

演练中观察到的具体后果：新环境恢复预热后开出了 2 个新账号；回退到原环境并取消暂停后，原环境按同样的命名顺序生成了同名账号，SCIM 创建返回 409（GitHub 上已存在），这 2 个账号在原环境中变为 `failed`，idle 目标没有补满。回退后请在 Console 的 Pool members 中处理这些 `failed` 账号，并在 GitHub 中核对新环境开出的用户与席位。同样的冲突也会出现在任何“曾经开过号的环境”之后启动的另一套环境上（包括演练环境），这也是第 11 节要求演练时不恢复预热的原因之一。

## 11. 演练建议

正式迁移前，用原环境的一份备份在新环境（或单独的测试环境）完整走一遍第 4–7 节，**不要切换 GitHub 的 SAML 设置和 LiteLLM，也不要恢复预热**（演练环境同样不能与原环境同时去改 GitHub）。演练能提前暴露触发器 `DEFINER`、字符集、文件属主、迁移耗时这些问题，并得到准确的维护窗口时长。我们自己的本地演练结果见第 12 节。

演练环境与原环境、正式新环境共用同一个 GitHub 企业时，演练结束后**丢弃演练环境的数据**，不要把演练库当作正式迁移的起点；正式迁移重新从停机后的备份开始。

## 12. 附录：演练结果（本地 Docker，合成数据）

2026-10-29 在本地 Docker Desktop 上按本文完整演练了一次。只用合成凭据；一个 mock 扮演 GitHub（SCIM、席位、Login 任务与回调、`/user`、Copilot），在原环境与新环境之间保持运行（与真实 GitHub 一样保留用户、席位和 token），同一时间只有一套环境接入它。没有连接任何真实 GitHub、Copilot、云或 Kubernetes。

| 环节 | 结果 |
| --- | --- |
| 原环境 | 用 `deploy/user-pool-mysql-customer/build-images.mjs` 的流程从 `bf38374`（含 `POOL_INFERENCE_TIMEOUT_SECONDS`）构建四个镜像（`git archive` 后 `docker build`，带 `org.opencontainers.image.revision`；npm 通过 `NPM_REGISTRY` 构建参数指向内部源，该脚本本身不能传构建参数）。MySQL 8.4、两个 Proxy（`caller-lease`，`POOL_REQUEST_TIMEOUT_SECONDS=120`、`POOL_INFERENCE_TIMEOUT_SECONDS=600`，沿用当时模板的启动命令覆盖）、SSO、Login、Console。初始化 Console 管理员，开池得到 7 个 ready 账号，3 个调用方（`sha256:<hex>`）经推理接口取得租约；`schema_migrations` 3 条 |
| 停机与备份 | 暂停预热、停止全部服务（旧 SSO/Login/Console 停止时退出码为 1，数据留在 `-wal`）。`mysqldump` 按第 3 节；库级账号导出出现 PROCESS 提示，与管理员导出的文件逐字相同 |
| 恢复（第 4 节） | 非 SUPER 导入账号：先遇到 `ERROR 1419`（binlog），开启 `log_bin_trust_function_creators` 后遇到 `ERROR 1227`（DEFINER）；去掉 `DEFINER` 后导入成功（约 5 秒），五张关键表 `CHECKSUM TABLE` 与原库相同。文件不改属主时 SSO `SQLITE_READONLY`、Console 接口 500 但 `/healthz` 200；`chown -R 1000:1000` 后正常 |
| r4 中转 | r4 在原数据上启动（Proxy 先 1 个，再 2 个）：数据库快照（表、行数、租约、设置、指纹、迁移记录）**与导入后完全相同**，3 条 `schema_migrations`；SSO/Login 的 SQLite 补上 r4 的列与表；Console 数据完整。停止后用库级管理员加 `--no-tablespaces` 再备份一次 |
| 多企业版 r3（演练时的当前版本；r4 只改了 Proxy 发往上游的请求时限和 qs，没有数据库、配置或接口变化，结果同样适用） | Proxy 先 1 个、再扩到 2 个：`schema_migrations` 共 11 条（含 `enterprise-v1/01`–`08`）；`default` 为 `active`，cap 等于原 `max_accounts`，库存 7；四个服务 `/healthz` 返回 `releaseLine: "multi"`；3 个已有调用方经两个 Proxy 都落在原账号；新调用方分到空闲账号；取消暂停后经 mock 补号成功（走按企业作用域的 Login 任务与回调）；推理请求在数据库中的 hold 截止时间约 600 秒、启动日志 `Pool request budgets` 为 `inferenceTimeoutMs: 600000`，说明 `POOL_INFERENCE_TIMEOUT_SECONDS` 仍然生效。之后改用 DBA 方式最小权限、`MYSQL_AUTO_MIGRATE=false` 重启两个 Proxy，正常 |
| 指纹检查 | 只把一个 Proxy 的 `POOL_REQUEST_TIMEOUT_SECONDS` 改为 90：该副本以 `Pool configuration differs between Proxy replicas` 拒绝启动；改回 120 后正常 |
| 直接跳转（仅供参考） | 在同一份备份的另一份副本上不经 r4、直接启动多企业版：迁移成功，MySQL 结构（`mysqldump --no-data`）与经 r4 中转的结果逐字相同，数据快照相同；SQLite 结构仅列名引号写法不同；路由、Console 正常。这只是一个样本（`bf38374` 的结构与 r4 相同），**推荐做法仍是第 1.2 节的 r4 中转** |
| 回退（第 10 节） | 停止新环境后原样启动原环境：原库 `CHECKSUM TABLE` 未变，Console、两个 Proxy、已有调用方的路由都与迁移前相同。取消暂停后出现第 10 节所述的 SCIM 409 与 `failed` 账号 |

未覆盖：真实 Login（Chromium）登录任务（演练中由 mock 代替 Login 执行任务，Login 任务历史为空）；Kubernetes / Rancher 与 `fsGroup`；托管 MySQL（用无 SUPER 的库级账号模拟）；大数据量下的迁移耗时；原环境 SSO、Login、Console 的实际版本（演练中四个服务都用 `bf38374`）。自动迁移的 DDL 权限清单（第 2.2 节）在直接跳转那一次实测通过；r4 中转那一次使用的是库级 `ALL PRIVILEGES`（r4 在该数据上没有执行任何结构变更）。
