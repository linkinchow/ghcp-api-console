# 多 SSO／多 slug：第五阶段实库验收记录

日期：2026-09-19。基线HEAD：`8ad76d547c9d067aac79f99391859cc67dcd7b44`，`feat/multi-sso-slug` 未提交工作树。**本阶段隔离实库与mock全栈验收已完成；不是生产发布批准。** 结果限于本报告列出的环境和用例。源码以base bundle与后续文件hash/镜像记录配对，不把HEAD冒充当前未提交源码。

## 1. 环境与安全边界

用户授权的隔离 Azure 测试资源组（具体资源标识不公开）。仅使用原测试services VM；未启动本地Docker Desktop，load VM未使用。Ubuntu24.04、Node22.23.2、Docker29.1.3、Compose2.40.3；数据库实际版本 **MySQL8.4.11**。

- 新建独立run目录、Compose项目、卷、schema与合成凭据，不覆盖旧9个容器/80个卷。
- 应用与provider只在internal Docker网络；数据库专用访问bridge使测试端口实际绑定127.0.0.1。没有扩大NSG、公网SSH、Storage公网或修改公司定时关机。
- 所有SCIM、席位、OAuth授权、GitHub `/user`、模型返回都是本地mock；SSO/Login/Proxy/Console实际应用与数据库真实运行。Login仅在test-only入口替换authorize，真实queue、持久化、取消、回调和Proxy主体核验保留。
- 未创建真实GitHub用户/席位，未调用真实模型，未访问客户数据库。旧真实GitHub测试不算新版多企业实测。
- 运行A保留失败现场；运行B使用修复版新数据做全栈；运行M单独用于迁移与恢复。不清空失败库后冒称第一次成功。

## 2. 已执行且通过的真实MySQL组

| 验证组 | 实际通过／失败／跳过 |
| --- | --- |
| v1→2迁移，direct＋pool | 3／0／0 |
| v2→3迁移 | 2／0／0 |
| v3→4迁移 | 2／0／0 |
| 第四阶段双连接竞争 | 6／0／0 |
| Proxy存储真实prepared语句 | 1／0／0 |
| 账号池多连接契约 | 22／0／0 |
| 恢复／清理 | 5／0／0 |
| 并发准入 | 16／0／0 |
| caller隔离 | 3／0／0 |
| 生命周期竞争 | 2／0／0 |
| catalog压力 | 2／0／0 |
| 凭据竞争HTTP路由 | 10／0／0（包含SQLite与MySQL子用例） |
| inference timeout MySQL | 3／0／0 |

以上是最终对应实库组的执行结果，不叠加失败重跑或本地mock组。MySQL使用固定镜像 `mysql@sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a`；不泛化为所有MySQL版本均已验收。

## 3. 已通过的实际全栈闭环

三Proxy共享MySQL，SSO/Login各SQLite、Console文件管理员、round-robin HAProxy和企业化mock。

- 冒烟3项通过：真实服务健康、初始pause无外部副作用、未认证/错企业拒绝。
- 生命周期14项通过、274次受控HTTP：准确补到2个idle；B启用时idle足够不开户；不足时补B；4∶2库存；SSO密码/会话企业隔离；JSON/SSE；429不轮换重放；降cap不删账号且可租已有idle；排空/重启用；自然TTL60秒；在途hold；401真实Login重授权；取消；SCIM已提交但丢ACK不重建；主体核验失败的uncertain回调需显式核对。
- 新库公开工具init＋verify确认Proxy4、SSO/Login3配对，所有初始企业draft、池paused。
- 离线追加企业实库资格通过：公开init/register/verify APIs保留原企业实际cap（5，而registry seed为6）、policy、凭据bytes、密码hash/salt、incarnation、有效lease和历史行；新企业draft/empty。错revision/旧profile修改拒绝，未调用provider。

## 4. 完整迁移、恢复与有界运行验收

运行M从实际8ad76d5旧初始化代码产生合成旧库，逐阶段实际dump备份后通过公开CLI完成1→2→3→Proxy4，以及最终verify、v4备份。原列typed-byte、SQLite原值、cap、lease/期限、ordinal、generation、incarnation、管理员和证书材料保持。

第二个新MySQL实例的v4备份恢复及逐字段verify已通过；SQLite文件、incarnation与原receipt保持，未重写marker。迁移后应用启动健康；只读冒烟最初误把历史单企业cap6与现代总cap12作整体相等比较，修正测试投影后7项复测通过，其他不变量、fingerprint及原始证据仍严格比较。

有界连续观察实际运行 **597.944秒**，296次合成推理全部成功、0不可用（300次上限，600秒硬上限），总HTTP648次；10个间隔采样均观察到一个本地owner，无请求重放、无新增SCIM/席位操作。它不是生产容量或长期可靠性结论。

Owner故障用例通过：停止`proxy-3`后约32.156秒由`proxy-2`接管，原owner同ID重启成功；前后两次合成推理对应两次上游调用，同一caller/成员/lease保持，无新增开户/席位/授权。该用例观察的是进程诊断与业务连续性，不单独声称证明所有数据库owner fence；后者由实库竞争组覆盖。

真实Chromium149.0.7827.55对运行B的Console完成99项断言，两企业用户/账号/池/策略/统计与真实API一致，统计第二页实际验证；桌面1280px和手机375px截图留存。只发一次管理员登录POST，业务写入0、外部浏览器请求0、页面错误0、失败API0。

故障注入三组实际通过：v2在服务器DDL成功后注入客户端ACK丢失，按冻结的精确before/after证明恢复；v3实际观察metadata lock并终止本轮指定连接，unknown checkpoint拒绝自动恢复；v4在真实COMMIT完成后注入ACK丢失，unknown checkpoint同样拒绝重放/改marker。后两种ACK测试是客户端传输边界注入，不宣传为任意网络分区故障覆盖。

实际旧8ad76d5 MysqlStorage/MysqlPoolStore初始化及已初始化对象兼容测试完成，direct/pool两组均记录结果。**已运行的旧对象在schema2/3/4仍可读取和更新原账号、记录统计等**；这不是安全放行的优点，而是必须停旧writer的实证。未执行完整旧HTTP服务器进程矩阵，不把storage classes覆盖扩写成该结论。

迁移后只读冒烟最终 **7项通过、28次HTTP**：三个实际Proxy均保留原成员/lease/TTL/时间/ordinal/cap，原Console管理员可登录并读取迁移后的池；provider调用、推理、启用和token续期均为0。特殊bytes旧token只验证保存保真，没有把它当作可发送HTTP的真实凭据。

## 5. 实测发现与修正

1. **预热多登记缺陷（生产逻辑）**：目标idle2时实际建3个。活跃SSO创建阶段不应被当作新的缺口，但持久未知状态又不能简单计入可靠P。worker有本地活跃步骤时继续原reservation事务/await，仅传空创建候选集合，延后新登记；继续推进已登记工作。未知结果、cap、owner/generation保护不变。130项定向与完整Proxy619项（590通过、29实库门禁跳过）通过；新运行B生命周期实测准确2与4∶2通过。
2. **实库夹具版本错误**：旧`maxAccounts` init字段被schema4严格拒绝；修正测试helper为v4-only，cap仍在profile。旧错误文案断言改为精确新错误码，保留fail-closed断言。
3. **运行账号元数据权限**：同库root可见13个trigger，DML账号为0；实际validator以`enterprise_mysql_triggers`拒绝。仅对本轮app schema追加`TRIGGER`后完整validator通过，未加全局权限。该权限也可CREATE/DROP TRIGGER，不是只读权限；客户需DBA/安全审批，详见升级指南。
4. **测试编排兼容**：Compose2.40.3不支持create `--no-deps`/start `--wait`；改成create不重建与plain start＋明确owned-ID健康检查。纯internal网络没有实际发布请求的host端口；单独数据库访问桥修复，实际port/peer门禁保留。
5. **稳定性脚本入口循环**：未决top-level await使初次观察exit13，未产生测试窗口。拆分共享工具与入口后，两个CLI的子进程回归通过，再执行新的有限窗口；不把失败入口算稳定性通过。
6. **迁移fixture旧cap投影**：旧单企业cap为6，现代runtime seed总cap12，最初被严格校验拒绝（0表、空目录）。在旧源生成前仅投影原企业cap6，保留全部fingerprint不变量，不改已保存数据库或marker；之后完整链通过。

## 6. 交付与仍需说明的限制

- 正常Proxy/SSO/Login/Console Dockerfile与tooling均在Azure构建通过，使用公司npm源，没有绕过Minimum Release控制；Login正常Chromium依赖打包通过不等于真实设备流已验收。
- 旧版本兼容资格脚本使用实际旧storage classes，不能宣传为完整旧HTTP进程和所有客户拓扑矩阵。
- 不提供新版写入后的通用无损降级；部分跨库迁移必须保持维护态。真实GitHub多企业SAML/device flow最终小范围冒烟仍未执行。
- 未commit、push、合并main或客户部署。本轮A/B/M共31个测试容器均已按精确ID/标签停止；容器、卷、备份和失败证据保留，没有删除历史资源。services VM保持运行交由既有公司关机策略处理，load VM未启动；本地预览控制器已停止。
- 最终本地部署构建、类型检查和diff whitespace检查通过。实际构建基础包SHA256为`55b7052c8ddbef3b216a6cfdfe8f2232b60f05a26f5022985e87a9a9587f40c8`；后续调度修复和测试修正按受保护逐文件receipt传输。最终worker源码SHA256为`96124e22085407a06a0d52b1a6c659de447fb6e26145998d52eb5ed45259e8be`。发布前仍需单独批准commit与最终镜像固定，不将测试tag当发布digest。
- 恢复覆盖本轮v4完整备份的第二实例恢复；没有把它扩写成任意历史备份、任意客户PITR、任意网络分区或全旧HTTP矩阵保证。

## 7. 验收镜像与资源证据

运行B及迁移运行M的最终实际镜像ID（不是发布批准）：

| 组件 | 实际镜像ID |
| --- | --- |
| 修复版Proxy（三副本同源） | `sha256:eb68496553ab65c1ac3a6bcd4138ad1f6fe099f46e92d07a3ffa110f37315e8e` |
| SSO | `sha256:c0b0c36fd40cedf769b37d502a62500302dcf8977190e82afe8bd62dc63d0235` |
| Console | `sha256:315b5a652af4e30ae811495b29611fcddddf8d923b3dbc9454dc56c782cb75b2` |
| 测试tooling／真实Login加合成authorize入口／provider | `sha256:012b7ab85da8086ce96aa167762ac739a99cfdfbd821914eada93b079d0e2d4b` |
| MySQL8.4.11 | `sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a` |

正常Login生产镜像另行构建通过；运行资格明确使用test-only授权入口，不将tooling镜像作为生产Login交付。稳定性与迁移冒烟后续只读挂载的测试脚本修正另有逐文件hash证据，不改变已运行的应用镜像。

最终远端复查A/B/M的running容器列表均为空；各运行容器/卷/备份保留。原始日志、合成凭据、证书、浏览器截图和SQL备份保持私有，源码交付不包含这些材料。

配套：[客户升级指南](user-pool-multi-sso-slug-upgrade-guide.md) · [第四阶段历史验证](user-pool-multi-sso-slug-phase4-validation.md) · [隔离夹具说明](../tests/enterprise-phase5/README.md)。
