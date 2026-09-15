# 客户自行构建与Rancher/MySQL交付草案

**模板，不是可直接上线的客户最终配置。** 未执行客户镜像构建、Rancher部署、真实账号写入或客户迁移。请先看[四阶段闭集计划](../../docs/user-pool-delivery-plan.md)。我们交付固定源码与构建规范，**不向我们的registry发布镜像**；客户沿用其SQLite部署时的源码自建方式。

## 包内文件与边界

- `build-images.mjs`：显式完整Git commit，默认只读预览；只有 `--execute-build` 才构建四服务并记录本地image ID。使用Node内置模块、Git和已安装Docker，无安装脚本、fetch/checkout、容器启动、push或迁移。
- `rancher.template.yaml`：Proxy Deployment/ClusterIP Service/两个ConfigMap。复用既有单实例SSO/Login/Console、外部MySQL、secret、CA和卷；没有新数据库、入口控制器或新监控平台。
- `package.test.mjs`：有限离线契约检查，不连接Docker、MySQL、云或真实服务，不执行构建。

本地真实SQLite数据已在另行授权下迁入MySQL三副本，新UI核对后两个新账号及四把virtual key功能验证均通过；结果见[客户迁移手册](../../docs/user-pool-customer-migration-guide.md)和[真实迁移报告](../../docs/user-pool-real-mysql-migration-validation.md)，不等于客户现场已执行。旧17704是SQLite，新本地MySQL UI为17714；本地直连Proxy1，不是客户Service/LB验收。合成负载/性能运行仅在获准Azure隔离VM，最新活动累计上限**600秒**；本机不做性能测试，不安排24小时或多日长测。

## 1. 客户必须先填写/核实

| 项目 | 要求；未满足时保持未批准 |
| --- | --- |
| 源码 | 最终完整40位commit SHA、可取得的源码交付渠道、审查记录；不要跟随分支最新HEAD。当前已测基线 `5ea75af7ac0000b37758efd751a606ea86010a00`，其生产源码是v5 `356f8f5e33a21ccfe7cf8c5db07060ab1ac47846`；后续最小修复应重新固定SHA |
| 构建 | 客户已安装Node/Git/Docker、获准网络/包源、目标CPU平台、资源与构建日志保存路径；本包不安装工具或改变宿主配置 |
| 产物 | 四个服务实际本地image ID；客户内部镜像分发方式；若有内部registry，另记它返回的manifest digest及Pod实际imageID，不混同本地ID |
| Rancher | 目标集群/namespace、节点分布、CPU/内存预算、所选副本数（草案3）、Service可达性、可信网关/内部调用路径、TLS和网络访问策略 |
| MySQL | 专用MySQL8/InnoDB写主库、同一DB、权限、连接预算（3副本默认30连接，rollout第4副本40，另留运维/迁移余量）、可信CA实际挂载、备份/恢复；仅采用HA时增加该实际主库切换演练 |
| 既有服务 | SSO/Login/Console各1实例；原镜像/卷、证书、管理员、session secret、SSO公开URL及Login浏览器可达SSO URL；统一内部Proxy root；不得重建空卷 |
| 池状态 | 真实driver、source schema、domain/model和全部fingerprint不变量、持久化paused/target/cap/lease、外部任务及统计保留策略；env不能覆盖已有settings |
| 验收 | 先授权客户等价环境，明确维护/恢复责任人、负载/SLO及失败停止条件；没有生产故障注入授权时不能停止唯一生产Pod/节点 |

所有 `REPLACE_*` 只在客户私有副本中替换。不要提交真实secret、URL凭据、账号、caller hash或数据；ConfigMap不放API_KEY、MYSQL_URL或INTERNAL_API_TOKEN，模板只引用现有Secret key。

## 2. 固定源码构建：构建不是启动

在包含所选commit的独立源码checkout中执行，提供新的、已有父目录下的**绝对输出路径，位于checkout之外**。脚本拒绝短SHA、分支名、已有输出路径和未知参数。它将指定commit用 `git archive` 直接作为Docker tar build context，不构建当前未提交更改或把工作目录里的 `.env`/客户文件当作上下文；仍须审核固定commit本身没有秘密。

仅规划，不调用Docker、不创建输出：

```sh
node deploy/user-pool-mysql-customer/build-images.mjs --commit <FULL_40_HEX_COMMIT> --output <NEW_ABSOLUTE_OUTPUT_DIR> --image-prefix customer-ghcp --platform linux/amd64
```

客户批准构建后，同样参数加 `--execute-build`。脚本复用 `src/sso/Dockerfile`、`src/login/Dockerfile`、`src/proxy/Dockerfile`、`src/console/Dockerfile` 和 `package-lock.json`；不改Dockerfile、不增加依赖。现有Dockerfile在镜像内执行 `npm ci`；Login还安装Chromium及系统依赖，因此**构建需要批准的下载网络，不是离线构建，也不是在宿主安装依赖**。失败不自动重试，输出目录保留部分证据，下一次需新目录。

生成的 `build-manifest.json` 包含：完整commit、源码tar与构建脚本hash、输入文件hash、Docker/Node版本、平台、Dockerfile的FROM引用及四个本地image ID。输出状态只有 `built-locally-not-deployed` 才表示四服务均构建完成，不等于运行验收。`customerRegistryManifestDigest` / `rancherRuntimeImageId` 默认null，须客户分发/部署后补实际值。

**可重复性限制**：当前Dockerfile的 `node:22-bookworm-slim` 是可变tag，Login系统/browser包也不是完全固定的构建来源。脚本记录FROM文本但不捕获所有已解析base digest，不声称bit-for-bit可复现，也不声称历史开发者镜像digest等于客户构建结果。客户应保留构建日志/产物，在维护前构建并固定这些实际产物，不在cutover时重建。若客户要求字节级可复现供应链，这是另一个需批准的目标，不擅自改变此闭集源码。

此脚本不运行Compose、不创建应用容器、不使用部署env、不访问应用DB、不迁移、不push。客户如使用自己的registry/节点导入流程，应自行授权执行并记录其返回的引用；不要填写不存在的 `@sha256:...`。镜像分发后的平台/四服务版本及Pod imageID必须核对。

## 3. Rancher模板使用门槛

### 默认封闭，不虚构paused环境变量

草案Deployment默认3副本，但 `require-approved-paused-database` init容器会因 `CUSTOMER_PAUSED_DATABASE_APPROVED=BLOCKED` 退出，**主Proxy不会启动**。这只是显式操作员门禁，不读取或写入MySQL，不证明数据库已暂停；不要把它称作自动零副作用初始化或新的产品功能。即使误apply仍会创建Kubernetes资源，故模板也不是可随意apply的只读文件。

真实产品没有 `POOL_PAUSED` 启动env。`READY_IDLE_TARGET=0` 只影响首次seed；导入工具强制paused=1但保留源target，已存在池忽略env target/cap/lease。**启动前私下验证实际持久化paused=1、target=0、外部任务状态及全部fingerprint**，通过后操作员才可在私有配置将门禁改为 `"true"`。解除此门禁也不代表授权解除pool暂停或开放流量。

- 现有SQLite池迁移：先在源的受支持管理流程中获准设置paused和target0、排空，再执行下面的离线迁移；importer保留target并强制目标暂停。目标在所有Proxy启动前核对。
- 新空库：不存在paused settings时，不能声称已满足上面的门禁。按[现有实施文档第4节](../../docs/user-pool-mysql-implementation.md#4-新建空池的启用顺序)安排**单独批准的一副本、target0、业务关闭的bootstrap**；该过程会初始化/写入DB。通过现有Console/版本化API设置paused1，核对后再使用多副本模板。不要手写settings、伪造ready账号或靠模板初始化真实业务。
- 不连接旧SQLite、未知MySQL或已有未暂停池试运行。门禁一旦放行，真实主程序启动可执行schema迁移、统计裁剪、owner/reclaim等写入，即使paused也不等于只读启动。

### 配置和探测契约

1. 默认3仅是草案；先将客户选定副本数和跨节点分布固定。已有3/5独立进程测试不证明Rancher跨节点HA或吞吐。迁移首次实际启动按一副本验证，验证后才扩至所选副本数。
2. `Service` 是ClusterIP、无sticky session，不是公网网关。客户现有可信网关验证virtual key并覆盖用户身份头，再使用Proxy服务密钥；禁止把内部管理口或凭据开放给普通caller。已有网关/NetworkPolicy必须限制业务和内部路径、客户端及出站访问。此包不创建入口控制器或通用网络策略。
3. `/readyz` 已存在：存储ping有5秒预算；模板probe timeout6秒，不按本机owner摘除MySQL standby。`/healthz` 已存在：进程HTTP存活、无DB访问；liveness不使用DB就绪探测，避免短DB故障的全副本重启风暴。startup probe预算/重启退避仍需客户实际环境验证。
4. 显式 `node src/proxy/dist/index.js` 沿用现有编译入口，让node接收SIGTERM。preStop的10秒只是endpoint传播等待，不是完整drain API；45秒grace留给等待与关闭。**现有源码SIGTERM后约25秒强制关闭HTTP连接**，更长流仍可能被截断。先由现有入口停止新admission并观察流排空，再批准终止；不要凭模板宣称无中断rollout。LB idle timeout必须覆盖批准的流长，关闭全量缓冲，不自动重放不明结果。
5. 单一共享MySQL写端点、verify-ca、CA只读挂载；不能连接只读副本或将required误当证书验证。所有Proxy/importer使用相同fingerprint不变量；模板并发值只是草案，迁移必须以实际批准值替换，不能直接改env绕过不一致。
6. 将companion-routing中的 `PROXY_BASE_URL` 合并到**既有**SSO/Login/Console，保留其余所有设置/secret/卷并保持各1实例；同namespace的 `http://ghcp-pool-proxy:3000` 不带 `/api`。跨namespace需改为实际Service DNS并验证可达。
7. resources、secret名、namespace、镜像、CA、域名/模型等占位未替换时，不是有效部署。先在客户工具中做离线schema检查，再在授权的预生产环境做server-side验证和实际路由/恢复验证；离线语法通过不能代替AdmissionPolicy/Rancher验收。

## 4. 备份、迁移、回退：明确与构建分开

本包不提供一键部署/迁移脚本，避免将不可逆动作夹在build中。复用[实施文档第6节](../../docs/user-pool-mysql-implementation.md#6-现有-sqlite-caller-lease-池的离线迁移)及[专用pool importer](../../upgrade/user-pool-mysql/README.md)，不使用旧direct importer代替。

1. **先核实源**：受支持caller-lease SQLite池、真实schema与原版本；direct账号自动纳管或未知自定义schema不属于本次迁移。不得将旧localhost真实SQLite当已批准源。
2. **先备份和恢复演练**：保留原Proxy数据、SSO/Login/Console数据/日志、签名证书、配置/secret引用、原实际镜像ID。保护完整原始SQLite目录/WAL；为importer另作一致的独立离线备份，不把运行main文件单独复制或删除sidecar。备份可恢复的证据先于切换。
3. **维护并排空**：pause不是流量闸门，也不证明Login浏览器停了。关闭业务admission，排空inference/catalog、已派发SSO/SCIM/seat/Login及回调；不明外部结果先核对。停止所有源writer/scheduler和能回调的写服务，绝不清nonce/hold骗过导入检查。
4. **离线source-only预检**：专用工具的 `--dry-run` 只查受控离线副本，不连MySQL。通过不是目标已验证或外部任务已停止的证明。
5. **独立批准的目标写入**：专用空MySQL、目标应用全停、安全注入MYSQL_URL/CA及正式fingerprint，确认offline source与empty target后才运行importer。DDL/seed失败可能残留；`commit_outcome_unknown` / `rollback_unconfirmed` 时保持维护、不盲重试或切回源，私下核对。
6. **一副本验收后扩容**：目标保持paused，业务关闭；确认统计保留策略、库存/凭据/租约/期限、storage=mysql、真实Service路由、原单实例服务及卷。再扩到客户批准副本数；解除暂停及开放业务均需单独放行。
7. **回退边界**：源和目标不同时接流量。目标尚无post-import运行时写入时才可按批准维护流程放弃切换并返回受保护源；启动统计裁剪/owner/reclaim也算写入。已有写入或无法确认边界时不能直接切旧SQLite，需要一致性核对/另行回退计划。外部新增账号/席位不是数据库恢复能撤销的变更。

SQLite旧版失权自动恢复仍未实现；过渡期/回退需保留取证与受控恢复步骤，不把它列为本次MySQL前置开发。SSO/Login/Console单实例故障恢复、客户Rancher实际节点故障和MySQL/TLS/可选HA验证仍须客户环境，不能凭此草案写成已部署运维完成。

## 5. 交付记录模板

在客户私有变更记录中填写，不把实际secret或客户数据提交到本仓库：

- 固定源码SHA、构建脚本/源码归档hash、四服务本地image ID、平台、构建日志位置；内部仓库manifest和Pod实际imageID如实另记。
- 已审核配置revision、namespace/节点/所选副本、MySQL写端点与CA校验、连接/资源预算、网关路由与超时、告警规则/接收人。
- 备份校验与恢复演练结果、source schema与状态、维护窗口/责任人、迁移实际结果及写入边界、回退决定。
- 实际UI URL和用户确认记录、真实driver/source/副本数、两个新账号授权与执行结果（未执行就写未执行）；合成负载执行位置/共同600秒授权预算和结果另列。
- 待客户确认的变量、未做的目标环境验收和已接受运行限制。**所有空项填实并完成目标验收前，不标“最终客户可用”。**

## 6. 本包已执行的有限检查（2026-09-15）

- `node --check deploy/user-pool-mysql-customer/build-images.mjs`：通过。
- `node --test deploy/user-pool-mysql-customer/package.test.mjs`：**6通过、0失败、0skip，约1.12秒**。包含真实只读plan调用、固定commit的lockfile SHA-256比对、未创建输出目录、参数拒绝、四服务构建参数和现有探测契约。没有执行 `--execute-build`。
- 使用已安装PyYAML6.0.2离线读取模板：**4个YAML文档通过**；检查重复key、ConfigMap字符串值、Deployment/Service结构及selector/port匹配、默认3副本、存储readiness/进程liveness、阻塞init门禁。
- `git diff --check -- docs/user-pool-delivery-plan.md deploy/user-pool-mysql-customer`：未报告空白错误。新增未跟踪文件的内容仍由上述语法/契约检查覆盖，该命令本身不等于完整新增文件审查。
- **本构建/模板工具未执行**：`--execute-build`实际构建、镜像push、Kubernetes OpenAPI/server-side校验或客户Rancher部署。另行执行的本地四服务Dockerfile构建、真实数据库迁移/UI、两账号和四key功能结果在对应报告中记录，不能误写为客户模板已部署。模板占位值故意未填；结构检查不是客户集群schema/准入策略或生产运维验收。
