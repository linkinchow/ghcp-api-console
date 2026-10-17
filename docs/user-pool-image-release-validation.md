# 四组件 Docker Hub 首次发布准备与验证记录

状态（2026-10-17）：**r4（源码 `164cade`）已发布到 Docker Hub 公开仓库**，digest 见 [升级指南](user-pool-release-upgrade-guide.md)。发布前完成功能、升级/回滚、全新库与 GHE.com mock 全链路验证；基础镜像系统包告警已按用户决定记录风险。发布后匿名按 digest 校验：四个清单的配置摘要均等于被验证的本地镜像 ID，平台 linux/amd64；Proxy 拉取后离线启动健康、停止退出 0。 r3 及更早记录保留在第 1–7 节，作为历史证据。

## 0. 当前候选 r4

### 0.1 与 r3 相比的变更

| 变更 | 说明 |
| --- | --- |
| 合并上游 `c8715cb..a64b92d` | GHE.com（`GITHUB_BASE_URL`）、SSO OOM 修复与异步密码哈希、席位 pending_cancellation、管理/运维批量接口、MySQL 低权限模式、无席位用户删除修复。 |
| 合并时的安全适配 | 异步默认密码识别（旧写法会永远返回第一个候选）；账号池保护覆盖上游新运维路径；MySQL 新查询沿用带超时的连接租用；低权限模式改为只读完整 schema 校验；`scripts/proxy-mysql-initial.sql` 由 schema 生成并有漂移测试。 |
| 四服务优雅停机 | 共享 `installGracefulShutdown`：排空在途请求（含 SSE），超过 `SHUTDOWN_TIMEOUT_MS`（默认 25 秒）关闭连接，释放存储后退出 0；二次信号或释放卡住时退出 1。compose `stop_grace_period: 35s`。 |
| 镜像定义统一 | 删除四个旧 `src/*/Dockerfile`；compose、客户构建脚本、测试 compose 统一使用 `deploy/images/Dockerfile.release`。默认 npm 源改为公共 npm，我方构建显式传入公司源。 |
| 部署命令兼容 | k8s/rancher 模板去掉 Proxy 的 `command` 覆盖（它会绕过 Tini）；镜像保留废弃的兼容入口，旧覆盖仍能启动。 |
| 许可证清单 | 兼容旧式 `licenses` 数组和 `license` 对象；r4 构建中 184 个生产依赖均识别到许可证。 |
| Console Models 页面 | 用配置的企业管理员 token 查看 Copilot 模型目录，绝不回退到账号池账号；见 [Models 使用指南](models-admin-guide.md)。 |

### 0.2 构建

四个镜像均以 `git archive 164cade` 的干净源码为构建上下文，`linux/amd64`，基础镜像按 digest 固定。仅本地 tag `ghcp-release-<组件>:single-slug-164cade-amd64-r4`，未推送。

| 组件 | 本地 Image ID |
| --- | --- |
| Proxy | `sha256:4f6a96d44fec31d85fc4cbadfeee20b02f39312c4d67663ac6958f9e228f368b` |
| Console | `sha256:c47daade0588506aebe936b13f938bcb13e6d62f6dbb6c46fe86a7a60497e26f` |
| SSO | `sha256:ef5e6efe5dcdc1bb6a269161175e2ccbc5adafe272b17ddaffc13d01d626143e` |
| Login | `sha256:d6c1a938b466386faf27a28921413444f5ded685edec8b665ae4bb1589383f21` |

镜像比 r3 大约 32MB：上游把前端图标库 `lucide-react` 放在根依赖，随生产依赖进入运行层。不影响功能。

### 0.3 已执行的验证

| 检查 | 结果 |
| --- | --- |
| 类型检查（全部 workspace + upgrade 工具） | PASS |
| 单元测试 | shared 6/6、SSO 56/56、Login 26/26、Console 15/15、Proxy 558 通过 / 28 跳过（需真实 MySQL）/ 0 失败、部署脚本 9/9 |
| 基线 `ac354ac` → r4 → 基线（真实 MySQL 8.4、双 Proxy caller-lease、同一数据卷） | PASS：账号、凭据、成员、租约、MySQL schema 升级与回滚前后一致；SSO 原有表、列、行全部保留（只允许新增列与追加迁移记录）；JSON/SSE 协议与请求统计绑定正确；调度 owner 正常接管续约 |
| r4 全新库供给 | PASS |
| r4 停止退出码 | 两轮中五个服务（含双 Proxy）全部 **0**（r3 时 SSO/Login/Console 为 143，基线 npm 为 1） |
| 旧模板启动命令（`--entrypoint node`，无 Tini，离线 SQLite） | 能启动；`docker stop` 退出码 0 |
| 运行时检查 | Tini 为 PID 1、无 npm、工作目录、依赖版本与行为、better-sqlite3 WAL/STRICT/事务、Login 内 Chromium 渲染本地页面、真实 Login 任务 0 |
| Console Models 页面 | Browser 预览实测：渲染、Messages 过滤、详情、过期提示、错误提示、刷新；名称中的 HTML 按纯文本显示 |
| Console 浏览器测试（本机 Edge，串行） | 61 项。合并后发现并修复 3 处测试与新 UI 不匹配（请求统计改为服务端分页、失败详情改用 RequestFailure 组件、managed list 的错误文案）。之后三轮完整/分组运行中每一项都至少通过一次；剩余失败均为本机偶发超时（如 `page.goto` 8 秒），失败项每轮不同。未在 CI 级稳定环境复测。 |


#### GHE.com 模式（mock 全链路，2026-10-17）

`tests/image-release/ghe-compose.yaml`：r4 四个镜像中的 SSO、Login、Proxy 均配置为 GHE.com 模式（`GITHUB_BASE_URL=http://fixture.ghe.com:8002`），存储为 SQLite，账号池为 caller-lease 模式。mock 在内网中扮演 `fixture.ghe.com`（网页与 OAuth 设备授权）、`api.fixture.ghe.com`（SCIM、席位）和 `copilot-api.fixture.ghe.com`（Copilot）。**真实 SSO 担任 SAML IdP，真实 Login 用镜像内的 Chromium 完成设备授权。**

| 检查 | 结果 |
| --- | --- |
| 账号池自动开户直到 ready（SSO → SCIM → 席位 → Login → 令牌回调 → 预热） | PASS |
| 设备授权请求发往 GHE 主机，使用默认 OpenCode Client ID | PASS |
| SSO 的 SAML 响应：Audience = `<GITHUB_BASE_URL>/enterprises/<slug>`，Destination、InResponseTo 正确，带签名，NameID 为账号 | PASS |
| SCIM 登录名无 shortcode 后缀（配置的 `ENTERPRISE_SHORTCODE=test` 被正确忽略），不超过 30 字符；席位分配给该登录名 | PASS |
| SCIM 与席位请求只访问 `api.fixture.ghe.com`，Copilot 请求只访问 `copilot-api.fixture.ghe.com` | PASS |
| 调用方推理请求由经 GHE 授权的账号令牌提供服务 | PASS |

另外，上游的 GHE 浏览器流程测试（`ghecomFlow`）已在 r4 Login 镜像内用镜像自带的 Chromium 离线运行，通过。

**范围限制**：GHE 网页由 mock 模拟，结构按上游测试的页面编写，与真实 GHE.com 页面可能不同；OpenCode Client ID 能否在真实 `*.ghe.com` 上使用、真实 `api.<子域>.ghe.com` 的行为，都**未在真实环境验证**。

资格验证报告：`.claude/release-qualification-run-d5bac5e1-7465-403b-809e-b85bd17a4efc`（升级/回滚）、`.claude/release-qualification-run-a5617312-a79a-4ce4-a3ae-8b7ef9ee258e`（全新库）。

验证过程中修复的问题（均为测试工具或测试夹具，非产品代码）：

1. mock 的席位列表缺少 `pending_cancellation_date`，且没有成员席位查询接口；上游新 SSO 会因此报错。按 GitHub 文档补齐（成员接口同样返回 `{ total_seats, seats }`）。
2. bridge 健康检查写死了 r3 的项目名。
3. 失败清理时，日志读取超时会跳过停止容器；现在日志失败不影响停止。
4. Docker Desktop 负载高时出现超时（基线 smoke 偶发 500、运行时检查超时、MySQL 观察连接被 bridge 的 120 秒空闲超时断开）。放宽了对性能敏感的超时并在使用前重连观察连接；按"Docker Desktop 只测功能"的原则，不据此判断性能。

### 0.4 安全门禁与风险记录

Docker Scout（critical/high）：Proxy、Console、SSO 各 **8 条 high**，Login **10 条 high**，全部 **0 critical**。全部来自基础镜像的 Debian Bookworm 系统包，Debian 均标注尚无修复（`not fixed`）。npm 生产依赖 `npm audit --omit=dev` 为 0。

**用户决定（2026-10-17）：记录风险后发布；Debian 发布修复后重建并发布新版本。** 每个候选仍须扫描；出现 critical、npm 应用依赖的 high、或已有修复的系统包告警时，必须修复后重建，不能只记录。

可达性依据为在 r4 镜像内实际核实（离线容器）：`ldd /usr/local/bin/node` 不链接 libssl/libz，Node 使用自带 OpenSSL 3.5.8 与 zlib 1.3.1；Login 的 Chromium 动态链接系统 libexpat 与 libz，但不链接 libssl（使用自带 BoringSSL）。

| 包 | CVE | 涉及镜像 | 触发前提 | 本应用中的情况 |
| --- | --- | --- | --- | --- |
| util-linux | 2026-53613、78409、78410、76642 | 全部 | 本地低权限用户 + fstab 中 `user`/`users` 或 `X-mount.*` 授权条目，利用 setuid `mount` 的路径竞态 | 镜像无此类 fstab 条目，进程以 root 运行且从不调用 `mount`；容器内无其他本地用户。不可达。 |
| util-linux | 2026-78408 | 全部 | 特权操作员对攻击者控制的目标执行 `nsenter --join-cgroup` | 应用与部署流程不调用 `nsenter`。不可达。 |
| util-linux（libblkid） | 2026-53615 | 全部 | 探测攻击者构造的磁盘镜像或可移动介质的分区表 | 应用不探测块设备。不可达。 |
| perl | 2026-82560 | 全部 | 用 Pod::Text 格式化恶意 POD 文档 | 应用不运行 perl；perl-base 为 Debian 必需包。不可达。 |
| zlib | 2026-85091 | 全部 | 非阻塞 `gzwrite` 停顿后调用 `gzprintf`（gzip 文件写入 API） | Node 不使用系统 zlib。Login 的 Chromium 加载系统 libz，但该缺陷位于 gzip 文件写入接口，并非网页内容解压路径。可达性低，记录为已知风险。 |
| expat | 2026-77214 | Login | 调用方向 `XML_ParseBuffer` 传入未校验的长度（API 误用） | Chromium 加载系统 libexpat（主要经 fontconfig 读取本地字体配置）。触发需要调用方误用 API，不是由网页 XML 内容直接触发。记录为已知风险。 |
| openssl（libssl3） | 2026-84782 | Login | DTLS 重传路径 | Node 与 Chromium 都不链接系统 libssl；应用不使用 DTLS。不可达。 |

以上为基于缺陷描述和实际链接关系的工程判断，不是形式化 VEX 证明。Login 的 Chromium 只访问 GitHub 与配置的 SSO 页面，并只在完成授权任务时运行。

### 0.5 发布前剩余步骤

1. 本轮改动（Dockerfile 默认源、验证脚本、浏览器测试）提交后，以最终提交重新构建候选并完整复跑本节验证；发布的必须是被验证的同一产物。
2. 用户确认后：PR 合入 main → 推送 Docker Hub → 按 digest 重新拉取验证 → 更新客户升级指南路径 A。

---

以下为 r3 及更早的历史记录。

## 1. 已批准的发布范围

- Docker Hub公开仓库：`linkinchow/ghcp-proxy`、`linkinchow/ghcp-console`、`linkinchow/ghcp-login`、`linkinchow/ghcp-sso`。
- 平台：Linux amd64。
- 用户确认已获得向客户分发授权；没有在仓库添加虚构上游license。第三方依赖许可证保留在候选node_modules中，并生成生产依赖license清单。
- 用户已通过终端完成Docker Hub登录，凭据由Docker Desktop credential helper保管；聊天、源码、build args及报告不保存密码或PAT。
- 本次准备单slug SQLite/MySQL版，不含多企业／Models，不用于旧PostgreSQL应用。
- 本次`output_config`修复客户仍**只升级Proxy**。四镜像是独立交付，不要求每次全套升级。

## 2. 源码与包装变更

- 当前准备分支：`release/proxy-dockerhub`，基于已合并main `ac354ac02725b09ff7eec2607f6a02940f0dfdcf`。
- 应用协议修复提交：`5046bca934c6e2b6de66510ff3133d68f34eba58`。
- 干净构建上下文从固定commit archive导出，不含Git、真实env、客户Excel／截图、诊断文件或本地数据库。
- 新 `deploy/images/Dockerfile.release`、`package-runtime.mjs` 为未提交的包装增量；不能声称它们存在于旧源码commit内。
- 正式运行层只复制目标组件dist和shared dist，排除应用测试、TypeScript源文件、其他服务源文件。pool姓名JSON保留。
- r2候选从运行层移除npm/Yarn/corepack，以Node直接运行；工作目录保持原workspace启动时的组件目录。r3加入Tini负责信号转发和子进程回收。原客户 `src/*/Dockerfile` 不修改。
- root运行权限沿用原基线，本轮未声称完成nonroot加固；数据目录权限、Secret与证书继续由部署挂载管理。
- Login安装与锁定Playwright匹配的Chromium及系统依赖；没有把真实浏览器授权或设备流资料带进镜像。
- 基础Node22 bookworm slim固定linuxamd64manifest：`sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562`；实际Node22.23.3。

生产依赖最低补丁：

| 包 | 基线 | 候选 |
| --- | --- | --- |
| proxy-addr | 2.0.7 | 2.0.8 |
| brace-expansion（应用树1.x） | 1.1.18 | 1.1.21 |
| multer | 2.3.0 | 2.4.0 |

仅更新批准feed上已有补丁，不执行audit fix --force，不绕过npm发布管控。package-lock保持integrity。生产 `npm audit --omit=dev` 修补前3项（1 critical、1 high、1 moderate），修补后 **0项**。这不等于OS／全镜像零漏洞。

## 3. 构建状态

r1四个组件均实际构建成功，仅本地tag，不是Docker Hub可拉取版本。

r1镜像扫描出现critical/high门禁失败。r2在相同固定Node基础上更新已提供的系统补丁，移除运行时包管理器，保留r1失败证据，重新构建。r2四个组件均已实际构建成功，功能/浏览器验证通过但停止超时137。r3新增Tini init并重建四组件，功能/浏览器/有界退出均实际通过。最终候选为r3。

候选标签 `single-slug-5046bca-amd64-r1/r2/r3` 只在本地 `ghcp-release-*` 使用，**没有推到公开namespace**，无registry digest。Image ID不是registry digest。

最终r3 Image IDs（记录于 `.claude/image-release-r3-images.json`，r2旧候选保留未覆盖）：

| 组件 | 本地Image ID |
| --- | --- |
| Proxy | `sha256:fe599088220997fe7caccef6a26683f64bf9047d0cb5e09cf41a7caf0765a4d5` |
| Console | `sha256:2e257d1024dedf59a73370799468df865c5eb3f75438fd6c8885a9240eb649ba` |
| SSO | `sha256:1e2135464ece66402330dc813d7fdbc11dbab7c5e9e19a91fdf71482eb6cdcfc` |
| Login | `sha256:bc3f337b17c20a0b3803f7817efd98e2176786bb64f501141ca01784fed51bba` |

## 4. 已实际执行的验证

| 检查 | 实际结果 |
| --- | --- |
| 四组件部署TypeScript检查 | PASS |
| 四组件本地构建 | PASS |
| 修补依赖后的Proxy串行全量 | 538项：510 PASS、28 SKIP、0 FAIL |
| SSO单元／隔离测试 | 31/31 PASS |
| Login单元／隔离测试 | 12/12 PASS |
| Console单元测试 | 6/6 PASS |
| Proxy r1应用层内容审计 | 2268个应用文件，71个workspace文件，未发现其他组件源码、应用测试、真实状态或私钥 |
| 四个r2应用层逐层内容审计 | PASS：历史候选证据保留，不代替r3审计 |
| 四个最终r3应用层逐层内容审计 | PASS：Proxy2268／Console2223／SSO2240／Login2233个应用文件；归档config hash与Image ID匹配，只含目标组件与shared，无上述异常文件及嵌入的合成凭据 |
| 最终r3四组件SBOM | 已生成并解析SPDX：Proxy／Console／SSO各320个package条目，Login499个；SPDX条目计数与scanner indexed计数分开记录 |
| Proxy r1 high/critical扫描 | FAIL：24条／10个包，历史证据保留 |
| Proxy r3 high/critical扫描 | FAIL：6条high，0 critical |
| Console r3 high/critical扫描 | FAIL：6条high，0 critical |
| SSO r3 high/critical扫描 | FAIL：6条high，0 critical |
| Login r3 high/critical扫描 | FAIL：8条high，0 critical；重试完整执行退出2 |
| 四组件r3容器health／协议／浏览器实际验证及复测 | PASS，两次运行各6次mock请求，Chromium实际渲染通过 |
| 四组件r3有界SIGTERM退出 | PASS：Proxy 0，其余143；不等于任务级优雅drain |
| MySQL双Proxy与限定基线升级/回滚 | PASS，133.117秒；相同卷/凭据/租约/会话/证书保持，应用默认CMD未覆盖 |
| r3全新MySQL库账号池供给与协议 | PASS，82.897秒；真实worker＋mock外部供给链，三个合成成员/两个租约 |
| 镜像内native ABI与Chromium | PASS；WAL/STRICT/事务/重开/integrity、shared ESM和本地HTML渲染 |
| 三项依赖行为基线/r3对照 | PASS；multipart正常/超限/畸形、代理地址解析与brace展开；非漏洞利用测试 |
| 旧模板root-relative Node command | FAIL（预期问题已证实）：MODULE_NOT_FOUND；需修正部署兼容，不算drop-in通过 |
| Docker Hub公开push／匿名pull验证 | NOT RUN |
| 真实GitHub、席位、模型调用 | NOT RUN |

并行Proxy测试与镜像build同时执行时，原套件4项超时类用例失败（GET_LOCK清理、RELEASE_LOCK清理、catalog deadline和一个503映射）。保留失败日志，随后串行复跑原断言全部通过；未放宽deadline或修改测试来掩盖。本轮不是负载或生产容量验收。

## 5. 发布门禁：剩余基础系统漏洞

最终r3继承r2的npm/Yarn运行层清理和可用系统补丁，并加入Tini。Proxy／Console／SSO当前扫描各报告6条基础系统high：

- `util-linux`：CVE-2026-78409、CVE-2026-78410、CVE-2026-78408、CVE-2026-76642。
- `perl`：CVE-2026-82560。
- `zlib`：CVE-2026-85091。

“扫描器报告”不是这些缺陷在本应用中可远程利用的证明，但也不能静默忽略或把它们算作修复。应核对平台vendor/VEX、包版本及应用可达性，或选择补丁可用的等价基础镜像后重建和回归；未完成该检查前不放行公开发布。不在生产层随意移除Debian Essential packages或强制忽略scanner。

四个最终r3候选均已实际扫描：Proxy、Console、SSO各6条high，Login8条high，全部0 critical。Login另涉及expat、openssl系统包，仍需核对其具体vendor状态，不把浏览器依赖缺陷算成应用已修复。扫描结果只表示安全数据库识别，不包含应用可达性证明。

Login首次r3扫描受240秒外层deadline中断；日志虽显示报告已写入，但不据此声称扫描流程成功。2026-10-14重新取得用户授权后，以600秒上限重试，正常生成SARIF并退出2，明确为8条high的门禁失败，而非扫描器运行故障。其他组件退出2同义。Windows临时归档“file in use”清理警告保留，不执行跨项目临时目录清理。

### Debian/vendor只读核对（2026-10-14）

独立核查读取实际r3 SARIF，并核对8个官方Debian／vendor页面。结果不是只依据scanner的“no fix”字符串：

| 来源包／实际版本 | CVE | 当前证据与门禁 |
| --- | --- | --- |
| util-linux `2.38.1-5+deb12u3` | 78409／78410／78408／76642（均CVE-2026） | Debian Bookworm仍标记vulnerable；78409的vendor影响版本范围与Debian分类不一致，需要进一步澄清，不能自动忽略 |
| perl `5.36.0-7+deb12u4` | CVE-2026-82560 | 缺陷涉及Pod::Text；scanner定位perl-base，尚未证明该受影响模块存在或不存在，未授予例外 |
| zlib `1:1.2.13.dfsg-1` | CVE-2026-85091 | Debian未提供已核实修复；上游对旧版本是否受影响存在讨论，不能只比较版本号排除 |
| openssl `3.0.22-1~deb12u1`，Login的libssl3 | CVE-2026-84782 | Debian明确标记当前Bookworm-security版本vulnerable；删除openssl命令行工具不能修复共享库 |
| expat `2.5.0-1+deb12u4`，Login的libexpat1 | CVE-2026-77214 | Debian明确标记当前Bookworm-security版本vulnerable；未核实可用Bookworm回补 |

可行方向是受支持发行版／vendor回补，或核实兼容且含修复的基础镜像后重建。**简单改为Trixie不等于全部消除**：其util-linux等仍有剩余分类。不混装Debian unstable包、不手动替换系统共享库。上表不证明远程利用，也不证明不可达；尚未完成正式VEX／风险接受，因此仍不发布。

核对来源：

- [Debian util-linux](https://security-tracker.debian.org/tracker/source-package/util-linux)、[vendor CVE-2026-78409](https://github.com/util-linux/util-linux/security/advisories/GHSA-8f2p-47x3-43mv)。
- [Debian Perl](https://security-tracker.debian.org/tracker/CVE-2026-82560)。
- [Debian zlib](https://security-tracker.debian.org/tracker/CVE-2026-85091)、[上游讨论](https://github.com/madler/zlib/issues/1310)。
- [Debian OpenSSL](https://security-tracker.debian.org/tracker/CVE-2026-84782)、[OpenSSL公告](https://openssl-library.org/news/secadv/20260929.txt)。
- [Debian Expat](https://security-tracker.debian.org/tracker/CVE-2026-77214)。

## 6. 容器运行资格：工具恢复后已完成

用户调整本地模型路由后，`preview_start("image-release-isolated")` 已正常启动。此前失败是桌面安全判断请求在Opus角色路径受到Copilot上游400拒绝，并非Docker容器失败；配置由用户修改，本会话未修改模型/权限以绕过检查。

实际运行采用仅internal Docker网络，合成凭据及一天有效的合成SAML证书。最终r3检查通过：

- 四组件health、Proxy真实SQLite readiness及合成凭据导入读取。
- 6次mock协议请求：优化true/false各一组HTTP JSON、SSE与缺beta400；正文/协议头正确，OAuth为合成上游token。
- SSO metadata、内部用户查询、Login管理API鉴权。
- Console首页与真实构建静态资源可访问。
- Login Chromium实际启动并渲染本地HTML，返回 `CHROMIUM_OK`；无真实GitHub设备授权。
- 运行文件只包含本组件与shared workspace。
- 最终有界SIGTERM退出：Proxy为0，SSO/Login/Console及mock为143；无停止超时的137，无OOM。143只证明信号正常终止，不证明授权任务、业务在途请求或数据库关闭的完整应用级drain。

保留的失败与修复：

1. 初次夹具尝试调用精简Proxy镜像不存在的openssl，失败发生在合成证书准备阶段。改用本机工具生成测试证书，不向发布镜像复制证书。
2. 校正fixture使用真实导入CSV格式 `name,copilotOauthToken`，通过SSO创建本地合成用户，再由公开内部API验证导入结果；无真实SCIM/席位操作。
3. r2功能与Chromium通过，但SSO/Login/Console/mock作为PID1的Node未有界响应停止，最终137。检查 `OOMKilled=false`，不误报OOM。新增运行层Tini init（mock使用Compose init），构建r3后重跑，正常143/0。
4. 控制器增加真实容器退出码断言，不能只看compose stop退出码0就判优雅退出成功。

原始记录分别为 `.claude/image-release-container-results-attempt1.json`、`-attempt2.json`、`-r3.json`。2026-10-14再次运行同一r3候选，通过全部相同断言；复测结果另存 `image-release-container-results-r3-repeat.json`。测试容器全部已停止，保留本轮专用合成卷/网络供复查。真实GitHub/模型调用0次。

### 测试环境范围与发布顺序

本次确实先验证改动后的镜像，而不是“改源码后直接push”：依赖补丁后的类型检查、构建及现有测试先通过，再以最终r3 Image ID执行两轮隔离容器验证，随后对这些相同ID的产物生成SBOM及逐层内容审计。来源manifest核对构建上下文与固定main加声明overlay一致，并核对被测容器Image ID。

此前Compose使用**本地SQLite、ACCOUNT_ROUTING_MODE=direct、合成SSO用户与mock Copilot**。2026-10-16至17另完成真实MySQL8.4.11、双Proxy caller-lease供给/租约/协议及固定基线→r3→基线同卷升级回滚，见[隔离资格验证报告](user-pool-image-isolated-qualification.md)。主机执行的旧单元套件28项实库门禁仍是历史SKIP，不因新增容器验证而改写原计数。未更新Azure/客户环境；不声称全部pool生命周期、HA、性能或真实上游资格。

发布前必须通过剩余安全门禁；如更换基础镜像或代码，则重建为新候选并重复相关验证，不能沿用r3结果。对计划部署方式还需在隔离预发布环境使用合成数据、对应存储driver和同一镜像完成升级/回滚验证，不触碰真实EMU、席位或模型。Docker Hub上传不等于生产上线：客户应用前仍要按升级指南核对存储实现、备份、停止writer与回滚。

### 启动兼容边界

新release镜像默认以Tini加直接Node启动，不再包含npm/Yarn/corepack。原部署未覆盖command/entrypoint时使用镜像默认命令；如原配置覆盖为 `npm run ...`，不能原样套用，应移除覆盖或改为与目标组件匹配的Node命令并在隔离环境验证。组件工作目录与原workspace一致。UID仍为root，卷权限/端口/schema不变；不能称本轮完成nonroot或完整应用级shutdown drain。

运行验证阻塞已解除；公开发布仍受基础系统安全告警审查门禁限制。新增隔离验证实测确认旧模板 `node src/proxy/dist/index.js` 与r3组件cwd不兼容；应修正/明确部署命令后验证，不能直接换镜像。许可证清单还需兼容legacy `licenses` 元数据；已有license文件仍保留。两项尚未修正，本轮未改变r3镜像。

## 7. 当前交付与下一步边界

- 新Dockerfile、运行打包脚本、隔离验证fixture和依赖补丁保留在本分支，未commit/push。
- 原multi-slug／Models工作目录未动；客户/现有Azure部署未更新。
- 既有客户指南路径A仍明确“镜像未发布”，不填写假digest或声称anonymous pull可用。
- 最终r3扫描、容器功能复测、镜像应用层内容审计、SBOM和来源核对已完成；容器功能/内容项为PASS，漏洞门禁为FAIL，不统称“镜像验证全通过”。
- 公开发布仍需完成：部署命令兼容与许可证清单修正及适用回归；剩余基础系统风险审查/补丁；若修补导致产物变化，生成新候选并重跑验证；本轮隔离资格不替代客户/其他版本部署验收；Docker Hub repo/public状态与tag不存在核验，再push并按digest重新pull/验证。
- 完成后更新[客户升级指南](user-pool-messages-output-config-upgrade-guide.md)和[镜像分发方案](user-pool-image-distribution-plan.md)，提供**实际四个digest与兼容矩阵**。

本地证据全部在忽略的 `.claude/`：生产audit前后，r1/r2历史build/scan/SBOM与失败记录，最终r3四组件build/scan/SPDX/逐层审计，来源manifest，以及测试日志。`image-release-r3-source-manifest.json`记录最终overlay和fixture SHA256、502个构建上下文文件的总指纹、报告与证据SHA256、四个被测Image ID及实际停止状态；逐文件核对固定main加声明overlay，无不明增量。不把未提交包装伪装成已合并commit。

应用层内容审计遍历Docker archive manifest指向的每一层。首次r2审计错误地假定layer路径以 `/layer.tar` 结尾，检查到0文件，不能作为通过；及时停止后改为读取实际manifest层引用，并增加“必须检查到文件且workspace匹配”的断言。最终r3另核对archive config SHA256等于Image ID、环境配置无credential字段及app层无嵌入合成凭据。此为明确范围内的检查，不宣称完整secret检测保证；干净固定commit构建上下文是主要防护。未把真实token、客户文件或业务prompt加入本次发布材料。
