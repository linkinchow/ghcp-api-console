# Models 页面：用企业管理员账号查看模型目录

## 页面行为

Console 左侧 **Models** 页面显示 Copilot `/models` 的实际模型目录，查询使用**部署时配置的 GitHub 企业管理员**的 Copilot 授权，不使用、不遍历、也不回退到任何账号池或直连账号。

成功后页面显示：

- 经 GitHub `/user` 验证的管理员登录名、目录获取时间和缓存状态（fresh / cached / stale）。
- 完整模型目录（不受 Claude Code 优化模式对公共 `/v1/models` 的过滤），可切换为只看 Messages 兼容模型。
- 按模型 ID、上游 ID、名称搜索；复制规范化模型 ID（剪贴板不可用时提供手动复制）。
- Proxy 判定支持的 API 路径、上下文窗口、最大输出，以及白名单内的模型元数据详情。缺失的限额显示 Unknown，不当作 0。

目录代表**该管理员账号**可见的结果，不表示每个账号都相同，也不表示每个模型都做过推理测试。

## 准备管理员的 Copilot 授权

操作人员需要指定一个真实的 GitHub 企业管理员，以及该账号可用于 Copilot 模型目录的 OAuth token：

- 不是 Console 管理员；不需要加入账号池，也不创建 Proxy 账号，不占用池库存或租约。
- 不能用 SCIM token 或席位管理 PAT 代替。
- 每次查询先用该 token 调用 `GITHUB_API_BASE_URL` 的 `/user`，核对登录名（不区分大小写）和可选的数字用户 ID，再用**同一 token** 查询 `COPILOT_API_BASE_URL` 的 `/models`。
- `/user` 只能证明 token 属于哪个账号，**不能证明该账号是企业管理员**；管理员身份由部署操作人员确认。

未配置、凭据缺失、身份不匹配或 Copilot 拒绝时，页面显示错误，**不会回退到其他账号、不会自动开户、派发 Login、分配席位或修改任何凭据状态**。

## 配置（Proxy 环境变量）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MODELS_ADMIN_GITHUB_LOGIN` | 是 | 管理员的 GitHub 登录名（不是显示名）。 |
| `MODELS_ADMIN_GITHUB_USER_ID` | 否（推荐） | 管理员固定的数字 GitHub 用户 ID，防止登录名被改名复用。 |
| `MODELS_ADMIN_COPILOT_TOKEN_FILE` | 二选一（推荐） | 挂载的 Secret 文件绝对路径。每次查询重新读取，轮换 Secret 无需重启。文件允许一个结尾换行，不允许其他空白。 |
| `MODELS_ADMIN_COPILOT_TOKEN` | 二选一 | 直接通过环境变量提供 token。修改需要重启；不能与 `_FILE` 同时设置。 |
| `GITHUB_API_BASE_URL` | 否 | GitHub REST API 地址，默认 `https://api.github.com`；GHE.com 使用 `https://api.<子域>.ghe.com`。 |

示例（全部为占位值）：

```dotenv
MODELS_ADMIN_GITHUB_LOGIN=example_admin
MODELS_ADMIN_GITHUB_USER_ID=101
MODELS_ADMIN_COPILOT_TOKEN_FILE=/run/secrets/models-admin-copilot-token
```

多副本部署时，所有 Proxy 副本挂载同一个 Secret。不要把真实 token 或管理员信息提交到 Git。查询期间如果配置或 token 发生变化，返回 409，不显示旧管理员的结果。

## 查询接口与副作用边界

```text
浏览器 → GET /api/console/proxy/models?refresh=false
Console → GET /api/models?refresh=false   （Proxy，内部令牌）
```

- `refresh` 只能是 `true`/`false`，不接受其他参数；浏览器不能指定账号、token 或上游地址。
- 不调用公共 `/v1/models`、不经过账号池准入，不读写账号、租约、授权或请求统计。
- 普通查询可命中 1 小时目录缓存；上游失败时可使用 6 小时内的旧目录并标记为 stale。401/403/429 不回退旧目录。显式刷新绕过缓存；401/403 会清除该管理员的进程内目录缓存。
- GitHub 身份校验最长 15 秒，整个查询最长 35 秒（Console 侧 40 秒）；浏览器断开会取消后端等待。
- 响应 `Cache-Control: no-store`。上游错误正文、token 与 Secret 路径不会返回浏览器。

## 常见错误

| 错误码 | 处理 |
| --- | --- |
| `models_admin_not_configured` | 设置 `MODELS_ADMIN_GITHUB_LOGIN` 和 token 来源。 |
| `models_admin_configuration_invalid` | 检查登录名/用户 ID 格式、文件路径是否为绝对路径、是否同时设置了两个 token 来源。 |
| `models_admin_credential_missing` | 检查 Secret 是否存在、可读、只有一行。 |
| `models_admin_identity_mismatch` | token 不属于配置的登录名或用户 ID；修正 Secret 或配置。 |
| `models_admin_verification_failed` | GitHub `/user` 校验失败；检查 token 有效性、`GITHUB_API_BASE_URL` 与网络。 |
| `models_upstream_authorization_rejected` | 身份正确但 Copilot 拒绝目录访问；确认管理员本人的 Copilot 授权。 |
| `models_upstream_rate_limited` | 等待后再刷新，不要换账号规避。 |
| `models_admin_changed` | 查询期间发生轮换，刷新即可。 |
