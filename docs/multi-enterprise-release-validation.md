# 多企业版发布验证记录（multi-41ecffc-amd64-r1）

本文记录多企业版（multi-enterprise / multi-slug SSO）候选镜像的发布前验证结果。设计见 [multi-enterprise-design.md](multi-enterprise-design.md)，升级步骤见 [multi-enterprise-upgrade-guide.md](multi-enterprise-upgrade-guide.md)。

全部验证只使用合成数据、mock 外部服务和本地 MySQL 容器；没有调用真实 GitHub、GHE.com、Copilot 或模型，没有创建真实用户或席位。Docker Desktop 只验证功能，不评估性能。

## 1. 候选镜像

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

## 2. 原地升级资格测试（设计 §9.4）

基线为已发布的单企业镜像 `single-slug-164cade-amd64-r4`。两种模式各跑一次，全部通过。

### 2.1 MySQL 8.4 + 双 Proxy（`multi-upgrade`，用时约 8 分钟）

| 步骤 | 内容 | 断言 | 结果 |
| --- | --- | --- | --- |
| 预检 | 全新项目与卷；只用本地镜像；隔离网络 | 6 | 通过 |
| 1 | r4 造数据（账号、库存、caller 租约、统计、SSO 会话），停服务，mysqldump 与卷备份 | 9 | 通过 |
| 2 | 同一数据卷换成多企业镜像，配置不变：数据逐项不变并回填 `default`；迁移记录完整；不带企业的写入被拒；同一租约的 6 种协议请求通过；r4 的 SSO 会话仍有效 | 18 | 通过 |
| 3 | r4 镜像直接启动在已迁移的 MySQL 上：拒绝启动，不改动库 | 4 | 通过 |
| 4 | 加入 registry（default + GHE.com mock 企业）：新企业为 draft → readiness 通过 → 激活 → 补货 → 推理走该企业的 Copilot 地址；跨企业负面检查（错企业回调、同名 SSO 用户、cookie 互换与伪造、无作用域路径） | 21 | 通过 |
| 5 | 恢复第 1 步的备份，启动 r4：与升级前完全一致 | 10 | 通过 |
| 7 | 统计表放大约 1024 倍，迁移停在第 05 步时强制结束 Proxy；重启后迁移继续完成，回填完整 | 8 | 通过 |

### 2.2 SQLite 直连（`multi-upgrade-sqlite`，用时约 2 分钟）

第 6 步：r4 造数据并备份 → 多企业镜像升级（旧值保留、回填 `default`、迁移记录完整、旧 `/api/accounts` 带 `Deprecation`、无作用域路径返回 400、会话有效）→ r4 在已迁移的库上写入被拒 → 恢复备份后与基线一致。19 条断言全部通过。

证据：报告与日志保存在本机运行目录（`.claude/release-qualification-run-*`，不入库）。

## 3. 单元与集成测试（提交 `41ecffc`）

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

## 4. 镜像扫描（Docker Scout）

| 镜像 | Critical | High | 说明 |
| --- | --- | --- | --- |
| Proxy / SSO / Console | 0 | 8 | 漏洞编号与 r4 逐条相同，均来自 Debian Bookworm 基础系统包，Debian 暂无修复 |
| Login | 0 | 10 | 漏洞编号与 r4 逐条相同（含 Chromium 依赖） |

应用依赖（npm）各级别均为 0。逐条可达性分析沿用 [单企业发布验证记录](user-pool-image-release-validation.md) 第 0.4 节。

## 5. 未验证的范围

- 真实 GitHub、GHE.com、Copilot 与模型调用；GHE.com 只用 mock 验证。首次在 GHE.com 使用时请先在预发布环境验收。
- OpenCode OAuth client id 能否用于 `*.ghe.com`（设计 §13 第 4 项）。
- 资格测试中没有真实 Login 浏览器任务（Login 任务历史只做了表级比对）；Login 浏览器流程由 Login 自带的浏览器测试覆盖。
- `MYSQL_AUTO_MIGRATE=false` + DBA 升级脚本的路径只在集成测试中覆盖，未在镜像资格测试中覆盖。
- 性能、容量与长时间稳定性。
