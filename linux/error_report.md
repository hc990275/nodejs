# 踩坑与经验沉淀报告 (Error Tracking)

---

### 问题一：数据库空文件启动异常 (Unexpected end of JSON input)
- **现象**：当 `users.json` 文件存在但字节数为 0（空文件）时，服务启动抛出 `[Database] 数据库读取异常，重置存储: Unexpected end of JSON input` 并重置数据。
- **原因**：`fs.readFileSync` 得到空字符串，直接执行 `JSON.parse("")` 触发原生语法解析异常。
- **方案**：在 `loadUsers()` 载入时，先使用 `.trim()` 检查非空白字符长度，仅在长度大于 0 时才调用 `JSON.parse`，否则直接安全兜底初始化为空数组。

---

### 问题二：节点链接 Fragment 编码导致客户端展示乱码
- **现象**：部分通用订阅客户端（如 v2rayN、Shadowrocket）解析节点列表时，节点名称出现 `%E7%9B%B4%E8%BF%9E` 等 URL 编码字符串。
- **原因**：节点链接生成中对 `#` 后的名称进行了 `encodeURIComponent`，而标准客户端在解析 URI Fragment 时直接将其按原始 UTF-8 字符串渲染。
- **方案**：取消对 Fragment 节点名称的强制 URI 转义，保持中文与标识名称原生输出。

---

### 问题三：历史存量用户非法时间戳导致后台崩溃 (RangeError: Invalid time value)
- **现象**：在翼龙面板环境下访问后台 `/admin` 时，Node.js 服务立即崩溃退出：
  `RangeError: Invalid time value at Date.toISOString (<anonymous>)`。
- **原因**：`users.json` 中某些存量用户的 `expireTime` 为 0、负数、null、NaN 或非标准格式，直接调用 `new Date(u.expireTime).toISOString()` 触发 V8 原生范围异常抛错，导致主进程死亡。
- **方案**：封装 `formatExpireDate(expireTime)` 防御函数，严格校验有效数值；遇到 0 或非法时间戳统一安全回退并渲染为“永久有效”，杜绝在非法日期对象上调用 `.toISOString()`。

---

### 问题四：HTTP/直接IP访问时“复制”按钮全部失效
- **现象**：在浏览器中点击前台“复制常规”、“复制 Clash”或后台“复制订阅”按钮时毫无反应，且无弹窗。
- **原因**：现代浏览器（Chrome、Edge 等）的安全策略规定：`navigator.clipboard` 仅在“安全上下文”（HTTPS 或 localhost）下开放。当用户通过 HTTP IP 地址（如 `http://51.75.118.169:20231`）访问时，`navigator.clipboard` 为 `undefined`，调用直接触发 `TypeError` 异常阻断执行。
- **方案**：编写全平台兼容复制引擎 `safeCopy(text)`：
  1. 优先检测 `navigator.clipboard && window.isSecureContext`，支持异步现代复制；
  2. 降级通过动态隐藏 `textarea` 执行 `document.execCommand("copy")`，确保在任何纯 HTTP、移动端浏览器及直接 IP 环境下 100% 复制成功；
  3. 引入全局微交互浮动 Toast 提示组件，提升交互质感与反馈明确性。

---

### 问题五：Alpine 3.22 (alpine322) 容器自愈与 ARM64/aarch64 部署
- **现象**：在 Alpine 3.22 极简容器（ARM64/aarch64 架构）环境下拉起时，基础工具链缺少 `ca-certificates`，导致 curl HTTPS 证书校验失败；且变量重构为 `DATA_DIR` 后启动日志末尾仍有一处残留别名调用。
- **原因**：Alpine 容器极端精简未内置完整 CA 根证书包；变量置顶重构时兼容别名需双向绑定。
- **方案**：
  1. 在置顶初始化中引入 `defaultDataDir = DATA_DIR` 双向兼容；
  2. 编写 `ensureAlpineEnvironment()` 自适应环境探测引擎，初次启动自动执行 `apk add --no-cache ca-certificates` 等工具链；
  3. 针对 `process.arch === "arm64"` 自动匹配 `sing-box-*-linux-arm64.tar.gz` 纯静态二进制，完美兼容 musl libc。

---

### 问题六：多端口协议矩阵与彻底禁用隧道架构
- **现象**：用户要求不开启 Cloudflare Argo 隧道，直接通过公网 IP 与独立连续映射端口（10800~10806）运行 Hysteria 2、TUIC、Reality 等前沿协议；启动时因缺少 openssl 工具导致 TLS 自签证书生成受阻。
- **原因**：Alpine 极简镜像未默认附带 openssl 二进制，导致基于 QUIC 的 Hy2 与 TUIC 无法读取证书。
- **方案**：
  1. 在 `ensureAlpineEnvironment()` 工具链中补充安装 `openssl`；
  2. 封装 `ensureMultiProtocolSecrets()` 自动生成自签证书、Reality 密钥对与 SS2022 强随机密钥；
  3. 将 `isTunnelAvailable` 与 `cloudflared` 执行入口彻底短路禁用，实现 100% 纯公网直连多协议分流。

---

### 问题七：Hysteria 2 端口跳跃 iptables 自动化与客户端跨协议兼容
- **现象**：在 Alpine 容器环境中配置专属 UDP 端口跳跃（10900-10909）以抵御运营商长时间大流量 UDP QoS 限速时，缺少 iptables 工具链，且旧规则易在重启后残留堆叠。
- **原因**：容器初次启动无 iptables 软件包；nat 表重定向规则若不执行幂等清理会产生冗余链。
- **方案**：
  1. 将 `iptables` 纳入 `ensureAlpineEnvironment()` 自动安装列表；
  2. 编写 `applyHy2PortHoppingRules()` 实现前置幂等 `-D` 清理与自动 `-A PREROUTING -p udp --dport 10900:10909 -j REDIRECT --to-ports 10800` 重定向；
  3. 在客户端订阅生成中双轨并行：同时输出单端口固定节点与全自动端口跳跃节点（Clash Meta `ports: 10900-10909` 与 URI `mport=10900-10909`），用户客户端更新订阅即可零配置享受跳跃防限速特性。

---

### 问题八：v2rayN 客户端解析 Hysteria 2 端口跳跃 URI 导致节点丢失
- **现象**：服务端生成了 Hy2 跳跃节点，但用户在 v2rayN 中更新订阅后，列表中只看得到固定单端口节点，跳跃节点静默丢失。
- **原因**：初始 URI 拼接中直接将主机与端口写为了 `server:10900-10909`。v2rayN 使用 .NET 标准 URI 解析器（`Uri.Port`），端口字段包含中划线时抛出格式异常，导致 v2rayN 静默跳过该节点。
- **方案**：
  1. 将 URI 的主端口设定为区间首端口整数（如 `server:10900`）；
  2. 将跳跃区间通过参数 `?mport=10900-10909&ports=10900-10909` 双参数传递；
  3. v2rayN 成功兼容解析，并在节点属性的“跳跃端口范围”中全自动识别并填充 `10900-10909`。

---

### 问题九：站点运营与注册配置重启后恢复默认值 (Settings Persistence Reset)
- **现象**：在后台管理面板“站点运营与注册配置”中修改试用天数、流量配额或客服联系方式并保存后，服务重启或 VPS 重启后立即恢复为默认数值（3天、10GB、@robberer）。
- **原因**：
  1. `saveSettings()` 采用了异步 Promise 写入队列（`safeWriteFileAsync`），在服务重启、`kill -9` 或进程退出时未执行同步落盘（flush），导致磁盘文件未写入或被中断；
  2. `startV3Service()` 内部在传入自定义 `dataDir` 时遗漏了对 `SETTINGS_FILE` 和 `CLIENT_DOWNLOADS_FILE` 的重定向，导致文件路径可能存在错位；
  3. 前端保存请求未显式携带 Token，且 `adminSessions`（内存 Map）在进程重启后丢失，导致保存请求在鉴权边界被静默 401 拦截。
- **方案**：
  1. 将 `saveSettings()` 重构为 **`fs.writeFileSync` 同步原子落盘引擎**，写入完成后即刻返回并输出落盘日志；
  2. 强化 `checkAdminAuth()` 支持多重鉴权（Cookie `v3_admin_token`、Header `x-admin-token`、Bearer Token、Query Token）；
  3. 前端保存配置时在 URL 与 Header 双重附加管理员凭据，且每次点开设置弹窗时均强制拉取服务端真实落盘数据，彻底杜绝数据回滚。

---

### 问题十：魔戒机场级商业化前后台与用户控制台重构 (Airport Architecture Transformation)
- **现象**：原有主页仅为一个单一简单的登录框，缺少专业机场的套餐体系、技术优势、节点网络总览、一键导入与用户控制台，无法满足商业化“机场”运营需求。
- **原因**：此前设计定位为单机节点中转面板，未建立多维度套餐方案与魔戒风格（多平台一键导入、流量进度监控、侧边栏导航）的完整机场交互链路。
- **方案**：
  1. **官网 Landing Page**：基于 Element UI 简约高颜值商务扁平风格，打造包含品牌 Header、Hero 专线特性、三级套餐计划（体验/月付/年付）、四大核心技术优势、实时节点网络矩阵、Telegram 客服与登录/注册弹窗的商业机场官网；
  2. **用户控制台 Dashboard**：引入魔戒风格 Sidebar 侧边栏导航，三格统计卡片（高精度流量进度条、时效倒计时、在线连接说明）、四大一键导入（Clash / Shadowrocket / v2rayN / 扫码二维码）、全部 11 个专线节点状态矩阵与各操作系统客户端推荐下载；
  3. 彻底修复前台登录刷新即清除会话的缺陷，实现标准 30 天持久免密登录。

---

### 问题十一：管理后台数据未渲染与单体架构解耦拆分 (Admin Data Stuck & Modular Decoupling)
- **现象**：访问管理后台 `/admin` 时，页面卡在“正在载入用户数据...”与“正在计算...”，无法读取和渲染用户表格；同时原 `index.js` 超过 320KB 过于庞大臃肿，逻辑混杂难以维护。
- **原因**：
  1. **模版字符串语法崩溃**：在 Node.js 模版字面量中拼接前端脚本时，`alert("...\\n...")` 中的 `\n` 未经二次转义被求值为物理硬换行，导致客户端浏览器在解析双引号字符串时触发未捕获的 `SyntaxError: Invalid or unexpected token`，中断了主脚本生命周期，使 `renderTable()` 永远无法被执行；
  2. **生命周期触发时序**：旧版 `renderTable()` 仅在后续心跳轮询成功时触发，缺乏 `DOMContentLoaded` 立即渲染机制；
  3. **单体代码膨胀**：主页、用户控制台、管理后台界面、API 路由与底层多协议隧道全部揉在 `index.js`，任何局部改动都极易造成偶发语法污染。
- **方案**：
  1. **语法与生命周期修复**：修正 `views/admin.js` 中所有双引号字符串内的换行转义，在页面初始化挂载 `DOMContentLoaded` 即刻主动调用 `renderTable()` 与 `fetchVisitors(true)`，实现打开后台 0 毫秒立即渲染；
  2. **模块化目录重构**：将整个 UI 视图层解耦拆离至独立目录 `views/`：
     - `views/landing.js`：商业官网与套餐介绍视图；
     - `views/dashboard.js`：魔戒风格用户控制台视图；
     - `views/admin.js`：Element UI 高效运维管理后台视图；
  3. **主入口架构精简**：`index.js` 瘦身至纯净的路由分发与网络服务内核控制器，各页面按需加载，维护与扩展效率大幅提升。

---

### 问题十二：首页路由拦截与登录会话死锁 (Cookie Required to Clear for Login Issue)
- **现象**：用户在浏览器中只要登录过一次，之后重新打开网站或输入 `/?action=login` 时，页面无法看到登录弹窗与官网首页，必须手动清空浏览器 Cookie 才能重新打开登录页面。
- **原因**：
  1. **首页被控制台挟持**：原路由逻辑中将根路径 `/` 与 `/dashboard` 混在一起，如果检测到请求头带有有效 `session_token`，就直接调用 `renderDashboard()` 渲染用户控制台，导致已登录用户永远无法访问官网主页与登录弹窗；
  2. **缺乏账号切换通道**：用户想更换账号测试或新注册时，因被强行拦截进控制台而产生“必须清除 Cookie 才能进登录页”的卡死感；
  3. **登出逻辑不规范**：旧版 `/logout` 仅设置了 `Max-Age=0`，未同步清理服务端 `activeSessions` 内存 Map，且缺少 `Expires=Thu, 01 Jan 1970` 与 `SameSite=Lax` 兼容指令。
- **方案**：
  1. **职责分离**：根路径 `/` 永远渲染商业官网 `renderLandingPage`，绝不强行拦截到控制台；
  2. **智能状态感知**：官网主页传入当前登录态 `currentUser`：
     - 若已登录：顶部与 Hero 区域智能切换为“进入控制台 (用户名)”与“退出”按钮，且登录弹窗支持直接输入新账号密码无感覆盖登录或一键退出，无需清理任何 Cookie；
     - 若未登录：展示标准的“控制台登录”与“免费注册”按钮；
  3. **控制台独立鉴权**：仅在访问 `/dashboard` 或 `/user` 时校验登录态，未登录 302 跳转至 `/?action=login`；
  4. **全标准登出**：在 `/logout` 中增加服务端 `activeSessions.delete()`，并下发跨浏览器标准的彻底失效 Cookie，重定向回 `/?action=login`。

---

### 问题十三：多 Linux 发行版环境自适应架构演进 (Multi-Distro Adaptive Linux Architecture)
- **现象**：此前脚本深度绑定 Alpine Linux（使用 `apk` 与 OpenRC），在主流 Ubuntu 20.04/22.04/24.04、Debian 或 CentOS/Rocky 环境下直接运行报错（如 `command not found: apk`，或缺少 systemd 单元文件无法开机自启）。
- **原因**：不同 Linux 发行版的包管理器（Debian/Ubuntu 的 `apt-get`、Alpine 的 `apk`、CentOS/Rocky 的 `dnf/yum`、Arch 的 `pacman`）、Init 守护系统（现代 Linux 的 `systemd` 与极简容器的 `OpenRC`）存在本质架构差异。
- **方案**：
  1. **独立版本工程化**：在 `d:\DeskTop\GitHub\测\lunes\自适应机场` 建立全新的自适应版本，保持与 Alpine 版本的独立隔离；
  2. **智能发行版与架构感知**：在 `index.js` 与 `start.sh` 中动态解析 `/etc/os-release`，自适应判断发行版族系（Ubuntu / Debian / Alpine / RHEL / Arch），匹配专用包管理器自动安装缺失的 Node.js 与核心工具链；
  3. **双轨开机自启守护**：配套编写针对 Ubuntu/Debian/CentOS 的 `v3.service` (systemd) 与针对 Alpine 的 `v3.openrc` (OpenRC)，并封装 `install_service.sh` 实现一键智能探知并注册为系统服务；
  4. **容器与文档双写交付**：提供基于 Ubuntu 24.04 LTS 的标准 Dockerfile，并同步交付自用版 `README.md` 与开源分享版 `README_SHARE.md`。




