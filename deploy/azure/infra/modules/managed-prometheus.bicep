// 可选：托管 Prometheus（Azure Monitor 工作区）+ 可选 Managed Grafana。
// 四个服务目前不暴露 /metrics，所以这里采集的是集群与节点指标（kube-state-metrics、cAdvisor、node-exporter）。
//
// 集群上的 azureMonitorProfile.metrics.enabled 只启动 ama-metrics 采集组件；采集数据写到哪个工作区由
// 数据收集终结点（DCE）、数据收集规则（DCR）和规则关联（DCRA）决定。三者在这里显式声明，
// 而不是依赖 CLI 的隐式行为（不带工作区参数时 CLI 会改用订阅的默认工作区）。

param location string
param clusterName string
param monitorWorkspaceName string
param namePrefix string
param enableGrafana bool = false
param grafanaName string = ''
param tags object = {}

resource cluster 'Microsoft.ContainerService/managedClusters@2024-10-01' existing = {
  name: clusterName
}

resource monitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = {
  name: monitorWorkspaceName
  location: location
  tags: tags
}

resource dce 'Microsoft.Insights/dataCollectionEndpoints@2022-06-01' = {
  name: 'dce-prom-${namePrefix}'
  location: location
  tags: tags
  kind: 'Linux'
  properties: {}
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2022-06-01' = {
  name: 'dcr-prom-${namePrefix}'
  location: location
  tags: tags
  kind: 'Linux'
  properties: {
    dataCollectionEndpointId: dce.id
    dataSources: {
      prometheusForwarder: [
        {
          name: 'PrometheusDataSource'
          streams: [
            'Microsoft-PrometheusMetrics'
          ]
          labelIncludeFilter: {}
        }
      ]
    }
    destinations: {
      monitoringAccounts: [
        {
          accountResourceId: monitorWorkspace.id
          name: 'MonitoringAccount1'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-PrometheusMetrics'
        ]
        destinations: [
          'MonitoringAccount1'
        ]
      }
    ]
  }
}

resource dcra 'Microsoft.Insights/dataCollectionRuleAssociations@2022-06-01' = {
  name: 'ContainerInsightsMetricsExtension'
  scope: cluster
  properties: {
    dataCollectionRuleId: dcr.id
    description: 'Managed Prometheus → ${monitorWorkspaceName}'
  }
}

resource grafana 'Microsoft.Dashboard/grafana@2023-09-01' = if (enableGrafana) {
  name: grafanaName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    grafanaIntegrations: {
      azureMonitorWorkspaceIntegrations: [
        {
          azureMonitorWorkspaceResourceId: monitorWorkspace.id
        }
      ]
    }
  }
}

// Grafana 用自己的托管标识查询工作区，需要 Monitoring Data Reader。
var monitoringDataReaderRoleId = 'b0d8363b-8ddd-447d-831f-62ca05bff136'

resource grafanaReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableGrafana) {
  name: guid(monitorWorkspace.id, grafanaName, monitoringDataReaderRoleId)
  scope: monitorWorkspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringDataReaderRoleId)
    principalId: grafana!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output monitorWorkspaceId string = monitorWorkspace.id
output grafanaEndpoint string = enableGrafana ? grafana!.properties.endpoint : ''
