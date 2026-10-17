# Docker发布包装与依赖补丁：隔离资格验证

验证日期：2026-10-16至2026-10-17。**结论：固定r3候选的MySQL账号池功能、镜像运行时、限定基线升级/回滚、依赖行为检查通过；不是无条件合并或公开发布放行。** 尚有部署命令兼容与许可证清单问题，已有OS安全门禁也未解除。本轮没有commit/push、合并main、上传Docker Hub或更新客户/Azure部署。

## 1. 被测版本与隔离范围

- 应用固定源码：`ac354ac02725b09ff7eec2607f6a02940f0dfdcf`，单slug SQLite/MySQL版本；不含multi-slug或未提交Models。
- 候选：既有 `ghcp-release-{proxy,console,sso,login}:single-slug-5046bca-amd64-r3`，运行前后核对实际Image ID，未重建或覆盖候选。
- 对照：从相同固定源码、原package-lock和原四组件Dockerfile构建 `ghcp-baseline-{component}:ac354ac-amd64-20261016`。唯一Dockerfile增量是将原Node tag固定到与r3相同digest；保留原npm构建、默认启动和完整运行内容。不是任意客户旧版本或原历史镜像的复刻。
- 固定Node22.23.3，native ABI127，Linux amd64。MySQL实际8.4.11。
- 应用、MySQL和mock在专用internal网络；只有固定目标bridge发布本机loopback端口。每次失败使用新项目/数据卷保留原现场；未删除旧项目/卷、未prune、未更改Docker daemon配置。
- 应用只挂载本轮数据卷、合成证书和只读测试探针，不挂载生产src/dist/node_modules，不覆盖应用镜像CMD、entrypoint或working_dir。
- 实际供给链：Proxy worker → 实际SSO → mock SCIM/席位 → mock Login → Proxy回调 → mock目录/预热。真实Login镜像只做启动、鉴权、零任务及本地Chromium检查，不执行设备授权。

## 2. 最终实际执行结果

| 检查 | 实际结果 |
| --- | --- |
| 原包装四组件对照镜像构建 | PASS；从固定源码通过批准npm feed构建，未执行audit fix |
| 基线 → r3 → 基线，同卷升级和回滚 | PASS，133.117秒，退出0，包括最终停止 |
| r3全新MySQL库、双Proxy账号池供给与协议 | PASS，82.897秒，退出0，包括最终停止 |
| 两种包装的默认启动命令 | PASS；未被Compose命令覆盖 |
| 真实MySQL及账号池 | 三个合成Ready成员、两个独占caller租约；单owner续约、settings CAS、跨副本一致、耗尽拒绝、429不换号/不续租、hold阻止release、取消后排空和约束检查通过 |
| 三协议JSON/SSE | 初始smoke通过；升级后、回滚后各6次成功且统计正确追加；候选全新库再做6次成功 |
| 状态保留 | 切换前后比较settings、账号凭据hash、成员、租约、schema/index/constraint及历史统计逻辑快照；管理员文件/既有会话、SSO用户逻辑内容和证书保持 |
| 生成新统计与继续使用原租约 | PASS；每阶段6条新增统计正确绑定caller/member/lease，未重建原租约，mock无重复供给 |
| 新进程owner接管 | PASS；等待owner不同于停止前旧owner后，验证其后续续约，不把未到期旧记录当新owner |
| 各组件共享包与SQLite native | PASS；镜像自己的ESM共享包可加载；每个应用镜像实际创建mounted临时SQLite，WAL、STRICT、事务回滚、关闭/重开、integrity_check通过 |
| Console | 首页和实际JS资源通过；管理员文件与已签名session跨升级/回滚有效 |
| SSO | metadata、合成证书及3个合成用户保留；没有真实SAML联邦登录 |
| Login | Chromium在三阶段实际启动/渲染本地HTML并关闭；任务始终0，未鉴权tasks返回401 |
| r3运行层 | Tini PID1、无npm进程/运行包、组件cwd正确 |
| r3停止（升级回滚轮） | Proxy和Proxy2均0，Console/Login/SSO均143，OOMKilled=false；不等于任意在途任务完整drain证明 |
| 旧包装停止 | 实测npm包装容器退出1，OOMKilled=false；作为旧基线观察记录，不记为r3优雅退出通过 |
| 依赖补丁镜像内对照 | PASS；基线和r3均退出0，见下 |
| 旧模板根目录相对命令 | **确认不兼容**：r3中返回MODULE_NOT_FOUND；功能通过不代表drop-in门禁通过 |
| 真实GitHub/EMU/席位/模型/客户数据/Azure操作 | NOT RUN |

每个协调运行上限600秒，单Docker命令不超过120秒；没有性能基准、长期压测或容量承诺。未运行32成员完整lifecycle、全部故障恢复矩阵、MySQL HA或真实设备流。成功scope不能扩写到所有部署组合。

### 依赖补丁的对照内容

实际读取并核对镜像内包版本：

| 包 | 对照 | r3 |
| --- | --- | --- |
| multer | 2.3.0 | 2.4.0 |
| proxy-addr | 2.0.7 | 2.0.8 |
| brace-expansion | 1.1.18 | 1.1.21 |

在两只独立network-none容器中，探针仅从镜像自己的node_modules加载依赖，用loopback Express验证正常上传200、超限LIMIT_FILE_SIZE、缺boundary畸形请求400；另验证可信/不可信代理地址解析与brace组合展开。它不是生产应用上传接口验收，也不是安全利用PoC。未因测试成功删除安全扫描结果。

## 3. 实测发现与失败保留

1. 首次clean-env缺Windows ProgramFiles/ProgramData，Docker CLI找不到Compose插件，在创建资源前退出。补回系统路径变量，不加载部署env/凭据。
2. 初次镜像内探针用CommonJS require.resolve访问ESM-only共享包，导致ERR_PACKAGE_PATH_NOT_EXPORTED。改为读取镜像包的import export并实际ESM import。不是应用启动失败，生产镜像未变。
3. 一次升级在健康和逻辑快照后未完成owner检查，原记录只有泛化失败；后续新增只写私有日志的诊断，未将不完整结果记PASS。
4. 新项目创建遇到默认Docker地址池耗尽。核对Docker网段和host路由后，为本次新网络显式指定不重叠私有网段，内部应用仍仅internal。没有删除历史网络、改全局地址池或防火墙。
5. owner探针误把仍有效的旧数据库owner租约当作已启动的新owner。修正夹具为先确认owner发生更换，再验证续约；保留原失败，未改生产30秒TTL或放宽产品断言。最终升级/回滚通过。
6. 所有尝试在失败或成功后仅停止本项目服务，保留数据卷与日志。最终dependency探针容器已自行退出；不删除旧资源。

最终成功状态是各自独立run的结果，不把失败重跑累计为额外业务覆盖。

## 4. 合并前及发布前仍需处理

### 4.1 旧部署命令不兼容（已实测）

[release Dockerfile](../deploy/images/Dockerfile.release)把Proxy工作目录设为 `/app/src/proxy`，而现有 [MySQL客户部署模板](../deploy/user-pool-mysql-customer/) 的部分工作负载覆盖为 `node src/proxy/dist/index.js`，未设置workingDir。新镜像中会解析成重复目录并报MODULE_NOT_FOUND。

默认CMD已经健康。本轮没有擅自修改客户模板：应审查并移除旧command覆盖，让Tini＋默认Node启动生效；若使用绝对命令需明确Kubernetes command会替换ENTRYPOINT，可能绕过Tini。npm命令覆盖在精简镜像也不能沿用。不能只恢复根cwd而忽略各服务相对数据、静态资源、日志和证书路径。

### 4.2 许可证清单元数据（静态发现，尚未修复）

[打包脚本](../deploy/images/package-runtime.mjs)只读pkg.license；部分依赖如busboy使用legacy licenses数组，生成清单会丢失其已提供的许可证类型。已有license文件仍复制保留。需补齐清单兼容并测试；如改变包装产物，生成新候选并重新核对，不把旧r3审计冒充新产物。

### 4.3 系统安全门禁

既有r3扫描仍为Proxy/Console/SSO各6条high、Login8条high、0critical；本轮未重新扫描/重新确认vendor状态，不把功能测试当安全修复。详见[发布验证报告](user-pool-image-release-validation.md)。

**当前不建议直接合main或发布。** 功能/升级资格已补上，但模板兼容与清单修正还需相应验证；公开镜像另受最终产物安全扫描和分发门禁限制。

## 5. 本地证据与版本身份

原始日志、详细SQL/hash快照、合成凭据和证书均仅位于ignored `.claude/`，不提交到公开仓库。最终成功证据：

- 升级/回滚：`release-qualification-20261016-run-033c0eac-540a-491d-b0d1-e05bea245d2b/qualification-report.json`。
- r3全新供给：`release-qualification-20261016-run-b3ff6a97-7169-4e85-8c81-52a95c6a53fa/qualification-report.json`。
- 依赖行为：`image-dependency-qualification-20261016.json`。
- 基线镜像：`image-baseline-source-20261016.json`、`image-baseline-build-result-20261016.json`及四份build日志。

r3的实际Image ID仍是原已审计的四个ID；基线ID和本轮证据/fixture哈希在本轮manifest另存。证据run包含当时复制的探针，后续tracked夹具修正不代表早前运行执行了新逻辑；依赖行为由单独实际完成的dependency报告证明。

测试启动均通过preview工具的受控本地HTTP入口，未使用Bash启动服务器。没有真实凭据/客户prompt/数据库进入构建上下文，没有commit/push、main合并或Docker Hub公开发布。
