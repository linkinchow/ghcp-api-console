<#
.SYNOPSIS
  把原环境的备份恢复到本部署：Proxy 的 MySQL 库、SSO / Login 的 SQLite、Console 的 admins.json（README 第 8.7 节）。

.DESCRIPTION
  迁移到新环境时，在第一次启动应用之前运行（GHCP_CONFIG_APPROVED 尚未设为 true，或已有应用被本脚本缩到 0）。
  原环境的数据只经过运维机和集群：备份文件被复制到集群内一个临时 Pod，由它
  - 以管理员账号经 TLS 把 proxy.sql 导入 Azure MySQL（私有终结点，只能在 VNet 内访问），导入前去掉触发器的 DEFINER；
  - 把 sso/、login/、console/ 的文件放进对应的数据盘，属主改为镜像内的 UID/GID 1000。
  临时 Pod 使用 MySQL 官方镜像（按 digest 导入 ACR）与 MySQL 账号初始化 Job 相同的 Key Vault 挂载、CA 和 NetworkPolicy。
  完成后删除临时 Pod；随后 azd env set GHCP_CONFIG_APPROVED true 并 azd hooks run postprovision 启动应用，
  Proxy 启动时把数据迁移为多企业结构。

  备份目录结构（文件名固定）：
    proxy.sql            mysqldump --single-transaction --routines --triggers --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces
    sso/sso.sqlite       以及同目录的 sso.sqlite-wal、sso.sqlite-shm、sso-user-events.log（存在时）
    login/login.sqlite   以及 login.sqlite-wal、login.sqlite-shm（存在时）
    console/admins.json

.PARAMETER BackupDir
  备份目录。

.PARAMETER ReplaceExistingData
  目标库或数据盘中已有数据时必须指定：先把正在运行的应用缩到 0，再删除目标库和数据盘中的内容。没有指定时发现任何已有数据即停止。

.EXAMPLE
  pwsh ./hooks/Restore-GhcpData.ps1 -BackupDir D:\ghcp-migration\backup
#>
param(
  [Parameter(Mandatory)][string] $BackupDir,
  [switch] $ReplaceExistingData
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/common.ps1"
Import-AzdEnvironment

# MySQL 8.4 官方镜像，只用其中的 mysql 客户端；按 digest 固定。
$MysqlClientSource = 'docker.io/library/mysql@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7'
$MysqlClientImage = 'ghcp/mysql-client:8.4'
$PodName = 'ghcp-restore'
$DataVolumes = [ordered]@{ sso = 'ghcp-sso-data'; login = 'ghcp-login-data'; console = 'ghcp-console-data' }
$Deployments = @('ghcp-proxy', 'ghcp-sso', 'ghcp-login', 'ghcp-console')

# ---- 1. 备份文件 ----
$backup = (Resolve-Path $BackupDir).Path
$required = @('proxy.sql', 'sso/sso.sqlite', 'login/login.sqlite', 'console/admins.json')
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $backup $file) -PathType Leaf)) { throw "Backup file missing: $file" }
}
$files = @(Get-ChildItem -LiteralPath $backup -Recurse -File | ForEach-Object {
  $relative = [IO.Path]::GetRelativePath($backup, $_.FullName).Replace('\', '/')
  if ($relative -eq 'proxy.sql' -or $relative -match '^(sso|login|console)/[^/]+$') {
    [pscustomobject]@{ Relative = $relative; Path = $_.FullName; Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant() }
  }
})
if (-not (Select-String -LiteralPath (Join-Path $backup 'proxy.sql') -Pattern 'TRIGGER `user_pool_credential_fence`' -Quiet)) {
  throw 'proxy.sql has no user_pool_credential_fence trigger: dump again with --triggers (the user pool depends on it).'
}
Write-Host "restore: $($files.Count) backup files from $backup"
$files | ForEach-Object { Write-Host "  $($_.Relative)  $($_.Sha256.Substring(0, 12))" }

# ---- 2. 集群与运行中的应用 ----
Connect-Aks
$namespace = Get-RequiredEnv 'GHCP_NAMESPACE'
Initialize-Namespace $namespace
Invoke-Kubectl -Arguments @('-n', $namespace, 'get', 'secretproviderclass', 'ghcp-mysql-bootstrap-kv', '-o', 'name') -AllowFailure 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The MySQL account bootstrap has not run yet: run azd provision first (README section 4).' }
$running = @($Deployments | Where-Object {
  $replicas = Invoke-Kubectl -Arguments @('-n', $namespace, 'get', 'deployment', $_, '-o', 'jsonpath={.spec.replicas}') -AllowFailure 2>$null
  $LASTEXITCODE -eq 0 -and [int]"0$replicas" -gt 0
})
if ($running.Count) {
  if (-not $ReplaceExistingData) { throw "The application is running ($($running -join ', ')). Restore only into a new environment, or pass -ReplaceExistingData." }
  Write-Host "restore: scaling $($running -join ', ') to 0"
  foreach ($name in $running) { Invoke-Kubectl -Arguments @('-n', $namespace, 'scale', "deployment/$name", '--replicas=0') | Out-Null }
  foreach ($name in $running) {
    Invoke-Kubectl -Arguments @('-n', $namespace, 'wait', '--for=delete', 'pod', '-l', "app.kubernetes.io/name=$name", '--timeout=5m') -AllowFailure | Out-Null
  }
}

# ---- 3. 数据盘（只创建 StorageClass 与 PVC，不启动应用）----
if ((Invoke-Renderer @('render')) -notin @(0, 3)) { throw 'Rendering the overlay failed (see the errors above).' }
$rendered = (& kubectl kustomize (Join-Path (Get-GeneratedDir) 'app')) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'kubectl kustomize failed.' }
$storage = @($rendered -split "(?m)^---\s*$" | Where-Object { $_ -match '(?m)^kind: (PersistentVolumeClaim|StorageClass)\s*$' })
if ($storage.Count -lt 4) { throw "Expected the StorageClass and data PVCs in the rendered app, found $($storage.Count) objects." }
$storage -join "`n---`n" | & kubectl --kubeconfig $script:Kube.Kubeconfig --context $script:Kube.Context apply -f - | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Applying the data volumes failed.' }

# ---- 4. 临时 Pod ----
$registry = Get-RequiredEnv 'AZURE_CONTAINER_REGISTRY_NAME'
Invoke-Az -Arguments @('acr', 'import', '--name', $registry, '--source', $MysqlClientSource, '--image', $MysqlClientImage, '--force') | Out-Null
$volumes = @(
  @{ name = 'mysql-ca'; configMap = @{ name = 'ghcp-mysql-ca'; items = @(@{ key = 'ca.pem'; path = 'ca.pem' }) } },
  @{ name = 'key-vault'; csi = @{ driver = 'secrets-store.csi.k8s.io'; readOnly = $true; volumeAttributes = @{ secretProviderClass = 'ghcp-mysql-bootstrap-kv' } } },
  @{ name = 'work'; emptyDir = @{ sizeLimit = '2Gi' } }
)
$mounts = @(
  @{ name = 'mysql-ca'; mountPath = '/run/mysql-ca'; readOnly = $true },
  @{ name = 'key-vault'; mountPath = '/mnt/secrets-store'; readOnly = $true },
  @{ name = 'work'; mountPath = '/work' }
)
foreach ($service in $DataVolumes.Keys) {
  $volumes += @{ name = $service; persistentVolumeClaim = @{ claimName = $DataVolumes[$service] } }
  $mounts += @{ name = $service; mountPath = "/restore/$service" }
}
# 标签与账号初始化 Job 相同：沿用它的 NetworkPolicy（只放行 MySQL 3306）与 DNS 放行。root 只用于把文件属主改为 1000。
$pod = @{
  apiVersion = 'v1'; kind = 'Pod'
  metadata = @{ name = $PodName; namespace = $namespace; labels = @{ 'app.kubernetes.io/name' = 'ghcp-mysql-bootstrap'; 'app.kubernetes.io/part-of' = 'ghcp'; 'app.kubernetes.io/component' = 'restore' } }
  spec = @{
    restartPolicy = 'Never'; serviceAccountName = 'ghcp-workload'; automountServiceAccountToken = $false; enableServiceLinks = $false
    containers = @(@{
      name = 'restore'; image = "$((Get-RequiredEnv 'AZURE_CONTAINER_REGISTRY_ENDPOINT'))/$MysqlClientImage"
      command = @('sleep', '3600')
      securityContext = @{ allowPrivilegeEscalation = $false; capabilities = @{ drop = @('ALL'); add = @('CHOWN', 'FOWNER', 'DAC_OVERRIDE') } }
      resources = @{ requests = @{ cpu = '100m'; memory = '256Mi' }; limits = @{ cpu = '1'; memory = '1Gi' } }
      volumeMounts = $mounts
    })
    volumes = $volumes
  }
}
Invoke-Kubectl -Arguments @('-n', $namespace, 'delete', 'pod', $PodName, '--ignore-not-found', '--wait=true') | Out-Null
$pod | ConvertTo-Json -Depth 12 | & kubectl --kubeconfig $script:Kube.Kubeconfig --context $script:Kube.Context apply -f - | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Creating the restore pod failed.' }
try {
  Invoke-Kubectl -Arguments @('-n', $namespace, 'wait', '--for=condition=Ready', "pod/$PodName", '--timeout=10m') -AllowFailure | Out-Null
  if ($LASTEXITCODE -ne 0) {
    # Usually a data disk that cannot attach (for example zonal disks in different zones); show why.
    Invoke-Kubectl -Arguments @('-n', $namespace, 'describe', 'pod', $PodName) -AllowFailure | Select-Object -Last 15 | Out-Host
    throw 'The restore pod did not become ready (see the events above). Nothing was changed.'
  }

  # ---- 5. 复制备份并校验 ----
  Invoke-Kubectl -Arguments @('-n', $namespace, 'exec', $PodName, '--', 'mkdir', '-p', '/work/in/sso', '/work/in/login', '/work/in/console') | Out-Null
  # kubectl cp reads "C:\..." as <pod>:<path>, so copy with paths relative to the backup directory.
  Push-Location $backup
  try {
    foreach ($file in $files) {
      # The API server connection can drop on long copies; retry (the SHA-256 check below catches a bad copy).
      foreach ($attempt in 1..5) {
        Invoke-Kubectl -Arguments @('-n', $namespace, 'cp', $file.Relative, "${PodName}:/work/in/$($file.Relative)") -AllowFailure | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        if ($attempt -eq 5) { throw "Copying $($file.Relative) into the restore pod failed five times. Nothing was changed." }
        Start-Sleep -Seconds 15
      }
    }
  } finally {
    Pop-Location
  }
  $remote = @{}
  (Invoke-Kubectl -Arguments @('-n', $namespace, 'exec', $PodName, '--', 'sh', '-c', 'cd /work/in && find . -type f -exec sha256sum {} +')) | ForEach-Object {
    $parts = "$_".Trim() -split '\s+', 2
    if ($parts.Count -eq 2) { $remote[$parts[1].TrimStart('.', '/')] = $parts[0] }
  }
  foreach ($file in $files) {
    if ($remote[$file.Relative] -ne $file.Sha256) { throw "Copy of $($file.Relative) does not match the backup (SHA-256)." }
  }
  Write-Host "restore: $($files.Count) files copied into the pod, SHA-256 verified"

  # ---- 6. MySQL 与数据盘 ----
  $replace = if ($ReplaceExistingData) { '1' } else { '0' }
  $restoreScript = @'
set -eu
used=""
export MYSQL_PWD="$(cat /mnt/secrets-store/mysql-admin-password)"
M="mysql --default-character-set=utf8mb4 --ssl-mode=VERIFY_IDENTITY --ssl-ca=/run/mysql-ca/ca.pem -h $DB_HOST -u $DB_ADMIN"
tables=$($M -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")
for s in sso login console; do
  if [ -n "$(ls -A /restore/$s 2>/dev/null | grep -v '^lost+found$' || true)" ]; then echo "data volume $s is not empty"; used="$used $s"; fi
done
if [ "$tables" != "0" ] || [ -n "$used" ]; then
  [ "$REPLACE" = 1 ] || { echo "REFUSED: database $DB_NAME has $tables tables, non-empty volumes:$used (pass -ReplaceExistingData)"; exit 3; }
fi
echo "mysql: $($M -N -e 'SELECT VERSION()'), TLS $($M -N -e "SHOW SESSION STATUS LIKE 'Ssl_version'" | cut -f2)"
$M -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
# The trigger keeps the source account as DEFINER; that account does not exist here (ERROR 1227). Without the clause the
# importing administrator becomes the definer.
sed -E 's#/\*!50017 DEFINER=`[^`]*`@`[^`]*`\*/ ##; s#DEFINER=`[^`]*`@`[^`]*` ##' /work/in/proxy.sql > /work/proxy.nodefiner.sql
left=$(grep -c 'DEFINER=' /work/proxy.nodefiner.sql || true)
[ "$left" = 0 ] || { echo "DEFINER clauses left in the dump: $left"; exit 4; }
$M "$DB_NAME" < /work/proxy.nodefiner.sql
echo "mysql: imported; tables=$($M -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME'")"
$M -N -e "SELECT 'trigger', TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='$DB_NAME'"
for t in proxy_accounts user_pool_accounts user_pool_leases schema_migrations; do
  echo "rows $t: $($M -N -e "SELECT COUNT(*) FROM \`$DB_NAME\`.\`$t\`" 2>/dev/null || echo missing)"
done
for s in sso login console; do
  find /restore/$s -mindepth 1 -maxdepth 1 ! -name lost+found -exec rm -rf {} +
  cp -a /work/in/$s/. /restore/$s/
  chown -R 1000:1000 /restore/$s
  # kubectl cp keeps the mode of the copy (0666 from Windows): only the service account may read these files.
  chmod -R u=rwX,go= /restore/$s
  echo "volume $s:"; ls -ln /restore/$s | tail -n +2
done
'@
  $environment = @(
    "DB_HOST=$(Get-RequiredEnv 'MYSQL_FQDN')", "DB_ADMIN=$(Get-RequiredEnv 'MYSQL_ADMIN_LOGIN')",
    "DB_NAME=$(if ($env:MYSQL_DATABASE) { $env:MYSQL_DATABASE } else { 'ghcp_proxy' })", "REPLACE=$replace"
  )
  $output = Invoke-Kubectl -Arguments (@('-n', $namespace, 'exec', $PodName, '--', 'env') + $environment + @('sh', '-c', $restoreScript)) -AllowFailure
  $code = $LASTEXITCODE
  $output | Out-Host
  if ($code -eq 3) { throw 'Existing data found: nothing was changed. Pass -ReplaceExistingData only if this environment may be overwritten.' }
  if ($code -ne 0) { throw "Restoring failed (exit $code); see the output above. The application has not been started." }
} finally {
  Invoke-Kubectl -Arguments @('-n', $namespace, 'delete', 'pod', $PodName, '--ignore-not-found', '--wait=false') -AllowFailure | Out-Null
}

Write-Host ''
Write-Host 'Restore complete. Next (README section 8.7):'
Write-Host '  1. Check that every identity value and every Proxy pool setting equals the source environment (section 3.1, GHCP_PROXY_CONFIG_OVERRIDES).'
Write-Host '  2. azd env set GHCP_CONFIG_APPROVED true; azd hooks run postprovision   (the MySQL account bootstrap runs again, then the app starts; Proxy migrates the data to the multi-enterprise schema).'
Write-Host '  3. Verify before resuming prewarming: /healthz releaseLine multi, schema_migrations enterprise-v1/*, Console pool counts and leases.'
