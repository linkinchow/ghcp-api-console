// 复用已有 AKS（例如 LiteLLM 所在的集群）：只读取联合身份和 ACR 授权需要的属性，不修改集群。
// 前提（README 第 9 节，部署前由集群管理员确认）：已启用 OIDC issuer、Workload Identity、
// azure-keyvault-secrets-provider 插件；节点能经私有终结点解析和访问本部署的 ACR / Key Vault / MySQL。

param name string

resource cluster 'Microsoft.ContainerService/managedClusters@2024-10-01' existing = {
  name: name
}

output name string = cluster.name
output id string = cluster.id
output oidcIssuerUrl string = cluster.properties.oidcIssuerProfile.issuerURL
output kubeletObjectId string = cluster.properties.identityProfile.kubeletidentity.objectId
output podCidr string = cluster.properties.networkProfile.?podCidr ?? ''
