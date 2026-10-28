// 在已有 VNet（可能位于其他资源组）中新建一个子网及其 NSG。只在“复用 VNet”路径使用。
// 注意：这里创建的资源位于 VNet 所在的资源组；该资源组不属于本部署，绝不能用 azd down 清理（README 第 9 节）。

param location string
param vnetName string
param subnetName string
param addressPrefix string
param nsgName string
param nsgRules array = []
param natGatewayId string = ''

@allowed([
  'Enabled'
  'Disabled'
])
param privateEndpointNetworkPolicies string = 'Enabled'

param tags object = {}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  tags: tags
  properties: {
    securityRules: nsgRules
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: addressPrefix
    privateEndpointNetworkPolicies: privateEndpointNetworkPolicies
    networkSecurityGroup: {
      id: nsg.id
    }
    natGateway: empty(natGatewayId) ? null : {
      id: natGatewayId
    }
  }
}

output id string = subnet.id
output name string = subnet.name
