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
  1. **独立版本工程化**：在 `d:\DeskTop\GitHub\测\lunes\nodejs` 建立全新的自适应版本，保持与 Alpine 版本的独立隔离；
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
- **本地开发目录**：d:\DeskTop\GitHub\测\lunes\nodejs
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

---

### 第三十五号：文件安全写入缺少递归父目录与 Alpine Linux 容器环境兼容性修复
- **问题现象**：
  1. 服务端写入用户数据库时抛错：[FS-Async] 写入文件失败 (/root/v3-airport/linux/data/v3_users.json): ENOENT: no such file or directory, open '/root/v3-airport/linux/data/v3_users.json'；
  2. 在 Alpine 3.22 容器环境中执行启动脚本时报错：/bin/sh: bash: not found，⚠️ 守护主服务终止结束。。
- **原因剖析**：
  1. safeWriteFileAsync 异步队列在调用 fs.promises.writeFile 前未预先确保其所在父级目录存在，新环境下 data 目录尚未生成时直接写入导致抛出 ENOENT；
  2. 历史提交误将单节点精简版启动器（163行）覆盖至完整的 linux/index.js，该精简启动器硬编码了 ash 调用与非 POSIX 的 urlencode 语法，在默认仅有 /bin/sh 的 Alpine Linux 极简镜像中无法执行。
- **实施解决对策**：
  1. **完整还原主程序**：恢复 linux/index.js 完整 3400+ 行机场核心后端服务；
  2. **自愈式安全落盘引擎**：在 safeWriteFileAsync 与 safeWriteFileSync 中均注入 wait fs.promises.mkdir(path.dirname(filePath), { recursive: true })，确保任意深层路径写入前父级目录必定存在；
  3. **内核平滑热加载**：在 safeReloadSingbox 中引入 Linux 环境下的 SIGHUP 信号热加载机制，配置变动时无需强杀进程，避免用户活跃连接意外断开；
  4. **全环境 Shell 自动降级与工具补齐**：在 linux/start.sh 中将 ash 纳入基础工具链自动安装；在启动器中增加 ash/sh 双模动态探测与 Node 原生 encodeURIComponent，彻底杜绝环境差异导致的异常。

---

### 第三十六号：历史落盘配置残留与控制中心弹窗移动端布局适配
- **问题现象**：
  1. 尽管代码已将默认联系方式变更为 @robberer，线上 VPS 管理控制面板弹窗中依然显示旧的 Telegram: @abcai 与 https://t.me/abcai；
  2. 手机端访问控制中心弹窗时，宽度超出屏幕边界，表单控件重叠变形。
- **原因剖析**：
  1. 服务端之前保存的 v3_settings.json 已写入过历史旧值，单纯更改默认常量变量无法覆盖磁盘已有持久化记录；
  2. 前端弹窗使用固定宽度与多列 flex 布局，在小屏设备上缺乏断点自适应与横向滚动支持。
- **实施解决对策**：
  1. **智能自愈配置升级**：在服务端的 loadSettings() 与前端 openSettingsModal() 中均注入自动洗涤逻辑，检测到含有历史 abcai 字样时自动升级为 @robberer 与 https://t.me/s5gydl；
  2. **移动端深度响应式 CSS**：在 views/admin.js 中增加针对 <=768px 屏幕的流式媒体查询，实现全屏弹窗、平滑横向滚动标签栏与单列输入组。

---

### 第三十七号：分布式集群主副机心跳通信、国家归属地国旗感知与远程免 SSH 协议热控制
- **问题现象**：
  1. v2rayN 等订阅客户端展示的节点名称缺少国家地区标识（仅有协议与端口，无法辨识服务器归属地）；
  2. 多台服务器时缺少分布式管理机制，副机开什么协议必须登录副机 SSH 手动改配置，且用户订阅无法全自动聚合主控与多台副机；
  3. 在服务端使用 ES 模板字符串渲染管理后台网页时，客户端脚本内嵌的 ${...} 被 Node.js 提前解析报错。
- **原因剖析**：
  1. 节点名称生成原先采用单机静态格式 ${protocol}[]-，未结合服务器公网 IP 进行 IP 归属地与国家 Emoji 映射；
  2. 缺少主从集群心跳通信机制，副机节点无法向主控上报自身在线状态与承载流量，主控也无法将协议变更下发至副机；
  3. views/admin.js 整个页面置于 Node.js 模板字面量中，客户端 JS 若写原生 ES6 模板插值会引发 Node.js 误解析。
- **实施解决对策**：
  1. **公网 IP 地理位置与国旗智能感知**：在 index.js 中新增 detectServerLocation() 引擎，自动结合 IP 探测 API 与 COUNTRY_FLAGS 字典赋予节点国旗与地区（如 🇺🇸 美西01、🇭🇰 香港01），并提供控制台自定义覆盖；
  2. **节点命名标准化**：订阅下发时统一规范命名格式为 ${locationPrefix} | []-；
  3. **分布式主副机双向心跳引擎**：
     - 主控维护 v3_cluster_nodes.json，超时 30 秒自动判定离线；
     - 副机运行 NODE_ROLE=worker，通过 5 秒定时心跳通道上报自身增量流量与健康状态；
     - 主控订阅分发中心实时聚合主控与所有在线副机节点，并支持用户级 assignedNodes 节点隔离；
  4. **网页端远程一键开关副机协议**：
     - 在后台【集群分机管理】弹窗中，站长可直接为任意在线副机勾选/取消 Hysteria 2、Reality、TUIC 等协议或调整端口；
     - 配置保存后主控递增 configVersion，副机在下一次心跳中接收新配置并平滑热重载（SIGHUP），全程无需登录副机 SSH；
     - 主副机无需统一管理密码，仅凭安全握手密钥 NODE_SECRET 建立受控连接；
  5. **前端模板字面量安全隔离**：在 views/admin.js 中将客户端动态渲染函数重构为标准字符串拼接，杜绝与服务端的语法冲突。

---

### 第三十八号：服务端模板字符串二次求值导致客户端内联 JS 语法解析异常 (Unexpected string)
- **问题现象**：访问管理后台 /admin 时，界面显示“0人”、“0活跃”、“0 B”，用户列表卡在“正在载入用户数据...”，控制台控制功能未渲染。
- **原因剖析**：
  1. 在 views/admin.js 的 HTML 拼接中，函数使用了 '... onclick="func(\'' + id + '\')"' 语法。因为整个 admin 页面是由 Node.js ES6 模板字符串包含的，在服务端生成 HTML 时，\' 被先行求值脱敏为单个 '，导致发往浏览器的 HTML 源码变成了 onclick="func('' + id + '')"，进而触发前端浏览器的 SyntaxError: Unexpected string，中断了整个 <script> 的加载执行；
  2. deleteClusterNode 弹窗中的 \n 在服务端模板中被求值为物理硬换行，嵌入双引号 JS 字符串中触发语法错误。
- **实施解决对策**：
  1. **采用 HTML5 Dataset 属性解耦**：彻底摒弃在 inline onclick 中拼接引号和转义符，改为 data-node-id=" + id + " onclick="func(this.dataset.nodeId)"，完全杜绝转义解析问题；
  2. **换行符二次转义**：确认对话框等字符串内部换行统一采用 \\n；
  3. **Node VM 端到端编译验证**：建立前端脚本 AST 编译测试，自动拦截发往浏览器的任何 JS 语法隐患。

---

### 第三十九号：ES6 模板字符串中直接书写 `\n` 引发客户端内联 JS 物理硬换行断裂 (Invalid or unexpected token)
- **问题现象**：更新端口避让告警后，管理员访问后台 /admin 再次卡在“正在载入用户数据...”，浏览器控制台报错 `SyntaxError: Invalid or unexpected token`。
- **原因剖析**：
  在 `views/admin.js` 内联的客户端脚本中，拼接了包含 `\n` 的字符串字面量（例如 `alertMsg += "\n\n⚠️..."` 和内联点击属性 `onclick="alert('...' + JSON.stringify(...join('\\n'))"`）。因整个页面置于 Node.js ES6 模板字符串（反引号 `` ` ``）中，服务端在渲染下发时将 `\n` 求值为了物理换行符（CR/LF），导致发送给浏览器的客户端 JS 源码在双引号字符串中间发生硬折行，浏览器 JS 引擎抛出语法错误，中断了 DOMContentLoaded 监听和用户表格的 `renderTable()` 渲染。
- **实施解决对策**：
  1. **摒弃字面量 `\n` 转义**：字符串换行全面采用 `String.fromCharCode(10)` 或由数组 `join(String.fromCharCode(10))` 实现，彻底避免服务端求值影响；
  2. **事件与参数 Dataset 解耦**：警告信息查看全部通过 `data-node-id` 绑定独立函数 `showNodePortWarnings`，杜绝内联 `onclick` 拼接转义符；
  3. **新增客户端 AST 语法自动化守门**：通过 Node 运行提取生成 HTML 中的 `<script>` 并做 `new Function()` AST 语法解析测试，确保 0 语法缺陷发往客户端。

---

### 第四十号：Telegram 机器人专属开通集成、官方群 @s5gydl 成员鉴权与防刷单号限制
- **问题现象**：
  1. 默认开放网页端自主注册容易引发爬虫或非本群人员恶意批量注册、刷取试用流量资源；
  2. 需要通过 Telegram 机器人为群成员发放专属福利，但必须限制只有本群 `@s5gydl` 成员才能开通，且必须防止同一个人反复注册刷流量；
  3. 原生 Node.js 无额外 npm 依赖环境下，调用 Telegram Bot API 进行长轮询时若遇网络超时或 409 冲突，若未妥善捕获将导致主进程异常退出。
- **原因剖析**：
  1. 历史配置中 `DEFAULT_ALLOW_REGISTER` 默认为 true；
  2. 原系统仅支持账号密码注册，未持久化 Telegram 关联信息与唯一性约束；
  3. Telegram Bot API `getChatMember` 要求机器人必须具有该群访问权限（群为公开群且机器人必须被拉入群中），且长轮询连接可能因网络超时或 409 产生异常。
- **实施解决对策**：
  1. **注册闭环与权限收紧**：将 `DEFAULT_ALLOW_REGISTER` 默认值设为 `false`，网页端前台增加友好导流提示卡片，将流量引流至群组与机器人；
  2. **专属群组身份鉴权**：在 `telegram.js` 模块中通过 `getChatMember` 实时核验用户的群身份（状态为 creator/administrator/member/restricted 即通过，left/kicked 拒绝并附带加群链接）；
  3. **一客一号防重锁**：在 `usersDatabase` 中持久化记录 `telegramId`，注册时强校验同一 TG ID 仅限注册 1 个账号，已绑定账号发送 `/my` 可随时查询；
  4. **原生无依赖高可用 Long-Polling**：纯 Node.js `https` 模块实现长轮询，完善超时控制与异常指数退避重试，永不断线，零内存消耗。



---

### 第四十一号：管理后台直填 Telegram 机器人配置、热重载唤醒与服务端 ES6 模板字符串嵌套解析排雷
- **问题现象**：
  1. 系统启动时输出 [TG-Bot] 当前未配置 TG_BOT_TOKEN，Telegram 机器人自动开通服务保持待命，站长在管理后台找不到配置 Telegram 机器人的表单入口，必须手动编辑 .env 重启服务，体验不够友好；
  2. 在前端 views/admin.js 中新增 Telegram 机器人配置卡片及一键测试联通性脚本时，Node.js 报错 SyntaxError: missing ) after argument list。
- **原因剖析**：
  1. Telegram Bot 相关参数（Bot Token、管理员 ID、专属群组、API 地址）原先仅设计为通过环境变量读取，未在管理后台界面的全局运营配置弹窗中开放可视化修改和双向读写落盘；
  2. views/admin.js 整个页面置于 Node.js 服务端 ES6 模板字符串中。在内嵌的客户端 JavaScript 脚本 window.testTgBotConnection 中，直接书写了客户端模板字符串，未加反斜杠转义的反引号和服务端未声明的变量被 Node.js 在服务端解析阶段提前求值，导致外层模板字符串被硬截断，抛出语法错误。
- **实施解决对策**：
  1. **后台全参数可视化配置卡片**：在管理后台运营弹窗的第一个 Tab 中新增「🤖 Telegram 机器人专属注册与官方群联动」模块，提供 Bot Token、管理员 ID、专属群组、API 反代地址输入框以及「🔌 探测机器人连通性」一键探测按钮；
  2. **双向持久化与热唤醒重载**：在 index.js 的 GET/POST /admin/api/settings 中打通 Telegram 参数的落盘同步（同时更新 v3_settings.json 与 .env），保存后自动调用 initTelegramBotService() 实现无缝热重载，无需重启服务即可上线机器人；
  3. **客户端 JS 杜绝裸写模板字符串**：在由 Node.js 服务端模板渲染的客户端脚本中，全面改用单/双引号加号拼接（+），彻底根除模板字符串冲突；新增端到端渲染及语法守门测试。

---

### 第四十二号：新成员入群 (new_chat_members) 事件拦截与 TG/Web 双端一键清空用户安全架构
- **问题现象**：
  1. 新成员加入官方 Telegram 交流群时，若无法第一时间收到引导，容易在群内盲目询问如何开通；且原先 handleMessage 依赖 msg.text，导致无文字的系统入群消息被提前 return 忽略；
  2. 测试运营或系统重置时，站长希望清空账号，但缺少一键批量清空入口，需逐条删除。
- **原因剖析**：
  1. Telegram 的 new_chat_members 事件消息内通常 msg.text 为空，必须在判断 msg.text 之前先行提取 msg.new_chat_members 数组并过滤机器人自身的进群消息；
  2. 清空用户属于高危破坏性操作，必须具备严格的权限校验与二次确认安全锁，且需区分“全库清空”与“仅清空 TG 注册用户”，并确保在删除数据的同时切断存量 TCP/WS 连接并热重载 Sing-box 核心。
- **实施解决对策**：
  1. **入群迎新专属卡片**：在 handleMessage 前置监听 new_chat_members，过滤 bot 之后自动发送 @ 新人的图文卡片，附带 ?start=start 深度直达按钮；
  2. **TG 机器人端一键清空**：管理员私聊专享 /clearall [confirm] 与 /cleartg [confirm]，提供内嵌二次确认按钮，秒级清理并断开存量连接；
  3. **Web 后台一键清空**：管理后台工具栏新增危险操作模态框，支持单选“仅清空TG用户”或“全库清空”，调用 /admin/api/clear-all-users 接口并实时热重载 Sing-box 核心。

---

### 第四十三号：Telegram 机器人群消息全自动 60 秒自毁防刷屏机制
- **问题现象**：
  官方交流群日常交流活跃，如果机器人发送的入群欢迎卡片、私聊引导卡片长期留存在群内，容易导致群聊记录杂乱、信息刷屏，影响正常群友交流体验。
- **原因剖析**：
  默认调用 sendMessage 时消息会永久驻留群聊中；同时，必须严格区分“群聊消息”与“私聊消息”：用户在机器人私聊中查看节点订阅、流量、教程的信息必须长期保留，绝对不能误删；只有目标会话类型为 group 或 supergroup（即 chatId < 0）的消息才需要定时撤回。
- **实施解决对策**：
  1. **底层统一拦截自毁队列**：在 telegram.js 的 sendMessage 基础方法中，根据返回的 chat.type 自动识别会话场景，群聊消息默认自动压入 60 秒延迟撤回队列；
  2. **双向清屏联动**：在群员触发 /reg 或开通引导时，不仅机器人发送的卡片会在 60 秒后自动调用 deleteMessage 撤回，群员在群内发送的触发消息亦同步在 60 秒后清理，彻底保持官方交流群版面整洁清爽；
  3. **私聊白名单免删**：私聊所有交互（如 /my 订阅提取、/checkin 签到、教程指南）默认保留，不执行删除。

---

### 第四十四号：Database-Safety 磁盘防空写安全锁与管理员合法一键清空冲突排查
- **问题现象**：
  在管理后台点击“一键清空用户”后，前端提示成功，但刷新页面后用户列表仍然存在（用户数为 102 人未减少），服务端日志输出：
  `[Database-Safety] 拦截到对有效用户库的清空风险！磁盘现有 102 用户，已自动阻止空数据覆盖并自动恢复。`
  `[Core] Sing-box 核心代理配置无变动，保持现有进程无缝运行。`
- **原因剖析**：
  在底层核心数据层 `saveUsers()` 中，为了防止 Node 进程异常或空指针导致无意间将空数组 `[]` 覆写磁盘，内置了防空写哨兵检查（当 `usersDatabase.length === 0` 且磁盘存在有效数据时，自动阻止覆盖并从磁盘自愈恢复数据）。而管理后台与 Telegram 机器人的“一键清空用户”是管理员主观意图触发的合法清库操作，调用 `saveUsers()` 时未传递允许清空的标志位，触发了安全哨兵的误拦截与自动还原。
- **实施解决对策**：
  1. **支持显式允许置空参数**：为 `saveUsers(allowEmpty = false)` 增加布尔参数，仅在 `!allowEmpty` 时执行防空覆盖拦截；
  2. **清空接口显式赋权**：在 `POST /admin/api/clear-all-users` 与 Telegram 机器人的 `clearAllUsers` 指令中，显式调用 `saveUsers(true)`，顺利完成磁盘合法重置清库；
  3. **强制核心重载**：清空后调用 `safeReloadSingbox(true)` 强制刷新 Sing-box 配置，实时剥离所有客户端入站授权。

---

### 第四十五号：Telegram 机器人通用订阅提取通道缺失、群聊隐私隔离与自定义订阅域名全链路打通
- **问题现象**：
  群友或用户在 Telegram 机器人面板中点击「📦 提取我的节点订阅」后，反馈“获取不了通用订阅”。
- **原因剖析**：
  1. **交互层缺失专用按钮**：原面板下方按钮矩阵仅提供了「⚡ 一键导入 Clash」，未提供通用订阅（Shadowrocket 小火箭 / v2rayN / Sing-box）的直接可点击按钮。手机 Telegram 用户在长文本 Markdown 中极难长按精准复制单行代码块链接，且极易误触换行导致格式失效；
  2. **群聊场景隐私泄露与自毁矛盾**：当用户在官方交流群内点击提取订阅时，机器人直接将包含敏感 Token 的面板大屏回复至群内，不仅泄露了用户 Token，且由于群消息 60 秒自毁机制，消息在一分钟后被自动撤回，导致用户无法复制；
  3. **网络层公网域名未解耦**：底层 `getBaseSubUrl` 仅依赖 `OPTIMIZED_DOMAIN` 或 `ARGO_DOMAIN`，若未配置则回退到 `DIRECT_IP` 或 `127.0.0.1`。在本地测试或处于 NAT / 反向代理后的 VPS 环境下，手机端访问内网 IP 必然拉取失败。
- **实施解决对策**：
  1. **全套专属导入与提取矩阵**：在订阅面板中新增「🚀 一键导入小火箭」（基于 `sub://` 协议 Scheme 极速唤起 App）及「🔗 提取通用订阅 (单行秒复制)」（单独下发纯净单行链接，长按一触即复制）；同时新增「📋 提取明文节点 (免订阅直连)」，下发原始 vless/vmess/hysteria2 节点链接以满足老旧客户端需求；
  2. **群聊私密触达保护**：当在群组中点击提取订阅时，自动转换为向该用户私发私聊消息（私聊永不删除），并在群内弹窗提醒「已私发至私聊」，若用户从未私聊过机器人则提供带有 `?start=my` 的一键直达私聊按钮；
  3. **管理后台自定义对外订阅域名 (SUB_DOMAIN)**：在 Web 管理后台与 `.env` 中增加 `subDomain` 配置项，允许站长自定义对外域名（如 `sub.example.com`），系统所有订阅下发统一优先采用该公网域名，确保无论任何网络环境均可 100% 秒级拉取。

---

### 第四十六号：Hysteria 2 / QUIC 协议长连接生命周期与 SIGHUP 平滑重载不斩断 UDP Session 排查
- **问题现象**：
  在管理后台将用户置为“● 手动阻断”（禁用账号）后，该用户已无法拉取/更新订阅，在 v2rayN 中 VLESS / VMess / Trojan 等节点均显示连接超时（延迟 -1）；但唯独 **Hysteria 2** 节点（如 18800 端口和 18806 端口跳跃）在代理软件中依然测得延迟（显示绿色 202ms / 328ms），用户疑惑为何被阻断后仍能使用。
- **原因剖析**：
  1. **Sing-box SIGHUP 信号特性**：原系统在更新配置时向 Sing-box 发送 `SIGHUP` 信号以平滑热重载配置。Sing-box 收到 SIGHUP 时仅重新加载入站验证规则以拒绝**新连接**；但对于已经建立握手的 QUIC / Hysteria 2 存量 UDP 会话，Sing-box 内核并不会主动向客户端发送 `CONNECTION_CLOSE` 报文，导致内核内存中的 UDP 会话保持畅通；
  2. **缺少核心级连接强杀流程**：在 `/admin/api/update` 禁用用户或修改 UUID 时，原代码仅执行了数据库更新，未调用断链逻辑，且未向 Sing-box 的 Clash RESTful API（`PORT_CLASH_API`）发送断开请求；
  3. **v2rayN 测速原理差异**：v2rayN 默认测速按钮为 RTT / Tcping 探针，向 Hysteria2 的 UDP 端口发送握手探针时，若旧 session 依然存活，会直接返回握手往返延迟。
- **实施解决对策**：
  1. **多层全链路强行断链 (disconnectUserConnections)**：封装全局断链核心，在切断 Node.js 层 WebSocket 客户端 Socket 的同时，向 Sing-box Clash RESTful API 发送 `DELETE /connections` 强行击毙所有存量活跃连接；
  2. **阻断时强制冷重载 Sing-box 核心进程**：在用户被管理员手动阻断（`enabled === false`）、轮换 UUID 或彻底删除时，强制触发 `safeReloadSingbox(true)`，毫秒级杀掉旧 Sing-box 进程并重新拉起，彻底销毁内存中所有的 UDP QUIC 会话缓存；
  3. **去除无用按钮**：按照运营需求，彻底移除 Telegram 机器人欢迎面板与订阅面板中的「📖 客户端导入教程」按钮，简化交互界面。

---

### 第四十七号：注册完成明文节点直出直连、群聊命令漏判与 /admin 站长控制台全矩阵大屏升级
- **问题现象**：
  1. 用户在 Telegram 机器人中注册开通后，返回的信息中仅包含通用订阅链接与 Clash 订阅，没有直接显示可用的明文节点代码块，小白用户或不支持订阅的客户端无法直接复制使用；
  2. 群聊中输入 `/start`、`/my` 等各种指令时机器人无响应，命令无法正常工作；
  3. 管理员在私聊输入 `/admin` 后，只有 4 个简单按钮（巡检、刷新、节点、广播），缺少核心控制、用户列表、在线 IP 监控等运维功能。
- **原因剖析**：
  1. **注册反馈信息单一**：原 `handleRegisterCommand` 仅拼装了订阅链接和两个快捷按钮，未调用 `getRawNodesText(newUser)` 将直连明文节点（如 `vless://`、`hysteria2://`）直接输出到消息卡片，也缺少「🚀 一键导入小火箭」与「📋 提取明文节点」按钮；
  2. **群聊拦截漏词与 Markdown 特殊字符炸群**：
     - 群聊指令拦截列表 `isIntentToStart` 仅包含了 `/start`、`/reg`，漏掉了 `/my`、`/sub`、`/nodes`、`/checkin`、`/admin`，导致发 `/my` 穿透到了私聊业务中，尝试向群内发送订阅并因群权限被 Telegram 拒绝；
     - 群回复文本直接拼接了 `[${from.first_name}](tg://user?id=...)`，未对昵称进行 `escapeMd()` 转义。群友昵称一旦带有下划线 `_` 或星号 `*`，Telegram API 立即报 400 Bad Request（`can't parse entities`）并将消息静默抛弃；
  3. **管理员控制台按钮缺失与无专用运维指令**：
     - `handleAdminDashboardCommand` 仅放置了 4 个基础按钮，未挂载 Sing-box 核心进程强启、全量用户列表拉取、活跃在线 IP 监控、全员福利追加、0 流量死号扫描及清库防呆对话框等高级按钮；
     - 宿主 `index.js` 未向 TelegramBot 实例注入 `restartSingboxCore`、`getOnlineIpsDetails`、`adminWebUrl` 等底层调度接口。
- **实施解决对策**：
  1. **注册即返明文节点代码块与全套导入矩阵**：在 `handleRegisterCommand` 中集成 `getRawNodesText(newUser)`，开通成功消息中直接携带可一键长按复制的明文节点代码块，并提供「⚡ 一键导入 Clash」、「🚀 一键导入小火箭」、「📋 提取所有明文节点」、「🔗 提取通用订阅链接」等完整按键矩阵；
  2. **群聊安全防呆全覆盖与精准场景跳转**：
     - 将群聊触发词全面扩充至 `/start`、`/my`、`/sub`、`/nodes`、`/checkin`、`/admin`、`/help` 以及中文“开通”、“我的”、“订阅”、“节点”、“签到”、“后台”等；
     - 用户昵称全面经过 `escapeMd()` 转义，并在底层 `sendMessage` 中强化 Markdown 解析异常自动纯文本降级机制；
     - 根据群友触发的命令精准生成私聊直达按钮（如输入 `/my` 生成 `?start=my`，输入 `/checkin` 生成 `?start=checkin`），群内消息 60 秒后自动撤回自毁，且绝不穿透至群聊造成隐私泄露；
  3. **升级 5 排 10 键 /admin 站长超级控制台与专属指令集**：
     - 控制台新增：`🔄 强启 Sing-box 核心`、`📊 查看最新用户列表`、`🔍 立即全员在群巡检`、`🌐 在线活跃 IP 监控`、`📡 节点矩阵与大屏`、`📢 全员广播群发推送`、`🖥️ 打开 Web 管理后台`、`🎁 全员发放 5GB 流量`、`🧹 清理 0 流量空账号`、`⚠️ 一键重置清空全库`；
     - 命令行同步支持特权命令：`/restart`、`/users`、`/ips`、`/grantall`、`/audit`、`/deluser`、`/unbind`、`/clearall confirm`、`/cleartg confirm`、`/broadcast`。

---

### 第四十八号：Telegram Bot API BUTTON_URL_INVALID 报错致 /start 与 /my 全面瘫痪及客户端安全唤起跳板重构
- **问题现象**：
  在 Telegram 私聊或群聊中发送 `/my`、`/start` 或完成开通后，机器人完全没有任何信息回复，所有命令犹如石沉大海。同时管理后台与系统环境缺少默认的站长 ID（`5153827615`）、专属群组（`@s5gydl`）、API 地址（`https://api.telegram.org`）以及节点订阅对外公网域名（`db.995677.xyz`）。
- **原因剖析**：
  1. **Telegram 官方 Bot API 对 InlineKeyboardButton URL 规范限制**：Telegram 官方 Bot API 严格要求内嵌按钮的 `url` 属性必须且只能是 `http://`、`https://` 或 `tg://` 协议。原代码在 `/start`、`/my` 和 `/reg` 的卡片按钮中直接塞入了类似 `clash://install-config?url=...` 和 `sub://base64...` 的自定义 scheme。Telegram 服务器校验时直接报 `HTTP 400 Bad Request: BUTTON_URL_INVALID` 并将整条消息彻底拒收，且因为不属于 Markdown 解析错误导致原有的 Markdown 降级逻辑未被触发，最终造成机器人发出的所有卡片全部静默消失；
  2. **群聊昵称转义副作用**：MarkdownV1 规范仅支持对 `_`、`*`、`` ` ``、`[` 反斜杠转义，原 `escapeMd` 正则中连带转义了 `-`、`.`、`!` 等在旧版 Markdown 中非法的字符，容易诱发 Telegram `can't parse entities`；
  3. **环境预设缺省未落地**：系统的 `TG_ADMIN_ID`、`SUB_DOMAIN` 默认留空，未固化用户指定的站长 ID、专属群组与对外域名 `db.995677.xyz`。
- **实施解决对策**：
  1. **构建安全 HTTPS 客户端唤起跳板路由 (`/import`)**：
     - 在 `index.js` 中新增 `GET /import?app=(clash|rocket)&token=xxx` 标准 HTTPS 路由，提供优雅自适应的轻量跳转页面；
     - 机器人端所有的「一键导入小火箭」与「一键导入 Clash」按钮全部改用该 HTTPS 标准 URL，100% 遵守 Telegram 规范，且在移动端可毫秒级自动唤起客户端完成一键导入，彻底根除 `BUTTON_URL_INVALID`；
  2. **强化 `sendMessage` 三重铁壁容错与自愈机制**：
     - 铁壁 1：若拦截到 `BUTTON_URL_INVALID`，自动清洗非法 URL 按钮后即时重发；
     - 铁壁 2：若拦截到 Markdown 实体解析异常，自动剥离 `parse_mode` 降级为纯文本重发；
     - 铁壁 3：终极兜底，若依然异常则彻底剥离格式裸发纯文本，确保任何消息 100% 不吞消息；
  3. **群聊纯文本秒级响应**：群内回复彻底剥离 Markdown 语法标记，使用原生纯文本，群友发 `/start`、`/my`、`/nodes` 等 100% 秒回带有相应私聊直达按钮；
  4. **固化图1全部默认配置**：
     - 站长 ID 默认设为 `5153827615`；
     - 限定专属注册群组默认设为 `@s5gydl`；
     - Telegram API 地址默认设为 `https://api.telegram.org`；
     - 对外订阅域名默认设为 `db.995677.xyz`；
     - 并在 `index.js`、`telegram.js`、`.env`、`v3_settings.json` 及前端管理后台中全量同步生效。


---

### 第四十九号：清除硬编码 Bot Token、图1/图2配额端口全开启、重拉脚本防丢数据跨目录持久化与群聊纯引导隔离铁律
- **问题现象**：
  1. 代码中 TG_BOT_TOKEN 被误填了硬编码默认 Token，用户要求严格移除，绝不预设任何机器人 Token；
  2. 图 1 与图 2 要求的参数未全量落地为默认值：注册试用天数需默认 365 天、初始流量配额需默认 10TB，且分配预览中的全部协议（Hy2: 18800、TUIC: 18801、Reality: 18802、VLESS-TCP: 18803、Trojan-TCP: 18804、SS: 18805、HOP: 18806-18817）需默认填写并全部开启；
  3. 用户在服务器上重新拉取脚本更新或重装后，原有所有注册用户全部消失被冲刷为空；
  4. 群聊中偶有非预期信息输出，用户要求群聊“只能引导用户私聊机器人，不做任何东西”。
- **原因剖析**：
  1. **Token 硬编码污染**：上一次修复中误将开发测试 Token 写入了变量初值；
  2. **图1与图2默认值未闭环**：DEFAULT_DAYS 原为 3，DEFAULT_TRAFFIC_UNIT 原为 GB，各协议端口原为 0（禁用状态），前端回显与向导中未同步将 18800-18805 预设为默认勾选状态；
  3. **数据丢失深层根因（单目录存储脆弱性 + 毁灭性脚本）**：
     - README.md 原有一键命令包含 rm -rf /root/v3-airport && git clone ...，用户或脚本更新时执行该命令直接物理抹除了本地 data/ 目录；
     - v3_users.json 与 v3_settings.json 原先仅保存在当前工作目录的 data/ 下，缺乏系统级的外部独立冷备，一旦工作目录发生被删、重装、重拉或冲突，数据彻底丢失；
  4. **群聊未做绝对隔离**：原群聊逻辑对部分文本或回调进行了分支下发，未能做到 100% 纯引导。
- **实施解决对策**：
  1. **彻底拔除硬编码 Token**：index.js、telegram.js、.env、v3_settings.json 中统一恢复为 (process.env.TG_BOT_TOKEN || '').trim()，未配时绝对保持为空；
  2. **全量落地图1与图2默认值与协议自动开启**：
     - 初始试用天数默认 365 天，初始流量配额默认 10 TB (折合 10240 GB)；
     - 协议端口与开关默认全面开启：Hy2 主端口 18800、TUIC v5 18801、VLESS Reality 18802、VLESS-TCP 18803、Trojan-TCP 18804、SS 18805、Hy2 HOP 18806-18817（全部 ENABLE_xxx=true）；
     - 管理后台表单、批量分配器、向导及配置文件中均完成对齐回显与自动打勾；
  3. **系统级跨目录持久化与智能多源寻回 (Out-of-Tree Persistence)**：
     - 新增 getSystemPersistentDirs() 函数，在 Linux 环境下挂载 /etc/v3-airport/data、/var/lib/v3-airport/data、/root/.v3_airport_data 等系统级独立存储路径；
     - saveUsers() 与 saveSettings() 每次变更落盘时，自动异步双写到上述系统级持久化目录；
     - loadUsers() 与 loadSettings() 启动寻回序列中，优先深度扫描系统级外部持久目录；即使用户执行了 rm -rf 重新 clone 整个仓库，新服务拉起的第一秒即可 100% 完整找回并恢复所有历史用户与配置；
     - 改造 README.md 一键命令，存在旧目录时自动走 git pull 无损更新，并明确提供 cd /root/v3-airport/linux && git pull && systemctl restart v3 日常无损热升级指令；
  4. **群聊铁律（纯引导私聊，不做任何其他事情）**：
     - 进群事件 (new_chat_members) 仅发送一条图文引导卡片，带直达私聊按钮；
     - 群聊中任何命令（/开头）、@机器人、回复机器人或意图关键词，机器人唯一动作是回复一条引导私聊卡片（带且仅带直达私聊按钮），随后立即 return;，绝对不穿透到任何业务；
     - 群聊中的按钮点击 (callback_query) 统一弹窗阻断并引导前往私聊；普通闲聊静默忽略，彻底实现群内零数据泄露与纯私聊业务闭环。
---

### 第五十号：退群断流生效后回群无法连接节点根因排查与管理员回群解封通知闭环
- **问题现象**：
  1. 用户退出官方群后，节点成功被停用断网；但重新加入群组后，虽然收到了机器人的回群激活私信（图1），客户端依然无法连接节点上网；
  2. 管理员在 Telegram 里收到了退群停用通知（图2），但用户回群后管理员端无任何解封通知反馈，导致误认为系统没有解封。
- **原因剖析**：
  1. **Sing-box 核心进程不支持 SIGHUP 信号热载入入站用户**：
     - 退群时调用了 safeReloadSingbox(true)，执行了强制查杀并重新拉起 Sing-box，将禁用的用户从 config.json 中剔除，因此断网立即成功；
     - 但回群激活时调用的是 safeReloadSingbox(false)，代码命中 Linux SIGHUP 分支：existingProcess.kill('SIGHUP') 并直接 return。然而 Sing-box 内核根本不支持通过 SIGHUP 信号动态重新加载入站用户列表，导致 Sing-box 核心内存中始终保持着剔除该用户的旧状态，客户端连接时直接被 Sing-box 拒绝凭据；
  2. **回群解封事件缺少对管理员的通知回调**：
     - 在 telegram.js 的 handleChatMemberUpdate 与 auditAllMembers 中，退群时有 this.sendMessage(this.adminId, ...) 发送图2通知；但回群激活解封时，仅给用户本人发送了欢迎私信，完全没有给管理员发送解封通知，导致管理员产生“回群未解封”的感知断层；
  3. **用户解封后 disableReason 残留**：
     - 激活时将 u.disableReason 写入了 '进群自动恢复'，未彻底清空为 ''，影响部分条件判断。
- **实施解决对策**：
  1. **彻底移除无效的 SIGHUP 信号逻辑，实行真实进程毫秒级冷重启加载**：
     - 改造 safeReloadSingbox()：移除 SIGHUP 分支，当检测到配置变动 (configChanged) 或 force === true 时，直接强制释放端口并以新配置拉起 Sing-box 核心进程；
     - 在用户启用、恢复、回群激活以及管理后台切换状态时，统一调度 safeReloadSingbox(true)，确保新入站凭据 100% 真实加载到 Sing-box 内存；
  2. **补全管理员回群解封实时通知（图2状态闭环）**：
     - 在 handleChatMemberUpdate 与后台定时巡检 auditAllMembers 中，当群员重新进群激活时，除给用户下发欢迎卡片外，同步给管理员 (this.adminId) 推送《🎉 群员回群触发解封通知》，明确标注账号、TG ID、动作及解封处理状态；
  3. **放宽回群判定并彻底清理原因**：
     - 将回群恢复判定优化为 !boundUser.enabled && boundUser.disableReason !== '管理员手动禁用'，并在 setUserEnabled 中将已启用用户的 disableReason 彻底重置为 ''。
---

### 第五十一号：空闲超时自动断连 (Idle Timeout) 对主流直连协议失效根因排查与内核级精确切断落地
- **问题现象**：
  在管理后台为用户开启“无连接信息产生就断链 (空闲超时守护)”并设定秒数（例如 60 秒）后，用户的客户端（Clash/小火箭等）哪怕长时间锁屏挂起、完全没有任何网络上下行数据流动，后台面板与系统底层依旧显示保持连接，空闲断连功能完全未生效。
- **原因剖析**：
  1. **直连协议连接被守护定时器硬编码跳过**：
     - 在每 10 秒执行一次的全局连接回收定时器中，存在 `if (conn.isSingbox) return;` 逻辑。因为系统当前 99.9% 的流量均由 Sing-box 核心协议（Hy2、TUIC、Reality、VLESS-TCP 等直连端口）承载，全部标记为 `isSingbox = true`，导致该守护定时器将所有直连长连接直接掠过；
  2. **活跃感知轮询中未区分“连接存活”与“流量流动”**：
     - 注释原定由 `pollSingboxClashApiTraffic` 负责，但该函数每次获取到连接时，无论其上行/下行字节是否停滞，均将 `existing.lastActivityAt` 强行刷新为当前时间 `Date.now()`，导致连接时间戳永远在刷新，永远无法满足超时判定；
  3. **缺少针对 Sing-box 核心的单连接底层切断接口**：
     - 原代码仅对 Node.js 本地 socket 执行 `destroy()`，缺乏通过 Sing-box Clash API 发送 `DELETE /connections/{connId}` 切断单连接的执行逻辑。
- **实施解决对策**：
  1. **构建内核级单连接精准切断器 (`closeSingboxConnection`)**：
     - 封装 `closeSingboxConnection(connId)` 函数，通过 HTTP `DELETE http://127.0.0.1:${PORT_CLASH_API}/connections/${connId}` 接口直接指令 Sing-box 释放指定客户端套接字；
  2. **精确记录真实数据流动时间戳 (`lastDataAt`)**：
     - 在 `activeConnTrafficMap` 中新增 `lastDataAt` 字段，仅当检测到真实上传/下载字节增量 (`delta > 0`) 时才推进该时间戳；无数据流动时保持原有时间戳不变；
  3. **双重防线自动空闲切断**：
     - **第一道防线**：在 `pollSingboxClashApiTraffic` 中，若连接当前未产生数据且 `now - lastDataAt > timeoutMs`，立即调用 `closeSingboxConnection(c.id)` 并移出活跃队列；
     - **第二道防线**：在每 10 秒执行的巡检定时器中，移除生硬的 `if (conn.isSingbox) return;`，对超时的 Sing-box 连接直接调度 `closeSingboxConnection(conn.id)`，形成双重闭环保护。
---

### 第五十二号：群聊自动删除群员发言与机器人引导卡片导致风控卫士刷屏根因排查与禁删优化
- **问题现象**：
  群员在群聊中发送提问或触发词（例如“请问这专属订阅怎么使用呢 也导不进机场里啊”），机器人回复引导卡片后 60 秒，群员发送的提问消息以及机器人发送的引导卡片双双被自动删除，导致群内第三方风控机器人（如“S5广告监测 | 杀神联动风控卫士”）频繁在群里弹出灰色“已删除消息:”告警提示。
- **原因剖析**：
  1. **主动调用 API 删除群员发言**：
     - 在 telegram.js 的群聊拦截器中，原先注册了 `setTimeout(() => this.deleteMessage(chat.id, msg.message_id), 60000)`，在 60 秒后直接调用 Telegram Bot API 强行删除了群友发出的提问；
  2. **机器人卡片默认 60 秒自毁**：
     - 在 `sendMessage` 基础方法中，原先对群聊消息（isGroup）默认设置了 60 秒后自动执行 `deleteMessage` 撤回；
  3. **第三方风控机器人联动报警**：
     - Telegram 群内的广告/防撤回风控卫士对任何被删除的消息都会记录并在群里广播“已删除消息:”，造成版面污染和负面体验。
- **实施解决对策**：
  1. **彻底解除对群员发言的删除操作**：
     - 彻底删除针对 `msg.message_id` 的定时删除代码，机器人绝不触碰、不删除群友用户的任何聊天与提问记录；
  2. **关闭默认群聊自动撤回**：
     - 将消息发送底层的 `delaySec` 默认值置为 0，只有在显式指定自毁时间时才删除，默认在群内常驻保留引导卡片；
     - 彻底避免触发任何群内第三方风控监控机器人的“已删除消息”报警。

---

### 第五十三号排查记录：注册回复精简化、默认时长365天持久化洗涤与群聊机器人引导卡片60秒自毁

- **问题现象 1 (注册回复刷屏与冗长明文节点)**：
  - 用户在 TG 私聊完成 `/reg` 开通后，机器人发送了长达数百行、杂乱无章的图 2 明文节点 (`vless://`, `tuic://`, `trojan://`, `ss://`)，而未直接下发整洁直观的图 1（我的节点账号状态面板）。

- **原因分析 1**：
  - `telegram.js` 中的 `handleRegisterCommand` 在构造完成开通消息后，强制调用了 `getRawNodesText(newUser)` 并将大量明文协议链接以 Markdown 代码块拼接在正文中，既影响美观又容易导致单条消息超过 Telegram 4096 字符上限。

- **解决方案 1**：
  - 重构 `handleRegisterCommand` 的下发模版，彻底剔除 `rawNodesBlock` 杂乱大段链接，完全对齐 `/my` 的图 1 标准结构，包含「👤 我的节点账号状态面板」：账号名称、正常可用状态、流量额度与剩余、到期时间，以及「通用订阅链接」与「Clash/Mihomo专属订阅」；
  - 底部挂载快捷 Inline 按钮：一键导入、提取明文节点、提取通用订阅、每日签到等，用户按需点击提取明文节点即可。

---

- **问题现象 2 (默认注册有效期仍为 3 天而非 1 年)**：
  - 尽管代码初始变量修改为 365 天，新注册用户仍显示有效期只有 3 天。

- **原因分析 2**：
  - 服务器上已存在历史生成的配置数据持久化文件 `/etc/v3-airport/data/v3_settings.json` 或本地 JSON，里面存储着上一版本的历史旧值 `"defaultDays": 3`，服务启动执行 `loadSettings()` 时读取覆盖了默认值；
  - 此外，`index.js` 的自主注册路由（2794 行）与 TG 注册处理程序（4761 行）中存在旧兜底 `parseInt(settings.defaultDays) || 3`。

- **解决方案 2**：
  - 在 `index.js` 的 `loadSettings()` 中加入**历史配置自愈机制**：读取到已存配置时，若检测到 `defaultDays < 30`，自动强制升级为 `365` 天，并同步保存写回；流量单位为 GB 时一并升级为 10 TB；
  - 同步排查更正所有代码里的兜底逻辑为 `|| 365`，杜绝任何历史遗留配置回流。

---

- **问题现象 3 (群聊引导卡片未在 60 秒后自动删除)**：
  - 群聊中机器人的引导卡片提示“群聊不提供服务，请私聊”停留在群聊中未被撤回。

- **原因分析 3**：
  - 上次更新中为了绝对避免误删群员消息，将底层默认延迟置为 0，且在群聊内发送引导卡片时未显式传递 `autoDeleteSeconds: 60`；
  - 服务器当前仍跑着旧镜像代码，新的自毁机制未在远端运行。

- **解决方案 3**：
  - 在 `telegram.js` 的群聊拦截处显式配置 `autoDeleteSeconds: 60`，并优化 `deleteMessage` 的异常捕获与日志输出；
  - 严格确保：群友发言永远不撤回（0 秒），机器人自身的引导卡片在 60 秒后精准定时静默销毁。

---

### 第五十四号排查与优化记录：图 2 超链接引擎移植、256MB 小鸡 ZRAM 内存压缩防 OOM 落地与积压消息清空

- **问题现象与需求**：
  1. Telegram 机器人出现无响应故障，私聊发送任何指令均无回复，接口积压了 139 条 updates；
  2. 新用户注册等通知需要支持图 2 交互：点击用户名直接私聊、点击 ID 直接查看账户资料（`https://t.me/tomsli` 格式）；
  3. Linux 机器配置为 1核 256MB 内存 2GB 硬盘，需吸收纽约版本优秀架构，移植内存压缩（ZRAM）与网卡 UDP 卸载，杜绝 OOM 假死。

- **原因分析**：
  1. 本地 `.env` 与 `v3_settings.json` 中的 `TG_BOT_TOKEN` 缺省为空，服务重启时导致机器人离线；同时 256MB 内存受限且未开压缩，并发波动易触发 OOM；
  2. 原通知模板使用纯代码块反引号，未封装超链接生成引擎；
  3. 原脚本针对 256MB 机器配置了极端压抑的 40MiB / 64MB 限制，容易引发频繁 GC 风暴且缺少内核级 Swap 保护。

- **实施解决对策**：
  1. **图 2 超链接引擎移植 (`formatUserChatLinks`)**：
     - 在 [telegram.js](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/telegram.js) 实现 `formatUserChatLinks`、`editMessageText` 以及管理员查用户与封禁体系；
     - 注册成功通知、退群停用通知、回群解封通知全面换装：账号/用户名点击直达 `https://t.me/username` 私聊，无用户名或点击数字 ID 直达 `tg://user?id=xxx` 个人账户卡片；
  2. **1核 256MB 小鸡 ZRAM 内存压缩与轻量内核调优**：
     - 在 [setup.sh](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/setup.sh) 注入自适应 ZRAM 内存压缩（支持 Debian/Ubuntu 的 `zram-tools`、Alpine 的 `zram-init` 及原生内核模块兜底，划分 256MB~384MB 虚拟压缩空间）；
     - 注入网卡硬件级 UDP GRO 报文卸载（降低单核软中断 50%）；
     - 固化 BBR、8MB 轻量缓冲、TCP Fast Open、MTU 黑洞探测；
     - 在 [start.sh](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/start.sh) 与 [v3.service](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/v3.service) 中将内存配额调优为 Sing-box 60MiB / Node.js 80MB，兼顾性能与安全；
  3. **凭据补全与积压消息消化**：
     - 固化 `TG_BOT_TOKEN`，并通过专用安全脚本完成 139 条积压 updates 确认与消费，`pending_update_count` 归零。

---

### 第五十五号排查与优化记录：TG 巡检网络超时误判退群与回群恢复震荡死循环排查与根治

- **问题现象**：
  - 用户在官方群内并未退群，但 Telegram 机器人隔段时间（如下午 9:44、凌晨 3:29、凌晨 3:59）会反复向用户发送私信通知：`🎉 检测到您已在群内，节点权限已自动恢复`；
  - 期间用户节点连接偶发短暂被切断或重置。

- **原因深度剖析**：
  1. **API 网络超时/报错被误当做退群 (致命盲区)**：
     - 在 [telegram.js](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/telegram.js) 的 `verifyUserInRequiredGroup` 中，当海外 VPS 到 Telegram API 偶发网络超时（10秒）、接口返回 429 Too Many Requests、502 错误或连接重置时，统一返回了 `{ inGroup: false, error: ... }`；
     - `auditAllMembers` 巡检定时器（每 15 分钟运行一次）在此前仅依据 `if (!check.inGroup && u.enabled)` 进行判定，完全未对 `check.error` 进行过滤识别，把临时的网络故障当成了“用户退群”，立即执行 `setUserEnabled(..., false, "退群自动停用")` 并切断了节点连接！
  2. **状态抖动（Flapping Loop）**：
     - 用户被误停用后，下一次巡检网络恢复正常，`getChatMember` 成功返回 `status: member`（`check.inGroup = true`）；
     - 系统触发 `else if (check.inGroup && !u.enabled && u.disableReason !== "管理员手动禁用")` 分支，误以为用户“重新加群”，于是自动调用激活并向用户发送了私信通知；
     - 随着凌晨网络环境的偶发波动，此“误停用 -> 恢复通知 -> 误停用 -> 恢复通知”形成震荡循环。

- **实施解决对策**：
  1. **明确区分 Telegram 确凿退群与系统/网络异常**：
     - 在 [telegram.js](file:///d:/DeskTop/GitHub/测/lunes/nodejs/linux/telegram.js) 的 `verifyUserInRequiredGroup` 中增加精确区分：只有接口返回 `status === 'left'`、`'kicked'` 或 Telegram 明确说明 `USER_NOT_PARTICIPANT` 时，才标定 `confirmedLeft: true`；
     - 所有超时（Timeout）、网络中断（ECONNRESET/ETIMEDOUT）、HTTP 429/502 等均显式标记 `isError: true`。
  2. **巡检异常全面保护与防误杀跳过**：
     - 在 `auditAllMembers` 巡检中加入 `if (check.isError) { continue; }` 保护守卫，一旦遇到网络抖动坚决维持现有状态不变，绝不盲目断网。
  3. **引入退群双重防抖确认机制 (`unconfirmedLeftCountMap`)**：
     - 单次常规巡检查出不在群仅打上待确认标记（1/2），只有连续 2 次巡检均确凿不在群内（或手动巡检、原生 chat_member 实时事件）时才执行停用断网，彻底杜绝单次抖动误判。
  4. **平滑流控升级**：
     - 请求间隔由 120ms 调至 250ms~400ms，有效抵御 Telegram 群成员批量查询时的 429 频控限制。


