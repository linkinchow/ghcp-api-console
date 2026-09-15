# 本地真实池 SQLite → 多 Proxy MySQL 迁移演练

迁移日期：2026-09-15；状态更新：2026-09-16。用户授权先迁移本地原真实账号数据、再查看新UI、最后才放行两个新账号。本文保留迁移实际过程与历史失败，并引用随后经另行批准的功能结果，不把此前合成迁移结果当成本次完成，也不把本地验证写成客户现场验收。

## 范围与保护

- 源是此前真实SSO/GitHub测试环境的SQLite池：4个Ready成员、2条请求统计、25条事件，0lease/hold，paused1、idleTarget2、cap5。
- **迁移期间**旧Proxy、SSO、Login均停止，未启动。原SQLite卷、WAL/SHM及其它组件卷/证书保留；备份与迁移只处理独立副本。后来两账号验证单独按授权启动真实链路，不意味着迁移期间曾发出外部请求。
- 本地Docker仅功能/迁移，不性能压测。目标是全新专用MySQL，先不启动应用；初始应用/UI检查阶段使用内部隔离网络，不启动SSO/Login，不连接真实外部服务。
- 导入本身不创建新账号、不增加席位、不调用模型。新增两个账号和四key调用在用户查看新MySQL多副本UI并明确批准后执行，分别归档，不算数据库导入动作。

## 迁移实际记录——已完成

1. 已只读核对源容器存储驱动为SQLite，与另一套双Proxy MySQL mock环境不同。
2. 已从只读挂载的停止卷保留main/WAL/SHM三文件，使用SQLite备份接口生成一致性独立副本；只在副本使用DELETE journal。完整性/FK检查通过，源文件哈希未变。
3. 使用现有`upgrade/user-pool-mysql`执行source-only dry-run：**拒绝**，旧库缺少`user_pool_catalog_cooldowns`及其过期索引。没有向MySQL写入，没有修改原备份。
4. 对照当前schema确认仅缺上述两个对象；新增严格copy-only兼容步骤（`upgrade/user-pool-mysql/legacy-copy.ts`），**15项专项测试通过**。只在新的工作副本补空表/索引，全部旧行/字段和原源哈希不变；原迁移器完整预检随后通过，未放宽校验，也不是原位升级源库。
5. 首次导入连接被拒绝：内部隔离网络未发布宿主端口，目标MySQL容器本身健康。增加固定的本机TCP转发入口后，确认目标无表，才重新执行；首个失败未写入数据库。这个本机连接调整不是客户MySQL/TLS或LB验收。
6. **实际导入通过**：4账号、4成员、2统计、25事件完整内部比对，源工作副本字节未变；目标paused1、owner为空，0lease/hold/catalog，未发外部请求。
7. 依次启动一个MySQL Proxy、另两个Proxy和Console，三副本均ready/storage=mysql，共享4ReadyIdle；一个owner、两个standby，原数据计数保持。此时应用内部网络仍无外网，SSO/Login未启动。导入时owner为空与应用启动后选出owner是不同检查点，并不矛盾。
8. 新UI已提供给用户，用户截图确认原4成员与旧验证时间。只读运维采集器实际读取3个独立副本和MySQL SELECT owner查询，结果`collectionComplete=true`、有效owner present、paused=true；不是仅离线测试。监控专项离线套件为30通过，但客户告警送达仍未验证。

## 迁移后另行批准的功能验证

### 并发维护与恰好两个新账号——通过

用户已查看UI，并批准两个新真实账号及必要席位/预热，同时指定Prewarm5、Login concurrency2、Login pending2。新离线并发维护工具（`upgrade/user-pool-mysql/reconfigure-concurrency.ts`）通过31项离线测试，以及隔离真实MySQL的新配置接受/旧配置拒绝校验。首个合成维护验证脚本误用缓存store导致旧配置拒绝断言失败；改用新storage实例后正反校验通过，真实池在该验证完成前未改fingerprint。

真实维护时暂停并排空，停止全部三个Proxy及Login/SSO，确认owner到期；CAS仅将已知旧配置fingerprint变更为新并发配置fingerprint（Prewarm/pending从1/1到5/2），全部其它表记录/字段逐值校验保留。Login自身运行并发2通过版本化管理API设置，三个Proxy配置统一后启动；数据库及旧配置另有私有备份。这不是在线改hash、清空owner或禁用fence。

两账号实测总**114.099秒**，完整保留原4成员、恰好新增2个真实Ready成员；没有第三个账号。两条新Login任务区间重叠，分别约**89.236秒、91.784秒**，均attempts=1首次成功，真实SSO/SCIM/席位/OAuth/warmup完成。此检查点为6ReadyIdle、0lease/hold，cap6、临时idleTarget6，结束重新paused1；旧4账号凭据行/库存行未变。详见[两个真实账号验证](user-pool-real-mysql-two-account-validation.md)，不以本摘要替代完整证据。

### 四把LiteLLM virtual key——通过，形成最新池状态

随后用户要求idle target恢复2并验证4leased/2idle。通过版本化API设置target2、保持cap6/paused1，经LiteLLM容器→**Proxy1直连**→共享MySQL，四把不同virtual key各一次有限请求，均HTTP200/completed，产生四个不同member的active lease及四条对应成功统计。hold/catalog hold均排空，没有新增账号或席位。

**最新记录：total6、leased4、ready_idle2、provisional0、provisioning0、failed0；idleTarget2、cap6、paused1、leaseTTL172800。** 四把测试key全部撤销，Proxy租约未手工释放，按原TTL自然过期；key撤销不等于释放租约。详见[四key排他租约验证](user-pool-real-mysql-four-key-validation.md)。最新状态不能仍写成迁移刚完成时的4idle或建号刚完成时的6idle；后续正常TTL处理也可能改变租约计数。

## 源码与验证范围

- 测试基线为`5ea75af7ac0000b37758efd751a606ea86010a00`。用户撤回100k扩展后，8个相关文件逐一与HEAD一致；运行上限一直为10000，**没有100k发布，也没有本轮生产源码改动**。
- 撤回后的完整Proxy回归438通过/0失败/25条件skip，迁移63通过/0失败/1数据库入口skip；skip不是实际MySQL通过，专项数与已有套件不重复相加。本节实导入、并发维护和真实业务结果是分别执行的证据，不由离线套件计数推断。
- 本提交收录copy-only兼容、离线并发维护等辅助工具、测试与最终客户手册；完整源码SHA以本次提交记录为准，旧基线SHA不包含这些新增文件。本次未push或发布镜像，客户现场使用前仍须核对交付版本与可取得的源码渠道。
- 本次本地功能路径实际直连Proxy1，不是负载均衡分流验收。客户拟用LiteLLM与Proxy同一Rancher集群的已有内部Kubernetes Service，优先复用而非新增NGINX；实际Service类型/selector/port/targetPort/EndpointSlice/跨节点分布仍须客户核对。本机三副本不能证明该入口或客户HA已通过。

## 当前状态与交接边界

真实SQLite备份、copy-only旧schema兼容、全新MySQL导入、3Proxy＋Console UI、运维实采、并发维护、两个真实新增账号及四key功能验证均已执行，实际通过结果如上；最初预检、目标连接及合成维护断言失败保留，未抹去或改写成首次通过。

客户数据库＋应用＋已有Service入口迁移手册见[客户迁移手册](user-pool-customer-migration-guide.md)，由主会话整合本次实际步骤、失败处置和最终审核。客户构建、实际Service/LB拓扑、MySQL/TLS、跨节点HA、告警送达及现场恢复切换仍未验收。本地MySQL已产生运行写入，**不能直接切回旧SQLite快照**；须保持维护并另行批准一致性核对/回退。原SQLite、组件卷、证书、旧账号及席位继续保留。

独立负载活动不属于本迁移通过结论：用户最新取消30分钟方案，改为全部累计最多600秒。多热点、修正版120秒stream短测及300秒持续测试均实际通过，累计482.940秒；此前stream17.176秒首次失败和18.162秒诊断失败仍保留。详见[额外负载报告](user-pool-final-load-validation.md)，不把本地功能、合成负载与客户生产环境验收混为一谈。

私有路径、账号标识、凭据与外部企业URL不写入本报告。本次文档更新没有新增真实请求、运行测试、改变VM/服务状态或执行commit/push。
