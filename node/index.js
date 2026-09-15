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
                    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
                    <title>总控中心 · 管理员登入</title>
                    <style>
                        :root {
                            --el-bg: #f0f2f5;
                            --el-card: #ffffff;
                            --el-border: #dcdfe6;
                            --el-text: #303133;
                            --el-text-sub: #606266;
                            --el-primary: #409eff;
                            --el-primary-hover: #66b1ff;
                        }
                        * { box-sizing: border-box; margin: 0; padding: 0; }
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                            background: var(--el-bg);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: var(--el-text);
                            padding: 16px;
                        }
                        .admin-login-card {
                            background: var(--el-card);
                            border: 1px solid var(--el-border);
                            border-radius: 8px;
                            padding: 36px 32px;
                            width: 100%;
                            max-width: 380px;
                            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
                        }
                        .logo-badge {
                            width: 48px; height: 48px; border-radius: 8px;
                            background: #ecf5ff; border: 1px solid #d9ecff;
                            display: flex; align-items: center; justify-content: center;
                            margin: 0 auto 14px auto; font-size: 24px; color: var(--el-primary);
                        }
                        .header-title { font-size: 20px; font-weight: 600; text-align: center; margin-bottom: 6px; color: #303133; }
                        .header-sub { font-size: 13px; color: var(--el-text-sub); text-align: center; margin-bottom: 24px; }
                        .input-box { margin-bottom: 20px; }
                        .input-box label { display: block; font-size: 13px; color: #606266; margin-bottom: 8px; font-weight: 500; }
                        input {
                            width: 100%;
                            padding: 11px 14px;
                            background: #ffffff;
                            border: 1px solid var(--el-border);
                            border-radius: 6px;
                            color: #303133;
                            font-size: 14px;
                            outline: none;
                            transition: border-color 0.2s;
                        }
                        input:focus { border-color: var(--el-primary); box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2); }
                        .btn-login {
                            width: 100%;
                            padding: 12px;
                            background: var(--el-primary);
                            color: #ffffff;
                            border: none;
                            border-radius: 6px;
                            font-size: 14px;
                            font-weight: 500;
                            cursor: pointer;
                            transition: background 0.2s;
                        }
                        .btn-login:hover { background: var(--el-primary-hover); }
                        .error-msg {
                            display: none;
                            background: #fef0f0;
                            border: 1px solid #fde2e2;
                            color: #f56c6c;
                            padding: 10px 14px;
                            border-radius: 6px;
                            font-size: 13px;
                            margin-bottom: 18px;
                            text-align: center;
                        }
                    </style>
                </head>
                <body>
                    <div class="admin-login-card">
                        <div class="logo-badge">🛡️</div>
                        <h2 class="header-title">系统控制中枢</h2>
                        <div class="header-sub">管理员独立鉴权通道 · 会话保护</div>
                        <div class="error-msg" id="errMsg"></div>
                        <div class="input-box">
                            <label>管理安全口令</label>
                            <input type="password" id="adminToken" placeholder="请输入 ADMIN_TOKEN" autofocus />
                        </div>
                        <button class="btn-login" id="loginBtn" onclick="doAdminLogin()">验证登录</button>
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
                    <td data-label="用户主体">
                        <div class="user-cell">
                            <span class="avatar">${u.username.substring(0, 1).toUpperCase()}</span>
                            <div class="user-info">
                                <span class="uname">${u.username}</span>
                                <span class="uuid-sub" onclick="copyText('${u.uuid}')" title="点击复制完整UUID">${u.uuid.substring(0, 8)}...</span>
                            </div>
                        </div>
                    </td>
                    <td data-label="用量/限额">
                        <div class="metric-val">${formatBytes(u.trafficUsed)}</div>
                        <div class="metric-sub">限额 ${formatBytes(u.trafficLimit)}</div>
                    </td>
                    <td data-label="到期时间" class="date-cell">${dateStr}</td>
                    <td data-label="账号状态">${statusBadge}</td>
                    <td data-label="实时感知">${onlineBadge}</td>
                    <td data-label="专属订阅">
                        <div class="sub-btn-group">
                            <button class="btn btn-copy-sub" onclick="copyText('${baseSubUrl}')" title="复制标准 Base64 订阅链接">常规</button>
                            <button class="btn btn-copy-sub btn-copy-clash" onclick="copyText('${clashSubUrl}')" title="复制 Clash Meta 规则配置订阅">Clash</button>
                        </div>
                    </td>
                    <td data-label="管理操作">
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
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>系统控制中枢 · 控制面板</title>
                <style>
                    :root {
                        --el-bg: #f0f2f5;
                        --el-card: #ffffff;
                        --el-border: #dcdfe6;
                        --el-border-light: #ebeef5;
                        --el-text-main: #303133;
                        --el-text-regular: #606266;
                        --el-text-secondary: #909399;
                        --el-primary: #409eff;
                        --el-primary-hover: #66b1ff;
                        --el-primary-light: #ecf5ff;
                        --el-primary-border: #d9ecff;
                        --el-success: #67c23a;
                        --el-success-light: #f0f9eb;
                        --el-success-border: #e1f3d8;
                        --el-warning: #e6a23c;
                        --el-warning-light: #fdf6ec;
                        --el-warning-border: #faecd8;
                        --el-danger: #f56c6c;
                        --el-danger-light: #fef0f0;
                        --el-danger-border: #fde2e2;
                        --el-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
                    }
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                        background: var(--el-bg);
                        color: var(--el-text-main);
                        padding: 20px;
                        min-height: 100vh;
                        -webkit-font-smoothing: antialiased;
                    }
                    .container { max-width: 1200px; margin: 0 auto; }
                    
                    /* 顶栏 */
                    .header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 16px;
                        background: var(--el-card);
                        padding: 14px 20px;
                        border-radius: 6px;
                        border: 1px solid var(--el-border);
                        box-shadow: var(--el-shadow);
                    }
                    .header-title {
                        font-size: 17px;
                        font-weight: 600;
                        color: var(--el-text-main);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .header-desc { font-size: 12px; color: var(--el-text-secondary); margin-top: 2px; }
                    .header-right { display: flex; align-items: center; gap: 10px; }
                    .logout-btn {
                        color: var(--el-danger);
                        text-decoration: none;
                        font-size: 13px;
                        font-weight: 500;
                        padding: 6px 14px;
                        border-radius: 4px;
                        border: 1px solid var(--el-danger-border);
                        background: var(--el-danger-light);
                        transition: all 0.2s;
                        white-space: nowrap;
                    }
                    .logout-btn:hover { background: #fde2e2; }
                    
                    /* 数据统计网格 */
                    .stats-grid {
                        display: grid;
                        grid-template-columns: repeat(4, 1fr);
                        gap: 14px;
                        margin-bottom: 16px;
                    }
                    .stat-card {
                        background: var(--el-card);
                        border: 1px solid var(--el-border);
                        border-radius: 6px;
                        padding: 16px 18px;
                        box-shadow: var(--el-shadow);
                        position: relative;
                        overflow: hidden;
                    }
                    .stat-card::before {
                        content: '';
                        position: absolute;
                        left: 0; top: 0; bottom: 0;
                        width: 4px;
                    }
                    .stat-card.c1::before { background: var(--el-primary); }
                    .stat-card.c2::before { background: var(--el-success); }
                    .stat-card.c3::before { background: #8e44ad; }
                    .stat-card.c4::before { background: #0284c7; }
                    .stat-title { font-size: 12px; color: var(--el-text-secondary); margin-bottom: 6px; font-weight: 500; }
                    .stat-value { font-size: 22px; font-weight: 700; color: var(--el-text-main); display: flex; align-items: baseline; gap: 4px; }
                    .stat-unit { font-size: 12px; color: var(--el-text-secondary); font-weight: normal; }

                    /* 主内容面板 */
                    .panel {
                        background: var(--el-card);
                        border: 1px solid var(--el-border);
                        border-radius: 6px;
                        padding: 18px 20px;
                        box-shadow: var(--el-shadow);
                    }
                    .panel-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 14px;
                        padding-bottom: 12px;
                        border-bottom: 1px solid var(--el-border-light);
                        flex-wrap: wrap;
                        gap: 10px;
                    }
                    .panel-title { font-size: 15px; font-weight: 600; color: var(--el-text-main); }
                    
                    .btn {
                        padding: 7px 14px;
                        border-radius: 4px;
                        border: 1px solid transparent;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.2s;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 5px;
                        white-space: nowrap;
                    }
                    .btn-primary { background: var(--el-primary); color: #fff; border-color: var(--el-primary); }
                    .btn-primary:hover { background: var(--el-primary-hover); border-color: var(--el-primary-hover); }
                    
                    /* 表格与横向滚动容器 */
                    .table-wrapper {
                        width: 100%;
                        overflow-x: auto;
                        -webkit-overflow-scrolling: touch;
                        border: 1px solid var(--el-border-light);
                        border-radius: 4px;
                    }
                    table { width: 100%; border-collapse: collapse; text-align: left; min-width: 800px; }
                    th {
                        background: #fafafa;
                        color: var(--el-text-regular);
                        font-weight: 600;
                        font-size: 13px;
                        padding: 11px 14px;
                        border-bottom: 1px solid var(--el-border);
                        white-space: nowrap;
                    }
                    td {
                        padding: 11px 14px;
                        border-bottom: 1px solid var(--el-border-light);
                        font-size: 13px;
                        color: var(--el-text-regular);
                        vertical-align: middle;
                        white-space: nowrap;
                    }
                    tr:last-child td { border-bottom: none; }
                    tr:hover td { background: #fdfdfd; }
                    
                    .user-cell { display: flex; align-items: center; gap: 10px; }
                    .avatar {
                        width: 32px; height: 32px; border-radius: 4px;
                        background: var(--el-primary-light);
                        border: 1px solid var(--el-primary-border);
                        color: var(--el-primary);
                        display: flex; align-items: center; justify-content: center;
                        font-size: 14px; font-weight: bold; flex-shrink: 0;
                    }
                    .uname { font-weight: 600; font-size: 14px; color: var(--el-text-main); }
                    .uuid-sub { font-family: Consolas, monospace; font-size: 11px; color: var(--el-text-secondary); cursor: pointer; display: block; }
                    .uuid-sub:hover { color: var(--el-primary); text-decoration: underline; }
                    
                    .metric-val { font-size: 13px; font-weight: 600; color: #0284c7; }
                    .metric-sub { font-size: 11px; color: var(--el-text-secondary); margin-top: 2px; }
                    .date-cell { font-size: 13px; color: var(--el-text-regular); }
                    
                    .badge {
                        display: inline-flex; align-items: center; gap: 5px;
                        padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
                    }
                    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
                    .badge-success { background: var(--el-success-light); color: var(--el-success); border: 1px solid var(--el-success-border); }
                    .badge-danger { background: var(--el-danger-light); color: var(--el-danger); border: 1px solid var(--el-danger-border); }
                    .badge-warning { background: var(--el-warning-light); color: var(--el-warning); border: 1px solid var(--el-warning-border); }
                    
                    .badge-online-live {
                        display: inline-flex; align-items: center; gap: 5px;
                        color: #0284c7; font-size: 11px; font-weight: 600;
                        background: #f0f9ff; border: 1px solid #e0f2fe; padding: 3px 8px; border-radius: 4px;
                    }
                    .badge-dot-live {
                        width: 6px; height: 6px; border-radius: 50%;
                        background: #0284c7; box-shadow: 0 0 6px rgba(2, 132, 199, 0.6);
                    }
                    .badge-online-offline { font-size: 11px; color: var(--el-text-secondary); }

                    .sub-btn-group { display: flex; gap: 6px; }
                    .btn-copy-sub {
                        background: var(--el-primary-light);
                        border: 1px solid var(--el-primary-border);
                        color: var(--el-primary);
                        font-size: 11px; padding: 4px 8px; border-radius: 4px;
                    }
                    .btn-copy-sub:hover { background: var(--el-primary); color: #fff; }
                    .btn-copy-clash { background: #f3e8ff; border: 1px solid #e9d5ff; color: #9333ea; }
                    .btn-copy-clash:hover { background: #9333ea; color: #fff; }

                    .actions-group { display: flex; gap: 6px; }
                    .btn-action-edit {
                        background: #ffffff; border: 1px solid var(--el-border);
                        color: var(--el-text-regular); padding: 4px 8px; font-size: 12px; border-radius: 4px;
                    }
                    .btn-action-edit:hover { color: var(--el-primary); border-color: var(--el-primary-border); background: var(--el-primary-light); }
                    .btn-action-reset {
                        background: var(--el-warning-light); border: 1px solid var(--el-warning-border);
                        color: var(--el-warning); padding: 4px 8px; font-size: 12px; border-radius: 4px;
                    }
                    .btn-action-reset:hover { background: var(--el-warning); color: #fff; }
                    .btn-action-del {
                        background: var(--el-danger-light); border: 1px solid var(--el-danger-border);
                        color: var(--el-danger); padding: 4px 8px; font-size: 12px; border-radius: 4px;
                    }
                    .btn-action-del:hover { background: var(--el-danger); color: #fff; }

                    /* 响应式弹窗 */
                    .modal-mask {
                        position: fixed; inset: 0;
                        background: rgba(0, 0, 0, 0.45);
                        display: none; align-items: center; justify-content: center;
                        z-index: 999; padding: 16px;
                    }
                    .modal {
                        background: var(--el-card);
                        border-radius: 8px;
                        border: 1px solid var(--el-border);
                        width: 100%;
                        max-width: 440px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                        padding: 22px 24px;
                    }
                    .modal h4 { font-size: 16px; font-weight: 600; margin-bottom: 18px; color: var(--el-text-main); }
                    .field-box { margin-bottom: 14px; }
                    .field-box label { display: block; font-size: 12px; color: var(--el-text-regular); margin-bottom: 6px; font-weight: 500; }
                    .field-box input, .field-box select {
                        width: 100%;
                        padding: 9px 12px;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        background: #ffffff;
                        color: var(--el-text-main);
                        font-size: 14px;
                        outline: none;
                        transition: border-color 0.2s;
                    }
                    .field-box input:focus, .field-box select:focus {
                        border-color: var(--el-primary);
                        box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
                    }
                    .input-unit-group { display: flex; gap: 8px; }
                    .modal-footer {
                        display: flex; justify-content: flex-end; gap: 10px;
                        margin-top: 20px; padding-top: 14px;
                        border-top: 1px solid var(--el-border-light);
                    }

                    /* 移动端手机界面媒体查询自适应 */
                    @media (max-width: 768px) {
                        body { padding: 12px; }
                        .header {
                            flex-direction: column;
                            align-items: flex-start;
                            gap: 12px;
                            padding: 14px 16px;
                        }
                        .header-right {
                            width: 100%;
                            justify-content: flex-end;
                        }
                        .stats-grid {
                            grid-template-columns: repeat(2, 1fr);
                            gap: 10px;
                            margin-bottom: 12px;
                        }
                        .stat-card {
                            padding: 12px 14px;
                        }
                        .stat-value {
                            font-size: 18px;
                        }
                        .panel {
                            padding: 14px 12px;
                        }
                        .panel-header {
                            flex-direction: column;
                            align-items: flex-start;
                            gap: 10px;
                        }
                        .panel-header .btn-primary {
                            width: 100%;
                        }
                        .mobile-tip {
                            display: block !important;
                            font-size: 11px;
                            color: var(--el-text-secondary);
                            margin-bottom: 8px;
                        }
                        .modal {
                            padding: 18px 16px;
                            max-width: 95vw;
                        }
                    }
                    .mobile-tip { display: none; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div>
                            <div class="header-title">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" color="var(--el-primary)"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>
                                节点服务集群总控台
                            </div>
                            <div class="header-desc">统一网关路由 · 多协议分流 · 实时感知运维</div>
                        </div>
                        <div class="header-right">
                            <span style="font-size:12px; color:var(--el-text-secondary);">端口: ${SERVER_PORT}</span>
                            <a href="/admin/logout" class="logout-btn">退出管理</a>
                        </div>
                    </div>

                    <div class="stats-grid">
                        <div class="stat-card c1">
                            <div class="stat-title">全站注册用户</div>
                            <div class="stat-value">${totalUsers} <span class="stat-unit">人</span></div>
                        </div>
                        <div class="stat-card c2">
                            <div class="stat-title">有效通行凭证</div>
                            <div class="stat-value" style="color:var(--el-success);">${activeUsersCount} <span class="stat-unit">活跃</span></div>
                        </div>
                        <div class="stat-card c3">
                            <div class="stat-title">实时活跃连线</div>
                            <div class="stat-value" style="color:#8e44ad;">${totalLiveConnections} <span class="stat-unit">连接</span></div>
                        </div>
                        <div class="stat-card c4">
                            <div class="stat-title">全站已用总流量</div>
                            <div class="stat-value" style="color:#0284c7;">${formatBytes(totalTrafficSum)}</div>
                        </div>
                    </div>

                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">用户清单与权限详情</div>
                            <button class="btn btn-primary" onclick="openAddModal()">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                新增用户授权
                            </button>
                        </div>
                        <div class="mobile-tip">💡 提示：表格支持左右横向滑动查看全部字段</div>
                        <div class="table-wrapper">
                            <table>
                                <thead>
                                    <tr>
                                        <th>用户主体</th>
                                        <th>流量消耗 / 上限</th>
                                        <th>到期时间</th>
                                        <th>账号状态</th>
                                        <th>实时在线感知</th>
                                        <th>专属订阅 (普通 / Clash)</th>
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
                            <h4>新增用户授权</h4>
                            <div class="field-box">
                                <label>用户账号名称</label>
                                <input type="text" id="add_user" placeholder="请输入用户名" />
                            </div>
                            <div class="field-box">
                                <label>初始登录密码</label>
                                <input type="password" id="add_pwd" placeholder="设置登录密码" value="123456" />
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
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeAddModal()">取消</button>
                                <button class="btn btn-primary" id="saveAddBtn" onclick="submitAdd()">立即创建</button>
                            </div>
                        </div>
                    </div>

                    <!-- 编辑用户弹窗 -->
                    <div class="modal-mask" id="editModal">
                        <div class="modal">
                            <h4 id="editModalTitle">编辑用户资料</h4>
                            <input type="hidden" id="edit_uuid" />
                            <div class="field-box">
                                <label>重置密码 (留空则保持原密码不变)</label>
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
                                <label>权限到期日 (清空则设为永久有效)</label>
                                <input type="date" id="edit_expire" />
                            </div>
                            <div class="field-box">
                                <label>通行许可状态</label>
                                <select id="edit_enabled">
                                    <option value="true">激活正常使用</option>
                                    <option value="false">阻断冻结连接</option>
                                </select>
                            </div>
                            <div class="modal-footer">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeEditModal()">取消</button>
                                <button class="btn btn-primary" id="saveEditBtn" onclick="submitEdit()">保存更新</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    function showToast(msg) {
                        let el = document.getElementById("__el_toast__");
                        if (!el) {
                            el = document.createElement("div");
                            el.id = "__el_toast__";
                            el.style.position = "fixed";
                            el.style.top = "24px";
                            el.style.left = "50%";
                            el.style.transform = "translateX(-50%) translateY(-20px)";
                            el.style.background = "#f0f9eb";
                            el.style.border = "1px solid #e1f3d8";
                            el.style.color = "#67c23a";
                            el.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.08)";
                            el.style.padding = "10px 20px";
                            el.style.borderRadius = "4px";
                            el.style.fontSize = "13px";
                            el.style.fontWeight = "500";
                            el.style.zIndex = "99999";
                            el.style.transition = "opacity 0.25s ease, transform 0.25s ease";
                            el.style.display = "flex";
                            el.style.alignItems = "center";
                            el.style.gap = "8px";
                            el.style.pointerEvents = "none";
                            el.style.opacity = "0";
                            document.body.appendChild(el);
                        }
                        el.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' + msg;
                        el.style.opacity = "1";
                        el.style.transform = "translateX(-50%) translateY(0)";
                        clearTimeout(el.__timer);
                        el.__timer = setTimeout(() => {
                            el.style.opacity = "0";
                            el.style.transform = "translateX(-50%) translateY(-20px)";
                        }, 2200);
                    }

                    function copyText(val) {
                        if (!val) return;
                        if (navigator.clipboard && window.isSecureContext) {
                            navigator.clipboard.writeText(val).then(() => {
                                showToast("已成功复制到剪贴板！");
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
                        ta.setAttribute("readonly", "");
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        ta.style.fontSize = "16px";
                        document.body.appendChild(ta);
                        ta.select();
                        ta.setSelectionRange(0, val.length);
                        let ok = false;
                        try {
                            ok = document.execCommand("copy");
                        } catch (e) {}
                        document.body.removeChild(ta);
                        if (ok) {
                            showToast("已成功复制到剪贴板！");
                        } else {
                            prompt("自动复制受限，请长按或手动复制链接：", val);
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
                            const username = document.getElementById("add_user").value.trim();
                            const password = document.getElementById("add_pwd").value.trim();
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
                                showToast("修改已成功生效！");
                                closeEditModal();
                                setTimeout(() => location.reload(), 500);
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
                    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
                    <title>网络接入平台 · 用户通行证</title>
                    <style>
                        :root {
                            --el-bg: #f0f2f5;
                            --el-card: #ffffff;
                            --el-border: #dcdfe6;
                            --el-text: #303133;
                            --el-text-sub: #606266;
                            --el-primary: #409eff;
                            --el-primary-hover: #66b1ff;
                        }
                        * { box-sizing: border-box; margin: 0; padding: 0; }
                        body {
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                            background: var(--el-bg);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            color: var(--el-text);
                            padding: 16px;
                            -webkit-font-smoothing: antialiased;
                        }
                        .auth-card {
                            background: var(--el-card);
                            border: 1px solid var(--el-border);
                            border-radius: 8px;
                            padding: 36px 32px;
                            width: 100%;
                            max-width: 380px;
                            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
                        }
                        .auth-header { text-align: center; margin-bottom: 24px; }
                        .logo-badge {
                            width: 48px; height: 48px; border-radius: 8px;
                            background: #ecf5ff; border: 1px solid #d9ecff;
                            display: flex; align-items: center; justify-content: center;
                            margin: 0 auto 12px auto; color: var(--el-primary);
                        }
                        .auth-title { font-size: 20px; font-weight: 600; color: #303133; margin-bottom: 6px; }
                        .auth-sub { font-size: 13px; color: var(--el-text-sub); }
                        .input-group { margin-bottom: 18px; }
                        .input-group label { display: block; font-size: 13px; font-weight: 500; color: #606266; margin-bottom: 6px; }
                        input {
                            width: 100%;
                            padding: 11px 14px;
                            background: #ffffff;
                            border: 1px solid var(--el-border);
                            border-radius: 6px;
                            color: #303133;
                            font-size: 14px;
                            outline: none;
                            transition: border-color 0.2s;
                        }
                        input:focus {
                            border-color: var(--el-primary);
                            box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
                        }
                        .btn-submit {
                            width: 100%;
                            padding: 12px;
                            background: var(--el-primary);
                            color: #ffffff;
                            border: none;
                            border-radius: 6px;
                            font-size: 14px;
                            font-weight: 500;
                            cursor: pointer;
                            margin-top: 6px;
                            transition: background 0.2s;
                        }
                        .btn-submit:hover { background: var(--el-primary-hover); }
                        .toggle-box { text-align: center; margin-top: 20px; font-size: 13px; color: var(--el-primary); cursor: pointer; }
                        .toggle-box:hover { text-decoration: underline; }
                        .error-banner {
                            display: none;
                            background: #fef0f0;
                            border: 1px solid #fde2e2;
                            color: #f56c6c;
                            padding: 10px 14px;
                            border-radius: 6px;
                            font-size: 13px;
                            margin-bottom: 18px;
                            text-align: center;
                        }
                        @media (max-width: 480px) {
                            .auth-card { padding: 26px 20px; }
                        }
                    </style>
                </head>
                <body>
                    <div class="auth-card">
                        <div class="auth-header">
                            <div class="logo-badge">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"></path></svg>
                            </div>
                            <h2 class="auth-title" id="formTitle">通行证登录</h2>
                            <div class="auth-sub" id="formDesc">登录以管理网络节点与专属订阅</div>
                        </div>

                        <div class="error-banner" id="errorBox"></div>

                        <div class="input-group">
                            <label>账号名称</label>
                            <input type="text" id="username" placeholder="请输入用户名" />
                        </div>
                        <div class="input-group">
                            <label>通行密码</label>
                            <input type="password" id="password" placeholder="请输入密码" />
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
                <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                <title>个人中心 · 节点控制面板</title>
                <style>
                    :root {
                        --el-bg: #f0f2f5;
                        --el-card: #ffffff;
                        --el-border: #dcdfe6;
                        --el-border-light: #ebeef5;
                        --el-text-main: #303133;
                        --el-text-regular: #606266;
                        --el-text-secondary: #909399;
                        --el-primary: #409eff;
                        --el-primary-hover: #66b1ff;
                        --el-primary-light: #ecf5ff;
                        --el-primary-border: #d9ecff;
                        --el-success: #67c23a;
                        --el-success-light: #f0f9eb;
                        --el-success-border: #e1f3d8;
                        --el-warning: #e6a23c;
                        --el-warning-light: #fdf6ec;
                        --el-warning-border: #faecd8;
                        --el-danger: #f56c6c;
                        --el-danger-light: #fef0f0;
                        --el-danger-border: #fde2e2;
                        --el-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.05);
                    }
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
                        background: var(--el-bg);
                        min-height: 100vh;
                        color: var(--el-text-main);
                        padding: 24px 16px;
                        -webkit-font-smoothing: antialiased;
                    }
                    .container { max-width: 680px; margin: 0 auto; }
                    
                    /* 顶栏卡片 */
                    .top-nav {
                        background: var(--el-card);
                        border: 1px solid var(--el-border);
                        border-radius: 8px;
                        padding: 16px 20px;
                        box-shadow: var(--el-shadow);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 16px;
                    }
                    .user-info { display: flex; align-items: center; gap: 12px; }
                    .user-avatar {
                        width: 42px; height: 42px; border-radius: 6px;
                        background: var(--el-primary-light);
                        border: 1px solid var(--el-primary-border);
                        color: var(--el-primary);
                        display: flex; align-items: center; justify-content: center;
                        font-size: 18px; font-weight: bold; flex-shrink: 0;
                    }
                    .user-meta h2 { font-size: 18px; font-weight: 600; color: var(--el-text-main); line-height: 1.2; }
                    .status-pill {
                        display: inline-flex; align-items: center; gap: 5px;
                        padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500;
                        margin-top: 4px;
                    }
                    .status-ok { background: var(--el-success-light); color: var(--el-success); border: 1px solid var(--el-success-border); }
                    .status-warn { background: var(--el-danger-light); color: var(--el-danger); border: 1px solid var(--el-danger-border); }
                    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
                    
                    .logout-btn {
                        color: var(--el-danger);
                        text-decoration: none;
                        font-size: 13px;
                        font-weight: 500;
                        padding: 6px 14px;
                        border-radius: 4px;
                        border: 1px solid var(--el-danger-border);
                        background: var(--el-danger-light);
                        transition: all 0.2s;
                        white-space: nowrap;
                    }
                    .logout-btn:hover { background: #fde2e2; }

                    /* 通用卡片容器 */
                    .dashboard-card {
                        background: var(--el-card);
                        border: 1px solid var(--el-border);
                        border-radius: 8px;
                        padding: 22px 24px;
                        margin-bottom: 16px;
                        box-shadow: var(--el-shadow);
                    }
                    .card-header-flex {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 12px;
                        font-size: 14px;
                        font-weight: 500;
                        color: var(--el-text-regular);
                    }
                    .card-header-flex .percent-num {
                        font-size: 18px;
                        font-weight: 700;
                        color: var(--el-primary);
                    }
                    
                    /* Element 风格线性进度条 */
                    .progress-track {
                        background: var(--el-border-light);
                        height: 10px;
                        border-radius: 100px;
                        overflow: hidden;
                        margin-bottom: 20px;
                    }
                    .progress-fill {
                        background: var(--el-primary);
                        height: 100%;
                        border-radius: 100px;
                        transition: width 0.4s ease;
                    }

                    /* 统计指标卡片网格 */
                    .grid-stats {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 12px;
                    }
                    .stat-subcard {
                        background: #fafafa;
                        border: 1px solid var(--el-border-light);
                        padding: 14px 16px;
                        border-radius: 6px;
                    }
                    .stat-subcard .title { font-size: 12px; color: var(--el-text-secondary); margin-bottom: 6px; }
                    .stat-subcard .value { font-size: 18px; font-weight: 700; color: var(--el-text-main); }
                    .stat-subcard .unit { font-size: 12px; color: var(--el-text-secondary); font-weight: normal; }

                    /* 订阅管理区域 */
                    .sub-section-title {
                        font-size: 15px;
                        font-weight: 600;
                        color: var(--el-text-main);
                        margin-bottom: 4px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .sub-section-desc { font-size: 12px; color: var(--el-text-secondary); margin-bottom: 16px; }
                    
                    .sub-item-block {
                        margin-bottom: 16px;
                        padding-bottom: 16px;
                        border-bottom: 1px solid var(--el-border-light);
                    }
                    .sub-item-block:last-child {
                        margin-bottom: 0;
                        padding-bottom: 0;
                        border-bottom: none;
                    }
                    .sub-item-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 8px;
                    }
                    .sub-item-title { font-size: 13px; font-weight: 600; color: var(--el-text-main); }
                    .sub-badge {
                        font-size: 11px;
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-weight: 500;
                    }
                    .badge-base { background: var(--el-primary-light); color: var(--el-primary); border: 1px solid var(--el-primary-border); }
                    .badge-clash { background: #f3e8ff; color: #9333ea; border: 1px solid #e9d5ff; }

                    .sub-input-row {
                        display: flex;
                        gap: 8px;
                        align-items: center;
                    }
                    .sub-input-row input {
                        flex: 1;
                        min-width: 0;
                        padding: 10px 12px;
                        background: #fafafa;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        color: var(--el-text-main);
                        font-family: Consolas, monospace;
                        font-size: 13px;
                        outline: none;
                        transition: border-color 0.2s;
                    }
                    .sub-input-row input:focus {
                        border-color: var(--el-primary);
                        background: #ffffff;
                    }
                    
                    .btn-action-primary {
                        padding: 9px 16px;
                        background: var(--el-primary);
                        border: 1px solid var(--el-primary);
                        border-radius: 4px;
                        color: #ffffff;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.2s;
                        white-space: nowrap;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                    }
                    .btn-action-primary:hover { background: var(--el-primary-hover); border-color: var(--el-primary-hover); }
                    
                    .btn-action-purple {
                        padding: 9px 14px;
                        background: #8e44ad;
                        border: 1px solid #8e44ad;
                        border-radius: 4px;
                        color: #ffffff;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.2s;
                        white-space: nowrap;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                    }
                    .btn-action-purple:hover { background: #9b59b6; border-color: #9b59b6; }

                    .btn-action-import {
                        padding: 9px 12px;
                        background: #faf5ff;
                        border: 1px solid #e9d5ff;
                        border-radius: 4px;
                        color: #8e44ad;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        text-decoration: none;
                        white-space: nowrap;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                    }
                    .btn-action-import:hover { background: #f3e8ff; }

                    /* 客户端支持说明卡片 */
                    .guide-card {
                        background: #fafafa;
                        border: 1px solid var(--el-border-light);
                        border-radius: 6px;
                        padding: 14px 16px;
                        font-size: 12px;
                        color: var(--el-text-secondary);
                        line-height: 1.6;
                    }
                    .guide-title { font-size: 13px; font-weight: 600; color: var(--el-text-regular); margin-bottom: 6px; }

                    /* 移动端手机界面深度优化 */
                    @media (max-width: 640px) {
                        body { padding: 12px 10px; }
                        .dashboard-card { padding: 16px 14px; }
                        .top-nav { padding: 12px 14px; }
                        .user-avatar { width: 36px; height: 36px; font-size: 16px; }
                        .user-meta h2 { font-size: 16px; }
                        .grid-stats { gap: 8px; }
                        .stat-subcard { padding: 10px 12px; }
                        .stat-subcard .value { font-size: 16px; }

                        .sub-input-row {
                            flex-direction: column;
                            align-items: stretch;
                            gap: 8px;
                        }
                        .sub-btn-group-mobile {
                            display: flex;
                            gap: 8px;
                            width: 100%;
                        }
                        .sub-btn-group-mobile button, .sub-btn-group-mobile a {
                            flex: 1;
                            padding: 10px 8px;
                            font-size: 13px;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <!-- 顶部导航 -->
                    <div class="top-nav">
                        <div class="user-info">
                            <div class="user-avatar">${currentUser.username.substring(0, 1).toUpperCase()}</div>
                            <div class="user-meta">
                                <h2>${currentUser.username}</h2>
                                <div class="status-pill ${invalidReason ? 'status-warn' : 'status-ok'}">
                                    <span class="status-dot"></span>${invalidReason ? invalidReason : '许可已激活'}
                                </div>
                            </div>
                        </div>
                        <a href="/logout" class="logout-btn">安全退出</a>
                    </div>

                    <!-- 配额监控卡片 -->
                    <div class="dashboard-card">
                        <div class="card-header-flex">
                            <span>独立流量配额消耗</span>
                            <span class="percent-num" id="percentText">${percentage}%</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" id="progressFill" style="width: ${percentage}%;"></div>
                        </div>
                        <div class="grid-stats">
                            <div class="stat-subcard">
                                <div class="title">已用 / 总限额</div>
                                <div class="value" id="trafficText">${formatBytes(currentUser.trafficUsed)} <span class="unit">/ ${formatBytes(currentUser.trafficLimit)}</span></div>
                            </div>
                            <div class="stat-subcard">
                                <div class="title">剩余有效时长</div>
                                <div class="value" id="daysText">${daysLeft} <span class="unit">天</span></div>
                            </div>
                        </div>
                    </div>

                    <!-- 订阅链接卡片 -->
                    <div class="dashboard-card">
                        <div class="sub-section-title">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" color="var(--el-primary)"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>
                            网络接入订阅中心
                        </div>
                        <div class="sub-section-desc">支持全协议直连、Argo 隧道接入与多节点异地集群下发</div>

                        <!-- 订阅 1: 通用 Base64 -->
                        <div class="sub-item-block">
                            <div class="sub-item-header">
                                <span class="sub-item-title">通用协议订阅</span>
                                <span class="sub-badge badge-base">v2rayN / Shadowrocket / Sing-box</span>
                            </div>
                            <div class="sub-input-row">
                                <input type="text" id="subUrl" readonly value="${baseSubUrl}" />
                                <div class="sub-btn-group-mobile">
                                    <button class="btn-action-primary" onclick="copyValue('subUrl')">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                        复制链接
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- 订阅 2: Clash Meta -->
                        <div class="sub-item-block">
                            <div class="sub-item-header">
                                <span class="sub-item-title">Clash Meta (Mihomo) 规则订阅</span>
                                <span class="sub-badge badge-clash">自动化分流规则 · 完整配置</span>
                            </div>
                            <div class="sub-input-row">
                                <input type="text" id="clashSubUrl" readonly value="${clashSubUrl}" style="color:#8e44ad;" />
                                <div class="sub-btn-group-mobile">
                                    <button class="btn-action-purple" onclick="copyValue('clashSubUrl')">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                        复制 Clash
                                    </button>
                                    <a class="btn-action-import" href="clash://install-config?url=${encodeURIComponent(clashSubUrl)}&name=${encodeURIComponent('Cluster-' + currentUser.username)}">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                        一键导入
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 客户端使用指南 -->
                    <div class="guide-card">
                        <div class="guide-title">使用说明与客户端建议：</div>
                        • <strong>Windows 用户</strong>：推荐使用 Clash Verge Rev、Mihomo Party 或 v2rayN，导入 Clash 订阅后开启系统代理。<br>
                        • <strong>Android 手机</strong>：推荐使用 Clash Meta for Android 或 sing-box，可直接点击“一键导入”按钮唤起应用。<br>
                        • <strong>iOS / macOS 用户</strong>：推荐使用 Shadowrocket (小火箭)、Loon、Surge 或 Clash Verge。<br>
                        • 如遇网络波动，客户端可自由切换“直连节点”或“Argo 隧道优化节点”。
                    </div>
                </div>

                <script>
                    function showToast(msg) {
                        let el = document.getElementById("__el_toast__");
                        if (!el) {
                            el = document.createElement("div");
                            el.id = "__el_toast__";
                            el.style.position = "fixed";
                            el.style.top = "24px";
                            el.style.left = "50%";
                            el.style.transform = "translateX(-50%) translateY(-20px)";
                            el.style.background = "#f0f9eb";
                            el.style.border = "1px solid #e1f3d8";
                            el.style.color = "#67c23a";
                            el.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.08)";
                            el.style.padding = "10px 20px";
                            el.style.borderRadius = "4px";
                            el.style.fontSize = "13px";
                            el.style.fontWeight = "500";
                            el.style.zIndex = "99999";
                            el.style.transition = "opacity 0.25s ease, transform 0.25s ease";
                            el.style.display = "flex";
                            el.style.alignItems = "center";
                            el.style.gap = "8px";
                            el.style.pointerEvents = "none";
                            el.style.opacity = "0";
                            document.body.appendChild(el);
                        }
                        el.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>' + msg;
                        el.style.opacity = "1";
                        el.style.transform = "translateX(-50%) translateY(0)";
                        clearTimeout(el.__timer);
                        el.__timer = setTimeout(() => {
                            el.style.opacity = "0";
                            el.style.transform = "translateX(-50%) translateY(-20px)";
                        }, 2200);
                    }

                    function copyValue(id) {
                        const input = document.getElementById(id);
                        if (!input || !input.value) return;
                        const val = input.value;
                        if (navigator.clipboard && window.isSecureContext) {
                            navigator.clipboard.writeText(val).then(() => {
                                showToast("订阅链接已复制到剪贴板！");
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
                        ta.setAttribute("readonly", "");
                        ta.style.position = "fixed";
                        ta.style.left = "-9999px";
                        ta.style.fontSize = "16px";
                        document.body.appendChild(ta);
                        ta.select();
                        ta.setSelectionRange(0, val.length);
                        let ok = false;
                        try {
                            ok = document.execCommand("copy");
                        } catch (e) {}
                        document.body.removeChild(ta);
                        if (ok) {
                            showToast("订阅链接已复制到剪贴板！");
                        } else {
                            prompt("自动复制受限，请长按或手动复制链接：", val);
                        }
                    }

                    setInterval(async () => {
                        try {
                            const res = await fetch("/api/my-stats");
                            if (res.ok) {
                                const data = await res.json();
                                document.getElementById("percentText").innerText = data.percentage + "%";
                                document.getElementById("progressFill").style.width = data.percentage + "%";
                                document.getElementById("trafficText").innerHTML = data.usedFormatted + ' <span class="unit">/ ' + data.totalFormatted + '</span>';
                                document.getElementById("daysText").innerHTML = data.daysLeft + ' <span class="unit">天</span>';
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
