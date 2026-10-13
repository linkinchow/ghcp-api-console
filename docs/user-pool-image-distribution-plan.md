# GHCP 镜像分发建议：供应方构建，客户按 digest 升级

## 建议

**应该提供预构建镜像。** 客户每次重装Node/npm、下载依赖和构建镜像会增加交付时间与环境差异；供应方一次受控构建、测试、扫描，客户按固定产物部署，更便于回滚与排障。

本次尚未上传镜像，也没有配置Docker Hub认证或自动发布流程。写升级指南不构成公开发布许可。客户升级文档见[Messages修复升级指南](user-pool-messages-output-config-upgrade-guide.md)。

## 一、先发布哪个镜像

本次修复只需要 **Proxy** 镜像；不要为一个协议补丁让客户更新四组件或迁移数据库。

建议以后分别维护：

- `ghcp-proxy`
- `ghcp-sso`
- `ghcp-login`
- `ghcp-console`

镜像repository按发布账号或组织的实际namespace命名，本文件不填写假定可用的地址。

**不同应用/存储基线必须分开发布并标明兼容矩阵。** 当前单slug main支持SQLite/MySQL，旧AKS应用是PostgreSQL，未来multi-slug又有显式schema/contract/registry配对升级。相同产品名称不代表可直接互换镜像，不建议含糊地使用一套latest。

## 二、Docker Hub 可以用，发布策略要明确

- 开源且获许可分发：可用public repository，客户无需账号即可拉取（受实际Docker Hub额度/访问规则约束）。
- 不希望公开源码或依赖内容：选择private repository，客户用read-only token；或使用GHCR/客户私有ACR。是否能直接匿名拉取、私库协作与额度以所选registry账户政策为准。
- 发布凭据仅保存在批准的CI Secret；使用最小权限仓库token，不把个人密码、GitHub token或真实客户配置放进workflow。
- registry是镜像交付层，不替代Copilot授权、席位、服务条款或安全治理。

## 三、版本不可漂移

建议使用可追溯标签，例如：

```text
<namespace>/ghcp-proxy:main-5046bca
<namespace>/ghcp-proxy:<approved-semver>
```

以上是**命名建议，未发布tag**。正式发布后记录实际：

```text
<namespace>/ghcp-proxy@sha256:<actual-registry-digest>
```

- 发布tag创建后不覆盖；修复安全问题则发新tag和新digest。
- 客户生产以digest固定产物，tag用于阅读与检索。
- latest如保留，只供实验使用，不作为升级指南中的唯一版本依据。
- 源commit `5046bca...` 与registry digest、构建时间、平台、基础镜像digest配对记录。

## 四、第一次公开发布前的门禁

1. **代码分发许可**：当前仓库根未发现已跟踪的LICENSE；需先确认上游及本fork授权、衍生修改和第三方依赖分发义务。不能仅凭GitHub可访问就认定能随意公开打包。
2. **干净构建上下文**：从固定commit导出的干净checkout构建，不用有客户.env、数据和本地测试材料的工作目录。正式build context只保留必要tracked文件。
3. **镜像内容审计**：现有Dockerfile `COPY src ./src` 会把全部服务源码/测试带入镜像，随后只删dev依赖；这不等于最小运行产物。公开前应检查镜像文件清单、历史layers、env和标签，无客户数据、token、DB、证书、诊断日志或私有包源凭据。
4. **运行时与许可证材料**：生产镜像宜用多阶段构建并只包含Proxy运行所需产物和依赖，保留必要的第三方许可证/NOTICE；Login浏览器镜像与Proxy不要混同。此项需要单独修改及测试，不在本次文档任务自动实施。
5. **依赖漏洞**：本修复安装时npm报告基准依赖树4项安全告警。需确认哪些影响真实生产镜像、当前漏洞详情与可用补丁；不要忽略或盲目audit fix --force，不把总数当成生产漏洞已定性。
6. **资格测试**：类型/build、单元、隔离HTTP/SSE与账号池回归；镜像层面使用专用mock与临时DB测试启动、readiness、SIGTERM，不接真实GitHub或客户MySQL。
7. **平台**：先确认客户节点arch。首轮可先提供经实测的linux/amd64；arm64须另外build与执行测试，不能只生成manifest就声称双平台已验收。
8. **供应链证据**：生成SBOM、扫描记录、OCI源revision标签、镜像签名/provenance，按团队策略执行；客户用实际签名身份与digest验证。

任何未过门禁项都应在release notes明确阻塞，而不是发布后再让客户补查。

## 五、推荐发布流程

1. 批准源码commit和release范围，确认private/public仓库与namespace。
2. CI在干净runner执行测试；通过公司批准feed安装依赖，不绕过Minimum Release策略。
3. 构建一次候选镜像（固定基础镜像与目标平台）；扫描、镜像启动mock和内容检查。
4. 若候选通过，发布**同一产物**到registry，不再重新build一遍用作release。
5. 记录digest、签名、源commit和兼容矩阵；生成客户release notes与升级指南。
6. 客户pull或镜像同步到自己的registry，以digest更新Proxy。
7. 保留至少前一批准版本，提供明确回滚路径；不自动删除旧镜像或客户资源。

自动workflow应只对已批准的release tag/手动发布触发，不对任意feature branch/PR自动公开上传。不能将有客户资料的runner目录当docker context。

## 六、实施前需要确认的决定

- 发布账号/组织namespace及Docker Hub（或其他registry）repository。
- public还是private，以及代码/依赖分发许可。
- 客户架构：linux/amd64或还需arm64。
- 第一批是否仅发布Proxy；对应当前SQLite/MySQL main基线，旧PG版是否独立支持。
- 发布凭据的安全提供方式和CI权限。

确认后才创建仓库/配置CI/push镜像。本轮没有执行这些操作，没有宣称存在可用镜像地址。
