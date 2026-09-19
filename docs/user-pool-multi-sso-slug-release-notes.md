# 多企业账号池候选版本发布说明

**状态：第六阶段发布准备与隔离复测已完成，尚未提交、发布或获准客户上线。** 当前功能分支为 `feat/multi-sso-slug`；基线 `8ad76d5` 不是新增功能的发布版本号。

## 功能范围

- 同一部署管理多个企业 profile，以固定内部 UUID 引用企业，真实 slug 和 shortcode 分别保存；原企业保留现有公开 SSO 根入口。
- 每企业一个 `max_accounts`，全局一个 `idle_target`。按 cap 比例与已登记库存比例的差额选择新库存与新准入企业，不新增独立 weight 或每企业 idle 配置。
- idle 充足不为调比例开户；降 cap 不删账号、不驱逐既有租约；TTL 释放不改变库存。**10,000 个池账号名字由所有企业共享，同一个名字不能被分配到不同企业。** 全局 ordinal/next_ordinal 不按企业重置；新增企业、释放租约、降 cap 和排空不回收名字供其他企业复用。
- **名字目录为5,000个 base × `00–01`**，原1,000个名字保持原顺序，仅追加新名字；新增4,000个统一按F–Z排序，整表A–Z。升级必须通过 ordinal/name 兼容检查；原始高序号不兼容时拒绝升级，不自动重命名。见[目录来源与兼容边界](pool-name-catalog-provenance.md)。
- 企业状态 Draft / Validated / Active / Draining，启用、排空及全局暂停为不同操作。
- SSO 用户、SAML 会话、Login 授权任务及回调均有显式企业绑定；账号 incarnation 防止删除重建后的迟到写入。未知外部操作结果保留待核对状态，不盲目重放。
- Console 提供全局池与企业视图、cap/状态管理、企业化用户/账号/任务/统计。原调用方格式不变，429 不通过切换账号/企业重试同一请求。

## 不兼容变更与部署要求

| 项目 | 要求 |
| --- | --- |
| 数据结构 | Proxy schema4；SSO/Login schema3；contract2；registry JSON3 |
| 配对升级 | 全部 Proxy 副本、SSO、Login、Console 使用同一批准源码 |
| 数据迁移 | 精确旧基线经 1→2→3→Proxy4，离线工具显式执行，运行时不自动 DDL |
| 写入边界 | 停止所有旧 writer；不支持新旧版共库普通滚动升级 |
| 数据库 | 多 Proxy 共享同一 MySQL 写库；SSO/Login SQLite 与 Console 管理员文件仍为单实例 |
| 权限 | 运行账号需经审批的业务 schema DML + TRIGGER；TRIGGER 也具有触发器 DDL 能力 |
| 负载均衡 | 普通 Service / round-robin LB；禁用推理 POST 失败重放，不依赖独立 hash-router 分支 |
| 租约 | 保留原租约及截止时间，不批量释放，不等待全部 48 小时 TTL |
| 回退 | 新版运行时写入后不承诺通用无损降级；数据库恢复不会撤销外部操作 |

registry 是进程生命周期内的固定可信配置。追加企业需离线 register、verify，并协调重启；不是热修改 JSON 自动生效。企业 cap 的实际权威在数据库，registry cap 只用于初始化/登记。

## 验收证据与未验证范围

- [第五阶段报告](user-pool-multi-sso-slug-phase5-validation.md)：MySQL8.4.11 实库、完整升级链、恢复、三 Proxy + mock 全栈及约10分钟有界观察。报告包含其实际源码/镜像，不自动覆盖后续修复。
- [第六阶段报告](user-pool-multi-sso-slug-phase6-validation.md)：发布审查、修复及候选源码复测，完成状态以该报告为准。
- 没有真实 GitHub 新版多企业验收，没有客户生产迁移，没有容量基准或长期可靠性保证。
- 不支持把多套已有部署无映射合并成一个池；不提供自动迁移外部用户/席位的功能。

## 尚未生成的发布标识

本次不填写虚构版本/tag、commit、镜像 registry digest 或客户批准记录。获得单独发布授权后才可固定提交、同源重建四组件及 tooling、记录不可变 digest，并将对应验证结果绑定到该候选。

完整操作顺序、备份、权限与回退界线见[客户升级指南](user-pool-multi-sso-slug-upgrade-guide.md)。
