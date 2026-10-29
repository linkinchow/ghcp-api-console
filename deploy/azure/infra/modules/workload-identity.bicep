// Workload Identity：一个用户分配托管标识 + 一条联合凭据，绑定 Kubernetes ServiceAccount ghcp-workload。
// 唯一权限：本部署 Key Vault 的 Key Vault Secrets User（在 main.bicep 中授予）。
//
// subject 必须与 components/azure-aks/workload-identity.yaml 的 ServiceAccount 名称、部署 namespace 逐字一致；
// 不一致时 Pod 停在 ContainerCreating，事件中是 CSI 挂载的 AADSTS 错误。

param location string
param name string
param oidcIssuerUrl string
param serviceAccountNamespace string
param serviceAccountName string = 'ghcp-workload'
param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

resource federatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: '${serviceAccountNamespace}-${serviceAccountName}'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${serviceAccountNamespace}:${serviceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output id string = identity.id
output name string = identity.name
output clientId string = identity.properties.clientId
output principalId string = identity.properties.principalId
