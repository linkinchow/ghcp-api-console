# GHCP 多企业版新部署指南：从一个企业开始

本指南适用于**全新部署**多企业版 `multi-f43f27e-amd64-r3`，以最常见的情况为例：客户只有**一个** GitHub 企业（一个 slug）。第 10 节说明以后如何再添加企业。

- 已有单企业版 r4 部署要升级，请看 [多企业版升级指南](multi-enterprise-upgrade-guide.md)，不要按本文操作原数据。
- 本文只写部署和首次开池。日常 Console 操作（每日巡检、调整 cap、Drain、处理异常成员、查用户租约等）见[《管理员手册》](admin-manual/README.md)。
- 文中的主机名、slug、域名、令牌都是占位值（`contoso`、`fabrikam`、`example.com`），请替换为实际值；实际值不要写进仓库、工单或截图。


整体流程：

```text
准备镜像、网络、GitHub 侧资料（第 2 节）→ 选择存储（第 3 节）→ 写配置（第 4 节）
→ 部署，账号池保持 Ready idle target = 0（第 5 节）→ 健康检查、初始化 Console（第 7.1–7.2 节）
→ GitHub 侧配置 SAML、SCIM、席位 PAT、Copilot（第 6 节）→ 检查就绪、小规模开池（第 7.3–7.5 节）
→ 接入 LiteLLM（第 8 节）→ 上线验收（第 9 节）
```

## 1. 适用对象与版本线选择

多企业版（镜像 tag 以 `multi-` 开头）让一套部署（一个 SSO、一个 Login、一个 Console 加 N 个 Proxy 副本）管理一个或多个 GitHub 企业。**不配置企业 registry 时只有一个企业 `default`，完全由环境变量合成，行为与单企业版相同。**

| 对比项 | 多企业版 `multi-f43f27e-amd64-r3` | 单企业版 `single-slug-164cade-amd64-r4` |
| --- | --- | --- |
| 只有一个企业时 | `default` 由环境变量定义，不需要 registry 文件 | 同样由环境变量定义 |
| 以后添加企业 | 写 registry 文件，重启 Proxy、SSO、Login，新企业从 `draft` 激活即可；**不需要数据库迁移** | 先按 [升级指南](multi-enterprise-upgrade-guide.md) 原地升级到多企业版：四个镜像一次性替换、需要短暂停机、回滚只能靠备份 |
| 管理接口 | 按企业作用域：`/api/enterprises/default/...` | 旧的无作用域路径 |
| 换到另一条版本线 | 单企业版 r4 不能使用多企业版创建的数据库（原因同升级指南第 10 节） | 只能升级到多企业版，见升级指南 |

**新部署建议直接使用多企业版。** 即使现在只有一个企业，以后添加企业也只是配置变更。自建脚本如果直接调用管理接口，从一开始就使用 `/api/enterprises/default/...`（见 [README 的管理接口](../README.md#管理接口内部)）。

验证范围：

- 发布前资格测试只使用 mock 的 GitHub、GHE.com 和 Copilot，没有调用真实服务。**GHE.com 只用 mock 验证过**，首次接入真实 GHE.com 企业前请先在预发布环境验收。
- 全新部署的镜像资格验证结果记录在 [多企业版发布验证记录](multi-enterprise-release-validation.md) 的 r3 部分（r2 部分有同样的全新部署验证）。
- 本文的配置步骤另外用源码在本机核对过（SQLite，GitHub 与 Copilot 地址指向本机不可达端口，没有任何外部调用），核对内容见文末附录。这不等于镜像级或真实 GitHub 环境的验收。

## 2. 前提

### 2.1 镜像

四个组件必须使用同一版本，按 **digest** 引用（linux/amd64）：

| 组件 | 按 digest 引用 |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:14ed9384f57a95c5cb4c1a5bd34d10d722d89d4e8ba9b3b49fcd6e32e41ad5f3` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:93e5be2c5fd8a9166cd67897c52466b833b9bbb12e2eede9dbe7700204b31214` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:96408b4fc3b0d0cd76083cc4bb8a1dcaf91ffa56152a8f7603caa1cc1a968338` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:6526394ff321ab15a4222423013689eb4959dc465dbec6262aa0a84ae267cc90` |

对应 tag 均为 `multi-f43f27e-amd64-r3`（Docker Hub 公开仓库，无需登录即可拉取；没有 `latest`）。建议先同步到客户自己的镜像仓库，再按 digest 部署。镜像以 Tini 为 PID 1，**不要覆盖启动命令**（否则 SIGTERM 不会转发给 node）。

### 2.2 网络

网络拓扑、SSO 地址的选择和端口暴露见 [部署网络环境说明](../guidance/network-deployment.md)。要点：

| 方向 | 需要访问的地址 | 用途 |
| --- | --- | --- |
| Login 出站（浏览器） | github.com：`github.com`；GHE.com：`<子域>.ghe.com` 和 `auth.ghe.com` | Device Flow、GitHub 网页登录与授权 |
| Login 出站（浏览器） | `<SSO_PUBLIC_BASE_URL>` | GitHub 把浏览器重定向到 SSO 登录页 |
| SSO 出站 | github.com：`api.github.com`；GHE.com：`api.<子域>.ghe.com` | SCIM、Copilot 席位、AI Credits |
| Proxy 出站 | github.com：`api.githubcopilot.com`、`api.github.com`；GHE.com：`copilot-api.<子域>.ghe.com`、`api.<子域>.ghe.com` | Copilot 推理与模型目录；Login 回传令牌时用 GitHub `/user` 核对账号身份；Models 页 |
| 管理员浏览器 | Console；`<SSO_PUBLIC_BASE_URL>` | 管理；GitHub 侧 SAML 测试登录 |
| LiteLLM → Proxy | Proxy Service（默认端口 3000） | 唯一的业务入口 |

- 都是 HTTPS 443 出站。GitHub 服务端不会主动连接 SSO：SAML 全部经浏览器中转，所以 SSO 只需被 Login 的浏览器和管理员浏览器访问到。
- 运行时不需要访问 npm；只有自行构建镜像时需要。
- 使用 MySQL 时，所有 Proxy 副本需要访问同一个 MySQL 写主库。

### 2.3 GitHub 侧准备

GitHub 侧的完整操作（含截图）见 [配置手册](../guidance/guidance.md) 第 3–10 节。按本文顺序，需要准备：

| 项目 | 写到哪里 | 说明 |
| --- | --- | --- |
| 启用 EMU 的 GitHub 企业 | `ENTERPRISE_SLUG`；github.com 还有 `ENTERPRISE_SHORTCODE`；GHE.com 有 `GITHUB_BASE_URL=https://<子域>.ghe.com` | 手册第 4 节。slug 和 shortcode 是企业身份字段，**有数据后不能修改**（第 4.4 节） |
| SAML 签名证书和私钥 | `SSO_CERT_DIR` 目录下的 `idp-cert.pem`、`idp-key.pem` | 生产使用自己维护的证书；`scripts/gen-certs.sh` 只用于开发 |
| SAML IdP 设置 | GitHub 企业的 SAML 页面 | 服务启动后再填，见第 6 节 |
| SCIM token | `SCIM_TOKEN`、`SCIM_BASE_URL` | 手册第 5 节 |
| 席位 PAT | `GITHUB_COPILOT_SEAT_PAT` | 必须能管理企业 Copilot 席位并读取 billing usage（手册第 2.3、9 节）。仓库记录中，只勾选 `manage_billing:copilot` 的 PAT 在测试企业里完成了席位读写，但这不是对所有企业策略的最小权限保证 |
| Copilot 开通与账单 | GitHub 企业设置 | 手册第 10 节。账号池中每个账号（包括空闲的）都占一个席位，开池前确认获批的席位预算 |
| OAuth Device Flow client | `GITHUB_OAUTH_CLIENT_ID`（可选） | 留空时使用内置的 OpenCode client ID，不需要在 GitHub 上创建应用。**它能否用于 `*.ghe.com` 尚未在真实环境确认**（设计文档 §13 第 4 项），GHE.com 请先在预发布环境验证 |
| Models 管理员（可选） | `MODELS_ADMIN_GITHUB_LOGIN` 等 | Console Models 页使用，见 [Models 使用指南](models-admin-guide.md) |

另需生成强随机值：`API_KEY`（LiteLLM 调用 Proxy 的服务密钥）、`INTERNAL_API_TOKEN`（四个服务的内部密钥）、`SESSION_SECRET`（Console 与 `default` 企业 SSO 会话签名）、`SSO_DEFAULT_USER_PASSWORD`（账号池用户的 SSO 密码，至少 16 个字符且不能等于用户名）。

## 3. 选择存储

只有 Proxy 可以选择存储。SSO、Login 和 Console 固定使用各自的 SQLite / JSON 文件，**始终保持单实例**。

| 对比项 | SQLite（单 Proxy） | MySQL（多 Proxy） |
| --- | --- | --- |
| Proxy 实例数 | **只能 1 个**；第二个 Proxy 打开同一个库时启动失败（`Another Proxy owns the SQLite user pool`） | 多个副本共享同一个库 |
| Compose 叠加文件 | `docker-compose.user-pool.yml`（`caller-lease` + SQLite） | `docker-compose.user-pool-mysql.yml`（`caller-lease` + MySQL，需要可信负载均衡） |
| 额外依赖 | 无 | 客户自备 MySQL 8（InnoDB、utf8mb4），负责备份、TLS 和高可用 |
| 适用 | 单机 Compose、试点 | Kubernetes / Rancher、多副本 |

两者都使用 `ACCOUNT_ROUTING_MODE=caller-lease`（账号池模式），这也是接入 LiteLLM 的前提（第 8 节）。默认的 `direct` 模式按调用方传入的 identity 直接开户，不适用于 LiteLLM 接入，本文不展开。

### 3.1 MySQL：建库与账号

1. DBA 创建一个**专用的空库**，字符集 `utf8mb4`（仓库脚本使用 `utf8mb4_0900_ai_ci`）。不要与其他应用共用库；同一个池的所有 Proxy 必须使用同一个库和写主库地址，不能用只读副本。
2. 创建 Proxy 专用账号，连接串写成 `mysql://<用户>:<URL 编码后的密码>@<主机>:<端口>/<库名>`，放在 Secret 中（`MYSQL_URL`）。
3. 生产启用 TLS：`MYSQL_SSL_MODE=verify-ca`，`MYSQL_SSL_CA_PATH` 指向挂载的 CA 文件。注意当前 Proxy 的 `verify-ca` 校验证书链，不应描述为已实现完整的主机名验证。
4. 连接数：每个 Proxy 最多 `MYSQL_CONNECTION_LIMIT`（默认 10）个连接，总数约为“副本数 × 该值”，加上滚动更新和运维余量，要小于 MySQL 的 `max_connections`。

然后二选一：

**方式 A：自动迁移（`MYSQL_AUTO_MIGRATE=true`，默认）**

- 第一个启动的 Proxy 取得迁移锁并建表；其他副本最多等待 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`（默认 30）秒。全新空库没有历史数据，但**首次启动仍建议只开 1 个 Proxy**，`/readyz` 正常后再扩容。
- Proxy 账号除了读写（SELECT、INSERT、UPDATE、DELETE），还需要迁移执行的 DDL 所需权限：建表、改表、建索引、外键（CREATE、ALTER、INDEX、REFERENCES）；账号池模式下迁移还会在 `proxy_accounts` 上创建触发器 `user_pool_credential_fence`，因此还需要 TRIGGER。这份清单是按代码整理的，请 DBA 在预发布环境用同样的账号实测一次；开启了二进制日志的 MySQL 创建触发器时可能还受服务器设置（如 `log_bin_trust_function_creators`）影响，由 DBA 确认。

**方式 B：DBA 预建表、运行账号低权限（`MYSQL_AUTO_MIGRATE=false`）**

1. DBA 用管理员账号执行**本版本源码**中的 `scripts/proxy-mysql-initial.sql`（全新空库用这个脚本；`scripts/proxy-mysql-enterprise-upgrade.sql` 只用于从 r4 升级）。注意：
   - 脚本开头是 `CREATE DATABASE IF NOT EXISTS ghcp_proxy;` 和 `USE ghcp_proxy;`。库名不同时，从注释 `-- If the database already exists, start here.` 之后开始、在自己的库上执行（例如私下复制一份并删除前面几行）。
   - 脚本用 `DELIMITER` 定义触发器，请用 `mysql` 命令行客户端执行。
   - **会话字符集必须是 utf8mb4**。r3 源码（`f43f27e`）和 main 上的脚本开头已有 `SET NAMES utf8mb4`，会自动切换；r2 源码提交 `4922a4a` 中的脚本还没有这一行，用它时必须加客户端参数，例如 `mysql --default-character-set=utf8mb4 -h <主机> -u <管理员> -p < scripts/proxy-mysql-initial.sql`（对新脚本加上也无害）。部分客户端（包括官方 mysql 8.4 镜像自带的客户端）默认是 latin1 会话，这样建出的 CHECK 约束字面量带 `_latin1` 前缀，`MYSQL_AUTO_MIGRATE=false` 时 Proxy 会以 `Unsupported MySQL schema: proxy_enterprises check constraints` 拒绝启动。两个版本的脚本建出的表结构相同，都适用于 r2 镜像。
2. 运行账号只需要（与脚本头部注释一致）：

   ```sql
   CREATE USER '<proxy_user>'@'<来源网段>' IDENTIFIED BY '<强密码>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON `<库名>`.* TO '<proxy_user>'@'<来源网段>';
   -- 仅账号池模式（caller-lease）：MySQL 只向有 TRIGGER 权限的账号展示触发器元数据，Proxy 启动时要核对它
   GRANT TRIGGER ON `<库名>`.`proxy_accounts` TO '<proxy_user>'@'<来源网段>';
   ```

3. Proxy 以 `MYSQL_AUTO_MIGRATE=false` 启动时只读校验表结构；`default` 企业的行和账号池配置指纹由 Proxy 首次启动时用 INSERT/UPDATE 写入，不需要额外权限。表结构不符合时 Proxy 拒绝启动并提示应执行的脚本。

## 4. 单企业最小配置

从模板复制：github.com 用 `cp .env.example .env`，GHE.com 用 `cp .env.example.data-residency .env`。下表只列单企业账号池部署需要关心的变量；完整清单和默认值见 [生产配置完整清单](user-pool-configuration-reference.md)。

### 4.1 不需要 registry

只有一个企业时**不要配置 registry**：不设置 `ENTERPRISE_REGISTRY_FILE`，不叠加 `docker-compose.enterprise-registry.yml`。Proxy、SSO、Login 各自用环境变量合成 `default` 企业（映射关系见 [registry 配置参考](multi-enterprise-registry.md) 第 5 节）；`default` 从第一次启动起就是 `active`。`DIRECT_MODE_ENTERPRISE_ID` 只用于直连模式，留空。

“必填”列：**Compose** 表示 `docker-compose.yml` 或账号池叠加文件用 `${VAR:?}` 强制，缺少时 Compose 拒绝启动；**是** 表示不强制但实际需要；**否** 表示可选。

### 4.2 共用

| 变量 | 服务 | 必填 | 示例（占位） | 说明 |
| --- | --- | --- | --- | --- |
| `INTERNAL_API_TOKEN` | 全部 | Compose | `<随机值>` | 服务间内部鉴权 |
| `SESSION_SECRET` | SSO、Console | Compose | `<随机值>` | Console 会话和 `default` 企业 SSO 会话签名 |
| `GITHUB_BASE_URL` | Proxy、SSO、Login | GHE.com 必填 | 空，或 `https://contoso.ghe.com` | 空表示 `https://github.com`。以 `.ghe.com` 结尾时三个服务进入 GHE.com 模式 |
| `ENTERPRISE_SHORTCODE` | Proxy、SSO | github.com 必填 | `ctso` | 留空时使用内置值 `octo`，**不会报错**，所以 github.com 必须填实际值。GHE.com 留空（填了也被忽略，启动日志打印 warning） |
| `GITHUB_API_BASE_URL`（Proxy、SSO）、`COPILOT_API_BASE_URL`（Proxy） | 见左 | 否 | 空 | 空时按 `GITHUB_BASE_URL` 推导：github.com 为 `https://api.github.com`、`https://api.githubcopilot.com`；GHE.com 为 `https://api.<子域>.ghe.com`、`https://copilot-api.<子域>.ghe.com`。GHE.com 下显式填写时必须属于同一个 `<子域>.ghe.com`，否则启动失败。`GITHUB_API_BASE_URL` 若给 SSO 显式设置（例如经出口网关），**Proxy 也必须设置同一个值**：多企业版 Proxy 在 Login 回传 token 时会调用 `GET <API 地址>/user` 核对账号身份，地址不可达时补货会全部以 `oauth_login_failed` 失败 |
| `LOG_LEVEL`、`SHUTDOWN_TIMEOUT_MS` | 全部 | 否 | `info`、`25000` | 关闭超时要小于容器的停止宽限期（第 5 节） |

### 4.3 Proxy

| 变量 | 必填 | 示例（占位） | 说明 |
| --- | --- | --- | --- |
| `API_KEY` | Compose | `<随机值>` | LiteLLM 调用 Proxy 的服务密钥，**不要发给最终用户**。账号池模式下为空时 Proxy 拒绝启动 |
| `ACCOUNT_ROUTING_MODE` | 是 | `caller-lease` | 账号池叠加文件已设置 |
| `STORAGE_DRIVER` | 否 | `sqlite` / `mysql` | MySQL 叠加文件设为 `mysql` |
| `DB_PATH` | SQLite | `/data/proxy.sqlite` | Compose 默认值 |
| `MYSQL_URL` | MySQL：Compose | Secret | 第 3.1 节 |
| `MYSQL_AUTO_MIGRATE`、`MYSQL_SSL_MODE`、`MYSQL_SSL_CA_PATH`、`MYSQL_CONNECTION_LIMIT` | MySQL | `true`、`verify-ca`、`/run/mysql-ca/ca.pem`、`10` | 第 3.1 节；`verify-ca` 时 CA 路径必填 |
| `POOL_ACCOUNT_EMAIL_DOMAIN` | 账号池：Compose | `pool.contoso.example.com` | 池账号的邮箱域名（`default.pool.accountDomain`），不是调用方身份。缺少时 Proxy 照常启动，但 `default` 有阻塞项、不会补货。**有池成员后不能修改** |
| `POOL_WARMUP_MODEL` | 账号池：Compose | `<账号可用的模型>` | 新账号凭据验证使用的模型，缺少时 Proxy 拒绝启动 |
| `READY_IDLE_TARGET` | 否 | **`0`** | 全局空闲目标，**只在首次创建设置时生效**，之后在 Console 修改。全新部署建议先设 0，避免一启动就开始真实开户（第 7.5 节） |
| `POOL_MAX_ACCOUNTS` | 否 | `100` | 只作为 `default` 企业的**初始 cap**（1–10000），之后在 Console 按企业修改 |
| `CALLER_LEASE_TTL_SECONDS` | 否 | `172800` | 正式租约时长（默认 48 小时），只在首次创建设置时生效，之后在 Console 修改 |
| `SSO_BASE_URL`、`LOGIN_BASE_URL` | Kubernetes 必填 | `http://<sso-service>:7001` | SSO、Login 的内部根地址，不带 `/api`；Compose 已固定 |
| `MODELS_ADMIN_GITHUB_LOGIN`、`MODELS_ADMIN_GITHUB_USER_ID`、`MODELS_ADMIN_COPILOT_TOKEN(_FILE)` | 否 | — | 未配置时 Models 页显示 `models_admin_not_configured` |
| `PROXY_ERROR_DIAGNOSTICS_ENABLED`、`PROXY_ERROR_DIAGNOSTICS_REDACT` | 否 | `false`、`true` | 账号池叠加文件和 K8s 模板关闭诊断并开启脱敏；代码默认是开启且**不脱敏**，自己写清单时要显式设置 |

MySQL 下，`POOL_WARMUP_MODEL`、`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` 写入共享的配置指纹，所有副本必须一致，事后修改需要维护流程（配置清单第 2 节）。请在首次启动前确定。只想放宽推理请求时限时，用独立的 `POOL_INFERENCE_TIMEOUT_SECONDS`（5–600 秒），它不进入指纹。

### 4.4 SSO

| 变量 | 必填 | github.com 示例（占位） | GHE.com 示例（占位） | 说明 |
| --- | --- | --- | --- | --- |
| `SSO_PUBLIC_BASE_URL`（Compose，映射为 `BASE_URL`） | Compose | `https://sso.contoso.example.com` | 同左 | SSO 的对外地址，生成 `/metadata`、`/sso`。为 https 时会话 cookie 带 Secure。必须能被 Login 浏览器和管理员浏览器访问（第 2.2 节） |
| `ENTERPRISE_SLUG` | Compose | `contoso` | `contoso` | 企业 slug，**有 SSO 用户后不能修改** |
| `SP_ENTITY_ID` | Compose | `https://github.com/enterprises/contoso` | `https://contoso.ghe.com/enterprises/contoso` | GitHub 作为 SAML SP 的标识 |
| `SP_ACS_URL` | Compose | `https://github.com/enterprises/contoso/saml/consume` | `https://contoso.ghe.com/enterprises/contoso/saml/consume` | 不填时代码回退到开发用 mock 地址，所以必须填 |
| `SCIM_BASE_URL` | Compose | `https://api.github.com/scim/v2/enterprises/contoso` | `https://api.contoso.ghe.com/scim/v2/enterprises/contoso` | 同上，必须填 |
| `SCIM_TOKEN` | Compose | Secret | Secret | |
| `GITHUB_COPILOT_SEAT_PAT` | 是 | Secret | Secret | 缺少时席位操作失败 |
| `SSO_DEFAULT_USER_PASSWORD` | 账号池：Compose | Secret | Secret | 至少 16 个字符，不能等于用户名 |
| `SSO_CERT_DIR`（Compose 主机目录，挂到 `/certs`） | 是 | `./certs` | 同左 | 目录中放 `idp-cert.pem`、`idp-key.pem`；K8s 中设置 `CERT_DIR` 为挂载路径 |

### 4.5 Login

| 变量 | 必填 | 示例（占位） | 说明 |
| --- | --- | --- | --- |
| `LOGIN_SSO_URL`（Compose，映射为 `SSO_URL`） | 是 | `<SSO_PUBLIC_BASE_URL>/login` | `default` 企业的 SSO 登录页。Login 浏览器只在与它同 origin、路径按整段前缀匹配的页面填写 SSO 密码，所以它必须与 `SSO_PUBLIC_BASE_URL` 同 host 和端口，且在 Login 容器内可访问。Compose 默认 `http://sso:7001/login` 只对应默认的 `SSO_PUBLIC_BASE_URL=http://sso:7001` |
| `ENTERPRISE_SLUG` | GHE.com 必填 | `contoso` | Compose 与 SSO 共用同一个变量。GHE.com 下 Login 直接打开 `https://<子域>.ghe.com/enterprises/<slug>/sso` |
| `GITHUB_OAUTH_CLIENT_ID` | 否 | 空 | 空表示内置 OpenCode client ID（第 2.3 节） |
| `AUTH_HEADLESS` | 否 | `true` | |

### 4.6 Console

| 变量 | 必填 | 示例（占位） | 说明 |
| --- | --- | --- | --- |
| `CONSOLE_PUBLIC_BASE_URL` | 否 | `https://console.contoso.example.com` | Console 前有会改写 Host 头的反向代理时设置。Console 的写操作只接受来自该地址或请求 Host 的同源请求，否则返回 403 |
| `ADMINS_FILE` | 否 | `/data/admins.json` | 必须在持久卷上：文件丢失时 Console 回到“未初始化”状态（第 7.2 节） |

### 4.7 首次启动前定下来的值

以下字段一旦有数据就不能再改，否则对应服务以 `enterprise_identity_changed` 拒绝启动（[registry 配置参考](multi-enterprise-registry.md) 第 8 节）。单企业部署中它们来自环境变量：

| 服务 | 字段（环境变量） | 何时锁定 |
| --- | --- | --- |
| Proxy | `GITHUB_BASE_URL`、`ENTERPRISE_SHORTCODE`、`POOL_ACCOUNT_EMAIL_DOMAIN` | 有池成员后 |
| SSO | `GITHUB_BASE_URL`、`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE` | 有 SSO 用户后 |
| Login | `GITHUB_BASE_URL`、`ENTERPRISE_SLUG` | 有登录任务后 |

## 5. 部署

### 5.1 Docker Compose

仓库的 `docker-compose.yml` 带有 `build:` 段，默认镜像名是本地构建的 `ghcp-*:local`。使用发布镜像时，写一个**私有**叠加文件（不入库）指定 digest，例如 `docker-compose.release.yml`：

```yaml
services:
  sso:
    image: docker.io/linkinchow/ghcp-sso@sha256:93e5be2c5fd8a9166cd67897c52466b833b9bbb12e2eede9dbe7700204b31214
  login:
    image: docker.io/linkinchow/ghcp-login@sha256:96408b4fc3b0d0cd76083cc4bb8a1dcaf91ffa56152a8f7603caa1cc1a968338
  proxy:
    image: docker.io/linkinchow/ghcp-proxy@sha256:14ed9384f57a95c5cb4c1a5bd34d10d722d89d4e8ba9b3b49fcd6e32e41ad5f3
  console:
    image: docker.io/linkinchow/ghcp-console@sha256:6526394ff321ab15a4222423013689eb4959dc465dbec6262aa0a84ae267cc90
```

先用 `docker pull <镜像@digest>` 拉取四个镜像（或从自己的仓库拉取），再用 `--no-build --pull never` 启动，确保运行的就是验收过的镜像。

**SQLite 单 Proxy：**

```bash
docker compose -f docker-compose.yml -f docker-compose.user-pool.yml -f docker-compose.release.yml \
  up -d --no-build --pull never --wait
```

- `docker-compose.user-pool.yml` 需要 Docker Compose ≥ 2.24.4（使用 `!override`）。它把 Proxy 只发布在宿主机 `127.0.0.1`，LiteLLM 应通过 Compose 网络访问 `http://proxy:3000`；不要把 Proxy 直接暴露给最终用户。
- SSO、Login、Console 的端口暴露按 [网络说明](../guidance/network-deployment.md) 第 3 节收窄。

**MySQL 多 Proxy：** 用 `docker-compose.user-pool-mysql.yml` 替换上面的 `docker-compose.user-pool.yml`。它不发布 Proxy 端口，需要一个可信负载均衡指向各 Proxy 副本并检查 `/readyz`，`PROXY_CLUSTER_BASE_URL` 设为该负载均衡的内部根地址（SSO、Login、Console 用它访问 Proxy）。负载均衡示例和全新空池的启用顺序见 [MySQL 实施文档](user-pool-mysql-implementation.md) 第 3、4 节：先 `--scale proxy=1` 启动、确认 `/readyz` 和 Console，再扩容。

优雅停止：Compose 中四个服务的 `stop_grace_period` 为 35 秒，覆盖 `SHUTDOWN_TIMEOUT_MS`（默认 25 秒）加资源释放。Proxy 收到 SIGTERM 约 25 秒后强制关闭仍在进行的连接，更长的流可能被截断。**不要使用 `docker compose down -v`**，它会删除数据卷。

### 5.2 Kubernetes / Rancher

全新部署使用 [`deploy/kubernetes/`](../deploy/kubernetes/README.md)：Kustomize base 加 overlay，包含**全部四个服务**（Proxy、SSO、Login、Console），外部托管 MySQL（例如 Azure Database for MySQL）。操作步骤（建库、填写 Secret 与 ConfigMap、apply 顺序、首次启动门禁、初始化 Console、开池、LiteLLM 访问、升级与回滚）见其 README；该目录的清单已在本地 kind 集群上用 mock 端到端验证过（README 第 9 节）。

| 目录 | 内容 |
| --- | --- |
| `base/` | 四个 Deployment、ClusterIP Service、ConfigMap、PVC 和 Proxy 的 PodDisruptionBudget；镜像按第 2.1 节的 digest 引用；Secret 只按名称引用，值不入库（格式见 `secret.example.yaml`） |
| `overlays/github-com/`、`overlays/ghe-com/` | 两种 GitHub 形态的企业变量（GHE.com 不设 `ENTERPRISE_SHORTCODE`），复制到私有仓库后替换 `REPLACE_*` |
| `components/` | 可选：`ingress-sso`（SSO 对浏览器开放，SAML 必需的可达性）、`ingress-console`（Console 只经内部 Ingress）、`mysql-dba-schema`（方式 B，`MYSQL_AUTO_MIGRATE=false`）、`network-policy`（默认拒绝 + 最小放行） |

要点（与第 3、4 节一致）：

- **Proxy**：2 个副本、`caller-lease` + MySQL、`RollingUpdate`（`maxSurge: 1`、`maxUnavailable: 0`）、PDB `minAvailable: 1`；`readinessProbe` 用 `/readyz`，`livenessProbe` 与 `startupProbe`（约 300 秒）用 `/healthz`。
- **SSO、Login、Console**：各 1 个副本、`strategy: Recreate`，`/data`（Login 另有 `/logs`）在 RWO 持久卷上；不要用 NFS / Azure Files 等共享文件系统。Login 的 `/dev/shm` 使用内存卷。
- **停止**：四个服务都是 `terminationGracePeriodSeconds: 45` = preStop 10 秒 + `SHUTDOWN_TIMEOUT_MS` 25 秒 + 资源释放 5 秒 + 余量；不覆盖镜像的启动命令（Tini 转发 SIGTERM）。
- **安全上下文**：以 UID 1000 运行（镜像内的 `node` 用户）、根文件系统只读、去掉全部 capability、不挂载 ServiceAccount token。
- **首次启动门禁**：每个 Pod 的 init 容器在 `GHCP_CONFIG_APPROVED` 不是 `"true"`、或任何环境变量仍含 `REPLACE_` 时拒绝启动。核对第 4.7 节的身份字段和池配置指纹参数后再放行。
- **SSO 地址**：只在 ConfigMap 写一次 `SSO_PUBLIC_BASE_URL`，SSO 的 `BASE_URL` 与 Login 的 `SSO_URL`（`<地址>/login`）都由它生成，保证同源。
- **MySQL**：默认 `MYSQL_SSL_MODE=verify-ca`，CA 来自 ConfigMap `ghcp-mysql-ca`。

[`deploy/user-pool-mysql-customer/`](../deploy/user-pool-mysql-customer/README.md) 中只有 Proxy 的模板，按“从已有单企业部署迁移”编写（`strategy: Recreate`、导入数据库门禁），用于升级，不用于全新部署。

## 6. GitHub 侧 SAML 配置（`default` 企业）

在服务已启动、Console 已初始化后进行（第 7.1–7.2 节）。`default` 企业使用 SSO 的**根路径**：

| GitHub SAML 字段 | 填写值 |
| --- | --- |
| Sign on URL | `<SSO_PUBLIC_BASE_URL>/sso` |
| Issuer | `<SSO_PUBLIC_BASE_URL>/metadata`（与 `<SSO_PUBLIC_BASE_URL>/metadata` 返回的 `entityID` 相同） |
| Public certificate | `idp-cert.pem` 的内容 |

- `SP_ENTITY_ID`、`SP_ACS_URL` 必须与该企业 GitHub 侧的 SP 地址一致（第 4.4 节）。
- 根路径只属于 `default`：`/enterprises/default/...` 不存在。以后添加的企业才使用 `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso` 和 `.../metadata`（第 10 节），`default` 的配置不需要改。
- 填写、测试登录、保存 recovery code、开启 SCIM、同步首个管理员、创建席位 PAT、开通 Copilot 的步骤见 [配置手册](../guidance/guidance.md) 第 6.4–10 节。这一阶段账号池保持 Ready idle target = 0（或暂停），只手工操作首个管理员用户。

## 7. 首次启动与开池

### 7.1 健康检查

| 检查 | 期望 |
| --- | --- |
| 四个服务的 `/healthz` | `{"status":"ok","service":"<服务>","releaseLine":"multi"}`。不是 `multi` 说明用错了镜像 |
| Proxy `/readyz` | `{"status":"ok","service":"proxy","storage":"sqlite"}`（或 `"mysql"`）。`/readyz` 会实际 ping 数据库；`/healthz` 不访问数据库 |
| Proxy 启动日志 | `[proxy] enterprise default (direct mode): GitHub <地址>, Copilot <地址>`，地址与预期一致（`(direct mode)` 表示它也是直连模式的默认企业，账号池模式下同样显示）。出现 `[proxy] enterprise default is not ready: ...` 表示缺字段（第 7.3 节） |
| SSO 启动日志 | `[sso] enterprise default: SAML metadata <SSO_PUBLIC_BASE_URL>/metadata`；github.com 还会显示 `GH login suffix _<shortcode>` |
| 启动错误 | 没有 `enterprise_registry_invalid`、`enterprise_env_conflict`、`enterprise_identity_changed`；GHE.com 地址不在同一子域时 Proxy 报 `copilotApiBaseUrl must be under the same <sub>.ghe.com as github.baseUrl` 并退出 |

可以用 `scripts/validate-health.sh`（通过 `PROXY_URL`、`SSO_URL`、`LOGIN_URL`、`CONSOLE_URL` 指定地址）一次检查四个服务。

### 7.2 初始化 Console 管理员

Console 首次打开显示 **Initialize Console**，填写用户名和密码后创建唯一的管理员（只保存加盐哈希）。

- **初始化之前，第一个访问 Console 的人就能创建管理员**。部署时先把 Console 限制在管理网段，启动后立即初始化。
- 跨站请求会被拒绝（403）；Console 前有改写 Host 的反向代理时设置 `CONSOLE_PUBLIC_BASE_URL`。
- 当前只能在初始化时创建一个管理员，没有找回密码功能；`admins.json` 要在持久卷上并备份。

### 7.3 Pool overview：确认 `default` 就绪

打开 **Pool overview**：

- 企业表只有 `default`，State 为 `active`，**Inventory / cap** 为 `0 / <POOL_MAX_ACCOUNTS>`，**Blockers** 为 `None`。
- Blockers 不为空时按 [registry 配置参考](multi-enterprise-registry.md) 第 6 节处理。单企业部署常见原因：

| 阻塞项 | 原因 |
| --- | --- |
| `proxy:enterprise_field_missing:pool.accountDomain` | Proxy 没有 `POOL_ACCOUNT_EMAIL_DOMAIN` |
| `sso:enterprise_secret_unconfigured:sso.signingKey`（或 `signingCert`、`sessionSecret`） | SSO 读不到证书目录中的文件或 `SESSION_SECRET` |
| `sso_unavailable` / `login_unavailable` | Proxy 访问不到 SSO 或 Login（检查 `SSO_BASE_URL`、`LOGIN_BASE_URL`、`INTERNAL_API_TOKEN`） |
| `shortcode_mismatch` / `slug_mismatch` | Proxy 与 SSO 的 `ENTERPRISE_SHORTCODE`，或 SSO 与 Login 的 `ENTERPRISE_SLUG` 不一致 |

就绪结果在每个 Proxy 中缓存（就绪 60 秒，未就绪 10 秒），修复后稍等再点 **Refresh**。

### 7.4 全局设置与 cap

**Global pool settings**（对所有企业生效，保存后无需重启）：

| 设置 | 全新部署初值 | 范围 | 说明 |
| --- | --- | --- | --- |
| Ready idle target | `READY_IDLE_TARGET`（建议 0） | 0–10000 | 全局希望保持的空闲账号数；可以大于企业 cap，各企业到 cap 后补货停止。空闲账号也占席位 |
| Lease TTL (seconds) | 172800（48 小时） | 60–2592000 | 完整成功推理后续期；修改只影响之后的续期 |
| Pause prewarming | 不勾选 | — | 暂停所有企业的开户和修复，不停止已有流量 |

企业表中 `default` 的 **Edit cap** 修改该企业的账号上限（所有企业之和 ≤ 10000，降低不删号）。`PATCH /api/user-pool/settings` 不接受 cap，传 `max_accounts` 返回 409 `use_enterprise_cap`。

### 7.5 小规模开池

开池会触发真实的 SSO 用户创建、SCIM、席位分配、浏览器登录和预热模型调用，请在 GitHub 侧准备完成（第 6 节）并取得席位预算批准后进行：

1. 把 `default` 的 cap 设小（例如 1–2），Ready idle target 设为 1，取消 Pause prewarming，保存。
2. 在 **Pool members** 观察第一个账号从开户中变为 `Ready idle`。失败时看 Login Tasks、SSO Users 和成员的错误信息；GHE.com 首次接入可在 Console Settings 临时开启 Login 的调试产物（截图、trace，含敏感内容，用完关闭）。
3. 用一把测试 virtual key 经 LiteLLM 完成一次调用（第 8 节），确认成员变为 leased。
4. 再逐步调高 cap 和 Ready idle target。

MySQL 多 Proxy：上述验证在 1 个 Proxy 上完成后再扩容，确认每个副本 `/readyz` 正常、负载均衡健康检查通过。

## 8. LiteLLM 接入

LiteLLM 侧的完整说明见 [LiteLLM 身份接入](user-pool-litellm.md) 和 [灰度准入 Hook](user-pool-litellm-canary.md)；参考版本为 LiteLLM v1.99.1，其他版本需自行验证回调生命周期。

- **透明路由**：在已有模型组中加入指向 GHCP Proxy 的 deployment，公开模型名不变，最终用户不需要 `ghcp/` 前缀，也不传企业。调用方是哪个企业的账号由账号池按企业 cap 比例分配，已有租约的调用方保持原企业和原账号。

  ```yaml
  model_list:
    - model_name: claude-opus-5
      litellm_params:
        model: anthropic/claude-opus-5
        api_base: os.environ/GHCP_POOL_API_BASE
        api_key: os.environ/GHCP_PROXY_API_KEY
        max_retries: 0
  ```

- **LiteLLM 进程的环境变量**（根目录 `.env` 中的同名变量不会传给独立部署的 LiteLLM）：

  | 变量 | 值 |
  | --- | --- |
  | `GHCP_POOL_API_BASE` | Proxy 根地址，例如 `http://proxy:3000` 或 Kubernetes Service 地址（MySQL 多副本时为负载均衡地址）；provider 自己追加 `/v1/messages` 等路径 |
  | `GHCP_POOL_API_BASES` | 逗号分隔，列出**所有** GHCP deployment 的 `api_base`，按 scheme、host、端口、路径精确匹配（忽略末尾斜杠）。缺少时 Hook 启动失败 |
  | `GHCP_PROXY_API_KEY` | Proxy 的 `API_KEY` |

- **二选一注册 Hook**（放在其他会修改 header/URL 的回调之后，不要同时注册两个，也不要再保留旧的 metadata 身份 Hook）：

  | Hook | 注册名 | 行为 |
  | --- | --- | --- |
  | 身份 Hook | `user_pool_hook.proxy_handler_instance` | 所有通过认证的业务 virtual key 都可以使用 GHCP deployment。Hook 把 key hash 作为 `X-User-Identity: sha256:<hash>` 发给 Proxy，Master Key、session token 和伪造的 header 不会被当作业务身份 |
  | 灰度 Hook | `user_pool_canary_hook.proxy_handler_instance`（同时挂载 `user_pool_hook.py`） | 只有 key hash 首位在 `ALLOWED_HASH_PREFIXES` 中的调用方可以选到 GHCP。该值是 `user_pool_canary_hook.py` 顶部的源码常量，默认 `"0"`（约 6.25% 的 key），`"0123456789abcdef"` 为全部，`""` 为暂停；不是环境变量，修改后需重启 LiteLLM。未入组的 key 只能走同组的非 GHCP 后端，没有时返回 403 |

- Proxy 的 `IDENTITY_HEADER` 保持 `X-User-Identity`（Hook 中写死该名称；账号池叠加文件已固定）。
- 示例配置关闭重试、回退和响应缓存：[config.user-pool.example.yaml](../litellm/config.user-pool.example.yaml)、[config.user-pool-canary.example.yaml](../litellm/config.user-pool-canary.example.yaml)。它们是合并到已有网关的片段，不是独立网关。
- 池中没有可分配账号时，Proxy 返回 429 `pool_exhausted` 和 `Retry-After`；文档记录 LiteLLM v1.99.1 不透传 `Retry-After`。

## 9. 上线验收清单

不调用真实模型的部分：

- [ ] 四个服务 `/healthz` 返回 `"releaseLine": "multi"`，运行中的镜像 digest 与第 2.1 节一致。
- [ ] Proxy `/readyz` 正常，`storage` 与选择一致；MySQL 时每个副本都正常。
- [ ] 启动日志中 `default` 的 GitHub、Copilot 地址正确，没有 `is not ready` 警告或启动错误。
- [ ] Console 已初始化，且只能从管理网段访问；`admins.json` 在持久卷上。
- [ ] Pool overview：`default` 为 `active`，Blockers 为 `None`，cap 与 Ready idle target 为批准值，Lease TTL 为 48 小时或批准值。
- [ ] `<SSO_PUBLIC_BASE_URL>/metadata` 可从管理员浏览器和 Login 容器访问；GitHub SAML 的 Sign on URL、Issuer、证书与第 6 节一致，测试登录成功，recovery code 已离线保存。
- [ ] SCIM 已开启；首个管理员已同步；席位 PAT 能分配席位、读取 AI Credits。
- [ ] Proxy 不对最终用户开放；未带有效 `API_KEY` 的请求返回 401，非 `sha256:<64 位 hex>` 的身份返回 403 `invalid_caller_identity`。
- [ ] 错误诊断已关闭，或已开启脱敏并限制访问。
- [ ] 已完成一次备份（第 11 节），并记录镜像 digest、配置版本。

需要真实开户和推理的部分（单独批准后进行）：

- [ ] 第 7.5 节：一个账号到达 `Ready idle`，测试 key 经 LiteLLM 调用成功，成员变为 leased，Request Stats 有记录。
- [ ] 灰度 Hook：未入组的 key 不会选到 GHCP。
- [ ] Models 页（若配置了 Models 管理员）能显示模型目录。

## 10. 以后添加第二个企业

不需要数据库迁移，也不需要修改 `default` 的任何配置。建议作为单独的变更进行。完整步骤和字段说明见 [registry 配置参考](multi-enterprise-registry.md) 第 9 节，概要：

1. **GitHub 侧**（新企业）：slug、SCIM token、席位 PAT；在该企业的 SAML 设置中填写 Sign on URL `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso`、Issuer `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata`、该企业**独立的**签名证书。
2. **Secret**：新企业独立的签名证书和私钥、session secret、SCIM token、席位 PAT、默认密码，放在 Secret 或主机目录中。
3. **registry**：参考 [`deploy/enterprise-registry.example.json`](../deploy/enterprise-registry.example.json)，**只写新企业，不写 `default`**（`default` 继续由环境变量定义；写了就要处理与环境变量的冲突，见 registry 配置参考第 5 节）。文件中只写 secret 引用，不写值；`id`、`slug`、`shortcode`、`pool.accountDomain` 有数据后不能修改。
4. **挂载**：同一份 registry 只读挂载到 Proxy、SSO、Login，并设置 `ENTERPRISE_REGISTRY_FILE`。
   - Compose：再叠加 `-f docker-compose.enterprise-registry.yml`，在 `.env` 中设置 `ENTERPRISE_REGISTRY_HOST_FILE`、`ENTERPRISE_SECRETS_DIR`（挂到 `/run/secrets`，registry 中按 `/run/secrets/<id>/<名称>` 引用）。
   - Kubernetes：registry 放 ConfigMap，每个企业一个 Secret 卷；Proxy 模板中有注释示例，SSO、Login 的清单按同样方式添加。
5. **重启 Proxy、SSO、Login**（MySQL 时重启所有 Proxy 副本）。不支持热加载；可以逐个重启，新企业在三方就绪前一直是 `draft`，不会被调度，`default` 不受影响。registry 路径写错时服务无法启动。
6. **Pool overview**：新企业以 `draft` 出现，cap 为 `initialMaxAccounts`（默认 10）。处理 Blockers（例如读不到签名私钥时为 `sso:enterprise_secret_unconfigured:sso.signingKey`，补文件后需重启 SSO）；未就绪时 Activate 返回 409 `enterprise_not_ready`。就绪后 **Edit cap**，再 **Activate**。
7. **验证**：按第 7.5 节小规模观察新企业开户，再用测试 key 验证。GHE.com 企业首次接入前先在预发布环境验证。

注意：开过户的企业不能从 registry 删除（服务以 `enterprise_missing_from_registry` 拒绝启动），不再使用时用 **Drain**。

## 11. 备份、回退与日志

### 11.1 备份

在“首次启动完成、开池之前”做一次基线备份，之后每次变更（例如添加企业）前再备份。SQLite 需要先停止对应服务，或使用支持 SQLite 的备份方式：

| 数据 | 位置（Compose 默认） |
| --- | --- |
| Proxy | SQLite：`/data/proxy.sqlite` 及同目录的 `-wal`、`-shm`（建议复制整个卷）；MySQL：对 Proxy 库做一致性备份（例如 `mysqldump --single-transaction`） |
| SSO | `/data/sso.sqlite`（含 `-wal`、`-shm`）和 `sso-user-events.log` |
| Login | `/data/login.sqlite`（含 `-wal`、`-shm`） |
| Console | `/data/admins.json` |
| 其他 | SAML 证书目录、`.env` 和私有叠加文件（或 ConfigMap、Secret、Deployment 清单）、四个镜像的 digest；添加企业后还有 registry 文件和各企业的 secret |

这些数据都高度敏感（OAuth token、密码哈希、证书私钥），备份同样按机密数据保管。

### 11.2 回退

全新部署没有可以退回的旧版本：

- 配置错误：改回配置，重新创建容器 / Pod。注意第 4.7 节的身份字段有数据后不能改。
- 数据需要回到某个时间点：停止全部四个服务，恢复第 11.1 节的备份（SQLite 连同 `-wal`、`-shm` 一起恢复），再用同样的镜像和配置启动。
- 放弃这套部署：停止服务后删除数据卷和数据库，重新开始。

数据库恢复**不会撤销 GitHub 侧的变化**（已通过 SCIM 创建的用户、已分配的席位），恢复或放弃后请在 GitHub 中核对并清理。单企业版 r4 不能使用多企业版的数据库，不要用 r4 镜像打开这些数据。

### 11.3 日志与诊断

| 位置 | 内容 |
| --- | --- |
| 四个服务的标准输出 | 结构化日志，等级由 `LOG_LEVEL` 控制；启动时打印每个企业的地址和阻塞项 |
| Login `/logs/login`（`LOG_DIR`） | 按账号的登录日志 |
| Login `/logs/auth-debug`（`AUTH_DEBUG_ARTIFACT_DIR`） | Console Settings 中开启调试产物后的截图和 trace（含敏感内容） |
| SSO `sso-user-events.log` | `default` 企业的用户事件；其他企业写在同目录的 `<id>/` 子目录 |
| Proxy `/data/error-diagnostics` | 上游失败现场（账号池叠加文件和 K8s 模板默认关闭）；Console **Error Diagnostics** 页查看 |
| Console | Pool members 的 Recent events、Login Tasks、SSO Users 的错误信息 |
| `GET /api/user-pool/diagnostics/local` | 每个 Proxy 进程的调度器状态（需 `X-Internal-Token`，直连实例） |

监控、告警和人工恢复见 [运维基础](user-pool-ops-basics.md)、[本机调度诊断](user-pool-local-diagnostics.md) 和 [安全恢复与人工核对](user-pool-recovery-triage.md)。

## 附录：本文配置步骤的本机核对

在源码（提交 `3fa8f91`）上用本机 Node 运行四个服务：SQLite、`caller-lease`、`READY_IDLE_TARGET=0`，GitHub API、SCIM、Copilot 地址指向本机不可达端口，`GHCP_RELEASE_LINE=multi`；没有调用真实 GitHub、Copilot 或模型，没有使用 Docker。核对结果：

- 按第 4 节的最小变量（无 registry）启动：四个 `/healthz` 返回 `releaseLine: "multi"`，`/readyz` 返回 `storage: "sqlite"`；`default` 为 `active`、cap 等于 `POOL_MAX_ACCOUNTS`、三方就绪；全局设置为 `idle_target` 0、`lease_seconds` 172800、`paused` 0。GHE.com 变量组合（不填 API 地址和 shortcode）同样就绪，Copilot 地址推导为 `https://copilot-api.<子域>.ghe.com`。
- SSO `/metadata` 的 `entityID` 为 `<BASE_URL>/metadata`；`/enterprises/default/metadata` 返回 404。
- Console：未初始化时 `GET /api/console/setup` 返回 `initialized: false`；跨站 Origin 的初始化请求返回 403；同源初始化成功后不能再初始化。
- `PATCH /api/user-pool/settings` 带 `max_accounts` 返回 409 `use_enterprise_cap`；`default` 不能改回 `draft`（409 `invalid_state_transition`）。
- 公共接口：错误 `API_KEY` 返回 401；非 hash 身份返回 403 `invalid_caller_identity`；池中无账号时返回 429 `pool_exhausted`；无作用域的 `/api/user-pool/summary` 返回 400 `enterprise_scope_required`。
- GHE.com 下 `COPILOT_API_BASE_URL` 指向其他子域时 Proxy 拒绝启动；`ENTERPRISE_SHORTCODE` 被忽略并打印 warning。同一个 SQLite 库上启动第二个 Proxy 时启动失败（`Another Proxy owns the SQLite user pool`）。
- 第 10 节：只写新 GHE.com 企业的 registry，重启三个服务后新企业为 `draft`，`default` 的 cap 和状态不变；缺签名私钥时 Blockers 为 `sso:enterprise_secret_unconfigured:sso.signingKey`，Activate 返回 409 `enterprise_not_ready`；补文件并只重启 SSO 后就绪，Activate 成功。registry 路径不存在时三个服务都无法启动。

未在本机核对（只按代码和文档整理）：Compose 叠加文件与 digest 镜像的组合，Rancher 清单，真实开户、浏览器登录与推理，LiteLLM Hook。MySQL 的两种迁移方式（含第 3.1 节方式 A 的权限清单）和 `deploy/kubernetes/` 清单另在本地 kind 集群上用 mock 验证过，见 [其 README 第 9 节](../deploy/kubernetes/README.md#9-在-kind-上验证了什么)。
