# Azure 部署（azd + Bicep）：GHCP Proxy 多企业版 multi-f43f27e-amd64-r3

本目录把多企业版 `multi-f43f27e-amd64-r3`（Proxy、SSO、Login、Console 四个服务）部署到 Azure：AKS + Azure Database for MySQL 灵活服务器 + ACR + Key Vault + Log Analytics，可选 Application Gateway WAF_v2 公网入口。应用清单复用 [`deploy/kubernetes/`](../kubernetes/README.md) 的 base 与 overlay，只在其上叠加 `components/azure-aks`，不复制、不修改 base。

- 新部署的业务配置（变量含义、GitHub 侧 SAML / SCIM / 席位、开池、LiteLLM 接入、验收清单）仍以 [多企业版新部署指南](../../docs/multi-enterprise-new-deployment-guide.md) 和 [Kubernetes README](../kubernetes/README.md) 为准，本文只写 Azure 相关部分。
- 公网访问开关的设计与取舍见 [public-access-design.md](public-access-design.md)。
- 与旧的单企业版 Azure 部署（AKS + PostgreSQL + Redis）的区别：不再使用 PostgreSQL 和 Redis；Proxy 的共享存储是 MySQL；机密在 Key Vault；镜像按 digest 从 Docker Hub 复制，不在部署时构建。
- 文中所有名称、地址、主机名都是占位值或文档地址段。实际值只放在 azd 环境（`.azure/`，不入库）或客户的私有仓库中。

## 0. 目录

```text
deploy/azure/
├── azure.yaml                   azd 项目：只管理环境与基础设施，hook 部署应用
├── infra/
│   ├── main.bicep               订阅级入口：资源组及下面全部模块
│   ├── main.bicepparam          参数（全部来自 azd 环境变量，见第 3 节）
│   ├── types.bicep              公网开关等对象参数的类型
│   ├── bicepconfig.json         严格的 linter 规则
│   └── modules/                 network、subnet、private-dns-zone、private-endpoint、log-analytics、aks、aks-existing、
│                                managed-prometheus、workload-identity、user-assigned-identity、role-assignments、
│                                subnet-role-assignment、acr、key-vault、key-vault-secret、mysql、waf-policy、app-gateway
├── hooks/                       PowerShell 7：preprovision、postprovision、deploy-app、predown、Set-GhcpSecret、common
├── scripts/render-overlay.mjs   按 azd 环境生成本环境的私有 overlay（.generated/<环境>/，不入库）
├── scripts/enterprise-registry.mjs  多企业 registry 的 Key Vault / 挂载约定与校验（第 8.6 节）
├── enterprise-registry.azure.example.json  按本部署约定写的 registry 示例（两个新增企业）
├── k8s/mysql-bootstrap/         MySQL 账号初始化 Job（用 Proxy 镜像，无额外镜像）
├── images.json                  四个镜像的 Docker Hub digest（与 base 一致，测试校验）
├── public-access-design.md      公网访问开关的设计
└── azure.test.mjs               静态检查（第 12 节）

deploy/kubernetes/
├── components/azure-aks/        AKS 适配组件（ACR、Key Vault CSI、MySQL CA、StorageClass、内部负载均衡）
├── components/azure-proxy-ilb/  可选：Proxy 内部负载均衡（LiteLLM 在另一个集群时）
├── overlays/azure-aks/          github-com + azure-aks 的模板 overlay（不用 azd 时使用）
└── azure-aks.test.mjs           AKS overlay 的静态检查
```

## 1. 架构

```text
                    （可选）公网 ── App GW WAF_v2 公网前端 ─┐            管理员 / VPN ──┐
                                                         │                           │
VNet（新建或复用） ─────────────────────────────────────────┼───────────────────────────┼──────────────
  snet-ghcp-appgw   App GW（公网 + 私网前端 .10，WAF 策略/端点）──► 内部负载均衡 IP ◄────┘
  snet-ghcp-ilb     SSO :7001（.4）  Console :7004（.5）  [Proxy :3000（.6），可选]
  snet-ghcp-aks     AKS 节点（system 池：kube-system；user 池：四个服务）──NAT Gateway──► 固定公网出口 IP
                      ghcp namespace：Proxy ×N（MySQL）、SSO / Login / Console ×1（Azure Disk）
  snet-ghcp-pe      私有终结点：MySQL（mysqlServer）、Key Vault（vault）、ACR（registry）
  私有 DNS 区域      privatelink.mysql.database.azure.com、privatelink.vaultcore.azure.net、privatelink.azurecr.io
Log Analytics ◄── Container Insights、AKS / MySQL / App GW 诊断；（可选）Azure Monitor 工作区 + Grafana
```

| 资源 | 说明 |
| --- | --- |
| VNet、子网、NSG | 四个子网（第 3.2 节网段）；NSG 只为占住绑定（企业治理策略会给无 NSG 子网绑定空 NSG）；App GW 子网有 v2 必需的 GatewayManager 规则 |
| NAT Gateway | AKS 子网的固定出口 IP（输出 `NAT_EGRESS_IP`），供 GitHub / GHE.com 的 IP 允许列表；空闲超时 15 分钟（覆盖 600 秒推理） |
| AKS | Azure CNI Overlay（Pod 不占 VNet 地址）、Cilium 数据面与网络策略、OIDC + Workload Identity、Key Vault CSI 插件（轮换开启）、Entra ID + Azure RBAC、system / user 节点池跨可用区、可选私有集群 |
| MySQL 灵活服务器 | 8.0（可选 8.4）、私有终结点、禁用公网、`require_secure_transport=ON`、utf8mb4、`log_bin_trust_function_creators=ON`、自动扩容存储、备份保留 14 天、默认区域冗余高可用 |
| ACR Premium | 只存四个发布镜像（按 digest 复制）；禁用公网；kubelet 标识 AcrPull |
| Key Vault | RBAC 授权、禁用公网（可选运维 IP）、清除保护；全部应用机密 |
| 身份 | `id-<环境>-ghcp-workload`（联合凭据 → ServiceAccount `ghcp-workload`，Key Vault Secrets User）；公网模式另有 `id-<环境>-appgw`（读取证书）；部署人员获得新建集群的 AKS RBAC Cluster Admin |
| App GW WAF_v2 | 只在公网开关打开时部署（第 7 节） |

**机密流**：Key Vault →（CSI 驱动以 ServiceAccount `ghcp-workload` 的联合身份换取 Entra token）→ 每个 Pod 只挂载自己的 SecretProviderClass → 同步出 base 按名称引用的 Secret（`ghcp-internal`、`ghcp-proxy`、`ghcp-sso`、`ghcp-sso-saml`）→ 环境变量 / `/certs`。应用进程本身不持有任何 Azure 凭据（Pod 不带 `azure.workload.identity/use` 标签，`automountServiceAccountToken` 仍为 `false`）。

**身份流**：kubelet 托管标识 → ACR（AcrPull）；AKS 控制面标识 → AKS 子网、内部负载均衡子网（Network Contributor）；工作负载标识 → Key Vault（Secrets User）；App GW 标识 → Key Vault（Secrets User，证书）。

**出口流**：四个服务到 GitHub / GHE.com / Copilot 的 HTTPS 都经 NAT Gateway 的固定公网 IP；到 MySQL、Key Vault、ACR 走私有终结点，不出 VNet。需要按域名限制出口时，在 NAT 之前加 Azure Firewall（`GHCP_AKS_OUTBOUND_TYPE=userDefinedRouting`），放行的主机见新部署指南第 2.2 节。

## 2. 前提

工具（只在运维机器上，部署本身不在本机构建任何东西）：

| 工具 | 用途 |
| --- | --- |
| Azure CLI 2.6x 或更新，`az login` | 部署、镜像复制、机密写入 |
| Bicep CLI | `az bicep install`（下载到 `~/.azure/bin`）或独立安装的 `bicep`；azd 也会自动使用 |
| Azure Developer CLI（azd）1.x | 环境与参数管理、`azd provision` |
| PowerShell 7（`pwsh`） | hooks |
| kubectl（含内置 kustomize v5）、kubelogin | 部署应用；`az aks install-cli --subscription <订阅>` 可安装两者 |
| Node.js 20+ | 渲染脚本（不需要 `npm install`） |

权限：目标订阅上的 Owner，或 Contributor + User Access Administrator（模板会创建角色分配）。复用别的资源组中的 VNet / AKS 时，还需要那些资源组上的相应权限。

资源提供程序（首次使用的订阅，逐个注册）：

```bash
SUB=<订阅 ID>
for ns in Microsoft.ContainerService Microsoft.DBforMySQL Microsoft.ContainerRegistry Microsoft.KeyVault \
          Microsoft.Network Microsoft.ManagedIdentity Microsoft.OperationalInsights Microsoft.Insights \
          Microsoft.Monitor Microsoft.Dashboard; do
  az provider register --namespace "$ns" --subscription "$SUB"
done
```

确认地域支持：所选 VM 尺寸和配额、MySQL SKU（`az mysql flexible-server list-skus --location <地域> --subscription "$SUB"`）、ZRS 磁盘、可用区数量。

## 3. 参数

全部参数在 [`infra/main.bicepparam`](infra/main.bicepparam) 中读取 azd 环境变量（`azd env set <名称> <值>`），未设置时用默认值。常用项：

### 3.1 必填 / 部署前决定

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | — | **必须显式设置**；hook 从不借用 az CLI 的默认订阅，每条 az 命令都带 `--subscription` |
| `AZURE_LOCATION` | — | 部署地域 |
| `GHCP_GITHUB_HOSTING` | `github.com` | `github.com`（EMU）或 `ghe.com`（数据驻留）。首次启动后不能更改 |
| `GHCP_ENTERPRISE_SLUG` | — | 企业 slug |
| `GHCP_ENTERPRISE_SHORTCODE` | — | github.com 必填（留空时代码会用内置值 `octo` 且不报错） |
| `GHCP_GHE_SUBDOMAIN` | — | GHE.com 必填：`<子域>.ghe.com` 中的子域 |
| `GHCP_POOL_ACCOUNT_EMAIL_DOMAIN` | — | 池账号邮箱域名，有池成员后不能改 |
| `GHCP_POOL_WARMUP_MODEL` | — | 新账号凭据验证使用的模型，写入配置指纹 |
| `GHCP_CONFIG_APPROVED` | 未设置 | 核对第 4 步打印的摘要后设为 `true`，才会部署应用（对应 base 的 `GHCP_CONFIG_APPROVED` 门禁） |
| `GHCP_PROXY_REPLICAS` | `2` | Proxy 副本数（2–20）。连接数约 `(副本数 + 1) × 10`，须小于 MySQL `max_connections` |
| `GHCP_NAMESPACE` | `ghcp` | 应用的 namespace，绑定在 Workload Identity 的联合凭据上，部署后不要更改 |
| `GHCP_RESOURCE_SUFFIX` / `GHCP_NAME_OVERRIDES` / `GHCP_TAGS` | 空 / `{}` / `{}` | 资源名后缀（例如地域代码）；直接指定资源名（`resourceGroup`、`vnet`、`aks`、`acr`、`keyVault`、`mysql`）；按客户规范的标签 |

### 3.2 网络

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `GHCP_VNET_ADDRESS_PREFIXES` | `["10.40.0.0/16"]` | 新建 VNet 的地址空间。默认避开 LiteLLM AKS 模板的默认网段（VNet `10.30.0.0/16`、Service `10.31.0.0/16`、Pod `10.240.0.0/16`） |
| `GHCP_AKS_SUBNET_PREFIX` / `GHCP_PE_SUBNET_PREFIX` / `GHCP_ILB_SUBNET_PREFIX` / `GHCP_APPGW_SUBNET_PREFIX` | `10.40.0.0/22` / `10.40.4.0/26` / `10.40.4.64/27` / `10.40.5.0/24` | 四个子网 |
| `GHCP_POD_CIDR` / `GHCP_SERVICE_CIDR` | `10.244.0.0/16` / `10.41.0.0/16` | 集群内部网段，不得与任何可达网络重叠（包括共用 VNet 的其他集群的 Service CIDR）；创建后不能改 |
| `GHCP_INTERNAL_LB_IPS` | `{}` | 内部负载均衡固定 IP `{ "sso", "console", "proxy" }`；默认 ILB 子网的 `.4`、`.5`、`.6` |
| `GHCP_CREATE_NAT_GATEWAY` / `GHCP_EXISTING_NAT_GATEWAY_ID` / `GHCP_NAT_IDLE_TIMEOUT_MINUTES` | `true` / 空 / `15` | NAT Gateway |
| `GHCP_EXISTING_VNET_NAME` / `GHCP_EXISTING_VNET_RESOURCE_GROUP` / `GHCP_EXISTING_SUBNET_NAMES` | 空 | 复用已有 VNet（第 9 节） |
| `GHCP_EXISTING_PRIVATE_DNS_ZONE_IDS` | `{}` | 复用已有私有 DNS 区域 `{ "acr", "keyVault", "mysql" }`（资源 ID） |
| `GHCP_INTERNAL_ALLOWED_CIDRS` | VNet 地址空间 | SSO / Console 内部负载均衡与 NetworkPolicy 放行的管理网段（逗号分隔，例如 VPN 地址池） |

### 3.3 AKS

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `GHCP_KUBERNETES_VERSION` | 平台默认 | 生产请固定（`az aks get-versions --location <地域> --subscription "$SUB"`） |
| `GHCP_AVAILABILITY_ZONES` | `["1","2","3"]` | `[]` 表示不使用可用区（磁盘随之用 LRS） |
| `GHCP_SYSTEM_NODE_VM_SIZE` / `GHCP_SYSTEM_NODE_COUNT` | `Standard_D2s_v5` / `2` | system 池（只跑 kube-system） |
| `GHCP_USER_NODE_VM_SIZE` / `GHCP_USER_NODE_MIN_COUNT` / `GHCP_USER_NODE_MAX_COUNT` | `Standard_D4s_v5` / `2` / `5` | user 池（自动伸缩） |
| `GHCP_NETWORK_DATAPLANE` / `GHCP_NETWORK_POLICY` | `cilium` / `cilium` | 网络策略引擎创建后不能更换 |
| `GHCP_AKS_OUTBOUND_TYPE` | `userAssignedNATGateway` | 走客户防火墙时 `userDefinedRouting` |
| `GHCP_PRIVATE_CLUSTER` | `false` | 私有集群：hook 必须在 VNet 内（跳板机 / 自托管流水线 / VPN）运行 |
| `GHCP_API_SERVER_AUTHORIZED_IP_RANGES` | `[]` | 非私有集群时限制 API server 来源（建议填运维出口） |
| `GHCP_DISABLE_LOCAL_ACCOUNTS` / `GHCP_AKS_ADMIN_GROUP_OBJECT_IDS` | `false` / `[]` | 集群始终启用 Entra ID + Azure RBAC；禁用本地账户时 hook 需要 kubelogin |
| `GHCP_GRANT_DEPLOYER_AKS_ADMIN` | `true` | 给执行部署的身份授予 AKS RBAC Cluster Admin（hook 部署应用需要） |
| `GHCP_UPGRADE_CHANNEL` / `GHCP_NODE_OS_UPGRADE_CHANNEL` | `none` / `None` | 自动升级默认关闭；开启时在周末维护窗口进行。SSO / Login / Console 是单副本，节点排空时各有短暂中断 |
| `GHCP_DISK_SKU_NAME` | 自动 | 有可用区时 `Premium_ZRS`，否则 `Premium_LRS`（第 10 节） |
| `GHCP_EXISTING_AKS_NAME` / `GHCP_EXISTING_AKS_RESOURCE_GROUP` / `GHCP_EXISTING_AKS_CONTROL_PLANE_PRINCIPAL_ID` | 空 | 复用已有 AKS（第 9 节） |

### 3.4 MySQL、ACR、Key Vault、监控

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `GHCP_MYSQL_SKU_TIER` / `GHCP_MYSQL_SKU_NAME` | `GeneralPurpose` / `Standard_D2ads_v5` | Burstable 不支持高可用、CPU 积分耗尽会限速，只用于测试 |
| `GHCP_MYSQL_VERSION` | `8.0.21` | 或 `8.4`（以地域支持为准） |
| `GHCP_MYSQL_HA` | `ZoneRedundant` | `Disabled` / `SameZone` / `ZoneRedundant` |
| `GHCP_MYSQL_STORAGE_GB` / `GHCP_MYSQL_BACKUP_RETENTION_DAYS` / `GHCP_MYSQL_GEO_BACKUP` | `64` / `14` / `false` | 存储自动扩容；异地备份创建后不能改 |
| `GHCP_MYSQL_ADMIN_LOGIN` | `ghcpadmin` | 管理员登录名 |
| `GHCP_MYSQL_ADMIN_PASSWORD` | preprovision 生成 | 只在本机 azd 环境与 Key Vault（`mysql-admin-password`）中 |
| `GHCP_MYSQL_TRUST_FUNCTION_CREATORS` | `true` | 第 5.3 节 |
| `GHCP_MYSQL_MODE` | `auto-migrate` | `dba-schema` = 方式 B（DBA 预建表） |
| `GHCP_MYSQL_BOOTSTRAP` / `GHCP_MYSQL_PROXY_USER` / `GHCP_MYSQL_PROXY_USER_HOST` | `true` / `ghcp_proxy` / `%` | 账号初始化 Job；第 5.3 节 |
| `GHCP_ACR_PUBLIC_NETWORK_ACCESS` | `false` | 关闭时 ACR 数据面命令只能在 VNet 内执行（`az acr import` 不受影响） |
| `GHCP_DOCKERHUB_USERNAME` / `GHCP_DOCKERHUB_TOKEN` | 空 | 可选：Docker Hub 账号，避免匿名拉取限额（只从环境变量读取） |
| `GHCP_KEY_VAULT_ALLOWED_IP_RANGES` | `[]` | 允许访问 Key Vault 数据面的运维出口 IP（默认仅私有终结点） |
| `GHCP_KEY_VAULT_PURGE_PROTECTION` | `true` | 开启后不能关闭 |
| `GHCP_GRANT_DEPLOYER_KEY_VAULT_ACCESS` / `GHCP_DEPLOYER_PRINCIPAL_TYPE` | `false` / `User` | 部署身份的 Key Vault Secrets Officer；流水线（服务主体）部署时类型设为 `ServicePrincipal` |
| `GHCP_LOG_RETENTION_DAYS` / `GHCP_LOG_DAILY_QUOTA_GB` | `30` / `-1` | Log Analytics |
| `GHCP_ENABLE_CONTAINER_INSIGHTS` / `GHCP_ENABLE_MANAGED_PROMETHEUS` / `GHCP_ENABLE_GRAFANA` / `GHCP_ENABLE_AKS_AUDIT_LOGS` | `true` / `false` / `false` / `false` | 四个服务没有 `/metrics`，托管 Prometheus 只有集群指标 |

### 3.5 应用渲染（不进入 Bicep）

| 环境变量 | 说明 |
| --- | --- |
| `GHCP_SSO_PUBLIC_BASE_URL` | 覆盖 SSO 对外地址（默认：公网模式 `https://<主机名>`，否则 `http://<SSO 内部负载均衡 IP>:7001`） |
| `GHCP_GITHUB_API_BASE_URL` | 经出口网关访问 GitHub API 时填写（Proxy 与 SSO 用同一个值） |
| `GHCP_PROXY_CONFIG_OVERRIDES` | JSON 对象，覆盖 `ghcp-proxy-config` 中的非机密键，例如 `{"POOL_INFERENCE_TIMEOUT_SECONDS":"600"}`；机密键被拒绝 |
| `GHCP_ENABLE_NETWORK_POLICY` | 默认在集群有策略引擎时启用 `components/network-policy` 与 Azure 补充策略 |
| `GHCP_LITELLM_NAMESPACE` / `GHCP_LITELLM_POD_LABEL` | NetworkPolicy 中放行访问 Proxy 的 LiteLLM（同集群时）；标签默认 `app=litellm`（LiteLLM AKS 模板） |
| `GHCP_PROXY_ILB` / `GHCP_PROXY_ILB_ALLOWED_CIDRS` | 启用 Proxy 内部负载均衡（LiteLLM 在另一个集群）；来源只能是 LiteLLM 节点子网 |
| `GHCP_ALLOW_AZD_DOWN` | 允许 `azd down`（第 8.5 节） |
| `GHCP_ENTERPRISE_REGISTRY_FILE` | 多企业：运维维护的 registry JSON 文件路径（绝对路径，或相对 `deploy/azure`；放在私有位置，不入库）。为空 = 只有 `default`（第 8.6 节） |

### 3.6 公网访问开关

`GHCP_PUBLIC_ACCESS`（JSON，默认 `{"sso":false,"console":false,"litellm":false,"allowedSourceCidrs":[]}`），以及 `GHCP_APPGW_MIN_CAPACITY` / `GHCP_APPGW_MAX_CAPACITY`（`1` / `4`）、`GHCP_APPGW_IDLE_TIMEOUT_MINUTES`（`15`）。见第 7 节。

## 4. 部署步骤

在 `deploy/azure` 目录中执行（示例为 bash；PowerShell 同理）。不要把实际值写进脚本或提交。

```bash
cd deploy/azure
SUB=<订阅 ID>
az account show --subscription "$SUB" -o table         # 确认登录的租户与订阅

azd env new <环境名>                                   # 例如 ghcp-prod；只用于命名
azd env set AZURE_SUBSCRIPTION_ID "$SUB"
azd env set AZURE_LOCATION <地域>

# 企业变量（第 3.1 节；GHE.com 用 GHCP_GHE_SUBDOMAIN 代替 SHORTCODE）
azd env set GHCP_GITHUB_HOSTING github.com
azd env set GHCP_ENTERPRISE_SLUG <slug>
azd env set GHCP_ENTERPRISE_SHORTCODE <shortcode>
azd env set GHCP_POOL_ACCOUNT_EMAIL_DOMAIN <池账号邮箱域名>
azd env set GHCP_POOL_WARMUP_MODEL <模型>
# 按需：网段、副本数、MySQL SKU / HA、私有集群、复用 VNet / AKS、公网开关……

azd provision
```

`azd provision` 依次执行：

1. **preprovision**：检查工具；确认 `AZURE_SUBSCRIPTION_ID` 已显式设置；校验 `GHCP_PUBLIC_ACCESS`；生成 MySQL 管理员密码（写入本机 azd 环境）。
2. **Bicep**：创建第 1 节的资源（约 20–40 分钟，MySQL 区域冗余高可用与 AKS 最慢）。
3. **postprovision**：
   - `az acr import --subscription ...` 把四个镜像按 digest 复制到 ACR 的 `ghcp/<服务>:multi-f43f27e-amd64-r3`（服务端复制）；
   - 在 Key Vault 中生成缺少的机密（第 5.1 节；已存在的不动）；
   - 列出还需要运维写入的机密；
   - 渲染本环境的 overlay，连接集群（凭据写入 `deploy/azure/.kube/<集群>.config`，所有 kubectl 调用显式带 `--kubeconfig` 与 `--context`，**不读写 `~/.kube/config`**），运行 MySQL 账号初始化 Job；
   - `GHCP_CONFIG_APPROVED` 不是 `true` 时**不部署应用**，只打印配置摘要。

然后：

4. 写入运维机密（第 5.2 节）。
5. 核对摘要中的企业身份字段、池配置指纹参数、`SSO_PUBLIC_BASE_URL` 与 GitHub SAML 地址（这些字段有数据后不能改，新部署指南第 4.7 节），确认后：

   ```bash
   azd env set GHCP_CONFIG_APPROVED true
   pwsh ./hooks/deploy-app.ps1          # 或 azd hooks run postprovision（会重新执行全部 postprovision 步骤，均可重复）
   ```

   `deploy-app.ps1` 渲染 overlay、离线检查（除启动门禁脚本外不允许残留 `REPLACE_`）、`kubectl apply -k`，等待四个 Deployment 就绪。

为什么不用 azd 的 AKS 服务部署（`services: host: aks`）：它会把集群凭据合并进操作者默认的 kubeconfig 并切换当前上下文；这里要求部署过程不改动操作者已有的 kubeconfig 和上下文，所以应用部署放在 hook 中、使用独立的 kubeconfig 文件。

## 5. 机密与 MySQL

### 5.1 Key Vault 中的机密

| Key Vault 机密 | 同步为 | 来源 | 使用者 |
| --- | --- | --- | --- |
| `ghcp-internal-api-token` | `ghcp-internal/INTERNAL_API_TOKEN` | postprovision 生成 | 四个服务 |
| `ghcp-session-secret` | `ghcp-internal/SESSION_SECRET` | postprovision 生成 | SSO、Console |
| `ghcp-proxy-api-key` | `ghcp-proxy/API_KEY` | postprovision 生成 | Proxy；**只配置给 LiteLLM**（`GHCP_PROXY_API_KEY`） |
| `ghcp-mysql-url` | `ghcp-proxy/MYSQL_URL` | postprovision 生成（与 `ghcp-mysql-proxy-password` 成对） | Proxy |
| `ghcp-mysql-proxy-password` | — | postprovision 生成 | MySQL 账号初始化 Job |
| `mysql-admin-password` | — | Bicep 写入（值来自 preprovision） | DBA、账号初始化 Job |
| `ghcp-sso-default-user-password` | `ghcp-sso/SSO_DEFAULT_USER_PASSWORD` | postprovision 生成 | SSO |
| `ghcp-scim-token` | `ghcp-sso/SCIM_TOKEN` | **运维写入** | SSO |
| `ghcp-copilot-seat-pat` | `ghcp-sso/GITHUB_COPILOT_SEAT_PAT` | **运维写入** | SSO |
| `ghcp-saml-idp-cert` / `ghcp-saml-idp-key` | `ghcp-sso-saml/idp-cert.pem`、`idp-key.pem` | **运维写入**（自己维护的 SAML 签名证书与私钥） | SSO |
| `ghcp-public-tls`（或 `certificateNames` 中的名字） | — | **运维写入**（公网模式） | App GW |
| `ghcp-ent-<id>-*` | 文件 `/run/secrets/<id>/*` | registry 中其他企业的机密（第 8.6 节） | SSO（`sso.*`）、Proxy（Models token） |

- 生成类机密只在内存中生成，经 ARM 控制面（`az resource create --subscription ...`）写入，不出现在 azd 环境、日志或仓库中；重复执行不会轮换已有值。
- 控制面写入不受 Key Vault 网络规则限制，所以私有的 vault 也能在 VNet 外写入；读取值（数据面）只能在 VNet 内或经 `GHCP_KEY_VAULT_ALLOWED_IP_RANGES`。
- MySQL 管理员密码是唯一保存在本机的机密（azd 在执行 hook 之前就要读取 Bicep 参数，旧版 PostgreSQL 部署也是同样做法）：`.azure/<环境>/.env` 不入库；账号初始化完成后可以在门户重置管理员密码并更新 Key Vault 中的 `mysql-admin-password`，再从 azd 环境中删除。

### 5.2 写入运维机密

```powershell
pwsh ./hooks/Set-GhcpSecret.ps1 -Name ghcp-scim-token -Prompt
pwsh ./hooks/Set-GhcpSecret.ps1 -Name ghcp-copilot-seat-pat -Prompt
pwsh ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-cert -File <证书 PEM>
pwsh ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-key -File <私钥 PEM>
# 公网模式的 TLS 证书（不带密码的 PFX）。也可以在 VNet 内：
#   az keyvault certificate import --vault-name <vault> --name ghcp-public-tls --file <pfx> --subscription "$SUB"
pwsh ./hooks/Set-GhcpSecret.ps1 -Name ghcp-public-tls -File <PFX> -Base64 -ContentType application/x-pkcs12
```

`Set-GhcpSecret.ps1` 从当前 azd 环境读取订阅和 Key Vault 资源 ID，值经安全提示或文件读入，不出现在命令行和 shell 历史中。需要资源组上的 Contributor（或 Key Vault Contributor）。

SSO 的 Pod 在 `ghcp-scim-token` 等机密写入之前停在 `ContainerCreating`（CSI 挂载失败会自动重试）。

### 5.3 MySQL：账号、方式 A / B 与 `log_bin_trust_function_creators`

- 库 `ghcp_proxy`（utf8mb4 / `utf8mb4_0900_ai_ci`）由 Bicep 创建；服务器参数 `require_secure_transport=ON`、`character_set_server=utf8mb4`、`collation_server=utf8mb4_0900_ai_ci`、`log_bin_trust_function_creators=ON`。
- **账号初始化 Job**（`k8s/mysql-bootstrap`，postprovision 运行，可重复执行）：以管理员经 TLS（完整校验证书链与主机名，CA 与 Proxy 相同）连接，确认库是 utf8mb4，创建 / 更新 `ghcp_proxy`（`REQUIRE SSL`，密码 = Key Vault 中的 `ghcp-mysql-proxy-password`），授权：
  - 方式 A（默认）：`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER`（与 Kubernetes README 第 3.2 节一致），Proxy 首次启动自己建表；
  - 方式 B（`GHCP_MYSQL_MODE=dba-schema`）：只授 DML；DBA 用管理员执行本版本的 `scripts/proxy-mysql-initial.sql`（utf8mb4 会话），再 `GRANT TRIGGER ON ghcp_proxy.proxy_accounts`；渲染时自动启用 `components/mysql-dba-schema`。
  - 账号来源默认 `%`（私有终结点之后只有 VNet 内可达）；要收紧时先用 `SELECT host FROM information_schema.processlist` 确认 MySQL 看到的来源地址，再设置 `GHCP_MYSQL_PROXY_USER_HOST`（`a.b.c.d/掩码` 形式）。
- **`log_bin_trust_function_creators` 的取舍**：Azure 灵活服务器的二进制日志始终开启且固定为 ROW 格式，该参数在灵活服务器上默认就是 `ON`（Microsoft Learn《Server parameters》）。MySQL 关闭它的目的是防止非 SUPER 账号创建的函数 / 触发器在基于语句的复制中产生不确定结果；ROW 格式下这一风险不存在，所以保持 `ON` 是官方推荐值，也是方式 A 中 Proxy 账号（无 SUPER）创建 `user_pool_credential_fence` 触发器的前提。仍然可以设 `GHCP_MYSQL_TRUST_FUNCTION_CREATORS=false` 并使用方式 B：触发器由 DBA 以管理员身份创建，运行账号没有任何 DDL 权限（权限最小，但每次版本升级若有表结构变化都需要 DBA 执行脚本）。账号初始化 Job 在方式 A 且该参数为 `OFF` 时直接失败并给出原因。
- **TLS**：`MYSQL_SSL_MODE=verify-ca`（base 默认），CA 为 `components/azure-aks/mysql-ca` 中的 DigiCert Global Root G2 与 Microsoft RSA Root Certificate Authority 2017（Microsoft Learn TLS 文档要求两者合并使用；指纹见该目录的 README）。`verify-ca` 不校验主机名（Proxy 的已知行为）。
- **备份与高可用**：自动备份保留 14 天，支持时间点还原；默认区域冗余高可用（主备在不同可用区，故障自动切换，连接地址不变；切换期间连接中断约一到两分钟，Proxy 的 `/readyz` 会短暂失败、只摘流量不重启）。异地冗余备份按需开启。

## 6. 部署后

1. **初始化 Console**（之前不要开放 Console）：

   ```bash
   kubectl --kubeconfig .kube/<集群>.config --context <上下文> -n ghcp port-forward svc/ghcp-console 7004:7004
   ```

   浏览器打开 `http://127.0.0.1:7004` → **Initialize Console**。之后管理员从管理网段访问 `http://<Console 内部负载均衡 IP>:7004`，或公网模式下的 `https://<Console 主机名>`。
2. **GitHub SAML**（新部署指南第 6 节）：Sign on URL `<SSO_PUBLIC_BASE_URL>/sso`，Issuer `<SSO_PUBLIC_BASE_URL>/metadata`，证书为 `ghcp-saml-idp-cert` 的内容。`SSO_PUBLIC_BASE_URL` 必须同时能被管理员浏览器和 Login Pod 访问：仅内网时是 SSO 内部负载均衡地址（管理员需在 VPN / 管理网段内），公网模式时是 SSO 主机名。
3. **SCIM、席位、开池**：按新部署指南第 6、7 节；Ready idle target 保持 0，直到 SAML / SCIM / 席位验证通过，再小规模开池。
4. **LiteLLM 接入**（新部署指南第 8 节），`GHCP_POOL_API_BASE` 与 `GHCP_POOL_API_BASES`：
   - LiteLLM 在同一个 AKS 集群：`http://ghcp-proxy.ghcp.svc.cluster.local:3000`；设置 `GHCP_LITELLM_NAMESPACE`（及 `GHCP_LITELLM_POD_LABEL`）后重新部署，NetworkPolicy 只放行它；
   - LiteLLM 在同一 VNet / 对等 VNet 的另一个集群：`GHCP_PROXY_ILB=true`、`GHCP_PROXY_ILB_ALLOWED_CIDRS=<LiteLLM 节点子网>`，地址 `http://<Proxy 内部负载均衡 IP>:3000`；
   - `GHCP_PROXY_API_KEY` 为 Key Vault 中的 `ghcp-proxy-api-key`（在 VNet 内读取，或由 LiteLLM 的 Key Vault 集成引用）。
5. **出口 IP**：把 `NAT_EGRESS_IP` 加入 GitHub 企业的 IP 允许列表（如启用）。
6. **机密轮换**：用 `Set-GhcpSecret.ps1` 写入新值；CSI 驱动 2 分钟内更新挂载文件与同步的 Secret，但环境变量在 Pod 重启后才变化：

   ```bash
   kubectl --kubeconfig .kube/<集群>.config --context <上下文> -n ghcp rollout restart deployment/ghcp-sso
   ```

   `ghcp-proxy-api-key` 轮换需要同时更新 LiteLLM；`ghcp-mysql-url` 轮换需要先改 MySQL 账号密码（重跑账号初始化 Job：删除两个 `ghcp-mysql-*` 机密后 `azd hooks run postprovision`）。

## 7. 公网访问开关

默认仅内网。打开后创建 Application Gateway WAF_v2（公网 IP + 私网前端）、每个端点的 WAF 策略和 HTTPS 监听器；后端是内部负载均衡 IP，后端服务始终没有公网地址。详细设计见 [public-access-design.md](public-access-design.md)。

```bash
# 先把证书写入 Key Vault（第 5.2 节），再：
azd env set GHCP_PUBLIC_ACCESS '{"sso":false,"console":true,"litellm":false,"allowedSourceCidrs":["203.0.113.0/24"],"hostNames":{"console":"console.example.com"}}'
azd provision
# 输出 APPGW_PUBLIC_IP：在公网 DNS 中把 Console 主机名指向它。SSO 通常不需要对外（设计文档第 2.1 节）；确需开放时 SSO 地址变化后同步 GitHub SAML 设置
```

| 键 | 说明 |
| --- | --- |
| `sso` / `console` / `litellm` | 三个推荐可开放端点的开关 |
| `proxy` | 默认 `false`，不推荐：持有共享 `API_KEY` 的任何人都能冒用任意身份。需要 `proxyAllowedSourceCidrs`（LiteLLM 出口 IP），建议 `proxyClientCaCertificate`（App GW mutual TLS），见设计文档第 4 节 |
| `proxyAllowedSourceCidrs` / `proxyClientCaCertificate` | Proxy 的来源允许列表（必填）；签发 LiteLLM 客户端证书的 CA（公开证书的 base64） |
| `allowedSourceCidrs` | 来源允许列表（VNet 总是放行）；Console 只能用允许列表 |
| `litellmAllowedSourceCidrs` | LiteLLM 单独的来源列表 |
| `ssoAllowAnySource` / `litellmAllowAnySource` | 显式同意对任意来源开放 |
| `hostNames` / `certificateNames` | 对外主机名；Key Vault 中的证书名（默认 `ghcp-public-tls`） |
| `litellmBackend` | `{ address, port, probePath }`，LiteLLM 的内部负载均衡 |
| `litellmAllowedPathPrefixes` | LiteLLM 放行的路径前缀 |
| `wafMode` | `Prevention`（默认）/ `Detection` |
| `splitHorizonDns` | 默认 `true`：VNet 内把对外主机名解析到 App GW 私网前端 |

**关闭**：把端点设为 `false` 后 `azd provision` 会移除对应监听器；三个都关闭后，增量部署**不会删除**已有的 App GW、公网 IP 与 WAF 策略，需要手工删除：

```bash
RG=<资源组>; ENV=<环境名>
az network application-gateway delete --resource-group "$RG" --name "agw-$ENV" --subscription "$SUB"
az network public-ip delete --resource-group "$RG" --name "pip-agw-$ENV" --subscription "$SUB"
for p in default sso console litellm proxy; do
  az network application-gateway waf-policy delete --resource-group "$RG" --name "waf-$ENV-$p" --subscription "$SUB"
done
```

## 8. 运维

### 8.1 升级到新版本

1. 读新版本的发布说明与升级指南（是否有数据库迁移、是否要求停机）。
2. 备份（第 8.3 节）。
3. 同一个提交中更新 `deploy/kubernetes/base/kustomization.yaml` 的四个 digest 与本目录的 `images.json`（`azure.test.mjs` 校验两者与发布记录一致）。
4. `azd hooks run postprovision`：复制新镜像、重新渲染并部署。Proxy 逐个替换；SSO、Login、Console 是 `Recreate`，各有几十秒不可用。

### 8.2 扩缩容

- Proxy：`azd env set GHCP_PROXY_REPLICAS <n>` 后 `pwsh ./hooks/deploy-app.ps1`。核对 MySQL `max_connections`（`(n + 1) × MYSQL_CONNECTION_LIMIT`）。
- 节点：user 池自动伸缩（`GHCP_USER_NODE_MIN_COUNT` / `MAX_COUNT`）。
- SSO、Login、Console 只能 1 个副本（SQLite / JSON 文件）。

### 8.3 备份

- MySQL：自动备份 + 时间点还原（`az mysql flexible-server restore ... --subscription "$SUB"`）；升级前另做一次 `mysqldump --single-transaction`（在 VNet 内）。
- SSO / Login / Console 的数据盘：Azure Disk 快照（`az snapshot create --source <磁盘 ID> --subscription "$SUB" ...`），一致的 SQLite 快照需要先把对应 Deployment 缩到 0。StorageClass 的回收策略是 `Retain`：误删 PVC 时磁盘保留。
- 同时保存镜像 digest 与渲染出的清单（`.generated/<环境>/` 可重新生成）。

### 8.4 日志

Container Insights（`ContainerLogV2`）、AKS / MySQL 指标、App GW 访问与防火墙日志都在 Log Analytics。需要审计时开启 `GHCP_ENABLE_AKS_AUDIT_LOGS`（只含写操作，注意日志量）；MySQL 慢查询 / 审计日志需在服务器参数中开启后再加诊断类别。

### 8.5 删除

`azd down` 会删除资源组及其中的 MySQL 和数据盘，predown hook 默认拒绝；确认已备份后 `azd env set GHCP_ALLOW_AZD_DOWN true`。复用 VNet / AKS 的环境永远拒绝（见第 9 节）。Key Vault 开启了清除保护，删除后在保留期内同名 vault 不能重建。

### 8.6 多企业：新增、轮换、移除

`default` 企业始终由环境变量定义，机密名不变（第 5.1 节）。其他企业写在运维维护的 registry 文件中（格式见 [registry 配置参考](../../docs/multi-enterprise-registry.md)，本部署的示例见 [`enterprise-registry.azure.example.json`](enterprise-registry.azure.example.json)），用 `GHCP_ENTERPRISE_REGISTRY_FILE` 指向它。registry 本身不含机密，可以放在客户的私有仓库中。

**依据代码确认的事实**（`src/packages/shared/src/enterprise/`）：

| registry 字段 | 读取的服务 | 容器内文件（本部署约定） | Key Vault 机密 | 必需 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `sso.signingCert` | SSO | `/run/secrets/<id>/idp-cert.pem` | `ghcp-ent-<id>-saml-idp-cert` | 是 | 运维（该企业**独立**的 SAML 证书） |
| `sso.signingKey` | SSO | `/run/secrets/<id>/idp-key.pem` | `ghcp-ent-<id>-saml-idp-key` | 是 | 运维 |
| `sso.sessionSecret` | SSO | `/run/secrets/<id>/session-secret` | `ghcp-ent-<id>-session-secret` | 是 | postprovision 生成 |
| `sso.scimToken` | SSO | `/run/secrets/<id>/scim-token` | `ghcp-ent-<id>-scim-token` | 是 | 运维 |
| `sso.seatPat` | SSO | `/run/secrets/<id>/seat-pat` | `ghcp-ent-<id>-copilot-seat-pat` | 是 | 运维 |
| `sso.defaultUserPassword` | SSO | `/run/secrets/<id>/default-user-password` | `ghcp-ent-<id>-sso-default-user-password` | 是（账号池要求 ≥16 字符） | postprovision 生成 |
| `modelsAdmin.copilotToken` | Proxy | `/run/secrets/<id>/models-admin-copilot-token` | `ghcp-ent-<id>-models-admin-copilot-token` | 否 | 运维 |

- 这是 registry 中全部 7 个机密字段（`registryFields.ts`）；SSO 读 `sso.*`（`sso/src/enterprises.ts`），Proxy 只读 `modelsAdmin.copilotToken`（`proxy/src/enterprises.ts`），**Login 不读任何机密**。`{"file"}` 必须是绝对路径（`secrets.ts`）。
- 企业 ID 规则 `^[a-z][a-z0-9-]{0,30}[a-z0-9]$`（`scope.ts`），也满足 Key Vault 机密名规则（字母数字和短横线，≤127）；最长的名字约 70 个字符。
- 本部署只接受 `{"file": "/run/secrets/<id>/<文件名>"}` 形式的引用：每个企业的机密不经过环境变量，也不允许指向别的企业的目录。registry 中不能写 `default`。
- 渲染结果：registry 作为 ConfigMap（名字带内容哈希）只读挂载到 Proxy、SSO、Login 的 `/etc/ghcp-registry/enterprise-registry.json`，三者的 ConfigMap 中设置 `ENTERPRISE_REGISTRY_FILE`；SSO 为每个企业挂载一个 SecretProviderClass（`ghcp-sso-ent-<id>`，只含 `sso.*` 的 6 个文件），Proxy 只为配置了 Models token 的企业挂载 `ghcp-proxy-ent-<id>`；Login、Console 不挂载任何企业机密。

**部署前的检查**（渲染脚本与 hook，失败即停止）：未知字段；ID 不合规或重复；registry 中出现 `default`；缺少必需的机密引用；`{"env"}` 引用或路径不符合约定；github.com 企业缺少 `github.shortcode` 或 `github.slug`；GHE.com 企业缺少 `github.slug`、设置了 shortcode、`apiBaseUrl` / `copilotApiBaseUrl` 不在同一个 `<子域>.ghe.com` 下；缺少 `pool.accountDomain`，或 slug / `accountDomain` 与其他企业（含 `default`）重复；各企业 `initialMaxAccounts` 之和超过 10000；`login.ssoLoginUrl` 与 `SSO_PUBLIC_BASE_URL` 不一致（建议省略，Login 按 `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/login` 推导）。`deploy-app.ps1` 还会确认 registry 引用的每个 Key Vault 机密都已存在。

**新增一个企业**（作为单独的变更进行；不需要数据库迁移）：

1. GitHub 侧准备该企业的 slug（github.com 还有 shortcode）、SCIM token、席位 PAT，可选 Models 管理员 token；为它生成**独立的** SAML 签名证书和私钥。
2. 写入 Key Vault：

   ```powershell
   pwsh ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind scim-token -Prompt
   pwsh ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind copilot-seat-pat -Prompt
   pwsh ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind saml-idp-cert -File <证书 PEM>
   pwsh ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind saml-idp-key -File <私钥 PEM>
   pwsh ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind models-admin-copilot-token -Prompt   # 可选
   ```

   `session-secret` 与 `sso-default-user-password` 由下一步的 postprovision 自动生成。
3. 在 registry 文件中追加该企业（从示例复制，`id`、`slug`、`shortcode`、`pool.accountDomain` 有数据后不能修改），首次使用时 `azd env set GHCP_ENTERPRISE_REGISTRY_FILE <路径>`。
4. 重新渲染并部署：`azd hooks run postprovision`（生成缺少的机密、检查、渲染、`kubectl apply`）。registry 的 ConfigMap 名字随内容变化，Proxy（逐个替换）、SSO、Login（`Recreate`）因此**滚动重启**——服务不支持热加载 registry。如需手工重启：`kubectl --kubeconfig .kube/<集群>.config --context <上下文> -n ghcp rollout restart deployment/ghcp-proxy deployment/ghcp-sso deployment/ghcp-login`。
5. GitHub 侧该企业的 SAML 设置：Sign on URL `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/sso`，Issuer `<SSO_PUBLIC_BASE_URL>/enterprises/<id>/metadata`，证书为该企业的 `ghcp-ent-<id>-saml-idp-cert`。`default` 的根路径设置不变。
6. Console **Pool overview**：新企业以 `draft` 出现；处理 Blockers（例如 `sso:enterprise_secret_unconfigured:sso.signingKey`），**Edit cap**，再 **Activate**。按第 6 节小规模观察开户。

**轮换某个企业的机密**：`Set-GhcpSecret.ps1 -Enterprise <id> -Kind <kind> ... -Force`。CSI 驱动约 2 分钟内更新挂载的文件；SSO 对文件机密缓存 60 秒，所以 SCIM token、席位 PAT、session secret、池用户密码无需重启即可生效；**SAML 签名证书与私钥在 SSO 进程内缓存，轮换后需要重启 SSO**（并在 GitHub 中更新证书）；Models token 每次查询都重新读取（`docs/multi-enterprise-registry.md` 第 4 节）。轮换 session secret 会使该企业已有的 SSO 会话失效。

**停用 / 移除**：开通过账号（有池成员、SSO 用户或 Login 任务）的企业**不能**从 registry 删除，否则相关服务以 `enterprise_missing_from_registry` 启动失败；在 Console 中 **Drain**（必要时把 cap 调到最小）。只有从未产生数据的 `draft` 企业可以从 registry 删除，然后 `azd hooks run postprovision`；之后可以删除它的 `ghcp-ent-<id>-*` 机密（Key Vault 开启了软删除 / 清除保护）。

## 9. 复用已有 VNet / AKS（与 LiteLLM 共存）

**复用 VNet**（例如 LiteLLM AKS 模板的 VNet，默认 `10.30.0.0/16`）：

```bash
azd env set GHCP_EXISTING_VNET_NAME <vnet>
azd env set GHCP_EXISTING_VNET_RESOURCE_GROUP <vnet 资源组>
# 已有子网就复用，否则在该 VNet 中新建（网段必须在 VNet 地址空间内且空闲）：
azd env set GHCP_EXISTING_SUBNET_NAMES '{"privateEndpoints":"snet-pe"}'
azd env set GHCP_AKS_SUBNET_PREFIX 10.30.8.0/22
azd env set GHCP_ILB_SUBNET_PREFIX 10.30.12.0/27
azd env set GHCP_APPGW_SUBNET_PREFIX 10.30.13.0/24
# 与 LiteLLM 共用 NAT Gateway（同一个出口 IP）：
azd env set GHCP_EXISTING_NAT_GATEWAY_ID <NAT Gateway 资源 ID>
# 该 VNet 已链接的私有 DNS 区域必须复用（同一区域对同一 VNet 只能链接一次）：
azd env set GHCP_EXISTING_PRIVATE_DNS_ZONE_IDS '{"acr":"<区域资源 ID>","keyVault":"<区域资源 ID>"}'
```

- 网段冲突由使用方保证：`GHCP_SERVICE_CIDR` / `GHCP_POD_CIDR` 不得与 VNet、对等网络、LiteLLM 集群的 Service CIDR（LiteLLM 模板默认 `10.31.0.0/16`）重叠。
- LiteLLM 模板把 CoreDNS 的公网解析转发到外部 DNS，但对 `database.azure.com`、`azurecr.io`、`vaultcore.azure.net` 例外转给 Azure DNS；本部署使用的三个私有区域都落在这些例外中。本部署自己的集群不修改 CoreDNS。
- 模板会在 VNet 所在的资源组中创建子网、NSG 和角色分配：**这类环境绝不能用 `azd down`**（azd 会按部署涉及的资源组清理）；predown hook 会拒绝。删除时只删本部署的资源组，并手工删除新建的子网 / NSG / 角色分配。

**复用 AKS**（GHCP 与 LiteLLM 在同一个集群，LiteLLM 直接经 ClusterIP 访问 Proxy）：

```bash
azd env set GHCP_EXISTING_AKS_NAME <集群>
azd env set GHCP_EXISTING_AKS_RESOURCE_GROUP <集群资源组>
azd env set GHCP_EXISTING_AKS_CONTROL_PLANE_PRINCIPAL_ID <集群控制面标识的对象 ID>   # 可选，用于内部负载均衡子网授权
```

集群管理员事先确认（每条命令都带 `--subscription`）：

```bash
az aks update --resource-group <rg> --name <集群> --enable-oidc-issuer --enable-workload-identity --subscription "$SUB"
az aks enable-addons --resource-group <rg> --name <集群> --addons azure-keyvault-secrets-provider --subscription "$SUB"
az aks update --resource-group <rg> --name <集群> --enable-secret-rotation --subscription "$SUB"
```

- 复用 AKS 时同样需要复用它的 VNet（`GHCP_EXISTING_VNET_*`），私有终结点与内部负载均衡子网都在该 VNet 中。
- 部署身份需要该集群的 Kubernetes 管理权限（Azure RBAC 集群时为 AKS RBAC Cluster Admin，或本地管理员凭据）。
- LiteLLM 模板默认没有网络策略引擎（`networkPolicy: none`），NetworkPolicy 不会生效；渲染脚本在无法确认引擎时默认不启用 `network-policy` 组件。
- 节点池、版本、升级窗口由集群所有者管理；GHCP 的四个服务按 user 池调度。

## 10. 可用区、副本与磁盘

| 组件 | 冗余 | 影响 |
| --- | --- | --- |
| Proxy | ≥2 副本，按节点分散（`ScheduleAnyway`），PDB `minAvailable: 1` | 单节点 / 单可用区故障时继续服务；租约在 MySQL，任何副本都能服务同一调用方 |
| SSO、Login、Console | 1 副本（SQLite / JSON），`Recreate` | 节点故障后在其他节点重建，期间几十秒到数分钟不可用：新账号开户、Console 暂停，已有调用方的推理不受影响 |
| 数据盘 | 默认 `Premium_ZRS` | 区域冗余盘可以挂到同一地域任意可用区的节点，Pod 能跨可用区重建；`Premium_LRS` 固定在一个可用区，该区没有可用节点时 Pod 会一直 Pending。同一时刻只能挂到一个节点 |
| MySQL | 默认区域冗余高可用 | 自动故障切换；Burstable 不支持 |
| 节点池 | 跨三个可用区 | user 池最少 2 个节点，自动伸缩 |
| App GW | 跨可用区、自动伸缩（最小实例数可调） | — |
| NAT Gateway | Standard 为非可用区资源 | 需要区域级冗余时评估 StandardV2（以官方文档为准） |

## 11. 成本驱动（量级，以 Azure 价格计算器为准）

| 项目 | 主要计费因素 | 降本选项 |
| --- | --- | --- |
| AKS 节点 | 2 × D2s_v5（system）+ 2–5 × D4s_v5（user）；AKS Standard 层控制面按集群小时计费 | 测试环境用更小的尺寸、减少节点、`Free` 层（需改模块） |
| MySQL 灵活服务器 | 计算（D2ads_v5）× 2（区域冗余高可用的备用服务器同价）、存储、备份超出部分 | 测试关闭 HA 或用 Burstable |
| Application Gateway WAF_v2 | 固定小时费 + 容量单位（公网模式才有） | 只在需要时开启；`GHCP_APPGW_MIN_CAPACITY` |
| NAT Gateway | 小时费 + 处理的数据量 | 与 LiteLLM 共用 |
| ACR Premium | 固定日费（为私有终结点） | 不需要私有终结点时可改 Standard（需改模块并开放公网） |
| Log Analytics | 采集量（容器日志、审计日志） | `GHCP_LOG_DAILY_QUOTA_GB`、关闭审计日志、缩短保留期 |
| 托管 Prometheus / Grafana | 采样量、Grafana 实例 | 默认关闭 |
| Key Vault、私有终结点、私有 DNS、磁盘 | 每个私有终结点按小时与流量；ZRS 盘比 LRS 略贵 | — |

账号池本身的主要成本在 GitHub Copilot 席位（每个池账号占一个席位，包括空闲账号），不在 Azure。

## 12. 验证了什么、没有验证什么

**已执行（离线，不连接任何订阅或租户）**：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Bicep 编译与 lint | `node --test deploy/azure/azure.test.mjs`（内部调用 Bicep CLI 0.44.1 的 `build`、`lint`、`build-params`） | 通过：编译无警告；按 `bicepconfig.json` 的严格规则（机密参数、输出不含机密等为 error）lint 无诊断；参数文件在默认值和公网开关样例下都能生成 |
| 模板结构 | 同上（检查编译后的 ARM JSON） | 通过：公网相关资源都带条件、默认关闭；MySQL 禁用公网、TLS、utf8mb4、触发器参数、私有终结点 `mysqlServer`；Key Vault RBAC + 默认拒绝；ACR Premium 无管理员账户；AKS Overlay + OIDC + Workload Identity + CSI 轮换；App GW WAF_v2、HTTP/2 关闭、响应缓冲关闭、TLS 策略、HTTPS 监听器、删除 `X-User-Identity`；WAF DRS 2.1 + Bot 1.1；没有 PostgreSQL / Redis；输出不含机密 |
| AKS overlay | `node --test deploy/kubernetes/azure-aks.test.mjs` | 通过：github.com、GHE.com、叠加全部组件三种渲染；镜像为 ACR + r3 digest；**每个 Pod 引用的每个 Secret 键都由它自己挂载的 SecretProviderClass 同步**；base 的安全上下文、副本、更新策略、探针与门禁不变；PVC 使用 Retain 的 Azure Disk 类；MySQL CA 恰为两个根证书且指纹匹配；内部负载均衡都是 internal |
| 渲染脚本 | `azure.test.mjs` | 通过：内网 github.com、公网 GHE.com（+ Proxy 内部负载均衡、DBA 方式、确认）、对外 Proxy（内部负载均衡只放行 App GW 子网）三种环境渲染后 `kubectl kustomize` 成功，除门禁脚本外无 `REPLACE_`；拒绝缺值确认、ConfigMap 中的机密、对全网开放的 Proxy 内部负载均衡 |
| 公网开关校验 | `azure.test.mjs` | 通过：主机名、CIDR、后端、重复主机名、未知键、类型；`proxy` 必须有 `proxyAllowedSourceCidrs`，宽于 /28 与缺少 mTLS 时警告，CA 证书格式校验；Proxy 的 WAF 策略总带来源与路径允许列表 |
| 多企业 | `azure-aks.test.mjs`、`azure.test.mjs` | 通过：default（github.com，环境变量）+ 一个 github.com + 一个 GHE.com 企业渲染成功；**registry 中每个机密文件都只由读取它的 Pod 的 SecretProviderClass 挂载**（SSO 12 个、Proxy 1 个、Login / Console 0 个），default 的原有名称不变；registry ConfigMap 与 `ENTERPRISE_REGISTRY_FILE` 接到 Proxy / SSO / Login；字段、机密字段、读取方、ID 规则与源码一致；24 种非法 registry（ID、`default`、缺少机密、`env` 引用、路径、GHE.com 规则、重复、`ssoLoginUrl` 等）被拒绝 |
| MySQL 账号初始化 | `azure.test.mjs` | 通过：语法；两种方式的授权；密码只作为绑定参数；输入校验 |
| PowerShell hooks | `azure.test.mjs`（有 pwsh 时） | 语法解析；每条 az 命令都经 `Invoke-Az`（追加 `--subscription`），kubectl 都显式带 kubeconfig |
| 仓库卫生 | `azure.test.mjs` | 没有订阅 / 租户 / 对象 ID（只有内置角色定义 ID 和全零示例）、公网 IP、真实主机名、本机路径、私钥或令牌 |
| 既有检查 | `node --test deploy/kubernetes/package.test.mjs` | 通过（13 项，未改动） |

**没有验证**：

- 没有部署到 Azure，没有运行 `what-if`、`az deployment ... validate` 或任何访问订阅的命令。因此 ARM 层面的校验（SKU / 版本在所选地域是否可用、配额、API 版本支持的属性值、`log_bin_trust_function_creators` 等参数的取值格式、MySQL 8.4 的可用性、ZRS 磁盘与 App GW 的可用区支持、角色分配的传播延迟）都要在客户订阅中首次部署时确认。
- hooks 没有实际运行（它们调用 az / azd / kubectl 访问 Azure）；只做了语法与约定检查。
- Key Vault CSI + Workload Identity 同步 Secret、`az acr import` 按 digest 复制、经 ARM 写入私有 Key Vault 的机密、App GW 从私有 Key Vault 读取证书、私有终结点 DNS、内部负载均衡固定 IP 与来源限制、Cilium 下的 NetworkPolicy、MySQL 账号初始化 Job 对真实 Azure MySQL 的连接，都只按官方文档设计，未在 Azure 上运行。
- 多企业：Secrets Store CSI 把同一个 Pod 的多个 SecretProviderClass 卷挂到 `/run/secrets/<id>`（根文件系统只读）、registry 变化触发的滚动重启、新企业在真实 SSO / Login 上的就绪，都未在集群上运行。
- WAF 托管规则对 SSO / Console 实际请求的误报情况未测（建议首次以 `Detection` 观察）；SSE 与 600 秒请求经 App GW 的端到端行为未测。
- 应用本身的行为沿用 `deploy/kubernetes` 在 kind 上的验证（Kubernetes README 第 9 节），本目录没有新增运行时验证。

## 13. 已知限制与待确认

- MySQL 管理员密码保存在运维机器的 azd 环境中（第 5.1 节），建议初始化后轮换。
- 公网开关关闭后不会自动删除 App GW（第 7 节）。
- `SSO_PUBLIC_BASE_URL` 改变需要同步 GitHub SAML 设置（public-access-design.md 第 8 节）。
- 复用 VNet / AKS 时模板在别的资源组创建资源，不能 `azd down`。
- Proxy 的 `verify-ca` 不校验 MySQL 主机名（产品行为）。
- 需要客户确认：订阅与地域、网段规划（尤其与 LiteLLM / 本地网络的重叠）、是否私有集群、MySQL SKU 与高可用、对外主机名与证书、管理员与开发者出口网段、GitHub 侧是否启用 IP 允许列表、日志保留与预算。
