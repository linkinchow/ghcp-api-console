// Log Analytics：Container Insights（容器 stdout）、AKS / MySQL / App GW 诊断日志的落点。
// 四个服务把结构化日志写到 stdout，Container Insights 采集后可在 ContainerLogV2 中查询。

param location string
param name string

@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('每日采集上限（GB）。-1 = 不限制。审计日志、容器日志量大时用它防止费用失控。')
param dailyQuotaGb int = -1

param tags object = {}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    retentionInDays: retentionInDays
    sku: {
      name: 'PerGB2018'
    }
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output id string = workspace.id
output name string = workspace.name
