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

- 新环境使用当前多企业版镜像（digest 见[发布验证记录](multi-enterprise-release-validation.md)最新一节），四个组件同一版本。
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
| 环境变量 | 有 `LOGIN_SSO_PROVIDER` → 早于 r4；有 `MYSQL_AUTO_MIGRATE`、`SHUTDOWN_TIMEOUT_MS` → r4 |
| SSO / Login 的 SQLite | `sso_users` 有 `copilot_seat_pending_cancellation_date` 列、Login 有 `login_task_attempts` 表 → 至少运行过 r4 |

查看 Pod 实际运行的镜像（显式指定原集群的 context 与 namespace）：

```bash
kubectl --context <原集群 context> -n <namespace> get pods -o custom-columns=POD:.metadata.name,IMAGE:.status.containerStatuses[*].imageID
```

`/healthz` 和 MySQL 的 `schema_migrations` 无法区分 r4 与更早的账号池版本（r4 及以前 `/healthz` 只有 `status`、`service`；`schema_migrations` 从 MySQL 账号池首个版本到 r4 都是同样 3 条记录）。

### 1.2 原环境早于 r4 时

- **MySQL 账号池版本**（源码提交 `2bc12b3`，2026-09-15 及以后，包括用 `build-images.mjs` 交付的版本）：Proxy 的 MySQL 表结构从那时到 r4 基本没有变化，r4 会自动处理两种旧形状（统计表补列、token 列排序规则）。**在新环境里多走一步**：第 4 节恢复数据后，先用 **r4** 镜像启动一次（账号池在备份前已暂停，暂停状态保存在数据库里，r4 启动后不会开户），确认 `/readyz` 正常、Console 数据完整，再按第 5 节换成多企业版。SSO / Login 的 SQLite 由 r4 在启动时自动补列，只进不退。
  - 这样做的原因：经过资格测试的是“r4 之前的基线 → r4”和“r4 → 多企业版”这两段；直接从更早的版本跳到多企业版在代码上大概率可行，但没有验证过，不推荐。
  - r4 的配置变化见 [r4 升级指南](user-pool-release-upgrade-guide.md)第 4 节（例如删除 `LOGIN_SSO_PROVIDER`；Proxy 不要再覆盖启动命令）。影响账号池配置指纹的 Proxy 环境变量保持不变（第 2.1 节）。
- **未提交源码构建的内部测试镜像**（例如 2026-09-14 前后的 `production-fix`、`check` 等 tag）：没有对应的提交，表结构无法从 git 核对。先把备份恢复到一个隔离的临时库，与 r4 的 `scripts/proxy-mysql-initial.sql` 建出的结构比对；结构不同时 r4 会以 `Unsupported MySQL schema` 拒绝启动，需要单独评估。
- **PostgreSQL / Redis 的旧版**（迁移到本 fork 之前的 Azure AKS 部署）：**没有迁移路径**，仓库中也没有 PostgreSQL → MySQL 的数据工具。只能在新环境全新部署（同一 GitHub 企业时注意第 0 节所说的孤儿账号与席位问题），或另行开发数据导出工具。

## 2. 准备新环境（不要启动应用）

按新部署指南部署新环境，但**四个服务保持不启动**：副本数为 0，或保持启动门禁（`GHCP_CONFIG_APPROVED` 不是 `true`）。

> **不要用空库先启动新环境。** 账号池一旦启用，就会通过 SCIM 在真实企业中新开账号，与原环境的账号冲突。

### 2.1 必须与原环境完全相同的配置

| 配置 | 服务 | 原因 |
| --- | --- | --- |
| `ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`（GHE.com 则为 `GITHUB_BASE_URL`） | Proxy、SSO、Login | 企业身份；有数据后不能修改（新部署指南第 4 节） |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | Proxy | 企业身份的一部分 |
| 账号池的其他 Proxy 参数（`POOL_WARMUP_MODEL`、`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_CONCURRENCY`、`PREWARM_POLL_SECONDS`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` 等） | Proxy | 它们写进 MySQL 中的账号池配置指纹；与原值不同时 Proxy 以 `Pool configuration differs between Proxy replicas` 拒绝启动。最稳妥：**原样复制原 Proxy 的全部非机密环境变量**。idle 目标、cap、租约时长不在指纹中，它们本来就保存在数据库里 |
| `POOL_REQUEST_TIMEOUT_SECONDS`（默认 120） | Proxy | 账号池上游请求时限，**属于账号池配置指纹**：与原值不同时 Proxy 拒绝启动。即使已用下一行把推理时限调大，这个值也保持原样 |
| `POOL_INFERENCE_TIMEOUT_SECONDS`（原环境设置过时，例如 600） | Proxy | 三条推理路径（`/v1/messages`、`/chat/completions`、`/responses`）的单独总时限（`bf38374` 起提供），**不在指纹中**。原环境设置过就必须带到新环境，否则长请求又会在 `POOL_REQUEST_TIMEOUT_SECONDS` 处被截断；原环境没有设置则不设 |
| `SSO_DEFAULT_USER_PASSWORD` | SSO | 每个池账号的 SSO 密码就是它；改了之后所有已有池账号登录失败 |
| SAML 签名证书与私钥 | SSO | 沿用则 GitHub 侧证书不用改 |
| SCIM token、Copilot 席位 PAT | SSO | 企业级凭据，沿用 |

可以更换：`API_KEY`（同时更新 LiteLLM）、`INTERNAL_API_TOKEN`、`SESSION_SECRET`（更换后已登录的 Console / SSO 会话失效，需要重新登录）。

### 2.2 新环境的 MySQL

- 专用空库，`utf8mb4`（`utf8mb4_0900_ai_ci`）。
- 运行账号权限与原环境相同：自动迁移方式需要 DDL 权限；DBA 方式只需 `SELECT, INSERT, UPDATE, DELETE` 加 `proxy_accounts` 上的 `TRIGGER`（新部署指南第 3 节）。
- 开启 binlog 的托管 MySQL（例如 Azure Database for MySQL）上，非 SUPER 账号创建触发器需要 `log_bin_trust_function_creators=ON`。

## 3. 停止原环境并备份

1. **暂停账号池**：在原环境 Console 的 **User pool** 页暂停预热，等进行中的登录任务结束（Login Tasks 页没有运行中的任务）。
2. **停止全部四个服务**，所有 Proxy 副本都要停（Kubernetes / Rancher 缩到 0，确认旧 Pod 全部退出）。
3. **备份**（与升级指南第 4 节相同）：

| 数据 | 方法 |
| --- | --- |
| Proxy 的 MySQL 库 | `mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 --set-gtid-purged=OFF <库名> > proxy.sql`。**必须带 `--triggers`**：账号池依赖触发器 `user_pool_credential_fence` |
| SSO | `sso.sqlite` 连同同目录的 `-wal`、`-shm` 文件（建议复制整个卷），以及 `sso-user-events.log` |
| Login | `login.sqlite` 连同 `-wal`、`-shm` |
| Console | `admins.json` |
| 配置 | 原环境的 ConfigMap、Secret、Deployment 清单，以及当前四个镜像的 digest |

导出命令示例（在能访问原集群的跳板机上执行，显式指定 context 与 namespace；Secret 只列键名，确需连值导出时文件必须加密保存）：

```bash
kubectl --context <原集群 context> -n <namespace> get deploy,svc,configmap,pvc -o yaml > config-export.yaml
kubectl --context <原集群 context> -n <namespace> get secret -o custom-columns=NAME:.metadata.name,KEYS:.data --no-headers
```

备份完成后，**原环境保持停止**，作为回退的依据（第 10 节）。

## 4. 恢复到新环境

### 4.1 MySQL

**① 处理触发器的 `DEFINER`。** 导出文件中的触发器带有原库账号作为定义者（`DEFINER=<原账号>@<主机>`），新库中没有该账号时导入会失败。二选一：在新库中先创建同名账号；或者去掉导出文件中触发器的 `DEFINER=...` 子句，让触发器以导入账号为定义者。

**② 以 utf8mb4 会话导入：**

```bash
mysql --default-character-set=utf8mb4 -h <新主机> -u <管理员> -p <新库名> < proxy.sql
```

**③ 授予运行账号权限**（第 2.2 节）。

**④ 核对：** 表数量，`proxy_accounts`、`user_pool_accounts`、`user_pool_leases` 的行数与原库一致；`information_schema.TRIGGERS` 中有 `user_pool_credential_fence`。

### 4.2 SQLite 与 Console 文件

把 `sso.sqlite`（含 `-wal`、`-shm`）、`login.sqlite`（含 `-wal`、`-shm`）、`admins.json` 分别复制到新环境 SSO、Login、Console 的数据卷（容器内默认 `/data/`）。文件属主改为镜像内的 UID/GID `1000`（`deploy/kubernetes/` 的 Pod 以 1000 运行，并设置 `fsGroup`）。

## 5. 启动新环境

1. **先只启动一个 Proxy 副本**（`MYSQL_AUTO_MIGRATE=true`，默认）。它取得迁移锁，把原数据迁移为多企业结构并全部归入 `default`；日志中出现迁移完成、`/readyz` 返回就绪后再继续。库较大时调高 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`（升级指南第 5.1 节）。
   - DBA 方式：由 DBA 以 utf8mb4 会话执行本版本的 `scripts/proxy-mysql-enterprise-upgrade.sql`，再以 `MYSQL_AUTO_MIGRATE=false` 启动（升级指南第 5.2 节）。
2. 启动 SSO、Login、Console。
3. 检查迁移记录完整（`schema_migrations` 中 `enterprise-v1/*` 全部存在），然后把 Proxy 扩到目标副本数。

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

## 11. 演练建议

正式迁移前，用原环境的一份备份在新环境（或单独的测试环境）完整走一遍第 4–7 节，**不要切换 GitHub 的 SAML 设置和 LiteLLM，也不要恢复预热**（演练环境同样不能与原环境同时去改 GitHub）。演练能提前暴露触发器 `DEFINER`、字符集、文件属主、迁移耗时这些问题，并得到准确的维护窗口时长。
