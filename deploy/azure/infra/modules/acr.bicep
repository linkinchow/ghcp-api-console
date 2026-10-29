// 私有镜像仓库：只存放从 Docker Hub 按 digest 复制来的四个发布镜像（postprovision hook 执行 az acr import），
// 本项目不构建镜像。用 ACR 的原因：
// - 运行的镜像与 docs/multi-enterprise-release-validation.md 记录的 digest 字节相同，且不依赖 Docker Hub 的可用性和匿名拉取限额；
// - 节点拉镜像不出 VNet（私有终结点），kubelet 用托管标识认证（AcrPull），集群不需要 imagePullSecrets。
// Premium 是为了私有终结点（Basic / Standard 不支持），不是为了容量。

param location string
param name string
param privateEndpointSubnetId string
param privateDnsZoneId string

@description('公网访问。默认关闭：az acr import 是服务端的仓库到仓库复制，不需要公网入口；关闭后 repository list 等数据面命令只能在 VNet 内执行。')
param publicNetworkAccess bool = false

@description('区域冗余（Premium 支持的地域）。')
param zoneRedundancy bool = true

param tags object = {}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Premium'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: publicNetworkAccess ? 'Enabled' : 'Disabled'
    // 显式声明：用 CLI 关闭公网时会把它改成 Deny 并保留，之后重新开启公网会表现为“开着但拒绝所有人”。
    // 公网关闭时它不起作用。
    networkRuleSet: {
      defaultAction: 'Allow'
    }
    // 允许受信任的 Azure 服务（ACR 自身的 import 任务等）在公网关闭时访问。
    networkRuleBypassOptions: 'AzureServices'
    zoneRedundancy: zoneRedundancy ? 'Enabled' : 'Disabled'
  }
}

module privateEndpoint 'private-endpoint.bicep' = {
  name: 'ghcp-pe-acr'
  params: {
    location: location
    name: 'pe-${name}'
    subnetId: privateEndpointSubnetId
    targetResourceId: registry.id
    groupId: 'registry'
    privateDnsZoneId: privateDnsZoneId
    tags: tags
  }
}

output id string = registry.id
output name string = registry.name
output loginServer string = registry.properties.loginServer
