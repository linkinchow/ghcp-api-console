# 多企业最终版本专项验收

基线：`9cbdae111f524a552ee607df4900e5c96189b16d`。开始日期：2026-09-20。

**状态：本轮专项测试已执行完成，最终修复/夹具复测通过；不代表所有组合场景或客户生产上线已验收。** 用户批准补充测试，并允许按需启动指定Azure资源组两台VM。只使用新的隔离目录、项目、容器、数据库、合成凭据和mock；未接触真实GitHub/客户环境，未自动commit/push。

## 目标和执行分工

1. 最终版本完整1→2→3→Proxy4、实际备份/第二实例恢复、迁移后应用和追加企业保真。
2. 真实MySQL名字目录不兼容拒绝/无写入与正常边界；补多企业cap总和竞争和100profile有界功能场景。
3. 实际Login、SSO及Proxy owner进程在工作未完成时被终止并重启，检查未知结果保护、无重放和企业隔离。
4. 两个真实浏览器管理员上下文对真实Console/API执行竞争、切换企业和失效会话测试。

三个实施agent各自拥有迁移、进程/并发、浏览器文件；主会话独占Azure和真实数据库执行。测试代码修复与生产修复分开记录，失败现场保留，最终按实际PASS/FAIL/SKIP记录。

## 固定边界

- 用户授权的隔离 Azure 测试资源组；具体资源标识不公开。
- services VM检查时运行，load VM检查时deallocated，用户授权启动load。公司定时关机策略不修改。
- 原阶段A/B/M/p6的容器与数据保持不动，只读取验证过的源码/旧初始化代码和缓存镜像。
- 新夹具run：`20260920m`用于迁移/恢复；`20260920b1/b2/b3`分别用于进程故障；`20260920c`用于Console写操作，避免共享状态污染。
- 每个进程故障批次有硬时限，不执行长时间压力测试；100企业场景为有界功能验证，不证明生产吞吐。
- 真实GitHub设备流/联邦登录及客户实际数据库/部署预检仍需另行环境与授权，本轮不冒充覆盖。

## 当前已核对的问题

原`tests/enterprise-phase5/registration.ts`测试fixture使用非目录名字配ordinal0，与最终名字门禁冲突。本轮已只修正合成fixture，不放宽运行门禁或篡改客户数据。

## 实测发现与修正

- 合成设备流新增7项定向测试首次4通过/3失败：设备码有效期起点错误（浏览器完成后才计时）、睡眠/响应跨过期后仍可接受token，以及null token响应暴露TypeError。固定devicecode接收时的绝对截止时间，等待前后/读取body后检查；格式不合法返回受控错误。未调用真实GitHub。修复后7/7通过、完整Login41/41通过、Login类型检查通过。
- 原registration self-test在基线实际退出1，安全错误输出保留。修正只改合成ordinal0名字，独立SQLite self-test与本轮实库均通过。
- 已启动load后两VM都出现deallocated，判断为既有定时关机影响；重新只读确认后按授权启动。尚未开始本轮DB/进程故障测试，不计作故障通过。

## 构建与本地验证

- 主候选源码：HEAD9cbdae1＋未提交修复/测试，430个源码文件内容映射SHA256 `9c5acc7d973a1cef970e4f2385fbaed2986aaef1a7623cf0eeb95001ef7b6847`。后续只读挂载的测试增量另保留hash receipt，不把HEAD单独当作实际源码。
- Azure tooling与正常Login构建实际通过。初始tooling image ID `sha256:fe6d03bc3a82d04fc943c4d2114bd5e0d649c5cb99a2638f9a2f185ed32f29a7`；补齐迁移测试文件后的tooling为`sha256:a3f6d006c8c5aa5a718a12b585f2757efedd024cfc40506b8ac4f7b729137193`，生产源码没有因此变化；正常Login `sha256:92b820caf1d32616fb5aeee006a7baba2516df2ba4233d2bc4d550a8a874c19a`。Proxy/SSO/Console生产源码未变，按已核验hash复用第六阶段对应image ID，不重命名冒称新构建。
- 五组新fixture准备成功；迁移夹具另有独立restore MySQL，其他夹具各自新MySQL与SQLite、合成凭据、paused/draft初始化。加入独立`20260920d`用于inflight，避免污染崩溃场景。
- 主会话新测试本地批次28项：25通过、3未授权实库/旧source门禁跳过；provider/控制器/浏览器安全门禁批次27通过。批次相互重叠，不叠加当作独立业务场景。所有真实DB/browser/process结果以下单列。
- Console启动器复核后增加精确持久owned ID核对，不能仅用可复制的名字/标签；纯回归9/9通过。原有证据保留。

## 实际结果

- 真实MySQL并发组：7/7通过，0跳过；包含跨企业cap合计边界、同policy CAS、cap/drain/owner登记竞争和全局Login名额。
- 真实MySQL100profile存储功能组：4/4通过，0跳过；只登记100个合成数据库库存，不调用SCIM、不等于100企业真实外部服务/吞吐验收。
- 首轮迁移seed在发出子命令前因主打包清单漏新integration文件被阻止；私有目录为空、无子命令/DB写入，保留目录和日志后补齐文件重建tooling。不是生产迁移失败。
- B1/C首轮app-up因新源码目录复制时umask077让公开haproxy.cfg成为0600，非root HAProxy无法读而退出；其他实际服务健康。仅将本轮公开配置文件改0644，Secret权限未变，精确同ID重启LB；保留原失败。

- 最终版本公开迁移链seed/1→2→3→4/verify全部实际通过；各阶段真实dump，第二独立MySQL恢复和restore-verify通过，复制18个配套文件，receipt/marker未改写。
- 名字目录真实MySQL9/9通过、0跳过，覆盖旧高ordinal拒绝且无写入、歧义cursor、合法前缀/新目录、实际并发startup/reserve快照。
- 最终追加企业资格实际通过（MySQL＋SSO/Login SQLite），保留原cap、账号/凭据bytes、lease/密码hash和历史，外部provider调用0。迁移后应用只读冒烟7/7、28HTTP通过；不是旧特殊字节token真实推理测试。
- 真实Login进程accepted-task故障：12.023秒PASS；精确同ID重启、原task/nonce/authority收尾、无重复授权、健康B租约继续。
- 实际SSO进程＋mock SCIM已提交/本地未完成故障：12.470秒PASS；重启保留持久unknown fence，拒绝重复副作用，B业务继续。
- 双管理员真实Chromium/Console/API：11场景、254断言PASS（7.883秒）；真实cap/CAS/总和冲突、A→B→A迟到请求、删除重建incarnation拒绝、同源和失效cookie，无伪造业务响应。只调用2次内部合成SCIM查询，无provider修改/真实外部请求。
- owner终止场景b3首轮FAIL：终止后立即经无重试HAProxy发送请求得到503，原容器已恢复、池已暂停。mock provider两企业该请求marker均0，说明请求未到上游，符合LB尚未移除死backend的探测窗口；原请求未重放。改为新b4夹具先验证存活副本继续处理，再GET-only观察LB连续至少5秒/20次健康，随后发送一个新marker请求；不宣称零中断，不修改生产LB重试规则。

- 100profile混合健康专项真实MySQL1/1通过、0跳过：readiness/capacity是注入式延迟/失败，实际100企业policy、实际库存登记与准入；健康尾部企业获得2个成员并服务2个caller，无HTTP/SCIM。证明有界扫描推进与存储组合，不等同100个真实企业外部系统。

- d/b4新夹具在创建网络前被Docker默认地址池耗尽阻止，没有数据库初始化/故障注入。核对现有Docker网段与host路由后，只为本轮缺失网络显式创建不重叠`10.240.71–75.0/24`子网并附精确标签；应用网络仍internal，数据库只host loopback，未删旧网络、未改daemon地址池/Azure NSG。

- 原mysql-up要求全新网络，恢复时因已创建本轮网络而正常拒绝`network_exists`。主执行者检查精确run标签、网络internal属性、无项目容器/旧数据卷、端口空闲后，仅为两个run创建新MySQL并记录真实ID，后续继续原`start-owned`、实际peer/schema门禁。未更改通用安全门禁，未接管历史资源。

## 尚未覆盖的范围

- 没有真实GitHub或同事/客户企业访问：所有SCIM、席位、OAuth授权和推理上游均为隔离mock。真实Login服务指实际queue/runner/SQLite，授权策略仍为test-only替代。
- 未取得客户实际数据库/配置备份，未执行客户Kubernetes ConfigMap/Secret、生产TLS、MySQL HA切换或实际LB验收。
- 本轮没有完整证书/Secret轮换过期矩阵，也没有“Proxy callback已经提交但ACK丢失时杀Login”的独立进程用例；已有受控回调未知/取消覆盖不能扩写成该用例。
- 100profile验证是实际MySQL数据＋注入式readiness的有界功能测试，不是100个真实GitHub企业的全栈或吞吐承诺。
- Inflight场景延迟在响应头之前，即使请求`stream=true`也不能称为半途SSE断流、慢读者或背压测试。
- 迁移后旧special-byte token验证保真和只读业务状态，不声称能发送为真实HTTP授权token；迁移后原账号的真实外部重新登录/续期仍未验收。

以上测试减少了已识别的盲区，不等于全部组合和生产环境已覆盖。

## 最终收口结果

| 专项 | 最终实际结果 |
| --- | --- |
| 公开迁移链、真实dump/第二实例restore、登记 | 全部通过；迁移后只读7/7、28HTTP |
| 名字门禁真实MySQL | 9/9，0跳过 |
| 真实MySQL并发 | 7/7，0跳过 |
| 100profile存储功能 | 4/4，0跳过 |
| 100profile混合健康/健康尾部准入 | 1/1，0跳过；readiness注入，存储实际MySQL |
| 实际Login进程终止/重启＋mock授权 | PASS，12.023秒 |
| 实际SSO进程终止/重启＋mock SCIM已提交 | PASS，12.470秒 |
| 实际Proxy owner终止＋A/B任务进行中 | b4 PASS，42.636秒；原b3失败保留 |
| 两管理员真实浏览器/Console/API | 11场景、254断言PASS，7.883秒 |
| 在途SSE＋drain＋B业务继续＋A401不重放 | 3/3 PASS，11.825秒、72HTTP |

owner b4：终止proxy-3后存活proxy-1单次请求成功，持久owner记录改变，原task/nonce/authority及副作用次数核对通过；LB只读观察32次，其中4次失败，然后连续21次健康跨5.083秒，整个收敛观察10.871秒。之后一个**新marker**LB推理单次成功，无失败POST重放，`zeroDowntimeClaimed=false`。

Inflight：A实际`stream=true`请求在响应头前延迟8秒，期间drain A和release返回409，B在A结束前完成；A的SSE随后完整成功，之后A的401只使A凭据失效且上游请求计数1，B仍成功。按设计暂停自动repair，避免把正常修复授权与请求重放混淆。

本轮唯一生产代码修改是`src/login/src/auth/deviceFlow.ts`的设备码截止时间与响应形状处理；完整Login41/41通过、类型检查通过。其余为测试夹具、受控runner和文档；真实设备流仍未执行。初始失败、编排失败、测试修正和最终通过分开保存，没有用重跑覆盖旧报告。
## 资源与交付收尾

七个本轮项目共**71个容器已全部停止**，每run running列表为空；容器、卷、实际备份和失败证据保留。历史项目未删除或修改，未执行prune。两台VM按授权启动并经历一次自动关机后重启；实际应用/数据库资格运行在services VM，load VM完成只读盘点，未把它启动当作跨VM压力测试证据。既有公司关机策略保持不变。

当前28个文件未提交，只有`src/login/src/auth/deviceFlow.ts`为生产代码修改，其余为测试/报告；没有把私有日志、数据库、密钥或ZIP纳入源码。基线提交仍为9cbdae1，未自动commit/push/合并main。最终类型检查、Login41测试、控制器/断言18测试、diff whitespace和文档链接检查通过。

每项以真实退出状态和保留JSON报告为准，不以测试脚本存在或Azure RunCommand调用成功当作通过。
