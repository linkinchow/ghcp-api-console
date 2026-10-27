# Kubernetes 全新部署：多企业版 multi-4922a4a-amd64-r2

本目录是多企业版 `multi-4922a4a-amd64-r2` 在 Kubernetes 上**全新部署**的清单：四个服务（Proxy、SSO、Login、Console）+ 客户自备的外部 MySQL（例如 Azure Database for MySQL 灵活服务器）。用 Kustomize 组织：`base/` 加一个 overlay，按需叠加 `components/`。

- 部署前先读 [多企业版新部署指南](../../docs/multi-enterprise-new-deployment-guide.md)：变量含义（第 4 节）、GitHub 侧 SAML / SCIM / 席位配置（第 6 节）、开池（第 7 节）、LiteLLM（第 8 节）、上线验收清单（第 9 节）。本文只写 Kubernetes 相关的部分。
- 从单企业版 r4 **升级**不要用本目录，见 [多企业版升级指南](../../docs/multi-enterprise-upgrade-guide.md) 和 [`deploy/user-pool-mysql-customer/`](../user-pool-mysql-customer/README.md)。
- 文件里的主机名、slug、域名都是 `REPLACE_*` 占位值。实际值只写在私有副本里，不要提交到任何仓库、工单或截图。

## 1. 目录

```text
deploy/kubernetes/
├── base/                     四个服务；不能单独 apply（企业变量来自 overlay）
│   ├── kustomization.yaml    namespace ghcp、公共标签、镜像 digest
│   ├── config.yaml           ConfigMap：ghcp-common、ghcp-enterprise、ghcp-{proxy,sso,login,console}-config
│   ├── proxy.yaml            Deployment（2 副本）、Service、PodDisruptionBudget
│   ├── sso.yaml              Deployment（1 副本，Recreate）、Service、PVC
│   ├── login.yaml            Deployment（1 副本，Recreate）、Service、两个 PVC
│   └── console.yaml          Deployment（1 副本，Recreate）、Service、PVC
├── overlays/
│   ├── github-com/           github.com 上的 EMU 企业
│   └── ghe-com/              GHE.com（数据驻留）企业
├── components/               可选组件，在 overlay 的 components: 中启用
│   ├── ingress-sso/          SSO 的 Ingress（浏览器可达，SAML 必需）
│   ├── ingress-console/      Console 的内部 Ingress
│   ├── mysql-dba-schema/     DBA 预建表，MYSQL_AUTO_MIGRATE=false
│   └── network-policy/       默认拒绝 + 最小放行
├── secret.example.yaml       Secret 与 MySQL CA 的占位格式（不被任何 kustomization 引用）
└── package.test.mjs          静态检查：渲染每个 overlay 并断言不变量
```

| 资源 | 名称 | 说明 |
| --- | --- | --- |
| Service（ClusterIP） | `ghcp-proxy:3000`、`ghcp-sso:7001`、`ghcp-login:7003`、`ghcp-console:7004` | 都不对集群外直接开放；SSO、Console 需要时经 Ingress |
| PVC（RWO） | `ghcp-sso-data`、`ghcp-login-data`、`ghcp-login-logs`、`ghcp-console-data` | 使用默认 StorageClass；需要指定时在 overlay 中补 `storageClassName` |
| Secret（运维创建） | `ghcp-internal`、`ghcp-proxy`、`ghcp-sso`、`ghcp-sso-saml` | 第 3 节 |
| ConfigMap（运维创建） | `ghcp-mysql-ca` | MySQL 服务器证书的 CA（公开证书） |

## 2. 设计说明

| 项目 | 取值 | 原因 |
| --- | --- | --- |
| Proxy 副本与更新 | 2 个，`RollingUpdate`（`maxSurge: 1`、`maxUnavailable: 0`），PDB `minAvailable: 1`，跨节点分散（`ScheduleAnyway`） | 无状态，租约在 MySQL，任何副本都能服务同一个调用方；Service 不需要会话粘滞 |
| SSO、Login、Console | 各 1 个，`strategy: Recreate` | 数据在 SQLite / JSON 文件中，不能被两个 Pod 同时打开；`RollingUpdate` 会短暂出现两个 Pod |
| 持久卷 | SSO `/data`；Login `/data`、`/logs`；Console `/data`（`admins.json`）；Proxy 无（MySQL） | Console 的管理员文件丢失即回到“未初始化”。只用 RWO 块存储（例如 Azure Disk），不用 NFS / Azure Files：SQLite 的文件锁在共享文件系统上不可靠 |
| 探针 | Proxy：startup / liveness 用 `/healthz`，readiness 用 `/readyz`（会 ping MySQL）；其他三个都用 `/healthz` | `/healthz` 不访问数据库，MySQL 短暂故障时只摘流量、不重启全部副本；Proxy 迁移完成后才监听，startupProbe 约 300 秒 |
| 停止 | 四个服务 `terminationGracePeriodSeconds: 45` = preStop 10 秒 + `SHUTDOWN_TIMEOUT_MS` 25 秒 + 资源释放 5 秒 + 余量 5 秒 | preStop 等 Endpoint 摘除传播；进程收到 SIGTERM 后排空请求，最长 25 秒后强制关闭连接，再最多 5 秒退出。改大 `SHUTDOWN_TIMEOUT_MS` 时同步改大宽限期 |
| 启动命令 | 不覆盖 | 镜像以 Tini 为 PID 1 转发 SIGTERM；覆盖命令会让进程收不到信号 |
| 安全上下文 | `runAsNonRoot`、UID/GID 1000（镜像内的 `node` 用户）、`fsGroup: 1000`、根文件系统只读、去掉全部 capability、禁止提权、`seccompProfile: RuntimeDefault`、不挂载 ServiceAccount token | 镜像没有声明 `USER`，默认是 root；四个服务都只写 `/data`、`/logs` 和 `/tmp`（emptyDir），以 1000 运行验证可用 |
| Login 的 Chromium | `/dev/shm` 为 512 MiB 内存卷；`HOME=/tmp`；内存 limit 2 GiB | 容器默认 `/dev/shm` 只有 64 MiB。默认 Login 并发 1；在 Console 调高并发时每个浏览器约加 300–500 MiB（内存卷也计入 limit） |
| 资源 | Proxy 250m / 384Mi（limit 2 / 1Gi），SSO 100m / 192Mi（1 / 512Mi），Login 500m / 1Gi（2 / 2Gi），Console 50m / 128Mi（500m / 384Mi） | 起点值，按实际负载调整；不是性能测试结论 |
| 首次启动门禁 | 每个 Pod 的 init 容器 `require-approved-config` | 沿用迁移模板的人工门禁做法：`GHCP_CONFIG_APPROVED` 不是 `"true"`，或任何环境变量（含 Secret）仍含 `REPLACE_` 时拒绝启动。企业身份字段和池配置指纹有数据后不能改，误 apply 一份没填好的配置代价很高 |
| SSO 对外地址 | ConfigMap 中只写一次 `SSO_PUBLIC_BASE_URL` | SSO 的 `BASE_URL` 与 Login 的 `SSO_URL`（`<地址>/login`）由 Kubernetes 的 `$(VAR)` 展开生成，保证同源 |
| MySQL | `MYSQL_SSL_MODE=verify-ca`，CA 挂到 `/run/mysql-ca/ca.pem` | 托管 MySQL 默认要求 TLS；`verify-ca` 校验证书链，不校验主机名 |
| 错误诊断 | 关闭（`PROXY_ERROR_DIAGNOSTICS_ENABLED=false`，开启时脱敏） | 代码默认开启且不脱敏 |

## 3. 前提

### 3.1 集群

- Kubernetes 1.25 及以上（PodDisruptionBudget `policy/v1`、`seccompProfile`）。kubectl 自带的 kustomize（v5）即可渲染。
- 一个支持 RWO 的默认 StorageClass（AKS：`managed-csi` 等 Azure Disk 类）。
- 使用 Ingress 组件时需要 Ingress 控制器和 TLS 证书流程；使用 NetworkPolicy 组件时需要支持它的 CNI（AKS：Azure NPM、Calico 或 Cilium）。
- 节点能拉取第 2.1 节的镜像（Docker Hub 公开仓库，或同步到自己的仓库，见第 4 节）。

### 3.2 外部 MySQL

DBA 准备（详见新部署指南第 3.1 节）：

1. **专用空库**，字符集 `utf8mb4`：

   ```sql
   CREATE DATABASE ghcp_proxy CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   ```

2. **Proxy 账号**，按迁移方式授权（`<来源网段>` 为 AKS 节点 / Pod 出口地址段）：

   - 方式 A（默认，`MYSQL_AUTO_MIGRATE=true`，Proxy 自己建表）：

     ```sql
     CREATE USER 'ghcp_proxy'@'<来源网段>' IDENTIFIED BY '<强密码>' REQUIRE SSL;
     GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER
       ON `ghcp_proxy`.* TO 'ghcp_proxy'@'<来源网段>';
     ```

     这组权限在 kind 验证中足够完成全新库的全部迁移（第 9 节）。开启二进制日志时，非 SUPER 账号创建触发器还需要服务器参数 `log_bin_trust_function_creators=ON`（kind 验证用的就是 ON；Azure 灵活服务器在“服务器参数”中设置），由 DBA 确认；不能开启时用方式 B。
   - 方式 B（启用 `components/mysql-dba-schema`）：DBA 用管理员账号执行**本版本源码**中的 `scripts/proxy-mysql-initial.sql`，运行账号只要：

     ```sql
     CREATE USER 'ghcp_proxy'@'<来源网段>' IDENTIFIED BY '<强密码>' REQUIRE SSL;
     GRANT SELECT, INSERT, UPDATE, DELETE ON `ghcp_proxy`.* TO 'ghcp_proxy'@'<来源网段>';
     GRANT TRIGGER ON `ghcp_proxy`.`proxy_accounts` TO 'ghcp_proxy'@'<来源网段>';
     ```

3. **utf8mb4 会话**：执行脚本的会话必须是 utf8mb4，否则 CHECK 约束字面量带 `_latin1` 前缀，`MYSQL_AUTO_MIGRATE=false` 时 Proxy 以 `Unsupported MySQL schema: proxy_enterprises check constraints` 拒绝启动。main 上的脚本开头已有 `SET NAMES utf8mb4`；r2 源码提交 `4922a4a` 中的脚本没有这一行，用它时加 `mysql --default-character-set=utf8mb4`（加上总是无害）。库名不是 `ghcp_proxy` 时，从注释 `-- If the database already exists, start here.` 之后开始执行。
4. **TLS**：拿到服务器证书的 CA（Azure Database for MySQL 使用其文档列出的根 CA，可把多个 PEM 拼在一个文件里）。
5. **连接数**：每个 Proxy 最多 `MYSQL_CONNECTION_LIMIT`（默认 10）个连接；2 个副本加滚动更新时多出的 1 个约 30 个，再加运维余量，要小于 `max_connections`。
6. **网络**：所有 Proxy 副本访问同一个写主库（不能用只读副本）；私有访问时允许 AKS 子网到 MySQL 3306。

## 4. 填写配置

复制 overlay 到私有仓库（保留对本仓库 `base/`、`components/` 的引用，或连同它们一起复制），然后替换所有 `REPLACE_*`：

| 位置 | 需要填写 |
| --- | --- |
| overlay `kustomization.yaml` | `namespace`（默认 `ghcp`）；需要的 `components`；镜像同步到自己的仓库时的 `images`（只改 `newName`，digest 不变） |
| overlay `enterprise.yaml` | github.com：`ENTERPRISE_SHORTCODE`（必须填写实际值：留空时代码用内置 `octo` 且不报错），`SP_ENTITY_ID` 等 URL 中的 slug；GHE.com：`GITHUB_BASE_URL` 的子域和 URL 中的 slug |
| `base/config.yaml`（在 overlay 中用补丁覆盖） | `ENTERPRISE_SLUG`、`SSO_PUBLIC_BASE_URL`（用 `ingress-sso` 时由组件设置）、`POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_WARMUP_MODEL`；按批准值核对 `POOL_MAX_ACCOUNTS`、`CALLER_LEASE_TTL_SECONDS` 等 |
| `components/*` | Ingress 的主机名、`ingressClassName`；NetworkPolicy 中 LiteLLM 与 Ingress 控制器的 namespace、LiteLLM 的 Pod 标签、MySQL 地址段 |

在 overlay 中覆盖 base 的 ConfigMap 值，例如 `overlays/github-com/enterprise.yaml` 中追加：

```yaml
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ghcp-enterprise
data:
  ENTERPRISE_SLUG: contoso
  SSO_PUBLIC_BASE_URL: https://sso.contoso.example.com
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ghcp-proxy-config
data:
  POOL_ACCOUNT_EMAIL_DOMAIN: pool.contoso.example.com
  POOL_WARMUP_MODEL: <账号可用的模型>
```

**首次启动前定下来、之后不能改的值**（新部署指南第 4.7 节）：`GITHUB_BASE_URL`、`ENTERPRISE_SLUG`、`ENTERPRISE_SHORTCODE`、`POOL_ACCOUNT_EMAIL_DOMAIN`；以及进入共享配置指纹的 `POOL_WARMUP_MODEL`、`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS`。

**SSO 对外地址**：`SSO_PUBLIC_BASE_URL` 必须同时能被 Login Pod 内的 Chromium 和管理员浏览器访问（GitHub 服务端从不主动连接 SSO）。常见做法是 `components/ingress-sso` 的内网 Ingress 主机名；此时 Login Pod 也要能解析该主机名（例如 AKS 关联了私有 DNS 区域），否则在 overlay 中给 `ghcp-login` 补 `hostAliases` 指向 Ingress 的内网地址。只用集群内地址（`http://ghcp-sso.<namespace>.svc.cluster.local:7001`）时 Login 可以工作，但管理员无法在自己的浏览器里完成 GitHub 的 SAML 登录（[网络说明](../../guidance/network-deployment.md) 第 2 节）。

### 4.1 Secret 与 CA

格式见 [`secret.example.yaml`](secret.example.yaml)。推荐直接用 kubectl 创建（不落盘），或用外部密钥管理（Azure Key Vault + Secrets Store CSI / External Secrets）同步出同名、同键的 Secret：

```bash
NS=ghcp
kubectl create namespace $NS
kubectl -n $NS create secret generic ghcp-internal \
  --from-literal=INTERNAL_API_TOKEN="$(openssl rand -base64 48 | tr -d '\n')" \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
kubectl -n $NS create secret generic ghcp-proxy \
  --from-literal=API_KEY="$(openssl rand -base64 48 | tr -d '\n')" \
  --from-literal=MYSQL_URL='mysql://ghcp_proxy:<URL 编码后的密码>@<服务器>.mysql.database.azure.com:3306/ghcp_proxy'
kubectl -n $NS create secret generic ghcp-sso \
  --from-literal=SCIM_TOKEN='<SCIM token>' \
  --from-literal=GITHUB_COPILOT_SEAT_PAT='<席位 PAT>' \
  --from-literal=SSO_DEFAULT_USER_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
kubectl -n $NS create secret generic ghcp-sso-saml \
  --from-file=idp-cert.pem=<证书文件> --from-file=idp-key.pem=<私钥文件>
kubectl -n $NS create configmap ghcp-mysql-ca --from-file=ca.pem=<CA 文件>
```

- 实际命令在受控终端执行，不要保存到 shell 历史或脚本仓库；`API_KEY` 只配置给 LiteLLM。
- `SSO_DEFAULT_USER_PASSWORD` 至少 16 个字符；`INTERNAL_API_TOKEN` 四个服务共用；`SESSION_SECRET` SSO 与 Console 共用。
- SAML 证书使用自己维护的证书（`scripts/gen-certs.sh` 只用于开发）。

## 5. 部署顺序与首次启动

1. **渲染并检查**（不连集群）：

   ```bash
   kubectl kustomize <私有 overlay 目录> > /tmp/ghcp.yaml
   grep -n 'REPLACE_' /tmp/ghcp.yaml   # 只应剩 init 容器脚本里检查用的字符串
   ```

2. **apply**（namespace、Secret、`ghcp-mysql-ca` 已在第 4.1 节创建）：

   ```bash
   kubectl apply -k <私有 overlay 目录>
   kubectl -n ghcp get pods
   ```

   此时所有 Pod 停在 `Init:CrashLoopBackOff`：`GHCP_CONFIG_APPROVED` 仍是 `BLOCKED`。`kubectl -n ghcp logs <pod> -c require-approved-config` 显示原因；仍有 `REPLACE_` 时列出变量名（不打印值）。
3. **核对后放行**：确认第 4 节的身份字段与指纹参数、`READY_IDLE_TARGET: "0"`，在私有 overlay 中把 `ghcp-common` 的 `GHCP_CONFIG_APPROVED` 改为 `"true"` 并重新 apply（或临时 `kubectl -n ghcp patch configmap ghcp-common --type merge -p '{"data":{"GHCP_CONFIG_APPROVED":"true"}}'`，之后同步回私有仓库），然后：

   ```bash
   kubectl -n ghcp rollout restart deployment
   for d in sso login proxy console; do kubectl -n ghcp rollout status deployment/ghcp-$d --timeout=10m; done
   ```

   两个 Proxy 副本可以同时首次启动：第一个取得迁移锁建表，另一个等待（最多 `MYSQL_MIGRATION_LOCK_WAIT_SECONDS`），kind 验证中两个都正常就绪。想更保守时先 `kubectl -n ghcp scale deployment/ghcp-proxy --replicas=1`，`/readyz` 正常后再扩回 2。
4. **健康检查**（新部署指南第 7.1 节）：

   ```bash
   for d in proxy sso login console; do
     kubectl -n ghcp exec deploy/ghcp-$d -- node -e \
       "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>r.text()).then(console.log)"
   done
   kubectl -n ghcp exec deploy/ghcp-proxy -- node -e \
     "fetch('http://127.0.0.1:3000/readyz').then(r=>r.text()).then(console.log)"
   kubectl -n ghcp logs deploy/ghcp-proxy | grep 'enterprise default'
   ```

   期望 `"releaseLine":"multi"`、`"storage":"mysql"`，日志中没有 `is not ready`、`enterprise_*` 错误。
5. **初始化 Console**（第 7.2 节）：初始化前第一个打开 Console 的人就能创建管理员，所以先只在本机访问：

   ```bash
   kubectl -n ghcp port-forward svc/ghcp-console 7004:7004
   ```

   浏览器打开 `http://127.0.0.1:7004`，**Initialize Console** 创建管理员；之后再启用 `ingress-console`。`admins.json` 在 PVC `ghcp-console-data` 上，重启和删除 Pod 都不会丢（kind 已验证）。
6. **GitHub 侧配置**（第 6 节）：Sign on URL `<SSO_PUBLIC_BASE_URL>/sso`，Issuer `<SSO_PUBLIC_BASE_URL>/metadata`，证书为 `idp-cert.pem`；`default` 使用 SSO 根路径。
7. **开池**（第 7.3–7.5 节）：Pool overview 中 `default` 为 `active`、Blockers 为 `None` 后，先把 cap 设小、Ready idle target 设 1，观察第一个账号到达 `Ready idle`，再逐步调高。
8. **上线验收**：新部署指南第 9 节的清单；另外核对 `kubectl -n ghcp get pods -o jsonpath='{..imageID}'` 与第 2.1 节的 digest 一致。

## 6. 可选组件

在 overlay 的 `components:` 中启用（顺序无关；overlay 自己的补丁最后生效）。

| 组件 | 作用 | 需要填写 |
| --- | --- | --- |
| `ingress-sso` | SSO 的 Ingress，整个前缀 `/` 转发（`default` 用根路径，以后添加的企业用 `/enterprises/<id>/...`）；把 `SSO_PUBLIC_BASE_URL` 设为 `https://<SSO 主机>` | 主机名、`ingressClassName`、TLS Secret `ghcp-sso-tls`；按控制器限制来源网段（注释中有 ingress-nginx 示例） |
| `ingress-console` | Console 的内部 Ingress；设置 `CONSOLE_PUBLIC_BASE_URL`（Console 写操作只接受同源请求） | 只在内网监听的 IngressClass、主机名、TLS Secret `ghcp-console-tls`；来源限制为管理网段 |
| `mysql-dba-schema` | `MYSQL_AUTO_MIGRATE=false`：Proxy 只读校验表结构，不做 DDL | 先由 DBA 执行初始脚本（第 3.2 节方式 B）；表结构不符合时 Proxy 处于 CrashLoopBackOff，日志给出应执行的脚本 |
| `network-policy` | 本应用 Pod 默认拒绝入站与出站；放行 DNS、服务之间必需的端口、LiteLLM → Proxy、Ingress 控制器 → SSO / Console、Proxy → MySQL、GitHub / Copilot（非私网地址的 443，排除云元数据地址） | LiteLLM 的 namespace 与 Pod 标签、Ingress 控制器的 namespace、MySQL 地址段（示例 `192.0.2.10/32` 是不可达的文档地址） |

关于 NetworkPolicy：

- 标准 NetworkPolicy 不能按域名放行。要把出站限制到 `github.com`、`api.github.com`、`api.githubcopilot.com`（GHE.com 为 `<子域>.ghe.com`、`api.<子域>.ghe.com`、`copilot-api.<子域>.ghe.com`、`auth.ghe.com`），在出口防火墙（例如 Azure Firewall 的应用规则）或 CNI 的 FQDN 策略（例如 Cilium）上做。
- Proxy 的业务接口和内部管理接口在同一个端口：LiteLLM 能连到 Proxy，也就能连到 `/api/...`（由 `INTERNAL_API_TOKEN` 保护）。不要把 `INTERNAL_API_TOKEN` 配给 LiteLLM。
- kubelet 探针来自节点本身，常见 CNI 不受这些策略影响。

## 7. LiteLLM 访问 Proxy

Proxy 只通过 ClusterIP Service 提供服务，不经 Ingress、不对最终用户开放。LiteLLM 的环境变量（新部署指南第 8 节）：

| LiteLLM 位置 | `GHCP_POOL_API_BASE` |
| --- | --- |
| 同一个 namespace | `http://ghcp-proxy:3000` |
| 另一个 namespace | `http://ghcp-proxy.<namespace>.svc.cluster.local:3000` |
| 另一个集群 / 集群外 | 需要内部负载均衡（例如在 overlay 中加一个 `service.beta.kubernetes.io/azure-load-balancer-internal: "true"` 的 LoadBalancer Service）并限制来源；不建议 |

- `GHCP_POOL_API_BASES` 必须逐字包含同一个地址（scheme、host、端口、路径精确匹配）；`GHCP_PROXY_API_KEY` 为 Secret `ghcp-proxy` 中的 `API_KEY`。
- Service 不需要会话粘滞：同一个调用方的租约保存在 MySQL，两个副本都会把它路由到同一个池成员（kind 已验证）。
- 启用 `network-policy` 时，把 LiteLLM 的 namespace 和 Pod 标签填进 `ghcp-proxy` 策略。

## 8. 升级与回滚

**同一多企业版本线内的新版本**：

1. 读新版本的发布说明与升级指南：是否有数据库迁移、是否要求先停机（例如单企业 → 多企业那样的不兼容迁移必须 `Recreate` 并一次替换四个服务）。
2. 备份：MySQL 做一致性备份（`mysqldump --single-transaction` 或托管服务的时间点还原）；SSO、Login、Console 的 PVC 做快照（CSI `VolumeSnapshot` / Azure Disk 快照）。一致的 SQLite 备份需要先把对应 Deployment 缩到 0（或用支持 SQLite 的备份方式）。同时保存当前的镜像 digest 和渲染出的清单。
3. 在 base 或 overlay 的 `images:` 中换成新 digest，`kubectl apply -k`。Proxy 逐个替换，始终有就绪副本（kind 验证：每个新请求新建连接时全部成功；r2 上复用长连接的网关在旧 Pod 停止时可能有个别请求被断开，r3 已修复，见第 10.1 节）；SSO、Login、Console 是 `Recreate`，各有几十秒不可用：期间新账号开户和 Console 暂停，已有调用方的推理不受影响。
4. `kubectl -n ghcp rollout status ...`，再按第 5 节第 4 步检查健康与日志。

**回滚**：

- 只改了配置或镜像、新版本没有做数据库迁移：`kubectl -n ghcp rollout undo deployment/<名称>`，或 apply 之前保存的清单。
- 新版本已经迁移了 MySQL 或 SQLite 的表结构：旧镜像可能无法使用新结构（单企业版 r4 就不能打开多企业版的数据库），只能停止全部四个服务、恢复第 2 步的备份、用旧 digest 启动。数据库恢复不会撤销 GitHub 侧的变化（SCIM 用户、席位）。
- 第 4 节的身份字段有数据后不能改；改错了的配置只能改回原值。

**修改配置**：ConfigMap / Secret 变更不会自动重启 Pod，改完后 `kubectl -n ghcp rollout restart deployment/<名称>`。

## 9. 在 kind 上验证了什么

验证脚本：[`tests/kubernetes/kind-e2e.mjs`](../../tests/kubernetes/README.md)（可重复执行）；静态检查：`node --test deploy/kubernetes/package.test.mjs`。

环境：kind v0.33（单节点，Kubernetes v1.37，CNI kindnet，**本版本的 kindnet 执行 NetworkPolicy**，已用拒绝策略实测），kubectl v1.32；Docker Desktop，只验证功能。镜像为本地 `ghcp-release-*:multi-4922a4a-amd64-r2`（与第 2 节 digest 字节相同，`kind load` 加载，不拉 Docker Hub）。“外部” MySQL 8.4 是 kind Docker 网络上的容器（`--require-secure-transport=ON`、binlog 开启），不在任何 namespace 中；GitHub、GHE.com、SCIM、Copilot 都是集群内的 mock，没有任何真实外部调用。最终一次完整运行 35 条断言全部通过：

| 阶段 | 断言 | 结果 |
| --- | --- | --- |
| A：`overlays/ghe-com` + `network-policy`，MySQL 方式 A（只授予第 3.2 节的权限），真实 SSO + 真实 Login（Chromium）对 mock 的 GHE.com | 未放行时四个 Pod 都停在启动门禁；放行并 `rollout restart` 后全部就绪（Proxy 2 个副本同时首次启动） | 通过 |
| | 五个 Pod 的 `/healthz` 都是 `releaseLine: "multi"`；两个 Proxy `/readyz` 为 `mysql` | 通过 |
| | 以 UID 1000 运行、根文件系统只读（写 `/app` 得到 `EROFS`） | 通过 |
| | 迁移 ID 完整（11 个）；`proxy_enterprises` 只有 `default`（active、cap = `POOL_MAX_ACCOUNTS`、库存 0）；三方就绪，无阻塞项 | 通过 |
| | Proxy 到 MySQL 的会话都是 TLS（`verify-ca`，CA 来自 `ghcp-mysql-ca`） | 通过 |
| | Console：未初始化 → 跨站初始化 403 → 初始化 201 → 再次初始化 400；登录成功、错误密码 401；企业列表只有 `default` | 通过 |
| | 池从 Ready idle target 0 开到 2：经 SSO、SCIM、席位、Login 的 Chromium 设备授权和 SAML，约 30 秒得到 2 个 Ready idle 账号；GHE.com 登录名无后缀 | 通过 |
| | 同一调用方 6 个请求（`/v1/messages`、`/chat/completions`、`/responses` × JSON / SSE）交替打到两个副本，全部落在同一成员；租约在两个副本上一致；第二个调用方拿到另一个成员；错误 `API_KEY` 401，非 hash 身份 403 | 通过 |
| | SSO 根路径：`/metadata` 的 entityID 与证书正确，`/enterprises/default/metadata` 404；`/login` 错误密码 401、正确密码得到会话，`/sso` 返回 SAMLResponse，匿名重定向到 `/login` | 通过 |
| | NetworkPolicy：其他 namespace 访问不到 Proxy（Pod IP 与 Service）、SSO、Console；LiteLLM 所在 namespace 访问不到 Login；Proxy 出站到其他 namespace 被拒；对照组（放行的路径）正常 | 通过 |
| | Proxy 两次滚动更新期间持续经 Service 请求：复用长连接 755 个、每次新建连接 310 个，全部 200 | 通过（长连接见第 10.1 节：r2 之前的运行中出现过 1/1271、1/669 的连接级失败；r3 候选的重跑要求零失败并通过） |
| | 7 个被替换的容器（4 个 Proxy、SSO、Login、Console）都以退出码 0（`Completed`）结束，删除请求后 9–12 秒退出 | 通过 |
| | 重启后 Console 管理员仍可登录（`admins.json` 在 PVC 上），调用方仍落在原成员（租约在 MySQL） | 通过 |
| | 删除 SSO、Login 的 Pod：新 Pod 绑定同一个 PV，SSO 用户、Login 任务数量不变，池用户仍能登录 SSO | 通过 |
| B：`overlays/github-com` + 全部四个组件，MySQL 方式 B | DBA 在 `mysql` 客户端默认会话（latin1）执行 `scripts/proxy-mysql-initial.sql`：表齐全，CHECK 字面量只有 `utf8mb4` | 通过 |
| | 运行账号只有 DML + `proxy_accounts` 上的 TRIGGER，没有 DDL 权限 | 通过 |
| | 两个 Proxy 以 `MYSQL_AUTO_MIGRATE=false` 就绪；启动前后表结构指纹不变，Proxy 只补写了 `02-seed-default`、`08-pool-config-fingerprint` | 通过 |
| | 只有 `default` 且就绪；空池时两个副本都返回 429 `pool_exhausted` 和配置的 `Retry-After`；SSO `/metadata` 正常；两个 Ingress 被 API server 接受 | 通过 |

静态检查（`package.test.mjs`，13 项）：两个 overlay 单独渲染和叠加全部组件渲染都成功；所有容器镜像都是第 2 节的 digest；宽限期 ≥ preStop + `SHUTDOWN_TIMEOUT_MS` + 资源释放（从 `shutdown.ts` 读取）+ 余量；没有 Secret 对象和内联凭据，`secret.example.yaml` 只有占位值且不被引用；SQLite 服务 1 副本 + `Recreate` + RWO PVC；Proxy ≥ 2 副本、`caller-lease`、MySQL、PDB、探针；安全上下文；两种 GitHub 形态的变量；组件内容；启动门禁脚本的三种结果；ConfigMap 中每个变量都确实被服务读取。

**没有验证**：真实 GitHub / GHE.com / Copilot 与真实开户、推理（只用 mock）；github.com 形态的浏览器登录（mock 只实现 GHE.com 的网页流程，阶段 B 只到就绪和空池）；Ingress 的实际转发、TLS 和来源限制（kind 没有 Ingress 控制器）；Azure Database for MySQL 本身（TLS、参数、权限只在 MySQL 8.4 容器上验证）、Azure Disk、AKS 的 CNI 与多节点调度；`log_bin_trust_function_creators=OFF` 时的方式 A；性能与容量。

## 10. 已知限制

### 10.1 Proxy 停止时不让长连接客户端离开（r2 的产品行为，r3 已修复）

**r3（`multi-f43f27e-amd64-r3`，待发布）已修复**：`src/packages/shared/src/shutdown.ts`（提交 `3d6db1a`，四个服务共用）在排空期间让 SIGTERM 时正忙的 keep-alive 连接在当前响应结束后关闭（响应头尚未发出的加 `Connection: close`，已发出的如 SSE 在响应结束后关闭套接字），空闲连接立即关闭。验证方式：

- kind（`tests/kubernetes/kind-e2e.mjs`，断言已收紧为零失败）：Proxy 滚动更新期间，复用长连接的客户端 739 个请求、每个请求新建连接的客户端 539 个请求全部 200；四个旧 Proxy Pod 从 SIGTERM 到 `shutdown complete` 用时 4–39 ms，没有 `closing their connections`。
- 镜像级（`tests/image-release/shutdown-keepalive-check.mjs`，四个镜像各自 `docker stop`，r2 作对照，连续 3 次全部通过）：进行中的请求收到带 `Connection: close` 的完整响应后 0–3 ms 收到 FIN；已开始的 SSE / CSV 流完整结束后 1–16 ms 收到 FIN；空闲连接在 draining 日志后 1–13 ms 关闭；容器 1.2–4.1 秒以退出码 0 退出。r2 在同样条件下连接被继续复用约 24 秒，直到强制关闭。
- 详细记录见 [多企业版发布验证记录](../../docs/multi-enterprise-release-validation.md) r3 第 4、5 节。

仍有一个理论上的竞态：客户端恰好在服务器关闭空闲连接的瞬间写入新请求，会得到一个未收到任何响应的连接错误。上述验证中没有出现；稳妥起见，LiteLLM 可对这类错误重试（仓库示例配置为 `max_retries: 0`）。

以下是 r2（当前清单中的 digest）的情况，升级到 r3 之前仍然适用。

**现象**：Proxy 滚动更新（或节点排空）时，复用 keep-alive 长连接的网关（LiteLLM 的 HTTP 客户端就是这样）在旧 Pod 收到 SIGTERM 后仍持续通过原连接向它发送新请求，约 25 秒（`SHUTDOWN_TIMEOUT_MS`）后这些连接被强制关闭，此刻正在处理的请求以连接错误失败（客户端看到 `ECONNRESET` / socket closed）；如果是刚开始的 SSE 长流，会被截断。

**kind 中的证据**：

- 一次滚动（keep-alive 客户端，669 个请求）：旧 Pod 日志 `SIGTERM received, draining in-flight requests (up to 25000 ms)`（03:10:08.70）→ `requests still running after 25000 ms; closing their connections`（03:10:33.665）→ 客户端 `ECONNRESET`（03:10:33.683，晚 18 ms），1 个失败。另一个旧 Pod 当时没有忙碌的连接，SIGTERM 后 21 ms 就 `shutdown complete`。另一次运行中 1271 个请求有 1 个 `UND_ERR_SOCKET`，还有一次 0 失败：取决于强制关闭的瞬间连接上是否有请求。
- 同样的滚动，客户端每个请求新建连接（`Connection: close`）：0 失败。
- 用与镜像相同大版本的 Node（22.23.3）单独复现：`http.Server.close()` 只关闭**当时空闲**的连接；忙碌的 keep-alive 连接之后的响应不带 `Connection: close`，客户端继续复用，服务器一直不结束，直到 `closeAllConnections()` 强制关闭。

**为什么清单改不了**：已建立的连接经 kube-proxy 的 conntrack 固定在旧 Pod 的 IP 上，与 Endpoint 摘除、readiness 无关；preStop 只推迟 SIGTERM，期间旧 Pod 照常服务这些连接；强制关闭由进程内的 `SHUTDOWN_TIMEOUT_MS` 计时决定，加大宽限期没有作用，加大 `SHUTDOWN_TIMEOUT_MS` 只是推迟。当前清单保证这一过程有界（10 + 25 + 5 < 45 秒）且进程以退出码 0 结束（kind 已验证）。

**当时建议的产品修改（已在 r3 以等价方式实施，见本节开头）**：在 `src/packages/shared/src/shutdown.ts` 开始停止时，让之后的每个响应带 `Connection: close`（例如 `server.prependListener('request', (_req, res) => res.setHeader('Connection', 'close'))`），并调用 `server.closeIdleConnections()`。这样每个连接在当前响应结束后就关闭，客户端经 Service 重连到其他就绪副本，排空在约一个请求的时间内完成。用上述 Node 实验验证：加上这两行后 `close()` 61 ms 后就排空完毕、没有强制关闭；不加时一直等到强制关闭。剩余一个很小的竞态（客户端恰好在连接被关闭的瞬间写入请求），需要客户端对“未收到任何响应的连接错误”重试；仓库的 LiteLLM 示例配置是 `max_retries: 0`，这一点需要一并评估。四个服务共用这段代码，SSO、Login、Console 同样受益。

仍在 r2 上时：把 Proxy 的滚动更新放在低峰期；预期每次滚动有极少量请求失败。

### 10.2 其他

- **镜像没有声明 `USER`**：默认以 root 运行。本清单显式以 UID 1000（镜像内的 `node` 用户）运行并只读根文件系统，四个服务（包括 Login 的 Chromium）在 kind 中验证可用。建议在 `deploy/images/Dockerfile.release` 中加 `USER node`，让不写 securityContext 的部署也不以 root 运行。
- **Proxy 的业务接口与管理接口在同一端口**：NetworkPolicy 无法只放行业务路径，管理接口只靠 `INTERNAL_API_TOKEN` 保护。
- **SSO 对外地址需要在 Login Pod 内可解析**：用 Ingress 主机名时依赖集群 DNS（例如私有 DNS 区域）或 `hostAliases`（第 4 节）。
- **方式 A 的触发器**：开启二进制日志时需要 `log_bin_trust_function_creators=ON`。kind 中只验证了 ON 的情况；不能开启时用方式 B。
- **同一调用方的并发请求在 MySQL 中按行串行**：kind 的持续负载（单个调用方、约 10 次/秒）中观察到 `proxy_accounts ... FOR UPDATE` 的行锁等待和 Docker Desktop 磁盘上较慢的提交，个别请求延迟到秒级；一次运行中出现过 1 个 503 `pool_storage_unavailable`（Proxy 的 MySQL 操作 5 秒时限）。这是功能环境的现象，不是性能结论，与清单无关；生产容量需要在客户的 MySQL 上另行评估。
- **kind 没有 Ingress 控制器**：Ingress 只验证了渲染和被 API server 接受，没有验证实际转发、TLS 和来源限制。
