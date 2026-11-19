> **项目定位**：本项目由 `kata-nodejs`（Kata-Tunnel）复刻而来，面向 **Altare 平台**（https://altare.gg）的 Node.js 容器环境。已将品牌字样、订阅名称、管理界面、容器规格等从 Kata/卡塔 统一改为 Altare。功能与上游一致：纯原生零依赖的 VLESS-WebSocket 隧道、三网优选节点池、订阅转换（6 格式 + ECH）和 Web 管理后台。

# Altare-Tunnel（altare-nodejs）使用与部署说明

原生 Node.js 实现的 VLESS over WebSocket 隧道服务，带用户管理、订阅导出、三网优选节点池和可选 Cloudflare Tunnel。无第三方运行依赖，适合小内存容器（Altare / Lunes Host / 翼龙面板）。

仓库位置：`https://github.com/hc990275/nodejs` 的 `altare-nodejs/` 目录。

## 1. 文件结构

```text
altare-nodejs/
├── index.js          # 主程序（必须）
├── package.json      # 启动与测试脚本（必须）
├── .env.example      # 配置模板（部署时复制为 .env）
├── src/
│   ├── security.js      # 密码哈希、会话、限速（必须）
│   ├── protocol.js      # WebSocket/VLESS 协议解析（必须）
│   ├── sub_converter.js # 现代订阅转换引擎：6 格式 + ECH 规范（必须）
│   └── yaml-lite.js     # 零依赖 YAML 序列化，供 sub_converter 生成 Clash 配置（必须）
├── test/             # 回归测试，仅本地运行，不必上传
└── data/             # 运行时生成，保存用户与设置
```

注意：`src/` 四个模块必须一起上传，只传 `index.js` 会报 `Cannot find module './src/security'` 或 `Cannot find module './src/sub_converter'`。

## 2. 环境要求

- Node.js 20 或更高版本（推荐 24）
- 无 npm 运行依赖，无需 `npm install`
- 端口：由面板注入，或手动在 `.env` 配置

## 3. 本地启动

```sh
git clone https://github.com/hc990275/nodejs.git
cd nodejs/altare-nodejs
cp .env.example .env
# 编辑 .env，按需配置（见第 6 节）
npm test          # 可选：运行 11 项回归测试
npm start         # 启动
```

启动后访问：

- 首页：`http://服务器地址:端口/`
- 管理后台：`http://服务器地址:端口/admin`

服务监听 `0.0.0.0`。本地测试请通过防火墙或隔离环境限制访问。

## 4. 面板部署（Altare / Lunes / 翼龙）

1. 新建服务器，选择 Node.js 运行环境，记下面板分配的业务端口（SFTP 端口与业务端口不同）。
2. 用面板 Settings 里给出的 SFTP 主机、端口、用户名、密码连接。SFTP 根目录通常对应 `/home/container`。
3. 上传这些文件到容器根目录：`index.js`、`package.json`、整个 `src/` 目录。首次部署把 `.env.example` 复制为 `.env` 并填写配置。不要上传整个父目录，也不要上传 `test/`。
4. 端口：面板注入 `SERVER_PORT` 时，`.env` 里的 `SERVER_PORT`、`PORT` 留空即可；程序会自动探测面板端口（进程环境变量 → `/proc` → 命令行 → 模糊匹配）。手动部署才需要显式填写。不再有固定默认端口，探测不到端口时服务挂起等待。
5. 启动命令填写：`node --max-old-space-size=96 /home/container/index.js`（或在项目根目录用 `npm start`）。
6. 点击启动，查看控制台是否出现核心启动标记，然后打开首页与 `/admin`。观察约两分钟确认稳定，不要只看面板 Running。
7. 公网建议通过自己的 HTTPS 反代或 Cloudflare Tunnel 访问。

## 5. 首次设置管理员密码

两种任选其一：

- **方式 A（部署前写死）**：在 `.env` 里设置 `ADMIN_PASSWORD=你的强密码`（至少 10 位，建议 20 位以上）。启动后直接用它登录后台。
- **方式 B（首次进后台设置）**：`.env` 里 `ADMIN_PASSWORD` 留空。首次打开 `/admin` 会进入"首次设置管理员密码"页面，输入密码并确认（至少 10 位），设置后自动写入 `.env` 并进入后台。未设置密码前无法进入后台。

## 6. 配置项说明（.env）

复制 `.env.example` 为 `.env` 后按需修改：

| 配置键 | 用途 |
| --- | --- |
| `SERVER_PORT` / `PORT` | 业务端口。面板注入时留空，程序自动探测；手动部署才填 |
| `ADMIN_PASSWORD` | 管理员密码。留空则走首次设置向导（见第 5 节） |
| `SUB_DOMAIN` | 首选公网域名或 IP。留空时自动使用隧道域名 `ARGO_DOMAIN`，无隧道则自动探测公网 IPv4 |
| `SERVER_IP` | 公网 IPv4 回退值。留空时自动探测（无需手动填） |
| `DEFAULT_ALLOW_REGISTER` | 首次启动是否开放注册，`true` / `false` |
| `DEFAULT_DAYS` | 新注册用户默认有效天数 |
| `DEFAULT_TRAFFIC_GB` | 新注册用户默认流量（GB） |
| `IP_REGISTER_COOLDOWN_SEC` | 同 IP 两次注册的间隔秒数 |
| `IP_DAILY_REGISTER_LIMIT` | 同 IP 24 小时注册上限 |
| `ARGO_TOKEN` | 可选，Cloudflare Tunnel Token，填了才会启动隧道进程 |
| `ARGO_DOMAIN` | 可选，隧道公开域名；未填隧道域名时订阅不会生成隧道节点 |
| `ENABLE_ECH` | 是否启用 ECH，`true` / `false` |
| `ECH_SNI` | ECH 查询用的 SNI 域名 |
| `ECH_DNS` | 查询 ECH 配置的 DoH 地址 |
| `CLIENT_FINGERPRINT` | TLS 客户端指纹（如 chrome） |
| `SUBAPI` | 订阅转换后端，`local` 表示本地转换 |
| `SUBCONFIG` | Clash 分流规则模板地址 |
| `WETEST_API_URL` | 三网优选 API 地址，留空则不拉取 |

说明：

- 后台"系统设置"里修改的配置会自动写回 `.env` 并热加载，无需重启。
- 隧道 Token：未填时不启动隧道进程；在后台填入并保存后会自动拉起/重载隧道；只改 Token 才会重启隧道，Token 不变只改域名不会重启。
- 域名只能手动填，程序无法从 Token 反推域名。
- 订阅节点不写入固定 ALPN，保证 ECH 正常协商。

## 7. 管理后台与用户操作

打开 `/admin` 登录后可：

- **添加用户**：填用户名、密码（至少 10 位）、有效天数、流量配额。密码留空会生成一次性随机临时密码，请立即保存。
- **用户列表**：紧凑表格，手机端三列显示「账号名称 / 已用流量 / 在线」。用户名带虚线框，点击直接打开编辑框。列表默认按在线连接数从多到少排序，点击表头「已用流量」「在线」「注册时间」可切换升降序。支持搜索、分页（每页 5 条）。
- **在线徽章**：绿色圆点 + 数字表示当前连接数；未显示数字表示离线。
- **封禁/解封/续期/删除**：在用户编辑框内操作。封禁和删除会断开该用户连接。
- **重启核心**：顶部工具栏按钮，会重启 Node 服务，影响所有在线连接，请在维护时段使用。

## 8. 订阅地址

格式：`/sub?token=用户UUID`

可附加参数切换格式（不带参数时按客户端 UA 自动识别，识别不了落到通用 Base64）：

| target | 格式 | 适用客户端 |
| :--- | :--- | :--- |
| `base64`（默认） | 通用 VLESS URI（标准 ECH 字段） | v2rayN / v2rayNG / Shadowrocket / Hiddify / Karing |
| `clash` | Mihomo / Clash Meta YAML | Clash Verge Rev / Clash Party / FlClash / CMFA / Stash / OpenClash |
| `singbox` | sing-box JSON | sing-box 官方 / Throne / GUI.for.SingBox |
| `surge` | Surge 配置 | Surge（Mac/iOS）/ Surfboard |
| `qx` / `quantumultx` | Quantumult X 配置 | Quantumult X |
| `loon` | Loon 配置 | Loon（iOS/tvOS） |

该订阅转换引擎从 liuyang 导航站移植，ECH 字段已按各客户端官方规范处理（Base64 用 `ech`、Clash 用 `ech-opts`、sing-box 用 `tls.ech` 无 enabled 字段；Surge/QX/Loon 不支持 ECH 则降级为普通 TLS）。UUID 是访问凭据，不要公开分享。

## 9. 更新与备份

1. 更新前备份线上 `index.js`、`package.json`、`src/`，以及私下的 `.env`、`data/`。
2. **升级时保留现有 `.env` 和 `data/`，不要用示例覆盖。**
3. 上传新版本源码文件，校验，重启，查看控制台和页面。
4. 失败时恢复旧文件并重启；恢复用户数据请选对备份版本。

说明：`data/users.json` 保存密码哈希、UUID、流量；`.env` 含 Token。这些文件不要提交 Git 或贴到公开日志。会话在内存，重启需重新登录；旧 SHA-256 密码在登录成功时自动迁移为 PBKDF2。

## 10. 测试与排障

```sh
node --check index.js
npm test
```

- 模块找不到：补传 `src/` 下四个模块（`security.js`、`protocol.js`、`sub_converter.js`、`yaml-lite.js`），检查大小写与目录层级。
- 页面打不开：确认业务端口、容器监听、防火墙、域名回源端口一致。
- 无法登录或提示 429：核对管理员密码，等待限速窗口结束；若开启 `NODE_ENV=production`，必须用 HTTPS 登录。
- 订阅不可用：检查用户是否被封禁/到期/超额，再检查域名、TLS、WebSocket 回源和客户端能力。
- 隧道不通：确认 `ARGO_TOKEN` 与 `ARGO_DOMAIN` 都已填写并保存；Token 才触发隧道拉起。
- 面板提示"停止 60 秒后再重启"：视为启动失败，先读控制台错误，修复后再启动。

## 7. 首次部署设置管理员密码

`.env` 中 **可以不预置 `ADMIN_PASSWORD`**。此时首次访问 `/admin` 会强制显示"首次设置管理员密码"表单：

- 未设置密码前，普通登录接口不可用（无法用空密码登录），只能走 `/admin/api/setup-password`
- 设置成功后，密码会**原子写回 `.env`**，且 `setup-password` 入口永久关闭，后续正常用密码登录
- 这保证新部署的机器不会以默认/空密码暴露后台

## 8. 多机器区分（国家/地区标识）

订阅中的节点名会自动加上机器归属地前缀，格式：

```
【🇲🇳蒙古·25206·原生直连·Altare】-VLESS-WS
【🇸🇬新加坡·30815·CF·电信优选·1·SIN】-VLESS-WS
```

- 启动时异步探测公网 IP 归属地（ip-api.com / ipinfo.io，带超时，失败回退 `🌐未知地区`）
- 前缀 = 国旗 + 地区中文名 + 面板端口，同一订阅下多台机器一眼可分
- 客户端指纹、ECH 等其它参数不受影响
