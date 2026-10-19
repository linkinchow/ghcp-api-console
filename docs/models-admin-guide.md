# Models 页面：用企业管理员账号查看模型目录

适用于多企业版本线（镜像 tag `multi-*`）。一套部署管理多个 GitHub 企业时，Models 页面**按企业**配置和查询；只有一个企业（`default`）时，配置方式与单企业版相同。多企业配置见 [registry 配置参考](multi-enterprise-registry.md)。

## 页面行为

Console 左侧 **Models** 页面是企业作用域页面：显示页头 **Enterprise** 选择器当前选中企业的 Copilot `/models` 实际模型目录。查询使用**该企业配置的 GitHub 企业管理员**的 Copilot 授权，不使用、不遍历、也不回退到任何账号池或直连账号，也不会改用其他企业的管理员。切换企业时页面重新加载，进行中的查询被取消，迟到的结果被丢弃。

成功后页面显示：

- 经该企业 GitHub `/user` 验证的管理员登录名、目录获取时间和缓存状态（fresh / cached / stale）。
- 完整模型目录（不受 Claude Code 优化模式对公共 `/v1/models` 的过滤），可切换为只看 Messages 兼容模型。
- 按模型 ID、上游 ID、名称搜索；复制规范化模型 ID（剪贴板不可用时提供手动复制）。
- Proxy 判定支持的 API 路径、上下文窗口、最大输出，以及白名单内的模型元数据详情。缺失的限额显示 Unknown，不当作 0。

目录代表**该企业中该管理员账号**可见的结果，不表示企业内每个账号都相同，不表示其他企业相同，也不表示每个模型都做过推理测试。

## 准备管理员的 Copilot 授权

每个需要 Models 页的企业，操作人员各自指定一个真实的 GitHub 企业管理员，以及该账号可用于 Copilot 模型目录的 OAuth token：

- 不是 Console 管理员；不需要加入账号池，也不创建 Proxy 账号，不占用池库存或租约。
- 不能用 SCIM token 或席位管理 PAT 代替。
- 每次查询先用该 token 调用**该企业**的 GitHub REST API（`github.apiBaseUrl`）的 `/user`，核对登录名（不区分大小写）和可选的数字用户 ID，再用**同一 token** 查询该企业 Copilot API（`github.copilotApiBaseUrl`）的 `/models`。
- `/user` 只能证明 token 属于哪个账号，**不能证明该账号是企业管理员**；管理员身份由部署操作人员确认。

未配置、凭据缺失、身份不匹配或 Copilot 拒绝时，页面显示该企业的错误，**不会回退到其他账号或其他企业、不会自动开户、派发 Login、分配席位或修改任何凭据状态**。

## 配置

### `default` 企业：Proxy 环境变量

没有 registry，或 registry 中没有 `default` 条目时，`default` 企业的 Models 管理员由 Proxy 环境变量提供（与单企业版相同）：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MODELS_ADMIN_GITHUB_LOGIN` | 是 | 管理员的 GitHub 登录名（不是显示名）。映射为 `default.modelsAdmin.githubLogin`。 |
| `MODELS_ADMIN_GITHUB_USER_ID` | 否（推荐） | 管理员固定的数字 GitHub 用户 ID，防止登录名被改名复用。映射为 `modelsAdmin.githubUserId`。 |
| `MODELS_ADMIN_COPILOT_TOKEN_FILE` | 二选一（推荐） | 挂载的 Secret 文件**绝对路径**（相对路径会导致 Proxy 启动失败）。映射为 `modelsAdmin.copilotToken = { "file": ... }`。每次查询重新读取，轮换 Secret 无需重启。文件只去掉一个结尾换行，不允许其他空白。 |
| `MODELS_ADMIN_COPILOT_TOKEN` | 二选一 | 直接通过环境变量提供 token，映射为 `{ "env": "MODELS_ADMIN_COPILOT_TOKEN" }`。修改需要重启。 |
| `GITHUB_API_BASE_URL` / `COPILOT_API_BASE_URL` | 否 | `default` 的 GitHub REST API 与 Copilot API 地址。github.com 默认 `https://api.github.com`、`https://api.githubcopilot.com`；GHE.com 未设置时自动推导（见下文）。 |

**两个 token 来源同时设置时，文件优先**：`MODELS_ADMIN_COPILOT_TOKEN` 被忽略，Proxy 启动日志打印一次 warning（`MODELS_ADMIN_COPILOT_TOKEN is ignored because MODELS_ADMIN_COPILOT_TOKEN_FILE is set.`），不会因此启动失败。建议只保留一个来源，避免误以为环境变量中的 token 在生效。

示例（全部为占位值）：

```dotenv
MODELS_ADMIN_GITHUB_LOGIN=example_admin
MODELS_ADMIN_GITHUB_USER_ID=101
MODELS_ADMIN_COPILOT_TOKEN_FILE=/run/secrets/models-admin-copilot-token
```

如果 registry 中写了 `default` 条目并且其中也有 `modelsAdmin`，对应环境变量必须留空或与文件一致，否则 Proxy 启动失败 `enterprise_env_conflict`（见 [registry 配置参考](multi-enterprise-registry.md) 第 5 节）。

### 其他企业：registry 的 `modelsAdmin`

其他企业在 registry 条目中配置（registry 只能写 secret 引用，不能写 token 值）：

```json
{
  "id": "contoso-ghe",
  "github": { "baseUrl": "https://contoso.ghe.com", "slug": "contoso" },
  "modelsAdmin": {
    "githubLogin": "contoso_admin",
    "githubUserId": "202",
    "copilotToken": { "file": "/run/secrets/contoso-ghe/models-admin-copilot-token" }
  }
}
```

- `copilotToken` 可以是 `{ "file": "/绝对路径" }`（推荐，Secret 只读挂载到 **Proxy**）或 `{ "env": "变量名" }`。Models 的 token 文件每次查询都重新读取，轮换挂载的 Secret 无需重启。
- 修改 `githubLogin`、`githubUserId` 或引用本身需要重启 Proxy（registry 不热加载）。
- 某个企业没有 `modelsAdmin` 时，只有该企业的 Models 页显示 `models_admin_not_configured`，不影响其他企业和服务启动。

### GHE.com 企业

`github.baseUrl` 为 `https://<子域>.ghe.com` 时，未设置的地址自动推导为 `https://api.<子域>.ghe.com`（`/user` 校验）和 `https://copilot-api.<子域>.ghe.com`（`/models`）；显式设置时两者必须属于同一个 `<子域>.ghe.com`，否则启动失败。GHE.com 的 Models 查询只在 mock 环境验证过，首次在真实 GHE.com 企业使用前请先在预发布环境确认。

多副本部署时，所有 Proxy 副本挂载同一份 registry 和同一组 Secret。不要把真实 token 或管理员信息提交到 Git。查询期间如果配置或 token 发生变化，返回 409，不显示旧管理员的结果。

## 查询接口与副作用边界

```text
浏览器 → GET /api/console/proxy/enterprises/<enterpriseId>/models?refresh=false
Console → GET /api/enterprises/<enterpriseId>/models?refresh=false   （Proxy，内部令牌）
```

- 企业由路径决定。没有企业的旧路径 `GET /api/models` 返回 400 `enterprise_scope_required`，不会默认使用 `default`；未知企业返回 404 `enterprise_not_found`。
- `refresh` 只能是 `true`/`false`，不接受其他参数；浏览器不能指定账号、token 或上游地址。
- 不调用公共 `/v1/models`、不经过账号池准入，不读写账号、租约、授权或请求统计。
- 目录缓存在每个 Proxy 副本内存中，键为 `models-admin:<enterpriseId>:<githubUserId>`（再加 Copilot 地址和 token），不同企业、不同 GitHub 实例之间不共享缓存。
- 普通查询可命中 1 小时目录缓存；上游失败时可使用 6 小时内的旧目录并标记为 stale。401/403/429 不回退旧目录。显式刷新绕过缓存；401/403 会清除该企业该管理员在本副本的目录缓存。
- GitHub 身份校验最长 15 秒，整个查询最长 35 秒（Console 侧 40 秒）；浏览器断开会取消后端等待。
- 响应 `Cache-Control: no-store`。上游错误正文、token 与 Secret 路径不会返回浏览器。

## 常见错误

管理员配置类错误（未配置、配置无效、凭据缺失、身份不匹配、Copilot 拒绝）在页面上会注明企业 ID，例如 `Enterprise contoso-ghe: ...`，并说明没有改用池账号或其他企业。

| 错误码 | HTTP | 处理 |
| --- | --- | --- |
| `models_admin_not_configured` | 409 | 该企业没有 Models 管理员：`default` 设置 `MODELS_ADMIN_GITHUB_LOGIN` 和 token 来源；其他企业在 registry 中加 `modelsAdmin` 后重启 Proxy。 |
| `models_admin_configuration_invalid` | 503 | 检查登录名 / 用户 ID 格式，以及是否只配了 token 没配登录名。 |
| `models_admin_credential_missing` | 409 | 检查 Secret 文件是否存在、可读、非空且只有一行，或引用的环境变量是否已设置。 |
| `models_admin_identity_mismatch` | 502 | token 不属于配置的登录名或用户 ID；修正 Secret 或配置。 |
| `models_admin_verification_failed` | 502 | 该企业 GitHub `/user` 校验失败；检查 token 有效性、`github.apiBaseUrl`（`default` 为 `GITHUB_API_BASE_URL`）与网络。 |
| `models_upstream_authorization_rejected` | 502 | 身份正确但 Copilot 拒绝目录访问；确认管理员本人在该企业的 Copilot 授权。 |
| `models_upstream_rate_limited` | 429 | 等待后再刷新，不要换账号规避。 |
| `models_admin_changed` | 409 | 查询期间发生轮换，刷新即可。 |
| `enterprise_scope_required` / `enterprise_not_found` | 400 / 404 | 自建脚本使用了无企业的旧路径，或企业 ID 不在 Proxy 的 registry 中。 |
