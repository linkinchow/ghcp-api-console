# User Pool 从 SQLite 离线迁移到 MySQL 8

本工具迁移的是 **caller-lease 账号池数据**，不同于用于旧 direct 模式的 `upgrade/sqlite-to-mysql`。工具不会请求 GitHub、SSO、SCIM、Login、席位或模型接口。迁移需要维护窗口、一致的离线备份，以及专用的空 MySQL 8／InnoDB 数据库；不支持零停机迁移。

**状态（2026-09-14）：审查发现的问题已修复，隔离回归已通过。** [生产审查与修复记录](../../docs/user-pool-mysql-production-review.md)保留了原始失败及修复过程。该状态记录对应当时尚未发布的候选版本；客户备份演练、资源／SLO及基础设施验收是独立事项。本文不构成访问生产环境的授权。

## 执行前准备

1. 暂停账号池预热，停止接收新流量，排空所有推理／目录请求及已派发的开通／Login操作。对创建、SCIM、席位和OAuth结果不明的任务，按运维核对流程处理；不要只为通过校验而清除安全字段。
2. 停止所有旧Proxy写入进程及其调度器，也停止可能通过回调修改源数据的Login写入端。本工具不得改动原部署、凭据、证书、SSO／Login／Console卷和原SQLite文件。
3. 生成一致的**独立备份副本**，不能只复制仍在运行且有未合并WAL的SQLite主文件。工具要求回滚日志格式的备份，且不存在`-wal`、`-shm`或`-journal`伴随文件。若备份仍为WAL模式，应离线生成另一份独立副本，或确认一致性后，仅对可丢弃的备份副本设置`journal_mode=DELETE`。迁移时绝不能对运行中的数据库或原数据库执行该转换。
4. 停止所有连接目标库的服务。准备专用空MySQL 8数据库，以及具备建表、DML、校验和执行命名锁操作所需权限的迁移账号。验收完成前，不开放目标流量。注入的测试连接池至少需要**三条连接**：导入器在整个表结构初始化期间会持续占用一条连接。

## 命令

从仓库根目录执行，根目录脚本会调用相应的`tsx`文件：

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite --dry-run
```

预检（dry-run）**只检查源数据**：不连接MySQL、不加载环境文件、不写表结构，也不检查目标库。它校验完整源快照、完整性、关联关系、字段值及维护状态，仅输出各表记录数。

通过安全的环境注入机制提供`MYSQL_URL`。工具不会加载`.env`文件，并明确拒绝`--mysql-url`参数及所有URL查询参数。不要把凭据放入命令参数或日志。

执行写入时，还需提供目标部署的`POOL_WARMUP_MODEL`及账号池不变量环境配置（`PROVISIONAL_LEASE_TTL_SECONDS`、`PREWARM_POLL_SECONDS`、`PREWARM_CONCURRENCY`、`POOL_EXHAUSTED_RETRY_AFTER_SECONDS`、`POOL_REQUEST_TIMEOUT_SECONDS`及新增的运行时池配置）。默认值遵循正常的`readPoolConfig`。备份提供域名及可变的空闲目标／容量／租约配置；显式指定不同域名会被拒绝。`MysqlPoolStore.initialize()`根据实际部署选项初始化配置指纹，不使用占位模型，也不会发起预热请求。后续所有Proxy必须使用相同的不变量配置。编程接口接受明确的`poolConfig: PoolConfig`，以及可选、由调用者持有的`pool: mysql2.Pool`；注入的连接池访问远程目标时必须验证TLS，并且至少有三条连接。`MYSQL_CONNECTION_LIMIT`配置工具内置连接池，范围3～100，默认3。

TLS环境变量沿用现有名称和模式：

- `MYSQL_SSL_MODE=disabled`：仅允许`localhost`、`127.0.0.1`或`::1`。
- `MYSQL_SSL_MODE=required`：加密但不验证证书；也仅允许上述回环地址。
- `MYSQL_SSL_MODE=verify-ca`：要求`MYSQL_SSL_CA_PATH`，验证证书信任及**主机身份**。非本机地址必须使用此模式，且默认使用此模式；回环地址默认`disabled`。

然后明确确认以下两个维护条件：

```sh
npm run upgrade:user-pool-mysql -- --sqlite /safe/offline/backup.sqlite \
  --confirm-offline-source --confirm-empty-target
```

执行写入必须同时提供这两个标志。它们是操作者的确认声明，不会自动保证外部服务已经停止。

## 校验与数据保留

支持的输入是当前账号池表结构，包括OAuth恢复字段及caller／lease统计列。未知表、视图、触发器名称、关键列缺失或多余、生成列，以及不兼容的SQLite列类型都会被拒绝。**允许保留凭据隔离触发器的前提是其SQLite定义符合标准，不能只检查名称。** 旧版或自定义结构需要单独审查升级；导入器绝不升级或修改源库。任意SQLite索引和表结构迁移历史不会直接复制，MySQL会创建自己的索引与迁移历史。

预检使用只读连接并设置`query_only`，在同一个读事务中读取表结构、执行`integrity_check`和`foreign_key_check`、读取所有数据表，并显式校验关联关系和字段值。以下情况会被拒绝：

- 源池未暂停，调度owner尚未到期，存在任何推理／目录hold（**即使已过期**），或存在身份初始化占用记录。
- 存在开通中的成员、刷新中的账号、未结束的账号OAuth回调、未知状态／阶段、操作意图阶段，或结果不明／未确认的外部操作。
- failed／disabled成员仍有未结束的Login任务证据。只有在成员已完成验证、状态为`ready`／`cooling`、阶段为`ready`、账号凭据有效且无待处理回调，并且历史task和OAuth ID同时存在时，才接受并保留这些ID。这依据的是worker持久化的开通完成检查点，不是向外部Login服务查询所得的状态。
- caller哈希非法、关联记录缺失、分配键重复、时间戳不安全／带小数／为负、租约期限不一致、姓名序号／域名／设置无效，或ISO时间格式错误／不规范。

复制内容包括：全部Proxy账号和OAuth凭据；含caller／lease归属的请求统计；设置版本、域名、容量、租约时长和下一个序号；成员库存的generation、恢复计数／窗口、错误、重试／验证／冷却时间及已结束的关联字段；租约；目录冷却；事件ID及内容。统计／事件中引用已不存在租约的历史字段仍视为历史引用，不要求当前租约表中存在对应记录。

有效租约保留原到期时间。已过期的租约与冷却记录也原样复制，后续由正常运行逻辑回收；迁移不会续租或执行回收。只有账号时间字段及统计的`requested_at`会从规范UTC ISO字符串转换为MySQL `DATETIME(3)`。所有账号池毫秒时间戳及SSO创建标记保持不变。目标owner被清除，owner期限置零，并强制暂停预热。

## 目标原子性与失败处理

从首次检查目标为空开始，直到初始化、复制、校验及提交／回滚结束，导入器一直持有目标命名锁。只接受空应用表，以及已知MySQL迁移历史和由`MysqlPoolStore.initialize()`生成、尚未使用、未暂停且配置匹配的单例设置种子。非空的部分表结构会在**执行迁移前**被拒绝；不含caller／lease列的空基础统计表可以初始化。未知表、视图、触发器元数据、迁移历史、生成列和非InnoDB表均被拒绝。启动与导入器共用的结构校验会检查受支持的列类型、可空性、默认值、必须的二进制排序规则、完整主键／唯一键、外键行为、查询索引、CHECK条件及标准凭据隔离触发器定义。存在迁移标记后发现隔离机制被修改或缺失，会直接拒绝，不自动修复。已知历史TEXT token排序规则升级仅允许在对应迁移标记出现前执行；其他自定义结构需要单独审查迁移。

表结构初始化调用基础MySQL迁移和`MysqlPoolStore(pool, config).initialize()`。MySQL DDL和初始settings种子**不与数据导入处于同一个事务**，因此失败后可能保留。全部导入DML使用一个可串行化事务：先锁settings，再对所有表做加锁空库检查、复制及读回校验。提交前在内部比对所有字段值（包括token）、记录数及关键关联。不会输出凭据、caller值、源路径、URL或驱动错误。绝不把导入数据合并进已有目标数据。

事务失败会回滚导入的数据，但表结构／种子可能保留。COMMIT异常返回`commit_outcome_unknown`并销毁连接，**不会尝试回滚或重试**。回滚异常返回`rollback_unconfirmed`。出现任一情况，**不要盲目重试，也不要恢复任意一侧部署**；先在维护状态下私下检查目标。工具不会自动重试写入。非空目标会阻止重跑，即使上次成功迁移的是空源库也一样，因为settings已持久化为暂停状态。释放命名锁失败时销毁连接，不将其放回池中。

## 切换与回退

首先只启动**一个**MySQL Proxy，预热继续暂停。按已授权验收步骤私下核对库存数、凭据／租约、就绪状态、路由和期限行为。确认共享配置与迁移后的域名／settings一致，再明确恢复预热／流量，通过验收后才增加Proxy副本。绝不能同时从旧SQLite和MySQL两侧承接流量。

只有目标**尚未产生任何导入后的运行时写入**时，才可回到保留的源库；仅仅“公共流量尚未开放”并不足够。启动统计裁剪、调度和回收也属于写入。一旦发生此类MySQL写入，就不能在没有另行安排一致性核对和维护的情况下切回旧SQLite快照。原SSO／Login／Console卷和证书保留。

每个Proxy启动前都应明确设置并核对相同的`REQUEST_STATS_PER_ACCOUNT_LIMIT`，需要时独立归档历史。默认每账号只保留两条记录；运行时裁剪可能删除导入器已正确保留的统计。启动会先校验账号池配置，再裁剪统计或启动worker；被拒绝的配置不会先裁剪历史，但有效配置启动仍会执行保留策略。

编程接口`poolConfig`中可选并发值会在生成指纹前进行默认值归一化和校验，与`readPoolConfig`一致。使用实际解析器的切换路径有集成测试覆盖。由完整运行时解析器生成的既有指纹保持不变；早期开发夹具因省略字段而生成的指纹不会被静默改写。应先离线演练，不要改持久化哈希绕过不匹配。

## 测试

```sh
npx tsc -p upgrade/user-pool-mysql/tsconfig.json
npx tsx --test upgrade/user-pool-mysql/migrate.test.ts
```

默认测试仅使用操作系统临时目录中生成的合成SQLite夹具，不读取部署`.env`、`.local-sso`、旧数据库或数据卷。仅当同时提供`RUN_USER_POOL_MIGRATION_MYSQL_TESTS=1`和`USER_POOL_MIGRATION_TEST_MYSQL_URL`时，才执行MySQL测试；测试绝不使用`MYSQL_URL`。

集成URL必须指向回环地址、名为`user_pool_migration_test`的数据库，且MySQL 8实例必须是在本机独立准备的**可丢弃测试实例**。测试只创建并删除带唯一后缀的数据库（`user_pool_migration_test_<uuid>`），需要创建／删除数据库权限。覆盖源端只读预检、竞争导入器、凭据／时间戳／租约／恢复字段精确保留，以及合成token不匹配时的回滚。不要对已有部署启用测试，也不要使用真实凭据。集成执行与默认离线套件分开，需要实际MySQL连接池实现。
