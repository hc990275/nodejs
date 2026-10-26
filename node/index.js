const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { exec, execSync, spawn } = require("child_process");
const crypto = require("crypto");

// ==================== 1. 原生零依赖 .ENV 解析与毫秒级热重载引擎 ====================
const WORK_DIR = __dirname;
const ENV_FILE = path.join(WORK_DIR, ".env");

let detectedServerIp = "";

// 原生轻量级 .env 解析器 (零外部依赖，极速无内存负担)
function parseEnvContent(content) {
    const result = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        result[key] = val;
    }
    return result;
}

function loadEnvFile(isInitial = false) {
    if (fs.existsSync(ENV_FILE)) {
        try {
            const raw = fs.readFileSync(ENV_FILE, "utf8");
            const parsed = parseEnvContent(raw);
            for (const [k, v] of Object.entries(parsed)) {
                // 若 .env 中该项值为空，且宿主机环境变量中已存在非空值，绝不能用空值冲掉宿主机的注入！
                if (v === "" && process.env[k]) {
                    continue;
                }
                process.env[k] = v;
            }
            if (!isInitial) {
                console.log("[Env] .env 变更已毫秒级热重载生效");
            }
        } catch (e) {
            console.error("[Env] 解析 .env 文件异常:", e.message);
        }
    } else if (isInitial) {
        console.warn("[Env] 未找到 .env 文件，将依赖卡塔/翼龙容器注入的环境变量");
    }
}

// 首次同步载入 .env
loadEnvFile(true);

// 智能探测翼龙面板 (Pterodactyl) 多 Allocations 附加端口
function detectPterodactylAdditionalPorts(mainPort) {
    const detectedPorts = new Set();

    // 1. 扫描列表型端口环境变量 (如 ADDITIONAL_PORTS="25566,25567")
    const listKeys = ["ADDITIONAL_PORTS", "EXTRA_PORTS", "ALLOCATIONS", "ADDITIONAL_ALLOCATIONS"];
    for (const key of listKeys) {
        if (process.env[key]) {
            process.env[key].split(/[,;\s]+/).forEach((p) => {
                const num = parseInt(p.trim(), 10);
                if (num > 0 && num <= 65535 && num !== mainPort) {
                    detectedPorts.add(num);
                }
            });
        }
    }

    // 2. 扫描翼龙标准附加端口命名规则 (SERVER_PORT_2, PORT_2, ALLOCATION_PORT_2 等)
    for (const [key, val] of Object.entries(process.env)) {
        if (!val || typeof val !== "string") continue;
        const upper = key.toUpperCase();
        if (
            upper.match(/^(?:SERVER_PORT|PORT|ALLOC|ALLOCATION)_?[2-9]$/) ||
            upper.match(/^(?:SERVER_PORT|PORT|ALLOCATION)_[A-Z0-9_]+$/)
        ) {
            const num = parseInt(val.trim(), 10);
            if (num > 0 && num <= 65535 && num !== mainPort) {
                detectedPorts.add(num);
            }
        }
    }

    return Array.from(detectedPorts).sort((a, b) => a - b);
}

// 深度感知卡塔/翼龙容器分配的外网主端口 (大小写不敏感 + /proc/1/environ PID 1 穿透)
function resolvePterodactylMainPort() {
    // 1. 显式配置的 SERVER_PORT 或 PORT (.env 或当前环境变量)
    const rawEnv = (process.env.SERVER_PORT || process.env.PORT || "").trim();
    if (rawEnv && parseInt(rawEnv, 10) > 0) {
        return { port: parseInt(rawEnv, 10), source: ".env / 环境变量显式配置" };
    }

    // 2. 大小写不敏感深度扫描当前 process.env
    const portKeysRegex = /^(?:SERVER_PORT|SERVERPORT|PORT|ALLOCATION_PORT|P_SERVER_PORT|ALLOCATION|APP_PORT|NODE_PORT|CONTAINER_PORT|SERVICE_PORT|WEB_PORT|LISTENING_PORT|KATABUMP_PORT)$/i;
    for (const [key, val] of Object.entries(process.env)) {
        if (!val || typeof val !== "string") continue;
        if (key.match(portKeysRegex)) {
            const p = parseInt(val.trim(), 10);
            if (p > 0 && p <= 65535) {
                return { port: p, source: `环境变量 (${key})` };
            }
        }
    }

    // 3. Docker 容器特权穿透：读取 /proc/1/environ 与 /proc/self/environ (卡塔 PID 1 初始环境变量)
    const procPaths = ["/proc/1/environ", "/proc/self/environ"];
    for (const procPath of procPaths) {
        try {
            if (fs.existsSync(procPath)) {
                const raw = fs.readFileSync(procPath, "utf8");
                const entries = raw.split("\u0000");
                for (const entry of entries) {
                    const eqIdx = entry.indexOf("=");
                    if (eqIdx > -1) {
                        const k = entry.slice(0, eqIdx).trim();
                        const v = entry.slice(eqIdx + 1).trim();
                        if (k.match(portKeysRegex)) {
                            const p = parseInt(v, 10);
                            if (p > 0 && p <= 65535) {
                                return { port: p, source: `${procPath} (${k})` };
                            }
                        }
                    }
                }
            }
        } catch (e) { }
    }

    // 4. 检查命令行启动参数 (例如 node index.js 25565 或 --port=25565)
    for (let i = 2; i < process.argv.length; i++) {
        const arg = (process.argv[i] || "").trim();
        const p = parseInt(arg, 10);
        if (p >= 1024 && p <= 65535) {
            return { port: p, source: `命令行参数 (${arg})` };
        }
        if (arg.startsWith("--port=") || arg.startsWith("-p=")) {
            const p2 = parseInt(arg.split("=")[1], 10);
            if (p2 >= 1024 && p2 <= 65535) {
                return { port: p2, source: `命令行参数 (${arg})` };
            }
        }
    }

    // 5. 模糊扫描环境变量与底层容器环境中所有带 PORT 的有效端口
    for (const [key, val] of Object.entries(process.env)) {
        if (!val || typeof val !== "string") continue;
        const upper = key.toUpperCase();
        if (upper.includes("PORT") && !upper.includes("PATH") && !upper.includes("SUPPORT")) {
            const p = parseInt(val.trim(), 10);
            if (p >= 1024 && p <= 65535 && p !== 8001 && p !== 10011 && p !== 10012 && p !== 10013 && p !== 10014) {
                return { port: p, source: `模糊匹配系统变量 (${key})` };
            }
        }
    }

    // 6. 从 /proc/1/environ 模糊扫描任何带 PORT 的变量
    try {
        if (fs.existsSync("/proc/1/environ")) {
            const raw = fs.readFileSync("/proc/1/environ", "utf8");
            const entries = raw.split("\u0000");
            for (const entry of entries) {
                const eqIdx = entry.indexOf("=");
                if (eqIdx > -1) {
                    const k = entry.slice(0, eqIdx).trim().toUpperCase();
                    const v = entry.slice(eqIdx + 1).trim();
                    if (k.includes("PORT") && !k.includes("PATH") && !k.includes("SUPPORT")) {
                        const p = parseInt(v, 10);
                        if (p >= 1024 && p <= 65535 && p !== 8001 && p !== 10011 && p !== 10012 && p !== 10013 && p !== 10014) {
                            return { port: p, source: `/proc/1/environ 模糊探测 (${k})` };
                        }
                    }
                }
            }
        }
    } catch (e) { }

    return null;
}

// 全局缓存客户端访问时从 Host 请求头中智能嗅探到的外网随机端口
let detectedExternalPort = null;

// 动态环境配置管理对象 (毫秒级响应，属性实时获取)
const appConfig = {
    // 严格动态主端口读取：绝不假装监听固定假端口导致 521 报错，未配置时安全返回 null 挂起等待
    get port() {
        const resolved = resolvePterodactylMainPort();
        return resolved ? resolved.port : null;
    },
    get portSource() {
        const resolved = resolvePterodactylMainPort();
        return resolved ? resolved.source : "未检测到外网端口 (等待配置)";
    },
    get isPortDetected() {
        return resolvePterodactylMainPort() !== null;
    },
    // 自动感知翼龙面板附加 Allocations 端口列表
    get detectedExtraPorts() {
        return detectPterodactylAdditionalPorts(this.port);
    },
    get serverIp() {
        return (process.env.SERVER_IP || "").trim();
    },
    get serverDomain() {
        return (process.env.SERVER_DOMAIN || process.env.DOMAIN || "").trim();
    },
    get adminToken() {
        return (process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || process.env.ADMIN_PWD || process.env.PASSWORD || process.env.TOKEN || "").trim();
    },
    get argoToken() {
        return (process.env.ARGO_TOKEN || "").trim();
    },
    get argoDomain() {
        return (process.env.ARGO_DOMAIN || "").trim();
    },
    get optimizedDomain() {
        return (process.env.OPTIMIZED_DOMAIN || "").trim();
    },
    get extraNodes() {
        if (!process.env.EXTRA_NODES || process.env.EXTRA_NODES.trim() === "") return [];
        try {
            return JSON.parse(process.env.EXTRA_NODES);
        } catch (e) {
            console.warn("[Cluster] 外部集群节点配置解析异常:", e.message);
            return [];
        }
    },
    get isTunnelAvailable() {
        const token = (this.argoToken || "").trim();
        const domain = (this.argoDomain || "").trim();
        if (!token || !domain) return false;
        if (domain.includes("example.com") || domain.includes("yourdomain.com")) return false;
        return true;
    },
    // 智能 UDP QUIC 模式：
    // 1. 若显式指定 UDP_QUIC_PROTOCOL 为 tuic 则单开 tuic；若显式指定 hy2-only 则强制仅开 hy2；
    // 2. 若存在独立 TUIC_PORT 或翼龙面板注入了附加 Allocations 端口，全自动无缝激活 "both" 双开模式；
    // 3. 否则单端口环境下默认启用 hy2 (抗丢包单边加速体验最优)
    get udpQuicMode() {
        const proto = (process.env.UDP_QUIC_PROTOCOL || process.env.QUIC_PROTOCOL || "").trim().toLowerCase();
        if (proto === "tuic") return "tuic";
        if (proto === "hy2-only") return "hy2";
        // 自动探测：一旦有独立的附加端口，全自动升级为双 QUIC 极速通道
        if (this.tuicPort && this.tuicPort !== this.port) {
            return "both";
        }
        return "hy2";
    },
    get tuicPort() {
        if (process.env.TUIC_PORT) {
            return parseInt(process.env.TUIC_PORT, 10);
        }
        // 自动探测翼龙多 Allocations 附加端口
        const extraPorts = this.detectedExtraPorts;
        if (extraPorts.length > 0) {
            return extraPorts[0];
        }
        return this.port;
    },
    get realityDest() {
        return (process.env.REALITY_DEST || "www.apple.com:443").trim();
    },
    get realitySni() {
        return (process.env.REALITY_SNI || "www.apple.com").trim();
    }
};

// 启动时静默并发探测本机外网公网 IP (备选容灾)
function autoDetectPublicIp() {
    const probeUrls = [
        "http://api.ipify.org",
        "http://icanhazip.com",
        "http://ifconfig.me/ip"
    ];
    let resolved = false;
    probeUrls.forEach((url) => {
        try {
            const req = http.get(url, { timeout: 3500 }, (res) => {
                let data = "";
                res.on("data", (c) => { data += c; });
                res.on("end", () => {
                    const ip = data.trim();
                    if (!resolved && ip && net.isIP(ip)) {
                        resolved = true;
                        detectedServerIp = ip;
                        console.log(`[Network] 智能感知到宿主机公网 IP: ${detectedServerIp}`);
                    }
                });
            });
            req.on("error", () => { });
            req.on("timeout", () => req.destroy());
        } catch (e) { }
    });
}
autoDetectPublicIp();

// 提取请求中的反向代理 / CDN 域名 (智能感知 Cloudflare CDN / 端口回溯 / X-Forwarded-Host)
function extractRequestHost(req) {
    if (!req || !req.headers) return null;
    // 1. 优先提取 X-Forwarded-Host (Cloudflare CDN / Nginx 反向代理真实访问域名)
    const fwdHost = (req.headers["x-forwarded-host"] || "").trim();
    if (fwdHost) {
        const first = fwdHost.split(",")[0].trim();
        const colonIdx = first.indexOf(":");
        const h = colonIdx > -1 ? first.slice(0, colonIdx) : first;
        if (h && h !== "127.0.0.1" && h !== "localhost") return h;
    }
    // 2. 提取 req.headers.host
    const rawHost = (req.headers.host || "").trim();
    if (rawHost) {
        const colonIdx = rawHost.indexOf(":");
        const h = colonIdx > -1 ? rawHost.slice(0, colonIdx) : rawHost;
        if (h && h !== "127.0.0.1" && h !== "localhost") return h;
    }
    return null;
}

// 动态解析客户端有效 Host/域名 (智能感知 Cloudflare CDN / 端口回溯 / 真实域名)
function getEffectiveHost(req = null) {
    // 1. 如果在 .env 中显式指定了自定义域名 (SERVER_DOMAIN / DOMAIN)，最高优先级
    if (appConfig.serverDomain) {
        return appConfig.serverDomain;
    }
    // 2. 检查当前请求是否带有合法域名 (通过 Cloudflare / 端口回溯访问时自动捕获)
    const reqHost = extractRequestHost(req);
    if (reqHost && /[a-zA-Z]/.test(reqHost)) {
        return reqHost;
    }
    // 3. 如果在 .env 中显式指定了固定的 SERVER_IP
    if (appConfig.serverIp) {
        return appConfig.serverIp;
    }
    // 4. 如果请求带有纯 IP Host
    if (reqHost) {
        return reqHost;
    }
    // 5. 使用自动探测到的公网 IP 或 127.0.0.1
    return detectedServerIp || "127.0.0.1";
}

// 动态解析客户端协议 (HTTP / HTTPS 智能感知，兼容 Cloudflare / 反向代理)
function getEffectiveProto(req = null) {
    if (req && req.headers) {
        if (req.headers["x-forwarded-proto"]) {
            return req.headers["x-forwarded-proto"].split(",")[0].trim().toLowerCase();
        }
        if (req.headers["cf-visitor"]) {
            try {
                const visitor = JSON.parse(req.headers["cf-visitor"]);
                if (visitor.scheme) return visitor.scheme.toLowerCase();
            } catch (e) { }
        }
    }
    return "http";
}

// 获取对外下发的标准基础订阅 URL (自动感知域名/反代/CF端口回溯/HTTPS/端口自适应)
function getEffectiveSubBaseUrl(req, uuid) {
    if (appConfig.isTunnelAvailable) {
        return `https://${appConfig.argoDomain}/sub?token=${uuid}`;
    }
    const host = getEffectiveHost(req);
    const proto = getEffectiveProto(req);
    const isDomain = /[a-zA-Z]/.test(host);

    // 如果通过 HTTPS 访问或主机名为域名 (例如 Cloudflare 端口回溯反代，前端标准走 443 或 80)
    if (proto === "https" || isDomain) {
        let externalPort = null;
        if (req && req.headers) {
            const raw = (req.headers["x-forwarded-host"] || req.headers.host || "").trim();
            const parts = raw.split(":");
            if (parts.length > 1 && parts[1]) {
                const p = parseInt(parts[1], 10);
                if (p && p !== 80 && p !== 443) {
                    externalPort = p;
                }
            }
        }
        if (externalPort) {
            return `${proto}://${host}:${externalPort}/sub?token=${uuid}`;
        }
        return `${proto}://${host}/sub?token=${uuid}`;
    }

    // 纯 IP 物理直连访问：拼接物理外网端口
    const port = getEffectivePort(req);
    return `http://${host}:${port}/sub?token=${uuid}`;
}

// 动态解析客户端有效外网端口（Host 智能嗅探 + .env 覆盖 + 容器感知）
function getEffectivePort(req = null) {
    // 1. 如果在 .env 或环境变量中指定了真实物理外网端口，优先使用
    const rawEnvPort = (process.env.SERVER_PORT || process.env.PORT || "").trim();
    if (rawEnvPort && parseInt(rawEnvPort, 10) > 0) {
        return parseInt(rawEnvPort, 10);
    }
    // 2. 核心黑科技：客户端访问后台或拉取订阅时，自动从 Host 请求头嗅探捕获外网物理端口！
    if (req && req.headers && req.headers.host) {
        const parts = req.headers.host.trim().split(":");
        if (parts.length > 1) {
            const p = parseInt(parts[1], 10);
            if (p > 0 && p <= 65535) {
                if (detectedExternalPort !== p) {
                    detectedExternalPort = p;
                    console.log(`[Pterodactyl] 🎯 从客户端请求 Host 智能捕获到真实外网物理端口: ${detectedExternalPort}`);
                }
                return p;
            }
        }
    }
    // 3. 使用先前已探测缓存到的外网端口
    if (detectedExternalPort) {
        return detectedExternalPort;
    }
    // 4. 采用容器自身监听的端口
    return appConfig.port;
}

// 安全状态自检与 Fail-Closed 熔断审查
function checkSecurityStatus() {
    if (!appConfig.adminToken) {
        console.warn("================================================================================");
        console.warn("⚠️  [Security][Fail-Closed 熔断] 警报：未在 .env 中配置 ADMIN_TOKEN！");
        console.warn("🛡️  后台管理入口已实施安全熔断锁定，拒绝任何登录请求。");
        console.warn("👉  请在 .env 文件中设置 ADMIN_TOKEN=你的强密码，保存后将毫秒级热重载自动解锁。");
        console.warn("================================================================================");
    } else {
        console.log("[Security] ADMIN_TOKEN 管理口令已就绪，后台管理通道已开放。");
    }
}

// 毫秒级原生无感热重载监听引擎
let envWatchDebounce = null;
if (fs.existsSync(ENV_FILE)) {
    try {
        fs.watch(ENV_FILE, (eventType) => {
            if (eventType === "change" || eventType === "rename") {
                if (envWatchDebounce) clearTimeout(envWatchDebounce);
                envWatchDebounce = setTimeout(() => {
                    loadEnvFile(false);
                    checkSecurityStatus();
                    syncCloudflaredOnEnvChange();
                    if (typeof startOrUpdateGateway === "function") {
                        startOrUpdateGateway();
                    }
                }, 100);
            }
        });
    } catch (e) {
        console.warn("[Env] 监听 .env 文件失败:", e.message);
    }
}

const PORT_TUNNEL = 8001;
const INTERNAL_VMESS_PORT = 10011;
const INTERNAL_VLESS_PORT = 10012;
const INTERNAL_TROJAN_PORT = 10013;
const INTERNAL_REALITY_PORT = 10014;

const USERS_FILE = path.join(WORK_DIR, "users.json");
const CONFIG_FILE = path.join(WORK_DIR, "config.json");
const SINGBOX_BIN = path.join(WORK_DIR, "sing-box");
const CLOUDFLARED_BIN = path.join(WORK_DIR, "cloudflared");

const CERT_FILE = path.join(WORK_DIR, "cert.pem");
const KEY_FILE = path.join(WORK_DIR, "key.pem");
const REALITY_KEYS_FILE = path.join(WORK_DIR, "reality.json");

// 确保 Hysteria 2 / TUIC 自签名 TLS 证书就绪
function ensureCertificates() {
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
        return;
    }
    try {
        const cmd = `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${KEY_FILE}" -out "${CERT_FILE}" -days 3650 -subj "/CN=bing.com"`;
        execSync(cmd, { stdio: "ignore" });
        return;
    } catch (e) { }

    const fallbackCert = `-----BEGIN CERTIFICATE-----\nMIIDBzCCAe+gAwIBAgIUE7V9+2zHzZmCcWMbxczDvemXKFEwDQYJKoZIhvcNAQEL\nBQAwEzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjYxMDE5MTEyMDQ0WhcNMzYxMDE2\nMTEyMDQ0WjATMREwDwYDVQQDDAhiaW5nLmNvbTCCASIwDQYJKoZIhvcNAQEBBQAD\nggEPADCCAQoCggEBALEH45ZEMc0GIqin96Q6D14u3mvXJhccDzRzcOGLkxwwR7zI\nUwUE/vqQFrIqvwp8f3Y/F5u/5VGKS1mtcdUI14SSk7538YUv9ECD+kTSZn5HVbV+\nN/pb951Xi+cSJnp7mhHMgkV2QThbDAmonXwEpkh7kp+kHXmR/aWTocKbFoUzhe0N\nJRebH1eRrdjjPWyDwz1m/F2jXnm3jxFZn1hn8Ck7KvId2w5rFJ7UQSLlYHZOri17\n037NxtQzxSzgHwtA7hwUJfoZcpSXrHyLnzuWU8Hcpn/kjG3JsO97itP48+dLi+Rl\nMPsp56Nm6R5yI1dKHFmLhAXjWBpAKtGj2NU1RY0CAwEAAaNTMFEwHQYDVR0OBBYE\nFGSjXSgI2uI2MCcg3FSKiKqkDrKjMB8GA1UdIwQYMBaAFGSjXSgI2uI2MCcg3FSK\niKqkDrKjMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAJbLa5PK\nNqzA67VCxLa4vYOl5Fwb4f5nOVRxQmTwbfIT/5Rl1hSi19Z6JZYaxrlX/FRcyfog\n12tHwrbzC6pOpxxlfsxQjlLLm9osH9ZA2GdUQCY4wor9tDTHDxhZtVKBoRv1hczy\nO8MK5FmVmo+6/kzSQQPhOTNQsGB7yREIw90wXPsxX74sXkKqvD7x+DGNhA4uvf7m\nIIOjjPkMDfpPj0AhnVJJnkqn5xwWuN0i8K06yAd4z7nRmt5WXd34NXMiHkyO9fFp\nJyXiAxjflBTvwBGdfRYtpz1J4x8clvybWCseiGGiDng9seRN/mVQqKu7WDtEs6ul\nibTl21Ef9ykBDDw=\n-----END CERTIFICATE-----\n`;

    const fallbackKey = `-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCxB+OWRDHNBiKo\np/ekOg9eLt5r1yYXHA80c3Dhi5McMEe8yFMFBP76kBayKr8KfH92Pxebv+VRiktZ\nrXHVCNeEkpO+d/GFL/RAg/pE0mZ+R1W1fjf6W/edV4vnEiZ6e5oRzIJFdkE4WwwJ\nqJ18BKZIe5KfpB15kf2lk6HCmxaFM4XtDSUXmx9Xka3Y4z1sg8M9Zvxdo155t48R\nWZ9YZ/ApOyryHdsOaxSe1EEi5WB2Tq4te9N+zcbUM8Us4B8LQO4cFCX6GXKUl6x8\ni587llPB3KZ/5IxtybDve4rT+PPnS4vkZTD7KeejZukeciNXShxZi4QF41gaQCrR\no9jVNUWNAgMBAAECggEACSjuVrUampAptO5T+vRiHS5xpcTRHLr/8mfSvGjbaMb6\nv0LiQM08YDyaYAekMOe2NKkZEJ8CP5DXS0GVNT+q3xoyeNV98rVDfx8VEQCN+xS3\n05c/UD339vUzsPYYdZf1pdweFXgD8eWMHufRljwrWm7CbG4ydDrgk/OqmAYsSSIG\nRfz8wH8Xc+kKTBpu0N7F4/5U7+ZJWOpaQrY2Sz2DIZOLizOw/UOD6flwoK5f9Mcd\n//CyI2pISoLYjyLC4YpxnFL5BgvOCaeqOdxSa9SynH5Yl1K2SC+sxYwtvNH62IMY\nXDom26UQ0hBwI1xTsIXyGqDc6y2K2hbXkYS3c8ecgQKBgQDiu2ktUDxNelJgFIEG\nJr0n30hr7TnqRB4iE8YUE0agKlDJB+yflinAyDYlBfoOt2/JwapOZsI9weiHdo0m\nNYTJFtRQGlmKiAMbbhKG7ty+t4v/Xz5GYW13EcRIheo8nj9xTmYErdCfj2o+OdlJ\n9TNmfPkJZClWum+QzM6OKpnooQKBgQDH4gzZPiJaW2+ar0QGQQz8Pnh7ldcNcmUF\nB87ObO4Ze4FJLAFazZnLAZ9ZBwaZmrQanxoQS+CtUvtc99QkEfRgTQAETSdAV6TO\ni1/IfbYmzf+kNU/c5JQE7ZLGHhCNk1Z5m8Vp66pTsb/0g8dZgfmFuobjHL82UscK\nLPl0moWZbQKBgGDnTHqLclqCzzY1TTe90tZ5vdAy4a/YUTCrVts5qdPGgiSJeH50\nhX/ZkhqcxVUI3YRTe2Bq1tXiTGmpJ4aPFSOE2FUsDd0BaKKOluiIqlvwwqrwoAMg\nnNJpC4UbhxNFZ0QcB8o0J5gqiXPy8YWEgOVqwF1dK7XflNNEVXu5hXJBAoGAAxbu\nZek89LKXHgf5gDM/NSLuD9L4GQAcqaA+RRiP8ZrkG7JvbuzgpK+ou+KM6pDmmca9\ny2Sw21z9/6jhAZG5ekeWaXqb0bXJGVw0JdAzoZPrkKk2S87Iru7RJvjN/rI5UvXi\nbkmzP0nvEqN60Fpe9f81GIuYNQnAg9rAHFpLGF0CgYAflF5MjxiVhLkW59ap4VTh\nsacuARkPDRvud0SOgxVcO3dDv1wxwaeJeaM/8XaccJkwuJHZax1xdgu43M4ksw0a\nYimtCtx+saww9awnR5Vjda54p/nAcY1oFf3ouksOhwEHnlTyvFHa9E5SLbbO3V0O\nPa6ehK2A+bsTZfUHQ09beg==\n-----END PRIVATE KEY-----\n`;

    try {
        fs.writeFileSync(CERT_FILE, fallbackCert, "utf8");
        fs.writeFileSync(KEY_FILE, fallbackKey, "utf8");
    } catch (e) { }
}

// 确保 VLESS-Reality 的 x25519 密钥对持久化就绪
let realityKeysCache = null;
function ensureRealityKeys() {
    if (realityKeysCache) return realityKeysCache;
    if (fs.existsSync(REALITY_KEYS_FILE)) {
        try {
            realityKeysCache = JSON.parse(fs.readFileSync(REALITY_KEYS_FILE, "utf8"));
            if (realityKeysCache.privateKey && realityKeysCache.publicKey && realityKeysCache.shortId) {
                return realityKeysCache;
            }
        } catch (e) { }
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
    const privRaw = privateKey.export({ type: "pkcs8", format: "der" }).slice(-32);
    const pubRaw = publicKey.export({ type: "spki", format: "der" }).slice(-32);
    const shortId = crypto.randomBytes(8).toString("hex");

    realityKeysCache = {
        privateKey: privRaw.toString("base64url"),
        publicKey: pubRaw.toString("base64url"),
        shortId: shortId
    };
    try {
        fs.writeFileSync(REALITY_KEYS_FILE, JSON.stringify(realityKeysCache, null, 2), "utf8");
    } catch (e) { }
    return realityKeysCache;
}

const GLOBAL_SALT = "_system_unified_salt_2026_pro";

let singboxProcess = null;
let isReloading = false;
let cloudflaredProcess = null;

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

// 全站动态控制配置（控制开放注册开关、新注册用户初始配额与 IP 防刷限额）
const SETTINGS_FILE = path.join(WORK_DIR, "settings.json");
const IP_REGISTER_LOG_FILE = path.join(WORK_DIR, "ip_registers.json");

let siteSettings = {
    allowRegistration: true,
    initialTrafficLimitVal: 15,
    initialTrafficLimitUnit: "GB",
    initialDays: 30,
    ipRegisterLimit: 1, // 24小时内同一 IP 最多允许注册账号数，0 为不限制
    // 📶 微测网 (Wetest.vip) 三网优选 API
    enableOptWetest: true,
    wetestApiCountCT: 6,
    wetestApiCountCU: 8,
    wetestApiCountCM: 8,
    wetestNodes: { ct: [], cu: [], cm: [] },
    wetestSyncTime: "未同步",
    // ⚡ CM佬三网优选 API (cf.090227.xyz)
    enableOptCMApi: true,
    cmApiCountCT: 8,
    cmApiCountCU: 8,
    cmApiCountCM: 8,
    cmNodes: { ct: [], cu: [], cm: [] },
    cmApiSyncTime: "未同步",
    // 🚀 批量自定义优选域名池
    enableCustomDomains: false,
    customDomainsText: ""
};

let ipRegisterMap = {};

function loadIpRegisterLogs() {
    if (fs.existsSync(IP_REGISTER_LOG_FILE)) {
        try {
            const raw = fs.readFileSync(IP_REGISTER_LOG_FILE, "utf8").trim();
            if (raw.length > 0) {
                ipRegisterMap = JSON.parse(raw);
                return;
            }
        } catch (e) { }
    }
    ipRegisterMap = {};
}

function saveIpRegisterLogs() {
    safeWriteFileAsync(IP_REGISTER_LOG_FILE, JSON.stringify(ipRegisterMap, null, 2));
}

function getClientIp(req) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (cfIp) return String(cfIp).trim();
    const xForwarded = req.headers["x-forwarded-for"];
    if (xForwarded) {
        const parts = String(xForwarded).split(",");
        if (parts.length > 0 && parts[0].trim()) return parts[0].trim();
    }
    const realIp = req.headers["x-real-ip"];
    if (realIp) return String(realIp).trim();
    let addr = req.socket ? (req.socket.remoteAddress || "127.0.0.1") : "127.0.0.1";
    if (addr.startsWith("::ffff:")) addr = addr.slice(7);
    return addr;
}

function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const raw = fs.readFileSync(SETTINGS_FILE, "utf8").trim();
            if (raw.length > 0) {
                const parsed = JSON.parse(raw);
                siteSettings = Object.assign({
                    allowRegistration: true,
                    initialTrafficLimitVal: 15,
                    initialTrafficLimitUnit: "GB",
                    initialDays: 30,
                    ipRegisterLimit: 1,
                    // 📶 微测网 (Wetest.vip)
                    enableOptWetest: true,
                    wetestApiCountCT: 6,
                    wetestApiCountCU: 8,
                    wetestApiCountCM: 8,
                    wetestNodes: { ct: [], cu: [], cm: [] },
                    wetestSyncTime: "未同步",
                    // ⚡ CM佬 (cf.090227.xyz)
                    enableOptCMApi: true,
                    cmApiCountCT: 8,
                    cmApiCountCU: 8,
                    cmApiCountCM: 8,
                    cmNodes: { ct: [], cu: [], cm: [] },
                    cmApiSyncTime: "未同步",
                    enableCustomDomains: false,
                    customDomainsText: ""
                }, parsed);
                if (!siteSettings.wetestNodes) siteSettings.wetestNodes = { ct: [], cu: [], cm: [] };
                if (!siteSettings.cmNodes) siteSettings.cmNodes = { ct: [], cu: [], cm: [] };
                console.log(`[Settings] 系统配置载入成功 (开放注册: ${siteSettings.allowRegistration ? "开启" : "关闭"}, 微测API: ${siteSettings.enableOptWetest ? "开启" : "关闭"}, CM优选API: ${siteSettings.enableOptCMApi ? "开启" : "关闭"}, 微测节点数:${(siteSettings.wetestNodes.ct || []).length + (siteSettings.wetestNodes.cu || []).length + (siteSettings.wetestNodes.cm || []).length}, CM节点数:${(siteSettings.cmNodes.ct || []).length + (siteSettings.cmNodes.cu || []).length + (siteSettings.cmNodes.cm || []).length})`);
                return;
            }
        } catch (err) {
            console.error("[Settings] 配置文件读取异常:", err.message);
        }
    }
    saveSettings();
}

function saveSettings() {
    safeWriteFileAsync(SETTINGS_FILE, JSON.stringify(siteSettings, null, 2));
}

// ==========================================
// 🚀 CM佬三网优选 (cf.090227.xyz) 异步拉取引擎
// ==========================================
function parseCmApiLines(text) {
    if (!text || typeof text !== "string") return [];
    return text.split(/\r?\n/).map(line => {
        let trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;
        let hostPart = trimmed;
        const hashIdx = trimmed.indexOf("#");
        if (hashIdx !== -1) {
            hostPart = trimmed.substring(0, hashIdx).trim();
        }
        if (!hostPart) return null;
        let ip = hostPart;
        let port = 443;
        const colonIdx = hostPart.lastIndexOf(":");
        if (colonIdx !== -1 && !hostPart.endsWith("]")) {
            const p = parseInt(hostPart.substring(colonIdx + 1), 10);
            if (!isNaN(p) && p > 0 && p <= 65535) {
                port = p;
                ip = hostPart.substring(0, colonIdx).trim();
            }
        }
        if (!ip || !/^[\d\.]+$/.test(ip)) return null;
        return { ip, port };
    }).filter(Boolean);
}

// 解析批量自定义优选域名池行
function parseCustomDomainLine(line) {
    if (!line || typeof line !== "string") return null;
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

    let remark = "";
    const hashIdx = trimmed.indexOf("#");
    if (hashIdx !== -1) {
        remark = trimmed.substring(hashIdx + 1).trim();
        trimmed = trimmed.substring(0, hashIdx).trim();
    }
    if (!trimmed) return null;

    let host = trimmed;
    let port = 443;
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx !== -1 && !trimmed.endsWith("]")) {
        const p = parseInt(trimmed.substring(colonIdx + 1), 10);
        if (!isNaN(p) && p > 0 && p <= 65535) {
            port = p;
            host = trimmed.substring(0, colonIdx).trim();
        }
    }
    if (!host) return null;
    if (!remark) remark = (port !== 443) ? `${host}:${port}` : host;
    return { host, port, remark };
}

let isFetchingCm = false;
let lastCmFetchTime = 0;

async function fetchCmApiIps(force = false) {
    const now = Date.now();
    if (isFetchingCm) {
        console.log("[CMApi] ⏳ 已有任务正在拉取中，复用现有请求，杜绝并发轰炸 CPU");
        return { success: true, settings: siteSettings };
    }
    // 3 分钟防抖冷却 (除非 force=true 强制刷新)
    if (!force && lastCmFetchTime > 0 && (now - lastCmFetchTime < 180000)) {
        console.log("[CMApi] ⚡ 距离上次拉取未满 3 分钟，直接复用内存优选池，保护系统 CPU");
        return { success: true, settings: siteSettings };
    }
    isFetchingCm = true;
    lastCmFetchTime = now;
    console.log("[CMApi] 开始从 cf.090227.xyz 动态拉取三网优选 IP...");
    const ctCount = Math.max(1, parseInt(siteSettings.cmApiCountCT, 10) || 6);
    const cuCount = Math.max(1, parseInt(siteSettings.cmApiCountCU, 10) || 8);
    const cmCount = Math.max(1, parseInt(siteSettings.cmApiCountCM, 10) || 8);

    const ctUrl = `https://cf.090227.xyz/ct?ips=${ctCount}`;
    const cuUrl = `https://cf.090227.xyz/cu?ips=${cuCount}`;
    const cmUrl = `https://cf.090227.xyz/cmcc?ips=${cmCount}`;

    try {
        const fetchText = (urlStr) => new Promise((resolve, reject) => {
            const req = https.get(urlStr, { timeout: 10000, headers: { "User-Agent": "curl/7.88.1" } }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => resolve(data));
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
            req.on("error", err => reject(err));
        });

        const [ctText, cuText, cmText] = await Promise.allSettled([
            fetchText(ctUrl),
            fetchText(cuUrl),
            fetchText(cmUrl)
        ]);

        let updated = false;
        if (!siteSettings.cmNodes) siteSettings.cmNodes = { ct: [], cu: [], cm: [] };

        if (ctText.status === "fulfilled") {
            const list = parseCmApiLines(ctText.value);
            if (list.length > 0) {
                siteSettings.cmNodes.ct = list;
                updated = true;
            }
        }
        if (cuText.status === "fulfilled") {
            const list = parseCmApiLines(cuText.value);
            if (list.length > 0) {
                siteSettings.cmNodes.cu = list;
                updated = true;
            }
        }
        if (cmText.status === "fulfilled") {
            const list = parseCmApiLines(cmText.value);
            if (list.length > 0) {
                siteSettings.cmNodes.cm = list;
                updated = true;
            }
        }

        if (updated) {
            siteSettings.cmApiSyncTime = new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
            saveSettings();
            console.log(`[CMApi] ✅ CM佬三网 IP 抓取成功！CT:${siteSettings.cmNodes.ct.length}, CU:${siteSettings.cmNodes.cu.length}, CM:${siteSettings.cmNodes.cm.length}`);
            return { success: true, settings: siteSettings };
        } else {
            throw new Error("未能获取到有效的三网优选 IP 列表");
        }
    } catch (e) {
        console.error("[CMApi] ❌ 抓取失败:", e.message);
        return { success: false, error: e.message };
    } finally {
        isFetchingCm = false;
    }
}

// ==========================================
// 📶 微测网 (Wetest.vip) 异步抓取引擎 (仅 CF)
// ==========================================
function fetchJsonUrl(reqUrl, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(reqUrl);
            const client = parsed.protocol === "https:" ? https : http;
            const req = client.get(reqUrl, { timeout: timeoutMs, headers: { "User-Agent": "curl/7.88.1" } }, (res) => {
                let data = "";
                res.on("data", chunk => data += chunk);
                res.on("end", () => {
                    try {
                        const parsedJson = JSON.parse(data);
                        resolve(parsedJson);
                    } catch (e) {
                        reject(new Error(`JSON 解析失败: ${e.message}`));
                    }
                });
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("请求超时")); });
            req.on("error", err => reject(err));
        } catch (e) {
            reject(e);
        }
    });
}

function normalizeWetestItemList(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(item => {
        let ip = "", colo = "", rtt = 0;
        if (typeof item === "string") {
            ip = item.trim();
        } else if (item && typeof item === "object") {
            ip = (item.ip || item.node || "").trim();
            colo = (item.colo || item.datacenter || item.city || "").toUpperCase();
            rtt = parseInt(item.rtt_avg || item.rtt || item.ping || item.latency || 0, 10);
        }
        return { ip, colo, rtt };
    }).filter(x => x.ip && /^[\d\.]+$/.test(x.ip));
}

let isFetchingWetest = false;
let lastWetestFetchTime = 0;

async function fetchWetestCleanIps(force = false) {
    const now = Date.now();
    if (isFetchingWetest) {
        console.log("[Wetest] ⏳ 已有任务正在拉取中，复用现有请求，杜绝并发轰炸 CPU");
        return { success: true, settings: siteSettings };
    }
    // 3 分钟防抖冷却 (除非 force=true 强制刷新)
    if (!force && lastWetestFetchTime > 0 && (now - lastWetestFetchTime < 180000)) {
        console.log("[Wetest] ⚡ 距离上次拉取未满 3 分钟，直接复用内存优选池，保护系统 CPU");
        return { success: true, settings: siteSettings };
    }
    isFetchingWetest = true;
    lastWetestFetchTime = now;
    console.log("[Wetest] 开始从微测网全量动态拉取三网 Cloudflare 优选 IP...");
    const cfUrl = "https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4";
    try {
        const cfRes = await fetchJsonUrl(cfUrl, 10000);
        if (cfRes && (cfRes.code === 200 || cfRes.status === "success" || cfRes.info)) {
            const rawData = cfRes.data || cfRes.info || {};
            const cleanCT = normalizeWetestItemList(rawData.CT || rawData.ct || rawData.dx || rawData.telecom);
            const cleanCU = normalizeWetestItemList(rawData.CU || rawData.cu || rawData.lt || rawData.unicom);
            const cleanCM = normalizeWetestItemList(rawData.CM || rawData.cm || rawData.yd || rawData.mobile);

            const sortByRtt = (list) => list.sort((a, b) => (a.rtt || 999) - (b.rtt || 999));

            if (!siteSettings.wetestNodes) siteSettings.wetestNodes = { ct: [], cu: [], cm: [] };
            if (cleanCT.length > 0) siteSettings.wetestNodes.ct = sortByRtt(cleanCT);
            if (cleanCU.length > 0) siteSettings.wetestNodes.cu = sortByRtt(cleanCU);
            if (cleanCM.length > 0) siteSettings.wetestNodes.cm = sortByRtt(cleanCM);

            siteSettings.wetestSyncTime = new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
            saveSettings();
            console.log(`[Wetest] ✅ 微测网三网 IP 抓取成功！CT:${siteSettings.wetestNodes.ct.length}, CU:${siteSettings.wetestNodes.cu.length}, CM:${siteSettings.wetestNodes.cm.length}`);
            return { success: true, settings: siteSettings };
        } else {
            throw new Error(cfRes ? (cfRes.msg || cfRes.message || "API 结构异常") : "返回为空");
        }
    } catch (e) {
        console.error("[Wetest] ❌ 抓取失败:", e.message);
        return { success: false, error: e.message };
    } finally {
        isFetchingWetest = false;
    }
}

// 启动 3 秒后全自动静默执行微测网与 CM 佬首轮优选 IP 同步，免手动点击
setTimeout(() => {
    if (siteSettings.enableOptWetest !== false) {
        const hasWetest = siteSettings.wetestNodes &&
            ((siteSettings.wetestNodes.ct && siteSettings.wetestNodes.ct.length > 0) ||
                (siteSettings.wetestNodes.cu && siteSettings.wetestNodes.cu.length > 0) ||
                (siteSettings.wetestNodes.cm && siteSettings.wetestNodes.cm.length > 0));
        console.log(`[Wetest] 🚀 服务启动完成，正在检查微测网优选池状态 (已有缓存: ${hasWetest ? "是" : "否"})...`);
        fetchWetestCleanIps(!hasWetest);
    }
}, 3000);

setTimeout(() => {
    if (siteSettings.enableOptCMApi !== false) {
        const hasNodes = siteSettings.cmNodes &&
            ((siteSettings.cmNodes.ct && siteSettings.cmNodes.ct.length > 0) ||
                (siteSettings.cmNodes.cu && siteSettings.cmNodes.cu.length > 0) ||
                (siteSettings.cmNodes.cm && siteSettings.cmNodes.cm.length > 0));
        // 若本地已有缓存，不强制刷，平滑度过启动期；若无缓存则立即拉取
        console.log(`[CMApi] 🚀 服务启动完成，正在检查三网优选池状态 (已有缓存: ${hasNodes ? "是" : "否"})...`);
        fetchCmApiIps(!hasNodes);
    }
}, 6000);

// 每 30 分钟后台静默自动轮询更新优选池
setInterval(() => {
    if (siteSettings.enableOptWetest !== false) {
        fetchWetestCleanIps(true);
    }
    if (siteSettings.enableOptCMApi !== false) {
        fetchCmApiIps(true);
    }
}, 30 * 60 * 1000);

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

    // 确保证书与 Reality 密钥准备完毕
    ensureCertificates();
    const realityKeys = ensureRealityKeys();
    const realityServer = appConfig.realityDest.split(":")[0];
    const realityPort = parseInt(appConfig.realityDest.split(":")[1] || "443", 10);

    const config = {
        log: {
            level: "warn",
            timestamp: true
        },
        dns: {
            servers: [
                {
                    tag: "dns-direct",
                    address: "tcp://1.1.1.1",
                    detour: "direct"
                },
                {
                    tag: "dns-backup",
                    address: "tcp://8.8.8.8",
                    detour: "direct"
                }
            ],
            strategy: "prefer_ipv4"
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
            },
            {
                type: "vless",
                tag: "reality-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_REALITY_PORT,
                users: activeUsers.map((u) => ({ uuid: u.uuid, flow: "xtls-rprx-vision" })),
                tls: {
                    enabled: true,
                    server_name: appConfig.realitySni,
                    reality: {
                        enabled: true,
                        handshake: {
                            server: realityServer,
                            server_port: realityPort
                        },
                        private_key: realityKeys.privateKey,
                        short_id: [realityKeys.shortId]
                    }
                }
            }
        ],
        outbounds: [
            {
                type: "direct",
                tag: "direct"
            },
            {
                type: "dns",
                tag: "dns-out"
            }
        ]
    };

    // 单端口智能分配 UDP QUIC 协议 (卡塔容器仅分配一个端口)
    const quicMode = appConfig.udpQuicMode;
    if (quicMode === "hy2" || quicMode === "both") {
        config.inbounds.push({
            type: "hysteria2",
            tag: "hy2-in",
            listen: "0.0.0.0",
            listen_port: appConfig.port, // 与主端口同一个端口 (UDP)
            up_mbps: 2000,
            down_mbps: 2000,
            ignore_client_bandwidth: false,
            users: activeUsers.map((u) => ({ name: u.uuid, password: u.uuid })),
            tls: {
                enabled: true,
                certificate_path: CERT_FILE,
                key_path: KEY_FILE
            }
        });
    }

    if (quicMode === "tuic" || quicMode === "both") {
        const tuicListenPort = quicMode === "tuic" ? appConfig.port : appConfig.tuicPort;
        config.inbounds.push({
            type: "tuic",
            tag: "tuic-in",
            listen: "0.0.0.0",
            listen_port: tuicListenPort, // 单端口下同样复用分配的外网端口
            users: activeUsers.map((u) => ({ name: u.uuid, uuid: u.uuid, password: u.uuid })),
            congestion_control: "bbr",
            tls: {
                enabled: true,
                certificate_path: CERT_FILE,
                key_path: KEY_FILE,
                alpn: ["h3"]
            }
        });
    }

    // 动态提取全部已启用的 inbound tags，确保 route rule 包含明确合法匹配条件并支持 final 兜底
    const allInboundTags = config.inbounds.map((ib) => ib.tag).filter(Boolean);
    config.route = {
        rules: [
            {
                protocol: "dns",
                outbound: "dns-out"
            },
            {
                inbound: allInboundTags,
                outbound: "direct"
            }
        ],
        final: "direct"
    };

    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    } catch (e) {
        safeWriteFileAsync(CONFIG_FILE, JSON.stringify(config, null, 2));
    }
}

function killPortOccupants() {
    try {
        const ports = [INTERNAL_VMESS_PORT, INTERNAL_VLESS_PORT, INTERNAL_TROJAN_PORT, INTERNAL_REALITY_PORT];
        if (process.platform === "win32") {
            // Windows 环境下查杀端口兼容
            ports.forEach((port) => {
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
                } catch (e) { }
            });
        } else {
            const portList = ports.map((p) => `${p}/tcp`).join(" ");
            execSync(`fuser -k -9 ${portList} 2>/dev/null || true`);
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
    generateSingboxConfig();
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
        try { fs.chmodSync(SINGBOX_BIN, "755"); } catch (e) { }
        safeReloadSingbox();
    }
}

function initAndStartCloudflared() {
    if (!appConfig.isTunnelAvailable) return;
    const start = () => {
        if (!appConfig.isTunnelAvailable) return;
        cloudflaredProcess = spawn(CLOUDFLARED_BIN, ["tunnel", "--no-autoupdate", "run", "--token", appConfig.argoToken], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });
        cloudflaredProcess.on("exit", () => {
            cloudflaredProcess = null;
            if (appConfig.isTunnelAvailable) setTimeout(start, 5000);
        });
    };

    if (!fs.existsSync(CLOUDFLARED_BIN)) {
        const archMap = { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm" };
        const binName = archMap[process.arch] || "cloudflared-linux-amd64";
        const downloadCmd = `curl -sSL -o "${CLOUDFLARED_BIN}" "https://github.com/cloudflare/cloudflared/releases/latest/download/${binName}" && chmod +x "${CLOUDFLARED_BIN}"`;
        exec(downloadCmd, start);
    } else {
        try { fs.chmodSync(CLOUDFLARED_BIN, "755"); } catch (e) { }
        start();
    }
}

function syncCloudflaredOnEnvChange() {
    if (appConfig.isTunnelAvailable) {
        if (!cloudflaredProcess) {
            console.log("[Tunnel] 检测到 Argo 隧道凭据已配置，正在热拉起 cloudflared...");
            initAndStartCloudflared();
        }
    } else {
        if (cloudflaredProcess) {
            console.log("[Tunnel] Argo 隧道凭据已清空，正在停止 cloudflared 进程...");
            try { cloudflaredProcess.kill("SIGTERM"); } catch (e) { }
            cloudflaredProcess = null;
        }
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

// 验证管理后台专属认证 (Cookie 隔离优先，兼容 Query Token / Pwd)
function checkAdminAuth(req, query) {
    if (!appConfig.adminToken) {
        return false; // Fail-Closed: 未在 .env 配置口令时直接熔断拒绝
    }
    const cookieHeader = req.headers.cookie || "";
    const match = cookieHeader.match(/admin_session_token=([a-zA-Z0-9]+)/);
    if (match) {
        const expire = adminSessions.get(match[1]);
        if (expire && expire > Date.now()) {
            return true;
        }
        if (expire) adminSessions.delete(match[1]);
    }
    // 兼容历史 URL ?token=... 或 ?pwd=... 或 ?password=...
    if (query) {
        const qToken = query.get("token") || query.get("pwd") || query.get("password");
        if (qToken && qToken === appConfig.adminToken) {
            return true;
        }
    }
    return false;
}

// 生成结构化节点池 (支持多节点集群与异地节点，自适应当前请求 Host 与端口)
function getStructuredNodesForUser(user, req = null) {
    const uuid = user.uuid;
    const nameSuffix = `-${user.username}`;
    const vlessPath = `/vless/${uuid}`;
    const vmessPath = `/vmess/${uuid}`;
    const trojanPath = `/trojan/${uuid}`;

    const host = getEffectiveHost(req);
    const directIp = appConfig.serverIp || detectedServerIp || "127.0.0.1";
    const port = getEffectivePort(req);
    const isDomain = /[a-zA-Z]/.test(host);

    const nodes = [];

    // 0. 自定义域名 / Cloudflare 端口回溯 CDN 加速节点 (走标准 443 端口，TLS 加密，小黄云免封锁)
    if (isDomain) {
        const cdnDomain = host;
        const optAddress = appConfig.optimizedDomain || cdnDomain;

        nodes.push({
            name: `CF回溯-VLESS${nameSuffix}`,
            type: "vless",
            server: optAddress,
            port: 443,
            uuid: uuid,
            tls: true,
            sni: cdnDomain,
            network: "ws",
            wsPath: vlessPath,
            wsHeaders: { Host: cdnDomain }
        });

        nodes.push({
            name: `CF回溯-VMess${nameSuffix}`,
            type: "vmess",
            server: optAddress,
            port: 443,
            uuid: uuid,
            alterId: 0,
            cipher: "auto",
            tls: true,
            sni: cdnDomain,
            network: "ws",
            wsPath: vmessPath,
            wsHeaders: { Host: cdnDomain }
        });

        nodes.push({
            name: `CF回溯-Trojan${nameSuffix}`,
            type: "trojan",
            server: optAddress,
            port: 443,
            password: uuid,
            tls: true,
            sni: cdnDomain,
            network: "ws",
            wsPath: trojanPath,
            wsHeaders: { Host: cdnDomain }
        });

        // 📶 微测网 (Wetest.vip) 三网优选动态节点下发 (电信 / 联通 / 移动)
        if (siteSettings.enableOptWetest !== false && siteSettings.wetestNodes) {
            const wtCtLimit = Math.max(1, parseInt(siteSettings.wetestApiCountCT, 10) || 6);
            const wtCuLimit = Math.max(1, parseInt(siteSettings.wetestApiCountCU, 10) || 8);
            const wtCmLimit = Math.max(1, parseInt(siteSettings.wetestApiCountCM, 10) || 8);

            (siteSettings.wetestNodes.ct || []).slice(0, wtCtLimit).forEach((n, idx) => {
                const colo = n.colo ? `·${n.colo}` : "";
                const rtt = n.rtt ? `·${n.rtt}ms` : "";
                nodes.push({
                    name: `【微测·电信优选${idx + 1}${colo}${rtt}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
            (siteSettings.wetestNodes.cu || []).slice(0, wtCuLimit).forEach((n, idx) => {
                const colo = n.colo ? `·${n.colo}` : "";
                const rtt = n.rtt ? `·${n.rtt}ms` : "";
                nodes.push({
                    name: `【微测·联通优选${idx + 1}${colo}${rtt}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
            (siteSettings.wetestNodes.cm || []).slice(0, wtCmLimit).forEach((n, idx) => {
                const colo = n.colo ? `·${n.colo}` : "";
                const rtt = n.rtt ? `·${n.rtt}ms` : "";
                nodes.push({
                    name: `【微测·移动优选${idx + 1}${colo}${rtt}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
        }

        // 🚀 CM佬三网优选 (cf.090227.xyz) 动态节点下发 (电信 / 联通 / 移动)
        if (siteSettings.enableOptCMApi !== false && siteSettings.cmNodes) {
            (siteSettings.cmNodes.ct || []).forEach((n, idx) => {
                nodes.push({
                    name: `【电信优选${idx + 1}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: n.port || 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
            (siteSettings.cmNodes.cu || []).forEach((n, idx) => {
                nodes.push({
                    name: `【联通优选${idx + 1}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: n.port || 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
            (siteSettings.cmNodes.cm || []).forEach((n, idx) => {
                nodes.push({
                    name: `【移动优选${idx + 1}】-VLESS-WS${nameSuffix}`,
                    type: "vless",
                    server: n.ip,
                    port: n.port || 443,
                    uuid: uuid,
                    tls: true,
                    sni: cdnDomain,
                    network: "ws",
                    wsPath: vlessPath,
                    wsHeaders: { Host: cdnDomain }
                });
            });
        }

        // 🚀 批量自定义优选域名池节点下发
        if (siteSettings.enableCustomDomains && siteSettings.customDomainsText) {
            const lines = siteSettings.customDomainsText.split(/\r?\n/);
            lines.forEach((line) => {
                const item = parseCustomDomainLine(line);
                if (item) {
                    nodes.push({
                        name: `【优选·${item.remark}】-VLESS-WS${nameSuffix}`,
                        type: "vless",
                        server: item.host,
                        port: item.port || 443,
                        uuid: uuid,
                        tls: true,
                        sni: cdnDomain,
                        network: "ws",
                        wsPath: vlessPath,
                        wsHeaders: { Host: cdnDomain }
                    });
                }
            });
        }
    }

    // 1. 物理直连节点 (走真实宿主机 IP + 物理端口，确保 Hysteria 2 / TUIC / Reality / 直连 WS 畅通)
    nodes.push({
        name: `直连-VLESS${nameSuffix}`,
        type: "vless",
        server: directIp,
        port: port,
        uuid: uuid,
        tls: false,
        network: "ws",
        wsPath: vlessPath,
        wsHeaders: { Host: directIp }
    });

    nodes.push({
        name: `直连-VMess${nameSuffix}`,
        type: "vmess",
        server: directIp,
        port: port,
        uuid: uuid,
        alterId: 0,
        cipher: "auto",
        tls: false,
        network: "ws",
        wsPath: vmessPath,
        wsHeaders: { Host: directIp }
    });

    nodes.push({
        name: `直连-Trojan${nameSuffix}`,
        type: "trojan",
        server: directIp,
        port: port,
        password: uuid,
        tls: false,
        network: "ws",
        wsPath: trojanPath,
        wsHeaders: { Host: directIp }
    });

    // 直连-Reality (首字节 0x16 TCP 嗅探穿透)
    const realityKeys = ensureRealityKeys();
    nodes.push({
        name: `直连-Reality${nameSuffix}`,
        type: "vless-reality",
        server: directIp,
        port: port,
        uuid: uuid,
        flow: "xtls-rprx-vision",
        tls: true,
        reality: true,
        sni: appConfig.realitySni,
        pbk: realityKeys.publicKey,
        sid: realityKeys.shortId,
        network: "tcp"
    });

    // 5. 根据单端口 UDP 策略下发可用的 QUIC 节点 (走 directIp 杜绝 Cloudflare UDP 丢包)
    const quicMode = appConfig.udpQuicMode;
    if (quicMode === "hy2" || quicMode === "both") {
        nodes.push({
            name: `直连-Hysteria2${nameSuffix}`,
            type: "hysteria2",
            server: directIp,
            port: port, // 单端口下复用分配的主端口 (UDP)
            password: uuid,
            sni: "bing.com",
            insecure: true
        });
    }

    if (quicMode === "tuic" || quicMode === "both") {
        const tuicNodePort = quicMode === "tuic" ? port : appConfig.tuicPort;
        nodes.push({
            name: `直连-TUIC${nameSuffix}`,
            type: "tuic",
            server: directIp,
            port: tuicNodePort, // 单端口下复用分配的主端口 (UDP)
            uuid: uuid,
            password: uuid,
            congestion_control: "bbr",
            sni: "bing.com",
            insecure: true
        });
    }

    // 2. Argo 优选穿透节点
    if (appConfig.isTunnelAvailable) {
        const optAddress = appConfig.optimizedDomain || appConfig.argoDomain;
        nodes.push({
            name: `优选-VLESS${nameSuffix}`,
            type: "vless",
            server: optAddress,
            port: 443,
            uuid: uuid,
            tls: true,
            sni: appConfig.argoDomain,
            network: "ws",
            wsPath: vlessPath,
            wsHeaders: { Host: appConfig.argoDomain }
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
            sni: appConfig.argoDomain,
            network: "ws",
            wsPath: vmessPath,
            wsHeaders: { Host: appConfig.argoDomain }
        });

        nodes.push({
            name: `优选-Trojan${nameSuffix}`,
            type: "trojan",
            server: optAddress,
            port: 443,
            password: uuid,
            tls: true,
            sni: appConfig.argoDomain,
            network: "ws",
            wsPath: trojanPath,
            wsHeaders: { Host: appConfig.argoDomain }
        });
    }

    // 3. 动态扩展集群节点 (从 EXTRA_NODES 配置注入)
    const extraNodesConfig = appConfig.extraNodes;
    if (Array.isArray(extraNodesConfig) && extraNodesConfig.length > 0) {
        extraNodesConfig.forEach((ext, idx) => {
            const extName = `${ext.name || `集群节点-${idx + 1}`}${nameSuffix}`;
            const extType = String(ext.type || "vless").toLowerCase();
            const extServer = ext.server || ext.address || host;
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
function getNodesForUser(user, req = null) {
    const rawNodes = getStructuredNodesForUser(user, req);
    const linkList = [];

    for (const n of rawNodes) {
        if (n.type === "vless") {
            const tlsStr = n.tls ? "security=tls&" : "security=none&";
            const sniStr = n.sni ? `sni=${n.sni}&` : "";
            const hostStr = n.wsHeaders && n.wsHeaders.Host ? `host=${n.wsHeaders.Host}&` : "";
            const encPath = encodeURIComponent(n.wsPath);
            linkList.push(`vless://${n.uuid}@${n.server}:${n.port}?type=ws&${tlsStr}${sniStr}${hostStr}path=${encPath}#${n.name}`);
        } else if (n.type === "vless-reality") {
            const encName = encodeURIComponent(n.name);
            linkList.push(`vless://${n.uuid}@${n.server}:${n.port}?security=reality&encryption=none&pbk=${n.pbk}&headerType=none&fp=chrome&type=tcp&flow=xtls-rprx-vision&sni=${n.sni}&sid=${n.sid}#${encName}`);
        } else if (n.type === "vmess") {
            const vmessObj = {
                v: "2",
                ps: n.name,
                add: n.server,
                port: parseInt(n.port, 10),
                id: n.uuid,
                aid: 0,
                scy: "auto",
                net: "ws",
                type: "none",
                host: (n.wsHeaders && n.wsHeaders.Host) || n.server,
                path: n.wsPath,
                tls: n.tls ? "tls" : "",
                sni: n.sni || "",
                alpn: "",
                fp: "chrome"
            };
            linkList.push("vmess://" + Buffer.from(JSON.stringify(vmessObj)).toString("base64"));
        } else if (n.type === "trojan") {
            const tlsStr = n.tls ? "security=tls&" : "security=none&";
            const sniStr = n.sni ? `sni=${n.sni}&` : "";
            const hostStr = n.wsHeaders && n.wsHeaders.Host ? `host=${n.wsHeaders.Host}&` : "";
            const encPath = encodeURIComponent(n.wsPath);
            linkList.push(`trojan://${n.password}@${n.server}:${n.port}?${tlsStr}${sniStr}${hostStr}type=ws&path=${encPath}#${n.name}`);
        } else if (n.type === "hysteria2") {
            const encName = encodeURIComponent(n.name);
            linkList.push(`hysteria2://${n.password}@${n.server}:${n.port}/?upmbps=2000&downmbps=2000&insecure=1&allowInsecure=1&sni=${n.sni}#${encName}`);
        } else if (n.type === "tuic") {
            const encName = encodeURIComponent(n.name);
            linkList.push(`tuic://${n.uuid}:${n.password}@${n.server}:${n.port}/?congestion_control=${n.congestion_control}&sni=${n.sni}&alpn=h3&allow_insecure=1&insecure=1#${encName}`);
        }
    }

    return Buffer.from(linkList.join("\n")).toString("base64");
}

// 自动生成符合 Clash Meta (Mihomo) 规范的标准 YAML 配置 (含三网分流策略组与权威 DoH)
function generateClashConfig(user, req = null) {
    const nodes = getStructuredNodesForUser(user, req);

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
        } else if (n.type === "vless-reality") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: vless\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    flow: xtls-rprx-vision\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: true\n`;
            proxiesYaml += `    servername: ${n.sni}\n`;
            proxiesYaml += `    client-fingerprint: chrome\n`;
            proxiesYaml += `    reality-opts:\n`;
            proxiesYaml += `      public-key: ${n.pbk}\n`;
            proxiesYaml += `      short-id: ${n.sid}\n`;
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
        } else if (n.type === "hysteria2") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: hysteria2\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    password: "${n.password}"\n`;
            proxiesYaml += `    up: "2000 Mbps"\n`;
            proxiesYaml += `    down: "2000 Mbps"\n`;
            proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    skip-cert-verify: true\n`;
            proxiesYaml += `    udp: true\n`;
        } else if (n.type === "tuic") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: tuic\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    password: ${n.password}\n`;
            proxiesYaml += `    congestion-controller: bbr\n`;
            proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    alpn:\n`;
            proxiesYaml += `      - h3\n`;
            proxiesYaml += `    skip-cert-verify: true\n`;
            proxiesYaml += `    reduce-rtt: true\n`;
        }
    }

    const ctNames = proxyNames.filter(name => name.includes("电信"));
    const cuNames = proxyNames.filter(name => name.includes("联通"));
    const cmNames = proxyNames.filter(name => name.includes("移动"));
    const directNames = proxyNames.filter(name => name.includes("直连"));
    const quotedAll = proxyNames.map(n => `"${n}"`);

    let groupsYaml = `  - name: "🚀 节点选择"
    type: select
    proxies:
      - "⚡ 自动优选"
      - "🇨🇳 电信优选"
      - "🇨🇳 联通优选"
      - "🇨🇳 移动优选"
      - "🌐 直连优选"
      - DIRECT
      ${quotedAll.map(n => "- " + n).join("\n      ")}

  - name: "⚡ 自动优选"
    type: url-test
    url: http://cp.cloudflare.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
      ${quotedAll.map(n => "- " + n).join("\n      ")}

  - name: "🇨🇳 电信优选"
    type: select
    proxies:
      ${(ctNames.length > 0 ? ctNames.map(n => `"${n}"`) : quotedAll).map(n => "- " + n).join("\n      ")}

  - name: "🇨🇳 联通优选"
    type: select
    proxies:
      ${(cuNames.length > 0 ? cuNames.map(n => `"${n}"`) : quotedAll).map(n => "- " + n).join("\n      ")}

  - name: "🇨🇳 移动优选"
    type: select
    proxies:
      ${(cmNames.length > 0 ? cmNames.map(n => `"${n}"`) : quotedAll).map(n => "- " + n).join("\n      ")}

  - name: "🌐 直连优选"
    type: select
    proxies:
      ${(directNames.length > 0 ? directNames.map(n => `"${n}"`) : quotedAll).map(n => "- " + n).join("\n      ")}

  - name: "🐟 漏网之鱼"
    type: select
    proxies:
      - "🚀 节点选择"
      - "⚡ 自动优选"
      - DIRECT`;

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
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  fallback:
    - https://1.1.1.1/dns-query
    - https://8.8.8.8/dns-query
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4

proxies:
${proxiesYaml}

proxy-groups:
${groupsYaml}

rules:
  - GEOIP,LAN,DIRECT,no-resolve
  - GEOIP,CN,DIRECT,no-resolve
  - MATCH,🐟 漏网之鱼
`;
}

// ==================== 5. HTTP 业务层与前端 ====================
function handleHttpRequest(req, res) {
    const hostHeader = req.headers.host || "127.0.0.1";
    const parsedUrl = new URL(req.url, `http://${hostHeader}`);
    let pathname = parsedUrl.pathname;
    // 严格规范化路径：兼容末尾斜杠 (如 /admin/ 或 /admin/login/ 自动规范化，彻底根除 404 故障)
    if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
    }
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
            return res.end(generateClashConfig(user, req));
        }

        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Subscription-Userinfo": subUserInfo
        });
        return res.end(getNodesForUser(user, req));
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

    // 3. 用户注册 API (受 siteSettings 注册开关与初始配额动态控制)
    if (pathname === "/api/register" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            try {
                // 1. 严格检查是否开启新用户自主注册
                if (!siteSettings.allowRegistration) {
                    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "系统已暂停开放新用户注册，请联系管理员！" }));
                }

                // 2. IP 注册防刷与速率限制 (Rate Limiting)
                const clientIp = getClientIp(req);
                const maxPerIp = (siteSettings.ipRegisterLimit !== undefined) ? parseInt(siteSettings.ipRegisterLimit, 10) : 1;
                if (maxPerIp > 0) {
                    const oneDayAgo = Date.now() - 24 * 3600 * 1000;
                    const recentTimestamps = (ipRegisterMap[clientIp] || []).filter((ts) => ts > oneDayAgo);
                    ipRegisterMap[clientIp] = recentTimestamps;

                    if (recentTimestamps.length >= maxPerIp) {
                        res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({
                            error: `当前 IP (${clientIp}) 24小时内注册数已达上限 (${maxPerIp}个账号)，请勿频繁注册！`
                        }));
                    }
                }

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

                // 3. 动态读取全站配置中的初始流量配额与有效天数
                const initialLimitBytes = convertToBytes(siteSettings.initialTrafficLimitVal || 15, siteSettings.initialTrafficLimitUnit || "GB");
                const initDays = parseInt(siteSettings.initialDays, 10);
                const expireTime = (initDays && initDays > 0) ? (Date.now() + initDays * 86400000) : 0;

                const newUser = {
                    uuid: crypto.randomUUID(),
                    username: cleanUser,
                    passwordHash: hashPassword(cleanPwd),
                    trafficLimit: initialLimitBytes,
                    trafficUsed: 0,
                    expireTime: expireTime,
                    enabled: true,
                    createdAt: Date.now()
                };

                usersDatabase.push(newUser);
                saveUsers();

                if (!ipRegisterMap[clientIp]) ipRegisterMap[clientIp] = [];
                ipRegisterMap[clientIp].push(Date.now());
                saveIpRegisterLogs();

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
                    const hint = (cleanUser.toLowerCase() === "admin" || (appConfig.adminToken && cleanPwd === appConfig.adminToken))
                        ? "密码输入有误。💡 若您是系统管理员，请点击右上角【管理后台】或访问 /admin"
                        : "密码输入有误，请核对后重试";
                    return res.end(JSON.stringify({ error: hint }));
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
            // 如果已登录管理会话或 URL 携带口令，直接重定向进入 /admin
            if (checkAdminAuth(req, query)) {
                const qToken = query.get("token") || query.get("pwd") || query.get("password");
                const target = qToken ? `/admin?token=${encodeURIComponent(qToken)}` : "/admin";
                res.writeHead(302, { Location: target });
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
                        ${!appConfig.adminToken ? `
                        <div style="background:#fef0f0; border:1px solid #fde2e2; color:#f56c6c; padding:12px 14px; border-radius:6px; font-size:12px; line-height:1.6; margin-bottom:18px; text-align:left;">
                            <strong style="font-size:13px;">🛡️ 系统安全熔断中：</strong><br>
                            未在 <code>.env</code> 文件中配置 <code>ADMIN_TOKEN</code>。<br>
                            后台已自动安全锁定。请在 <code>.env</code> 中配置口令并保存，系统将毫秒级热重载自动解锁。
                        </div>` : ''}
                        <div class="error-msg" id="errMsg"></div>
                        <div class="input-box">
                            <label>管理安全口令</label>
                            <input type="password" id="adminToken" placeholder="请输入 ADMIN_TOKEN" autofocus ${!appConfig.adminToken ? 'disabled' : ''} />
                        </div>
                        <button class="btn-login" id="loginBtn" onclick="doAdminLogin()" ${!appConfig.adminToken ? 'disabled style="background:#c0c4cc; cursor:not-allowed;"' : ''}>验证登录</button>
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
                    if (!appConfig.adminToken) {
                        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({ error: "后台已被安全熔断锁定：未在 .env 中配置 ADMIN_TOKEN 管理口令！" }));
                    }

                    const { token } = JSON.parse(body || "{}");
                    if (token !== appConfig.adminToken) {
                        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({ error: "安全密钥未通过核验" }));
                    }

                    const adminSessionToken = crypto.randomBytes(24).toString("hex");
                    const expireTime = Date.now() + 24 * 3600 * 1000;
                    adminSessions.set(adminSessionToken, expireTime);

                    res.writeHead(200, {
                        "Content-Type": "application/json; charset=utf-8",
                        "Set-Cookie": `admin_session_token=${adminSessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
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
        res.writeHead(302, { "Set-Cookie": "admin_session_token=; Path=/; Max-Age=0", Location: "/admin/login" });
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
                try {
                    const { uuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled } = JSON.parse(body || "{}");
                    const user = usersDatabase.find((u) => u.uuid === uuid);
                    if (!user) {
                        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                        return res.end(JSON.stringify({ error: "未找到目标用户" }));
                    }

                    if (typeof newPassword === "string" && newPassword.trim().length > 0) {
                        user.passwordHash = hashPassword(newPassword.trim());
                    }

                    if (trafficLimitVal !== undefined && trafficLimitVal !== "" && !isNaN(trafficLimitVal)) {
                        user.trafficLimit = convertToBytes(trafficLimitVal, trafficLimitUnit || "GB");
                    }

                    if (expireDate !== undefined) {
                        if (!expireDate || String(expireDate).trim() === "" || expireDate === "永久有效") {
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
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "数据处理异常: " + e.message }));
                }
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

        if (pathname === "/admin/api/clear-invalid" && req.method === "POST") {
            const beforeCount = usersDatabase.length;
            usersDatabase = usersDatabase.filter((u) => {
                const reason = isUserInvalid(u);
                if (reason) {
                    userActivityMap.delete(u.uuid);
                    return false;
                }
                return true;
            });
            const removedCount = beforeCount - usersDatabase.length;
            if (removedCount > 0) {
                saveUsers();
                safeReloadSingbox();
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: true, removedCount }));
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
                    enabled: true,
                    createdAt: Date.now()
                };

                usersDatabase.push(newUser);
                saveUsers();
                safeReloadSingbox();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true }));
            });
            return;
        }

        if (pathname === "/admin/api/settings" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ success: true, settings: siteSettings }));
        }

        if (pathname === "/admin/api/sync-wetest" && req.method === "POST") {
            fetchWetestCleanIps(true).then((result) => {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
            }).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
            return;
        }

        if (pathname === "/admin/api/sync-cm" && req.method === "POST") {
            fetchCmApiIps(true).then((result) => {
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
            }).catch((err) => {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: false, error: err.message }));
            });
            return;
        }

        if (pathname === "/admin/api/settings" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                try {
                    const { 
                        allowRegistration, initialTrafficLimitVal, initialTrafficLimitUnit, initialDays, ipRegisterLimit,
                        enableOptWetest, wetestApiCountCT, wetestApiCountCU, wetestApiCountCM,
                        enableOptCMApi, cmApiCountCT, cmApiCountCU, cmApiCountCM,
                        enableCustomDomains, customDomainsText
                    } = JSON.parse(body || "{}");

                    if (allowRegistration !== undefined) {
                        siteSettings.allowRegistration = Boolean(allowRegistration);
                    }
                    if (initialTrafficLimitVal !== undefined && !isNaN(initialTrafficLimitVal)) {
                        siteSettings.initialTrafficLimitVal = Math.max(0, parseFloat(initialTrafficLimitVal));
                    }
                    if (initialTrafficLimitUnit) {
                        const unitUpper = String(initialTrafficLimitUnit).toUpperCase();
                        if (["MB", "GB", "TB"].includes(unitUpper)) {
                            siteSettings.initialTrafficLimitUnit = unitUpper;
                        }
                    }
                    if (initialDays !== undefined && !isNaN(initialDays)) {
                        siteSettings.initialDays = Math.max(0, parseInt(initialDays, 10));
                    }
                    if (ipRegisterLimit !== undefined && !isNaN(ipRegisterLimit)) {
                        siteSettings.ipRegisterLimit = Math.max(0, parseInt(ipRegisterLimit, 10));
                    }

                    // 微测网 (Wetest.vip) 优选配置字段
                    if (enableOptWetest !== undefined) {
                        siteSettings.enableOptWetest = Boolean(enableOptWetest);
                    }
                    if (wetestApiCountCT !== undefined && !isNaN(wetestApiCountCT)) {
                        siteSettings.wetestApiCountCT = Math.max(1, parseInt(wetestApiCountCT, 10));
                    }
                    if (wetestApiCountCU !== undefined && !isNaN(wetestApiCountCU)) {
                        siteSettings.wetestApiCountCU = Math.max(1, parseInt(wetestApiCountCU, 10));
                    }
                    if (wetestApiCountCM !== undefined && !isNaN(wetestApiCountCM)) {
                        siteSettings.wetestApiCountCM = Math.max(1, parseInt(wetestApiCountCM, 10));
                    }

                    // CM 佬 (cf.090227.xyz) 优选配置字段
                    if (enableOptCMApi !== undefined) {
                        siteSettings.enableOptCMApi = Boolean(enableOptCMApi);
                    }
                    if (cmApiCountCT !== undefined && !isNaN(cmApiCountCT)) {
                        siteSettings.cmApiCountCT = Math.max(1, parseInt(cmApiCountCT, 10));
                    }
                    if (cmApiCountCU !== undefined && !isNaN(cmApiCountCU)) {
                        siteSettings.cmApiCountCU = Math.max(1, parseInt(cmApiCountCU, 10));
                    }
                    if (cmApiCountCM !== undefined && !isNaN(cmApiCountCM)) {
                        siteSettings.cmApiCountCM = Math.max(1, parseInt(cmApiCountCM, 10));
                    }
                    if (enableCustomDomains !== undefined) {
                        siteSettings.enableCustomDomains = Boolean(enableCustomDomains);
                    }
                    if (customDomainsText !== undefined) {
                        siteSettings.customDomainsText = String(customDomainsText);
                    }

                    saveSettings();
                    console.log("[Settings] 管理员已成功更新全站系统与三网优选策略配置:", JSON.stringify(siteSettings));

                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ success: true, settings: siteSettings }));
                } catch (e) {
                    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "更新系统配置失败: " + e.message }));
                }
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

        // 自动会话下发：如果用户是通过 ?token=... 或 ?pwd=... 直接访问，自动补种全域 Cookie，确保后续 API 全程畅通
        let autoAuthCookie = null;
        const qToken = query.get("token") || query.get("pwd") || query.get("password");
        if (qToken && qToken === appConfig.adminToken) {
            const adminSessionToken = crypto.randomBytes(24).toString("hex");
            const expireTime = Date.now() + 24 * 3600 * 1000;
            adminSessions.set(adminSessionToken, expireTime);
            autoAuthCookie = `admin_session_token=${adminSessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
        }

        const totalUsers = usersDatabase.length;
        const activeUsersCount = getActiveUsers().length;
        const totalTrafficSum = usersDatabase.reduce((acc, u) => acc + (u.trafficUsed || 0), 0);

        // 统计实时全站在线连接数
        let totalLiveConnections = 0;
        userActivityMap.forEach((act) => {
            totalLiveConnections += (act.activeConnections || 0);
        });

        const structuredUsers = usersDatabase.map((u) => {
            const act = getUserActivity(u.uuid);
            const invalidMsg = isUserInvalid(u);
            const baseSubUrl = getEffectiveSubBaseUrl(req, u.uuid);
            const clashSubUrl = `${baseSubUrl}${baseSubUrl.includes("?") ? "&" : "?"}type=clash`;
            return {
                uuid: u.uuid,
                username: u.username,
                trafficLimit: u.trafficLimit || 0,
                trafficUsed: u.trafficUsed || 0,
                expireTime: u.expireTime || 0,
                createdAt: u.createdAt || 0,
                enabled: Boolean(u.enabled),
                invalidMsg: invalidMsg || "",
                activeConnections: act ? (act.activeConnections || 0) : 0,
                lastSeenAt: act ? (act.lastSeenAt || 0) : 0,
                baseSubUrl: baseSubUrl,
                clashSubUrl: clashSubUrl
            };
        });
        const structuredUsersJson = JSON.stringify(structuredUsers);
        const siteSettingsJson = JSON.stringify(siteSettings);

        const responseHeaders = { "Content-Type": "text/html; charset=utf-8" };
        if (autoAuthCookie) {
            responseHeaders["Set-Cookie"] = autoAuthCookie;
        }
        res.writeHead(200, responseHeaders);
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
                    th.sortable {
                        cursor: pointer;
                        user-select: none;
                        transition: all 0.2s;
                    }
                    th.sortable:hover {
                        background: #f0f2f5;
                        color: var(--el-primary);
                    }
                    th.sortable.active {
                        background: #ecf5ff;
                        color: #409eff;
                    }
                    th.sortable .sort-icon {
                        display: inline-block;
                        margin-left: 4px;
                        font-size: 12px;
                        color: #909399;
                    }
                    th.sortable.active .sort-icon {
                        color: #409eff;
                        font-weight: bold;
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
                        <div class="header-right" style="display:flex; align-items:center; gap:10px;">
                            ${appConfig.isTunnelAvailable
                ? '<span style="font-size:12px; color:#67c23a; background:#f0f9eb; border:1px solid #e1f3d8; padding:3px 8px; border-radius:4px;">⚡ 隧道: 已激活 (含3优选节点)</span>'
                : '<span style="font-size:12px; color:#909399; background:#f4f4f5; border:1px solid #dcdfe6; padding:3px 8px; border-radius:4px;">⚪ 隧道: 未配置 (仅3直连节点)</span>'}
                            <span style="font-size:12px; color:var(--el-text-secondary);">端口: ${appConfig.port}</span>
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
                            <div style="display:flex; gap:10px; align-items:center;">
                                <button class="btn" style="background:#fef0f0; border:1px solid #fde2e2; color:#f56c6c; cursor:pointer;" onclick="clearInvalidUsers()" title="一键清理所有过期、流量超额或被冻结的失效用户">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    一键清理失效
                                </button>
                                <button class="btn" style="background:var(--el-primary-light); border:1px solid var(--el-primary-border); color:var(--el-primary); cursor:pointer;" onclick="openSettingsModal()" title="设置是否开放注册以及新注册用户初始配额">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                                    注册与初始配额
                                    <span id="regStatusBadge" style="margin-left:4px; font-size:11px; padding:1px 6px; border-radius:10px; background:${siteSettings.allowRegistration ? '#67c23a' : '#909399'}; color:#fff;">${siteSettings.allowRegistration ? '开放中' : '已关闭'}</span>
                                </button>
                                <button class="btn" style="background:#ecf5ff; border:1px solid #d9ecff; color:#409eff; cursor:pointer;" onclick="openCdnOptModal()" title="设置 CM佬三网优选 API 与批量自定义加速域名池">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                                    三网优选与域名池
                                </button>
                                <button class="btn" style="background:#f4f4f5; border:1px solid #e9e9eb; color:var(--el-text-regular); cursor:pointer;" onclick="openClientsModal()" title="查看 Windows / Android / iOS / Mac 各大平台主流客户端官方下载地址">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                    客户端下载
                                </button>
                                <button class="btn btn-primary" onclick="openAddModal()">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                    新增用户授权
                                </button>
                            </div>
                        </div>
                        <div class="mobile-tip">💡 提示：表格支持左右横向滑动查看全部字段</div>
                        <div class="table-wrapper">
                            <table>
                                <thead>
                                    <tr>
                                        <th>用户主体</th>
                                        <th class="sortable" id="th_traffic" onclick="handleSortClick('traffic')">已用流量 <span class="sort-icon" id="icon_traffic">⇅</span></th>
                                        <th class="sortable active" id="th_created" onclick="handleSortClick('created')">注册时间 <span class="sort-icon" id="icon_created">↓</span></th>
                                        <th class="sortable" id="th_expire" onclick="handleSortClick('expire')">到期时间 <span class="sort-icon" id="icon_expire">⇅</span></th>
                                        <th class="sortable" id="th_status" onclick="handleSortClick('status')">状态 <span class="sort-icon" id="icon_status">⇅</span></th>
                                        <th class="sortable" id="th_online" onclick="handleSortClick('online')">在线 <span class="sort-icon" id="icon_online">⇅</span></th>
                                        <th>专属订阅</th>
                                        <th>运维操作</th>
                                    </tr>
                                </thead>
                                <tbody id="userTableBody"></tbody>
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

                    <!-- 注册控制与初始配额设置弹窗 -->
                    <div class="modal-mask" id="settingsModal">
                        <div class="modal">
                            <h4>注册控制与初始配额</h4>
                            <div class="field-box">
                                <label>公开新用户自主注册通道</label>
                                <select id="cfg_allow_reg">
                                    <option value="true">开启（允许新用户在前台自主注册）</option>
                                    <option value="false">关闭（暂停新用户注册，仅限管理员手工添加）</option>
                                </select>
                            </div>
                            <div class="field-box">
                                <label>新注册账号初始流量配额</label>
                                <div class="input-unit-group">
                                    <input type="number" step="0.1" id="cfg_traffic_val" placeholder="初始流量" style="flex:2;" />
                                    <select id="cfg_traffic_unit" style="flex:1;">
                                        <option value="MB">MB</option>
                                        <option value="GB">GB</option>
                                        <option value="TB">TB</option>
                                    </select>
                                </div>
                            </div>
                            <div class="field-box">
                                <label>新注册账号有效期限 (天)</label>
                                <input type="number" id="cfg_days" placeholder="填 0 表示永久有效" />
                                <div style="font-size:12px; color:var(--el-text-secondary); margin-top:4px;">💡 提示：输入 0 表示账号永久有效，不设到期时间。</div>
                            </div>
                            <div class="field-box">
                                <label>同一 IP 24小时内最多注册账号数 (防刷限额)</label>
                                <input type="number" id="cfg_ip_limit" placeholder="填 0 表示不限制，默认 1" />
                                <div style="font-size:12px; color:var(--el-text-secondary); margin-top:4px;">💡 提示：限制同一客户端 IP 在 24 小时内最多注册的账号数（如 1），填 0 则不限制。</div>
                            </div>
                            <div class="modal-footer">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeSettingsModal()">取消</button>
                                <button class="btn btn-primary" id="saveSettingsBtn" onclick="submitSettings()">保存配置</button>
                            </div>
                        </div>
                    </div>

                    <!-- 常用代理客户端下载中心弹窗 -->
                    <!-- 常用代理客户端下载中心弹窗 -->
                    <div class="modal-mask" id="clientsModal">
                        <div class="modal" style="max-width:620px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <h4 style="margin:0;">常用代理客户端官方直连下载</h4>
                                <span style="font-size:12px; background:#e1f3d8; color:#67c23a; padding:2px 8px; border-radius:10px; font-weight:500;">国内高速直链 · 极速下载</span>
                            </div>
                            <div style="font-size:13px; color:var(--el-text-secondary); margin-bottom:14px;">
                                提供当前最主流、高颜值的全平台开源客户端 <strong>FlClash (v0.8.94)</strong> 官方国内 CDN 直连下载，即点即下，免去 GitHub 访问困扰：
                            </div>
                            
                            <div style="display:flex; flex-direction:column; gap:12px; max-height:420px; overflow-y:auto; padding-right:4px;">
                                <!-- Windows -->
                                <div style="background:#fafafa; border:1px solid var(--el-border); border-radius:6px; padding:12px 14px;">
                                    <div style="font-weight:600; font-size:13px; color:var(--el-text-main); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                        <span>💻 <strong>Windows 电脑端</strong></span>
                                        <span style="font-size:11px; color:#909399;">Win 10 / 11 兼容</span>
                                    </div>
                                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64-setup.exe" target="_blank" class="btn btn-primary" style="font-size:12px; text-decoration:none; padding:5px 12px;">⚡ FlClash 安装程序 (.exe)</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64.zip" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash 绿色版 (.zip)</a>
                                        <a href="https://github.com/clash-verge-rev/clash-verge-rev/releases" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-secondary); font-size:12px; text-decoration:none; padding:5px 10px;">Clash Verge (备用)</a>
                                    </div>
                                </div>

                                <!-- Android -->
                                <div style="background:#fafafa; border:1px solid var(--el-border); border-radius:6px; padding:12px 14px;">
                                    <div style="font-weight:600; font-size:13px; color:var(--el-text-main); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                        <span>📱 <strong>Android 安卓手机/平板</strong></span>
                                        <span style="font-size:11px; color:#909399;">APK 直链极速安装</span>
                                    </div>
                                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-arm64-v8a.apk" target="_blank" class="btn btn-primary" style="font-size:12px; text-decoration:none; padding:5px 12px;">⚡ FlClash 64位 (.apk 首选)</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-armeabi-v7a.apk" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash 32位老机型 (.apk)</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-x86_64.apk" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash 模拟器/x86 (.apk)</a>
                                    </div>
                                </div>

                                <!-- macOS -->
                                <div style="background:#fafafa; border:1px solid var(--el-border); border-radius:6px; padding:12px 14px;">
                                    <div style="font-weight:600; font-size:13px; color:var(--el-text-main); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                        <span>🍎 <strong>macOS 苹果电脑</strong></span>
                                        <span style="font-size:11px; color:#909399;">DMG 原生镜像包</span>
                                    </div>
                                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-arm64.dmg" target="_blank" class="btn btn-primary" style="font-size:12px; text-decoration:none; padding:5px 12px;">⚡ FlClash M系列芯片 (.dmg)</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-amd64.dmg" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash Intel 芯片 (.dmg)</a>
                                        <a href="https://apps.apple.com/app/shadowrocket/id932747118" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-secondary); font-size:12px; text-decoration:none; padding:5px 10px;">iOS 小火箭 (AppStore)</a>
                                    </div>
                                </div>

                                <!-- Linux -->
                                <div style="background:#fafafa; border:1px solid var(--el-border); border-radius:6px; padding:12px 14px;">
                                    <div style="font-weight:600; font-size:13px; color:var(--el-text-main); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                        <span>🐧 <strong>Linux 平台</strong></span>
                                        <span style="font-size:11px; color:#909399;">多发行版包格式支持</span>
                                    </div>
                                    <div style="display:flex; flex-wrap:wrap; gap:8px;">
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.AppImage" target="_blank" class="btn btn-primary" style="font-size:12px; text-decoration:none; padding:5px 12px;">⚡ FlClash AppImage</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.deb" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash Debian/Ubuntu (.deb)</a>
                                        <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.rpm" target="_blank" class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular); font-size:12px; text-decoration:none; padding:5px 10px;">FlClash RPM (.rpm)</a>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-footer" style="margin-top:16px;">
                                <button class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeClientsModal()">关闭</button>
                            </div>
                        </div>
                    </div>

                    <!-- 三网优选 API 与批量自定义优选域名池弹窗 -->
                    <div class="modal-mask" id="cdnOptModal">
                        <div class="modal" style="max-width:620px; max-height:85vh; overflow-y:auto;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <h4 style="margin:0;">⚡ 三网优选 API 与批量加速域名池</h4>
                                <span style="font-size:12px; background:#e0f2fe; color:#0284c7; padding:2px 8px; border-radius:10px; font-weight:500;">CF 端口回溯直连</span>
                            </div>

                            <!-- 📶 微测网 (Wetest.vip) 三网优选 API -->
                            <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:14px; margin-bottom:14px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                    <div>
                                        <span style="font-weight:700; color:#15803d; font-size:13px;">📶 微测网 Cloudflare 官方优选 (wetest.vip)</span>
                                        <div style="font-size:11px; color:#166534; margin-top:2px;">实时拉取国内电信/联通/移动最优Anycast节点与真实延迟</div>
                                    </div>
                                    <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; cursor:pointer;">
                                        <input type="checkbox" id="cfg_enableOptWetest" /> <span style="color:#15803d;">启用</span>
                                    </label>
                                </div>
                                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:12px;">
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">电信数量</label>
                                        <input type="number" id="cfg_wetestApiCountCT" min="1" max="30" value="6" />
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">联通数量</label>
                                        <input type="number" id="cfg_wetestApiCountCU" min="1" max="30" value="8" />
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">移动数量</label>
                                        <input type="number" id="cfg_wetestApiCountCM" min="1" max="30" value="8" />
                                    </div>
                                </div>
                                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                                    <button class="btn" style="background:#fff; border:1px solid #86efac; color:#15803d; font-size:12px; padding:5px 12px;" id="btn_sync_wetest" onclick="syncWetestApi()">🔄 立即拉取微测网</button>
                                    <span style="font-size:11px; color:#166534;">上次同步: <b id="wetest_sync_time_text" style="color:#0f172a;">未同步</b></span>
                                </div>
                            </div>

                            <!-- ⚡ CM 佬三网优选订阅器 API -->
                            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px; margin-bottom:14px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                    <div>
                                        <span style="font-weight:700; color:#0369a1; font-size:13px;">⚡ CM佬 Cloudflare 三网优选 (cf.090227.xyz)</span>
                                        <div style="font-size:11px; color:#64748b; margin-top:2px;">实时拉取电信/联通/移动最优Anycast IP并格式化下发</div>
                                    </div>
                                    <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; cursor:pointer;">
                                        <input type="checkbox" id="cfg_enableOptCMApi" /> <span style="color:#0369a1;">启用</span>
                                    </label>
                                </div>
                                <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-bottom:12px;">
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">电信数量</label>
                                        <input type="number" id="cfg_cmApiCountCT" min="1" max="30" value="6" />
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">联通数量</label>
                                        <input type="number" id="cfg_cmApiCountCU" min="1" max="30" value="8" />
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:12px;">移动数量</label>
                                        <input type="number" id="cfg_cmApiCountCM" min="1" max="30" value="8" />
                                    </div>
                                </div>
                                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                                    <button class="btn" style="background:#fff; border:1px solid #bae6fd; color:#0284c7; font-size:12px; padding:5px 12px;" id="btn_sync_cm" onclick="syncCmApi()">🔄 立即拉取 CM佬</button>
                                    <span style="font-size:11px; color:#64748b;">上次同步: <b id="cm_sync_time_text" style="color:#0f172a;">未同步</b></span>
                                </div>
                            </div>

                            <!-- 🚀 批量自定义优选域名池 -->
                            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:14px;">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                    <div>
                                        <span style="font-weight:700; color:#6d28d9; font-size:13px;">🚀 批量自定义加速域名池</span>
                                        <div style="font-size:11px; color:#64748b; margin-top:2px;">支持自定义优质 CDN 域名或专属端口</div>
                                    </div>
                                    <label style="display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; cursor:pointer;">
                                        <input type="checkbox" id="cfg_enableCustomDomains" /> <span style="color:#6d28d9;">启用</span>
                                    </label>
                                </div>
                                <div class="field-box" style="margin-bottom:0;">
                                    <textarea id="cfg_customDomainsText" rows="4" placeholder="每行一个，支持：&#10;1. 纯域名：cf.090227.xyz&#10;2. 域名#备注：cf.090227.xyz#香港优质CDN&#10;3. 域名:端口#备注：cf.090227.xyz:8443#高防8443" style="width:100%; font-family:Consolas, monospace; font-size:12px; line-height:1.4; padding:8px; border:1px solid var(--el-border); border-radius:4px; box-sizing:border-box;"></textarea>
                                </div>
                            </div>

                            <div class="modal-footer" style="margin-top:16px;">
                                <button class="btn" style="background:#fff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeCdnOptModal()">取消</button>
                                <button class="btn btn-primary" id="saveCdnOptBtn" onclick="submitCdnOptSettings()">保存配置</button>
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

                    // 全量用户数据驱动与响应式排序引擎
                    window.__ALL_USERS__ = ${structuredUsersJson};
                    window.__SITE_SETTINGS__ = ${siteSettingsJson};
                    let currentSortField = "created"; // 默认按注册时间倒序排
                    let currentSortOrder = "desc";

                    function formatBytesClient(bytes) {
                        if (!bytes || bytes <= 0) return "0 B";
                        const k = 1024;
                        const sizes = ["B", "KB", "MB", "GB", "TB"];
                        const i = Math.floor(Math.log(bytes) / Math.log(k));
                        const safeIndex = Math.min(i, sizes.length - 1);
                        return (bytes / Math.pow(k, safeIndex)).toFixed(2) + " " + sizes[safeIndex];
                    }

                    function parseBytesToInputClient(bytes) {
                        if (!bytes || bytes <= 0) return { val: 0, unit: "GB" };
                        const tb = 1024 * 1024 * 1024 * 1024;
                        const gb = 1024 * 1024 * 1024;
                        const mb = 1024 * 1024;
                        if (bytes >= tb) return { val: (bytes / tb).toFixed(2), unit: "TB" };
                        if (bytes >= gb) return { val: (bytes / gb).toFixed(2), unit: "GB" };
                        return { val: (bytes / mb).toFixed(2), unit: "MB" };
                    }

                    function formatDateTimeClient(ts) {
                        if (!ts || isNaN(ts) || Number(ts) <= 0) return "-";
                        var d = new Date(Number(ts));
                        if (isNaN(d.getTime())) return "-";
                        var pad = function(n) { return String(n).padStart(2, "0"); };
                        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
                    }

                    function formatExpireDateClient(ts) {
                        if (!ts || isNaN(ts) || Number(ts) <= 0) return "永久有效";
                        var d = new Date(Number(ts));
                        if (isNaN(d.getTime())) return "永久有效";
                        var pad = function(n) { return String(n).padStart(2, "0"); };
                        return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
                    }

                    function formatRelativeTimeClient(ts) {
                        if (!ts || ts <= 0) return "从未活跃";
                        var diff = Math.floor((Date.now() - ts) / 1000);
                        if (diff < 60) return "刚刚活跃";
                        if (diff < 3600) return Math.floor(diff / 60) + "分钟前";
                        if (diff < 86400) return Math.floor(diff / 3600) + "小时前";
                        return Math.floor(diff / 86400) + "天前";
                    }

                    function handleSortClick(field) {
                        if (currentSortField === field) {
                            currentSortOrder = currentSortOrder === "asc" ? "desc" : "asc";
                        } else {
                            currentSortField = field;
                            currentSortOrder = "desc";
                        }
                        renderUsersTable();
                    }

                    function renderUsersTable() {
                        var list = (window.__ALL_USERS__ || []).slice();
                        var factor = currentSortOrder === "asc" ? 1 : -1;

                        list.sort(function(a, b) {
                            if (currentSortField === "traffic") {
                                return factor * ((a.trafficUsed || 0) - (b.trafficUsed || 0));
                            }
                            if (currentSortField === "created") {
                                return factor * ((a.createdAt || 0) - (b.createdAt || 0));
                            }
                            if (currentSortField === "expire") {
                                var expA = a.expireTime > 0 ? a.expireTime : (currentSortOrder === "asc" ? Infinity : -Infinity);
                                var expB = b.expireTime > 0 ? b.expireTime : (currentSortOrder === "asc" ? Infinity : -Infinity);
                                return factor * (expA - expB);
                            }
                            if (currentSortField === "status") {
                                var stA = a.enabled ? 1 : 0;
                                var stB = b.enabled ? 1 : 0;
                                return factor * (stA - stB);
                            }
                            if (currentSortField === "online") {
                                return factor * ((a.activeConnections || 0) - (b.activeConnections || 0));
                            }
                            return 0;
                        });

                        // 更新表头高亮与箭头状态
                        ["traffic", "created", "expire", "status", "online"].forEach(function(f) {
                            var th = document.getElementById("th_" + f);
                            var icon = document.getElementById("icon_" + f);
                            if (!th || !icon) return;
                            if (f === currentSortField) {
                                th.classList.add("active");
                                icon.innerText = currentSortOrder === "asc" ? "↑" : "↓";
                            } else {
                                th.classList.remove("active");
                                icon.innerText = "⇅";
                            }
                        });

                        var tbody = document.getElementById("userTableBody");
                        if (!tbody) return;

                        if (list.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:32px; color:#909399;">暂无注册用户数据</td></tr>';
                            return;
                        }

                        tbody.innerHTML = list.map(function(u) {
                            var statusBadge = '<span class="badge badge-success"><span class="badge-dot"></span>有效活跃</span>';
                            if (!u.enabled) statusBadge = '<span class="badge badge-danger"><span class="badge-dot"></span>手动阻断</span>';
                            else if (u.invalidMsg === '账号已过有效期限') statusBadge = '<span class="badge badge-danger"><span class="badge-dot"></span>已过期</span>';
                            else if (u.invalidMsg === '流量配额已耗尽') statusBadge = '<span class="badge badge-warning"><span class="badge-dot"></span>已超额</span>';

                            var onlineBadge = '<span class="badge-online-offline">⚪ 离线 (' + formatRelativeTimeClient(u.lastSeenAt) + ')</span>';
                            if (u.activeConnections > 0) {
                                onlineBadge = '<span class="badge-online-live"><span class="badge-dot-live"></span>在线 (' + u.activeConnections + '设备)</span>';
                            }

                            var createdStr = formatDateTimeClient(u.createdAt);
                            var expireStr = formatExpireDateClient(u.expireTime);

                            var rowHtml = '<tr>' +
                                '<td data-label="用户主体">' +
                                    '<div class="user-cell">' +
                                        '<span class="avatar">' + u.username.substring(0, 1).toUpperCase() + '</span>' +
                                        '<div class="user-info">' +
                                            '<span class="uname">' + u.username + '</span>' +
                                            '<span class="uuid-sub" data-copy="' + u.uuid + '" style="cursor:pointer;" title="点击复制完整UUID">' + u.uuid.substring(0, 8) + '...</span>' +
                                        '</div>' +
                                    '</div>' +
                                '</td>' +
                                '<td data-label="用量/限额">' +
                                    '<div class="metric-val">' + formatBytesClient(u.trafficUsed) + '</div>' +
                                    '<div class="metric-sub">限额 ' + formatBytesClient(u.trafficLimit) + '</div>' +
                                '</td>' +
                                '<td data-label="注册时间" class="date-cell" style="font-size:12px; color:#606266;">' + createdStr + '</td>' +
                                '<td data-label="到期时间" class="date-cell">' + expireStr + '</td>' +
                                '<td data-label="账号状态">' + statusBadge + '</td>' +
                                '<td data-label="实时感知">' + onlineBadge + '</td>' +
                                '<td data-label="专属订阅">' +
                                    '<div class="sub-btn-group">' +
                                        '<button class="btn btn-copy-sub" data-copy="' + u.baseSubUrl + '" title="复制标准 Base64 订阅链接">常规</button>' +
                                        '<button class="btn btn-copy-sub btn-copy-clash" data-copy="' + u.clashSubUrl + '" title="复制 Clash Meta 规则配置订阅">Clash</button>' +
                                    '</div>' +
                                '</td>' +
                                '<td data-label="管理操作">' +
                                    '<div class="actions-group">' +
                                        '<button class="btn btn-action-edit" data-action="edit" data-uuid="' + u.uuid + '">编辑</button>' +
                                        '<button class="btn btn-action-reset" data-action="reset" data-uuid="' + u.uuid + '">重置</button>' +
                                        '<button class="btn btn-action-del" data-action="del" data-uuid="' + u.uuid + '">注销</button>' +
                                    '</div>' +
                                '</td>' +
                            '</tr>';
                            return rowHtml;
                        }).join("");
                    }

                    // 页面初始化即刻按默认排序渲染并挂载表格事件委托
                    window.addEventListener("DOMContentLoaded", () => {
                        renderUsersTable();

                        const tbody = document.getElementById("userTableBody");
                        if (tbody) {
                            tbody.addEventListener("click", function(e) {
                                const copyEl = e.target.closest("[data-copy]");
                                if (copyEl) {
                                    var textToCopy = copyEl.getAttribute("data-copy") || "";
                                    try {
                                        if (textToCopy.indexOf("/sub?token=") > -1 && window.location.hostname && window.location.hostname !== "127.0.0.1" && window.location.hostname !== "localhost") {
                                            var u = new URL(textToCopy, window.location.origin);
                                            textToCopy = window.location.origin + u.pathname + u.search;
                                        }
                                    } catch(err) {}
                                    copyText(textToCopy);
                                    return;
                                }

                                const actionEl = e.target.closest("[data-action]");
                                if (actionEl) {
                                    const action = actionEl.getAttribute("data-action");
                                    const uuid = actionEl.getAttribute("data-uuid");
                                    if (action === "edit") {
                                        openEditModalByUuid(uuid);
                                    } else if (action === "reset") {
                                        resetTraffic(uuid);
                                    } else if (action === "del") {
                                        deleteUser(uuid);
                                    }
                                }
                            });
                        }
                    });

                    // 纯 UUID 驱动编辑弹窗：零参数拼接，彻底杜绝单双引号特殊字符引发的崩溃
                    function openEditModalByUuid(uuid) {
                        const u = (window.__ALL_USERS__ || []).find(item => item.uuid === uuid);
                        if (!u) {
                            alert("未定位到目标用户数据，请刷新后重试");
                            return;
                        }

                        const parsed = parseBytesToInputClient(u.trafficLimit);
                        document.getElementById("editModalTitle").innerText = "编辑用户: " + u.username;
                        document.getElementById("edit_uuid").value = u.uuid;
                        document.getElementById("edit_pwd").value = "";
                        document.getElementById("edit_val").value = parsed.val;
                        document.getElementById("edit_unit").value = parsed.unit;
                        document.getElementById("edit_expire").value = (u.expireTime > 0) ? new Date(u.expireTime).toISOString().split("T")[0] : "";
                        document.getElementById("edit_enabled").value = String(u.enabled);
                        document.getElementById("editModal").style.display = "flex";
                    }

                    function closeEditModal() {
                        document.getElementById("editModal").style.display = "none";
                    }

                    // 注册控制与初始配额弹窗管理
                    function openSettingsModal() {
                        const s = window.__SITE_SETTINGS__ || {};
                        document.getElementById("cfg_allow_reg").value = String(Boolean(s.allowRegistration));
                        document.getElementById("cfg_traffic_val").value = (s.initialTrafficLimitVal !== undefined) ? s.initialTrafficLimitVal : 15;
                        document.getElementById("cfg_traffic_unit").value = s.initialTrafficLimitUnit || "GB";
                        document.getElementById("cfg_days").value = (s.initialDays !== undefined) ? s.initialDays : 30;
                        document.getElementById("cfg_ip_limit").value = (s.ipRegisterLimit !== undefined) ? s.ipRegisterLimit : 1;
                        document.getElementById("settingsModal").style.display = "flex";
                    }

                    function closeSettingsModal() {
                        document.getElementById("settingsModal").style.display = "none";
                    }

                    function openClientsModal() {
                        document.getElementById("clientsModal").style.display = "flex";
                    }

                    function closeClientsModal() {
                        document.getElementById("clientsModal").style.display = "none";
                    }

                    function openCdnOptModal() {
                        const s = window.__SITE_SETTINGS__ || {};
                        // 📶 微测网配置回填
                        const elWetestCheck = document.getElementById("cfg_enableOptWetest");
                        if (elWetestCheck) elWetestCheck.checked = s.enableOptWetest !== false;
                        const elWetestCT = document.getElementById("cfg_wetestApiCountCT");
                        if (elWetestCT) elWetestCT.value = s.wetestApiCountCT || 6;
                        const elWetestCU = document.getElementById("cfg_wetestApiCountCU");
                        if (elWetestCU) elWetestCU.value = s.wetestApiCountCU || 8;
                        const elWetestCM = document.getElementById("cfg_wetestApiCountCM");
                        if (elWetestCM) elWetestCM.value = s.wetestApiCountCM || 8;
                        const elWetestTime = document.getElementById("wetest_sync_time_text");
                        if (elWetestTime) elWetestTime.innerText = s.wetestSyncTime || "未同步";

                        // ⚡ CM佬配置回填
                        const elCmCheck = document.getElementById("cfg_enableOptCMApi");
                        if (elCmCheck) elCmCheck.checked = s.enableOptCMApi !== false;
                        const elCmCT = document.getElementById("cfg_cmApiCountCT");
                        if (elCmCT) elCmCT.value = s.cmApiCountCT || 6;
                        const elCmCU = document.getElementById("cfg_cmApiCountCU");
                        if (elCmCU) elCmCU.value = s.cmApiCountCU || 8;
                        const elCmCM = document.getElementById("cfg_cmApiCountCM");
                        if (elCmCM) elCmCM.value = s.cmApiCountCM || 8;
                        const elCmTime = document.getElementById("cm_sync_time_text");
                        if (elCmTime) elCmTime.innerText = s.cmApiSyncTime || "未同步";

                        // 🚀 批量自定义域名回填
                        const elCustomCheck = document.getElementById("cfg_enableCustomDomains");
                        if (elCustomCheck) elCustomCheck.checked = Boolean(s.enableCustomDomains);
                        const elCustomText = document.getElementById("cfg_customDomainsText");
                        if (elCustomText) elCustomText.value = s.customDomainsText || "";

                        const modal = document.getElementById("cdnOptModal");
                        if (modal) modal.style.display = "flex";
                    }

                    function closeCdnOptModal() {
                        const modal = document.getElementById("cdnOptModal");
                        if (modal) modal.style.display = "none";
                    }

                    async function syncWetestApi() {
                        const btn = document.getElementById("btn_sync_wetest");
                        if (btn) {
                            btn.innerText = "⏳ 正在拉取微测网...";
                            btn.disabled = true;
                        }
                        try {
                            const qToken = new URLSearchParams(window.location.search).get("token") || "";
                            const apiUrl = qToken ? ("/admin/api/sync-wetest?token=" + encodeURIComponent(qToken)) : "/admin/api/sync-wetest";
                            const res = await fetch(apiUrl, { method: "POST" });
                            const data = await res.json();
                            if (res.ok && data.success) {
                                window.__SITE_SETTINGS__ = data.settings;
                                const elTime = document.getElementById("wetest_sync_time_text");
                                if (elTime) elTime.innerText = data.settings.wetestSyncTime || "刚刚更新";
                                showToast("微测网官方三网优选 IP 拉取成功！");
                            } else {
                                alert(data.error || "微测网拉取失败");
                            }
                        } catch (e) {
                            alert("网络异常: " + e.message);
                        } finally {
                            if (btn) {
                                btn.innerText = "🔄 立即拉取微测网";
                                btn.disabled = false;
                            }
                        }
                    }

                    async function syncCmApi() {
                        const btn = document.getElementById("btn_sync_cm");
                        if (btn) {
                            btn.innerText = "⏳ 正在拉取 CM佬...";
                            btn.disabled = true;
                        }
                        try {
                            const qToken = new URLSearchParams(window.location.search).get("token") || "";
                            const apiUrl = qToken ? ("/admin/api/sync-cm?token=" + encodeURIComponent(qToken)) : "/admin/api/sync-cm";
                            const res = await fetch(apiUrl, { method: "POST" });
                            const data = await res.json();
                            if (res.ok && data.success) {
                                window.__SITE_SETTINGS__ = data.settings;
                                const elTime = document.getElementById("cm_sync_time_text");
                                if (elTime) elTime.innerText = data.settings.cmApiSyncTime || "刚刚更新";
                                showToast("CM佬三网优选 IP 拉取成功！");
                            } else {
                                alert(data.error || "CM佬拉取失败");
                            }
                        } catch (e) {
                            alert("网络异常: " + e.message);
                        } finally {
                            if (btn) {
                                btn.innerText = "🔄 立即拉取 CM佬";
                                btn.disabled = false;
                            }
                        }
                    }

                    async function submitCdnOptSettings() {
                        const btn = document.getElementById("saveCdnOptBtn");
                        if (btn) {
                            btn.innerText = "保存中...";
                            btn.disabled = true;
                        }
                        try {
                            const enableOptWetest = document.getElementById("cfg_enableOptWetest") ? document.getElementById("cfg_enableOptWetest").checked : true;
                            const wetestApiCountCT = parseInt(document.getElementById("cfg_wetestApiCountCT").value, 10) || 6;
                            const wetestApiCountCU = parseInt(document.getElementById("cfg_wetestApiCountCU").value, 10) || 8;
                            const wetestApiCountCM = parseInt(document.getElementById("cfg_wetestApiCountCM").value, 10) || 8;

                            const enableOptCMApi = document.getElementById("cfg_enableOptCMApi") ? document.getElementById("cfg_enableOptCMApi").checked : true;
                            const cmApiCountCT = parseInt(document.getElementById("cfg_cmApiCountCT").value, 10) || 6;
                            const cmApiCountCU = parseInt(document.getElementById("cfg_cmApiCountCU").value, 10) || 8;
                            const cmApiCountCM = parseInt(document.getElementById("cfg_cmApiCountCM").value, 10) || 8;

                            const enableCustomDomains = document.getElementById("cfg_enableCustomDomains") ? document.getElementById("cfg_enableCustomDomains").checked : false;
                            const customDomainsText = document.getElementById("cfg_customDomainsText") ? document.getElementById("cfg_customDomainsText").value : "";

                            const qToken = new URLSearchParams(window.location.search).get("token") || "";
                            const apiUrl = qToken ? ("/admin/api/settings?token=" + encodeURIComponent(qToken)) : "/admin/api/settings";

                            const res = await fetch(apiUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    enableOptWetest, wetestApiCountCT, wetestApiCountCU, wetestApiCountCM,
                                    enableOptCMApi, cmApiCountCT, cmApiCountCU, cmApiCountCM,
                                    enableCustomDomains, customDomainsText
                                })
                            });
                            const data = await res.json();
                            if (res.ok && data.success) {
                                window.__SITE_SETTINGS__ = data.settings;
                                showToast("三网优选与自定义域名池策略已成功保存！");
                                closeCdnOptModal();
                            } else {
                                alert(data.error || "保存失败");
                            }
                        } catch (e) {
                            alert("网络异常: " + e.message);
                        } finally {
                            if (btn) {
                                btn.innerText = "保存配置";
                                btn.disabled = false;
                            }
                        }
                    }

                    async function submitSettings() {
                        const btn = document.getElementById("saveSettingsBtn");
                        btn.innerText = "保存中...";
                        btn.disabled = true;

                        try {
                            const allowRegistration = document.getElementById("cfg_allow_reg").value === "true";
                            const initialTrafficLimitVal = parseFloat(document.getElementById("cfg_traffic_val").value) || 0;
                            const initialTrafficLimitUnit = document.getElementById("cfg_traffic_unit").value;
                            const initialDays = parseInt(document.getElementById("cfg_days").value, 10) || 0;
                            const ipRegisterLimit = parseInt(document.getElementById("cfg_ip_limit").value, 10);

                            const qToken = new URLSearchParams(window.location.search).get("token") || "";
                            const apiUrl = qToken ? ("/admin/api/settings?token=" + encodeURIComponent(qToken)) : "/admin/api/settings";

                            const res = await fetch(apiUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    allowRegistration: allowRegistration,
                                    initialTrafficLimitVal: initialTrafficLimitVal,
                                    initialTrafficLimitUnit: initialTrafficLimitUnit,
                                    initialDays: initialDays,
                                    ipRegisterLimit: isNaN(ipRegisterLimit) ? 1 : Math.max(0, ipRegisterLimit)
                                })
                            });

                            const data = await res.json();
                            if (res.ok && data.success) {
                                window.__SITE_SETTINGS__ = data.settings;
                                showToast("系统注册、初始配额与IP防刷限额配置已成功保存！");
                                closeSettingsModal();
                                const badge = document.getElementById("regStatusBadge");
                                if (badge) {
                                    badge.style.background = data.settings.allowRegistration ? "#67c23a" : "#909399";
                                    badge.innerText = data.settings.allowRegistration ? "开放中" : "已关闭";
                                }
                            } else {
                                alert(data.error || "保存失败，请检查填写内容");
                            }
                        } catch (err) {
                            alert("网络通信异常: " + err.message);
                        } finally {
                            btn.innerText = "保存配置";
                            btn.disabled = false;
                        }
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

                            const qToken = new URLSearchParams(window.location.search).get("token") || "";
                            const apiUrl = qToken ? ("/admin/api/update?token=" + encodeURIComponent(qToken)) : "/admin/api/update";

                            const res = await fetch(apiUrl, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ uuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled })
                            });

                            const data = await res.json();
                            if (res.ok && data.success) {
                                showToast("修改已成功生效！");
                                closeEditModal();
                                setTimeout(() => location.reload(), 500);
                            } else {
                                alert(data.error || "保存失败，请检查填写内容");
                            }
                        } catch (err) {
                            alert("网络通信异常: " + err.message);
                        } finally {
                            btn.innerText = "确认保存更新";
                            btn.disabled = false;
                        }
                    }

                    async function resetTraffic(uuid) {
                        if (!confirm("确定清空该用户的用量？")) return;
                        const qToken = new URLSearchParams(window.location.search).get("token") || "";
                        const apiUrl = qToken ? ("/admin/api/reset?token=" + encodeURIComponent(qToken)) : "/admin/api/reset";
                        await fetch(apiUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }

                    async function deleteUser(uuid) {
                        if (!confirm("确定注销此账号？其节点连接将即刻失效！")) return;
                        const qToken = new URLSearchParams(window.location.search).get("token") || "";
                        const apiUrl = qToken ? ("/admin/api/delete?token=" + encodeURIComponent(qToken)) : "/admin/api/delete";
                        await fetch(apiUrl, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }

                    async function clearInvalidUsers() {
                        const confirmMsg = ["⚠️ 确定一键清理所有失效用户？", "", "系统将自动检测并移除：", "1. 账号已过期的用户", "2. 流量已耗尽超额的用户", "3. 已被手动冻结禁用的用户", "", "此操作不可逆！"].join("\\n");
                        if (!confirm(confirmMsg)) return;
                        try {
                            const res = await fetch("/admin/api/clear-invalid", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" }
                            });
                            const data = await res.json();
                            if (res.ok) {
                                showToast("已成功清理 " + data.removedCount + " 位失效用户！");
                                setTimeout(() => location.reload(), 600);
                            } else {
                                alert(data.error || "清理失败");
                            }
                        } catch (e) {
                            alert("网络通信异常: " + e.message);
                        }
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
                    <div style="position: fixed; top: 16px; right: 16px; z-index: 100;">
                        <a href="/admin" style="display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; background: #ffffff; border: 1px solid var(--el-border); border-radius: 6px; font-size: 13px; font-weight: 500; color: var(--el-text-sub); text-decoration: none; box-shadow: 0 2px 6px rgba(0,0,0,0.06); transition: all 0.2s;" onmouseover="this.style.borderColor='var(--el-primary)';this.style.color='var(--el-primary)'" onmouseout="this.style.borderColor='var(--el-border)';this.style.color='var(--el-text-sub)'">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                            管理后台
                        </a>
                    </div>
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
                        <div class="toggle-box" id="toggleBtn" onclick="toggleMode()" style="${siteSettings.allowRegistration ? '' : 'color:var(--el-text-sub); cursor:default;'}">${siteSettings.allowRegistration ? '新用户？点此注册账号' : '新用户注册通道已暂停'}</div>
                        <div style="text-align: center; margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--el-border); font-size: 13px; color: var(--el-text-sub);">
                            系统管理员？<a href="/admin" style="color: var(--el-primary); text-decoration: none; font-weight: 500;">点此进入管理后台 &rarr;</a>
                        </div>
                    </div>

                    <script>
                        let isRegister = false;
                        const isRegistrationOpen = ${siteSettings.allowRegistration};

                        function toggleMode() {
                            if (!isRegistrationOpen && !isRegister) {
                                showError("系统当前已暂停开放新用户注册，如需使用请联系管理员。");
                                return;
                            }
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

        const baseSubUrl = getEffectiveSubBaseUrl(req, currentUser.uuid);
        const clashSubUrl = `${baseSubUrl}${baseSubUrl.includes("?") ? "&" : "?"}type=clash`;

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
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <a href="/admin" style="display: inline-flex; align-items: center; gap: 5px; color: var(--el-text-regular); border: 1px solid var(--el-border); text-decoration: none; font-size: 13px; font-weight: 500; padding: 6px 12px; border-radius: 4px; background: #ffffff; transition: all 0.2s;" onmouseover="this.style.borderColor='var(--el-primary)';this.style.color='var(--el-primary)'" onmouseout="this.style.borderColor='var(--el-border)';this.style.color='var(--el-text-regular)'">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                                管理总控
                            </a>
                            <a href="/logout" class="logout-btn">安全退出</a>
                        </div>
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
                        <div class="sub-section-desc">${appConfig.isTunnelAvailable ? '支持全协议直连、Argo 隧道穿透与多节点异地集群下发' : '支持全协议高速直连接入与多节点异地集群下发'}</div>

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

                    <!-- 常用代理客户端下载卡片 -->
                    <div class="dashboard-card" style="margin-top: 16px;">
                        <div class="sub-section-title" style="margin-bottom: 6px;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" color="var(--el-primary)"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            常用代理客户端官方下载
                        </div>
                        <div class="sub-section-desc" style="margin-bottom: 14px;">一键直达各大主流系统平台官方 Release 与应用商店，下载后导入上方订阅即可高速联网：</div>

                        <div style="display: flex; flex-direction: column; gap: 10px;">
                            <!-- Windows -->
                            <div style="background: #fafafa; border: 1px solid var(--el-border); border-radius: 6px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div>
                                    <div style="font-weight: 600; font-size: 13px; color: var(--el-text-main);">💻 Windows 电脑端</div>
                                    <div style="font-size: 12px; color: var(--el-text-sub);">首选推荐 FlClash，支持分流规则与开箱即用系统代理</div>
                                </div>
                                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64-setup.exe" target="_blank" class="btn-action-primary" style="text-decoration: none; padding: 6px 14px; font-size: 12px;">⚡ FlClash 安装包 (.exe)</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64.zip" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">绿色版 (.zip)</a>
                                    <a href="https://github.com/2dust/v2rayN/releases" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-sub); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">v2rayN</a>
                                </div>
                            </div>

                            <!-- Android -->
                            <div style="background: #fafafa; border: 1px solid var(--el-border); border-radius: 6px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div>
                                    <div style="font-weight: 600; font-size: 13px; color: var(--el-text-main);">📱 Android 安卓手机 / 平板</div>
                                    <div style="font-size: 12px; color: var(--el-text-sub);">推荐 FlClash，下载后直接安装并导入上方 Clash 规则订阅</div>
                                </div>
                                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-arm64-v8a.apk" target="_blank" class="btn-action-primary" style="text-decoration: none; padding: 6px 14px; font-size: 12px;">⚡ FlClash 64位 (.apk)</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-armeabi-v7a.apk" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">32位老机型</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-x86_64.apk" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">模拟器/x86</a>
                                </div>
                            </div>

                            <!-- macOS -->
                            <div style="background: #fafafa; border: 1px solid var(--el-border); border-radius: 6px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div>
                                    <div style="font-weight: 600; font-size: 13px; color: var(--el-text-main);">🍎 macOS (苹果电脑) & iOS</div>
                                    <div style="font-size: 12px; color: var(--el-text-sub);">Mac 平台原生支持，iPhone/iPad 推荐 AppStore 小火箭</div>
                                </div>
                                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-arm64.dmg" target="_blank" class="btn-action-primary" style="text-decoration: none; padding: 6px 14px; font-size: 12px;">⚡ Mac M系列芯片 (.dmg)</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-amd64.dmg" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">Mac Intel芯片</a>
                                    <a href="https://apps.apple.com/app/shadowrocket/id932747118" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">AppStore 小火箭</a>
                                </div>
                            </div>

                            <!-- Linux -->
                            <div style="background: #fafafa; border: 1px solid var(--el-border); border-radius: 6px; padding: 12px 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                                <div>
                                    <div style="font-weight: 600; font-size: 13px; color: var(--el-text-main);">🐧 Linux 平台客户端</div>
                                    <div style="font-size: 12px; color: var(--el-text-sub);">支持 AppImage 便携格式及主流包管理器</div>
                                </div>
                                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.AppImage" target="_blank" class="btn-action-primary" style="text-decoration: none; padding: 6px 14px; font-size: 12px;">⚡ FlClash AppImage</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.deb" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">Debian/Ubuntu (.deb)</a>
                                    <a href="https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.rpm" target="_blank" class="btn" style="background: #ffffff; border: 1px solid var(--el-border); color: var(--el-text-main); text-decoration: none; padding: 6px 10px; font-size: 12px; border-radius: 4px;">RPM (.rpm)</a>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- 客户端使用指南 -->
                    <div class="guide-card" style="margin-top: 14px;">
                        <div class="guide-title">使用说明与接入建议：</div>
                        • <strong>订阅更新</strong>：客户端添加订阅后建议勾选“自动定时更新”，及时同步集群最新节点策略。<br>
                        • <strong>规则分流</strong>：Clash 客户端内置智能分流规则，国内流量直连直通，外网流量毫秒级路由加速。<br>
                        ${appConfig.isTunnelAvailable ? '• <strong>高可用保障</strong>：如遇本地网络受限，可随时在客户端节点列表中切换“Argo 隧道穿透节点”。' : '• <strong>原生直连</strong>：当前采用宿主机物理全端口直连模式，超低延迟。'}
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

                    // 客户端无感自适应：以浏览器实际访问地址为准，即时自适应校准订阅链接前缀与一键导入
                    (function autoCalibrateSubUrls() {
                        try {
                            var curOrigin = window.location.origin;
                            var curHost = window.location.hostname;
                            if (curHost && curHost !== "127.0.0.1" && curHost !== "localhost") {
                                var subInput = document.getElementById("subUrl");
                                var clashInput = document.getElementById("clashSubUrl");
                                if (subInput && subInput.value) {
                                    var u = new URL(subInput.value, curOrigin);
                                    subInput.value = curOrigin + u.pathname + u.search;
                                }
                                if (clashInput && clashInput.value) {
                                    var u = new URL(clashInput.value, curOrigin);
                                    clashInput.value = curOrigin + u.pathname + u.search;
                                    var importBtn = document.querySelector(".btn-action-import");
                                    if (importBtn) {
                                        importBtn.href = "clash://install-config?url=" + encodeURIComponent(clashInput.value) + "&name=" + encodeURIComponent("Cluster-" + ${JSON.stringify(currentUser.username)});
                                    }
                                }
                            }
                        } catch(e) {}
                    })();

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
                    }, 60000); // 1分钟定时同步一次流量，拒绝频繁轮询浪费资源
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
    }, 60000); // 1分钟聚合刷盘一次，杜绝频繁高频IO开销
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

// ==================== 7. 系统启动 (TCP 嗅探多协议网关) ====================
loadUsers();
loadSettings();
loadIpRegisterLogs();

const serverExternal = http.createServer(handleHttpRequest);
serverExternal.on("upgrade", handleUpgradeRequest);

const CURRENT_PORT = appConfig.port;

// 原生 TCP 嗅探网关：支持同一端口无感分流 HTTP/WS 网页与 VLESS-Reality 原生 TLS 握手
const gatewayServer = net.createServer((clientSocket) => {
    clientSocket.once("data", (firstChunk) => {
        if (!firstChunk || firstChunk.length === 0) {
            clientSocket.destroy();
            return;
        }

        // 探测首字节：0x16 代表 TLS ClientHello (VLESS-Reality 握手)
        if (firstChunk[0] === 0x16) {
            const realityBackend = net.connect(INTERNAL_REALITY_PORT, "127.0.0.1");
            realityBackend.write(firstChunk);
            clientSocket.pipe(realityBackend);
            realityBackend.pipe(clientSocket);
            realityBackend.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => realityBackend.destroy());
        } else {
            // 普通 HTTP 网页访问或 WebSocket 握手，无缝回退交由 Node.js HTTP 引擎处理
            clientSocket.pause();
            clientSocket.unshift(firstChunk);
            serverExternal.emit("connection", clientSocket);
            process.nextTick(() => clientSocket.resume());
        }
    });

    clientSocket.on("error", () => { });
});

let isGatewayListening = false;
let currentBoundPort = null;

function bindPortAndStart(port) {
    gatewayServer.listen(port, "0.0.0.0", () => {
        isGatewayListening = true;
        currentBoundPort = port;
        const displayHost = getEffectiveHost();
        console.log(`[Pterodactyl] ✅ 容器外网服务就绪，真实监听物理端口: ${port} (来源: ${appConfig.portSource})`);
        const extraPorts = appConfig.detectedExtraPorts;
        if (extraPorts.length > 0) {
            console.log(`[Pterodactyl] 🎯 自动探测到附加 Allocations 端口: ${extraPorts.join(", ")} -> 自动开放 Hy2 (${port}) + TUIC (${appConfig.tuicPort}) 双 QUIC 极速通道`);
        } else {
            console.log(`[Pterodactyl] 📦 单端口运行模式: UDP 独占分配给 ${appConfig.udpQuicMode.toUpperCase()} (端口: ${port})`);
        }
        const adminTip = appConfig.adminToken
            ? `http://${displayHost}:${port}/admin (或一键直通: http://${displayHost}:${port}/admin?token=${appConfig.adminToken})`
            : `http://${displayHost}:${port}/admin (⚠️ 提示: .env 未配置 ADMIN_TOKEN，后台处于锁定保护)`;
        console.log(`[Admin] 后台管理入口就绪: ${adminTip}`);
        checkSecurityStatus();
        initSingboxCore();
        initAndStartCloudflared();
    });
}

function startOrUpdateGateway() {
    const port = appConfig.port;
    if (!port) {
        console.warn("================================================================================");
        console.warn("🛑  [Pterodactyl 端口未就绪] 挂起等待端口配置，坚决杜绝假端口兜底！");
        console.warn(`📋  当前容器检测到的全部环境变量: [${Object.keys(process.env).join(", ")}]`);
        console.warn("👉  卡塔服务器使用翼龙分配的随机端口，绝不私自监听假端口避免 521 故障！");
        console.warn("👉  请查看翼龙面板顶部/Allocations 分配的真实端口 (如 51.75.118.169:XXXXX)；");
        console.warn("👉  在 /home/container/.env 文件中填写: SERVER_PORT=你的分配端口 (例如 SERVER_PORT=34567)");
        console.warn("👉  保存后，系统将自动毫秒级热唤醒启动并监听该真实端口，绝不崩溃！");
        console.warn("================================================================================");
        return;
    }

    if (isGatewayListening) {
        if (currentBoundPort === port) return;
        console.log(`[Pterodactyl] 🔄 检测到端口配置变更: ${currentBoundPort} -> ${port}，正在热迁移监听...`);
        try {
            gatewayServer.close(() => {
                isGatewayListening = false;
                bindPortAndStart(port);
                safeReloadSingbox();
            });
        } catch (e) {
            bindPortAndStart(port);
        }
    } else {
        bindPortAndStart(port);
    }
}

// 启动入口
startOrUpdateGateway();

if (appConfig.isTunnelAvailable) {
    const serverTunnel = http.createServer(handleHttpRequest);
    serverTunnel.on("upgrade", handleUpgradeRequest);
    serverTunnel.listen(PORT_TUNNEL, "0.0.0.0", () => {
        console.log(`[Tunnel] Argo 回源端口就绪: ${PORT_TUNNEL}`);
    });
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        generateSingboxConfig,
        getStructuredNodesForUser,
        getNodesForUser,
        generateClashConfig,
        parseCmApiLines,
        parseCustomDomainLine,
        fetchCmApiIps,
        appConfig,
        siteSettings
    };
}
