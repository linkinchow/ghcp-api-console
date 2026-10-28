# ownerSideEffects 测试的确定性修正

日期：2026-10-27。对象：`src/proxy/src/userPool/ownerSideEffects.test.ts`（[owner专项](user-pool-owner-side-effects.md)的契约测试）。r3 发布资格测试（`f43f27e`，Node 24，Windows，Docker Desktop 中的一次性 MySQL 8.4）里，该文件 8 次单独运行只有 1 次 22/22，其余 20–21/22，每次失败的是不同的 owner 交接用例，例如期望 `oauth-wait` 实际仍为 `oauth-starting`、期望 `ready` 实际仍为 `provisioning`（见 `release/multi-r3` 分支上的 `docs/multi-enterprise-release-validation.md` 第 7 节）。

本次只改测试，没有改产品代码。断言没有删除或放宽。

## 根因

### 1. 数据库时钟不单调，测试假设“每次 tick 都会推进一步”

worker 只调度 `retry_at <= 数据库当前时间` 的账户。每步成功后写 `retry_at = 数据库 now`（无进展时再加 `pollMs`）。测试原来连续调用 `tick()`，并假设每次都正好执行一步。

在本机实测：60 秒内每约 16 ms 读取一次 `UTC_TIMESTAMP(3)`，Docker Desktop 虚拟机时钟发生了一次约 **392 ms 的回拨**（45 个连续样本小于此前最大值），数据库时间与宿主单调时钟的差值波动 530 ms。回拨发生在某步写完 `retry_at` 之后时，这个账户在几百毫秒内都不到期，紧接着的 tick 选不到它，什么也不做。于是会出现三种失败：

- 准备／收尾循环（最多 6 次 tick）停在 `synced`、`scim-synced`、`oauth-starting`；
- 单次 tick 后断言 `warmup`／`ready`，实际仍是上一阶段；
- 旧 owner 那次被扣住的 tick 选不到账户，屏障永远不进入，报 `Owner-side-effect barrier did not settle`；后继 owner 的恢复 tick 没有发出任何 GET（`0 !== 1`）。

修正前加诊断复现到的一次：旧 worker 第一次 tick 后账户为 `sso-created`，`retry_at` 比 tick 结束后读到的数据库时间晚 454 ms；两次读数之间宿主单调时钟走了 593 ms，数据库时间只走了 65 ms。

同一回拨还会影响 `expire()`：原来把 `owner_until` 设为“数据库 now − 1 ms”，回拨后旧 owner 的租约会短暂重新有效，`renewOwner(ownerA)` 可能成功。这次运行中没有观察到，但属于同一根因，一并修正。

### 2. 测试把步骤截止时间设成了允许的最小值 5 秒

测试配置 `requestTimeoutMs: 5000`。它同时是 `realProvisioner` 的步骤截止时间（`stepTimeoutMs`）。主机负载高时，单步（多次 MySQL 事务加 mock HTTP）可能超过 5 秒，结果是 `provision_timeout`、`attempts=1`、30 秒退避，后续步骤在等待窗口内都不再到期。负载测试中加了诊断后直接看到：`{"stage":"oauth-starting","state":"failed","attempts":1,"last_error":"provision_timeout","retry_at":…（比数据库 now 晚约 9 秒）}`。生产默认值是 120000（`config.ts`），`mysqlAdmission.integration.test.ts` 也用 120000。

## 修正

| 修改 | 说明 |
| --- | --- |
| `stepOnce(worker)` | 反复 tick，直到 worker 真的调用了一次适配器 step（以 `service.steps` 计数为准），并断言正好一次。未启动任何 step 的 tick 不改动账户，只是重试。“最多 6 步到达某阶段”的上界、恢复只发 GET 的请求数等断言保持不变；超时时报告账户的 stage/state/last_error/retry_at 和数据库时间 |
| 旧 owner 被扣住的那次 tick | 循环 `old.tick()`，直到 step 进入屏障；只有“未启动 step 就结束”的 tick 会重来，并断言这种 tick 没有执行 step、没有 mock 错误 |
| `expire()` | `owner_until` 设为数据库 now − 60 秒（SQLite 同样），时钟回拨不能让旧租约复活 |
| `requestTimeoutMs` | 5000 → 120000（生产默认）。MySQL 单事务截止时间由 `MysqlDeadline` 固定封顶 5 秒，不受影响 |
| 挂起保护 | `bounded` 8 → 60 秒，单测 30 → 300 秒；它们只在真的挂起时触发，正常路径都等待事件或已存储状态 |

不需要“到期”才执行的检查（失败／待人工核对的账户不会自动重试）仍用单次 tick，因为那里的期望正是“tick 后没有变化”。

### 产品代码

没有发现需要修改的缺陷。调度、租约统一使用数据库时间，这是多副本一致性所需。数据库时钟回拨只会让刚推进的账户晚几百毫秒被调度，或让租约接管晚相同的时间；本地任期还有单调时钟 30 秒的独立上限。这是延迟，不是正确性问题。

## 验证

环境：Windows 11，Node v24.22.1，Docker Desktop 中自建的一次性 `mysql:8.4` 容器（只绑定 127.0.0.1，合成 root 密码，每个用例使用随机 `ghcp_pool_test_*` 库）。外部服务全部为测试内 mock，没有访问真实 GitHub、Copilot 或模型。

| 项目 | 结果 |
| --- | --- |
| 修正前基线（同一环境） | 8 次（后 4 次带只记录不改行为的临时诊断）：20、21、21、22、22、22、21、22/22，4 次有失败 |
| 故障注入 A：MySQL store 的 `now()` 加 400 ms（等效每步后时钟回拨） | 原测试 12/22（10 条失败，类型与发布记录相同）；修正后 22/22 |
| 故障注入 B：第一次 `synced` 步骤延迟 6 秒 | 旧 5 秒配置 16/22（6 条 login 用例失败）；修正后 22/22 |
| 中间版本（仅修正 1） | 连续 12 次全部 22/22；与完整单元套件并行 5 轮，4 轮 22/22，1 轮 21/22（即根因 2，促成第二项修正） |
| 最终版本连续运行 | 连续 12 次全部 22/22（每次约 85–98 秒） |
| 最终版本负载运行（同时循环运行完整 Proxy 单元套件） | 5 轮全部 22/22（169–243 秒）；同时运行的 18 次单元套件中 17 次 641 pass/0 fail/40 skip（skip 为 MySQL 条件用例），1 次另一文件的 `migration RELEASE_LOCK timeout destroys without recycling` 失败，与本测试无关 |
| rebase 到最新 `fork/main`（含 r3）后负载复核 | 22/22（170 秒）；同时运行的 3 次单元套件均 642 pass/0 fail/40 skip |
| `tsc --noEmit`（proxy） | 通过 |

两组故障注入只用于测试的临时副本，验证后已删除，没有提交。

## 覆盖边界

- 仍是同一进程内两个真实 worker 对同一测试库的确定性契约，不是两个 OS 进程或 Pod。
- 只在 Docker Desktop + Windows 上测得时钟回拨；托管 MySQL 的时钟行为未测。
- 在两条单元套件循环同时运行的过载条件下，单元套件自身也有 2–3 条计时相关用例失败，那些是其他文件，不在本次范围内。
