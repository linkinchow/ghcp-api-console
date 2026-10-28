// 子网上的 Network Contributor：AKS 控制面需要在 AKS 子网（节点 NIC）和内部负载均衡子网（前端 IP）上操作。
// 部署到子网所在的资源组（复用 VNet 时是别的资源组）。

param vnetName string
param subnetNames array
param principalId string

var networkContributorRoleId = '4d97b98b-1d4f-4787-a291-c67834d212e7'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

resource subnets 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = [for subnetName in subnetNames: {
  parent: vnet
  name: subnetName
}]

resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (subnetName, i) in subnetNames: {
  name: guid(subnets[i].id, principalId, networkContributorRoleId)
  scope: subnets[i]
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', networkContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}]
