# Messages 消息级 output_config／beta 转发修复

## 背景与适用版本

客户报错：

```text
messages.1.output_config: Extra inputs are not permitted
```

当前修复分支 **`fix/messages-output-config`** 从单slug `main` 的 `8ad76d547c9d067aac79f99391859cc67dcd7b44` 分出。没有引入multi-slug迁移、registry、Models或新schema；修复已提交并推送，尚未部署。

Anthropic支持在特定模型上通过 `role:system` 消息内的 `output_config.effort` 调节会话中的effort。此消息可以有空content，但需要配对的beta头：

```http
anthropic-beta: mid-conversation-output-config-2026-07-01
```

官方明确列出：缺少该beta会报 `messages.N.output_config: Extra inputs are not permitted`。这不是 `max_tokens`、账号席位或WebSocket问题，也不说明字段放进消息永远非法。

客户其他云厂商可用，支持了协议转发差异这一假设，但不是Copilot支持同一beta的证据；GHCP访问的是Copilot接口，不是客户端直连Anthropic官方入口。实际customer版本、收到/发出beta和messages结构未提供，因此本补丁**修复已确认的GHCP本地转发缺陷，不声称已验证客户根因或Copilot的新能力**。

## GHCP 原来是不是完全透传？

**不是。**

始终保留的服务职责：客户端服务key鉴权、可信identity映射、账号池准入、读取对应账号OAuth、模型目录校验、规范model ID映射上游ID、错误/usage统计。上游Authorization必须由服务端生成，不透传客户端凭据、任意上游地址或伪造身份。

`X-Claude-Code-Optimized=true` 还会启用历史兼容适配：过滤beta、处理cache_control.scope、清理特定日期块、调整thinking/effort、合并工具结果、清理部分工具标记/空消息、改写某些system消息、添加必要的continue消息。这些是旧Copilot能力兼容策略，不能叫“正文原样转发”。

false模式原来不做这些正文适配，但遗漏了Anthropic版本/beta头。因此简单关优化也不一定能解决消息级beta问题。

## 本次修复

### 消息级output_config存在时

- 基于消息对象自有 `output_config` 字段检测，不只识别某个effort值，也不把content中的文本误判为字段。
- 克隆请求，不执行旧正文适配链。角色、顺序、空content、output_config、thinking历史、system/tools/cache字段全部保留。
- 原始 `anthropic-beta` 请求头不再经过旧白名单，`anthropic-version` 按原规则传递。
- 不擅自补beta，不把消息级effort移动到顶层，不删消息来得到“成功”，不对非法请求做猜测式修复。
- 保留既有明确unsupported web-search server-tool预检；鉴权、模型目录验证、OAuth替换、统计不受影响。
- 调用归属判断跳过末尾空内容的system effort控制消息，但不删除它们或修改正文；避免工具结果之后的effort设置把自动续接误标为user。显式 `x-initiator` 优先级及非空system消息行为保持不变。

### 非优化 /v1/messages

- 直接传递客户端 `anthropic-version`、`anthropic-beta` 给现有上游header构造器。
- 请求正文仍仅在模型解析处替换model；Chat/Responses路由不增加Anthropic头。

不含消息级output_config的优化请求，继续旧版适配，限制客户其他使用方式的回归范围。**本次不是把所有路径改为全透明代理，也没有更改所有模型profile。**

该补丁直接支持的是header形式的Anthropic beta。只在JSON中放 `anthropic_beta` 不等价于提供该header，不会偷偷把缺失header补出来。

## 隔离验证

使用真实GHCP Express路由和临时SQLite，合成账号/授权，mock `/models` 与 `/v1/messages`；清空部署env、DOTENV路径指向不存在的文件、禁止全部真实外部请求。

修复前保留的结果：

- helper：11项，6 PASS / 5 FAIL。
- mock HTTP route：8项，2 PASS / 6 FAIL；复现缺beta400、控制消息丢失/改role。
- 收尾追加的调用归属回归：8项，6 PASS / 2 FAIL；空system effort消息遮住末尾tool_result或自动continue。已修复且失败证据保留在本分支 `.claude/messages-intent-before.log`。

收尾专项（协议helper＋HTTP/SSE路由＋请求归属）已实际执行 **33/33 PASS**，包括优化true/false、空/非空控制消息、原JSON保留（只换model ID）、上游OAuth替换、协议头一致、缺beta仍400、上游即使收到beta仍拒绝时不伪造成功、HTTP/SSE都到最终事件。

### 最终执行结果

| 检查 | 实际结果 |
| --- | --- |
| 新协议helper＋HTTP/SSE mock＋请求归属专项 | 33/33 PASS，0 FAIL，0 SKIP |
| 单slug Proxy全量 | 538项：510 PASS、0 FAIL、28 SKIP |
| 单slug Console单元 | 6/6 PASS，0 FAIL，0 SKIP |
| shared构建、Proxy typecheck及生产构建 | PASS |
| 原multi-slug／Models目录 | 未修改 |
| 真实Claude/Copilot推理 | NOT RUN，用户明确禁用 |
| 真实MySQL重验 | NOT RUN，相关门禁28项跳过 |

专项包含在Proxy全量中，不重复相加。两次独立静态review子agent均未返回有效结果，已停止，未计为review PASS；不把启动review当作完成。收尾由主会话复核并补上调用归属缺陷，重新执行编译、专项与全量回归。独立review仍是未覆盖项，不影响上述已执行测试的真实统计。

修复前失败记录分别保留在原工作目录 `.claude/messages-protocol-before.log`、`messages-route-before.log`；收尾最新记录在本修复worktree `.claude/messages-closeout-targeted.log`、`messages-closeout-proxy.log`、`messages-closeout-console.log`。这些结果替代早先23项／533项的中间统计。mock契约通过不能当成Copilot支持该beta或客户已解决的实测。

从修复分支目录复跑专项：

```bash
node --import tsx --test src/proxy/src/routes/claudeCodeCompat.test.ts src/proxy/src/routes/messagesProtocolForwarding.test.ts src/proxy/src/routes/requestIntent.test.ts
```

全量测试通过清空部署env、指定不存在的DOTENV路径执行；相关真实MySQL测试仍按显式门禁跳过。没有启动浏览器或应用dev server来代替协议测试。

### 测试环境状态检查和启动

环境操作使用显式Azure subscription、独立kubeconfig及context。公开报告不包含实际订阅ID、资源名称或连接信息。只检查/启动已有测试资源，没有部署修复。

- GHCP测试环境的PostgreSQL初始Ready、AKS已Running/Succeeded，因此没有重启；SSO/Login/Console及两个Proxy全部Ready。
- LiteLLM测试环境的PostgreSQL和AKS初始Stopped；先启动数据库，确认Ready后才启动AKS。最终AKS为Running/Succeeded，三个LiteLLM副本全部Ready。
- 运行镜像未更新；不能把环境启动称作补丁上线。
- 中间一次readiness检查使用了错误selector，检查实际labels并改正后确认全部Ready。这不是应用故障。
- 未调用模型、修改Secret、模型权限或公司停机策略。

依赖通过公司npm feed安装，npm报告基准依赖树4项安全警告（1 moderate、2 high、1 critical）；本补丁未更新依赖或执行audit fix，这些警告不作为本次新引入缺陷，也不宣称已解决。

## 生产使用与未验证项

- 不需要multi-slug升级或DB迁移；应用补丁只涉及Proxy，Console/SSO/Login无功能修改。
- 客户实际基准必须核对，尤其旧AKS PostgreSQL分支和这个SQLite/MySQL主线不是同一个部署二进制。跨分支需按原版本移植并构建，不能直接覆盖不同存储架构镜像。
- 没有真实Claude模型调用、模型重新enabled、用户/席位操作或客户配置修改。不得因为模型disabled而临时打开授权或改用其他用户。
- 配对字段和beta到达后，上游仍可能拒绝；这种情况应保留原始错误，改为客户端关闭该新功能／使用上游已验收能力，而不是自动删除指令或重放。
- 发布前记录客户端版本、LiteLLM版本、GHCP镜像、是否优化、消息结构与两段beta头。不得公开真实业务提示词或token。

参考：[Anthropic官方per-message effort](https://platform.claude.com/docs/en/build-with-claude/effort#per-message-effort-beta)。
