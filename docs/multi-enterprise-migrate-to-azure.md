# 执行手册：单企业版迁移到 Azure 上的多企业版

本手册把[迁移指南：单企业版 → 新环境中的多企业版](multi-enterprise-migrate-to-new-environment.md)落到一个具体场景，可以照着执行：

- **原环境**：单企业版。部署在 Rancher / Kubernetes 或 Docker Compose 上，Proxy 多副本，数据库是任意的 MySQL（例如其他云厂商的托管 MySQL）。
- **新环境**：Azure，用本仓库的 [`deploy/azure`](../deploy/azure/README.md)（azd + Bicep）部署多企业版 r4（`multi-ea1a29e-amd64-r4`）。

迁移指南讲原理和通用步骤，[`deploy/azure` README](../deploy/azure/README.md) 第 8.7 节讲 Azure 侧的恢复命令，本手册把两者串成一次迁移的完整清单。文中的主机名、账号、PVC 名都是占位值。

## 1. 先确认原环境的版本

```bash
kubectl --context <原集群 context> -n <namespace> get pods -o custom-columns=POD:.metadata.name,IMAGE:.spec.containers[*].image,IMAGEID:.status.containerStatuses[*].imageID
docker image inspect <镜像> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

第二条命令读取 `build-images.mjs` 构建的镜像中记录的源码提交。其他判断方法见迁移指南第 1.1 节。

| 原环境 | 做法 |
| --- | --- |
| 单企业版 r4，或 `bf38374` 一类 r4 之前的 MySQL 账号池版本 | 按本手册直接迁移到 r4。对 `bf38374` 的数据，直接迁移与先经 r4 中转再迁移，得到的表结构和数据逐字相同（第 11 节），Azure 上也实测过直接迁移 |
| 更早的版本，或来源不明（没有对应源码提交）的镜像 | 先把备份恢复到一个隔离的临时库，与 r4 的表结构比对，按迁移指南第 1.2 节决定是否需要经 r4 中转 |
| PostgreSQL / Redis 的旧版 | 没有迁移路径（迁移指南第 1.2 节） |

**流式与非流式请求的超时**：

- r4 之前的版本中，**非流式**请求如果上游超过约 300 秒才返回响应头，会以 502 失败，即使 `POOL_INFERENCE_TIMEOUT_SECONDS=600` 也一样。原因是 Node 内置 fetch 的默认响应头超时为 300 秒。
- **流式**请求不受影响，因为响应头立即返回。
- r4 中两类请求都按 `POOL_INFERENCE_TIMEOUT_SECONDS` 执行（[推理超时验证报告](user-pool-inference-timeout-validation.md)“非流式 300 秒上限”一节）。迁移后，长时间的非流式请求可以运行到设定的时限，**LiteLLM 和业务客户端的超时要覆盖它**。

## 2. 为什么要迁移数据，而不是在新环境重新开户

同一个 GitHub 企业只能有一个 SAML 身份提供方，新环境接管的就是原来的池账号。如果不迁移数据：

| 后果 | 原因 |
| --- | --- |
| 新环境开出的前 N 个账号（N 是原环境开过的账号数）全部以 SCIM 409 失败，需要人工处理，还占用 cap | 池账号名按固定字典从头取名（`aaliyah.abbott00`、`aaron.abernathy00`……），空库从第一个开始取，与 GitHub 上已有的用户重名 |
| 删除旧用户也不能解决 | EMU 删除（停用）用户后用户名仍被占用；席位到账期末才释放，期间重复计费 |
| 所有调用方被重新分配账号 | 调用方与账号的绑定（租约）保存在 MySQL 中 |
| 已有池账号无法再登录 | SSO 用户（密码哈希、SCIM ID、席位状态）保存在 SSO 的 SQLite 中 |

迁移数据后，账号、席位、SSO 用户和租约都保留，下一个新账号接着原来的序号取名。

## 3. 要迁移的数据

| 服务 | 数据位置 | 内容 |
| --- | --- | --- |
| Proxy | MySQL | 池账号、Copilot 凭据、调用方租约、账号池设置（含发号序号、暂停状态）、请求统计 |
| SSO | SQLite 文件 `sso.sqlite`、`sso.sqlite-wal`、`sso.sqlite-shm`，以及 `sso-user-events.log`，在 SSO 的数据卷中 | SSO 用户 |
| Login | SQLite 文件 `login.sqlite`、`-wal`、`-shm`，在 Login 的数据卷中 | 自动登录任务记录 |
| Console | `admins.json`，在 Console 的数据卷中 | Console 管理员账号 |

SQLite 是服务内嵌的数据库，整个库就是磁盘上的文件。旧版本停止时不会把 `-wal` 合并回主文件，**最新数据甚至全部数据可能都在 `-wal` 中**：主文件可能只有 4 KB，三个文件必须一起复制。

## 4. 需要准备的信息与权限

### 4.1 Azure

| 项目 | 说明 |
| --- | --- |
| 订阅、租户、地域 | 部署者需要订阅上的 Owner，或 Contributor + User Access Administrator |
| 网段 | VNet（一个 /24 即可）以及 AKS 的 Service / Pod CIDR，不能与 LiteLLM、公司内网、对等网络重叠（README 第 3.2 节） |
| 复用已有 VNet / AKS | 例如与 LiteLLM 共用（README 第 9 节） |
| 规格 | MySQL SKU 与高可用、AKS 节点规格（有默认值） |
| 订阅中的成本自动化 | 如果订阅有定时停止资源、把未挂载的磁盘降级之类的策略，把本部署的资源组和 AKS 节点资源组排除在外：被从 `Premium_ZRS` 降级为 `Standard_LRS` 的数据盘，再也挂不到可用区中的节点上（README 第 12 节） |

### 4.2 公网暴露（可选，App Gateway WAF_v2）

| 项目 | 说明 |
| --- | --- |
| LiteLLM 的位置 | 推荐把 LiteLLM 放进同一个 VNet：Proxy 不需要对外。LiteLLM 在其他地方时，Proxy 经 App Gateway 对外，需要准备下面几项 |
| LiteLLM 的出口 IP | 作为 Proxy 的来源允许列表（`proxyAllowedSourceCidrs`）。要填 App Gateway 实际看到的来源地址：经代理、VPN 或 Global Secure Access 出网时，往往不是本机查到的公网 IP |
| Proxy 的域名与 TLS 证书 | PFX（不带密码）或 PEM，写入 Key Vault（README 第 5.2 节），DNS 指向 `APPGW_PUBLIC_IP` |
| 签发 LiteLLM 客户端证书的 CA | 强烈建议开启双向 TLS。Proxy 用一个共享的 `API_KEY` 校验调用方，然后直接信任 `X-User-Identity`：持有这个 key 的人可以冒用任何身份（[公网访问设计](../deploy/azure/public-access-design.md)第 4 节） |
| Console 的域名、证书与管理员出口网段 | Console 对外时只放行管理员网段；也可以不对外，经 VPN 访问内部负载均衡 |
| SSO | 通常不需要对外：池账号的 SAML 登录在集群内 Login 的浏览器中完成 |

### 4.3 GitHub 企业

| 项目 | 说明 |
| --- | --- |
| 企业 owner | 切换当天修改 SAML 的 Sign on URL 与 Issuer |
| IP 允许列表 | 如果企业启用了，加入部署输出的 `NAT_EGRESS_IP` |

### 4.4 原环境的配置、机密与数据

| 项目 | 说明 |
| --- | --- |
| 四个服务的全部配置 | ConfigMap 与环境变量，第 5 节的项目必须相同 |
| `SSO_DEFAULT_USER_PASSWORD` | **必须原样保留**：每个池账号的 SSO 密码就是它 |
| SAML 签名证书与私钥 | 建议沿用，GitHub 侧就不用更换证书 |
| SCIM token、Copilot 席位 PAT | 沿用 |
| `API_KEY`、`INTERNAL_API_TOKEN`、`SESSION_SECRET` | 可以使用新值；更换 `API_KEY` 时同步 LiteLLM |
| MySQL 访问 | 能执行 `mysqldump` 的账号，以及能连上原 MySQL 的机器 |
| 数据卷访问 | 读取 SSO、Login、Console 数据卷的权限 |
| 维护窗口与 LiteLLM 运维 | 切换当天修改 `GHCP_POOL_API_BASE`（及 `GHCP_POOL_API_BASES`）与 `GHCP_PROXY_API_KEY` |

## 5. 必须与原环境相同的配置

| 原环境变量 | Azure 部署（azd 环境） |
| --- | --- |
| `ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`（GHE.com 为子域） | `GHCP_ENTERPRISE_SLUG`、`GHCP_ENTERPRISE_SHORTCODE`（`GHCP_GHE_SUBDOMAIN`）、`GHCP_GITHUB_HOSTING` |
| `POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_WARMUP_MODEL` | `GHCP_POOL_ACCOUNT_EMAIL_DOMAIN`、`GHCP_POOL_WARMUP_MODEL` |
| `PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` | 与默认值（300、5、5、5、30、120）不同的，写进 `GHCP_PROXY_CONFIG_OVERRIDES`。它们属于账号池配置指纹，不同时 Proxy 以 `Pool configuration differs between Proxy replicas` 拒绝启动 |
| `POOL_INFERENCE_TIMEOUT_SECONDS`（设置过时） | `GHCP_PROXY_CONFIG_OVERRIDES`，例如 `{"POOL_INFERENCE_TIMEOUT_SECONDS":"600"}` |
| `GITHUB_API_BASE_URL`（经出口网关时） | `GHCP_GITHUB_API_BASE_URL` |

**不要**设置 `GHCP_CONFIG_APPROVED`：数据恢复之前，应用不能启动。空库启动后一旦开池，就会在 GitHub 上新开账号。

## 6. 迁移前准备（维护窗口之前）

1. **部署基础设施**（README 第 4 节）：
   - 按第 5 节设置 azd 环境；
   - 写入第 4.4 节的机密。**`ghcp-sso-default-user-password` 必须在第一次 `azd provision` 之前写入**，否则 postprovision 会随机生成一个，已有池账号全部无法登录（命令见 README 第 8.7 节）；
   - 执行 `azd provision`，应用停在启动门禁处，不会启动。
2. **公网入口**（如需要）：
   - 证书写入 Key Vault，设置 `GHCP_PUBLIC_ACCESS` 后重新执行 `azd provision`（README 第 7 节）；
   - 配置 DNS；
   - 来源允许列表按实际的出口地址填写。
3. **演练恢复**（推荐）：
   - 用一份原环境的备份（原环境不停机也可以）运行 `Restore-GhcpData.ps1`，核对表数、行数、触发器和文件，并记录耗时；
   - **演练时不要批准、也不要启动应用**：新旧两套同时运行，会同时修改 GitHub 上的用户和席位；
   - 正式迁移时用 `-ReplaceExistingData` 覆盖演练数据。
4. **准备 LiteLLM 的切换**：
   - 新 Proxy 的地址：同一 VNet 时用内部地址，否则用公网域名；
   - 新的 `API_KEY`：Key Vault 中的 `ghcp-proxy-api-key`；
   - 业务客户端与 LiteLLM 的超时（第 1 节）。

## 7. 迁移当天

| 步骤 | 操作 |
| --- | --- |
| 1 | 原 Console → User pool：**暂停预热**，等待 Login Tasks 中没有运行中的任务 |
| 2 | 停止原环境的**全部四个服务**，所有 Proxy 副本都要停（Kubernetes 缩到 0，确认旧 Pod 全部退出） |
| 3 | 备份 MySQL（7.1） |
| 4 | 复制 SSO / Login / Console 数据卷中的文件（7.2） |
| 5 | 核对备份：`proxy.sql` 中有 ``TRIGGER `user_pool_credential_fence` ``；`sso/` 中有 `sso.sqlite` 与 `sso.sqlite-wal` |
| 6 | `pwsh ./hooks/Restore-GhcpData.ps1 -BackupDir <备份目录>`；演练过时加 `-ReplaceExistingData`（README 第 8.7 节） |
| 7 | `azd env set GHCP_CONFIG_APPROVED true`；`azd hooks run postprovision`。Proxy 把数据迁移为多企业结构，账号池保持暂停 |
| 8 | 按第 9 节验证，全部通过后再继续 |
| 9 | GitHub 企业 SAML：Sign on URL 改为 `<新 SSO 地址>/sso`，Issuer 改为 `<新 SSO 地址>/metadata`；沿用原证书时不用改证书 |
| 10 | LiteLLM 指向新 Proxy 并换成新 key；用一个已有调用方的 key 发请求，确认它落在原来的账号上 |
| 11 | 新 Console → Pool overview：**取消暂停预热**，观察补号。新账号经 SAML 登录成功，说明 GitHub 已指向新 SSO |

### 7.1 备份 MySQL

```bash
mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces \
  -h <原 MySQL 主机> -u <账号> -p <库名> > proxy.sql
```

**必须带 `--triggers`**：账号池依赖触发器 `user_pool_credential_fence`。用只有库级权限的账号导出时，可能提示缺少 PROCESS 权限，加 `--no-tablespaces` 即可。

### 7.2 复制数据卷

**Kubernetes / Rancher**：四个服务缩到 0 之后，用一个临时 Pod 同时挂载三个 PVC，再复制出来（PVC 名以原环境为准）：

```bash
kubectl --context <原集群 context> -n <namespace> run ghcp-backup --restart=Never --image=busybox:1.36 \
  --overrides='{"spec":{"containers":[{"name":"b","image":"busybox:1.36","command":["sleep","3600"],"volumeMounts":[{"name":"sso","mountPath":"/sso"},{"name":"login","mountPath":"/login"},{"name":"console","mountPath":"/console"}]}],"volumes":[{"name":"sso","persistentVolumeClaim":{"claimName":"<SSO PVC>"}},{"name":"login","persistentVolumeClaim":{"claimName":"<Login PVC>"}},{"name":"console","persistentVolumeClaim":{"claimName":"<Console PVC>"}}]}}'
kubectl --context <原集群 context> -n <namespace> cp ghcp-backup:/sso ./backup/sso
kubectl --context <原集群 context> -n <namespace> cp ghcp-backup:/login ./backup/login
kubectl --context <原集群 context> -n <namespace> cp ghcp-backup:/console ./backup/console
kubectl --context <原集群 context> -n <namespace> delete pod ghcp-backup
```

**Docker Compose**：服务停止后，用一个不联网的临时容器复制卷的全部内容（卷名以 `docker volume ls` 为准）：

```bash
docker run --rm --network none -v <项目>_sso-data:/from/sso:ro -v <项目>_login-data:/from/login:ro -v <项目>_console-data:/from/console:ro \
  -v "$PWD/backup:/to" node:22-bookworm-slim sh -c 'for s in sso login console; do mkdir -p /to/$s; cp -a /from/$s/. /to/$s/; done'
```

备份目录整理为：

```text
backup/
├── proxy.sql
├── sso/        sso.sqlite、sso.sqlite-wal、sso.sqlite-shm、sso-user-events.log
├── login/      login.sqlite、login.sqlite-wal、login.sqlite-shm
└── console/admins.json
```

备份中有 Copilot token、密码哈希等敏感数据，要放在加密的位置，迁移稳定后按保留策略处理。

## 8. 回退

原环境的数据在整个过程中没有被修改，回退不需要恢复任何东西：

1. 停止新环境：把四个 Deployment 缩到 0。
2. GitHub SAML 改回原 SSO 地址；LiteLLM 改回原 Proxy 和原 key。
3. 把原环境的四个服务恢复到原来的副本数，在原 Console 中取消暂停预热。

新环境运行期间新开的账号、建立的租约只存在于新库中，原环境不知道它们。所以第 9 节验证通过之前不要取消暂停预热，把这个窗口缩到最小。

## 9. 验证清单

| 检查 | 期望 |
| --- | --- |
| 四个服务的 `/healthz` | `releaseLine: "multi"` |
| Proxy 日志 | 没有 `Pool configuration differs`、`Unsupported MySQL schema`、`enterprise_identity_changed` |
| `schema_migrations` | 原有记录（例如 3 条），加上 `enterprise-v1/01`–`08` |
| Console | 原管理员可以登录 |
| Pool overview | 只有 `default` 且为 `active`；账号数与 Leased 和原环境相同；预热处于暂停 |
| Pool members | 已有调用方仍绑定原账号（按 key hash 抽查） |
| SSO Users | 用户数与原环境相同 |
| 切换后 | 已有调用方落在原账号；新调用方分到空闲账号；取消暂停后补号成功 |

## 10. 迁移之后

- 原环境在新环境稳定运行至少一个租约周期（默认 48 小时）后再删除，在此之前不要启动。
- 要接入更多 GitHub 企业时，按 README 第 8.6 节添加，不需要再迁移数据。
- 非流式请求现在可以运行到 `POOL_INFERENCE_TIMEOUT_SECONDS`（第 1 节）。

## 11. 已验证的范围

| 范围 | 结果 |
| --- | --- |
| 本地演练（迁移指南第 12 节） | 合成数据，`bf38374` 单企业版（MySQL + 双 Proxy）：停机、备份、恢复、迁移、回退；直接迁移与经 r4 中转的结果逐字相同 |
| Azure（README 第 12 节） | 同一份合成备份（数据在 `-wal` 中）用 `Restore-GhcpData.ps1` 恢复到 Azure MySQL 8.4 与 AKS 数据盘，启动 r4 后 17 项核对全部通过：迁移记录、账号与租约保留、发号序号接续、SSO 用户、Console 原管理员登录、预热保持暂停。另外验证了 550 秒的非流式请求、App Gateway 公网入口、WAF、来源允许列表与证书 |
| 未验证 | 真实 GitHub 企业的 SAML 切换与补号（测试中用 mock 代替）；7.2 节的 Kubernetes 备份命令（按原理编写；Compose 的方法在本地演练中使用过）；大数据量下的耗时 |
