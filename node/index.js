const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { exec, execSync, spawn } = require("child_process");
const crypto = require("crypto");

// ==================== 1. 基础配置与端口自适应 ====================
const SERVER_PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || "20231", 10);
const DIRECT_IP = process.env.SERVER_IP || "51.75.118.169";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "123456";

const ARGO_TOKEN = process.env.ARGO_TOKEN || "";
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";
const OPTIMIZED_DOMAIN = process.env.OPTIMIZED_DOMAIN || "";

// 多节点集群/异地节点拓展支持 (支持 JSON 数组字符串注入)
let extraNodesConfig = [];
try {
    if (process.env.EXTRA_NODES && process.env.EXTRA_NODES.trim() !== "") {
        extraNodesConfig = JSON.parse(process.env.EXTRA_NODES);
        console.log(`[Cluster] 已成功载入 ${extraNodesConfig.length} 个异地扩展集群节点`);
    }
} catch (e) {
    console.warn("[Cluster] 外部集群节点配置解析异常:", e.message);
}

const PORT_TUNNEL = 8001;
const INTERNAL_VMESS_PORT = 10011;
const INTERNAL_VLESS_PORT = 10012;
const INTERNAL_TROJAN_PORT = 10013;

const WORK_DIR = __dirname;
const USERS_FILE = path.join(WORK_DIR, "users.json");
const CONFIG_FILE = path.join(WORK_DIR, "config.json");
const SINGBOX_BIN = path.join(WORK_DIR, "sing-box");
const CLOUDFLARED_BIN = path.join(WORK_DIR, "cloudflared");

const GLOBAL_SALT = "_system_unified_salt_2026_pro";

let singboxProcess = null;
let isReloading = false;
let isTunnelAvailable = Boolean(ARGO_TOKEN && ARGO_TOKEN.trim() !== "" && ARGO_DOMAIN && ARGO_DOMAIN.trim() !== "");

// 用户会话与管理员独立隔离会话存储
const activeSessions = new Map();       // user session: token -> username
const adminSessions = new Map();        // admin session: token -> expireTime

// 节点在线活跃状态感知存储: uuid -> { activeConnections: number, lastSeenAt: number }
const userActivityMap = new Map();

function getUserActivity(uuid) {
    if (!userActivityMap.has(uuid)) {
        userActivityMap.set(uuid, { activeConnections: 0, lastSeenAt: 0 });
    }
    return userActivityMap.get(uuid);
}

function formatRelativeTime(ts) {
    if (!ts || ts <= 0) return "从未在线";
    const diff = Date.now() - ts;
    if (diff < 10000) return "刚刚在线";
    if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
}

// ==================== 2. 异步非阻塞写锁队列与用户存储 ====================
let usersDatabase = [];

// 全局异步文件写锁队列，彻底防止并发写入冲突
let fileWriteQueue = Promise.resolve();

function safeWriteFileAsync(filePath, content) {
    fileWriteQueue = fileWriteQueue.then(async () => {
        try {
            await fs.promises.writeFile(filePath, content, "utf8");
        } catch (err) {
            console.error(`[FS-Async] 写入文件失败 (${filePath}):`, err.message);
        }
    });
    return fileWriteQueue;
}

function hashPassword(password) {
    if (!password) return "";
    const cleanPwd = String(password).trim();
    return crypto.createHash("sha256").update(cleanPwd + GLOBAL_SALT).digest("hex");
}

function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const raw = fs.readFileSync(USERS_FILE, "utf8").trim();
            if (raw.length > 0) {
                usersDatabase = JSON.parse(raw);
                console.log(`[Database] 数据载入成功，当前总注册用户: ${usersDatabase.length}`);
                return;
            }
        } catch (err) {
            console.error("[Database] 数据库读取异常，重置存储:", err.message);
        }
    }
    usersDatabase = [];
    saveUsers();
}

function saveUsers() {
    safeWriteFileAsync(USERS_FILE, JSON.stringify(usersDatabase, null, 2));
}

function isUserInvalid(user) {
    if (!user) return "未授权用户凭证";
    if (!user.enabled) return "账号已被管理员冻结禁用";

    const now = Date.now();
    if (user.expireTime > 0 && now > user.expireTime) {
        return "账号已过有效期限";
    }

    if (user.trafficLimit > 0 && user.trafficUsed >= user.trafficLimit) {
        return "流量配额已耗尽";
    }

    return null;
}

function getActiveUsers() {
    return usersDatabase.filter((u) => isUserInvalid(u) === null);
}

// ==================== 3. Sing-box 核心配置与防死锁管理 ====================
function generateSingboxConfig() {
    let activeUsers = getActiveUsers();

    if (activeUsers.length === 0) {
        activeUsers = [{ uuid: "00000000-0000-0000-0000-000000000000" }];
    }

    const config = {
        log: {
            level: "warn",
            timestamp: true
        },
        inbounds: [
            {
                type: "vmess",
                tag: "vmess-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_VMESS_PORT,
                users: activeUsers.map((u) => ({ uuid: u.uuid, alterId: 0 })),
                transport: { type: "ws", path: "/vmess" }
            },
            {
                type: "vless",
                tag: "vless-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_VLESS_PORT,
                users: activeUsers.map((u) => ({ uuid: u.uuid, flow: "" })),
                transport: { type: "ws", path: "/vless" }
            },
            {
                type: "trojan",
                tag: "trojan-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_TROJAN_PORT,
                users: activeUsers.map((u) => ({ password: u.uuid })),
                transport: { type: "ws", path: "/trojan" }
            }
        ],
        outbounds: [
            {
                type: "direct",
                tag: "direct"
            }
        ]
    };

    safeWriteFileAsync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function killPortOccupants() {
    try {
        if (process.platform === "win32") {
            // Windows 环境下查杀端口兼容
            [INTERNAL_VMESS_PORT, INTERNAL_VLESS_PORT, INTERNAL_TROJAN_PORT].forEach((port) => {
                try {
                    const out = execSync(`netstat -ano | findstr :${port}`).toString();
                    const lines = out.split("\r\n");
                    for (const line of lines) {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length >= 5 && parts[1].endsWith(`:${port}`)) {
                            const pid = parts[parts.length - 1];
                            if (pid && pid !== "0") execSync(`taskkill /F /PID ${pid} 2>nul`);
                        }
                    }
                } catch (e) {}
            });
        } else {
            execSync(`fuser -k -9 ${INTERNAL_VMESS_PORT}/tcp ${INTERNAL_VLESS_PORT}/tcp ${INTERNAL_TROJAN_PORT}/tcp 2>/dev/null || true`);
        }
    } catch (e) { }
}

function safeReloadSingbox() {
    if (isReloading) return;
    isReloading = true;

    generateSingboxConfig();

    if (singboxProcess) {
        try {
            singboxProcess.removeAllListeners();
            singboxProcess.kill("SIGKILL");
        } catch (e) { }
        singboxProcess = null;
    }

    killPortOccupants();

    setTimeout(() => {
        console.log("[Core] 正在拉起 Sing-box 核心代理引擎...");
        singboxProcess = spawn(SINGBOX_BIN, ["run", "-c", CONFIG_FILE], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });

        singboxProcess.on("exit", (code) => {
            console.warn(`[Core] Sing-box 进程退出 (code: ${code})`);
            singboxProcess = null;
        });

        isReloading = false;
    }, 500);
}

function initSingboxCore() {
    if (!fs.existsSync(SINGBOX_BIN)) {
        console.log("[Binary] 正在下载 Sing-box 二进制执行文件...");
        const archMap = { x64: "linux-amd64", arm64: "linux-arm64", arm: "linux-armv7" };
        const currentArch = archMap[process.arch] || "linux-amd64";
        const downloadCmd = `curl -sSL "https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-${currentArch}.tar.gz" | tar -xz --strip-components=1 -C "${WORK_DIR}" && chmod +x "${SINGBOX_BIN}"`;
        exec(downloadCmd, (err) => {
            if (err) return console.error("[Binary] 核心下载失败:", err);
            safeReloadSingbox();
        });
    } else {
        try { fs.chmodSync(SINGBOX_BIN, "755"); } catch (e) {}
        safeReloadSingbox();
    }
}

function initAndStartCloudflared() {
    if (!isTunnelAvailable) return;
    const start = () => {
        const tunnel = spawn(CLOUDFLARED_BIN, ["tunnel", "--no-autoupdate", "run", "--token", ARGO_TOKEN], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });
        tunnel.on("exit", () => setTimeout(start, 5000));
    };

    if (!fs.existsSync(CLOUDFLARED_BIN)) {
        const archMap = { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm" };
        const binName = archMap[process.arch] || "cloudflared-linux-amd64";
        const downloadCmd = `curl -sSL -o "${CLOUDFLARED_BIN}" "https://github.com/cloudflare/cloudflared/releases/latest/download/${binName}" && chmod +x "${CLOUDFLARED_BIN}"`;
        exec(downloadCmd, start);
    } else {
        try { fs.chmodSync(CLOUDFLARED_BIN, "755"); } catch (e) {}
        start();
    }
}

// ==================== 4. 辅助函数、多节点与订阅构建 ====================
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const safeIndex = Math.min(i, sizes.length - 1);
    return (bytes / Math.pow(k, safeIndex)).toFixed(2) + " " + sizes[safeIndex];
}

function convertToBytes(val, unit) {
    const num = parseFloat(val) || 0;
    const upperUnit = String(unit || "GB").toUpperCase();
    if (upperUnit === "TB") return num * 1024 * 1024 * 1024 * 1024;
    if (upperUnit === "GB") return num * 1024 * 1024 * 1024;
    if (upperUnit === "MB") return num * 1024 * 1024;
    return num;
}

function parseBytesToInput(bytes) {
    if (!bytes || bytes <= 0) return { val: 0, unit: "GB" };
    const tb = 1024 * 1024 * 1024 * 1024;
    const gb = 1024 * 1024 * 1024;
    const mb = 1024 * 1024;

    if (bytes >= tb) return { val: (bytes / tb).toFixed(2), unit: "TB" };
    if (bytes >= gb) return { val: (bytes / gb).toFixed(2), unit: "GB" };
    return { val: (bytes / mb).toFixed(2), unit: "MB" };
}

function formatExpireDate(expireTime) {
    if (!expireTime || isNaN(expireTime) || Number(expireTime) <= 0) return "永久有效";
    const d = new Date(Number(expireTime));
    if (isNaN(d.getTime())) return "永久有效";
    try {
        return d.toISOString().split("T")[0];
    } catch (e) {
        return "永久有效";
    }
}

// 提取前台普通用户 Session
function getSessionUser(req) {
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(/session_token=([a-zA-Z0-9]+)/);
    if (!match) return null;
    const username = activeSessions.get(match[1]);
    if (!username) return null;
    return usersDatabase.find((u) => u.username === username) || null;
}

// 验证管理后台专属认证 (Cookie 隔离优先，兼容 Query Token)
function checkAdminAuth(req, query) {
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(/admin_session_token=([a-zA-Z0-9]+)/);
    if (match) {
        const expire = adminSessions.get(match[1]);
        if (expire && expire > Date.now()) {
            return true;
        }
        if (expire) adminSessions.delete(match[1]);
    }
    // 兼容历史 URL ?token=...
    if (query && query.get("token") === ADMIN_TOKEN) {
        return true;
    }
    return false;
}

// 生成结构化节点池 (支持多节点集群与异地节点)
function getStructuredNodesForUser(user) {
    const uuid = user.uuid;
    const nameSuffix = `-${user.username}`;
    const vlessPath = `/vless/${uuid}`;
    const vmessPath = `/vmess/${uuid}`;
    const trojanPath = `/trojan/${uuid}`;

    const nodes = [];

    // 1. 直连节点 (VLESS / VMess / Trojan)
    nodes.push({
        name: `直连-VLESS${nameSuffix}`,
        type: "vless",
        server: DIRECT_IP,
        port: SERVER_PORT,
        uuid: uuid,
        tls: false,
        network: "ws",
        wsPath: vlessPath,
        wsHeaders: { Host: DIRECT_IP }
    });

    nodes.push({
        name: `直连-VMess${nameSuffix}`,
        type: "vmess",
        server: DIRECT_IP,
        port: SERVER_PORT,
        uuid: uuid,
        alterId: 0,
        cipher: "auto",
        tls: false,
        network: "ws",
        wsPath: vmessPath,
        wsHeaders: { Host: DIRECT_IP }
    });

    nodes.push({
        name: `直连-Trojan${nameSuffix}`,
        type: "trojan",
        server: DIRECT_IP,
        port: SERVER_PORT,
        password: uuid,
        tls: false,
        network: "ws",
        wsPath: trojanPath,
        wsHeaders: { Host: DIRECT_IP }
    });

    // 2. Argo 优选穿透节点
    if (isTunnelAvailable) {
        const optAddress = OPTIMIZED_DOMAIN || ARGO_DOMAIN;
        nodes.push({
            name: `优选-VLESS${nameSuffix}`,
            type: "vless",
            server: optAddress,
            port: 443,
            uuid: uuid,
            tls: true,
            sni: ARGO_DOMAIN,
            network: "ws",
            wsPath: vlessPath,
            wsHeaders: { Host: ARGO_DOMAIN }
        });

        nodes.push({
            name: `优选-VMess${nameSuffix}`,
            type: "vmess",
            server: optAddress,
            port: 443,
            uuid: uuid,
            alterId: 0,
            cipher: "auto",
            tls: true,
            sni: ARGO_DOMAIN,
            network: "ws",
            wsPath: vmessPath,
            wsHeaders: { Host: ARGO_DOMAIN }
        });

        nodes.push({
            name: `优选-Trojan${nameSuffix}`,
            type: "trojan",
            server: optAddress,
            port: 443,
            password: uuid,
            tls: true,
            sni: ARGO_DOMAIN,
            network: "ws",
            wsPath: trojanPath,
            wsHeaders: { Host: ARGO_DOMAIN }
        });
    }

    // 3. 动态扩展集群节点 (从 EXTRA_NODES 配置注入)
    if (Array.isArray(extraNodesConfig) && extraNodesConfig.length > 0) {
        extraNodesConfig.forEach((ext, idx) => {
            const extName = `${ext.name || `集群节点-${idx + 1}`}${nameSuffix}`;
            const extType = String(ext.type || "vless").toLowerCase();
            const extServer = ext.server || ext.address || DIRECT_IP;
            const extPort = parseInt(ext.port || 443, 10);
            const extTls = ext.tls !== undefined ? Boolean(ext.tls) : true;
            const extSni = ext.sni || ext.host || extServer;
            const extPath = ext.path ? ext.path.replace("{uuid}", uuid) : `/vless/${uuid}`;

            nodes.push({
                name: extName,
                type: extType,
                server: extServer,
                port: extPort,
                uuid: uuid,
                password: uuid,
                alterId: 0,
                cipher: "auto",
                tls: extTls,
                sni: extSni,
                network: ext.network || "ws",
                wsPath: extPath,
                wsHeaders: { Host: ext.host || extSni }
            });
        });
    }

    return nodes;
}

// 生成通用 Base64 订阅链接列表 (V2RayN / Clash 等单链接)
function getNodesForUser(user) {
    const rawNodes = getStructuredNodesForUser(user);
    const linkList = [];

    for (const n of rawNodes) {
        if (n.type === "vless") {
            const tlsStr = n.tls ? "security=tls&" : "security=none&";
            const sniStr = n.sni ? `sni=${n.sni}&` : "";
            const hostStr = n.wsHeaders && n.wsHeaders.Host ? `host=${n.wsHeaders.Host}&` : "";
            const encPath = encodeURIComponent(n.wsPath);
            linkList.push(`vless://${n.uuid}@${n.server}:${n.port}?type=ws&${tlsStr}${sniStr}${hostStr}path=${encPath}#${n.name}`);
        } else if (n.type === "vmess") {
            const vmessObj = {
                v: "2",
                ps: n.name,
                add: n.server,
                port: String(n.port),
                id: n.uuid,
                aid: "0",
                net: "ws",
                type: "none",
                host: (n.wsHeaders && n.wsHeaders.Host) || n.server,
                path: n.wsPath,
                tls: n.tls ? "tls" : "",
                sni: n.sni || ""
            };
            linkList.push("vmess://" + Buffer.from(JSON.stringify(vmessObj)).toString("base64"));
        } else if (n.type === "trojan") {
            const tlsStr = n.tls ? "security=tls&" : "security=none&";
            const sniStr = n.sni ? `sni=${n.sni}&` : "";
            const hostStr = n.wsHeaders && n.wsHeaders.Host ? `host=${n.wsHeaders.Host}&` : "";
            const encPath = encodeURIComponent(n.wsPath);
            linkList.push(`trojan://${n.password}@${n.server}:${n.port}?${tlsStr}${sniStr}${hostStr}type=ws&path=${encPath}#${n.name}`);
        }
    }

    return Buffer.from(linkList.join("\n")).toString("base64");
}

// 自动生成符合 Clash Meta (Mihomo) 规范的标准 YAML 配置
function generateClashConfig(user) {
    const nodes = getStructuredNodesForUser(user);

    let proxiesYaml = "";
    const proxyNames = [];

    for (const n of nodes) {
        proxyNames.push(n.name);
        if (n.type === "vless") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: vless\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: ${n.tls}\n`;
            if (n.sni) proxiesYaml += `    servername: ${n.sni}\n`;
            proxiesYaml += `    network: ws\n`;
            proxiesYaml += `    ws-opts:\n`;
            proxiesYaml += `      path: "${n.wsPath}"\n`;
            if (n.wsHeaders && n.wsHeaders.Host) {
                proxiesYaml += `      headers:\n`;
                proxiesYaml += `        Host: ${n.wsHeaders.Host}\n`;
            }
        } else if (n.type === "vmess") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: vmess\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    alterId: 0\n`;
            proxiesYaml += `    cipher: auto\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: ${n.tls}\n`;
            if (n.sni) proxiesYaml += `    servername: ${n.sni}\n`;
            proxiesYaml += `    network: ws\n`;
            proxiesYaml += `    ws-opts:\n`;
            proxiesYaml += `      path: "${n.wsPath}"\n`;
            if (n.wsHeaders && n.wsHeaders.Host) {
                proxiesYaml += `      headers:\n`;
                proxiesYaml += `        Host: ${n.wsHeaders.Host}\n`;
            }
        } else if (n.type === "trojan") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: trojan\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    password: ${n.password}\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: ${n.tls}\n`;
            if (n.sni) proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    network: ws\n`;
            proxiesYaml += `    ws-opts:\n`;
            proxiesYaml += `      path: "${n.wsPath}"\n`;
            if (n.wsHeaders && n.wsHeaders.Host) {
                proxiesYaml += `      headers:\n`;
                proxiesYaml += `        Host: ${n.wsHeaders.Host}\n`;
            }
        }
    }

    const proxyNameListStr = proxyNames.map((name) => `      - "${name}"`).join("\n");

    return `port: 7890
socks-port: 7891
mixed-port: 7892
allow-lan: false
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090

dns:
  enable: true
  listen: 0.0.0.0:1053
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5
    - 119.29.29.29
  fallback:
    - 1.1.1.1
    - 8.8.8.8

proxies:
${proxiesYaml}

proxy-groups:
  - name: "🚀 节点选择"
    type: select
    proxies:
      - "♻️ 自动优选"
      - "⚡ 故障转移"
${proxyNameListStr}
      - DIRECT

  - name: "♻️ 自动优选"
    type: url-test
    url: http://cp.cloudflare.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
${proxyNameListStr}

  - name: "⚡ 故障转移"
    type: fallback
    url: http://cp.cloudflare.com/generate_204
    interval: 300
    proxies:
${proxyNameListStr}

  - name: "🐟 漏网之鱼"
    type: select
    proxies:
      - "🚀 节点选择"
      - DIRECT

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,🐟 漏网之鱼
`;
}

// ==================== 5. HTTP 业务层与前端 ====================
function handleHttpRequest(req, res) {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.searchParams;

    // 1. 订阅分发 (支持 Base64 与 Clash 规则订阅)
    if (pathname === "/sub") {
        const token = query.get("token");
        const user = usersDatabase.find((u) => u.uuid === token);

        const invalidReason = isUserInvalid(user);
        if (invalidReason) {
            res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end(`[Access Denied] 拒绝订阅下发：${invalidReason}。请联系管理员续约。`);
        }

        const isClash = query.get("type") === "clash" || 
                        query.get("format") === "clash" || 
                        /clash|meta|mihomo|stash/i.test(req.headers["user-agent"] || "");

        const subUserInfo = `upload=0; download=${user.trafficUsed}; total=${user.trafficLimit}; expire=${Math.floor(user.expireTime / 1000)}`;

        if (isClash) {
            res.writeHead(200, {
                "Content-Type": "text/yaml; charset=utf-8",
                "Content-Disposition": `attachment; filename*=UTF-8''clash_${encodeURIComponent(user.username)}.yaml`,
                "Subscription-Userinfo": subUserInfo
            });
            return res.end(generateClashConfig(user));
        }

        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Subscription-Userinfo": subUserInfo
        });
        return res.end(getNodesForUser(user));
    }

    // 2. 实时用量异步轮询 API
    if (pathname === "/api/my-stats") {
        const currentUser = getSessionUser(req);
        if (!currentUser) {
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "未登录" }));
        }

        const percentage = currentUser.trafficLimit > 0
            ? Math.min(100, (currentUser.trafficUsed / currentUser.trafficLimit * 100)).toFixed(1)
            : 0;

        const act = getUserActivity(currentUser.uuid);

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            usedFormatted: formatBytes(currentUser.trafficUsed),
            totalFormatted: formatBytes(currentUser.trafficLimit),
            percentage,
            daysLeft: Math.max(0, Math.ceil((currentUser.expireTime - Date.now()) / 86400000)),
            activeConnections: act.activeConnections,
            lastSeen: formatRelativeTime(act.lastSeenAt)
        }));
    }

    // 3. 用户注册 API
    if (pathname === "/api/register" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            try {
                const { username, password } = JSON.parse(body || "{}");
                const cleanUser = String(username || "").trim();
                const cleanPwd = String(password || "").trim();

                if (!cleanUser || !cleanPwd) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "用户名与密码不得为空" }));
                }

                if (usersDatabase.some((u) => u.username.toLowerCase() === cleanUser.toLowerCase())) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "该用户名已被注册占用" }));
                }

                const newUser = {
                    uuid: crypto.randomUUID(),
                    username: cleanUser,
                    passwordHash: hashPassword(cleanPwd),
                    trafficLimit: 15 * 1024 * 1024 * 1024,
                    trafficUsed: 0,
                    expireTime: Date.now() + 30 * 86400000,
                    enabled: true
                };

                usersDatabase.push(newUser);
                saveUsers();
                safeReloadSingbox();

                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "请求数据有误" }));
            }
        });
        return;
    }

    // 4. 用户前台登录 API
    if (pathname === "/api/login" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            try {
                const { username, password } = JSON.parse(body || "{}");
                const cleanUser = String(username || "").trim();
                const cleanPwd = String(password || "").trim();

                const targetUser = usersDatabase.find((u) => u.username.toLowerCase() === cleanUser.toLowerCase());

                if (!targetUser) {
                    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "该账号尚未注册，请先点击注册" }));
                }

                if (targetUser.passwordHash !== hashPassword(cleanPwd)) {
                    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "密码输入有误，请核对后重试" }));
                }

                const sessionToken = crypto.randomBytes(16).toString("hex");
                activeSessions.set(sessionToken, targetUser.username);

                res.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Set-Cookie": `session_token=${sessionToken}; Path=/; HttpOnly; Max-Age=86400`
                });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "认证模块异常" }));
            }
        });
        return;
    }

    if (pathname === "/logout") {
        res.writeHead(302, { "Set-Cookie": "session_token=; Path=/; Max-Age=0", Location: "/" });
        return res.end();
    }

    // 5. 后台独立登录页面与鉴权 (/admin/login)
    if (pathname === "/admin/login") {
        if (req.method === "GET") {
            // 如果已登录管理会话，直接跳到 /admin
            if (checkAdminAuth(req, query)) {
                res.writeHead(302, { Location: "/admin" });
                return res.end();
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(`
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>总控中心 · 管理员登入</title>
                    <style>
                        * { box-sizing: border-box; margin: 0; padding: 0; }
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                            background: radial-gradient(circle at 50% 20%, #1e1b4b 0%, #030712 70%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: #f8fafc;
                            padding: 20px;
                        }
                        .admin-login-card {
                            background: rgba(15, 23, 42, 0.75);
                            backdrop-filter: blur(20px);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 24px;
                            padding: 42px 36px;
                            width: 100%;
                            max-width: 400px;
                            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
                        }
                        .logo-badge {
                            width: 52px; height: 52px; border-radius: 14px;
                            background: linear-gradient(135deg, #6366f1, #3b82f6);
                            display: flex; align-items: center; justify-content: center;
                            margin: 0 auto 16px auto; font-size: 26px;
                            box-shadow: 0 10px 25px -5px rgba(99, 102, 241, 0.5);
                        }
                        .header-title { font-size: 20px; font-weight: 700; text-align: center; margin-bottom: 6px; }
                        .header-sub { font-size: 13px; color: #94a3b8; text-align: center; margin-bottom: 28px; }
                        .input-box { margin-bottom: 20px; }
                        .input-box label { display: block; font-size: 12px; color: #cbd5e1; margin-bottom: 8px; font-weight: 500; }
                        input {
                            width: 100%;
                            padding: 13px 16px;
                            background: rgba(0, 0, 0, 0.4);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 12px;
                            color: #fff;
                            font-size: 14px;
                            outline: none;
                            transition: 0.2s;
                        }
                        input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25); }
                        .btn-login {
                            width: 100%;
                            padding: 13px;
                            background: #4f46e5;
                            color: #fff;
                            border: none;
                            border-radius: 12px;
                            font-size: 14px;
                            font-weight: 600;
                            cursor: pointer;
                            transition: 0.2s;
                        }
                        .btn-login:hover { background: #4338ca; transform: translateY(-1px); }
                        .error-msg {
                            display: none;
                            background: rgba(239, 68, 68, 0.15);
                            border: 1px solid rgba(239, 68, 68, 0.3);
                            color: #f87171;
                            padding: 10px 14px;
                            border-radius: 10px;
                            font-size: 13px;
                            margin-bottom: 20px;
                            text-align: center;
                        }
                    </style>
                </head>
                <body>
                    <div class="admin-login-card">
                        <div class="logo-badge">🛡️</div>
                        <h2 class="header-title">系统总控中心</h2>
                        <div class="header-sub">管理凭据隔离鉴权 · 会话保护</div>
                        <div class="error-msg" id="errMsg"></div>
                        <div class="input-box">
                            <label>管理员安全口令</label>
                            <input type="password" id="adminToken" placeholder="输入 ADMIN_TOKEN 密码" autofocus />
                        </div>
                        <button class="btn-login" id="loginBtn" onclick="doAdminLogin()">验证登入</button>
                    </div>

                    <script>
                        async function doAdminLogin() {
                            const pwd = document.getElementById("adminToken").value.trim();
                            const err = document.getElementById("errMsg");
                            if (!pwd) {
                                err.innerText = "请输入管理安全口令";
                                err.style.display = "block";
                                return;
                            }
                            const btn = document.getElementById("loginBtn");
                            btn.innerText = "正在验证...";
                            btn.disabled = true;
                            try {
                                const res = await fetch("/admin/login", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ token: pwd })
                                });
                                const data = await res.json();
                                if (res.ok && data.success) {
                                    location.href = "/admin";
                                } else {
                                    err.innerText = data.error || "口令无效";
                                    err.style.display = "block";
                                    btn.innerText = "验证登入";
                                    btn.disabled = false;
                                }
                            } catch (e) {
                                err.innerText = "网络通信异常";
                                err.style.display = "block";
                                btn.innerText = "验证登入";
                                btn.disabled = false;
                            }
                        }
                        document.getElementById("adminToken").addEventListener("keydown", (e) => {
                            if (e.key === "Enter") doAdminLogin();
                        });
                    </script>
                </body>
                </html>
            `);
        }

        if (req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                try {
                    const { token } = JSON.parse(body || "{}");
                    if (token !== ADMIN_TOKEN) {
                        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({ error: "安全密钥未通过核验" }));
                    }

                    const adminSessionToken = crypto.randomBytes(24).toString("hex");
                    const expireTime = Date.now() + 24 * 3600 * 1000;
                    adminSessions.set(adminSessionToken, expireTime);

                    res.writeHead(200, {
                        "Content-Type": "application/json; charset=utf-8",
                        "Set-Cookie": `admin_session_token=${adminSessionToken}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=86400`
                    });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "服务器处理异常" }));
                }
            });
            return;
        }
    }

    if (pathname === "/admin/logout") {
        res.writeHead(302, { "Set-Cookie": "admin_session_token=; Path=/admin; Max-Age=0", Location: "/admin/login" });
        return res.end();
    }

    // 6. 后台管理 API (严格经过 checkAdminAuth 隔离校验)
    if (pathname.startsWith("/admin/api/")) {
        if (!checkAdminAuth(req, query)) {
            res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ error: "管理凭据未授权或会话已过期" }));
        }

        if (pathname === "/admin/api/update" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { uuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled } = JSON.parse(body || "{}");
                const user = usersDatabase.find((u) => u.uuid === uuid);
                if (!user) {
                    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "未找到目标用户" }));
                }

                if (typeof newPassword === "string" && newPassword.trim().length > 0) {
                    user.passwordHash = hashPassword(newPassword.trim());
                }

                if (trafficLimitVal !== undefined && !isNaN(trafficLimitVal)) {
                    user.trafficLimit = convertToBytes(trafficLimitVal, trafficLimitUnit || "GB");
                }

                if (expireDate !== undefined) {
                    if (!expireDate || String(expireDate).trim() === "") {
                        user.expireTime = 0;
                    } else {
                        const parts = String(expireDate).trim().split("-");
                        if (parts.length === 3) {
                            const endOfDay = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 23, 59, 59, 999);
                            if (!isNaN(endOfDay.getTime())) {
                                user.expireTime = endOfDay.getTime();
                            }
                        }
                    }
                }

                if (enabled !== undefined) {
                    user.enabled = Boolean(enabled);
                }

                saveUsers();
                safeReloadSingbox();

                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }

        if (pathname === "/admin/api/reset" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { uuid } = JSON.parse(body || "{}");
                const target = usersDatabase.find((u) => u.uuid === uuid);
                if (target) {
                    target.trafficUsed = 0;
                    saveUsers();
                    safeReloadSingbox();
                }
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }

        if (pathname === "/admin/api/delete" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { uuid } = JSON.parse(body || "{}");
                usersDatabase = usersDatabase.filter((u) => u.uuid !== uuid);
                userActivityMap.delete(uuid);
                saveUsers();
                safeReloadSingbox();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }

        if (pathname === "/admin/api/add" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { username, password, limitVal, limitUnit, days } = JSON.parse(body || "{}");
                const cleanUser = String(username || "").trim();
                const cleanPwd = String(password || "123456").trim();

                if (!cleanUser) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "用户名不能为空" }));
                }

                if (usersDatabase.some((u) => u.username.toLowerCase() === cleanUser.toLowerCase())) {
                    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "该用户名已被占用" }));
                }

                const newUser = {
                    uuid: crypto.randomUUID(),
                    username: cleanUser,
                    passwordHash: hashPassword(cleanPwd),
                    trafficLimit: convertToBytes(limitVal || 50, limitUnit || "GB"),
                    trafficUsed: 0,
                    expireTime: Date.now() + parseInt(days || 30, 10) * 86400000,
                    enabled: true
                };

                usersDatabase.push(newUser);
                saveUsers();
                safeReloadSingbox();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }
    }

    // 7. 后台管理页面 (/admin) - 独立 Cookie 鉴权与在线感知看板
    if (pathname === "/admin") {
        if (!checkAdminAuth(req, query)) {
            res.writeHead(302, { Location: "/admin/login" });
            return res.end();
        }

        const totalUsers = usersDatabase.length;
        const activeUsersCount = getActiveUsers().length;
        const totalTrafficSum = usersDatabase.reduce((acc, u) => acc + (u.trafficUsed || 0), 0);

        // 统计实时全站在线连接数
        let totalLiveConnections = 0;
        userActivityMap.forEach((act) => {
            totalLiveConnections += (act.activeConnections || 0);
        });

        const userRows = usersDatabase.map((u) => {
            const invalidMsg = isUserInvalid(u);
            let statusBadge = `<span class="badge badge-success"><span class="badge-dot"></span>有效活跃</span>`;
            if (!u.enabled) statusBadge = `<span class="badge badge-danger"><span class="badge-dot"></span>手动阻断</span>`;
            else if (invalidMsg === "账号已过有效期限") statusBadge = `<span class="badge badge-danger"><span class="badge-dot"></span>已过期</span>`;
            else if (invalidMsg === "流量配额已耗尽") statusBadge = `<span class="badge badge-warning"><span class="badge-dot"></span>已超额</span>`;

            const act = getUserActivity(u.uuid);
            let onlineBadge = `<span class="badge-online-offline">⚪ 离线 (${formatRelativeTime(act.lastSeenAt)})</span>`;
            if (act.activeConnections > 0) {
                onlineBadge = `<span class="badge-online-live"><span class="badge-dot-live"></span>在线 (${act.activeConnections}设备)</span>`;
            }

            const baseSubUrl = isTunnelAvailable
                ? `https://${ARGO_DOMAIN}/sub?token=${u.uuid}`
                : `http://${DIRECT_IP}:${SERVER_PORT}/sub?token=${u.uuid}`;
            const clashSubUrl = `${baseSubUrl}&type=clash`;

            const dateStr = formatExpireDate(u.expireTime);
            const parsedLimit = parseBytesToInput(u.trafficLimit);

            return `
                <tr>
                    <td>
                        <div class="user-cell">
                            <span class="avatar">${u.username.substring(0, 1).toUpperCase()}</span>
                            <div class="user-info">
                                <span class="uname">${u.username}</span>
                                <span class="uuid-sub" onclick="copyText('${u.uuid}')" title="点击复制完整UUID">${u.uuid.substring(0, 8)}...</span>
                            </div>
                        </div>
                    </td>
                    <td>
                        <div class="metric-val">${formatBytes(u.trafficUsed)}</div>
                        <div class="metric-sub">限额 ${formatBytes(u.trafficLimit)}</div>
                    </td>
                    <td class="date-cell">${dateStr}</td>
                    <td>${statusBadge}</td>
                    <td>${onlineBadge}</td>
                    <td>
                        <div class="sub-btn-group">
                            <button class="btn btn-copy-sub" onclick="copyText('${baseSubUrl}')" title="复制标准 Base64 订阅链接">常规</button>
                            <button class="btn btn-copy-sub btn-copy-clash" onclick="copyText('${clashSubUrl}')" title="复制 Clash Meta 规则配置订阅">Clash</button>
                        </div>
                    </td>
                    <td>
                        <div class="actions-group">
                            <button class="btn btn-action-edit" onclick="openEditModal('${u.uuid}', '${u.username}', '${parsedLimit.val}', '${parsedLimit.unit}', '${dateStr}', ${u.enabled})">编辑</button>
                            <button class="btn btn-action-reset" onclick="resetTraffic('${u.uuid}')">重置</button>
                            <button class="btn btn-action-del" onclick="deleteUser('${u.uuid}')">注销</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join("");

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>控制中枢 - 系统总控</title>
                <style>
                    :root {
                        --bg: #07090e;
                        --card: #0e131f;
                        --card-border: rgba(255, 255, 255, 0.07);
                        --card-hover: rgba(255, 255, 255, 0.02);
                        --input-bg: #05070a;
                        --primary: #3b82f6;
                        --primary-hover: #2563eb;
                        --text: #f8fafc;
                        --text-muted: #94a3b8;
                    }
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                        background: radial-gradient(circle at 50% 0%, #111a2e 0%, var(--bg) 60%);
                        color: var(--text);
                        padding: 32px 24px;
                        min-height: 100vh;
                    }
                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 24px;
                    }
                    .header-title { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
                    .header-right { display: flex; align-items: center; gap: 12px; }
                    .logout-btn {
                        color: #f87171; text-decoration: none; font-size: 13px; font-weight: 500;
                        padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.25);
                        transition: 0.2s; background: rgba(239, 68, 68, 0.05);
                    }
                    .logout-btn:hover { background: rgba(239, 68, 68, 0.15); }
                    .stats-grid {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                        gap: 16px;
                        margin-bottom: 24px;
                    }
                    .stat-card {
                        background: var(--card);
                        border: 1px solid var(--card-border);
                        border-radius: 16px;
                        padding: 20px 24px;
                        backdrop-filter: blur(10px);
                        position: relative;
                        overflow: hidden;
                    }
                    .stat-card::before {
                        content: '';
                        position: absolute;
                        top: 0; left: 0; width: 100%; height: 2px;
                        background: linear-gradient(90deg, var(--primary), transparent);
                    }
                    .stat-title { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; }
                    .stat-value { font-size: 26px; font-weight: 700; color: #fff; display: flex; align-items: baseline; gap: 4px; }
                    .stat-unit { font-size: 13px; color: var(--text-muted); font-weight: normal; }
                    .panel {
                        background: var(--card);
                        border: 1px solid var(--card-border);
                        border-radius: 18px;
                        padding: 24px;
                        margin-bottom: 24px;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                    }
                    .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 18px;
                    }
                    .panel-title {
                        font-size: 16px;
                        font-weight: 600;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .input-unit-group { display: flex; gap: 6px; }
                    input, select {
                        width: 100%;
                        background: var(--input-bg);
                        border: 1px solid var(--card-border);
                        color: #fff;
                        padding: 11px 14px;
                        border-radius: 10px;
                        font-size: 13px;
                        outline: none;
                        transition: 0.2s border, 0.2s box-shadow;
                    }
                    input:focus, select:focus {
                        border-color: var(--primary);
                        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
                    }
                    .btn {
                        padding: 10px 18px;
                        border-radius: 10px;
                        border: none;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: 0.2s;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    }
                    .btn-primary { background: var(--primary); color: #fff; }
                    .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
                    .sub-btn-group { display: flex; gap: 4px; }
                    .btn-copy-sub {
                        background: rgba(255, 255, 255, 0.04);
                        border: 1px solid var(--card-border);
                        color: #93c5fd;
                        font-size: 11px;
                        padding: 5px 8px;
                        border-radius: 6px;
                    }
                    .btn-copy-sub:hover { background: rgba(59, 130, 246, 0.1); border-color: rgba(59, 130, 246, 0.3); }
                    .btn-copy-clash { color: #a78bfa; }
                    .btn-copy-clash:hover { background: rgba(167, 139, 250, 0.1); border-color: rgba(167, 139, 250, 0.3); }
                    .table-wrapper { width: 100%; overflow-x: auto; }
                    table { width: 100%; border-collapse: collapse; margin-top: 4px; }
                    th, td { padding: 14px 16px; text-align: left; border-bottom: 1px solid var(--card-border); }
                    th { font-size: 12px; color: var(--text-muted); font-weight: 600; letter-spacing: 0.5px; }
                    tr:hover td { background: var(--card-hover); }
                    .user-cell { display: flex; align-items: center; gap: 12px; }
                    .avatar {
                        width: 34px; height: 34px; border-radius: 10px;
                        background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2));
                        border: 1px solid rgba(59, 130, 246, 0.3);
                        color: #60a5fa; display: flex; align-items: center; justify-content: center;
                        font-size: 13px; font-weight: bold;
                    }
                    .uname { font-weight: 600; font-size: 14px; display: block; }
                    .uuid-sub { font-family: monospace; font-size: 11px; color: #64748b; cursor: pointer; transition: 0.2s; }
                    .uuid-sub:hover { color: #94a3b8; text-decoration: underline; }
                    .metric-val { font-size: 13px; font-weight: 600; color: #38bdf8; }
                    .metric-sub { font-size: 11px; color: #64748b; margin-top: 2px; }
                    .date-cell { font-size: 13px; color: #cbd5e1; }
                    .badge {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        padding: 4px 10px;
                        border-radius: 20px;
                        font-size: 11px;
                        font-weight: 600;
                    }
                    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
                    .badge-success { background: rgba(34, 197, 94, 0.12); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.25); }
                    .badge-danger { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }
                    .badge-warning { background: rgba(245, 158, 11, 0.12); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
                    .badge-online-live {
                        display: inline-flex; align-items: center; gap: 5px;
                        color: #38bdf8; font-size: 11px; font-weight: 600;
                    }
                    .badge-dot-live {
                        width: 7px; height: 7px; border-radius: 50%;
                        background: #38bdf8; box-shadow: 0 0 8px #38bdf8;
                    }
                    .badge-online-offline { font-size: 11px; color: #64748b; }
                    .actions-group { display: flex; gap: 6px; }
                    .btn-action-edit {
                        background: rgba(59, 130, 246, 0.1);
                        border: 1px solid rgba(59, 130, 246, 0.25);
                        color: #60a5fa; padding: 5px 10px; font-size: 12px;
                    }
                    .btn-action-edit:hover { background: var(--primary); color: #fff; }
                    .btn-action-reset {
                        background: rgba(245, 158, 11, 0.08);
                        border: 1px solid rgba(245, 158, 11, 0.2);
                        color: #fbbf24; padding: 5px 10px; font-size: 12px;
                    }
                    .btn-action-reset:hover { background: #f59e0b; color: #000; }
                    .btn-action-del {
                        background: rgba(239, 68, 68, 0.08);
                        border: 1px solid rgba(239, 68, 68, 0.2);
                        color: #f87171; padding: 5px 10px; font-size: 12px;
                    }
                    .btn-action-del:hover { background: #ef4444; color: #fff; }
                    
                    /* 模态框 */
                    .modal-mask {
                        position: fixed; inset: 0;
                        background: rgba(0, 0, 0, 0.7);
                        backdrop-filter: blur(8px);
                        display: none; align-items: center; justify-content: center;
                        z-index: 99;
                    }
                    .modal {
                        background: #0e131f;
                        border: 1px solid var(--card-border);
                        border-radius: 20px;
                        width: 100%; max-width: 440px; padding: 28px;
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6);
                    }
                    .modal h4 { font-size: 18px; margin-bottom: 20px; letter-spacing: -0.3px; }
                    .field-box { margin-bottom: 16px; }
                    .field-box label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; font-weight: 500; }
                    .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 24px; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div>
                        <h2 class="header-title">系统控制中枢</h2>
                        <span style="font-size:13px; color:var(--text-muted);">异步非阻塞写锁 · 实时流式记账 · 多节点集群支持</span>
                    </div>
                    <div class="header-right">
                        <a href="/admin/logout" class="logout-btn">退出管理</a>
                    </div>
                </div>

                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-title">全站注册用户</div>
                        <div class="stat-value">${totalUsers} <span class="stat-unit">人</span></div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">有效通行凭证</div>
                        <div class="stat-value" style="color:#4ade80;">${activeUsersCount} <span class="stat-unit">活跃</span></div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">实时活跃网络连接</div>
                        <div class="stat-value" style="color:#a78bfa;">${totalLiveConnections} <span class="stat-unit">连线</span></div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-title">全站已产生总流量</div>
                        <div class="stat-value" style="color:#38bdf8;">${formatBytes(totalTrafficSum)}</div>
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header">
                        <div class="panel-title">用户清单与权限详情</div>
                        <button class="btn btn-primary" onclick="openAddModal()">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                            新增用户
                        </button>
                    </div>
                    <div class="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th>用户主体</th>
                                    <th>流量消耗 / 上限</th>
                                    <th>过期时间</th>
                                    <th>账号状态</th>
                                    <th>实时活跃状态</th>
                                    <th>专属订阅 (普通/Clash)</th>
                                    <th>运维操作</th>
                                </tr>
                            </thead>
                            <tbody>${userRows}</tbody>
                        </table>
                    </div>
                </div>

                <!-- 新建用户弹窗 -->
                <div class="modal-mask" id="addModal">
                    <div class="modal">
                        <h4>新建用户授权</h4>
                        <div class="field-box">
                            <label>用户账号名称</label>
                            <input type="text" id="add_user" placeholder="输入用户名" />
                        </div>
                        <div class="field-box">
                            <label>初始登录密码</label>
                            <input type="password" id="add_pwd" placeholder="设置密码" value="123456" />
                        </div>
                        <div class="field-box">
                            <label>流量配额限制</label>
                            <div class="input-unit-group">
                                <input type="number" step="0.1" id="add_val" placeholder="限额" value="50" style="flex:2;" />
                                <select id="add_unit" style="flex:1;">
                                    <option value="MB">MB</option>
                                    <option value="GB" selected>GB</option>
                                    <option value="TB">TB</option>
                                </select>
                            </div>
                        </div>
                        <div class="field-box">
                            <label>有效时长 (天)</label>
                            <input type="number" id="add_days" placeholder="有效天数" value="30" />
                        </div>
                        <div class="modal-footer">
                            <button class="btn" style="background:transparent; color:var(--text-muted); border:1px solid var(--card-border);" onclick="closeAddModal()">取消</button>
                            <button class="btn btn-primary" id="saveAddBtn" onclick="submitAdd()">立即创建</button>
                        </div>
                    </div>
                </div>

                <!-- 编辑用户弹窗 -->
                <div class="modal-mask" id="editModal">
                    <div class="modal">
                        <h4 id="editModalTitle">编辑资料</h4>
                        <input type="hidden" id="edit_uuid" />
                        <div class="field-box">
                            <label>重置密码 (留空保持原密码不变)</label>
                            <input type="text" id="edit_pwd" placeholder="输入新密码" />
                        </div>
                        <div class="field-box">
                            <label>流量总配额限制</label>
                            <div class="input-unit-group">
                                <input type="number" step="0.01" id="edit_val" style="flex:2;" />
                                <select id="edit_unit" style="flex:1;">
                                    <option value="MB">MB</option>
                                    <option value="GB">GB</option>
                                    <option value="TB">TB</option>
                                </select>
                            </div>
                        </div>
                        <div class="field-box">
                            <label>权限到期日</label>
                            <input type="date" id="edit_expire" />
                        </div>
                        <div class="field-box">
                            <label>连接许可状态</label>
                            <select id="edit_enabled">
                                <option value="true">激活正常使用</option>
                                <option value="false">阻断冻结连接</option>
                            </select>
                        </div>
                        <div class="modal-footer">
                            <button class="btn" style="background:transparent; color:var(--text-muted); border:1px solid var(--card-border);" onclick="closeEditModal()">取消</button>
                            <button class="btn btn-primary" id="saveEditBtn" onclick="submitEdit()">确认保存更新</button>
                        </div>
                    </div>
                </div>

                <script>
                    function showToast(msg) {
                        let el = document.getElementById("__toast_msg__");
                        if (!el) {
                            el = document.createElement("div");
                            el.id = "__toast_msg__";
                            el.style.position = "fixed";
                            el.style.bottom = "40px";
                            el.style.left = "50%";
                            el.style.transform = "translateX(-50%)";
                            el.style.background = "rgba(15, 23, 42, 0.95)";
                            el.style.color = "#38bdf8";
                            el.style.border = "1px solid rgba(56, 189, 248, 0.4)";
                            el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.6)";
                            el.style.padding = "10px 24px";
                            el.style.borderRadius = "30px";
                            el.style.fontSize = "13px";
                            el.style.fontWeight = "600";
                            el.style.zIndex = "99999";
                            el.style.transition = "opacity 0.3s ease";
                            document.body.appendChild(el);
                        }
                        el.innerText = msg;
                        el.style.opacity = "1";
                        clearTimeout(el.__timer);
                        el.__timer = setTimeout(() => { el.style.opacity = "0"; }, 2000);
                    }

                    function copyText(val) {
                        if (!val) return;
                        if (navigator.clipboard && window.isSecureContext) {
                            navigator.clipboard.writeText(val).then(() => {
                                showToast("已复制到剪贴板！");
                            }).catch(() => {
                                fallbackCopy(val);
                            });
                        } else {
                            fallbackCopy(val);
                        }
                    }

                    function fallbackCopy(val) {
                        const ta = document.createElement("textarea");
                        ta.value = val;
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        ta.style.top = "-9999px";
                        ta.style.opacity = "0";
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        let ok = false;
                        try {
                            ok = document.execCommand("copy");
                        } catch (e) {}
                        document.body.removeChild(ta);
                        if (ok) {
                            showToast("已复制到剪贴板！");
                        } else {
                            prompt("自动复制失败，请手动按 Ctrl+C 复制：", val);
                        }
                    }

                    function openAddModal() {
                        document.getElementById("add_user").value = "";
                        document.getElementById("add_pwd").value = "123456";
                        document.getElementById("add_val").value = "50";
                        document.getElementById("add_unit").value = "GB";
                        document.getElementById("add_days").value = "30";
                        document.getElementById("addModal").style.display = "flex";
                    }

                    function closeAddModal() {
                        document.getElementById("addModal").style.display = "none";
                    }

                    async function submitAdd() {
                        const btn = document.getElementById("saveAddBtn");
                        btn.innerText = "创建中...";
                        btn.disabled = true;

                        try {
                            const username = document.getElementById("add_user").value;
                            const password = document.getElementById("add_pwd").value;
                            const limitVal = document.getElementById("add_val").value;
                            const limitUnit = document.getElementById("add_unit").value;
                            const days = document.getElementById("add_days").value;
                            if (!username) return alert("请填写用户名");

                            const res = await fetch("/admin/api/add", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ username, password, limitVal, limitUnit, days })
                            });

                            if (res.ok) {
                                showToast("用户创建成功！");
                                closeAddModal();
                                setTimeout(() => location.reload(), 600);
                            } else {
                                const data = await res.json();
                                alert(data.error || "创建失败");
                            }
                        } catch (err) {
                            alert("网络异常: " + err.message);
                        } finally {
                            btn.innerText = "立即创建";
                            btn.disabled = false;
                        }
                    }

                    function openEditModal(uuid, uname, val, unit, dateStr, enabled) {
                        document.getElementById("editModalTitle").innerText = "编辑用户: " + uname;
                        document.getElementById("edit_uuid").value = uuid;
                        document.getElementById("edit_pwd").value = "";
                        document.getElementById("edit_val").value = val;
                        document.getElementById("edit_unit").value = unit;
                        document.getElementById("edit_expire").value = (dateStr === "永久有效" ? "" : dateStr);
                        document.getElementById("edit_enabled").value = String(enabled);
                        document.getElementById("editModal").style.display = "flex";
                    }

                    function closeEditModal() {
                        document.getElementById("editModal").style.display = "none";
                    }

                    async function submitEdit() {
                        const btn = document.getElementById("saveEditBtn");
                        btn.innerText = "保存中...";
                        btn.disabled = true;

                        try {
                            const uuid = document.getElementById("edit_uuid").value;
                            const newPassword = document.getElementById("edit_pwd").value;
                            const trafficLimitVal = document.getElementById("edit_val").value;
                            const trafficLimitUnit = document.getElementById("edit_unit").value;
                            const expireDate = document.getElementById("edit_expire").value;
                            const enabled = document.getElementById("edit_enabled").value === "true";

                            const res = await fetch("/admin/api/update", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ uuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled })
                            });

                            if (res.ok) {
                                alert("修改已成功生效！");
                                closeEditModal();
                                location.reload();
                            } else {
                                const data = await res.json();
                                alert(data.error || "保存失败");
                            }
                        } catch (err) {
                            alert("网络请求失败：" + err.message);
                        } finally {
                            btn.innerText = "确认保存更新";
                            btn.disabled = false;
                        }
                    }

                    async function resetTraffic(uuid) {
                        if (!confirm("确定清空该用户的用量？")) return;
                        await fetch("/admin/api/reset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }

                    async function deleteUser(uuid) {
                        if (!confirm("确定注销此账号？其节点连接将即刻失效！")) return;
                        await fetch("/admin/api/delete", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }
                </script>
            </body>
            </html>
        `);
    }

    // 8. 前台用户仪表盘 (/)
    if (pathname === "/") {
        const currentUser = getSessionUser(req);

        if (!currentUser) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(`
                <!DOCTYPE html>
                <html lang="zh-CN">
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>网络接入平台 - 登入认证</title>
                    <style>
                        * { box-sizing: border-box; margin: 0; padding: 0; }
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                            background: radial-gradient(circle at 50% 15%, #182647 0%, #03060c 60%);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: #fff;
                            padding: 20px;
                        }
                        .auth-card {
                            background: rgba(13, 19, 33, 0.7);
                            backdrop-filter: blur(24px);
                            border: 1px solid rgba(255, 255, 255, 0.08);
                            border-radius: 24px;
                            padding: 44px 36px;
                            width: 100%;
                            max-width: 400px;
                            box-shadow: 0 30px 60px -12px rgba(0, 0, 0, 0.7);
                        }
                        .auth-header { text-align: center; margin-bottom: 32px; }
                        .logo-badge {
                            width: 48px; height: 48px; border-radius: 14px;
                            background: linear-gradient(135deg, #3b82f6, #8b5cf6);
                            display: flex; align-items: center; justify-content: center;
                            margin: 0 auto 16px auto; box-shadow: 0 10px 25px -5px rgba(59, 130, 246, 0.5);
                        }
                        .auth-title { font-size: 22px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.5px; }
                        .auth-sub { font-size: 13px; color: #94a3b8; }
                        .input-group { margin-bottom: 20px; }
                        .input-group label { display: block; font-size: 12px; font-weight: 500; color: #cbd5e1; margin-bottom: 8px; }
                        input {
                            width: 100%;
                            padding: 13px 16px;
                            background: rgba(0, 0, 0, 0.35);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            border-radius: 12px;
                            color: #fff;
                            font-size: 14px;
                            outline: none;
                            transition: 0.2s;
                        }
                        input:focus {
                            border-color: #3b82f6;
                            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
                        }
                        .btn-submit {
                            width: 100%;
                            padding: 13px;
                            background: #2563eb;
                            color: #fff;
                            border: none;
                            border-radius: 12px;
                            font-size: 14px;
                            font-weight: 600;
                            cursor: pointer;
                            margin-top: 8px;
                            transition: 0.2s;
                        }
                        .btn-submit:hover { background: #1d4ed8; transform: translateY(-1px); }
                        .toggle-box { text-align: center; margin-top: 24px; font-size: 13px; color: #60a5fa; cursor: pointer; }
                        .toggle-box:hover { text-decoration: underline; }
                        .error-banner {
                            display: none;
                            background: rgba(239, 68, 68, 0.15);
                            border: 1px solid rgba(239, 68, 68, 0.3);
                            color: #f87171;
                            padding: 12px 14px;
                            border-radius: 10px;
                            font-size: 13px;
                            margin-bottom: 20px;
                        }
                    </style>
                </head>
                <body>
                    <div class="auth-card">
                        <div class="auth-header">
                            <div class="logo-badge">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>
                            </div>
                            <h2 class="auth-title" id="formTitle">通行证登入</h2>
                            <div class="auth-sub" id="formDesc">登录以管理网络节点与专属订阅</div>
                        </div>

                        <div class="error-banner" id="errorBox"></div>

                        <div class="input-group">
                            <label>账号名称</label>
                            <input type="text" id="username" placeholder="输入用户名" />
                        </div>
                        <div class="input-group">
                            <label>通行密码</label>
                            <input type="password" id="password" placeholder="输入密码" />
                        </div>
                        <button class="btn-submit" id="submitBtn" onclick="handleAuth()">进入控制面板</button>
                        <div class="toggle-box" id="toggleBtn" onclick="toggleMode()">新用户？点此注册账号</div>
                    </div>

                    <script>
                        let isRegister = false;

                        function toggleMode() {
                            isRegister = !isRegister;
                            document.getElementById("formTitle").innerText = isRegister ? "注册新账号" : "通行证登入";
                            document.getElementById("formDesc").innerText = isRegister ? "创建账户即刻激活节点订阅" : "登录以管理网络节点与专属订阅";
                            document.getElementById("submitBtn").innerText = isRegister ? "立即创建账户" : "进入控制面板";
                            document.getElementById("toggleBtn").innerText = isRegister ? "已有账号？返回登入" : "新用户？点此注册账号";
                            hideError();
                        }

                        function showError(msg) {
                            const box = document.getElementById("errorBox");
                            box.innerText = msg;
                            box.style.display = "block";
                        }

                        function hideError() {
                            document.getElementById("errorBox").style.display = "none";
                        }

                        async function handleAuth() {
                            hideError();
                            const u = document.getElementById("username").value.trim();
                            const p = document.getElementById("password").value.trim();
                            if (!u || !p) return showError("请输入完整的账号与密码");

                            const endpoint = isRegister ? "/api/register" : "/api/login";
                            try {
                                const res = await fetch(endpoint, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ username: u, password: p })
                                });
                                const data = await res.json();
                                if (res.ok) {
                                    if (isRegister) {
                                        alert("账号创建成功，请直接登录！");
                                        toggleMode();
                                    } else {
                                        location.reload();
                                    }
                                } else {
                                    showError(data.error || "请求处理失败");
                                }
                            } catch (e) {
                                showError("网络连接超时，请重试");
                            }
                        }
                    </script>
                </body>
                </html>
            `);
        }

        const baseSubUrl = isTunnelAvailable
            ? `https://${ARGO_DOMAIN}/sub?token=${currentUser.uuid}`
            : `http://${DIRECT_IP}:${SERVER_PORT}/sub?token=${currentUser.uuid}`;
        const clashSubUrl = `${baseSubUrl}&type=clash`;

        const percentage = currentUser.trafficLimit > 0
            ? Math.min(100, (currentUser.trafficUsed / currentUser.trafficLimit * 100)).toFixed(1)
            : 0;

        const daysLeft = Math.max(0, Math.ceil((currentUser.expireTime - Date.now()) / 86400000));
        const invalidReason = isUserInvalid(currentUser);

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>个人中心 - 控制面板</title>
                <style>
                    :root {
                        --primary: #3b82f6;
                        --primary-glow: rgba(59, 130, 246, 0.4);
                        --card-bg: rgba(13, 19, 33, 0.7);
                        --border: rgba(255, 255, 255, 0.08);
                    }
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                        background: radial-gradient(circle at 50% 0%, #172554 0%, #03060c 60%);
                        min-height: 100vh;
                        color: #f8fafc;
                        padding: 48px 20px;
                    }
                    .container { max-width: 660px; margin: 0 auto; }
                    .top-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
                    .user-meta h2 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
                    .status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 12px; margin-top: 6px; }
                    .status-ok { background: rgba(34, 197, 94, 0.12); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.25); }
                    .status-warn { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.25); }
                    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
                    .logout-link { color: #f87171; text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.2); transition: 0.2s; }
                    .logout-link:hover { background: rgba(239, 68, 68, 0.1); }
                    .dashboard-card {
                        background: var(--card-bg);
                        backdrop-filter: blur(20px);
                        border: 1px solid var(--border);
                        border-radius: 22px;
                        padding: 30px;
                        margin-bottom: 24px;
                        box-shadow: 0 20px 40px -15px rgba(0,0,0,0.5);
                    }
                    .card-header-flex { display: flex; justify-content: space-between; margin-bottom: 14px; font-size: 13px; font-weight: 500; }
                    .progress-track { background: rgba(255, 255, 255, 0.06); height: 10px; border-radius: 10px; overflow: hidden; margin-bottom: 24px; }
                    .progress-fill { background: linear-gradient(90deg, #38bdf8, #3b82f6); height: 100%; border-radius: 10px; transition: width 0.3s ease; }
                    .grid-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
                    .stat-subcard {
                        background: rgba(0, 0, 0, 0.25);
                        border: 1px solid var(--border);
                        padding: 18px 20px;
                        border-radius: 14px;
                    }
                    .stat-subcard .title { font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
                    .stat-subcard .value { font-size: 22px; font-weight: 700; color: #fff; }
                    .sub-tabs { display: flex; gap: 10px; margin-top: 14px; }
                    .sub-input-box { display: flex; gap: 10px; margin-top: 10px; }
                    .sub-input-box input {
                        flex: 1;
                        padding: 13px 16px;
                        background: rgba(0, 0, 0, 0.35);
                        border: 1px solid var(--border);
                        border-radius: 12px;
                        color: #38bdf8;
                        font-family: monospace;
                        font-size: 13px;
                        outline: none;
                    }
                    .btn-copy {
                        padding: 0 20px;
                        background: #2563eb;
                        border: none;
                        border-radius: 12px;
                        color: #fff;
                        font-weight: 600;
                        font-size: 13px;
                        cursor: pointer;
                        transition: 0.2s;
                        white-space: nowrap;
                    }
                    .btn-copy:hover { background: #1d4ed8; }
                    .btn-copy-clash-sub { background: #7c3aed; }
                    .btn-copy-clash-sub:hover { background: #6d28d9; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="top-nav">
                        <div class="user-meta">
                            <h2>${currentUser.username}</h2>
                            <div class="status-pill ${invalidReason ? 'status-warn' : 'status-ok'}">
                                <span class="status-dot"></span>${invalidReason ? invalidReason : '许可已激活'}
                            </div>
                        </div>
                        <a href="/logout" class="logout-link">注销登出</a>
                    </div>

                    <div class="dashboard-card">
                        <div class="card-header-flex">
                            <span style="color:#94a3b8;">独立配额消耗率</span>
                            <span style="font-weight:700;" id="percentText">${percentage}%</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" id="progressFill" style="width: ${percentage}%;"></div>
                        </div>
                        <div class="grid-stats">
                            <div class="stat-subcard">
                                <div class="title">已用 / 总限额</div>
                                <div class="value" id="trafficText">${formatBytes(currentUser.trafficUsed)} <span style="font-size:12px; font-weight:normal; color:#64748b;">/ ${formatBytes(currentUser.trafficLimit)}</span></div>
                            </div>
                            <div class="stat-subcard">
                                <div class="title">剩余有效天数</div>
                                <div class="value" id="daysText">${daysLeft} <span style="font-size:12px; font-weight:normal; color:#64748b;">天</span></div>
                            </div>
                        </div>
                    </div>

                    <div class="dashboard-card">
                        <h4 style="font-size: 16px; margin-bottom: 6px;">通用客户端与 Clash 规则订阅</h4>
                        <p style="font-size: 13px; color: #94a3b8;">复制对应订阅链接直接导入客户端使用（支持多协议直连与异地集群节点）：</p>
                        
                        <div style="margin-top:16px;">
                            <div style="font-size:12px; color:#cbd5e1; margin-bottom:4px;">1. 通用 Base64 订阅 (v2rayN / Shadowrocket / Sing-box)</div>
                            <div class="sub-input-box">
                                <input type="text" id="subUrl" readonly value="${baseSubUrl}" />
                                <button class="btn-copy" onclick="copyValue('subUrl')">复制常规</button>
                            </div>
                        </div>

                        <div style="margin-top:16px;">
                            <div style="font-size:12px; color:#cbd5e1; margin-bottom:4px;">2. Clash Meta (Mihomo) 规则配置订阅</div>
                            <div class="sub-input-box">
                                <input type="text" id="clashSubUrl" readonly value="${clashSubUrl}" style="color:#c084fc;" />
                                <button class="btn-copy btn-copy-clash-sub" onclick="copyValue('clashSubUrl')">复制 Clash</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    function showToast(msg) {
                        let el = document.getElementById("__toast_msg__");
                        if (!el) {
                            el = document.createElement("div");
                            el.id = "__toast_msg__";
                            el.style.position = "fixed";
                            el.style.bottom = "40px";
                            el.style.left = "50%";
                            el.style.transform = "translateX(-50%)";
                            el.style.background = "rgba(15, 23, 42, 0.95)";
                            el.style.color = "#38bdf8";
                            el.style.border = "1px solid rgba(56, 189, 248, 0.4)";
                            el.style.boxShadow = "0 10px 30px rgba(0,0,0,0.6)";
                            el.style.padding = "10px 24px";
                            el.style.borderRadius = "30px";
                            el.style.fontSize = "13px";
                            el.style.fontWeight = "600";
                            el.style.zIndex = "99999";
                            el.style.transition = "opacity 0.3s ease";
                            document.body.appendChild(el);
                        }
                        el.innerText = msg;
                        el.style.opacity = "1";
                        clearTimeout(el.__timer);
                        el.__timer = setTimeout(() => { el.style.opacity = "0"; }, 2000);
                    }

                    function copyValue(id) {
                        const input = document.getElementById(id);
                        if (!input || !input.value) return;
                        const val = input.value;
                        if (navigator.clipboard && window.isSecureContext) {
                            navigator.clipboard.writeText(val).then(() => {
                                showToast("订阅链接已复制到剪切板！");
                            }).catch(() => {
                                fallbackCopy(val);
                            });
                        } else {
                            fallbackCopy(val);
                        }
                    }

                    function fallbackCopy(val) {
                        const ta = document.createElement("textarea");
                        ta.value = val;
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        ta.style.top = "-9999px";
                        ta.style.opacity = "0";
                        document.body.appendChild(ta);
                        ta.focus();
                        ta.select();
                        let ok = false;
                        try {
                            ok = document.execCommand("copy");
                        } catch (e) {}
                        document.body.removeChild(ta);
                        if (ok) {
                            showToast("订阅链接已复制到剪切板！");
                        } else {
                            prompt("自动复制受限，请长按或按 Ctrl+C 复制：", val);
                        }
                    }

                    setInterval(async () => {
                        try {
                            const res = await fetch("/api/my-stats");
                            if (res.ok) {
                                const data = await res.json();
                                document.getElementById("percentText").innerText = data.percentage + "%";
                                document.getElementById("progressFill").style.width = data.percentage + "%";
                                document.getElementById("trafficText").innerHTML = data.usedFormatted + ' <span style="font-size:12px; font-weight:normal; color:#64748b;">/ ' + data.totalFormatted + '</span>';
                                document.getElementById("daysText").innerHTML = data.daysLeft + ' <span style="font-size:12px; font-weight:normal; color:#64748b;">天</span>';
                            }
                        } catch (e) {}
                    }, 3000);
                </script>
            </body>
            </html>
        `);
    }

    res.writeHead(404);
    res.end();
}

// ==================== 6. 实时流式分块记账代理核心 ====================
let saveDiskTimer = null;
function triggerDebouncedSave() {
    if (saveDiskTimer) return;
    saveDiskTimer = setTimeout(() => {
        saveUsers();
        saveDiskTimer = null;
    }, 3000);
}

function handleUpgradeRequest(req, clientSocket, head) {
    const rawUrl = req.url || "/";
    const lowerUrl = rawUrl.toLowerCase();

    let targetPort = null;
    let targetCorePath = "/";

    if (lowerUrl.includes("vless")) {
        targetPort = INTERNAL_VLESS_PORT;
        targetCorePath = "/vless";
    } else if (lowerUrl.includes("vmess")) {
        targetPort = INTERNAL_VMESS_PORT;
        targetCorePath = "/vmess";
    } else if (lowerUrl.includes("trojan")) {
        targetPort = INTERNAL_TROJAN_PORT;
        targetCorePath = "/trojan";
    }

    if (!targetPort) {
        clientSocket.destroy();
        return;
    }

    const matchedUser = usersDatabase.find((u) => rawUrl.includes(u.uuid));

    const invalidReason = isUserInvalid(matchedUser);
    if (invalidReason) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        clientSocket.destroy();
        return;
    }

    // 活跃在线感知：增加活跃连接并刷新活跃时间
    const userAct = matchedUser ? getUserActivity(matchedUser.uuid) : null;
    if (userAct) {
        userAct.activeConnections++;
        userAct.lastSeenAt = Date.now();
    }

    const backendSocket = net.connect(targetPort, "127.0.0.1", () => {
        let requestRaw = `${req.method} ${targetCorePath} HTTP/1.1\r\n`;
        let hasUpgrade = false;
        let hasConnection = false;

        for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const key = req.rawHeaders[i];
            const val = req.rawHeaders[i + 1];
            const lowerKey = key.toLowerCase();

            if (lowerKey === "upgrade") hasUpgrade = true;
            if (lowerKey === "connection") hasConnection = true;

            requestRaw += `${key}: ${val}\r\n`;
        }

        if (!hasUpgrade) requestRaw += "Upgrade: websocket\r\n";
        if (!hasConnection) requestRaw += "Connection: Upgrade\r\n";
        requestRaw += "\r\n";

        backendSocket.write(requestRaw);
        if (head && head.length > 0) backendSocket.write(head);

        let uncommittedBytes = 0;
        const FLUSH_THRESHOLD = 256 * 1024;

        const flushRealtimeTraffic = (bytes) => {
            if (!matchedUser) return;
            uncommittedBytes += bytes;
            if (userAct) userAct.lastSeenAt = Date.now();

            if (uncommittedBytes >= FLUSH_THRESHOLD) {
                matchedUser.trafficUsed += uncommittedBytes;
                uncommittedBytes = 0;
                triggerDebouncedSave();

                if (matchedUser.trafficLimit > 0 && matchedUser.trafficUsed >= matchedUser.trafficLimit) {
                    clientSocket.destroy();
                    backendSocket.destroy();
                    safeReloadSingbox();
                }
            }
        };

        clientSocket.on("data", (chunk) => flushRealtimeTraffic(chunk.length));
        backendSocket.on("data", (chunk) => flushRealtimeTraffic(chunk.length));

        let isClosed = false;
        const handleClose = () => {
            if (isClosed) return;
            isClosed = true;

            if (userAct) {
                userAct.activeConnections = Math.max(0, userAct.activeConnections - 1);
                userAct.lastSeenAt = Date.now();
            }

            if (matchedUser && uncommittedBytes > 0) {
                matchedUser.trafficUsed += uncommittedBytes;
                uncommittedBytes = 0;
                triggerDebouncedSave();
            }
        };

        clientSocket.once("close", handleClose);
        backendSocket.once("close", handleClose);

        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);
    });

    backendSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => backendSocket.destroy());
}

setInterval(() => {
    const beforeCount = getActiveUsers().length;
    saveUsers();
    const afterCount = getActiveUsers().length;
    if (beforeCount !== afterCount) {
        safeReloadSingbox();
    }
}, 60000);

// ==================== 7. 系统启动 ====================
loadUsers();

const serverExternal = http.createServer(handleHttpRequest);
serverExternal.on("upgrade", handleUpgradeRequest);
serverExternal.listen(SERVER_PORT, "0.0.0.0", () => {
    console.log(`[Pterodactyl] 翼龙外网服务就绪: ${SERVER_PORT}`);
    console.log(`[Admin] 后台管理独立入口: http://${DIRECT_IP}:${SERVER_PORT}/admin/login`);
    initSingboxCore();
    initAndStartCloudflared();
});

if (isTunnelAvailable) {
    const serverTunnel = http.createServer(handleHttpRequest);
    serverTunnel.on("upgrade", handleUpgradeRequest);
    serverTunnel.listen(PORT_TUNNEL, "0.0.0.0", () => {
        console.log(`[Tunnel] Argo 回源端口就绪: ${PORT_TUNNEL}`);
    });
}
