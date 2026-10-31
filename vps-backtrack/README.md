# VPS-Backtrack: Linux NAT VPS 纯原生 Node.js VLESS 端口回溯与微测网优选中枢 (自用版)

## 一、项目架构与设计指标
*   **适用环境**：128MB ~ 512MB RAM 的 NAT VPS（共享 IPv4 / 端口映射型小鸡）。
*   **核心特性**：
    1. **摆脱 Cloudflare 隧道**：彻底移除 `cloudflared` 二进制与进程开销，常驻内存仅 25MB~32MB。
    2. **Cloudflare 端口回溯 (Origin Rules)**：客户端请求 443 优选 IP，Cloudflare 边缘节点根据 Hostname 自动将请求重写并回溯至 NAT 机器的外部公网端口（`PUBLIC_PORT`）。
    3. **微测网（wetest.vip）三网优选池**：电信 CT / 联通 CU / 移动 CM 官方动态优选清洗池完整继承。
    4. **全端自适应订阅**：Clash YAML / Sing-box JSON / Surge / Quantumult X / Base64 通用池。
    5. **Element UI 扁平明亮前后台**：手机/电脑完全自适应，弹窗防截断。

## 二、一键安装与交互引导
```sh
curl -fsSL https://raw.githubusercontent.com/hc990275/nodejs/main/vps-backtrack/setup.sh | sh
```
*   **新部署/重部署检测**：脚本自动检测 `.env` 中已配置的值；按回车（Enter）直接沿用已有值，无需重复输入。

## 三、Cloudflare Origin Rules 配置速查
1. 登录 Cloudflare 控制台，进入域名（如 `3xui.995677.xyz` 或你的专属 CDN 域名）；
2. 点击左侧菜单：**规则 (Rules) ➔ 源服务器规则 (Origin Rules)** ➔ 点击【创建规则】；
3. 规则名称：`vps-backtrack`；
4. 匹配条件：**主机名 (Hostname) 等于 `你的CDN域名`**；
5. 目标操作：**重写到... (Rewrite to...) ➔ 端口** 填入你的 NAT 外部映射公网端口（例如 `19900`）；
6. 保存生效！客户端所有通过 443 优选 IP 的连接将自动直通 NAT 机器。
