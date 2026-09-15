const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");

// ==================== 1. 翼龙面板环境与端口自适应 ====================
// 翼龙面板环境变量 SERVER_PORT 优先读取
const SERVER_PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || "20231", 10);
const USER_UUID = process.env.UUID || "de04add9-5c11-45da-9b11-255c3f46b35a";

// 宿主机 IP（可通过环境变量 SERVER_IP 自定义）
const DIRECT_IP = process.env.SERVER_IP || "51.75.118.169";

// 隧道配置留空（彻底脱敏）
const ARGO_TOKEN = process.env.ARGO_TOKEN || "";
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";
const OPTIMIZED_DOMAIN = process.env.OPTIMIZED_DOMAIN || "";

// 隧道回源端口
const PORT_TUNNEL = 8001;

// 内部 Sing-box 监听端口
const INTERNAL_VMESS_PORT = 10001;
const INTERNAL_VLESS_PORT = 10002;
const INTERNAL_TROJAN_PORT = 10003;

const WORK_DIR = __dirname;
const CONFIG_FILE = path.join(WORK_DIR, "config.json");
const SINGBOX_BIN = path.join(WORK_DIR, "sing-box");
const CLOUDFLARED_BIN = path.join(WORK_DIR, "cloudflared");

// 自动检测是否开启隧道
let isTunnelAvailable = Boolean(ARGO_TOKEN && ARGO_TOKEN.trim() !== "" && ARGO_DOMAIN && ARGO_DOMAIN.trim() !== "");

// ==================== 2. Sing-box 核心配置 ====================
function generateSingboxConfig() {
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
                users: [{ uuid: USER_UUID, alterId: 0 }],
                transport: { type: "ws", path: "/vmess" }
            },
            {
                type: "vless",
                tag: "vless-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_VLESS_PORT,
                users: [{ uuid: USER_UUID, flow: "" }],
                transport: { type: "ws", path: "/vless" }
            },
            {
                type: "trojan",
                tag: "trojan-in",
                listen: "127.0.0.1",
                listen_port: INTERNAL_TROJAN_PORT,
                users: [{ password: USER_UUID }],
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

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log("[Config] Sing-box 核心配置已成功生成。");
}

// ==================== 3. 进程管理 ====================
function initAndStartSingbox() {
    generateSingboxConfig();

    const start = () => {
        console.log("[Core] 正在拉起 Sing-box 核心服务...");
        const core = spawn(SINGBOX_BIN, ["run", "-c", CONFIG_FILE], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });

        core.on("exit", (code) => {
            console.warn(`[Core] 进程退出 (${code})，3 秒后重启...`);
            setTimeout(start, 3000);
        });
    };

    if (!fs.existsSync(SINGBOX_BIN)) {
        console.log("[Binary] 正在拉取 Sing-box 内核...");
        const archMap = { x64: "linux-amd64", arm64: "linux-arm64", arm: "linux-armv7" };
        const currentArch = archMap[process.arch] || "linux-amd64";
        const downloadCmd = `curl -sSL "https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-${currentArch}.tar.gz" | tar -xz --strip-components=1 -C "${WORK_DIR}" && chmod +x "${SINGBOX_BIN}"`;
        exec(downloadCmd, start);
    } else {
        fs.chmodSync(SINGBOX_BIN, "755");
        start();
    }
}

function initAndStartCloudflared() {
    if (!isTunnelAvailable) {
        console.log("[Tunnel] 未配置隧道，当前运行在纯直连模式。");
        return;
    }

    const start = () => {
        console.log(`[Tunnel] 启动 Argo 隧道: ${ARGO_DOMAIN}`);
        const tunnel = spawn(CLOUDFLARED_BIN, ["tunnel", "--no-autoupdate", "run", "--token", ARGO_TOKEN], {
            cwd: WORK_DIR,
            stdio: "inherit"
        });

        tunnel.on("exit", (code) => {
            console.warn(`[Tunnel] 隧道中断 (${code})，5 秒后重启...`);
            setTimeout(start, 5000);
        });
    };

    if (!fs.existsSync(CLOUDFLARED_BIN)) {
        const archMap = { x64: "cloudflared-linux-amd64", arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm" };
        const binName = archMap[process.arch] || "cloudflared-linux-amd64";
        const downloadCmd = `curl -sSL -o "${CLOUDFLARED_BIN}" "https://github.com/cloudflare/cloudflared/releases/latest/download/${binName}" && chmod +x "${CLOUDFLARED_BIN}"`;
        exec(downloadCmd, start);
    } else {
        fs.chmodSync(CLOUDFLARED_BIN, "755");
        start();
    }
}

// ==================== 4. 动态节点生成器 ====================
function getDynamicNodes() {
    // 直连物理节点（自适应翼龙分配端口）
    const directVless = `vless://${USER_UUID}@${DIRECT_IP}:${SERVER_PORT}?type=ws&security=none&path=%2Fvless#Direct-VLESS`;

    const directVmessConfig = {
        v: "2",
        ps: "Direct-VMess",
        add: DIRECT_IP,
        port: String(SERVER_PORT),
        id: USER_UUID,
        aid: "0",
        net: "ws",
        type: "none",
        host: DIRECT_IP,
        path: "/vmess",
        tls: ""
    };
    const directVmess = "vmess://" + Buffer.from(JSON.stringify(directVmessConfig)).toString("base64");

    const directTrojan = `trojan://${USER_UUID}@${DIRECT_IP}:${SERVER_PORT}?security=none&type=ws&path=%2Ftrojan#Direct-Trojan`;

    const directNodes = {
        vless: directVless,
        vmess: directVmess,
        trojan: directTrojan
    };

    const activeList = [directVless, directVmess, directTrojan];
    let tunnelNodes = null;

    if (isTunnelAvailable) {
        const optAddress = OPTIMIZED_DOMAIN || ARGO_DOMAIN;
        const tunnelHost = ARGO_DOMAIN;
        const port = "443";

        const tunnelVless = `vless://${USER_UUID}@${optAddress}:${port}?type=ws&security=tls&sni=${tunnelHost}&host=${tunnelHost}&path=%2Fvless#CF-优选-VLESS`;

        const tunnelVmessConfig = {
            v: "2",
            ps: "CF-优选-VMess",
            add: optAddress,
            port: port,
            id: USER_UUID,
            aid: "0",
            net: "ws",
            type: "none",
            host: tunnelHost,
            path: "/vmess",
            tls: "tls",
            sni: tunnelHost
        };
        const tunnelVmess = "vmess://" + Buffer.from(JSON.stringify(tunnelVmessConfig)).toString("base64");

        const tunnelTrojan = `trojan://${USER_UUID}@${optAddress}:${port}?security=tls&sni=${tunnelHost}&type=ws&host=${tunnelHost}&path=%2Ftrojan#CF-优选-Trojan`;

        tunnelNodes = {
            vless: tunnelVless,
            vmess: tunnelVmess,
            trojan: tunnelTrojan
        };

        activeList.push(tunnelVless, tunnelVmess, tunnelTrojan);
    }

    return {
        direct: directNodes,
        tunnel: tunnelNodes,
        subBase64: Buffer.from(activeList.join("\n")).toString("base64")
    };
}

// ==================== 5. HTTP 业务与水墨国风主页 ====================
function handleHttpRequest(req, res) {
    const rawUrl = req.url || "/";
    const userAgent = (req.headers["user-agent"] || "").toLowerCase();
    const isProxyClient = userAgent.includes("v2ray") || userAgent.includes("clash") || userAgent.includes("sing-box") || userAgent.includes("shadowrocket");
    const nodes = getDynamicNodes();

    // 订阅请求处理
    if (rawUrl.startsWith("/sub") || isProxyClient) {
        res.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8",
            "Subscription-Userinfo": "upload=0; download=0; total=1073741824000; expire=0"
        });
        res.end(nodes.subBase64);
        return;
    }

    // 网页主页展示
    if (rawUrl === "/") {
        const subUrl = isTunnelAvailable 
            ? `https://${ARGO_DOMAIN}/sub` 
            : `http://${DIRECT_IP}:${SERVER_PORT}/sub`;

        const tunnelSectionHtml = isTunnelAvailable ? `
            <div class="section-title"><span>✦</span> 二、覆灵幽谷 (优选域名 ${OPTIMIZED_DOMAIN} | SNI: ${ARGO_DOMAIN})</div>
            <div class="node-card">
                <div class="node-header"><span class="tag-tunnel">优选 VLESS (TLS)</span><span>千峰隐匿 · 抗阻</span></div>
                <textarea readonly onclick="this.select()">${nodes.tunnel.vless}</textarea>
            </div>
            <div class="node-card">
                <div class="node-header"><span class="tag-tunnel">优选 VMess (TLS)</span><span>重云深护</span></div>
                <textarea readonly onclick="this.select()">${nodes.tunnel.vmess}</textarea>
            </div>
            <div class="node-card">
                <div class="node-header"><span class="tag-tunnel">优选 Trojan (TLS)</span><span>金石难移</span></div>
                <textarea readonly onclick="this.select()">${nodes.tunnel.trojan}</textarea>
            </div>
        ` : "";

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
            <!DOCTYPE html>
            <html lang="zh-CN">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>山海清绝 - 节点雅集</title>
                <style>
                    :root {
                        --bg-paper: #f4efe6;
                        --bg-paper-dark: #e8e0d1;
                        --ink-black: #2b2b2b;
                        --ink-medium: #4a4a4a;
                        --dai-blue: #2c4053;
                        --zhusha-red: #9e2a2b;
                        --tan-wood: #8c7b6d;
                    }
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: "Songti SC", "Noto Serif SC", "SimSun", serif;
                        background-color: var(--bg-paper);
                        color: var(--ink-black);
                        min-height: 100vh;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        background-image: 
                            radial-gradient(var(--bg-paper-dark) 15%, transparent 16%),
                            radial-gradient(var(--bg-paper-dark) 15%, transparent 16%);
                        background-size: 60px 60px;
                        background-position: 0 0, 30px 30px;
                    }
                    .page-border {
                        position: fixed;
                        top: 12px; left: 12px; right: 12px; bottom: 12px;
                        border: 1px solid var(--tan-wood);
                        pointer-events: none;
                        z-index: 99;
                    }
                    .page-border::after {
                        content: "";
                        position: absolute;
                        top: 4px; left: 4px; right: 4px; bottom: 4px;
                        border: 1px dashed rgba(140, 123, 109, 0.4);
                    }
                    .container {
                        width: 100%;
                        max-width: 860px;
                        padding: 45px 20px 30px;
                        z-index: 2;
                    }
                    .header {
                        text-align: center;
                        margin-bottom: 24px;
                    }
                    .header-title-wrap {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 14px;
                    }
                    .title {
                        font-size: 32px;
                        letter-spacing: 5px;
                        font-weight: 700;
                    }
                    .seal {
                        width: 32px;
                        height: 32px;
                        border: 2px solid var(--zhusha-red);
                        color: var(--zhusha-red);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 13px;
                        font-weight: bold;
                        border-radius: 4px;
                        transform: rotate(-5deg);
                    }
                    .subtitle {
                        font-size: 14px;
                        color: var(--ink-medium);
                        letter-spacing: 2px;
                        margin-top: 6px;
                    }
                    .poem-box {
                        background-color: rgba(255, 255, 255, 0.45);
                        border-left: 3px solid var(--zhusha-red);
                        padding: 12px 18px;
                        margin-bottom: 20px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-style: italic;
                    }
                    .sub-card {
                        background: rgba(255, 255, 255, 0.75);
                        border: 1px solid var(--tan-wood);
                        padding: 16px;
                        margin-bottom: 24px;
                    }
                    .sub-input {
                        width: 100%;
                        padding: 8px 12px;
                        font-family: monospace;
                        background: #fff;
                        border: 1px solid var(--tan-wood);
                        margin-top: 8px;
                        color: var(--dai-blue);
                        font-weight: bold;
                    }
                    .section-title {
                        font-size: 16px;
                        color: var(--dai-blue);
                        letter-spacing: 2px;
                        margin: 18px 0 10px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .node-card {
                        background: rgba(255, 255, 255, 0.7);
                        border: 1px solid var(--tan-wood);
                        padding: 12px 16px;
                        margin-bottom: 12px;
                        transition: all 0.2s ease;
                    }
                    .node-card:hover {
                        border-color: var(--zhusha-red);
                        background: #fff;
                        transform: translateY(-2px);
                    }
                    .node-header {
                        display: flex;
                        justify-content: space-between;
                        margin-bottom: 6px;
                        font-size: 14px;
                        font-weight: 600;
                    }
                    textarea {
                        width: 100%;
                        height: 42px;
                        box-sizing: border-box;
                        padding: 6px;
                        font-family: monospace;
                        font-size: 12px;
                        border: 1px solid #d4cbbd;
                        background: rgba(244, 239, 230, 0.4);
                        resize: none;
                    }
                    .tag-direct { color: #854d0e; }
                    .tag-tunnel { color: var(--dai-blue); }
                    .footer {
                        text-align: center;
                        font-size: 12px;
                        color: var(--ink-medium);
                        letter-spacing: 2px;
                        margin-top: 30px;
                    }
                </style>
            </head>
            <body>
                <div class="page-border"></div>
                <div class="container">
                    <header class="header">
                        <div class="header-title-wrap">
                            <h1 class="title">山海清绝</h1>
                            <div class="seal">心印</div>
                        </div>
                        <p class="subtitle">万籁收声天地静 · 一溪流水照浮云</p>
                    </header>

                    <div class="poem-box">
                        <span id="poem">行到水穷处，坐看云起时。</span>
                        <span style="font-size: 12px; color: var(--tan-wood); cursor: pointer;" onclick="nextPoem()">[换一篇]</span>
                    </div>

                    <div class="sub-card">
                        <strong style="color: var(--zhusha-red);">引渡全谱（客户端一键订阅）：</strong>
                        <input class="sub-input" readonly onclick="this.select(); document.execCommand('copy'); alert('订阅链接已复制！');" value="${subUrl}" />
                    </div>

                    <div class="section-title"><span>✦</span> 一、直连古径 (物理端位 ${DIRECT_IP}:${SERVER_PORT})</div>
                    <div class="node-card">
                        <div class="node-header"><span class="tag-direct">直连 VLESS</span><span>免覆灵网 · 极速</span></div>
                        <textarea readonly onclick="this.select()">${nodes.direct.vless}</textarea>
                    </div>
                    <div class="node-card">
                        <div class="node-header"><span class="tag-direct">直连 VMess</span><span>轻量通流</span></div>
                        <textarea readonly onclick="this.select()">${nodes.direct.vmess}</textarea>
                    </div>
                    <div class="node-card">
                        <div class="node-header"><span class="tag-direct">直连 Trojan</span><span>本色通明</span></div>
                        <textarea readonly onclick="this.select()">${nodes.direct.trojan}</textarea>
                    </div>

                    ${tunnelSectionHtml}

                    <footer class="footer">
                        <p>© 丙午年 · 自适轩 · 随性而安</p>
                    </footer>
                </div>

                <script>
                    const poems = [
                        "行到水穷处，坐看云起时。",
                        "山气日夕佳，飞鸟相与还。",
                        "小舟从此逝，江海寄余生。",
                        "晚来天欲雪，能饮一杯无？",
                        "风烟俱净，天山共色。从流飘荡，任意东西。"
                    ];
                    let pIdx = 0;
                    function nextPoem() {
                        pIdx = (pIdx + 1) % poems.length;
                        document.getElementById("poem").innerText = poems[pIdx];
                    }
                </script>
            </body>
            </html>
        `);
        return;
    }

    res.writeHead(404);
    res.end();
}

// ==================== 6. WebSocket 弹性分流 ====================
function handleUpgradeRequest(req, clientSocket, head) {
    const rawUrl = (req.url || "").toLowerCase();
    let targetPort = null;
    let targetPath = "/";

    if (rawUrl.includes("vless")) {
        targetPort = INTERNAL_VLESS_PORT;
        targetPath = "/vless";
    } else if (rawUrl.includes("vmess")) {
        targetPort = INTERNAL_VMESS_PORT;
        targetPath = "/vmess";
    } else if (rawUrl.includes("trojan")) {
        targetPort = INTERNAL_TROJAN_PORT;
        targetPath = "/trojan";
    }

    if (targetPort) {
        const backendSocket = net.connect(targetPort, "127.0.0.1", () => {
            let requestRaw = `${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n`;
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                requestRaw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
            }
            requestRaw += "\r\n";

            backendSocket.write(requestRaw);
            if (head && head.length > 0) backendSocket.write(head);

            clientSocket.pipe(backendSocket);
            backendSocket.pipe(clientSocket);
        });

        backendSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => backendSocket.destroy());
    } else {
        clientSocket.destroy();
    }
}

// ==================== 7. 端口监听与服务自启 ====================
// 监听翼龙面板分配的物理端口
const serverExternal = http.createServer(handleHttpRequest);
serverExternal.on("upgrade", handleUpgradeRequest);
serverExternal.listen(SERVER_PORT, "0.0.0.0", () => {
    console.log(`[Pterodactyl] 翼龙面板服务已成功监听物理端口: ${SERVER_PORT}`);
    initAndStartSingbox();
    initAndStartCloudflared();
});

// 若未来临时需要开启隧道，保留内部端口监听支持
if (isTunnelAvailable) {
    const serverTunnel = http.createServer(handleHttpRequest);
    serverTunnel.on("upgrade", handleUpgradeRequest);
    serverTunnel.listen(PORT_TUNNEL, "0.0.0.0", () => {
        console.log(`[Gateway-Tunnel] 隧道回源端口就绪: ${PORT_TUNNEL}`);
    });
}
