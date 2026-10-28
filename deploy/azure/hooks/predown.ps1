# azd predown：默认拒绝。azd down 会删除本环境的资源组，其中包括 MySQL（账号池、租约）与 SSO / Login / Console 的数据盘。
# 复用 VNet / AKS 时，本部署还在别人的资源组里创建过子网、角色分配或 DNS 链接，azd down 可能波及这些资源组。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"

if ((Test-EnvTrue 'GHCP_BYO_NETWORK') -or (Test-EnvTrue 'GHCP_BYO_AKS')) {
  throw 'This environment reuses an existing VNet or AKS cluster. Do not use azd down; delete the resources of this deployment by hand (README section 9).'
}
if (-not (Test-EnvTrue 'GHCP_ALLOW_AZD_DOWN')) {
  throw 'azd down deletes the MySQL database and the SSO / Login / Console disks. Back them up first, then run: azd env set GHCP_ALLOW_AZD_DOWN true'
}
Write-Warning 'GHCP_ALLOW_AZD_DOWN=true: deleting this environment.'
