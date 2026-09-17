# LiteLLM User Pool 灰度准入 Hook

> 2026-09-17 Azure 真实运行验证发现：`80e8315` 的灰度子类没有显式声明认证前置回调，LiteLLM v1.99.1 的具体类方法发现机制会跳过继承的方法。**`80e8315` 及未包含本修复的版本不能直接作为灰度上线版本使用。** 本提交已补显式转调，修正后的 12 项真实 Router 测试全部通过；默认放行首位仍为 `"0"`，身份校验规则不变。

## 1. 本次实现的行为

适用于已有 LiteLLM virtual key 认证、现有 GHCP `caller-lease` 账号池：不再检查旧 `metadata.ghcp_identity`，只允许服务端认证后的 key hash 首位属于配置集合的调用方进入 GHCP。

默认在 [user_pool_canary_hook.py](../litellm/user_pool_canary_hook.py) 顶部配置：

```python
ALLOWED_HASH_PREFIXES = "0"
```

- `0` 开头：保留原候选列表，允许选择 GHCP，**不是强制路由到 GHCP**；仍由 LiteLLM 原路由策略决定选哪个健康后端。
- 其他首位：只删除 GHCP 候选，保留同一模型组原有的非 GHCP 后端。
- 如果只剩 GHCP 候选且调用方未入组：Hook 抛出 HTTP 403，`detail=ghcp_canary_not_allowed`，在调用 GHCP 前拒绝。实际网关可能重新包装错误正文，需按客户版本验证。
- 健康候选本身为空：保持空列表，交给 LiteLLM 原有不可用处理，不把健康故障改写成灰度拒绝。
- 缺少可信业务 key 身份：沿用原身份 Hook 的过滤和 `ghcp_pool_trusted_identity_required` 拒绝，不把 Master Key、session token 或伪造 metadata 当作业务 key。
- 没有 GHCP 的模型组不受影响，不按公开模型名或 `ghcp/` 前缀猜测后端。

这是**GHCP 使用资格的灰度**，不是“命中灰度只走 GHCP、未命中只走 stable”的双向强制分组。两者不要混淆。此文件替代此前未交付的双向分组草稿，不需要 `GHCP_POOL_STABLE_API_BASES` 或 `GHCP_POOL_CANARY_MODELS`。

哈希为小写十六进制，因此 `0` 首位约占 key 总数的 1/16，即 **6.25%**，不是 10%。它既不是准确的人数比例，也不是流量比例；同一人多把 key、不同用户活跃度及 key 轮换都会影响实际结果。不要生成额外 key 来挑选入组结果。

## 2. 与原身份 Hook 的关系

灰度类继承 [user_pool_hook.py](../litellm/user_pool_hook.py) 的 `UserPoolIdentityHook`，不修改原文件及其默认行为。

沿用以下链路：

1. `async_pre_call_hook` 从真实 `UserAPIKeyAuth` 验证 virtual-key 类型及 `token` / `hashed_token`，保存请求级可信身份。
2. `async_filter_deployments` 在选路前按首位过滤 GHCP 候选。
3. `async_pre_call_deployment_hook` 再次检查是否允许调用 GHCP，防止直接指定 deployment 或 fallback 绕过候选过滤，然后执行原有的 header 清理及注入。

实际发往 GHCP 的身份仍为 `X-User-Identity: sha256:<64位小写hash>`。不二次哈希，不读取请求正文、header、alias、metadata 或上游服务密钥作为分组身份。`metadata.ghcp_identity` 可以不存在；已有值或伪造值不影响分组，不需要批量修改 LiteLLM 数据库。

“去掉 metadata 限制”不等于关闭认证：LiteLLM 的 API key 认证、模型权限及预算检查继续执行，GHCP 的 API_KEY 校验也不变。非 GHCP 路径不注入可信 key hash；原来的客户端自定义 header 行为不由此 Hook 统一清洗。

## 3. 安装到 LiteLLM

将以下两个文件放在 LiteLLM 进程能导入的同一个目录中：

- [user_pool_hook.py](../litellm/user_pool_hook.py)
- [user_pool_canary_hook.py](../litellm/user_pool_canary_hook.py)

保留原有环境变量，地址需与实际 GHCP deployment 的有效 `base_url` / `api_base` 一致：

```dotenv
GHCP_POOL_API_BASES=http://ghcp-proxy.ghcp.svc.cluster.local:3000
```

以上只是示例地址，使用客户实际 Service 根地址。Hook 按 scheme、host、有效端口和路径精确匹配，忽略末尾斜杠。所有 GHCP 入口必须都在允许列表中，且禁止客户端通过 URL 覆盖或绕过网关直连 GHCP。默认采用单池 Service；本 Hook 不实现多 slug 分流或跨池唯一绑定。

在现有 LiteLLM 配置中，用下面这一条**替换**原 `user_pool_hook.proxy_handler_instance`，不要同时注册两个实例：

```yaml
litellm_settings:
  callbacks:
    - user_pool_canary_hook.proxy_handler_instance
```

如果原配置还有隔壁项目的 `ghcp_identity_hook`，应在实际部署配置中移除其注册，避免继续检查旧 metadata 或覆盖 hash 身份。其他不冲突回调可以保留；新的灰度回调仍须放在会修改 header/URL 的回调之后。导入基础文件会构造原模块实例，但只有 callbacks 中明确注册的实例参与请求，不要额外注册基础实例。

参考 [配置合并示例](../litellm/config.user-pool-canary.example.yaml)。保留原 `model_list`、同一公开模型名及 provider 适配方式。要使未入组用户继续成功访问，原模型组必须已有可用、获授权且协议兼容的非 GHCP 后端；Hook 不会自动创建它。如果所有模型都只有 GHCP 后端，那么默认只有约 6.25% 的 key 获准调用，其余会被拒绝，而不是自动获得其他渠道。

## 4. 调整放行范围

仅修改 Hook 顶部常量，每个字符表示**hash 第一位的一个可选值**，不是多字符前缀：

| 常量值 | 含义 | 理论 key 占比 |
| --- | --- | --- |
| `"0"` | 首位为 0 | 6.25% |
| `"012"` | 首位为 0、1 或 2 | 18.75% |
| `"0123456789abcdef"` | 所有通过原身份校验的业务 key | 100% |
| `""` | 暂停所有业务 key 进入 GHCP，非 GHCP 候选保留 | 0% |

只接受小写十六进制字符。不使用 `"0-2"`、逗号列表或百分比字符串；无效值启动失败，而不是默认全放行。重复字符不提高比例。

本版配置在 Hook 实例构造时读取，**不实现热加载**。更新挂载文件后仍需按正常发布流程更新 LiteLLM Pod，确保每个进程使用新版本；不能只编辑文件就假定生效。更新不需要改变 GHCP 镜像、数据库或租约，也不需要重新生成 virtual key。各 LiteLLM 副本须使用相同配置；滚动更新期间会短暂存在不同放行集合。

如果以后需要不重启 Pod 更新规则，建议另行实现配置文件热加载：ConfigMap 以目录挂载、禁止使用 `subPath`，有界周期检查并校验新内容，每个请求固定开始时的规则，变更异常保留上一份有效配置。ConfigMap 跨 Pod 传播有延迟，不提供同时切换保证。本次没有实现该能力。

## 5. 不改变的运行边界

- Hook 不查询账号池剩余量，不建立或释放租约，不触发开户，也不提高 `Maximum accounts`。获准请求后，原后台预热可能按已有配置补池，仍须控制获批容量。
- 灰度收紧不会删除已有成员或释放已有租约；旧租约仍按原 TTL 和回收机制处理。
- 不根据 429 更换 GHCP 成员或企业，不自动重试已执行、超时或部分输出的请求。
- 未入组 key 即使通过 fallback/直接选 deployment 到达 GHCP，发送前仍会被拒绝。入组 key 的非 GHCP 选路保持原行为；Hook 本身不新启用 fallback，客户已有 retry/fallback 策略仍需审核。
- 不修改存量正在执行的请求。发布/重启 LiteLLM 前应按现有流程排空长请求。
- 客户 LiteLLM 版本仍须验证回调生命周期；现有项目参考基线为 v1.99.1，不因添加该文件自动证明其他版本可用。

## 6. 本轮验证记录

2026-09-17，Windows Python 3.11.9，本地仅执行离线测试；未调用真实模型、GitHub、SSO/Login，也未改客户环境。

```bash
python -m unittest discover -s litellm -p 'test_user_pool*hook.py' -v
```

结果：**39 项通过、0 失败**，包含原身份 Hook 17 项及新增灰度 22 项。覆盖：全部 16 个首字符、只放行／不强制选 GHCP、组合／空／全部首位、无效配置、无 metadata 的认证、伪造身份、Master/session 拒绝、前后请求清理、并发 ContextVar、fallback/直接选路的发送前保护、精确 URL 匹配、其他渠道不变及共享对象不被修改。

```bash
python -m unittest discover -s litellm -p 'test_user_pool*runtime.py' -v
```

结果：**0 项运行时通过、12 项跳过**，其中新增灰度 7 项、原身份 5 项。原因是本机没有安装 LiteLLM；现有 Docker Desktop Linux 引擎也未运行，没有启动引擎或客户服务。新增真实 Router 用例已编写，但**尚未执行，不能据离线桩测试宣称客户版本已经验收**。实际 HTTP 认证、Messages/Responses、流式以及客户部署/重试策略也未在本次执行。

本轮收尾检查还包括 Python 语法、YAML 解析、文档链接及改动范围。不会将历史身份 Hook 的运行时通过结果算作新增灰度的运行时验收。

### Azure补充验证与修复（2026-09-17）

上述39通过/12跳过是初始本地记录，保留其原始状态。随后在Azure的真实LiteLLM v1.99.1镜像中执行，暴露具体类回调发现问题：初次12项中2失败、1错误；灰度类补显式 `async_pre_call_hook` 转调后，**40项离线通过、12项真实Router全部通过**。

随后完整HTTP链路使用测试配置 `prefixes="047ad"`，经过真实数据库virtual key认证、Hook、NGINX、五个真实Proxy及一个MySQL实例的五个独立数据库，**25个检查全部通过**；21次获准推理、7次拒绝探测均符合预期。没有真实GitHub/席位/模型调用。该链路验证使用Messages JSON/SSE，不等于客户K8s或其他协议全部验收；NGINX组件及其完整报告独立交付，不包含在本次Hook修复提交中。仓库默认前缀仍为 `"0"`。

证据校验值：

- 首次真实Router失败日志：`1696c55e060aefd8450ebae379a5a134e6beb93334d431547200e69527ea8040`。
- 修正后真实Router日志（12项通过）：`f8072fe81ec5202fcba15b951b482ef449ef50257fd1c94a342e33cff1413fe6`。
- HTTP端到端报告：`5122ca97d551a4cacbaa6374ac7da006d24c0b04e83918af714f61b6fe8cf5cd`。

更新时只替换LiteLLM中的灰度Hook文件并按原发布流程重新加载进程，保留基础身份Hook、现有允许地址和客户选定的前缀配置。无需因此重建GHCP Proxy镜像或更改数据库。
