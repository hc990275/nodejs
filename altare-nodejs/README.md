> **项目定位**：本项目由 `kata-nodejs`（Kata-Tunnel）复刻而来，面向 **Altare 平台**（https://altare.gg）的 Node.js 容器环境。已将品牌字样、订阅名称、管理界面、容器规格等从 Kata/卡塔 统一改为 Altare。功能与上游一致：纯原生零依赖的 VLESS-WebSocket 隧道、三网优选节点池、订阅转换（6 格式 + ECH）和 Web 管理后台。

# Altare-Tunnel（altare-nodejs）使用与部署说明

原生 Node.js 实现的 VLESS over WebSocket 隧道服务，带用户管理、订阅导出、三网优选节点池和可选 Cloudflare Tunnel。无第三方运行依赖，面向 Altare 的 Node.js 容器运行。内存、CPU、磁盘配额由每个实例的套餐分配，部署时查询目标实例的实际额度，不按固定容器规格假设。

仓库位置：`https://github.com/hc990275/nodejs` 的 `altare-nodejs/` 目录。

## 1. 文件结构

```text
altare-nodejs/
├── index.js          # 主程序（必须）
├── package.json      # 启动与测试脚本（必须）
├── .env.example      # 配置模板（部署时复制为 .env）
├── src/
│   ├── argo-supervisor.js # 隧道进程监管与就绪探测（必须）
│   ├── security.js      # 密码哈希、会话、限速（必须）
│   ├── protocol.js      # WebSocket/VLESS 协议解析（必须）
│   ├── sub_converter.js # 现代订阅转换引擎：6 格式 + ECH 规范（必须）
│   └── yaml-lite.js     # 零依赖 YAML 序列化，供 sub_converter 生成 Clash 配置（必须）
├── test/             # 回归测试，仅本地运行，不必上传
└── data/             # 运行时生成，保存用户与设置
```

注意：`src/` 五个模块必须一起上传，只传 `index.js` 会报 `Cannot find module './src/security'` 或 `Cannot find module './src/sub_converter'`。

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
npm test          # 运行回归测试
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
5. 启动命令填写：`node --max-old-space-size=<按目标实例内存配额设置> /home/container/index.js`（或在项目根目录用 `npm start`）。
6. 点击启动，查看控制台是否出现核心启动标记，然后打开首页与 `/admin`。观察约两分钟确认稳定，不要只看面板 Running。
7. 公网建议通过自己的 HTTPS 反代或 Cloudflare Tunnel 访问。

## 5. 首次设置管理员密码

两种任选其一：

- 已在 `.env` 或运行环境预置 `ADMIN_PASSWORD` 时，使用现有密码从 HTTPS 后台登录。
- 首次部署可将 `ADMIN_PASSWORD` 留空或省略。在 `.env` 填入 `ADMIN_SETUP_TOKEN`，使用 `openssl rand -hex 24` 生成随机口令。如果反代改写回源的 `Host`，请先把对外域名填入 `SUB_DOMAIN` 或 `ARGO_DOMAIN`。通过 HTTPS 打开 `/admin`，输入初始化口令并设置 10 至 256 位的管理员密码。保存成功后密码写入 `.env`，文件中的初始化口令清空，首次设置入口关闭。

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

- 模块找不到：补传 `src/` 下五个模块（`security.js`、`protocol.js`、`sub_converter.js`、`yaml-lite.js`、`argo-supervisor.js`），检查大小写与目录层级。
- 页面打不开：确认业务端口、容器监听、防火墙、域名回源端口一致。
- 无法登录或提示 429：确认使用 HTTPS，核对管理员密码并等待限速窗口结束。
- 订阅不可用：检查用户是否被封禁/到期/超额，再检查域名、TLS、WebSocket 回源和客户端能力。
- 隧道不通：确认 `ARGO_TOKEN` 与 `ARGO_DOMAIN` 都已填写并保存；Token 才触发隧道拉起。
- 面板提示"停止 60 秒后再重启"：视为启动失败，先读控制台错误，修复后再启动。

## 11. 多机器区分（国家/地区标识）

订阅中的节点名会自动加上机器归属地前缀，格式：

```
【🇲🇳蒙古·25206·原生直连·Altare】-VLESS-WS
【🇸🇬新加坡·30815·CF·电信优选·1·SIN】-VLESS-WS
```

- 优先读取 Altare 注入的 `P_SERVER_LOCATION`。缺少机房地区时，按公网 IPv4 查询 ipinfo.io，失败时显示「未知地区」。
- 首页、管理登录页、后台顶部和浏览器标题显示国家／地区及机房城市，不显示端口或版本数字。
- 订阅节点名仍保留端口作为机器标识，便于区分同一地区的多个实例。

### 隧道启动、停止与自愈

后台 Token 输入框留空会保留已有值。提交不同的 Token 会等旧连接进程退出，再启动新进程。将 `.env` 中的 `ARGO_TOKEN` 显式置空可停止隧道。运行时环境变量用于没有该配置项的部署。

程序通过 cloudflared 的回环 `/ready` 接口检测边缘连通性。退出会按 3 到 60 秒退避重试，连续就绪失败且启动宽限期已过会重启当前连接进程。公开域名和实际回源还需独立验收。

## 12. Altare 平台 API（已核对的用法）

文档入口：<https://docs.altare.gg/altare-api>。以下路径属于平台管理 API，和项目自己的 `/admin/api/` 是两套接口。平台 Token 用来管理容器文件、启动配置及电源；项目管理密码用于本项目的用户和订阅设置，不能混用。

### 12.1 认证、团队和实例 ID

平台地址为 `https://console.altare.gg/api`。API Token 属于一个团队，使用 `Authorization: Bearer` 认证。不要把真实 Token 写入脚本、仓库或示例；下面从终端隐藏输入：

```bash
read -rsp 'Altare Token: ' ALTARE_TOKEN; printf '\n'
export ALTARE_TOKEN
API=https://console.altare.gg/api

altare() {
  local endpoint=$1
  shift
  curl --config <(printf 'url = "%s%s"\nheader = "Authorization: Bearer %s"\n' "$API" "$endpoint" "$ALTARE_TOKEN") \
    --fail-with-body --silent --show-error \
    --connect-timeout 10 --max-time 90 "$@"
}

altare /api-tokens/self
TEAM=$(altare /api-tokens/self | jq -r '.team.id')
altare "/tenants/$TEAM/servers" | jq '.items[] | {id,name,memoryMb,diskMb,cpuPercent}'
```

`jq` 用于示例中的 JSON 选择。`team.id` 是路径中的 `tenantId`；机器列表每项的 `id` 才是后续使用的 `serverId`。`cpuPercent=100` 表示一个核心的配额，磁盘和内存字段是配额，不代表当前用量。`serverIds: null` 表示 Token 没有限定具体实例，最终权限仍取决于它的 scopes 和创建者当前角色。

选定实例后：

```bash
APP=YOUR_SERVER_ID  # 从实例列表选择目标 ID
BASE="/tenants/$TEAM/servers/$APP"
altare "$BASE/details" | jq '{name,ip,location,node,sftp,sandbox,git,imageApp}'
altare "$BASE/startup" | jq '{startup,dockerImage,dockerImages,variables}'
```

详情必须使用 **`/details`**。省略末尾路径、直接请求 `/servers/{id}` 不是此处的公开详情端点。`/details` 返回机房、节点、分配端口及 SFTP 地址；`/startup` 的 `P_SERVER_LOCATION`（如 `de-fra`）也能确认地区。不要只根据 `sg`、`flkf` 等自定义实例名称猜地区。

### 12.2 最小权限

| scope | 此次项目中的用途 |
| --- | --- |
| `servers:view` | 列表与 `/details` |
| `servers:files` | 列目录、读写源码、上传二进制 |
| `servers:startup` | 查询与修改启动命令、镜像、模板变量 |
| `servers:power` | 开机、关机、重启 |
| `servers:network` | 查询平台分配端口、配置平台域名 |
| `servers:activity` | 查看修改活动 |
| `servers:console` | GitHub/Docker App 的持久日志；不等于实时控制台权限 |

Token 不能创建/删除/迁移实例，不能购买资源，不能设置 SSH 密码或添加 SSH Key，也不能直接打开实时控制台。`403 TOKEN_ROUTE_NOT_ALLOWED` 不是再加一个 scope 就能解决的错误。需要这些操作时使用平台控制台。Cloudflare 隧道和 DNS 由 Cloudflare 自己的 API 管理，不是 Altare Token 的权限范围。

### 12.3 文件部署

模板容器的 Files API 根路径 `/` 对应容器工作目录 `/home/container`，不是 Linux 系统根目录。此次项目是模板 Node.js 容器，部署路径为上传文件并设置启动命令。

```bash
# 根目录、源码模块目录
altare "$BASE/files?path=%2F" | jq
altare "$BASE/files?path=%2Fsrc" | jq

# 读取一个文本文件
altare "$BASE/files/contents?path=%2Fpackage.json" | jq -r '.content'

# 新建目录：只对尚不存在的 src 执行
altare "$BASE/files/directories" -X POST \
  -H 'Content-Type: application/json' -d '{"path":"/","name":"src"}'

# 从本地文件构造 JSON，不手工转义 JavaScript 或中文
jq -n --rawfile content ./index.js '{path:"/index.js",content:$content}' |
  altare "$BASE/files/write" -X POST \
    -H 'Content-Type: application/json' --data-binary @-

# 上传后读回并比对，写接口 200 不等于部署验收完成
cmp ./index.js <(altare "$BASE/files/contents?path=%2Findex.js" | jq -j '.content')
```

需要部署 `index.js`、`package.json`、`src/` 全部五个模块。只传入口文件会因为缺模块启动失败。更新时保留线上 `.env`、`data/`、已有 `cloudflared`，不能用新实例模板或本地测试用户库覆盖线上配置及用户数据。

二进制走短时上传链接：

```bash
UPLOAD_URL=$(altare "$BASE/files/uploads/url" -X POST \
  -H 'Content-Type: application/json' -d '{"directory":"/"}' | jq -r '.url')
printf 'url = "%s"\n' "$UPLOAD_URL" |
  curl --config - --fail-with-body --silent --show-error --max-time 120 \
    -F 'files=@./cloudflared'
unset UPLOAD_URL
```

上传链接本身是短时凭据，不要打印、分享或提交。可以用 `/files/pull` 让节点下载公开文件；该动作是异步的，返回 `{ok:true}` 后还要检查文件是否完整。下载来源应固定版本并验证 SHA-256。新环境下项目启动器会给 `cloudflared` 设置执行权限。

### 12.4 启动配置与电源

官方文档允许只修改部分启动字段，但本次实测曾返回 `422 The startup field is required` 或 `The image field is required`。因此先读当前配置，再保留原镜像和完整模板变量一起 PATCH：

```bash
# startup.json 包含模板环境变量，应放在私有临时目录，不进入 Git。
umask 077
altare "$BASE/startup" > startup.json
jq '{startup:"cd /home/container && exec /usr/local/bin/node --max-old-space-size=512 index.js >> boot.log 2>&1",dockerImage,environment}' \
  startup.json | altare "$BASE/startup" -X PATCH \
    -H 'Content-Type: application/json' --data-binary @-
rm -f startup.json

# 这是一个端点，动作用 JSON 的 signal 指定
altare "$BASE/power" -X POST \
  -H 'Content-Type: application/json' -d '{"signal":"restart"}'
```

正确端点是 **`POST .../power` + `{"signal":"restart"}`**，不是 `/power/restart`。`signal` 支持 `start`、`stop`、`restart`、`kill`。`kill` 是强制终止，不作为普通重启默认动作。

响应 `200 {ok:true}` 只表示信号接受，必须继续验收。`202` 且 `queued:true` 表示正在排队，不等于已启动。写入超时后不能盲目重复重启，先读启动状态、日志和文件确认是否已应用。

### 12.5 运行验证与日志

普通模板容器不提供 GitHub App 那样的持久 Logs API。为它设置 `boot.log` 输出后，使用 Files API 读日志：

```bash
altare "$BASE/files/contents?path=%2Fboot.log" | jq -r '.content' | tail -60
curl --fail --silent --show-error --max-time 15 https://你的域名/
curl --fail --silent --show-error --max-time 15 https://你的域名/admin
# 未登录的用户列表应返回 401，不能只凭首页 200 判断鉴权正常。
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  https://你的域名/admin/api/users
```

完整部署验收包括：源文件回读一致、启动标记、隧道 `/ready` 成功、公开 HTTPS、后台会话登录、用户列表及异常日志。平台详情接口不等于电源状态接口；仅看到实例仍在列表中不能认定它正在运行。

### 12.6 域名、Cloudflare Tunnel 与 GitHub 部署的区别

```bash
altare "$BASE/network/domains" | jq '{items,allocations}'
altare "$BASE/network/allocations" | jq
```

- Altare 平台域名：`POST .../network/domains`，提供 `label`、`kind:"https"`、`app:"web"`、`allocationId`，指向平台分配端口。自有域名还需 DNS 验证。
- Cloudflare Tunnel：在 Cloudflare 账号下创建/配置隧道，域名 CNAME 到 `<tunnel-id>.cfargotunnel.com`，`cloudflared` 在容器里运行，并回源 `http://localhost:8001`。最终加兜底 `http_status:404`。修改前检查已有 DNS，不能覆盖其他机器使用的名字。
- 当前这些模板容器并非 GitHub App，`/git/deploy` 不适用。只有已从 GitHub 部署的 App 才能 `POST .../git/deploy`（`ref`/`sha`），并用 `GET .../git/deployments/{id}` 跟踪结果。

### 12.7 自建隧道管理面板

自建 Tunnel 管理面板是独立应用，并非 Altare 官方 API。其入口、账号、Zone、实例与隧道对应关系及部署记录仅保存在部署者本地私有档案。公开文档只使用示例参数；面板接口以对应项目的公开文档为准。

### 12.7 超时、错误与重试

节点接口偶发 502 或慢响应时，查询可有限退避重试；不要把短超时当作实例不存在。

| HTTP / code | 处理 |
| --- | --- |
| `401 TOKEN_INVALID/TOKEN_EXPIRED/TOKEN_REVOKED` | 核对 Token 状态 |
| `403 TOKEN_WRONG_TEAM` | 核对团队 ID |
| `403 TOKEN_ROUTE_NOT_ALLOWED` | 此端点不允许 Token 使用，改走控制台 |
| `403` 无 code | 检查 scope 和实例范围 |
| `409` | 状态冲突、实例尚在准备或配额已满 |
| `422` | JSON 字段或模板变量校验失败 |
| `429` | 等待 `Retry-After`，降低频次 |
| `502/5xx`、连接超时 | 查询可重试；写操作先回读，避免重复变更 |

官方上限为每 Token 每分钟 600 请求，部分文件操作有更低上限。列表通常使用 `{items:[...]}` 一次返回；持久日志使用游标分页。不要把 API 的 JSON、错误 HTML 和 Cloudflare 边缘拦截页混在一起解析。以前 Python 默认 User-Agent 曾得到边缘 `1010`，curl 则正常；排错时同时检查 HTTP 状态、响应类型和正文。

参考：官方 API 的 [Apps](https://docs.altare.gg/altare-api/apps)、[Files](https://docs.altare.gg/altare-api/files)、[Tokens](https://docs.altare.gg/altare-api/tokens)、[Domains](https://docs.altare.gg/altare-api/domains)、[Logs](https://docs.altare.gg/altare-api/logs)、[Errors](https://docs.altare.gg/altare-api/errors)、[Deploys](https://docs.altare.gg/altare-api/deploys)。
