# Pool OAuth 401 后自动恢复 — 实现与验证

更新：2026-09-09。范围：当前Docker fork的 `caller-lease` 模式；不改变Direct模式，不操作真实GitHub账号。

## 行为

1. 模型目录或推理返回401时，按实际请求的hold、成员、凭据generation及旧token检查。
2. 在一个SQLite事务中条件清空该旧token/授权attempt，将成员置failed并登记 `stage=synced` 的自动修复，替换worker attempt并清除旧任务/OAuth nonce。
3. 多个同token并发401只有第一个可登记修复，旧generation/过期hold/不同token不能使新凭据失效。
4. 在途hold保留到请求排空；worker不可在旧请求仍使用成员时重新授权。
5. worker使用原SSO用户和既有席位重新执行Login，等待实际OAuth attempt回调，再做模型warmup。完成才恢复ready，不重新创建SSO/SCIM用户或重复分配席位。
6. 原失效租约沿用隔离/过期释放行为，下一次caller请求可能使用其他idle账号；当前请求不等待浏览器完成，也不换成员重放。
7. 暂停prewarming会同时暂停自动修复；恢复后继续已有任务。

这属于**被动401触发的后台重新授权**。不保存/使用expires_in或refresh token，不做预防性刷新，不保证触发401的第一次请求成功。权限/席位403、限流429及一般网络失败不触发运行期自动登录。Direct账号仍需要原有重新授权操作。

## 防登录风暴和失败边界

`user_pool_accounts`新增可重入迁移列 `reauth_count`、`reauth_window_at`，持久化每账号**从窗口起点计算的一小时固定窗口**最多3轮运行期401恢复（不是任意连续60分钟的滑动窗口）。成功warmup不会清零这个窗口内计数，避免“登录成功→立刻401→再次登录”无限循环。

- 第1–3轮允许自动调度，每轮普通失败仍递增attempts并使用现有30/60/120秒等有界退避，达到3次失败停止。
- 第4次运行期401记录 `oauth_reauth_limit_reached`，attempts=3，事件 `oauth_reauth_blocked`，不再自动派发；即使窗口过后也不会自行解除终止状态，需要人工检查/Retry。
- 待修复但正在退避的成员计入未来供给，不为每次失败反复开替代账号。
- SSO所有权不符、密码无法取得、Login派发不确定或任务挂起等已有保护仍保留，不盲目重复派发。
- warmup读取模型目录或调用模型的401退回synced并使所用token条件失效，避免反复验证同一失效凭据。模型目录401即使响应body损坏，也保留401判定。
- 取消Login任务不保证旧浏览器停止，因此cancelled任务保留原OAuth关联并进入需人工核对状态，不像明确failed那样直接重派。
- 旧的独立管理员reauthorize接口对pool成员返回409，避免与worker并行派发；Direct账号行为不变。凭据generation同时隔离成功与失败结果，旧warmup网络错误不能消耗替换token的重试预算。

## 代码位置

- [recoverUnauthorized](../src/proxy/src/userPool/store.ts)：原子失效、去重、重登录窗口及持久化队列。
- [compatible routes](../src/proxy/src/routes/compatible.ts)：推理/模型目录401接入，Direct原逻辑保留。
- [provisioner](../src/proxy/src/userPool/provisioner.ts)：复用已有OAuth授权流程和warmup401修复。
- [管理API](../src/proxy/src/routes/userPoolApi.ts)：允许展示安全的恢复事件和超限错误码。
- [恢复测试](../src/proxy/src/userPool/reauthorization.test.ts)：并发401、旧凭据、disable、ABA、hold、窗口、pause和退避。

## 验证结果

- 全workspace typecheck、deployment build通过。
- Proxy回归：**167通过，0失败，1项MySQL集成跳过**（含模型目录401/body损坏、迟到401、取消Login、独立管理员重授权拦截和旧warmup失败隔离的最终补充回归）。
- 新Proxy Docker镜像通过获批包源完成干净构建。
- 新隔离项目 `ghcp-user-pool-recovery`，Console17604，Proxy17600，不替换此前测试栈。
- Docker/mock实测总量cap=1：首次预热1个账号后，连续3轮“成功请求→401→自动重新登录→回调→warmup→再次成功”全部通过。
- **手动Retry次数0，原请求重放次数0，SSO/SCIM创建仍1次、席位分配仍1次，Login总任务数4（首次1+自动修复3）。**
- 第4轮401验证超限停止，后续新caller返回容量429且不会继续派发Login。

上游401、Login授权完成和模型输出仍来自本地fixture；SSO/Proxy/worker/SQLite/HTTP回调实际执行。不是已通过真实Github自动重新授权或生产长期运行验收。

## Mapping 和数据库开销

当前pool权威mapping位于SQLite `user_pool_leases`：`caller_id`主键查询得到 `member_identity`，再读 `proxy_accounts.identity`主键取得成员token。Direct模式直接以header identity查 `proxy_accounts`。Proxy未用Redis或内存mapping缓存作为权威状态。

SQLite是进程内本地数据库，没有每次查询的数据库网络往返，但pool请求不只做一次主键查询：还会执行状态回收、在途hold/事件写入和成功续租，better-sqlite3操作是同步的。主键映射通常不是主要耗时，但不能据此保证高QPS/P95/P99；当前测试证明功能和并发一致性，不是专门的数据库性能基准。LiteLLM的Postgres/Redis与这张账号池mapping表无关。
