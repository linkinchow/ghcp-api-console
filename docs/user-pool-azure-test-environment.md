# Azure 隔离测试环境（2026-09-14）

## 已创建的测试基础设施

所有资源在用户指定的独立资源组内新建，没有复用其他资源组的VNet、磁盘、网卡、身份或其他测试依赖。本文件不包含订阅、真实公网IP、SSH私钥或客户命名空间；具体连接信息仅保存在本地忽略目录的接续记录中。

| 用途 | 配置 |
| --- | --- |
| 服务VM | Ubuntu24.04 x64，Standard_D8s_v5，8vCPU/32GiB |
| 压测VM | Ubuntu24.04 x64，Standard_D2s_v5，2vCPU/8GiB |
| 区域/可用区 | Australia East，可用区1；这是隔离性能测试，不是跨AZ高可用部署 |
| OS磁盘 | 各128GiB Premium SSD |
| 服务数据盘 | 独立128GiB Premium SSD v2，3000IOPS、125MB/s、无host caching |
| 私网 | 新VNet和子网，两个静态私网地址，新NSG/NIC |
| SSH | 专用ed25519密钥，禁止密码登录，公网仅允许批准的来源IPv4/32访问22 |
| 应用端口 | 不允许公网访问；测试服务端口仅对压测VM私网地址开放 |
| 工具 | Docker29.1.3、Compose2.40.3、Node22.23.2、Python3、sysstat/iotop等 |

服务数据盘经过空盘签名/容量检查后格式化并挂载到`/mnt/ghcp-test`，Docker data-root在该盘上。两台VM的cloud-init完成，Docker及到期timer active；压测VM到服务VM的私网SSH握手通过。

本机到两台公网IP的直接SSH握手被重置，VM内部SSH socket及私网链路正常，来源/路径原因尚未确认。未扩大公网来源或通过另开服务绕过；本轮初始化和核验通过Azure VM Agent Run Command完成，该管理路径可用。

## 费用和生命周期

创建时Australia East公开Linux按需计算价格：D8s_v5每小时US$0.48，D2s_v5每小时US$0.12，合计US$0.60/小时、48小时计算约US$28.80，另计磁盘、公网IP和可能的流量。实际计费取决于订阅价格，不是费用硬上限。

每台VM有新system-assigned identity，Virtual Machine Contributor仅作用于该VM本身，用于自动deallocate，不拥有资源组/订阅权限。已验证身份可访问本VM的ARM资源。systemd绝对定时器已设置 **2026-09-16 02:53:37 UTC** 请求释放本机计算；失败会重试。尚未实际执行deallocate以免打断准备。定时任务运行仍依赖VM/网络健康，不等价于Azure成本硬限额。

到期保留磁盘、网卡、公网IP和证据；这些资源可能继续收费。删除需用户明确授权，不因到期自动删库或删整个资源组。

## 验证范围

本轮已完成源码白名单打包、双VM分块上传及SHA-256验证（267文件，531319字节），在服务VM构建四个应用镜像，在压测VM安装相同测试代码。npm只用批准源。本机Docker Desktop保持关闭，不建AKS/托管MySQL，不调用真实GitHub/EMU/席位/模型。

存储账户用于传输的尝试未成功：订阅控制使公网访问保持Disabled、shared key禁用，身份授权/白名单/AzCopy均未能上传；未绕过策略。最终用Azure VM Agent每块48KB的有界管理传输，完整hash验证后解包。长脚本通过结构化ARM managed run command执行，不能把Azure资源provisioning成功当作脚本实际成功。

云端Linux发现测试初始化SQL为0600使MySQL容器非root用户读失败；仅把合成mysql-init.sql改为0644，使用新azure-v2测试卷重跑（旧失败卷保留）。未改生产MySQL逻辑。

## 云端分机实测结果

本轮云端构建Proxy镜像ID `sha256:ebfed2ed8c1d18777473bc2c5c84c5951236a9c04a529b648bf4fd0714a8e46e`，Console `sha256:da2f7064726da54238170fd6b05bdeb0866df625ea36f3a142c5169861e801de`。重建镜像ID不同于本机历史镜像，不混用其digest；远端5个关键生产源码hash与当前工作区相同，整个上传包hash另行验证。完整报告SHA-256为 `6b5fc91c3c88950fe8eb677c47a89d9285ef9d6056e7a2db966f52b27bb6059b`，保留在压测VM与私有摘要日志中。


- 服务VM运行双Proxy、MySQL8.4.11、SSO/Login/Console、mock和HAProxy；压测VM通过固定私网转发运行原loopback门禁脚本。App/MySQL/mock只连接Docker internal网络，只有fixture bridge暴露到服务VM私网地址；NSG仅允许压测VM来源，不对公网暴露应用。
- 跨VM故障操作使用专用SSH公钥、来源限制、forced command和严格host key，仅允许固定五种测试动作；没有任意远程Docker API。
- 分机HTTP smoke与故障控制snapshot通过。
- 完整soak实际流量 **1942秒**，6并发、4809请求，**0意外错误**。4392成功、242主动取消、176预期错误/管理故障计数（该计数包含管理采样，不能直接相加为请求数）。70次429绑定不变、254次延迟SSE成功、1次原成员401重授权及自然租约到期通过。
- Proxy退出至恢复约39.1秒；MySQL暂停至恢复约14.8秒。期内503/断流按预定义窗口分类，恢复后成功请求和最终一致性均验证；不是要求故障阶段HTTP全200。
- 最终12合成成员、6租约，hold/catalog hold均0。4707唯一上游client marker、4809已发marker，其余被本地保护或故障拒绝，无重复上游marker；SCIM合成创建12、授权13（含一次既有成员修复），无额外账号。
- 正常JSON各协议P50约16.2ms、P95约22.1–22.8ms、P99约26.1–26.4ms，固定tiny mock场景，不是真实模型延迟。内存/连接池预热后有变化，未出现持续错误或最终hold泄漏；不宣称单轮证明无内存泄漏。

相较本机失败，Azure此次通过支持环境干扰解释，但CPU、磁盘、原生Linux、分机网络和Node版本均改变，且本轮没有启动LiteLLM/Postgres网关profile；不是单变量A/B，不抹掉历史失败。当前通过的是规定负载与故障场景，不是生产最大容量、Rancher跨节点或数据库主库HA验收。原完整LiteLLM/迁移证据来自此前独立本地验收。客户适配见 [入口待办](user-pool-rancher-ha-todo.md)。
