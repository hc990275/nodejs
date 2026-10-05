# 🚀 VPS-Tunnel: 高性能纯原生 Node.js VLESS 隧道与多源三网优选管理中枢

专为 **独立 Linux VPS (Alpine / Ubuntu / Debian / CentOS / Rocky 等全系架构)** 深度打造的高性能轻量级代理服务枢纽与三网优选分发大屏。

---

## Ⅰ. 核心架构特性与优势

1. **纯原生 0 外部重型依赖**：
   - 彻底摆脱体积数十 MB 的编译二进制，纯 Node.js 原生事件驱动与 RFC 6455 帧解析，常态常驻仅 20MB~40MB。
2. **全自动硬件资源感知与自适应管控引擎 (ResourceGovernor)**：
   - **零硬编码**：全自动动态探测 Linux Cgroups v1/v2 容器配额、物理内存与有效 CPU 核心数；
   - **堆配额动态分配**：自动按物理配额计算安全堆上限（如 244MB 内存动态分配 109MB 堆），彻底杜绝内核 OOM Killer 强杀；
   - **内存反压防线 (Backpressure)**：当物理内存达到警戒阈值时，自动触发 `global.gc()` 并启动反压门禁，保护已存在的活跃连接；
   - **连接池容量自适应**：依据硬件规格动态调配系统最大并发连接数与单用户配额，套接字缓冲区高低水位线动态适配（16KB~64KB）。
3. **多源三网优选矩阵 (微测网 + CM 佬 + 自定义域名池)**：
   - **微测网 (wetest.vip)**：电信 CT、联通 CU、移动 CM 三网优选池动态测速与清洗；
   - **CM 佬 (cf.090227.xyz)**：按需批量拉取移动/联通/电信高速优选 IP；
   - **自定义批量域名池**：支持纯域名、`域名#备注`、`域名:端口#备注`、`域名:端口` 多种格式一键批量导入；
   - **互斥锁与防抖冷却**：具备 3 分钟防抖与并发互斥保护，彻底消除启动期与多用户访问时的 CPU 100% 尖峰。
4. **双重看门狗守护 (永不断连自愈机制)**：
   - **Alpine Linux (OpenRC)**：原生适配 `supervisor="supervise-daemon"`，进程无论是后台重启还是异常崩溃，2 秒内毫秒级全自动拉起；
   - **Debian / Ubuntu / CentOS**：标准 Systemd `Restart=always` 守护；
   - **Argo 隧道保活看门狗**：具备进程退出指数退避重连与 30 秒全局巡检心跳，确保 443 端口与订阅穿透永不失联。
5. **全端智能自适应与零信任脱敏架构**：
   - 智能识别客户端请求头 User-Agent，自动派发 Clash YAML、Sing-box JSON、Surge 或通用 Base64 订阅；
   - 采用虚拟占位符隔离脱敏机制，确保真实 UUID 与域名不泄露给公网转换接口。
6. **毫秒级定向连接控制 (零闪断)**：
   - 封禁、修改或删除用户时，直接从内存活跃连接池定向销毁目标连接，其他在线用户绝对 0 丢包、0 影响。

---

## Ⅱ. 硬件配额自适应对比

| 硬件规格 | 系统总内存配额 | V8 安全堆配额 | 自适应最大连接数 | 套接字水位线 |
| :--- | :--- | :--- | :--- | :--- |
| **超轻量容器 / NAT VPS** | 244 MB ~ 300 MB | 109 MB ~ 135 MB | 146 ~ 180 | 16 KB (低内存节约) |
| **基础型 VPS** | 512 MB ~ 1 GB | 230 MB ~ 460 MB | 300 ~ 600 | 64 KB (高吞吐极速) |
| **生产级 VPS** | 2 GB ~ 8 GB+ | 920 MB ~ 3.6 GB+ | 1,200 ~ 4,800+ | 64 KB (高吞吐极速) |

> [!NOTE]
> 以上数据完全由系统内核与 Cgroups 动态探测感知计算，无需人工干预或修改代码，自动适配任何 VPS 规格。

---

## Ⅲ. 一键极速部署与迁移指南

### 1. 全自动单行一键安装 (推荐)

在全新 Linux VPS 终端中（root 权限执行），可直接通过环境变量传入初始化参数，全自动装配环境、依赖、自适应守护与开机自启：

```bash
# 自定义端口、后台密码与 Argo 穿透域名/Token 一键部署
SET_PORT="19900" \
SET_ADMIN_PASSWORD="your_secure_password_here" \
SET_ARGO_DOMAIN="your-tunnel.example.com" \
SET_ARGO_TOKEN="eyJh..." \
curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | bash
```

> [!TIP]
> 若服务器在国内或访问 GitHub 缓慢，可使用国内高速 CDN 镜像代理命令：
> ```bash
> curl -fsSL https://gh-proxy.net/https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | bash
> ```

---

### 2. 现有项目平移迁移方式 (保留全部数据与配置)

若您希望将现有机房的数据与配置原汁原味迁往新 VPS：

1. 将当前项目文件夹 `vps-nodejs` 完整上传至新 VPS 的 `/opt/vps-tunnel`；
2. 在新 VPS 执行启动脚本：
   ```bash
   cd /opt/vps-tunnel && chmod +x *.sh && bash setup.sh
   ```
3. 脚本会自动复用现有的 `.env` 与 `data/` 用户数据库，自动检测新服务器的硬件配额并完成自启守护注册。

---

## Ⅳ. 常用运维管理命令

### 1. 服务状态与健康监控

- **Debian / Ubuntu / CentOS / Rocky (Systemd)**：
  ```bash
  systemctl status vps-tunnel
  ```
- **Alpine Linux (OpenRC)**：
  ```bash
  rc-service vps-tunnel status
  ```

### 2. 查看实时运行日志

```bash
tail -f /var/log/vps-tunnel.log
```
> 日志中实时输出 CPU 占用、常驻内存 RSS、在线长连接数、Argo 隧道握手状态与优选 IP 同步详情。

### 3. 重启与停止服务

- **重启服务**：
  - Systemd: `systemctl restart vps-tunnel`
  - Alpine: `rc-service vps-tunnel restart`
- **停止服务**：
  - Systemd: `systemctl stop vps-tunnel`
  - Alpine: `rc-service vps-tunnel stop`

---

## Ⅴ. 配置文件与环境变量 (`.env`)

所有关键参数均统一定义在 `/opt/vps-tunnel/.env` 中，系统支持**毫秒级无感知双向热重载**，修改保存后即刻生效，无需重启进程：

```ini
# 服务监听端口 (默认 19900，亦可设为 80 / 8080 等)
PORT=19900

# 管理员后台密码 (严格执行 Fail-Closed 安全熔断，严禁弱口令)
ADMIN_PASSWORD=your_secure_password_here

# Cloudflare Argo 隧道穿透配置 (支持 443 端口直连与国内免备案 CDN 优选)
ARGO_DOMAIN=your-tunnel.example.com
ARGO_TOKEN=eyJh...

# 防薅安全风控策略
IP_REGISTER_COOLDOWN_SEC=60
IP_DAILY_REGISTER_LIMIT=3

# 客户端默认订阅配额
DEFAULT_DAYS=365
DEFAULT_TRAFFIC_GB=100
DEFAULT_ALLOW_REGISTER=true

# 订阅转换后端引擎 (local 为本地极速零外传脱敏引擎)
SUBAPI=local
SUBCONFIG=https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini
```

---

## Ⅵ. 网络性能进阶调优 (开启 BBR)

在 VPS 终端执行自带的优化脚本：
```bash
bash /opt/vps-tunnel/optimize_bbr.sh
```
该脚本将全自动开启 Linux 内核 BBR 拥塞控制、优化 TCP 发送接收缓冲队列，并将文件句柄上限调整至 65535，显著提高多并发代理吞吐稳定性。
