# Azure：Canary Hook → NGINX → 五套 MySQL Proxy 端到端验证

日期：2026-09-17。**NGINX Linux 功能验证、修正后的真实 LiteLLM Router 测试、完整 HTTP 端到端验证均已通过。** 灰度Hook修复已独立发布为 `75b92a8ca8ad999d90f1c8235edbd1f3424e5492`；不能把之前 `80e8315` 的文件当作修正版。本报告随NGINX独立功能分支交付。

## 1. 授权与隔离

- 经用户授权启动原有两台Azure测试VM；只使用指定资源组，没有新建云资源，也没有修改公司自动关机策略。
- 负载VM执行独立NGINX容器验证；服务VM执行真实LiteLLM运行时测试及端到端测试。
- 本轮所有GitHub/SCIM/席位/Login执行/模型响应均为合成mock；不访问客户服务、不创建真实用户、不添加席位、不发真实模型请求。
- 原有服务容器和数据卷未启动、替换或删除；所有测试使用新项目、新内部网络、独立数据库和临时数据。

## 2. 分阶段实际结果

| 阶段 | 实际结果 | 证明范围 |
| --- | --- | --- |
| NGINX离线配置 | 7项通过 | 配置生成、16首位映射、非法输入、转发约束 |
| Windows真实NGINX | 11组检查通过 | 固定路由、流式、取消、断流、不可信来源、目标不可用不串池 |
| Azure Linux双NGINX | 4阶段通过，含准备/清理42.728秒 | 同一配置双容器、非root/只读根、DNS、错误/流式、停止及恢复一个路由器 |
| 原灰度Hook真实Router首轮 | 12项中2失败、1错误 | 暴露继承的认证前置回调未被LiteLLM发现的问题 |
| 修正后的离线Hook | 40项通过 | 新灰度23项＋原身份17项 |
| 修正后的真实LiteLLM Router | **12项通过、0失败、0跳过，0.539秒** | 原身份5项＋灰度7项，真实回调/Router执行、mock模型、network none |
| 完整真实HTTP链路 | **25个报告检查全部通过** | 数据库virtual key鉴权→灰度→NGINX→5个真实Proxy→5库租约与mock推理核对 |

时间不是吞吐量测量。端到端报告未记录可可靠恢复的总墙钟时长，因此不虚构整轮耗时；代码设置业务探测不超过590秒，主执行预算780秒，另留清理时间。报告中的25个检查是分组断言，不是25个独立负载场景。

## 3. 真实运行暴露并修复的Hook问题

LiteLLM v1.99.1的认证前置回调分发检查 `"async_pre_call_hook" in vars(callback.__class__)`。原灰度Hook只从 `UserPoolIdentityHook` 继承此方法，在该机制下不会执行，因此没有捕获可信身份。原身份类直接声明了方法，所以其5项运行时测试仍通过。

修正是在灰度具体类中显式声明 `async_pre_call_hook`，转调父类实现，不更改身份来源/metadata规则/过滤条件。新增离线回归验证该方法直接存在于具体类中；同一固定LiteLLM镜像重跑原12项全部通过。它不是放宽鉴权以通过测试。

首轮失败完整日志SHA256：`1696c55e060aefd8450ebae379a5a134e6beb93334d431547200e69527ea8040`。
修正后完整日志SHA256：`f8072fe81ec5202fcba15b951b482ef449ef50257fd1c94a342e33cff1413fe6`。

日志包含预期被拒绝fallback的ERROR及合成模型费用映射WARNING，断言检查的是安全拒绝和真实发送路径；没有把“日志完全无ERROR”作为该反例套件的标准。不是生产费用校验。

## 4. 完整端到端拓扑

```text
合成测试客户端（使用真实签发的virtual key）
  → LiteLLM v1.99.1 + 新PostgreSQL
  → UserPoolCanaryHook(prefixes="047ad")
  → 真实NGINX
  → 五个真实Proxy v5进程
       每套 → 同一新MySQL实例中自己的pool1..pool5数据库
       每套 → 独立真实SSO及其SQLite
       每套 → 独立mock SCIM/席位/Login/model服务
```

共20个容器服务。各池mock/SSO使用各自internal网络，DNS别名proxy/sso/mock在池内独立；Proxy额外加入路由网络。NGINX仅接受实际LiteLLM静态测试IP；客户端不能直接穿过入口伪造身份。无主机端口发布，无外部网络。数据库使用全新tmpfs数据，未复用旧卷。

每个池通过真实后台worker和SSO API预配两个合成Ready成员，检查SCIM创建、mock Login POST、成功回调均为2、失败/冲突为0，随后暂停补池。不是直接SQL写Ready记录。

测试回调文件直接实例化 `UserPoolCanaryHook(prefixes="047ad")`，未另建会丢失具体类回调的子类；仓库默认 `ALLOWED_HASH_PREFIXES="0"` 不变。

## 5. 真实HTTP断言

- 实际LiteLLM版本为1.99.1；就绪接口报告数据库已连接。
- 通过标准 `/user/new` 创建合成内部用户，`auto_create_key=false`；通过 `/key/generate` 签发数据库virtual key。
- 在最多256把的安全上限内，实际生成53把短期测试key，在内存中计算hash，取得 `0/4/7/a/d` 五组和拒绝组 `2`。没有修改生产key或数据库认证记录来伪造hash。该过程仅限本隔离测试，不是让客户挑选业务key绕过灰度。
- 每个入组key执行两轮JSON/SSE，共4次、五组共20次推理HTTP请求，全部成功。
- 独立读取全部五库池API：每个caller只在目标池有一条active租约，重复请求保持成员；逐条mock请求标记只在目标池出现一次且成员与租约一致。
- 真实非灰度key返回403；缺失/无效key返回401；伪造header/metadata不能获得灰度资格，全部五池租约及mock状态不变。
- 已入组的 `4` key伪造 `0` 的身份仍到池2，额外1次成功推理，未产生额外租约。
- 撤销真实入组key后再次请求返回401，伪造另一个入组身份仍不能调用后端。
- 共21次获准推理，另有7次拒绝探测；不计建号预热调用为业务推理。
- 最后53把生成key全部通过管理API撤销，合成用户删除；新测试容器和网络全部清理，原有容器/数据卷保留。

完整端到端报告SHA256：`5122ca97d551a4cacbaa6374ac7da006d24c0b04e83918af714f61b6fe8cf5cd`。报告与探测日志已打包下载并校验传输SHA256；真实密钥始终不写报告。

## 6. 固定镜像记录

| 组件 | 使用的本地镜像ID |
| --- | --- |
| Proxy v5 | `sha256:552d81e938703c8f46f6d8d85821938a1e1b6bef2f3a1247067feaa53c06a1cb` |
| SSO | `sha256:5b855297b623c1ff9721450f5d0e02247413b9a231e5d31cf5a354a1731f1837` |
| MySQL 8.4 | `sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a` |
| LiteLLM v1.99.1 | `sha256:a53a7d3ffebede1925bd3ee8a21e4a7b9b63e2e68ec883af136edcccb6eeb82c` |
| NGINX 1.30.5 Alpine | `sha256:25820c39dba41369486df729ad6697de2fab631ca809e0503e1d1e0c73d9a232` |
| PostgreSQL16 | `sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94` |

NGINX独立容器测试另见[组件测试报告](../deploy/user-pool-hash-router/validation.md)。

## 7. 保留的夹具失败及限制

- 第一次端到端启动在Docker网络IPAM Config为null时失败，尚未启动服务；改为正确处理空网络配置后重跑。首轮清理命令因Compose尚未生成返回失败，但核验没有新容器/网络及旧资源丢失；不将首轮计为通过。
- NGINX Linux首轮Python函数名遮蔽http模块失败，修复后完整重跑；容器nofile警告通过保守worker_connections=512处理。
- 端到端仅覆盖Messages JSON/SSE，其他协议由独立NGINX转发检查覆盖，不等于其他LiteLLM适配器全部端到端验收。
- 没有真实GitHub、付费席位、浏览器OAuth或真实模型质量验证；真正的Login执行仍为mock。
- 没有客户K8s NetworkPolicy/CNI/跨节点调度/上线流量验收、性能SLO或长期稳定性验收。
- 本轮没有改变 `POOL_REQUEST_TIMEOUT_SECONDS` 默认值、范围或客户配置；120→600的生产变更应按另行评审的方案处理。

本报告记录的是2026-09-17实际测试；2026-09-18随 `feat/ghcp-hash-router` 分支提交组件及测试资料，不代表已部署客户生产环境。两台Azure VM在当时按用户授权启动，测试结束未由本次工作关闭，公司关机策略未变；这不是当前VM状态的实时证明。
