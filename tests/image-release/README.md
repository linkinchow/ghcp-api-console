# 发布镜像资格验证

验证 `deploy/images/Dockerfile.release` 构建出的四个镜像能否发布。只使用合成数据、mock 外部服务和本地 MySQL 容器；不连接真实 GitHub、Copilot、SSO，不推送镜像。Docker Desktop 上只验证功能，不评估性能。

## 文件

| 文件 | 用途 |
| --- | --- |
| `compose.yaml`、`mock.mjs`、`verify.mjs` | SQLite 直连模式的快速冒烟：健康检查、合成凭据导入、`/v1/messages` JSON/SSE 与缺少 beta 头时的 400、SSO/Login/Console 基本接口。 |
| `qualification-compose.json` | MySQL 8.4 + 双 Proxy（caller-lease）+ SSO/Login/Console + mock + 本机回环 bridge 的完整环境。 |
| `qualification-prepare.mjs` | 新建一次运行目录（`.claude/release-qualification-run-<uuid>/`）：复制并适配 `tests/docker-user-pool` 的 smoke 与 mock、写入合成证书和 MySQL 初始化脚本。 |
| `qualification-run.mjs` | 执行资格验证。默认模式：基线镜像 → 候选镜像 → 基线镜像（同一数据卷原地升级再回滚）；`RELEASE_QUALIFICATION_MODE=candidate-fresh`：候选镜像全新库。 |
| `qualification-verify-runtime.mjs` | 在每个运行中的容器里执行：Tini/npm/工作目录、依赖版本与行为、better-sqlite3、Login 内 Chromium、持久化数据摘要等。 |
| `qualification-dependency.mjs` | 基线与候选的依赖补丁行为对照（独立、离线容器内执行）。 |

## 运行

每次运行必须使用**新的** Compose 项目名和未被占用的子网；脚本拒绝复用已存在的项目或卷。

```bash
export RELEASE_QUALIFICATION_PROJECT=ghcp-release-qualification-<唯一后缀>
export RELEASE_QUALIFICATION_CANDIDATE_TAG=single-slug-<7位提交>-amd64-r<N>
export RELEASE_QUALIFICATION_CERTS_DIR=<含 idp-cert.pem / idp-key.pem 的合成证书目录>
export RELEASE_QUALIFICATION_MYSQL_IMAGE=<本地已缓存的 mysql:8.4 镜像 ID 或带 digest 的引用>
export RELEASE_QUALIFICATION_ISOLATED_SUBNET=10.244.x.0/24
export RELEASE_QUALIFICATION_INGRESS_SUBNET=10.244.y.0/24
node tests/image-release/qualification-prepare.mjs   # 输出 RELEASE_QUALIFICATION_STATE <run.json 路径>
RELEASE_QUALIFICATION_CONFIRM=$RELEASE_QUALIFICATION_PROJECT node tests/image-release/qualification-run.mjs <run.json 路径>
```

结果写入运行目录的 `qualification-report.json`。

## 安全边界

- 只启动、停止本项目的容器；从不执行 `down`、`rm`、`prune` 或删除卷，失败时保留现场供排查。
- 应用容器只连接 internal 网络；只有 bridge 绑定 `127.0.0.1` 端口。
- 不读取 `.env`，清除继承的 `COMPOSE_*`、`DOCKER_HOST` 等变量；所有凭据均为合成值。
