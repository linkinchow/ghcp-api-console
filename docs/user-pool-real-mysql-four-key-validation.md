# 真实LiteLLM四virtual-key排他租约验证

日期：2026-09-16。用户要求将迁移后的真实池Ready idle target设为2，并通过LiteLLM容器使用四把virtual key调用GHCP Proxy，验证总6成员中4leased/2idle。此为有限功能验证，不是吞吐测试。

## 实际配置与边界

- 基于已迁移的4个真实成员及后续成功新增的2个成员，总数6。
- 经版本化管理API将idle target从6调到2，max accounts保持6，补池全程paused1；未新增账号或席位。
- 保留原LiteLLM版本和PostgreSQL数据卷，指向新MySQL环境Proxy1；hook受信任api_base也同步更新。
- 路径为LiteLLM容器→Proxy1→共享MySQL，不是负载均衡分流验收。三个Proxy共享结果另行只读核对。
- 模型为既有已批准配置，四次非流式Responses请求，每次输出上限16token，重试0、fallback空、响应缓存关闭。没有失败后的替代请求。

## 结果——通过

| 测试key | HTTP及响应 | 实际耗时 |
| --- | --- | --- |
| 1 | 200 / completed | 5824ms |
| 2 | 200 / completed | 4211ms |
| 3 | 200 / completed | 5264ms |
| 4 | 200 / completed | 3098ms |

四把不同的已认证virtual key经过hook产生四个不同caller hash；与四个不同member、四个active lease对应。MySQL统计恰好四条成功请求且归属匹配。hold/catalog hold全部排空。

最终：**total6、leased4、ready_idle2、provisional0、provisioning0、failed0**。idle target2、cap6、paused1。四把短期测试key已全部撤销；Proxy租约未手工释放，保留给用户查看并按原TTL自然过期。key撤销不等于立即释放Proxy租约。

完整响应和key信息仅保存在本机受保护目录，不进入Git或截图；普通报告不包含key原文、caller全hash、外部企业URL或完整账号映射。用户真实模型仅发起上述四次有限请求，无追加性能负载。
