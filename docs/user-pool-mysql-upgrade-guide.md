# 单副本 SQLite User Pool 升级到多副本 MySQL

适用：已经使用 `ACCOUNT_ROUTING_MODE=caller-lease` 的单 Proxy、SQLite 账号池，升级为 Kubernetes 集群中的多 Proxy、共享 MySQL。需要维护窗口。**不是从 direct 模式首次启用 User Pool 的指南。**

准备范围：源部署、目标K8s集群、专用MySQL，以及备份和回退负责人均已明确。本指南使用交付指定的源码SHA；确认该版本包含本指南引用的工具与YAML后再操作。

升级后保留现有账号、OAuth 凭据、池成员、租约和统计，不需要重新创建 GitHub 用户或重新购买席位。SSO、Login、Console 继续各运行一个实例，保留原数据卷和证书。

## 一、升级后的部署结构与文件

```text
LiteLLM ──→ 原有 Proxy Service ──→ Proxy Pod 1 / 2 / 3
                                      │
                                      └──→ 同一个 MySQL 写主库
SSO / Login / Console ──→ 同一个 Proxy Service
```

- **部署 YAML**：[kubernetes.template.yaml](../deploy/user-pool-mysql-customer/kubernetes.template.yaml)。包含 Proxy Deployment、Service、Proxy 配置和辅助服务的路由配置。迁移首次启动为 **1 个 Proxy**，验证后扩到3个或所需数量。
- **数据库迁移程序**：[`upgrade/user-pool-mysql/index.ts`](../upgrade/user-pool-mysql/index.ts)。不要使用旧的 direct 模式迁移程序。
- **运维说明**：[基础监控与故障处理](user-pool-ops-basics.md)。

YAML不部署MySQL，也不替换现有SSO、Login和Console的Deployment/PVC。MySQL由部署方提供；这三个应用在原部署上更新镜像和必要配置即可。**已有Proxy Service应保留名称、地址和端口，只在切换时调整后端，不另加NGINX。**

所有 `<...>` 和 `REPLACE_*` 必须替换为实际值。以下命令在已选择正确Kubernetes context的管理机执行；使用Helm或GitOps管理的部署，应把同样配置变更提交到原发布流程，避免控制器覆盖手工修改。

## 二、升级前准备

### 2.1 记录并保留现有配置

| 项目 | 升级要求 |
| --- | --- |
| 源码与镜像 | 使用交付时指定的完整commit SHA；保留旧镜像引用和原部署YAML |
| 数据与卷 | 记录Proxy、SSO、Login、Console的实际挂载位置和PVC；不得误挂新空卷 |
| 凭据 | 保留API_KEY、INTERNAL_API_TOKEN、SESSION_SECRET及现有GitHub凭据，用Secret管理 |
| SSO | 保留SAML URL、Issuer、ACS、签名证书、私钥和用户库，不因本次迁移重新配置GitHub SAML |
| Login | 保留浏览器使用的SSO URL、并发数和超时；该URL必须与实际登录跳转地址匹配 |
| 账号池 | 记录域名、预热模型、target、cap、TTL及下表的并发/超时参数 |
| 请求统计 | 明确`REQUEST_STATS_PER_ACCOUNT_LIMIT`；默认仅每账号2条，启动可能裁剪历史，0不是无限 |
| MySQL | MySQL 8、InnoDB、专用空数据库、受信任TLS证书、备份方案和连接预算 |

MySQL迁移账号需要建表、索引、触发器、读写和命名锁所需权限；运行账号需具备应用启动校验/迁移及运行权限。若分离迁移与运行账号，还需保证触发器的DEFINER及其权限持续有效。连接必须指向**同一个写主库**，不能使用读副本。

### 2.2 核对已有 Service

```bash
kubectl -n <namespace> get service <proxy-service> -o yaml
```

```bash
kubectl -n <namespace> get endpointslices -l kubernetes.io/service-name=<proxy-service> -o wide
```

确认Service的selector、port/targetPort与Proxy Pod对应，后端只包含预期实例。记录集群域名；内部地址通常为：

```text
http://<proxy-service>.<namespace>.svc.<cluster-domain>:<service-port>
```

标准ClusterIP Service可在健康Proxy之间分发新连接，不需要sticky session。如果现有入口是Headless、ExternalName或指向中间代理，先确认其实际转发方式，不能直接套用本模板。流式请求还需核对现有入口的空闲超时与缓冲设置。

## 三、提前准备新镜像和配置

### 3.1 从固定源码构建四个镜像

从交付渠道取得源码，在独立release目录固定到提供的完整SHA，不覆盖旧部署目录：

```bash
git checkout --detach <完整源码SHA>
```

在仓库根目录构建；`NPM_REGISTRY`填写组织批准的包源，镜像标签使用本次版本且不覆盖旧标签。构建不启动服务、不迁移数据库。

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -f src/proxy/Dockerfile -t <镜像前缀>-proxy:<版本> .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -f src/sso/Dockerfile -t <镜像前缀>-sso:<版本> .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -f src/login/Dockerfile -t <镜像前缀>-login:<版本> .
```

```bash
docker build --build-arg NPM_REGISTRY="$NPM_REGISTRY" -f src/console/Dockerfile -t <镜像前缀>-console:<版本> .
```

按现有K8s镜像分发流程将这些镜像提供给各节点，记录实际镜像ID/引用。本指南不要求使用我们提供的镜像仓库。Login镜像还会安装浏览器，构建应在维护窗口前完成。

### 3.2 填写 Kubernetes YAML

复制模板到私有配置目录：

```bash
cp deploy/user-pool-mysql-customer/kubernetes.template.yaml <私有配置目录>/user-pool-mysql.yaml
```

按模板内的`REPLACE_*`填写namespace、原有Service名称、镜像、Secret、MySQL CA、资源和服务地址。将四个YAML对象按`---`分成配置、Deployment和Service三个私有文件，便于分阶段应用；**先不要应用Service对象或启动应用**。

Proxy的关键配置如下。迁移期间保留原池参数，不顺便调整并发和模型；迁移器与所有Proxy必须使用相同的有效值。

| 配置 | 迁移时填写 |
| --- | --- |
| `STORAGE_DRIVER` | `mysql` |
| `ACCOUNT_ROUTING_MODE` | `caller-lease` |
| `MYSQL_URL` | 目标数据库连接串，通过Secret注入，不放进ConfigMap或命令参数 |
| `MYSQL_SSL_MODE` | 非本机连接使用`verify-ca` |
| `MYSQL_SSL_CA_PATH` | 挂载的受信任CA文件路径，证书应匹配实际MySQL主机名 |
| `MYSQL_CONNECTION_LIMIT` | 每个Proxy的连接上限；按副本数和滚动更新额外Pod计算总量 |
| `POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_WARMUP_MODEL` | 保留原池域名和已使用的预热模型 |
| `PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS` | 保留原值；未显式设置时分别默认300秒、5秒 |
| `PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING` | 迁移器与所有Proxy统一；未显式设置时均默认5，不能把原来显式的1当成默认5 |
| `POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` | 保留原值；默认分别30秒、120秒 |
| `READY_IDLE_TARGET`、`POOL_MAX_ACCOUNTS`、`CALLER_LEASE_TTL_SECONDS` | 已有值从SQLite迁入；这些env仅用于首次初始化，不覆盖已有池设置 |
| `SSO_BASE_URL`、`LOGIN_BASE_URL` | 现有SSO/Login内部服务根地址，不带`/api` |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | 使用已批准的保留量，所有Proxy相同 |

迁移管理机上的私有备份和配置目录应仅允许维护人员访问（例如先设置`umask 077`）。应用密钥继续使用原值；在目标namespace中准备模板引用的Secret，包含`API_KEY`、`INTERNAL_API_TOKEN`和新增的`MYSQL_URL`。若使用现有Secret管理系统，在该系统中更新；以下仅是从受保护文件创建专用Secret的示例，不在命令行写出密钥值：

```bash
kubectl -n <namespace> create secret generic <proxy-secret> --from-env-file=<私有配置目录>/proxy-secrets.env
```

将MySQL CA证书准备为模板引用的ConfigMap，键名为`ca.pem`：

```bash
kubectl -n <namespace> create configmap <mysql-ca-configmap> --from-file=ca.pem=<MySQL-CA证书文件>
```

资源已存在时，通过原配置管理流程更新，不删除重建。模板的`CUSTOMER_PAUSED_DATABASE_APPROVED`默认`BLOCKED`。它只是启动前的操作员确认门禁，不会替你暂停数据库。导入验证完成前不要改为`"true"`。

## 四、维护停机并备份

1. 在User pool页面勾选 **Pause prewarming**，将Ready idle target设为 **0** 并保存；记录原target，切换完成后恢复。
2. 让LiteLLM/原入口停止向这套Proxy发送新业务请求，等待推理、catalog hold以及SSO/SCIM/席位/Login任务完成。**暂停预热不等于停止业务，也不代表浏览器任务已结束。**
3. 停止旧Proxy及可写入/回调的Login、SSO和Console。K8s Deployment示例：

```bash
kubectl -n <namespace> scale deployment <旧proxy> <login> <sso> <console> --replicas=0
```

4. 确认Pod/进程已停止，备份实际Proxy/SSO/Login/Console数据、Login日志、证书及私有配置。保留整个SQLite目录，包括可能存在的`-wal`、`-shm`、`-journal`，不要只复制主文件。
5. 在**备份副本**上生成迁移所需的独立SQLite文件。下面在已有私有目录中执行，不接触原卷：

```bash
python3 - <<'PY'
from pathlib import Path
import sqlite3
source = Path('/替换为完整备份副本目录/proxy.sqlite')
target = Path('/替换为私有迁移目录/proxy-migrate.sqlite')
assert source.is_file() and not target.exists()
with source.open('rb') as f:
    assert f.read(16) == b'SQLite format 3\x00'
src = sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)
dst = sqlite3.connect(target)
try:
    src.backup(dst)
    dst.execute('PRAGMA journal_mode=DELETE')
    assert dst.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert dst.execute('PRAGMA foreign_key_check').fetchall() == []
finally:
    dst.close()
    src.close()
PY
```

迁移输入必须是独立、完整的DELETE-journal备份且没有sidecar文件。不要直接删除WAL或给原库设置`immutable=1`来跳过数据。保存备份校验值，并验证备份能恢复。

## 五、迁移数据库

在可信维护环境准备项目依赖（Node.js 22+；使用组织批准的包源），从固定源码目录运行。迁移程序不会自动加载`.env`。

```bash
npm ci --registry="$NPM_REGISTRY"
```

```bash
npm --workspace @ghcp/shared run build
```

确认迁移管理机上的原生SQLite依赖可加载，使用与安装依赖时相同的Node版本；不要把另一平台的`node_modules`直接复制过来。

### 5.1 先预检 SQLite

```bash
npm run upgrade:user-pool-mysql -- --sqlite <独立备份绝对路径> --dry-run
```

预检只读取源副本，不连接MySQL。通过后记录表计数。若提示未暂停、owner未到期、hold/初始化记录未排空或授权结果不明，先解决对应问题，不删记录或清安全字段强行通过。

**旧schema处理：** 如果仅缺`user_pool_catalog_cooldowns`及其索引，已有窄范围的副本准备工具；按[详细手册的旧schema步骤](user-pool-customer-migration-guide.md)处理并重新预检。其他缺列、未知表或触发器不符时停止，由维护人员确认升级路径，不能使用force或直接改原库。

### 5.2 导入全新 MySQL

保持所有目标Proxy停止。通过受保护的环境注入方式设置`MYSQL_URL`、`MYSQL_SSL_MODE=verify-ca`、`MYSQL_SSL_CA_PATH`，以及第3.2节中所有池配置不变量。迁移连接池至少3条连接；非本机地址必须验证TLS。

```bash
npm run upgrade:user-pool-mysql -- --sqlite <独立备份绝对路径> --confirm-offline-source --confirm-empty-target
```

程序导入并内部逐字段比对账号、凭据、池成员、租约、统计和事件，只输出计数。成功后目标保持暂停，清除旧调度owner；已有租约期限不重置。**SSO、Login、Console的数据库不迁到这个MySQL，继续使用原持久卷。**

若出现`commit_outcome_unknown`或`rollback_unconfirmed`，保持维护状态，检查目标后再决定；不要直接重试导入。DDL失败可能留下空表/初始化记录，不能据此认为导入已成功。目标非空时不要清表重跑。

## 六、先启动一个 Proxy，核对迁移结果

1. 确认目标库paused=1、idle target=0、计数符合预检；确认应用连接的是目标库，统计保留量正确。
2. 将私有配置中的启动门禁改为`"true"`，Deployment仍为 **replicas: 1**。先应用两个ConfigMap和新的Proxy Deployment，**不改变旧Service selector**。

```bash
kubectl apply -f <私有配置目录>/configmaps.yaml -f <私有配置目录>/proxy-deployment.yaml
```

```bash
kubectl -n <namespace> rollout status deployment/ghcp-pool-proxy
```

3. 使用独立管理通道检查新Proxy，不恢复业务流量。例如从管理机临时port-forward到新Deployment：

```bash
kubectl -n <namespace> port-forward deployment/ghcp-pool-proxy 18000:3000
```

另开终端检查健康：

```bash
curl --fail http://127.0.0.1:18000/readyz
```

返回应包含`storage: mysql`。通过内部鉴权API或迁移工具的输出核对账号/成员数、状态、租约及到期时间、统计保留结果。不要把token打印到日志。发现数据缺失先检查数据库/卷/版本，不新建账号来补齐。

## 七、应用升级与 Service 切换

1. 保持业务入口关闭、补池暂停。**保留原Proxy Service对象的名称、ClusterIP和端口**，将selector改为新Deployment的标签`app.kubernetes.io/name: ghcp-pool-proxy`；targetPort应与新Pod的`http`端口（3000）一致。不要删除重建原Service。
2. 在原SSO、Login、Console部署上更新镜像，并把三者的`PROXY_BASE_URL`统一改为原Proxy Service根地址。其余Secret、SAML配置、原PVC和证书不变。模板中的`ghcp-pool-companion-routing` ConfigMap可供引用，也可以通过原发布配置设置。
3. SSO/Login/Console各恢复 **1 个实例**；先停止旧实例再启动新实例，不让滚动更新同时产生两个写同一SQLite卷的副本。先后检查服务健康、SSO页面、Login配置、Console管理员登录及池数据。Login重启会处理未完成任务，所以停机前必须先排空。

```bash
kubectl -n <namespace> set image deployment/<sso-deployment> <sso-container>=<新SSO镜像引用>
```

```bash
kubectl -n <namespace> set image deployment/<login-deployment> <login-container>=<新Login镜像引用>
```

```bash
kubectl -n <namespace> set image deployment/<console-deployment> <console-container>=<新Console镜像引用>
```

确认三个部署已使用新的`PROXY_BASE_URL`、保留原卷/Secret后，按SSO、Login、Console顺序各恢复为1副本：

```bash
kubectl -n <namespace> scale deployment <sso-deployment> --replicas=1
```

```bash
kubectl -n <namespace> scale deployment <login-deployment> --replicas=1
```

```bash
kubectl -n <namespace> scale deployment <console-deployment> --replicas=1
```

每个应用就绪后再恢复下一个。**看到Console初始化页面或空用户列表时，优先检查错挂空卷，不要重新创建管理员。**

4. 确认Service EndpointSlice只指向新MySQL Proxy，旧SQLite Proxy保持停止。通过Console或一个已批准的virtual key做小额请求，检查身份、错误码和统计归属；失败不自动重放。
5. 单副本正常后扩为计划副本数，初始可用3个：

```bash
kubectl -n <namespace> scale deployment/ghcp-pool-proxy --replicas=3
```

```bash
kubectl -n <namespace> rollout status deployment/ghcp-pool-proxy
```

核对三个Pod就绪、Service后端数量及跨节点分布。所有Proxy共享同一MySQL及同一组池配置；正常standby不是故障，不按本机owner状态摘除流量。

### LiteLLM需要核对的配置

- 模型配置的`api_base`指向同一个Proxy Service根地址；保留正确的provider和模型组。
- `GHCP_POOL_API_BASES`同步为相同受信任地址，`GHCP_PROXY_API_KEY`与Proxy的API_KEY一致；保留`user_pool_hook`。
- caller继续使用认证后的virtual-key hash，不改成用户名/邮箱。原已使用的key无需因迁移重新生成。
- 如Service地址未变，通常不需要改LiteLLM地址；仍需验证实际路由。关闭响应缓存，明确重试/fallback策略，不重放不明结果或通过换账号规避429。

## 八、恢复业务与验收

先恢复少量业务请求，确认以下项目后再正常放量：

- [ ] 原账号/成员、SSO用户、OAuth状态、租约期限和历史数据符合预期。
- [ ] SSO、Login、Console各1实例，原卷和证书正确，回调指向Proxy Service。
- [ ] 计划中的Proxy副本全部ready，Service后端正确，旧SQLite写入端保持停止。
- [ ] 同一virtual key保持一个排他成员，不同key不共享同一活跃成员；完整成功请求能续租。
- [ ] 错误/取消不续租，hold能排空，统计关联正确。
- [ ] MySQL连接数、延迟、错误率及池库存告警可观察。

最后在User pool页面恢复原Ready idle target，按实际库存和已批准的席位预算设置Maximum accounts，再取消 **Pause prewarming**。恢复补池可能创建新成员或修复失效凭据，应明确授权后执行。迁移验收本身不要求额外创建两个新账号。

账号上限为10,000；Lease TTL范围60～2,592,000秒（最多30天）。这些是配置范围，不是该集群已经具备的容量承诺。

**探针和停机：** readiness使用`/readyz`检查存储，liveness使用`/healthz`检查进程。不要因数据库短故障同时重启全部Proxy。现有进程收到SIGTERM后约25秒会强制关闭剩余连接；长流在Pod退出时可能中断，滚动升级前应停止新流量并尽量排空，不能只调大K8s grace period就认为无中断。

## 九、失败处理与回退

| 所处阶段 | 处理方式 |
| --- | --- |
| 预检/导入失败，目标应用尚未启动 | 保持旧环境和备份不变，检查明确错误；目标非空或提交结果不明时不盲重试 |
| 导入完成，但目标没有任何后续运行写入 | 在维护窗口中停止并弃用目标，核对后才可按原配置恢复SQLite |
| 已启动MySQL Proxy或已恢复业务/补池 | 启动时owner、回收、统计裁剪等也属于写入；**不能直接切回旧SQLite快照**，先停流量并保留两边数据，制定一致性恢复方案 |

不让SQLite和MySQL两边同时承接业务，不执行`down -v`、全局volume prune或清表来回退。新增外部账号/席位不会被数据库恢复自动撤销，须单独核对。

升级结束后保存本次源码SHA、四组件镜像引用、部署YAML、备份校验值和验收结果。旧环境备份按数据保留策略保管，不立即删除。
