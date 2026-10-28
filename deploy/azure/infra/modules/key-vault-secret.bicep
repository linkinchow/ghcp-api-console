// 经 ARM（控制面）写入一个 Key Vault 机密。控制面写入不受 Key Vault 网络规则限制，
// 所以私有的 vault 也能在部署时写入。只用于部署本身生成的值（MySQL 管理员密码）。

param keyVaultName string
param secretName string

@secure()
param secretValue string

param contentType string = ''

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: secretName
  properties: {
    value: secretValue
    contentType: empty(contentType) ? null : contentType
  }
}

output name string = secret.name
