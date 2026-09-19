# 第六阶段：多企业版本发布准备与审查记录

日期：2026-09-19。分支 `feat/multi-sso-slug`。基线 `8ad76d547c9d067aac79f99391859cc67dcd7b44`。

**完成：本阶段发布前审查、必要修复、名字扩充与隔离复测已完成；不是代码发布或生产上线批准。** 未 commit、push、合并 main；未访问真实 GitHub 或客户数据。

## 1. 来源与执行边界

- 第五阶段完成状态保存在私有源文件检查点：308 个变更/新增文件，ZIP SHA256 `8714fbcfbf4bef9111b5a29d9f0b872c32ca0e91d924e81fd9b226bfba86a950`。
- 先执行多角度只读审查，候选由独立验证者核查；静态确认与运行复现分别记录。审查工具内部展开了多于三个审查/验证 agent；后续实施严格限制为三个并行工作组，禁止子组再展开。
- 三组分别负责：Proxy 授权/导入/统计；账号池 readiness/取消/容量；SSO 启动/SAML/外部结果保护。主会话负责跨组协议、共享运行门禁、集成、测试与交付文档。
- 独立工作树必须先覆盖完整未提交源码检查点；只按归属文件的 baseline/delivery SHA256 导入增量，不把旧 HEAD 或整个工作树反向覆盖主目录。
- 第五阶段测试证据保留为历史结果，不能自动当作第六阶段修复源码的验收。

## 2. 审查发现与处理范围

用户本阶段再次确认：**一万个池账号名字全局共享，不允许不同企业重复分配。** 将 SQLite/MySQL 全局 identity/ordinal 唯一约束、单一 next_ordinal、跨企业补货与边界回归列为必验项；不把多个企业各自重复的一万个名字误当全局容量。

| 发现 | 处理要求 |
| --- | --- |
| 已确认取消的 Login 任务仍占全局池名额 | 校验完整绑定后收尾；不释放 uncertain/cancel_requested 的名额 |
| 账号删除后终态授权记录无法读取 | 允许准确旧绑定读取终态；旧回调不能修改新账号 |
| token 导入在外部验证期间发生删除重建 | 导入提交使用 incarnation/不存在状态及授权世代比较，拒绝过期写入 |
| 单个慢 readiness 阻止所有企业补货 | 独立限时并保留健康结果；owner 失效仍中止 |
| 企业 SSO 用户容量满仍创建池占位 | 独立只读容量检查；明确拒绝保留同一名字/ordinal 并安全失败，容量恢复后显式 Retry，不误判未知提交或无限自动重试 |
| draft 企业缺 session secret 导致 SSO 全局启动失败 | 企业独立延迟初始化，缺配置企业拒绝访问，不拖垮其他企业 |
| 成功 HTTP 但语义无效的外部修改回执解除保护 | 未确认外部结果继续持久化保护，不自动重放 |
| 可满足的标准 SAML AuthnContext 被全面拒绝 | 严格接受可满足的明确上下文，不放宽其他 SAML 校验 |
| 新 direct 身份初始化失败统计不可见 | 请求时保存可信原企业归属，不改历史 NULL 归属 |
| 安全的 readiness 错误码被脱敏成无意义文本 | 仅放行固定机器码，任意上游内容继续脱敏 |
| 周期 readiness 重复扫描整个 SQLite 业务历史 | 完整启动校验保留，周期仅核对连接/FK/结构版本/配置及完成标记 |
| Proxy 每次 profile 查询同步重读完整 registry | 进程内固定只读配置，离线登记后协调重启生效 |
| MySQL policy mapper 忽略 evidence 长度限制 | 复用既有严格解析器，不改 schema |

未纳入本次扩大重构：重复库存聚合、SQLite 全局总览按企业查询、冗余任务 closure-state 字段。它们不是已证明的安全故障；避免发布收口时引入新 schema 或大范围锁/查询变化。MySQL 旧 claim retry 的特定“同身份必死锁”推断已反证，不按误报修改。

## 3. 验证记录

### 审查前基线执行

- 审查子会话报告：869 通过、34 跳过；另有取消名额旧行为定向测试 1 通过，该测试证明旧缺陷行为，不是修复通过。
- 类型检查、Console 构建通过。
- 浏览器首次启动受缺失 bundled Chromium 阻塞，19 项应用断言未执行；主会话使用本机现有 Edge 复跑，不下载/绕过公司 npm 控制。

### 主会话实施中

- 共享 readiness guard、Proxy 配置生命周期、Login readiness：最终 14 通过、0 失败、0 跳过。新增 marker 测试首次误写受 CHECK 禁止的 state，改为合法但不匹配的 registry hash 后通过；未放宽数据库约束。
- 只合入主会话缓存/门禁修复时的完整 Proxy：620 总项、591 通过、29 实库门禁跳过、0 失败；Login 36 通过。
- 原有 Console 离线 Edge 浏览器回归首次 18 通过、1 个元素等待超时；保留失败日志，串行重跑 19/19 通过。未修改产品代码或放宽断言。
- 实际本地服务 preview：新隔离 SQLite fixture，SSO 登录页可达；新 scoped creation-capacity 返回 200 + no-store，值与本企业用户一致；Console 原文件管理员登录、排空→validate 200、切换企业后 cap 和 scope 正确。初始未登录 `/me` 的401为预期；SSO登录页 CSP 阻止调试 fetch，转到 healthz 后验证 API，不修改 CSP。五个 preview 服务已停止。
- A 组本地定向 29/29、C 组完整 SSO 63/63；均无失败/跳过。它们使用独立工作树，不等同最终集成源码全量结果。
- 最终5,000名字统一A–Z排序候选：完整Proxy651总项、622通过、29实库门禁跳过、0失败；名字/分配/V4工具85总项、83通过、2实库跳过、0失败。所有10,000名字及最长shortcode规范化结果唯一，原1,000前缀逐项保持。
- 最终串行本地批次中，shared23、Login37、Console13通过；V2工具69通过/1实库跳过，V3工具56通过/2实库跳过，V4快照修正后40通过/2实库跳过。SSO Windows批次61通过/2 schema worker的5秒超时，孤立重跑8项SAML通过，但不抹去超时；另以Linux/Node22构建复核。
- 初次全量因严格名字门禁发现HTTP测试夹具使用虚构`legacy-member`/`second-member`和不匹配SSO alias；修正为目录ordinal对应名字后定向15/15和完整Proxy通过。未放宽运行门禁。
- 正确性集成复核额外修正MySQL目录启动竞态：cursor和inventory必须来自同一条SELECT快照，不能启动时两次读取而误拒绝并发新登记；纯SQL模拟回归通过，实库待本轮验证。
- Azure首轮真实执行：五个正常组件/tooling构建通过；Linux/Node22完整SSO63/63通过，0跳过，未修改SAML的5秒校验上限。MySQL新实例初始化、v1→2和v2→3实库通过。v3→4 direct通过、pool因历史测试夹具`known`/ordinal0不匹配名字门禁失败，保留原始结果；仅修正fixture为实际目录名字后复跑，门禁未放宽。
- Azure实库新增取消回归首次6通过/2失败（一个子项与父汇总）：夹具误用`update(last_error)`制造generation变化，但disabled成员该更新被拒绝、也不是凭据世代写入。修正为实际凭据写入触发generation，旧错误码保持不变；不是修改生产release规则。原失败记录保留，复跑结果另列。
### 最终真实 MySQL 与全栈结果

本轮新建`phase5-20260919p6`独立项目/数据卷/schema，复用已获准services VM；旧A/B/M现场未启动、覆盖或删除。数据库实际MySQL8.4.11；最终各组均0失败、0跳过：

| 实际组 | 通过 |
| --- | ---: |
| v1→2 / v2→3 / v3→4 | 3 / 2 / 2 |
| 多企业并发与新增取消/全局名字回归 | 8 |
| MysqlStorage（含导入CAS场景） | 1个汇总测试 |
| 池多连接 / recovery / admission / caller隔离 / lifecycle | 22 / 5 / 16 / 3 / 2 |
| catalog压力 / 凭据竞争HTTP / inference timeout | 2 / 10 / 3 |

三Proxy+真实SSO/Login/Console+企业mock最终冒烟**3/3通过、15HTTP**；生命周期**15/15通过、299HTTP**。其中确认取消的disabled成员退出oauth-wait并释放Login名额，原disabled状态保留；实时SSO容量满但池cap有余量时不增加新库存；两企业9个已登记名字全局唯一。Login只替换test-only authorize，实际queue/runner/回调与Proxy主体核验保留。

本阶段未重复10分钟稳定窗口、owner kill或完整备份恢复；这些仍明确引用第五阶段对应源码的历史结果，不冒充最终改动的重跑。此次实库重点复跑受影响迁移门禁、并发、导入、取消及全栈生命周期。

## 4. 名字目录扩充（用户追加范围）

用户先提出独立待办，随后确认本轮可以追加原目录且不得删除旧名字，要求整数乘积保持10,000；最后明确优先5,000而非2,500。本轮最终目标为5,000个 base × 00–01；原1,000个条目保持前缀原顺序，追加4,000个并覆盖A–Z。按用户随后要求，仅将尚未发布的新增4,000个统一F–Z排序，原1,000个本来已按A–E排序，最终整表A–Z。新增部分F–O各191个、P–Z各190个，并非集中追加Z。旧目录仅覆盖A–E，来自历史提交`da76eb1e`；仓库未记录原始网站/生成命令，不能声称已确认素材来源。新增部分应记录可复现生成方法和来源，不抓取真实用户。

兼容门禁不得依赖“客户大概只用几十个”的推测：已有旧ordinal/name超出共同前缀或已消耗历史无法证明兼容时，必须在迁移/启动拒绝，不自动改名、删除、重编号或回拨cursor。冻结历史工具的目录保持原样。

## 5. 发布与上线界线

交付检查：共328个未提交变更/新增路径（包含前五阶段），其中本阶段相对检查点73个文件变化；源码候选414个文件的内容映射SHA256为`d048ae4622205387332a99565308a13daf8614e7ad462673dabae87425b5aab4`，随后仅MySQL测试fixture有独立hash receipt。原始日志、凭据、SQLite/MySQL数据和证书不在交付列表。增加root测试diagnostics忽略规则，保留现场而不误提交；新名字来源文档已明确加入docs白名单。冻结v1文件与本阶段前检查点hash一致。

token导入保护明确限定：已有账号删除/重建、仍存在的新账号、授权尝试世代变化均拒绝旧写入；最初不存在→并发创建→未产生任何授权记录便删除→再次不存在，现有schema无持久账号生命周期墓碑，不能区分这段历史，不声称所有不存在状态ABA都已解决。导入仍是管理员主动写入，不放宽旧回调权限。

本阶段允许代码审查、必要修复、合成数据测试、发布材料整理。代码发布仍需单独授权；没有 commit SHA 和批准的发布镜像 digest 时，不把测试 tag 称为发布产物。

收尾已实际完成：本轮10个精确ID/标签对应的容器全部停止，running列表为空；容器、数据库卷、结果和失败证据保留，历史资源未改。本地preview列表为空。services VM保持既有公司关机策略，load VM未启动；未commit/push/合并main/客户部署。

### 最终测试镜像（不是已发布registry digest）

| 组件 | 实际image ID |
| --- | --- |
| Proxy（三副本） | `sha256:fe4889e41ff7604c8161b5569985b31a60d604618a036f938e6570e3350d25ff` |
| SSO | `sha256:8c5a062f9c3b64556e194edb53756c8447fde90b793058449058044520002a40` |
| 正常Login构建 | `sha256:6e28d324d21583c5ba15a00634da8ef6165133e5af32d5e94319da207c5c97b1` |
| Console | `sha256:35e78486929266115572a14d9d05bcd8d13a15d87f458c7bc85751e866e428f1` |
| 测试tooling/合成authorize Login/provider | `sha256:4c38f3184f6ae8dafc3f3dded391dd0ac922bdb8406f343ba464d44b491baeca` |

真实 GitHub 多企业 SAML、SCIM、席位、设备授权和模型端冒烟仍未执行。客户 DBA 对运行账号 schema 级 TRIGGER（含创建/删除触发器能力）的批准、停止全部旧 writer、客户自己的备份恢复演练及维护窗口仍是上线门槛。

## 6. 可复核入口

本地最终执行入口为`npm run build:deploy`、`npm run typecheck:deploy`、`node scripts/generate-pool-name-catalog.mjs --check`、Node `--import tsx --test --test-concurrency=1` 的显式Proxy全部测试文件，以及三个版本化工具测试。Console离线浏览器使用已安装Edge（`PLAYWRIGHT_CHANNEL=msedge`）串行执行19项；没有下载替代浏览器或绕过npm Minimum Release。新增名字纯测试直接枚举10,000候选，非实际创建10,000用户。

实库入口仍为`tests/enterprise-phase5/db-run.ts`明确允许的v2/v3/v4/phase4/storage/pool/routing七组，先核对run ID、容器精确ID/标签、数字loopback实际peer和专用schema，再导入driver执行。完整HTTP测试由`fullstack.ts --mode smoke`与`--mode lifecycle`执行；最终test-fixture修正只读挂载，不冒称重新构建过正常生产镜像。原始SQL/异常日志保存在VM私有目录，源码只交付脱敏总结。

配套：[第五阶段历史验收](user-pool-multi-sso-slug-phase5-validation.md) · [客户升级指南](user-pool-multi-sso-slug-upgrade-guide.md)。
