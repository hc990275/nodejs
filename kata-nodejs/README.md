# Kata-Tunnel 使用说明

本项目位于 **[hc990275/nodejs 的 kata-nodejs/ 目录](https://github.com/hc990275/nodejs/tree/main/kata-nodejs)**。它使用原生 Node.js 提供 VLESS over WebSocket TCP 转发、用户管理、订阅导出、三网节点池和可选 Cloudflare Tunnel。无需 npm 运行依赖，适用于小内存容器。实际内存和并发能力取决于负载，不能保证固定内存占用或零中断。

## 1. 文件与环境要求

使用 Node.js 20 或更高版本，建议 Node.js 24。入口与模块必须保持以下相对位置：

```text
kata-nodejs/
├── index.js
├── package.json
├── .env.example
├── src/
│   ├── security.js
│   └── protocol.js
├── test/                 # 本地回归测试，不必上传生产
└── data/                 # 运行时生成，保存用户和设置
```

**不能只上传 index.js**，否则启动会出现 `Cannot find module ./src/security` 或 `./src/protocol`。

## 2. 下载与本地启动

```sh
git clone https://github.com/hc990275/nodejs.git
cd nodejs/kata-nodejs
cp .env.example .env
# 编辑 .env：必须设置自己的 ADMIN_PASSWORD、端口和 SUB_DOMAIN
npm test
npm start
```

`.env` 中的最小配置示例：

```ini
PORT=20255
ADMIN_PASSWORD=请替换为独立随机的强密码
SUB_DOMAIN=你的公网IP或域名
DEFAULT_ALLOW_REGISTER=false
DEFAULT_DAYS=30
DEFAULT_TRAFFIC_GB=10
SUBAPI=local
ENABLE_ECH=false
```

管理员密码建议至少 20 位，后台修改密码要求至少 12 位；不要照抄示例口令。服务监听 `0.0.0.0`，本地测试应通过防火墙或隔离环境限制访问。访问 `http://你的服务器地址:端口/`，后台为 `/admin`。

## 3. KataBump / 翼龙面板部署

1. 在面板选择 Node.js 运行环境，记下分配的业务端口；SFTP 端口与业务端口不同。
2. 使用面板 Settings 提供的 SFTP 主机、用户名和密码连接。SFTP 根目录通常对应 `/home/container`。
3. 上传 `index.js`、`package.json`、完整 `src/` 目录。首次部署将 `.env.example` 复制为 `.env`，填写自己的配置；不要上传仓库中的整个父目录。
4. 面板会注入 `SERVER_PORT` 时可把 `.env` 的 `SERVER_PORT`、`PORT` 留空。端口优先级为进程环境 `SERVER_PORT` → `PORT` → `.env` 中两者 → 默认 `20255`。
5. 启动命令设置为 `node --max-old-space-size=96 /home/container/index.js`，或在项目根目录使用 `npm start`。没有运行依赖需要安装。
6. 点击启动，查看控制台是否出现核心启动标记，再打开首页与 `/admin`。检查至少两分钟，不能仅凭面板 Running 判断成功。

公网使用建议通过自己的 HTTPS 反向代理或 Cloudflare Tunnel 访问。容器公网业务端口应按实际用途控制访问。

## 4. 后台和用户操作

- 打开 `/admin`，使用 `.env` 的 `ADMIN_PASSWORD` 登录。无密码时后台拒绝登录；没有通用默认管理员密码。
- 用户库为空时不会自动生成用户。点击“添加新用户”，设置用户名、至少 10 位密码、有效天数和流量配额。密码留空时会生成一次性展示的随机临时密码，请立即保存。
- 用户列表默认折叠，显示用户名、状态和已用流量。点击用户展开配额、UUID、到期时间及编辑、封禁、续期、删除操作。
- 每行右侧“复制订阅”直接复制该用户完整订阅地址，不必展开。UUID 按钮复制 UUID，和复制订阅不同。
- 列表上方点击“流量”可反复切换用量从多到少、从少到多。“在线”和“注册时间”也支持排序；也可使用下拉框、搜索和分页。
- 用户在首页登录后可查看配额及到期信息，复制或导入客户端订阅。公开注册默认关闭，可由后台开启并设置注册限额。
- 封禁、删除及修改 UUID 可能断开该用户连接。重启核心会影响所有现有连接；请在维护时段操作。

## 5. 订阅与客户端

通用订阅为 `/sub?token=用户UUID`；可附加 `&target=clash`、`&target=singbox`、`&target=surge` 或 `&target=qx`。完整链接中的 UUID 属于访问凭据，禁止公开分享。

优先使用支持 VLESS over WebSocket 的客户端及通用节点导入。内置转换输出需要与实际客户端版本核验，尤其 sing-box 的配置字段可能随版本变化；Surge、Quantumult X 的 VLESS 支持请以客户端版本能力为准，不能保证所有导出格式直接可用。本项目原生数据面支持 TCP，不提供完整 UDP 转发；不要把配置中的 UDP 标记当作实际 UDP 支持。

## 6. 配置说明

| 配置键 | 用途 |
| --- | --- |
| `SERVER_PORT` / `PORT` | 面板业务端口，注意进程环境优先于文件 |
| `ADMIN_PASSWORD` | 管理员密码；请设置独立强密码 |
| `SUB_DOMAIN` | 实际可达的公网 IP 或域名，必须自行配置 |
| `DEFAULT_ALLOW_REGISTER` | 首次启动是否允许注册，默认 false |
| `DEFAULT_DAYS` / `DEFAULT_TRAFFIC_GB` | 新用户默认天数及 GB 配额，默认 30 / 10 |
| `IP_REGISTER_COOLDOWN_SEC` | 同 IP 注册冷却秒数，默认 60 |
| `IP_DAILY_REGISTER_LIMIT` | 同 IP 24 小时注册上限，默认 3 |
| `ARGO_TOKEN` / `ARGO_DOMAIN` | 可选 Cloudflare Tunnel Token 和自己的公开主机名 |
| `WETEST_API_URL` | 自己获授权的 Wetest API 完整地址；不配置则保留当前节点池 |
| `SUBAPI` / `SUBCONFIG` | 本地转换使用 local；外部转换地址和模板需自行评估 |
| `ENABLE_ECH` / `ECH_SNI` / `ECH_DNS` | ECH 开关、查询名称和 DoH 地址；需服务端及客户端共同支持 |
| `CLIENT_FINGERPRINT` | TLS 客户端指纹名称 |

部分后台设置保存在 `data/settings.json`，已存在的设置会覆盖首次启动默认值。`.env` 同时支持进程内热更新，但建议修改关键配置后在维护窗口重启核验。开启 `NODE_ENV=production` 后会使用 Secure Cookie，浏览器需通过 HTTPS 登录。

Argo 可选：在 Cloudflare Zero Trust 创建 Tunnel，把公开主机名转发至 `http://127.0.0.1:业务端口`，填写 Token 和域名。程序可能自动下载并启动 `cloudflared`，因此需联网和足够磁盘；应在可信环境使用并核验二进制来源。Token 不回显到后台设置接口。

## 7. 更新、备份和恢复

更新前备份实际线上 `index.js`、`package.json`、`src/`，同时将 `.env` 和 `data/` 私下备份到安全位置。**升级时保留现有 .env 和 data/，不要用示例覆盖。** 上传四个源码/清单文件并校验，再重启、查看控制台和页面。失败时恢复旧入口、旧模块和清单后重启；用户数据恢复必须明确选择需要的备份版本。

`data/users.json` 保存用户密码哈希、UUID 和流量等敏感数据；`data/settings.json`、`.env` 可能含 Token。它们不应提交 Git、贴到工单或发送到公开日志。会话在内存中，重启后需要重新登录；旧 SHA-256 用户密码在成功登录时迁移为 PBKDF2。

## 8. 测试和排障

```sh
node --check index.js
npm test
```

- 模块找不到：补传 `src/security.js` 和 `src/protocol.js`，检查大小写及目录层级。
- 页面无法访问：确认业务端口、容器监听、防火墙和域名回源端口一致。
- 登录失败或 429：核对管理员密码，等待失败限速窗口结束；生产 Secure Cookie 必须使用 HTTPS。
- 订阅不可用：检查用户是否被封禁、到期或超额，再确认域名、TLS、WebSocket 回源及客户端能力。
- Wetest 同步失败：核对自己的 `WETEST_API_URL`、授权和响应结构；默认节点数据不代表当前实测延迟。
- 面板提示停止 60 秒后再重启：视为启动失败，先读控制台错误，修复后再启动，避免反复盲目重启。

维护状态：包含紧凑用户列表、订阅复制、可见排序、认证加固及 11 项回归测试。仍需结合真实客户端验证端到端转发及 ECH；HTTP 页面正常不等同于代理功能全部通过。
