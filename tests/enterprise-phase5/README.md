# Phase5：隔离多企业全栈夹具

> 验收夹具，不是客户部署模板。本目录脚本的存在不表示真实 MySQL、Docker 或 GitHub 已通过。远端实际 PASS / FAIL / SKIP、镜像 digest 与源码包 SHA256 由主执行者另行记录；本 README 不预填结果。

## 安全边界与来源

- 全部账号、密码、SCIM/PAT/OAuth、域名和模型响应都是合成值。真实 Login API、SQLite、queue、runner、callback 与 Proxy 独立主体核验保留；仅授权 strategy 由 `login-test-entry.ts` 注入 mock。**未验证真实 GitHub device-flow、企业 SAML 配置、席位或真实模型**。
- 使用当前源码 bytes：HEAD 与 dirty source bundle SHA256 必须同时提供，不能把未提交工作树称为已发布版本。`state.source` 保存这一配对。生产 Proxy/SSO/Login/Console 四个 Dockerfile 分别构建；tooling 保留 devDependencies/tsx、src、upgrade、tests。测试 Login 跑 tooling，不等同于默认生产 Login 授权流程验收。
- 主执行者独占 Azure、上传、Docker 和真实数据库操作；本地纯准备/形状验证不联网、不连接数据库。禁止操作历史 Compose 项目、历史卷、客户库、真实 Secret 或改变 NSG；不运行 Docker prune / volume prune。
- 一个新 run ID 对应一个新根目录 `phase5-<runId>`、项目 `ghcp-enterprise-phase5-<runId>`、带 run/synthetic 标签的容器、网络和新卷。状态和 ownership 文件独占创建，不能修改已有 run 冒充新 run。
- MySQL 默认候选 `mysql:8.4`，主执行者应传实际缓存/批准镜像 digest；HAProxy 同理。MySQL 只发布数字 loopback 端口（默认 33195，恢复实例 33196）；Console 桥仅 loopback 18195。先确认端口未占用。不发布 Proxy/SSO/Login，不开放公网入口。
- 三个 Proxy、单 SSO/Login/Console、provider、round-robin HAProxy 只在 internal Docker 网络。HAProxy `retries 0`、关闭 redispatch，推理 POST 失败不重放。固定目标 Console 桥另接 preview 网络，保持浏览器 Host（含端口）/Origin，不能借重写绕过同源检查。MySQL/恢复MySQL另外连接本轮专属 `database-access` bridge，使Linux Docker实际发布仅127.0.0.1的测试端口；应用/provider不连接此桥。实际端口与numeric-loopback peer继续严格校验，不以HostConfig声明代替有效发布。

## 准备顺序

以下是 **Linux 主执行者的模板命令**，需替换所有显式变量；不是自动执行授权。使用受保护目录与 `umask 077`。密码只写 fixture 的受限文件，不打印 state/compose config/test.env。

```sh
# ROOT 已由上传器独占建立，源码只解包到全新 $ROOT/workspace。
# RUN、HEAD、SOURCE_SHA 必须对应这次真实源码包；镜像 digest 从实际盘点取得。
ROOT=/opt/ghcp-test/phase5-$RUN
cd "$ROOT/workspace"
node --import tsx tests/enterprise-phase5/prepare.ts \
  --run-id "$RUN" --root "$ROOT" --mode init \
  --head "$HEAD" --source-sha256 "$SOURCE_SHA" \
  --mysql-image "$MYSQL_IMAGE" --haproxy-image "$HAPROXY_IMAGE"
```

生成初始文件时不导入数据库 driver、不执行 SQL。生成 registry JSON3、临时两天自签名证书与各企业独立 Secret 引用、管理员文件、明确的 compose/test 环境和 V4 init manifest。必须安装本源码所需依赖及 `openssl`，或在独立 tooling 容器内将 ROOT 按相同绝对路径挂载后运行。不能把 Windows node_modules 挂入 Linux。

默认要求 fixture/results/backups 都不存在。若上传器已经创建 **空** results/backups，可显式加 `--adopt-empty-owned-dirs`，且 ROOT/owner.json 必须包含本次准确 `runId` 与 `syntheticOnly:true`。非空目录、符号链接、已存在 fixture 一律拒绝；不会删除后重试。`--dry-run` 只验证输入和对象形状，零文件、零 DB，不证明真实 init 成功。

`--mode migration` 只准备同样的隔离配置，不运行新库 init；旧 v1→2→3→Proxy4 合成保真链属于 `migration-chain.ts`，不能用空库 init 假装旧数据升级。迁移完成的数据切入 runtime 必须由主执行者明确核对数据库名、registry 和新文件路径；不得覆盖已有 init 目标。

## 构建与 guarded controller

正常生产镜像构建与 tooling 构建分别记录 exit code、image ID/digest。示例 tag 必须与 state.images 一致：

```sh
docker build --build-arg NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
  -f tests/enterprise-phase5/Dockerfile -t "ghcp-phase5-tooling:$RUN" .
# 四个正常镜像分别执行；不省略 Login 生产构建。
for service in proxy sso login console; do
  docker build --build-arg NPM_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ \
    -f "src/$service/Dockerfile" -t "ghcp-phase5-$service:$RUN" .
done
export PHASE5_SYNTHETIC_ONLY=1
STATE="$ROOT/fixture/state.json"
node tests/enterprise-phase5/run.mjs mysql-up --state "$STATE"
node tests/enterprise-phase5/run.mjs db-prepare --state "$STATE" --output "$ROOT/results/db-prepare.json"
node tests/enterprise-phase5/run.mjs init --state "$STATE" --output "$ROOT/results/init.json"
node tests/enterprise-phase5/run.mjs app-up --state "$STATE"
node tests/enterprise-phase5/run.mjs fullstack --state "$STATE" --mode smoke --output "$ROOT/results/smoke.json"
node tests/enterprise-phase5/run.mjs fullstack --state "$STATE" --mode lifecycle --output "$ROOT/results/lifecycle.json"
# 最多 10 分钟；结果不是长期稳定性或容量承诺。
node tests/enterprise-phase5/run.mjs stable --state "$STATE" --output "$ROOT/results/stable.json"
```

controller 使用明确绝对 compose/env 路径和项目名，固定本机 Docker default context，不读取默认 `.env`，不接受任意 shell command。先 create、检查精确 ID/labels/新卷/端口，再 start；ownership 写到新的独占文件。后续 SQL 前检查新鲜 inspect。schema 创建属于 `db-prepare.ts`；MySQL 首次容器启动仅引导合成 root，不自动创建 app schema。

公共离线工具拒绝无 TLS 的 Docker DNS MySQL 连接，因此 **DB prepare/init/迁移资格检查用 tooling `--network host` 访问 `127.0.0.1:33195`，继续验证真实 socket peer**；不放松 gate。全栈运行/HTTP 测试走 internal Docker DNS `mysql:3306`。新安装 init 使用真实 V4 offline 工具再 verify，保留全局 paused、所有企业 Draft；不会自动开户或 activate。

`restore-up` 为单独的 mysql-restore 容器/卷与 loopback33196。A 的链/fault/compatibility 入口需主执行者按其 CLI 使用新鲜 inspect、显式旧源码路径及真实备份。备份文件、receipt/plan 和 synthetic secrets 仍为私有资料，不随源码发布；恢复到新目标且保持数据库名一致，不编辑 receipt 让校验通过。

## 故障与收尾

```sh
node tests/enterprise-phase5/run.mjs inspect --state "$STATE"
# 主执行者先确定真实 owner 对应哪个本轮 Proxy，再选择准确 service：
node tests/enterprise-phase5/run.mjs kill --state "$STATE" --service proxy-1
node tests/enterprise-phase5/run.mjs restart --state "$STATE" --service proxy-1
# 推荐收尾，只停本轮精确 IDs，保留容器、卷与证据：
node tests/enterprise-phase5/run.mjs stop --state "$STATE"
# 只有明确需要移除本轮容器/网络时才使用；永远不带 -v：
node tests/enterprise-phase5/run.mjs down --state "$STATE"
```

`restart` 在这里是启动同一个已登记 ID（不是 recreate）。stop/down/kill/restart 都重新检查精确容器 ID、Compose project/service、run/synthetic 标签；发现未知容器即拒绝。down 保留卷和结果，但 ownership 不再可用，不以删 state 方式复用 run。测试失败保留输出并换新输出文件，不覆盖旧证据；任何中断不能默认计为通过。

## 本地已执行的开发检查

本次夹具编写阶段执行了Node语法、prepare dry-run、严格类型及负面/文件独占检查；其结果与真实运行分开记录。完整远端执行、实库故障修正、恢复、owner接管、浏览器及有界观察结果见[第五阶段实际报告](../../docs/user-pool-multi-sso-slug-phase5-validation.md)。该报告不代表真实GitHub端或客户生产环境通过。
