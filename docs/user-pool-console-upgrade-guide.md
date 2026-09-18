# 单独升级 Console：完整 key hash 复制功能

适用：已有 GHCP Console，部署在 Kubernetes 中，需要获得 User pool 页的完整 hash 复制功能。

**目标源码提交：`f65cea609138d1a18d24f5529755f195780dc131`。只构建、更新 Console 镜像。**

本手册是操作指南，不代表已经操作客户环境。命令中的名称、路径和镜像仓库须先替换成实际值。有 Helm/GitOps/平台发布流程的，优先通过原流程执行同样的变更，避免控制器覆盖手工操作。

## 一、本次升级改什么、不改什么

新增的 User pool 页面行为：

- Accounts、Leases、Recent events 及释放租约确认框中，hash 旁显示一个无边框复制图标。
- 悬停/键盘聚焦提示 `Copy hash`；点击成功提示 `Copied`，约2秒后消失，不增加表格行高。
- 按钮复制完整 **64位小写hash，不带 `sha256:`**，便于到 LiteLLM 排查对应 key。
- 页面文字仍保留完整 caller ID；视觉截断不再把省略号写入实际内容。
- 浏览器拒绝剪贴板或不支持Clipboard API时，展示完整hash供手动复制，不误报成功。

| 组件/数据 | 本次是否变更 |
| --- | --- |
| Console 镜像 | **更新** |
| Console 管理员文件/原持久卷 | **保留原数据和挂载** |
| Console Secret、后端地址、Service/Ingress | **保持原值** |
| Proxy 镜像及600秒超时配置 | 不改 |
| SSO、Login | 不改，不停机 |
| MySQL、账号池指纹、成员、租约 | 不改，不迁移 |
| LiteLLM配置、Canary Hook | 不改 |

同一源码提交包含之前的其他功能，**不意味着需要一起部署其他镜像**。本次只把新Console镜像提供给原Console工作负载。

预期影响：Console 单实例替换期间，管理页面会短暂不可用；正常的 `LiteLLM → Proxy` 模型请求不经过Console，因此不应因本次更新中断。前提是客户没有把业务流量错误地经由Console转发。

## 二、升级前核对

由具备对应权限的运维人员填写：

| 项目 | 实际值/要求 |
| --- | --- |
| Kubernetes context | 明确是本次客户集群 |
| Namespace | Console实际所在namespace |
| Deployment名称 | 原Console Deployment，不是Proxy Deployment |
| 容器名称 | Deployment中运行Console的容器名 |
| 当前镜像及运行中的imageID | 保存旧镜像完整引用和digest，以便回退 |
| 副本数 | 维持原Console单实例；不要新增多写者 |
| 发布控制器 | 是否由Helm、GitOps、平台应用或HPA管理 |
| `ADMINS_FILE` | 原管理员JSON实际绝对路径、所属卷及挂载位置 |
| Secret/ConfigMap引用 | 保留原名称、key及有效值 |
| Console Service/Ingress | 保留名称、selector、端口、域名和TLS配置 |
| 备份位置 | 客户长期保管的受保护发布目录，不能只留 `/tmp` |
| 镜像拉取 | 集群能访问新镜像仓库；原imagePullSecrets有效 |

### 2.1 所需权限

至少需要查看Console Deployment/Pod/Service、读取Pod日志、执行备份或使用现有卷备份机制，以及更新该Deployment。ConfigMap/Secret的引用和有效配置应由有权限人员核对；**不需要在聊天中贴出完整Secret或kubeconfig**。

不要为本次Console升级申请或执行MySQL写入、GitHub用户/席位管理权限。遇到Forbidden交给有权限运维，不绕过权限边界。

### 2.2 确认管理员数据真实持久化

Console管理员不在MySQL中，而在 `ADMINS_FILE` 指定的JSON文件中，包含用户名、密码hash、salt、启用状态和角色。

- 代码默认是 `./data/admins.json`，相对于Console进程工作目录；现有容器部署通常显式配置 `/data/admins.json`，**不能直接假定客户也是这个路径**。
- 需要挂载原PVC/持久存储，并保证运行身份可读写该文件。
- **如果文件仅在容器层或 `emptyDir` 中，先停止升级。** 必须先设计并验证管理员文件的持久化迁移，确认新Pod会挂到原数据，再重建Pod。
- 看到旧Pod里有 `admins.json`，不代表重建后一定还在；必须同时看volumeMount和volume来源。
- 保留原 `SESSION_SECRET`；不要趁本次升级更换管理员密码、内部密钥或会话密钥。

下面是核对路径的只读示例，仅输出路径/工作目录，不输出文件内容或密钥：

```bash
kubectl -n <namespace> exec <当前Console-Pod> -c <console-container> -- node -e 'console.log(JSON.stringify({cwd:process.cwd(),adminsFile:process.env.ADMINS_FILE??"./data/admins.json"}))'
```

同时查看该Deployment的挂载配置。容器命令及工作目录应保持与原来一致；仓库默认启动命令通过workspace进入Console目录，不能随意改成在 `/app` 根目录直接启动，否则可能找不到静态页面或使用错误的相对数据路径。

## 三、备份旧配置与管理员文件

### 3.1 保存到受保护的长期目录

以下示例使用Bash。目录建在发布管理机的用户目录下，不在源码仓库、镜像构建上下文或临时目录中：

```bash
umask 077
```

```bash
export BACKUP_DIR="$HOME/ghcp-release-backups/console-$(date +%Y%m%d-%H%M%S)"
```

```bash
mkdir -p "$BACKUP_DIR"
```

```bash
chmod 700 "$BACKUP_DIR"
```

保存原部署和服务配置：

```bash
kubectl -n <namespace> get deployment <console-deployment> -o yaml > "$BACKUP_DIR/console-deployment.before.yaml"
```

```bash
kubectl -n <namespace> get service <console-service> -o yaml > "$BACKUP_DIR/console-service.before.yaml"
```

如有Console Ingress，通过同样方式保存。配置文件可能含内联敏感环境变量，应按敏感发布资料管理，不自动提交公共仓库。原始导出保留作核对证据，不把带status/resourceVersion的完整对象不加审查地重新apply。

记录运行镜像的真实ID：

```bash
kubectl -n <namespace> get pod <当前Console-Pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{"\t"}{.image}{"\t"}{.imageID}{"\n"}{end}' > "$BACKUP_DIR/console-images.before.txt"
```

### 3.2 备份 `admins.json`

通知管理人员暂时不要创建管理员、修改密码或执行Console管理操作；等待正在进行的管理操作结束。**这不是暂停账号池预热，也不是停止模型流量。**

优先使用客户现有持久卷备份方式。如果使用以下文件导出方法，先把路径换为已核对的实际绝对路径。命令不使用TTY，文件写入管理机私有目录，不打印到聊天：

```bash
kubectl -n <namespace> exec <当前Console-Pod> -c <console-container> -- node -e 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))' /data/admins.json > "$BACKUP_DIR/admins.json"
```

该命令必须返回退出码0。即使失败，shell也可能已创建空文件，**不能只看文件存在就认定备份成功**。在管理机验证JSON结构及计算摘要，不输出账号内容：

```bash
python3 -c 'import pathlib,json,hashlib,sys;p=pathlib.Path(sys.argv[1]);b=p.read_bytes();v=json.loads(b);assert isinstance(v,list) and any(isinstance(x,dict) and x.get("enabled") is True and isinstance(x.get("username"),str) and isinstance(x.get("password_hash"),str) and isinstance(x.get("salt"),str) for x in v);print("admins backup valid; sha256="+hashlib.sha256(b).hexdigest())' "$BACKUP_DIR/admins.json"
```

文件包含密码hash，也需要保密。校验成功后，备份和原持久卷都保留；**本次正常升级不应导入/覆盖这份文件**，新Pod直接使用原卷。

## 四、构建并分发新版 Console 镜像

在独立源码目录构建，不覆盖现网发布目录，也不在包含真实 `.env`、备份和凭据的目录构建。

如果尚无这个发布目录，可以取得源码：

```bash
git clone --branch ghcp-user-pool-ops-handoff https://github.com/linkinchow/ghcp-api-console.git ghcp-console-copy-release
```

进入新目录：

```bash
cd ghcp-console-copy-release
```

固定源码，而不是一直跟随分支最新版本：

```bash
git checkout --detach f65cea609138d1a18d24f5529755f195780dc131
```

```bash
git rev-parse HEAD
```

输出必须为上述完整SHA。确认工作区无其他改动：

```bash
git status --short
```

### 4.1 设置组织批准的包源和镜像名称

`NPM_REGISTRY` 使用客户构建环境批准的包源。本项目当前受管环境使用以下包源；客户需确认能够访问及已获批准，不绕过包发布限制：

```bash
export NPM_REGISTRY="https://packagefeedproxy.microsoft.io/npm/"
```

镜像地址只是格式示例，替换为客户自己的仓库和项目路径：

```bash
export CONSOLE_IMAGE="registry.example.com/ghcp/ghcp-console:copy-hash-f65cea6"
```

### 4.2 只构建 Console

在仓库根目录执行，末尾 `.` 不可省略。下面针对Linux x86_64节点；ARM节点需选匹配平台并单独验证，不能直接照搬：

```bash
docker build --platform linux/amd64 --build-arg NPM_REGISTRY="$NPM_REGISTRY" -f src/console/Dockerfile -t "$CONSOLE_IMAGE" .
```

Dockerfile已经包含依赖安装、共享包构建、Console后端和网页构建，不需要在宿主机先运行应用构建。需要访问基础镜像和包源；不能把凭据作为普通build arg或文件打进镜像。

构建不会启动服务或连接客户数据库。只构建Console即可，**不要执行四组件全量重建/发布**。源码固定不意味着基础镜像标签和网络下载完全不可变，因此还需记录实际产物digest。

### 4.3 发布到客户镜像仓库

按客户仓库流程登录，避免把密码直接写进命令或记录：

```bash
docker login registry.example.com
```

```bash
docker push "$CONSOLE_IMAGE"
```

保存push结果中的仓库digest，部署时优先使用：

```text
registry.example.com/ghcp/ghcp-console@sha256:<实际仓库digest>
```

不要把Docker本地image ID误当作仓库manifest digest，也不要覆盖旧标签。离线平台按原有导入流程分发镜像，确保节点实际能取到新产物。

## 五、执行单实例升级

### 5.1 原则

- 本次只有Console管理页面短暂维护，不停Proxy/SSO/Login，不暂停模型请求。
- 保持Console原Service/Ingress、selector、端口、路径、Secret及数据卷，不另加NGINX或新Service。
- Console使用管理员JSON存储，**不为了减少几秒管理页面中断而让两个不同Console进程同时写同一份文件**。
- 如果有HPA/平台控制器，先按原管理流程固定单实例并防止停机阶段自动拉起；记录升级后需要恢复的管理状态。
- 原Deployment若有其他sidecar或自定义探针/安全上下文，一并保留，不能直接用空白示例覆盖。

### 5.2 推荐：停止旧Console，再启动新Console

该顺序避免默认RollingUpdate临时创建第二个Console。若客户平台已有经过验证的Recreate单实例发布流程，直接通过平台执行等效步骤；不要同时混用手工kubectl和GitOps。

**1. 停止Console：**

```bash
kubectl -n <namespace> scale deployment/<console-deployment> --replicas=0
```

等待原Pod确实删除/退出：

```bash
kubectl -n <namespace> wait --for=delete pod/<已记录的旧Console-Pod> --timeout=120s
```

再次确认该Deployment没有其他存活Pod（包括terminating状态）。检查的是Console自身，不是整个namespace。未退出时先排查，不强制删除数据卷或跳过安全步骤。

**2. 仅更新Console容器镜像：**

```bash
kubectl -n <namespace> set image deployment/<console-deployment> <console-container>=<新Console镜像完整引用或digest>
```

此时副本仍为0。核对Deployment变更仅为预期镜像/副本字段，数据挂载和所有配置保持原样。

**3. 恢复1个实例：**

```bash
kubectl -n <namespace> scale deployment/<console-deployment> --replicas=1
```

```bash
kubectl -n <namespace> rollout status deployment/<console-deployment> --timeout=180s
```

如果超时，查看新Pod事件、日志、镜像拉取和挂载权限，不继续重启循环。`rollout status`通过也不替代下面的登录和功能检查。

## 六、升级后验证

### 6.1 Pod、镜像及健康状态

- 仅1个Console实例，Pod Ready，无反复重启/OOMKilled。
- 核对新Pod `imageID` 对应本次发布产物。
- 没有 `EACCES`、管理员文件JSON解析失败、静态资源找不到等错误。
- `/healthz` 返回 `{"status":"ok","service":"console"}`。这是进程健康，不证明所有后端已可用。

可以通过原管理入口检查健康。若使用临时port-forward：

```bash
kubectl -n <namespace> port-forward deployment/<console-deployment> 18004:7004
```

若实际Console端口不是7004，用实际值。另一个终端执行：

```bash
curl --fail http://127.0.0.1:18004/healthz
```

管理员初始化状态应仍为true：

```bash
curl --fail http://127.0.0.1:18004/api/console/setup
```

**如果 `initialized:false` 或打开页面出现“创建管理员”初始化界面，立即停止验证，不新建管理员。** 先检查ADMINS_FILE、原PVC、挂载路径、文件权限和运行工作目录；新建管理员可能覆盖错误路径上的文件，并掩盖原数据未挂载的问题。

### 6.2 原账号登录和后端数据

- 用原Console管理员登录，原管理员和权限仍有效；不要为了测试重置密码。
- 打开User pool、Request Stats等页面，确认连接原Proxy服务，原成员/租约数据符合正在运行的业务状态。
- 页面数据会随正常业务变化，不要求静态计数完全不变；不能据一次自动刷新就认定新增了账号。
- 不点击Reconcile、Release、Disable、Retry、SSO删除/同步等写操作来证明本次UI升级成功。
- 若登录失效但文件和SESSION_SECRET确认无变化，可以重新登录；不承诺所有浏览器会话必定跨发布保留。

### 6.3 复制功能验收

1. 使用原HTTPS Console地址打开页面并刷新；仍是旧资源时强制刷新，例如Windows/Linux `Ctrl+Shift+R`、macOS `Cmd+Shift+R`。先确认实际新镜像已运行，不把所有问题都归因于浏览器缓存。
2. Accounts页选择一个已有租约的成员：hash旁应出现复制图标，而不是下划线文字按钮。
3. 悬停提示 `Copy hash`；点击后显示 `Copied`，约2秒后消失，不长期占一行。
4. 粘贴到受保护的本地文本编辑器，确认恰好64位小写十六进制字符，**不带 `sha256:`，没有 `…`/`...`**；不要粘贴到公共聊天或工单。
5. Leases页执行同样检查。Recent events和释放确认框使用同一组件；**不必为了验收而真正释放租约**。
6. 浏览器不允许自动复制时，应出现完整hash手动复制字段，不是假显示Copied。可在正常浏览器HTTPS页面取得焦点后再试；不要关闭浏览器安全策略。内嵌预览或HTTP非localhost页面可能受剪贴板限制。
7. 复制的是定位用hash，不是原始virtual key，不能用它代替API认证凭据。

### 6.4 业务链路检查

使用已有监控确认Proxy原副本健康和业务成功率没有异常；本次无需额外创建账号、购买席位或发真实模型长请求。只有Console短暂不可用不应被误判为模型服务停机。

## 七、失败处理与回退

| 现象 | 优先检查 |
| --- | --- |
| ImagePullBackOff | 镜像名称/digest、仓库权限、imagePullSecrets、CPU架构 |
| Console未Ready或反复重启 | 日志、PORT/探针、命令工作目录、内存、数据卷权限 |
| 出现初始化页面 | 原管理员文件是否挂载、路径/工作目录是否变化；**不要重新创建管理员** |
| 管理员登录正常，但后端页面401/502 | INTERNAL_API_TOKEN和原Proxy/SSO/Login地址引用；不要修改池指纹 |
| 新镜像运行但图标未出现 | 浏览器/CDN旧静态资源、实际访问是否仍落在旧Console；核对部署和入口 |
| 复制提示不可用 | HTTPS/页面焦点/浏览器权限，使用手动复制字段；不是hash被截断丢失 |

### 7.1 回退步骤

本次不迁移管理员文件格式或数据库，正常回退只恢复旧Console镜像。

1. 暂停新的Console管理操作，记录失败信息。
2. 将Console缩到0并确认新Pod退出。
3. 把Console容器镜像设回记录的旧镜像完整引用/digest。
4. 原配置、Secret、持久卷不变，恢复1个实例，等待Ready。
5. 原管理员登录、后端页面可用；复制图标会恢复为旧版行为，这是预期。

回退镜像命令示例（仅在该Deployment已缩为0之后执行）：

```bash
kubectl -n <namespace> set image deployment/<console-deployment> <console-container>=<保存的旧Console镜像引用或digest>
```

**不要直接用整套应用的回滚命令把Proxy一并退回旧版本。** 也不要执行 `down -v`、删除PVC、清空admins.json、恢复旧MySQL快照或改动账号池指纹。

### 7.2 何时需要恢复管理员备份？

只有确认原管理员文件被丢失/破坏，并经运维核对后才需要。恢复前停止所有Console写入者，确认目标卷及路径，保留损坏文件证据，恢复正确权限再启动。不要自动用备份覆盖仍有效的文件，否则可能回退升级后合法的密码变更或权限调整。

## 八、发布记录与结束条件

保存到长期受保护目录：

- 源码完整SHA `f65cea609138d1a18d24f5529755f195780dc131`。
- 新旧Console仓库镜像digest、部署名称、namespace和发布时间。
- 原Deployment/Service配置、原持久卷/管理员文件路径，以及管理员备份校验值。
- 健康、登录、hash复制、后端页面检查结果。
- 回退步骤和旧镜像可拉取性。

实际Token、kubeconfig、Session密钥和admins.json内容不要放进公共仓库或普通聊天。使用临时授权文件时按客户安全流程清理，但不要误删已经迁入长期目录的回退材料。

满足以下条件后结束升级：**新Console单实例Ready、原管理员可登录、后端服务地址未变、复制得到完整hash且提示按时消失、Proxy业务无异常、旧镜像和回退材料保留。**

## 九、已验证证据及范围

本次UI修复的Console生产构建、类型检查通过；6项单元测试、8项真实浏览器回归通过，覆盖完整复制、键盘操作、提示自动消失、失败手动复制及移动端布局。发布前8项浏览器测试再次通过。

这些结果不是客户K8s挂载、镜像仓库、RBAC或实际HTTPS剪贴板权限的替代验收；按本手册核对客户环境。

- [hash复制修复测试报告](user-pool-hash-copy-validation.md)
- [User pool页面操作说明](user-pool-console-guide.md)
- [本次源码提交](https://github.com/linkinchow/ghcp-api-console/commit/f65cea609138d1a18d24f5529755f195780dc131)
