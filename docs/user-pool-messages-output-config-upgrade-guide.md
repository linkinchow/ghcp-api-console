# GHCP Proxy 升级指南：Claude Opus 5.5 Messages 协议兼容修复

## 1. 本次升级解决什么

部分客户端使用消息级 `output_config` 调整 effort 时，通过 LiteLLM → GHCP Proxy 可能收到：

```text
messages.1.output_config: Extra inputs are not permitted
```

本次修复保留消息级配置、消息结构和对应的 Anthropic beta 请求头，避免旧兼容适配把新字段与协议声明拆开；同时修复非优化 Messages 的协议头转发，以及 effort 控制消息后的工具续接归属判断。

**目标源码：**

```text
仓库：https://github.com/linkinchow/ghcp-api-console
分支：main
固定提交：5046bca934c6e2b6de66510ff3133d68f34eba58
```

对应 [linkinchow/ghcp-api-console#1](https://github.com/linkinchow/ghcp-api-console/pull/1)。不要只凭随时间变化的 `main` 或 `latest` 识别本次版本。

## 2. 范围与适用条件

| 项目 | 本次操作 |
| --- | --- |
| GHCP Proxy | 更新镜像 |
| SSO / Login / Console | 不更新镜像，不改原数据 |
| LiteLLM | 不要求升级；保留现有路由、身份 hook 和 key 权限 |
| SQLite / MySQL schema | 本补丁没有数据库结构变更 |
| 账号、租约、token、席位 | 保留，不批量删除或重建 |
| slug / SSO / 证书 | 不变，不启用多企业功能 |
| 服务密钥、internal token、数据库Secret | 不变，不复制到镜像 |

**必须先核对实际运行版本与存储类型：**

- 本指南基于单 slug `main` 的SQLite／MySQL应用。相对于基线 `8ad76d547c9d067aac79f99391859cc67dcd7b44`，修复没有更改存储schema、依赖锁文件或Dockerfile。
- 如果现版本更旧、带客户定制或未知schema，先在隔离副本核对差异；不能据此跳过它原本需要的升级步骤。
- **若当前运行的是旧AKS PostgreSQL版，不要直接换成本指南镜像。** 那是不同存储实现，需在对应分支移植修复并提供匹配镜像。
- 本补丁不包含multi-slug、企业registry、Models页或WebSocket支持，不需要进行多企业迁移。

## 3. 为什么不是“加一个beta就一定解决”

该字段必须与上游支持的协议能力配套。修复保证GHCP不再破坏传入的消息级配置及beta，并保留上游错误，**不保证所有Copilot账户、模型、接口都支持该beta**。

已经完成隔离测试：协议／HTTP／SSE／调用归属专项33/33；Proxy全量510通过、28项实库门禁跳过、0失败；Console6/6；构建与类型检查通过。本次没有真实Claude调用，也没有替客户完成生产验收。

如果修复后仍报同类错误，需要核对客户端 → LiteLLM → GHCP → Copilot每一段的脱敏协议结构及beta，而不是删除整条system消息或擅自重新启用模型。

## 4. 升级前准备

安排短维护窗口，准备以下记录：

- 当前Proxy镜像tag和**实际digest**、运行源码版本（若有）。
- 当前副本数、服务名称／端口／入口、启动命令、环境变量与Secret引用、存储driver和卷挂载。
- 当前SSO/Login/Console镜像与数据路径，确认本次保持不动。
- 数据库一致备份和可恢复性验证；对MySQL另按DBA制度保留备份，对SQLite使用已验证的backup流程或停写后的文件备份。若停写备份目录包含WAL/SHM，一致保存整个目录，不只复制主文件、不手工删除边车；如需独立单文件恢复，使用SQLite支持的backup/checkpoint流程另行验证。
- 可立即取用的**旧Proxy镜像digest**及原工作负载配置，不能只记录可能被覆盖的tag。
- 保持现有 `CLAUDE_CODE_OPTIMIZED` 和客户端header值；本补丁不要求强制切换优化模式。示例env不是客户的实际配置，不整份覆盖。
- 客户端与LiteLLM版本、失败请求ID、有效 `X-Claude-Code-Optimized` 设置。业务文本、token和完整Secret不放普通工单或聊天。

备份资料可含敏感配置，只存放于客户受控目录。不要把完整 `.env`、kubeconfig、SQL dump或 `kubectl get secret` 输出发给供应方。

### 维护边界

1. 在可信网关/运维入口暂停新增模型请求，等待已有推理和流式响应结束。
2. 暂停新的账号供给或授权操作，核对现有Login／回调是否已结束；按客户既有维护流程处理未完成任务，避免停Proxy时产生授权结果未知。已持久化的池settings不一定被env覆盖，不能把设置 `READY_IDLE_TARGET=0` 或重启当作已暂停。
3. 记录原副本数和工作负载状态，防止HPA/GitOps在维护期间自动改回。
4. 停止本次要替换的Proxy writer，再取得需要停写的备份，执行镜像替换。

**不需要释放所有租约或等待租约TTL到期，不执行schema init／SQL迁移。** 建议本次采用有界停写替换；只有客户原流程已验证同schema滚动升级及在途请求drain，才按该流程滚动。不能因有两个Proxy就承诺零中断。

## 5. 获取镜像

### 路径A：使用供应方已发布镜像（推荐的交付方式）

**截至本指南编写时，本次镜像尚未发布到Docker Hub。下面是待发布后填写的格式，不能当成现有可拉取地址。**

供应方应提供：registry/repository、不可变版本tag、digest、目标架构、源commit、验证结果和回滚限制。客户使用自己的私有镜像仓库/镜像镜像同步规则亦可。

```text
<registry>/<namespace>/ghcp-proxy:<approved-release-tag>
<registry>/<namespace>/ghcp-proxy@sha256:<approved-digest>
```

Kubernetes推荐按digest部署；镜像必须与客户存储实现匹配。不要把真实认证信息写进镜像URL。

### 路径B：从本次固定源码构建（当前可用）

在新的干净目录获取源码，不使用含客户配置或原生产数据的工作目录做build context：

```bash
git clone --branch main --single-branch https://github.com/linkinchow/ghcp-api-console.git ghcp-proxy-upgrade-5046bca
```

```bash
cd ghcp-proxy-upgrade-5046bca
```

```bash
git checkout --detach 5046bca934c6e2b6de66510ff3133d68f34eba58
```

```bash
git status --short
```

最后一条应无输出；不把真实 `.env`、数据、密钥、客户Excel或历史日志复制到此目录。Dockerfile读取根目录workspace和 `src`，因此build context必须是这个仓库根，而不是 `src/proxy`。

下面以Linux amd64为例；平台不同不能照抄，需使用经验证的对应架构：

```bash
docker build --platform linux/amd64 --build-arg NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ --label org.opencontainers.image.revision=5046bca934c6e2b6de66510ff3133d68f34eba58 --label org.opencontainers.image.source=https://github.com/linkinchow/ghcp-api-console -f src/proxy/Dockerfile -t ghcp-proxy:main-5046bca .
```

如客户不使用该公司npm feed，按其批准的包源替换；不得绕过包版本发布管控。构建只生成镜像，不启动服务，不连接生产数据库，也不需要真实GitHub凭据。

记录本地产物：

```bash
docker image inspect ghcp-proxy:main-5046bca --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

本地Image ID不是registry digest。推入客户批准的仓库后，按实际registry返回值记录RepoDigest；基础镜像tag可能更新，所以同一个源commit重复build不保证相同digest。

没有registry时可离线交付镜像包和校验值：

```bash
docker save ghcp-proxy:main-5046bca -o ghcp-proxy-main-5046bca-linux-amd64.tar
```

```bash
sha256sum ghcp-proxy-main-5046bca-linux-amd64.tar
```

目标主机核对同一SHA256后加载：

```bash
docker load -i ghcp-proxy-main-5046bca-linux-amd64.tar
```

本地tar校验值也不是registry digest，交付记录中要分开。

## 6. Kubernetes / Rancher：只更新原Proxy

使用客户已有发布系统或GitOps时，**在该系统修改原Proxy image字段**，不另建一套Deployment，不更改Service/selector/Secret/卷/副本数，也不手工命令与控制器互相覆盖。

以下为无GitOps控制器冲突时的kubectl字段示例。所有尖括号必须替换；命令使用显式context：

```bash
kubectl --context <context> -n <namespace> get deployment <proxy-deployment> -o yaml > proxy-deployment.before.yaml
```

该文件可能含敏感配置，只存客户受控备份目录，不作为原样apply输入（包含status/resourceVersion等）。

```bash
kubectl --context <context> -n <namespace> get pods -l <proxy-selector> -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.name}{"\t"}{.imageID}{"\n"}{end}{end}'
```

维护暂停并等待在途请求结束后，采用停写替换：

```bash
kubectl --context <context> -n <namespace> scale deployment/<proxy-deployment> --replicas=0
```

```bash
kubectl --context <context> -n <namespace> wait --for=delete pod -l <proxy-selector> --timeout=120s
```

确认数据库备份完成后替换镜像：

```bash
kubectl --context <context> -n <namespace> set image deployment/<proxy-deployment> <proxy-container>=<approved-image-reference>
```

```bash
kubectl --context <context> -n <namespace> scale deployment/<proxy-deployment> --replicas=<original-replica-count>
```

```bash
kubectl --context <context> -n <namespace> rollout status deployment/<proxy-deployment> --timeout=300s
```

```bash
kubectl --context <context> -n <namespace> get pods -l <proxy-selector> -o wide
```

确认原副本数、Ready和实际imageID。**SQLite Proxy仍单实例；MySQL多Proxy仍指向同一writer DB。** 不因为本补丁扩大副本或修改存储类型。

不要随便延长数据库连接timeout、打开diagnostic原始捕获或修改模型权限来让readiness变绿。根据实际错误先查配置、网络和数据库状态。

## 7. Docker Compose：保留卷与现有组合

保留原Compose项目名称、工作目录和compose文件组合。若有pool/MySQL overlay，继续使用原组合，不改变driver或服务名称。

将**Proxy服务的image引用**改成批准的新镜像，其他build/env/volume不变。如果仍保留build项，部署时指定 `--no-build`，避免客户机器重新构建出不同产物。

以下 `<原compose参数>` 包括原项目名、所有 `-f` 文件及受控env-file，不包含真实密钥明文：

```bash
docker compose <原compose参数> stop -t 45 proxy
```

取一致备份后执行：

```bash
docker compose <原compose参数> up -d --no-build --no-deps proxy
```

```bash
docker compose <原compose参数> ps proxy
```

```bash
docker compose <原compose参数> logs --since 10m --tail 200 proxy
```

不要执行 `down -v`，不要删除重建named volume；不要全栈 `up --build`；不要同时套SQLite和MySQL两种pool overlay。生产日志先在客户环境脱敏再对外提供。

## 8. 验证后再恢复流量

### 无真实模型调用的检查

- `/healthz` 和 `/readyz` 正常，且ready对应真实存储可用；health不等于DB健康。
- 所有原Proxy副本使用批准的新digest；SSO/Login/Console镜像、服务地址和Secret引用保持原值。
- Console中原账号、租约和状态可查询，无批量变为missing/refreshing；不点击重新授权或导入token。
- 无schema不兼容、数据库连接、证书、401/403或实例占用异常日志。
- 确认客户端和LiteLLM仍把原 `anthropic-beta` 传到GHCP；只核对header和脱敏结构，不输出Authorization。

这些只能证明部署/存储正常，不证明真实模型已接受新beta。

### 需要客户授权的最小真实验收

只有对应Claude模型与账号已获授权时，才执行短合成文本。若模型disabled，不重新enabled、不换其他用户规避，记录“真实模型验收未完成”。

建议至少验证：普通单轮、多轮、工具结果自动续接、带消息级effort和对应beta、流式完整到终态。使用原LiteLLM key和身份hook，不手工伪造caller或改模型路由；没有必要执行负载压测。

如仍报同类400，留存：时间、客户端/网关/Proxy版本、原request_id、effective优化模式、请求Messages中各对象role/content类型/output_config、两段beta头。业务文本替换为占位，凭据删掉。不要仅凭“服务Ready”宣布修复验收完成。

恢复网关新请求及原供给维护状态后，观察短时错误率、授权任务和库存，记录成功/失败/未验证项。

## 9. 回滚

本补丁相对已核对基线没有DB变更，通常应**回滚Proxy镜像，不恢复旧DB备份**，避免丢掉升级后正常写入的统计或租约状态。

- 暂停新增流量，等待活动请求/授权结果按原维护流程结束。
- 按相同停写流程将原Proxy镜像恢复为升级前记录的digest，恢复原副本数。
- 检查ready、原账号/租约、Secret引用，恢复原流量。
- 如发现数据损坏，交DBA按既有恢复方案处理；不要同时在运行writer下恢复数据库，也不自动回放模型请求或GitHub外部操作。

回滚镜像会恢复旧协议行为，原消息级effort错误可能再次出现。需要临时停用这项客户端新能力时，明确确认设置和有效请求，不删除业务指令或输出配置来伪造成功。

## 10. 镜像交付状态

本指南已提供当前可执行的固定源码构建与升级路径。**Docker Hub镜像尚未发布**，不要猜测仓库名或tag。供应方完成发布后，应更新本节提供实际digest/架构/源commit，客户再采用路径A。

升级只更新Proxy，原数据库和其他组件保留；生产是否支持消息级beta仍以实际授权小样本验收为准。
