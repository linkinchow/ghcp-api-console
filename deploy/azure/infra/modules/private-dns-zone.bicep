// 私有 DNS 区域 + 到 VNet 的链接。复用已有区域时不调用本模块：同一个区域对同一个 VNet 只能有一条链接，
// 复用的区域通常已经链接到这个（共用的）VNet。

param zoneName string
param vnetId string
param linkName string

@description('区域内的 A 记录：[{ name, ipv4Address }]（name 为 @ 表示区域根）。用于对外主机名的 split-horizon 解析。')
param aRecords array = []

param tags object = {}

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: zoneName
  location: 'global'
  tags: tags
}

resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: zone
  name: linkName
  location: 'global'
  tags: tags
  properties: {
    virtualNetwork: {
      id: vnetId
    }
    registrationEnabled: false
  }
}

resource records 'Microsoft.Network/privateDnsZones/A@2024-06-01' = [for record in aRecords: {
  parent: zone
  name: record.name
  properties: {
    ttl: 300
    aRecords: [
      {
        ipv4Address: record.ipv4Address
      }
    ]
  }
}]

output id string = zone.id
