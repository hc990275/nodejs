# 🌐 VPS-Tunnel: 海外 Linux VPS 纯原生极速隧道与多源三网优选管理中枢

专为 **海外独立 VPS 及云主机 (Oracle Cloud / RackNerd / 搬瓦工 / Cloudcone / Vultr / Hetzner / OVH / Alpine NAT 小鸡等)** 量身打造的超轻量、纯原生 VLESS 代理中枢与智能三网优选分发系统。

---

## Ⅰ. 海外 VPS 核心痛点与本系统解决方案

海外 VPS（尤其是特价年付机、小内存玩具鸡、NAT 共享机）普遍存在以下痛点：
1. **内存极其严苛 (128MB ~ 512MB，Swap=0)**：
   - 传统 Xray / Sing-box 等重型二进制或臃肿框架常驻动辄 100MB+，稍有并发测速便突破机器配额被 Linux 内核 OOM Killer 强行斩杀；
   - **本系统解法**：采用纯原生 Node.js 流式转发与事件循环，常态常驻仅 **20MB~40MB**。配合全自动 `ResourceGovernor` 自适应引擎，按实际物理配额动态分配堆上限（如 244MB 内存动态配额 109MB），配合 75% 警戒水位反压门禁与主动 GC，彻底杜绝 OOM 崩溃！
2. **单核 CPU 算力受限 (容易 Full GC 爆 CPU 导致网络雪崩)**：
   - 内存压迫会导致 V8 疯狂 Full GC 跑满单核，同时频繁请求外部 API 导致 CPU 持续 100%；
   - **本系统解法**：引入多源优选并发互斥锁与 180 秒冷却防抖，启动时优先复用本地持久化节点池，全生命周期 CPU 负载稳定在 **1%~5%**。
3. **国内直连阻断与端口封锁**：
   - 海外 IP 直连国内易遇阻断、丢包或端口劣化；
   - **本系统解法**：原生深度集成 **Cloudflare Argo (QUIC / HTTP/3 over UDP)** 极速隧道，一键直通全球 CDN 边缘 443 端口，免除海外 VPS 申请证书与维护 Nginx 的繁琐步骤；同时内置微测网 (wetest.vip) 与 CM 佬 (cf.090227.xyz) 三网动态优选池，自动派发最快回国线路。
4. **服务异常退出后永久断连 (无看门狗)**：
   - **本系统解法**：无论是 Alpine Linux (OpenRC `supervise-daemon`) 还是 Debian/Ubuntu (Systemd)，均提供系统级内核看门狗守护，任何原因导致退出均在 **2 秒内全自动拉起复活**；Argo 隧道自带 30 秒全局保活心跳，保障海外节点 100% 永在线。

---

## Ⅱ. 硬件配额动态感知与自适应矩阵 (零硬编码)

系统启动时自动穿透探测 Linux Cgroups v1/v2 容器硬限制与系统真实物理规格，动态调配核心参数，绝不硬编码：

| 海外主机类型 | 真实内存配额 | V8 堆安全上限 | 自适应最大连接池 | Socket 缓冲水位 | 运行表现 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **超轻量 NAT / 玩具小鸡** | 244 MB ~ 300 MB | 109 MB ~ 135 MB | 146 ~ 180 长连接 | 16 KB (极度省内存) | 常驻 ~30MB，极度平稳 |
| **主流特价机 / 基础 VPS** | 512 MB ~ 1 GB | 230 MB ~ 460 MB | 300 ~ 600 长连接 | 64 KB (高吞吐极速) | 4K 秒开，轻松抗多用户并发 |
| **生产级 / 高配云主机** | 2 GB ~ 16 GB+ | 920 MB ~ 7.2 GB+ | 1,200 ~ 9,600+ 长连接 | 64 KB (极速大带宽) | 跑满千兆甚至万兆上行 |

---

## Ⅲ. 海外 VPS 极速一键部署指南

得益于海外 VPS 原生畅通的全球网络，无需任何镜像代理，秒级直接从 GitHub 官方源拉取安装。

### 1. 全自动单行极速安装 (最推荐)

SSH 登录海外 VPS（使用 root 权限），直接粘贴以下命令执行：

默认极速部署（自动生成随机高强度后台密码与 UUID）：
```bash
curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | sh
```

若 Alpine 极简系统未安装 curl，可使用系统自带的 wget 一行安装：
```bash
wget -qO- https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | sh
```

**带自定义参数一键部署（推荐按需配置）**：
```bash
SET_PORT="19900" SET_ADMIN_PASSWORD="your_secure_password_here" SET_ARGO_DOMAIN="your-tunnel.example.com" SET_ARGO_TOKEN="eyJh..." sh -c "$(curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh 2>/dev/null || wget -qO- https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh)"
```

安装脚本将全自动完成：
- 自动适配 OS 包管理器（Alpine `apk`、Debian/Ubuntu `apt`、CentOS/Rocky `dnf/yum`）；
- 自动安装 Node.js LTS、curl、openssl 与必要组件；
- 动态感知海外 VPS 内存与 CPU 规格，自动生成看门狗守护配置并注册开机自启；
- 自动检测并放行系统防火墙端口，服务就绪即刻可用。

---

### 2. 跨 VPS 数据与配置无缝平移

若您需要将现有機房配置平移到另一台海外 VPS：
1. 将本地项目目录 `vps-nodejs` 上传至新 VPS 的 `/opt/vps-tunnel`；
2. 在新 VPS 运行：
   ```bash
   cd /opt/vps-tunnel && chmod +x *.sh && bash setup.sh
   ```
3. 脚本会自动复用现存的 `.env` 配置与 `data/users.json` 用户库，自动适应新主机的硬件规格并启动守护。

---

## Ⅳ. 常用运维管理命令

### 1. 检查服务与硬件自适应状态

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
> 日志每 3 秒实时输出硬件感知指标：当前 CPU 占用率、常驻内存 RSS、在线长连接数、Argo 隧道握手状态与优选 IP 同步详情。

### 3. 重启与停止服务

- **重启微服务**（看门狗守护，2秒内毫秒级复活）：
  - Systemd: `systemctl restart vps-tunnel`
  - Alpine: `rc-service vps-tunnel restart`
- **停止服务**：
  - Systemd: `systemctl stop vps-tunnel`
  - Alpine: `rc-service vps-tunnel stop`

---

## Ⅴ. 环境变量与动态热重载 (`.env`)

所有参数统一定义于 `/opt/vps-tunnel/.env` 中。系统内置轻量级监听引擎，**修改保存后毫秒级原生热重载，无需重启服务进程**：

```ini
# 服务监听端口 (默认 19900，亦可根据安全组改为 80 / 8080 等)
PORT=19900

# 管理后台口令 (严格执行 Fail-Closed 安全熔断，严禁弱口令)
ADMIN_PASSWORD=your_secure_password_here

# Cloudflare Argo 隧道穿透配置 (直通 443 端口与全球 CDN)
ARGO_DOMAIN=your-tunnel.example.com
ARGO_TOKEN=eyJh...

# 防薅风控安全策略
IP_REGISTER_COOLDOWN_SEC=60
IP_DAILY_REGISTER_LIMIT=3

# 客户端默认订阅配额
DEFAULT_DAYS=365
DEFAULT_TRAFFIC_GB=100
DEFAULT_ALLOW_REGISTER=true

# 零信任订阅转换引擎 (local 为本地极速零外传脱敏引擎)
SUBAPI=local
SUBCONFIG=https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini
```

---

## Ⅵ. 海外 VPS 网络极限提速 (开启 BBR)

在海外 VPS 终端中运行自带的内核优化脚本：
```bash
bash /opt/vps-tunnel/optimize_bbr.sh
```
该脚本将一键开启 Linux 内核 **BBR 拥塞控制算法**、扩大 TCP 发送接收 Buffer 并调优网络队列，跨国回国长连接测速延迟与丢包抖动可降低 **30%~50%**。
