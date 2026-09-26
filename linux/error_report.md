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

---

### 问题十四：直连协议流量穿透盲区与 Sing-box Clash API 轮询集成 & 后台变量可视化改造
- **现象**：用户在客户端（如 Clash）跑了 1GB 以上大流量，后台“全站已用总流量”和“用户流量消耗”一直定格在 `12.93 KB` 不动，且“实时在线感知”显示“离线 (1小时前)”。同时在初次安装部署时，脚本需手动敲大量协议端口，交互过于繁琐。
- **原因**：
  1. **流量链路盲区**：系统原先只有 WebSocket 协议（`直连-VLESS/VMess/Trojan`）走 Node.js 的主服务端口（19900），由 Node.js 套接字直接统计流量；而高性能直连协议（`Hysteria 2`、`TUIC v5`、`VLESS-Reality`、`SS` 等）全部由底层的 Sing-box 核心在独立端口直接监听并响应，完全绕过了 Node.js，且 Sing-box 未开启统计接口；
  2. **客户端策略跳跃**：Clash 的 `🚀 节点选择` 策略组默认启用了 `url-test (自动优选)`，因 Hysteria 2 / TUIC / Reality 延迟极低，客户端瞬间切到了直连协议，导致后续流量全部走 Sing-box 独立端口跑掉，Node.js 毫无感知；
  3. **安装交互冗余**：命令行安装脚本逐项询问 8 组协议端口，缺少一键跳过并在后台可视化配置的通道。
- **方案**：
  1. **Sing-box Clash API 深度集成**：在 Sing-box 核心配置中注入 `experimental.clash_api`，监听本地内部端口 `127.0.0.1:19090`；
  2. **毫秒级增量差值流量轮询引擎**：Node.js 开启每 5 秒的异步轮询，通过 `GET /connections` 读取所有活跃连接的累计上传与下载，通过连接 ID 差值算法精准计算增量流量（delta），过滤内部 WS tag 避免双重计费，精准匹配用户并累加至 `trafficUsed`，同步刷新用户在线状态感知与使用者真实 IP；
  3. **超额断流联动**：当通过直连协议跑超限额时，立即触发 `safeReloadSingbox()` 重新生成配置并安全断流；
  4. **安装脚本极速模式**：在 `setup.sh` 增加极速秒装模式（默认），仅需指定主端口即可极速拉起，跳过所有协议端口；
  5. **管理后台全量参数控制中心**：在 `views/admin.js` 升级设置弹窗为三大 Tab（运营与注册、节点协议与端口、网络与域名穿透），支持在 Web 界面自由开启/禁用协议、修改端口、配置 Reality 伪装域名与 Argo 参数，保存后自动原子落盘至 `.env` 并触发 Sing-box 平滑热重载。

---

### 问题十五：一键随机/轮换 UUID 架构与 Element UI 现代微质感管理后台全面重构
- **现象**：
  1. 用户需要频繁为账号更换或新建随机 UUID，原后台只能手动输入或编辑密码，无法一键换密钥并立即踢掉旧长连接；
  2. 既有管理后台页面风格较为粗糙、老旧，采用了突兀的纯色条（`::before`），缺少现代 Web 后台（Admin Dashboard）的通透感、数据胶囊进度条与微交互体验。
- **原因**：
  1. 原设计中用户的 `uuid` 仅在初次注册时生成，缺少动态轮换凭据的独立后端端点与前端操作触发器；
  2. 原样式缺乏 Element UI 现代设计系统的规范约束，统计卡片和表格列表信息密度过低且没有图形化视觉锚点。
- **方案**：
  1. **UUID 架构与即时热生效**：新增 `POST /admin/api/rotate-uuid` 接口，支持指定或使用纯原生 `crypto.randomUUID()`（标准 RFC 4122 v4）随机换新。执行后自动迁移存量连接记录至新键，并立即触发 `safeReloadSingbox()` 重新生成 Sing-box 核心配置并热重载，旧 UUID 的长连接被瞬间强制阻断，旧订阅链接即刻失效；
  2. **新增与编辑弹窗深度集成**：`addModal` 默认自动随机生成 UUID 并提供【🎲 随机生成】按钮；`editModal` 暴露只读 UUID 输入框并提供【🎲 随机换新UUID】按钮与危险风险提示；
  3. **表格快捷操作**：用户主体列加入等宽微徽章、一键复制图标 📋 以及 🎲 快速轮换按钮；操作栏新增醒目的【🎲 换UUID】操作；
  4. **Element UI 扁平明亮视觉重塑**：
     - 背景统一为 `#f0f2f5`，卡片为纯白 `#ffffff` 配浅灰细边框 `#dcdfe6` 与微阴影；
     - 4 个数据看板彻底摒弃左侧老旧色条，升级为现代微彩色底的圆角 SVG 图标徽章（用户组、安全护盾、网络雷达、流量水波）加右侧统计数值的看板架构，带有轻微悬浮微动效；
     - 流量消耗列引入胶囊进度条（Element UI 风格），根据消耗百分比智能变色（正常为蓝、超 85% 为橙、超 100% 变红），数据状态一览无余。

---

### 问题十六：Shadowsocks 2022 多用户隔离模式改造与 Socks5 协议全面清理
- **现象**：
  1. 用户在管理后台将某账号设为到期或停用后，其他协议均无法连接，但客户端保存的 Shadowsocks 2022 节点依然可以正常握手连通；
  2. 系统内部残留的未加密 Socks5 代理已不再需要，存在端口暴露与配置冗余。
- **原因**：
  1. 原设计中 Shadowsocks 2022 仅配置了服务端全局单一共享密钥 `ssSecretState`，没有将鉴权与单用户的到期状态绑定；
  2. 客户端一旦导入全局密码，即便账号到期，因端口依然开放且密钥有效，核心直接放行数据包；
  3. Socks5 代理不带 TLS 且易被阻断，属于非必要协议。
- **方案**：
  1. **SS2022 多用户专属密钥模式**：基于 `crypto.createHash("sha256").update(uuid + ":ss2022")` 算法，为每个用户确定性派生出 16 字节（128-bit）标准的 Base64 专属 UserKey；
  2. **Sing-box 动态装载**：在 Sing-box 的 `ss-in` inbound 中注入 `users: activeUsers.map(...)`。当用户到期或被阻断时，该用户的 Key 立即被移出 `users` 列表，热重载后客户端使用该用户的专属凭据将被 Sing-box 立即拒绝握手（Auth Failure），彻底解决过期仍能连通的问题；
  3. **订阅输出格式适配**：客户端配置输出标准 Shadowsocks 2022 多用户凭据 `${ServerKey}:${UserKey}`，完全兼容 Clash Meta / Mihomo、Sing-box、Shadowrocket 等主流客户端；
  4. **彻底移除 Socks5**：下线全链路的 Socks5 监听、Sing-box 入站、订阅分发及管理后台配置控件，保持架构极简与纯粹。

---

### 问题十七：客户端模板字符串换行符转义缺失导致 SyntaxError 阻断弹窗与全局交互
- **现象**：在后台页面中，点击【实时访客IP监控】、【站点与注册配置】、【+ 新增用户授权】等任何操作按钮均无任何响应，弹窗无法弹出。
- **原因**：在 `views/admin.js` 的 `quickRotateUuid` 函数中，`confirm("...\\n• ...")` 提示文本中使用了单斜杠 `\n`。由于整个 HTML 页面是通过 ES6 模板字符串（反引号 ``）由 Node.js 渲染的，模板解析时将 `\n` 直接解释为物理换行符嵌入到了前端生成的 `<script>` 双引号字符串中，导致浏览器 V8 解析 JavaScript 遇到非法换行 token，抛出 `SyntaxError: Invalid or unexpected token`。这直接阻断了整个客户端脚本的执行，导致所有绑定在 window 上的模态框函数未挂载。

---

### 问题十八：后台配置 Cloudflare Argo 隧道后订阅无优选节点且进程未热启动
- **现象**：在管理后台【站点与网络配置】->【网络与穿透】中填入了 `ARGO_DOMAIN`（隧道域名）和 `ARGO_TOKEN`（隧道凭证）并保存成功后，重新获取或刷新客户端订阅链接，节点列表中依然只有直连节点，没有生成任何 Argo 优选穿透节点（如 `优选-VLESS`、`优选-VMess`、`优选-Trojan`）。
- **原因**：
  1. **全局可用性标记被硬编码定格**：在 `index.js` 启动加载阶段，`let isTunnelAvailable` 被硬编码设置为了 `false`，未跟随 `ARGO_TOKEN` 和 `ARGO_DOMAIN` 进行动态求值；
  2. **后台保存 API 遗漏变量刷新**：管理员在后台调用 `POST /admin/api/settings` 保存时，后端仅更新了 `ARGO_DOMAIN` 和 `ARGO_TOKEN` 字符串并写入 `.env`，**完全没有重新计算 `isTunnelAvailable`**。导致正在运行的服务内存中 `isTunnelAvailable` 始终定格为 `false`；
  3. **订阅构建拦截阻断**：在订阅节点生成函数 `getNodesForUser()` 中，优选穿透节点的生成受 `if (isTunnelAvailable)` 条件保护。因为该值为 `false`，直接跳过了穿透节点的组装，导致客户端订阅中始终无法呈现；
  4. **进程与监听服务未热拉起**：原代码中的 `initAndStartCloudflared()` 头部存在早期调试遗留的硬编码 `return;`，且配置保存后未联动热拉起 `cloudflared` 二进制守护进程与本地 `PORT_TUNNEL (8001)` Ingress 端口服务。
- **方案**：
  1. **内存动态响应重算**：在 `index.js` 初始化时将 `isTunnelAvailable` 恢复为标准动态布尔值 `Boolean(ARGO_TOKEN && ... && ARGO_DOMAIN && ...)`；
  2. **设置保存热触发联动**：在 `/admin/api/settings` 保存逻辑中增加动态重算判断。一旦检测到隧道配置填入或修改，立即自动重置 `isTunnelAvailable` 状态；
  3. **全链路进程与端口热生命周期管控**：
     - 若配置有效：自动调用 `initAndStartCloudflared()` 热拉起 `cloudflared` 守护进程并启动本地 8001 端口流量接收器；
     - 若配置清空：自动调用 `stopCloudflared()` 和 `stopTunnelServer()` 平滑释放子进程与端口；

---

### 问题十九：Argo 隧道实时在线状态看板与多优选 CDN 域名/IP 矩阵订阅分发集成
- **现象**：
  1. 管理员在后台配置 Argo 隧道后，无法直观确认 cloudflared 核心守护进程是否启动、PID 为多少、是否已成功向 Cloudflare 边缘注册心跳，缺乏可视化排障抓手；
  2. 既有优选域名（`OPTIMIZED_DOMAIN`）仅支持单个域名，无法同时配置多个优选域名或优选 IP，导致客户端无法按不同地区/运营商线路测速挑选最佳接入点。
- **原因**：
  1. `cloudflared` 进程采用 `inherit` 模式运行，Node.js 内存中未捕获其控制台日志输出流，且后台缺乏轮询隧道运行状态的专用数据接口与前端展示看板；
  2. `getNodesForUser` 仅对单个 `OPTIMIZED_DOMAIN || ARGO_DOMAIN` 进行了节点装配，未支持多行/多地址列表解析。
- **方案**：
  1. **守护进程输出流解析与状态状态机**：
     - 将 `cloudflared` 子进程输入输出改为 `pipe` 模式，实时逐行捕获 stdout/stderr 输出流；
     - 维护全局 `tunnelStatusState` 对象，记录 PID、运行状态（`stopped` / `starting` / `connected` / `error`）、Connector ID、心跳时间戳及最近 30 条核心日志；
     - 智能正则匹配 `Registered tunnel connection` / `connected to` 等边缘注册成功标志，将状态机置为绿色 `connected`；
  2. **状态接口与看板控件**：
     - 提供 `GET /admin/api/tunnel-status` 及在 `/admin/api/settings` 中集成状态数据；
     - 在管理后台【网络与穿透】Tab 顶部构建精美 Element UI 风格看板，包含动态状态徽章（绿/橙/红/灰）、核心 PID、实例 ID、绑定域名及暗色高反差 Consolas 终端日志框；
     - 切换至该 Tab 时自动开启 3 秒轻量轮询，离开时立即停止定时器，降低服务端负载；
  3. **多优选 CDN 域名与 IP 矩阵订阅生成**：
     - 将后台输入控件升级为多行文本框 `textarea`，支持配置多个优选域名或 IP（支持换行、空格、逗号或分号分隔）；
     - 订阅生成引擎在生成优选节点时，自动遍历所有优选地址，按 `优选1-VLESS [地址]`、`优选2-VLESS [地址]` 矩阵化展开，方便客户端本地并发测速与择优连接。

---

### 第三十号：256MB 极小 VPS / 容器 CPU 85% 与内存 209MB 深度调优及全面剥离隧道
- **问题现象**：
  在 1 核 CPU / 256 MB 内存的 VPS 或翼龙面板容器中运行时，CPU 经常飙升到 85%，内存常年居于 209 MB / 256 MB（占用率 81.7%），濒临 OOM 崩溃边缘。
- **原因剖析**：
  1. **多重后台进程并发吃光内存**：未加限制的 Node.js V8 堆内存默认占用 60~90MB，Go 编写的 Sing-box 占用 40~50MB，Go 编写的 Cloudflared 占用 30~40MB，加上系统基础栈 50MB，在 256MB 环境下直接达到 209MB 极限；
  2. **内存见顶触发 V8 频繁全量垃圾回收 (Full GC)**：空闲内存不足 40MB 时，Node.js 频繁执行单线程全量 GC，直接打满单核 CPU；
  3. **高频连接与流量轮询 (5 秒)**：`pollSingboxClashApiTraffic` 每 5 秒轮询并解析 Clash API 大 JSON，持续冲击单核 CPU；
  4. **Cloudflared 隧道维护开销**：隧道在后台维持 4 条 QUIC/HTTP2 连接，持续产生网络心跳与内存常驻。
- **实施解决对策**：
  1. **Node.js 堆内存严格限额**：
     - 在 `start.sh`、`v3.service`、`v3.openrc` 与 `package.json` 中统一注入 `--max-old-space-size=64`，将 Node 堆内存限制在 64MB 以内；
  2. **Go Runtime 激进回收**：
     - 在启动脚本和服务环境变量中注入 `GOMEMLIMIT=40MiB` 和 `GOGC=20`，并在 `index.js` spawn Sing-box 时强制继承该环境变量，将 Sing-box 内存压制在 40MB 以内并加快 GC；
  3. **流量统计轮询间隔削减 75%**：
     - 将 `setInterval(pollSingboxClashApiTraffic, 5000)` 放宽至 `20000` (20 秒)，消除周期性 CPU 脉冲峰值；
  4. **彻底剥离所有隧道依赖**：
     - 拔除 `initAndStartCloudflared` 进程与自动下载、移除 8001 端口监听；
     - 移除后台 Argo 隧道监控看板与设置项，订阅全面走高性能原生直连，立省 35MB+ 内存！

---

### 第三十一号：远程代码仓库映射与目录归属归档
- **对应远程仓库**：https://github.com/hc990275/nodejs
- **对应分支与目录**：main 分支下的 linux/ 子目录 (https://github.com/hc990275/nodejs/tree/main/linux)
- **本地开发目录**：d:\DeskTop\GitHub\测\lunes\自适应机场
- **归档说明**：本地工作目录 自适应机场 即为远程仓库 hc990275/nodejs 中 linux/ 目录的本地完整镜像；未来所有该项目的优化与提交，均精确同步至远程仓库 main 分支的 linux/ 路径下。

---

### 第三十二号：后台保存配置报 Unexpected end of JSON input 缺陷与全量清理 Argo 看板
- **问题现象**：在管理后台点击“保存所有配置”时弹出报错：`❌ 网络请求异常: Failed to execute 'json' on 'Response': Unexpected end of JSON input`，且 TAB 3 依然展示已停用的 Argo 隧道监控看板与定时器。
- **原因剖析**：
  1. 服务端路由解析中仅定义了 `GET /admin/api/settings`，缺失了 `POST /admin/api/settings` 接收分支，导致请求穿透返回 404 及 0 字节空响应体；
  2. 前端直接对空响应执行 `await res.json()` 触发 V8 原生解析错误；
  3. 控制中心前端模板遗留了旧版 Argo 隧道看板、Token 输入框及每 3 秒发起一次的隧道状态轮询定时器。
- **实施解决对策**：
  1. 在 `index.js` 补全 `POST /admin/api/settings` 处理逻辑，接收配额与 `DIRECT_IP` 公网配置，调用 `saveSettings()` 实时落盘；
  2. 彻底重构 TAB 3 为“🌐 网络与公网IP”，拔除所有隧道监控看板、Token 输入框与轮询定时器；
  3. 优化前端 `saveSiteSettings` 响应解析为 `await res.text()` + 安全 `JSON.parse`，彻底杜绝空响应报错。

---

### 第三十三号：管理后台“节点协议与端口”配置无法保存与回显失效缺陷修复
- **问题现象**：在管理后台“节点集群与参数控制中心”的【⚡ 节点协议与端口】Tab 中，勾选协议（Hysteria 2、TUIC、Reality 等）并配置端口后，点击“保存所有配置”无法生效，重新打开弹窗或刷新页面依然处于未勾选、端口为空的初始状态。
- **原因剖析**：
  1. 服务端 POST /admin/api/settings 在接收前端 envSettings 时，仅提取了 DIRECT_IP，完全忽略了所有协议变量（ENABLE_HY2, PORT_HY2, ENABLE_TUIC, PORT_TUIC, ENABLE_REALITY, PORT_REALITY, REALITY_DEST, ENABLE_VLESS_TCP, PORT_VLESS_TCP, ENABLE_TROJAN_TCP, PORT_TROJAN_TCP, ENABLE_SS, PORT_SS 等）；
  2. 服务端未调用 updateEnvFile(envUpdates) 进行 .env 持久化，亦未调用 safeReloadSingbox(true) 热重载 Sing-box，导致参数完全未落盘生效；
  3. 服务端直出 HTML 时 renderAdminPage 的 siteSettings 缺少 envSettings，且鉴权 checkAdminAuth 未支持 x-admin-token 请求头；
  4. 前端表单中，若用户勾选了协议但未手动输入端口（误以为灰色的 placeholder 是已输入的值），前端原逻辑提交 port: 0，导致服务端误判为禁用协议。
- **实施解决对策**：
  1. **全协议参数接收与落盘闭环**：在 index.js 的 POST /admin/api/settings 完整解构全部协议开关与端口，更新内存变量，调用 updateEnvFile(envUpdates) 原子写盘，并平滑触发 safeReloadSingbox(true) 重载核心；
  2. **鉴权全面兼容**：checkAdminAuth 增加对 req.headers["x-admin-token"] 与 x-admin-session 的校验；
  3. **初始渲染注入与 Token 保障**：在 renderAdminPage 直出数据中合并最新 envSettings 与 ADMIN_TOKEN，前端 getAdminToken() 优先读取避免凭据缺失；
  4. **端口智能自动补全**：在前端为所有协议复选框增加联动事件，用户勾选协议时自动补全默认推荐端口（HY2: 10800, TUIC: 10801, REALITY: 10802, VLESS: 10803, TROJAN: 10804, SS: 10805），保存时增加安全保活，彻底杜绝误设为 0。

---

### 第三十四号：后台保存配置提示网络错误 (Failed to fetch) 缺陷修复
- **问题现象**：在管理后台点击“保存所有配置”后，数据虽然能够成功写入磁盘保存，但前端界面依然弹出 `❌ 网络请求异常: Failed to fetch`。
- **原因剖析**：
  1. 服务端在收到保存请求后，在向 HTTP 客户端返回 200 响应前同步调用了 `safeReloadSingbox(true)`，其内部包含 `killPortOccupants()` 进程查杀与底层系统调用，阻塞了当前连接甚至导致 HTTP socket 被提前重置中断；
  2. 前端请求中配置了 `credentials: "include"`，当通过特定反向代理或跨端口访问时，浏览器触发严格 CORS 拦截，由于缺少精确匹配的 CORS 头而阻断响应抛出 `Failed to fetch`；
  3. 服务端路由未显式拦截 `OPTIONS` 跨域预检请求，携带 `x-admin-token` 自定义请求头的复杂请求在预检阶段被 404 中断。
- **实施解决对策**：
  1. **响应优先与重载异步化**：在 `index.js` 的 `POST /admin/api/settings` 中，数据校验落盘后先立即发送 200 成功响应，随后在 `setImmediate` 中异步执行 Sing-box 核心热重载，彻底脱离当前 HTTP 请求生命周期；
  2. **全局 CORS 与 OPTIONS 预检支持**：在 `handleHttpRequest` 顶部增加统一的 OPTIONS 拦截器与动态 CORS 头注入；
  3. **前端凭据规范化与安全降级通道**：在 `views/admin.js` 中移除 `credentials: "include"`，并在发生网络抖动时提供静默简单请求降级重试机制。
