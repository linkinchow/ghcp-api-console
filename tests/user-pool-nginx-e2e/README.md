# 隔离的 LiteLLM → Canary → NGINX → 五池验证

实现文件：[run.py](run.py)、[probe.py](probe.py)。实际运行结果见[Azure端到端报告](../../docs/user-pool-nginx-canary-azure-validation.md)。

仅用于获准的Linux测试VM，使用现有项目镜像和全新的独立Compose项目。真实数据库virtual key认证、NGINX和五个Proxy/SSO进程；外部SCIM、席位、Login执行及模型服务均为mock。不连接客户环境，不安装依赖、不拉取镜像、不建真实账号、不发布主机端口。

离线检查不执行Docker：

```bash
python tests/user-pool-nginx-e2e/run.py --self-check
```

预览工具应启动运行器，并传入 `--source-dir <新建的平铺输入目录> --execute-isolated-test`。输入目录需要 `user_pool_hook.py`、`user_pool_canary_hook.py`、`render.py`、`nginx.conf.template`、`mock-services.mjs`；run.py与probe.py放同一目录。源文件不得包含客户凭据。必须使用已修复具体类认证前置回调的灰度Hook；测试实例直接设置 `prefixes="047ad"`，不改源码默认。

运行器在 `/opt/ghcp-nginx-e2e-*` 新建随机目录和同名项目；20个服务使用新的internal网络，MySQL/SSO/PostgreSQL数据使用临时存储，不复用原卷。MySQL中五个库各供一套池，五个Proxy顺序启动，避免服务器级启动迁移锁争用。全部服务镜像必须预先存在，Proxy v5镜像ID明确验证。

所有真实测试key仅留在内存，最多签发256把以取得五个允许首位和一个拒绝首位；实际通过报告中为53把，全部撤销。报告不写原始key、令牌或密码；私有容器日志及测试凭据配置留在受保护的测试目录，不上传公共仓库。退出会清理仅属于该新项目的容器/网络/临时数据；不执行全局prune。失败日志保留，非零退出不算通过。

`--runtime-tests` 可单独启用现有两个真实Router测试文件，需把它们放入输入目录。2026-09-17主控方已在独立禁网容器先行执行12项，因此最终E2E报告中的该子选项显示NOT_RUN不是整条链路未执行；以独立报告和HTTP检查为准。
