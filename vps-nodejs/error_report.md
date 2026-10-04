# 经验沉淀与踩坑记录 (Error Tracking & Retrospective)

记录将受限卡塔容器架构 (`kata-nodejs`) 演进升级为独立 Linux VPS 架构 (`vps-nodejs`) 过程中的关键坑点、权限边界与解决方案。

---

## 1. Linux 非 Root 用户绑定 1024 以下特权端口 (80/443) 报 EACCES
- **问题现象**：在 Linux 系统中直接用非 root 用户运行 `node index.js`（当配置 `PORT=80` 或 `TLS_PORT=443` 时），服务立即崩溃并报错：`Error: listen EACCES: permission denied 0.0.0.0:80`。
- **原因剖析**：POSIX/Linux 内核出于安全考虑，默认禁止非特权用户（UID != 0）绑定 1024 以下的标准网络端口。
- **解决方案**：
  1. 在 `vps-tunnel.service` 中将运行用户设为 `root`（最简单可靠）；
  2. 若出于最小权限原则使用独立用户 `nobody` 或 `node`，可通过 Linux Capabilities 授权 node 二进制特权绑定能力：
     ```bash
     sudo setcap 'cap_net_bind_service=+ep' $(which node)
     ```
  3. 或者将服务端口设为 `8080`，由前置 Nginx 转发到 `8080`。

---

## 2. Linux VPS 云厂商安全组与操作系统双重防火墙拦截
- **问题现象**：执行 `setup.sh` 启动成功且 `curl 127.0.0.1` 正常响应，但外网浏览器与客户端连接始终超时 (Connection Timed Out)。
- **原因剖析**：
  1. 操作系统内部防火墙（Ubuntu 的 UFW 或 CentOS 的 Firewalld）默认丢弃了外部对 80/443 的 TCP 入站流量；
  2. 腾讯云、阿里云、AWS、甲骨文云等主流厂商在网页控制台自带“安全组 (Security Group)”规则，未放行 80/443 入站。
- **解决方案**：
  1. `setup.sh` 中自动增加 UFW / Firewalld 检测并自动放行 `ufw allow 80/tcp` 与 `ufw allow 443/tcp`；
  2. 在文档中明确提示用户检查云服务器服务商控制台的安全组规则。

---

## 3. 从容器小内存模式到 VPS 高并发的垃圾回收调优
- **问题现象**：卡塔版本启动参数带有 `--max-old-space-size=96`，用于防止突破 308MB 配额被容器杀掉。但如果原封不动照搬到 VPS 上，当在线用户突增或高并发下载时，V8 引擎会在 96MB 边界频繁触发 Full GC，导致 CPU 占用骤升甚至吞吐出现卡顿。
- **解决方案**：
  1. 在 `package.json` 和 `vps-tunnel.service` 中移除 `--max-old-space-size=96` 压制，交由 V8 根据 VPS 实际物理内存自动扩展堆内存；
  2. 依然保留原生零外部依赖的异步 Stream 与事件循环设计，常态依然仅占用 ~20MB，只有在突发大数据吞吐时才动态借用内存，并发处理能力提升数十倍。

---

## 4. 严禁默认口令回退 (Fail-Closed 铁律落地)
- **问题现象**：原有卡塔代码在未显式传递环境变量时存在 `ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD', 'admin123')` 的弱口令兜底。
- **风险根源**：一旦用户把项目部署到公网 VPS 且未及时配置 `.env`，公网扫描器可在秒级扫描出暴露的 80 端口并使用默认密码 `admin123` 登入后台接管节点。
- **根本解决方案**：
  彻底废弃默认回退逻辑。若 `.env` 中 `ADMIN_PASSWORD` 缺失或为空，系统严格执行 **Fail-Closed（安全熔断）**，控制台抛出告警并直接拒绝任何后台登录尝试，坚决消除默认口令后门漏洞。

---

## 5. Alpine Linux NAT VPS (无 Systemd / OpenRC / SSH 未初始化) 部署与穿透适配
- **问题现象**：Alpine Linux 容器使用 musl libc，无 `systemd`（只有 OpenRC），且新装镜像默认未开启 sshd 或缺少主机密钥，导致外网映射的 19999->22 端口连不上（报超时/拒绝），传统的 `systemctl` 与 `apt-get` 命令全部报 `command not found`。
- **原因剖析**：
  1. Alpine 极简镜像没有安装 bash/curl，采用 `apk` 包管理器与 `/sbin/openrc-run`；
  2. NAT 实例映射的 22 端口在容器初始化后未自动配置 root 密码登录与 sshd 守护进程。
- **解决方案**：
  1. `setup.sh` 增加 `apk add --no-cache nodejs npm curl bash openssh-server openssl ca-certificates openrc cloudflared`；
  2. 自动执行 `ssh-keygen -A`，在 `/etc/ssh/sshd_config` 放行 `PermitRootLogin yes`，激活并加入开机自启；
  3. 编写 `/etc/init.d/vps-tunnel` OpenRC 守护脚本与 `start-stop-daemon`，支持 Alpine 守护进程与开机自启；
  4. 原生兼容 Cloudflare Argo 穿透，自动读取 `ARGO_TOKEN` 与域名，直接将本地端口穿透至 `aaa.abcai.online`，免除 NAT 端口记忆烦恼。

---

## 6. 连接池双重注册导致的内存冗余与事件监听器泄漏
- **问题现象**：高并发代理请求下，活跃连接池中对象数量翻倍，且 Node.js 控制台偶发 `MaxListenersExceededWarning: Possible EventEmitter memory leak detected`。
- **原因剖析**：`handleVlessWebSocket` 在出站连接发起前注册了一次 `{ clientSocket, null }`，在出站连接建立后又重复注册了一次 `{ clientSocket, targetSocket }`，导致同一个 `clientSocket` 上挂载了重复的 `once('close')` 与 `once('error')` 清理监听器。
- **解决方案**：重构为单次原子注册机制。握手成功后只注册一次上下文，出站连接成功后通过 `bindTargetSocket` 原地绑定，消灭重复包装对象与监听器残留。

---

## 7. 定时器同步 I/O (fs.writeFileSync) 阻塞主事件循环与无意义盲写
- **问题现象**：每隔 30 秒进行大吞吐测速或高清视频播放时，偶尔出现微小的丢包或速度抖动顿挫。
- **原因剖析**：系统通过 `setInterval(saveUsers, 30000)` 每 30 秒无条件执行同步序列化 `JSON.stringify` 并调用 `fs.writeFileSync` / `fs.renameSync` 阻塞主线程 I/O，阻塞期间全服所有在线用户的 WebSocket 转发瞬间被冻结。
- **解决方案**：
  1. 引入 `isUsersDirty` 脏标记引擎，仅当实际产生流量消耗或用户信息更新时才触发写盘；
  2. 全面改用纯异步非阻塞 `fs.promises.writeFile` 与 `fs.promises.rename`，彻底释放主事件循环，代理通信零顿挫。

---

## 8. WebSocket 逐字节单循环解掩码与 VLESS UUID 堆对象碎片风暴
- **问题现象**：高并发上行测速（100M/1G 上传）时 CPU 迅速冲顶，且 V8 频繁触发垃圾回收（GC），吞吐受限。
- **原因剖析**：
  1. RFC 6455 客户端上行数据必须带 Mask 掩码，原有代码采用 `for` 循环逐字节取模异或，并频繁分配 `Buffer.allocUnsafe`；
  2. 每次 VLESS 握手为了拼出 36 位 UUID，连续创建 5 个子 Buffer 切片、5 个十六进制小字符串并 `join`，产生 11 个临时堆对象。
- **解决方案**：
  1. 引入 32 位整型批量就地异或（In-Place 32-bit XOR Fast Unmasking），彻底实现 0 内存分配与 4 字节步长批量解码；
  2. 预分配 256 元素字节映射表 `byteToHex`，单次纯查表快速解析 UUID，消灭堆碎片。

---

## 9. Cloudflare Bot Fight Mode (5秒盾质询) 拦截客户端导致节点全部测速报 -1
- **问题现象**：客户端（Clash、V2rayN、Sing-box 等）测速时，所有经由 Cloudflare CDN / 优选 IP / Argo 隧道的节点全部报 `-1`（握手超时/失败）。
- **原因剖析**：
  1. 域名所在的 Cloudflare 免费版控制台开启了 `Bot Fight Mode (fight_mode: True)`；
  2. 代理客户端测速时发送的 HTTP WebSocket Upgrade 探针包由于缺少常规浏览器的完整指纹与 Header，被 Cloudflare 边缘算法判定为“疑似自动化机器人”，返回了 `HTTP/1.1 403 Forbidden`、`Cf-Mitigated: challenge` 响应头以及 `<title>Just a moment...</title>` 的五秒盾 JS 质询页面；
  3. 客户端无法在无 JS 环境下完成质询，直接判定握手失败报 `-1`。
- **解决方案**：
  1. 通过 Cloudflare API 或控制台将 `bot_management` 中的 `fight_mode` 设为 `False`；
  2. 保持 WAF 自定义规则按需精准拦截，杜绝粗暴的 Bot 全局拦截导致代理流量断流。

---

## 10. 服务端与客户端 UUID 失配导致 [Auth] 拦截
- **问题现象**：服务端控制台密集报错 `[Auth] ❌ 未知 UUID 请求已被拒: <uuid>`，客户端测速返回 `-1`。
- **原因剖析**：重新部署或环境迁移后，服务端生成了新的用户 UUID，而用户客户端本地缓存的节点配置依然保留着旧 UUID，且未重新“更新订阅”。
- **解决方案**：
  1. 服务端 `users.json` 支持向后兼容录入历史合法 UUID；
  2. 客户端在节点失效时应及时点击“更新订阅”拉取最新的节点配置。

---

## 11. 出站连接 net.createConnection 自定义 lookup 导致 `Invalid IP address: undefined` 致命熔断
- **问题现象**：客户端 WebSocket 握手成功（101 Switching Protocols）且收到 VLESS 首帧头，但随后立刻被服务端静默关闭 TCP 连接，无法完成 HTTP 204 探针通信，客户端测速全部报 `-1`。
- **原因剖析**：
  1. 为优化 DNS 在 `net.createConnection` 注入了自定义 `lookup: cachedLookup`；
  2. Node.js `net.Socket` 在某些内部流程或高版本中向 `lookup` 传递了 `{ all: true }`，期望回调返回对象数组 `[{ address, family }]`，而自定义函数硬编码返回了 `callback(null, address, 4)`；
  3. Node 内部解析 IP 时取 `addresses[0].address` 得到 `undefined`，抛出内核级错误 `Invalid IP address: undefined`，出站连接瞬间被摧毁。
- **根本解决方案**：
  1. 移除脆弱的自定义 `lookup` 覆盖，依托系统级配置 `UV_THREADPOOL_SIZE=64`，由 Libuv 纯原生 C++ 线程池并发处理系统 DNS 解析，既稳健又安全；
  2. 移除出站 Socket 错误的静默忽略，增加完整错误堆栈捕获。

