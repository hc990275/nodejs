# V3 极轻量多协议节点管理中枢与自适应订阅网关

本项目是一个极轻量、开箱即用的多协议网络代理接入与多用户权限管理网关。核心基于原生 Node.js 实现反向代理与流量分发，底层无缝调度 Sing-box 代理核心，全面支持 **VLESS / VMess / Trojan / Reality / Hysteria 2** 协议，并集成 **ECH (Encrypted Client Hello)** 与 **ACL4SSR 分流策略库**。

---

## ⚡ 全平台交互式一键部署

在任意全新的 Linux 服务器（支持 **Ubuntu / Debian / Alpine / CentOS / Rocky / Alma / Arch**）终端中执行以下命令（推荐使用 `sh -c "$(curl ...)"` 或 `sh -c "$(wget ...)"` 获得最佳终端交互体验）：

### 1. 官方主干通道
**推荐命令 (curl)：**
```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh)"
```

**推荐命令 (wget)：**
```sh
sh -c "$(wget -qO- https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh)"
```

*也可以使用标准管道执行：*
```sh
curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh | sh
# 或
wget -qO- https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh | sh
```

### 2. 国内 / 阻断地区加速通道 (带 GitHub CDN 镜像)
**加速命令 (curl)：**
```sh
sh -c "$(curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh)"
```

**加速命令 (wget)：**
```sh
sh -c "$(wget -qO- https://ghproxy.net/https://raw.githubusercontent.com/hc990275/nodejs/main/node/install.sh)"
```

---

## 🛠️ 交互式配置说明

运行一键脚本后，向导将自动执行以下流程：

1. **IPv4 自动探测**：无需手动填写，脚本将自动抓取当前服务器真实公网 IPv4。
2. **回溯端口设定**：提示输入回溯监听端口（默认 `21216`，普通 VPS 可设为 `8080`，NAT 鸡填写分配的公网转发端口）。
3. **管理后台密码**：提示输入后台管理员密码（直接回车将自动生成随机高强度密码）。
4. **回溯域名设定**：提示输入 Cloudflare 端口回溯主域名（如 `yylsl.abcai.online`）。**直接回车可跳过**，后续可在 Web 管理后台随时填写或修改，立即热重载生效。

> 💡 **小内存保护**：脚本会自动感知 VPS 物理内存大小（如 128MB / 256MB NAT 鸡），自动注入 `--max-old-space-size=48` 内存隔离保护，杜绝 OOM 崩溃。

---

## 🌐 访问与管理

安装完成后，终端将即刻输出交付凭据：

* **前台用户中心**：`http://<服务器IP>:<端口>/`
* **管理后台入口**：`http://<服务器IP>:<端口>/admin`
* **后台免密直通**：`http://<服务器IP>:<端口>/admin?token=<管理员密码>`
* **全平台自适应订阅**：`https://<回溯域名>/sub?token=<用户UUID>`
  * **v2rayN / Shadowrocket**：自适应返回携带原生 Chrome 指纹与 ECH 配置的 Base64 订阅。
  * **Clash / Mihomo / Clash Verge / Flclash**：自适应返回携带 12 大策略组与 ACL4SSR 规则源的开箱即用 YAML 配置。

---

## 📋 常用运维命令

系统已根据宿主机自动适配开机自启守护：

### 针对 systemd 体系 (Debian / Ubuntu / CentOS / Rocky)
```sh
# 查看运行状态
systemctl status v3-node

# 重启服务
systemctl restart v3-node

# 查看实时日志
journalctl -u v3-node -f -n 50
```

### 针对 OpenRC 体系 (Alpine Linux)
```sh
# 查看运行状态
rc-service v3-node status

# 重启服务
rc-service v3-node restart

# 查看实时日志
tail -f /var/log/v3-node.log
```

### 配置文件修改
* 路径：`/opt/v3-node/.env`
* 支持**毫秒级无感知热重载**，修改并保存 `.env` 即可自动生效，无需重启服务进程。
