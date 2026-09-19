# 多 SSO／多 slug：第二阶段实现与验证报告

日期：2026-09-18。分支：`feat/multi-sso-slug`。基础提交：`8ad76d547c9d067aac79f99391859cc67dcd7b44`。

**交付范围：single-profile企业基础、显式初始化和离线迁移工具。尚未开放第二企业，也不是完整多租户生产版本。** 当前改动未commit/push、未合并main、未部署客户环境；没有真实GitHub/SCIM/席位/模型调用。

入口：[工具操作说明](../upgrade/default-enterprise/README.md) · [总体设计](user-pool-multi-sso-slug-design.md) · [维护与回退边界](user-pool-multi-sso-slug-migration-plan.md)。

## 1. 本阶段做了什么

### 企业标识与归属

- 企业内部ID为固定UUIDv4，保存真实GitHub slug和独立EMU shortcode；不使用字面default替代企业名称。
- schema版本2、服务契约1、能力`enterprise-single-profile`；数据库只允许一条已登记企业profile。
- Proxy所有主账号（含旧direct）带企业归属；pool成员从主账号继承，不复制两份归属；旧direct不自动成为pool成员。
- SSO业务数据、Login任务增加不可变企业归属；旧SSO用户名主键保持不变。
- DTO显式输出企业ID，内部/管理请求显式错企业或错revision在副作用前拒绝。旧无企业请求只代表已登记的原企业。
- 客户关注的数据库路径为**Proxy MySQL、SSO/Login各自SQLite**。Proxy SQLite已实现的基础兼容保留，但不拿它代替MySQL运行验证。

### cap只有一个存储权威

原持久化`user_pool_settings.max_accounts`搬至`enterprise_profiles.max_accounts`，旧settings形状通过投影兼容，事务与乐观锁保持。不存在两套可独立修改的cap，启动种子不覆盖实际持久化值。

本阶段没有实施多企业比例调度、独立weight或每企业idle。原租约、TTL、catalog hold、401修复、429冷却和失败不跨企业重试语义保持。

### 启动门禁

- Proxy、SSO、Login不再自动建表、补列或升级旧库；缺失/空库提示显式init，旧版提示离线迁移。
- 精确结构、约束、索引、trigger、marker、profile内容及revision均验证；未知、未来或半迁移结构拒绝，不自动修复。
- SQLite在WAL切换/旧migration/任务恢复前预检；不通过immutable忽略WAL，热journal或无法安全检查的sidecar状态拒绝。
- MySQL显式init在同一迁移锁下检查空库并建结构；完成标记在结构/数据校验后发布。未知锁/DDL结果停下并销毁不确定连接。
- 服务使用`ENTERPRISE_PROFILE_FILE`，只包含非敏感身份/可信路由配置；真实Secret仍走原受控配置。

### 离线工具

`upgrade:default-enterprise`提供`init/preflight/apply/verify/inspect`：

- 精确识别8ad76d5已知来源布局，不将未知旧版“修成能跑”。
- 三服务manifest配对、停writer/外部操作排空/备份确认、未决OAuth和hold/claim检查。
- SQLite只读standalone源备份，新目标独占创建、拒绝覆盖、原列逐字段保真、源hash前后不变、已完成结果幂等验证。
- MySQL原库维护态逐DDL checkpoint，绑定来源/数据库/profile/manifest/备份；明确before/after/unknown及显式resume，不声称事务rollback可撤回DDL。
- `preflight --plan-out`生成独占受保护计划，不把凭据派生摘要打印到stdout；apply/verify使用绑定后的计划。
- Console admins.json可选只读保真检查，不改内容、不重新初始化管理员。
- CLI pool init强制`paused:1`，不因初始化而自动开始真实补池。
- 旧迁移工具仍按冻结v1运行；16个基线依赖文件按SHA-256验证，旧白名单和数据迁移语义不放宽。

## 2. 实际执行的验证

### 完整模块与工具

以下均为合成数据或mock；有重叠的定向测试不相加宣称独立覆盖。

| 检查 | 实际结果 |
| --- | --- |
| 共享企业纯契约 | 8通过，0失败 |
| Proxy最终完整回归（严格按文件串行） | **518项：490通过、0失败、28真实MySQL门禁跳过；296.657秒** |
| SSO模块回归（含新增门禁） | 32通过，0失败，0跳过；66.679秒 |
| Login模块回归（含新增门禁） | 13通过，0失败，0跳过；8.012秒 |
| Console单元回归 | 7通过，0失败，0跳过；3.326秒 |
| 新迁移工具最终整组（增加暂停CLI用例之前） | 69项：68通过、0失败、1真实MySQL跳过；112.109秒 |
| 最后共享契约＋CLI定向组 | 13通过，0失败；含新增初始化必须暂停的用例，8.786秒 |
| 旧迁移工具兼容整组 | 100项：98通过、0失败、2真实MySQL跳过；27.727秒 |
| 全部部署组件生产构建 | shared、Proxy、SSO、Login、Console TypeScript/Vite均通过 |
| 部署类型检查＋3组upgrade类型检查 | 通过 |

### Proxy完整回归与复测记录

完整集成后运行了518项Proxy测试，真实MySQL授权门禁项为28。首轮失败集中在测试夹具与新显式初始化的适配，不隐藏早期失败：

- 初次517项：470通过、19失败计数、28跳过。部分计数包含父测试/子测试；HTTP摘要夹具未设置企业profile，catalog多个case错误复用同一文件库，恢复测试的精确POST断言缺新增企业字段。
- 修正夹具后，新增实例化配置一致性检查暴露测试只改config、未同步profile来源；修正为同一合成配置，不放松运行时检查。
- 另一个fixture shortcode使用9位`synthetic`，不符合EMU的3–8位规则；改为`synth`，不改变实际校验。
- 遗留MySQL migration lock测试使用40ms时间预算，在本机调度迟延下甚至未进入被测SQL阶段；将**仅测试fixture**预算改为250ms，保留超时销毁/释放/迟到处理的全部断言，生产deadline未改。
- 严格串行完整回归曾有488通过、2失败、28跳过（279.723秒）：两个既有时间敏感场景受实际调度延迟影响，600ms测试记录约1459ms，延迟GET测试超出其观察窗口。保持这两项断言与生产逻辑不变，独立复跑所属两组**45项全部通过，7.979秒**。

**最终完整复跑518项：490通过、0失败、28跳过，296.657秒**，使用`node --import tsx --test --test-concurrency=1`按文件串行执行，没有并发构建。定向45项与该组重叠，不相加；最终通过不抹去前述失败记录。

### 真实本机服务启动（不是客户或MySQL环境）

使用新工具显式生成三个空的合成SQLite库、一份合成profile、临时自签证书；实际启动Proxy、SSO、Login运行代码。测试进程不加载部署.env，外部fetch被显式阻止，无账号/队列任务，不触发开户或模型。

- Proxy：healthz/readyz、受内部token保护的企业能力与账号列表返回200；正确企业/revision请求200，错误企业400，错误revision409，无内部token401。
- SSO：healthz、空用户列表、runtime settings返回200；错误企业400。
- Login：healthz、空任务列表、runtime settings返回200；错误企业400。
- 三服务日志确认合成路径及正常启动，没有运行时异常。
- 初次访问`/api/settings`得到404，是检查路径写错；核对路由后使用实际`/api/settings/runtime`返回200。预览打开根路径可能有启动时connection-refused或Proxy未鉴权401，不作为业务API故障。

这些启动检查证明新schema与应用接线，不证明Proxy MySQL端到端或SAML/SCIM真实外部登录。没有UI视觉改动，未重跑浏览器布局矩阵。

## 3. 修正过的实现问题

- URL校验初稿先用URL解析器，编码`%2e%2e`可能先被规范化抹去；改为对原始输入拒绝编码分隔/点路径、query/hash等，再解析，回归通过。
- MySQL初始化初稿缺命名锁；补并发init互斥、锁内空库检查、完成marker前完整检查以及错误/超时清理，新增离线并发回归。
- MySQL CLI verify初稿只检查schema，已补迁移receipt及全部原列绑定验证。
- CLI预检逻辑快照摘要初稿只有编程接口能取得；改为受保护`--plan-out`闭环，避免要求客户自写代码或公开凭据派生摘要。
- MySQL无CA连接只允许字面loopback并核对实际peer，不把localhost名称简单视为安全本机连接。
- 迁移预检补池ordinal/name/next_ordinal/caller/lease/ready状态等数据约束，不只看表结构和行数。
- 新旧schema分离导致两个历史v1迁移测试需移动：原断言保留在冻结v1升级测试集中，并非删除历史覆盖。

## 4. 仍未覆盖／不能承诺

1. **真实MySQL DDL、TLS、checkpoint恢复及生产数据演练未执行。** 当前没有为本轮确认的专用可丢弃MySQL实例；只运行离线metadata/SQL模拟和故障注入。生产批准前必须在获准专用实例完成真实集成与恢复演练。
2. 没有旧binary × SQLite/MySQL × direct/pool全部启动兼容实测；旧进程不会因为新增版本行就自动停止，维护停写、防自动拉起和访问隔离不可省略。
3. 三服务工具返回配对ready不等于跨库原子事务；某组件迁移失败不会自动回滚其他已完成组件。各服务启动只核对其本地完整状态/可信profile，部署方必须遵守整体切换门禁。
4. Login enterpriseRevision来自不可变profile投影，不是旧任务历史配置快照；账号incarnation、完整task幂等和GitHub实际主体校验尚未实现。
5. SSO保持旧用户名主键和单SAML上下文；跨企业同名、会话/SCIM/预算隔离、第二企业接入属于第三阶段。
6. 全局idle＋cap比例调度及Console企业界面属于第四阶段，尚未启用。
7. checkpoint建表确认丢失留下未绑定空表时，工具故意拒绝自动恢复，要求人工检查；不能为追求自动恢复放宽识别。
8. 新版一旦运行产生写入，不能仅换回旧镜像或恢复旧快照声称无损回退；恢复数据库也不会撤销外部用户/席位。

## 5. 最终检查

本报告记录的原始本机日志保存在忽略的`.claude/enterprise-phase2-*.log`；合成预览数据位于系统临时目录，不进入Git。实际客户配置、证书、密钥与账号未读取或复制到交付文件。

完整Proxy最终复跑通过；文档相对链接、`git diff --check`及新增/修改源码隐藏控制字符检查通过。三个本阶段合成预览服务已停止，临时数据和私有日志保留。main与fork/main仍为8ad76d5，当前仅功能分支有未提交改动。本阶段未提交、推送或部署。
