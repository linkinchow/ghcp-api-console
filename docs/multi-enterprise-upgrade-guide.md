# GHCP 多企业版升级指南：从单企业版 r4 升级

本指南适用于把现有**单企业版 r4**（tag `single-slug-164cade-amd64-r4`，见 [r4 升级指南](user-pool-release-upgrade-guide.md)）部署原地升级到**多企业版**（multi-enterprise）。存储支持 SQLite 与 MySQL。

多企业版是独立的发布线：镜像 tag 以 `multi-` 开头，不复用 `single-slug-*`，不发布 `latest`。单企业版继续单独维护；不需要多个企业的客户可以留在单企业版。

没有现有部署、要全新安装多企业版时，请看 [多企业版新部署指南](multi-enterprise-new-deployment-guide.md)。

## 1. 本版本包含什么

| 类别 | 内容 |
| --- | --- |
| 多企业 | 一套部署（一个 SSO、一个 Login、一个 Console、N 个 Proxy 副本）管理多个 GitHub 企业，可混用 github.com 与 GHE.com。每个企业有自己的 slug、shortcode、SAML/SCIM、席位 PAT、登录页和 Models 管理员。配置见 [registry 配置参考](multi-enterprise-registry.md)。 |
| 原地升级 | 启动时自动迁移数据库；已有数据全部归入 `default` 企业。**不配置 registry 时无需修改任何配置**，行为与单企业版相同。 |
| 账号池 | 所有企业共享一个全局 idle 目标，按各企业 cap 的比例补货；企业有 `draft` → `active` → `draining` 生命周期。 |
| Console | 页头企业选择器；新增 Pool overview 页（全局设置 + 企业表：cap、激活、排空、恢复）和按企业的 Pool members 页；Models 页按企业查询。 |
| 安全加固 | Console 所有写操作校验同源；SSO 登录/登出拒绝跨站请求；Login 登录页白名单按整段路径匹配；Login 回传令牌前，Proxy 用 GitHub `/user` 核对账号身份。 |
| 镜像 | 仍是同一个 `deploy/images/Dockerfile.release`，构建参数 `RELEASE_LINE=multi`。镜像带 label `com.ghcp.release-line=multi`，四个服务的 `/healthz` 返回 `"releaseLine": "multi"`。 |

## 2. 前提与镜像

- **只支持从 r4 升级**。更早的版本请先按 [r4 升级指南](user-pool-release-upgrade-guide.md) 升级到 r4 并验证。
- 四个组件必须使用同一版本：

| 组件 | 按 digest 引用（linux/amd64） |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:00453e3b81a3fea67ef05d4fce1e3def680dac96ae9ca288a85d1a77c74997b6` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:5b112760945fa5444d5720d48ddae5a4da9fa42ead08a8fa5715356395dcefe7` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:6a7e48f79a86a04a5343ad0e6c4ac9f294ddd87c772f36927f9bbb148ffe1d2e` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:a1605e6304597387e3e193223b01823d89b7a007d7e7bb5d8e44e236b97d3e2c` |

对应 tag 均为 `multi-4922a4a-amd64-r2`（linux/amd64，2026-10-20 发布，仓库公开，无需登录即可拉取）。源码提交：`4922a4a`（main）。

r2 相对 r1（`multi-41ecffc-amd64-r1`）的变化：全局 `READY_IDLE_TARGET` 不再受单个企业 cap（`POOL_MAX_ACCOUNTS`）限制，r1 在 idle 目标大于该值时拒绝启动，r2 正常启动；Console Pool overview 企业表的列名改为 Provisioning。两者之间没有数据库或服务间接口变化，已部署 r1 的环境替换四个镜像即可（这条 r1→r2 路径没有单独做资格测试；r4→r2 原地升级已验证，见[发布验证记录](multi-enterprise-release-validation.md)）。新升级请直接使用 r2。

部署时请按 **digest** 引用，建议先同步到客户自己的镜像仓库。

## 3. 首次升级需要短暂停机

首次升级**必须一次性替换全部四个镜像**，不能滚动混跑：

- 迁移后旧版本按设计**拒绝工作**（fail closed）：MySQL 上 r4 Proxy 因严格的 schema 校验和账号池配置指纹而无法启动，仍在运行的 r4 副本写入会失败（新列 `enterprise_id` 没有默认值）；SQLite 上 r4 能读，但写入被触发器拒绝。
- 服务间内部接口改为按企业的路径（`/internal/enterprises/<id>/...`）。新旧版本混跑时，旧路径返回 400，进行中的登录任务会失败。

做法：停止全部四个服务 → 备份 → 换镜像 → 启动。Kubernetes/Rancher 使用 `strategy: Recreate`（仓库模板已改），或先把四个工作负载缩到 0。停机时长主要取决于数据库迁移，请先在一份数据副本上实测（第 5 节）。

首次升级完成后，同一多企业版本线内的 Proxy 更新可以恢复滚动更新。

## 4. 升级前准备

1. **（账号池模式）暂停账号池**：在 Console User pool 页暂停，等进行中的登录任务结束。升级时被中断的任务由 Login 启动时的恢复逻辑处理，不保证无损续跑。
2. **停止全部四个服务后备份**（回滚只能靠备份，见第 10 节）：

| 数据 | 位置（仓库 Compose 默认） |
| --- | --- |
| Proxy | SQLite：`/data/proxy.sqlite` 及同目录的 `-wal`、`-shm` 文件（建议复制整个卷）；MySQL：对 Proxy 库做一致性备份（例如 `mysqldump --single-transaction`） |
| SSO | `/data/sso.sqlite`（含 `-wal`、`-shm`），以及 `sso-user-events.log` |
| Login | `/data/login.sqlite`（含 `-wal`、`-shm`） |
| Console | `/data/admins.json` |
| 其他 | SSO 签名证书目录、Compose 文件与 `.env`（或 ConfigMap / Secret / Deployment 清单）、当前四个镜像的 digest |

3. 检查配置变化（第 6 节）。

## 5. MySQL

### 5.1 自动迁移（`MYSQL_AUTO_MIGRATE=true`，默认）

- 第一个启动的 Proxy 副本取得迁移锁并执行迁移；其他副本最多等待 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS` 秒（默认 30，范围 1–3600），超时后退出并由容器平台重启。
- **建议先只启动 1 个 Proxy 副本**，`/readyz` 正常后再扩容。
- `proxy_request_stats` 很大时：调高 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`（例如 `600`）；Proxy 在迁移完成后才开始监听，Kubernetes 的 `startupProbe` 也要覆盖迁移时间（仓库模板约 300 秒）。或者由 DBA 先执行第 5.2 节的脚本。
- 所需权限与 r4 自动迁移相同（建表、改表、建索引、外键），**不需要新增 TRIGGER 权限**。

### 5.2 DBA 手动迁移（`MYSQL_AUTO_MIGRATE=false`）

1. 停止全部 Proxy 副本，备份数据库。
2. DBA 用管理员账号对 Proxy 库执行**本版本源码**中的 `scripts/proxy-mysql-enterprise-upgrade.sql`，只执行一次，例如：`mysql --default-character-set=utf8mb4 <Proxy库名> < scripts/proxy-mysql-enterprise-upgrade.sql`。**会话字符集必须是 utf8mb4**：latin1 会话（部分客户端的默认值）建出的 CHECK 约束带 `_latin1` 前缀，`MYSQL_AUTO_MIGRATE=false` 时 Proxy 会拒绝启动。main 上的脚本开头已有 `SET NAMES utf8mb4`；r2 源码提交 `4922a4a` 中的脚本还没有这一行，用它时必须加 `--default-character-set=utf8mb4`。两个版本的脚本结构变更相同，都适用于 r2 镜像。
3. 启动 Proxy（保持 `MYSQL_AUTO_MIGRATE=false`）。Proxy 只读校验 schema，再用运行时权限（INSERT/UPDATE）补全 `default` 企业的指纹、cap 和库存计数，并更新账号池配置指纹。

注意：

- 脚本**只适用于 r4 的 schema**，且**不可重入**。中途失败时二选一：恢复备份后重来；或用 `MYSQL_AUTO_MIGRATE=true` 启动**一个** Proxy 副本，它会识别已执行的步骤并完成剩余部分。
- schema 未升级就启动时，Proxy 报错并提示应执行的脚本。
- 全新的空库仍使用 `scripts/proxy-mysql-initial.sql`（已包含多企业的表和列）。

## 6. 配置变化

不配置 registry 时，**不需要修改任何配置**。

| 变量 / 配置 | 服务 | 变化 |
| --- | --- | --- |
| `ENTERPRISE_REGISTRY_FILE` | Proxy、SSO、Login | 新增，可选。registry 文件的容器内路径，只读挂载。添加第二个企业时才需要（第 11 节）。 |
| `MYSQL_MIGRATION_LOCK_WAIT_SECONDS` | Proxy | 新增，默认 `30`。见第 5.1 节。 |
| `DIRECT_MODE_ENTERPRISE_ID` | Proxy | 新增，仅直连模式。新 identity 归属的企业，默认 `default`。 |
| `CONSOLE_PUBLIC_BASE_URL` | Console | 新增，可选。Console 前有反向代理且会改写 Host 头时，设为用户访问的 Console 地址；Console 的写操作只接受来自该地址或请求 Host 的同源请求。 |
| `GITHUB_API_BASE_URL`、`COPILOT_API_BASE_URL` | Proxy、SSO | GHE.com 下未设置时自动推导为 `https://api.<子域>.ghe.com`、`https://copilot-api.<子域>.ghe.com`。显式设置时必须属于同一个 `<子域>.ghe.com`，否则启动失败。 r4 中如果只给 SSO 设置了 `GITHUB_API_BASE_URL`，升级后 **Proxy 也要设置同一个值**：多企业版 Proxy 在 Login 回传 token 时会调用 `GET <API 地址>/user` 核对账号身份，地址不可达时补货会全部以 `oauth_login_failed` 失败。 |
| `ENTERPRISE_SHORTCODE` | Proxy、SSO | 自动转为小写（与 r4 生成登录名的方式一致）。 |
| `docker-compose.yml` | — | `GITHUB_BASE_URL`、`GITHUB_API_BASE_URL`、`COPILOT_API_BASE_URL`、`ENTERPRISE_SHORTCODE`、`GITHUB_OAUTH_CLIENT_ID` 的默认值改为空，空值时服务使用与 r4 模板相同的内置值；新增 `docker-compose.enterprise-registry.yml` 用于挂载 registry。 |
| Kubernetes / Rancher 模板 | Proxy | `strategy` 改为 `Recreate`（第 3 节）；新增上述变量和 registry 挂载示例（注释）。`terminationGracePeriodSeconds: 45` 与 Compose `stop_grace_period: 35s` 不变。 |

## 7. 升级步骤

### Docker Compose

1. 完成第 4 节（暂停账号池、`docker compose stop`、备份）。**不要**使用 `down -v`。
2. 将四个服务的 `image:` 改为第 2 节的 `镜像@digest`。
3. MySQL 多副本：先用 `--scale proxy=1` 启动，或按第 5.1 节调高等待时间。
4. `docker compose up -d`，查看 Proxy 日志确认迁移完成、打印出 `enterprise default`，再恢复原副本数。

### Kubernetes / Rancher

1. 完成第 4 节；把 SSO、Login、Console、Proxy 缩到 0，确认旧 Pod 全部退出后备份。
2. 四个工作负载的镜像改为 `镜像@digest`；Proxy 使用 `strategy: Recreate`，副本数先设为 1。
3. 按 SSO → Login → Proxy → Console 的顺序启动；等 Proxy `/readyz` 正常后，把 Proxy 扩到原副本数。
4. SSO、Login 保持单实例。

完成第 9 节检查后，在 Console 恢复账号池。

## 8. 可能注意到的行为变化

- **管理接口加上企业作用域**：Console 已全部改用新路径。自建脚本如果直接调用 Proxy、SSO、Login 的管理接口，需要改为 `/api/enterprises/default/...`。Proxy 中除 `/api/enterprises`、`/api/user-pool/overview`、`/api/user-pool/settings`、错误诊断等全局接口外，无作用域的旧路径返回 400 `enterprise_scope_required`；只有旧的 `/api/accounts*` 保留一个版本，响应带 `Deprecation: true`。监控脚本如果轮询旧的全局 `/api/user-pool/summary`，升级后会收到 400：全局计数改用 `/api/user-pool/overview`，单个企业用 `/api/enterprises/<id>/user-pool/summary`。
- **账号池 cap 改为按企业设置**：在 Pool overview 页的企业表中修改；`PATCH /api/user-pool/settings` 再传 `max_accounts` 会返回 409 `use_enterprise_cap`。升级后 `default` 的 cap 等于升级前的值。
- **Console**：页头出现企业选择器（升级后只有 `default`）。选择器不是权限边界，所有管理员都能管理所有企业。
- **GHE.com**：未设置 API 地址时自动推导（第 6 节）。
- **SSO**：
  - SSO 的 `BASE_URL`（Compose 中为 `SSO_PUBLIC_BASE_URL`）是 https 时，会话 cookie 带 Secure 属性（r4 不带），TLS 在前置代理终止时也能正常写入。用户和 Login 浏览器应通过该 https 地址访问 SSO 登录页。
  - 无效的 SAML 请求返回 400 和纯文本（`text/plain`）错误说明。
  - 登录、登出表单拒绝跨站提交（403）。
  - 已有的 `sso_session` 会话、IdP entityID、证书和 GitHub 侧 SAML 配置都不变。
- **Login**：任务请求不能再覆盖 SSO 登录地址或选择器；登录页白名单按整段路径匹配（`/login` 不再匹配 `/loginfoo`）。
- **`/healthz`** 多了 `releaseLine` 字段，原有字段不变。

## 9. 升级后检查（不调用真实模型）

- 四个服务的 `/healthz` 返回 `"releaseLine": "multi"`；Proxy `/readyz` 正常。
- 日志中没有 `enterprise_registry_invalid`、`enterprise_env_conflict`、`enterprise_identity_changed` 等启动错误。
- Console 能登录；企业选择器显示 `default`；Pool overview 页企业表中 `default` 为 `active`，cap 与库存等于升级前，Blockers 为空。
- 账号、SSO 用户、登录任务、请求统计与升级前一致。
- 根路径 SAML 登录可用，已登录的会话仍有效。
- MySQL：`SELECT id FROM schema_migrations WHERE id LIKE 'enterprise-v1/%'` 有记录。
- 恢复账号池后，用测试调用方确认原租约仍可用。

## 10. 回滚

**只支持备份恢复，不支持只换回镜像。** r4 在已迁移的 MySQL 上会按设计拒绝启动；在已迁移的 SQLite 上写入会失败。

回滚步骤：

1. 停止全部四个新版本服务。
2. 用第 4 节的备份恢复 Proxy 数据库、`sso.sqlite`、`login.sqlite` 和 `admins.json`（SQLite 连同 `-wal`、`-shm` 一起恢复或删除）。
3. 用 r4 的 digest（见 [r4 升级指南](user-pool-release-upgrade-guide.md)）和**升级前保存的** Compose 文件、`.env`（或清单）启动四个服务。不要用本版本的 `docker-compose.yml` 启动 r4：其中部分变量的默认值改为空，r4 的 SSO 不把空值当作未设置。

升级后产生的数据（新账号、SSO 用户、登录任务、统计、新增企业）会丢失。数据库恢复**不会撤销 GitHub 侧的变化**（已通过 SCIM 创建的用户、已分配的席位），回滚后请在 GitHub 中核对。

## 11. 添加第二个企业

建议在升级验证完成、稳定运行后，作为单独的变更进行。完整步骤见 [registry 配置参考](multi-enterprise-registry.md) 第 9 节，概要：

1. 在 GitHub 企业中配置 SAML（Sign on URL `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso`，Issuer `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata`），准备 SCIM token、席位 PAT 和独立的签名证书。
2. 编写 registry（参考 `deploy/enterprise-registry.example.json`），只读挂载到 Proxy、SSO、Login（Compose：`docker-compose.enterprise-registry.yml`；Kubernetes：ConfigMap + Secret 卷，模板中有注释示例）。推荐 registry 不写 `default`，`default` 继续由环境变量定义；若写，请按 registry 配置参考第 5 节处理环境变量，否则启动报 `enterprise_env_conflict`。
3. 重启 Proxy、SSO、Login（可以逐个重启；新企业在三方就绪前一直是 `draft`，不会被调度）。
4. 在 Pool overview 页查看新企业的 Blockers，设置 cap，然后 Activate。

## 12. 验证范围说明

- 发布前资格测试覆盖：r4 → 多企业版原地升级（MySQL 与 SQLite，同一数据卷，无 registry、配置不变）、升级前后数据逐项一致、r4 在已迁移的 MySQL 上被拒绝启动、备份恢复后 r4 正常运行、迁移中途中断后继续完成、添加一个 GHE.com mock 企业并完成激活、补货和推理，以及跨企业隔离检查。结果见 [多企业版发布验证记录](multi-enterprise-release-validation.md)。
- **GHE.com 企业只用 mock 验证**（网页、OAuth 设备授权、SCIM、席位、Copilot 均为 mock），**尚未在真实 GHE.com 环境验收**；也没有调用真实 GitHub/Copilot。首次接入真实 GHE.com 企业前，请先在预发布环境验证，可设置 `AUTH_DEBUG_ARTIFACT_DIR` 保存登录过程截图。
- 不支持新旧版本混跑；未验证客户环境的网络、性能和大数据量下的迁移时长。请在客户预发布环境用同一 digest、同等规模的数据副本完成升级演练后再上线。
