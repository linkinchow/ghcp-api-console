// AKS：system / user 两个节点池，Azure CNI Overlay，Workload Identity + OIDC，Key Vault CSI 插件，Container Insights。
//
// - Azure CNI Overlay：节点 IP 来自 VNet，Pod 来自 podCidr（不占 VNet 地址），出 VNet 时 SNAT 为节点 IP。
//   这让 MySQL 账号来源、内部负载均衡来源限制都能按节点子网写。与 LiteLLM、旧版 GHCP 的集群一致。
// - 网络策略默认 Cilium（networkDataplane 与 networkPolicy 都为 cilium）：deploy/kubernetes 的 network-policy 组件
//   需要一个执行 NetworkPolicy 的引擎；引擎在集群创建后不能更换。
// - 出口默认 userAssignedNATGateway：所有出站（GitHub、Copilot、Docker Hub 以外）都从 NAT 的固定公网 IP 出去。
//   复用的子网走客户防火墙时改为 userDefinedRouting。

param location string
param name string

@description('Kubernetes 版本；空 = 平台默认版本。生产请固定（az aks get-versions --location <地域> --subscription <订阅>）。')
param kubernetesVersion string = ''

param aksSubnetId string

@description('节点池可用区；[] 表示不使用可用区（Azure Disk 只能用 LRS）。')
param availabilityZones array = [
  '1'
  '2'
  '3'
]

param systemNodeVmSize string = 'Standard_D2s_v5'

@minValue(1)
param systemNodeCount int = 2

param userNodeVmSize string = 'Standard_D4s_v5'

@minValue(1)
param userNodeMinCount int = 2

@minValue(1)
param userNodeMaxCount int = 5

@minValue(30)
@maxValue(250)
param maxPodsPerNode int = 110

param podCidr string = '10.244.0.0/16'
param serviceCidr string = '10.41.0.0/16'

@allowed([
  'azure'
  'cilium'
])
param networkDataplane string = 'cilium'

@description('网络策略引擎。cilium 要求 networkDataplane=cilium；none 时 network-policy 组件不生效。')
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
param outboundType string = 'userAssignedNATGateway'

@description('私有集群：API server 只有私网地址；azd / kubectl 必须在 VNet 内（或经 VPN / 跳板机）执行。')
param privateCluster bool = false

@description('非私有集群时，允许访问 API server 的公网来源（CIDR）。空 = 不限制（不推荐生产）。')
param apiServerAuthorizedIpRanges array = []

@description('禁用本地账户（只允许 Entra ID + Azure RBAC）。开启后 hook 使用 kubelogin（README 第 2 节）。')
param disableLocalAccounts bool = false

@description('拥有集群管理员权限的 Entra 组（对象 ID）。')
param adminGroupObjectIds array = []

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

param logAnalyticsWorkspaceId string

@description('Container Insights（容器 stdout → Log Analytics）。')
param enableContainerInsights bool = true

@description('托管 Prometheus 的采集组件（ama-metrics）。数据写入哪个 Azure Monitor 工作区由 managed-prometheus.bicep 的 DCR 关联决定。')
param enableManagedPrometheus bool = false

@description('kube-audit-admin 审计日志（只含写操作）。空闲集群也会产生可观的日志量，按合规需要开启。')
param enableAuditLogs bool = false

@description('授予 Azure Kubernetes Service RBAC Cluster Admin 的主体（执行部署的人或流水线），hook 需要它在集群中创建 namespace、Job 和应用。为空则不授予。')
param clusterAdminPrincipalId string = ''

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param clusterAdminPrincipalType string = 'User'

param tags object = {}

var zones = empty(availabilityZones) ? null : availabilityZones
var aksRbacClusterAdminRoleId = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'
var version = empty(kubernetesVersion) ? null : kubernetesVersion

resource cluster 'Microsoft.ContainerService/managedClusters@2024-10-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    dnsPrefix: name
    kubernetesVersion: version
    nodeResourceGroup: 'MC_${resourceGroup().name}_${name}'
    enableRBAC: true
    disableLocalAccounts: disableLocalAccounts
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      adminGroupObjectIDs: adminGroupObjectIds
    }
    apiServerAccessProfile: {
      enablePrivateCluster: privateCluster
      privateDNSZone: privateCluster ? 'system' : null
      authorizedIPRanges: privateCluster ? null : apiServerAuthorizedIpRanges
    }
    oidcIssuerProfile: {
      enabled: true
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
      imageCleaner: {
        enabled: true
        intervalHours: 168
      }
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkDataplane: networkDataplane
      networkPolicy: networkPolicy
      podCidr: podCidr
      serviceCidr: serviceCidr
      // CoreDNS 必须在 serviceCidr 内；推导出来避免写错。
      dnsServiceIP: cidrHost(serviceCidr, 9)
      outboundType: outboundType
      loadBalancerSku: 'standard'
    }
    autoUpgradeProfile: {
      upgradeChannel: upgradeChannel
      nodeOSUpgradeChannel: nodeOsUpgradeChannel
    }
    addonProfiles: {
      // Key Vault CSI：Pod 挂载 Key Vault 机密并同步为 Kubernetes Secret；开启轮换（2 分钟轮询）。
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '2m'
        }
      }
      omsagent: enableContainerInsights ? {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: logAnalyticsWorkspaceId
          useAADAuth: 'true'
        }
      } : {
        enabled: false
      }
    }
    azureMonitorProfile: {
      metrics: {
        enabled: enableManagedPrometheus
      }
    }
    agentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        vmSize: systemNodeVmSize
        count: systemNodeCount
        maxPods: maxPodsPerNode
        availabilityZones: zones
        osType: 'Linux'
        osSKU: 'Ubuntu'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: aksSubnetId
        orchestratorVersion: version
        upgradeSettings: {
          maxSurge: '1'
        }
        // 只运行 kube-system；应用调度到 user 池。
        nodeTaints: [
          'CriticalAddonsOnly=true:NoSchedule'
        ]
      }
      {
        name: 'user'
        mode: 'User'
        vmSize: userNodeVmSize
        count: userNodeMinCount
        minCount: userNodeMinCount
        maxCount: userNodeMaxCount
        enableAutoScaling: true
        maxPods: maxPodsPerNode
        availabilityZones: zones
        osType: 'Linux'
        osSKU: 'Ubuntu'
        type: 'VirtualMachineScaleSets'
        vnetSubnetID: aksSubnetId
        orchestratorVersion: version
        upgradeSettings: {
          maxSurge: '33%'
        }
      }
    ]
  }
}

// 自动升级只在维护窗口内进行（只有开启对应通道时才创建窗口）。
resource upgradeWindow 'Microsoft.ContainerService/managedClusters/maintenanceConfigurations@2024-10-01' = if (upgradeChannel != 'none') {
  parent: cluster
  name: 'aksManagedAutoUpgradeSchedule'
  properties: {
    maintenanceWindow: {
      schedule: {
        weekly: {
          dayOfWeek: 'Saturday'
          intervalWeeks: 1
        }
      }
      durationHours: 4
      startTime: '18:00'
      utcOffset: '+00:00'
    }
  }
}

resource nodeOsWindow 'Microsoft.ContainerService/managedClusters/maintenanceConfigurations@2024-10-01' = if (nodeOsUpgradeChannel != 'None') {
  parent: cluster
  name: 'aksManagedNodeOSUpgradeSchedule'
  properties: {
    maintenanceWindow: {
      schedule: {
        weekly: {
          dayOfWeek: 'Sunday'
          intervalWeeks: 1
        }
      }
      durationHours: 4
      startTime: '18:00'
      utcOffset: '+00:00'
    }
  }
}

// Container Insights 使用托管标识认证（useAADAuth）时，采集内容由数据收集规则决定，ARM 部署需要显式创建规则与关联
// （CLI 会代劳，模板不会）。只采集 ContainerLogV2 与清单 / 性能数据；namespace 过滤关闭。
var containerInsightsStreams = [
  'Microsoft-ContainerLogV2'
  'Microsoft-KubeEvents'
  'Microsoft-KubePodInventory'
  'Microsoft-KubeNodeInventory'
  'Microsoft-KubePVInventory'
  'Microsoft-KubeServices'
  'Microsoft-KubeMonAgentEvents'
  'Microsoft-InsightsMetrics'
  'Microsoft-ContainerInventory'
  'Microsoft-ContainerNodeInventory'
  'Microsoft-Perf'
]

resource containerInsightsRule 'Microsoft.Insights/dataCollectionRules@2022-06-01' = if (enableContainerInsights) {
  name: take('MSCI-${location}-${name}', 64)
  location: location
  tags: tags
  kind: 'Linux'
  properties: {
    dataSources: {
      extensions: [
        {
          name: 'ContainerInsightsExtension'
          extensionName: 'ContainerInsights'
          streams: containerInsightsStreams
          extensionSettings: {
            dataCollectionSettings: {
              interval: '1m'
              namespaceFilteringMode: 'Off'
              enableContainerLogV2: true
            }
          }
        }
      ]
    }
    destinations: {
      logAnalytics: [
        {
          name: 'ciworkspace'
          workspaceResourceId: logAnalyticsWorkspaceId
        }
      ]
    }
    dataFlows: [
      {
        streams: containerInsightsStreams
        destinations: [
          'ciworkspace'
        ]
      }
    ]
  }
}

resource containerInsightsAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2022-06-01' = if (enableContainerInsights) {
  name: 'ContainerInsightsExtension'
  scope: cluster
  properties: {
    dataCollectionRuleId: containerInsightsRule.id
    description: 'Container Insights → Log Analytics'
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'ghcp-aks'
  scope: cluster
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'kube-audit-admin'
        enabled: enableAuditLogs
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource clusterAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(clusterAdminPrincipalId)) {
  name: guid(cluster.id, clusterAdminPrincipalId, aksRbacClusterAdminRoleId)
  scope: cluster
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aksRbacClusterAdminRoleId)
    principalId: clusterAdminPrincipalId
    principalType: clusterAdminPrincipalType
  }
}

output name string = cluster.name
output id string = cluster.id
output oidcIssuerUrl string = cluster.properties.oidcIssuerProfile.issuerURL
output kubeletObjectId string = cluster.properties.identityProfile.kubeletidentity.objectId
output controlPlanePrincipalId string = cluster.identity.principalId
