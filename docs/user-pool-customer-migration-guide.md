# 客户迁移手册：单 Proxy＋SQLite → 多 Proxy＋MySQL

**状态：客户升级操作手册；源码发布与客户现场验收门禁见下文。** 更新日期：2026-09-16。本文是数据库、四服务应用及客户已有 Rancher Service 入口的完整操作交付，不只是待办计划。按步骤执行并逐项核验；命令中的客户私有值须填写和审批，文档交付不等于已在客户生产执行。本次提交包含新增工具与手册；客户必须固定交付记录中的完整提交SHA，不追随移动分支，并完成第0–4步版本/备份门禁。

**目标拓扑**：客户同一 Rancher/Kubernetes 集群内，`LiteLLM → 已有内部 Service DNS → 3 或 5 个 Proxy Pod → 同一个 MySQL 写主库/数据库`；SSO、Login、Console 各保留 **1 个实例及原持久卷、证书和配置**。优先复用已有 Service，**不新增 NGINX、HAProxy、Ingress 或监控平台**。已有 DNS 截图不能证明 Service 的实际 `type`、后端数量、跨节点放置或 HA；这些必须按第 2 步只读核对。

本流程是**离线迁移，有维护窗口，不是零停机或双写方案**。账号迁移本身不创建 GitHub/SSO 用户、不调用 SCIM、不增减席位、不启动 Login、不调用模型。第 13 步分别记录迁移之后**已完成的本地两账号 canary/四 key 请求**和客户日后单独授权的验收；它们不是数据库迁移的隐含动作，也不能代替客户现场验收。

## 0. 先认清版本、容量与已有证据

### 0.1 固定源码，不把未提交文件当作已发布版本

- 已验证基线完整 SHA：`5ea75af7ac0000b37758efd751a606ea86010a00`；对应生产代码基线 v5：`356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`。
- **本次 `ghcp-user-pool-ops-handoff` 提交收录** `legacy-copy.ts`、`reconfigure-concurrency.ts`、客户构建/部署包、运维适配器、测试及本文。交付时记录本次提交的完整40位SHA，作为后续命令的 `SOURCE_SHA`；本次只做本地提交，不代表已经推送或可由客户远端拉取。不能声称仅 checkout `5ea75af` 就能取得这些新增文件。本地已运行应用仍是 `5ea75af` 构建基线／v5 `356f8f5` 生产代码；本提交未更改生产应用源码，不是另一个“v6”镜像。
- 客户从自己获准的源码渠道自行构建四个服务；我们不发布供客户拉取的镜像。构建工具按指定 commit 的 `git archive` 构建，**不会包含工作目录中未提交的修复**。包含 helper 的交付必须先固定能实际取得且含该文件的源码候选，并补齐受影响验证。
- 容量扩到 100,000 的要求已经取消，相关 8 个文件的容量变更已恢复基线、额外扩容测试已移除；本候选维持 **1,000 个基础名字 × `00`–`09` 十种后缀 = 10,000 个命名位置**。`POOL_MAX_ACCOUNTS` 上限 10,000，`READY_IDLE_TARGET` 为 0–10,000 且不超过 cap；这不是已验证吞吐或真实 GitHub 容量。不得沿用 100,000 配置或扩容承诺。

### 0.2 已做与未做，分别记录

| 证据类别 | 已实际执行的范围 | 不能据此声称 |
| --- | --- | --- |
| 历史合成验证 | 合成 SQLite→真实 MySQL 导入、字段/关系保护及失败路径；v5 的 3/5 独立 Proxy 进程恢复/共享池验证有独立记录 | 真实账号开通通过、客户 Rancher 跨节点 HA、客户峰值/SLO 通过；不同轮次测试计数不得相加 |
| 本次本地真实数据迁移 | 原 **4 个 Ready 成员**；源 `paused=1 / idle_target=2 / max_accounts=5`，2 条统计、25 条事件、0 lease/hold。原服务停止，原 SQLite 主文件/WAL/SHM、卷及证书保留；仅操作私有一致性副本 | 修改了原数据库、迁移需要重新开户/新席位/模型调用 |
| 本次真实迁移的失败与修复 | 首次 source-only dry-run 拒绝缺少 `user_pool_catalog_cooldowns` 及其过期索引的旧 schema。逐项确认仅为受支持缺失形状后，新增 copy-only helper，**15 项专项测试通过**；只在新副本补空表/索引，原文件及已有行不变，原严格 importer 未放宽且预检通过。首次目标连接因隔离网络无宿主入口失败、未写库；固定本机转发入口并再次确认空库后导入成功 | 任意旧库可强制升级；失败后一律可以重试；禁用 TLS 是远程连接修复方式 |
| 本次 MySQL/应用/UI | 新专用 MySQL 内部逐字段比对 4 账号、4 成员、2 统计、25 事件通过；导入后 paused、无 owner/lease/hold。随后先 1 个再共 **3 个 Proxy＋Console**，三个均 `storage=mysql`、迁移阶段共享 4 ReadyIdle；一个 owner、两个 standby。新本地 UI `http://localhost:17714/#user-pool` 已展示且用户看过 | **本地 Console 直连 Proxy1，没有 LB**；不是客户 Service/LB HA 验收，不能把此前另一合成环境的 3/5 进程 HA 结果套到本地真实流量 |
| 运维采集 | sampler 最终 **30 项离线测试通过**；另有本地真实环境对 **3 个副本＋MySQL SELECT collector** 的只读采集，`collectionComplete=true`、有效 owner present、paused=true | 客户告警已安装/已收到、采集器已接入客户平台或客户环境 HA 通过 |
| 新增两个真实账号 | 用户查看 UI、确认容量回退并授权后，**两新账号真实 canary 已完成，总计 114.099 秒**；Login 首次尝试均成功，耗时 89.236／91.784 秒，重叠约 89 秒；结束时共 6 Ready、恢复暂停。原 4 账号凭据和 inventory 字段逐项完全不变 | 客户租户授权、批量开通容量、峰值/SLO、客户 LB/HA 或持续 stream 已通过 |
| 四个 LiteLLM 测试 key 的真实请求 | 用户随后用 4 个 key 的真实请求均 HTTP 200 完成，耗时分别 **5,824／4,211／5,264／3,098 ms**。收尾快照为 total=6、4 active leases、2 ReadyIdle，`target=2 / cap=6 / paused=1 / TTL=172800s`；测试 key 已撤销，leases 按原规则保留，没有额外账号 | key 撤销自动释放 lease、原 4 个账号在后续真实业务中绝不再变化、全部模型/长流/客户峰值已验收；这些时延只是四次观测 |
| 离线并发维护 | 专用 helper **31 项离线测试＋合成数据实际 MySQL 验证通过**；另经用户批准，在停 3 个 Proxy、Login、SSO、确认 owner 过期与完全静止后，实际应用 **5/2/2** 配置。MySQL 只 CAS 更新 fingerprint，所有表其他字段保留 | 通用 fingerprint 编辑器、在线 reload、任意不变量修改或客户远程库已受支持；详见第 4.3 节 |
| 额外合成负载 | multihot、修正版120秒stream短测及条件300秒持续测试均实际通过；两轮stream分别0意外错误、3/9个完整周期，清理全部通过。含此前失败的活动累计**482.940秒/600秒**，没有使用旧30分钟/24小时计划 | 真实GitHub吞吐或客户长流SLA；完整记录见[额外负载报告](user-pool-final-load-validation.md)，本地与客户环境结果不能混用 |
| 客户环境 | 本文已交付完整操作步骤；客户实际 Service、节点、MySQL/TLS、镜像、恢复/切换仍待核对和演练 | 客户已构建、上线、完成流量/长流/主库 HA 或单实例恢复验收 |

上述本地**导入与最初 UI 展示阶段**保持 `idle_target=2`，靠明确授权和外部网络隔离进行暂停态展示，**没有通过 env 改写原 settings**；之后才单独批准真实两账号/四 key 请求，收尾状态以表中的 6 total／4 leased／2 idle 为准。下文的客户标准启动门禁要求事先按受支持管理流程获批设置 `paused=1 / idle_target=0`，不把这一要求倒写为本地演练已经执行的步骤。导入/首次 canary 准备期间的本机网络入口或端口冲突通过获批本地 relay 处理，**不是客户 Service 的故障或修复证据**。

容量代码恢复基线后的完整 Proxy 回归为 **463 项：438 通过、0 失败、25 项条件 skip**；最新 legacy-copy＋importer 回归为 **64 项：63 通过、0 失败、1 项 MySQL engine 条件 skip**。另一次交付/运维离线复核 36 项通过（30 sampler＋6 deployment package），维护工具离线复核 46 项通过（15 legacy＋31 concurrency）；它们与前述专项存在重叠，**不得累计成新增测试数**。较早 importer 单独 48 通过／1 skip 是旧范围，不代替最新 63／1。skip 不计作 engine 执行通过，合成 engine 与真实 canary 的计数/时长也不相加。较早迁移/运维报告中的“未完成／未访问 SQL”描述当时那一轮范围；当前摘要采用本次后续实测，但客户现场仍须执行本手册。

参考：[严格 importer](../upgrade/user-pool-mysql/README.md)、[本地真实迁移记录](user-pool-real-mysql-migration-validation.md)、[交付计划](user-pool-delivery-plan.md)、[运维基础](user-pool-ops-basics.md)、[客户自建包](../deploy/user-pool-mysql-customer/README.md)、[MySQL 实施说明](user-pool-mysql-implementation.md)。

## 1. 建立私有变更记录、变量与停止条件

每一步记录责任人、批准范围、UTC 时间、候选 SHA、实际退出码、检查结论和下一步放行人。备份/凭据/完整账号数据只存在客户访问受控的存储，不进入仓库、截图、聊天或普通日志。不要 `set -x`、打印环境、展开 Secret 或开启 HTTP/SQL debug。

以下变量由客户在私有 shell/变更记录中填写；`REPLACE_*` 未填完就停止。后续 Bash 命令假定从**固定源码 checkout 的根目录**执行。此手册不安装工具；先准备获准版本的 Git、Node.js/锁文件依赖、Docker、kubectl、MySQL 8 client、Python 3 和 jq。构建镜像需要客户批准的下载网络；备份示例使用 Python 标准库，不涉及安装或外部调用。

```bash
set -eu
umask 077
export SOURCE_SHA='REPLACE_FINAL_AVAILABLE_40_LOWERCASE_HEX_SHA'
export CHANGE_ID='REPLACE_NEW_CHANGE_ID'
export PRIVATE_DIR='/REPLACE_PROTECTED_EXISTING_CHANGE_DIRECTORY'
export BUILD_OUT='/REPLACE_EXISTING_PARENT/REPLACE_NEW_BUILD_OUTPUT'
export IMAGE_PREFIX='customer-ghcp-REPLACE_NEW_LOWERCASE_BUILD_ID'
export BUILD_PLATFORM='linux/amd64' # 必须匹配客户节点；arm64 须另行验证
export APPROVED_REGISTRY='REPLACE_CUSTOMER_APPROVED_REGISTRY/REPLACE_PROJECT'
export KUBE_CONTEXT='REPLACE_APPROVED_CONTEXT'
export NAMESPACE='REPLACE_NAMESPACE'
export EXISTING_SERVICE='REPLACE_EXISTING_PROXY_SERVICE'
export SERVICE_PORT='REPLACE_EXISTING_SERVICE_PORT'
export CLUSTER_DOMAIN='REPLACE_ACTUAL_CLUSTER_DNS_DOMAIN'
export OLD_PROXY_DEPLOYMENT='REPLACE_SOURCE_PROXY_DEPLOYMENT'
export NEW_PROXY_DEPLOYMENT='REPLACE_NEW_MYSQL_PROXY_DEPLOYMENT'
export NEW_PROXY_SELECTOR='REPLACE_NEW_EXCLUSIVE_LABEL_SELECTOR'
export SSO_DEPLOYMENT='REPLACE_EXISTING_SSO_DEPLOYMENT'
export LOGIN_DEPLOYMENT='REPLACE_EXISTING_LOGIN_DEPLOYMENT'
export CONSOLE_DEPLOYMENT='REPLACE_EXISTING_CONSOLE_DEPLOYMENT'
export PROXY_REPLICAS='3' # 或获批的 5；首次启动始终为 1
export MYSQL_DATABASE='REPLACE_NEW_DEDICATED_DATABASE'
export MYSQL_CLIENT_CONFIG='/REPLACE_PROTECTED_MYSQL_CLIENT_OPTION_FILE'
export MYSQL_CA_LOCAL='/REPLACE_PROTECTED_MYSQL_CA.pem'
export INTERNAL_CURL_CONFIG='/REPLACE_PROTECTED_INTERNAL_CURL_CONFIG'
export PROXY_CLUSTER_ROOT="http://${EXISTING_SERVICE}.${NAMESPACE}.svc.${CLUSTER_DOMAIN}:${SERVICE_PORT}"
k() { kubectl --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" "$@"; }
```

- `MYSQL_URL` 由批准的 secret manager 注入迁移进程及 Proxy Secret；**不在本文、argv、URL query、shell history 或 ConfigMap 写凭据**。MySQL client option 文件保存其获准身份/host，文件路径不是密码。
- `INTERNAL_CURL_CONFIG` 由受控流程提供，只包含批准的 CA 与 `X-Internal-Token` 头等必要配置；不得包含 `insecure`、重定向、trace、重试或未批准 URL。`curl --disable` 禁用个人 `.curlrc`。它是现有高权限内部 token，不是只读专用 token；命令只在可信管理网络执行。
- 集群 root 不带 `/api`、模型路径或凭据。上述 HTTP 仅适用于批准的集群内部受控网络；跨不可信网络必须使用验证证书的 TLS/mTLS。实际 cluster domain 不一定是 `cluster.local`。

**总停止条件**：源身份/schema 不明；未排空/外部任务结果不明；备份不可恢复；目标非专用空库；fingerprint 不一致；TLS/权限/现有 Service/Secret/卷未核实；缺少最终源码；导入 commit/rollback 不明；目标历史丢失不符合策略；未经授权产生外部行为。任何一项出现都保持维护状态，不能用清安全字段、关闭 TLS、降 fence、重复开户、重放推理或重启全部副本“试通”。

## 2. 只读盘点客户已有入口与四服务

本步需要客户批准只读集群访问，**不修改 Service、不扩容、不启动已停服务**。若不是 Deployment，把后续操作替换为客户实际控制器/Helm/GitOps 流程，不对未知 workload 套命令。

```bash
k get service "$EXISTING_SERVICE" -o json > "$PRIVATE_DIR/existing-service.json"
jq '{type:.spec.type,clusterIP:.spec.clusterIP,selector:.spec.selector,
     ports:.spec.ports,sessionAffinity:.spec.sessionAffinity,
     internalTrafficPolicy:.spec.internalTrafficPolicy,
     publishNotReadyAddresses:.spec.publishNotReadyAddresses}' \
  "$PRIVATE_DIR/existing-service.json"
k get endpointslices -l "kubernetes.io/service-name=$EXISTING_SERVICE" -o json \
  > "$PRIVATE_DIR/existing-endpointslices.json"
k get pods -o wide > "$PRIVATE_DIR/pod-placement.txt"
k get deployment "$OLD_PROXY_DEPLOYMENT" "$SSO_DEPLOYMENT" \
  "$LOGIN_DEPLOYMENT" "$CONSOLE_DEPLOYMENT" \
  -o custom-columns='NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas'
k get pvc -o wide > "$PRIVATE_DIR/pvc-inventory.txt"
```

**检查与放行**：

1. 客户在 Rancher 中私下核对实际 `Service.type`、selector、`port/targetPort`（含命名端口）、EndpointSlice 的 ready/serving/terminating 状态、所选 Pod、节点/故障域。`ClusterIP` 是包内**新建示例**的 type，不是客户现有 Service 的已证事实。若为 headless/ExternalName、手工 endpoints 或有 service mesh，需先审核等价路由，不能假定普通 Service LB 契约。
2. 现有 Service 优先保留名称/DNS、端口及与 LiteLLM 的约定；私下审核后只把后端改成新 MySQL Proxy 的**独占 label**，旧 SQLite Pod 绝不同时匹配。维护窗口业务关闸后才改 selector；不得直接套模板把现有 Service 改名、改成 ClusterIP 或新建一层 NGINX。
3. 检查 Service 未通过 `publishNotReadyAddresses`、本地流量策略、拓扑路由或客户端 DNS 缓存绕过预期 readiness/故障处理；不需要会话粘滞。Service 是连接级转发，持久连接可能一直落在同一 Pod；一次成功请求不是遍历了所有副本。
4. 核对 LiteLLM **实际生效**的 Proxy root、完整 model-group/alias、路径拼接及 timeout/retry/fallback。精确的带前缀/不带前缀 group 不是同一 key；fallback 目标必须已存在、被允许且满足数据路由/费用约束。不能推测异常一定命中 fallback，不能自动重放已开始的流或结果不明的请求。
5. 保留原四服务镜像 ID/版本、管理员与 session secret、SSO 公网 `BASE_URL`、SAML entity/ACS、证书/私钥、Login `SSO_URL`/浏览器设置、各 PVC/volume/subPath/文件权限和配置 revision。只记录 Secret 引用与获准校验结果，不导出 Secret 值。
6. SSO/Login/Console 仍单实例。它们不会因 Proxy 改 MySQL 而自动改成 MySQL；保留各自原数据路径/卷。单实例升级采用已排空的停止后重建/受控 Recreate，不能用 surge 让两个 SQLite writer 同时挂同一个卷。

**网络/信任核对表**：LiteLLM→Service 业务路径；SSO/Login/Console→同一 Service 的鉴权内部 API/回调；Proxy→MySQL writer、原 SSO/Login root；获批外部阶段的 SSO→GitHub/SCIM/席位与 Login 浏览器→SSO/GitHub。都要核对 DNS、端口、NetworkPolicy、出站策略及 CA 链。`localhost` 在 Pod 内指该 Pod，不是宿主或另一服务。集群 DNS 通常不供客户桌面浏览器/外部 GitHub 回调直接访问；**不要把 SSO 公网地址改成内部 Service DNS**。Node 信任和 Login Chromium/OS 信任分别配置；MySQL CA 挂载不会自动给浏览器或所有 HTTP 客户端装根证书。不得用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、`curl -k` 或浏览器忽略证书作为修复。

## 3. 维护前构建四服务与准备不可变产物

先取得批准的最终源码与包；确认 `SOURCE_SHA` 指向本地真实存在的完整 commit，且需用到的 helper/模板/运维文件已随该候选交付。若交付记录未提供完整SHA或客户无法取得该提交，则停止，不构建工作区脏文件补进基线镜像。

```bash
test "$(git rev-parse --verify "${SOURCE_SHA}^{commit}")" = "$SOURCE_SHA"
git status --short
node deploy/user-pool-mysql-customer/build-images.mjs \
  --commit "$SOURCE_SHA" --output "$BUILD_OUT" \
  --image-prefix "$IMAGE_PREFIX" --platform "$BUILD_PLATFORM"
```

上条只做 plan，不调用 Docker、不创建输出、不启动/连接应用。`BUILD_OUT` 必须尚不存在、位于 checkout 外且父目录已存在；`IMAGE_PREFIX` 必须是无 registry/tag 的合法小写 local-name，使用本次**新**前缀，不复用 `ghcp-*:local`。先核对四个预期 tag 均不存在；下条仅查询镜像，不能把 daemon/权限错误误认成“tag 不存在”。

```bash
for service in sso login proxy console; do
  docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' \
    --filter "reference=${IMAGE_PREFIX}-${service}:${SOURCE_SHA}"
done
```

输出必须为空且命令成功。构建脚本本身不会拒绝已有同名 tag，**操作者必须守住这个检查**；已有产物换新前缀，不覆盖旧镜像。客户批准构建后执行：

```bash
node deploy/user-pool-mysql-customer/build-images.mjs \
  --commit "$SOURCE_SHA" --output "$BUILD_OUT" \
  --image-prefix "$IMAGE_PREFIX" --platform "$BUILD_PLATFORM" --execute-build
```

检查 `build-manifest.json` 状态为 `built-locally-not-deployed`，四服务源码/平台/实际 local image ID 齐全。现有 Dockerfile 使用锁文件 `npm ci`，Login 下载 Chromium/系统依赖；`node:22-bookworm-slim` 等可变来源意味着**不承诺字节级可复现**。构建失败保留证据，审查后用新输出目录/前缀，不自动重试。

客户若已批准自己的 registry 分发，使用自己的认证流程；不要把 password 放在命令中。示例 tag 仍必须是未占用的新引用：

```bash
# 仅在客户批准向其内部 registry 发布后运行；构建脚本不会代做 push。
for service in sso login proxy console; do
  local_ref="${IMAGE_PREFIX}-${service}:${SOURCE_SHA}"
  customer_ref="${APPROVED_REGISTRY}/${IMAGE_PREFIX}-${service}:${SOURCE_SHA}"
  docker tag "$local_ref" "$customer_ref"
  docker push "$customer_ref"
done
```

记录 registry **实际返回**的 manifest digest，部署私有清单使用批准的不可变引用；不要杜撰 `sha256`。本地 Docker image ID、registry manifest digest、Pod 运行时 imageID 是三个不同字段，分别保留实际值。若客户采用节点离线装载，替换为其批准的分发流程，逐节点核对。维护切换时不追分支、不重建、不覆盖旧镜像。

## 4. 准备新 MySQL、权限和应用私有清单，应用暂不启动

### 4.1 MySQL 写主库与权限生命周期

由 DBA 提供专用**全新空** MySQL 8/InnoDB 数据库、正确写端点、受信 CA、备份/PITR 策略与恢复演练证据。不是 SQLite 卷共享、不是读副本、不是另一测试/生产池，不能合并非空目标。若使用 MySQL HA，真实主库切换及客户端重新连接必须在授权等价环境验收；不用 HA 也要明确数据库单点和恢复目标。

- 创建数据库/账号/网络白名单由 DBA 在其批准流程内完成，限定到该 schema、应用主机和需要的权限，不把管理员/root 连接串分发给 Proxy。
- importer/初次启动需要 schema DDL 与校验能力：`CREATE`、适用的 `ALTER`/`INDEX`/`REFERENCES`、`TRIGGER`，以及 `SELECT/INSERT/UPDATE/DELETE`；需要读取相应 `information_schema` 元数据和执行内建 `GET_LOCK/RELEASE_LOCK`。不存在要授予的自定义“advisory-lock privilege”；具体可用性由 DBA 用选定 MySQL/托管策略验证。不要为省事授全局 `ALL`/`SUPER` 或关闭二进制日志安全策略。
- **运行时每次启动仍调用 schema migrations，包含 `CREATE TABLE IF NOT EXISTS` 和 migration/seed 的 DML**。不能假定离线导入一次后把应用降为纯 DML 就一定可重启；现候选没有独立的 migrate-only 启动模式。若要求运行时撤销 DDL，必须先审查并实际验证等价权限流程，不能在切换时临时试错。
- credential-fence trigger 默认由创建它的身份成为 `DEFINER`。DBA 要保留/审核该身份和 trigger 执行所需的权限；**不可在导入后直接 DROP migration 用户，或撤销其被 trigger 使用的权限**。分别管理登录权限、轮换凭据、对象 definer 与 runtime 权限，测试凭据更新时 fence 正常工作。只读监控身份独立，仅给所需 SELECT。
- 连接预算：默认每 Proxy 10，3 副本共 30、滚动第 4 个时 40；5 副本共 50、滚动第 6 个时 60，另留 SRE/监控/备份与迁移余量。importer 独立池默认 3、允许 3–100，至少 3 连接；不是三个服务各用一条连接。副本数量不等于线性吞吐。

安全注入 MySQL client option 文件后，以正确 schema 做只读确认。`--defaults-extra-file` 必须是 MySQL client 的首个 option；不要将密码直接传参。

```bash
mysql --defaults-extra-file="$MYSQL_CLIENT_CONFIG" \
  --ssl-mode=VERIFY_IDENTITY --ssl-ca="$MYSQL_CA_LOCAL" \
  --database="$MYSQL_DATABASE" --batch <<'SQL'
SELECT VERSION() AS mysql_version, @@read_only AS read_only,
       @@super_read_only AS super_read_only;
SHOW SESSION STATUS LIKE 'Ssl_cipher';
SELECT COUNT(*) AS objects_in_target
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();
SELECT COUNT(*) AS triggers_in_target
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE();
SQL
```

期望是经 DBA 确认的 writer，TLS cipher 非空，全新目标对象/trigger 为 0。这些聚合不能独自认证“连对了环境”；host/schema/审批记录必须同时匹配。DBA 的创建动作不嵌入迁移命令，更不嵌入 build。

**TLS 两种客户端的命名区别**：应用/importer 用 `MYSQL_SSL_MODE=verify-ca`＋`MYSQL_SSL_CA_PATH`，此模式验证证书链**及主机身份**；MySQL CLI 上述等价要求用 `VERIFY_IDENTITY`。非 loopback importer 强制 verified TLS；`disabled`/`required` 只允许精确 loopback，后者仅加密不验证，不能用于远程客户库。Proxy 配置解析虽然允许更弱模式，客户部署也必须 verify-ca。CA 路径是**执行进程看到的路径**：宿主迁移工具与 Pod 中的只读挂载路径分别填写，不能只设置 env 而没挂文件。用与证书 SAN 匹配的 writer DNS，不因 hostname 校验失败改用不验证的模式。

### 4.2 配置不变量、保留策略与应用清单

将正式值记录为一个受控配置 revision，并同步给 importer 和所有 Proxy：

| 必须核对的设置 | 处理方式 |
| --- | --- |
| `ACCOUNT_ROUTING_MODE=caller-lease`、`STORAGE_DRIVER=mysql` | 新 Proxy 固定；不混入 SQLite overlay 或旧 SQLite writer |
| `POOL_ACCOUNT_EMAIL_DOMAIN`、`POOL_WARMUP_MODEL` | 使用原批准 domain 与正式 model；不向导入工具填临时模型再改 env |
| `PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS` | 全部 fingerprint 不变量（包括所用默认值）必须与导入时相同；以后新增选项也要审查 |
| `READY_IDLE_TARGET`、`POOL_MAX_ACCOUNTS`、`CALLER_LEASE_TTL_SECONDS` | 只用于初次 seed；已有 DB 的 target/cap/lease 由共享 settings 决定，env 不覆盖导入数据 |
| `paused` | **没有 `POOL_PAUSED` 产品 env**。用 Console/版本化 API 保存共享 settings；importer 强制目标 paused=1，但保留源 target |
| `REQUEST_STATS_PER_ACCOUNT_LIMIT` | 所有副本在首次启动前统一到客户批准值；默认每账号只保留 2 条，会在正常启动/新请求时裁剪。需保留完整历史则先独立归档并核定足够保留量，不使用未支持的“0=无限”假设 |
| `API_KEY`、`INTERNAL_API_TOKEN`、`MYSQL_URL` | 仅 Secret 注入；内部四服务 token 一致，Gateway 使用正确业务 key，不暴露给终端调用者 |
| `IDENTITY_HEADER=X-User-Identity`、`IDENTITY_HEADER_REQUIRED=true` | 可信网关验证 caller 后覆盖客户端同名头，生成稳定 `sha256:`＋64 位小写十六进制；hash 不是授权凭据 |
| `SSO_BASE_URL`、`LOGIN_BASE_URL`、上游/企业配置 | 复用批准值和原服务 root；不得把测试/mock 地址或默认企业配置带入客户部署 |

fingerprint 不匹配时停止：不能删 settings、手工改 hash，或认为“所有 env 一起改”即可绕过持久化不变量。target/cap/lease/paused 通过最新 `expectedVersion` 的管理 API 修改；已评审的两个并发参数有第 4.3 节专用**离线**维护路径，其余不变量变化仍需单独审查迁移。

以 [Rancher 模板](../deploy/user-pool-mysql-customer/rancher.template.yaml) 为输入，在**私有副本**审核这些变更：

1. 去掉示例的**新 Service 文档**；另备“复用已有 Service”的最小受控变更，保留 type/DNS/port 及需要的现有字段，只切到新部署独占 selector。若须改变不可变字段，停止另行评审，不能强删重建。
2. 新 MySQL Proxy Deployment 首次 `replicas: 1`；新 label 不匹配旧 SQLite。保留旧 SQLite PVC，但新 Proxy 不挂它。mount 正确 MySQL CA、Secret、资源，填入四服务构建的实际引用；init 容器与主 Proxy 使用一致批准镜像。
3. 模板 `CUSTOMER_PAUSED_DATABASE_APPROVED=BLOCKED` 保持阻塞，直到第 8 步私下确认真实目标 `paused=1 / idle_target=0` 和外部任务安全，再在私有配置改为 `"true"`。这是**操作者 attestation**，不是自动查询 DB 的安全程序，不是暂停 env；`READY_IDLE_TARGET=0` 也不是暂停已有池。不能以该 init 为由随意 apply，apply 本身会创建资源。
4. SSO/Login/Console 分别保留原卷、Secret、证书、管理员、端口和公网配置，只升级到候选匹配镜像并把三者的 `PROXY_BASE_URL` 合并为实际 `PROXY_CLUSTER_ROOT`（无 `/api`）。它们不是三个新空服务，不应用 Proxy 扩容参数。
5. 默认不开放业务/外部开户网络；维护状态下可以逐副本 health/readiness 和 Console 摘要验证。DB pause 不代表进程启动只读，后面须经过明确写入边界放行。
6. 经客户工具做离线 YAML/schema 检查，再在获批集群执行 server-side dry-run（会联系控制面，不是离线测试）。未填变量、准入拒绝、镜像/CA/Secret/PVC 不匹配则停止。

```bash
export PROXY_MANIFEST="$PRIVATE_DIR/REPLACE_REVIEWED_PROXY_ONE_REPLICA.yaml"
export SERVICE_MANIFEST="$PRIVATE_DIR/REPLACE_REVIEWED_EXISTING_SERVICE_UPDATE.yaml"
export CONSOLE_MANIFEST="$PRIVATE_DIR/REPLACE_REVIEWED_EXISTING_CONSOLE.yaml"
export SSO_MANIFEST="$PRIVATE_DIR/REPLACE_REVIEWED_EXISTING_SSO.yaml"
export LOGIN_MANIFEST="$PRIVATE_DIR/REPLACE_REVIEWED_EXISTING_LOGIN.yaml"
k apply --dry-run=server -f "$PROXY_MANIFEST"
k apply --dry-run=server -f "$SERVICE_MANIFEST"
k apply --dry-run=server -f "$CONSOLE_MANIFEST"
k apply --dry-run=server -f "$SSO_MANIFEST"
k apply --dry-run=server -f "$LOGIN_MANIFEST"
```

这些 dry-run 不是创建 Secret/PVC、镜像可拉取、网络可达或业务已验收的证明。客户若由 Helm/GitOps 管理资源，使用其等价预览/部署流程，不让直接 kubectl 修改被控制器回写。

### 4.3 可选维护：仅调整两个池并发参数，不能盲改 fingerprint

此步骤**不是 SQLite→MySQL 导入的必做项**，也不是在线变更。需要时单独批准 [reconfigure-concurrency.ts](../upgrade/user-pool-mysql/reconfigure-concurrency.ts) 及其[专项测试](../upgrade/user-pool-mysql/reconfigure-concurrency.test.ts)；它仍须随最终源码 SHA 交付。`5/2/2` 的含义是 **Proxy `PREWARM_CONCURRENCY=5`／池 `POOL_LOGIN_MAX_PENDING=2`／Login 自身持久化 concurrency=2**，三者作用不同，不是 5 个 Proxy，也不是每个 Proxy 各开 2 个 Login。最后一项由 Login 已有版本化设置管理，**不由 MySQL helper 修改、不虚构 Login 并发 env**。

本地已执行证据：31 项离线测试及合成数据实际 MySQL 校验通过；用户随后批准 5/2/2，在停止 3 个 Proxy、Login、SSO、排空并确认 owner 过期后实际完成维护。MySQL 只改变 `config_fingerprint`，其他 settings（含 version/paused/target/cap/owner 字段）、凭据、inventory、leases、统计、事件等所有表字段逐项保留；不是直接生成 hash 后无条件 UPDATE。

客户若需要同类维护，依次核验：

1. 关闭业务/管理 mutation，paused=1，排空所有外部任务/浏览器/回调，停止所有 Proxy 和外部 writer，保存 MySQL＋companion 备份/旧新配置。确认无 hold/catalog hold/identity claim，owner 以 **DB 时间**已经过期。helper 要求所有 inventory 为已验证的 quiescent ready；它比一般 importer 更窄，cooling/failed/未知任务状态不能强过。
2. 此工具**没有 CLI、没有 `--force`／`--mysql-url`／`--dry-run` 参数**。导出函数是 `reconfigureConcurrency(options)`；调用方提供已借出的专用 `mysql2` `PoolConnection`，并负责连接获取超时及释放/关闭。只接受明确的 `127.0.0.1` 或 `::1` 连接，实际远端也须 loopback，database 与 `expectedDatabase` 完全匹配；不接受任意远程 writer 或 Unix socket。客户远程库需另行审查受控访问方案，不能为命中检查而关闭远程 TLS、暴露 DB 或复制本地 relay 配置。
3. 私有 `oldEnv`、`newEnv` 必须是仅含第 4.2 节相关 13 个键的显式配置映射：`ACCOUNT_ROUTING_MODE`、`STORAGE_DRIVER`、`POOL_ACCOUNT_EMAIL_DOMAIN`、`READY_IDLE_TARGET`、`POOL_MAX_ACCOUNTS`、`CALLER_LEASE_TTL_SECONDS`、`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_LOGIN_MAX_PENDING`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_WARMUP_MODEL`、`POOL_REQUEST_TIMEOUT_SECONDS`。不能直接传整个 `process.env`；两份配置仅允许 `PREWARM_CONCURRENCY`／`POOL_LOGIN_MAX_PENDING` 有差异，其他值和 mutable seeds 均相同。
4. `expectedSettings` 为当前 singleton 除 fingerprint 外的**完整、私有、逐字段快照**；另显式给 `confirmAllProxiesStopped`、`confirmExternalWritersStopped`、`confirmLoginDrained` 三个 true。这些是操作者声明，不是停服务功能。工具校验旧配置 hash、schema/credential fence 和全部表，用 serializable 事务/行与范围锁读取并验证，再以旧 hash＋所有 settings＋paused/owner-expiry 条件 **CAS 单行**，回读验证除新 hash 外全表不变。SQL 总预算最多 5 秒，不能提高它来掩盖大库锁竞争；不执行 migrations/provider/worker。
5. 成功返回 `{changed:true}` 后，更新**每一个 Proxy** 的受控配置为同一新值；Login concurrency 按其原版本化管理流程单独核对。先恢复 1 个 Proxy、保持 paused 验证，再按第 9–10 步恢复所选副本和原 companion；不混跑旧 fingerprint。测试 key 的撤销不等于释放/删除旧 lease，合法 leases 原样保留。
6. `commit_outcome_unknown_do_not_retry_or_resume`、`transaction_outcome_unconfirmed_do_not_resume` 或 `rollback_unconfirmed_do_not_retry_or_resume` 都是停止条件：不重试/重启/切旧源，私下核对提交状态；仅配置改回旧值也不构成回退。其余失败也须审查原因，不手工改 hash 代替安全维护。

本节交付的是当前 helper 的准确使用边界，不是可对客户任意库执行的一键脚本。客户若不更改这两个并发参数，直接保留原正式不变量，继续下一步即可。

## 5. 进入维护：关业务、排空、暂停、停止源写进程

按批准窗口执行，记录原 source 配置/计数与之后受支持管理变更，不能先冷拷文件再继续写源。

1. 在现有 LiteLLM/入口流程关闭本路由的新 admission；阻止普通调用者访问 Proxy 业务端口。**paused 只暂停补池，不关闭模型流量**。停止自动运维 mutation、定时开户和会写池的后台任务。
2. 用 Console/受控 API 设置 `paused=1`，客户标准流程另明确批准将 `idle_target=0`（记下原值，后续是否恢复单独决定）。不手工 SQL 改源，不靠 env 覆盖已存在 settings；管理操作本身会写 settings/version/event，要先于封存备份。
3. 排空 inference/catalog、所有已派发 SSO 创建/SCIM/席位/Login 浏览器和回调。暂停不证明浏览器已停；cancelled/404/超时不是外部动作未发生的证明。保留 task/nonce/generation/fence 证据，结果不明先人工 reconciliation，不能清字段或重复 POST。
4. 确认无 provisioning、refreshing、未完成 OAuth、identity-init claim、任何 inference/catalog hold（含已过期行）。合法 settled ready/cooling 历史 task/OAuth 关联可保留，不为“清爽”删数据。现有 leases 可以按原 deadline 保留，不强制 release、续租或删除来过检。
5. 按原平台停写流程停止旧 Proxy 及仍能回调写源的 SSO/Login/Console，保留原卷/镜像/证书；确认调度器不再运行、owner deadline 已失效。禁止 `down -v`、PVC 删除或全局 prune。

在源当前确实运行且允许管理、使用批准的可达内部 root 时，可用下面的版本化调用替代 Console。**已经停止的源不得为执行示例擅自重启**；若其保留 target 非零，停止标准模板流程，申请具体隔离启动方案，不修改离线原库来“凑 target0”。

```bash
export SOURCE_ADMIN_ROOT='REPLACE_APPROVED_REACHABLE_SOURCE_INTERNAL_ROOT'
curl --disable --config "$INTERNAL_CURL_CONFIG" --silent --show-error --fail \
  --connect-timeout 3 --max-time 10 \
  --output "$PRIVATE_DIR/source-summary.json" \
  "$SOURCE_ADMIN_ROOT/api/user-pool/summary"
jq '{expectedVersion:.settings.version,changes:{paused:1,idle_target:0}}' \
  "$PRIVATE_DIR/source-summary.json" > "$PRIVATE_DIR/source-pause-request.json"
# 以下 PATCH 是已批准的维护配置写入，不是只读检查。
curl --disable --config "$INTERNAL_CURL_CONFIG" --silent --show-error --fail \
  --connect-timeout 3 --max-time 10 --request PATCH \
  --header 'Content-Type: application/json' \
  --data-binary "@$PRIVATE_DIR/source-pause-request.json" \
  --output "$PRIVATE_DIR/source-pause-result.json" \
  "$SOURCE_ADMIN_ROOT/api/user-pool/settings"
```

409 时重新读取并由操作者判断，不强制覆盖/自动重试。再读取 summary 核对真实 settings；其他排空条件由受控工具核查，summary 没有全局 hold/owner 字段不等于它们为零。若源由 Deployment 管理且应用/外部动作已确认排空，受控停源命令形状如下；不能对生产故障注入借用此例：

```bash
k scale deployment "$OLD_PROXY_DEPLOYMENT" --replicas=0
k scale deployment "$SSO_DEPLOYMENT" "$LOGIN_DEPLOYMENT" \
  "$CONSOLE_DEPLOYMENT" --replicas=0
k get deployment "$OLD_PROXY_DEPLOYMENT" "$SSO_DEPLOYMENT" \
  "$LOGIN_DEPLOYMENT" "$CONSOLE_DEPLOYMENT" \
  -o custom-columns='NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas'
```

还须确认旧 Pod 已终止、无外部 writer、无仍运行的浏览器/回调、自动扩容/GitOps 不会把旧 writer 拉起。不能只凭 desired=0 开始备份。

## 6. 封存原 SQLite/WAL，制作可验证的独立备份

先用客户已批准的存储快照/备份流程保存**停止写入后的整个源数据目录**，至少包含实际 SQLite 主文件及存在的 `-wal/-shm`，记录原文件校验值；SSO/Login/Console 的卷、日志、证书、配置也分别备份。验证可恢复后再迁移。保留原始封存件只读，不用迁移工具打开原卷，不删除 sidecar，不对原库 `VACUUM`/checkpoint/改 journal。

以下示例输入 `RAW_SQLITE` 是已一致封存、只读挂载的**备份主文件**，不是活库路径。脚本先把备份主文件和 sidecar 复制到新私有工作目录，再用 SQLite backup API 读出 WAL 一致内容。读取连接为 `mode=ro`＋`query_only`；**不要加 `immutable=1` 来忽略 WAL**。仅新输出转换为 DELETE journal。若源 snapshot 有 rollback journal 或完整性失败，停止交由 DBA 审查恢复，不自动删除 journal。

```bash
export RAW_SQLITE='/REPLACE_READONLY_STOPPED_SNAPSHOT/REPLACE_DB.sqlite'
export BACKUP_STAGE="$PRIVATE_DIR/REPLACE_NEW_BACKUP_STAGE"
export SQLITE_BACKUP="$PRIVATE_DIR/REPLACE_NEW_STANDALONE_BACKUP.sqlite"
python3 - <<'PY'
import hashlib, os, shutil, sqlite3
from pathlib import Path
raw = Path(os.environ['RAW_SQLITE'])
stage = Path(os.environ['BACKUP_STAGE'])
out = Path(os.environ['SQLITE_BACKUP'])
assert raw.is_absolute() and stage.is_absolute() and out.is_absolute()
assert raw.is_file() and not raw.is_symlink()
assert not Path(str(raw) + '-journal').exists(), 'Review source journal before proceeding'
assert not out.exists() and not out.is_symlink()
assert not any(Path(str(out) + s).exists() for s in ('-wal', '-shm', '-journal'))
parts = [Path(str(raw) + s) for s in ('', '-wal', '-shm') if Path(str(raw) + s).exists()]
assert all(p.is_file() and not p.is_symlink() for p in parts)
def hashes():
    return {p.name: hashlib.sha256(p.read_bytes()).digest() for p in parts}
before = hashes()
stage.mkdir(mode=0o700, exist_ok=False)
for p in parts:
    shutil.copy2(p, stage / p.name)
source = sqlite3.connect((stage / raw.name).as_uri() + '?mode=ro', uri=True)
source.execute('PRAGMA query_only=ON')
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
dest = sqlite3.connect(out)
try:
    source.backup(dest)
    assert dest.execute('PRAGMA journal_mode=DELETE').fetchone()[0].lower() == 'delete'
    assert dest.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
    assert dest.execute('PRAGMA foreign_key_check').fetchall() == []
    dest.commit()
finally:
    dest.close()
    source.close()
assert hashes() == before, 'Raw backup changed: stop'
assert not any(Path(str(out) + s).exists() for s in ('-wal', '-shm', '-journal'))
with out.open('rb') as f:
    header = f.read(20)
assert header[:16] == b'SQLite format 3\x00' and header[18:20] == b'\x01\x01'
print('Standalone backup verified; raw snapshot unchanged.')
PY
```

任何异常后保留未批准输出、记录失败，**不把半成品交给 importer，不自动重试/覆盖**；排查后另用新路径。该示例校验备份输入没变，不替代原卷前后 hash、存储快照一致性或恢复演练。原封存件、standalone 原备份与后续可选兼容工作副本分别保留、访问受控；恢复目标和保存期限由客户批准。

## 7. Source-only 预检；仅在精确旧形状命中时准备兼容副本

使用已安装的固定锁文件依赖；不要让维护命令临时通过 npx 下载未知工具。先对独立备份执行：

```bash
export SQLITE_IMPORT="$SQLITE_BACKUP"
npm run upgrade:user-pool-mysql -- --sqlite "$SQLITE_IMPORT" --dry-run
```

它不加载部署 `.env`、不连接/检查 MySQL，不升级/修改 SQLite；只输出安全表计数。通过必须包含完整 schema、integrity/FK、数据/关系/安全状态检查，而不仅是“能打开文件”。它不查询外部 Login，操作者排空声明仍必需。`upgrade:sqlite-to-mysql` 是旧 direct 工具，**不能替代此 caller-lease pool importer**；未知 direct 账号自动纳管不在范围。

### 唯一已审查的旧 schema 分支

当且仅当审查确认源是 [legacy-copy.ts](../upgrade/user-pool-mysql/legacy-copy.ts) 认可的**完整精确形状**：只缺空的 `user_pool_catalog_cooldowns` 和 `user_pool_catalog_cooldown_expiry`，其余 schema 与已评审布局相符（含 helper 明确接受的 recovery 列写法），才可批准 copy-only 处理。它不是任意“缺表就补”的方案，也不是 `--force` 开关。额外列/触发器/索引/自定义 schema、数据不安全或另一历史版本均停止另行审查。

helper **没有 CLI**。在已固定且包含 helper 的交付候选上，经批准使用其导出函数，原备份只读，输出全新路径：

```bash
export SQLITE_LEGACY_OUTPUT="$PRIVATE_DIR/REPLACE_NEW_REVIEWED_LEGACY_COPY.sqlite"
node --import tsx --input-type=module - <<'JS'
import { prepareLegacySqliteCopy } from './upgrade/user-pool-mysql/legacy-copy.ts';
const result = prepareLegacySqliteCopy({
  sourcePath: process.env.SQLITE_BACKUP,
  outputPath: process.env.SQLITE_LEGACY_OUTPUT,
  confirmOfflineSource: true,
});
console.log(JSON.stringify({counts: result.counts,
  sourceUnchanged: result.sourceUnchanged,
  existingRowsUnchanged: result.existingRowsUnchanged}));
JS
export SQLITE_IMPORT="$SQLITE_LEGACY_OUTPUT"
npm run upgrade:user-pool-mysql -- --sqlite "$SQLITE_IMPORT" --dry-run
```

helper 在独立内存/新文件中补空对象，不在 source path 上打开可写数据库、不启动应用/worker，不放宽 importer；逐项保留既有行/字段、schema history/sequence，并重新执行原 preflight。成功必须有两项 unchanged=true；失败输出保留但未批准，不能继续导入。原备份路径、凭据或真实 identities 不放进测试/报告。

**放行条件**：正式 importer 对最终 `SQLITE_IMPORT` 的 dry-run 通过，计数/原备份 hash/必要的兼容审查已归档，维护源仍无 writer，目标应用仍全部停止。

## 8. 离线写入空 MySQL，应用仍关闭

再次确认正确 writer/schema 和全新空目标。注入正式 fingerprint 全部配置（第 4 步）、`MYSQL_URL` 与迁移进程能读的 CA。工具不读取 `.env`，不接受 `--mysql-url` 或连接 URL query overrides。

```bash
# MYSQL_URL 及正式 POOL_* 不变量已通过获准 secret/config 流程注入；不要打印。
export MYSQL_SSL_MODE='verify-ca'
export MYSQL_SSL_CA_PATH="$MYSQL_CA_LOCAL"
export MYSQL_CONNECTION_LIMIT='3'
npm run upgrade:user-pool-mysql -- --sqlite "$SQLITE_IMPORT" \
  --confirm-offline-source --confirm-empty-target
```

两个 confirm flag 是操作者声明，**不会替你停服务**。工具在 target advisory lock 下初始化、在一个 serializable DML 事务里复制并读回比较所有值（含不输出的 token）/计数/关系后提交。DDL 与初始 seed 不和导入 DML 一起回滚，失败可留下它们。工具不会合并非空目标，也不自动 retry。

### 8.1 导入后、启动前核验

留存 importer 脱敏结果及备份未变证据；在受控 MySQL 客户端只读查看聚合：

```bash
mysql --defaults-extra-file="$MYSQL_CLIENT_CONFIG" \
  --ssl-mode=VERIFY_IDENTITY --ssl-ca="$MYSQL_CA_LOCAL" \
  --database="$MYSQL_DATABASE" --batch <<'SQL'
SELECT version, paused, idle_target, max_accounts, lease_seconds, next_ordinal,
       (owner IS NULL) AS owner_cleared, owner_until
FROM user_pool_settings WHERE id=1;
SELECT 'accounts' AS item, COUNT(*) AS n FROM proxy_accounts
UNION ALL SELECT 'members', COUNT(*) FROM user_pool_accounts
UNION ALL SELECT 'stats', COUNT(*) FROM proxy_request_stats
UNION ALL SELECT 'events', COUNT(*) FROM user_pool_events
UNION ALL SELECT 'leases', COUNT(*) FROM user_pool_leases
UNION ALL SELECT 'holds', COUNT(*) FROM user_pool_holds
UNION ALL SELECT 'catalog_holds', COUNT(*) FROM user_pool_catalog_holds
UNION ALL SELECT 'catalog_cooldowns', COUNT(*) FROM user_pool_catalog_cooldowns
UNION ALL SELECT 'identity_claims', COUNT(*) FROM proxy_identity_initializations;
SELECT state, COUNT(*) AS n FROM user_pool_accounts GROUP BY state;
SQL
```

- 目标 `paused=1`、`owner IS NULL`、`owner_until=0`；holds/catalog holds/identity claims 为 0。客户标准模板还必须有实际 `idle_target=0`，不能用 env target0 作证。
- accounts/OAuth 凭据、members 及 generation/recovery/验证时间、settings/version/domain/cap/lease/next ordinal、leases、cooldowns、stats 的 caller/lease 归属、events ID/内容与 importer 比对结果相符。个别字段按工具约定转换：账户 ISO 时间及 `requested_at` 转 MySQL `DATETIME(3)`；pool epoch-ms 与 SSO creation marker 不变。owner 清空和强制 paused 是有意差异，MySQL 自建 indexes/history，不逐字复制 SQLite 的 schema history。
- **原 lease/cooldown deadline 不续期**；过期记录仍原样迁移，之后 runtime 可按正常规则回收。用计数作公开摘要，凭据/身份/每条 deadline 只在私有校验中核对。不要把合法非零 leases 当成导入错误或清成 0。
- 统计须在启动前核对和独立归档；启动后的 retention 差异须按已批准策略解释，不能以删旧数据凑表计数。

### 8.2 失败处置

| 失败点 | 必须采取的行动 |
| --- | --- |
| source-only 预检拒绝 | 目标尚未被该命令访问；保持源封存。审查 schema/维护状态，不能降校验/清保护字段 |
| 连接/TLS/权限失败 | 保持目标应用停。查私网路由、CA 主机名、实际 writer、权限及是否已有 DDL/seed，不能泛化为“零写入可重跑” |
| DML 确认 rollback | imported DML 可已回滚，DDL/seed 可能残留；DBA 私下核验后决定新空目标或受支持空 seed 是否可重用。不能自动 DROP/清数据 |
| `commit_outcome_unknown` / `rollback_unconfirmed` | **保持维护，停止重试和两边启动**。保存证据，私下核对目标实际提交状态；未确定前不能删库、重导或返回旧源 |
| 导入成功后误再运行 | 目标不再空，拒绝是保护；不清 settings/数据重新过检 |

## 9. 先启动一个 MySQL Proxy，再恢复可查看 Console

这是明确的**目标 post-import 运行时写入边界**。即使 paused、业务关闭，Proxy 初始化/统计裁剪、scheduler owner 选举/renewal/reclaim 仍可能写 MySQL。**一旦批准启动即按“已有运行时写入”管理回退**，不能因为没流量就直接回旧 SQLite。

启动前逐项签字：第 8 步通过；stats 保留值正确；实际 paused/target0/外部任务安全；旧 writer 无法重启；正式不变量一致；新镜像/CA/Secret/labels 正确；业务和开户/模型出站保持关闭。然后只在私有配置将 init attestation 改为 true，并确认清单仍 `replicas: 1`，再执行批准部署：

```bash
k apply -f "$PROXY_MANIFEST"
k rollout status deployment "$NEW_PROXY_DEPLOYMENT" --timeout=180s
k get pods -l "$NEW_PROXY_SELECTOR" -o wide
k get deployment "$NEW_PROXY_DEPLOYMENT" \
  -o custom-columns='NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas'
# 当前只有一个目标 Pod；只检查本进程 endpoint，不发模型/目录/开户请求。
k exec "deployment/$NEW_PROXY_DEPLOYMENT" -- node -e \
  "fetch('http://127.0.0.1:3000/readyz').then(async r=>{const b=await r.json();if(!r.ok||b.storage!=='mysql')process.exit(1);console.log(JSON.stringify(b));}).catch(()=>process.exit(1))"
```

ready 必须为 mysql。核对镜像运行时 imageID 和期望源 revision，不能只看 Deployment spec。若 startup 失败，保留受控脱敏日志，按可能已写入处理，不连续重启掩盖 fingerprint/DB 错误。

在 LiteLLM 业务仍关闸、旧 writer 仍停止的条件下，将**已有 Service** 最小变更切到该单个新 Pod：

```bash
k apply -f "$SERVICE_MANIFEST"
k get service "$EXISTING_SERVICE" -o json > "$PRIVATE_DIR/service-after-single-proxy.json"
k get endpointslices -l "kubernetes.io/service-name=$EXISTING_SERVICE" -o json \
  > "$PRIVATE_DIR/endpoints-after-single-proxy.json"
```

确认 EndpointSlice 只包含新 mysql Pod；selector、targetPort、readiness 无误。按审批恢复既有 **Console 1 实例**，保留管理员/卷/session，只用已更新的 cluster root；SSO/Login 若只为查看 UI 可以继续停止。三个 companion 清单必须分开审批和应用，不提前启动全部服务或重新创建空卷。先应用现有 Console 的受控升级清单（实际 `replicas: 1`、不产生两个 writer）：

```bash
k apply -f "$CONSOLE_MANIFEST"
k rollout status deployment "$CONSOLE_DEPLOYMENT" --timeout=180s
```

需要完整应用链路时，先单独确认原任务已结清及网络门禁，通过后逐个恢复原 SSO、Login 单实例；以下不是为了显示 UI 自动执行的依赖启动命令。它们的应用启动/恢复也可能产生写入，先纳入变更记录。

```bash
# 仅在该阶段的 SSO/Login 恢复获批后运行；每个清单保留原卷/证书、replicas=1。
k apply -f "$SSO_MANIFEST"
k rollout status deployment "$SSO_DEPLOYMENT" --timeout=180s
k apply -f "$LOGIN_MANIFEST"
k rollout status deployment "$LOGIN_DEPLOYMENT" --timeout=180s
k get deployment "$SSO_DEPLOYMENT" "$LOGIN_DEPLOYMENT" "$CONSOLE_DEPLOYMENT" \
  -o custom-columns='NAME:.metadata.name,DESIRED:.spec.replicas,READY:.status.readyReplicas'
```

不以 UI 不可用为由盲启旧任务。

管理员进入客户真实 Console URL 的 `/#user-pool`，核对 settings、总数/分页、旧成员验证时间、statistics 和 event。列表默认 25、最大 100 每页；旧兼容 overview/accounts/leases 有截断，不能把某一页/旧数组长度当总量。不按 retry/resume/warmup/创建用户按钮证明迁移；此阶段不会“重验”所有外部 token。

**放行条件**：一个 MySQL Proxy 与 Console 正常、共享数据保留、业务仍关闭、paused 不变、正确 Service 路由、无未经批准的外部任务。用户/客户签认看到的是新 MySQL 环境，而非旧 SQLite UI 或 mock。

## 10. 扩到批准的 3 或 5 Proxy，保留三个 companion 单实例

先核对节点放置、资源/DB 连接预算和可用容量。更新客户受控 desired state 到所选副本数，之后才执行等价 scale；自动化管理时用原 GitOps/Helm 流程，不只做临时命令让它回缩。

```bash
case "$PROXY_REPLICAS" in 3|5) ;; *) printf '%s\n' 'Only approved 3 or 5 replicas here'; exit 1;; esac
k scale deployment "$NEW_PROXY_DEPLOYMENT" --replicas="$PROXY_REPLICAS"
k rollout status deployment "$NEW_PROXY_DEPLOYMENT" --timeout=180s
k get pods -l "$NEW_PROXY_SELECTOR" -o wide
k get pods -l "$NEW_PROXY_SELECTOR" \
  -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName,IMAGE:.spec.containers[*].image,IMAGEID:.status.containerStatuses[*].imageID'
k get endpointslices -l "kubernetes.io/service-name=$EXISTING_SERVICE" -o json \
  > "$PRIVATE_DIR/endpoints-after-expansion.json"
for pod in $(k get pods -l "$NEW_PROXY_SELECTOR" -o jsonpath='{.items[*].metadata.name}'); do
  k exec "$pod" -- node -e \
    "fetch('http://127.0.0.1:3000/readyz').then(async r=>{const b=await r.json();if(!r.ok||b.storage!=='mysql')process.exit(1);console.log(JSON.stringify(b));}).catch(()=>process.exit(1))"
done
```

逐 Pod 核对 mysql readiness、同 SHA/配置/数据库、实际 EndpointSlice、实际节点/故障域；`ScheduleAnyway` spread 只是偏好，不是一定跨节点。每副本 MySQL standby 也应 ready/接流量；**不把非 owner 从 Service 摘除**。SSO/Login/Console 仍各 1、没有共享 SQLite 文件的多个 writer。

通过内部鉴权 `GET /api/user-pool/diagnostics/local` 按**真实实例直达/固定路由**采集，结合第 12 步 writer SQL 确认一个有效调度 owner 与其他 standby。多次调用同一 LB URL不是采集了每副本；本机 owner 是内存观察，最终以新鲜 DB-clock 结果为准。此时库存/计数仍应符合已批准 retention/reclaim 规则，没有无授权新增成员。owner 的出现不等于允许解除暂停。

## 11. 验证已有 Service/LiteLLM 路由后，分开批准业务与补池

以下为客户环境待执行验收，不把上面局部 loopback readiness 当作 Service/网络通过。使用既有批准的集群诊断入口，从实际 LiteLLM Pod 与三个 companion 网络位置验证 DNS 和 `/readyz`。若现有 Pod 没有诊断工具，由客户提供已批准工具/方式，不临时安装、拉起特权 Pod 或绕过 NetworkPolicy。

- DNS/root/path/端口与第 2 步相同；Service 仅新 MySQL Pod，失败 readiness 能真正摘后端，恢复能加回。跨节点连通、LB/mesh、端点更新传播及节点故障试验只在明确批准的等价环境进行。
- LiteLLM 验证 virtual key 后覆写 caller hash，向 Proxy 用正确服务 key；普通 caller 不能直接访问 `/api/*`、`/internal/*` 或携带有效内部 token。Kubernetes Service 本身没有 HTTP 路径 ACL；限制须由既有可信网关/网络/应用鉴权共同承担。
- SSO/Login/Console `PROXY_BASE_URL` 均为同一 Service root，OAuth 成功/失败回调、membership/protection 与管理请求不再指旧 SQLite/单个 Pod；callback 不需要 owner 粘滞。公网 SSO/SAML/浏览器 URL 与证书继续有效。
- 不用 `GET /v1/models` 当无副作用 health probe：catalog 可访问上游并使用池保护；模型/目录真实请求、SSO/seat/Login mutation 都要业务审批。
- 核对 LiteLLM/mesh/LB/client streaming timeout、禁用全量缓冲，支持取消/断连；不自动重放结果不明的请求。某些 Service 本身不负责 HTTP idle timeout，检查真正的网关/mesh/客户端，而不是虚构 Service 注解万能生效。

**业务开闸与解除补池暂停是两项批准**：可以在池 paused 时让既有 Ready 库存承接批准流量；需要补池/repair 时再通过版本化 settings 明确批准 target/cap、席位/账户/模型额度及解除暂停。不得看到 target0 库存不增长就私自改 env 或解除 pause。先以批准的小量客户验收确认业务路径、caller/lease 一致性、stream 完成/取消、统计归属和安全错误；检查失败先关闸，按第 14 步处理，不盲回 SQLite。

### 健康与退出契约（所有滚动/恢复操作都适用）

- `/healthz` 是**进程 HTTP 存活**，不查询 DB；适合 liveness/startup。`/readyz` 检查 storage，MySQL ping 有 5 秒预算，示例 probe timeout=6 秒；不是完整 admission/credential/上游链路证明，不要求本机 scheduler owner。
- 共享 DB 短故障可能让全部 readiness 503；liveness 不应改为 readyz 造成全副本重启风暴。Kubernetes readiness 摘流量，liveness 重启；Docker `unhealthy` 本身不等于自动 on-failure restart。
- 计划终止应先在现有入口停止新 admission，等待实际请求/长流排空及端点传播，再批准 SIGTERM。**当前源码 SIGTERM 后约 25 秒会强制关闭 HTTP 连接**；更长流可能被截断。模板 preStop 10 秒只是传播等待，45 秒 grace 不是“长流无中断”的保证；调大 grace 也不改变源码 cutoff。
- 测量 drain/清理需要的裕量，一次只处理一个已获批副本，保持其他容量并观察恢复。没有产品 drain API，不手工释放 active hold，不修改 owner/fence，不重放不明流来凑成功率。30 秒 owner 任期不是接管 SLA。

## 12. 接入现有运维平台并建立恢复观察

复用 [ops/user-pool-monitor](../ops/user-pool-monitor/) 的可选 one-shot 只读 sampler，不另建服务/平台。客户确认实际 instance allowlist、受控 token 注入、TLS、同步时钟和 writer SELECT collector，再由其既有平台调度（防重叠）。诊断 URL 不经普通 LB伪装成全副本，配置不含凭据；输出不含真实 identity/caller/owner UUID/URL。

```bash
node ops/user-pool-monitor/monitor.mjs "$PRIVATE_DIR/REPLACE_MONITOR_CONFIG.json" \
  --db-observation "$PRIVATE_DIR/REPLACE_ATOMIC_DB_OBSERVATION.json" \
  --previous "$PRIVATE_DIR/REPLACE_PREVIOUS_MONITOR_REPORT.json"
```

DB collector 用独立只读身份执行 [owner-observation.sql](../ops/user-pool-monitor/owner-observation.sql)，读取 **writer** 的 `user_pool_settings`、DB 当前时间与有效任期，不持有旧 transaction snapshot；按[运维说明](user-pool-ops-basics.md#sql-observation-adapter-contract)原子发布带 query-start 时间的观察，失败也必须发布 fresh unknown。sampler 本身不连接 SQL/写 observation，不部署告警。

至少区分进程、每副本 readiness、权威 owner、库存、存储503、耗尽/冷却429、流中断和进程重启：

- local standby/null/失联、DB 查询失败、旧数据都不是“无 owner”。采集不全/陈旧是 **unknown**；连续无 owner 计时只能从连续新鲜有效 DB absent 样本开始，遇 unknown 重置。`collectionComplete=true`/exit 0 是采集有效，不是健康判定。
- 无 owner 时旧 Ready 请求可能继续，但 replenishment/repair 停滞；结合 `ready_idle`、paused/target/cap、失败/冷却库存和流量影响。
- 保留精确 `503 pool_storage_unavailable`、`503 member_unavailable`、`429 pool_exhausted`、`429 member_cooling`；MySQL 集群若出现 `pool_owner_unavailable` 需核对是否混入 SQLite。已经开始 SSE 的错误不能把最初 200 改成503。
- 可从“连续新鲜无 owner 90 秒、unknown 30 秒”等建议起步，但由客户测量后批准阈值/接收人/维护抑制到期，**不是已安装告警或 SLA**。验证告警实际送达、清除及采集丢失时不延用旧绿色结果。
- 使用已有安全 request/call ID 和 backend/版本做关联，不启用 payload/header debug；无共享 ID 就记录仅时间窗相关，不伪造端到端关联。fallback 成功不代表池/DB/owner 已恢复。

运行恢复按[运维 runbook](user-pool-ops-basics.md#4-manual-recovery-and-drainrestart-runbook)：先收集安全证据、修共享 DB/网络/TLS，确有需要才排空单个实例；不因 standby 或一次失联重启整池，不用 SQL 清 owner 强行接管。客户单实例 SSO/Login/Console 恢复、MySQL 备份恢复及可选 HA、Service/节点故障仍须实测签认。

## 13. 迁移后的独立真实 canary：本地结果与客户执行门禁

### 13.1 本地已经执行的结果

本次遵循“先迁移 4 个既有账号→用户看新 UI→确认容量回退→单独批准两名新账号”的顺序。两名新账号真实开通/验证闭环 **114.099 秒完成**；Login 首次尝试均成功，分别 89.236／91.784 秒，两项约 89 秒重叠。原 4 账号 credential/inventory 逐字段未变；该检查针对新增两账号阶段，不表示之后获批真实业务不会正常更新运行数据。canary 完成后共 6 Ready，恢复暂停，没有额外新账号。

用户随后用 4 个 LiteLLM 测试 key 发起的真实请求均 HTTP200 完成，耗时 5,824／4,211／5,264／3,098 ms。收尾快照是 **6 total、4 active leased、2 ReadyIdle、target2、cap6、paused1、lease TTL172800 秒**。测试 key 已撤销；现有 leases 留存，按产品期限/保护规则处理，未为收尾强制 release 或删除账号。历史导入的“2 stats／25 events”属于导入时基准，**不是后续真实请求后的当前统计总量**。

这是本地真实开户/业务功能证据，不是客户租户授权、全部模型/长流容量或端到端 LB/HA 证据。本地 Console 使用 Proxy1 直连，没有 LB；另一个合成环境的 3/5 副本 HA 证据不能挪用到本次真实流量。首次链路准备的本地端口/relay 修正也不是客户 Service 变更。不得因本节通过而省略客户第 2、10、11 步。

### 13.2 客户若另行安排两账号验收

此动作**不是数据迁移隐含步骤**；客户自己批准其真实租户、账号/席位数量和模型预算后执行，已迁移账号无需重新开户才能完成数据校验。

1. 明确新 MySQL 多 Proxy＋原单实例 SSO/Login/Console 的实际环境，客户先查看新 UI 与保留数据；私下固定真实 URL/租户/账号范围，对外只用安全标签。
2. 核对真实 settings。若也是原 4 成员＋新增 2，则批准 cap=6 且关闭其他创建入口/并发活动；不能保留 cap5 假装可创建 2，也不能把 target=2 解释为“再新建两个”。target 是**未绑定 Ready 库存目标**，须依据当前 idle/leased/provisioning/failed 与累计创建数计算，状态改变则停止重审。不要默认所有客户都有相同 4 个旧成员。
3. 初始保持 paused，核对旧 Login 浏览器/SSO/SCIM/席位/OAuth 结果已结清，客户所有回调指 cluster Service root。并发值须与已验证 fingerprint 相同；若需改动，先独立执行第 4.3 节维护，不能在 canary 进行中改 hash/并发。
4. 核对真实网络/CA/SSO 签名证书与 Login 浏览器信任链；客户明确批准恰好两个新身份、席位数量、小额模型/代表性 stream 请求上限及停止条件。任何不明外部结果先人工 reconciliation，不删失败行/退槽后自动补第三个。
5. 操作员批准版本化 target/cap/paused 变更后才开始，跟踪**累计新建身份数**而非仅看 Ready 总数；达到两名边界或发生失败/歧义立即停止新的活动并暂停。pause 不证明已派发浏览器已停，仍须核对在途任务。
6. 结束保持 paused，记录真实完成/失败/未完成、原成员保护结果和聚合库存；不将旧成员调用当新账号、不把 mock 结果替换。临时 key 按客户批准流程撤销，lease 保留/到期与 key 撤销分别说明，不擅自删账号/退席位/切回旧数据库。

### 13.3 有界负载实际结果

本地只做获批功能 canary，不在用户电脑做性能测试。最新批准的额外 Azure 隔离负载活动**总上限是 10 分钟（600 秒）**，含该轮负载和恢复观察的统一预算；不得把每个分项各跑 10 分钟、延长至此前 30 分钟、24 小时或多日。到期停止发流并有界收尾，超时/未运行如实记录，不自动补跑。

multihot、修正版stream短测和持续测试均已实际通过，累计482.940秒，结束后子进程、随机数据库及会话清理通过。短测17请求/3周期、持续测试41请求/9周期，均0意外错误；计划取消匹配精确请求/PID和原生关闭证据，hold不泄漏、不错误续租。完整报告及校验值见[额外负载报告](user-pool-final-load-validation.md)。这证明指定合成负载的传输正确性和资源边界，不等于客户真实长流吞吐/SLA验收。

## 14. 回退闸门：旧 SQLite 不是实时备用库

保留旧镜像/卷与备份是恢复材料，不代表任何时候都可 `rollout undo` 或把 Service selector 指回旧 Pod。先关业务、停相关 writer、保留事实，再由回退责任人判定下面的边界：

| 状态 | 允许的决策 |
| --- | --- |
| 尚未向目标写入，仅备份/dry-run | 可按批准流程放弃迁移。核对原受保护源和 companion 配置后恢复原单 Proxy；先恢复正确原 root/卷，禁止两边同服 |
| 导入已明确成功，目标从未发生 **post-import 运行时写入**、无外部动作 | 可在维护状态按批准方案放弃目标，验证旧源/时间经过后的 lease 及任务安全再恢复旧部署；MySQL 保留/销毁由 DBA 单独批准，不自动删库 |
| 首个目标 Proxy/companion 已启动，或任何 startup prune、owner/reclaim、业务/管理/回调写入 | **不能直接返回旧 SQLite 快照**。以 MySQL 为当前一致性来源，优先批准的前向恢复；若必须回退，先备份 MySQL＋companion、核对 credentials/leases/stats/tasks 与外部结果，另行设计/批准一致性恢复或反向迁移 |
| 写入边界不明，commit/rollback 不明，外部开户/席位/Login 结果不明 | 当成可能已写入，保持维护；不重试、不双启、不切旧源，先人工 reconciliation |

当前没有交付通用 MySQL→SQLite 反向同步工具，也不把恢复旧快照当作撤销外部新账号/席位的方法。对已有 MySQL 写入，只回退代码镜像也须核对该版本的 schema/配置兼容性，不能用旧 SQLite 镜像接新数据试错。恢复后只有一个权威 backend；客户批准业务重开与补池重开仍分开。

原 SQLite 失权自动恢复属于未交付的独立工作，回退到 SQLite 时沿用[既有受控恢复限制](user-pool-sqlite-owner-recovery.md)，不承诺自动 HA，也不借迁移引入新补丁。

## 15. 客户最终签收清单与尚待填写输入

以下各项必须实际执行/填实；模板/离线检查通过不能打勾为现场完成。测试、失败/修正、条件 skip、未运行按轮次写入客户私有变更报告，不累加重叠测试数，不记录敏感身份或凭据。

- [ ] 最终完整可取得源码 SHA、集成 legacy/concurrency helper 与本包状态及受影响测试；四服务构建清单、全新 tag、本地 image ID、客户 registry digest/分发和 Pod 实际 imageID。
- [ ] 实际 Rancher context/namespace/controller/GitOps 所属、现有 Service **type**、DNS、selector、port/targetPort、EndpointSlice、跨节点/故障域；无旧 SQLite endpoint、无额外 NGINX。
- [ ] 真实 MySQL8 writer/schema、verified TLS/SAN/CA 挂载、migration/runtime/trigger-definer/monitor 权限生命周期、连接/资源预算、备份恢复与可选 HA 验收。
- [ ] 原源版本/schema、配置不变量、settings/统计保留、维护排空和外部任务证据；完整主文件/WAL/SHM及 companion/证书备份校验与恢复证明。
- [ ] source-only dry-run、必要时精确 legacy 分支审查、源未变、真实 importer 字段/关系/计数/期限核验、失败处理与目标首次 runtime 写入时间。
- [ ] 目标先单 Proxy＋真实 Console 数据核验，再 3/5 MySQL Proxy；paused/target 实际值及 retention/reclaim 的有意变化；SSO/Login/Console 各 1 且保留原卷/证书。
- [ ] 所有 callback/internal root 指同一 Service，SSO 公网/浏览器 URL 保持正确；NetworkPolicy/服务鉴权/caller 信任边界和 Node/浏览器/MySQL 三类证书信任通过。
- [ ] 客户 Service/LiteLLM 精确路由/fallback、安全关联、readiness 摘除、DB 故障不触发全池重启、stream 超时/取消及 **25 秒 SIGTERM cutoff** 已接受；跨节点/长流/恢复按授权实测。
- [ ] 现有监控平台逐副本＋writer collector、unknown/freshness/reset 规则和告警送达已验证；本地 sampler 实测不代签客户集成。
- [ ] 业务开闸、target/cap/解除 pause 各自批准；回退边界/责任人签字，MySQL 与原 companion 的后续备份恢复制度启用。
- [ ] 本地两新账号／四 key 的已执行证据与客户验收记录分开；客户如未执行就写未执行、不要求为签收再开两个账号。临时 key 已撤销/待撤销、lease 留存/到期和最终 paused/target/cap 分别核对。
- [ ] 若采用第 4.3 节并发维护，最终源码包含工具且输入/loopback/停写条件满足；保存完整旧新配置、CAS 及数据保留证据，Login concurrency 另行按受支持流程管理。
- [ ] stream 只有实际执行报告确认后才记通过；最新 Azure 额外负载总预算≤600 秒，不能把 pending 或离线检查当运行通过。

**交付时仍需核对的输入**：本次完整提交SHA及客户可取得的源码渠道；客户批准的构建平台/网络/镜像分发；实际 Service/namespace/控制器/节点拓扑；MySQL writer/CA/权限/备份与连接预算；原 PVC/证书与 private Secret 引用；正式 fingerprint、持久化 settings 与统计策略；客户维护/恢复责任人与业务/告警验收标准。修正后stream实际结果已通过并列于本手册及独立报告，不再作为待执行项。两个本地新账号 canary 已完成，不再列为未执行前置；客户自己的额外真实验收仍需独立授权。私有环境值由客户填写，本文不提供真实凭据、企业 URL 或身份。

**本手册编写的验证边界**：对照现有源码、importer/helper、构建与 Rancher 模板核对命令和契约；没有以编写文档名义运行构建、容器/集群、迁移、GitHub/席位/模型或负载。第 0.2 节是先前已执行结果的分层摘要，其余执行步骤仍由客户/集成人员按批准范围验证。
