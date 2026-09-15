# Azure 双 VM User Pool 持续测试报告

**日期：2026-09-14　结论：本轮规定的持续负载与故障恢复场景通过。**

这是合成账号、mock上游条件下的技术验收，不是客户生产容量、真实模型性能或Rancher节点级高可用认证。没有真实GitHub/EMU/SCIM/席位/模型调用，没有部署客户环境，没有commit/push。

## 1. 一句话结果

在一台Azure服务VM运行双Proxy及MySQL，另一台独立VM生成流量，经私网和实际HAProxy执行三个协议的JSON/SSE、取消、401修复、429冷却、租约到期，并在流量期间停止一个Proxy、暂停MySQL。**实际流量持续1942秒（32分22秒），4809个请求，0个意外错误；最终hold和catalog hold均为0，上游请求标记无重复。**

本轮只使用 **12个真实走mock预热流程的成员、6个并发工作线程**，另有一个用于自然到期的caller。**不是2000成员压力测试**；2000成员/25并发的短负载和集中到期测试见此前 [验证记录](user-pool-mysql-validation.md)。之后新增的从零建池场景、调度修复及新镜像验收见 [0→2000独立报告](user-pool-provisioning-2000-test.md)，不改变本文的历史结果。

## 2. 测试环境与版本

```text
Azure 压测VM（2vCPU / 8GiB）
  Node.js 测试发生器、SQL只读观察、受限故障控制
                  │
             同VNet私网
                  │
Azure 服务VM（8vCPU / 32GiB）
  固定fixture bridge → HAProxy → Proxy 1 / Proxy 2
                                  │
                               MySQL 8.4.11
  SSO / Login / Console / mock（同机独立容器）
```

| 项目 | 本轮配置 |
| --- | --- |
| Azure地域 | Australia East；同可用区，非跨AZ部署 |
| 服务VM | Standard_D8s_v5，8vCPU/32GiB，Ubuntu24.04 |
| 压测VM | Standard_D2s_v5，2vCPU/8GiB，Ubuntu24.04 |
| 数据盘 | 独立128GiB PremiumSSDv2，3000IOPS/125MB/s |
| Docker数据目录 | `/mnt/ghcp-test/docker` |
| 运行时 | Node22.23.2，Docker29.1.3，Compose2.40.3 |
| 每个Proxy容器上限 | 2CPU/1GiB，各10个MySQL连接 |
| MySQL容器上限 | 3CPU/3GiB |
| mock / HAProxy上限 | 1CPU/512MiB，1CPU/256MiB |
| 应用网络 | Proxy/MySQL/mock只在Docker internal网络；固定bridge私网可达 |
| 身份来源 | 本轮发生器直接发送合成caller hash和fixture服务API key |
| 网关profile | **本轮未启动LiteLLM/PostgreSQL**，其完整virtual-key HTTP链路已另测 |
| 源码 | `ghcp-user-pool-mysql`，HEAD `da76eb1`上的未提交候选 |

源码包267文件、531319字节，经15个小分块上传，两台VM均验证完整SHA-256。部署前在云端构建镜像，运行期间不并行构建或其他回归。远端5个关键生产文件hash与该轮测试时工作区匹配。

云端测试镜像：
- Proxy：`sha256:ebfed2ed8c1d18777473bc2c5c84c5951236a9c04a529b648bf4fd0714a8e46e`
- Console：`sha256:da2f7064726da54238170fd6b05bdeb0866df625ea36f3a142c5169861e801de`
- HAProxy：`sha256:694c3627658abb674c8a4d04ae9133effca81e141787920325753820b3f3ad4c`

镜像ID因云端重建而不同于本机历史镜像，不能把二者digest混称同一镜像。此前Linux初始化遇到合成SQL文件0600无法被MySQL非root用户读取，仅修正测试文件为0644并用新测试卷重建，旧失败数据保留；本轮没有修改生产逻辑或放宽运行期5秒SQL预算。

## 3. 这半小时具体测了什么

### 3.1 普通请求与三个协议

交替使用两个Proxy后端，覆盖：
- `/v1/messages`
- `/chat/completions`
- `/responses`

分别使用JSON和SSE，验证状态、canonical模型ID、返回内容、协议终止事件与统计。JSON采用很小的mock响应，不执行真实模型推理。

### 3.2 长时间SSE和客户端取消

- 注入2–20秒的成功SSE，期间持续发送stream注释，使连接和hold保持在途。
- **254次延迟SSE完整成功**，检查不是只有HTTP200，而是协议有正确终止事件且无in-band error。
- **242次主动取消**：客户端收到流式响应后主动断开，检查取消传到mock、没有把不完整推理当成功续租。
- 在基础设施故障期间，已发出HTTP200的流仍可能中断；只有落入规定故障窗口的这类失败才归为预期。

### 3.3 429冷却、不续租、不换号

共 **70次上游mock429及70次冷却期间探测**，70次绑定检查通过。

每次流程：
1. 等待该caller前一次请求的hold排空，避免把前次正常成功的迟到续租算到429上。
2. 保存lease ID、member、phase、lastSuccess和expires基线。
3. mock返回429和`Retry-After:10`。
4. 再发一个不同标记的新请求，预期在Proxy本地被`member_cooling`拒绝，不到上游。
5. 确认数据库观测时仍处于冷却期，lease/member及成功时间/到期时间未改变。
6. 遵守冷却等待后继续该caller流量。

10秒是本测试注入窗口，**不是改了产品默认值**。此前1秒窗口短于本机调度/网络延迟可能误报，该历史失败仍保留。

### 3.4 401修复既有成员

只注入 **一次401**：验证该成员按当前凭据条件失效、原成员进入重授权和warmup，再恢复ready；没有创建替代账号或重复提交原推理。

观测到原成员恢复约 **1.526秒**（mock授权速度），不能作为真实GitHub重授权时长。最终SCIM合成创建12次、Login派发/回调13次：第13次属于既有成员修复，不是新增席位。

401会使旧租约失效，后续新的请求可能重新分配；测试按**租约epoch**检查排他性，不把已合法失效或自然到期后的新lease误判为串号。

### 3.5 租约到期、排他性与持久化hold

- 设置测试正式TTL60秒；一个独立caller完成一次成功请求后停止使用，验证自然到期不是提前释放。
- 活跃caller在同一有效lease内保持member不变；合法到期/401后的新lease单独核验。
- **1926次SQL观察**检查：caller/member唯一关系、无孤儿hold、hold绝对deadline和10秒排空宽限、catalog/inference所有者一致、无孤儿成员及无意外新增成员。
- 观察到最高6个hold，最终全部排空。报告有10次自然lease转换、1次401后的转换，均满足合法epoch边界，不是同一有效租约内换号。

## 4. 故障时间线

测试任务UTC时间：**07:14:29启动，07:47:13结束**。程序报告总1963.446秒，实际流量1942秒；其余为初始化、最终核对与收尾。下表相对时间以程序开始为基准，不把命令提交等待算作业务恢复时间。

| 阶段 | 动作 | 结果 |
| --- | --- | --- |
| 初始约8秒 | 从既有mock smoke库存补齐12成员，随后target0、worker保持运行用于401修复 | 通过 |
| 初始约16秒 | 原成员401恢复完成 | 通过 |
| 约10分11秒 | 停止Proxy1约35秒，继续向LB发送流量，然后启动并等待readiness | 退出到恢复约39.111秒 |
| Proxy1离线期间 | 观察Proxy2成功处理请求 | **75次成功**，证明存活副本继续服务 |
| 约20分11秒 | 暂停MySQL进程12秒，制造已建连接不响应，再解除暂停 | 暂停到恢复约14.788秒 |
| MySQL恢复后 | 销毁/重新获取observer连接，重新核对SQL和两Proxy readiness | 通过，observer重连2次含初始连接 |
| 流量结束 | 所有caller新请求、三协议延迟SSE、上游记录去重与最终hold排空 | 全部通过 |

HAProxy没有配置推理重试/redispatch。停一个Proxy不保证其原有流无中断；MySQL暂停期间也不要求业务成功。验证目标是：**及时拒绝、不串号、不重放、恢复后能正常服务、最终清理完整**。

本轮暂停的是单个测试MySQL进程，**没有主从提升/托管数据库HA切换**；两个Proxy仍同一服务VM，没有验证整个worker节点/可用区故障。

## 5. 请求与错误结果

| 指标 | 数值 |
| --- | ---: |
| 总请求（含初始化/最终探测） | 4809 |
| 完整成功 | 4392 |
| 主动取消 | 242 |
| 预期失败请求 | 175 |
| 意外错误 | **0** |
| 另计的预期管理采样失败 | 1 |
| 报告`expectedErrors` | 176（175请求＋1管理） |

请求分类相加为4809；`expectedErrors`包含管理采样，不能直接当互斥请求数相加。

预期失败请求拆分：
- 注入上游401：1。
- 注入上游429：70。
- 冷却期间本地拒绝：70。
- Proxy退出窗口：503一次、网络/断流一次。
- MySQL暂停窗口：503共31次、网络/断流一次。

HTTP状态计数：200共4636，401共1，429共140，503共32。HTTP200包括之后被主动取消或断流的请求，因此不能把4636写成完整成功次数。

最终数据核验：
- 12合成成员、6当前租约、hold0、catalog hold0。
- 4809已发client marker；4707唯一上游marker，其余102因本地拒绝/故障未到上游。
- 所有应到达上游的成功/注入请求均有对应记录；冷却拒绝等不应转发的标记没有上游记录。
- 没有重复client marker、同一有效lease跨member变化或无授权新账号；原始mock记录未因超出保留上限而丢失。
- 故障cleanup确认Proxy已恢复、MySQL未处于paused。

## 6. 延迟与资源观察

### 正常窗口JSON延迟

| 协议 | 样本 | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| Messages | 890 | 16.15ms | 22.57ms | 26.18ms |
| Chat Completions | 903 | 16.28ms | 22.10ms | 26.09ms |
| Responses | 870 | 16.29ms | 22.79ms | 26.44ms |

这些是独立发生器至私网fixture的极小mock响应，不含真实模型计算，不据此承诺客户请求延迟。SSE混入人为2–20秒延迟，P95约14–16秒、P99约20秒是预设负载特征，不应拿它判断真实模型速度。平均请求数也受客户端节奏、长流和主动等待影响，**本轮不测最大QPS**。

### 34次资源采样的最高观察值

| 容器 | CPU采样最高值 | 内存采样最高值（约） |
| --- | ---: | ---: |
| Proxy1 | 15.07% | 74.2MiB |
| Proxy2 | 10.61% | 74.3MiB |
| MySQL | 8.99% | 571.3MiB |
| mock | 9.76% | 62.3MiB |
| HAProxy | 0.26% | 12.4MiB |

CPU是Docker stats口径，100%约等于一个逻辑CPU，不是整台8核VM的百分比。每约60秒采样，不是连续峰值捕获，可能漏掉短峰。

正常首末样本内存变化：Proxy1约+18.1MiB，Proxy2约-3.6MiB，MySQL约+70.3MiB，mock约+24.3MiB；mock有意保留本轮请求记录。测试后再次观察两个Proxy各11个进程/线程计数、MySQL连接17/历史最高21。不能凭单轮和粗采样断言不存在内存泄漏，但本轮未出现本机曾见的窗口外SQL超时/503持续失败。

## 7. 与本机失败怎样比较

云端通过支持“本机资源/运行环境干扰对旧失败有影响”，但不是严格单变量实验：

- Windows Docker Desktop换成原生Linux Docker。
- 发生器与服务从同机变为两VM。
- 数据盘、CPU资源、网络路径不同。
- Node从本机24版本换成22.23.2。
- 本轮未运行LiteLLM/PostgreSQL网关profile；该链路此前已独立通过。
- 镜像在云端重新构建，5个关键生产源码hash与该轮测试时工作区一致。

因此不能宣布“旧失败全部是电脑造成”，也不能删除本机失败记录。准确结论是：**该轮记录的候选在明确记录的Azure分机环境，通过了本次完整规定场景。**

## 8. 没测什么

- 真实GitHub/EMU、付费席位、真实OAuth浏览器流程或真实模型容量。
- Azure上2000成员/更高并发最大容量及多小时/多天内存趋势。
- Rancher ClusterIP Service、Pod跨节点、整节点失联或NGINX入口冗余。
- Azure MySQL Flexible Server/主库HA提升、跨AZ故障、备份灾备恢复。
- 客户真实数据副本迁移与正式维护窗口。
- 本轮没有经过LiteLLM实际key认证入口；它来自此前独立完整网关测试，不把证据混称为同一轮。

## 9. 证据与交付状态

完整报告保留在压测VM `/opt/ghcp-test/results/cloud-soak-report.json`，原始日志为同目录`cloud-soak-30m.log`。报告SHA-256：

```text
6b5fc91c3c88950fe8eb677c47a89d9285ef9d6056e7a2db966f52b27bb6059b
```

本地私有管理记录另保存VM执行开始/结束、exit0、摘要、生产hash和镜像ID。公开文档不含SSH私钥、订阅/公网IP或客户标识。

测试已结束，资源保持运行以保留环境；已配置2026-09-16 02:53:37 UTC自动释放VM计算，磁盘/IP/证据不自动删除且可能继续计费。源码和文档未commit/push。部署背景见 [Azure环境说明](user-pool-azure-test-environment.md)，历史记录见 [MySQL验证](user-pool-mysql-validation.md)，客户入口方案见 [Rancher待办](user-pool-rancher-ha-todo.md)。
