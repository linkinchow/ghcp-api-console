# Azure Database for MySQL 根 CA

`azure-mysql-ca.pem` 是 `ghcp-mysql-ca` ConfigMap 的 `ca.pem`（Proxy 以 `MYSQL_SSL_MODE=verify-ca` 校验服务器证书链）。两个都是公开的根证书，不是机密。

- 依据：Microsoft Learn《Azure Database for MySQL - Flexible Server: Encrypted connectivity using TLS/SSL》（文档日期 2026-07-17）要求客户端同时信任 **DigiCert Global Root G2** 与 **Microsoft RSA Root Certificate Authority 2017**，并把两者合并后使用。
- 下载地址（文档给出）：`https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem`、`https://www.microsoft.com/pkiops/certs/Microsoft%20RSA%20Root%20Certificate%20Authority%202017.crt`。
- 本文件的内容不是从网上下载的：从 Node.js 24.22.1 内置根证书库（`tls.rootCertificates`，Mozilla 根证书计划）按主题名取出，再与本机 Windows 根证书库独立比对（序列号与 SHA-1 一致）：

| 证书 | 序列号 | SHA-256 指纹（由本文件计算） | 到期 |
| --- | --- | --- | --- |
| DigiCert Global Root G2 | `033AF1E6A711A9A0BB2864B11D09FAE5` | `CB:3C:CB:B7:60:31:E5:E0:13:8F:8D:D3:9A:23:F9:DE:47:FF:C3:5E:43:C1:14:4C:EA:27:D4:6A:5A:B1:CB:5F` | 2038-01-15 |
| Microsoft RSA Root Certificate Authority 2017 | `1ED397095FD8B4B347701EAABE7F45B3` | `C7:41:F7:0F:4B:2A:8D:88:BF:2E:71:C1:41:22:EF:53:EF:10:EB:A0:CF:A5:E6:4C:FA:20:F4:18:85:30:73:E0` | 2042-07-18 |

部署前请运维按自己的流程再核对一次（例如对比操作系统根证书库或上面的官方下载地址），并关注 Microsoft 关于 MySQL 根证书轮换的公告；Azure 更换根 CA 时更新本文件并 `kubectl rollout restart deployment/ghcp-proxy`。
