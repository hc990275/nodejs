# VPS-Tunnel: 高性能纯原生 Node.js VLESS 隧道与微测网优选系统 (开源分享版)

基于 Node.js 原生 HTTP/WebSocket 协议构建的高性能轻量代理节点与三网动态优选管理面板，专为标准 Linux VPS 深度定制。

---

## 项目亮点

- ⚡ **纯原生零依赖**：无体积庞大的外部核心，常驻内存仅 ~20MB，支持高并发长连接。
- 📶 **微测网 (Wetest.vip) 优选矩阵**：自动集成电信 CT、联通 CU、移动 CM 与 Cloudflare 官方 Anycast 节点分发。
- 🔄 **全能客户端适配**：智能下发 Clash YAML、Sing-box JSON、Surge 及通用 Base64 订阅。
- 🛡️ **0 毫秒单连接隔离断流**：封禁或删除用户立即掐断长连接，对其他在线用户 0 影响、0 闪断。
- 🖥️ **微测网风格大屏与 Element UI 后台**：可视化用户流量监控与运营风控，支持在线修改密码并即时热落盘。
- 🐧 **全系 Linux 运维无缝集成**：内置 Systemd 与 OpenRC 服务、一键安装脚本 (`setup.sh`)，原生适配 Alpine Linux、Debian、Ubuntu、CentOS 等系统及 BBR 内核调优。

---

## 快速上手

### 方式一：🔥 终极单行一键安装 (推荐)
在 VPS 终端直接粘贴执行以下单行命令，全自动安装 Node.js、拉取核心文件并注册开机自启：
```bash
curl -fsSL https://raw.githubusercontent.com/your_username/nodejs/main/vps-nodejs/setup.sh | sudo bash
```

### 方式二：手动克隆安装
```bash
# 克隆代码到 VPS
git clone <repo_url> /opt/vps-tunnel
cd /opt/vps-tunnel

# 拷贝环境模板
cp .env.example .env

# 执行一键安装脚本
sudo chmod +x *.sh
sudo ./setup.sh
```

---

## 开源协议

MIT License.
