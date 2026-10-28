<#
.SYNOPSIS
  把运维提供的机密写入本部署的 Key Vault（经 ARM 控制面，私有 vault 也可用；值不出现在命令行和 shell 历史中）。

.EXAMPLE
  # 在 deploy/azure 目录、已 azd env select 的终端中：
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-scim-token -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-copilot-seat-pat -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-cert -File <证书 PEM 路径>
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-key -File <私钥 PEM 路径>
  # App GW 的 TLS 证书：不带密码的 PFX，按 base64 存为 application/x-pkcs12（也可以在 VNet 内用 az keyvault certificate import）。
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-public-tls -File <PFX 路径> -Base64 -ContentType application/x-pkcs12

.NOTES
  需要对 Key Vault 有 Microsoft.KeyVault/vaults/secrets/write（例如资源组上的 Contributor 或 Key Vault Contributor）。
  订阅、Key Vault 资源 ID 取自 azd 环境（azd env get-values），也可用 -Subscription / -KeyVaultResourceId 指定。
#>
[CmdletBinding(DefaultParameterSetName = 'Prompt')]
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]{1,127}$')][string] $Name,
  [Parameter(ParameterSetName = 'Prompt')][switch] $Prompt,
  [Parameter(ParameterSetName = 'File', Mandatory)][string] $File,
  [Parameter(ParameterSetName = 'File')][switch] $Base64,
  [string] $ContentType = '',
  [string] $Subscription = '',
  [string] $KeyVaultResourceId = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"

# 未显式给出时从当前 azd 环境读取（不打印值）。
if ($Subscription) { $env:AZURE_SUBSCRIPTION_ID = $Subscription }
if ($KeyVaultResourceId) { $env:AZURE_KEY_VAULT_RESOURCE_ID = $KeyVaultResourceId }
if (-not ($Subscription -and $KeyVaultResourceId)) { Import-AzdEnvironment }
if ($Subscription) { $env:AZURE_SUBSCRIPTION_ID = $Subscription }
if ($KeyVaultResourceId) { $env:AZURE_KEY_VAULT_RESOURCE_ID = $KeyVaultResourceId }

if ($PSCmdlet.ParameterSetName -eq 'File') {
  $value = if ($Base64) { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path $File))) } else { [System.IO.File]::ReadAllText((Resolve-Path $File)) }
} else {
  $secure = Read-Host -AsSecureString -Prompt "Value for $Name"
  $value = [System.Net.NetworkCredential]::new('', $secure).Password
}
if ([string]::IsNullOrEmpty($value)) { throw 'Empty value.' }
if ($Name -eq 'ghcp-sso-default-user-password' -and $value.Length -lt 16) { throw 'SSO_DEFAULT_USER_PASSWORD needs at least 16 characters.' }

Set-KeyVaultSecretViaArm -Name $Name -Value $value -ContentType $ContentType
Remove-Variable value
Write-Host "Wrote $Name. Pods read it at their next start: kubectl rollout restart deployment/<name> (README section 6)."
