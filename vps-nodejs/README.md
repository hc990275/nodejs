# 🚀 VPS-Tunnel: 高性能纯原生 Node.js VLESS 隧道与微测网三网优选系统 (自用版)

以 `kata-tunnel` 为坚实蓝本，专为 **独立 Linux VPS (Debian / Ubuntu / CentOS / Alpine 等)** 全面进化升级的高性能代理枢纽与三网优选管理中枢。

---

## Ⅰ. 架构对比：VPS 版本 vs 卡塔受限容器

| 维度 | 卡塔版本 (Kata-Tunnel) | VPS 版本 (VPS-Tunnel) |
| :--- | :--- | :--- |
| **部署宿主** | 卡塔 (Katabump) 翼龙面板受限容器 | 任意 Linux VPS (搬瓦工、RackNerd、腾讯云、甲骨文、AWS等) |
| **内存限制** | 严格限制 308MB (超限 OOM 杀进程) | **解除内存压制**，常驻极低(~20MB)，支持高并发数千长连接 |
| **端口支持** | 面板随机单端口 (如 20255) | **支持标准 80 / 443 / 8080 / 8443** 等任意公网端口 |
| **TLS/HTTPS** | 必须依赖 Argo 隧道穿透 443 | **支持原生读取 PEM 证书**（直接监听 443 TLS），亦支持前置 Nginx/Caddy 反代或 Argo |
| **进程守护** | 依赖翼龙面板监控重启 | **标准 Linux Systemd 守护进程**（开机自启、崩溃 5 秒自愈拉起） |
| **网络调优** | 受限共享内核，无法调优 | **支持内核开启 BBR 拥塞控制**、TCP 缓冲区扩展、`ulimit 65535` |

---

## Ⅱ. 核心功能全景

1. **纯原生 0 外部重型依赖**：
   - 彻底摆脱体积数十 MB 的 Sing-box 或 Xray 二进制，纯 Node.js 事件循环与 RFC 6455 帧解析。
2. **毫秒级定向连接控制 (零闪断)**：
   - 管理员在后台封禁/删除/修改用户时，直接从内存句柄池**定向销毁目标用户的连接**，其他正常用户通信**绝对 0 影响、0 丢包**。
3. **微测网 (Wetest.vip) 三网优选分发矩阵**：
   - 电信 (CT)、联通 (CU)、移动 (CM) 以及 Cloudflare 官方 Anycast 动态测速与机房归属感知。
4. **全能自适应客户端订阅**：
   - 智能识别请求头 User-Agent，自动下发开箱即用的 Clash YAML、Sing-box JSON、Surge 或 Base64 订阅。
5. **微测网大屏前台与 Element UI 扁平后台**：
   - 前台：测速状态看板、用户流量与有效期直观展示、订阅一键复制；
   - 后台：用户全生命周期管理、注册开关与风控、一键修改密码并实时原子落盘 `.env`。

---

## Ⅲ. Linux VPS 一键部署指南

### 1. 🔥 终极单行一键安装命令 (推荐，直接复制回车即可)

在全新空白的 Linux VPS 终端中，直接复制以下单行命令粘贴并回车，全自动完成环境检测、Node.js 安装、服务创建与开机自启：

```bash
# 境外服务器极速直连安装
curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | sudo bash

# 若遇 GitHub 访问受限，可使用高速镜像安装
curl -fsSL https://gh-proxy.net/https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs/setup.sh | sudo bash
```

---

### 2. 本地源码/克隆手动安装 (备用方式)

若已手动下载或克隆了仓库代码，可在当前项目目录下执行：
```bash
cd /opt/vps-tunnel
chmod +x setup.sh start.sh optimize_bbr.sh
sudo ./setup.sh
```

脚本将自动完成：
- 检查并安装 Node.js 20 LTS；
- 同步文件并创建 `/opt/vps-tunnel/data`；
- 生成并注册 `/etc/systemd/system/vps-tunnel.service` 服务；
- 检查并自动放行 UFW / Firewalld 对应端口；
- 立即启动服务并加入开机自启。

### 2. 常用管理命令

#### Systemd 环境 (Debian / Ubuntu / CentOS 等)
```bash
# 查看实时运行状态
sudo systemctl status vps-tunnel

# 查看服务实时日志
sudo journalctl -u vps-tunnel -f

# 重启服务
sudo systemctl restart vps-tunnel

# 停止服务
sudo systemctl stop vps-tunnel
```

#### OpenRC 环境 (Alpine Linux)
```bash
# 查看服务状态
rc-service vps-tunnel status

# 查看服务实时日志
tail -f /var/log/vps-tunnel.log

# 重启服务
rc-service vps-tunnel restart

# 停止服务
rc-service vps-tunnel stop
```

---

## Ⅳ. 环境变量配置说明 (`.env`)

```ini
# HTTP / WebSocket 端口 (默认 80 或 8080)
PORT=80

# 原生 TLS 监听端口与证书绝对路径 (可选，若配置证书则自动启动原生 443 TLS)
TLS_PORT=443
CERT_PATH=
KEY_PATH=

# 后台管理员密码 (严禁留空，遵循 Fail-Closed 安全熔断原则)
ADMIN_PASSWORD=your_secure_password_here

# 节点绑定的域名或公网 IP
SUB_DOMAIN=your.domain.com

# 运营策略
DEFAULT_ALLOW_REGISTER=true
DEFAULT_DAYS=365
DEFAULT_TRAFFIC_GB=100
```

---

## Ⅴ. 网络性能进阶调优 (开启 BBR)

在 VPS 终端以 root 身份运行：
```bash
sudo ./optimize_bbr.sh
```
该脚本将自动为 Linux 内核配置 `bbr` 拥塞控制、优化 TCP 发送/接收缓冲区，并将系统并发描述符上限提升至 65535。
