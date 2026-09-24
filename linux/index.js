#!/usr/bin/env node

/**
 * ==============================================================================
 *  V3 极轻量多协议节点管理控制中枢 - 全Linux发行版自适应版 (Ubuntu / Debian / Alpine / CentOS / Alma / Rocky / Arch 全生态自适应)
 *  特点：
 *  1. 所有业务/端口/路径/配额/运营参数全部集中置顶定义，一目了然，开箱即改；
 *  2. 支持 .env 文件与环境变量优先覆盖，留空则自动回退至置顶默认值；
 *  3. 原生适配 Alpine Linux 3.22 极简容器环境，集成 musl 库自愈与工具链检测。
 * ==============================================================================
 */

// ==================== 视图层解耦模块 (主页/用户控制台/管理后台独立维护) ====================
const { renderLandingPage } = require("./views/landing");
const { renderDashboard } = require("./views/dashboard");
const { renderAdminPage } = require("./views/admin");

const http = require("http");
const https = require("https");
const url = require("url");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { exec, execSync, spawn } = require("child_process");
const crypto = require("crypto");

// ==============================================================================
// 🔑【置顶最优先】: 在所有变量声明前同步读取 .env，确保 SERVER_PORT 等覆盖面板注入值
// ==============================================================================
(function earlyLoadEnv() {
    const candidates = [
        path.join(__dirname, ".env"),
        path.join(__dirname, "../.env"),
        path.join(process.cwd(), ".env"),
    ];
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
            const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
            for (const line of lines) {
                const t = line.trim();
                if (!t || t.startsWith("#")) continue;
                const eq = t.indexOf("=");
                if (eq <= 0) continue;
                const key = t.slice(0, eq).trim();
                let val = t.slice(eq + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) ||
                    (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (val !== "") {
                    process.env[key] = val;
                }
            }
            if (process.env.SERVER_PORT) {
                process.env.PORT = process.env.SERVER_PORT;
            }
            console.log(`[Env-Early] .env 已提前载入: ${p}`);
            break;
        } catch (e) {
            console.warn(`[Env-Early] 读取异常: ${e.message}`);
        }
    }
})();

// ==============================================================================
// 🌟【第一部分：全局所有配置变量集中置顶区】(可在面板直接修改，亦支持 .env 覆盖)
// ==============================================================================

// -------------------- 1. 外部服务网络与管理员安全配置 --------------------
// 外部服务对外监听端口 (未设置则默认 10809)
let SERVER_PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || "10809", 10) || 10809;

// 宿主机公网 IP (严禁硬编码默认真实IP，留空由系统通过接口自动探测公网 IP)
let DIRECT_IP = (process.env.SERVER_IP || "").trim();

// 管理员后台登录密码与授权 Token (严禁硬编码默认密码，留空自动生成随机临时密码)
let ADMIN_TOKEN = (process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || "").trim();
if (!ADMIN_TOKEN) {
    ADMIN_TOKEN = crypto.randomBytes(4).toString("hex");
    console.log("[Security] 提示：未在 .env 中设置 ADMIN_TOKEN，已自动生成本次管理Token: " + ADMIN_TOKEN);
}

// -------------------- 1.1 独立多协议多端口配置 (全部从 .env 读取，未填则禁用) --------------------
// Hysteria 2 (Hy2, 基于 UDP/QUIC 暴力抗丢包) — 未配置时为 0 (禁用)
let PORT_HY2 = parseInt(process.env.PORT_HY2 || "0", 10);
let ENABLE_HY2 = process.env.ENABLE_HY2 !== "false";

// 10900 - 10909: Hysteria 2 专属端口跳跃配置 (防运营商大流量 UDP QoS 限速)
let ENABLE_HY2_HOP = process.env.ENABLE_HY2_HOP !== "false";
let HY2_HOP_PORTS = process.env.HY2_HOP_PORTS || "";
let HY2_HOP_INTERVAL = process.env.HY2_HOP_INTERVAL || "30s";


// TUIC v5 (基于 UDP/QUIC 0-RTT 极低延迟) — 未配置时为 0 (禁用)
let PORT_TUIC = parseInt(process.env.PORT_TUIC || "0", 10);
let ENABLE_TUIC = process.env.ENABLE_TUIC !== "false";

// VLESS-Reality (基于 TCP/TLS 偷跑官方大站证书，抗审查防封锁顶级) — 未配置时为 0 (禁用)
let PORT_REALITY = parseInt(process.env.PORT_REALITY || "0", 10);
let ENABLE_REALITY = process.env.ENABLE_REALITY !== "false";
let REALITY_DEST = process.env.REALITY_DEST || "addons.mozilla.org";
let REALITY_PORT = parseInt(process.env.REALITY_PORT || "443", 10);

// VLESS-TCP 原生纯直连 (无 WS 封装开销，延迟极低) — 未配置时为 0 (禁用)
let PORT_VLESS_TCP = parseInt(process.env.PORT_VLESS_TCP || "0", 10);
let ENABLE_VLESS_TCP = process.env.ENABLE_VLESS_TCP !== "false";

// Trojan-TCP 原生纯直连 — 未配置时为 0 (禁用)
let PORT_TROJAN_TCP = parseInt(process.env.PORT_TROJAN_TCP || "0", 10);
let ENABLE_TROJAN_TCP = process.env.ENABLE_TROJAN_TCP !== "false";

// Shadowsocks 2022 AEAD 单端口 — 未配置时为 0 (禁用)
let PORT_SS = parseInt(process.env.PORT_SS || "0", 10);
let ENABLE_SS = process.env.ENABLE_SS !== "false";
let SS_METHOD = process.env.SS_METHOD || "2022-blake3-aes-128-gcm";

// Socks5 带认证独立代理端口 — 未配置时为 0 (禁用)
let PORT_SOCKS5 = parseInt(process.env.PORT_SOCKS5 || "0", 10);
let ENABLE_SOCKS5 = process.env.ENABLE_SOCKS5 !== "false";

// -------------------- 2. Cloudflare Argo 隧道与优选域名 --------------------
// Cloudflare Argo 隧道 Token (留空则不开启 Argo，直接使用 DIRECT_IP 直连)
let ARGO_TOKEN = process.env.ARGO_TOKEN || "";

// Argo 隧道映射绑定的完整域名
let ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";

// CDN 优选加速域名 (留空则默认使用 ARGO_DOMAIN)
let OPTIMIZED_DOMAIN = process.env.OPTIMIZED_DOMAIN || "";

// -------------------- 3. 异地集群扩展节点 (可选) --------------------
// 外部集群节点配置 JSON 数组字符串
let EXTRA_NODES_RAW = process.env.EXTRA_NODES || "";
let extraNodesConfig = [];
try {
    if (EXTRA_NODES_RAW && EXTRA_NODES_RAW.trim() !== "") {
        extraNodesConfig = JSON.parse(EXTRA_NODES_RAW);
    }
} catch (e) {
    console.warn("[Cluster] 外部集群节点配置解析异常:", e.message);
}

// -------------------- 4. 内部代理分流端口与本地工作路径 --------------------
const PORT_TUNNEL = parseInt(process.env.PORT_TUNNEL || "8001", 10);
const INTERNAL_VMESS_PORT = parseInt(process.env.INTERNAL_VMESS_PORT || "10011", 10);
const INTERNAL_VLESS_PORT = parseInt(process.env.INTERNAL_VLESS_PORT || "10012", 10);
const INTERNAL_TROJAN_PORT = parseInt(process.env.INTERNAL_TROJAN_PORT || "10013", 10);
const PORT_CLASH_API = parseInt(process.env.PORT_CLASH_API || "19090", 10);

const WORK_DIR = process.env.WORK_DIR || __dirname;

// 数据存储目录 (支持自定义，默认 ./data 或 ../../data)
const DATA_DIR = process.env.DATA_DIR || (
    fs.existsSync(path.join(__dirname, "../../data"))
        ? path.join(__dirname, "../../data")
        : path.join(__dirname, "data")
);
const defaultDataDir = DATA_DIR;
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

let USERS_FILE = path.join(DATA_DIR, "v3_users.json");
let CONFIG_FILE = path.join(DATA_DIR, "v3_config.json");
let SETTINGS_FILE = path.join(DATA_DIR, "v3_settings.json");
let CLIENT_DOWNLOADS_FILE = path.join(DATA_DIR, "v3_client_downloads.json");
let PID_FILE = path.join(WORK_DIR, "singbox.pid");

let SINGBOX_BIN = process.env.SINGBOX_BIN || path.join(WORK_DIR, "sing-box");
let CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || path.join(WORK_DIR, "cloudflared");
let TLS_CERT_PATH = path.join(DATA_DIR, "tls_cert.pem");
let TLS_KEY_PATH = path.join(DATA_DIR, "tls_key.pem");
let REALITY_KEYS_FILE = path.join(DATA_DIR, "reality_keys.json");
let SS_KEY_FILE = path.join(DATA_DIR, "ss_secret.key");

let realityState = { privateKey: "", publicKey: "", shortId: "16888888" };
let ssSecretState = "";


// -------------------- 5. 初始试用与站点运营默认配额 --------------------
const DEFAULT_ALLOW_REGISTER = process.env.DEFAULT_ALLOW_REGISTER !== "false"; // 是否开放自主注册
const DEFAULT_ENABLE_CLIENT_DOWNLOAD = process.env.DEFAULT_ENABLE_CLIENT_DOWNLOAD !== "false"; // 是否开启客户端下载
const DEFAULT_DAYS = parseInt(process.env.DEFAULT_DAYS || "3", 10); // 初始试用天数
const DEFAULT_TRAFFIC_VAL = parseInt(process.env.DEFAULT_TRAFFIC_VAL || "10", 10); // 初始流量数值
const DEFAULT_TRAFFIC_UNIT = process.env.DEFAULT_TRAFFIC_UNIT || "GB"; // 流量单位: MB / GB / TB
const DEFAULT_MAX_ONLINE_IPS = parseInt(process.env.DEFAULT_MAX_ONLINE_IPS || "0", 10); // 初始并发限制 (0 不限)
const DEFAULT_IP_LIMIT_POLICY = process.env.DEFAULT_IP_LIMIT_POLICY || "kick_oldest"; // 超额策略
const DEFAULT_IDLE_DISCONNECT_ENABLED = process.env.DEFAULT_IDLE_DISCONNECT !== "false"; // 初始空闲自动断链
const DEFAULT_IDLE_TIMEOUT_SECONDS = parseInt(process.env.DEFAULT_IDLE_TIMEOUT_SECONDS || "60", 10); // 初始空闲秒数
const DEFAULT_CONTACT_TEXT = process.env.DEFAULT_CONTACT_TEXT || "Telegram: @abcai"; // 站长联系方式文案
const DEFAULT_CONTACT_URL = process.env.DEFAULT_CONTACT_URL || "https://t.me/abcai"; // 站长联系链接

const defaultSettings = {
    allowRegister: DEFAULT_ALLOW_REGISTER,
    enableClientDownload: DEFAULT_ENABLE_CLIENT_DOWNLOAD,
    defaultDays: DEFAULT_DAYS,
    defaultTrafficVal: DEFAULT_TRAFFIC_VAL,
    defaultTrafficUnit: DEFAULT_TRAFFIC_UNIT,
    defaultTrafficGB: DEFAULT_TRAFFIC_VAL,
    defaultMaxOnlineIps: DEFAULT_MAX_ONLINE_IPS,
    defaultIpLimitPolicy: DEFAULT_IP_LIMIT_POLICY,
    defaultIdleDisconnectEnabled: DEFAULT_IDLE_DISCONNECT_ENABLED,
    defaultIdleTimeoutSeconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
    contactText: DEFAULT_CONTACT_TEXT,
    contactUrl: DEFAULT_CONTACT_URL
};

let siteSettings = { ...defaultSettings };

// -------------------- 6. 默认客户端下载列表预置 --------------------
const DEFAULT_CLIENT_DOWNLOADS = [
    { platform: "安卓 (arm64)", fileName: "FlClash-0.8.94-android-arm64-v8a.apk", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-arm64-v8a.apk" },
    { platform: "安卓 (armeabi)", fileName: "FlClash-0.8.94-android-armeabi-v7a.apk", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-armeabi-v7a.apk" },
    { platform: "安卓 (x86)", fileName: "FlClash-0.8.94-android-x86_64.apk", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-android-x86_64.apk" },
    { platform: "Linux (AppImage)", fileName: "FlClash-0.8.94-linux-amd64.AppImage", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.AppImage" },
    { platform: "Linux (Debian)", fileName: "FlClash-0.8.94-linux-amd64.deb", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.deb" },
    { platform: "Linux (RPM)", fileName: "FlClash-0.8.94-linux-amd64.rpm", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-linux-amd64.rpm" },
    { platform: "macOS (Intel)", fileName: "FlClash-0.8.94-macos-amd64.dmg", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-amd64.dmg" },
    { platform: "macOS (ARM)", fileName: "FlClash-0.8.94-macos-arm64.dmg", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-macos-arm64.dmg" },
    { platform: "Windows (安装程序)", fileName: "FlClash-0.8.94-windows-amd64-setup.exe", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64-setup.exe" },
    { platform: "Windows (压缩包)", fileName: "FlClash-0.8.94-windows-amd64.zip", url: "https://dl.p6p.net/FlClash/v0.8.94/FlClash-0.8.94-windows-amd64.zip" }
];
let clientDownloads = [...DEFAULT_CLIENT_DOWNLOADS];

// -------------------- 7. 全局运行时状态与安全凭据 --------------------
const GLOBAL_SALT = process.env.GLOBAL_SALT || "_system_unified_salt_2026_pro";
let globalTunnelServer = null;
let singboxProcess = null;
let isReloading = false;
let isTunnelAvailable = false; // 用户已指定不开启隧道，彻底禁用

const activeSessions = new Map();       // user session: token -> username
const adminSessions = new Map();        // admin session: token -> expireTime
const registeringUsers = new Map();     // 防并发注册击穿锁: username.toLowerCase() -> timestamp

let isCrawlingDownloads = false;
let lastCrawlTimestamp = 0;

// -------------------- 8. Alpine 3.22 (alpine322) 容器自愈与下载镜像源 --------------------
// 是否在 Alpine 容器缺失基础工具时自动执行 apk 补充安装
const LINUX_AUTO_INSTALL = (process.env.LINUX_AUTO_INSTALL !== "false") && (process.env.ALPINE_AUTO_INSTALL !== "false");
const ALPINE_AUTO_INSTALL = LINUX_AUTO_INSTALL;

// Sing-box 核心自定义镜像源 (留空则默认官方 GitHub Release)
const SINGBOX_DOWNLOAD_MIRROR = process.env.SINGBOX_DOWNLOAD_MIRROR || "";

// Cloudflared 核心自定义镜像源 (留空则默认官方 GitHub Release)
const CLOUDFLARED_DOWNLOAD_MIRROR = process.env.CLOUDFLARED_DOWNLOAD_MIRROR || "";

// ==============================================================================
// 🌟【第二部分：配置载入与环境自愈初始化】
// ==============================================================================

// 原生自适应加载 .env 配置文件
function loadEnv() {
    const candidatePaths = [
        path.join(__dirname, ".env"),
        path.join(__dirname, "../.env"),
        path.join(process.cwd(), ".env")
    ];
    for (const envPath of candidatePaths) {
        if (fs.existsSync(envPath)) {
            try {
                const envContent = fs.readFileSync(envPath, "utf8");
                envContent.split(/\r?\n/).forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith("#")) return;
                    const eqIdx = trimmed.indexOf("=");
                    if (eqIdx > 0) {
                        const key = trimmed.slice(0, eqIdx).trim();
                        let val = trimmed.slice(eqIdx + 1).trim();
                        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                            val = val.slice(1, -1);
                        }
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                });
                console.log(`[Env] 成功读取并载入环境变量: ${envPath}`);
                break;
            } catch (e) {
                console.warn(`[Env] 读取 .env 异常: ${e.message}`);
            }
        }
    }

    // 重新将环境变量注入置顶变量
    if (process.env.SERVER_PORT || process.env.PORT) {
        SERVER_PORT = parseInt(process.env.SERVER_PORT || process.env.PORT, 10);
    }
    if (process.env.SERVER_IP) DIRECT_IP = process.env.SERVER_IP;
    if (process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD) {
        ADMIN_TOKEN = (process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD).trim();
    }
    if (process.env.ARGO_TOKEN) ARGO_TOKEN = process.env.ARGO_TOKEN;
    if (process.env.ARGO_DOMAIN) ARGO_DOMAIN = process.env.ARGO_DOMAIN;
    if (process.env.OPTIMIZED_DOMAIN) OPTIMIZED_DOMAIN = process.env.OPTIMIZED_DOMAIN;
    isTunnelAvailable = Boolean(ARGO_TOKEN && ARGO_TOKEN.trim() !== "" && ARGO_DOMAIN && ARGO_DOMAIN.trim() !== "");
}

loadEnv();

// 全Linux发行版 (Ubuntu / Debian / Alpine / CentOS / Alma / Rocky / Arch) 环境自适应探测与自愈工具安装
function ensureAdaptiveLinuxEnvironment() {
    try {
        if (process.platform !== "linux") return;

        let osInfo = { id: "unknown", name: "Linux", version: "", isUbuntu: false, isDebian: false, isAlpine: false, isRhel: false, isArch: false };
        if (fs.existsSync("/etc/os-release")) {
            const lines = fs.readFileSync("/etc/os-release", "utf8").split("\n");
            for (const line of lines) {
                const eqIdx = line.indexOf("=");
                if (eqIdx > 0) {
                    const k = line.slice(0, eqIdx).trim();
                    const v = line.slice(eqIdx + 1).replace(/["']/g, "").trim();
                    if (k === "ID") osInfo.id = v.toLowerCase();
                    if (k === "NAME") osInfo.name = v;
                    if (k === "VERSION_ID") osInfo.version = v;
                }
            }
        }
        if (fs.existsSync("/etc/alpine-release")) {
            osInfo.id = "alpine";
            try { osInfo.version = fs.readFileSync("/etc/alpine-release", "utf8").trim(); } catch (_) {}
        }

        osInfo.isUbuntu = osInfo.id.includes("ubuntu");
        osInfo.isDebian = osInfo.id.includes("debian") || osInfo.isUbuntu;
        osInfo.isAlpine = osInfo.id.includes("alpine");
        osInfo.isRhel = ["centos", "rhel", "rocky", "almalinux", "fedora", "ol"].some(x => osInfo.id.includes(x));
        osInfo.isArch = osInfo.id.includes("arch") || osInfo.id.includes("manjaro");

        console.log(`[OS-Detect] 系统自适应感知: ${osInfo.name} (${osInfo.id} ${osInfo.version || ""}), 架构: ${process.arch}`);

        if (LINUX_AUTO_INSTALL) {
            const checkTools = ["curl", "tar", "openssl", "iptables"];
            if (osInfo.isDebian || osInfo.isRhel) {
                checkTools.push("procps");
            }
            const missingTools = [];
            checkTools.forEach(tool => {
                try {
                    execSync(`which ${tool} 2>/dev/null`, { stdio: "ignore" });
                } catch (_) {
                    missingTools.push(tool);
                }
            });

            if (missingTools.length > 0) {
                console.log(`[Adaptive-Linux] 检测到核心工具链缺失: [${missingTools.join(", ")}]，自适应调用包管理器补齐...`);
                try {
                    if (osInfo.isDebian) {
                        execSync(`DEBIAN_FRONTEND=noninteractive apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates ${missingTools.join(" ")}`, { stdio: "inherit" });
                        console.log("[Adaptive-Linux] Ubuntu / Debian 工具链补齐就绪！");
                    } else if (osInfo.isAlpine) {
                        execSync(`apk update && apk add --no-cache ca-certificates ${missingTools.join(" ")}`, { stdio: "inherit" });
                        console.log("[Adaptive-Linux] Alpine Linux 工具链补齐就绪！");
                    } else if (osInfo.isRhel) {
                        execSync(`(command -v dnf >/dev/null 2>&1 && dnf install -y ca-certificates ${missingTools.join(" ")}) || yum install -y ca-certificates ${missingTools.join(" ")}`, { stdio: "inherit" });
                        console.log("[Adaptive-Linux] RHEL / CentOS / Rocky 工具链补齐就绪！");
                    } else if (osInfo.isArch) {
                        execSync(`pacman -Sy --noconfirm ca-certificates ${missingTools.join(" ")}`, { stdio: "inherit" });
                        console.log("[Adaptive-Linux] Arch Linux 工具链补齐就绪！");
                    }
                } catch (installErr) {
                    console.warn(`[Adaptive-Linux] 包管理器自愈提示 (若无 root 权限可忽略): ${installErr.message}`);
                }
            }
        }
    } catch (e) {
        // 忽略非致命环境自适应异常
    }
}
const ensureAlpineEnvironment = ensureAdaptiveLinuxEnvironment;

// ==================== 多协议凭据、自签证书与 Reality 密钥自愈初始化 ====================
function ensureMultiProtocolSecrets() {
    try {
        // 1. 初始化自签 TLS 证书 (用于 Hysteria 2 与 TUIC)
        if (!fs.existsSync(TLS_CERT_PATH) || !fs.existsSync(TLS_KEY_PATH)) {
            console.log("[Crypto-Engine] 正在生成 Hysteria 2 / TUIC 专用自签 TLS 证书...");
            try {
                execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "${TLS_KEY_PATH}" -out "${TLS_CERT_PATH}" -days 3650 -subj "/CN=${REALITY_DEST}" 2>/dev/null`);
                console.log("[Crypto-Engine] 自签 TLS 证书生成成功！");
            } catch (e) {
                console.warn("[Crypto-Engine] openssl 生成证书异常:", e.message);
            }
        }

        // 2. 初始化 Reality 密钥对与 ShortId
        if (fs.existsSync(REALITY_KEYS_FILE)) {
            try {
                const raw = JSON.parse(fs.readFileSync(REALITY_KEYS_FILE, "utf8"));
                if (raw.privateKey && raw.publicKey) {
                    realityState = raw;
                }
            } catch (_) {}
        }
        if (!realityState.privateKey || !realityState.publicKey) {
            console.log("[Crypto-Engine] 正在初始化 VLESS-Reality 密钥对与 ShortId...");
            try {
                let pKey = "", pubKey = "", shortId = crypto.randomBytes(4).toString("hex");
                if (fs.existsSync(SINGBOX_BIN)) {
                    try {
                        const out = execSync(`"${SINGBOX_BIN}" generate reality-keypair`).toString();
                        const mPriv = out.match(/PrivateKey:\s*([^\s]+)/i);
                        const mPub = out.match(/PublicKey:\s*([^\s]+)/i);
                        if (mPriv && mPub) {
                            pKey = mPriv[1].trim();
                            pubKey = mPub[1].trim();
                        }
                    } catch (_) {}
                }
                if (!pKey || !pubKey) {
                    pKey = "sBcdltAktY4joWSmBsepqeAONWK0UOr3YGlzfO09Zlg";
                    pubKey = "69AStdzMh4yMRcSkzb5UKCVnd7vq_lvauBmEFtOKjX4";
                }
                realityState = { privateKey: pKey, publicKey: pubKey, shortId: shortId };
                fs.writeFileSync(REALITY_KEYS_FILE, JSON.stringify(realityState, null, 2), "utf8");
                console.log("[Crypto-Engine] Reality 密钥对就绪 (PublicKey: " + pubKey + ")");
            } catch (err) {
                console.warn("[Crypto-Engine] Reality 密钥生成异常:", err.message);
            }
        }

        // 3. 初始化 Shadowsocks 2022 随机密钥
        if (fs.existsSync(SS_KEY_FILE)) {
            try {
                ssSecretState = fs.readFileSync(SS_KEY_FILE, "utf8").trim();
            } catch (_) {}
        }
        if (!ssSecretState) {
            ssSecretState = crypto.randomBytes(16).toString("base64");
            try { fs.writeFileSync(SS_KEY_FILE, ssSecretState, "utf8"); } catch (_) {}
        }
    } catch (err) {
        console.warn("[Crypto-Engine] 多协议密钥引擎自检异常:", err.message);
    }
}

// 派生用户专属 Shadowsocks 2022 预共享密钥 (2022-blake3-aes-128-gcm 要求 16 字节 Base64 编码)
function getUserSsKey(uuid) {
    if (!uuid) return "";
    return crypto.createHash("sha256").update(String(uuid) + ":ss2022").digest().subarray(0, 16).toString("base64");
}

ensureAdaptiveLinuxEnvironment();
ensureMultiProtocolSecrets();
applyHy2PortHoppingRules();
// ==================== Hysteria 2 端口跳跃 iptables NAT 自动规则 ====================
function applyHy2PortHoppingRules() {
    if (!ENABLE_HY2 || !ENABLE_HY2_HOP || !HY2_HOP_PORTS || !PORT_HY2 || PORT_HY2 <= 0) return;
    if (process.platform !== "linux") return;

    try {
        const portRangeFormatted = HY2_HOP_PORTS.replace("-", ":");
        // 幂等清理旧规则
        try {
            execSync(`iptables -t nat -D PREROUTING -p udp --dport ${portRangeFormatted} -j REDIRECT --to-ports ${PORT_HY2} 2>/dev/null || true`);
        } catch (_) {}
        
        // 写入重定向规则
        execSync(`iptables -t nat -A PREROUTING -p udp --dport ${portRangeFormatted} -j REDIRECT --to-ports ${PORT_HY2}`);
        console.log(`[Port-Hopping] Hy2 端口跳跃规则配置成功: UDP ${HY2_HOP_PORTS} -> ${PORT_HY2}`);
    } catch (e) {
        console.warn(`[Port-Hopping] 配置 iptables 规则提示:`, e.message);
    }
}


function loadSettings() {
    const candidateFiles = [
        SETTINGS_FILE,
        path.join(WORK_DIR, "v3_settings.json"),
        path.join(WORK_DIR, "settings.json"),
        path.join(WORK_DIR, "data", "v3_settings.json")
    ];
    for (const fPath of candidateFiles) {
        if (fPath && fs.existsSync(fPath)) {
            try {
                const raw = fs.readFileSync(fPath, "utf8").trim();
                if (raw.length > 0) {
                    const parsed = JSON.parse(raw);
                    siteSettings = Object.assign({}, defaultSettings, parsed);
                    console.log(`[Settings] 站点与注册配置载入成功 (${path.basename(fPath)})`);
                    return;
                }
            } catch (e) {
                console.warn(`[Settings] 读取配置异常 (${fPath}):`, e.message);
            }
        }
    }
    siteSettings = { ...defaultSettings };
    saveSettings();
}

function saveSettings() {
    try {
        if (!fs.existsSync(path.dirname(SETTINGS_FILE))) {
            fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(siteSettings, null, 2), "utf8");
        console.log(`[Settings] 站点运营与注册配置已安全同步落盘至: ${SETTINGS_FILE}`);
        return true;
    } catch (err) {
        console.error(`[Settings] 同步落盘写入配置失败 (${SETTINGS_FILE}):`, err.message);
        return false;
    }
}

// 优雅同步原子更新 .env 文件中的键值对
function updateEnvFile(updates) {
    const candidates = [
        path.join(__dirname, ".env"),
        path.join(__dirname, "../.env"),
        path.join(process.cwd(), ".env"),
    ];
    let targetPath = candidates.find((p) => fs.existsSync(p)) || path.join(__dirname, ".env");

    let content = "";
    if (fs.existsSync(targetPath)) {
        try {
            content = fs.readFileSync(targetPath, "utf8");
        } catch (_) {}
    }

    const lines = content ? content.split(/\r?\n/) : [];
    const keysHandled = new Set();

    const newLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) return line;
        const key = trimmed.slice(0, eq).trim();
        if (updates.hasOwnProperty(key)) {
            keysHandled.add(key);
            return `${key}=${updates[key]}`;
        }
        return line;
    });

    for (const [k, v] of Object.entries(updates)) {
        if (!keysHandled.has(k)) {
            newLines.push(`${k}=${v}`);
        }
    }

    try {
        fs.writeFileSync(targetPath, newLines.join("\n"), "utf8");
        console.log(`[Env-Update] 已成功持久化同步更新 .env: ${targetPath}`);
        return true;
    } catch (err) {
        console.error(`[Env-Update] 写入 .env 失败:`, err.message);
        return false;
    }
}

function loadClientDownloads() {
    const candidateFiles = [
        CLIENT_DOWNLOADS_FILE,
        path.join(WORK_DIR, "v3_client_downloads.json"),
        path.join(WORK_DIR, "data", "v3_client_downloads.json")
    ];
    for (const fPath of candidateFiles) {
        if (fPath && fs.existsSync(fPath)) {
            try {
                const raw = fs.readFileSync(fPath, "utf8").trim();
                if (raw.length > 0) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        clientDownloads = parsed;
                        console.log(`[ClientDownloads] 成功载入客户端下载列表 (${clientDownloads.length} 条)`);
                        return;
                    }
                }
            } catch (e) {
                console.warn(`[ClientDownloads] 读取缓存异常:`, e.message);
            }
        }
    }
    clientDownloads = [...DEFAULT_CLIENT_DOWNLOADS];
}

function saveClientDownloads() {
    try {
        const dir = path.dirname(CLIENT_DOWNLOADS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CLIENT_DOWNLOADS_FILE, JSON.stringify(clientDownloads, null, 2), "utf8");
    } catch (e) {
        console.warn(`[ClientDownloads] 保存缓存失败:`, e.message);
    }
}

function crawlFlClashDownloads(force = false) {
    const now = Date.now();
    if (!force && now - lastCrawlTimestamp < 15000) {
        return Promise.resolve(clientDownloads);
    }
    if (isCrawlingDownloads) {
        return Promise.resolve(clientDownloads);
    }
    isCrawlingDownloads = true;
    lastCrawlTimestamp = now;

    return new Promise((resolve) => {
        function fetchPage(targetUrl, redirectsRemaining = 3) {
            const req = https.get(targetUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 10000
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsRemaining > 0) {
                    const nextUrl = url.resolve(targetUrl, res.headers.location);
                    return fetchPage(nextUrl, redirectsRemaining - 1);
                }
                if (res.statusCode !== 200) {
                    console.warn(`[Crawler] 抓取下载页面状态异常 (${res.statusCode})`);
                    isCrawlingDownloads = false;
                    return resolve(clientDownloads);
                }
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    isCrawlingDownloads = false;
                    try {
                        const rows = [];
                        const trRegex = /<tr>\s*<td>(.*?)<\/td>\s*<td>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>\s*<\/td>\s*<\/tr>/gi;
                        let match;
                        while ((match = trRegex.exec(data)) !== null) {
                            const platform = match[1].replace(/<[^>]+>/g, '').trim();
                            const downloadUrl = match[2].trim();
                            const fileName = match[3].replace(/<[^>]+>/g, '').trim();
                            if (platform && downloadUrl && !platform.includes('平台')) {
                                rows.push({ platform, fileName, url: downloadUrl });
                            }
                        }
                        if (rows.length > 0) {
                            clientDownloads = rows;
                            saveClientDownloads();
                            console.log(`[Crawler] 成功爬取并更新 ${rows.length} 个客户端下载链接`);
                        }
                        resolve(clientDownloads);
                    } catch (e) {
                        console.warn(`[Crawler] 解析下载表格异常:`, e.message);
                        resolve(clientDownloads);
                    }
                });
            });
            req.on('error', (err) => {
                console.warn(`[Crawler] 抓取请求失败:`, err.message);
                isCrawlingDownloads = false;
                resolve(clientDownloads);
            });
            req.on('timeout', () => {
                req.destroy();
                console.warn(`[Crawler] 抓取超时`);
                isCrawlingDownloads = false;
                resolve(clientDownloads);
            });
        }

        fetchPage('https://flclash.cc/en/download.html');
    });
}

// ==================== 1.1 IP 归属地极速查询引擎 (多源兜底 + 本地持久内存缓存) ====================
const ipGeoCache = new Map();

function isPrivateIp(ip) {
    if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    if (ip.startsWith("172.")) {
        const parts = ip.split(".");
        const second = parseInt(parts[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

function lookupIpLocation(ip) {
    if (!ip) return Promise.resolve("未知地址");
    if (isPrivateIp(ip)) return Promise.resolve("局域网 / 回环地址");
    if (ipGeoCache.has(ip)) return Promise.resolve(ipGeoCache.get(ip));

    return new Promise((resolve) => {
        // 数据源 1: ip-api.com 中文归属地与 ISP
        const req = http.get(`http://ip-api.com/json/${ip}?lang=zh-CN`, { timeout: 3500 }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (json.status === "success") {
                        const parts = [];
                        if (json.country && json.country !== "中国") parts.push(json.country);
                        if (json.regionName) parts.push(json.regionName);
                        if (json.city && json.city !== json.regionName) parts.push(json.city);
                        if (json.isp) parts.push(json.isp);
                        const result = parts.join(" ") || json.country || "公网地址";
                        ipGeoCache.set(ip, result);
                        return resolve(result);
                    }
                } catch (_) {}
                fallbackWhois();
            });
        });
        req.on("error", fallbackWhois);
        req.setTimeout(3500, () => {
            req.destroy();
            fallbackWhois();
        });

        // 数据源 2: ipwho.is 备用 HTTPS 兜底
        function fallbackWhois() {
            try {
                const https = require("https");
                const hreq = https.get(`https://ipwho.is/${ip}?lang=zh-CN`, { timeout: 3500 }, (hres) => {
                    let hdata = "";
                    hres.on("data", (c) => (hdata += c));
                    hres.on("end", () => {
                        try {
                            const hj = JSON.parse(hdata);
                            if (hj.success !== false) {
                                const parts = [];
                                if (hj.country && hj.country !== "中国") parts.push(hj.country);
                                if (hj.region) parts.push(hj.region);
                                if (hj.city && hj.city !== hj.region) parts.push(hj.city);
                                if (hj.connection && hj.connection.isp) parts.push(hj.connection.isp);
                                const result = parts.join(" ") || hj.country || "公网地址";
                                ipGeoCache.set(ip, result);
                                return resolve(result);
                            }
                        } catch (_) {}
                        ipGeoCache.set(ip, "公网地址");
                        resolve("公网地址");
                    });
                });
                hreq.on("error", () => {
                    ipGeoCache.set(ip, "公网地址");
                    resolve("公网地址");
                });
                hreq.setTimeout(3500, () => {
                    hreq.destroy();
                    ipGeoCache.set(ip, "公网地址");
                    resolve("公网地址");
                });
            } catch (_) {
                ipGeoCache.set(ip, "公网地址");
                resolve("公网地址");
            }
        }
    });
}

function getClientIp(req, socket) {
    let ip = (req.headers && req.headers["cf-connecting-ip"]) ||
             (req.headers && req.headers["x-real-ip"]) ||
             (req.headers && req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"].split(",")[0].trim() : "") ||
             (socket && socket.remoteAddress) ||
             (req.socket && req.socket.remoteAddress) ||
             "";
    if (ip.startsWith("::ffff:")) ip = ip.substring(7);
    if (ip === "::1") ip = "127.0.0.1";
    return ip;
}

// 节点在线活跃状态感知存储: uuid -> { activeConnections, lastSeenAt, lastIp, lastLocation, activeList }
const userActivityMap = new Map();

function getUserActivity(uuid) {
    if (!userActivityMap.has(uuid)) {
        userActivityMap.set(uuid, {
            activeConnections: 0,
            lastSeenAt: 0,
            lastIp: "",
            lastLocation: "",
            activeList: []
        });
    }
    const act = userActivityMap.get(uuid);
    if (!act.activeList) act.activeList = [];
    return act;
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
    let loaded = false;
    const candidateFiles = [
        USERS_FILE,
        path.join(WORK_DIR, "users.json"),
        path.join(WORK_DIR, "data", "users.json")
    ];

    for (const fPath of candidateFiles) {
        if (fPath && fs.existsSync(fPath)) {
            try {
                const raw = fs.readFileSync(fPath, "utf8").trim();
                if (raw.length > 0) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        usersDatabase = parsed;
                        loaded = true;
                    } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.users)) {
                        usersDatabase = parsed.users;
                        loaded = true;
                    }
                    if (loaded) {
                        console.log(`[Database] 数据载入成功 (${path.basename(fPath)})，当前总注册用户: ${usersDatabase.length}`);
                        if (fPath !== USERS_FILE) {
                            saveUsers();
                        }
                        return;
                    }
                }
            } catch (err) {
                console.error(`[Database] 读取文件异常 (${fPath}):`, err.message);
            }
        }
    }

    usersDatabase = [];
    console.log("[Database] 初始化空用户数据库完成，当前总注册用户: 0");
    saveUsers();
}

function saveUsers() {
    if (!Array.isArray(usersDatabase)) usersDatabase = [];
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
    if (!Array.isArray(usersDatabase)) usersDatabase = [];
    return usersDatabase.filter((u) => isUserInvalid(u) === null);
}

// ==================== 3. Sing-box 核心配置与防死锁管理 ====================
function generateSingboxConfig() {
    let activeUsers = getActiveUsers();

    if (activeUsers.length === 0) {
        activeUsers = [{ uuid: "00000000-0000-0000-0000-000000000000" }];
    }

    ensureMultiProtocolSecrets();
    applyHy2PortHoppingRules();

    const inboundsList = [
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
    ];

    // Hysteria 2
    if (ENABLE_HY2 && PORT_HY2 > 0 && fs.existsSync(TLS_CERT_PATH) && fs.existsSync(TLS_KEY_PATH)) {
        inboundsList.push({
            type: "hysteria2",
            tag: "hy2-in",
            listen: "0.0.0.0",
            listen_port: PORT_HY2,
            users: activeUsers.map((u) => ({ password: u.uuid })),
            tls: {
                enabled: true,
                certificate_path: TLS_CERT_PATH,
                key_path: TLS_KEY_PATH
            }
        });
    }

    // TUIC v5
    if (ENABLE_TUIC && PORT_TUIC > 0 && fs.existsSync(TLS_CERT_PATH) && fs.existsSync(TLS_KEY_PATH)) {
        inboundsList.push({
            type: "tuic",
            tag: "tuic-in",
            listen: "0.0.0.0",
            listen_port: PORT_TUIC,
            users: activeUsers.map((u) => ({ uuid: u.uuid, password: u.uuid })),
            congestion_control: "bbr",
            tls: {
                enabled: true,
                certificate_path: TLS_CERT_PATH,
                key_path: TLS_KEY_PATH,
                alpn: ["h3"]
            }
        });
    }

    // VLESS-Reality
    if (ENABLE_REALITY && PORT_REALITY > 0 && realityState.privateKey) {
        inboundsList.push({
            type: "vless",
            tag: "vless-reality-in",
            listen: "0.0.0.0",
            listen_port: PORT_REALITY,
            users: activeUsers.map((u) => ({ uuid: u.uuid })),
            tls: {
                enabled: true,
                server_name: REALITY_DEST,
                reality: {
                    enabled: true,
                    handshake: {
                        server: REALITY_DEST,
                        server_port: REALITY_PORT
                    },
                    private_key: realityState.privateKey,
                    short_id: [realityState.shortId || "16888888", ""]
                }
            }
        });
    }

    // VLESS-TCP 直连
    if (ENABLE_VLESS_TCP && PORT_VLESS_TCP > 0) {
        inboundsList.push({
            type: "vless",
            tag: "vless-tcp-in",
            listen: "0.0.0.0",
            listen_port: PORT_VLESS_TCP,
            users: activeUsers.map((u) => ({ uuid: u.uuid }))
        });
    }

    // Trojan-TCP 直连
    if (ENABLE_TROJAN_TCP && PORT_TROJAN_TCP > 0) {
        inboundsList.push({
            type: "trojan",
            tag: "trojan-tcp-in",
            listen: "0.0.0.0",
            listen_port: PORT_TROJAN_TCP,
            users: activeUsers.map((u) => ({ password: u.uuid }))
        });
    }

    // Shadowsocks 2022 (AEAD 2022 多用户隔离模式：严格跟随 activeUsers 鉴权，过期/超额即断)
    if (ENABLE_SS && PORT_SS > 0 && ssSecretState) {
        const ssUsers = activeUsers.map((u) => ({
            name: u.username || u.uuid,
            password: getUserSsKey(u.uuid)
        }));
        inboundsList.push({
            type: "shadowsocks",
            tag: "ss-in",
            listen: "0.0.0.0",
            listen_port: PORT_SS,
            method: SS_METHOD,
            password: ssSecretState,
            users: ssUsers
        });
    }

    const config = {
        log: {
            level: "warn",
            timestamp: true
        },
        inbounds: inboundsList,
        outbounds: [
            {
                type: "direct",
                tag: "direct"
            }
        ],
        experimental: {
            clash_api: {
                external_controller: `127.0.0.1:${PORT_CLASH_API}`
            }
        }
    };

    const configStr = JSON.stringify(config, null, 2);
    let isConfigChanged = false;
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const currentStr = fs.readFileSync(CONFIG_FILE, "utf8");
            if (currentStr.trim() !== configStr.trim()) {
                isConfigChanged = true;
            }
        } catch (_) {
            isConfigChanged = true;
        }
    } else {
        isConfigChanged = true;
    }

    if (isConfigChanged) {
        safeWriteFileAsync(CONFIG_FILE, configStr);
    }
    return isConfigChanged;
}

// PID_FILE 已在顶部集中声明
let singboxRetryCount = 0;

function killPortOccupants() {
    // 1. 根据 PID 文件精确 kill
    if (fs.existsSync(PID_FILE)) {
        try {
            const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
            if (oldPid && !isNaN(oldPid)) {
                process.kill(oldPid, 'SIGKILL');
            }
        } catch (_) {}
    }

    // 2. Linux 原生 /proc 精准扫描清理 (零外部命令依赖，兼容极简容器)
    if (process.platform === "linux") {
        try {
            const entries = fs.readdirSync('/proc');
            for (const item of entries) {
                if (/^\d+$/.test(item)) {
                    const pid = parseInt(item, 10);
                    if (pid === process.pid) continue;
                    try {
                        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
                        if (cmd.includes('sing-box') && !cmd.includes('node')) {
                            console.log(`[Core] 发现残留代理进程 (PID: ${pid})，正在强制释放...`);
                            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    // 3. 辅助命令查杀 (兼容 Windows 和具备外部工具链的环境)
    try {
        if (process.platform === "win32") {
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
                } catch (e) { }
            });
        } else {
            try { execSync(`pkill -9 -f sing-box 2>/dev/null || true`); } catch (_) {}
            try { execSync(`killall -9 sing-box 2>/dev/null || true`); } catch (_) {}
        }
    } catch (e) { }
}

function safeReloadSingbox(force = false) {
    if (isReloading) return;
    isReloading = true;

    const configChanged = generateSingboxConfig();
    const existingProcess = global.__v3_singbox_process || singboxProcess;

    // 关键防断链保护：如果 Sing-box 正在健康运行，且配置并未发生实质改变，且非强制重载，直接复用已有进程！
    if (!force && existingProcess && !existingProcess.killed && !configChanged) {
        console.log("[Core] Sing-box 核心代理配置无变动，保持现有进程无缝运行。");
        singboxProcess = existingProcess;
        isReloading = false;
        return;
    }

    if (existingProcess) {
        try {
            existingProcess.removeAllListeners();
            existingProcess.kill("SIGKILL");
        } catch (e) { }
        singboxProcess = null;
        global.__v3_singbox_process = null;
    }

    killPortOccupants();

    setTimeout(() => {
        console.log("[Core] 正在拉起 Sing-box 核心代理引擎...");
        singboxProcess = spawn(SINGBOX_BIN, ["run", "-c", CONFIG_FILE], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });
        global.__v3_singbox_process = singboxProcess;

        if (singboxProcess && singboxProcess.pid) {
            try { fs.writeFileSync(PID_FILE, String(singboxProcess.pid)); } catch (_) {}
        }

        singboxProcess.on("error", (err) => {
            console.error(`[Core] Sing-box 启动异常: ${err.message}`);
        });

        singboxProcess.on("exit", (code) => {
            console.warn(`[Core] Sing-box 进程退出 (code: ${code})`);
            singboxProcess = null;

            // 异常退出自动重试自愈守护 (最多自愈拉起 3 次)
            if (code !== 0 && !isReloading) {
                if (singboxRetryCount < 3) {
                    singboxRetryCount++;
                    console.log(`[Core-SelfHealing] 正在执行 Sing-box 故障自愈重试 (${singboxRetryCount}/3)...`);
                    setTimeout(() => {
                        safeReloadSingbox(true);
                    }, 2000);
                }
            } else if (code === 0) {
                singboxRetryCount = 0;
            }
        });

        isReloading = false;
    }, 600);
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
        try { fs.chmodSync(SINGBOX_BIN, "755"); } catch (e) { }
        safeReloadSingbox();
    }
}

function initAndStartCloudflared() {
    // 用户已明确指定不开启隧道，直接跳过
    console.log("[Cloudflared] 已配置为不开启 Argo 隧道，直连模式运行。");
    return;

    if (!isTunnelAvailable) return;
    if (global.__v3_cloudflared_process && !global.__v3_cloudflared_process.killed) {
        console.log("[Cloudflared] 现有 Argo 隧道进程健康运行中，保持复用无需重启。");
        return;
    }
    let retryCount = 0;
    const maxRetries = 3;
    const start = () => {
        if (retryCount >= maxRetries) {
            console.warn("[Cloudflared] 隧道连接多次失败，已自动停止重试。若不需要 Argo 穿透请保持 ARGO_TOKEN 留空。");
            return;
        }
        const tunnel = spawn(CLOUDFLARED_BIN, ["tunnel", "--no-autoupdate", "run", "--token", ARGO_TOKEN], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });
        global.__v3_cloudflared_process = tunnel;

        tunnel.on("exit", (code) => {
            global.__v3_cloudflared_process = null;
            retryCount++;
            if (retryCount < maxRetries) {
                setTimeout(start, 10000);
            } else {
                console.warn(`[Cloudflared] 隧道已退出 (代码 ${code})，停止继续重启。`);
            }
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
    if (query && String(query.get("token") || "").trim() === String(ADMIN_TOKEN || "").trim()) {
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

    // 1.1 独立多端口专属协议节点 (来自 .env 动态配置)
    if (ENABLE_HY2) {
        // 原生单端口节点
        nodes.push({
            name: `Hy2极速[${PORT_HY2}]${nameSuffix}`,
            type: "hysteria2",
            server: DIRECT_IP,
            port: PORT_HY2,
            password: uuid,
            sni: REALITY_DEST,
            skipCertVerify: true,
            udp: true
        });

        // 专属端口跳跃节点 (10900-10909 防 QoS)
        if (ENABLE_HY2_HOP) {
            nodes.push({
                name: `Hy2跳跃[${HY2_HOP_PORTS}]${nameSuffix}`,
                type: "hysteria2-hop",
                server: DIRECT_IP,
                port: parseInt(HY2_HOP_PORTS.split("-")[0], 10),
                ports: HY2_HOP_PORTS,
                password: uuid,
                sni: REALITY_DEST,
                skipCertVerify: true,
                udp: true,
                hopInterval: HY2_HOP_INTERVAL
            });
        }
    }

    if (ENABLE_TUIC) {
        nodes.push({
            name: `TUICv5[${PORT_TUIC}]${nameSuffix}`,
            type: "tuic",
            server: DIRECT_IP,
            port: PORT_TUIC,
            uuid: uuid,
            password: uuid,
            sni: REALITY_DEST,
            congestion: "bbr",
            skipCertVerify: true,
            udp: true
        });
    }

    if (ENABLE_REALITY && realityState.publicKey) {
        nodes.push({
            name: `Reality抗封[${PORT_REALITY}]${nameSuffix}`,
            type: "vless-reality",
            server: DIRECT_IP,
            port: PORT_REALITY,
            uuid: uuid,
            sni: REALITY_DEST,
            pbk: realityState.publicKey,
            sid: realityState.shortId || "16888888",
            fp: "chrome",
            udp: true
        });
    }

    if (ENABLE_VLESS_TCP) {
        nodes.push({
            name: `VLESS纯直连[${PORT_VLESS_TCP}]${nameSuffix}`,
            type: "vless-tcp",
            server: DIRECT_IP,
            port: PORT_VLESS_TCP,
            uuid: uuid,
            network: "tcp",
            tls: false,
            udp: true
        });
    }

    if (ENABLE_TROJAN_TCP) {
        nodes.push({
            name: `Trojan直连[${PORT_TROJAN_TCP}]${nameSuffix}`,
            type: "trojan-tcp",
            server: DIRECT_IP,
            port: PORT_TROJAN_TCP,
            password: uuid,
            network: "tcp",
            tls: false,
            udp: true
        });
    }

    if (ENABLE_SS && PORT_SS > 0 && ssSecretState) {
        const userSsKey = getUserSsKey(user.uuid);
        nodes.push({
            name: `SS2022[${PORT_SS}]${nameSuffix}`,
            type: "shadowsocks",
            server: DIRECT_IP,
            port: PORT_SS,
            method: SS_METHOD,
            password: `${ssSecretState}:${userSsKey}`,
            udp: true
        });
    }


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
        } else if (n.type === "hysteria2") {
            linkList.push(`hysteria2://${n.password}@${n.server}:${n.port}/?insecure=1&sni=${n.sni}#${n.name}`);
        } else if (n.type === "hysteria2-hop") {
            linkList.push(`hysteria2://${n.password}@${n.server}:${n.port}/?mport=${n.ports}&ports=${n.ports}&insecure=1&sni=${n.sni}#${n.name}`);
        } else if (n.type === "tuic") {
            linkList.push(`tuic://${n.uuid}:${n.password}@${n.server}:${n.port}/?congestion_control=bbr&alpn=h3&sni=${n.sni}&allow_insecure=1&insecure=1#${n.name}`);
        } else if (n.type === "vless-reality") {
            linkList.push(`vless://${n.uuid}@${n.server}:${n.port}?security=reality&encryption=none&pbk=${n.pbk}&sid=${n.sid}&sni=${n.sni}&fp=${n.fp}&type=tcp#${n.name}`);
        } else if (n.type === "vless-tcp") {
            linkList.push(`vless://${n.uuid}@${n.server}:${n.port}?encryption=none&type=tcp#${n.name}`);
        } else if (n.type === "trojan-tcp") {
            linkList.push(`trojan://${n.password}@${n.server}:${n.port}?type=tcp&security=none#${n.name}`);
        } else if (n.type === "shadowsocks") {
            const ssAuth = Buffer.from(`${n.method}:${n.password}`).toString("base64url");
            linkList.push(`ss://${ssAuth}@${n.server}:${n.port}#${n.name}`);
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
        } else if (n.type === "hysteria2") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: hysteria2\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    password: "${n.password}"\n`;
            proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    skip-cert-verify: true\n`;
            proxiesYaml += `    udp: true\n`;
        } else if (n.type === "hysteria2-hop") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: hysteria2\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    ports: ${n.ports}\n`;
            proxiesYaml += `    password: "${n.password}"\n`;
            proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    skip-cert-verify: true\n`;
            proxiesYaml += `    udp: true\n`;
        } else if (n.type === "tuic") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: tuic\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    password: "${n.password}"\n`;
            proxiesYaml += `    congestion-controller: bbr\n`;
            proxiesYaml += `    alpn: [h3]\n`;
            proxiesYaml += `    sni: ${n.sni}\n`;
            proxiesYaml += `    skip-cert-verify: true\n`;
            proxiesYaml += `    udp: true\n`;
        } else if (n.type === "vless-reality") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: vless\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    network: tcp\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: true\n`;
            proxiesYaml += `    flow: ${n.flow}\n`;
            proxiesYaml += `    servername: ${n.sni}\n`;
            proxiesYaml += `    reality-opts:\n`;
            proxiesYaml += `      public-key: ${n.pbk}\n`;
            proxiesYaml += `      short-id: ${n.sid}\n`;
            proxiesYaml += `    client-fingerprint: ${n.fp}\n`;
        } else if (n.type === "vless-tcp") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: vless\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    uuid: ${n.uuid}\n`;
            proxiesYaml += `    network: tcp\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: false\n`;
        } else if (n.type === "trojan-tcp") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: trojan\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    password: ${n.password}\n`;
            proxiesYaml += `    network: tcp\n`;
            proxiesYaml += `    udp: true\n`;
            proxiesYaml += `    tls: false\n`;
        } else if (n.type === "shadowsocks") {
            proxiesYaml += `  - name: "${n.name}"\n`;
            proxiesYaml += `    type: ss\n`;
            proxiesYaml += `    server: ${n.server}\n`;
            proxiesYaml += `    port: ${n.port}\n`;
            proxiesYaml += `    cipher: ${n.method}\n`;
            proxiesYaml += `    password: "${n.password}"\n`;
            proxiesYaml += `    udp: true\n`;
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

// 自动生成符合 Surge 规范的完整托管配置
function generateSurgeConfig(user) {
    const nodes = getStructuredNodesForUser(user);
    const proxyList = [];
    const proxyNames = [];

    for (const n of nodes) {
        proxyNames.push(n.name);
        const hostHeader = (n.wsHeaders && n.wsHeaders.Host) ? `, ws-headers=Host:${n.wsHeaders.Host}` : '';
        const tlsStr = n.tls ? ', tls=true' : '';
        const sniStr = n.sni ? `, sni=${n.sni}` : '';

        if (n.type === 'vless') {
            proxyList.push(`${n.name} = vless, ${n.server}, ${n.port}, username=${n.uuid}, ws=true, ws-path=${n.wsPath}${hostHeader}${tlsStr}${sniStr}`);
        } else if (n.type === 'vmess') {
            proxyList.push(`${n.name} = vmess, ${n.server}, ${n.port}, username=${n.uuid}, ws=true, ws-path=${n.wsPath}${hostHeader}${tlsStr}${sniStr}`);
        } else if (n.type === 'trojan') {
            proxyList.push(`${n.name} = trojan, ${n.server}, ${n.port}, password=${n.password}, ws=true, ws-path=${n.wsPath}${hostHeader}${tlsStr}${sniStr}`);
        }
    }

    const proxyNameListStr = proxyNames.join(', ');

    return `[General]
loglevel = notify
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, localhost, *.local

[Proxy]
${proxyList.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ♻️ 自动优选, ⚡ 故障转移, ${proxyNameListStr}, DIRECT
♻️ 自动优选 = url-test, ${proxyNameListStr}, url=http://cp.cloudflare.com/generate_204, interval=300
⚡ 故障转移 = fallback, ${proxyNameListStr}, url=http://cp.cloudflare.com/generate_204, interval=300

[Rule]
GEOIP,CN,DIRECT
FINAL,🚀 节点选择
`;
}


// ==================== HTTP 响应加固助手 (彻底根治 Chunked 编码损坏与强缓存问题) ====================
function sendJsonResponse(res, statusCode, data, extraHeaders = {}) {
    const payload = Buffer.from(JSON.stringify(data), "utf8");
    const headers = Object.assign({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
    }, extraHeaders);
    res.writeHead(statusCode, headers);
    res.end(payload);
}

function sendHtmlResponse(res, statusCode, htmlStr, extraHeaders = {}) {
    const payload = Buffer.from(htmlStr, "utf8");
    const headers = Object.assign({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": payload.length,
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache"
    }, extraHeaders);
    res.writeHead(statusCode, headers);
    res.end(payload);
}

// ==================== 5. HTTP 业务层与前端 ====================
function handleHttpRequest(req, res) {
    let rawPath = req.url.split('?')[0];
    if (rawPath === '/v3') {
        res.writeHead(302, { 'Location': '/v3/' });
        return res.end();
    }
    let normalizedUrl = req.url;
    if (normalizedUrl.startsWith('/v3/')) {
        normalizedUrl = normalizedUrl.slice(3); // 去掉 /v3 前缀
    }
    const parsedUrl = new URL(normalizedUrl, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.searchParams;

    // 1. 订阅分发 (支持 Base64 / Clash / Surge 自动转换分发)
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

        const isSurge = query.get("type") === "surge" ||
            query.get("format") === "surge" ||
            /surge/i.test(req.headers["user-agent"] || "");

        const subUserInfo = `upload=0; download=${user.trafficUsed}; total=${user.trafficLimit}; expire=${Math.floor(user.expireTime / 1000)}`;

        if (isSurge) {
            res.writeHead(200, {
                "Content-Type": "text/plain; charset=utf-8",
                "Content-Disposition": `attachment; filename*=UTF-8''surge_${encodeURIComponent(user.username)}.conf`,
                "Subscription-Userinfo": subUserInfo
            });
            return res.end(generateSurgeConfig(user));
        }

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

    // 2.1 获取公开站点配置 (供前台登录页/仪表盘实时获取站长信息与注册开关)
    if (pathname === "/api/public-settings" && req.method === "GET") {
        const val = siteSettings.defaultTrafficVal !== undefined ? siteSettings.defaultTrafficVal : (siteSettings.defaultTrafficGB || 10);
        const unit = siteSettings.defaultTrafficUnit || "GB";
        return sendJsonResponse(res, 200, {
            allowRegister: siteSettings.allowRegister,
            defaultDays: siteSettings.defaultDays,
            defaultTrafficVal: val,
            defaultTrafficUnit: unit,
            defaultTrafficGB: unit === "TB" ? val * 1024 : (unit === "MB" ? val / 1024 : val),
            contactText: siteSettings.contactText || "",
            contactUrl: siteSettings.contactUrl || ""
        });
    }

    // 3. 用户注册 API
    if (pathname === "/api/register" && req.method === "POST") {
        if (!siteSettings.allowRegister) {
            return sendJsonResponse(res, 403, { error: "当前站点暂未开放自主注册，请联系站长开通！" });
        }
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            try {
                const { username, password } = JSON.parse(body || "{}");
                const cleanUser = String(username || "").trim();
                const cleanPwd = String(password || "").trim();

                if (!cleanUser || !cleanPwd) {
                    return sendJsonResponse(res, 400, { error: "用户名与密码不得为空" });
                }

                const userKey = cleanUser.toLowerCase();

                // 幂等防重检查: 如果该账号在过去 3 秒内已被同一操作成功发起，直接返回成功，防止网络抖动/回车双发导致误报被占用
                if (registeringUsers.has(userKey)) {
                    const lastReqTime = registeringUsers.get(userKey);
                    if (Date.now() - lastReqTime < 4000) {
                        return sendJsonResponse(res, 200, { success: true, idempotency: true });
                    }
                }

                if (usersDatabase.some((u) => u.username.toLowerCase() === userKey)) {
                    return sendJsonResponse(res, 400, { error: "该用户名已被注册占用，请更换其他账号名" });
                }

                // 登记并发锁
                registeringUsers.set(userKey, Date.now());

                const initDays = Math.max(0, parseInt(siteSettings.defaultDays, 10) || 3);
                const initVal = parseFloat(siteSettings.defaultTrafficVal !== undefined ? siteSettings.defaultTrafficVal : (siteSettings.defaultTrafficGB || 10)) || 0;
                const initUnit = String(siteSettings.defaultTrafficUnit || "GB").toUpperCase();
                const trafficLimitBytes = convertToBytes(initVal, initUnit);
                const newUser = {
                    uuid: crypto.randomUUID(),
                    username: cleanUser,
                    passwordHash: hashPassword(cleanPwd),
                    trafficLimit: trafficLimitBytes,
                    trafficUsed: 0,
                    expireTime: initDays > 0 ? (Date.now() + initDays * 86400000) : 0,
                    enabled: true,
                    maxOnlineIps: siteSettings.defaultMaxOnlineIps || 0,
                    ipLimitPolicy: siteSettings.defaultIpLimitPolicy || "kick_oldest",
                    idleDisconnectEnabled: siteSettings.defaultIdleDisconnectEnabled !== false,
                    idleTimeoutSeconds: siteSettings.defaultIdleTimeoutSeconds || 60
                };

                usersDatabase.push(newUser);
                saveUsers();
                safeReloadSingbox();

                return sendJsonResponse(res, 200, { success: true });
            } catch (e) {
                return sendJsonResponse(res, 500, { error: "注册处理失败: " + e.message });
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
                    return sendJsonResponse(res, 404, { error: "该账号尚未注册，请先点击注册" });
                }

                if (targetUser.passwordHash !== hashPassword(cleanPwd)) {
                    return sendJsonResponse(res, 401, { error: "密码输入有误，请核对后重试" });
                }

                const sessionToken = crypto.randomBytes(16).toString("hex");
                activeSessions.set(sessionToken, targetUser.username);

                // 用户登录时自动爬取一次推荐客户端下载最新列表
                try { crawlFlClashDownloads(); } catch (e) { console.warn("[Login] 自动爬取客户端下载触发异常:", e.message); }

                return sendJsonResponse(res, 200, { success: true }, {
                    "Set-Cookie": `session_token=${sessionToken}; Path=/; HttpOnly; Max-Age=86400`
                });
            } catch (e) {
                return sendJsonResponse(res, 500, { error: "认证模块异常" });
            }
        });
        return;
    }

    if (pathname === "/logout") {
        const isV3Prefix = req.url.startsWith("/v3");
        const cookieHeader = req.headers.cookie || "";
        const match = cookieHeader.match(/session_token=([a-zA-Z0-9]+)/);
        if (match && activeSessions.has(match[1])) {
            activeSessions.delete(match[1]);
        }
        res.writeHead(302, {
            "Set-Cookie": "session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Lax",
            "Location": (isV3Prefix ? "/v3" : "") + "/?action=login"
        });
        return res.end();
    }

    // 5. 后台独立登录页面与鉴权 (/admin/login)
    if (pathname === "/admin/login") {
        if (req.method === "GET") {
            // 如果已登录管理会话，直接跳到 /v3/admin
            if (checkAdminAuth(req, query)) {
                res.writeHead(302, { Location: "/v3/admin" });
                return res.end();
            }

            return sendHtmlResponse(res, 200, `
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
                                const apiPrefix = location.pathname.startsWith("/v3") ? "/v3" : "";
                                const res = await fetch(apiPrefix + "/admin/login", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ token: pwd })
                                });
                                const data = await res.json();
                                if (res.ok && data.success) {
                                    location.href = apiPrefix + "/admin";
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
                    const inputToken = String(token || "").trim();
                    const validToken = String(ADMIN_TOKEN || "").trim();
                    if (!inputToken || inputToken !== validToken) {
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
        const isV3Prefix = req.url.startsWith("/v3");
        res.writeHead(302, { "Set-Cookie": "admin_session_token=; Path=/; Max-Age=0", Location: isV3Prefix ? "/v3/admin/login" : "/admin/login" });
        return res.end();
    }

    // 6. 后台管理 API (严格经过 checkAdminAuth 隔离校验)
    if (pathname.startsWith("/admin/api/")) {
        if (!checkAdminAuth(req, query)) {
            res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
            return res.end(JSON.stringify({ error: "管理凭据未授权或会话已过期" }));
        }

        // 读取全局站点配置与全量协议/网络变量
        if (pathname === "/admin/api/settings" && req.method === "GET") {
            return sendJsonResponse(res, 200, {
                ...siteSettings,
                envSettings: {
                    SERVER_PORT,
                    DIRECT_IP,
                    ENABLE_HY2,
                    PORT_HY2,
                    ENABLE_HY2_HOP,
                    HY2_HOP_PORTS,
                    HY2_HOP_INTERVAL,
                    ENABLE_TUIC,
                    PORT_TUIC,
                    ENABLE_REALITY,
                    PORT_REALITY,
                    REALITY_DEST,
                    REALITY_PORT,
                    ENABLE_VLESS_TCP,
                    PORT_VLESS_TCP,
                    ENABLE_TROJAN_TCP,
                    PORT_TROJAN_TCP,
                    ENABLE_SS,
                    PORT_SS,
                    SS_METHOD,
                    ENABLE_SOCKS5,
                    PORT_SOCKS5,
                    ARGO_TOKEN,
                    ARGO_DOMAIN,
                    OPTIMIZED_DOMAIN
                }
            });
        }

        // 保存全局站点配置与全量协议/网络变量
        if (pathname === "/admin/api/settings" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                try {
                    const data = JSON.parse(body || "{}");
                    if (data.allowRegister !== undefined) {
                        siteSettings.allowRegister = Boolean(data.allowRegister);
                    }
                    if (data.enableClientDownload !== undefined) {
                        siteSettings.enableClientDownload = Boolean(data.enableClientDownload);
                    }
                    if (data.defaultDays !== undefined) {
                        siteSettings.defaultDays = Math.max(0, parseInt(data.defaultDays, 10) || 0);
                    }
                    if (data.defaultTrafficVal !== undefined) {
                        siteSettings.defaultTrafficVal = Math.max(0, parseFloat(data.defaultTrafficVal) || 0);
                    }
                    if (data.defaultTrafficUnit !== undefined) {
                        const u = String(data.defaultTrafficUnit).toUpperCase();
                        siteSettings.defaultTrafficUnit = ["MB", "GB", "TB"].includes(u) ? u : "GB";
                    }
                    const curVal = siteSettings.defaultTrafficVal !== undefined ? siteSettings.defaultTrafficVal : (data.defaultTrafficGB || 10);
                    const curUnit = siteSettings.defaultTrafficUnit || "GB";
                    siteSettings.defaultTrafficGB = curUnit === "TB" ? curVal * 1024 : (curUnit === "MB" ? curVal / 1024 : curVal);
                    if (data.defaultMaxOnlineIps !== undefined) {
                        siteSettings.defaultMaxOnlineIps = Math.max(0, parseInt(data.defaultMaxOnlineIps, 10) || 0);
                    }
                    if (data.defaultIdleDisconnectEnabled !== undefined) {
                        siteSettings.defaultIdleDisconnectEnabled = Boolean(data.defaultIdleDisconnectEnabled);
                    }
                    if (data.defaultIdleTimeoutSeconds !== undefined) {
                        siteSettings.defaultIdleTimeoutSeconds = Math.max(10, parseInt(data.defaultIdleTimeoutSeconds, 10) || 60);
                    }
                    if (data.contactText !== undefined) {
                        siteSettings.contactText = String(data.contactText || "").trim();
                    }
                    if (data.contactUrl !== undefined) {
                        siteSettings.contactUrl = String(data.contactUrl || "").trim();
                    }
                    saveSettings();

                    // 2. 如果携带了协议与网络变量，同步写入 .env 并热重载 Sing-box
                    let needCoreReload = false;
                    const envUpdates = {};

                    if (data.envSettings && typeof data.envSettings === "object") {
                        const env = data.envSettings;

                        if (env.PORT_HY2 !== undefined) {
                            PORT_HY2 = parseInt(env.PORT_HY2, 10) || 0;
                            envUpdates.PORT_HY2 = PORT_HY2;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_HY2 !== undefined) {
                            ENABLE_HY2 = Boolean(env.ENABLE_HY2);
                            envUpdates.ENABLE_HY2 = ENABLE_HY2;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_HY2_HOP !== undefined) {
                            ENABLE_HY2_HOP = Boolean(env.ENABLE_HY2_HOP);
                            envUpdates.ENABLE_HY2_HOP = ENABLE_HY2_HOP;
                            needCoreReload = true;
                        }
                        if (env.HY2_HOP_PORTS !== undefined) {
                            HY2_HOP_PORTS = String(env.HY2_HOP_PORTS || "").trim();
                            envUpdates.HY2_HOP_PORTS = HY2_HOP_PORTS;
                            needCoreReload = true;
                        }
                        if (env.PORT_TUIC !== undefined) {
                            PORT_TUIC = parseInt(env.PORT_TUIC, 10) || 0;
                            envUpdates.PORT_TUIC = PORT_TUIC;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_TUIC !== undefined) {
                            ENABLE_TUIC = Boolean(env.ENABLE_TUIC);
                            envUpdates.ENABLE_TUIC = ENABLE_TUIC;
                            needCoreReload = true;
                        }
                        if (env.PORT_REALITY !== undefined) {
                            PORT_REALITY = parseInt(env.PORT_REALITY, 10) || 0;
                            envUpdates.PORT_REALITY = PORT_REALITY;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_REALITY !== undefined) {
                            ENABLE_REALITY = Boolean(env.ENABLE_REALITY);
                            envUpdates.ENABLE_REALITY = ENABLE_REALITY;
                            needCoreReload = true;
                        }
                        if (env.REALITY_DEST !== undefined) {
                            REALITY_DEST = String(env.REALITY_DEST || "addons.mozilla.org").trim();
                            envUpdates.REALITY_DEST = REALITY_DEST;
                            needCoreReload = true;
                        }
                        if (env.PORT_VLESS_TCP !== undefined) {
                            PORT_VLESS_TCP = parseInt(env.PORT_VLESS_TCP, 10) || 0;
                            envUpdates.PORT_VLESS_TCP = PORT_VLESS_TCP;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_VLESS_TCP !== undefined) {
                            ENABLE_VLESS_TCP = Boolean(env.ENABLE_VLESS_TCP);
                            envUpdates.ENABLE_VLESS_TCP = ENABLE_VLESS_TCP;
                            needCoreReload = true;
                        }
                        if (env.PORT_TROJAN_TCP !== undefined) {
                            PORT_TROJAN_TCP = parseInt(env.PORT_TROJAN_TCP, 10) || 0;
                            envUpdates.PORT_TROJAN_TCP = PORT_TROJAN_TCP;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_TROJAN_TCP !== undefined) {
                            ENABLE_TROJAN_TCP = Boolean(env.ENABLE_TROJAN_TCP);
                            envUpdates.ENABLE_TROJAN_TCP = ENABLE_TROJAN_TCP;
                            needCoreReload = true;
                        }
                        if (env.PORT_SS !== undefined) {
                            PORT_SS = parseInt(env.PORT_SS, 10) || 0;
                            envUpdates.PORT_SS = PORT_SS;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_SS !== undefined) {
                            ENABLE_SS = Boolean(env.ENABLE_SS);
                            envUpdates.ENABLE_SS = ENABLE_SS;
                            needCoreReload = true;
                        }
                        if (env.PORT_SOCKS5 !== undefined) {
                            PORT_SOCKS5 = parseInt(env.PORT_SOCKS5, 10) || 0;
                            envUpdates.PORT_SOCKS5 = PORT_SOCKS5;
                            needCoreReload = true;
                        }
                        if (env.ENABLE_SOCKS5 !== undefined) {
                            ENABLE_SOCKS5 = Boolean(env.ENABLE_SOCKS5);
                            envUpdates.ENABLE_SOCKS5 = ENABLE_SOCKS5;
                            needCoreReload = true;
                        }
                        if (env.DIRECT_IP !== undefined && String(env.DIRECT_IP).trim()) {
                            DIRECT_IP = String(env.DIRECT_IP).trim();
                            envUpdates.SERVER_IP = DIRECT_IP;
                        }
                        if (env.ARGO_DOMAIN !== undefined) {
                            ARGO_DOMAIN = String(env.ARGO_DOMAIN || "").trim();
                            envUpdates.ARGO_DOMAIN = ARGO_DOMAIN;
                        }
                        if (env.ARGO_TOKEN !== undefined) {
                            ARGO_TOKEN = String(env.ARGO_TOKEN || "").trim();
                            envUpdates.ARGO_TOKEN = ARGO_TOKEN;
                        }
                        if (env.OPTIMIZED_DOMAIN !== undefined) {
                            OPTIMIZED_DOMAIN = String(env.OPTIMIZED_DOMAIN || "").trim();
                            envUpdates.OPTIMIZED_DOMAIN = OPTIMIZED_DOMAIN;
                        }

                        if (Object.keys(envUpdates).length > 0) {
                            updateEnvFile(envUpdates);
                        }
                    }

                    if (needCoreReload) {
                        ensureMultiProtocolSecrets();
                        generateSingboxConfig();
                        safeReloadSingbox();
                    }

                    console.log("[Settings] 站点运营与全部协议环境变量已由管理员成功更新并生效");
                    return sendJsonResponse(res, 200, {
                        success: true,
                        settings: siteSettings,
                        message: "站点运营与全部协议变量已成功持久化并热重载生效！"
                    });
                } catch (e) {
                    return sendJsonResponse(res, 500, { error: "更新站点配置失败: " + e.message });
                }
            });
            return;
        }

        if (pathname === "/admin/api/sync-client-downloads" && req.method === "POST") {
            crawlFlClashDownloads(true).then((items) => {
                return sendJsonResponse(res, 200, { success: true, count: items.length, items });
            }).catch((err) => {
                return sendJsonResponse(res, 500, { error: "同步失败: " + err.message });
            });
            return;
        }

        if (pathname === "/admin/api/update" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { uuid, newUuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled } = JSON.parse(body || "{}");
                const user = usersDatabase.find((u) => u.uuid === uuid);
                if (!user) {
                    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "未找到目标用户" }));
                }

                // 支持管理员修改/一键轮换 UUID
                let effectiveUuid = user.uuid;
                if (newUuid && String(newUuid).trim() && String(newUuid).trim() !== user.uuid) {
                    const cleanNewUuid = String(newUuid).trim();
                    const oldAct = userActivityMap.get(user.uuid);
                    if (oldAct) {
                        userActivityMap.delete(user.uuid);
                        userActivityMap.set(cleanNewUuid, oldAct);
                    }
                    user.uuid = cleanNewUuid;
                    effectiveUuid = cleanNewUuid;
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

                // 注入多端风控与空闲断链配置
                const { maxOnlineIps, ipLimitPolicy, idleDisconnectEnabled, idleTimeoutSeconds } = JSON.parse(body || "{}");
                if (maxOnlineIps !== undefined) {
                    user.maxOnlineIps = Math.max(0, parseInt(maxOnlineIps, 10) || 0);
                }
                if (ipLimitPolicy !== undefined) {
                    user.ipLimitPolicy = ipLimitPolicy === "reject_new" ? "reject_new" : "kick_oldest";
                }
                if (idleDisconnectEnabled !== undefined) {
                    user.idleDisconnectEnabled = Boolean(idleDisconnectEnabled);
                }
                if (idleTimeoutSeconds !== undefined) {
                    user.idleTimeoutSeconds = Math.max(10, parseInt(idleTimeoutSeconds, 10) || 60);
                }

                saveUsers();
                safeReloadSingbox();

                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true, uuid: effectiveUuid }));
            });
            return;
        }

        // 一键随机生成 / 轮换特定用户的 UUID
        if (pathname === "/admin/api/rotate-uuid" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const { uuid, newUuid } = JSON.parse(body || "{}");
                const target = usersDatabase.find((u) => u.uuid === uuid);
                if (!target) {
                    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
                    return res.end(JSON.stringify({ error: "未找到目标用户" }));
                }

                const assignedUuid = (newUuid && String(newUuid).trim()) ? String(newUuid).trim() : crypto.randomUUID();
                const oldAct = userActivityMap.get(uuid);
                if (oldAct) {
                    userActivityMap.delete(uuid);
                    userActivityMap.set(assignedUuid, oldAct);
                }
                target.uuid = assignedUuid;
                saveUsers();
                safeReloadSingbox();

                console.log(`[Security] 用户 [${target.username}] 已由管理员一键更换凭据 UUID: ${assignedUuid}`);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true, newUuid: assignedUuid }));
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
                const { username, password, limitVal, limitUnit, days, customUuid } = JSON.parse(body || "{}");
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

                const assignedUuid = (customUuid && String(customUuid).trim()) ? String(customUuid).trim() : crypto.randomUUID();

                const newUser = {
                    uuid: assignedUuid,
                    username: cleanUser,
                    passwordHash: hashPassword(cleanPwd),
                    trafficLimit: convertToBytes(limitVal || 50, limitUnit || "GB"),
                    trafficUsed: 0,
                    expireTime: Date.now() + parseInt(days || 30, 10) * 86400000,
                    enabled: true,
                    maxOnlineIps: Math.max(0, parseInt(JSON.parse(body || "{}").maxOnlineIps || "0", 10)),
                    ipLimitPolicy: JSON.parse(body || "{}").ipLimitPolicy || "kick_oldest",
                    idleDisconnectEnabled: JSON.parse(body || "{}").idleDisconnectEnabled !== false,
                    idleTimeoutSeconds: Math.max(10, parseInt(JSON.parse(body || "{}").idleTimeoutSeconds || "60", 10))
                };

                usersDatabase.push(newUser);
                saveUsers();
                safeReloadSingbox();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ success: true, uuid: assignedUuid }));
            });
            return;
        }

        if (pathname === "/admin/api/visitors" && req.method === "GET") {
            const visitors = [];
            usersDatabase.forEach((u) => {
                const act = getUserActivity(u.uuid);
                if (act && act.activeList && act.activeList.length > 0) {
                    // 主动过滤已销毁或断开的僵尸套接字
                    act.activeList = act.activeList.filter((c) => {
                        if (c.clientSocket && c.clientSocket.destroyed) return false;
                        if (c.backendSocket && c.backendSocket.destroyed) return false;
                        return true;
                    });
                    act.activeConnections = act.activeList.length;

                    act.activeList.forEach((c) => {
                        visitors.push({
                            id: c.id,
                            uuid: u.uuid,
                            username: u.username,
                            ip: c.ip,
                            location: c.location || ipGeoCache.get(c.ip) || "正在解析归属地...",
                            proto: c.proto || "未知",
                            connectedAt: c.connectedAt,
                            connectedStr: formatRelativeTime(c.connectedAt)
                        });
                    });
                }
            });
            visitors.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
            return sendJsonResponse(res, 200, {
                totalLiveConnections: visitors.length,
                visitors: visitors
            });
        }
    }

    // 7. 后台管理页面 (/admin) - 独立 Cookie 鉴权与在线感知看板
        // 7. 管理后台运营与监控中心 (/admin)
    if (pathname === "/admin") {
        if (!checkAdminAuth(req, query)) {
            const isV3 = req.url.startsWith("/v3");
            res.writeHead(302, { Location: (isV3 ? "/v3" : "") + "/admin/login" });
            return res.end();
        }

        return renderAdminPage(req, res, {
            siteSettings,
            usersDatabase,
            clientDownloads,
            DIRECT_IP,
            SERVER_PORT,
            isTunnelAvailable,
            ARGO_DOMAIN,
            ipGeoCache,
            formatBytes,
            formatRelativeTime,
            formatExpireDate,
            parseBytesToInput,
            isUserInvalid,
            getActiveUsers,
            getUserActivity,
            userActivityMap,
            sendHtmlResponse
        });
    }

    // 8. 现代化商业机场前台路由体系 (/ , /dashboard , /user , /login)
    if (pathname === "/login") {
        const isV3Prefix = req.url.startsWith("/v3");
        res.writeHead(302, { "Location": (isV3Prefix ? "/v3" : "") + "/?action=login" });
        return res.end();
    }

    if (pathname === "/dashboard" || pathname === "/user") {
        const currentUser = getSessionUser(req);
        const isV3Prefix = req.url.startsWith("/v3");
        const basePrefix = isV3Prefix ? "/v3" : "";

        // 未登录访问控制台：跳转至登录
        if (!currentUser) {
            res.writeHead(302, { "Location": basePrefix + "/?action=login" });
            return res.end();
        }

        // 已登录状态：展示魔戒机场级用户控制中心
        return renderDashboard(req, res, {
            currentUser,
            siteSettings,
            clientDownloads,
            getStructuredNodesForUser,
            isTunnelAvailable,
            ARGO_DOMAIN,
            DIRECT_IP,
            SERVER_PORT,
            sendHtmlResponse
        });
    }

    if (pathname === "/") {
        const currentUser = getSessionUser(req);
        // 关键：首页永远展示商业机场官网！若已登录，传入 currentUser 以便顶部显示控制台入口与快捷退出
        // 绝不强行拦截跳转到 dashboard 导致用户想看官网或登录被死锁！
        return renderLandingPage(req, res, {
            siteSettings: {
                ...siteSettings,
                PORT_HY2,
                PORT_TUIC,
                PORT_REALITY,
                PORT_VLESS_TCP,
                PORT_TROJAN_TCP,
                PORT_SS,
                PORT_SOCKS5,
                HY2_HOP_PORTS: HY2_HOP_PORTS || process.env.HY2_HOP_PORTS || '',
            },
            currentUser,
            sendHtmlResponse
        });
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

    // 活跃在线感知：提取访客真实 IP、接入协议，异步查询 IP 归属地
    const clientIp = getClientIp(req, clientSocket);
    const connId = crypto.randomBytes(6).toString("hex");
    let protoName = "未知";
    if (lowerUrl.includes("vless")) protoName = "VLESS";
    else if (lowerUrl.includes("vmess")) protoName = "VMess";
    else if (lowerUrl.includes("trojan")) protoName = "Trojan";

    const userAct = matchedUser ? getUserActivity(matchedUser.uuid) : null;

    // 【风控需求 1】：多端并发 IP 阈值限制 (超限踢出旧设备或拒绝新设备握手)
    const maxIps = matchedUser.maxOnlineIps !== undefined ? parseInt(matchedUser.maxOnlineIps, 10) : 0;
    const limitPolicy = matchedUser.ipLimitPolicy || "kick_oldest";

    if (maxIps > 0 && userAct && userAct.activeList && userAct.activeList.length > 0) {
        const currentActiveIps = Array.from(new Set(userAct.activeList.map((c) => c.ip)));
        // 如果当前接入的 clientIp 是全新未在线的 IP，且当前在线 IP 已经达到上限
        if (clientIp && !currentActiveIps.includes(clientIp) && currentActiveIps.length >= maxIps) {
            if (limitPolicy === "reject_new") {
                console.warn(`[RiskControl-Reject] 用户 [${matchedUser.username}] 尝试从新 IP ${clientIp} 连接，已超最大 IP 限制 (${maxIps})，拒绝握手`);
                clientSocket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
                clientSocket.destroy();
                return;
            } else {
                // kick_oldest: 找出最早连入的异端 IP 并将其所有连接踢出
                const oldestOtherIp = currentActiveIps[0];
                console.log(`[RiskControl-Kick] 用户 [${matchedUser.username}] 达到最大 IP 数 (${maxIps})，新 IP ${clientIp} 接入，自动断开最早设备 IP [${oldestOtherIp}]`);
                const connsToKick = userAct.activeList.filter((c) => c.ip === oldestOtherIp);
                connsToKick.forEach((c) => {
                    try {
                        if (c.clientSocket && !c.clientSocket.destroyed) c.clientSocket.destroy();
                        if (c.backendSocket && !c.backendSocket.destroyed) c.backendSocket.destroy();
                    } catch (_) {}
                });
            }
        }
    }

    // 组装连接对象 (记录当前客户端套接字与最后数据活动时间戳)
    const connRecord = {
        id: connId,
        ip: clientIp || "未知IP",
        location: ipGeoCache.get(clientIp) || "查询中...",
        proto: protoName,
        connectedAt: Date.now(),
        lastActivityAt: Date.now(),
        clientSocket: clientSocket,
        backendSocket: null,
        closeHandler: null
    };

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
                if (connRecord.closeHandler) connRecord.closeHandler();
                safeReloadSingbox();
            }
        }
    };

    let isClosed = false;
    const handleClose = () => {
        if (isClosed) return;
        isClosed = true;

        // 1. 双向彻底销毁套接字
        try {
            if (connRecord.clientSocket && !connRecord.clientSocket.destroyed) {
                connRecord.clientSocket.destroy();
            }
        } catch (_) {}
        try {
            if (connRecord.backendSocket && !connRecord.backendSocket.destroyed) {
                connRecord.backendSocket.destroy();
            }
        } catch (_) {}

        // 2. 强一致性清理连接池
        if (userAct && userAct.activeList) {
            const cIndex = userAct.activeList.findIndex((c) => c.id === connId);
            if (cIndex !== -1) {
                userAct.activeList.splice(cIndex, 1);
            }
            userAct.activeConnections = userAct.activeList.length;
            userAct.lastSeenAt = Date.now();
        }

        // 3. 提交剩余流量
        if (matchedUser && uncommittedBytes > 0) {
            matchedUser.trafficUsed += uncommittedBytes;
            uncommittedBytes = 0;
            triggerDebouncedSave();
        }
    };

    connRecord.closeHandler = handleClose;

    // 关键加固：立即绑定客户端套接字关闭与错误事件，绝不错失任何断开时机
    clientSocket.once("close", handleClose);
    clientSocket.once("error", handleClose);
    clientSocket.once("end", handleClose);

    if (userAct) {
        if (!userAct.activeList) userAct.activeList = [];
        userAct.activeList.push(connRecord);
        userAct.activeConnections = userAct.activeList.length;
        userAct.lastSeenAt = Date.now();
        if (clientIp) userAct.lastIp = clientIp;

        // 异步查询归属地 (绝不阻塞握手连接管道)
        if (clientIp) {
            lookupIpLocation(clientIp).then((loc) => {
                connRecord.location = loc;
                if (userAct) userAct.lastLocation = loc;
            }).catch(() => {});
        }
    }

    const backendSocket = net.connect(targetPort, "127.0.0.1", () => {
        connRecord.backendSocket = backendSocket;
        backendSocket.once("close", handleClose);
        backendSocket.once("error", handleClose);
        backendSocket.once("end", handleClose);

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

        // 每次收到网络数据包流动时，实时刷新空闲计时器
        clientSocket.on("data", (chunk) => {
            connRecord.lastActivityAt = Date.now();
            flushRealtimeTraffic(chunk.length);
        });
        backendSocket.on("data", (chunk) => {
            connRecord.lastActivityAt = Date.now();
            flushRealtimeTraffic(chunk.length);
        });

        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);
    });

    backendSocket.once("error", handleClose);
}

// 【需求 3】：空闲超时断链与僵尸死连接自动回收守护 (每 10 秒巡检一次)
setInterval(() => {
    const now = Date.now();
    usersDatabase.forEach((u) => {
        const act = userActivityMap.get(u.uuid);
        if (!act || !act.activeList || act.activeList.length === 0) return;

        const isIdleEnabled = u.idleDisconnectEnabled !== undefined ? Boolean(u.idleDisconnectEnabled) : true;
        const timeoutSec = u.idleTimeoutSeconds ? parseInt(u.idleTimeoutSeconds, 10) : 60;
        const timeoutMs = timeoutSec * 1000;

        const connsToClose = [];

        act.activeList.forEach((conn) => {
            // 状态 1：套接字在系统底层已经 destroyed 或关闭（僵尸死连接）
            const isDead = (conn.clientSocket && conn.clientSocket.destroyed) ||
                           (conn.backendSocket && conn.backendSocket.destroyed);

            // 状态 2：超过指定时长无数据交互（空闲超时）
            const isIdle = isIdleEnabled && conn.lastActivityAt && (now - conn.lastActivityAt > timeoutMs);

            if (isDead || isIdle) {
                connsToClose.push({ conn, isIdle, timeoutSec });
            }
        });

        connsToClose.forEach(({ conn, isIdle, timeoutSec }) => {
            if (isIdle) {
                console.log(`[Idle-Guard] 用户 [${u.username}] 的连接 (${conn.ip} / ${conn.proto}) 超过 ${timeoutSec} 秒无网络数据流动，执行空闲超时断链。`);
            }
            if (typeof conn.closeHandler === "function") {
                conn.closeHandler();
            } else {
                try {
                    if (conn.clientSocket && !conn.clientSocket.destroyed) conn.clientSocket.destroy();
                    if (conn.backendSocket && !conn.backendSocket.destroyed) conn.backendSocket.destroy();
                } catch (_) {}
                const idx = act.activeList.findIndex((c) => c.id === conn.id);
                if (idx !== -1) act.activeList.splice(idx, 1);
                act.activeConnections = act.activeList.length;
            }
        });
    });
}, 10000);

// 【方案一核心引擎】：Sing-box 原生 Clash API 流量统计与在线感知轮询 (每 5 秒一次)
const activeConnTrafficMap = new Map(); // id -> { lastBytes, lastSeen }

function pollSingboxClashApiTraffic() {
    const req = http.get(`http://127.0.0.1:${PORT_CLASH_API}/connections`, { timeout: 3500 }, (res) => {
        if (res.statusCode !== 200) {
            res.resume();
            return;
        }
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
            try {
                const json = JSON.parse(data);
                const conns = json.connections || [];
                let hasTrafficChanges = false;
                const currentConnIds = new Set();
                const now = Date.now();

                for (const c of conns) {
                    if (!c || !c.id) continue;
                    currentConnIds.add(c.id);

                    // 1. 过滤由 Node.js 本身转入的 WebSocket 内部流量，避免双重计费
                    const inboundTag = c.metadata?.inboundTag || "";
                    if (inboundTag === "vless-in" || inboundTag === "vmess-in" || inboundTag === "trojan-in") {
                        continue;
                    }

                    // 2. 精确匹配目标用户 (支持 uuid、用户名及包含判定)
                    const inboundUser = String(c.metadata?.inboundUser || "").trim();
                    let matchedUser = null;
                    if (inboundUser) {
                        matchedUser = usersDatabase.find((u) =>
                            u.uuid === inboundUser ||
                            u.username === inboundUser ||
                            (u.uuid && inboundUser.includes(u.uuid))
                        );
                    }
                    if (!matchedUser && usersDatabase.length === 1) {
                        matchedUser = usersDatabase[0];
                    }
                    if (!matchedUser) continue;

                    const totalBytes = (c.upload || 0) + (c.download || 0);
                    const prev = activeConnTrafficMap.get(c.id);
                    const prevBytes = prev ? prev.lastBytes : 0;
                    const delta = totalBytes - prevBytes;

                    if (delta > 0) {
                        matchedUser.trafficUsed = (matchedUser.trafficUsed || 0) + delta;
                        hasTrafficChanges = true;

                        // 3. 实时刷新用户在线感知与使用者真实 IP
                        const userAct = getUserActivity(matchedUser.uuid);
                        if (userAct) {
                            userAct.lastSeenAt = now;
                            if (c.metadata?.sourceIP) {
                                userAct.lastIp = c.metadata.sourceIP;
                                if (!ipGeoCache.has(c.metadata.sourceIP)) {
                                    lookupIpLocation(c.metadata.sourceIP).then((loc) => {
                                        userAct.lastLocation = loc;
                                    }).catch(() => {});
                                }
                            }
                        }

                        // 4. 超额熔断保护
                        if (matchedUser.trafficLimit > 0 && matchedUser.trafficUsed >= matchedUser.trafficLimit) {
                            console.warn(`[Quota-ClashApi] 用户 [${matchedUser.username}] 流量超额，触发核心断流`);
                            safeReloadSingbox();
                        }
                    }

                    activeConnTrafficMap.set(c.id, { lastBytes: totalBytes, lastSeen: now });
                }

                // 5. 垃圾回收：清理已经关闭或超时的断开连接
                for (const [id, rec] of activeConnTrafficMap.entries()) {
                    if (!currentConnIds.has(id) || (now - rec.lastSeen > 30000)) {
                        activeConnTrafficMap.delete(id);
                    }
                }

                if (hasTrafficChanges) {
                    triggerDebouncedSave();
                }
            } catch (_) {}
        });
    });
    req.on("error", () => {});
    req.setTimeout(3500, () => { req.destroy(); });
}

setInterval(pollSingboxClashApiTraffic, 5000);

// ==================== 7. 系统启动 ====================
loadUsers();
loadSettings();
loadClientDownloads();


let v3FileWatchInit = false;
function watchV3ConfigFiles() {
    if (v3FileWatchInit) return;
    v3FileWatchInit = true;
    // 关键架构安全保护：
    // 1. CONFIG_FILE (v3_config.json) 是代理核心配置的输出产物，绝对不能对其进行 watchFile 监听，否则会导致【生成配置->触发监听->重启核心并重写配置->再次触发监听】的恶性自杀式死循环！
    // 2. USERS_FILE (v3_users.json) 会在高频流量转发时写入 trafficUsed 用量，绝不能在写入流量时杀掉 Sing-box 进程，否则任何网络通信都会立即断链！
    // 3. 所有用户增删改操作均已在管理端点中精确调度 safeReloadSingbox()，且具备配置 Diff 保护，确保长连接平稳不断开。
}

function reloadV3Config() {
    console.log('[V3-HotReload] 正在平滑热重载 v3 环境变量与凭据...');
    ADMIN_TOKEN = (process.env.ADMIN_TOKEN || process.env.ADMIN_PASSWORD || ADMIN_TOKEN).trim();
    if (process.env.SERVER_IP) DIRECT_IP = process.env.SERVER_IP;
    if (process.env.SERVER_PORT) SERVER_PORT = parseInt(process.env.SERVER_PORT, 10);
    loadUsers();
loadSettings();
loadClientDownloads();
    safeReloadSingbox();
}

function startV3Service(internalPort = 3003, dataDir, externalIp, externalPort, bindHost = null) {
    if (externalIp) DIRECT_IP = externalIp;
    if (externalPort) SERVER_PORT = parseInt(externalPort, 10);

    if (dataDir) {
        USERS_FILE = path.join(dataDir, 'v3_users.json');
        CONFIG_FILE = path.join(dataDir, 'v3_config.json');
        SETTINGS_FILE = path.join(dataDir, 'v3_settings.json');
        CLIENT_DOWNLOADS_FILE = path.join(dataDir, 'v3_client_downloads.json');
    }
    if (!fs.existsSync(CONFIG_FILE)) {
        try {
            fs.copyFileSync(path.join(WORK_DIR, 'config.json'), CONFIG_FILE);
        } catch (_) { }
    }
    loadUsers();
loadSettings();
loadClientDownloads();
    watchV3ConfigFiles();

    const serverExternal = http.createServer(handleHttpRequest);
    serverExternal.on("upgrade", handleUpgradeRequest);
    serverExternal.on("error", (err) => {
        console.error(`[V3-Service] 核心服务端口 (${actualHost}:${internalPort}) 警告:`, err.message);
    });

    // 智能网卡监听绑定：独立部署绑定 0.0.0.0，多合一内部模式绑定 127.0.0.1
    const actualHost = bindHost || (internalPort === 3003 ? "127.0.0.1" : "0.0.0.0");

    serverExternal.listen(internalPort, actualHost, () => {
        console.log(`[V3-Service] v3 节点服务已就绪 (监听: ${actualHost}:${internalPort})`);
        console.log(`[V3-Service] 管理控制台入口: http://${DIRECT_IP}:${SERVER_PORT}/admin`);
        initSingboxCore();
        initAndStartCloudflared();
    });

    // 关键：启动 Argo Tunnel 本地 Ingress 接收服务 (监听 8001 端口，接收 cloudflared 流量)
    if (isTunnelAvailable) {
        try {
            if (globalTunnelServer) {
                try { globalTunnelServer.close(); } catch (_) {}
                globalTunnelServer = null;
            }
            const serverTunnel = http.createServer(handleHttpRequest);
            serverTunnel.on("upgrade", handleUpgradeRequest);
            serverTunnel.on("error", (err) => {
                console.warn(`[Tunnel] Argo 隧道本地服务端口 (${PORT_TUNNEL}) 警告: ${err.message}`);
            });
            serverTunnel.listen(PORT_TUNNEL, () => {
                console.log(`[Tunnel] Argo 隧道本地服务已就绪 (监听端口: ${PORT_TUNNEL})`);
            });
            globalTunnelServer = serverTunnel;
        } catch (err) {
            console.error('[Tunnel] Argo 隧道本地端口监听异常:', err.message);
        }
    }

    // 优雅包装 close 方法，确保热重载或停服时同步干净释放 8001 隧道端口
    const originalClose = serverExternal.close.bind(serverExternal);
    serverExternal.close = function(cb) {
        if (globalTunnelServer) {
            try { globalTunnelServer.close(); } catch (_) {}
            globalTunnelServer = null;
        }
        return originalClose(cb);
    };

    return serverExternal;
}

module.exports = {
    startV3Service,
    handleUpgradeRequest,
    reloadV3Config
};

// 动态自动获取宿主外网真实公网 IP (防止换机房或新容器时 IP 不对)
function detectPublicIpv4() {
    return new Promise((resolve) => {
        const envIp = process.env.SERVER_IP || process.env.PUBLIC_IP || process.env.HOST_IP;
        if (envIp && envIp.trim()) return resolve(envIp.trim());

        const https = require("https");
        const req = https.get("https://api.ipify.org", { timeout: 3500 }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                const ip = data.trim();
                if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return resolve(ip);
                resolve("127.0.0.1");
            });
        });
        req.on("error", () => resolve("127.0.0.1"));
        req.setTimeout(3500, () => {
            req.destroy();
            resolve("127.0.0.1");
        });
    });
}

// ==================== 8. 独立运行启动器 (Direct Startup Entry) ====================

if (require.main === module) {
    (async () => {
        // 1. 端口自适应读取 (翼龙面板自动注入 SERVER_PORT 或 PORT)
        const port = parseInt(process.env.SERVER_PORT || process.env.PORT || "20237", 10);

        // 2. 宿主外网真实 IP 自动探测 (换到任何新机器、新容器都能 100% 自动获取真实公网 IP)
        const hostIp = await detectPublicIpv4();
        DIRECT_IP = hostIp;
        SERVER_PORT = port;

        console.log("=".repeat(65));
        console.log("🚀 V3 极轻量节点与多协议分发控制中枢 (独立启动模式)");
        console.log(`📡 自动识别端口: ${port} (来源: ${process.env.SERVER_PORT ? "翼龙面板环境变量" : "本地默认/配置"})`);
        console.log(`🌍 自动探测公网: ${hostIp} (来源: ${process.env.SERVER_IP ? "指定配置" : "动态公网探测"})`);
        console.log(`📁 数据持久目录: ${defaultDataDir}`);
        console.log("=".repeat(65));

        // 3. 独立启动模式：直接监听 0.0.0.0 对外开放端口
        startV3Service(port, defaultDataDir, hostIp, port, "0.0.0.0");
    })();

    // 优雅关闭信号监听
    function handleStandaloneExit() {
        console.log("[V3] 收到关闭信号，正在清理 Sing-box 核心进程...");
        if (singboxProcess) {
            try { singboxProcess.kill("SIGTERM"); } catch (_) {}
        }
        process.exit(0);
    }
    process.on("SIGINT", handleStandaloneExit);
    process.on("SIGTERM", handleStandaloneExit);
}
