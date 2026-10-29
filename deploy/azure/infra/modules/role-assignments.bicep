// 资源组内的角色分配：ACR（AcrPull）、Key Vault（Secrets User / Secrets Officer）。

param acrName string
param keyVaultName string

@description('AKS kubelet 标识（对象 ID）：从 ACR 拉镜像。')
param kubeletObjectId string

@description('读取 Key Vault 机密的服务主体（对象 ID）：工作负载标识、App GW 标识。')
param keyVaultReaderPrincipalIds array

@description('可选：授予数据面写权限（Key Vault Secrets Officer）的主体，例如部署人员。为空则不授予。')
param keyVaultOfficerPrincipalId string = ''

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param keyVaultOfficerPrincipalType string = 'User'

// 内置角色定义 ID（全局固定值）。
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, kubeletObjectId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: kubeletObjectId
    principalType: 'ServicePrincipal'
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in keyVaultReaderPrincipalIds: {
  name: guid(vault.id, principalId, keyVaultSecretsUserRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}]

resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultOfficerPrincipalId)) {
  name: guid(vault.id, keyVaultOfficerPrincipalId, keyVaultSecretsOfficerRoleId)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: keyVaultOfficerPrincipalId
    principalType: keyVaultOfficerPrincipalType
  }
}
