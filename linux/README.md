# 极速云专线 - 全 Linux 发行版自适应商业机场

本版本为**全发行版综合自适应版本**，在单机多协议专线机场的基础上，全面支持 **Ubuntu 20.04/22.04/24.04**、**Debian 10/11/12**、**Alpine Linux**、**CentOS / RHEL / Rocky Linux** 等主流 Linux 系统与容器环境。

> **项目仓库关联信息**：
> - **远程代码仓库**：https://github.com/hc990275/nodejs
> - **对应分支与目录**：`main` 分支的 `linux/` 目录 (https://github.com/hc990275/nodejs/tree/main/linux)
> - **本地开发目录**：`d:\DeskTop\GitHub\测\lunes\自适应机场`

---

## 🌟 核心特性与架构

1. **操作系统自适应探测与自愈 (Adaptive Linux Engine)**：
   - 自动识别操作系统发行版（`/etc/os-release`）；
   - 自动适配底层包管理器（Ubuntu/Debian 使用 `apt-get`、Alpine 使用 `apk`、CentOS/Rocky 使用 `dnf/yum`、Arch 使用 `pacman`）；
   - 自动探测并补齐核心依赖：`node`、`npm`、`curl`、`tar`、`ca-certificates`、`openssl`、`iptables`、`procps`；
   - 自动适配 CPU 架构（`amd64` / `arm64` / `armv7`）下载纯静态 Sing-box 核心二进制。
2. **多协议专线矩阵与 UDP 智能跳跃**：
   - Hysteria 2（基于 UDP/QUIC 暴力抗丢包）
   - Hysteria 2 专属端口跳跃（全自动 iptables 转发，突破运营商 UDP QoS）
   - TUIC v5（基于 UDP/QUIC 0-RTT 极低延迟握手）
   - VLESS-Reality（基于 TCP/TLS 偷跑官方大站证书，0 证书 0 特征顶级抗封锁）
   - VLESS-TCP / Trojan-TCP / Shadowsocks-2022 AEAD / Socks5
   - 所有协议端口均通过 `.env` 灵活配置，留空即禁用对应协议
3. **开机自启双轨支持 (Systemd & OpenRC)**：
   - Ubuntu / Debian / CentOS：原生支持 `systemd`（`v3.service`）；
   - Alpine Linux：原生支持 `OpenRC`（`/etc/init.d/v3`）；
   - 内置 `install_service.sh`，一键识别并自动注册为系统级守护服务。
4. **商业化前后台界面体系**：
   - **机场官网主页 (`/`)**：Element UI 商务扁平风，展示品牌、Hero 特性、三档套餐、节点网络总览；
   - **用户控制台 (`/dashboard`)**：流量倒计时、四大一键导入（Clash / Shadowrocket / v2rayN / 扫码）；
   - **管理后台 (`/admin`)**：即时渲染用户表格、实时活跃连线、在线感知、站点配置实时落盘。

---

## ⚡ 一键拉取 + 交互式配置向导（推荐）

在任意全新 Linux 服务器终端中直接粘贴执行下方这一行命令，即可自动拉取代码，然后进入**交互式配置向导**逐项填写端口和密码，最后自动安装启动服务：

```bash
cd ~ && (command -v git >/dev/null 2>&1 || (apt-get update -y && apt-get install -y git || apk add --no-cache git || dnf install -y git)) && rm -rf /root/v3-airport && git clone https://github.com/hc990275/nodejs.git /root/v3-airport && cd /root/v3-airport/linux && chmod +x setup.sh install_service.sh start.sh && ./setup.sh
```

向导会逐步询问：
- 主端口（必填）、管理员密码（必填）
- 各协议端口（留空 = 禁用该协议）
- Argo 隧道 Token（可选）

全部回答完毕后自动写入 `.env` 并安装为系统服务（支持 systemd 和 OpenRC）。

---

## 🚀 部署与运维指南

### 方式一：一键服务部署（推荐）

```bash
cd /root/v3-airport/linux
chmod +x start.sh install_service.sh
./install_service.sh
```

**systemd 常用管理指令（Ubuntu / Debian / CentOS）：**
```bash
systemctl status v3        # 查看状态
systemctl restart v3       # 重启服务
systemctl stop v3          # 停止服务
journalctl -u v3 -f -n 50  # 实时日志
```

**OpenRC 常用管理指令（Alpine Linux）：**
```bash
rc-service v3 status       # 查看状态
rc-service v3 restart      # 重启服务
rc-service v3 stop         # 停止服务
tail -f /var/log/v3.log    # 实时日志
```

### 方式二：前台调试
```bash
./start.sh
```

### 方式三：Docker 容器化部署
```bash
docker build -t v3-airport-adaptive .
docker run -d \
  --name v3-airport \
  --restart=always \
  --net=host \
  --cap-add=NET_ADMIN \
  v3-airport-adaptive
```

---

## ⚙️ 核心环境变量配置 (.env)

> 复制 `.env.example` 为 `.env`，按需填写，未填写的协议端口系统自动禁用：

```ini
# 第 1 组：服务器网络基础
SERVER_PORT=8080          # 必填：主监听端口（翼龙面板填分配端口）
SERVER_IP=                # 选填：公网IP，留空自动探测

# 第 2 组：管理员认证
ADMIN_TOKEN=your_strong_password_here   # 必填：管理后台密码

# 第 3 组：Hysteria 2（留空 = 禁用）
PORT_HY2=
ENABLE_HY2=true
ENABLE_HY2_HOP=true
HY2_HOP_PORTS=            # 例: 10900-10909

# 第 4 组：TUIC v5（留空 = 禁用）
PORT_TUIC=

# 第 5 组：VLESS Reality（留空 = 禁用）
PORT_REALITY=
REALITY_DEST=addons.mozilla.org

# 第 6 组：TCP 直连（留空 = 禁用）
PORT_VLESS_TCP=
PORT_TROJAN_TCP=

# 第 7 组：SS2022 / Socks5（留空 = 禁用）
PORT_SS=
PORT_SOCKS5=

# 第 8 组：Argo 隧道（留空 = 不启用）
ARGO_TOKEN=
ARGO_DOMAIN=

# 第 9 组：系统自适应
LINUX_AUTO_INSTALL=true
```

---

## 📁 目录文件清单

- `index.js`：自适应路由中枢与核心控制器
- `views/`：
  - `views/landing.js`：官网主页视图模块
  - `views/dashboard.js`：用户控制台视图模块
  - `views/admin.js`：管理后台视图模块
- `data/`：持久化数据存储目录（用户、配置、客户端下载）
- `start.sh`：全 Linux 发行版自适应启动脚本
- `install_service.sh`：systemd / OpenRC 一键自启安装脚本
- `v3.service`：Ubuntu / Debian / CentOS systemd 服务文件
- `v3.openrc`：Alpine Linux OpenRC 守护服务脚本
- `Dockerfile`：Ubuntu 24.04 LTS 容器配置
