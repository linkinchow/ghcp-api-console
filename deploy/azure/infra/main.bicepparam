// azd 读取本文件（而不是 main.parameters.json）：参数值来自 azd 环境变量（azd env set <名称> <值>）。
// 用 .bicepparam 的原因：公网开关是一个对象参数，需要按 types.bicep 的类型做编译期校验；
// JSON 参数文件的 ${VAR=默认值} 写法无法在默认值里写对象（花括号会截断表达式）。
// 未设置的变量使用这里的默认值（= main.bicep 的默认值）。不要在本文件里写任何机密或客户信息。
using 'main.bicep'

// ---- 基本 ----
param environmentName = readEnvironmentVariable('AZURE_ENV_NAME', 'ghcp')
param location = readEnvironmentVariable('AZURE_LOCATION', 'eastasia')
param resourceSuffix = readEnvironmentVariable('GHCP_RESOURCE_SUFFIX', '')
param nameOverrides = json(readEnvironmentVariable('GHCP_NAME_OVERRIDES', '{}'))
param tags = json(readEnvironmentVariable('GHCP_TAGS', '{}'))

// ---- 应用形态 ----
param githubHosting = readEnvironmentVariable('GHCP_GITHUB_HOSTING', 'github.com')
param proxyReplicas = int(readEnvironmentVariable('GHCP_PROXY_REPLICAS', '2'))
param kubernetesNamespace = readEnvironmentVariable('GHCP_NAMESPACE', 'ghcp')

// ---- 网络 ----
param vnetAddressPrefixes = json(readEnvironmentVariable('GHCP_VNET_ADDRESS_PREFIXES', '["10.40.0.0/16"]'))
param aksSubnetPrefix = readEnvironmentVariable('GHCP_AKS_SUBNET_PREFIX', '10.40.0.0/22')
param privateEndpointSubnetPrefix = readEnvironmentVariable('GHCP_PE_SUBNET_PREFIX', '10.40.4.0/26')
param internalLbSubnetPrefix = readEnvironmentVariable('GHCP_ILB_SUBNET_PREFIX', '10.40.4.64/27')
param appGatewaySubnetPrefix = readEnvironmentVariable('GHCP_APPGW_SUBNET_PREFIX', '10.40.5.0/24')
param existingVnetName = readEnvironmentVariable('GHCP_EXISTING_VNET_NAME', '')
param existingVnetResourceGroup = readEnvironmentVariable('GHCP_EXISTING_VNET_RESOURCE_GROUP', '')
param existingSubnetNames = json(readEnvironmentVariable('GHCP_EXISTING_SUBNET_NAMES', '{}'))
param createNatGateway = bool(readEnvironmentVariable('GHCP_CREATE_NAT_GATEWAY', 'true'))
param existingNatGatewayId = readEnvironmentVariable('GHCP_EXISTING_NAT_GATEWAY_ID', '')
param natIdleTimeoutMinutes = int(readEnvironmentVariable('GHCP_NAT_IDLE_TIMEOUT_MINUTES', '15'))
param existingPrivateDnsZoneIds = json(readEnvironmentVariable('GHCP_EXISTING_PRIVATE_DNS_ZONE_IDS', '{}'))
param internalLbIps = json(readEnvironmentVariable('GHCP_INTERNAL_LB_IPS', '{}'))

// ---- AKS ----
param existingAksClusterName = readEnvironmentVariable('GHCP_EXISTING_AKS_NAME', '')
param existingAksResourceGroup = readEnvironmentVariable('GHCP_EXISTING_AKS_RESOURCE_GROUP', '')
param existingAksControlPlanePrincipalId = readEnvironmentVariable('GHCP_EXISTING_AKS_CONTROL_PLANE_PRINCIPAL_ID', '')
param kubernetesVersion = readEnvironmentVariable('GHCP_KUBERNETES_VERSION', '')
param availabilityZones = json(readEnvironmentVariable('GHCP_AVAILABILITY_ZONES', '["1","2","3"]'))
param systemNodeVmSize = readEnvironmentVariable('GHCP_SYSTEM_NODE_VM_SIZE', 'Standard_D2s_v5')
param systemNodeCount = int(readEnvironmentVariable('GHCP_SYSTEM_NODE_COUNT', '2'))
param userNodeVmSize = readEnvironmentVariable('GHCP_USER_NODE_VM_SIZE', 'Standard_D4s_v5')
param userNodeMinCount = int(readEnvironmentVariable('GHCP_USER_NODE_MIN_COUNT', '2'))
param userNodeMaxCount = int(readEnvironmentVariable('GHCP_USER_NODE_MAX_COUNT', '5'))
param podCidr = readEnvironmentVariable('GHCP_POD_CIDR', '10.244.0.0/16')
param serviceCidr = readEnvironmentVariable('GHCP_SERVICE_CIDR', '10.41.0.0/16')
param networkDataplane = readEnvironmentVariable('GHCP_NETWORK_DATAPLANE', 'cilium')
param networkPolicy = readEnvironmentVariable('GHCP_NETWORK_POLICY', 'cilium')
param aksOutboundType = readEnvironmentVariable('GHCP_AKS_OUTBOUND_TYPE', 'userAssignedNATGateway')
param privateCluster = bool(readEnvironmentVariable('GHCP_PRIVATE_CLUSTER', 'false'))
param apiServerAuthorizedIpRanges = json(readEnvironmentVariable('GHCP_API_SERVER_AUTHORIZED_IP_RANGES', '[]'))
param disableLocalAccounts = bool(readEnvironmentVariable('GHCP_DISABLE_LOCAL_ACCOUNTS', 'false'))
param aksAdminGroupObjectIds = json(readEnvironmentVariable('GHCP_AKS_ADMIN_GROUP_OBJECT_IDS', '[]'))
param upgradeChannel = readEnvironmentVariable('GHCP_UPGRADE_CHANNEL', 'none')
param nodeOsUpgradeChannel = readEnvironmentVariable('GHCP_NODE_OS_UPGRADE_CHANNEL', 'None')
param diskSkuName = readEnvironmentVariable('GHCP_DISK_SKU_NAME', '')

// ---- MySQL ----
param mysqlSkuTier = readEnvironmentVariable('GHCP_MYSQL_SKU_TIER', 'GeneralPurpose')
param mysqlSkuName = readEnvironmentVariable('GHCP_MYSQL_SKU_NAME', 'Standard_D2ads_v5')
param mysqlVersion = readEnvironmentVariable('GHCP_MYSQL_VERSION', '8.0.21')
param mysqlHighAvailability = readEnvironmentVariable('GHCP_MYSQL_HA', 'ZoneRedundant')
param mysqlStorageSizeGB = int(readEnvironmentVariable('GHCP_MYSQL_STORAGE_GB', '64'))
param mysqlBackupRetentionDays = int(readEnvironmentVariable('GHCP_MYSQL_BACKUP_RETENTION_DAYS', '14'))
param mysqlGeoRedundantBackup = bool(readEnvironmentVariable('GHCP_MYSQL_GEO_BACKUP', 'false'))
param mysqlAdminLogin = readEnvironmentVariable('GHCP_MYSQL_ADMIN_LOGIN', 'ghcpadmin')
// 由 hooks/preprovision.ps1 生成（只保存在本机的 azd 环境中）。
param mysqlAdminPassword = readEnvironmentVariable('GHCP_MYSQL_ADMIN_PASSWORD', '')
param mysqlTrustFunctionCreators = bool(readEnvironmentVariable('GHCP_MYSQL_TRUST_FUNCTION_CREATORS', 'true'))

// ---- ACR、Key Vault ----
param acrPublicNetworkAccess = bool(readEnvironmentVariable('GHCP_ACR_PUBLIC_NETWORK_ACCESS', 'false'))
param keyVaultAllowedIpRanges = json(readEnvironmentVariable('GHCP_KEY_VAULT_ALLOWED_IP_RANGES', '[]'))
param keyVaultPurgeProtection = bool(readEnvironmentVariable('GHCP_KEY_VAULT_PURGE_PROTECTION', 'true'))
param grantDeployerKeyVaultAccess = bool(readEnvironmentVariable('GHCP_GRANT_DEPLOYER_KEY_VAULT_ACCESS', 'false'))
param grantDeployerAksAdmin = bool(readEnvironmentVariable('GHCP_GRANT_DEPLOYER_AKS_ADMIN', 'true'))
param deployerPrincipalType =readEnvironmentVariable('GHCP_DEPLOYER_PRINCIPAL_TYPE', 'User')

// ---- 监控 ----
param logAnalyticsRetentionDays = int(readEnvironmentVariable('GHCP_LOG_RETENTION_DAYS', '30'))
param logAnalyticsDailyQuotaGb = int(readEnvironmentVariable('GHCP_LOG_DAILY_QUOTA_GB', '-1'))
param enableContainerInsights = bool(readEnvironmentVariable('GHCP_ENABLE_CONTAINER_INSIGHTS', 'true'))
param enableManagedPrometheus = bool(readEnvironmentVariable('GHCP_ENABLE_MANAGED_PROMETHEUS', 'false'))
param enableGrafana = bool(readEnvironmentVariable('GHCP_ENABLE_GRAFANA', 'false'))
param enableAksAuditLogs = bool(readEnvironmentVariable('GHCP_ENABLE_AKS_AUDIT_LOGS', 'false'))

// ---- 公网访问开关（默认仅内网）----
// 例：azd env set GHCP_PUBLIC_ACCESS '{"sso":true,"console":false,"litellm":false,"allowedSourceCidrs":["203.0.113.0/24"],"hostNames":{"sso":"sso.example.com"}}'
param publicAccess = json(readEnvironmentVariable('GHCP_PUBLIC_ACCESS', '{"sso":false,"console":false,"litellm":false,"allowedSourceCidrs":[]}'))
param appGatewayMinCapacity = int(readEnvironmentVariable('GHCP_APPGW_MIN_CAPACITY', '1'))
param appGatewayMaxCapacity = int(readEnvironmentVariable('GHCP_APPGW_MAX_CAPACITY', '4'))
param appGatewayPublicIpIdleTimeoutMinutes = int(readEnvironmentVariable('GHCP_APPGW_IDLE_TIMEOUT_MINUTES', '15'))
