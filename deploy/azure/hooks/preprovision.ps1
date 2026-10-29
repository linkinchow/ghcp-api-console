# azd preprovision：检查工具与参数，生成 MySQL 管理员密码（只保存在本机 azd 环境）。不访问 Azure 资源。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"

Write-Host 'preprovision: checking tools'
foreach ($tool in @('az', 'azd', 'kubectl', 'kustomize', 'node')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is required (deploy/azure/README.md section 2)." }
}
$nodeMajor = [int]((& node -p 'process.versions.node.split(".")[0]'))
if ($nodeMajor -lt 20) { throw "Node.js 20 or later is required (found $nodeMajor)." }

# 订阅必须显式指定：不借用 az CLI 当前的默认订阅，避免部署到错误的订阅。
Write-Host 'preprovision: checking subscription'
$subscription = Get-Subscription
Write-Host "  subscription: $subscription (from AZURE_SUBSCRIPTION_ID)"

Write-Host 'preprovision: validating GHCP_PUBLIC_ACCESS'
if ((Invoke-Renderer @('validate-public-access')) -ne 0) { throw 'GHCP_PUBLIC_ACCESS is invalid (see the errors above).' }

if (-not [string]::IsNullOrWhiteSpace($env:GHCP_EXISTING_VNET_NAME) -or -not [string]::IsNullOrWhiteSpace($env:GHCP_EXISTING_AKS_NAME)) {
  Write-Warning 'Existing VNet / AKS mode: this deployment adds subnets, role assignments or DNS links in resource groups it does not own. Never run "azd down" for this environment (README section 9).'
}

# MySQL 管理员密码：azd 在运行 hook 之前就校验参数，所以 Bicep 中它的默认值为空；这里生成后写回 azd 环境，
# provision 读取。它保存在本机 .azure/<环境>/.env（不入库）并由 Bicep 写入 Key Vault 的 mysql-admin-password。
$existing = & azd env get-value GHCP_MYSQL_ADMIN_PASSWORD 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($existing)) {
  Write-Host 'preprovision: generating the MySQL administrator password'
  # 末尾固定字符保证满足 Azure MySQL 的复杂度要求（大写、小写、数字、符号中至少三类），熵来自前面的随机部分。
  & azd env set GHCP_MYSQL_ADMIN_PASSWORD "$(New-RandomSecret 32)aA1-" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'azd env set failed.' }
}
Write-Host 'preprovision: done'
