# VPS-Backtrack: Pure Native Node.js VLESS Port-Backtrack & Wetest Engine for NAT VPS (开源分享版)

## 📖 项目简介
本系统是专为入门级 NAT VPS（128MB ~ 512MB RAM、共享端口映射）打造的高性能纯原生代理网关。
彻底摆脱第三方隧道客户端，采用 Cloudflare Origin Rules（源服务器规则）端口回溯机制，实现零隧道损耗、直连与 CDN 优选双轨并行。

## 🚀 核心特性
*   **0 外部依赖**：纯 Node.js 原生标准库，常驻内存仅 25MB~32MB，杜绝 OOM。
*   **Cloudflare 端口回溯**：客户端连接 443 优选 IP，Cloudflare 边缘节点根据 Origin Rules 自动回溯到 NAT 机器公网端口。
*   **微测网三网优选池**：动态清洗电信、联通、移动官方高质量 IP。
*   **交互式向导**：重新部署自动感知已有 `.env`，回车即可沿用。

## 📦 一键安装与部署
```sh
curl -fsSL https://raw.githubusercontent.com/example/nodejs/main/vps-backtrack/setup.sh | sh
```

## ⚙️ Cloudflare Origin Rules 配置说明
1. 进入 Cloudflare 域名控制台；
2. 菜单：**Rules ➔ Origin Rules ➔ Create rule**；
3. Rule name: `vps-backtrack`；
4. When incoming requests match: **Hostname equals `backtrack.example.com`**；
5. Action: **Rewrite to... ➔ Port ➔ 填入分配给你的 NAT 公网端口 (如 `19900`)**；
6. 保存即可。
