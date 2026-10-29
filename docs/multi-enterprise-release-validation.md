# 多企业版发布验证记录

本文记录多企业版（multi-enterprise / multi-slug SSO）候选镜像的发布前验证结果。设计见 [multi-enterprise-design.md](multi-enterprise-design.md)，升级步骤见 [multi-enterprise-upgrade-guide.md](multi-enterprise-upgrade-guide.md)。r4（`multi-ea1a29e-amd64-r4`）的验证记录在最前，它修复了非流式推理被限制在约 300 秒的问题；r3（`multi-f43f27e-amd64-r3`）受该问题和 qs 的 CVE-2026-110816 影响；r2（`multi-4922a4a-amd64-r2`）受 CVE-2026-111181 影响，已被 r3 取代；此前发布的 r1（`multi-41ecffc-amd64-r1`）记录保留在后半部分。

## r4：multi-ea1a29e-amd64-r4（已发布）

所有验证都只用合成数据、mock 外部服务、本地 MySQL 容器。没有调用真实的 GitHub、GitHub EMU、GHE.com、Copilot 或模型；没有创建真实用户或席位；没有接触真实 SSO 环境。Docker Desktop 只用来验证功能，不评估性能。

### 0. 与 r3 相比的变更

源码从 `f43f27e` 前进到 `ea1a29e`（分支 `release/multi-r4`，基于 `main` 的 `8a5cb9d`）。`f43f27e..8a5cb9d` 之间其余的提交只涉及文档、Kubernetes 清单、`.gitignore` 和测试（`ownerSideEffects` 的确定性修正只改了测试）。运行时的改动有两项：

| 提交 | 改动 | 说明 |
| --- | --- | --- |
| `0ea666b` | `src/proxy/src/copilot/copilotClient.ts`：Proxy 发往上游 Copilot 的请求改用独立的 undici `Agent`（`headersTimeout`、`bodyTimeout` 均为 660 秒）；Proxy 新增生产依赖 `undici` 6.29.1 | **非流式推理不再被限制在约 300 秒**，见下方说明 |
| `ea1a29e` | `package-lock.json`：qs 6.16.0 → 6.16.1 | **修复 CVE-2026-110816**（中危，r3 发布后才公开，r3 同样受影响）。6.16.1 是补丁版本，在 express 5.2.1（`^6.14.0`）和 body-parser 2.3.0（`^6.15.2`）允许的范围内，只改锁文件 |

关于 `0ea666b`：
- **问题**：r3 及更早版本使用 Node 内置 fetch 的默认超时，响应头和数据块间隔各 300 秒。上游超过 300 秒才返回响应头时，请求以 502 失败；即使设置 `POOL_INFERENCE_TIMEOUT_SECONDS=600` 也没有用。Azure 实测：一个 550 秒内没有输出的非流式请求，在 300.8 秒时失败。
- **修复**：660 秒高于两个时限参数的上限（600 秒），实际时限仍由原来的预算决定。详见[推理超时验证报告](user-pool-inference-timeout-validation.md)的“非流式 300 秒上限”一节。
- **为什么是 undici 6.29.1**：运行时 Node 22 内置的 undici 是 6.28.0，所以新依赖也选 6.x。6.28.0 本身落在 `npm audit` 公告范围内（≤6.29.0），因此用 6.29.1。

`8a5cb9d` 曾单独构建为 `multi-8a5cb9d-amd64-r4`，并跑完一轮验证（第 9 节）。扫描发现 qs 的新漏洞后升级了 qs，再从 `ea1a29e` 重新构建。

### 1. 候选镜像

构建方式：
- **构建上下文**：`git -c core.autocrlf=false archive ea1a29e`。已检查上下文中没有 CRLF 文件；tar 的 SHA-256 为 `45c37383a09106619ce9fb1960c110e9e0b9992147276ee4dba95280a3db2f29`。
- **Dockerfile 与参数**：`deploy/images/Dockerfile.release`，`RELEASE_LINE=multi`，平台 linux/amd64。
- **基础镜像**：按 digest 固定为 `node:22-bookworm-slim@sha256:efd0ab57…`，镜像内 Node 为 v22.23.3。
- **npm 源**：公司批准的源，没有绕过 npm 最短发布期管控。
- **缓存**：运行层不使用缓存（`--no-cache-filter runtime`）。

| 组件 | 本地标签 | 镜像 ID |
| --- | --- | --- |
| Proxy | `ghcp-release-proxy:multi-ea1a29e-amd64-r4` | `sha256:d816492bf62bf3f1251ca6b51717f6cacbbae3d720480462ea6ee5d61e798139` |
| SSO | `ghcp-release-sso:multi-ea1a29e-amd64-r4` | `sha256:2f93ff7cd567804ecabb908ac1f95ab36c2436480c59f68555e13515a56ec2d3` |
| Login | `ghcp-release-login:multi-ea1a29e-amd64-r4` | `sha256:7aa3a8ee40ac757988384bbb2664b9f25439fabd19a7107a7a2978f61fbfd577` |
| Console | `ghcp-release-console:multi-ea1a29e-amd64-r4` | `sha256:229a71f2015d98e22b37ae9c4272874ab7bafa3741b76a59f4d50be38f8ef8e9` |

镜像内容：
- **label**（四个镜像相同）：`org.opencontainers.image.revision=ea1a29e`、`com.ghcp.release-line=multi`、`org.opencontainers.image.version=multi-ea1a29e-amd64-r4`；ENTRYPOINT 为 Tini。
- **系统包**：运行层的 `apt-get upgrade` 结果与 r3 相同，升级了 `perl-base`（deb12u3 → deb12u4）和 `tzdata`（2026c → 2026e），没有其他可用更新。
- **npm 包**：`undici` 6.29.1、qs 6.16.1；`body-parser` 仍为 2.3.0（`inflate: false` 缓解不变）；没有 multer。
- **`undici` 的位置**：四个服务共用同一个 `node_modules`，所以四个镜像都带有 `undici`，但只有 Proxy 使用它。

### 2. 300 秒上限的镜像级检查（本次新增）

做法：在候选 Proxy 镜像内调用打包后的 `executePreparedCopilotRequest`（位于 `/app/src/proxy/dist`），请求一个本地上游。这个上游 310 秒后才返回响应头，请求的 AbortSignal 预算为 600 秒。

| 镜像 | 结果 |
| --- | --- |
| r4 `ea1a29e` | 200，310.0 秒 |
| r4 `8a5cb9d`（第 9 节） | 200，309.7 秒 |
| r3 `f43f27e`（对照） | 301.2 秒时失败：`fetch failed`，`UND_ERR_HEADERS_TIMEOUT` |

另外，在发布镜像的运行时（`node:22-bookworm-slim`，内置 undici 6.28.0）上确认，内置 fetch 会采用 `undici` 6.29.1 的 Agent：
- 把超时设为 500 毫秒时，请求按时以 `UND_ERR_HEADERS_TIMEOUT` 失败；
- 把超时设为 5 秒时，请求成功。

### 3. 原地升级与全新部署资格测试

测试条件与 r3 相同：
- 命令为 `qualification-prepare.mjs` + `qualification-run.mjs`；
- 基线为 `single-slug-164cade-amd64-r4`，数据库为 MySQL 8.4；
- 合成 IdP 证书，有效期至 2026-11-17；
- 每次使用全新的项目名和未使用的子网（`10.231.81–93.0/24`）。

结果：各报告都记录了上表的镜像 ID，`planCoverage.complete=true`。全部一次通过，断言数与 r3 相同。

| 模式 | 项目 | 用时 | 断言 | 结果 |
| --- | --- | --- | --- | --- |
| `multi-upgrade`（MySQL 8.4 + 双 Proxy） | `ghcp-release-qualification-multi-r4b-m1` | 约 11.5 分钟 | 76 | 通过 |
| `multi-upgrade-sqlite` | `ghcp-release-qualification-multi-r4b-s1` | 约 1 分钟 | 19 | 通过 |
| `multi-fresh` | `ghcp-release-qualification-multi-r4b-fm1` | 约 3.4 分钟 | 30 | 通过 |
| `multi-fresh-dba` | `ghcp-release-qualification-multi-r4b-fd1` | 约 3.6 分钟 | 34 | 通过 |
| `multi-fresh-sqlite` | `ghcp-release-qualification-multi-r4b-fs1` | 约 1.5 分钟 | 23 | 通过 |
| `idle-target-cap-check.mjs`（对照 r1） | `ghcp-release-qualification-multi-r4b-idlecap1` | 约 2.3 分钟 | 19 | 通过 |
| 停止时的长连接（对照 r2），3 次 | `ghcp-release-qualification-r4b-shutdown-1/2/3` | 每次约 3–15 分钟 | 每次 50 | 通过 |

`multi-upgrade` 和第一次停止检查比 `8a5cb9d` 那一轮慢（`multi-upgrade` 11.5 分钟，上一轮 6.8 分钟）。当时主机同时在构建和扫描，负载较高；没有出现失败或重试。

### 4. 单元与集成测试

测试环境的变化：
- **本机 Node 被升级**：这次发布期间，系统把本机 Node 从 v24 自动升级到了 v26.13.0。依赖是在 v24 下安装的，better-sqlite3 无法在 v26 下加载。
- **`ea1a29e` 改在 Linux 容器中测试**，用了两个运行时：
  - 发布运行时 `node:22-bookworm-slim`（Node 22.23.3）；
  - `node:24-bookworm-slim`（Node 24.22.2）。
- **MySQL 的位置**：MySQL 8.4 与测试容器共用网络命名空间，因为测试只接受回环地址上的 MySQL。
- **`8a5cb9d` 的单元测试**是在 v26 升级之前、在本机 Node 24 上跑的。

| 范围 | `ea1a29e` | `8a5cb9d`（本机 Node 24） |
| --- | --- | --- |
| 全仓 typecheck | 通过（Node 22） | 通过 |
| shared / SSO / Login / Console | 147/147、96/96、62/62、36/36（Node 22） | 相同 |
| Proxy | Node 24：685 条，643 通过、41 跳过、1 失败；Node 22 的情况见下方说明 | 685 条：644 通过、41 跳过、0 失败 |
| Proxy MySQL 集成（13 个文件，逐个运行） | Node 22 上全部通过，各文件结果见表后 | 运行时本机 Node 已升级为 v26，结果不采用：3 个文件因 better-sqlite3 版本不匹配和一次 OpenSSL 熵源错误失败，其余 10 个文件通过 |
| 资格测试脚本与 mock | 40/40（Node 22） | 40/40 |
| 部署脚本 | 未在容器中运行：需要 `kubectl kustomize`，容器内没有；`ea1a29e` 只改了锁文件 | 24/24 |

`ea1a29e` 在 Node 22 上的 Proxy MySQL 集成测试结果：

| 文件 | 结果 |
| --- | --- |
| `mysqlStorage` | 2/2 |
| `mysqlEnterpriseMigrations` | 10/10 |
| `scheduling` | 2/2 |
| `ownerSideEffects` | 22/22 |
| `mysqlStore` | 34/34 |
| `mysqlRecovery` | 5/5 |
| `mysqlLifecycle` | 2/2 |
| `mysqlCallerIsolation` | 3/3 |
| `mysqlAdmission` | 16/16 |
| `loginPollingRecovery` | 6/6 |
| `inferenceTimeout.mysql` | 3/3 |
| `userPoolCredentialRace` | 10/10 |
| `userPoolCatalogPressure.mysql` | 2/2 |

失败情况如实记录如下。

**Node 24 上的 1 条失败**：
- **用例**：`mysqlAdmission.integration.test.ts` 中的“uncertain named-lock release (null) …”。
- **现象**：期望得到 `pool_exhausted`，实际得到 `MysqlDeadlineError`（5 秒的 MySQL 时限）。失败发生在 Proxy 全量测试并行运行时。
- **结论**：负载下的计时断言，不是代码问题。同一文件在 Node 24 上单独重跑 3 次，每次都是 8 通过、1 跳过；在 Node 22 的 MySQL 集成运行中为 16/16。

**Node 22 容器中 Proxy 全量单元测试的 4 条失败和 5 条取消**：
- **`store.test.ts`**：4 条并行 SQLite 用例在 worker 线程中加载不到源码模块（`ERR_MODULE_NOT_FOUND …/migrations.js`）。
- **`enterpriseReadiness.worker.test.ts`**：5 条被取消（`Promise resolution is still pending …`）。
- **对照**：在同一个容器环境中，对已发布的 r3 源码 `f43f27e` 运行这两个文件，结果完全相同（`store.test` 38/42，`enterpriseReadiness.worker` 5 条取消）。在 Node 24 上，这两个文件全部通过。
- **结论**：问题出在这种运行方式（Node 22 + tsx 的 worker 线程），不是 r4 的回归。

### 5. 镜像扫描（Docker Scout）

在同一天、用同一漏洞库，扫描了 r4 `ea1a29e`、`8a5cb9d` 和已发布的 r3（全部级别）：

| 镜像 | r4 `ea1a29e`：Critical / High / 全部 | r3（今天的漏洞库）：全部 |
| --- | --- | --- |
| Proxy / SSO / Console | 0 / 9 / 52 | 53 |
| Login | 0 / 14 / 139 | 140 |

**与 r3 的差别**：只有一处，qs 的 CVE-2026-110816 消失了。新增的 `undici` 6.29.1 没有任何条目。

**仍有修复版本的条目**：只剩 CVE-2026-111181（body-parser 2.3.0，修复版本为 2.4.0）。批准的 npm 源仍只到 2.3.0，`inflate: false` 缓解保持不变（见 r3 第 6 节）。

**其余 High 条目**：都来自 Debian Bookworm 基础系统包，Scout 标注为 `not fixed`。

| 范围 | 条目 | 说明 |
| --- | --- | --- |
| 全部镜像 | util-linux（6 条）、perl CVE-2026-82560、zlib CVE-2026-85091 | 与 r3 相同 |
| Login | expat CVE-2026-115506 | 与 r3 相同 |
| Login | expat CVE-2026-117610、CVE-2026-118370；libxi CVE-2026-109089、CVE-2026-109090 | r3 发布时尚未公开；用今天的漏洞库扫描 r3 的 Login，同样报告 |

Login 中这些条目的可达性：
- **expat**：只经 Chromium 的 fontconfig 解析镜像内的本地字体配置（见[单企业发布验证记录](user-pool-image-release-validation.md)第 0.4 节），攻击者无法提供输入。
- **libxi**：X11 输入扩展库，随 Chromium 的系统依赖安装。Login 以无头模式运行，没有 X 服务器，不可达。

**扫描过程**：第一次扫描 Console 和 Login 时，Docker Desktop 的登录会话失效了（`docker scout` 要求登录），重新运行后成功。

### 6. 失败与重跑汇总

- **构建**：第一次失败是脚本问题：脚本把 Git Bash 风格的路径传给了 docker，3 次重试都卡在准备构建上下文这一步。修正脚本后一次构建成功。
- **Linux 测试**：
  - 第一次运行时，Docker 的 DNS 暂时无法解析 `deb.debian.org`，测试没有执行。DNS 恢复后重新运行，结果见第 4 节。
  - 另外两次是脚本问题：`docker exec -w` 的路径被 Git Bash 改写；MySQL 不在回环地址上，被测试拒绝。都在测试真正开始之前发现并修正。
- **Scout**：见第 5 节。
- **资格测试与停止检查**：都一次通过，没有重跑。

### 7. 未验证的范围

- 与 r3 第 11 节相同：真实 GitHub / GHE.com / Copilot、真实 LiteLLM、性能与长时间稳定性等。
- **kind（Kubernetes）**：没有用 r4 重跑。运行时的改动只涉及 Proxy 发往上游的请求，Kubernetes 清单没有变化，沿用 r3 的 kind 结果。
- **600 秒以上的推理截止行为**：只由单元测试和原有的 MySQL 测试（`inferenceTimeout.mysql`）覆盖。超过 300 秒的端到端请求，计划在 Azure 测试环境中验证。

### 8. 发布

已发布到 Docker Hub（公开仓库，2026-10-29）：

| 组件 | 按 digest 引用 |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:98c4c720db3189d53536885cfd1e521954f3b2989333e27784d6387edad63dec` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:12d60ca0b55e593bb5163d044b906640f033b9a2e767568dea7fb30ac8a35919` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:4481f51701fc23c8f78b1bbe4e4c6eb41b0fe9fc6b4d5e8ae897f9add1263bec` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:91a02afbbba6913a81ab252213a632508cd68610cf6d73d99543b6e731f12fb8` |

发布后核对：每个 manifest 的 config digest 等于第 1 节经资格测试的镜像 ID；按 digest 拉起 Proxy，`/healthz` 返回 `releaseLine: "multi"`，带 `Content-Encoding: gzip` 的请求体返回 415，停止时 `shutdown complete`、退出码 0。

### 9. `8a5cb9d` 候选（已被 `ea1a29e` 取代，未发布）

镜像 `multi-8a5cb9d-amd64-r4`：

| 组件 | 镜像 ID |
| --- | --- |
| Proxy | `sha256:141a2c6fada8…` |
| SSO | `sha256:2be1cafc2855…` |
| Login | `sha256:53d884e7a580…` |
| Console | `sha256:823e6597805d…` |

构建上下文 tar 的 SHA-256 为 `ea134d32dac5…`。

这一轮完整跑过的验证：
- **单元测试**（本机 Node 24）：typecheck 通过；shared 147/147、Proxy 685 条中 644 通过（41 跳过、0 失败）、SSO 96/96、Login 62/62、Console 36/36、资格测试脚本 40/40、部署脚本 24/24。
- **资格测试**：`multi-upgrade` 76、`multi-upgrade-sqlite` 19、`multi-fresh` 30、`multi-fresh-dba` 34、`multi-fresh-sqlite` 23、idle-target 19 条断言，全部一次通过（项目 `ghcp-release-qualification-multi-r4-*`，子网 `10.231.61–73.0/24`）。
- **停止检查**：3 次，每次 50/50。
- **300 秒镜像级检查**：通过（第 2 节）。

被取代的原因：扫描发现 qs 的 CVE-2026-110816 后，按“有修复就修”升级 qs 并重新构建。这些镜像保留在本地。

证据：构建日志、测试日志、报告和扫描结果都保存在本机（`.claude/multi-r4/`、`.claude/multi-r4b/`、`.claude/release-qualification-run-*`），不入库。

---

## r3：multi-f43f27e-amd64-r3（已发布）

全部验证只使用合成数据、mock 外部服务、本地 MySQL 容器和本机 kind 集群；没有调用真实 GitHub、GitHub EMU、GHE.com、Copilot 或模型，没有创建真实用户或席位，没有接触真实 SSO 环境、云资源或集群。Docker Desktop 只验证功能，不评估性能。

### 0. 与 r2 相比的变更

源码从 `4922a4a` 前进到 `f43f27e`（分支 `release/multi-r3`，基于 `main` 的 `8e58bc2`）。`4922a4a..8e58bc2` 之间是文档、DBA 脚本（`SET NAMES utf8mb4`）及其生成器 `src/proxy/src/db/mysqlInitialSql.ts`（只被脚本生成和测试使用，服务运行时不调用）、资格测试脚本和 Kubernetes 清单。运行时的改动：

| 提交 | 改动 | 说明 |
| --- | --- | --- |
| `3d6db1a` | `src/packages/shared/src/shutdown.ts`（四个服务共用的优雅停止） | 排空期间，SIGTERM 时正忙的 keep-alive 连接在当前响应结束后关闭：响应头尚未发出的加 `Connection: close`；响应头已发出的（例如 SSE）在 `finish` 后结束套接字；空闲连接立即关闭。之前 LiteLLM 这类复用连接的客户端会一直使用忙碌的连接，直到 25 秒排空时限强制关闭（kind 中 669 个请求有 1 个 `ECONNRESET`，见 `deploy/kubernetes/README.md` 第 10.1 节）。 |
| `f43f27e` | 四个服务的 body parser（Proxy、Login、Console 的 `express.json`，SSO 的 `express.json` 与 `express.urlencoded`）加 `inflate: false`；共享的 `managementErrorHandler` 把该解析错误映射为 415 | **CVE-2026-111181 的缓解**（body-parser 2.3.0，见第 6 节）：带 `Content-Encoding`（`identity` 除外）的请求体一律 415，不再创建解压流。SSO、Login 的响应为 `{"error":{"code":"unsupported_content_encoding"}}`，Proxy、Console 为 Express 默认的 415 页面。批准的 npm 源提供 body-parser ≥ 2.4.0 后取消。 |
| `f43f27e` | 根 `package.json` / `package-lock.json` 删除 `multer` | CVE-2026-113872。multer 自初始提交起在依赖中，但产品代码从未引用；随之从锁文件删除的只有 multer、busboy、streamsearch、append-field 和 multer 内嵌的 type-is、mime-types、mime-db、media-typer，其他锁定版本不变。 |

测试与脚本：`98ef32e` 新增镜像级停止检查、收紧 kind 断言；`e6112c9` 修正 `3d6db1a` 中的两个停止单元测试（见第 9 节）；`f43f27e` 增加四个服务的 415 测试，并让镜像运行时检查期望候选镜像中没有 multer（基线 r4 仍有，照旧检查其 multipart 行为）。

`3d6db1a` 曾单独构建为 `multi-3d6db1a-amd64-r3` 并跑完一轮资格测试（第 10 节），扫描发现上述两个 npm 漏洞后按决定加入缓解并重新构建；`3d6db1a` 镜像从未发布，保留在本地。

### 1. 候选镜像

构建上下文为 `git -c core.autocrlf=false archive f43f27e`（LF 行尾，已检查上下文中没有 CRLF 文件；tar 的 SHA-256 为 `cf2c9d2e82b780e3a50ba73d9030e2d0e44e2fbe68090d2fc04cbec290570b13`），`deploy/images/Dockerfile.release`，`RELEASE_LINE=multi`，linux/amd64，基础镜像仍按 digest 固定为 `node:22-bookworm-slim@sha256:efd0ab57…`，npm 源为公司批准的源（没有绕过 npm 最短发布期管控）。镜像内 Node 为 v22.23.3。

| 组件 | 本地标签 | 镜像 ID |
| --- | --- | --- |
| Proxy | `ghcp-release-proxy:multi-f43f27e-amd64-r3` | `sha256:95a15dc68faaa1d5f41f1b498ae6e35d890776cd1759df53b590e5127ad35fd1` |
| SSO | `ghcp-release-sso:multi-f43f27e-amd64-r3` | `sha256:d0788d0a52ffbb2b69c3482bda29f8e5b0e5fc34e6594c1b6b8c01e70f1ea7ea` |
| Login | `ghcp-release-login:multi-f43f27e-amd64-r3` | `sha256:05b60da5ed39df80c93f5a9889734cc23be4c5b1c2681c4d09a1965994c20e51` |
| Console | `ghcp-release-console:multi-f43f27e-amd64-r3` | `sha256:b9e6f52faca7fa33cdde05d90c46ec286e54b6540ee683b12654a61cc8f91b60` |

已发布到 Docker Hub（公开仓库，2026-10-27）：

| 组件 | 按 digest 引用 |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:14ed9384f57a95c5cb4c1a5bd34d10d722d89d4e8ba9b3b49fcd6e32e41ad5f3` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:93e5be2c5fd8a9166cd67897c52466b833b9bbb12e2eede9dbe7700204b31214` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:96408b4fc3b0d0cd76083cc4bb8a1dcaf91ffa56152a8f7603caa1cc1a968338` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:6526394ff321ab15a4222423013689eb4959dc465dbec6262aa0a84ae267cc90` |

发布后核对：每个 manifest 的 config digest 等于上表经资格测试的镜像 ID；按 digest 拉起 Proxy，`/healthz` 返回 `releaseLine: "multi"`，带 `Content-Encoding: gzip` 的请求体返回 415，停止时退出码 0。

四个镜像的 label：`org.opencontainers.image.revision=f43f27e`、`com.ghcp.release-line=multi`、`org.opencontainers.image.version=multi-f43f27e-amd64-r3`。ENTRYPOINT 为 Tini（`/usr/bin/tini -g --`），CMD 与工作目录与 r2 相同。镜像内没有 `multer`、`busboy`，`body-parser` 仍为 2.3.0（express 5.2.1 的依赖）。

构建说明：

- 系统包：运行层的 `apt-get update && apt-get upgrade` 重新执行（`--no-cache-filter runtime`），相对固定的基础镜像升级了 `perl-base`（`5.36.0-7+deb12u3` → `deb12u4`，与 r2 相同）和 `tzdata`（`2026c-0+deb12u1` → `2026e-0+deb12u1`，本次新增），没有其他可用更新。
- 行尾：构建上下文用 `git -c core.autocrlf=false archive` 生成，一次构建成功。验证用的工作区中 `tests/`、`scripts/`、`deploy/` 以 LF 重新检出（资格测试脚本的一个单元测试按 LF 解析 `compose.yaml`，在 CRLF 检出上会失败，与 r2 相同）。

### 2. 原地升级资格测试（设计 §9.4）

基线为已发布的单企业镜像 `single-slug-164cade-amd64-r4`。命令行方式与 r2 相同（`qualification-prepare.mjs` + `qualification-run.mjs`），全新项目名与未使用的子网（`10.231.21–29.0/24`），合成证书沿用 r1/r2 的合成 IdP 证书（有效期至 2026-11-17，公私钥配对已校验）。各报告都记录了上表的镜像 ID；`planCoverage.complete=true`；全部一次通过。

| 模式 | 项目 | 用时 | 断言 | 结果 |
| --- | --- | --- | --- | --- |
| `multi-upgrade`（MySQL 8.4 + 双 Proxy） | `ghcp-release-qualification-multi-r3f-m1` | 约 7 分钟 | 76（预检 6、step1 9、step2 18、step3 4、step4 21、step5 10、step7 8） | 通过 |
| `multi-upgrade-sqlite`（SQLite 直连，第 6 步） | `ghcp-release-qualification-multi-r3f-s1` | 约 1.5 分钟 | 19（预检 3、baseline 4、candidate 9、r4-on-migrated 1、restore 2） | 通过 |
| `idle-target-cap-check.mjs`（对照 r1 必须拒绝启动） | `ghcp-release-qualification-multi-r3f-idlecap1` | 约 1 分钟 | 19（对照 1、SQLite 9、MySQL 9） | 通过 |

各步骤内容与 r2 第 2 节相同。每个应用容器内的运行时检查（`qualification-verify-runtime.mjs`）确认候选镜像没有 multer、`proxy-addr` 2.0.8、`brace-expansion` 1.1.21。`idle-target-cap-check.mjs` 按设计在全部通过后只删除了自己创建的容器、网络和卷。

### 3. 全新部署资格测试

与 r2 第 3 节相同的三个模式，空库、空卷、没有 registry 文件，全部一次通过：

| 模式 | 项目 | 用时 | 断言 | 结果 |
| --- | --- | --- | --- | --- |
| `multi-fresh` | `ghcp-release-qualification-multi-r3f-fm1` | 约 2.7 分钟 | 30（预检 5、启动 7、Console 3、账号池 3、caller 5、作用域 2、SSO 3、运行时 1、停止 1） | 通过 |
| `multi-fresh-dba` | `ghcp-release-qualification-multi-r3f-fd1` | 约 2.8 分钟 | 34（预检 5、DBA 建库 3、启动 8、Console 3、账号池 3、caller 5、作用域 2、SSO 3、运行时 1、停止 1） | 通过 |
| `multi-fresh-sqlite` | `ghcp-release-qualification-multi-r3f-fs1` | 约 1.7 分钟 | 23（预检 4、启动 5、Console 3、直连 4、作用域 2、SSO 3、运行时 1、停止 1） | 通过 |

`multi-fresh-dba` 用客户端默认会话执行 `scripts/proxy-mysql-initial.sql`，CHECK 字面量只有 `_utf8mb4`。五个模式的“停止”断言（全部应用退出码 0）说明新的停止逻辑不影响正常停止；Login 回调 Proxy、SSO 调 Proxy、Console 转发等服务间请求都是未压缩的 JSON，在 `inflate: false` 下照常工作。主机时钟监测（每 5 秒比较墙钟与单调时钟）在这些运行期间偏差最大 12 ms，没有休眠或时间跳变（当天 10:26–10:35 UTC 有一次约 9 分钟的主机停顿，发生在资格测试开始之前，见第 9 节）。

### 4. 停止时的长连接（本次新增，`tests/image-release/shutdown-keepalive-check.mjs`）

独立、隔离的检查（说明见 `tests/image-release/README.md`“停止时的长连接检查”）：一个 internal 网络上运行四个服务（SQLite 直连，合成凭据）、mock 和每个服务一个原始 HTTP/1.1 客户端；对每个服务建立空闲连接 A、SIGTERM 时进行中的请求 B（请求体只上传了一半，响应头未发出）、响应头已发出的流 C（Proxy 为 SSE，Console 为经 Console 转发的 CSV 导出；SSO、Login 没有流式接口），然后 `docker stop -t 60`。r2 作为对照。在 `f43f27e` 镜像上连续运行 3 次（`r3f-shutdown-1/2/3`，子网 `10.231.31–33.0/24`），每次 50 条断言全部通过（r3 35 条、r2 对照 15 条）；在 `3d6db1a` 镜像上的最终版本检查也连续 3 次 50/50（第 10 节）。`f43f27e` 三次的范围：

| 服务 | r3：B 的响应 | r3：B 之后的 FIN | r3：C | r3：`docker stop` 用时 / 退出码 | r2 对照 |
| --- | --- | --- | --- | --- | --- |
| Proxy | 200，`Connection: close` | 响应后 1–3 ms | SSE 完整（`message_stop`）后 1–2 ms FIN | 3.2–4.1 秒 / 0 | B 不带 `Connection: close`，SIGTERM 后又被复用 41 次；C 结束后仍可复用；约 24–26 秒时 `closing their connections` 强制关闭 |
| SSO | 201，`Connection: close` | 0–1 ms | — | 1.3–1.5 秒 / 0 | 复用 42 次，强制关闭 |
| Login | 404，`Connection: close` | 0–1 ms | — | 1.2 秒 / 0 | 复用 42 次，强制关闭 |
| Console | 401，`Connection: close` | 0 ms | CSV 完整后 4–16 ms FIN | 3.4–3.5 秒 / 0 | 复用 42 次，C 结束后仍可复用，强制关闭 |

r3 另外每次都满足：A 的 FIN 在服务日志 `SIGTERM received, draining` 之后 1–13 ms（空闲连接立即关闭）；SIGTERM 后的新连接 D 被拒绝（`ECONNREFUSED`）；日志有 `shutdown complete`，没有 `closing their connections`。r2 的四个服务每次都在排空时限处强制关闭，`docker stop` 用时（主机侧）24.4–25.5 秒，退出码仍为 0。

**开发过程中的 4 次未通过运行（`3d6db1a` 镜像，`r3-shutdown-1..4`）都是检查脚本的问题，不是 r3 的缺陷**：

| 运行 | 失败 | 原因 | 修改 |
| --- | --- | --- | --- |
| 1 | r3：只有“服务健康且 `releaseLine` 为 multi”一条（Proxy 的健康检查读了 `/readyz`，它不含 `releaseLine`），r3 其余 34 条行为断言全部通过；r2 对照：Proxy、Console 4 条 | 健康检查路径写错；对照中客户端等 C 结束后才开始复用 B，B 已空闲超过 5 秒，被服务的 keep-alive 超时关闭 | `releaseLine` 读 `/healthz`、就绪读 `/readyz`；复用循环与 C 并行 |
| 3 | 只有 r2 对照的 Console 3 条（r3 35/35 通过） | 客户端把 A 收到 FIN 当作排空开始；Docker Desktop 送达 SIGTERM 慢，A 先被服务的 5 秒 keep-alive 超时关闭（A 的最后响应在“触发”前 6.0 秒，SIGTERM 日志在“触发”后 1.8 秒） | 见运行 4、5 |
| 4 | r3 Console 4 条（B 的 `Connection: close`、B 的 FIN、C 完成、D 被拒） | 同一类误触发：客户端 05:29:25.3（UTC，容器时钟）停止刷新 A，A 在 05:29:30.9 被 5 秒 keep-alive 超时关闭，客户端误以为开始排空；Console 的 SIGTERM 日志在 05:29:33.557，晚 2.6 秒（`docker stop` 从调用到送达信号约 8 秒）。所以 D 能连上（服务还在监听）、B 在 SIGTERM 之前就正常返回（自然不带 `Connection: close`）、当时固定 6 秒的流 C 在 SIGTERM 之前 9.4 秒就已结束。B 在 05:29:33.558 收到 FIN，与 SIGTERM 日志相差 1 ms：此刻 B 空闲，被 r3 立即关闭，产品行为正确 | 运行 5 起：以服务自己的 `SIGTERM received, draining` 日志行为准（编排脚本看到后才通知客户端），A 每秒刷新、只有排空能关闭它，C 由 mock 持续到 SIGTERM 之后才结束，并断言 A 的 FIN 紧跟 draining 日志 |

改动后的 9 次运行（`3d6db1a` 3 次、`f43f27e` 3 次，加上开发中的运行 2）中，Console 的 B（Console 自己处理的登录请求）和 C（经 Console 转发管道 `pipeline(...)` 流式返回的 CSV）都表现出修复后的行为，没有发现 Console 转发路径的缺口。同一时段测得 Docker Desktop 虚拟机的单调时钟比主机快约 4%（主机 31.9 秒内多出 1.2 秒），所以 r2 的 25 秒时限在主机上约 24 秒触发；对照组的用时下限因此设为 20 秒。

### 5. Kubernetes（kind）

`tests/kubernetes/kind-e2e.mjs` 用 r3 镜像重跑（kind v0.33，单节点，Kubernetes v1.37；独立 kubeconfig，每次 kubectl 调用都显式传 `--kubeconfig` 和 `--context kind-ghcp-k8s-check`；镜像用 `kind load docker-image` 加载）。滚动更新的断言收紧为：复用长连接的客户端与每个请求新建连接的客户端都必须**零失败**，两个旧 Proxy Pod 都必须在 SIGTERM 后 5 秒内 `shutdown complete` 且没有 `closing their connections`。

**`f43f27e`：一次运行，35/35 全部通过**（阶段 A 26 条、阶段 B 9 条，内容同 `deploy/kubernetes/README.md` 第 9 节；池开到 2 个 Ready idle 用时约 46 秒）。滚动更新：

| 客户端 | 请求 | 失败 | 延迟 p50 / p95 / 最大 | 旧 Pod：SIGTERM → `shutdown complete` | 强制关闭 |
| --- | --- | --- | --- | --- | --- |
| 复用长连接（`http.Agent({ keepAlive: true })`，2 并发、间隔 250 ms，模拟 LiteLLM） | 739 | 0 | 54 / 96 / 369 ms | 25 ms、39 ms | 无 |
| 每个请求新建连接 | 539 | 0 | 70 / 668 / 1556 ms | 25 ms、4 ms | 无 |

r2 时的对照：旧 Pod 有忙碌长连接时要等满 25 秒才强制关闭，669 个请求中 1 个 `ECONNRESET`。随后 SSO、Login、Console 依次重启，7 个旧容器都以退出码 0（`Completed`）在删除请求后 9–11 秒内结束。全部通过后按规则删除了 kind 集群、它的 kubeconfig、测试用 node 镜像 tag 和外部 MySQL 容器；默认 kubeconfig 的当前 context 仍为原值，文件哈希不变。

**`3d6db1a` 的两次运行（如实记录）**：各 34/35，唯一的失败都是新收紧的零失败断言，原因都是 HTTP 503 `pool_storage_unavailable`（Proxy 的 MySQL 操作 5 秒时限），不是连接级错误，也与停止无关：

- 第 1 次：复用长连接客户端 596 个请求中 1 个 503，发生在最后一个旧 Pod SIGTERM 之后 74 秒（滚动早已完成，在新 Pod 上）；两个旧 Pod 的排空分别为 38 ms、5 ms，没有强制关闭；同一 10 秒内的最慢请求 3.3 秒。新建连接客户端 642/642。
- 第 2 次：复用长连接客户端 298/298（排空 1100 ms、385 ms，没有强制关闭）；新建连接客户端 542 个中 4 个 503，都在旧 Pod SIGTERM 之后 72–89 秒（新 Pod 上）。

这与 `deploy/kubernetes/README.md` 第 10.2 节记录的 Docker Desktop 上 MySQL 偶发 503 是同一现象。两次运行合计 2078 个请求，没有任何连接级失败，旧 Pod 都没有强制关闭；断言没有放宽。`f43f27e` 的运行在 Docker Desktop 负载较低时进行，没有出现 503。

### 6. CVE-2026-111181 / CVE-2026-113872 的处理

`3d6db1a` 镜像的扫描（与 r2 同一时间、同一漏洞库）发现两条新公开、有修复版本的 High 级 npm 漏洞，r2 同样受影响：

| 漏洞 | 包 | 修复版本 | 批准的 npm 源 | 可达性（r2 / `3d6db1a`） | r3（`f43f27e`）的处理 |
| --- | --- | --- | --- | --- | --- |
| CVE-2026-111181 | `body-parser@2.3.0`（express 5.2.1 的依赖，四个镜像） | 2.4.0 | 只到 2.3.0（推测受最短发布期管控限制） | **可达**：四个服务都在全局挂载 `express.json`（SSO 另有 `express.urlencoded`），在路由和鉴权之前解析请求体；公开说明为带 `Content-Encoding` 的请求体可导致进程退出 | 版本不变，加 `inflate: false` 缓解：压缩请求体在创建解压流之前就以 415 拒绝，漏洞路径不可达 |
| CVE-2026-113872 | `multer@2.4.0`（根依赖，四个镜像） | 2.5.0 | 只到 2.4.0 | 不可达：产品代码从未引用 | 删除依赖，镜像中不再有 multer |

缓解的范围与限制：

- 四个服务都不再接受压缩的请求体（JSON，以及 SSO 的表单），一律 415；响应不受影响。LiteLLM、浏览器、Console 与服务之间的调用默认都发送未压缩的请求体（第 2、3、5 节的全部流程照常通过）；若网关或客户端开启了请求体压缩，必须关闭。已写入 `docs/user-pool-configuration-reference.md` 第 12 节。
- 单元测试：四个服务对 gzip、deflate 的 JSON 请求体返回 415（SSO 的表单同样），未压缩的请求体仍被解析（Console 与 SSO 的登录、Login 的建任务都按请求体内容返回 401/400）。
- SSO、Login 对**格式错误**的 JSON 仍返回 500 `internal_error`（r2 已有的行为，本次未改）。
- body-parser 仍是 2.3.0，Scout 仍会按版本报告 CVE-2026-111181（第 8 节）。批准的源提供 2.4.0 后应升级并去掉 `inflate: false`。

### 7. 单元与集成测试（提交 `f43f27e`）

| 范围 | 结果 |
| --- | --- |
| 全仓 typecheck（含 upgrade 工具） | 通过 |
| shared | 147/147（含 `e6112c9` 修正后的停止测试） |
| Proxy | 682 条：642 通过、40 跳过（需 MySQL，另行运行）、0 失败（含新的 415 测试） |
| Proxy MySQL 集成（MySQL 8.4 一次性容器，逐个文件） | 13 个文件：`mysqlStorage` 2/2、`mysqlEnterpriseMigrations` 10/10、`scheduling` 2/2、`mysqlStore` 34/34（单独重跑）、`mysqlRecovery` 5/5、`mysqlLifecycle` 2/2（单独重跑）、`mysqlCallerIsolation` 3/3、`mysqlAdmission` 16/16、`loginPollingRecovery` 6/6（单独重跑）、`inferenceTimeout.mysql` 3/3、`userPoolCredentialRace` 10/10、`userPoolCatalogPressure.mysql` 2/2；`ownerSideEffects` **未能在本机得到一次 22/22**（见下） |
| SSO / Login / Console | 96/96、62/62、36/36（各含新的 415 测试） |
| Console 浏览器测试（本机 Edge headless，`--test-concurrency=1` 串行） | 71/71，一次通过 |
| 离线迁移工具（`upgrade/user-pool-mysql` 三个测试文件 + `upgrade/sqlite-to-mysql` 集成测试，MySQL 用例在 MySQL 上） | 133/133 |
| 资格测试脚本与 mock（`qualification-multi-lib` 27、`mock-services.tenants` 5、`mock-login-queue` 3、`mysql-bridge` 2、`local-diagnostics-contract` 3） | 40/40 |
| 部署脚本（`deploy/images/package-runtime` 2、`deploy/user-pool-mysql-customer/package` 9、`deploy/kubernetes/package` 13） | 24/24 |

**MySQL 集成测试（如实记录）**：首轮逐文件运行时，kind 集群的节点容器仍在后台运行（空闲时约 37% CPU），`ownerSideEffects` 16/22（6 条 30 秒超时取消）、`mysqlStore` 28/34、`mysqlLifecycle` 1/2、`loginPollingRecovery` 5/6（1 条取消）。停掉 kind 节点后单独重跑：`mysqlStore` 34/34、`mysqlLifecycle` 2/2、`loginPollingRecovery` 6/6；`ownerSideEffects` 连续 5 次都是 21/22 或 20/22，每次失败的是不同的“owner 交接”用例（例如期望 `oauth-wait` 实际仍为 `oauth-starting`，期望 `ready` 实际仍为 `provisioning`），都是等待状态推进的计时断言。其中第 4、5 次期间主机出现过一次约 9 分钟的停顿（见第 9 节）。这个文件测试的 `src/proxy/src/userPool/` 代码在 `3d6db1a..f43f27e` 之间没有任何改动，也不引用本次改动的文件（`server.ts`、`operationRoutes.ts`）；在 `3d6db1a` 上同一文件首轮 21/22、随后单独重跑两次 22/22。结论：计时类不稳定、与本次改动无关，之后在主机空闲时于 `f43f27e` 上再单独重跑 3 次：22/22、21/22、21/22，取得了完整通过记录；单条计时断言偶发失败仍然存在，属于这个测试文件已知的不稳定，与本次改动无关。

### 8. 镜像扫描（Docker Scout）

同一天、同一漏洞库扫描了 r3（`f43f27e`，全部级别）、`3d6db1a` 和 r2（critical/high；`3d6db1a` 另扫了全部级别）：

| 镜像 | r3 `f43f27e`：Critical / High | `3d6db1a` | r2（今天的漏洞库） | 说明 |
| --- | --- | --- | --- | --- |
| Proxy / SSO / Console | 0 / 9 | 0 / 10 | 0 / 10 | r3 与 r2 相比：multer 的 CVE-2026-113872 消失（镜像中已无 multer）；其余与 r2 逐条相同 |
| Login | 0 / 10 | 0 / 11 | 0 / 15 | 另外 r3 的 Login 层中 expat 为 `2.5.0-1+deb12u5`、openssl 为更新版本，r2 中 4 条有修复的 expat/openssl 漏洞（CVE-2025-59375、CVE-2026-102633、CVE-2026-77214、CVE-2026-84782）不再出现；新增 expat CVE-2026-115506（Debian 尚无修复） |

- **r2 复扫结论**：已发布的 r2 四个镜像都受 CVE-2026-111181（body-parser 2.3.0，可达，见第 6 节）和 CVE-2026-113872（multer 2.4.0，不可达）影响，r2 的 Login 另有上述 4 条有修复的 Debian 漏洞（r2 构建之后 Debian 才发布修复）。r2 没有 `inflate: false` 缓解。
- **r3 仍被报告的 npm 条目只有 CVE-2026-111181**：Scout 按版本判断，body-parser 仍为 2.3.0。已按第 6 节缓解：四个服务的全部 body parser 都设置 `inflate: false`，压缩请求体在创建解压流之前就以 415 拒绝，该漏洞所需的解压路径不可达；批准的源提供 2.4.0 后升级。
- 全部级别中，除 body-parser 外没有其他有修复版本的条目（Proxy 共 51 条、Login 共 134 条，其余均为 `not fixed`）。
- 其余 High 条目都来自 Debian Bookworm 基础系统包，Scout 标注 `fixed_version: not fixed`：util-linux CVE-2026-53613、53615、76642、78408、78409、78410，perl CVE-2026-82560，zlib CVE-2026-85091（全部镜像），expat CVE-2026-115506（Login）。逐条可达性分析沿用 [单企业发布验证记录](user-pool-image-release-validation.md) 第 0.4 节；新增的 expat CVE-2026-115506 只在 Login 镜像中（随 Chromium 的系统依赖安装），可达性分析已补入该节：Node 不链接 libexpat，Chromium 只经 fontconfig 用它解析镜像内的本地字体配置，网页 XML 不经 libexpat，攻击者无法提供输入，不可达。

### 9. 失败与重跑汇总

- **停止单元测试（`3d6db1a` 中的测试问题，已在 `e6112c9` 修正）**：`lets an in-flight request finish …` 与新的 `a keep-alive connection busy at shutdown …` 在发起请求后固定等待 20 ms 就开始停止。负载下请求还没到达服务器（连接仍在建立）监听就关闭了，客户端得到 `ECONNRESET`（Linux 上为 connect，Windows 上为 read）；另外修复后服务器在响应写完后立即关闭连接，`release` 可能先于客户端读完响应体执行，旧测试断言的是客户端读到响应的顺序。实测：`3d6db1a` 的测试在 Node 22.23.3（Linux 容器）上 40 次有 11 次失败，在 Node 24（Windows）上 15 次有 13 次失败；改为等待服务器确实收到请求、并断言服务器侧“响应写完 → release”的顺序和客户端拿到完整响应体后，新代码 60/60（Linux）、25/25（Windows）通过，两个 keep-alive 测试在旧 `shutdown.ts` 上仍 60/60 失败（测试仍有区分能力）。产品代码未改。第一次在 `3d6db1a` 上跑 shared 时 147/147 是碰巧通过。
- **资格测试脚本单元测试**：首次在 CRLF 检出上 39/40（`SQLite compose mirrors …`），以 LF 重新检出后 40/40，与 r2 相同。
- **Proxy 单元测试**：一次在 kind 节点运行期间的全量运行中 `userPoolDiagnostics` 1 条超时（`TimeoutError`），单独重跑通过；`f43f27e` 的全量运行 0 失败。
- **Proxy MySQL 集成**：见第 7 节。
- **停止时的长连接检查**：4 次开发中的运行未通过，均为检查脚本问题（第 4 节）。
- **主机**：10:26–10:35 UTC 主机停顿约 9 分钟（时钟监测：一次 537 秒没有调度，墙钟与单调时钟偏差 7 ms，不是时间跳变），发生在 `ownerSideEffects` 重跑期间、资格测试开始之前；之后的资格测试、停止检查、kind 运行期间没有再出现。Docker Desktop 当天命令延迟偏高（一次 `docker stop` 约 8 秒才送达 SIGTERM，一次约 20 秒才读到日志）。
- 第 2、3 节的资格测试和 idle-target 检查都一次通过，没有重跑。

### 10. `3d6db1a` 候选（已被 `f43f27e` 取代，未发布）

`multi-3d6db1a-amd64-r3`（Proxy `sha256:1b5c0312c2c4…`、SSO `sha256:87b8a5ab2702…`、Login `sha256:4e8a0a5570d8…`、Console `sha256:f2dbf517b734…`；tar SHA-256 `50139fa385a7…`）在加入 CVE 缓解之前跑完了一轮：typecheck；shared 147/147；Proxy 681 条（641 通过、40 跳过）；Proxy MySQL 集成 13 个文件（`ownerSideEffects` 首轮 21/22、`mysqlCallerIsolation` 首轮 1/3，各单独重跑两次全部通过）；SSO/Login/Console 95/95、61/61、35/35；Console 浏览器 71/71；离线迁移工具 133/133；资格测试脚本 40/40；部署脚本 24/24；`multi-upgrade` 76、`multi-upgrade-sqlite` 19、`multi-fresh` 30、`multi-fresh-dba` 34、`multi-fresh-sqlite` 23、idle-target 19 条断言全部一次通过（项目 `ghcp-release-qualification-multi-r3-*`）；停止检查最终版本 3 次 50/50（`r3-shutdown-5/6/7`）；kind 两次运行各 34/35（第 5 节）。这些镜像保留在本地，没有删除。

### 11. 未验证的范围

- 真实 GitHub、GHE.com、Copilot 与模型调用；GHE.com 只用 mock 验证。
- 真实 LiteLLM：kind 和镜像级检查中的长连接客户端分别是 Node 的 `http.Agent({ keepAlive: true })` 和原始套接字，行为与 LiteLLM 的连接池相近，但没有用 LiteLLM 本身验证（包括它是否压缩请求体）；仓库的 LiteLLM 示例配置是 `max_retries: 0`。
- CVE-2026-111181 的缓解只按设计和单元测试验证（压缩请求体在解压之前被 415 拒绝），没有在镜像上做攻击性复现。
- SSO、Login 没有流式接口，“响应头已发出后在 `finish` 时结束套接字”只在 Proxy（SSE）、Console（CSV 转发）上做了镜像级验证，SSO、Login 由共享代码的单元测试覆盖。
- `ownerSideEffects` 在 `f43f27e` 上 8 次运行中 1 次 22/22，其余各有 1–2 条计时断言失败（第 7 节）；测试本身的不稳定已在之后单独修正（数据库时钟回拨与 5 秒步骤截止，只改测试），见 [ownerSideEffects 确定性修正](user-pool-owner-side-effects-determinism.md)。
- 资格测试中没有真实 Login 浏览器任务（kind 阶段 A 有真实 Login 的 Chromium 对 mock GHE.com）。
- `MYSQL_AUTO_MIGRATE=false` + r4 → 多企业 DBA 升级脚本只在集成测试中覆盖；全新部署的其余未覆盖项同 r2 第 3.4 节。
- 性能、容量与长时间稳定性。

证据：构建日志、测试日志、各报告与 kind 运行目录保存在本机（`.claude/multi-r3/`、`.claude/release-qualification-run-*`、`.claude/kind/`，不入库）。

---

## r2：multi-4922a4a-amd64-r2（已发布）

全部验证只使用合成数据、mock 外部服务和本地 MySQL 容器；没有调用真实 GitHub、GitHub EMU、GHE.com、Copilot 或模型，没有创建真实用户或席位，没有接触真实 SSO 环境、云资源或集群。Docker Desktop 只验证功能，不评估性能。

### 0. 与 r1 相比的变更

源码从 `41ecffc` 前进到 `4922a4a`（`main` 上的合并提交，含修复 `a060b24`）。代码改动只有三处，其余是文档：

| 变更 | 说明 |
| --- | --- |
| `src/proxy/src/userPool/config.ts` | 去掉启动时“`READY_IDLE_TARGET` 不得大于 `POOL_MAX_ACCOUNTS`”的检查。上限按企业设置，`POOL_MAX_ACCOUNTS` 只作为 `default` 企业的初始上限；全局空闲目标可以更大，所有可用企业达到上限后补货自然停止。r1 用同样的环境会拒绝启动（`Idle target exceeds pool account cap`）。 |
| `src/console/src/web/pages/EnterprisePoolPage.tsx` | Console 企业池表格的 `In flight` 列改名为 `Provisioning`。 |
| `src/proxy/src/userPool/config.test.ts` | 对应的单元测试。 |

`r` 是发布序号，因此虽然提交变了，本次仍记为 r2。

### 1. 候选镜像

构建上下文为 `git archive 4922a4a`（LF 行尾，tar 的 SHA-256 为 `d978dd2d0ef1bb694e947e89df408f15435ab1039c96cdbdd4abf9d0ce87bfa6`），`deploy/images/Dockerfile.release`，`RELEASE_LINE=multi`，linux/amd64，基础镜像仍按 digest 固定为 `node:22-bookworm-slim@sha256:efd0ab57…`，npm 源为公司批准的源。

| 组件 | 本地标签 | 镜像 ID |
| --- | --- | --- |
| Proxy | `ghcp-release-proxy:multi-4922a4a-amd64-r2` | `sha256:4a845f1ce1582ba3975d0e36e17d54c70fd75f8079e0dc5c601a1926df7dc895` |
| SSO | `ghcp-release-sso:multi-4922a4a-amd64-r2` | `sha256:62e8d5109e436b3d2a127cbd0096a902f3eaca30ad708e2cd7986397f41b5499` |
| Login | `ghcp-release-login:multi-4922a4a-amd64-r2` | `sha256:06deb18e77af634fa3f450f4401b6b595cd850fdb046bef51a5e4fae65f141fa` |
| Console | `ghcp-release-console:multi-4922a4a-amd64-r2` | `sha256:bd289d234deeb711872afe44df4004505132d386c6fc8d7f23fad2f5f8b0f3b2` |

已发布到 Docker Hub（公开仓库，2026-10-20）：

| 组件 | 按 digest 引用 |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:00453e3b81a3fea67ef05d4fce1e3def680dac96ae9ca288a85d1a77c74997b6` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:5b112760945fa5444d5720d48ddae5a4da9fa42ead08a8fa5715356395dcefe7` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:6a7e48f79a86a04a5343ad0e6c4ac9f294ddd87c772f36927f9bbb148ffe1d2e` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:a1605e6304597387e3e193223b01823d89b7a007d7e7bb5d8e44e236b97d3e2c` |

发布后核对：每个 manifest 的 config digest 等于上表经资格测试的镜像 ID；按 digest 拉起 Proxy，`/healthz` 返回 `releaseLine: "multi"`，停止时退出码 0。

四个镜像的 label：`org.opencontainers.image.revision=4922a4a`、`com.ghcp.release-line=multi`、`org.opencontainers.image.version=multi-4922a4a-amd64-r2`。ENTRYPOINT 为 Tini，CMD 与工作目录与 r1 相同。

构建说明：

- 系统包：运行层的 `apt-get update && apt-get upgrade` 本次重新执行（未用缓存），取到当天的 Debian 安全更新。相对固定的基础镜像只升级了 `perl-base`（`5.36.0-7+deb12u3` → `deb12u4`，r1 的缓存层里已是 `deb12u4`），其余包没有可用更新。四个镜像共用同一个新的系统包层。
- 行尾：Windows 主机的 `core.autocrlf=true` 会让 `git archive` 输出 CRLF。第一次构建因此用了 CRLF 源码，发现后丢弃这批镜像（已删除，未经任何验证），改用 `git -c core.autocrlf=false archive` 重建；上表是重建后的镜像。验证用的工作区中 `tests/image-release`、`tests/docker-user-pool` 也以 LF 检出（资格测试脚本的一个单元测试按 LF 解析 `compose.yaml`）。
- 构建中两次遇到 npm 源网络超时（`ETIMEDOUT`），原样重试后成功；没有更换源或绕过 npm 发布管控。

### 2. 原地升级资格测试（设计 §9.4）

基线为已发布的单企业镜像 `single-slug-164cade-amd64-r4`，候选为上表 r2 镜像。使用文档中的命令行方式（`qualification-prepare.mjs` + `qualification-run.mjs`），全新项目名与未使用的子网，合成证书沿用 r1 的合成 IdP 证书（有效期至 2026-11-17，公私钥配对已校验）。两种模式都通过，`planCoverage.complete=true`。

#### 2.1 MySQL 8.4 + 双 Proxy（`multi-upgrade`，用时约 5 分钟）

| 步骤 | 内容 | 断言 | 结果 |
| --- | --- | --- | --- |
| 预检 | 全新项目与卷；只用本地镜像；隔离网络；旧模板命令可启动并干净退出 | 6 | 通过 |
| 1 | r4 造数据（账号、库存、caller 租约、统计、SSO 会话），停服务，mysqldump 与卷备份 | 9 | 通过 |
| 2 | 同一数据卷换成 r2，配置不变：数据逐项不变并回填 `default`；迁移记录完整；不带企业的写入被拒；同一租约的 6 种协议请求通过；r4 的 SSO 会话仍有效 | 18 | 通过 |
| 3 | r4 镜像直接启动在已迁移的 MySQL 上：拒绝启动，不改动库 | 4 | 通过 |
| 4 | 加入 registry（default + GHE.com mock 企业）：draft → readiness → 激活 → 补货 → 推理走该企业的 Copilot 地址；跨企业负面检查 | 21 | 通过 |
| 5 | 恢复第 1 步的备份，启动 r4：与升级前完全一致 | 10 | 通过 |
| 7 | 统计表放大约 1024 倍，迁移停在第 05 步时强制结束 Proxy；重启后迁移继续完成，回填完整 | 8 | 通过 |

合计 76 条断言全部通过。

**一次未完成的运行（如实记录）**：第一次 `multi-upgrade` 运行在第 1 步的基线 smoke 中失败（`baseline_smoke_passed`），随后执行器因总时限（`workflow_deadline`）未能停止容器，由人工按名称只停止了该项目自己的容器（未删除，卷保留）。容器日志显示 Proxy 在 `listening` 之后出现约 90 分钟的时间跳变，随后才报 `ownership-lost`，与主机在运行期间休眠一致。失败发生在 r4 基线阶段，候选镜像尚未启动。之后在保持主机唤醒的情况下用新的项目名和子网重跑，即上表结果。

#### 2.2 SQLite 直连（`multi-upgrade-sqlite`，用时约 4 分钟）

第 6 步：r4 造数据并备份 → r2 升级（旧值保留、回填 `default`、迁移记录完整、旧 `/api/accounts` 带 `Deprecation`、无作用域路径返回 400、会话有效）→ r4 在已迁移的库上写入被拒 → 恢复备份后与基线一致。

| 子步骤 | 断言 | 结果 |
| --- | --- | --- |
| 预检 | 3 | 通过 |
| step6-baseline | 4 | 通过 |
| step6-candidate | 9 | 通过 |
| step6-r4-on-migrated | 1 | 通过 |
| step6-restore | 2 | 通过 |

合计 19 条断言全部通过。

#### 2.3 全局空闲目标大于默认企业上限（本次新增，`tests/image-release/idle-target-cap-check.mjs`）

独立、隔离的检查：Proxy 以 caller-lease 模式启动，`READY_IDLE_TARGET=5`、`POOL_MAX_ACCOUNTS=2`；SQLite 模式无网络，MySQL 模式只连一个 internal 网络上的一次性 MySQL 8.4；不发布端口，请求在容器内发出；全部为合成凭据。通过后只删除本检查自己创建的容器、网络和卷。

| 断言 | SQLite | MySQL |
| --- | --- | --- |
| 对照：r1（`multi-41ecffc-amd64-r1`）用同样环境拒绝启动（非 0 退出，日志为 `Idle target exceeds pool account cap`） | 通过 | — |
| r2 启动成功，`/healthz` 的 `releaseLine` 为 `multi` | 通过 | 通过 |
| `GET /api/user-pool/settings` 的 `idle_target` 为 5 | 通过 | 通过 |
| `default` 企业的上限由 `POOL_MAX_ACCOUNTS` 初始化为 2 | 通过 | 通过 |
| `PATCH /api/user-pool/settings` 把 `idle_target` 改为 50（大于上限 2）返回 200，版本 +1 | 通过 | 通过 |
| 重新读取为 50 | 通过 | 通过 |
| 设置里带 `max_accounts` 仍返回 409 `use_enterprise_cap` | 通过 | 通过 |
| `idle_target` 超过名称容量（10001）仍返回 400 | 通过 | 通过 |
| 修改后 `default` 上限仍为 2，库存不超过上限 | 通过 | 通过 |
| 同样环境重启后正常启动，`idle_target` 保持 50 | 通过 | 通过 |

合计 19 条断言全部通过。由于无网络，补货无法真正进行，本检查不覆盖“补货在所有企业达到上限后停止”的运行时行为；该行为由 Proxy 存储契约测试（`enterprise caps bound creation, and a raised cap resumes it`）覆盖。

证据：报告与日志保存在本机运行目录（`.claude/release-qualification-run-*`、`.claude/multi-r2/`，不入库）。

### 3. 全新部署资格测试（发布后补充，2026-10-22）

第 2 节只验证了 r4 → r2 的原地升级。本节用**同一批 r2 镜像**（第 1 节的镜像 ID，与 Docker Hub digest 字节相同；没有构建、拉取或推送）验证全新的单企业部署：空数据库、空卷、**没有** enterprise registry 文件，`default` 企业由各服务的环境变量合成。资格测试脚本新增三个模式（`tests/image-release/README.md` 的“多企业镜像的全新单企业部署资格验证”），每次运行都用全新的项目名和未使用的子网；只用 mock、本地 MySQL 8.4 容器、合成证书与合成凭据，应用容器只在 internal 网络上，没有访问真实 GitHub、GHE.com、Copilot 或模型。

| 模式 | 环境 | 用时 | 断言 | 结果 |
| --- | --- | --- | --- | --- |
| `multi-fresh` | MySQL 8.4 空库 + 两个 Proxy 副本（caller-lease）+ SSO/Login/Console + mock + 回环 bridge；Proxy 自动迁移（不设 `MYSQL_AUTO_MIGRATE`，即默认 `true`） | 约 3.5 分钟 | 30 | 通过 |
| `multi-fresh-dba` | 同上；DBA 先执行 `scripts/proxy-mysql-initial.sql`，运行账号只保留库级 `SELECT, INSERT, UPDATE, DELETE` 与 `proxy_accounts` 上的 `TRIGGER`，两个副本 `MYSQL_AUTO_MIGRATE=false` | 约 3.5 分钟 | 34 | 通过 |
| `multi-fresh-sqlite` | SQLite 直连 + SSO/Login/Console + mock，空卷，无对外端口 | 约 1 分钟 | 23 | 通过 |

三个模式的最终通过运行都基于提交后的脚本，`planCoverage.complete=true`；运行期间监测主机时钟，墙钟与单调时钟的偏差最大 7 ms，没有休眠。新增的纯函数（fresh Compose 生成、registry 引用检查、初始脚本改库名与迁移 ID 解析、DBA 授权 SQL 与 DDL 权限识别、PEM 证书哈希、计划与时限）都有单元测试：`qualification-multi-lib.test.mjs` 26 通过、1 跳过（需要已构建的 shared 包，与以前相同）。

#### 3.1 MySQL（`multi-fresh` / `multi-fresh-dba`）

| 步骤 | 内容 | `multi-fresh` | `multi-fresh-dba` |
| --- | --- | --- | --- |
| 预检 | 全新项目与卷；隔离渲染；没有任何服务引用 registry；`MYSQL_AUTO_MIGRATE` 与模式一致；只用本地候选镜像；Tini/CMD/WORKDIR 保持；旧模板命令覆盖可启动并干净退出 | 5 | 5 |
| DBA 建库 | 库里只有 fixture 表；以 utf8mb4 会话执行初始脚本后 12 张业务表齐全，`schema_migrations` 恰为脚本写入的 9 个 ID（不含 `02-seed-default`、`08-pool-config-fingerprint`），`proxy_enterprises` 为空，CHECK 字面量只有 `_utf8mb4`；`SHOW GRANTS` 无任何 DDL 权限 | — | 3 |
| 启动 | 全部服务健康；Proxy ×2、SSO、Login、Console 的 `/healthz` 都是 `releaseLine: "multi"`；`schema_migrations` 恰为 r4 的 3 个 ID + `enterprise-v1/01…08` 共 11 个，SSO 01–05、Login 01–03 齐全；（DBA）Proxy 启动前后 schema 指纹不变，Proxy 只用运行时权限补写了 02 与 08；`enterprise_id` NOT NULL 且无默认值，不带它的插入被拒（`ER_NO_DEFAULT_FOR_FIELD`）；`proxy_enterprises` 只有 `default`（active、cap 2000 = `POOL_MAX_ACCOUNTS`、库存 0），两个副本的 `GET /api/enterprises` 都只列出它，readiness 为 ready 且无 blocker；SSO、Login 的企业表也只有 `default`；单一调度 owner 并续期 | 7 | 8 |
| Console | 初始为未初始化 → 创建管理员 201 → 再次创建 400；登录 200，错误密码与匿名 401；读企业列表（只有 `default`）、`default` 的池概览、SSO 用户、Login 任务和请求统计均 200，无作用域转发 400 `enterprise_scope_required`，未登录 401 | 3 | 3 |
| 账号池 | 初始 `idle_target=0`、池与 mock 为空；经 `proxy2` 设 `idle_target=3`，5–11 秒内补到 3 个 ready idle（SCIM 创建、席位、Login 任务、回调各 3 次，失败 0，预热推理 3 次），库存计数 3；成员与账号都属于 `default`，Login 任务全部走 `/api/enterprises/default/tasks`；SSO 有 3 个用户 | 3 | 3 |
| caller | 新 caller 的 SSE 请求在 `proxy` 上被 mock 挂住时，从 `proxy2` 看到 `provisional` 租约（TTL 60 秒）；取消后同一 caller 的 6 个请求（`/v1/messages`、`/chat/completions`、`/responses` × JSON/SSE，两副本交替）全部打到同一成员；租约在两副本上都是 `active` 且 `leaseId` 不变；统计 7 行（6 行成功 + 1 行被取消的挂起请求）全部为 `default`；第二个 caller 拿到另一个成员 | 5 | 5 |
| 作用域 | `/api/enterprises/default/...` 7 个路径（Proxy 账号、统计、池概览/租约/事件，SSO 用户，Login 任务）都是 200；无作用域的 7 个路径（Proxy 统计、`/internal/accounts/...`、两副本的池接口，SSO 用户与 `/internal/users/...`，Login 任务）都是 400 `enterprise_scope_required` | 2 | 2 |
| SSO | 根路径 `/login` 登录得到 `e: "default"` 的 `sso_session`，错误密码 401；`/sso` 用该会话返回 SAMLResponse，匿名时重定向到 `/login`；`/metadata` 的 entityID 存在、证书即合成证书 | 3 | 3 |
| 运行时 | 五个应用容器内 `qualification-verify-runtime.mjs … candidate scoped 3` 全部通过（Tini、无 npm、依赖版本与行为、better-sqlite3、Login 内 Chromium、作用域管理 API 与无作用域 400） | 1 | 1 |
| 停止 | 五个应用停止，退出码全部为 0 | 1 | 1 |
| 合计 | | 30 | 34 |

#### 3.2 SQLite 直连（`multi-fresh-sqlite`）

| 步骤 | 内容 | 断言 |
| --- | --- | --- |
| 预检 | 全新项目与卷；隔离渲染、无 registry；只用本地候选镜像；Tini/CMD/WORKDIR 保持 | 4 |
| 启动 | 健康（`/readyz` 的 storage 为 `sqlite`）；四个应用 `releaseLine: "multi"`；Proxy `enterprise-v1/01…05`、SSO 01–05、Login 01–03 齐全，三个库 `integrity_check` 为 ok；fail-closed trigger 存在；Proxy、SSO、Login 的企业表都只有 `default`（Proxy 中为 active），`GET /api/enterprises` 只列出 `default` 且 `pool: null`（直连模式下作用域池接口返回 409 `pool_mode_disabled`，记录为证据） | 5 |
| Console | 同 3.1 | 3 |
| 直连 | 经作用域接口建 SSO 用户、导入合成 OAuth token（成功 1）；`/v1/messages` JSON 与 SSE 都 200，mock 收到 2 次且 token 正确；统计 2 行、账号 1 行都是 `default`；旧 `/api/accounts` 200 且带 `Deprecation: true` | 4 |
| 作用域 | 作用域 4 个路径 200；无作用域 5 个路径 400 `enterprise_scope_required` | 2 |
| SSO | 同 3.1 | 3 |
| 运行时 | 四个应用容器内运行时检查通过（`scoped`，SSO 用户数 1） | 1 |
| 停止 | 四个应用退出码 0 | 1 |
| 合计 | | 23 |

#### 3.3 失败与重跑（如实记录）

最终通过前共有 5 次未通过的运行，每次都换新的项目名和子网重跑，没有复用任何部分结果。

| 运行 | 失败位置 | 原因 | 处理 |
| --- | --- | --- | --- |
| `multi-fresh` 第 1 次 | 启动：所有服务已健康，资格测试的只读 MySQL 观察连接经本机回环 bridge 握手超时（`ER_NET_READ_INTERRUPTED`） | Docker Desktop 端口转发的瞬时问题，与镜像无关 | 观察连接在连接级错误时最多重试 3 次，重试次数写入报告（`transport`）；最终运行未发生重试 |
| `multi-fresh` 第 2 次 | 账号池：300 秒内未达空闲目标，9 个成员全部 `failed`（`oauth_login_failed`） | 多企业版 Proxy 在 Login 回传 token 时用 `default` 的 GitHub REST API 调 `GET /user` 核对身份（设计 §5.7，升级指南与 Proxy README 已写明）。r4 资格验证环境只给 SSO 设了 `GITHUB_API_BASE_URL`，Proxy 因而用默认的 `https://api.github.com`；internal 网络访问不到（没有请求离开隔离网络），回调 503，成员重试三次后失败 | 测试环境给两个 Proxy 加 `GITHUB_API_BASE_URL=http://mock:8002`。不是产品缺陷，但值得在部署说明中强调：GitHub API 走网关、只给 SSO 设了该变量的环境，换成多企业版后 Proxy 也必须设置，否则补货全部失败 |
| `multi-fresh-dba` 第 1 次 | DBA 建库：收回运行账号权限的 `REVOKE … ON db.*` 报 1141 | 测试脚本问题：MySQL 镜像入口脚本按转义下划线的库名授权 | 改为 `REVOKE ALL PRIVILEGES, GRANT OPTION FROM <user>` |
| `multi-fresh-dba` 第 2 次 | 启动：Proxy 拒绝启动 | **发现**，见下 | 改用 utf8mb4 会话执行脚本，并把“CHECK 字面量只有 `_utf8mb4`”加进断言 |
| `multi-fresh-dba` 第 3 次 | DBA 建库：CHECK 字面量字符集解析为空 | 测试脚本问题：batch 输出对反斜杠再转义一次 | 修正解析 |

**发现：DBA 用默认 latin1 会话执行初始脚本时，r2 Proxy 拒绝启动。** 官方 `mysql:8.4` 镜像里的 `mysql` 客户端在 POSIX locale 下默认 `character_set_client=latin1`。用它直接执行 `scripts/proxy-mysql-initial.sql` 时，CHECK 约束里的字符串字面量被保存为 `_latin1'draft'` 等；r2 Proxy 在 `MYSQL_AUTO_MIGRATE=false` 下只接受 `_utf8mb4`、`_ascii` 前缀，启动报 `Proxy MySQL schema is not ready for MYSQL_AUTO_MIGRATE=false: Unsupported MySQL schema: proxy_enterprises check constraints`（`user_pool_accounts`、`user_pool_leases` 的 CHECK 同样是 `_latin1`）。以 `--default-character-set=utf8mb4` 执行同一脚本则一切正常（上表 34 条）。集成测试用 mysql2 的 utf8mb4 连接执行脚本，所以没有发现。升级脚本 `scripts/proxy-mysql-enterprise-upgrade.sql` 含同样的 CHECK，预计有同样的问题（未在镜像级验证）。建议：生成的两个脚本开头加 `SET NAMES utf8mb4;`，或校验器接受任意字符集前缀的 ASCII 字面量；在此之前，在 README 与升级指南中写明 DBA 需用 utf8mb4 会话（例如 `mysql --default-character-set=utf8mb4`）。本分支只改资格测试脚本与文档，产品代码和脚本未改动。

**修复（脚本层，镜像不变）：** 生成器在两个脚本的表结构语句之前加入 `SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;`（全新部署脚本放在“库已存在时从这里开始”标记之后），并有单元测试约束位置。修复后的复核：用官方 `mysql:8.4` 镜像的客户端、**不加任何字符集参数**（默认 latin1 会话）执行脚本，r2 Proxy 以 `MYSQL_AUTO_MIGRATE=false` 启动，隔离网络、合成凭据：

| 场景 | 新脚本 | 修复前脚本（对照） |
| --- | --- | --- |
| 全新空库执行 `proxy-mysql-initial.sql` | 启动正常，CHECK 字面量为 `_utf8mb4`，停止退出码 0 | 拒绝启动（`proxy_enterprises check constraints`，`_latin1`） |
| r4 库（以 utf8mb4 会话建表，与 r4 自动迁移一致）执行 `proxy-mysql-enterprise-upgrade.sql` | 启动正常，停止退出码 0 | 拒绝启动（`proxy_enterprises check constraints`） |

另外确认：r4 的表结构如果当初是用 latin1 会话按 r4 脚本建的，r4 Proxy 自己就拒绝启动（`user_pool_accounts check constraints`），这样的库不会出现在正在运行的 r4 环境中，所以不构成 r4 → 多企业升级的新障碍。`multi-fresh-dba` 模式此后改为用客户端默认会话执行初始脚本，直接覆盖这项修复。

#### 3.4 本节未覆盖

- SQLite 直连只验证 `/v1/messages`（`tests/image-release/mock.mjs` 只实现这一条）；`/chat/completions`、`/responses` 在 MySQL caller-lease 模式下覆盖。SQLite 下的 caller-lease（账号池）模式未覆盖。
- 全新部署时由 registry 文件定义 `default`（或同时定义多个企业）的情形；r4 → 多企业的 DBA 升级脚本仍只在集成测试中覆盖。
- `default` 补货以外的生命周期（cap 调整、draining、成员禁用与重新授权）；真实 Login 浏览器任务（Login 任务数仍为 0）；Kubernetes/Rancher 模板；性能与长时间稳定性。

证据：报告与日志保存在本机运行目录（`.claude/release-qualification-run-*`，不入库）；各次运行的项目、容器、网络和卷都已停止并保留。

### 4. 单元与集成测试（提交 `4922a4a`）

| 范围 | 结果 |
| --- | --- |
| 全仓 typecheck（含 upgrade 工具） | 通过 |
| shared | 145/145 |
| Proxy | 680 条：639 通过、40 跳过（需 MySQL，另行运行）、1 失败。失败项为 `mysqlMigrationLock.test.ts` 的 “migration CREATE TABLE timeout destroys without recycling”，单独重跑 3 次均 18/18 通过。另有一轮与镜像构建同时运行的全量测试出现 2 失败、1 取消（`loginPollingRecovery`、`mysqlAdmission.integration`、`mysqlCallerIsolation` 中的超时类用例），这几个文件单独重跑全部通过。 |
| Proxy MySQL 集成（MySQL 8.4，逐个文件） | 13 个文件全部通过。其中 `mysqlStore.integration` 和 `loginPollingRecovery` 在主机负载高时于普通磁盘 MySQL 上超时失败，主机空闲后在同一普通磁盘 MySQL 上复跑通过（34/34、6/6），见下文 |
| SSO / Login / Console | 95/95、61/61、35/35 |
| Console 浏览器测试（本机 Edge headless，串行） | 71 条：70 通过、1 失败（“SSO sync submits directly once …”，服务端计数尚未记录请求时就断言）。单独重跑该文件时这条通过，另一条（“logout and session expiry clear action snapshots …”）因 8 秒点击超时失败；两条再单独重跑都通过。每条测试都至少通过一次，失败都是计时类。 |
| 离线迁移工具（`upgrade/user-pool-mysql` 三个测试文件 + `upgrade/sqlite-to-mysql` 集成测试，MySQL 用例在 MySQL 上） | 133/133 |
| 资格测试脚本与 mock | `qualification-multi-lib` + `mock-services.tenants`：25/25；连同 `mock-login-queue`、`mysql-bridge`、`local-diagnostics-contract` 共 33/33。r1 记录为 45/45，但未写明文件组合，两者数字不能直接比较。 |
| 部署脚本 | 11/11 |

**MySQL 集成测试的详细情况（如实记录）**

本机 Docker Desktop 在测试期间明显变慢：容器内 `dd … oflag=dsync` 约 24 ms 一次同步写，`docker exec … SELECT 1` 约 2.7–3.1 秒。

- 普通磁盘（匿名卷）上的 MySQL 8.4：
  - 第一次逐文件运行时，11 个文件全部通过：`mysqlStorage` 2/2、`mysqlEnterpriseMigrations` 10/10、`scheduling` 2/2、`ownerSideEffects` 22/22、`mysqlRecovery` 5/5、`mysqlLifecycle` 2/2、`mysqlCallerIsolation.integration` 3/3、`mysqlAdmission.integration` 16/16、`inferenceTimeout.mysql` 3/3、`userPoolCredentialRace` 10/10、`userPoolCatalogPressure.mysql` 2/2。
  - `mysqlStore.integration`（34 条）运行 3 次都失败，失败数逐次增加，报告的 fail 数（含父级套件）依次为 2、4、6。失败的叶子用例：
    - 第 1 次：`one replenishment batch fills 500/300/200 from empty as 25/15/10 for T=50`。
    - 第 2 次：上一条，加上 `replenishment issues at most one aggregate per batch; admission issues none` 和 `enterprise caps bound creation, and a raised cap resumes it`。
    - 第 3 次：`one replenishment batch …`、`multi-writer reservations obey hard cap, retries count toward future inventory`、`reservation batches bounded, aliases skipped, and name exhaustion never wraps`、`same caller races converge; distinct callers never share a member`。
    - 错误一律是 `MysqlDeadlineError: User pool MySQL deadline exceeded during query`（`POOL_SQL_TIMEOUT`，即每条语句 5 秒的时限）。
  - `loginPollingRecovery`（6 条，含 MySQL 场景）：第一次 4 通过、2 取消（`disabled-read-rejection`、`success-callback-race` 超过 45 秒的测试时限）；单独重跑时 3 通过、1 失败（`failed-read-503`，连接 MySQL 时 `connect ETIMEDOUT`）、2 取消（同上两条超时）。
- 同一 MySQL 8.4 镜像、数据目录放在 tmpfs 的一次性容器：`mysqlStore.integration` **34/34 通过**，`loginPollingRecovery` **6/6 通过**。
- 次日主机空闲时（容器内 `SELECT 1` 往返约 0.7 秒，此前约 3 秒），在**同一个普通磁盘 MySQL 容器**上逐个复跑：`mysqlStore.integration` **34/34 通过**，`loginPollingRecovery` **6/6 通过**。

结论：这两个文件此前的失败都是超时类（语句时限、测试时限、连接超时），出现在主机负载高、Docker Desktop 磁盘明显变慢的时段；主机空闲后在同一普通磁盘 MySQL 上复跑全部通过。与本次代码改动无关（改动只涉及启动配置校验和 Console 列名）。

### 5. 镜像扫描（Docker Scout）

在同一时间、同一漏洞库下扫描了 r2 和 r1 的四个镜像（critical/high）：

| 镜像 | Critical | High | 与 r1 对比 |
| --- | --- | --- | --- |
| Proxy / SSO / Console | 0 | 8 | 漏洞编号逐条相同 |
| Login | 0 | 10 | 漏洞编号逐条相同 |

全部来自 Debian Bookworm 基础系统包，Scout 标注 `fixed_version: not fixed`，没有可用修复，因此本次没有可以修复的项：

- util-linux `2.38.1-5+deb12u3`：CVE-2026-53613、53615、76642、78408、78409、78410（全部镜像）；
- perl `5.36.0-7+deb12u4`：CVE-2026-82560（全部镜像）；
- zlib `1:1.2.13.dfsg-1`：CVE-2026-85091（全部镜像）；
- expat `2.5.0-1+deb12u4`：CVE-2026-77214（Login）；
- openssl `3.0.22-1~deb12u1`：CVE-2026-84782（Login）。

应用依赖（npm）没有 critical/high 告警。逐条可达性分析沿用 [单企业发布验证记录](user-pool-image-release-validation.md) 第 0.4 节；本次没有新增编号，结论不变。

### 6. 未验证的范围

- 真实 GitHub、GHE.com、Copilot 与模型调用；GHE.com 只用 mock 验证。
- OpenCode OAuth client id 能否用于 `*.ghe.com`（设计 §13 第 4 项）。
- 资格测试中没有真实 Login 浏览器任务；Login 浏览器流程由 Login 自带的浏览器测试覆盖。
- `MYSQL_AUTO_MIGRATE=false` + r4 → 多企业 DBA 升级脚本的路径只在集成测试中覆盖。全新库的初始脚本已在第 3 节做了镜像级验证（需 utf8mb4 会话，见 3.3）。
- 第 2.3 节在无网络环境下进行，不覆盖空闲目标大于上限时的实际补货行为。
- 全新部署的其余未覆盖项见 3.4。
- 性能、容量与长时间稳定性。

---

## r1：multi-41ecffc-amd64-r1（已发布）

全部验证只使用合成数据、mock 外部服务和本地 MySQL 容器；没有调用真实 GitHub、GHE.com、Copilot 或模型，没有创建真实用户或席位。Docker Desktop 只验证功能，不评估性能。

### 1. 候选镜像

源码提交 `41ecffc`（分支 `feat/multi-enterprise`，基于已发布的单企业 r4 `164cade`）。构建上下文为该提交的 `git archive`，`RELEASE_LINE=multi`，linux/amd64。

| 组件 | 本地标签 | 镜像 ID |
| --- | --- | --- |
| Proxy | `ghcp-release-proxy:multi-41ecffc-amd64-r1` | `sha256:06e46643d59256844025dc0710b6e1edb043e951154cbbf491043fde495abc7a` |
| SSO | `ghcp-release-sso:multi-41ecffc-amd64-r1` | `sha256:e30edff3ce3016e2f5f51bd71a16ac39dcf883dbf1127db95315b004340070d4` |
| Login | `ghcp-release-login:multi-41ecffc-amd64-r1` | `sha256:08601c95c6d5460a99333cb78249a40ea50bc287c48bbfd464d12fac64ab0b60` |
| Console | `ghcp-release-console:multi-41ecffc-amd64-r1` | `sha256:2430525644eb53ebb7d2daee1cc8c688240a4263f5889e870f3b2c1686bbafa0` |

已发布到 Docker Hub（公开仓库）：

| 组件 | 按 digest 引用 |
| --- | --- |
| Proxy | `docker.io/linkinchow/ghcp-proxy@sha256:e2632d5120e333824c57436879fdff795b3d14ad57ca5f44e60747a719aba648` |
| SSO | `docker.io/linkinchow/ghcp-sso@sha256:29e3e9adefc225c1325d93eab43bbadb6a114f6c5dd6a4f236889292d33cf1a9` |
| Login | `docker.io/linkinchow/ghcp-login@sha256:7c71e1e85c703a580413f5776640ea656f8b0eebbef903ea24a8fb4ad412b0fd` |
| Console | `docker.io/linkinchow/ghcp-console@sha256:52f6677539dd45ef70805f374c1d468bf17c32dfa632c03ed8779fffc9503c53` |

发布后不登录核对：tag `multi-41ecffc-amd64-r1` 指向上述 digest；每个 manifest 的 config digest 等于上表经资格测试的镜像 ID；按 digest 拉起 Proxy，`/healthz` 返回 `releaseLine: "multi"`，停止时退出码 0。

四个镜像的 label：`org.opencontainers.image.revision=41ecffc`、`com.ghcp.release-line=multi`、`org.opencontainers.image.version=multi-41ecffc-amd64-r1`。

### 2. 原地升级资格测试（设计 §9.4）

基线为已发布的单企业镜像 `single-slug-164cade-amd64-r4`。两种模式各跑一次，全部通过。

#### 2.1 MySQL 8.4 + 双 Proxy（`multi-upgrade`，用时约 8 分钟）

| 步骤 | 内容 | 断言 | 结果 |
| --- | --- | --- | --- |
| 预检 | 全新项目与卷；只用本地镜像；隔离网络 | 6 | 通过 |
| 1 | r4 造数据（账号、库存、caller 租约、统计、SSO 会话），停服务，mysqldump 与卷备份 | 9 | 通过 |
| 2 | 同一数据卷换成多企业镜像，配置不变：数据逐项不变并回填 `default`；迁移记录完整；不带企业的写入被拒；同一租约的 6 种协议请求通过；r4 的 SSO 会话仍有效 | 18 | 通过 |
| 3 | r4 镜像直接启动在已迁移的 MySQL 上：拒绝启动，不改动库 | 4 | 通过 |
| 4 | 加入 registry（default + GHE.com mock 企业）：新企业为 draft → readiness 通过 → 激活 → 补货 → 推理走该企业的 Copilot 地址；跨企业负面检查（错企业回调、同名 SSO 用户、cookie 互换与伪造、无作用域路径） | 21 | 通过 |
| 5 | 恢复第 1 步的备份，启动 r4：与升级前完全一致 | 10 | 通过 |
| 7 | 统计表放大约 1024 倍，迁移停在第 05 步时强制结束 Proxy；重启后迁移继续完成，回填完整 | 8 | 通过 |

#### 2.2 SQLite 直连（`multi-upgrade-sqlite`，用时约 2 分钟）

第 6 步：r4 造数据并备份 → 多企业镜像升级（旧值保留、回填 `default`、迁移记录完整、旧 `/api/accounts` 带 `Deprecation`、无作用域路径返回 400、会话有效）→ r4 在已迁移的库上写入被拒 → 恢复备份后与基线一致。19 条断言全部通过。

证据：报告与日志保存在本机运行目录（`.claude/release-qualification-run-*`，不入库）。

### 3. 单元与集成测试（提交 `41ecffc`）

| 范围 | 结果 |
| --- | --- |
| 全仓 typecheck | 通过 |
| shared | 145/145 |
| Proxy | 638 通过、0 失败（整套并行时偶发的 3 条超时，单独重跑通过）；40 条需 MySQL，另行运行 |
| Proxy MySQL 集成（MySQL 8.4，逐个文件） | 13 个文件全部通过，含 SQLite/MySQL 一致性场景 |
| SSO / Login / Console | 95/95、61/61、35/35 |
| Console 浏览器测试（Edge，串行） | 71/71 |
| 离线迁移工具 | 59 通过、0 失败；MySQL 用例在 MySQL 上通过 |
| 资格测试脚本与 mock | 45/45 |
| 部署脚本 | 9/9 |

### 4. 镜像扫描（Docker Scout）

| 镜像 | Critical | High | 说明 |
| --- | --- | --- | --- |
| Proxy / SSO / Console | 0 | 8 | 漏洞编号与 r4 逐条相同，均来自 Debian Bookworm 基础系统包，Debian 暂无修复 |
| Login | 0 | 10 | 漏洞编号与 r4 逐条相同（含 Chromium 依赖） |

应用依赖（npm）各级别均为 0。逐条可达性分析沿用 [单企业发布验证记录](user-pool-image-release-validation.md) 第 0.4 节。

### 5. 未验证的范围

- 真实 GitHub、GHE.com、Copilot 与模型调用；GHE.com 只用 mock 验证。首次在 GHE.com 使用时请先在预发布环境验收。
- OpenCode OAuth client id 能否用于 `*.ghe.com`（设计 §13 第 4 项）。
- 资格测试中没有真实 Login 浏览器任务（Login 任务历史只做了表级比对）；Login 浏览器流程由 Login 自带的浏览器测试覆盖。
- `MYSQL_AUTO_MIGRATE=false` + DBA 升级脚本的路径只在集成测试中覆盖，未在镜像资格测试中覆盖。
- 性能、容量与长时间稳定性。
