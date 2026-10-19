# 多企业版发布验证记录

本文记录多企业版（multi-enterprise / multi-slug SSO）候选镜像的发布前验证结果。设计见 [multi-enterprise-design.md](multi-enterprise-design.md)，升级步骤见 [multi-enterprise-upgrade-guide.md](multi-enterprise-upgrade-guide.md)。当前候选为 r2（`multi-4922a4a-amd64-r2`，待发布）；已发布的 r1（`multi-41ecffc-amd64-r1`）记录保留在后半部分。

## r2：multi-4922a4a-amd64-r2（候选，待发布）

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

Docker Hub：**待发布**（发布需另行确认；发布后在此补充按 digest 引用与不登录核对结果）。

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

### 3. 单元与集成测试（提交 `4922a4a`）

| 范围 | 结果 |
| --- | --- |
| 全仓 typecheck（含 upgrade 工具） | 通过 |
| shared | 145/145 |
| Proxy | 680 条：639 通过、40 跳过（需 MySQL，另行运行）、1 失败。失败项为 `mysqlMigrationLock.test.ts` 的 “migration CREATE TABLE timeout destroys without recycling”，单独重跑 3 次均 18/18 通过。另有一轮与镜像构建同时运行的全量测试出现 2 失败、1 取消（`loginPollingRecovery`、`mysqlAdmission.integration`、`mysqlCallerIsolation` 中的超时类用例），这几个文件单独重跑全部通过。 |
| Proxy MySQL 集成（MySQL 8.4，逐个文件） | 13 个文件中 11 个第一次就通过；`mysqlStore.integration` 和 `loginPollingRecovery` 在普通磁盘的 MySQL 上失败，在 tmpfs 的 MySQL 上通过，见下文 |
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

结论：这两个文件在普通磁盘 MySQL 上的失败都是超时类（语句时限、测试时限、连接超时），与本次代码改动无关（改动只涉及启动配置校验和 Console 列名）；功能断言在 tmpfs MySQL 上全部通过。但它们在本机普通磁盘 MySQL 上**没有**通过，不能记为“全部通过”。建议在磁盘性能正常的环境中复跑这两个文件。

### 4. 镜像扫描（Docker Scout）

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

### 5. 未验证的范围

- 真实 GitHub、GHE.com、Copilot 与模型调用；GHE.com 只用 mock 验证。
- OpenCode OAuth client id 能否用于 `*.ghe.com`（设计 §13 第 4 项）。
- 资格测试中没有真实 Login 浏览器任务；Login 浏览器流程由 Login 自带的浏览器测试覆盖。
- `MYSQL_AUTO_MIGRATE=false` + DBA 升级脚本的路径只在集成测试中覆盖。
- `mysqlStore.integration`、`loginPollingRecovery` 未在普通磁盘 MySQL 上通过（见第 3 节）。
- 第 2.3 节在无网络环境下进行，不覆盖空闲目标大于上限时的实际补货行为。
- Docker Hub 推送与按 digest 拉取核对（待发布）。
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
