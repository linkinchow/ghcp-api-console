# azd hook 共用函数。约定：
# - 每一条 az 命令都显式带 --subscription（来自 azd 环境的 AZURE_SUBSCRIPTION_ID），从不依赖 az 的默认订阅；
# - kubectl 只使用本项目自己的 kubeconfig 文件（deploy/azure/.kube/<集群>.config），并显式传 --kubeconfig 与 --context，
#   从不读写 ~/.kube/config 或其他上下文；
# - 机密只在内存中生成，经 ARM（控制面）写入 Key Vault，不写入 azd 环境、日志或仓库（MySQL 管理员密码除外，见 README 第 5 节）。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:AzureDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:KeyVaultApiVersion = '2023-07-01'

# 单独运行脚本（不经 azd hook）时，从当前 azd 环境读入值；已存在的进程环境变量优先。
function Import-AzdEnvironment {
  if ($env:AZD_HOOK_IMPORTED -eq '1' -or -not [string]::IsNullOrWhiteSpace($env:AZURE_KEY_VAULT_RESOURCE_ID)) { return }
  $lines = & azd env get-values 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'azd env get-values failed: run from deploy/azure after azd env select <name>.' }
  foreach ($line in $lines) {
    if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)="(.*)"$') {
      if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Matches[1]))) {
        [Environment]::SetEnvironmentVariable($Matches[1], ($Matches[2] -replace '\\"', '"'))
      }
    }
  }
  $env:AZD_HOOK_IMPORTED = '1'
}

function Get-RequiredEnv {
  param([Parameter(Mandatory)][string] $Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Environment value '$Name' is not set. Run 'azd provision' first, or 'azd env set $Name <value>'."
  }
  return $value
}

function Test-EnvTrue {
  param([Parameter(Mandatory)][string] $Name, [bool] $Default = $false)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return @('true', '1', 'yes') -contains $value.ToLowerInvariant()
}

function Get-Subscription {
  $subscription = Get-RequiredEnv 'AZURE_SUBSCRIPTION_ID'
  if ($subscription -notmatch '^[0-9a-fA-F-]{36}$') { throw "AZURE_SUBSCRIPTION_ID is not a subscription ID." }
  return $subscription
}

# 运行 az 并在结尾追加 --subscription；失败时抛出（不打印参数，参数里可能有文件路径但从不含机密值）。
function Invoke-Az {
  param([Parameter(Mandatory)][string[]] $Arguments, [switch] $AllowFailure)
  $all = @($Arguments) + @('--subscription', (Get-Subscription), '--only-show-errors')
  $output = & az @all
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
    throw "az $($Arguments[0]) $($Arguments[1]) failed (exit $LASTEXITCODE)."
  }
  return $output
}

function New-RandomSecret {
  param([int] $ByteCount = 48)
  $bytes = [byte[]]::new($ByteCount)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  # base64url，不含 + / =：可以直接放进 mysql:// URL 和环境变量。
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-KeyVaultSecretId {
  param([Parameter(Mandatory)][string] $Name)
  return "$(Get-RequiredEnv 'AZURE_KEY_VAULT_RESOURCE_ID')/secrets/$Name"
}

# 经 ARM 判断机密是否存在（只返回元数据，不读值；私有 vault 也可用）。
function Test-KeyVaultSecret {
  param([Parameter(Mandatory)][string] $Name)
  Invoke-Az -Arguments @('resource', 'show', '--ids', (Get-KeyVaultSecretId $Name), '--api-version', $script:KeyVaultApiVersion, '-o', 'none') -AllowFailure 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# 经 ARM 写入机密。值只写进一个仅当前用户可读的临时文件，用完立即删除。
function Set-KeyVaultSecretViaArm {
  param(
    [Parameter(Mandatory)][string] $Name,
    [Parameter(Mandatory)][string] $Value,
    [string] $ContentType = ''
  )
  if ($Name -notmatch '^[A-Za-z0-9-]{1,127}$') { throw "Invalid Key Vault secret name '$Name'." }
  $properties = @{ value = $Value }
  if ($ContentType) { $properties.contentType = $ContentType }
  $file = [System.IO.Path]::GetTempFileName()
  try {
    if (-not $IsWindows) { & chmod 600 $file }
    [System.IO.File]::WriteAllText($file, ($properties | ConvertTo-Json -Compress))
    Invoke-Az -Arguments @('resource', 'create', '--id', (Get-KeyVaultSecretId $Name), '--api-version', $script:KeyVaultApiVersion,
      '--properties', "@$file", '-o', 'none') | Out-Null
  } finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

# 机密不存在时才生成并写入（重复执行 azd provision 不会轮换已有机密）。
function Initialize-GeneratedSecret {
  param([Parameter(Mandatory)][string] $Name, [int] $ByteCount = 48)
  if (Test-KeyVaultSecret $Name) {
    Write-Host "  $Name exists, kept"
    return $false
  }
  Set-KeyVaultSecretViaArm -Name $Name -Value (New-RandomSecret $ByteCount)
  Write-Host "  $Name generated"
  return $true
}

# 集群凭据写到本项目自己的 kubeconfig；不触碰 ~/.kube/config。
function Connect-Aks {
  $cluster = Get-RequiredEnv 'AZURE_AKS_CLUSTER_NAME'
  $group = Get-RequiredEnv 'AZURE_AKS_RESOURCE_GROUP'
  $kubeconfig = Join-Path $script:AzureDir ".kube/$cluster.config"
  New-Item -ItemType Directory -Force -Path (Split-Path $kubeconfig) | Out-Null
  Invoke-Az -Arguments @('aks', 'get-credentials', '--resource-group', $group, '--name', $cluster, '--file', $kubeconfig, '--overwrite-existing') | Out-Null
  # Entra ID 集群：把 exec 插件换成复用 az 登录态的 kubelogin（禁用本地账户时必需）。
  if (Get-Command kubelogin -ErrorAction SilentlyContinue) {
    & kubelogin convert-kubeconfig --kubeconfig $kubeconfig -l azurecli | Out-Null
  } elseif (Test-EnvTrue 'GHCP_DISABLE_LOCAL_ACCOUNTS') {
    throw 'kubelogin is required when local accounts are disabled (az aks install-cli installs it).'
  }
  $context = (& kubectl config current-context --kubeconfig $kubeconfig).Trim()
  $script:Kube = [pscustomobject]@{ Kubeconfig = $kubeconfig; Context = $context }
  Write-Host "Using kubeconfig $kubeconfig (context $context)"
  # 新授予的 Azure RBAC 角色需要几分钟才对 API server 生效。
  foreach ($attempt in 1..30) {
    $answer = Invoke-Kubectl -Arguments @('auth', 'can-i', 'create', 'namespaces') -AllowFailure 2>$null
    if ("$answer".Trim() -eq 'yes') { return }
    Start-Sleep -Seconds 10
  }
  throw 'The signed-in identity cannot manage the cluster (needs Azure Kubernetes Service RBAC Cluster Admin, see README section 2).'
}

function Invoke-Kubectl {
  param([Parameter(Mandatory)][string[]] $Arguments, [switch] $AllowFailure)
  if (-not $script:Kube) { throw 'Connect-Aks has not been called.' }
  $all = @('--kubeconfig', $script:Kube.Kubeconfig, '--context', $script:Kube.Context) + $Arguments
  $output = & kubectl @all
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "kubectl $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
  return $output
}

function Initialize-Namespace {
  param([Parameter(Mandatory)][string] $Namespace)
  Invoke-Kubectl -Arguments @('get', 'namespace', $Namespace, '-o', 'name') -AllowFailure 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Invoke-Kubectl -Arguments @('create', 'namespace', $Namespace) | Out-Null }
}

function Invoke-Renderer {
  param([string[]] $Arguments = @('render'))
  & node (Join-Path $script:AzureDir 'scripts/render-overlay.mjs') @Arguments
  return $LASTEXITCODE
}

# registry（GHCP_ENTERPRISE_REGISTRY_FILE）中每个企业引用的 Key Vault 机密：[{ name, enterprise, field, service, required, generated }]。
# 没有 registry 时为空。registry 不符合约定时抛出（错误由渲染脚本打印）。
function Get-EnterpriseSecrets {
  if ([string]::IsNullOrWhiteSpace($env:GHCP_ENTERPRISE_REGISTRY_FILE)) { return @() }
  $output = & node (Join-Path $script:AzureDir 'scripts/render-overlay.mjs') enterprise-secrets
  if ($LASTEXITCODE -ne 0) { throw 'The enterprise registry is invalid (see the errors above).' }
  return @($output | ConvertFrom-Json)
}

# 部署前检查：registry 引用的每个机密都必须已在 Key Vault 中（缺少时 SSO 对该企业报阻塞项，Pod 停在 CSI 挂载）。
function Assert-EnterpriseSecretsPresent {
  $missing = @(Get-EnterpriseSecrets | Where-Object { -not (Test-KeyVaultSecret $_.name) } | ForEach-Object { "$($_.name) ($($_.enterprise).$($_.field))" })
  if ($missing.Count) {
    throw ("Key Vault is missing secrets referenced by the enterprise registry: " + ($missing -join ', ') +
      ". Write them with hooks/Set-GhcpSecret.ps1 -Enterprise <id> -Kind <kind> (README section 8.6).")
  }
}

function Get-GeneratedDir {
  return Join-Path $script:AzureDir ".generated/$(Get-RequiredEnv 'AZURE_ENV_NAME')"
}
