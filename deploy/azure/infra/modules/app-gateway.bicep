// Application Gateway WAF_v2：公网访问开关打开时才部署。设计与取舍见 ../../public-access-design.md。
//
// - 两个前端：公网 IP（对外）与固定私网 IP（VNet 内客户端、Login 的 Chromium）；IPv4 下公网与私网监听器可共用 443。
// - 每个对外端点在两个前端各有一个 HTTPS 监听器（同一主机名、同一证书、同一 WAF 策略），后端是内部负载均衡 IP。
// - TLS 在 App GW 终止，证书从 Key Vault 读取（版本无关的机密 URI，Key Vault 中更新证书后自动轮换）。
//   到后端是 VNet 内的 HTTP（后端服务本身只监听 HTTP）。
// - 关闭响应缓冲：SSE 流式响应逐块转发给客户端（WAF_v2 的请求缓冲无法关闭，WAF 需要完整请求体）。
// - 关闭 HTTP/2：App GW v2 前端的 HTTP/2 连接空闲超时固定 180 秒、不可配置，会切断长时间无输出的非流式推理；
//   HTTP/1.1 连接的空闲超时由公网 IP 的 idleTimeoutInMinutes 控制（4–30 分钟）。

param location string
param name string
param subnetId string
param privateFrontendIp string
param identityId string

@description('Key Vault URI（以 / 结尾）。')
param keyVaultUri string

@description('对外端点：[{ key, hostName, backendAddress, backendPort, probePath, requestTimeout, certificateName, wafPolicyId, stripIdentityHeader, mutualTls? }]。')
param endpoints array

@description('mutual TLS：签发客户端证书的 CA（公开证书的 base64）。只用于 mutualTls 为 true 的端点（Proxy）；为空则不启用。')
param clientCaCertificateData string = ''

@description('网关级 WAF 策略（没有挂策略的监听器使用；本模板每个监听器都有自己的策略）。')
param defaultWafPolicyId string

param availabilityZones array = []

@minValue(0)
@maxValue(125)
param minCapacity int = 1

@minValue(2)
@maxValue(125)
param maxCapacity int = 4

@description('公网前端 TCP 空闲超时（分钟，4–30）。覆盖最长 600 秒的推理请求与 SSE 事件间隔。')
@minValue(4)
@maxValue(30)
param publicIpIdleTimeoutMinutes int = 15

param logAnalyticsWorkspaceId string
param tags object = {}

var zones = empty(availabilityZones) ? null : availabilityZones
var mutualTls = !empty(clientCaCertificateData)
var tlsPolicy = {
  policyType: 'Predefined'
  policyName: 'AppGwSslPolicy20220101S'
}
var certificateNames = union(map(endpoints, e => e.certificateName), [])
var frontends = [
  {
    key: 'public'
    configName: 'fe-public'
  }
  {
    key: 'private'
    configName: 'fe-private'
  }
]
// 每个端点 × 两个前端，按顺序编号（规则优先级）。
var listeners = flatten(map(range(0, length(endpoints)), i => map(range(0, length(frontends)), j => {
  endpoint: endpoints[i]
  frontend: frontends[j]
  name: 'listener-${endpoints[i].key}-${frontends[j].key}'
  priority: 100 + (i * 10) + j
})))

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-${name}'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  zones: zones
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    idleTimeoutInMinutes: publicIpIdleTimeoutMinutes
  }
}

resource gateway 'Microsoft.Network/applicationGateways@2024-05-01' = {
  name: name
  location: location
  tags: tags
  zones: zones
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: minCapacity
      maxCapacity: maxCapacity
    }
    enableHttp2: false
    globalConfiguration: {
      enableRequestBuffering: true
      enableResponseBuffering: false
    }
    sslPolicy: tlsPolicy
    // mutual TLS（只给 Proxy 端点）：客户端必须出示由该 CA 签发的证书，否则 TLS 握手失败。
    trustedClientCertificates: mutualTls ? [
      {
        name: 'client-ca'
        properties: {
          data: clientCaCertificateData
        }
      }
    ] : []
    sslProfiles: mutualTls ? [
      {
        name: 'mutual-tls'
        properties: {
          sslPolicy: tlsPolicy
          trustedClientCertificates: [
            {
              id: resourceId('Microsoft.Network/applicationGateways/trustedClientCertificates', name, 'client-ca')
            }
          ]
          clientAuthConfiguration: {
            verifyClientCertIssuerDN: true
            // 私有 CA 通常没有 OCSP；吊销靠更换 CA / 证书。CA 提供 OCSP 时可改为 'OCSP'。
            verifyClientRevocation: 'None'
          }
        }
      }
    ] : []
    firewallPolicy: {
      id: defaultWafPolicyId
    }
    gatewayIPConfigurations: [
      {
        name: 'gateway-ip'
        properties: {
          subnet: {
            id: subnetId
          }
        }
      }
    ]
    frontendIPConfigurations: [
      {
        name: 'fe-public'
        properties: {
          publicIPAddress: {
            id: publicIp.id
          }
        }
      }
      {
        name: 'fe-private'
        properties: {
          privateIPAllocationMethod: 'Static'
          privateIPAddress: privateFrontendIp
          subnet: {
            id: subnetId
          }
        }
      }
    ]
    frontendPorts: [
      {
        name: 'port-443'
        properties: {
          port: 443
        }
      }
    ]
    sslCertificates: [for certificateName in certificateNames: {
      name: certificateName
      properties: {
        keyVaultSecretId: '${keyVaultUri}secrets/${certificateName}'
      }
    }]
    backendAddressPools: [for endpoint in endpoints: {
      name: 'pool-${endpoint.key}'
      properties: {
        backendAddresses: [
          {
            ipAddress: endpoint.backendAddress
          }
        ]
      }
    }]
    probes: [for endpoint in endpoints: {
      name: 'probe-${endpoint.key}'
      properties: {
        protocol: 'Http'
        host: endpoint.hostName
        path: endpoint.probePath
        interval: 30
        timeout: 30
        unhealthyThreshold: 3
        pickHostNameFromBackendHttpSettings: false
        match: {
          statusCodes: [
            '200-399'
          ]
        }
      }
    }]
    backendHttpSettingsCollection: [for endpoint in endpoints: {
      name: 'settings-${endpoint.key}'
      properties: {
        port: endpoint.backendPort
        protocol: 'Http'
        cookieBasedAffinity: 'Disabled'
        // 不改写 Host：后端看到对外主机名（SSO 的同源检查、Console 的 CONSOLE_PUBLIC_BASE_URL 都基于它）。
        pickHostNameFromBackendAddress: false
        requestTimeout: endpoint.requestTimeout
        probe: {
          id: resourceId('Microsoft.Network/applicationGateways/probes', name, 'probe-${endpoint.key}')
        }
        connectionDraining: {
          enabled: true
          drainTimeoutInSec: 60
        }
      }
    }]
    rewriteRuleSets: [
      {
        name: 'rw-default'
        properties: {
          rewriteRules: [
            {
              name: 'security-headers'
              ruleSequence: 100
              actionSet: {
                responseHeaderConfigurations: [
                  {
                    headerName: 'Strict-Transport-Security'
                    headerValue: 'max-age=31536000'
                  }
                  {
                    // 空值 = 删除该响应头。
                    headerName: 'X-Powered-By'
                    headerValue: ''
                  }
                ]
              }
            }
          ]
        }
      }
      {
        name: 'rw-strip-identity'
        properties: {
          rewriteRules: [
            {
              name: 'security-headers'
              ruleSequence: 100
              actionSet: {
                responseHeaderConfigurations: [
                  {
                    headerName: 'Strict-Transport-Security'
                    headerValue: 'max-age=31536000'
                  }
                  {
                    headerName: 'X-Powered-By'
                    headerValue: ''
                  }
                ]
                // 纵深防御：外部请求不得携带 Proxy 信任的身份头；LiteLLM 的身份 Hook 也会清理并重新注入。
                requestHeaderConfigurations: [
                  {
                    headerName: 'X-User-Identity'
                    headerValue: ''
                  }
                ]
              }
            }
          ]
        }
      }
    ]
    httpListeners: [for listener in listeners: {
      name: listener.name
      properties: {
        protocol: 'Https'
        hostName: listener.endpoint.hostName
        requireServerNameIndication: true
        frontendIPConfiguration: {
          id: resourceId('Microsoft.Network/applicationGateways/frontendIPConfigurations', name, listener.frontend.configName)
        }
        frontendPort: {
          id: resourceId('Microsoft.Network/applicationGateways/frontendPorts', name, 'port-443')
        }
        sslCertificate: {
          id: resourceId('Microsoft.Network/applicationGateways/sslCertificates', name, listener.endpoint.certificateName)
        }
        firewallPolicy: {
          id: listener.endpoint.wafPolicyId
        }
        sslProfile: mutualTls && (listener.endpoint.?mutualTls ?? false) ? {
          id: resourceId('Microsoft.Network/applicationGateways/sslProfiles', name, 'mutual-tls')
        } : null
      }
    }]
    requestRoutingRules: [for listener in listeners: {
      name: 'rule-${listener.endpoint.key}-${listener.frontend.key}'
      properties: {
        ruleType: 'Basic'
        priority: listener.priority
        httpListener: {
          id: resourceId('Microsoft.Network/applicationGateways/httpListeners', name, listener.name)
        }
        backendAddressPool: {
          id: resourceId('Microsoft.Network/applicationGateways/backendAddressPools', name, 'pool-${listener.endpoint.key}')
        }
        backendHttpSettings: {
          id: resourceId('Microsoft.Network/applicationGateways/backendHttpSettingsCollection', name, 'settings-${listener.endpoint.key}')
        }
        rewriteRuleSet: {
          id: resourceId('Microsoft.Network/applicationGateways/rewriteRuleSets', name, listener.endpoint.stripIdentityHeader ? 'rw-strip-identity' : 'rw-default')
        }
      }
    }]
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'ghcp-appgw'
  scope: gateway
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

output id string = gateway.id
output publicIpAddress string = publicIp.properties.ipAddress
output privateIpAddress string = privateFrontendIp
