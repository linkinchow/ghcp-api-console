# GHCP 单企业版升级指南：Docker Hub 镜像（r4）

本指南适用于把现有**单企业**（single-slug）部署升级到 Docker Hub 发布的 r4 镜像（2026-10-17 发布）。存储支持 SQLite 与 MySQL；不适用于旧的 PostgreSQL 版本。

## 1. 本版本包含什么

| 类别 | 内容 |
| --- | --- |
| 上游新功能 | GHE.com 数据驻留（`GITHUB_BASE_URL`）；SSO 内存泄漏修复与异步密码哈希；Copilot 席位 pending_cancellation 状态；Console 管理/批量运维与导出；MySQL 低权限模式（`MYSQL_AUTO_MIGRATE=false`）；无直接席位用户的删除修复。 |
| 可靠性 | 四个服务支持优雅停机：停止时先完成进行中的请求（含 SSE 流），超过 `SHUTDOWN_TIMEOUT_MS`（默认 25 秒）才关闭连接，正常退出码为 0。 |
| 新页面 | Console **Models**：用配置的企业管理员账号查看 Copilot 模型目录（可选，见 [Models 使用指南](models-admin-guide.md)）。 |
| 镜像 | 多阶段构建，运行层只含所需服务；Tini 作为 PID 1；不含 npm/Yarn；基础镜像 Node 22（按 digest 固定）。 |
| 之前的修复 | 包含 Claude Opus 5.5 Messages 协议兼容修复（见 [上一版指南](user-pool-messages-output-config-upgrade-guide.md)）。 |

## 2. 必须四个组件一起升级

Proxy、SSO、Login、Console 之间的内部接口在本版本有变化（例如 Login 重试授权会调用 Proxy 的新接口）。经过验证的组合是**四个组件使用同一版本**；不要只升级其中一部分。

| 组件 | 按 digest 引用（linux/amd64） |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:b8decb321701218f499b1701bdba0d0f00d202990a900b291fc4fb126934029d` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:14ca0e14aff339e417761928948ee18f22a98f6dbd01f8aa0898ad7568f88819` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:b04ca796bad4404407fef7d665e8c71e3535decb3f0bfe21cbe45888dc46918d` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:0824d0fd53a6ae0b2619070a1f1a58e42709e49f48290e08a601217b569482c7` |

对应 tag 均为 `single-slug-164cade-amd64-r4`。仓库公开，无需登录即可拉取；建议先同步到客户自己的镜像仓库（例如 ACR）再部署。

源码提交：`164cade`（已合入 main）。部署时请按 **digest** 引用（`image@sha256:...`），不要只用 tag。

## 3. 升级前准备

1. **备份数据**（回滚时需要）：
   - SQLite：停止服务后复制 Proxy、SSO、Login 的数据卷（`/data`）。
   - MySQL：对 Proxy 数据库做一次一致性备份（例如 `mysqldump --single-transaction`）。
2. 记录当前四个镜像的 **digest** 和完整部署配置。
3. 检查配置变化（下一节）。

## 4. 配置变化

| 变量 / 配置 | 服务 | 变化 |
| --- | --- | --- |
| `GITHUB_BASE_URL` | SSO、Login、Proxy | 新增，默认 `https://github.com`。GHE.com 设为 `https://<子域>.ghe.com`，并同时设置 `GITHUB_API_BASE_URL`、`COPILOT_API_BASE_URL`、`SCIM_BASE_URL`（见 `.env.example.data-residency`）。github.com 用户无需修改。 |
| `LOGIN_SSO_PROVIDER` | Login | 移除。SSO 类型改为每个登录任务单独携带，旧变量不再生效。 |
| `SHUTDOWN_TIMEOUT_MS` | 全部 | 新增，默认 `25000`。需小于容器停止宽限期（见第 5 节）。 |
| `MYSQL_AUTO_MIGRATE` | Proxy | 新增，默认 `true`（行为不变）。DBA 预建表结构时可设为 `false`，启动时只读校验，脚本为 `scripts/proxy-mysql-initial.sql`。 |
| `MODELS_ADMIN_*`、`GITHUB_API_BASE_URL` | Proxy | 新增，可选。用于 Console Models 页面。 |
| Kubernetes/Rancher Proxy 的 `command` 覆盖 | Proxy | **请删除** `command: [node, src/proxy/dist/index.js]`。镜像自带的入口会经 Tini 转发停止信号；镜像内仍保留兼容入口，旧覆盖可以启动，但已废弃。 |

## 5. 升级步骤

### Docker Compose

1. 将四个服务的 `image:` 改为上表的 `镜像@digest`。
2. 为每个服务加上 `stop_grace_period: 35s`（Docker 默认只有 10 秒，短于停机排空时间）。
3. 停止旧服务（保留数据卷，**不要**使用 `down -v`），然后 `docker compose up -d`。

### Kubernetes / Rancher

1. 四个工作负载的镜像改为 `镜像@digest`，删除 Proxy 的 `command` 覆盖。
2. `terminationGracePeriodSeconds` 至少为 preStop 等待 + `SHUTDOWN_TIMEOUT_MS` + 5 秒余量；仓库模板为 45 秒（preStop 10 秒 + 25 秒 + 余量）。
3. 多副本 Proxy 按原有滚动策略更新；SSO、Login 保持单实例。

数据库结构在服务启动时自动迁移（SQLite 与 `MYSQL_AUTO_MIGRATE=true` 的 MySQL）。迁移只新增列和表，不删除已有数据。

## 6. 升级后检查（不调用真实模型）

- 四个服务的 `/healthz` 正常，Proxy `/readyz` 正常。
- Console 能登录；账号、用户池、请求统计、登录任务页面数据与升级前一致。
- 在日志中确认没有启动错误；停止一个副本时退出码为 0。

## 7. 回滚

我们在隔离环境验证过：同一份数据（MySQL 双 Proxy + SQLite 的 SSO/Login），从 `ac354ac` 版本升级到 r4，再切回 `ac354ac` 镜像，数据保持一致、服务正常。

回滚步骤：把四个镜像改回升级前记录的 digest。新版本新增的列会保留，旧版本会忽略这些列。如果回滚后有异常，用第 3 节的备份恢复。

## 8. 已知风险

镜像扫描发现基础系统（Debian Bookworm）包的 high 级别告警：Proxy/SSO/Console 各 8 条，Login 10 条，无 critical；Debian 目前均未提供修复，应用依赖（npm）为 0 条。逐条可达性分析见 [发布验证记录](user-pool-image-release-validation.md) 第 0.4 节。Debian 发布修复后，我们会重建并发布新版本。

## 9. 验证范围说明

- 已验证：SQLite 与真实 MySQL 8.4、双 Proxy、升级/回滚、全新库、JSON/SSE 协议、停机退出码、旧启动命令兼容。全部使用合成数据与 mock 外部服务。
- GHE.com：已用 mock 完成全链路验证（真实 SSO + 真实 Login 浏览器授权 + 账号池），但**尚未在真实 GHE.com 环境验收**；首次在 GHE.com 使用时，请先在预发布环境验证，并可设置 `AUTH_DEBUG_ARTIFACT_DIR` 保存登录过程截图以便排查。
- 未验证：真实 GitHub/Copilot 调用、客户环境的网络与性能。请在客户预发布环境用同一 digest 完成验收后再上线。
