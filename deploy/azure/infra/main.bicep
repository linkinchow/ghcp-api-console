// GHCP Proxy 多企业版（multi-ea1a29e-amd64-r4）在 Azure 上的基础设施。
// 部署方式：azd（azure.yaml）+ 本文件（订阅级）；参数见 main.bicepparam，说明见 ../README.md。
//
// 资源：VNet / 子网 / NSG / NAT Gateway、AKS（或复用已有 AKS）、Azure Database for MySQL 灵活服务器（私有终结点）、
// ACR（私有终结点）、Key Vault（私有终结点）、Log Analytics（+ 可选托管 Prometheus / Grafana）、
// Workload Identity，以及公网访问开关打开时的 Application Gateway WAF_v2。
// 不使用 PostgreSQL / Redis（旧单企业版的依赖）。

targetScope = 'subscription'

import { publicAccessConfig, existingPrivateDnsZones } from 'types.bicep'

// ---------------------------------------------------------------------------
// 基本
// ---------------------------------------------------------------------------
@description('azd 环境名，用于资源命名。')
@minLength(2)
@maxLength(20)
param environmentName string

@description('部署地域。')
param location string

@description('追加在资源名后的后缀（例如地域代码），可为空。')
param resourceSuffix string = ''

@description('直接指定资源名（只给需要的键）：resourceGroup、vnet、aks、acr、keyVault、mysql。')
param nameOverrides object = {}

@description('所有资源的标签（按客户的标签规范填写）。')
param tags object = {}

// ---------------------------------------------------------------------------
// 应用形态（由渲染脚本写入 Kubernetes 清单，Bicep 只透传）
// ---------------------------------------------------------------------------
@description('GitHub 形态：github.com（EMU）或 ghe.com（数据驻留）。决定渲染哪个 overlay；首次启动后不能更改。')
@allowed([
  'github.com'
  'ghe.com'
])
param githubHosting string = 'github.com'

@description('Proxy 副本数（≥2）。MySQL 连接数约为 (副本数 + 1) × MYSQL_CONNECTION_LIMIT(10)，须小于 max_connections。')
@minValue(2)
@maxValue(20)
param proxyReplicas int = 2

@description('应用所在的 Kubernetes namespace。与 Workload Identity 的联合凭据 subject 绑定，部署后不要更改。')
param kubernetesNamespace string = 'ghcp'

// ---------------------------------------------------------------------------
// 网络（新建，或复用已有 VNet，例如 LiteLLM 的 VNet）
// ---------------------------------------------------------------------------
@description('新建 VNet 的地址空间。默认避开 LiteLLM 模板的默认网段（VNet 10.30.0.0/16、Service 10.31.0.0/16）。')
param vnetAddressPrefixes array = [
  '10.40.0.0/16'
]

@description('AKS 节点子网（Azure CNI Overlay，只有节点占地址）。')
param aksSubnetPrefix string = '10.40.0.0/22'

@description('私有终结点子网（ACR、Key Vault、MySQL）。')
param privateEndpointSubnetPrefix string = '10.40.4.0/26'

@description('内部负载均衡前端子网（SSO、Console、可选 Proxy 的固定内网 IP）。')
param internalLbSubnetPrefix string = '10.40.4.64/27'

@description('Application Gateway 专用子网（v2 建议 /24，至少 /26）。即使不开公网也预留。')
param appGatewaySubnetPrefix string = '10.40.5.0/24'

@description('复用已有 VNet：名称。为空则新建。')
param existingVnetName string = ''

@description('复用已有 VNet：资源组。')
param existingVnetResourceGroup string = ''

@description('复用已有子网：{ aks?, privateEndpoints?, internalLb?, appGateway? }。未给出的在已有 VNet 中新建（用上面的网段）。')
param existingSubnetNames object = {}

@description('新建 NAT Gateway（固定出口 IP）并关联到新建的 AKS 子网。')
param createNatGateway bool = true

@description('复用已有 NAT Gateway 的资源 ID（与 LiteLLM 共用出口 IP 时）。')
param existingNatGatewayId string = ''

@minValue(4)
@maxValue(120)
param natIdleTimeoutMinutes int = 15

@description('复用已有私有 DNS 区域（资源 ID）。复用 VNet 时，该 VNet 已链接的同名区域必须复用（同一区域对同一 VNet 只能链接一次）。')
param existingPrivateDnsZoneIds existingPrivateDnsZones = {}

@description('内部负载均衡的固定 IP：{ sso?, console?, proxy? }；默认取 internalLb 子网的第 4、5、6 个地址（.4/.5/.6）。')
param internalLbIps object = {}

// ---------------------------------------------------------------------------
// AKS（新建，或复用已有集群）
// ---------------------------------------------------------------------------
@description('复用已有 AKS：集群名。为空则新建。前提见 README 第 9 节。')
param existingAksClusterName string = ''

@description('复用已有 AKS：资源组。')
param existingAksResourceGroup string = ''

@description('复用已有 AKS：控制面托管标识的对象 ID（用于授予内部负载均衡子网的 Network Contributor）。为空则由集群管理员自行授权。')
param existingAksControlPlanePrincipalId string = ''

param kubernetesVersion string = ''

@description('节点池与 App GW 的可用区；[] 表示不使用可用区。')
param availabilityZones array = [
  '1'
  '2'
  '3'
]

param systemNodeVmSize string = 'Standard_D2s_v5'
param systemNodeCount int = 2
param userNodeVmSize string = 'Standard_D4s_v5'
param userNodeMinCount int = 2
param userNodeMaxCount int = 5

@description('Pod CIDR（Overlay，不占 VNet 地址；不得与本地 / 对等网络重叠）。')
param podCidr string = '10.244.0.0/16'

@description('Service CIDR（集群内部，不得与任何可达网络重叠，包括共用 VNet 的 LiteLLM 集群的 serviceCidr）。')
param serviceCidr string = '10.41.0.0/16'

@allowed([
  'azure'
  'cilium'
])
param networkDataplane string = 'cilium'

@allowed([
  'none'
  'azure'
  'calico'
  'cilium'
])
param networkPolicy string = 'cilium'

@allowed([
  'userAssignedNATGateway'
  'userDefinedRouting'
  'loadBalancer'
])
param aksOutboundType string = 'userAssignedNATGateway'

@description('私有集群（API server 无公网地址）。开启后 azd / kubectl 必须在 VNet 内执行。')
param privateCluster bool = false

@description('非私有集群时允许访问 API server 的公网 CIDR（建议填运维出口）。')
param apiServerAuthorizedIpRanges array = []

param disableLocalAccounts bool = false
param aksAdminGroupObjectIds array = []

@allowed([
  'none'
  'patch'
  'stable'
  'rapid'
  'node-image'
])
param upgradeChannel string = 'none'

@allowed([
  'None'
  'Unmanaged'
  'NodeImage'
  'SecurityPatch'
])
param nodeOsUpgradeChannel string = 'None'

@description('SSO / Login / Console 数据盘的 SKU；空 = 有可用区时 Premium_ZRS，否则 Premium_LRS。')
@allowed([
  ''
  'Premium_ZRS'
  'Premium_LRS'
  'StandardSSD_ZRS'
  'StandardSSD_LRS'
])
param diskSkuName string = ''

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param mysqlSkuTier string = 'GeneralPurpose'

param mysqlSkuName string = 'Standard_D2ads_v5'

@allowed([
  '8.0.21'
  '8.4'
])
param mysqlVersion string = '8.4'

@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param mysqlHighAvailability string = 'ZoneRedundant'

param mysqlStorageSizeGB int = 64
param mysqlBackupRetentionDays int = 14
param mysqlGeoRedundantBackup bool = false

@description('MySQL 管理员登录名。')
param mysqlAdminLogin string

@secure()
@description('MySQL 管理员密码。由 preprovision hook 生成并保存在 azd 环境中（不入库），部署时同时写入 Key Vault 机密 mysql-admin-password。默认空：azd 在执行 hook 之前就校验参数。')
param mysqlAdminPassword string = ''

@description('log_bin_trust_function_creators=ON（Proxy 自动迁移创建触发器需要）。false 时只能用 DBA 预建表。')
param mysqlTrustFunctionCreators bool = true

// ---------------------------------------------------------------------------
// ACR、Key Vault
// ---------------------------------------------------------------------------
param acrPublicNetworkAccess bool = false

@description('允许访问 Key Vault 数据面的公网 IP（运维出口）。为空 = 仅私有终结点。')
param keyVaultAllowedIpRanges array = []

param keyVaultPurgeProtection bool = true

@description('给执行部署的身份授予 Key Vault Secrets Officer（在 VNet 内用 az keyvault secret set 写入运维机密时需要）。')
param grantDeployerKeyVaultAccess bool = false

@description('给执行部署的身份授予新建 AKS 上的 Azure Kubernetes Service RBAC Cluster Admin（集群启用了 Entra ID + Azure RBAC，hook 用它部署应用）。')
param grantDeployerAksAdmin bool = true

@allowed([
  'User'
  'ServicePrincipal'
])
param deployerPrincipalType string = 'User'

// ---------------------------------------------------------------------------
// 监控
// ---------------------------------------------------------------------------
param logAnalyticsRetentionDays int = 30
param logAnalyticsDailyQuotaGb int = -1
param enableContainerInsights bool = true
param enableManagedPrometheus bool = false
param enableGrafana bool = false
param enableAksAuditLogs bool = false

// ---------------------------------------------------------------------------
// 公网访问开关（默认仅内网）
// ---------------------------------------------------------------------------
@description('公网访问开关，类型见 types.bicep。默认全部关闭。')
param publicAccess publicAccessConfig = {
  sso: false
  console: false
  litellm: false
  allowedSourceCidrs: []
}

@minValue(0)
param appGatewayMinCapacity int = 1

@minValue(2)
param appGatewayMaxCapacity int = 4

@minValue(4)
@maxValue(30)
param appGatewayPublicIpIdleTimeoutMinutes int = 15

// ===========================================================================
// 命名
// ===========================================================================
var suf = empty(resourceSuffix) ? '' : '-${resourceSuffix}'
var base = '${environmentName}${suf}'
var baseFlat = toLower(replace(base, '-', ''))
// 全局唯一的名字（ACR、Key Vault、MySQL 都有公网 DNS 名）带 6 位后缀，同一订阅 + 环境重复部署时不变。
var uniq = substring(uniqueString(subscription().id, environmentName, resourceSuffix), 0, 6)

var names = {
  resourceGroup: nameOverrides.?resourceGroup ?? 'rg-${base}'
  vnet: nameOverrides.?vnet ?? 'vnet-${base}'
  aks: nameOverrides.?aks ?? 'aks-${base}'
  acr: nameOverrides.?acr ?? 'acr${take(baseFlat, 41)}${uniq}'
  keyVault: nameOverrides.?keyVault ?? 'kv${take(baseFlat, 16)}${uniq}'
  mysql: nameOverrides.?mysql ?? 'mysql-${take(toLower(base), 50)}-${uniq}'
  logAnalytics: 'log-${base}'
  workloadIdentity: 'id-${base}-ghcp-workload'
  appGatewayIdentity: 'id-${base}-appgw'
  appGateway: 'agw-${base}'
  monitorWorkspace: 'amw-${base}'
  grafana: take('graf-${baseFlat}', 23)
}

var byoVnet = !empty(existingVnetName)
var byoAks = !empty(existingAksClusterName)
var zonal = !empty(availabilityZones)
var effectiveDiskSku = !empty(diskSkuName) ? diskSkuName : (zonal ? 'Premium_ZRS' : 'Premium_LRS')

var pa = publicAccess
var proxyPublic = pa.?proxy ?? false
var publicEnabled = pa.sso || pa.console || pa.litellm || proxyPublic
var defaultCertificate = 'ghcp-public-tls'
var hosts = {
  sso: pa.?hostNames.?sso ?? ''
  console: pa.?hostNames.?console ?? ''
  litellm: pa.?hostNames.?litellm ?? ''
  proxy: pa.?hostNames.?proxy ?? ''
}
var publicHosts = concat(pa.sso ? [hosts.sso] : [], pa.console ? [hosts.console] : [], pa.litellm ? [hosts.litellm] : [], proxyPublic ? [hosts.proxy] : [])
var splitHorizon = publicEnabled && (pa.?splitHorizonDns ?? true)

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: names.resourceGroup
  location: location
  tags: union(tags, {
    'azd-env-name': environmentName
  })
}

// ===========================================================================
// 网络与私有 DNS
// ===========================================================================
module network 'modules/network.bicep' = {
  name: 'ghcp-network'
  scope: rg
  params: {
    location: location
    namePrefix: base
    vnetName: names.vnet
    vnetAddressPrefixes: vnetAddressPrefixes
    subnetPrefixes: {
      aks: aksSubnetPrefix
      privateEndpoints: privateEndpointSubnetPrefix
      internalLb: internalLbSubnetPrefix
      appGateway: appGatewaySubnetPrefix
    }
    subnetNames: {
      aks: 'snet-ghcp-aks'
      privateEndpoints: 'snet-ghcp-pe'
      internalLb: 'snet-ghcp-ilb'
      appGateway: 'snet-ghcp-appgw'
    }
    existingVnetName: existingVnetName
    existingVnetResourceGroup: existingVnetResourceGroup
    existingSubnetNames: existingSubnetNames
    createNatGateway: createNatGateway
    existingNatGatewayId: existingNatGatewayId
    natIdleTimeoutMinutes: natIdleTimeoutMinutes
    allowInternetToAppGateway: publicEnabled
    tags: tags
  }
}

// With NAT Gateway outbound, AKS adds no egress IP to the API server allowlist (it only does so for load-balancer
// outbound), so nodes could not reach the API server and the cluster failed to provision. Add this template's NAT
// IP whenever an allowlist is set; with an existing NAT gateway or firewall the operator must list its egress IPs.
var effectiveApiServerAuthorizedIpRanges = empty(apiServerAuthorizedIpRanges) ? [] : union(apiServerAuthorizedIpRanges,
  empty(network.outputs.natEgressIp) ? [] : ['${network.outputs.natEgressIp}/32'])

var dnsZoneLinkName = 'link-${base}'

module acrDnsZone 'modules/private-dns-zone.bicep' = if (empty(existingPrivateDnsZoneIds.?acr ?? '')) {
  name: 'ghcp-dns-acr'
  scope: rg
  params: {
    zoneName: 'privatelink.azurecr.io'
    vnetId: network.outputs.vnetId
    linkName: dnsZoneLinkName
    tags: tags
  }
}

module keyVaultDnsZone 'modules/private-dns-zone.bicep' = if (empty(existingPrivateDnsZoneIds.?keyVault ?? '')) {
  name: 'ghcp-dns-kv'
  scope: rg
  params: {
    zoneName: 'privatelink.vaultcore.azure.net'
    vnetId: network.outputs.vnetId
    linkName: dnsZoneLinkName
    tags: tags
  }
}

module mysqlDnsZone 'modules/private-dns-zone.bicep' = if (empty(existingPrivateDnsZoneIds.?mysql ?? '')) {
  name: 'ghcp-dns-mysql'
  scope: rg
  params: {
    zoneName: 'privatelink.mysql.database.azure.com'
    vnetId: network.outputs.vnetId
    linkName: dnsZoneLinkName
    tags: tags
  }
}

var dnsZoneIds = {
  acr: empty(existingPrivateDnsZoneIds.?acr ?? '') ? acrDnsZone!.outputs.id : existingPrivateDnsZoneIds.acr!
  keyVault: empty(existingPrivateDnsZoneIds.?keyVault ?? '') ? keyVaultDnsZone!.outputs.id : existingPrivateDnsZoneIds.keyVault!
  mysql: empty(existingPrivateDnsZoneIds.?mysql ?? '') ? mysqlDnsZone!.outputs.id : existingPrivateDnsZoneIds.mysql!
}

var ilbIps = {
  sso: internalLbIps.?sso ?? cidrHost(network.outputs.ilbSubnetPrefix, 3)
  console: internalLbIps.?console ?? cidrHost(network.outputs.ilbSubnetPrefix, 4)
  proxy: internalLbIps.?proxy ?? cidrHost(network.outputs.ilbSubnetPrefix, 5)
}
var appGatewayPrivateIp = cidrHost(network.outputs.appGwSubnetPrefix, 9)

// ===========================================================================
// 日志
// ===========================================================================
module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'ghcp-log-analytics'
  scope: rg
  params: {
    location: location
    name: names.logAnalytics
    retentionInDays: logAnalyticsRetentionDays
    dailyQuotaGb: logAnalyticsDailyQuotaGb
    tags: tags
  }
}

// ===========================================================================
// AKS
// ===========================================================================
module aks 'modules/aks.bicep' = if (!byoAks) {
  name: 'ghcp-aks'
  scope: rg
  params: {
    location: location
    name: names.aks
    kubernetesVersion: kubernetesVersion
    aksSubnetId: network.outputs.aksSubnetId
    availabilityZones: availabilityZones
    systemNodeVmSize: systemNodeVmSize
    systemNodeCount: systemNodeCount
    userNodeVmSize: userNodeVmSize
    userNodeMinCount: userNodeMinCount
    userNodeMaxCount: userNodeMaxCount
    podCidr: podCidr
    serviceCidr: serviceCidr
    networkDataplane: networkDataplane
    networkPolicy: networkPolicy
    outboundType: aksOutboundType
    privateCluster: privateCluster
    apiServerAuthorizedIpRanges: effectiveApiServerAuthorizedIpRanges
    disableLocalAccounts: disableLocalAccounts
    adminGroupObjectIds: aksAdminGroupObjectIds
    upgradeChannel: upgradeChannel
    nodeOsUpgradeChannel: nodeOsUpgradeChannel
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    enableContainerInsights: enableContainerInsights
    enableManagedPrometheus: enableManagedPrometheus
    enableAuditLogs: enableAksAuditLogs
    clusterAdminPrincipalId: grantDeployerAksAdmin ? deployer().objectId : ''
    clusterAdminPrincipalType: deployerPrincipalType
    tags: tags
  }
}

module aksExisting 'modules/aks-existing.bicep' = if (byoAks) {
  name: 'ghcp-aks-existing'
  scope: resourceGroup(empty(existingAksResourceGroup) ? names.resourceGroup : existingAksResourceGroup)
  params: {
    name: existingAksClusterName
  }
}

var cluster = {
  name: byoAks ? existingAksClusterName : names.aks
  resourceGroup: byoAks ? (empty(existingAksResourceGroup) ? names.resourceGroup : existingAksResourceGroup) : names.resourceGroup
  oidcIssuerUrl: byoAks ? aksExisting!.outputs.oidcIssuerUrl : aks!.outputs.oidcIssuerUrl
  kubeletObjectId: byoAks ? aksExisting!.outputs.kubeletObjectId : aks!.outputs.kubeletObjectId
  podCidr: byoAks ? aksExisting!.outputs.podCidr : podCidr
}

// AKS 控制面需要在节点子网和内部负载均衡子网上创建 / 关联前端 IP。
var controlPlanePrincipalId = byoAks ? existingAksControlPlanePrincipalId : aks!.outputs.controlPlanePrincipalId
var controlPlaneSubnets = byoAks ? [network.outputs.ilbSubnetName] : [network.outputs.aksSubnetName, network.outputs.ilbSubnetName]

module subnetRoles 'modules/subnet-role-assignment.bicep' = if (!byoAks || !empty(existingAksControlPlanePrincipalId)) {
  name: 'ghcp-subnet-roles'
  scope: resourceGroup(byoVnet ? (empty(existingVnetResourceGroup) ? names.resourceGroup : existingVnetResourceGroup) : names.resourceGroup)
  params: {
    vnetName: network.outputs.vnetName
    subnetNames: controlPlaneSubnets
    principalId: controlPlanePrincipalId
  }
}

module prometheus 'modules/managed-prometheus.bicep' = if (enableManagedPrometheus && !byoAks) {
  name: 'ghcp-managed-prometheus'
  scope: rg
  params: {
    location: location
    clusterName: names.aks
    monitorWorkspaceName: names.monitorWorkspace
    namePrefix: base
    enableGrafana: enableGrafana
    grafanaName: names.grafana
    tags: tags
  }
  dependsOn: [
    aks
  ]
}

// ===========================================================================
// 身份、ACR、Key Vault、MySQL
// ===========================================================================
module workloadIdentity 'modules/workload-identity.bicep' = {
  name: 'ghcp-workload-identity'
  scope: rg
  params: {
    location: location
    name: names.workloadIdentity
    oidcIssuerUrl: cluster.oidcIssuerUrl
    serviceAccountNamespace: kubernetesNamespace
    tags: tags
  }
}

module acr 'modules/acr.bicep' = {
  name: 'ghcp-acr'
  scope: rg
  params: {
    location: location
    name: names.acr
    privateEndpointSubnetId: network.outputs.peSubnetId
    privateDnsZoneId: dnsZoneIds.acr
    publicNetworkAccess: acrPublicNetworkAccess
    zoneRedundancy: zonal
    tags: tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'ghcp-key-vault'
  scope: rg
  params: {
    location: location
    name: names.keyVault
    tenantId: tenant().tenantId
    privateEndpointSubnetId: network.outputs.peSubnetId
    privateDnsZoneId: dnsZoneIds.keyVault
    allowedIpRanges: keyVaultAllowedIpRanges
    enablePurgeProtection: keyVaultPurgeProtection
    tags: tags
  }
}

module mysql 'modules/mysql.bicep' = {
  name: 'ghcp-mysql'
  scope: rg
  params: {
    location: location
    name: names.mysql
    skuTier: mysqlSkuTier
    skuName: mysqlSkuName
    version: mysqlVersion
    highAvailability: mysqlHighAvailability
    storageSizeGB: mysqlStorageSizeGB
    backupRetentionDays: mysqlBackupRetentionDays
    geoRedundantBackup: mysqlGeoRedundantBackup
    administratorLogin: mysqlAdminLogin
    administratorLoginPassword: mysqlAdminPassword
    trustFunctionCreators: mysqlTrustFunctionCreators
    privateEndpointSubnetId: network.outputs.peSubnetId
    privateDnsZoneId: dnsZoneIds.mysql
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    tags: tags
  }
}

// 管理员密码同时放进 Key Vault：DBA 从这里取，MySQL 账号初始化 Job（k8s/mysql-bootstrap）也从这里挂载。
module mysqlAdminSecret 'modules/key-vault-secret.bicep' = if (!empty(mysqlAdminPassword)) {
  name: 'ghcp-kv-mysql-admin'
  scope: rg
  params: {
    keyVaultName: keyVault.outputs.name
    secretName: 'mysql-admin-password'
    secretValue: mysqlAdminPassword
  }
}

// App GW 读取 Key Vault 证书用的标识（只在公网模式创建）。
module appGatewayIdentityCreate 'modules/user-assigned-identity.bicep' = if (publicEnabled) {
  name: 'ghcp-appgw-identity'
  scope: rg
  params: {
    location: location
    name: names.appGatewayIdentity
    tags: tags
  }
}

module roles 'modules/role-assignments.bicep' = {
  name: 'ghcp-role-assignments'
  scope: rg
  params: {
    acrName: acr.outputs.name
    keyVaultName: keyVault.outputs.name
    kubeletObjectId: cluster.kubeletObjectId
    keyVaultReaderPrincipalIds: concat([workloadIdentity.outputs.principalId], publicEnabled ? [appGatewayIdentityCreate!.outputs.principalId] : [])
    keyVaultOfficerPrincipalId: grantDeployerKeyVaultAccess ? deployer().objectId : ''
    keyVaultOfficerPrincipalType: deployerPrincipalType
  }
}

// ===========================================================================
// 公网访问：Application Gateway WAF_v2（只在开关打开时部署）
// ===========================================================================
func sourceAllowlistRule(priority int, cidrs array) object => {
  name: 'AllowListedSourcesOnly'
  priority: priority
  ruleType: 'MatchRule'
  action: 'Block'
  state: 'Enabled'
  matchConditions: [
    {
      matchVariables: [
        {
          variableName: 'RemoteAddr'
        }
      ]
      operator: 'IPMatch'
      negationConditon: true
      matchValues: cidrs
    }
  ]
}

func pathRule(name string, priority int, prefixes array, negate bool) object => {
  name: name
  priority: priority
  ruleType: 'MatchRule'
  action: 'Block'
  state: 'Enabled'
  matchConditions: [
    {
      matchVariables: [
        {
          variableName: 'RequestUri'
        }
      ]
      operator: 'BeginsWith'
      negationConditon: negate
      matchValues: prefixes
      transforms: [
        'UrlDecode'
        'Lowercase'
      ]
    }
  ]
}

func postRateLimitRule(name string, priority int, pathSuffix string, threshold int) object => {
  name: name
  priority: priority
  ruleType: 'RateLimitRule'
  action: 'Block'
  state: 'Enabled'
  rateLimitDuration: 'OneMin'
  rateLimitThreshold: threshold
  groupByUserSession: [
    {
      groupByVariables: [
        {
          variableName: 'ClientAddr'
        }
      ]
    }
  ]
  matchConditions: [
    {
      matchVariables: [
        {
          variableName: 'RequestMethod'
        }
      ]
      operator: 'Equal'
      negationConditon: false
      matchValues: [
        'POST'
      ]
    }
    {
      matchVariables: [
        {
          variableName: 'RequestUri'
        }
      ]
      operator: 'EndsWith'
      negationConditon: false
      matchValues: [
        pathSuffix
      ]
      transforms: [
        'Lowercase'
      ]
    }
  ]
}

func argExclusion(selector string) object => {
  matchVariable: 'RequestArgNames'
  selectorMatchOperator: 'Equals'
  selector: selector
}

// VNet 地址空间总是放行（Login 的 Chromium 经私网监听器访问 SSO；VNet 内的管理员）。
var vnetCidrs = network.outputs.vnetAddressPrefixes
var adminCidrs = union(vnetCidrs, pa.allowedSourceCidrs)
var litellmCidrs = union(vnetCidrs, pa.?litellmAllowedSourceCidrs ?? pa.allowedSourceCidrs)
var wafMode = pa.?wafMode ?? 'Prevention'

// SSO 只开放 SAML 浏览器页面（default 企业在根路径，其他企业在 /enterprises/<id>/）；/api、/internal 是内部接口。
var ssoPublicPaths = [
  '/sso'
  '/metadata'
  '/login'
  '/logout'
  '/enterprises/'
]
var defaultLitellmPaths = [
  '/v1/'
  '/chat/completions'
  '/completions'
  '/embeddings'
  '/responses'
  '/messages'
  '/models'
  '/health/liveliness'
]

module wafDefault 'modules/waf-policy.bicep' = if (publicEnabled) {
  name: 'ghcp-waf-default'
  scope: rg
  params: {
    location: location
    name: 'waf-${base}-default'
    mode: wafMode
    tags: tags
  }
}

module wafSso 'modules/waf-policy.bicep' = if (pa.sso) {
  name: 'ghcp-waf-sso'
  scope: rg
  params: {
    location: location
    name: 'waf-${base}-sso'
    mode: wafMode
    customRules: concat((pa.?ssoAllowAnySource ?? false) ? [] : [sourceAllowlistRule(10, adminCidrs)], [
      pathRule('AllowSamlPathsOnly', 20, ssoPublicPaths, true)
      pathRule('BlockManagementPaths', 30, ['/api', '/internal'], false)
      postRateLimitRule('RateLimitPasswordLogin', 40, '/login', 60)
    ])
    // SAML 重定向绑定的 SAMLRequest（deflate + base64）与 RelayState、登录密码是任意字符，托管规则会误报。
    exclusions: [
      argExclusion('SAMLRequest')
      argExclusion('RelayState')
      argExclusion('SigAlg')
      argExclusion('Signature')
      argExclusion('password')
    ]
    tags: tags
  }
}

module wafConsole 'modules/waf-policy.bicep' = if (pa.console) {
  name: 'ghcp-waf-console'
  scope: rg
  params: {
    location: location
    name: 'waf-${base}-console'
    mode: wafMode
    // Console 只对管理网段开放，不提供“任意来源”选项。
    customRules: [
      sourceAllowlistRule(10, adminCidrs)
      postRateLimitRule('RateLimitPasswordLogin', 40, '/login', 30)
    ]
    exclusions: [
      argExclusion('password')
      argExclusion('currentPassword')
      argExclusion('newPassword')
    ]
    // Console 的导入接口接收 CSV / JSON，上限放宽到 1 MB。
    maxRequestBodySizeInKb: 1024
    tags: tags
  }
}

module wafLitellm 'modules/waf-policy.bicep' = if (pa.litellm) {
  name: 'ghcp-waf-litellm'
  scope: rg
  params: {
    location: location
    name: 'waf-${base}-litellm'
    mode: wafMode
    requestBodyCheck: false
    customRules: concat((pa.?litellmAllowAnySource ?? false) ? [] : [sourceAllowlistRule(10, litellmCidrs)], [
      pathRule('AllowInferencePathsOnly', 20, map(pa.?litellmAllowedPathPrefixes ?? defaultLitellmPaths, p => toLower(p)), true)
    ])
    tags: tags
  }
}

// Proxy（默认关闭，不推荐）：持有共享 API_KEY 的任何人都能冒用任意 X-User-Identity。只放行 LiteLLM 的出口 IP
// （不提供“任意来源”）和公开的推理路径；/api、/internal、/healthz、/readyz 全部拦截。不删除 X-User-Identity（Proxy 需要它）。
var proxyInferencePaths = [
  '/v1/messages'
  '/chat/completions'
  '/responses'
  '/v1/models'
]

module wafProxy 'modules/waf-policy.bicep' = if (proxyPublic) {
  name: 'ghcp-waf-proxy'
  scope: rg
  params: {
    location: location
    name: 'waf-${base}-proxy'
    mode: wafMode
    requestBodyCheck: false
    customRules: [
      sourceAllowlistRule(10, union(vnetCidrs, pa.?proxyAllowedSourceCidrs ?? []))
      pathRule('AllowInferencePathsOnly', 20, proxyInferencePaths, true)
      pathRule('BlockManagementPaths', 30, ['/api', '/internal'], false)
    ]
    tags: tags
  }
}

var publicEndpoints = concat(proxyPublic ? [
  {
    key: 'proxy'
    hostName: hosts.proxy
    backendAddress: ilbIps.proxy
    backendPort: 3000
    probePath: '/readyz'
    requestTimeout: 900
    certificateName: pa.?certificateNames.?proxy ?? defaultCertificate
    wafPolicyId: wafProxy!.outputs.id
    stripIdentityHeader: false
    mutualTls: !empty(pa.?proxyClientCaCertificate ?? '')
  }
] : [], pa.sso ? [
  {
    key: 'sso'
    hostName: hosts.sso
    backendAddress: ilbIps.sso
    backendPort: 7001
    probePath: '/healthz'
    requestTimeout: 60
    certificateName: pa.?certificateNames.?sso ?? defaultCertificate
    wafPolicyId: wafSso!.outputs.id
    stripIdentityHeader: false
  }
] : [], pa.console ? [
  {
    key: 'console'
    hostName: hosts.console
    backendAddress: ilbIps.console
    backendPort: 7004
    probePath: '/healthz'
    requestTimeout: 120
    certificateName: pa.?certificateNames.?console ?? defaultCertificate
    wafPolicyId: wafConsole!.outputs.id
    stripIdentityHeader: false
  }
] : [], pa.litellm ? [
  {
    key: 'litellm'
    hostName: hosts.litellm
    backendAddress: pa.?litellmBackend.?address ?? ''
    backendPort: pa.?litellmBackend.?port ?? 4000
    probePath: pa.?litellmBackend.?probePath ?? '/health/liveliness'
    // Proxy 的推理时限最长 600 秒（POOL_INFERENCE_TIMEOUT_SECONDS），加上 LiteLLM 自身开销。
    requestTimeout: 900
    certificateName: pa.?certificateNames.?litellm ?? defaultCertificate
    wafPolicyId: wafLitellm!.outputs.id
    stripIdentityHeader: true
  }
] : [])

module appGateway 'modules/app-gateway.bicep' = if (publicEnabled) {
  name: 'ghcp-app-gateway'
  scope: rg
  params: {
    location: location
    name: names.appGateway
    subnetId: network.outputs.appGwSubnetId
    privateFrontendIp: appGatewayPrivateIp
    identityId: appGatewayIdentityCreate!.outputs.id
    keyVaultUri: keyVault.outputs.uri
    endpoints: publicEndpoints
    clientCaCertificateData: proxyPublic ? (pa.?proxyClientCaCertificate ?? '') : ''
    defaultWafPolicyId: wafDefault!.outputs.id
    availabilityZones: availabilityZones
    minCapacity: appGatewayMinCapacity
    maxCapacity: appGatewayMaxCapacity
    publicIpIdleTimeoutMinutes: appGatewayPublicIpIdleTimeoutMinutes
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    tags: tags
  }
  // App GW 创建时就要读取 Key Vault 中的证书：先完成角色分配。
  dependsOn: [
    roles
  ]
}

// split-horizon：VNet 内把对外主机名解析到 App GW 私网前端（区域名就是主机名，A 记录在区域根）。
module publicHostZones 'modules/private-dns-zone.bicep' = [for host in publicHosts: if (splitHorizon) {
  name: 'ghcp-dns-host-${uniqueString(host)}'
  scope: rg
  params: {
    zoneName: host
    vnetId: network.outputs.vnetId
    linkName: dnsZoneLinkName
    aRecords: [
      {
        name: '@'
        ipv4Address: appGatewayPrivateIp
      }
    ]
    tags: tags
  }
}]

// ===========================================================================
// 输出（大写的会被 azd 写入环境，供 hooks/ 与 scripts/render-overlay.mjs 使用）
// ===========================================================================
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_AKS_CLUSTER_NAME string = cluster.name
output AZURE_AKS_RESOURCE_GROUP string = cluster.resourceGroup
output AZURE_CONTAINER_REGISTRY_NAME string = acr.outputs.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = acr.outputs.loginServer
output AZURE_KEY_VAULT_NAME string = keyVault.outputs.name
output AZURE_KEY_VAULT_RESOURCE_ID string = keyVault.outputs.id
output GHCP_WORKLOAD_CLIENT_ID string = workloadIdentity.outputs.clientId
output GHCP_NAMESPACE string = kubernetesNamespace
output GHCP_GITHUB_HOSTING string = githubHosting
output GHCP_PROXY_REPLICAS int = proxyReplicas
output GHCP_DISK_SKU string = effectiveDiskSku
output GHCP_NETWORK_POLICY_ENGINE string = byoAks ? 'unknown' : networkPolicy
output GHCP_BYO_NETWORK bool = byoVnet
output GHCP_BYO_AKS bool = byoAks
output MYSQL_SERVER_NAME string = mysql.outputs.name
output MYSQL_FQDN string = mysql.outputs.fqdn
output MYSQL_ADMIN_LOGIN string = mysqlAdminLogin
output MYSQL_DATABASE string = mysql.outputs.databaseName
output NAT_EGRESS_IP string = network.outputs.natEgressIp
output VNET_ADDRESS_PREFIXES string = join(network.outputs.vnetAddressPrefixes, ',')
output AKS_SUBNET_PREFIX string = network.outputs.aksSubnetPrefix
output PE_SUBNET_PREFIX string = network.outputs.peSubnetPrefix
output APPGW_SUBNET_PREFIX string = network.outputs.appGwSubnetPrefix
output POD_CIDR string = cluster.podCidr
output GHCP_ILB_SUBNET_NAME string = network.outputs.ilbSubnetName
output GHCP_SSO_ILB_IP string = ilbIps.sso
output GHCP_CONSOLE_ILB_IP string = ilbIps.console
output GHCP_PROXY_ILB_IP string = ilbIps.proxy
output GHCP_PUBLIC_ACCESS_ENABLED bool = publicEnabled
output GHCP_PUBLIC_SSO_HOST string = pa.sso ? hosts.sso : ''
output GHCP_PUBLIC_CONSOLE_HOST string = pa.console ? hosts.console : ''
output GHCP_PUBLIC_LITELLM_HOST string = pa.litellm ? hosts.litellm : ''
output GHCP_PUBLIC_PROXY_HOST string = proxyPublic ? hosts.proxy : ''
output APPGW_PUBLIC_IP string = publicEnabled ? appGateway!.outputs.publicIpAddress : ''
output APPGW_PRIVATE_IP string = publicEnabled ? appGatewayPrivateIp : ''
output GRAFANA_ENDPOINT string = enableManagedPrometheus && !byoAks ? prometheus!.outputs.grafanaEndpoint : ''
