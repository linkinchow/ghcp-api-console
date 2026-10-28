// 网络：VNet、四个子网、NSG、NAT Gateway（固定出口 IP）。
//
// 两条路径：
// - 新建（existingVnetName 为空）：VNet 与子网在同一次 PUT 中声明（子网内联）。只单独声明子网资源、VNet 不带
//   subnets 时，重复部署 VNet 会试图删除子网（InUseSubnetCannotBeDeleted），所以内联。
// - 复用已有 VNet（例如与 LiteLLM 共用）：existingSubnetNames 中给出的子网直接复用；没给出的在该 VNet 中新建
//   （subnet.bicep，部署到 VNet 所在资源组，逐个创建以避免同一 VNet 的并发写冲突）。
//   网段是否与对端冲突由使用方保证：模板看不到对端集群的 serviceCidr / podCidr。
//
// 子网用途：
// - aks：节点 IP（Azure CNI Overlay，Pod 不占 VNet 地址），出口走 NAT Gateway；
// - privateEndpoints：ACR、Key Vault、MySQL 的私有终结点；
// - internalLb：SSO、Console（可选 Proxy）的内部负载均衡前端，IP 固定；
// - appGateway：Application Gateway 专用（v2 建议 /24，至少 /26）。即使不开公网也预留，开启时不必改网络。

@description('部署区域。')
param location string

@description('NSG / NAT 等名称前缀，例如 ghcp-prod。')
param namePrefix string

@description('新建 VNet 的名称。')
param vnetName string

@description('新建 VNet 的地址空间。')
param vnetAddressPrefixes array

@description('新建子网的地址段：{ aks, privateEndpoints, internalLb, appGateway }。')
param subnetPrefixes object

@description('新建子网的名称：{ aks, privateEndpoints, internalLb, appGateway }。')
param subnetNames object

@description('复用已有 VNet 时的名称；为空则新建。')
param existingVnetName string = ''

@description('已有 VNet 的资源组。')
param existingVnetResourceGroup string = ''

@description('复用已有子网的名称：{ aks?, privateEndpoints?, internalLb?, appGateway? }；未给出的子网会新建。')
param existingSubnetNames object = {}

@description('新建 NAT Gateway 并关联到（新建的）AKS 子网。复用已有 AKS 子网时不改动它的出口。')
param createNatGateway bool = true

@description('复用已有 NAT Gateway（资源 ID），关联到新建的 AKS 子网；优先于 createNatGateway。')
param existingNatGatewayId string = ''

@description('NAT Gateway 空闲超时（分钟，4–120）。Proxy 到 Copilot 的非流式推理最长可达 600 秒，默认 15 分钟留足余量。')
@minValue(4)
@maxValue(120)
param natIdleTimeoutMinutes int = 15

@description('App GW 子网 NSG 是否放行来自 Internet 的 443（公网模式）。来源细分由 WAF 自定义规则完成。')
param allowInternetToAppGateway bool = false

param tags object = {}

var createVnet = empty(existingVnetName)
var vnetRg = createVnet ? resourceGroup().name : (empty(existingVnetResourceGroup) ? resourceGroup().name : existingVnetResourceGroup)
var effectiveVnetName = createVnet ? vnetName : existingVnetName

var reuse = {
  aks: !createVnet && !empty(existingSubnetNames.?aks ?? '')
  privateEndpoints: !createVnet && !empty(existingSubnetNames.?privateEndpoints ?? '')
  internalLb: !createVnet && !empty(existingSubnetNames.?internalLb ?? '')
  appGateway: !createVnet && !empty(existingSubnetNames.?appGateway ?? '')
}
var names = {
  aks: reuse.aks ? existingSubnetNames.aks : subnetNames.aks
  privateEndpoints: reuse.privateEndpoints ? existingSubnetNames.privateEndpoints : subnetNames.privateEndpoints
  internalLb: reuse.internalLb ? existingSubnetNames.internalLb : subnetNames.internalLb
  appGateway: reuse.appGateway ? existingSubnetNames.appGateway : subnetNames.appGateway
}

// AKS 子网新建时才关联 NAT；复用的子网保持原有出口（例如客户的防火墙 UDR）。
var natInOurRg = createNatGateway && empty(existingNatGatewayId) && !reuse.aks
var natGatewayId = !empty(existingNatGatewayId) ? existingNatGatewayId : (natInOurRg ? natGateway.id : '')

// App GW v2 子网的必需入站规则：GatewayManager 65200-65535（平台管理）与 AzureLoadBalancer（健康探测）。
var appGwNsgRules = concat([
  {
    name: 'AllowGatewayManager'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'GatewayManager'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '65200-65535'
    }
  }
  {
    name: 'AllowAzureLoadBalancer'
    properties: {
      priority: 110
      direction: 'Inbound'
      access: 'Allow'
      protocol: '*'
      sourceAddressPrefix: 'AzureLoadBalancer'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '*'
    }
  }
  {
    name: 'AllowVnetHttps'
    properties: {
      priority: 120
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'VirtualNetwork'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '443'
    }
  }
], allowInternetToAppGateway ? [
  {
    name: 'AllowInternetHttps'
    properties: {
      priority: 130
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: '*'
      destinationPortRange: '443'
    }
  }
] : [])

// ---------------------------------------------------------------------------
// NAT Gateway：GitHub / GHE.com 的 IP 允许列表、Copilot 侧看到的固定出口地址。
// Standard SKU 是非可用区资源（单个 NAT 实例服务整个子网）；需要区域级冗余时评估 StandardV2（以官方文档为准）。
// ---------------------------------------------------------------------------
resource natPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (natInOurRg) {
  name: 'pip-nat-${namePrefix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = if (natInOurRg) {
  name: 'nat-${namePrefix}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: natIdleTimeoutMinutes
    publicIpAddresses: [
      {
        id: natPip.id
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 新建 VNet：NSG 只为“占住绑定”（企业治理策略会给无 NSG 的子网自动绑定空 NSG，隐式拒绝入站），
// 默认规则（AllowVnetInBound、AllowAzureLoadBalancerInBound）已满足需要；App GW 子网另有必需规则。
// ---------------------------------------------------------------------------
resource nsgAks 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createVnet) {
  name: 'nsg-${namePrefix}-aks'
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource nsgPe 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createVnet) {
  name: 'nsg-${namePrefix}-pe'
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource nsgIlb 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createVnet) {
  name: 'nsg-${namePrefix}-ilb'
  location: location
  tags: tags
  properties: {
    securityRules: []
  }
}

resource nsgAppGw 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (createVnet) {
  name: 'nsg-${namePrefix}-appgw'
  location: location
  tags: tags
  properties: {
    securityRules: appGwNsgRules
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = if (createVnet) {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: vnetAddressPrefixes
    }
    subnets: [
      {
        name: names.aks
        properties: {
          addressPrefix: subnetPrefixes.aks
          networkSecurityGroup: {
            id: nsgAks.id
          }
          natGateway: empty(natGatewayId) ? null : {
            id: natGatewayId
          }
        }
      }
      {
        name: names.privateEndpoints
        properties: {
          addressPrefix: subnetPrefixes.privateEndpoints
          privateEndpointNetworkPolicies: 'Disabled'
          networkSecurityGroup: {
            id: nsgPe.id
          }
        }
      }
      {
        name: names.internalLb
        properties: {
          addressPrefix: subnetPrefixes.internalLb
          networkSecurityGroup: {
            id: nsgIlb.id
          }
        }
      }
      {
        name: names.appGateway
        properties: {
          addressPrefix: subnetPrefixes.appGateway
          networkSecurityGroup: {
            id: nsgAppGw.id
          }
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// 复用已有 VNet：缺少的子网在该 VNet 中新建（逐个，避免并发写同一个 VNet 被拒绝）。
// ---------------------------------------------------------------------------
module byoAksSubnet 'subnet.bicep' = if (!createVnet && !reuse.aks) {
  name: 'ghcp-subnet-aks'
  scope: resourceGroup(vnetRg)
  params: {
    location: location
    vnetName: effectiveVnetName
    subnetName: names.aks
    addressPrefix: subnetPrefixes.aks
    nsgName: 'nsg-${namePrefix}-aks'
    natGatewayId: natGatewayId
    tags: tags
  }
}

module byoPeSubnet 'subnet.bicep' = if (!createVnet && !reuse.privateEndpoints) {
  name: 'ghcp-subnet-pe'
  scope: resourceGroup(vnetRg)
  params: {
    location: location
    vnetName: effectiveVnetName
    subnetName: names.privateEndpoints
    addressPrefix: subnetPrefixes.privateEndpoints
    nsgName: 'nsg-${namePrefix}-pe'
    privateEndpointNetworkPolicies: 'Disabled'
    tags: tags
  }
  dependsOn: [
    byoAksSubnet
  ]
}

module byoIlbSubnet 'subnet.bicep' = if (!createVnet && !reuse.internalLb) {
  name: 'ghcp-subnet-ilb'
  scope: resourceGroup(vnetRg)
  params: {
    location: location
    vnetName: effectiveVnetName
    subnetName: names.internalLb
    addressPrefix: subnetPrefixes.internalLb
    nsgName: 'nsg-${namePrefix}-ilb'
    tags: tags
  }
  dependsOn: [
    byoPeSubnet
  ]
}

module byoAppGwSubnet 'subnet.bicep' = if (!createVnet && !reuse.appGateway) {
  name: 'ghcp-subnet-appgw'
  scope: resourceGroup(vnetRg)
  params: {
    location: location
    vnetName: effectiveVnetName
    subnetName: names.appGateway
    addressPrefix: subnetPrefixes.appGateway
    nsgName: 'nsg-${namePrefix}-appgw'
    nsgRules: appGwNsgRules
    tags: tags
  }
  dependsOn: [
    byoIlbSubnet
  ]
}

// 读回实际网段（复用的子网也一样），供 AKS、MySQL NetworkPolicy、负载均衡来源限制使用。
resource vnetRead 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: effectiveVnetName
  scope: resourceGroup(vnetRg)
}

resource aksSubnetRead 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnetRead
  name: names.aks
}

resource peSubnetRead 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnetRead
  name: names.privateEndpoints
}

resource ilbSubnetRead 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnetRead
  name: names.internalLb
}

resource appGwSubnetRead 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnetRead
  name: names.appGateway
}

output vnetId string = createVnet ? vnet.id : vnetRead.id
output vnetName string = effectiveVnetName
output vnetResourceGroup string = vnetRg
output vnetAddressPrefixes array = createVnet ? vnetAddressPrefixes : vnetRead.properties.addressSpace.addressPrefixes

output aksSubnetId string = resourceId(vnetRg, 'Microsoft.Network/virtualNetworks/subnets', effectiveVnetName, names.aks)
output peSubnetId string = resourceId(vnetRg, 'Microsoft.Network/virtualNetworks/subnets', effectiveVnetName, names.privateEndpoints)
output ilbSubnetId string = resourceId(vnetRg, 'Microsoft.Network/virtualNetworks/subnets', effectiveVnetName, names.internalLb)
output appGwSubnetId string = resourceId(vnetRg, 'Microsoft.Network/virtualNetworks/subnets', effectiveVnetName, names.appGateway)

output aksSubnetName string = names.aks
output ilbSubnetName string = names.internalLb

// 新建子网直接取参数（读回 existing 会与创建并行求值）；复用的子网读回实际值。
output aksSubnetPrefix string = reuse.aks ? aksSubnetRead.properties.addressPrefix : subnetPrefixes.aks
output peSubnetPrefix string = reuse.privateEndpoints ? peSubnetRead.properties.addressPrefix : subnetPrefixes.privateEndpoints
output ilbSubnetPrefix string = reuse.internalLb ? ilbSubnetRead.properties.addressPrefix : subnetPrefixes.internalLb
output appGwSubnetPrefix string = reuse.appGateway ? appGwSubnetRead.properties.addressPrefix : subnetPrefixes.appGateway

@description('NAT Gateway 的出口公网 IP（本模板创建时）。复用已有 NAT / 防火墙时为空，出口地址以客户网络为准。')
output natEgressIp string = natInOurRg ? natPip!.properties.ipAddress : ''
output natGatewayCreated bool = natInOurRg
