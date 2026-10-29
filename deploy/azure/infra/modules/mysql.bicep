// Azure Database for MySQL 灵活服务器：Proxy 的共享存储（caller-lease 租约、账号池、企业配置）。
//
// 网络：私有终结点 + privatelink.mysql.database.azure.com（不用 VNet 集成）。原因：
// - 与 ACR、Key Vault 的私有终结点方式一致，复用 LiteLLM 的 VNet 时只需要一个私有终结点子网，不需要委派子网；
// - 对等 VNet / 本地网络经私有终结点访问；VNet 集成在创建后不能改，私有终结点可以随时增删。
// 私有终结点要求服务器以“公共访问”模式创建，这里同时把 publicNetworkAccess 设为 Disabled：只能经私有终结点访问。
//
// TLS：require_secure_transport=ON（默认即 ON，这里显式固定）；tls_version 保持服务默认 TLSv1.2（静态参数，改动需重启）。
// Proxy 使用 verify-ca，CA 为 components/azure-aks/mysql-ca 中的两个根 CA。

param location string
param name string

@description('计算层级。Burstable 不支持高可用，且 CPU 积分耗尽后会被限速，只用于开发测试。')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'GeneralPurpose'

@description('SKU 名称，例如 Standard_D2ads_v5（GeneralPurpose）、Standard_B2ms（Burstable）。按地域可用性选择。')
param skuName string = 'Standard_D2ads_v5'

@description('MySQL 主版本。8.0.21 = 8.0 系列；8.4 为 LTS（以所在地域和 API 支持为准）。')
@allowed([
  '8.0.21'
  '8.4'
])
param version string = '8.4'

@description('高可用：Disabled、SameZone、ZoneRedundant（需要地域支持可用区；Burstable 不支持）。')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param highAvailability string = 'ZoneRedundant'

@description('主服务器可用区（空 = 由平台选择）。')
param availabilityZone string = ''

@description('备用服务器可用区（ZoneRedundant 时，空 = 由平台选择）。')
param standbyAvailabilityZone string = ''

@minValue(20)
@maxValue(16384)
param storageSizeGB int = 64

@minValue(1)
@maxValue(35)
param backupRetentionDays int = 14

@description('异地冗余备份（创建后不能修改；需要配对地域支持）。')
param geoRedundantBackup bool = false

param administratorLogin string

@secure()
param administratorLoginPassword string

@description('Proxy 专用库名（与 deploy/kubernetes README 第 3.2 节一致）。')
param databaseName string = 'ghcp_proxy'

@description('log_bin_trust_function_creators。Azure 灵活服务器 binlog 始终开启且为 ROW 格式，该参数默认即 ON；Proxy 自动迁移（方式 A）以非 SUPER 账号创建触发器时需要它为 ON。设为 false 时只能用 DBA 预建表（方式 B）。')
param trustFunctionCreators bool = true

param privateEndpointSubnetId string
param privateDnsZoneId string
param logAnalyticsWorkspaceId string
param tags object = {}

var haEnabled = highAvailability != 'Disabled'

resource server 'Microsoft.DBforMySQL/flexibleServers@2023-12-30' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: version
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorLoginPassword
    availabilityZone: empty(availabilityZone) ? null : availabilityZone
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
      autoIoScaling: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: highAvailability
      standbyAvailabilityZone: haEnabled && !empty(standbyAvailabilityZone) ? standbyAvailabilityZone : null
    }
    network: {
      publicNetworkAccess: 'Disabled'
    }
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 18
      startMinute: 0
    }
  }
}

// 服务器参数逐个修改：并发更新同一台服务器的参数会冲突。
var serverParameters = [
  {
    name: 'require_secure_transport'
    value: 'ON'
  }
  {
    name: 'character_set_server'
    value: 'utf8mb4'
  }
  {
    name: 'collation_server'
    value: 'utf8mb4_0900_ai_ci'
  }
  {
    name: 'log_bin_trust_function_creators'
    value: trustFunctionCreators ? 'ON' : 'OFF'
  }
]

@batchSize(1)
resource parameters 'Microsoft.DBforMySQL/flexibleServers/configurations@2023-12-30' = [for parameter in serverParameters: {
  parent: server
  name: parameter.name
  properties: {
    value: parameter.value
    source: 'user-override'
  }
}]

// 专用空库，utf8mb4（scripts/proxy-mysql-initial.sql 使用同样的字符集与排序规则）。
resource database 'Microsoft.DBforMySQL/flexibleServers/databases@2023-12-30' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'utf8mb4'
    collation: 'utf8mb4_0900_ai_ci'
  }
  dependsOn: [
    parameters
  ]
}

module privateEndpoint 'private-endpoint.bicep' = {
  name: 'ghcp-pe-mysql'
  params: {
    location: location
    name: 'pe-${name}'
    subnetId: privateEndpointSubnetId
    targetResourceId: server.id
    groupId: 'mysqlServer'
    privateDnsZoneId: privateDnsZoneId
    tags: tags
  }
  dependsOn: [
    database
  ]
}

// 只发送指标；慢查询与审计日志需要先开启 slow_query_log / audit_log_enabled（会增加日志量与费用），按需在门户开启。
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'ghcp-mysql-metrics'
  scope: server
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output id string = server.id
output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
