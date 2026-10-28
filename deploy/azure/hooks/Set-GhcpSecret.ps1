<#
.SYNOPSIS
  把运维提供的机密写入本部署的 Key Vault（经 ARM 控制面，私有 vault 也可用；值不出现在命令行和 shell 历史中）。

.EXAMPLE
  # 在 deploy/azure 目录、已 azd env select 的终端中。default 企业（名称不变）：
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-scim-token -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-copilot-seat-pat -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-cert -File <证书 PEM 路径>
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-saml-idp-key -File <私钥 PEM 路径>
  # registry 中的其他企业（名称为 ghcp-ent-<id>-<kind>，README 第 8.6 节）：
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind scim-token -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind copilot-seat-pat -Prompt
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind saml-idp-cert -File <该企业自己的证书 PEM>
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind saml-idp-key -File <该企业自己的私钥 PEM>
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind models-admin-copilot-token -Prompt     # 可选
  ./hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind session-secret -Generate -Force        # 轮换（postprovision 会自动生成缺少的）
  # App GW 的 TLS 证书：不带密码的 PFX，按 base64 存为 application/x-pkcs12（也可以在 VNet 内用 az keyvault certificate import）。
  ./hooks/Set-GhcpSecret.ps1 -Name ghcp-public-tls -File <PFX 路径> -Base64 -ContentType application/x-pkcs12

.NOTES
  需要对 Key Vault 有 Microsoft.KeyVault/vaults/secrets/write（例如资源组上的 Contributor 或 Key Vault Contributor）。
  订阅、Key Vault 资源 ID 取自 azd 环境（azd env get-values），也可用 -Subscription / -KeyVaultResourceId 指定。
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9-]{1,127}$')][string] $Name = '',
  # 企业 ID 的规则与 src/packages/shared/src/enterprise/scope.ts 相同；default 用 -Name 与原有名称。
  [ValidatePattern('^[a-z][a-z0-9-]{0,30}[a-z0-9]$')][string] $Enterprise = '',
  [ValidateSet('saml-idp-cert', 'saml-idp-key', 'session-secret', 'scim-token', 'copilot-seat-pat', 'sso-default-user-password', 'models-admin-copilot-token')]
  [string] $Kind = '',
  [switch] $Prompt,
  [string] $File = '',
  [switch] $Base64,
  # 只用于 session-secret / sso-default-user-password：随机生成，值不显示。
  [switch] $Generate,
  # 允许覆盖已有的机密（轮换）。没有 -Force 时，已存在的机密不覆盖。
  [switch] $Force,
  [string] $ContentType = '',
  [string] $Subscription = '',
  [string] $KeyVaultResourceId = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"

if ($Enterprise -or $Kind) {
  if (-not ($Enterprise -and $Kind)) { throw '-Enterprise and -Kind go together.' }
  if ($Name) { throw 'Use either -Name or -Enterprise/-Kind.' }
  if ($Enterprise -eq 'default') { throw 'default keeps its original names: use -Name ghcp-scim-token etc. (README section 5.1).' }
  $Name = "ghcp-ent-$Enterprise-$Kind"
}
if (-not $Name) { throw 'Give -Name, or -Enterprise and -Kind.' }
$sources = @($Prompt.IsPresent, [bool]$File, $Generate.IsPresent) | Where-Object { $_ }
if (@($sources).Count -ne 1) { throw 'Give exactly one of -Prompt, -File or -Generate.' }
if ($Generate -and $Name -notmatch '(session-secret|sso-default-user-password)$') { throw '-Generate is only for session-secret and sso-default-user-password.' }

# 未显式给出时从当前 azd 环境读取（不打印值）。
if ($Subscription) { $env:AZURE_SUBSCRIPTION_ID = $Subscription }
if ($KeyVaultResourceId) { $env:AZURE_KEY_VAULT_RESOURCE_ID = $KeyVaultResourceId }
if (-not ($Subscription -and $KeyVaultResourceId)) { Import-AzdEnvironment }
if ($Subscription) { $env:AZURE_SUBSCRIPTION_ID = $Subscription }
if ($KeyVaultResourceId) { $env:AZURE_KEY_VAULT_RESOURCE_ID = $KeyVaultResourceId }

if (-not $Force -and (Test-KeyVaultSecret $Name)) { throw "$Name already exists; add -Force to replace it (rotation)." }

if ($Generate) {
  $value = New-RandomSecret 32
} elseif ($File) {
  $value = if ($Base64) { [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path $File))) } else { [System.IO.File]::ReadAllText((Resolve-Path $File)) }
} else {
  $secure = Read-Host -AsSecureString -Prompt "Value for $Name"
  $value = [System.Net.NetworkCredential]::new('', $secure).Password
}
if ([string]::IsNullOrEmpty($value)) { throw 'Empty value.' }
if ($Name -match 'sso-default-user-password$' -and $value.Length -lt 16) { throw 'The pool users'' SSO password needs at least 16 characters.' }

Set-KeyVaultSecretViaArm -Name $Name -Value $value -ContentType $ContentType
Remove-Variable value
Write-Host "Wrote $Name. Environment variables change only after a restart; mounted enterprise files within about 2 minutes (README sections 6 and 8.6)."
