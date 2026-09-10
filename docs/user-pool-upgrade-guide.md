# 客户现有 GHCP Proxy Docker 升级到 User Pool 操作手册

更新：2026-09-11。目标分支：`ghcp-user-pool`。适用：GitHub.com EMU + 本项目custom SSO，单Proxy进程、SQLite。允许维护停机，要求保留现有业务数据。**不是跨数据库迁移工具，也不是存量账号自动入池工具。**

> **先读结论：升级软件和切换账号池是两件事。**
>
> 1. 先在旧数据副本上验证升级，保持 `ACCOUNT_ROUTING_MODE=direct`，确认现有用户、映射和可用OAuth token仍正常。
> 2. 再决定是否切换整个Proxy到 `caller-lease`，同时切换LiteLLM hook。**Pool模式不兼容继续传用户名/邮箱的旧header，不自动纳管旧账号/席位。**
> 3. 如果要求“原有账号直接入池、沿用旧席位、旧caller不断调用”，当前版本不是可直接替换的迁移方案；应停止在第一阶段，另行实施受控纳管和流量迁移。
> 4. 不需要为常规软件升级修改GitHub SAML URL、Issuer或证书；保留原SSO地址、证书、用户库和访问路径。
> 5. 禁止对客户数据执行 `down -v`、volume prune、SQL清表或照搬本地测试脚本。先备份，后迁移；失败回滚必须匹配旧镜像与升级前数据。

配套：[设计](user-pool-design.md) · [实现与配置](user-pool-implementation.md) · [LiteLLM接入](user-pool-litellm.md) · [真实测试完整报告](user-pool-real-e2e-validation.md) · [发布检查记录](user-pool-release-checklist.md)

## 1. 升级后存量数据如何处理

| 数据 | 已知原版结构的行为 | 客户需注意 |
| --- | --- | --- |
| SSO用户名、email、role、password_hash/salt | 保留 | 不要求改为hash用户名，不重置原密码 |
| SSO的GH login、SCIM ID、EMU/seat状态 | 保留 | 数据库记录不是实时GitHub状态，验证时可只读核对 |
| GitHub真实EMU、Copilot席位 | 软件迁移不自动删除、恢复或重新分配 | 旧席位继续存在/计费，不因开启pool自动被新账号复用 |
| 已为OAuth结构的Proxy账号 | 保留identity、sso_user、gh_login及OAuth字段；添加缺失字段 | 以数据库schema确认，不仅凭UI截图或“没更新models”判断 |
| 更早的 `gh_token` / 短期 `copilot_token` 结构 | 保留账号关联和created_at；重建表并清除旧token字段，OAuth变missing；updated_at更新 | **不是无损凭据迁移**。需旧备份归档和重新授权；未知自定义列/索引/触发器不保证保留 |
| Request stats | 迁移加列并保留行；启动随后按每identity限额裁剪 | 默认 `REQUEST_STATS_PER_ACCOUNT_LIMIT=2`，可能删掉大量旧历史，必须提前设定并归档 |
| SSO import plan | 保留主体；旧 `password_for_login` 明文列会删除并清理存储 | 原用户密码哈希不受该删除影响，但不能声称所有旧列逐字保留 |
| Login历史 | 完成/失败任务保留；加OAuth attempt列 | 重启把pending/running标failed，队列密码只在内存，不自动继续旧浏览器任务 |
| Login文件日志 | 挂载卷可保留 | 相同SSO用户新登录可能覆盖该用户的旧日志，重授权前归档 |
| Console管理员 | 保留原admins.json及哈希 | 必须挂回原console-data卷；初始设置页常意味着错挂空卷 |
| SSO/Login运行时设置 | 已有设置行保留；没有则插入代码默认 | 旧env中的concurrency/domain等不会全部自动导入，逐项在Settings核对 |

判断OAuth结构的关键列是 `copilot_oauth_token`、`copilot_oauth_status`、`copilot_oauth_updated_at`。三列齐全时不会走旧凭据表重建分支。迁移可重复运行，但“可重复”不代表能从新结构自动降级回旧结构。

**数据库表确有变化：**新增 `user_pool_settings/accounts/leases/holds/catalog_holds/events`，成员generation/重新授权计数等；request stats增加caller/lease字段。Pool表在启用pool能力时初始化，direct不会启动补池。现有旧用户无需改名。

新版本给pool用户增加独立的SSO ownership标记表（不把标记加入普通DTO），并禁止旧导入入口写入pool token。若来自早期未发布的pool测试版本，旧成员可能没有本地标记：破坏性SSO操作仍会查询Proxy确认，但本地编辑保护只对已标记成员完整生效；不要自行回填或据此保证该开发版本迁移，需核对后补标记。

## 2. 老用户为什么不纳入池子

`sha256:<hash>`是**LiteLLM caller**，不是SSO用户名。Pool中的实际成员仍是合成用户名，header进入Proxy后才查租约、选择成员。

当前版本：

- 不把已有 `proxy_accounts`、SSO用户或已分配席位自动转换为pool inventory。
- 姓名候选与已有Proxy identity或SSO alias冲突时跳过；仅SSO存在同名记录时，预热会记录冲突并停止接管该候选。冲突失败行可能消耗pool cap。
- SCIM `createOnly` 禁止借同名冲突接管/覆盖已有GitHub账号。
- 没有旧成员导入、固定caller映射导入或按邮箱推断旧key归属的管理API。
- 一名SSO/GitHub用户可能有“邮箱identity”和“短用户名identity”两条Proxy记录；这不是两个独立账号/席位。未来纳管必须按实际成员去重。
- 旧账号保留在数据库并能在管理界面看到，但在pool模式下**不是可供分配的ready-idle**。旧Direct调用header会被拒绝，不会回退。

**如果客户必须复用旧账号，应先保持direct，另做明确的纳管方案。**不要手工插入user_pool表把未经所有权/并发/凭据验证的成员标为ready；也不要先删旧账号“给新池腾地方”。

## 3. 开始前需客户填写/确认的清单

### 3.1 保留现有值，不要覆盖成示例

| 项目 | 要求 |
| --- | --- |
| Compose项目名、文件顺序、override | 记录实际值；后续所有命令显式使用同一个项目和既有拓扑 |
| 五个卷/绑定目录、DB_PATH | 记录实际mount source，不只记 `proxy-data` 逻辑名 |
| API_KEY | 保留有效值并与LiteLLM上游服务密钥一致；不要要求终端用户使用它 |
| INTERNAL_API_TOKEN | 四组件一致，保留现有受保护值；不能随意生成新值只替换一端 |
| SESSION_SECRET | 保留现有值以避免额外会话失效；若主动轮换需安排重新登录 |
| SSO_PUBLIC_BASE_URL / LOGIN_SSO_URL | 保留与GitHub登记匹配、Login浏览器可访问的地址；`LOGIN_SSO_URL` 必须显式填成浏览器实际跳转的SSO origin及登录路径，通常为 `<SSO_PUBLIC_BASE_URL>/login`。仅填内部 `http://sso:7001/login` 不能识别跳到另一个公网域名的页面；修改后重新创建Login；SSO URL是启动配置，不是Settings里的持久化运行时字段 |
| SSO_CERT_DIR与签名证书/私钥 | 使用原有持久化文件，不运行生成脚本覆盖已有证书 |
| SP_ENTITY_ID / SP_ACS_URL | 保留原GitHub企业值 |
| ENTERPRISE_SLUG / ENTERPRISE_SHORTCODE | 使用客户企业实际标识 |
| SCIM_BASE_URL / SCIM_TOKEN | 使用仍有效的企业SCIM凭据 |
| GITHUB_API_BASE_URL / GITHUB_COPILOT_SEAT_PAT | 使用实际企业席位管理凭据；先只读验证，不把401误判成需要所有权限 |
| COPILOT_API_BASE_URL及OAuth客户端/头配置 | 核对原值与当前流程，不盲目复制开发者测试值 |
| SSO_DEFAULT_USER_PASSWORD | **新pool成员必填强随机值，至少16个非首尾空白字符且不等于用户名**；旧用户密码哈希不重置，仍按原密码登录；旧direct自动取密码需确认新默认值与旧账号的兼容性，不能靠哈希恢复原密码 |
| REQUEST_STATS_PER_ACCOUNT_LIMIT | 显式决定保留量。要保留升级前全部在库记录，至少覆盖每identity已有最大条数并另做完整归档；0不是无限 |
| SSO/Login Settings | 记录现有domain、prefix、capacity、SCIM pacing、Login concurrency/timeout等 |

当前代码允许使用经批准的 `manage_billing:copilot` 凭据完成已测试企业的席位读写；不为所有企业政策/API保证统一最小权限。凭据存私有env/secret系统，不能写进Git、工单截图或构建ARG。

### 3.2 新账号池必须决定的参数

| 变量/设置 | 代码默认 | 客户首轮建议/填写 |
| --- | --- | --- |
| ACCOUNT_ROUTING_MODE | direct | 第一阶段direct，第二阶段才caller-lease |
| STORAGE_DRIVER | sqlite | 保持sqlite；其他后端不能开启pool |
| POOL_ACCOUNT_EMAIL_DOMAIN | 空、pool必填 | 客户批准的池账号邮箱域名；不是caller邮箱域 |
| POOL_WARMUP_MODEL | 空、pool必填 | 该企业/账号实际可用模型；会产生少量真实推理用量 |
| READY_IDLE_TARGET | 10 | **首次启用填0**，核验后在Console改为1 |
| POOL_MAX_ACCOUNTS | 100 | **首轮填1**；后续按批准账号/席位预算逐步提高 |
| CALLER_LEASE_TTL_SECONDS | 172800 | 正式租约秒数，默认48小时 |
| PROVISIONAL_LEASE_TTL_SECONDS | 300 | 首次领取5分钟临时租约 |
| PREWARM_POLL_SECONDS | 5 | 后台保底检查和等待阶段间隔 |
| PREWARM_CONCURRENCY | 5 | 首轮填1，真实稳定后再评估提高到3–5，允许1–20 |
| POOL_EXHAUSTED_RETRY_AFTER_SECONDS | 30 | 429重试建议；LiteLLM默认可能丢弃该header |
| POOL_REQUEST_TIMEOUT_SECONDS | 120 | 请求/单预热步骤超时，范围5–600秒 |
| Login Settings → concurrency | 1 | 独立于Proxy预热并发，范围1–20；保存动态生效 |
| Login Settings → authTimeoutMs | 60000 | 根据真实登录耗时确定，不把超时随意改成无限 |
| PROXY_ERROR_DIAGNOSTICS_ENABLED/REDACT | base为true/false | 客户建议false/true，pool overlay已强制保护 |
| NPM_REGISTRY | 公共npm | 有管控时填组织批准源，不关闭TLS/绕过包隔离 |

target、cap和正式TTL仅用于**首次**种子初始化；数据库已有pool设置后，修改env不会覆盖它们，要通过User pool设置/API变更。更换已持久化的pool邮箱域会启动失败，不能当作普通在线配置随意改。

### 3.3 LiteLLM填写

- 核实目标LiteLLM版本，当前实际验收基线v1.99.1。
- 在LiteLLM进程设置 `GHCP_POOL_API_BASE`（供YAML）、`GHCP_POOL_API_BASES`（供hook），值为客户真实Proxy根地址。
- `GHCP_PROXY_API_KEY`对应原Proxy API_KEY。
- 普通数据库virtual key，每人一把，按模型组正常授权；不再填写 `metadata.ghcp_identity`。
- 保留正确provider与标准model ID，按实际模型能力选择Messages/Chat/Responses；不是任意模型都能走任意入口。
- 替换旧metadata identity hook，不要同时注册两套互相覆盖的身份注入。
- Response cache关闭；retry/fallback必须显式批准且有界，不能轮换GHCP账号规避429。

## 4. 阶段一：升级软件，但仍使用direct

### 4.1 记录现状和取得新源码

以下命令是Bash示例。`<...>`必须替换；涉及的`-p`/`-f`必须与客户现有部署一致。不要将带密钥的完整 `docker inspect` / `docker compose config`输出贴到聊天。

```bash
docker compose -p <现有项目名> -f <现有Compose文件> ps
```

仅记录卷映射：

```bash
docker inspect <现有Proxy容器> --format '{{range .Mounts}}{{println .Type .Name .Source "->" .Destination}}{{end}}'
```

对SSO/Login/Console也记录同类映射、镜像tag和digest、实际代码revision。请勿用 `git reset --hard` 覆盖客户自定义代码或 `.env`。

新源码推荐先放**独立release目录**，避免改坏现有运行目录。仓库：`https://github.com/linkinchow/ghcp-api-console`，分支 `ghcp-user-pool`。以下操作只取代码，不代表启动：

```bash
git clone --branch ghcp-user-pool --single-branch https://github.com/linkinchow/ghcp-api-console.git <新release目录>
```

```bash
git -C <新release目录> rev-parse HEAD
```

记录提交SHA并固定交付版本；不要每次停机都不经验证直接跟随分支最新提交。

### 4.2 挂载映射：最容易丢数据的地方

新目录会改变Compose默认项目名，**不显式指定旧项目/旧卷就可能创建全新空库**。建议为目标配置补一个私有override，引用已确认的existing named volumes：

```yaml
volumes:
  proxy-data:
    external: true
    name: <实际旧Proxy卷名>
  sso-data:
    external: true
    name: <实际旧SSO卷名>
  login-data:
    external: true
    name: <实际旧Login卷名>
  login-logs:
    external: true
    name: <实际旧Login日志卷名>
  console-data:
    external: true
    name: <实际旧Console卷名>
```

若旧部署是bind mounts，应在service层使用原路径，不把bind误写成named volume。证书路径使用确认后的绝对路径；Proxy自定义DB_PATH必须对应卷内原数据库。上述override只能用于单套服务接管，不能让新旧两个Proxy/SSO同时写同一SQLite。

### 4.3 停机和备份

1. 提前拉源码/构建候选镜像；不挂客户卷做构建测试。新镜像另取tag，记录旧镜像ID以便回滚。
2. 关闭入口新流量，等待推理和Login/SSO批任务完成。取消任务不保证浏览器已停止，不靠点击Cancel替代排空。
3. 停止**客户这套项目**的写服务。若还有其他服务共享SSO库，同样协调停止写入。

```bash
docker compose -p <现有项目名> -f <现有Compose文件> stop console proxy login sso
```

4. 备份五个实际数据卷/目录、签名文件、旧Compose/私有env、runtime settings记录和旧镜像标识。保护备份访问权限；停止后保留整个数据库目录，包括可能存在的WAL/SHM，不只复制一个打开中的sqlite文件。

named volume示例，每次只替换一个已核实卷名，使用本机已批准的工具镜像；备份文件名必须唯一，防止覆盖：

下面先定义已核实的值（此代码块是模板，执行前替换；当前备份目录必须为私有且文件不存在）：

```bash
export OLD_VOLUME='<旧卷名>' BACKUP_DIR='<私有备份目录绝对路径>' ARCHIVE='<唯一卷备份名>.tgz'
```

```bash
docker run --rm --network none --mount "type=volume,source=$OLD_VOLUME,target=/source,readonly" --mount "type=bind,source=$BACKUP_DIR,target=/backup" -e ARCHIVE="$ARCHIVE" node:22-bookworm-slim sh -c 'test ! -e "/backup/$ARCHIVE" && tar -C /source -czf "/backup/$ARCHIVE" .'
```

5. 验证归档能列出预期文件、记录校验和，确认可恢复后才继续。还要单独归档旧日志，因为新授权会覆盖某些按用户名组织的日志文件。

### 4.4 先在数据副本演练

不要第一次就让新镜像打开唯一的原库。复制备份到测试卷，使用隔离项目、不连真实SCIM/Copilot、保持direct，仅验证迁移和本地登录/读取。

检查至少包括：

- SSO用户数量及全部身份关联、role、密码哈希/salt不变；Console管理员可登录。
- 已OAuth结构的token/status字段不变，不把token输出为检查结果，可在本地比对摘要/相等性。
- 邮箱identity和短identity指向同一SSO用户时，两条记录都保留；不自动去重或改名。
- request stats按批准的保留量处理，原始完整历史在备份中可恢复。
- runtime settings恢复为客户原值；登录pending/running清理符合预期。
- direct模式不创建pool成员，不执行真实外部开户。

实际客户revision/自定义schema未验证前，不能用“已在模拟旧表测试通过”替代这一步。

### 4.5 正式启动新软件，仍保持direct

完成旧部署备份/副本演练后，后续命令必须在**新release目录**执行，不能继续在旧checkout运行相对路径 `docker-compose.yml`：

```bash
cd <新release目录>
```

下文的私有env和override建议使用绝对路径；证书bind mount也使用已核实的绝对路径。

在新release私有env中保留全部原有效参数，补充明确值：

```dotenv
ACCOUNT_ROUTING_MODE=direct
STORAGE_DRIVER=sqlite
READY_IDLE_TARGET=0
PROXY_ERROR_DIAGNOSTICS_ENABLED=false
PROXY_ERROR_DIAGNOSTICS_REDACT=true
# REQUEST_STATS_PER_ACCOUNT_LIMIT 填客户确认的保留条数，不照抄默认2。
```

仅渲染校验（不打印展开的敏感配置）：

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> config --quiet
```

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> build sso login proxy console
```

确认旧写进程已停后，挂回已演练的目标卷启动：

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> up -d --no-build --wait sso login proxy console
```

核对健康、管理员登录、SSO用户和OAuth状态。用一个既有caller做批准的小额请求验证direct。若客户本来就是OAuth版本且凭据未撤销，通常不需要全部重新登录；若确属旧双token结构，重新授权是计划内步骤，不等于删除用户或席位。

**看见初始化Console或空用户表，应先查错挂卷，不要重新创建管理员/用户掩盖错误。**

## 5. 阶段二：启用pool并切换LiteLLM

### 5.1 切换条件

先由客户确认：

- 接受旧SSO/Proxy账号保留但不加入池，新池会另建普通成员并可能增加席位。
- 接受整个该Proxy入口改为caller hash，不再接收旧direct身份header。
- 已批准账号数量、席位分配与模型用量；pending cancellation不等于已释放额度。
- 如仍需旧direct流量，当前没有同一个入口的混合兼容模式；应单独设计路由/隔离部署，不让两个Proxy共写SQLite，不在这里临时拼接方案。

### 5.2 配置初始空池

保留原SAML URL、Issuer、签名证书和用户库，增加：

```dotenv
ACCOUNT_ROUTING_MODE=caller-lease
STORAGE_DRIVER=sqlite
POOL_ACCOUNT_EMAIL_DOMAIN=<客户批准的域名>
SSO_DEFAULT_USER_PASSWORD=<至少16字符的强随机池账号密码>
POOL_WARMUP_MODEL=<该企业实际可用模型>
READY_IDLE_TARGET=0
POOL_MAX_ACCOUNTS=1
CALLER_LEASE_TTL_SECONDS=172800
PROVISIONAL_LEASE_TTL_SECONDS=300
PREWARM_POLL_SECONDS=5
PREWARM_CONCURRENCY=1
POOL_EXHAUSTED_RETRY_AFTER_SECONDS=30
POOL_REQUEST_TIMEOUT_SECONDS=120
```

如果数据库已经有pool表，必须先检查持久化target/cap/paused；env中的0不会替换旧值。

使用pool overlay并使客户网络override最后加载：

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f docker-compose.user-pool.yml -f <客户挂载及网络override> config --quiet
```

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f docker-compose.user-pool.yml -f <客户挂载及网络override> up -d --no-build --force-recreate --wait proxy
```

Pool overlay默认把Proxy发布到 `127.0.0.1`。若LiteLLM在另一台主机，该端口不可达，需要客户最后一层override使用受限私网入口/网络策略，并检查最终渲染结果。不建议把Proxy服务密钥接口公开；Console/SSO/Login管理口同样需保护。不要把本地测试 `sso.localhost` 地址复制到客户环境。

### 5.3 配置LiteLLM（准备好后再导入业务流量）

按 [示例](../litellm/config.user-pool.example.yaml)挂载新版hook、配置实际GHCP根地址及服务密钥。保持正确模型provider。旧 `metadata.ghcp_identity` 不再读取，可以暂时保留供回退，**不要批量删metadata**。

当前回调流程为：认证对象捕获可信hash → 路由前filter → 选中GHCP后覆盖注入 `sha256:<hash>`。只支持已验证的普通DB virtual key身份；Master Key不是业务caller，不能用它做模型验收。LiteLLM管理Master Key仅用于key管理。

这一步与Proxy模式切换必须配合：新hash不要发给direct Proxy；旧identity不要发给pool Proxy。保持入口流量闸门，避免切换过程中混用。

### 5.4 首个真实成员验收

在提高target或解除暂停前，先通过SSO用户页容量显示或内部 `GET /api/users/capacity` 核对剩余SSO容量。持久化的 `maxSsoUsers` 统计全部保留的旧direct用户和新pool用户；`POOL_MAX_ACCOUNTS=1` 不会自动为SSO增加一个名额。必须先按批准预算调整SSO运行时上限，确保至少容纳本次新成员；不要删除旧用户或提高pool cap来绕过容量限制。SSO创建被拒绝可能留下需要人工核对的失败reservation，之后仅提高SSO上限并不保证普通Retry即可恢复。

Console → User pool：确认旧用户仍保留、pool库存0；在Settings检查Login并发1，再将pool target改1、cap保持1、解除暂停。

预期：自动预占普通成员 → SSO创建 → SCIM create-only → 分配席位 → Login授权 → token回调 → 模型warmup → Ready idle。

如失败，先暂停检查阶段/错误，不连续提高cap或反复点击Retry。尤其同名冲突、SSO密码未知、取消后浏览器状态不明，不应靠删除旧用户解决。

Ready后用一把真实业务virtual key调用批准模型，核对caller hash和实际成员，成功后lease active；正式TTL默认48小时。通过后暂停，评审是否扩大cap/target和并发。idle账号也占席位。

## 6. 必须告诉客户的限制

1. **旧账号不入池，旧caller header不兼容pool入口。**保留数据不等于旧业务继续从相同入口自动工作。
2. **Pool cap不是企业seat cap。**旧账号、待取消分配及pool新分配可能并存；由客户用实际控制台/账单管理总预算，不能仅减掉pending字段推导无额外收费。
3. 一次注册缺口、有限并发阶段，不代表瞬间Ready；真实Login可能分钟级。Login浏览器并发独立于 `PREWARM_CONCURRENCY`。
4. 只有完整成功推理续租。模型目录/token counting不续租。旧key撤销不会即时删除Proxy租约，需等TTL或明确释放。
5. 401后台重新登录已实现且有固定窗口/退避上限，当前请求仍可能失败；不做同请求换号重放，不通过账号轮换绕过429。pause也暂停自动修复。
6. 不保存/使用refresh token或到期时间，不保证自然到期前刷新；真实token撤销恢复尚未专门做故障验收。
7. v1.99.1实际发现LiteLLM未透传 `Retry-After`，body会包装；不能默认承诺客户端拿到Proxy原始错误header。
8. Console列表上限：1000成员、1000租约、200近期事件；筛选仅覆盖已加载记录。
9. 不自动缩池、退席位、删除SSO/EMU。禁用/释放只改变池状态，不能作为席位回收操作。
10. 新版SSO给新pool成员持久化本地ownership标记，阻止从旧SSO管理入口删用户、删EMU、暂停EMU、移除席位，以及修改其密码/email/role。对未标记的用户，破坏性操作先向配对Proxy只读核对pool ownership，确认失败会拒绝，因此新SSO与旧/不可达Proxy混用可能阻断这些管理操作，必须同release升级。没有自动席位回收/纳管工具，完整退池删除仍需单独受控方案。
11. caller-lease模式禁用旧的OAuth token CSV导入；池成员独立管理员reauthorize、旧Login任务Retry和普通SSO Sync/角色提升也拒绝，以免绕过受控授权及create-only检查。通过User pool受控恢复，不靠给另一成员导入token“救活”。终态Login任务被pool恢复引用期间不能删除；进入warmup/ready后可清理。Login删除/重试需配对Proxy在线且具备新接口，否则503拒绝操作，四组件应同版本升级。
12. 本版pool要求GitHub.com EMU与项目custom SSO。普通个人账号、外部Entra/Okta的自动供应、GHE.com替代域名路径未提供等价已验证支持。
13. 当前依赖及安全审查状态见[发布检查记录](user-pool-release-checklist.md)，不能将功能测试通过当作无漏洞认证。


## 7. 回滚

### 仅从pool退回当前版本direct

停止业务流量、暂停预热、排空请求；先恢复LiteLLM旧hook/identity来源与已保留的旧映射，再以direct重建Proxy。只有新hash而没有旧identity的key不能自动兼容，要暂时禁用或明确建立旧绑定。Pool新增账号与席位不会自动删除。

**回退时必须从Compose文件列表移除 `docker-compose.user-pool.yml`。**它硬编码 `caller-lease`，只把私有env改为 `ACCOUNT_ROUTING_MODE=direct` 并重复pool启动命令，不会切回direct。保留客户原卷/证书/网络override，并在该私有override保留已批准的受限端口绑定；移除pool overlay不能顺便放开原来受保护的Proxy端口。私有env继续保留诊断关闭/脱敏设置。

在新release目录，将私有env设为direct后校验并重新创建：

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> config --quiet
```

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> up -d --no-build --force-recreate --wait proxy
```

只输出容器中的模式值，确认是 `direct`，再验证既有caller并恢复流量：

```bash
docker compose --env-file <私有env路径> -p <现有项目名> -f docker-compose.yml -f <客户挂载及网络override> exec -T proxy node -e 'console.log(process.env.ACCOUNT_ROUTING_MODE)'
```

### 降级回升级前旧镜像

停止当前写服务，保留故障现场副本。按演练方式恢复**升级前**的五份数据卷/目录和旧配置/证书，再启动对应旧镜像。不要把旧镜像直接指向已迁移新库。

若升级后已经创建真实EMU/seat，这些外部变更不包含在SQLite回滚中：先记录新增对象，由企业管理员决定保留/清理，不应通过恢复数据库“假装它们没有发生”。建议正式推广前保持小规模canary，将回滚外部差异限制在批准范围。

## 8. 客户验收清单

- [ ] 记录旧revision/image digest、Compose项目名和实际挂载。
- [ ] 原始数据、证书、配置和日志备份可恢复。
- [ ] 升级副本演练完成，OAuth schema判断准确，统计保留量明确。
- [ ] direct阶段用户/管理员/映射/凭据按预期保留，旧请求可用。
- [ ] 不修改GitHub IdP；原SSO/证书/网络仍可用。
- [ ] 客户明确接受旧账号不入池、席位可能另增、旧header需切换。
- [ ] pool首次目标0、cap1，私网入口和密钥保护正确。
- [ ] LiteLLM新版hook、实际根URL、普通DB key和正确provider配置完成。
- [ ] 首个成员真实自动预热与业务小额调用成功，有对应request/lease证据。
- [ ] cap/idle/并发扩大经批准；pool计数与企业席位/账单分别检查。
- [ ] 回滚演练及外部新增资源处置责任明确。

**如果要求旧账号/旧seat直接复用，当前版本只完成软件保留升级和新池能力，不能把本手册当作“老账号自动迁入池”交付。**
