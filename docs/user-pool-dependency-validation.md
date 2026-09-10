# User Pool 依赖安全修复与验证

日期：2026-09-10。本次发布候选对已知可修复依赖告警做了兼容版本升级，没有更换框架、关闭TLS校验或绕过企业包源策略。

## 生产依赖

| 包 | 原锁定版本 | 修复后 |
| --- | --- | --- |
| @xmldom/xmldom | 0.8.13 | 0.8.15 |
| brace-expansion | 1.1.15 | 1.1.18 |
| multer | 2.2.0 | 2.3.0 |
| qs | 6.15.2 | 6.16.0 |

Multer直接依赖固定为2.3.0。其余生产修复满足父依赖现有范围，无overrides。生产审计从4项（3 high、1 moderate）变为0。

## 构建/开发依赖

| 包 | 原锁定版本 | 修复后 |
| --- | --- | --- |
| baseline-browser-mapping | 2.10.38 | 2.11.20 |
| browserslist | 4.28.2 | 4.28.8 |
| nanoid | 3.3.12 | 3.3.18 |
| postcss | 8.5.15 | 8.5.27 |
| vite | 7.3.5 | 7.3.6 |
| Vite依赖esbuild及其平台二进制包 | 0.27.7 | 0.28.2 |

对应Browserslist数据/更新包随新依赖要求更新（caniuse-lite、electron-to-chromium、node-releases、update-browserslist-db）。现有顶层另一个esbuild版本未无故替换。

所有下载经过组织批准的保护源及其授权交付地址。校验源提供的包摘要后记录SHA-512 integrity；公开lockfile使用标准npm URL保持客户可移植性，构建通过 `NPM_REGISTRY` 指定各组织批准源，不把内部地址或凭据写死。

## 验证

- 最新 `npm audit`（含开发依赖）：**0 vulnerabilities**。
- `npm audit --omit=dev`：**0 vulnerabilities**。
- 最终依赖安装后workspace typecheck、deployment build、Proxy/SSO/Login/Console测试及本地浏览器测试通过。
- 当前通过数和四个Docker镜像构建记录统一见[发布检查](user-pool-release-checklist.md)。

这是特定时间依赖公告数据库的结果，不等于应用无漏洞或完整供应链认证。后续固定release SHA并持续审计；不要自动运行宽泛 `npm audit fix --force` 破坏兼容性。
