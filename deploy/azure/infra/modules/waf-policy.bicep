// Application Gateway WAF 策略（每个对外端点一个，挂在该端点的监听器上）。
// 托管规则：Microsoft_DefaultRuleSet 2.1（OWASP CRS 3.3 系）+ Bot Manager 1.1；自定义规则由 main.bicep 按端点生成
// （来源允许列表、路径允许列表、登录限速）。设计说明见 ../../public-access-design.md 第 5 节。

param location string
param name string

@allowed([
  'Prevention'
  'Detection'
])
param mode string = 'Prevention'

@description('是否检查请求体。LiteLLM 的推理请求体是提示词（大量代码、SQL、HTML 片段），托管规则会大面积误报，且常超过 2 MB 检查上限，所以 LiteLLM 策略关闭请求体检查。')
param requestBodyCheck bool = true

@minValue(8)
@maxValue(2000)
param maxRequestBodySizeInKb int = 128

param customRules array = []
param exclusions array = []
param tags object = {}

resource policy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    policySettings: {
      state: 'Enabled'
      mode: mode
      requestBodyCheck: requestBodyCheck
      requestBodyEnforcement: requestBodyCheck
      maxRequestBodySizeInKb: maxRequestBodySizeInKb
      requestBodyInspectLimitInKB: maxRequestBodySizeInKb
      fileUploadLimitInMb: 10
      fileUploadEnforcement: true
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.1'
        }
      ]
      exclusions: exclusions
    }
    customRules: customRules
  }
}

output id string = policy.id
