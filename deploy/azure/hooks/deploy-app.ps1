<#
.SYNOPSIS
  渲染本环境的 overlay 并部署到 AKS（postprovision 自动调用；确认配置后也可以单独运行）。

.DESCRIPTION
  不使用 azd 的 AKS 服务部署：azd 会把集群凭据合并进默认 kubeconfig 并切换当前上下文，而这里要求只用本项目自己的
  kubeconfig（deploy/azure/.kube/），所有 kubectl 调用都显式带 --kubeconfig 与 --context。

  企业身份字段与池配置指纹有数据后不能修改（docs/multi-enterprise-new-deployment-guide.md 第 4.7 节）。
  GHCP_CONFIG_APPROVED 不是 true 时只渲染并打印配置摘要，不部署；核对后：
    azd env set GHCP_CONFIG_APPROVED true
    pwsh ./hooks/deploy-app.ps1        # 或 azd hooks run postprovision

.PARAMETER IfApproved
  未确认时正常退出（postprovision 使用），而不是报错。
#>
param([switch] $IfApproved)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"
Import-AzdEnvironment

$code = Invoke-Renderer @('render', '--require-approved')
if ($code -eq 3) {
  $message = 'Configuration not approved yet: review the summary above, then run "azd env set GHCP_CONFIG_APPROVED true" and "pwsh ./hooks/deploy-app.ps1".'
  if ($IfApproved) { Write-Warning $message; return }
  throw $message
}
if ($code -ne 0) { throw 'Rendering the overlay failed (see the errors above).' }

$appDir = Join-Path (Get-GeneratedDir) 'app'
# 渲染结果离线检查：除启动门禁脚本本身和 network-policy 组件中未使用的占位 namespace 外，不允许任何 REPLACE_。
$rendered = & kubectl kustomize $appDir
if ($LASTEXITCODE -ne 0) { throw 'kubectl kustomize failed.' }
$leftovers = @($rendered | Select-String 'REPLACE_' | Where-Object { $_.Line -notmatch "includes\(''REPLACE_''\)|REPLACE_(INGRESS|INTERNAL_INGRESS|LITELLM)_" })
if ($leftovers.Count) { throw "Placeholders left in the rendered manifests:`n$($leftovers.Line -join "`n")" }

Connect-Aks
$namespace = Get-RequiredEnv 'GHCP_NAMESPACE'
Initialize-Namespace $namespace
Invoke-Kubectl -Arguments @('apply', '-k', $appDir) | Out-Null
foreach ($name in @('sso', 'login', 'proxy', 'console')) {
  Invoke-Kubectl -Arguments @('-n', $namespace, 'rollout', 'status', "deployment/ghcp-$name", '--timeout=10m') -AllowFailure
}
Invoke-Kubectl -Arguments @('-n', $namespace, 'get', 'pods,svc', '-o', 'wide') -AllowFailure

$ssoBase = if ($env:GHCP_SSO_PUBLIC_BASE_URL) { $env:GHCP_SSO_PUBLIC_BASE_URL }
  elseif ($env:GHCP_PUBLIC_SSO_HOST) { "https://$($env:GHCP_PUBLIC_SSO_HOST)" }
  else { "http://$($env:GHCP_SSO_ILB_IP):7001" }
Write-Host ''
Write-Host 'Next steps (deploy/azure/README.md section 6):'
Write-Host "  1. Initialize the Console admin first, from this machine only: kubectl --kubeconfig $($script:Kube.Kubeconfig) --context $($script:Kube.Context) -n $namespace port-forward svc/ghcp-console 7004:7004"
Write-Host "  2. GitHub SAML: Sign on URL $ssoBase/sso, Issuer $ssoBase/metadata, certificate = Key Vault secret ghcp-saml-idp-cert"
Write-Host '  3. Keep Ready idle target at 0 until SAML / SCIM / seats are verified; then open the pool gradually.'
if ($env:APPGW_PUBLIC_IP) { Write-Host "  4. Public DNS: point the published host names at $($env:APPGW_PUBLIC_IP) (Application Gateway)." }
