# Kata-Node & Lunes Host 融合部署架构 (Sing-Box)

本项目已实现 **大一统环境探测**。核心主脚本 (`index.js`) 能够自动识别当前它运行在哪种服务提供商环境下，并自适应下发不同的代理安装与守护模式，旨在为 Lunes 翼龙面板环境与标准 Linux 虚拟机/VPS 环境提供 **零门槛、零配置** 的极致节点架设体验。

无论是跑在由于权限拉跨、交互受限而导致无限重启的免费虚机里，还是正常的独立云主机上，它都能完美运行。

---

## 🌐 平台快速部署指南

由于不同系统有着完全不同的限制，请根据你所使用的平台属性遵循相应的部署说明。

### 方案 A：在 Lunes Host (或 Pterodactyl 翼龙子面板) 上部署

> **适用场景：只有网页面板控制权，没有/无法使用 Root 命令行终端，不支持交互弹窗输入的容器白嫖环境。**

翼龙面板环境不允许使用交互式输入（不可使用 `read -p`），且默认的容器启动命令通常为 NodeJS。此时脚本会自动探测环境执行 **无交互静默部署模式**。

1. **进入面板**：打开你的 [Lunes Host 面板控制台](https://ctrl.lunes.host/) 或 [KataBump 控制台](https://dashboard.katabump.com/)。
2. **重置状态**：如果你的机器之前因为脚本错误处于 Crash (崩溃) 状态，请先点击 `Kill` 强制死进程。
3. **获取代码**：在面板左侧导航栏进入 **[Files] (文件管理)**。
4. **上传文件**：下载本仓库下的 `index.js` 和 `package.json` 两个核心文件，然后点击面板里的 `Upload` 按钮，将这两个文件上传至服务器主目录 (`/home/container`)。
5. **设置启动指令及变量**：在左侧导航栏进入 **[Startup] (启动设置)** 页面，依据你的不同平台进行精准设置以确保 Node 不会执行错乱：
   - **👉 对于 Lunes Host ([https://ctrl.lunes.host/](https://ctrl.lunes.host/)) **：
     - 在页面上方的 **`STARTUP COMMAND`** 外壳启动命令处填写：`node index.js`
# Kata-Node & Lunes Host 融合部署架构 (Sing-Box)

本项目已实现 **大一统环境探测**。核心主脚本 (`index.js`) 能够自动识别当前它运行在哪种服务提供商环境下，并自适应下发不同的代理安装与守护模式，旨在为 Lunes 翼龙面板环境与标准 Linux 虚拟机/VPS 环境提供 **零门槛、零配置** 的极致节点架设体验。

无论是跑在由于权限拉跨、交互受限而导致无限重启的免费虚机里，还是正常的独立云主机上，它都能完美运行。

---

## 🌐 平台快速部署指南

由于不同系统有着完全不同的限制，请根据你所使用的平台属性遵循相应的部署说明。

### 方案 A：在 Lunes Host (或 Pterodactyl 翼龙子面板) 上部署

> **适用场景：只有网页面板控制权，没有/无法使用 Root 命令行终端，不支持交互弹窗输入的容器白嫖环境。**

翼龙面板环境不允许使用交互式输入（不可使用 `read -p`），且默认的容器启动命令通常为 NodeJS。此时脚本会自动探测环境执行 **无交互静默部署模式**。

1. **进入面板**：打开你的 [Lunes Host 面板控制台](https://ctrl.lunes.host/) 或 [KataBump 控制台](https://dashboard.katabump.com/)。
2. **重置状态**：如果你的机器之前因为脚本错误处于 Crash (崩溃) 状态，请先点击 `Kill` 强制死进程。
3. **获取代码**：在面板左侧导航栏进入 **[Files] (文件管理)**。
4. **上传文件**：下载本仓库下的 `index.js` 和 `package.json` 两个核心文件，然后点击面板里的 `Upload` 按钮，将这两个文件上传至服务器主目录 (`/home/container`)。
5. **设置启动指令及变量**：在左侧导航栏进入 **[Startup] (启动设置)** 页面，依据你的不同平台进行精准设置以确保 Node 不会执行错乱：
   - **👉 对于 Lunes Host ([https://ctrl.lunes.host/](https://ctrl.lunes.host/)) **：
     - 在页面上方的 **`STARTUP COMMAND`** 外壳启动命令处填写：`node index.js`
     - 在下方的 Variables (环境变量) 区域里找到 **`STARTUP COMMAND`** 这个变量框，同样填写：`node index.js`
   - **👉 对于 KataBump ([https://dashboard.katabump.com/](https://dashboard.katabump.com/)) **：
     - 确保页面上方的 **`Startup Command`** 显示为（或修改为）：`node /home/container/index.js`
     - 在下方的 Variables 区块中找到 **`JS FILE`** 框，并填写：`index.js`。（如果有 ADDITIONAL NODE PACKAGES 留空即可）
6. **一键启动**：回到 **[Console] (控制台)**，点击 **Start(启动)**。脚本一旦检测到自己在支持的面板上，就会全自动加载静默模式，截获系统给你分配的安全端口，并且跳过多余的问卷调查，建立进程看护守护程序。

🎉 部署完成后，控制台中会直接为你打出以 **`Lunes-TUIC`** 和 **`Lunes-vless`** 命名的双协议节点导入链接！

---

### 方案 B：在 Kata-Node 或普通云服务器 (VPS/VM) 上部署

> **适用场景：你可以通过 SSH / 完整 Console 直连控制的正常 Linux 轻量云服务器环境。**

脚本会探测不到 Lunes 被阉割的环境变量，自动切换进入 **Kata-Node 纯 Bash 接管交互式安装模式**。

你只需要通过 SSH 登录进你的服务器，复制下方的一键命令敲下回车即可：

```bash
mkdir -p kata-node && cd kata-node
curl -O https://raw.githubusercontent.com/hc990275/nodejs/main/package.json
curl -O https://raw.githubusercontent.com/hc990275/nodejs/main/index.js
npm install && npm start
```

1. 该步骤拉取本仓环境以后，检测到常规环境会自动开始**对接底层云端一键构建链路**。
2. 随后终端屏幕上会跳出提示：`请输入您想要的端口号:`，输入你想绑定的本地节点工作口即可。
3. 等待内核与证书拉取完毕，即部署成功并在屏幕打印节点分享代码。该平台支持 Crontab 的自动防崩溃接管保护。

---

## 🎯 双平台大一统特性

- 💥 **智能环境嗅探**：原生支持检测 `P_SERVER_UUID` 等翼龙独占环境变量，能够从底层隔离控制进程环境的分叉。
- 💥 **端口智能抓取并容灾跳水**：支持读取容器提供商动态注入的 `SERVER_PORT` 环境。能在像 Lunes 极少数发生 `-1` 空映射灾难时容灾跳回 `8080` 原生工作口。
- 💥 **内置 Sing-Box 新架构引擎**：抛弃了 Xray Websocket (WS) 发出过时警告与封锁频发的老旧底座；全面部署了穿墙生存率最高的双引擎技术池：支持 UDP 发流最优选的 **`TUIC` v5（搭载 H3/BBR）**，和基于最强底层重组协议 `xtls-rprx-vision` 发包封装的 TCP **`VLESS-Reality`** 流控技术。
- 💥 **防崩溃自拉起技术守护**：对于方案 A，内联了 `spawn` 子进程循环监测死循环。主节点（母鸡）被暂时阻绝也不会造成你在面板端的挂起进程被无辜干掉。

---

## 🛡️ 安全合规说明

- 根据信息架构与开发规范，系统脚本内只用开源加密规则，无需也不含任何高危私人服务端认证密钥。
- 此脚本功能定性为开发网路试验的结构验证辅助。基于某些云端主机提供方的平台风控协议可能引发你的账户冻结，由此带来的相关删鸡（宕出云层）责任请在使用前自行评判接受。我们仅建议此部署用于紧急冗余网络的探索补充。

---

## 📝 版本更新日志 (Changelog)

### v4.1.0 (2026-03-09)
* **feat**: 放弃复杂的平台探测逻辑，改为全平台大一统 Scheme A (自动面板流) 部署模式。
* **feat**: 统一节点命名规范为 `hc990275-TUIC` 和 `hc990275-vless`。
* **style**: 移除冗余的 Scheme B 交互模式代码，实现极致瘦身。

### v4.0.3 (2026-03-09)
* **fix**: 增强了平台探测的健壮性（改为不区分大小写检查），并添加了 `[DEBUG]` 启动日志以辅助定位环境识别问题。

### v4.0.2 (2026-03-09)
* **fix**: 实现了基于 `P_SERVER_HOSTNAME` 的动态平台前缀检测。
* **feat**: 彻底解决了 Katabump 与 Lunes Host 节点名称混淆的问题，现在脚本能自动识别运行平台并下发正确的 `kata-` 或 `Lunes-` 前缀。

### v4.0.1 (2026-03-09)
* **fix**: 修复了 `Lunes` 环境下模板字符串反引号未闭合导致的 `Unexpected identifier 'bash'` 语法错误。
* **feat**: 区分了不同宿主机环境的节点名称，现在 `Kata-Node` 环境下生成的节点名统一定义为 `kata-TUIC` 和 `kata-vless`，`Lunes` 为 `Lunes-TUIC` 和 `Lunes-vless`。
