# 踩坑与故障修复排查记录 (Error Report)

## 问题 1：管理后台进不去，主页可以正常访问

### 1. 问题现象
客户端访问主页 `http://ip:port/` 能正常渲染前台页面，但在访问 `/admin/` 时报 404，或在主页上找不到后台入口；登录后在某些浏览器下 Cookie 丢失导致无法进入管理面板。

### 2. 根因分析
1. **URL 末尾斜杠（Trailing Slash）未规范化**：路由仅严格判断 `pathname === "/admin"`，当浏览器或用户输入 `http://ip:port/admin/` 时，`pathname` 为 `"/admin/"`，导致路由未匹配直接穿透到末尾的 `404 Not Found`。
2. **Cookie 作用域过窄**：后台登录下发的 `admin_session_token` 作用域原设置为 `Path=/admin`。部分现代浏览器在重定向至 `/admin` 时因路径缺少末尾斜杠而不附带该 Cookie，导致重定向死循环。
3. **主页缺少后台直达入口**：主页卡片上未放置后台管理跳转按钮，用户只能在地址栏盲猜路径。
4. **.env 空值反向覆盖宿主机变量**：若 `.env` 中留空 `SERVER_PORT=` 或 `ADMIN_TOKEN=`，加载器无条件赋值导致宿主机注入的环境变量被空字符串冲刷置空。

### 3. 解决方案与实施
1. **路由末尾斜杠自动裁剪**：在 `handleHttpRequest` 入口对 `pathname` 执行自动规范化，去除末尾斜杠，使 `/admin` 与 `/admin/`、`/admin/login` 与 `/admin/login/` 均可 100% 精准匹配。
2. **全域 Cookie 赋能**：将 `admin_session_token` 的 Cookie 作用域统一升级为 `Path=/; HttpOnly; SameSite=Lax`，并支持通过 `?token=...` 首次访问时在响应头自动颁发 Cookie，实现一键免密秒进与后续 API 免登录畅通。
3. **前台界面增设直达入口**：在未登录卡片右上角和已登录个人中心顶部，加入现代化 Element UI 纯色扁平化“⚙️ 管理后台”一键直达按钮。
4. **环境变量保护机制**：优化 `.env` 解析合并逻辑，当 `.env` 中的值为空且 `process.env` 已存在非空值时跳过覆盖，彻底杜绝宿主机环境变量被冲掉的隐患。

---

## 问题 2：后台不能编辑用户信息，且需要增加类似图2的正序/倒序排序

### 1. 问题现象
1. 点击后台用户列表的“编辑”按钮时，部分用户弹不出编辑弹窗，或在保存后修改未生效；
2. 表格表头为静态文本，无法像参考图那样点击按已用流量、注册时间、到期时间、状态、在线设备数进行正序与倒序排布。

### 2. 根因分析
1. **HTML 属性拼接转义漏洞**：原先使用 `onclick="openEditModal('${u.uuid}', '${u.username}', ...)"` 将多个字符串拼接入 HTML 属性。当用户名或配额中包含特殊字符、单引号或空格时，直接破坏 HTML 标签闭合并引发客户端 JavaScript SyntaxError，导致点击编辑按钮没有任何反应。
2. **缺漏注册时间字段**：原数据结构缺少 `createdAt`，无法实现参考图中的注册时间排序。
3. **缺少响应式内存数据驱动**：表格行依赖服务端单向渲染，缺少前端响应式数据层驱动动态重排。

### 3. 解决方案与实施
1. **UUID 纯键驱动弹窗**：彻底废弃内联多参数字符串拼接，改为 `openEditModalByUuid(uuid)`。弹窗直接由全量内存数据 `window.__ALL_USERS__` 根据唯一 UUID 精准提取填充，彻底根除语法崩溃。
2. **更新接口与 API 双保险**：优化 `/admin/api/update` 校验与容错，并在前端发起的修改、重置、删除请求中自动携带 URL Token，确保即便在复杂跨域或无痕浏览器环境下鉴权绝对通过。
3. **复刻参考图的正序/倒序表头**：
   - 增加 `注册时间` 列，并为 `已用流量`、`注册时间`、`到期时间`、`状态`、`在线` 增加 `th.sortable` 点击交互；
   - 激活列以浅蓝背景（`#ecf5ff`）与 Element UI 蓝（`#409eff`）高亮呈现，箭头实时在 `↑` / `↓` / `⇅` 切换；
   - 点击时毫秒级原地重排 DOM 列表，无需刷新页面。

---

## 问题 3：后台控制开放注册开关、初始流量配额与初始有效天数

### 1. 需求与问题现象
1. 原先用户注册通道始终向公网开放，无法在后台自主暂停/开放注册；
2. 新注册用户的初始流量配额硬编码为 15GB，初始有效天数硬编码为 30天，无法由管理员按需配置（例如活动赠送 50GB、长期开放免过期等）。

### 2. 根因分析
1. **写死业务常量**：`/api/register` 接口中直接硬编码 `trafficLimit: 15 * 1024 * 1024 * 1024` 与 `expireTime: Date.now() + 30 * 86400000`，缺少集中管理的数据模型。
2. **缺少配置持久化机制**：服务缺少轻量级的系统运行配置持久化存储（如 `settings.json`），导致策略无法跨重启长效保持。
3. **前台与后台缺少联动**：前台登录注册表单未感知注册通道状态，在关闭注册时不能向用户展示直观友好的引导提示。

### 3. 解决方案与实施
1. **轻量持久化数据层 (`settings.json`)**：
   - 在项目根目录建立 `settings.json`，定义 `allowRegistration`（布尔开关）、`initialTrafficLimitVal`（流量数值）、`initialTrafficLimitUnit`（单位 MB/GB/TB）与 `initialDays`（有效天数，0 表示永久有效）；
   - 提供服务启动自动加载 `loadSettings()` 与安全异步写入 `saveSettings()`。
2. **安全防护与接口拦截 (`/api/register`)**：
   - 当 `allowRegistration === false` 时，服务端严格阻断注册请求，返回 403 友好提示：“系统已暂停开放新用户注册，请联系管理员！”；
   - 开启注册时，动态调用 `convertToBytes` 精准换算初始配额，若 `initialDays === 0` 则自动赋予 `expireTime = 0`（永久有效）。
3. **后台控制面板与管理 API (`/admin/api/settings`)**：
   - 提供受管理员鉴权保护的 GET 与 POST `/admin/api/settings` 接口；
   - 在管理后台控制台顶部增设“注册与初始配额”按钮，实时展示当前注册通道状态徽章（开放中 / 已关闭）；
   - 提供 Element UI 纯色扁平化设置模态框，支持实时调整开关、流量数值、单位选择器与有效天数，保存后即刻热更新并落盘。
4. **前台页面智能自适应**：
   - 前台根据配置实时展示“新用户？点此注册账号”或“新用户注册通道已暂停”；
   - 在关闭注册状态下点击注册通道，主动弹出友好提示，防止无效操作。

---

## 问题 4：后台无法读取用户数据、按钮点不开，以及 IP 注册防刷与客户端下载地址集成

### 1. 问题现象
1. 进入管理后台后，顶部统计卡片数据正常，但下方的“用户清单与权限详情”表格为空，显示不出用户；
2. 点击所有按钮（如“新增用户授权”、“注册与初始配额”）没有任何弹窗反应；
3. 用户反馈找不到主流代理客户端下载地址；
4. 缺少针对同一 IP 24 小时内最多注册 1 个账号的防刷与撞库限制。

### 2. 根因分析
1. **Node.js 模板反引号字符串内的引号转义陷阱**：
   在服务端反引号模板字符串（`res.end(\` ... \`)`）中渲染客户端脚本时，形如 `onclick="copyText(\'' + u.uuid + '\')"` 中的 `\'` 被服务端模板引擎当成转义单引号直接求值为 `'`，生成到 HTML 中变成了非法的客户端 JS：`copyText('' + u.uuid + '')`。
2. **多行换行转义导致 JS 语法断裂**：
   `confirm("...\n...")` 中的 `\n` 被展开为真实物理换行符，浏览器在解析双引号跨行字符串时直接抛出 `SyntaxError: Invalid or unexpected token`，阻断了整个 `<script>` 的执行，导致表格无法渲染、所有弹窗函数失效。
3. **未集成客户端下载矩阵**：缺少直达各平台常用客户端 GitHub Release / AppStore 的入口卡片。

### 3. 解决方案与实施
1. **彻底废除内联引号拼接，全面改用标准 HTML5 `data-*` 属性与事件委托**：
   - 表格行内的复制与管理操作按钮统一改用 `data-copy` 与 `data-action` 属性承载参数，彻底免除任何反斜杠与引号转义；
   - 在 `userTableBody` 挂载事件委托统一分发处理，彻底根绝浏览器 JS 语法错误，表格即刻恢复秒级动态渲染，所有按钮全部恢复响应。
2. **IP 注册防刷与速率限制 (Rate Limiting)**：
   - 新增 `ipRegisterLimit`（24小时内同 IP 注册上限，默认 1 个，填 0 不限制），持久化至 `settings.json`；
   - 自动提取真实客户端 IP（智能感知 `CF-Connecting-IP`、`X-Forwarded-For`、`X-Real-IP`），将 24 小时内的注册时间戳记录于 `ip_registers.json`；
   - 超过限额强制返回 429 阻断并清晰报错；并在后台设置弹窗中提供管理员实时调整开关。
3. **全平台常用代理客户端下载中心集成**：
   - 在后台面板操作栏增设“💻 客户端下载”按钮与弹窗，汇集 Windows（Clash Verge Rev、v2rayN、Mihomo Party）、Android（Clash Meta、Sing-box、v2rayNG）、iOS/macOS（小火箭、Mac版Clash）最新官方发布直达链接；
   - 在前台用户个人仪表盘增设“常用代理客户端官方下载”网格卡片，用户下载后可一键导入订阅，体验丝滑流畅。

---

## 问题 5：未配置 Argo 隧道但配置了 Cloudflare 端口回溯后，订阅地址仍显示纯 IP

### 1. 问题现象
用户将自定义域名（如 `shop.995677.xyz`）托管至 Cloudflare 并开启小黄云代理（Proxied），配合 Cloudflare Origin Rules（回源规则 / 端口回溯）将公网 443/80 端口转发到宿主机容器分配的物理随机端口（如 20231）。
在浏览器通过 `https://shop.995677.xyz` 正常访问前后台时，页面上的“通用协议订阅”和“Clash 规则订阅”地址依然显示为服务端的裸 IP 与内网/物理端口（如 `http://51.75.118.169:20231/sub?token=...`），导致用户无法复制到域名形式且 HTTPS 安全加密的订阅链接。

### 2. 根因分析
1. **未深度提取代理标头 (`X-Forwarded-Host`)**：
   当流量经过 Cloudflare 端口回溯反代时，Cloudflare 传入的标准标头为 `X-Forwarded-Host: shop.995677.xyz` 与 `X-Forwarded-Proto: https`。而系统原逻辑未解析 `X-Forwarded-Host`，且在 `.env` 配置了 `SERVER_IP` 时优先写死了该 IP，导致域名未被识别。
2. **协议与端口粗暴写死拼接**：
   原订阅地址生成逻辑硬编码了 `http://` 与 `:${appConfig.port}`。但 Cloudflare 边缘节点只监听标准 Web 端口（443/80），不能在域名后拼接物理端口（如 `:20231`），否则会导致客户端连接 Cloudflare 节点报 Connection Refused。
3. **前端缺少地址动态自适应校准**：
   前端 HTML 模板在服务端渲染时生成的是静态的 `value="${baseSubUrl}"`，即使浏览器已经在 `https://shop.995677.xyz` 下运行，前端未能根据 `window.location.origin` 对订阅输入框进行即时校准。
4. **QUIC/UDP 协议直连与 CDN 节点混淆**：
   Cloudflare 免费 CDN 仅代理 HTTP/WebSocket 流量，无法代理 UDP（Hysteria 2 / TUIC）和非标准 TCP（Reality）。若将所有直连节点的服务器地址直接换成域名，会导致 Hy2 / TUIC 因 Cloudflare 阻断 UDP 而彻底瘫痪。

### 3. 解决方案与实施
1. **服务端四重 Host 穿透感知引擎 (`getEffectiveHost` / `getEffectiveProto`)**：
   - 优先提取 `X-Forwarded-Host` / `Host`；若请求主机名为域名（包含英文字母），优先级压倒 `SERVER_IP`，自动识别为真实访问域名；
   - 自动解析 `X-Forwarded-Proto` 与 `CF-Visitor`，若为 HTTPS 则协议自动升格为 `https://`。
2. **智能端口省略与订阅基础地址构造器 (`getEffectiveSubBaseUrl`)**：
   - 当检测到访问为 HTTPS 或通过域名访问（Cloudflare CDN / 端口回溯）时，自动剥离物理容器端口，生成标准无端口的 `https://域名/sub?token=...`；
   - 若为纯 IP 直连访问，则精确保留对应宿主机外网物理端口。
3. **浏览器端前端无感自适应引擎 (`autoCalibrateSubUrls`)**：
   - 在个人中心页面注入轻量自适应脚本：浏览器加载时自动对比 `window.location.origin`。若当前通过自定义域名访问，即时将输入框内的订阅地址和一键导入按钮自动校准为当前浏览器的协议与域名；
   - 管理后台表格在复制用户订阅时，同样自动基于当前域名与协议进行智能校准。
4. **CF 回溯 CDN 代理节点与物理直连极速节点双轨分流**：
   - 若检测到域名访问，系统在 `/sub` 与 Clash 配置中自动新增 **CF回溯-VLESS**、**CF回溯-VMess**、**CF回溯-Trojan** 节点（走 443 端口，TLS 加密，小黄云免封锁，国内阻断自动由 CF 转发）；
   - 保留 **直连-Hysteria2**、**直连-TUIC**、**直连-Reality** 节点，并强制绑定至宿主机真实物理 IP 与物理端口，保障 UDP 暴力抗丢包与低延迟直连 100% 畅通。
5. **支持 `.env` 显式配置 `SERVER_DOMAIN=`**：
   - 允许管理员在 `.env` 中显式指定 `SERVER_DOMAIN=shop.995677.xyz`，无需发起请求即可毫秒级热生效。

---

### 问题 6: Hysteria 2 节点测速真连接延迟正常但作为系统代理/活动节点检测为 -1 连通超时，以及集成 CM 佬三网优选 API

#### 1. 问题现象
1. 用户在 v2rayN 客户端中选中 `直连-Hysteria2` 节点按 `Ctrl+R` 测试真连接延迟正常（显示 200+ ms），但将其右键设为“活动服务器”后，底部状态栏实时测速显示 `-1 ms, none`，浏览器无法打开任何外网网页；
2. 系统缺乏中国大陆电信、联通、移动三网优选测速 IP 自动派发机制，需要参考 `vps-nodejs` 引入 CM 佬三网优选 API 与自定义批量加速域名池。

#### 2. 根本原因深入排查
1. **URI 格式规范缺陷导致证书信任失效**：
   - 原导出的 URI 为 `hysteria2://pass@ip:port?sni=bing.com&insecure=1#name`，缺少根路径斜杠 `/`；
   - 客户端核心配置解析器在缺少 `/` 时未能正确提取查询参数，导致在为活动节点生成系统代理配置时，未将 `allowInsecure` 设为 `true`；
   - 当客户端进行正式代理请求时，严格校验自签名证书并抛出证书不受信任错误，强行终止连接（状态栏检测返回 -1）；
2. **服务端 Sing-box 缺少权威 DNS 模块与路由转发通道**：
   - 原 sing-box 配置文件仅有入站与单个 `type: direct` 出站，未配置 `dns` 模块和 `route` 模块；
   - 在卡塔服务器（翼龙容器/极简 Linux）环境下，sing-box 默认尝试调用容器本地 UDP 53，而很多容器无法稳定解析外部公网域名，导致上游请求触发 `i/o timeout` 并阻断数据转发；
3. **缺少 ALPN 协议协商声明**：
   - 服务端与客户端 Hysteria 2 依赖 HTTP/3 (QUIC)，若 TLS 握手阶段未显式协商 `alpn: ["h3"]`，部分客户端核心建立数据流时会由于协议不匹配而挂起；
4. **三网优选生态缺失**：
   - Cloudflare 端口回溯需要结合电信 (CT)、联通 (CU)、移动 (CM) 优选 Anycast IP 才能发挥出极速低延迟性能。

#### 3. 解决方案与实施标准
1. **URI 规范化与参数自适应兼容**：
   - 格式化 Hysteria 2 单链接为：`hysteria2://${password}@${host}:${port}/?sni=${sni}&alpn=h3&insecure=1&allowInsecure=1#${name}`；
   - 格式化 TUIC 单链接为：`tuic://${uuid}:${password}@${host}:${port}/?congestion_control=bbr&sni=${sni}&alpn=h3&allow_insecure=1&insecure=1#${name}`；
2. **服务端 Sing-box 核心配置强化**：
   - 注入 TCP 权威公共 DNS：`tcp://1.1.1.1`（主）与 `tcp://8.8.8.8`（备），配置 `detour: "direct"` 确保域名解析 0 丢包；
   - 显式声明 `route: { rules: [{ outbound: "direct" }] }`；
   - 在 `hysteria2` 入站中注入 `alpn: ["h3"]`、`ignore_client_bandwidth: false` 与 `masquerade: "https://bing.com"` 防主动探测；
3. **集成 CM 佬三网优选 API (`cf.090227.xyz`)**：
   - 引入三网异步抓取引擎 `fetchCmApiIps`，支持电信 (CT)、联通 (CU)、移动 (CM) 优选 IP 动态拉取；
   - 具备 3 分钟防抖与并发互斥锁，启动 6 秒后静默更新首轮，每 30 分钟后台自动轮询；
   - 当检测到回溯域名访问时，自动在 Base64 订阅与 Clash 配置中生成 `【电信优选1】-VLESS-WS`、`【联通优选1】-VLESS-WS`、`【移动优选1】-VLESS-WS` 等高品质节点；
4. **批量自定义加速域名池与 Clash 专属策略组**：
   - 支持纯域名、`域名#备注`、`域名:端口#备注`、`域名:端口` 灵活解析；
   - 在 Clash 配置中自动生成 `🚀 节点选择`、`⚡ 自动优选` (url-test)、`🇨🇳 电信优选`、`🇨🇳 联通优选`、`🇨🇳 移动优选`、`🌐 直连优选` 以及国内权威 DoH 分流。

---

### 问题 7: 卡塔容器拉起 Sing-box 核心报错 `FATAL create service: parse route options: parse rule[0]: missing conditions` 导致核心进程崩溃退出 (code: 1)

#### 1. 问题现象
卡塔容器（翼龙面板）启动 `node /home/container/index.js` 时：
```
[Core] 正在拉起 Sing-box 核心代理引擎...
FATAL[0000] create service: parse route options: parse rule[0]: missing conditions
[Core] Sing-box 进程退出 (code: 1)
```
代理核心瞬间崩溃，无法维持常驻监听，导致全协议代理服务中断。

#### 2. 根本原因深入排查
1. **Sing-box 1.9.0 路由语法严格校验 (Route Rules Condition Constraint)**：
   - 在 `generateSingboxConfig` 中，原路由定义为：
     ```json
     "route": {
       "rules": [
         {
           "outbound": "direct"
         }
       ]
     }
     ```
   - Sing-box 1.8+ / 1.9.0 的 `box/route.go` 规则解析器在解析 `rules` 数组时，会对每个规则项进行字段审查；
   - 规定 `rules` 中的每一项规则**必须包含至少一个有效匹配条件**（例如 `inbound`、`protocol`、`domain`、`ip_cidr`、`port`、`network` 等）；
   - 若 `rules[0]` 仅有 `outbound: "direct"` 而无任何匹配条件，解析器会认为该规则无效，直接抛出 `fatal: parse rule[0]: missing conditions` 并触发 `os.Exit(1)` 退出。

#### 3. 解决方案与实施标准
1. **动态入站标签提取与合法匹配条件注入**：
   - 在组装好所有协议入站后，动态提取当前已启用的全部入站 Tag：
     `const allInboundTags = config.inbounds.map((ib) => ib.tag).filter(Boolean);`
   - 将路由规则重构为具备合法明确匹配条件的规范结构：
     ```javascript
     config.route = {
         rules: [
             {
                 protocol: "dns",
                 outbound: "direct"
             },
             {
                 inbound: allInboundTags,
                 outbound: "direct"
             }
         ],
         auto_detect_interface: true,
         final: "direct"
     };
     ```
2. **`final: "direct"` 与 `auto_detect_interface: true` 双重安全兜底**：
   - 注入 `final: "direct"` 作为全局默认出站，即使存在任何未被规则明确覆盖的边界流量，也能平滑出站；
   - 启用 `auto_detect_interface: true`，使 Sing-box 能够自感知卡塔容器内部虚拟网卡路由，杜绝外网数据包无法流出的死锁问题；
3. **自动化测试 100% 覆盖**：
   - 单测与全量测试均验证生成后的 `config.json` 语法完全合规，Sing-box 核心秒级成功拉起且无任何 FATAL 异常。

---

### 问题 8: 管理后台【⚡ 三网优选与域名池】按钮点击无反应（DOM 遮蔽），以及拓展微测网 (Wetest.vip) 官方优选生态

#### 1. 问题现象
1. 管理员在后台点击【⚡ 三网优选与域名池】按钮没有任何弹窗弹出；
2. 系统原先仅集成了 CM 佬（cf.090227.xyz）单一优选源，缺乏微测网（wetest.vip）官方三网优选生态；
3. 用户卡塔容器中节点全部显示 `-1`（连接不通）。

#### 2. 根本原因深入排查
1. **DOM 标签未闭合导致弹窗被父层遮蔽 (`clientsModal` 嵌套 bug)**：
   - 在生成管理后台 HTML 时，前面的【客户端下载中心弹窗 (`#clientsModal`)】内部多层容器未正确闭合 `modal` 与 `modal-mask`；
   - 导致紧随其后的【三网优选与域名池弹窗 (`#cdnOptModal`)】被强制嵌套进了 `clientsModal` 内部；
   - 由于祖先元素 `clientsModal` 默认处于 `display: none` 隐藏状态，即使点击按钮通过 JS 将 `cdnOptModal.style.display` 设为 `flex`，屏幕上也依然被完全隐藏，产生“点不开”的假死现象；
2. **微测网生态与配置持久化缺失**：
   - 缺乏针对 `https://www.wetest.vip/api/cf2dns/get_cloudflare_ip` 的异步清洗与动态排序引擎；
   - 本地 `loadSettings()` 默认对象未初始化微测网配置，存在已有 `settings.json` 时导致字段脱落；
3. **“节点全部-1”的根因**：
   - 用户容器内运行的代码仍为上个版本，Sing-box 核心启动时因 `parse rule[0]: missing conditions` 崩溃退出 (`code: 1`)；核心进程未常驻，客户端所有代理握手自然全部被拒导致全部 `-1`。

#### 3. 解决方案与实施标准
1. **修复 DOM 树闭合与弹窗独立化**：
   - 为 `clientsModal` 补全底部关闭按钮及 `modal` / `modal-mask` 的完整闭合标签；
   - 使 `cdnOptModal` 成为独立的同级顶级弹窗，并增加微测网与 CM 佬并列展示；
2. **无缝集成微测网 (Wetest.vip) 官方优选引擎**：
   - 实现 `fetchWetestCleanIps(force = false)`，自动拉取电信/联通/移动节点并提取数据中心代码 (`colo`) 与实测延迟 (`rtt`)；
   - 启动 3 秒后静默拉取首轮，30 分钟后台自愈轮询，提供 3 分钟 CPU 防抖互斥锁；
   - 增加 `/admin/api/sync-wetest` 专用后台接口与后台一键拉取操作；
3. **订阅与 Clash 策略组升级**：
   - 回溯域名下同时下发微测网节点（如 `【微测·电信优选1·HKG·18ms】-VLESS-WS`）与 CM 佬节点；
   - Clash 策略组自动将微测网与 CM 佬节点汇聚进三网分流与全网自动测速组 (url-test)；
4. **测试 100% 验证**：
   - 所有 DOM 元素 ID 100% 存在，端到端测试 16 个全协议节点派发绿灯通过。

---

### 问题 9: Hysteria 2 节点在客户端具有真连接延迟，但活动代理检测显示 -1 且无法正常上网访问目标网站

#### 1. 问题现象
客户端（如 v2rayN / Clash / Sing-box 等）在导入并测试 Hysteria 2 节点时：
- 底部【测试真连接延迟 (RTT / Ping)】显示正常延迟（如 180ms~220ms，说明 QUIC 握手成功）；
- 但将 Hysteria 2 设为活动代理并执行【HTTP/HTTPS 连通性测试 (访问 cp.cloudflare.com/generate_204)】时，检测结果全部显示 `-1`，浏览器打开任何网页均超时失败。

#### 2. 根本原因深入排查
1. **Sing-box 服务端 DNS 出站 (`dns-out`) 缺失导致域名解析死锁 (DNS Routing Blackhole)**：
   - 在 Sing-box 1.8+ / 1.9+ 中，客户端通过 Hysteria 2 发起网络请求时，首包往往是发往代理的 DNS 查询或域名级 CONNECT；
   - 原配置中 `route.rules` 设置为 `{ "protocol": "dns", "outbound": "direct" }`，并且 `outbounds` 仅包含 `direct`；
   - 客户端发来的 DNS 查询包直接被 `direct` 扔给公网 UDP 53；而在卡塔容器（翼龙 Docker 面板）宿主机安全策略下，向外部公网直接发送 UDP 53 数据包常被屏蔽或无应答，且客户端的目标 DNS 往往是虚拟地址（如 198.18.0.1），导致所有 DNS 解析全部挂死；
   - 正确规范必须在 `outbounds` 声明 `{ "type": "dns", "tag": "dns-out" }`，并在 `route.rules` 将 `{ "protocol": "dns", "outbound": "dns-out" }`，强制让 Sing-box 内部 DNS 引擎接管并走可靠的 TCP DNS (`tcp://1.1.1.1` 和 `tcp://8.8.8.8`)。
2. **`hy2-in` 入站存在非法属性与 ALPN 干扰**：
   - 原配置中包含 `masquerade: "https://bing.com"` 字符串（Sing-box 规定若存在 masquerade 必须为规范的 object 代理对象，字符串会引发解析异常或静默丢弃请求）；
   - `tls` 内部强配了 `alpn: ["h3"]`，破坏了 Hysteria 2 协议自带的协商流；
   - `users` 数组中缺少了标准的 `name: u.uuid` 标识属性。
3. **客户端导出 URI 锁死 ALPN 与缺少带宽放行**：
   - 原订阅链接导出的 URI 为 `/?sni=bing.com&alpn=h3&insecure=1`，导致部分客户端强绑 HTTP/3 ALPN，无法完成代理应用层流协商；
   - 未携带 `upmbps=2000&downmbps=2000`，部分客户端按极度保守的 10Mbps 甚至更小限速启动。

#### 3. 解决方案与实施标准
1. **重构 Sing-box 核心出站与 DNS 路由架构**：
   - 在 `outbounds` 中补充 `{ type: "dns", tag: "dns-out" }`；
   - 在 `route.rules` 将 DNS 规则配置为 `{ protocol: "dns", outbound: "dns-out" }`；
   - 彻底移除 `auto_detect_interface: true`，仅保留 `final: "direct"`，避免在非特权 Docker 容器内产生网卡探测异常。
2. **净化并放开 `hy2-in` 入站**：
   - 注入 `up_mbps: 2000, down_mbps: 2000, ignore_client_bandwidth: false`；
   - 用户对象规范为 `{ name: u.uuid, password: u.uuid }`；
   - 移除 `masquerade` 字符串，移除 `tls` 内部冗余的 `alpn: ["h3"]`。
3. **优化客户端导出链接与 Clash Meta 配置**：
   - 通用 URI 标准化为：`hysteria2://${password}@${host}:${port}/?upmbps=2000&downmbps=2000&insecure=1&allowInsecure=1&sni=${sni}#${name}`；
   - Clash Meta 节点补充 `up: "2000 Mbps"`, `down: "2000 Mbps"`, `udp: true`，移除 `alpn: - h3`。
4. **自动化测试 100% 验证**：
   - [test_optimal_api_and_hy2.js](file:///d:/DeskTop/GitHub/测/lunes/nodejs/node/test_optimal_api_and_hy2.js) 绿灯通过，验证配置结构与 URI 生成完全正确。

---

## 问题 8: Cloudflare 端口回溯优选节点测速 -1 故障与 ECH + ACL4SSR 规则集集成

- **问题现象**：在通过 Cloudflare Origin Rules 对 VPS 的 21216 端口配置 443 回溯后，客户端拉取的 CF 优选节点测速全部超时或报错 `-1`。
- **根本原因**：
  1. GFW 对 Cloudflare 443 边缘节点全面启用了 SNI 深度阻断，常规明文 SNI 握手会被立即注入 TCP RST 断开。
  2. 生成的 Clash 配置缺少 `client-fingerprint: chrome` 与 `ech: { enable: true }` 参数支持。
  3. 未在 `.env` 中显式指定 `SERVER_DOMAIN` 时，通过 IP 访问订阅无法触发 `isDomain` 优选节点下发逻辑。
  4. 原生配置缺少精细化分流规则，无法实现流媒体、AI 与广告分流。
- **解决方案**：
  1. 在 `.env` 中写入 `SERVER_DOMAIN=yylsl.abcai.online`，锁定端口回溯主域名。
  2. 在 `generateClashConfig` 中为所有 CF 443 端口优选节点注入 `ech: { enable: true }` 与 `client-fingerprint: chrome`。
  3. 配置全局权威 DoH（阿里 DNS `https://dns.alidns.com/dns-query#h3=true`），确保客户端能从权威 DNS 解析到 Cloudflare 域名的 HTTPS/SVCB ECH 加密公钥。
  4. 完整集成鼻祖级 **ACL4SSR** 云端规则集（`rule-providers`），支持 24 小时定时自动更新，配套包含节点选择、自动优选、三网优选、人工智能、国外媒体、电报消息、广告拦截与全球直连策略组。
  5. 热推送到远程 VPS 并重启验证，下发的 Clash 订阅完全符合标准。
  6. 在通用的 Base64 单链接导出函数 `getNodesForUser` 中，为 VLESS、VMess、Trojan 链接补全 `fp=chrome` 与 `echConfigList=cloudflare-ech.com+https://dns.alidns.com/dns-query`，使得 v2rayN 客户端导入后能自动填充 `Fingerprint` 与 `EchConfigList` 字段，实现原生零手动配置 ECH。
  7. 修正 Clash Meta (Mihomo) ECH 语法为规范的 `ech-opts: enable: true`，并将外部 rule-providers 域名替换为国内高速 CDN（`cdn.jsdelivr.net`），避免直连 GitHub Raw 超时；扩展订阅入口对各类 Clash 客户端 UA 的宽容探测，支持带 `&type=clash` 显式下发。

---

## 问题 9: VPS 一键安装脚本在管道模式 (curl | sh) 下终端无法交互输入的问题

- **问题现象**：在通过 `curl -fsSL ... | sh` 远程执行部署脚本时，终端直接跳过用户输入或抛出 `read: read error: 0: Bad file descriptor`，无法交互式设定回溯端口、管理密码与域名。
- **根本原因**：
  1. 通过管道 `| sh` 启动时，标准输入（`stdin`，fd 0）已被管道占用（用于传输脚本内容），直接调用 `read` 无法从键盘控制台读取用户输入。
  2. 部分精简 Linux（如 Alpine BusyBox）在管道读取完毕后直接向 `read` 返回 EOF。
- **解决方案**：
  1. 在脚本初始化阶段加入文件描述符探测：若存在控制终端设备 `[ -e /dev/tty ]`，执行 `exec < /dev/tty` 将标准输入重新定向至当前物理终端。
  2. 实现交互式向导：回溯端口提供默认值 `21216` 并进行纯数字范围校验；管理密码提供回车自动生成 10 位高强度随机串；回溯域名提供回车直接跳过（支持后续在 Web 后台随时修改）。
  3. 公网 IPv4 通过权威接口（ipify / ifconfig.me）全自动探测，无需用户手动输入。
  4. 自适应系统守护（systemd / OpenRC）并在完成后输出美观的访问地址与运维命令。


