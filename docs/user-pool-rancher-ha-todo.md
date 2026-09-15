# Rancher 入口高可用与 NGINX 适配待办

记录：2026-09-14。用户明确客户环境为 Rancher，并要求记录“换成 NGINX”。**当前仅记录与设计评估，未替换正在运行的 HAProxy 验收夹具，未连接或修改客户集群。** 继续遵守不commit/push、不读真实凭据、不操作真实EMU/席位/模型。

## 待办定义

- [x] NGINX替换从必选改为条件待办（决策已记录，实施未验收）：用户提供的客户回复已确认LiteLLM与Proxy同集群，配置截图使用标准`<service>.<namespace>.svc.cluster.local`内部Service DNS。优先复用现有Service，不额外插入NGINX；仅有集群外入口或额外七层需求时，再选择受维护的NGINX方案。
- [x] 同集群及内部Service DNS路径已由用户提供材料确认；没有连接客户集群。截图不展示`spec.type`，不能仅靠DNS名断言类型严格为ClusterIP，也不能证明已有多个健康后端。
- [ ] 由部署方只读核对实际Service的type/clusterIP、selector/port/targetPort、EndpointSlice中ready地址与对应Pod节点；若`clusterIP: None`则为headless，若ExternalName或selector指向中间转发器须另分析。不得在客户唯一生产环境直接停止Pod/节点做测试。
- [ ] 获取经授权提供的 Rancher 下游集群信息：RKE2/K3s/RKE或导入的其他Kubernetes、版本、Ingress/Gateway实现与版本、Pod副本与节点分布、入口IP/域名归属、外部LB/VIP的冗余机制、MySQL部署与HA能力。Rancher品牌本身不能说明这些实际拓扑。
- [ ] **同集群服务优先用 Kubernetes Service**：LiteLLM→Proxy ClusterIP Service→至少两个不同节点的Proxy Pod；SSO/Login/Console内部API与OAuth回调同样指向该Service，不必绕外部Ingress或新建单实例NGINX。
- [ ] 对集群外入口复用客户已验收的高可用Ingress/Gateway；如确需NGINX，必须多个NGINX数据面实例跨节点，并确认其前面的外部LB/VIP/节点入口也具备故障切换。域名多个A记录、Service名字、Pod自动重启、PDB都不是独立的外部入口HA证明。
- [ ] Proxy配置Deployment>=2、readinessProbe `/readyz`、topology spread/required anti-affinity、滚动发布与终止排空；PDB只覆盖自愿驱逐，不保证物理节点失败无中断。长连接在所在Pod/节点故障时仍可能中断，不自动重放已开始的推理。
- [ ] MySQL使用经验证的单写主库HA端点/存储/备份，测试主切换期间连接重建与不明commit安全；不能只把MySQL StatefulSet副本数改成2或让多个mysqld共享一个数据目录。
- [ ] 检查LiteLLM、其数据库/缓存、Ingress外部入口、Kubernetes控制面/etcd及DNS等依赖的HA。SSO/Login/Console当前仍各单实例；故障一般阻止新开户/重授权/管理，已ready凭据业务可在依赖不触发时继续，但不叫全系统无单点。
- [ ] 最终验收覆盖Proxy Pod退出、整个worker节点失联、外部入口/VIP故障、数据库主库切换；若采用NGINX，再验证NGINX实例退出，分别定义可接受中断/错误和恢复时间。仅本机Docker中停止Proxy不代表通过Rancher节点级HA。

## 为什么单个 NGINX 仍是单点

```text
单NGINX → 两个Proxy → 单MySQL
```

只移除了Proxy进程这一层的单点，NGINX和MySQL仍可使整条请求链不可用。正确方向是使用客户集群现有冗余入口，加跨节点Proxy Service和HA数据库，而不是在链路前面新增一个孤立转发进程。

同集群最简业务路径：

```text
LiteLLM Pod → ghcp-proxy ClusterIP Service → Proxy Pod A / Proxy Pod B（不同节点）
                                                 ↓
                                         同一MySQL HA写端点
```

需要集群外访问时：

```text
可信客户端 → 高可用外部LB/VIP → 多副本Ingress/Gateway/NGINX（跨节点）
                                      ↓
                               Proxy Service → 多Proxy Pod
```

Service是Kubernetes虚拟网络对象，由数据面规则/CNI处理，不是必须运行的一台“Service容器”；但是CNI、节点和控制面等仍须有健康与冗余设计。

## NGINX 名称与维护状态

不要混淆 NGINX Open Source/NGINX Plus、F5 NGINX Ingress Controller 与 Kubernetes 社区 **ingress-nginx**。Kubernetes官方公告：社区ingress-nginx在2026年3月退休，之后不再提供发布、bug或安全修复。新的生产方案不能不核对实现就写“装nginx ingress”。F5的NGINX Ingress Controller是不同项目，官方有从社区Ingress-NGINX迁移的文档；是否采用及支持/LTS版本需由客户平台规范决定。

RKE2官方文档也提示ingress-nginx EOL及默认控制器变更，并明确LoadBalancer Service需要对应外部控制器；不能以“由Rancher管理”推断已提供高可用外部LB。上述产品状态按2026-09-14官方资料核对，实际集群类型/版本仍未知。

资料：
- [Kubernetes Ingress NGINX retirement](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [RKE2 networking services](https://docs.rke2.io/networking/networking_services)
- [F5 NGINX Ingress Controller](https://docs.nginx.com/nginx-ingress-controller/)
