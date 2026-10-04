# 经验沉淀与踩坑记录 (Error Tracking & Retrospective)

记录将受限卡塔容器架构 (`kata-nodejs`) 演进升级为独立 Linux VPS 架构 (`vps-nodejs`) 过程中的关键坑点、权限边界与解决方案。

---

## 1. Linux 非 Root 用户绑定 1024 以下特权端口 (80/443) 报 EACCES
- **问题现象**：在 Linux 系统中直接用非 root 用户运行 `node index.js`（当配置 `PORT=80` 或 `TLS_PORT=443` 时），服务立即崩溃并报错：`Error: listen EACCES: permission denied 0.0.0.0:80`。
- **原因剖析**：POSIX/Linux 内核出于安全考虑，默认禁止非特权用户（UID != 0）绑定 1024 以下的标准网络端口。
- **解决方案**：
  1. 在 `vps-tunnel.service` 中将运行用户设为 `root`（最简单可靠）；
  2. 若出于最小权限原则使用独立用户 `nobody` 或 `node`，可通过 Linux Capabilities 授权 node 二进制特权绑定能力：
     ```bash
     sudo setcap 'cap_net_bind_service=+ep' $(which node)
     ```
  3. 或者将服务端口设为 `8080`，由前置 Nginx 转发到 `8080`。

---

## 2. Linux VPS 云厂商安全组与操作系统双重防火墙拦截
- **问题现象**：执行 `setup.sh` 启动成功且 `curl 127.0.0.1` 正常响应，但外网浏览器与客户端连接始终超时 (Connection Timed Out)。
- **原因剖析**：
  1. 操作系统内部防火墙（Ubuntu 的 UFW 或 CentOS 的 Firewalld）默认丢弃了外部对 80/443 的 TCP 入站流量；
  2. 腾讯云、阿里云、AWS、甲骨文云等主流厂商在网页控制台自带“安全组 (Security Group)”规则，未放行 80/443 入站。
- **解决方案**：
  1. `setup.sh` 中自动增加 UFW / Firewalld 检测并自动放行 `ufw allow 80/tcp` 与 `ufw allow 443/tcp`；
  2. 在文档中明确提示用户检查云服务器服务商控制台的安全组规则。

---

## 3. 从容器小内存模式到 VPS 高并发的垃圾回收调优
- **问题现象**：卡塔版本启动参数带有 `--max-old-space-size=96`，用于防止突破 308MB 配额被容器杀掉。但如果原封不动照搬到 VPS 上，当在线用户突增或高并发下载时，V8 引擎会在 96MB 边界频繁触发 Full GC，导致 CPU 占用骤升甚至吞吐出现卡顿。
- **解决方案**：
  1. 在 `package.json` 和 `vps-tunnel.service` 中移除 `--max-old-space-size=96` 压制，交由 V8 根据 VPS 实际物理内存自动扩展堆内存；
  2. 依然保留原生零外部依赖的异步 Stream 与事件循环设计，常态依然仅占用 ~20MB，只有在突发大数据吞吐时才动态借用内存，并发处理能力提升数十倍。

---

## 4. 严禁默认口令回退 (Fail-Closed 铁律落地)
- **问题现象**：原有卡塔代码在未显式传递环境变量时存在 `ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD', 'admin123')` 的弱口令兜底。
- **风险根源**：一旦用户把项目部署到公网 VPS 且未及时配置 `.env`，公网扫描器可在秒级扫描出暴露的 80 端口并使用默认密码 `admin123` 登入后台接管节点。
- **根本解决方案**：
  彻底废弃默认回退逻辑。若 `.env` 中 `ADMIN_PASSWORD` 缺失或为空，系统严格执行 **Fail-Closed（安全熔断）**，控制台抛出告警并直接拒绝任何后台登录尝试，坚决消除默认口令后门漏洞。
