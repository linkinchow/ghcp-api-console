# GHCP API Learning

这个项目探索一种把 **GitHub Copilot 后端能力作为“API”提供 LLM 服务** 的方案：对调用方暴露 OpenAI / Anthropic / Responses 兼容接口，对内自动管理 GitHub Enterprise Managed User(EMU)、SSO 登录、OpenCode Copilot OAuth 凭据和后台运维。

> 重要：GitHub Copilot 当前并不提供面向第三方服务端集成的公开裸 API。本项目依赖 Copilot 内部接口，适合学习、验证和自维护部署；用于生产前必须自行评估合规、稳定性和运维风险。

> proxy 参考repo https://github.com/hooyao/copilot-bridge
> 获得 GitHub Copilot Token的部分参考了 OpenCode 项目

> 管理员的通用配置手册：[guidance/guidance.md](./guidance/guidance.md) · 网络配置：[guidance/network-deployment.md](./guidance/network-deployment.md)
>
> 多企业版 Console 的任务式操作手册（带截图）：[docs/admin-manual](./docs/admin-manual/README.md)

## 多企业版：一套部署服务多个 GitHub 企业

多企业版（镜像 tag 以 `multi-` 开头，当前发布 `multi-ea1a29e-amd64-r4`）让**一套部署**——一个 SSO、一个 Login、一个 Console 加 N 个 Proxy 副本——同时管理多个 GitHub 企业。每个企业可以是 github.com 或 GHE.com（data residency），可在同一部署中混用；每个企业有自己的 slug、shortcode、SAML/SCIM、席位 PAT、SSO 登录页和 Models 管理员。

| 要点 | 说明 |
| --- | --- |
| 不配置 registry 时 | 行为与单企业版相同：`default` 企业完全由现有环境变量合成，无需修改任何配置。已有数据在启动时自动迁移，全部归入 `default`。 |
| 添加企业 | 编写 registry JSON（参考 [`deploy/enterprise-registry.example.json`](./deploy/enterprise-registry.example.json)，只写 secret 引用、不写 secret 值），用 `ENTERPRISE_REGISTRY_FILE` 只读挂载到 Proxy、SSO、Login（Compose 叠加 `docker-compose.enterprise-registry.yml`），然后重启这三个服务。不支持热加载。 |
| 生命周期（账号池模式） | 新企业初始为 `draft`，不补货、不分配。在 Console **Pool overview** 的企业表查看三方 readiness（Blockers）、设置 cap 后 **Activate** → `active`；**Drain** → `draining`（不新建租约、不补货，已有租约保留）；**Resume** 恢复为 `active`。直连模式不使用生命周期，新 identity 归属 `DIRECT_MODE_ENTERPRISE_ID`（默认 `default`）。 |
| SAML 地址 | `default` 保持根路径 `/sso`、`/metadata`，已有 GitHub IdP 配置不变；其他企业使用 `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso` 和 `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata`。 |
| 接口 | 公共推理接口（`/v1/*`、`/chat/completions`、`/responses`）不变，调用方不传企业；管理接口改为按企业作用域 `/api/enterprises/<id>/...`，见下文[调用 API](#调用-api)。 |
| Console | 页头 **Enterprise** 选择器决定企业作用域页面显示哪个企业；它不是权限边界，所有 Console 管理员都能管理所有企业。 |
| 镜像 | Docker Hub 公开仓库 `linkinchow/ghcp-{proxy,sso,login,console}:multi-ea1a29e-amd64-r4`（linux/amd64）。四个组件必须同一版本，部署时按[升级指南](./docs/multi-enterprise-upgrade-guide.md)中的 digest 引用。 |
| 验证范围 | GHE.com 企业**只用 mock 验证**（网页、设备授权、SCIM、席位、Copilot 均为 mock），尚未在真实 GHE.com 环境验收；首次接入真实 GHE.com 企业前请先在预发布环境验证。 |

多企业版是独立的发布线；不需要多个企业的客户可以继续使用单企业版（`single-slug-*`）。**全新部署建议直接使用多企业版**：只有一个企业时不需要 registry，以后添加企业也不需要数据库迁移。文档：[新部署指南](./docs/multi-enterprise-new-deployment-guide.md) · [管理员手册（任务式，带截图）](./docs/admin-manual/README.md) · [升级指南（r4 → 多企业版）](./docs/multi-enterprise-upgrade-guide.md) · [registry 配置参考](./docs/multi-enterprise-registry.md) · [设计文档](./docs/multi-enterprise-design.md) · [发布验证记录](./docs/multi-enterprise-release-validation.md)。

## User Pool：多 Proxy＋MySQL

当前版本支持 **MySQL 共享账号池和多个 Proxy 副本**，同时保留 SQLite 单 Proxy 和默认 `direct` 模式。已有 SQLite User Pool 升级时，请从下面的客户指南开始，不要直接照后文的新环境快速启动命令操作原数据。

### 客户部署与迁移入口

| 要做的事情 | 文档或配置 |
| --- | --- |
| **已有单 Proxy／SQLite User Pool 升级到多 Proxy／MySQL** | **[客户升级指南](./docs/user-pool-mysql-upgrade-guide.md)**：数据库迁移、四组件升级、Service切换、验证与回退 |
| 多企业版全新部署到 Kubernetes | **[Kustomize 清单（四个服务 + 外部 MySQL）](./deploy/kubernetes/README.md)**：github.com / GHE.com overlay，可选 Ingress、DBA 预建表、NetworkPolicy |
| Kubernetes 部署配置 | **[K8s YAML模板](./deploy/user-pool-mysql-customer/kubernetes.template.yaml)**：先启动1个Proxy验证，再扩为3个或所需数量 |
| 数据库迁移参数与兼容处理 | [User Pool 专用迁移工具](./upgrade/user-pool-mysql/README.md) |
| 自行构建四组件镜像 | [固定源码构建与部署包](./deploy/user-pool-mysql-customer/README.md) |
| 日常监控、诊断与恢复 | [运维基础](./docs/user-pool-ops-basics.md) · [本机调度诊断](./docs/user-pool-local-diagnostics.md) |
| LiteLLM caller身份与页面操作 | [LiteLLM Hash Hook](./docs/user-pool-litellm.md) · [User pool页面说明](./docs/user-pool-console-guide.md) |

客户从固定源码提交自行构建镜像，按现有K8s镜像分发流程部署。YAML是需要填写实际值的模板，**不包含MySQL部署，也不重建原SSO/Login/Console或其数据卷**。客户准备专用空MySQL数据库、账号权限和TLS，迁移工具负责创建应用表并导入数据。不要在迁移前启动目标Proxy写入该库。

### 多副本运行方式

```text
LiteLLM → 现有 Kubernetes Proxy Service → Proxy 1 / Proxy 2 / Proxy 3
                                                 │
                                                 └→ 同一个 MySQL 写主库／数据库
SSO / Login / Console → 同一个 Proxy Service
```

- **Proxy**：`STORAGE_DRIVER=mysql`、`ACCOUNT_ROUTING_MODE=caller-lease`，各副本使用相同池配置和同一MySQL数据库。K8s通过Secret注入`MYSQL_URL`，不将真实连接串写入公开YAML。
- **SSO、Login、Console**：配套升级但各保持1个实例。SSO/Login保留原SQLite及数据卷，Console保留管理员文件和原卷；SAML地址、签名证书及现有凭据不因迁移而重建。
- **业务与后台调度分开**：健康Proxy均可处理请求，只有一个调度owner负责补池和修复。MySQL模式的standby副本仍可服务；数据库故障仍可能返回安全503。
- **账号排他使用**：已认证LiteLLM virtual-key hash映射到成员租约，完整成功推理才续租。模型列表、失败或取消不会续租；恢复补池可能创建新成员，必须符合批准的账号和席位预算。
- **先迁移、后扩容**：暂停并排空、备份、导入空MySQL、先验证1个新Proxy，再扩容和切换原Service；旧SQLite与新MySQL不得同时承接业务。只改`STORAGE_DRIVER`不会自动搬迁数据。

### 按现有部署选择升级路径

| 当前部署与升级目标 | 对应指南或工具 |
| --- | --- |
| 没有现有部署，全新安装（单个或多个企业） | [多企业版新部署指南](./docs/multi-enterprise-new-deployment-guide.md)：使用 `multi-ea1a29e-amd64-r4`，从一个企业（`default`）开始，以后按 registry 添加企业 |
| 单企业部署，升级到单企业版 r4（`single-slug-164cade-amd64-r4`） | [单企业版 r4 升级指南](./docs/user-pool-release-upgrade-guide.md)；SQLite 与 MySQL 均适用 |
| 单企业版 r4（SQLite 或 MySQL），升级到多企业版（`multi-ea1a29e-amd64-r4`） | [多企业版升级指南](./docs/multi-enterprise-upgrade-guide.md)：只支持从 r4 升级；四个组件一次性替换，首次升级需短暂停机；回滚只能恢复备份。升级完成并稳定后，再按 [registry 配置参考](./docs/multi-enterprise-registry.md) 添加企业 |
| 已使用 SQLite User Pool（`caller-lease`），升级到 MySQL 多副本 | [SQLite User Pool → MySQL 多副本升级指南](./docs/user-pool-mysql-upgrade-guide.md)，保留现有池成员和有效凭据，不重新开户 |
| 使用普通 `direct` 模式，仅将账号数据库从 SQLite 迁到 MySQL | [direct 模式数据库迁移工具](./upgrade/sqlite-to-mysql/README.md)，不用于迁移 User Pool 表 |
| 尚未启用 User Pool，希望在单 Proxy／SQLite 部署中启用账号池 | [单副本 User Pool 启用与升级指南](./docs/user-pool-upgrade-guide.md)；原 direct 账号不会自动成为池成员 |

`ACCOUNT_ROUTING_MODE`默认仍为`direct`。启用`caller-lease`后，入口要求`X-User-Identity: sha256:<key hash>`，不能继续使用用户名／邮箱header。旧版[SQLite设计](./docs/user-pool-design.md)、[SQLite实现](./docs/user-pool-implementation.md)和[发布检查](./docs/user-pool-release-checklist.md)保留为历史参考，不作为本分支MySQL部署入口。

开发与验收参考：[MySQL设计](./docs/user-pool-mysql-design.md) · [MySQL实施细节](./docs/user-pool-mysql-implementation.md) · [详细迁移与验证记录](./docs/user-pool-customer-migration-guide.md) · [真实迁移报告](./docs/user-pool-real-mysql-migration-validation.md) · [多热点与长流式验证](./docs/user-pool-final-load-validation.md)。这些记录不替代客户自己的备份恢复、Service路由或MySQL HA验收。

## 背景

开源社区已经有不少项目可以把 Copilot 包装成 API 来用，例如 LiteLLM、ccswitch、copilot2api 等。这些方案通常适合**单个开发者本地使用**：本地代理读取一个 GitHub/Copilot 登录态，再把请求转发到 Copilot 后端。

当要集中给大量最终用户提供 GHCP API 服务时，单人本地代理模式会遇到几个问题：

1. **账号合规问题**：合规使用 GHCP 不应共享账号，理想状态是一个 GitHub 账号对应一个最终用户。
2. **账号规模问题**：最终用户量大时，需要批量获得对应数量的 GitHub 账号，并能持续管理这些账号。
3. **自动登录问题**：即使账号已经创建，GitHub 账号的 MFA/device flow 会阻碍无人值守、批量化登录。

## 本项目思路

本项目通过 **GitHub Enterprise Managed User + 自定义 SSO + 自动化登录 + API Proxy** 组合解决上述问题：

- 使用自定义 SSO/SAML IdP 结合 GitHub EMU，通过 SCIM 批量创建和同步 GitHub 账号，避免手工注册大量普通 GitHub 账号。
- 使用 OpenCode OAuth client 发起 GitHub Device Flow，并由 Playwright 自动完成 GitHub/SSO 登录。
- 通过 Proxy 统一维护 `identity -> ssoUser -> ghLogin -> token` 映射，并对外提供兼容 API。
- 支持验证后批量导入 OpenCode Copilot OAuth token，也支持后台控制台查看账号、请求统计、上游错误诊断、登录任务、AI Credits 和 Copilot seat 状态。
- 在 Proxy 层包含 Claude Code / Anthropic Messages 相关兼容优化。

整体调用链（默认direct模式；caller-lease模式改由预热成员和排他租约路由）：

```text
Client
  -> proxy compatible API
  -> proxy 按 X-User-Identity 找账号
  -> 首次使用时 proxy 调 sso 确保用户并同步 EMU
  -> proxy 调 login 创建自动登录任务
  -> login 完成 GitHub device flow + SSO 登录
  -> login 把 Copilot OAuth token 回写 proxy
  -> proxy 直接以 Bearer token 调用 Copilot API
```

`sso` 和 `login` 没有直接服务间调度关系；它们都由 `proxy` 或 `console` 通过内部 API 协调。

## 模块概览

| 模块 | 职责 |
| --- | --- |
| `src/proxy` | 对外 API 网关；鉴权、identity 映射、Copilot OAuth 管理、请求转发和统计；多企业版中还负责企业列表、跨服务 readiness 和账号池的企业生命周期。 |
| `src/sso` | 自定义 SAML IdP；SSO 用户、EMU/SCIM、Copilot seat、AI Credits 用量；多企业版中每个企业有独立的 SAML 地址、证书和会话 cookie。 |
| `src/login` | OpenCode OAuth Device Flow + Playwright 自动登录；成功后回写 Copilot OAuth token。 |
| `src/console` | Web 管理控制台；统一操作 proxy/sso/login 管理 API。 |
| `src/packages/shared` | 跨服务共享 DTO、HTTP client、logger、错误结构和工具。 |

更详细的代码结构和接口说明见 [`src/README.md`](./src/README.md)。

## 使用前提

部署前需要准备：

1. **GitHub Enterprise 订阅**，并启用 Enterprise Managed Users(EMU)。支持 GitHub.com 和 GHE.com（GitHub Enterprise Cloud with data residency）。
2. **GitHub Copilot 可用授权**，并准备可管理 Copilot seat / AI Credits 的 GitHub PAT。
3. **GitHub Enterprise SAML SSO 配置权限**，可以把企业 SAML SSO 指向本项目的 `sso` 服务或你自己的 SSO/IdP。
4. **GitHub SCIM token**，用于 `sso` 服务批量创建、更新、暂停、删除 EMU 用户。
5. **SAML IdP 签名证书和私钥**。本项目提供 `scripts/gen-certs.sh` 生成开发证书；生产环境应使用你维护的证书。
6. **Docker / Docker Compose** 用于容器化部署；本地开发还需要 Node.js 22 和 npm。

多企业版中，每个新增企业都需要各自准备第 1–5 项：GitHub 侧 SAML 配置、SCIM token、席位 PAT，以及独立的签名证书、私钥和 session secret。

## 配置模型：`.env` 与 Settings

配置按以下来源管理，已有运行时设置与启动参数的生效方式不同：

| 配置来源 | 保存位置 | 适合内容 | 生效方式 |
| --- | --- | --- | --- |
| 环境变量 / `.env` / K8s Secret与ConfigMap | 进程环境 | 端口、服务地址、密钥、数据库/日志/证书路径、认证 header、浏览器静态选项 | 启动时读取；更新后需重新创建容器或滚动更新Pod，单纯restart不会更新容器环境。 |
| Console **Settings**（SSO/Login） | `sso.sqlite` 或 `login.sqlite` | 管理员需要在线调整的限额、并发、超时、重试和调试开关；SSO 设置按企业保存，Login 设置全局 | 保存后持久化并在当前服务实例立即应用，无需重启。 |
| Console **Pool overview** | Proxy的SQLite或共享MySQL `user_pool_settings`、`proxy_enterprises` | 全局 idle target、正式租约TTL、暂停补池；企业表中各企业的 cap 和生命周期 | 通过版本化管理API保存，所有MySQL Proxy共享；已有设置不会被启动env覆盖。 |
| 企业 registry（可选） | `ENTERPRISE_REGISTRY_FILE` 指向的只读 JSON | 第二个及以后企业的 GitHub/SSO/Login/池/Models 配置和 secret 引用 | Proxy、SSO、Login 启动时读取一次；修改后需重启这三个服务。 |

根目录 `.env` 只用于 Docker Compose 的变量插值；只有 `docker-compose.yml` 的 `environment`、`ports`、`volumes` 中明确引用的变量才会传入容器。`src/<service>/.env` 面向单独运行该 workspace 的场景。显式注入的进程环境变量优先于 `.env`，两者都没有时才使用代码默认值。

敏感值和部署拓扑使用受保护的环境变量或K8s Secret，不放管理页面Settings，例如`API_KEY`、`INTERNAL_API_TOKEN`、`SESSION_SECRET`、GitHub/SCIM token、数据库连接串和服务URL。SSO/Login运行时Settings首次初始化使用代码默认值，不从旧环境变量自动导入。User Pool的target/正式TTL仅首次由env提供种子，各企业cap只在Proxy首次登记该企业时取初值（`default`取`POOL_MAX_ACCOUNTS`，其他企业取registry的`pool.initialMaxAccounts`，默认10；从单企业版升级时`default`沿用升级前的cap），之后以数据库为准；MySQL还保存域名、模型、预热并发等不变量的配置指纹，所有Proxy与迁移进程必须一致，不能只改某一副本的env或手工改hash绕过检查。

SSO runtime settings：

| Setting | 默认值 | 合法范围 | 作用 |
| --- | ---: | --- | --- |
| `maxSsoUsers` | `null` | `null` 或 `1..1000000` | SSO 用户总量上限；`null` 表示不限。 |
| `userPrefix` | `user` | 规范化后必须包含字母或数字，最长 32 字符 | identity 无法生成用户名或发生最终 fallback 时使用。 |
| `emailDomain` | `customsso.com` | 合法域名 | 新用户未显式提供 email 时使用 `<ssoUser>@<domain>`。 |
| `bulkSyncConcurrency` | `3` | `1..20` | `sync_emu` 批处理并发；其他破坏性批处理仍串行。 |
| `scimRequestDelayMs` | `250` | `0..60000` | 同一 SSO 进程内 SCIM 请求之间的最小间隔。 |
| `scimMaxRetries` | `3` | `0..10` | SCIM 可重试响应/网络错误的最大重试次数。 |
| `scimRetryBaseDelayMs` | `1000` | `0..60000` | SCIM 指数退避基础延迟；`Retry-After` 可覆盖等待时间。 |

Login runtime settings：

| Setting | 默认值 | 合法范围 | 作用 |
| --- | ---: | --- | --- |
| `concurrency` | `1` | `1..20` | 当前 Login 进程同时运行的任务数；调高后立即排队，调低不会中断已运行任务。 |
| `authTimeoutMs` | `60000` | `5000..600000` | 新启动 Device Flow/Playwright 任务的认证超时。 |
| `authDebugLogs` | `false` | boolean | 为新启动任务写入详细账号日志。 |
| `authDebugArtifacts` | `false` | boolean | 为新启动任务保存截图和 trace 等调试产物。 |

`REQUEST_STATS_PER_ACCOUNT_LIMIT` 和 `PROXY_ERROR_DIAGNOSTICS_*` 仍是 Proxy 环境变量，不属于 runtime Settings；前者控制每个 identity 保留的请求统计条数，后者控制上游失败现场的启用、目录、脱敏和文件轮转。Login task 历史目前没有自动保留条数/天数配置，终态任务会一直保留，直到通过 Console 或 API 手动删除。

## 快速启动（Docker Compose，新环境默认direct）

下面是通用新环境启动流程，不是已有账号池的迁移步骤。已有SQLite User Pool升级到MySQL/K8s，请使用[客户升级指南](./docs/user-pool-mysql-upgrade-guide.md)，保留原卷和签名证书，不重新生成或覆盖。

1. 复制并修改环境变量：

```bash
cp .env.example .env
# GHE.com（data residency）使用：cp .env.example.data-residency .env
```

至少需要替换（GitHub、SAML、SCIM、席位相关变量定义的是 `default` 企业；多企业版中其他企业在 registry 中配置，见 [registry 配置参考](./docs/multi-enterprise-registry.md)）：

| 变量 | 说明 |
| --- | --- |
| `API_KEY` | 调用 `proxy` 裸 API 时使用的 Bearer token。 |
| `INTERNAL_API_TOKEN` | `proxy`、`sso`、`login`、`console` 内部通信共享密钥。 |
| `SESSION_SECRET` | `console` cookie session 和 `sso` 中 `default` 企业 SAML 会话 cookie 的签名密钥；其他企业使用 registry 中各自的 `sso.sessionSecret`。 |
| `SSO_PUBLIC_BASE_URL` | `sso` 服务对 GitHub 可访问的公网地址。 |
| `SP_ENTITY_ID` / `SP_ACS_URL` | GitHub Enterprise SAML SP 配置。 |
| `GITHUB_BASE_URL` | GitHub Web 地址，默认 `https://github.com`；GHE.com 填 `https://<subdomain>.ghe.com`。Login、SSO、Proxy 都据此判断是否为 GHE.com 模式。 |
| `ENTERPRISE_SLUG` / `ENTERPRISE_SHORTCODE` | GitHub Enterprise 标识和 GitHub.com EMU login 后缀（GH login = `<ssoUser>_<shortcode>`）。GHE.com 模式下忽略 `ENTERPRISE_SHORTCODE`：shortcode 被隐藏，且 GHE.com API 拒绝带后缀的用户名，因此 GH login 直接为 `<ssoUser>`（最长 30 字符）。 |
| `SCIM_BASE_URL` / `SCIM_TOKEN` | GitHub Enterprise SCIM API 地址和 token。 |
| `GITHUB_COPILOT_SEAT_PAT` | 管理 Copilot seat / AI Credits 的 GitHub PAT。 |
| `SSO_DEFAULT_USER_PASSWORD` | 新建SSO用户默认密码。direct旧行为为空时使用用户名；**poolManaged新成员强制要求至少16字符且不等于用户名，禁止空值回退**。不改变已有用户密码哈希。 |

根目录 `.env` 也包含 proxy 的公共 API 和 OpenCode 认证/header 配置。Docker Compose 默认使用 `CLAUDE_CODE_OPTIMIZED=true` 启动 proxy，作为 Claude Code / Anthropic Messages 兼容优化和 `/v1/messages/count_tokens` 的默认模式；单个请求可用 `X-Claude-Code-Optimized: true|false` 覆盖，无需重启服务。

| 变量 | 说明 |
| --- | --- |
| `STORAGE_DRIVER` | Proxy 存储模式：默认 `sqlite`，多 Proxy Pod 使用 `mysql`。 |
| `DB_PATH` | `sqlite` 模式的数据库路径；该模式只支持一个 Proxy 实例。 |
| `MYSQL_URL` | `mysql` 模式必填，指向所有 Proxy Pod 共享的外部 MySQL 8 数据库。 |
| `MYSQL_CONNECTION_LIMIT` / `MYSQL_SSL_*` | 每个 Proxy Pod 的连接池上限与 MySQL TLS 配置。 |
| `MYSQL_AUTO_MIGRATE` | 默认 `true`，Proxy 启动时自动迁移 MySQL；`false` 时只读校验 schema，由 DBA 执行 `scripts/proxy-mysql-initial.sql`（空库）或 `scripts/proxy-mysql-enterprise-upgrade.sql`（r4 → 多企业版）。 |
| `MYSQL_MIGRATION_LOCK_WAIT_SECONDS` | 多企业版新增，默认 `30`（1–3600）。其他 Proxy 副本等待迁移锁的秒数；首次升级且请求统计表很大时调高。 |
| `ENTERPRISE_REGISTRY_FILE` | 多企业版新增，可选。registry 文件的容器内绝对路径，只读挂载到 Proxy、SSO、Login；Compose 用 `docker-compose.enterprise-registry.yml`，宿主机路径由 `ENTERPRISE_REGISTRY_HOST_FILE`、`ENTERPRISE_SECRETS_DIR` 指定。未设置时只有 `default` 企业。registry 中写了 `default` 时，对应环境变量必须留空或与文件一致，否则启动报 `enterprise_env_conflict`。 |
| `DIRECT_MODE_ENTERPRISE_ID` | 多企业版新增，仅直连模式。新 identity 归属的企业，留空为 `default`；必须是 registry 中的企业，否则 Proxy 启动失败。 |
| `CONSOLE_PUBLIC_BASE_URL` | 多企业版新增，可选。Console 前有会改写 Host 头的反向代理时，设为用户访问的 Console 地址；Console 写操作只接受来自该地址或请求 Host 的同源请求。 |
| `IDENTITY_HEADER` | 调用方身份 header 名称和是否必填；默认 `X-User-Identity` 必填。 |
| `IDENTITY_HEADER_REQUIRED` | 调用方身份 header 是否必填；默认 `true`。如果设置为 false，则 Identity header 可选。identity header 为空时，默认使用匿名身份。当前匿名用户为 `default` |
| `CLAUDE_CODE_OPTIMIZED` | Proxy 的默认 Claude Code 优化模式；代码默认 `false`，Compose 默认和根模板均为 `true`。 |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | 每个 identity 保留的请求统计数；代码、Compose fallback 和环境变量示例均默认为 `2`。 |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED` | 是否保存 Copilot 上游失败现场；默认 `true`。 |
| `PROXY_ERROR_DIAGNOSTICS_DIR` | 人类可读诊断日志目录；Compose 默认 `/data/error-diagnostics`，位于 `proxy-data` volume。 |
| `PROXY_ERROR_DIAGNOSTICS_REDACT` | 是否脱敏诊断中的敏感 headers 和 JSON 字段；默认 `false`，即保留原始凭据和请求内容。 |
| `PROXY_ERROR_DIAGNOSTICS_MAX_FILE_MB` / `PROXY_ERROR_DIAGNOSTICS_MAX_FILES` | 轮转上限；默认每文件 `50 MB`、保留 `5` 个文件。 |
| `PROXY_ERROR_DIAGNOSTICS_SHARED` / `PROXY_INSTANCE_ID` | 多 Proxy Pod 使用 RWX 诊断卷时启用；每个 Pod 使用独立实例目录，管理接口聚合读取。 |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_SCOPE` | Login 使用的 OpenCode OAuth client 和 Device Flow scope。 |
| `OPENCODE_VERSION` / `OPENCODE_USER_AGENT` | Login 与 Proxy 请求使用的 OpenCode User-Agent；显式 User-Agent 优先。 |
| `COPILOT_API_BASE_URL` | `default` 企业的 Copilot API 地址；GitHub.com 默认 `https://api.githubcopilot.com`，GHE.com 为 `https://copilot-api.<subdomain>.ghe.com`。多企业版在 GHE.com 下未设置时按 `GITHUB_BASE_URL` 自动推导；显式设置时必须属于同一个 `<subdomain>.ghe.com`，否则启动失败。 |
| `GITHUB_API_BASE_URL` | `default` 企业的 GitHub REST API 根地址（SSO 的 Copilot seat、AI Credits；Proxy 的 Models 和 Login 回传 token 的 `/user` 身份核对），默认 `https://api.github.com`；GHE.com 为 `https://api.<subdomain>.ghe.com`（`SCIM_BASE_URL` 同理），未设置时同样自动推导。 |
| `GITHUB_API_VERSION` | Copilot 请求的 `X-GitHub-Api-Version`，默认 `2026-06-01`。 |
| `LOGIN_SSO_URL` | `default` 企业的 SSO 登录 URL（Login 的 `SSO_URL`）；其他企业默认 `<该 URL 的 origin>/enterprises/<id>/login`。多企业版中任务请求不能再覆盖登录地址或 selector。Provider 由任务的 `ssoType` 或企业 registry 的 `login.ssoProvider` 决定，不通过环境变量配置。 |
| `AUTH_HEADLESS` | Login Playwright 是否无头运行，默认 `true`。 |
| `LOG_LEVEL` | 所有服务的结构化日志等级：`debug`、`info`、`warn`、`error`。 |
| `PROXY_PORT` / `SSO_PORT` / `LOGIN_PORT` / `CONSOLE_PORT` | Compose 暴露到宿主机的端口，不会改变容器内服务端口。 |

**GHE.com（data residency）**：复制 `.env.example.data-residency`，把 `sample-ent` 换成实际的子域名和 enterprise slug；无需配置 `ENTERPRISE_SHORTCODE`。GHE.com 上 Login 不输入 GitHub 用户名：它根据 `GITHUB_BASE_URL` 和 `ENTERPRISE_SLUG` 直接打开 `https://<subdomain>.ghe.com/enterprises/<slug>/sso`，点击 Continue，在 SSO 登录页输入 SSO 用户名和密码；回到 GHE 后再完成 Device Flow 填码和授权。GHE.com 的 shortcode 随机生成并隐藏，REST API 也拒绝带后缀的用户名，所以 SSO 和 Proxy 在 GHE.com 模式下忽略 `ENTERPRISE_SHORTCODE`，GH login 直接使用 `<ssoUser>`（GitHub 限制为 30 字符），Copilot 坐席分配和查询都使用这个值。其余只需把 SCIM、GitHub API、SAML 和 Copilot API 地址换成 GHE.com 地址。若之前已用带后缀的 GH login 同步过用户，需在 Console 对这些用户重新执行 Sync to GH，再分配坐席。多企业版中，也可以在 registry 里把 GHE.com 企业作为额外企业加入（`github.shortcode` 留空或省略），与 github.com 的 `default` 共用一套部署；多企业版的 GHE.com 支持目前只经过 mock 验证。

各服务完整环境变量表见 [`src/proxy/README.md`](./src/proxy/README.md)、[`src/sso/README.md`](./src/sso/README.md)、[`src/login/README.md`](./src/login/README.md) 和 [`src/console/README.md`](./src/console/README.md)。升级后请在 Console **Settings** 页面确认 SSO/Login 的持久化设置值。

> **升级提示**：如果旧 `proxy.sqlite` 仍为 `gh_token` / 短期 `copilot_token`结构，首次启动会保留identity/SSO/GH关联，但清除旧凭据并要求重新授权；若已具备当前OAuth三列，则保留已有OAuth token而不重建账号表。迁移后启动还会按 `REQUEST_STATS_PER_ACCOUNT_LIMIT` 裁剪统计（默认2），因此必须先备份、核对schema和保留量，并在副本演练。详见[存量升级手册](./docs/user-pool-upgrade-guide.md)。

SQLite → MySQL必须按源模式选择迁移工具：**已有User Pool（`caller-lease`）用 [`upgrade/user-pool-mysql`](./upgrade/user-pool-mysql/README.md)**；普通direct账号数据用 [`upgrade/sqlite-to-mysql`](./upgrade/sqlite-to-mysql/README.md)。两者不能互换。客户先创建专用空数据库和账号权限，迁移工具负责创建应用表并导入；Proxy启动不会自动跨数据库搬迁数据。

2. 准备 SAML 证书：

```bash
bash scripts/gen-certs.sh
```

默认会生成到 `./certs`。如果使用自己的证书，请把 `idp-cert.pem` 和 `idp-key.pem` 放到 `.env` 中 `SSO_CERT_DIR` 指向的目录。

3. 启动服务：

```bash
npm run compose:up
```

4. 检查健康状态：

```bash
npm run validate:health
```

5. 打开控制台：

```text
http://localhost:7004
```

### 可选：本地 MySQL 8

生产部署的 `docker-compose.yml` 只接收外部 `MYSQL_URL`，不会强制创建 MySQL。需要本地验证时，可用独立 Compose 文件启动测试数据库：

```bash
npm run mysql:test:up
```

在宿主机运行 Proxy 或集成测试时使用：

```bash
MYSQL_TEST_URL='mysql://ghcp_proxy:ghcp_proxy_local@127.0.0.1:3306/ghcp_proxy' npm run test:mysql
```

其中 `MYSQL_TEST_URL` 是仅对本次命令生效的环境变量，`npm run test:mysql` 会读取它来连接测试数据库。连接串采用常见的 MySQL URI 格式：

```text
mysql://<用户名>:<密码>@<主机>:<端口>/<数据库名>
```

本例中，`mysql://` 是固定的协议前缀；`ghcp_proxy` 是用户名；`ghcp_proxy_local` 是密码；`127.0.0.1` 表示宿主机本机；`3306` 是 MySQL 默认端口；最后的 `ghcp_proxy` 是数据库名。格式固定，但这些字段需按实际配置修改；用户名或密码含特殊字符时需要进行 URL 编码。

需要让完整 Compose 栈连接这个 MySQL 时，在 `.env` 设置：

```dotenv
STORAGE_DRIVER=mysql
MYSQL_URL=mysql://ghcp_proxy:ghcp_proxy_local@mysql:3306/ghcp_proxy
```

然后同时加载两个 Compose 文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.mysql.yml up -d --build --wait
```

多 Pod/Kubernetes 部署必须使用 `mysql`，并让每个 Proxy Pod 使用同一 `MYSQL_URL`。错误诊断如需在 Console 中全局可见，应给所有 Proxy Pod 挂载同一个 RWX PVC，设置 `PROXY_ERROR_DIAGNOSTICS_SHARED=true`，并通过 Downward API 把 Pod 名注入 `PROXY_INSTANCE_ID`。本次横向扩展仅覆盖 Proxy；仍使用 SQLite/文件状态的 SSO、Login 和 Console 必须保持单副本。

首次访问会创建本地控制台管理员。之后可以在控制台管理 SSO 用户、EMU 同步、Proxy 账号、登录任务、Copilot OAuth 重授权/导入、请求统计和 Error Diagnostics；管理员可在 **Settings** 修改自己的 Console 密码。多企业版在页头用 **Enterprise** 选择器切换企业，选择保存在 URL hash（`#/<page>?e=<id>`）中。

> **SSO 改密与自动登录**：SSO 只保存密码哈希，不能把修改后的任意密码提供给 Login。若新密码不是当前 `SSO_DEFAULT_USER_PASSWORD` 或该用户的 `ssoUser`，后续自动初始化无法取得密码；请在 Console 的 **Reauthorize Copilot OAuth** 中手动输入新密码。Login 仅使用该次请求提供的密码执行任务，不会把密码保存到任务历史。

## 调用 API

以下`alice`等用户名示例用于默认 **direct** 模式；`caller-lease`模式应经已配置的LiteLLM Hash Hook调用，由已认证virtual key派生`sha256:<hash>`，不能原样使用下面的用户名header。详见[LiteLLM接入说明](./docs/user-pool-litellm.md)。

设置API_KEY环境变量
```
export API_KEY=change-me-proxy-api-key
```

`proxy` 默认监听 `3000`，公共接口需要：

```http
Authorization: Bearer <API_KEY>
X-User-Identity: <your-user-identity>
Content-Type: application/json
X-Claude-Code-Optimized: true|false  # 可选；覆盖 CLAUDE_CODE_OPTIMIZED 默认值
```

示例：

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Claude-Code-Optimized: false" \
  -H "X-Cache: false" \
  -H "X-User-Identity: alice"
```

首次请求某个 identity 时，如果账号和 token 还没准备好，`proxy` 可能返回 `202 account_initializing`。等待后台 SSO/EMU 同步和登录任务完成后再重试。

多企业版的公共接口与单企业版完全相同，请求中不带企业：direct 模式下已有 identity 按其账号所属企业路由，新 identity 归属 `DIRECT_MODE_ENTERPRISE_ID`（默认 `default`）；caller-lease 模式下由账号池按各企业 cap 比例分配成员，租约绑定的成员属于哪个企业，就使用该企业的 Copilot API 地址。落在 `draining` 企业、且只有模型列表占位（catalog hold）的调用方会收到 `503 enterprise_draining`，不会被换到其他企业。

成功启动且 identity 对应账号可用后，可以调用 Anthropic Messages 系列接口：

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍 GitHub Copilot。"
      }
    ]
  }'
```

```bash
curl http://localhost:3000/v1/messages/count_tokens \
  -H "x-api-key: $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [
      {
        "role": "user",
        "content": "统计这句话的输入 token。"
      }
    ]
  }'
```

也可以调用 OpenAI Responses 形状接口：

```bash
curl http://localhost:3000/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-User-Identity: alice" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5-mini",
    "input": "用一句话说明 GitHub Copilot 的用途。"
  }'
```

`model` 必须来自 `GET /v1/models`。Proxy 以当前账号的 Copilot `/models` 为实时权威目录：Claude 模型对外使用 Anthropic 标准连字符 ID（例如上游 `claude-opus-4.8` 对外为 `claude-opus-4-8`），其他模型 ID 原样保留。三个 POST 入口同时接受标准 ID 和旧点号 ID，并在发给 Copilot 前统一解析为上游真实 ID；因此该兼容不依赖 `X-Claude-Code-Optimized`。未来 Copilot 若返回 `claude-opus-5.1`、`5.2` 等型号，会由实时目录动态生成 `claude-opus-5-1`、`5-2`，无需维护静态型号表。默认 `CLAUDE_CODE_OPTIMIZED=true` 时，`GET /v1/models` 面向 Claude Code 只返回支持 `/v1/messages` 的模型；如需完整 Copilot/OpenAI 风格模型列表，传 `X-Claude-Code-Optimized: false`。`/responses` 示例中的 `gpt-5-mini` 需要替换为账号可用且支持 `/responses` 的 Copilot 模型。如果你在 `.env` 里改了 `IDENTITY_HEADER`，示例里的 `X-User-Identity` 也要同步替换。

Claude Code 可以通过 settings 文件接入本地 proxy，例如 `~/.claude/settings.json` ：

```json
{
  "env": {
    "ANTHROPIC_MODEL": "claude-opus-5[1m]",
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "<your_proxy_api_key>",
    "ANTHROPIC_CUSTOM_HEADERS": "X-User-Identity: <your_identity_string>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5"
  },
  "theme": "dark",
  "model": "claude-opus-5"
}
```
**注意：** Copilot API的Claude系列模型默认是包含1M的上下文窗口的。但在Claude Code侧默认是使用200K上下文窗口，这个是CC在客户端默认的配置。如果需要更多的上下文窗口，需要在CC配置文件的模型名称后面增加`[1m]`的后缀，如上面的示例中的模型名称。

如果使用项目内 `.claude/settings.local.json`，不要提交包含 `ANTHROPIC_AUTH_TOKEN` 的文件。

### 管理接口（内部）

Console 已全部改用新路径，通常不需要直接调用。自建脚本直接调用 Proxy、SSO、Login 的 `/api/*`、`/internal/*` 时，使用 `X-Internal-Token: <INTERNAL_API_TOKEN>`，并按多企业版的路径调用：

```bash
# 企业列表（含 readiness 与池状态），全局接口
curl http://localhost:3000/api/enterprises -H "X-Internal-Token: $INTERNAL_API_TOKEN"

# 企业作用域接口：/api/enterprises/<id>/...，单企业部署使用 default
curl "http://localhost:3000/api/enterprises/default/accounts?page=1&pageSize=25" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN"
curl "http://localhost:7001/api/enterprises/default/users?page=1&pageSize=25" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN"
curl "http://localhost:7003/api/enterprises/default/tasks?limit=20" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN"
```

| 路径 | 行为 |
| --- | --- |
| `/api/enterprises/<id>/...`（三个服务） | 企业作用域的账号、请求统计、池成员、Models、SSO 用户、AI Credits、SSO 设置、登录任务等。未知企业返回 `404 enterprise_not_found`。 |
| Proxy 全局接口 | `GET /api/enterprises`、`PATCH /api/enterprises/<id>/pool-policy`、`/api/user-pool/overview`、`/api/user-pool/settings`、`/api/user-pool/diagnostics/local`、`/api/user-pool/reconcile`、`/api/error-diagnostics*`。`PATCH /api/user-pool/settings` 再传 `max_accounts` 返回 `409 use_enterprise_cap`（cap 改为按企业设置）。 |
| Login 全局接口 | `/api/settings/runtime`（Login 设置是进程级）。 |
| Proxy 旧 `/api/accounts*` | 保留一个版本，响应带 `Deprecation: true`；列表使用 `DIRECT_MODE_ENTERPRISE_ID` 企业，单个账号按全局 identity 查找。请改用 `/api/enterprises/<id>/accounts*`。 |
| 其他无作用域的 `/api/*`、`/internal/*` | 返回 `400 enterprise_scope_required`，不会回落到 `default`（例如旧的 `/api/request-stats`、`/api/user-pool/accounts`、SSO 的 `/api/users`、Login 的 `/api/tasks`）。 |
| 公共推理接口 | 不变，见上文。 |

## 本地开发

```bash
npm install
npm run build:deploy
npm run typecheck:deploy
```

单独启动服务：

```bash
npm run start:sso
npm run start:login
npm run start:proxy
npm --workspace @ghcp/console run build
npm run start:console
```

## 必须知道的限制

- Copilot 后端不是正式公开的裸 API，一些模型能力、参数、流式格式或模型可见性可能与 OpenAI/Anthropic 官方 API 不完全一致。
- Copilot 内部 API 可能被 GitHub 产品组调整，生产使用可能受到兼容性影响。
- 本项目是开源自维护方案，不提供托管 SLA；部署、密钥、账号、合规、日志和安全策略需要使用方自行负责。
- 账号和 token 涉及敏感权限，不能提交 `.env`、SQLite 数据库、日志、Playwright trace、Copilot OAuth token 或 SSO 密码。
- 错误诊断默认不脱敏，会保存原始入站请求、实际 Copilot 请求、Authorization/API Key、用户 prompt、工具内容和上游响应；必须像 token 数据库一样限制 `proxy-data` 和 Console 管理员访问。
- EMU、SAML、SCIM、Copilot seat 配置依赖 GitHub Enterprise 管理权限；没有这些前提无法完整跑通批量账号和自动登录流程。


## 已知问题
- GH EMU模式下，删除GH Login有两种模式，其中一种是软删除，即，使用 PATCH 方式更新 GH Login 的状态值，执行完后，GH Login对应的唯一内部ID依然存在，并且关联的copilot坐席也都依然存在，只是copilot坐席会被标记为下个月失效。在软删除的GH Login被恢复时，关联的Copilot坐席也随之恢复，但是短时间（大约30分钟？）内在GH页面上无法看到该用户被分配了坐席，而只能通过API获得坐席的正确状态。同时也无法通过GH管理门户或者API再次授权Copilot坐席，在通过API分配时会遭遇422错误，错误信息如下。等待一段时间后，门户和API的Copilot坐席授权会恢复正常。此外，在软删除恢复时，该 GH Login 的Copilot坐席依然会被自动标记成下个月失效，如果需要恢复坐席需要再次授权。
  ```text
  username: Assign seat - GitHub Copilot seat assign failed for "username_shortcode": 422 {"message":"Seat assignment for user username_shortcode could not be created: Cannot refresh revoked seat assignment","documentation_url":"https://docs.github.com/rest/copilot/copilot-user-management#add-users-to-the-copilot-subscription-for-an-enterprise","status":"422"} Some external steps may have completed; check GitHub, seat and Proxy state before retrying.
  ```
- 硬删除：使用DELETE 掉用API删除 GH Login 以及对应的唯一ID，配套的Copilot 坐席也会被删除，但是最低消费的坐席计数会持续到月底。GH Login无法恢复，再次创建同样名字的账号，其唯一ID会发生变化，之前的Copilot坐席记录不会继承。