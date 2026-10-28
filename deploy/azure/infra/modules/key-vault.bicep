// 应用机密的唯一存放处。Pod 经 Secrets Store CSI 驱动 + Workload Identity 读取（Key Vault Secrets User），
// App GW 经自己的托管标识读取 TLS 证书。机密的值不出现在 Bicep、参数文件或仓库中：
// - hook 生成的随机机密、组合出的 MYSQL_URL，经 ARM（控制面）写入，不需要数据面网络可达；
// - 运维提供的机密（SCIM token、席位 PAT、SAML 证书与私钥、TLS 证书）用 hooks/Set-GhcpSecret.ps1 或在 VNet 内用 az keyvault 写入。

param location string
param name string
param tenantId string
param privateEndpointSubnetId string
param privateDnsZoneId string

@description('允许访问数据面的公网来源（运维出口 IP）。为空 = 只能经私有终结点访问（默认）。')
param allowedIpRanges array = []

@description('清除保护。生产保持 true：开启后无法关闭，删除的 vault 在保留期内不能被清除，同名 vault 也不能重建。')
param enablePurgeProtection bool = true

@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

param tags object = {}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enabledForDeployment: false
    enabledForTemplateDeployment: false
    enabledForDiskEncryption: false
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // 只能设为 true 或省略（不能显式设 false）。
    enablePurgeProtection: enablePurgeProtection ? true : null
    publicNetworkAccess: empty(allowedIpRanges) ? 'Disabled' : 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      ipRules: [for ip in allowedIpRanges: {
        value: ip
      }]
      virtualNetworkRules: []
    }
  }
}

module privateEndpoint 'private-endpoint.bicep' = {
  name: 'ghcp-pe-kv'
  params: {
    location: location
    name: 'pe-${name}'
    subnetId: privateEndpointSubnetId
    targetResourceId: vault.id
    groupId: 'vault'
    privateDnsZoneId: privateDnsZoneId
    tags: tags
  }
}

output id string = vault.id
output name string = vault.name
output uri string = vault.properties.vaultUri
