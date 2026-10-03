/**
 * =========================================================================
 * 🚀 Kata-Tunnel: 纯原生 Node.js VLESS-WebSocket 隧道与微测网三网优选管理中枢
 * =========================================================================
 * 适配硬件规格：308 MB RAM | 716 MB NVMe | 25% CPU | 翼龙面板单端口环境
 * 核心设计指标：
 *   1. 纯原生 0 外部重型依赖，常态内存仅 20MB~30MB，彻底杜绝 OOM 崩溃；
 *   2. 原生 VLESS-over-WebSocket 协议握手与 RFC 6455 帧解析，0 二进制开销；
 *   3. 毫秒级定向连接控制：删除/封禁用户立即 0 毫秒掐断连接，新增用户立即连通，
 *      且对其他正在通信的在线用户绝对 0 影响（零闪断、零感知）；
 *   4. 微测网 (wetest.vip) 三网优选动态池清洗（电信 CT / 联通 CU / 移动 CM，彻底剔除 AWS）；
 *   5. 前台：微测网清爽专业风格三网测速大屏与用户控制台；
 *   6. 后台：Element UI 现代化明亮扁平后台，支持修改管理员密码并实时回写落盘 .env。
 * =========================================================================
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

// ==========================================
// 1. 路径与持久化目录
// ==========================================
const BASE_DIR = __dirname;
const DATA_DIR = path.join(BASE_DIR, 'data');
const ENV_FILE = path.join(BASE_DIR, '.env');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==========================================
// 2. .env 环境变量管理 (支持热修改并原子写盘)
// ==========================================
function parseEnvFile(filePath) {
    const envObj = {};
    if (!fs.existsSync(filePath)) return envObj;
    const content = fs.readFileSync(filePath, 'utf-8');
    content.split(/\r?\n/).forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
            const k = line.substring(0, eqIdx).trim();
            const v = line.substring(eqIdx + 1).trim();
            envObj[k] = v;
        }
    });
    return envObj;
}

function updateEnvFile(updates) {
    let lines = [];
    if (fs.existsSync(ENV_FILE)) {
        lines = fs.readFileSync(ENV_FILE, 'utf-8').split(/\r?\n/);
    }
    const updatedKeys = new Set();
    const newLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
            const k = trimmed.substring(0, eqIdx).trim();
            if (updates.hasOwnProperty(k)) {
                updatedKeys.add(k);
                return `${k}=${updates[k]}`;
            }
        }
        return line;
    });

    for (const [k, v] of Object.entries(updates)) {
        if (!updatedKeys.has(k)) {
            newLines.push(`${k}=${v}`);
        }
    }

    const tmpFile = ENV_FILE + '.tmp.' + Date.now();
    fs.writeFileSync(tmpFile, newLines.join('\n'), 'utf-8');
    fs.renameSync(tmpFile, ENV_FILE);
    console.log(`[Env] .env 配置文件已原子更新:`, Object.keys(updates).join(', '));
}


// ==========================================
// ==========================================
// 2.1 Cloudflare Argo 隧道智能感知与守护引擎
// ==========================================
// 核心逻辑：
// 1. 本地已有合法程序 -> 绝不重复下载，0毫秒直接启动；
// 2. 换服务器/新环境无程序 -> 自动探测 CPU/OS 架构，静默下载高速二进制并赋权运行；
// 3. 进程异常退出 -> 自动拉起自愈，无缝保障隧道高可用。
let argoProcess = null;
let argoStatus = 'stopped'; // 'connected', 'running', 'downloading', 'stopped', 'error'
let argoLastLog = '';
let isArgoDownloading = false;

function downloadFileWithRedirect(targetUrl, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('重定向层级过多'));
        const lib = targetUrl.startsWith('https') ? require('https') : require('http');
        const req = lib.get(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, targetUrl).toString();
                return downloadFileWithRedirect(nextUrl, destPath, maxRedirects - 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
            }
            const fileStream = fs.createWriteStream(destPath);
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });
            fileStream.on('error', err => {
                try { fs.unlinkSync(destPath); } catch (e) {}
                reject(err);
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('下载连接超时'));
        });
    });
}

async function autoFetchCloudflared(destPath) {
    if (isArgoDownloading) return;
    isArgoDownloading = true;
    argoStatus = 'downloading';

    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    console.log(`[Argo] 🌐 检测到新环境无 ./cloudflared，准备自动匹配 (linux-${arch}) 进行静默下载...`);

    const downloadCandidates = [
        `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
        `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`
    ];

    const tmpFile = destPath + '.tmp.' + Date.now();
    let success = false;

    // 先尝试系统自带的 curl 命令（若宿主环境具备 curl 则速度极快且稳健）
    try {
        const { execSync } = require('child_process');
        for (const dlUrl of downloadCandidates) {
            try {
                console.log(`[Argo] 尝试通过系统 curl 下载: ${dlUrl}`);
                execSync(`curl -L -s --connect-timeout 15 -m 120 "${dlUrl}" -o "${tmpFile}"`, { stdio: 'ignore' });
                if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 10 * 1024 * 1024) {
                    fs.renameSync(tmpFile, destPath);
                    success = true;
                    console.log(`[Argo] ✅ curl 下载完成并通过校验！`);
                    break;
                }
            } catch (ce) {}
        }
    } catch (e) {}

    // 若 curl 失败，使用纯原生 Node.js 流式下载器兜底
    if (!success) {
        for (const dlUrl of downloadCandidates) {
            try {
                console.log(`[Argo] 尝试通过原生 HTTP 流式下载: ${dlUrl}`);
                await downloadFileWithRedirect(dlUrl, tmpFile);
                if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 10 * 1024 * 1024) {
                    fs.renameSync(tmpFile, destPath);
                    success = true;
                    console.log(`[Argo] ✅ 原生 HTTP 流下载完成！`);
                    break;
                }
            } catch (err) {
                console.error(`[Argo] 节点下载重试: ${err.message}`);
            }
        }
    }

    isArgoDownloading = false;
    if (!success) {
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e) {}
        throw new Error('所有源下载均失败，请检查服务器公网网络连接');
    }
}

async function startArgoTunnel(token) {
    if (!token || token.trim() === '') {
        stopArgoTunnel();
        return;
    }
    stopArgoTunnel();

    const binPath = path.join(BASE_DIR, 'cloudflared');

    // 智能检测机制：检查本地是否有完整合法的程序 (大于 10MB)
    let needDownload = true;
    if (fs.existsSync(binPath)) {
        try {
            const stat = fs.statSync(binPath);
            if (stat.size > 10 * 1024 * 1024) {
                needDownload = false;
                console.log(`[Argo] ✅ 检测到本地已存在合法的 cloudflared 程序 (${formatBytes(stat.size)})，直接启动，绝不重复下载！`);
            } else {
                console.log(`[Argo] ⚠️ 本地文件大小异常 (${stat.size} 字节)，将重新拉取`);
            }
        } catch (e) {}
    }

    if (needDownload) {
        try {
            await autoFetchCloudflared(binPath);
        } catch (err) {
            console.error(`[Argo] ❌ 自动下载程序失败: ${err.message}`);
            argoStatus = 'error';
            return;
        }
    }

    try {
        fs.chmodSync(binPath, 0o755);
    } catch (e) {}

    console.log('[Argo] 🚀 正在拉起 Cloudflare Argo 隧道守护进程...');
    argoStatus = 'starting';

    try {
        argoProcess = spawn(binPath, ['tunnel', '--no-autoupdate', 'run', '--token', token.trim()], {
            cwd: BASE_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        argoProcess.stdout.on('data', chunk => {
            const str = chunk.toString();
            argoLastLog = str.trim();
            console.log(`[Argo STDOUT] ${argoLastLog}`);
        });

        argoProcess.stderr.on('data', chunk => {
            const str = chunk.toString();
            argoLastLog = str.trim();
            if (str.includes('Registered tunnel connection') || (str.includes('Connection') && str.includes('registered'))) {
                argoStatus = 'connected';
                console.log(`[Argo] 🟢 隧道已成功握手接入 Cloudflare 全球边缘网络！443端口直通与三网优选已全面激活！`);
            }
            console.log(`[Argo LOG] ${argoLastLog}`);
        });

        argoProcess.on('exit', (code, signal) => {
            console.log(`[Argo] 进程退出: code=${code}, signal=${signal}`);
            argoStatus = 'stopped';
            argoProcess = null;
        });

        argoProcess.on('error', err => {
            console.error(`[Argo] 进程异常: ${err.message}`);
            argoStatus = 'error';
            argoProcess = null;
        });
    } catch (err) {
        console.error(`[Argo] 进程启动抛出异常: ${err.message}`);
        argoStatus = 'error';
    }
}

function stopArgoTunnel() {
    if (argoProcess) {
        console.log('[Argo] 🛑 停止现有 Argo 隧道守护进程...');
        try {
            argoProcess.kill('SIGTERM');
        } catch (e) {}
        argoProcess = null;
        argoStatus = 'stopped';
    }
}

// 优先读取 .env
const initialEnv = parseEnvFile(ENV_FILE);
function getEnv(key, defVal = '') {
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    if (initialEnv[key] !== undefined && initialEnv[key] !== '') return initialEnv[key];
    return defVal;
}

// 端口自动探测（优先读取翼龙面板环境变量 SERVER_PORT）
const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || initialEnv.SERVER_PORT || initialEnv.PORT || '20255', 10);
let ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD', 'admin123');

// ==========================================
// 3. 运营配置与三网优选池持久化
// ==========================================
const DEFAULT_SETTINGS = {
    allowRegister: getEnv('DEFAULT_ALLOW_REGISTER', 'true') === 'true',
    defaultDays: parseInt(getEnv('DEFAULT_DAYS', '365'), 10),
    defaultTrafficGB: parseInt(getEnv('DEFAULT_TRAFFIC_GB', '100'), 10),
    subDomain: getEnv('SUB_DOMAIN', ''),
    argoToken: getEnv('ARGO_TOKEN', ''),
    argoDomain: getEnv('ARGO_DOMAIN', ''),

    // 微测网三网优选独立开关 (彻底无 AWS)
    enableOptOfficial: true,
    enableOptCT: true,
    enableOptCU: true,
    enableOptCM: true,
    autoSyncWetest: true,

    // 各运营商覆盖首选 IP
    optOfficialIp: '',
    optCTIp: '104.25.18.145',
    optCUIp: '104.19.152.130',
    optCMIp: '104.21.90.61',

    // 优选池缓存
    wetestSyncTime: '未同步',
    cfNodes: {
        official: [
            { ip: "104.16.132.229", colo: "HKG", rtt: 37 },
            { ip: "104.16.133.229", colo: "HKG", rtt: 38 },
            { ip: "172.67.182.190", colo: "HKG", rtt: 39 }
        ],
        ct: [
            { ip: "104.25.18.145", colo: "FRA", rtt: 168 },
            { ip: "104.25.19.145", colo: "LAX", rtt: 182 },
            { ip: "104.22.40.145", colo: "SJC", rtt: 185 }
        ],
        cu: [
            { ip: "104.19.152.130", colo: "SJC", rtt: 130 },
            { ip: "104.19.153.130", colo: "SJC", rtt: 135 },
            { ip: "104.18.33.111", colo: "LAX", rtt: 142 }
        ],
        cm: [
            { ip: "104.21.90.61", colo: "HKG", rtt: 48 },
            { ip: "104.21.91.61", colo: "HKG", rtt: 52 },
            { ip: "172.67.170.88", colo: "HKG", rtt: 56 }
        ]
    }
};

let siteSettings = Object.assign({}, DEFAULT_SETTINGS);
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        siteSettings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    } catch (e) {
        console.error('[Settings] 读取 settings.json 异常，使用默认配置:', e.message);
    }
}

function saveSettings() {
    try {
        const tmp = SETTINGS_FILE + '.tmp.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(siteSettings, null, 2), 'utf-8');
        fs.renameSync(tmp, SETTINGS_FILE);
    } catch (e) {
        console.error('[Settings] 保存 settings.json 失败:', e.message);
    }
}

// ==========================================
// 4. 用户账号库与 0 毫秒定向连接池控制
// ==========================================
let users = new Map(); // uuid -> userObject

// 活跃套接字映射表：uuid -> Set<{ clientSocket, targetSocket, wsStream }>
const activeConnections = new Map();

function loadUsers() {
    users.clear();
    if (fs.existsSync(USERS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
            if (Array.isArray(raw)) {
                raw.forEach(u => { if (u && u.uuid) users.set(u.uuid, u); });
            } else if (typeof raw === 'object') {
                Object.values(raw).forEach(u => { if (u && u.uuid) users.set(u.uuid, u); });
            }
        } catch (e) {
            console.error('[Users] 读取 users.json 异常:', e.message);
        }
    }

    // 若无任何用户，自动生成管理员预设初始用户
    if (users.size === 0) {
        const initUuid = crypto.randomUUID();
        const initUser = {
            uuid: initUuid,
            username: 'admin_user',
            passwordHash: crypto.createHash('sha256').update('123456').digest('hex'),
            trafficLimit: siteSettings.defaultTrafficGB * 1024 * 1024 * 1024,
            trafficUsed: 0,
            expireTime: Date.now() + siteSettings.defaultDays * 86400 * 1000,
            enabled: true,
            createdAt: new Date().toISOString()
        };
        users.set(initUuid, initUser);
        saveUsers();
        console.log(`[Users] 已初始化默认用户: admin_user | UUID: ${initUuid}`);
    }
}

function saveUsers() {
    try {
        const arr = Array.from(users.values());
        const tmp = USERS_FILE + '.tmp.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8');
        fs.renameSync(tmp, USERS_FILE);
    } catch (e) {
        console.error('[Users] 保存 users.json 失败:', e.message);
    }
}

loadUsers();

/**
 * 核心特性：0 毫秒定向掐断用户所有活跃长连接！
 * @param {string} uuid 用户 UUID
 * @param {string} reason 断开原因
 */
function disconnectUser(uuid, reason = '管理指令即时熔断') {
    const conns = activeConnections.get(uuid);
    if (!conns || conns.size === 0) return 0;
    const count = conns.size;
    console.log(`[Pipeline] ⚡ 正在为用户 ${uuid} 定向掐断 ${count} 个活跃长连接 (原因: ${reason})...`);
    conns.forEach(item => {
        try {
            if (item.clientSocket && !item.clientSocket.destroyed) {
                item.clientSocket.destroy();
            }
            if (item.targetSocket && !item.targetSocket.destroyed) {
                item.targetSocket.destroy();
            }
        } catch (_) {}
    });
    activeConnections.delete(uuid);
    return count;
}

function registerUserConnection(uuid, clientSocket, targetSocket) {
    if (!activeConnections.has(uuid)) {
        activeConnections.set(uuid, new Set());
    }
    const item = { clientSocket, targetSocket };
    activeConnections.get(uuid).add(item);

    const cleanup = () => {
        const set = activeConnections.get(uuid);
        if (set) {
            set.delete(item);
            if (set.size === 0) activeConnections.delete(uuid);
        }
    };
    clientSocket.once('close', cleanup);
    clientSocket.once('error', cleanup);
    if (targetSocket) {
        targetSocket.once('close', cleanup);
        targetSocket.once('error', cleanup);
    }
}

// ==========================================
// 5. 微测网 (Wetest.vip) 异步抓取引擎 (仅 CF)
// ==========================================
function fetchJsonUrl(reqUrl, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new url.URL(reqUrl);
            const client = parsed.protocol === 'https:' ? require('https') : require('http');
            const req = client.get(reqUrl, { timeout: timeoutMs }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsedJson = JSON.parse(data);
                        resolve(parsedJson);
                    } catch (e) {
                        reject(new Error(`JSON 解析失败: ${e.message}`));
                    }
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
            req.on('error', err => reject(err));
        } catch (e) {
            reject(e);
        }
    });
}

function normalizeWetestItemList(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(item => {
        let ip = '', colo = '', rtt = 0;
        if (typeof item === 'string') {
            ip = item.trim();
        } else if (item && typeof item === 'object') {
            ip = (item.ip || item.node || '').trim();
            colo = (item.colo || item.datacenter || item.city || '').toUpperCase();
            rtt = parseInt(item.rtt || item.ping || item.latency || 0, 10);
        }
        return { ip, colo, rtt };
    }).filter(x => x.ip && /^[\d\.]+$/.test(x.ip));
}

async function fetchWetestCleanIps() {
    console.log('[Wetest] 开始从微测网全量动态拉取三网 Cloudflare 优选 IP (不含 AWS)...');
    const cfUrl = 'https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4';
    try {
        const cfRes = await fetchJsonUrl(cfUrl, 10000);
        if (cfRes && (cfRes.code === 200 || cfRes.status === 'success' || cfRes.info)) {
            const rawData = cfRes.data || cfRes.info || {};
            const cleanCT = normalizeWetestItemList(rawData.ct || rawData.dx || rawData.telecom);
            const cleanCU = normalizeWetestItemList(rawData.cu || rawData.lt || rawData.unicom);
            const cleanCM = normalizeWetestItemList(rawData.cm || rawData.yd || rawData.mobile);
            const cleanCN = normalizeWetestItemList(rawData.all || rawData.anycast || rawData.cn || []);

            const sortByRtt = (list) => list.sort((a, b) => (a.rtt || 999) - (b.rtt || 999));

            if (cleanCT.length > 0) siteSettings.cfNodes.ct = sortByRtt(cleanCT).slice(0, 5);
            if (cleanCU.length > 0) siteSettings.cfNodes.cu = sortByRtt(cleanCU).slice(0, 5);
            if (cleanCM.length > 0) siteSettings.cfNodes.cm = sortByRtt(cleanCM).slice(0, 5);
            if (cleanCN.length > 0) siteSettings.cfNodes.official = sortByRtt(cleanCN).slice(0, 5);

            siteSettings.wetestSyncTime = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
            saveSettings();
            console.log(`[Wetest] ✅ 微测网三网 IP 抓取成功！CT:${siteSettings.cfNodes.ct.length}, CU:${siteSettings.cfNodes.cu.length}, CM:${siteSettings.cfNodes.cm.length}`);
            return { success: true, settings: siteSettings };
        } else {
            throw new Error(cfRes ? (cfRes.msg || cfRes.message || 'API 结构异常') : '返回为空');
        }
    } catch (e) {
        console.error('[Wetest] ❌ 抓取失败:', e.message);
        return { success: false, error: e.message };
    }
}

// 启动 5 秒后首次抓取，之后每 30 分钟自愈刷新
setTimeout(() => { fetchWetestCleanIps(); }, 5000);
setInterval(() => {
    if (siteSettings.autoSyncWetest !== false) {
        fetchWetestCleanIps();
    }
}, 30 * 60 * 1000);

// ==========================================
// 6. 原生 RFC 6455 WebSocket 帧流解析与封包
// ==========================================
/**
 * 封装向客户端发送的 Unmasked 二进制 WebSocket Frame
 */
function createWsBinaryFrame(buffer) {
    const len = buffer.length;
    let header;
    if (len <= 125) {
        header = Buffer.alloc(2);
        header[0] = 0x82; // Fin=1, Opcode=2 (Binary)
        header[1] = len;  // Mask=0
    } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x82;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x82;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, buffer]);
}

/**
 * 原生极简 WebSocket 帧拆包流转换器
 */
class WsFrameDecoder {
    constructor(onPayload, onClose) {
        this.buffer = Buffer.alloc(0);
        this.onPayload = onPayload;
        this.onClose = onClose;
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 2) {
            const b0 = this.buffer[0];
            const b1 = this.buffer[1];
            const opcode = b0 & 0x0f;
            const isMasked = (b1 & 0x80) !== 0;
            let payloadLen = b1 & 0x7f;
            let offset = 2;

            if (opcode === 0x08) { // Close
                if (this.onClose) this.onClose();
                return;
            }

            if (payloadLen === 126) {
                if (this.buffer.length < 4) return;
                payloadLen = this.buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this.buffer.length < 10) return;
                payloadLen = Number(this.buffer.readBigUInt64BE(2));
                offset = 10;
            }

            const maskLen = isMasked ? 4 : 0;
            if (this.buffer.length < offset + maskLen + payloadLen) return;

            let maskKey = null;
            if (isMasked) {
                maskKey = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }

            const payload = this.buffer.subarray(offset, offset + payloadLen);
            this.buffer = this.buffer.subarray(offset + payloadLen);

            if (isMasked && maskKey) {
                const unmasked = Buffer.allocUnsafe(payload.length);
                for (let i = 0; i < payload.length; i++) {
                    unmasked[i] = payload[i] ^ maskKey[i % 4];
                }
                this.onPayload(unmasked);
            } else {
                this.onPayload(payload);
            }
        }
    }
}

// ==========================================
// 7. 原生 VLESS 协议解析与 TCP 出站透明代理
// ==========================================
function parseVlessHeader(buffer) {
    if (buffer.length < 24) return null;
    const version = buffer[0];
    const uuidBytes = buffer.subarray(1, 17);
    const uuid = [
        uuidBytes.subarray(0, 4).toString('hex'),
        uuidBytes.subarray(4, 6).toString('hex'),
        uuidBytes.subarray(6, 8).toString('hex'),
        uuidBytes.subarray(8, 10).toString('hex'),
        uuidBytes.subarray(10, 16).toString('hex')
    ].join('-');

    let offset = 17;
    const addonLen = buffer[offset];
    offset += 1 + addonLen;

    const command = buffer[offset]; // 1 = TCP, 2 = UDP
    offset += 1;

    const port = buffer.readUInt16BE(offset);
    offset += 2;

    const addrType = buffer[offset];
    offset += 1;

    let address = '';
    if (addrType === 1) { // IPv4
        address = Array.from(buffer.subarray(offset, offset + 4)).join('.');
        offset += 4;
    } else if (addrType === 2) { // Domain
        const domainLen = buffer[offset];
        offset += 1;
        address = buffer.subarray(offset, offset + domainLen).toString('utf-8');
        offset += domainLen;
    } else if (addrType === 3) { // IPv6
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(buffer.readUInt16BE(offset + i).toString(16));
        }
        address = parts.join(':');
        offset += 16;
    }

    const payload = buffer.subarray(offset);
    return { version, uuid, command, port, address, payload, headerLength: offset };
}

function handleVlessWebSocket(clientSocket, head) {
    let targetSocket = null;
    let targetConnected = false;
    let currentUser = null;
    let isHeaderProcessed = false;
    const pendingPayloads = [];

    const decoder = new WsFrameDecoder(
        (data) => {
            if (!isHeaderProcessed) {
                isHeaderProcessed = true;
                const header = parseVlessHeader(data);
                if (!header) {
                    clientSocket.destroy();
                    return;
                }

                currentUser = users.get(header.uuid);
                if (!currentUser) {
                    console.log(`[Auth] ❌ 未知 UUID 请求已被拒: ${header.uuid}`);
                    clientSocket.destroy();
                    return;
                }
                if (!currentUser.enabled) {
                    console.log(`[Auth] 🚫 被封禁用户连接已被立即拒止: ${currentUser.username} (${currentUser.uuid})`);
                    clientSocket.destroy();
                    return;
                }
                if (Date.now() > currentUser.expireTime) {
                    console.log(`[Auth] ⏰ 到期用户连接已被拒止: ${currentUser.username}`);
                    clientSocket.destroy();
                    return;
                }
                if (currentUser.trafficUsed >= currentUser.trafficLimit) {
                    console.log(`[Auth] ⚠️ 流量超额用户已被熔断: ${currentUser.username}`);
                    clientSocket.destroy();
                    return;
                }

                // 注册进入活跃连接池（支持管理端即时精准熔断）
                registerUserConnection(currentUser.uuid, clientSocket, null);

                // 发送 VLESS 首帧握手成功响应: [version=0, addonLen=0]
                const vlessResp = Buffer.from([0x00, 0x00]);
                clientSocket.write(createWsBinaryFrame(vlessResp));

                // 建立出站 TCP 连接
                targetSocket = net.createConnection({ host: header.address, port: header.port }, () => {
                    targetConnected = true;
                    if (header.payload && header.payload.length > 0) {
                        targetSocket.write(header.payload);
                        currentUser.trafficUsed += header.payload.length;
                    }
                    while (pendingPayloads.length > 0) {
                        const p = pendingPayloads.shift();
                        targetSocket.write(p);
                        currentUser.trafficUsed += p.length;
                    }
                });

                registerUserConnection(currentUser.uuid, clientSocket, targetSocket);

                targetSocket.on('data', (chunk) => {
                    if (currentUser) {
                        currentUser.trafficUsed += chunk.length;
                        if (currentUser.trafficUsed >= currentUser.trafficLimit) {
                            disconnectUser(currentUser.uuid, '流量耗尽实时断流');
                            return;
                        }
                    }
                    const frame = createWsBinaryFrame(chunk);
                    const canWrite = clientSocket.write(frame);
                    if (!canWrite && targetSocket) targetSocket.pause();
                });

                clientSocket.on('drain', () => {
                    if (targetSocket) targetSocket.resume();
                });

                targetSocket.on('error', () => { clientSocket.destroy(); });
                targetSocket.on('close', () => { clientSocket.destroy(); });
            } else {
                if (currentUser) {
                    currentUser.trafficUsed += data.length;
                }
                if (targetConnected && targetSocket) {
                    targetSocket.write(data);
                } else {
                    pendingPayloads.push(data);
                }
            }
        },
        () => {
            if (targetSocket) targetSocket.destroy();
            clientSocket.destroy();
        }
    );

    clientSocket.on('data', chunk => decoder.push(chunk));
    clientSocket.on('error', () => { if (targetSocket) targetSocket.destroy(); });
    clientSocket.on('close', () => { if (targetSocket) targetSocket.destroy(); });

    if (head && head.length > 0) {
        decoder.push(head);
    }
}

// 定时 30 秒落盘一次已用流量，兼顾极高性能与数据持久化
setInterval(() => { saveUsers(); }, 30000);

// ==========================================
// 8. 订阅链接生成引擎 (Base64 / 节点格式)
// ==========================================
function generateUserNodes(user) {
    const list = [];
    const host = siteSettings.subDomain || initialEnv.SERVER_IP || '51.75.118.151';
    const domain = siteSettings.argoDomain || siteSettings.subDomain || host;

    // 1. 卡塔原生端口直连节点
    const directTag = `【卡塔·原生直连·${PORT}】-VLESS-WS`;
    list.push(`vless://${user.uuid}@${host}:${PORT}?encryption=none&security=none&type=ws&host=${encodeURIComponent(host)}&path=%2F#${encodeURIComponent(directTag)}`);

    // 1.1 若配置了 Cloudflare Argo 隧道域名，额外下发专属 443 端口隧道直连节点
    if (siteSettings.argoDomain) {
        const argoTag = `【CF·Argo隧道直连·443】-VLESS-WS`;
        list.push(`vless://${user.uuid}@${siteSettings.argoDomain}:443?encryption=none&security=tls&sni=${encodeURIComponent(siteSettings.argoDomain)}&type=ws&host=${encodeURIComponent(siteSettings.argoDomain)}&path=%2F#${encodeURIComponent(argoTag)}`);
    }

    // 2. CF 官方 Anycast
    if (siteSettings.enableOptOfficial !== false) {
        const anyIp = siteSettings.optOfficialIp || (siteSettings.cfNodes.official[0] && siteSettings.cfNodes.official[0].ip) || domain;
        const tag = `【CF·Anycast·443】-VLESS-WS`;
        list.push(`vless://${user.uuid}@${anyIp}:443?encryption=none&security=tls&sni=${encodeURIComponent(domain)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F#${encodeURIComponent(tag)}`);
    }

    // 3. CF 中国电信 (CT) 优选
    if (siteSettings.enableOptCT !== false) {
        const ctList = siteSettings.cfNodes.ct || [];
        ctList.slice(0, 3).forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCTIp) ? siteSettings.optCTIp : n.ip;
            const tag = `【CF·电信优选·${idx + 1}·${n.colo || 'FRA'}·${n.rtt || 160}ms】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(domain)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F#${encodeURIComponent(tag)}`);
        });
    }

    // 4. CF 中国联通 (CU) 优选
    if (siteSettings.enableOptCU !== false) {
        const cuList = siteSettings.cfNodes.cu || [];
        cuList.slice(0, 3).forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCUIp) ? siteSettings.optCUIp : n.ip;
            const tag = `【CF·联通优选·${idx + 1}·${n.colo || 'SJC'}·${n.rtt || 130}ms】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(domain)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F#${encodeURIComponent(tag)}`);
        });
    }

    // 5. CF 中国移动 (CM) 优选
    if (siteSettings.enableOptCM !== false) {
        const cmList = siteSettings.cfNodes.cm || [];
        cmList.slice(0, 3).forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCMIp) ? siteSettings.optCMIp : n.ip;
            const tag = `【CF·移动优选·${idx + 1}·${n.colo || 'HKG'}·${n.rtt || 48}ms】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(domain)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F#${encodeURIComponent(tag)}`);
        });
    }

    return list;
}

// ==========================================
// 9. HTTP 路由分发与 Session 鉴权
// ==========================================
const adminSessions = new Set();
const userSessions = new Map(); // token -> uuid

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach(c => {
            const parts = c.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    return list;
}

function checkAdminAuth(req) {
    const cookies = parseCookies(req);
    if (cookies.admin_token && adminSessions.has(cookies.admin_token)) return true;
    const authHeader = req.headers['x-admin-token'];
    if (authHeader && authHeader === ADMIN_PASSWORD) return true;
    const q = url.parse(req.url, true).query;
    if (q.token && q.token === ADMIN_PASSWORD) return true;
    return false;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==========================================
// 10. Web 服务与 API
// ==========================================
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 通用 JSON 辅助
    const sendJson = (data, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    };
    const sendHtml = (html, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    };

    // 读取 POST Body
    const readBody = (callback) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                callback(JSON.parse(body || '{}'));
            } catch (e) {
                sendJson({ error: '无效 JSON 请求' }, 400);
            }
        });
    };

    // ──────────────── 1. 订阅导出 /sub ────────────────
    if (pathname === '/sub') {
        const token = parsedUrl.query.token || parsedUrl.query.uuid;
        if (!token) return sendJson({ error: '缺少 token 或 uuid 参数' }, 400);
        const user = users.get(token);
        if (!user || !user.enabled || Date.now() > user.expireTime || user.trafficUsed >= user.trafficLimit) {
            return sendJson({ error: '订阅无效、已被封禁或已到期/超额' }, 403);
        }
        const nodeLines = generateUserNodes(user);
        const base64Data = Buffer.from(nodeLines.join('\n'), 'utf-8').toString('base64');
        res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Subscription-Userinfo': `upload=0; download=${user.trafficUsed}; total=${user.trafficLimit}; expire=${Math.floor(user.expireTime / 1000)}`
        });
        return res.end(base64Data);
    }

    // ──────────────── 2. 用户注册与登录 API ────────────────
    if (pathname === '/api/register' && method === 'POST') {
        if (siteSettings.allowRegister === false) {
            return sendJson({ error: '当前系统已关闭新用户自主注册' }, 403);
        }
        readBody(data => {
            const username = (data.username || '').trim();
            const password = (data.password || '').trim();
            if (!username || username.length < 3) return sendJson({ error: '用户名至少3位' }, 400);
            if (!password || password.length < 6) return sendJson({ error: '密码至少6位' }, 400);

            for (const u of users.values()) {
                if (u.username === username) return sendJson({ error: '用户名已被注册' }, 400);
            }

            const uuid = crypto.randomUUID();
            const newUser = {
                uuid,
                username,
                passwordHash: crypto.createHash('sha256').update(password).digest('hex'),
                trafficLimit: siteSettings.defaultTrafficGB * 1024 * 1024 * 1024,
                trafficUsed: 0,
                expireTime: Date.now() + siteSettings.defaultDays * 86400 * 1000,
                enabled: true,
                createdAt: new Date().toISOString()
            };
            users.set(uuid, newUser);
            saveUsers();
            console.log(`[Auth] 🆕 用户注册成功: ${username} | 0ms即刻连接可用`);
            sendJson({ success: true, message: '注册成功', uuid });
        });
        return;
    }

    if (pathname === '/api/login' && method === 'POST') {
        readBody(data => {
            const username = (data.username || '').trim();
            const password = (data.password || '').trim();
            const pHash = crypto.createHash('sha256').update(password).digest('hex');

            for (const u of users.values()) {
                if (u.username === username && u.passwordHash === pHash) {
                    const sessionToken = crypto.randomBytes(16).toString('hex');
                    userSessions.set(sessionToken, u.uuid);
                    res.setHeader('Set-Cookie', `user_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
                    return sendJson({ success: true, user: { username: u.username, uuid: u.uuid } });
                }
            }
            sendJson({ error: '用户名或密码错误' }, 401);
        });
        return;
    }

    if (pathname === '/api/logout') {
        res.setHeader('Set-Cookie', 'user_token=; Path=/; SameSite=Lax; Max-Age=0');
        res.writeHead(302, { Location: '/' });
        return res.end();
    }

    // ──────────────── 3. 管理员鉴权 API ────────────────
    if (pathname === '/admin/api/login' && method === 'POST') {
        readBody(data => {
            const pwd = (data.password || '').trim();
            if (pwd === ADMIN_PASSWORD) {
                const sToken = crypto.randomBytes(16).toString('hex');
                adminSessions.add(sToken);
                res.setHeader('Set-Cookie', `admin_token=${sToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
                return sendJson({ success: true, token: sToken });
            }
            sendJson({ error: '管理员密码错误' }, 401);
        });
        return;
    }

    if (pathname === '/admin/logout') {
        res.setHeader('Set-Cookie', 'admin_token=; Path=/; Max-Age=0');
        res.writeHead(302, { Location: '/admin' });
        return res.end();
    }

    // 管理员 API 保护门禁
    if (pathname.startsWith('/admin/api/')) {
        if (!checkAdminAuth(req)) return sendJson({ error: '未授权访问' }, 401);

        if (pathname === '/admin/api/status') {
            const mem = process.memoryUsage();
            let totalOnlineConns = 0;
            activeConnections.forEach(set => totalOnlineConns += set.size);
            return sendJson({
                uptime: Math.floor(process.uptime()),
                memoryRss: formatBytes(mem.rss),
            argoStatus: argoStatus,
            argoLastLog: argoLastLog,
                memoryHeap: formatBytes(mem.heapUsed),
                onlineConnections: totalOnlineConns,
                port: PORT,
                domain: siteSettings.subDomain || initialEnv.SERVER_IP || '51.75.118.151',
                settings: siteSettings,
                usersCount: users.size
            });
        }

        if (pathname === '/admin/api/sync-wetest' && method === 'POST') {
            fetchWetestCleanIps().then(result => {
                if (result.success) {
                    sendJson({ success: true, message: '微测网三网 IP 全量更新成功', settings: siteSettings });
                } else {
                    sendJson({ error: result.error || '同步失败' }, 500);
                }
            });
            return;
        }

        if (pathname === '/admin/api/settings' && method === 'POST') {
            readBody(data => {
                const envUpdates = {};

                // 1. 密码热修改与回写 .env
                if (data.newAdminPassword && data.newAdminPassword.trim().length >= 5) {
                    ADMIN_PASSWORD = data.newAdminPassword.trim();
                    envUpdates.ADMIN_PASSWORD = ADMIN_PASSWORD;
                    console.log(`[Auth] 🔑 管理员密码已热修改为新密码并落盘 .env！`);
                }

                // 2. 运营配置
                if (data.allowRegister !== undefined) siteSettings.allowRegister = Boolean(data.allowRegister);
                if (data.defaultDays !== undefined) siteSettings.defaultDays = parseInt(data.defaultDays, 10);
                if (data.defaultTrafficGB !== undefined) siteSettings.defaultTrafficGB = parseInt(data.defaultTrafficGB, 10);
                if (data.subDomain !== undefined) {
                    siteSettings.subDomain = data.subDomain.trim();
                    envUpdates.SUB_DOMAIN = siteSettings.subDomain;
                }

                // 3. Cloudflare Argo 隧道配置
                if (data.argoToken !== undefined) {
                    siteSettings.argoToken = data.argoToken.trim();
                    envUpdates.ARGO_TOKEN = siteSettings.argoToken;
                }
                if (data.argoDomain !== undefined) {
                    siteSettings.argoDomain = data.argoDomain.trim();
                    envUpdates.ARGO_DOMAIN = siteSettings.argoDomain;
                }

                // 4. 三网优选开关
                if (data.enableOptOfficial !== undefined) siteSettings.enableOptOfficial = Boolean(data.enableOptOfficial);
                if (data.enableOptCT !== undefined) siteSettings.enableOptCT = Boolean(data.enableOptCT);
                if (data.enableOptCU !== undefined) siteSettings.enableOptCU = Boolean(data.enableOptCU);
                if (data.enableOptCM !== undefined) siteSettings.enableOptCM = Boolean(data.enableOptCM);
                if (data.autoSyncWetest !== undefined) siteSettings.autoSyncWetest = Boolean(data.autoSyncWetest);

                if (data.optOfficialIp !== undefined) siteSettings.optOfficialIp = data.optOfficialIp.trim();
                if (data.optCTIp !== undefined) siteSettings.optCTIp = data.optCTIp.trim();
                if (data.optCUIp !== undefined) siteSettings.optCUIp = data.optCUIp.trim();
                if (data.optCMIp !== undefined) siteSettings.optCMIp = data.optCMIp.trim();

                if (Object.keys(envUpdates).length > 0) {
                    updateEnvFile(envUpdates);
                }

                saveSettings();
                sendJson({ success: true, message: '系统参数与隧道配置已成功落盘热生效！', settings: siteSettings });
            });
            return;
        }

        // 用户管理 API: 增、删、改、查、封、解封、重置、续期
        if (pathname === '/admin/api/users') {
            const list = Array.from(users.values()).map(u => ({
                uuid: u.uuid,
                username: u.username,
                trafficUsed: u.trafficUsed,
                trafficLimit: u.trafficLimit,
                trafficUsedStr: formatBytes(u.trafficUsed),
                trafficLimitStr: formatBytes(u.trafficLimit),
                trafficLimitGB: Math.round(u.trafficLimit / (1024 * 1024 * 1024)),
                trafficUsedMB: Math.round(u.trafficUsed / (1024 * 1024)),
                expireTime: u.expireTime,
                expireDateStr: new Date(u.expireTime).toLocaleDateString('zh-CN'),
                expireDateISO: new Date(u.expireTime).toISOString().split('T')[0],
                enabled: u.enabled,
                isExpired: Date.now() > u.expireTime,
                isExhausted: u.trafficUsed >= u.trafficLimit,
                onlineConns: (activeConnections.get(u.uuid) || new Set()).size
            }));
            return sendJson({ users: list });
        }

        if (pathname === '/admin/api/user/add' && method === 'POST') {
            readBody(data => {
                const username = (data.username || '').trim();
                if (!username) return sendJson({ error: '用户名不能为空' }, 400);
                for (const u of users.values()) {
                    if (u.username === username) return sendJson({ error: '该用户名已存在' }, 400);
                }
                const uuid = (data.uuid && data.uuid.trim().length >= 32) ? data.uuid.trim() : crypto.randomUUID();
                if (users.has(uuid)) return sendJson({ error: '该 UUID 已存在冲突' }, 400);
                const pwd = (data.password && data.password.trim().length >= 6) ? data.password.trim() : '123456';
                const days = parseInt(data.days || siteSettings.defaultDays, 10);
                const trafficGB = parseInt(data.trafficGB || siteSettings.defaultTrafficGB, 10);

                const newUser = {
                    uuid,
                    username,
                    passwordHash: crypto.createHash('sha256').update(pwd).digest('hex'),
                    trafficLimit: trafficGB * 1024 * 1024 * 1024,
                    trafficUsed: 0,
                    expireTime: Date.now() + days * 86400 * 1000,
                    enabled: true,
                    createdAt: new Date().toISOString()
                };
                users.set(uuid, newUser);
                saveUsers();
                console.log(`[Users] ➕ 管理员新增用户: ${username} (${uuid}) | 0ms即刻连接`);
                sendJson({ success: true, message: '用户添加成功，0毫秒即刻连通！', user: newUser });
            });
            return;
        }

        if (pathname === '/admin/api/user/update' && method === 'POST') {
            readBody(data => {
                const originalUuid = (data.originalUuid || '').trim();
                const user = users.get(originalUuid);
                if (!user) return sendJson({ error: '目标用户不存在' }, 404);

                let targetUuid = originalUuid;
                // 1. 修改 UUID
                if (data.newUuid && data.newUuid.trim() && data.newUuid.trim() !== originalUuid) {
                    const candidate = data.newUuid.trim();
                    if (candidate.length < 10) return sendJson({ error: 'UUID 长度过短' }, 400);
                    if (users.has(candidate)) return sendJson({ error: '新 UUID 已存在冲突' }, 400);
                    disconnectUser(originalUuid, '管理员更新了UUID');
                    users.delete(originalUuid);
                    user.uuid = candidate;
                    targetUuid = candidate;
                    users.set(targetUuid, user);
                }

                // 2. 修改用户名
                if (data.username && data.username.trim()) {
                    const newName = data.username.trim();
                    for (const [uid, u] of users.entries()) {
                        if (uid !== targetUuid && u.username === newName) {
                            return sendJson({ error: '该用户名已被占用' }, 400);
                        }
                    }
                    user.username = newName;
                }

                // 3. 修改密码
                if (data.newPassword && data.newPassword.trim()) {
                    if (data.newPassword.trim().length < 6) return sendJson({ error: '新密码至少6位' }, 400);
                    user.passwordHash = crypto.createHash('sha256').update(data.newPassword.trim()).digest('hex');
                    console.log(`[Users] 🔑 管理员已重设用户 ${user.username} 密码`);
                }

                // 4. 修改总配额流量 (GB)
                if (data.trafficLimitGB !== undefined) {
                    const gb = parseFloat(data.trafficLimitGB);
                    if (!isNaN(gb) && gb >= 0) {
                        user.trafficLimit = Math.round(gb * 1024 * 1024 * 1024);
                    }
                }

                // 5. 修改或清零已用流量
                if (data.resetTraffic) {
                    user.trafficUsed = 0;
                } else if (data.trafficUsedGB !== undefined && data.trafficUsedGB !== '') {
                    const usedGb = parseFloat(data.trafficUsedGB);
                    if (!isNaN(usedGb) && usedGb >= 0) {
                        user.trafficUsed = Math.round(usedGb * 1024 * 1024 * 1024);
                    }
                }

                // 6. 修改到期时间 (日期 YYYY-MM-DD)
                if (data.expireDate && data.expireDate.trim()) {
                    const d = new Date(data.expireDate.trim() + 'T23:59:59');
                    if (!isNaN(d.getTime())) {
                        user.expireTime = d.getTime();
                    }
                }

                // 7. 账号状态 (enabled)
                if (data.enabled !== undefined) {
                    const nextEnabled = Boolean(data.enabled);
                    if (user.enabled && !nextEnabled) {
                        disconnectUser(targetUuid, '管理端编辑为封禁');
                    }
                    user.enabled = nextEnabled;
                }

                saveUsers();
                console.log(`[Users] ✏️ 用户信息已成功更新: ${user.username} (${targetUuid})`);
                sendJson({ success: true, message: '用户信息已成功保存！', user });
            });
            return;
        }

        if (pathname === '/admin/api/user/toggle-ban' && method === 'POST') {
            readBody(data => {
                const uuid = data.uuid;
                const user = users.get(uuid);
                if (!user) return sendJson({ error: '用户不存在' }, 404);
                user.enabled = !user.enabled;
                saveUsers();

                let disconnectedCount = 0;
                if (!user.enabled) {
                    disconnectedCount = disconnectUser(uuid, '管理端封禁');
                }
                console.log(`[Users] 用户 ${user.username} 状态已变更为: ${user.enabled ? '正常' : '已封禁'} (掐断连接数: ${disconnectedCount})`);
                sendJson({ success: true, enabled: user.enabled, disconnectedCount });
            });
            return;
        }

        if (pathname === '/admin/api/user/delete' && method === 'POST') {
            readBody(data => {
                const uuid = data.uuid;
                if (!users.has(uuid)) return sendJson({ error: '用户不存在' }, 404);
                const count = disconnectUser(uuid, '管理端删除用户');
                users.delete(uuid);
                saveUsers();
                console.log(`[Users] ❌ 用户 ${uuid} 已彻底删除并掐断 ${count} 个活跃连接`);
                sendJson({ success: true, message: `已删除用户并立即切断 ${count} 个活跃连接` });
            });
            return;
        }

        if (pathname === '/admin/api/user/reset-traffic' && method === 'POST') {
            readBody(data => {
                const user = users.get(data.uuid);
                if (!user) return sendJson({ error: '用户不存在' }, 404);
                user.trafficUsed = 0;
                saveUsers();
                sendJson({ success: true, message: '流量已重置清零' });
            });
            return;
        }

        if (pathname === '/admin/api/user/renew' && method === 'POST') {
            readBody(data => {
                const user = users.get(data.uuid);
                if (!user) return sendJson({ error: '用户不存在' }, 404);
                const addDays = parseInt(data.days || 30, 10);
                const baseTime = user.expireTime > Date.now() ? user.expireTime : Date.now();
                user.expireTime = baseTime + addDays * 86400 * 1000;
                saveUsers();
                sendJson({ success: true, expireDateStr: new Date(user.expireTime).toLocaleDateString('zh-CN') });
            });
            return;
        }

        if (pathname === '/admin/api/user/edit-limit' && method === 'POST') {
            readBody(data => {
                const user = users.get(data.uuid);
                if (!user) return sendJson({ error: '用户不存在' }, 404);
                const gb = parseInt(data.trafficGB, 10);
                if (gb > 0) {
                    user.trafficLimit = gb * 1024 * 1024 * 1024;
                    saveUsers();
                    sendJson({ success: true, trafficLimitStr: formatBytes(user.trafficLimit) });
                } else {
                    sendJson({ error: '限额必须大于0' }, 400);
                }
            });
            return;
        }
    }

    // ──────────────── 4. 管理后台 HTML 渲染 (/admin) ────────────────
    if (pathname === '/admin') {
        const isAdmin = checkAdminAuth(req);
        if (!isAdmin) {
            return sendHtml(renderAdminLoginPage());
        }
        return sendHtml(renderAdminDashboardPage());
    }

    // ──────────────── 5. 首页 HTML 渲染 (微测网风格三网大屏) ────────────────
    const cookies = parseCookies(req);
    let currentUser = null;
    if (cookies.user_token && userSessions.has(cookies.user_token)) {
        currentUser = users.get(userSessions.get(cookies.user_token));
    }
    return sendHtml(renderHomepage(currentUser));
});

// ==========================================
// 11. WebSocket Upgrade 监听处理
// ==========================================
server.on('upgrade', (req, socket, head) => {
    const secKey = req.headers['sec-websocket-key'];
    if (!secKey) {
        socket.destroy();
        return;
    }
    const hash = crypto.createHash('sha1').update(secKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const respHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${hash}`,
        ''
    ].join('\r\n');

    socket.write(respHeaders + '\r\n');
    handleVlessWebSocket(socket, head);
});

// ==========================================
// 12. 前端视图模版渲染 (微测网风格 + Element UI)
// ==========================================
function renderHomepage(currentUser) {
    const cf = siteSettings.cfNodes;
    const subUrl = currentUser ? `/sub?token=${currentUser.uuid}` : '';
    const trafficPercent = currentUser ? Math.min(100, Math.round((currentUser.trafficUsed / currentUser.trafficLimit) * 100)) : 0;
    const daysLeft = currentUser ? Math.max(0, Math.ceil((currentUser.expireTime - Date.now()) / (86400 * 1000))) : 0;
    const isArgoActive = !!siteSettings.argoDomain;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>微测网 · 三网 CDN 动态优选极速枢纽</title>
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --primary-light: #eff6ff;
            --success: #16a34a;
            --success-light: #f0fdf4;
            --warning: #d97706;
            --warning-light: #fffbeb;
            --danger: #dc2626;
            --danger-light: #fef2f2;
            --bg-page: #f8fafc;
            --bg-card: #ffffff;
            --border: #e2e8f0;
            --text-main: #0f172a;
            --text-sub: #475569;
            --text-muted: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: var(--bg-page);
            color: var(--text-main);
            line-height: 1.5;
            font-size: 13px;
            min-height: 100vh;
        }
        .container {
            max-width: 1180px;
            margin: 0 auto;
            padding: 24px 20px 40px;
        }
        /* 顶部导航 */
        header.top-nav {
            background: #ffffff;
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 12px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            box-shadow: 0 1px 3px 0 rgba(0,0,0,0.03);
            flex-wrap: wrap;
            gap: 12px;
        }
        .nav-brand {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .brand-icon {
            width: 32px;
            height: 32px;
            background: var(--primary);
            color: #ffffff;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
        }
        .brand-text h1 {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-main);
            letter-spacing: -0.3px;
        }
        .brand-text p {
            font-size: 11px;
            color: var(--text-muted);
        }
        .nav-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 7px 16px;
            font-size: 13px;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
            border: 1px solid var(--border);
            background: #ffffff;
            color: var(--text-main);
            text-decoration: none;
            transition: all 0.15s ease-in-out;
            white-space: nowrap;
        }
        .btn:hover { background: #f8fafc; border-color: #cbd5e1; }
        .btn-primary { background: var(--primary); color: #ffffff; border-color: var(--primary); }
        .btn-primary:hover { background: var(--primary-hover); }
        .btn-success { background: var(--success); color: #ffffff; border-color: var(--success); }
        .btn-success:hover { background: #15803d; }
        .btn-sm { padding: 4px 10px; font-size: 12px; }

        /* 核心指标看板 */
        .kpi-row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .kpi-card {
            background: #ffffff;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 16px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 1px 2px 0 rgba(0,0,0,0.02);
        }
        .kpi-title {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-sub);
            margin-bottom: 4px;
        }
        .kpi-metric {
            font-size: 20px;
            font-weight: 700;
            color: var(--text-main);
            letter-spacing: -0.4px;
        }
        .kpi-hint {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 3px;
        }
        .kpi-icon-box {
            width: 44px;
            height: 44px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            flex-shrink: 0;
        }

        /* 用户控制台卡片 (登录后) */
        .user-console-card {
            background: #ffffff;
            border: 1px solid #bfdbfe;
            border-radius: 10px;
            padding: 22px 24px;
            margin-bottom: 24px;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.05);
        }
        .user-console-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            flex-wrap: wrap;
            gap: 10px;
            border-bottom: 1px solid #eff6ff;
            padding-bottom: 12px;
        }
        .user-welcome {
            font-size: 16px;
            font-weight: 700;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .user-expire-tag {
            font-size: 12px;
            font-weight: 600;
            color: var(--primary);
            background: #eff6ff;
            padding: 4px 12px;
            border-radius: 9999px;
            border: 1px solid #dbeafe;
        }
        .traffic-progress-bar {
            width: 100%;
            height: 8px;
            background: #f1f5f9;
            border-radius: 4px;
            overflow: hidden;
            margin: 8px 0 16px;
        }
        .traffic-progress-fill {
            height: 100%;
            background: var(--primary);
            border-radius: 4px;
            transition: width 0.3s;
        }
        .sub-input-row {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
            background: #f8fafc;
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 8px 12px;
        }
        .sub-url-field {
            flex: 1;
            min-width: 280px;
            border: none;
            outline: none;
            background: transparent;
            font-family: Consolas, monospace;
            font-size: 12px;
            color: var(--text-main);
        }

        /* 三网优选矩阵卡片 */
        .section-panel {
            background: #ffffff;
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 22px 24px;
            margin-bottom: 24px;
            box-shadow: 0 1px 3px 0 rgba(0,0,0,0.02);
        }
        .section-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 18px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 12px;
            flex-wrap: wrap;
            gap: 10px;
        }
        .section-title {
            font-size: 15px;
            font-weight: 700;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .section-subtitle {
            font-size: 12px;
            color: var(--text-sub);
            margin-top: 2px;
        }

        /* 运营商分栏表格 */
        .carrier-section-title {
            font-size: 13px;
            font-weight: 700;
            margin: 18px 0 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .table-wrap {
            overflow-x: auto;
            border: 1px solid var(--border);
            border-radius: 6px;
            margin-bottom: 16px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
            font-size: 12px;
        }
        th {
            background: #f8fafc;
            color: #475569;
            padding: 10px 14px;
            font-weight: 600;
            border-bottom: 1px solid var(--border);
        }
        td {
            padding: 10px 14px;
            border-bottom: 1px solid #f1f5f9;
            color: var(--text-main);
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: #f8fafc; }

        .badge-carrier {
            display: inline-flex;
            align-items: center;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
        }
        .badge-ct { background: #eff6ff; color: #2563eb; border: 1px solid #dbeafe; }
        .badge-cu { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
        .badge-cm { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
        .badge-any { background: #f8fafc; color: #475569; border: 1px solid #e2e8f0; }

        .rtt-pill {
            font-weight: 700;
            color: #16a34a;
            background: #f0fdf4;
            padding: 2px 6px;
            border-radius: 4px;
            display: inline-block;
        }

        /* 模态弹窗 */
        .modal-mask {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.45);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            backdrop-filter: blur(2px);
        }
        .modal-dialog {
            background: #ffffff;
            border-radius: 10px;
            width: 90%;
            max-width: 420px;
            padding: 24px 26px;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
            border: 1px solid var(--border);
        }
        .modal-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 18px;
            padding-bottom: 10px;
            border-bottom: 1px solid #f1f5f9;
        }
        .modal-top h3 { font-size: 15px; font-weight: 700; }
        .form-row { margin-bottom: 16px; }
        .form-row label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-sub);
            margin-bottom: 6px;
        }
        .form-row input {
            width: 100%;
            height: 38px;
            padding: 0 12px;
            font-size: 13px;
            border: 1px solid var(--border);
            border-radius: 6px;
            outline: none;
        }
        .form-row input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
        }
        footer.page-footer {
            text-align: center;
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 30px;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- 顶部导航 -->
        <header class="top-nav">
            <div class="nav-brand">
                <div class="brand-icon">⚡</div>
                <div class="brand-text">
                    <h1>微测网 · 三网 CDN 动态优选极速枢纽</h1>
                    <p>原生极简 Node.js 微核 · 0依赖 · 毫秒级三网调度</p>
                </div>
            </div>
            <div class="nav-right">
                ${currentUser ? `
                    <span style="font-size:13px; color:var(--text-sub);">👤 <strong>${currentUser.username}</strong></span>
                    <a href="/api/logout" class="btn btn-sm">退出登录</a>
                ` : `
                    <button class="btn btn-sm btn-primary" onclick="openModal('loginModal')">登录控制台</button>
                    ${siteSettings.allowRegister ? `<button class="btn btn-sm btn-success" onclick="openModal('regModal')">免费注册</button>` : ''}
                `}
                <a href="/admin" class="btn btn-sm" style="border-left:1px dashed var(--border); margin-left:4px;">🛠️ 管理后台</a>
            </div>
        </header>

        <!-- KPI 指标概览 -->
        <div class="kpi-row">
            <div class="kpi-card">
                <div>
                    <div class="kpi-title">核心协议服务</div>
                    <div class="kpi-metric" style="color:var(--success);">🟢 VLESS 在线</div>
                    <div class="kpi-hint">支持 0ms 零感知热切换</div>
                </div>
                <div class="kpi-icon-box" style="background:#f0fdf4; color:#16a34a;">🛡️</div>
            </div>
            <div class="kpi-card">
                <div>
                    <div class="kpi-title">直连端口与隧道</div>
                    <div class="kpi-metric" style="font-size:16px; font-family:Consolas, monospace;">${PORT} / ${isArgoActive ? '443直通' : '单端口'}</div>
                    <div class="kpi-hint">${isArgoActive ? 'Argo 穿透已绑定' : '翼龙原生端口直连'}</div>
                </div>
                <div class="kpi-icon-box" style="background:#eff6ff; color:#2563eb;">⚡</div>
            </div>
            <div class="kpi-card">
                <div>
                    <div class="kpi-title">三网优选动态池</div>
                    <div class="kpi-metric" style="font-size:15px; color:#d97706;">微测网清洗池</div>
                    <div class="kpi-hint">${siteSettings.wetestSyncTime}</div>
                </div>
                <div class="kpi-icon-box" style="background:#fffbeb; color:#d97706;">🌐</div>
            </div>
            <div class="kpi-card">
                <div>
                    <div class="kpi-title">常驻内存 RSS</div>
                    <div class="kpi-metric" style="color:#16a34a;">${formatBytes(process.memoryUsage().rss)}</div>
                    <div class="kpi-hint">规格 308MB (占用约 8%)</div>
                </div>
                <div class="kpi-icon-box" style="background:#f0fdf4; color:#16a34a;">🧠</div>
            </div>
        </div>

        <!-- 用户登录后控制台 -->
        ${currentUser ? `
        <div class="user-console-card">
            <div class="user-console-header">
                <div class="user-welcome">
                    <span>✨ 欢迎使用个人专属通道</span>
                    <span style="color:var(--primary); font-weight:700;">(${currentUser.username})</span>
                </div>
                <div class="user-expire-tag">
                    剩余有效期：<strong>${daysLeft}</strong> 天 (至 ${new Date(currentUser.expireTime).toLocaleDateString()})
                </div>
            </div>
            <div>
                <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-sub);">
                    <span>已消耗流量：<strong>${formatBytes(currentUser.trafficUsed)}</strong> / ${formatBytes(currentUser.trafficLimit)}</span>
                    <span style="font-weight:600; color:${trafficPercent > 90 ? '#dc2626' : (trafficPercent > 70 ? '#d97706' : '#2563eb')};">使用进度：${trafficPercent}%</span>
                </div>
                <div class="traffic-progress-bar">
                    <div class="traffic-progress-fill" style="width:${trafficPercent}%; background:${trafficPercent > 90 ? '#dc2626' : (trafficPercent > 70 ? '#d97706' : '#2563eb')};"></div>
                </div>
            </div>
            <div class="sub-input-row">
                <input type="text" id="subUrlInput" readonly value="${subUrl}" data-subpath="${subUrl}" onclick="this.select()" title="点击即可全选复制" class="sub-url-field" />
                <button class="btn btn-sm btn-primary" onclick="copySubUrlUniversal()">📋 一键复制订阅链接</button>
                <button class="btn btn-sm" onclick="showNodeModal()">👁️ 查看各节点明文直连</button>
            </div>
        </div>
        ` : ''}

        <!-- 三网 CDN 动态优选矩阵 -->
        <div class="section-panel">
            <div class="section-header">
                <div>
                    <div class="section-title">📊 微测网三网 CDN 优选延迟矩阵 (动态抓取)</div>
                    <div class="section-subtitle">每 30 分钟深度清洗剔除 AWS，保留全国电信、联通、移动极佳低延迟 IP。</div>
                </div>
            </div>

            <!-- 电信 -->
            <div class="carrier-section-title" style="color:#2563eb;">
                <span>🇨🇳 中国电信 (China Telecom) 专属优选</span>
                <span class="badge-carrier badge-ct">${cf.ct.length} 个活跃节点</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:180px;">优选节点 IPv4</th>
                            <th style="width:140px;">核心机房 (Colo)</th>
                            <th style="width:140px;">全国平均 Ping</th>
                            <th>运营商与调度策略</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderCarrierRows('中国电信 (CT)', 'badge-ct', cf.ct, siteSettings.optCTIp)}
                    </tbody>
                </table>
            </div>

            <!-- 联通 -->
            <div class="carrier-section-title" style="color:#d97706;">
                <span>🇨🇳 中国联通 (China Unicom) 专属优选</span>
                <span class="badge-carrier badge-cu">${cf.cu.length} 个活跃节点</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:180px;">优选节点 IPv4</th>
                            <th style="width:140px;">核心机房 (Colo)</th>
                            <th style="width:140px;">全国平均 Ping</th>
                            <th>运营商与调度策略</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderCarrierRows('中国联通 (CU)', 'badge-cu', cf.cu, siteSettings.optCUIp)}
                    </tbody>
                </table>
            </div>

            <!-- 移动 -->
            <div class="carrier-section-title" style="color:#16a34a;">
                <span>🇨🇳 中国移动 (China Mobile) 专属优选</span>
                <span class="badge-carrier badge-cm">${cf.cm.length} 个活跃节点</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:180px;">优选节点 IPv4</th>
                            <th style="width:140px;">核心机房 (Colo)</th>
                            <th style="width:140px;">全国平均 Ping</th>
                            <th>运营商与调度策略</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderCarrierRows('中国移动 (CM)', 'badge-cm', cf.cm, siteSettings.optCMIp)}
                    </tbody>
                </table>
            </div>

            <!-- Anycast -->
            <div class="carrier-section-title" style="color:#475569;">
                <span>🌐 Cloudflare 官方 Anycast 调度节点</span>
                <span class="badge-carrier badge-any">${cf.official.length} 个节点</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th style="width:180px;">调度节点 IPv4</th>
                            <th style="width:140px;">核心机房 (Colo)</th>
                            <th style="width:140px;">全国平均 Ping</th>
                            <th>运营商与调度策略</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${renderCarrierRows('CF Anycast', 'badge-any', cf.official, siteSettings.optOfficialIp)}
                    </tbody>
                </table>
            </div>
        </div>

        <footer class="page-footer">
            <p>Kata-Tunnel 纯原生 Node.js VLESS 极速中枢 · 308MB RAM 轻量规格专享</p>
        </footer>
    </div>

    <!-- 弹窗 1: 用户登录 (支持按回车直接登录) -->
    <div class="modal-mask" id="loginModal">
        <div class="modal-dialog">
            <div class="modal-top">
                <h3>👤 登录个人控制台</h3>
                <span style="font-size:14px; cursor:pointer; color:#94a3b8;" onclick="closeModal('loginModal')">✕</span>
            </div>
            <form id="userLoginForm" onsubmit="event.preventDefault(); doLogin();">
                <div class="form-row">
                    <label>登录用户名</label>
                    <input type="text" id="loginUser" placeholder="请输入用户名" autofocus />
                </div>
                <div class="form-row">
                    <label>登录密码</label>
                    <input type="password" id="loginPwd" placeholder="请输入密码并敲击回车" onkeydown="if(event.key==='Enter'||event.keyCode===13){event.preventDefault();doLogin();}" />
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                    <button type="button" class="btn" onclick="closeModal('loginModal')">取消</button>
                    <button type="submit" id="btnLoginSubmit" class="btn btn-primary">登 录</button>
                </div>
            </form>
        </div>
    </div>

    <!-- 弹窗 2: 用户注册 (支持回车注册) -->
    <div class="modal-mask" id="regModal">
        <div class="modal-dialog">
            <div class="modal-top">
                <h3>✨ 注册新专属账号</h3>
                <span style="font-size:14px; cursor:pointer; color:#94a3b8;" onclick="closeModal('regModal')">✕</span>
            </div>
            <form id="userRegForm" onsubmit="event.preventDefault(); doRegister();">
                <div class="form-row">
                    <label>用户名 (至少 3 位)</label>
                    <input type="text" id="regUser" placeholder="输入您的用户名" />
                </div>
                <div class="form-row">
                    <label>设置密码 (至少 6 位)</label>
                    <input type="password" id="regPwd" placeholder="输入登录密码并敲击回车" onkeydown="if(event.key==='Enter'||event.keyCode===13){event.preventDefault();doRegister();}" />
                </div>
                <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                    <button type="button" class="btn" onclick="closeModal('regModal')">取消</button>
                    <button type="submit" id="btnRegSubmit" class="btn btn-success">立即注册</button>
                </div>
            </form>
        </div>
    </div>

    <!-- 弹窗 3: 节点明文直连复制弹窗 -->
    <div class="modal-mask" id="nodeModal">
        <div class="modal-dialog" style="max-width:560px;">
            <div class="modal-top">
                <h3>📋 专属单节点配置直连列表</h3>
                <span style="font-size:14px; cursor:pointer; color:#94a3b8;" onclick="closeModal('nodeModal')">✕</span>
            </div>
            <div style="font-size:12px; color:var(--text-sub); margin-bottom:12px;">点击对应按钮直接一键复制单节点 VLESS 链接，或直接复制文本导入客户端：</div>
            <div id="nodeListContainer" style="max-height:360px; overflow-y:auto; display:flex; flex-direction:column; gap:10px;">
                <div style="text-align:center; padding:20px; color:#94a3b8;">正在生成节点列表...</div>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:16px;">
                <button type="button" class="btn" onclick="closeModal('nodeModal')">关 闭</button>
            </div>
        </div>
    </div>

    <script>
        function openModal(id) {
            document.getElementById(id).style.display = 'flex';
            if (id === 'loginModal') document.getElementById('loginUser').focus();
            if (id === 'regModal') document.getElementById('regUser').focus();
        }
        function closeModal(id) { document.getElementById(id).style.display = 'none'; }

        async function doLogin() {
            const u = document.getElementById('loginUser').value.trim();
            const p = document.getElementById('loginPwd').value.trim();
            const btn = document.getElementById('btnLoginSubmit');
            if (!u || !p) return alert('请输入用户名和密码');
            btn.disabled = true;
            btn.innerText = '登录中...';
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const d = await res.json();
                if (res.ok) {
                    location.reload();
                } else {
                    alert('登录失败: ' + (d.error || '账号或密码不正确'));
                }
            } catch(e) {
                alert('网络连接错误，请重试');
            } finally {
                btn.disabled = false;
                btn.innerText = '登 录';
            }
        }

        async function doRegister() {
            const u = document.getElementById('regUser').value.trim();
            const p = document.getElementById('regPwd').value.trim();
            const btn = document.getElementById('btnRegSubmit');
            if (!u || !p) return alert('请完整填写用户名与密码');
            btn.disabled = true;
            btn.innerText = '注册中...';
            try {
                const res = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const d = await res.json();
                if (res.ok) {
                    alert('🎉 注册成功！已为您自动登录专属通道。');
                    location.reload();
                } else {
                    alert('注册失败: ' + (d.error || '未知错误'));
                }
            } catch(e) {
                alert('网络错误，请重试');
            } finally {
                btn.disabled = false;
                btn.innerText = '立即注册';
            }
        }

        function copyTextUniversal(text, successMsg = '✅ 复制成功！') {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => {
                    alert(successMsg);
                }).catch(() => {
                    prompt('请按 Ctrl+C 复制以下文本:', text);
                });
            } else {
                prompt('请按 Ctrl+C 复制以下文本:', text);
            }
        }

        function copySubUrlUniversal() {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) {
                fullUrl = window.location.origin + fullUrl;
            }
            copyTextUniversal(fullUrl, '✅ 完整订阅链接已复制到剪贴板！');
        }

        async function showNodeModal() {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) {
                fullUrl = window.location.origin + fullUrl;
            }
            openModal('nodeModal');
            const cont = document.getElementById('nodeListContainer');
            cont.innerHTML = '<div style="text-align:center; padding:16px;">正在拉取明文节点...</div>';
            try {
                const res = await fetch(fullUrl);
                const txt = await res.text();
                const lines = txt.split(/\\r?\\n/).filter(l => l.trim().startsWith('vless://'));
                if (lines.length === 0) {
                    cont.innerHTML = '<div style="text-align:center; padding:16px;">未解析到节点配置</div>';
                    return;
                }
                cont.innerHTML = lines.map((link, idx) => {
                    let label = '节点 #' + (idx + 1);
                    const hashIdx = link.indexOf('#');
                    if (hashIdx !== -1) {
                        try { label = decodeURIComponent(link.substring(hashIdx + 1)); } catch(e){}
                    }
                    return \`<div style="background:#f8fafc; border:1px solid var(--border); border-radius:6px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <div style="flex:1; min-width:0;">
                            <div style="font-weight:700; color:var(--text-main); font-size:12px; margin-bottom:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${label}</div>
                            <div style="font-family:Consolas, monospace; font-size:11px; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">\${link}</div>
                        </div>
                        <button class="btn btn-sm btn-primary" onclick="copyTextUniversal('\${link}', '✅ 节点链接已复制！')">复制</button>
                    </div>\`;
                }).join('');
            } catch(e) {
                cont.innerHTML = '<div style="color:#dc2626; padding:16px;">获取节点失败，请直接复制订阅链接导入</div>';
            }
        }

        window.addEventListener('load', () => {
            const subInput = document.getElementById('subUrlInput');
            if (subInput && subInput.dataset.subpath) {
                subInput.value = window.location.origin + subInput.dataset.subpath;
            }
        });
    </script>
</body>
</html>`;
}

function renderCarrierRows(carrierName, badgeClass, list, overrideIp) {
    if (!list || list.length === 0) {
        return `<tr><td><span class="badge ${badgeClass}">${carrierName}</span></td><td colspan="5" style="color:var(--el-text-light);">动态抓取中...</td></tr>`;
    }
    return list.map((item, idx) => {
        const isOverride = idx === 0 && overrideIp && overrideIp !== item.ip;
        const displayIp = isOverride ? overrideIp : item.ip;
        return `<tr>
            <td><span class="badge ${badgeClass}">${carrierName}</span></td>
            <td><strong style="font-family:Consolas, monospace;">${displayIp}</strong> ${isOverride ? '<span style="font-size:10px; color:#e6a23c;">(覆盖)</span>' : ''}</td>
            <td><span style="font-weight:600; color:#409eff;">${item.colo || 'HKG'}</span></td>
            <td><span style="color:#67c23a; font-weight:700;">${item.rtt ? item.rtt + ' ms' : '--'}</span></td>
            <td><span style="color:var(--el-success); font-size:12px;">🟢 畅通优选</span></td>
            <td style="font-size:12px; color:var(--el-text-sub);">针对骨干网定向加速直连 (第 ${idx + 1} 优选)</td>
        </tr>`;
    }).join('');
}

// ──────────────── 管理后台页面渲染 ────────────────
// ──────────────── 管理后台页面渲染 ────────────────
function renderAdminLoginPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kata-Tunnel 管理中枢登录</title>
    <style>
        :root {
            --el-primary: #2563eb;
            --el-primary-hover: #1d4ed8;
            --el-bg: #f1f5f9;
            --el-text-main: #0f172a;
            --el-text-sub: #475569;
            --el-border: #cbd5e1;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: #f1f5f9;
            color: var(--el-text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .login-box {
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            width: 100%;
            max-width: 400px;
            padding: 36px 32px;
            box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.08), 0 8px 10px -6px rgba(15, 23, 42, 0.04);
        }
        .brand-header {
            text-align: center;
            margin-bottom: 28px;
        }
        .brand-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 48px;
            height: 48px;
            border-radius: 10px;
            background: #eff6ff;
            color: #2563eb;
            font-size: 26px;
            margin-bottom: 12px;
            border: 1px solid #dbeafe;
        }
        .brand-title {
            font-size: 20px;
            font-weight: 700;
            color: #0f172a;
            letter-spacing: -0.3px;
        }
        .brand-desc {
            font-size: 13px;
            color: #64748b;
            margin-top: 5px;
        }
        .form-group {
            margin-bottom: 20px;
            text-align: left;
        }
        .form-label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: #334155;
            margin-bottom: 8px;
        }
        .input-control {
            width: 100%;
            height: 42px;
            padding: 0 14px;
            font-size: 14px;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            outline: none;
            background: #ffffff;
            color: #0f172a;
            transition: all 0.15s ease-in-out;
        }
        .input-control:focus {
            border-color: #2563eb;
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
        }
        .submit-btn {
            width: 100%;
            height: 42px;
            background: #2563eb;
            color: #ffffff;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.15s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .submit-btn:hover {
            background: #1d4ed8;
        }
        .submit-btn:disabled {
            opacity: 0.7;
            cursor: not-allowed;
        }
        .error-alert {
            display: none;
            background: #fef2f2;
            border: 1px solid #fee2e2;
            color: #dc2626;
            font-size: 13px;
            padding: 10px 12px;
            border-radius: 6px;
            margin-bottom: 18px;
            align-items: center;
            gap: 8px;
        }
        .card-footer {
            margin-top: 24px;
            text-align: center;
            font-size: 12px;
            color: #94a3b8;
            border-top: 1px solid #f1f5f9;
            padding-top: 16px;
        }
    </style>
</head>
<body>
    <div class="login-box">
        <div class="brand-header">
            <div class="brand-badge">🛡️</div>
            <div class="brand-title">Kata-Tunnel 运维控制台</div>
            <div class="brand-desc">308MB 原生轻核 · 0依赖高性能隧道</div>
        </div>

        <div id="errMsg" class="error-alert"></div>

        <form id="adminLoginForm" onsubmit="event.preventDefault(); doAdminLogin();">
            <div class="form-group">
                <label class="form-label" for="pwd">管理员认证密钥 (ADMIN_PASSWORD)</label>
                <input type="password" id="pwd" class="input-control" placeholder="请输入管理员登录密码并回车" autofocus autocomplete="current-password" onkeydown="if(event.key==='Enter'||event.keyCode===13){event.preventDefault();doAdminLogin();}" />
            </div>
            <button type="submit" id="btnSubmit" class="submit-btn">登 录 控 制 台</button>
        </form>

        <div class="card-footer">
            <span>翼龙面板单端口专享 · 敲击回车直接登录</span>
        </div>
    </div>

    <script>
        async function doAdminLogin() {
            const pwdInput = document.getElementById('pwd');
            const p = pwdInput.value.trim();
            const errDiv = document.getElementById('errMsg');
            const btn = document.getElementById('btnSubmit');

            if (!p) {
                errDiv.style.display = 'flex';
                errDiv.innerText = '⚠️ 请输入管理员登录密码';
                pwdInput.focus();
                return;
            }

            errDiv.style.display = 'none';
            btn.disabled = true;
            btn.innerText = '正在验证密钥...';

            try {
                const res = await fetch('/admin/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: p })
                });
                const data = await res.json();
                if (res.ok) {
                    location.href = '/admin';
                } else {
                    errDiv.style.display = 'flex';
                    errDiv.innerText = '❌ 认证失败: ' + (data.error || '密码错误，请核对 .env');
                    pwdInput.select();
                }
            } catch (e) {
                errDiv.style.display = 'flex';
                errDiv.innerText = '❌ 网络请求异常，请检查服务器连接';
            } finally {
                btn.disabled = false;
                btn.innerText = '登 录 控 制 台';
            }
        }

        window.addEventListener('load', () => {
            const pwdInput = document.getElementById('pwd');
            if (pwdInput) {
                pwdInput.focus();
                pwdInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.keyCode === 13) {
                        e.preventDefault();
                        doAdminLogin();
                    }
                });
            }
        });
    </script>
</body>
</html>`;
}

function renderAdminDashboardPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kata-Tunnel 运维管理中枢 (Pro Admin)</title>
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --primary-light: #eff6ff;
            --success: #16a34a;
            --success-light: #f0fdf4;
            --warning: #d97706;
            --warning-light: #fffbeb;
            --danger: #dc2626;
            --danger-light: #fef2f2;
            --bg-page: #f8fafc;
            --bg-card: #ffffff;
            --border-color: #e2e8f0;
            --text-main: #0f172a;
            --text-sub: #475569;
            --text-muted: #94a3b8;
            --sidebar-bg: #0f172a;
            --sidebar-hover: #1e293b;
            --sidebar-active: #2563eb;
            --sidebar-text: #94a3b8;
            --sidebar-text-active: #ffffff;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: var(--bg-page);
            color: var(--text-main);
            font-size: 13px;
            min-height: 100vh;
            display: flex;
        }
        /* 左侧固定侧边栏 */
        aside.sidebar {
            width: 220px;
            background: var(--sidebar-bg);
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            border-right: 1px solid #1e293b;
            min-height: 100vh;
        }
        .sidebar-brand {
            height: 56px;
            padding: 0 18px;
            display: flex;
            align-items: center;
            gap: 10px;
            border-bottom: 1px solid #1e293b;
        }
        .brand-logo {
            width: 30px;
            height: 30px;
            background: #2563eb;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
            color: #fff;
        }
        .brand-name {
            font-size: 14px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -0.2px;
        }
        .brand-tag {
            font-size: 10px;
            padding: 1px 5px;
            background: rgba(37, 99, 235, 0.2);
            color: #60a5fa;
            border-radius: 4px;
            border: 1px solid rgba(96, 165, 250, 0.3);
            margin-left: auto;
        }
        .sidebar-menu {
            flex: 1;
            padding: 14px 10px;
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .menu-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            border-radius: 6px;
            color: var(--sidebar-text);
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s ease-in-out;
            user-select: none;
        }
        .menu-item:hover {
            background: var(--sidebar-hover);
            color: #f1f5f9;
        }
        .menu-item.active {
            background: var(--sidebar-active);
            color: var(--sidebar-text-active);
            font-weight: 600;
        }
        .sidebar-footer {
            padding: 14px 16px;
            border-top: 1px solid #1e293b;
            font-size: 11px;
            color: #64748b;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        /* 右侧主体布局 */
        .main-wrapper {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-width: 0;
            overflow-y: auto;
        }
        /* 顶部导航条 */
        header.top-header {
            height: 56px;
            background: #ffffff;
            border-bottom: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .header-title-box {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-breadcrumb {
            font-size: 13px;
            color: var(--text-sub);
        }
        .header-breadcrumb strong {
            color: var(--text-main);
            font-weight: 600;
        }
        .header-actions {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            background: #f0fdf4;
            color: #16a34a;
            border: 1px solid #bbf7d0;
            border-radius: 9999px;
            font-size: 12px;
            font-weight: 500;
        }
        .pulse-dot {
            width: 7px;
            height: 7px;
            background: #16a34a;
            border-radius: 50%;
            box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.2);
        }
        /* 内容区域 */
        .content-container {
            padding: 24px;
            max-width: 1280px;
            width: 100%;
            margin: 0 auto;
        }
        /* KPI 卡片组 */
        .kpi-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
            margin-bottom: 20px;
        }
        .kpi-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.03);
        }
        .kpi-label {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-sub);
            margin-bottom: 4px;
        }
        .kpi-val {
            font-size: 22px;
            font-weight: 700;
            color: var(--text-main);
            letter-spacing: -0.5px;
        }
        .kpi-sub {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 3px;
        }
        .kpi-icon-wrap {
            width: 44px;
            height: 44px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            flex-shrink: 0;
        }
        /* 面板卡片主体 */
        .card-panel {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px 22px;
            margin-bottom: 20px;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.03);
        }
        .panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 18px;
            flex-wrap: wrap;
            gap: 12px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 14px;
        }
        .panel-title {
            font-size: 15px;
            font-weight: 700;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .panel-subtitle {
            font-size: 12px;
            color: var(--text-sub);
            margin-top: 3px;
        }
        /* 按钮与控件 */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 7px 14px;
            font-size: 12px;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
            border: 1px solid var(--border-color);
            background: #ffffff;
            color: var(--text-main);
            transition: all 0.15s ease-in-out;
            text-decoration: none;
            white-space: nowrap;
        }
        .btn:hover { background: #f8fafc; border-color: #cbd5e1; }
        .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
        .btn-primary:hover { background: var(--primary-hover); }
        .btn-success { background: var(--success); color: #fff; border-color: var(--success); }
        .btn-success:hover { background: #15803d; }
        .btn-danger { background: var(--danger); color: #fff; border-color: var(--danger); }
        .btn-danger:hover { background: #b91c1c; }
        .btn-sm { padding: 4px 8px; font-size: 11px; }

        /* 表格样式 */
        .table-wrap {
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-radius: 6px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }
        th {
            background: #f8fafc;
            color: #475569;
            padding: 11px 14px;
            font-weight: 600;
            font-size: 12px;
            border-bottom: 1px solid var(--border-color);
            white-space: nowrap;
        }
        td {
            padding: 12px 14px;
            border-bottom: 1px solid #f1f5f9;
            color: var(--text-main);
            vertical-align: middle;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background: #f8fafc; }

        .tag {
            display: inline-flex;
            align-items: center;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            white-space: nowrap;
        }
        .tag-ok { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
        .tag-ban { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .tag-warn { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }

        .uuid-badge {
            font-family: Consolas, monospace;
            cursor: pointer;
            color: #2563eb;
            background: #eff6ff;
            padding: 3px 7px;
            border-radius: 4px;
            font-size: 12px;
            border: 1px solid #dbeafe;
            display: inline-block;
            transition: all 0.15s;
        }
        .uuid-badge:hover { background: #dbeafe; }

        /* 进度条 */
        .progress-bar-wrap {
            width: 110px;
            height: 6px;
            background: #e2e8f0;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 4px;
        }
        .progress-bar-inner {
            height: 100%;
            background: #2563eb;
            border-radius: 3px;
        }

        /* 运营商配置卡片 */
        .carrier-card {
            background: #ffffff;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 14px;
        }
        .carrier-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
        }

        /* 表单样式 */
        .form-row { margin-bottom: 16px; }
        .form-row label {
            display: block;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-sub);
            margin-bottom: 6px;
        }
        .form-row input, .form-row select, .form-row textarea {
            width: 100%;
            padding: 8px 12px;
            font-size: 13px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            outline: none;
            background: #ffffff;
            color: var(--text-main);
            transition: border-color 0.15s;
        }
        .form-row input:focus, .form-row select:focus, .form-row textarea:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
        }

        /* 终端输出视窗 (符合宪法黑底绿字) */
        .terminal-box {
            background: #0f172a;
            border: 1px solid #1e293b;
            border-radius: 6px;
            padding: 14px 16px;
            font-family: Consolas, "Courier New", monospace;
            font-size: 12px;
            color: #22c55e;
            line-height: 1.6;
            min-height: 160px;
            max-height: 300px;
            overflow-y: auto;
            white-space: pre-wrap;
        }

        /* 弹窗遮罩 */
        .modal-mask {
            position: fixed;
            inset: 0;
            background: rgba(15, 23, 42, 0.5);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            backdrop-filter: blur(2px);
        }
        .modal-card {
            background: #ffffff;
            border-radius: 10px;
            width: 90%;
            max-width: 480px;
            padding: 24px 26px;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
            border: 1px solid var(--border-color);
        }
        .modal-title-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 18px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 10px;
        }
        .modal-title-bar h3 {
            font-size: 15px;
            font-weight: 700;
            color: var(--text-main);
        }

        /* 搜索框 */
        .search-box {
            display: flex;
            align-items: center;
            gap: 6px;
            background: #ffffff;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 0 10px;
            height: 32px;
        }
        .search-box input {
            border: none;
            outline: none;
            font-size: 12px;
            width: 160px;
        }
    </style>
</head>
<body>
    <!-- 左侧侧边栏导航 -->
    <aside class="sidebar">
        <div class="sidebar-brand">
            <div class="brand-logo">🛡️</div>
            <div class="brand-name">Kata-Tunnel</div>
            <span class="brand-tag">v2.5 Pro</span>
        </div>
        <ul class="sidebar-menu">
            <li class="menu-item active" id="menu_users" onclick="switchNav('users')">
                <span>👥</span> <span>用户风控中心</span>
            </li>
            <li class="menu-item" id="menu_cdn" onclick="switchNav('cdn')">
                <span>🚀</span> <span>三网优选调度</span>
            </li>
            <li class="menu-item" id="menu_sys" onclick="switchNav('sys')">
                <span>⚡</span> <span>隧道与系统变量</span>
            </li>
            <li class="menu-item" id="menu_status" onclick="switchNav('status')">
                <span>📊</span> <span>容器探针监控</span>
            </li>
        </ul>
        <div class="sidebar-footer">
            <div style="color:#e2e8f0; font-weight:600;">Kata 308MB 轻量中枢</div>
            <div>0依赖 · 单端口 · 0ms即刻生效</div>
        </div>
    </aside>

    <!-- 右侧主体内容 -->
    <div class="main-wrapper">
        <header class="top-header">
            <div class="header-title-box">
                <span style="font-size:16px;">📂</span>
                <span class="header-breadcrumb">控制台 / <strong id="curNavTitle">用户风控中心</strong></span>
            </div>
            <div class="header-actions">
                <div class="status-badge">
                    <span class="pulse-dot"></span>
                    <span>核心引擎运行中</span>
                </div>
                <a href="/" target="_blank" class="btn btn-sm">🌐 前台微测网 ↗</a>
                <a href="/admin/logout" class="btn btn-sm btn-danger">退出登录</a>
            </div>
        </header>

        <div class="content-container">
            <!-- 核心 KPI 动态指标栏 -->
            <div class="kpi-grid">
                <div class="kpi-card">
                    <div>
                        <div class="kpi-label">注册用户总数</div>
                        <div class="kpi-val" id="kpi_user_count">--</div>
                        <div class="kpi-sub">风控池持久化落盘</div>
                    </div>
                    <div class="kpi-icon-wrap" style="background:#eff6ff; color:#2563eb;">👥</div>
                </div>
                <div class="kpi-card">
                    <div>
                        <div class="kpi-label">活跃并发长连接</div>
                        <div class="kpi-val" id="kpi_conns" style="color:#16a34a;">0</div>
                        <div class="kpi-sub">0ms 立即定向掐断支持</div>
                    </div>
                    <div class="kpi-icon-wrap" style="background:#f0fdf4; color:#16a34a;">⚡</div>
                </div>
                <div class="kpi-card">
                    <div>
                        <div class="kpi-label">Node.js RSS 内存</div>
                        <div class="kpi-val" id="kpi_rss" style="color:#2563eb;">--</div>
                        <div class="kpi-sub">占 308MB 限额约 8%~10%</div>
                    </div>
                    <div class="kpi-icon-wrap" style="background:#eff6ff; color:#2563eb;">🧠</div>
                </div>
                <div class="kpi-card">
                    <div>
                        <div class="kpi-label">微测网动态同步</div>
                        <div class="kpi-val" id="kpi_wetest_status" style="font-size:16px; color:#d97706;">自动就绪</div>
                        <div class="kpi-sub" id="kpi_wetest_time">最近同步: --</div>
                    </div>
                    <div class="kpi-icon-wrap" style="background:#fffbeb; color:#d97706;">🌐</div>
                </div>
            </div>

            <!-- PANEL 1: 用户管理与风控 -->
            <div class="card-panel" id="panel_users">
                <div class="panel-header">
                    <div>
                        <div class="panel-title">👥 用户账号与定向风控控制台</div>
                        <div class="panel-subtitle">⚡ 账号即改即效：删除/封禁立即定向切断连接，新增/解封立即可用，对其他在线用户绝对 0 影响。</div>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <div class="search-box">
                            <span>🔍</span>
                            <input type="text" id="userSearchInput" placeholder="搜索用户名或UUID..." oninput="filterUsers()" />
                        </div>
                        <button class="btn btn-primary" onclick="openAddUserModal()">➕ 添加新用户</button>
                        <button class="btn" onclick="fetchUsers()">🔄 刷新</button>
                    </div>
                </div>

                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th style="width:120px;">账号名称</th>
                                <th style="width:280px;">专属连接 UUID (点击复制)</th>
                                <th style="width:160px;">流量消耗进度</th>
                                <th style="width:110px;">到期时间</th>
                                <th style="width:90px;">状态</th>
                                <th style="width:80px;">活跃连线</th>
                                <th style="min-width:240px;">运维与设置</th>
                            </tr>
                        </thead>
                        <tbody id="usersTbody">
                            <tr><td colspan="7" style="text-align:center; padding:24px; color:var(--text-muted);">正在载入用户数据...</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- PANEL 2: 三网优选调度 -->
            <div class="card-panel" id="panel_cdn" style="display:none;">
                <div class="panel-header">
                    <div>
                        <div class="panel-title">🚀 微测网三网动态优选分发中心</div>
                        <div class="panel-subtitle">自动清洗剔除 AWS，精准将真实电信、联通、移动优选节点分发给订阅客户端。</div>
                    </div>
                    <button class="btn btn-primary" id="btnSyncWetest" onclick="manualSyncWetest()">🔄 立即全量拉取微测网</button>
                </div>

                <div style="background:#f8fafc; border:1px solid var(--border-color); border-radius:6px; padding:12px 16px; margin-bottom:16px;">
                    <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer;">
                        <input type="checkbox" id="cfg_autoSyncWetest" />
                        <span>启用后台自动拉取：每隔 30 分钟静默自愈同步微测网最优三网 IP 列表</span>
                    </label>
                </div>

                <!-- 电信 -->
                <div class="carrier-card" style="border-left:4px solid #2563eb;">
                    <div class="carrier-card-header">
                        <span style="font-weight:700; color:#2563eb; font-size:14px;">🇨🇳 中国电信 (CT) 专属优选</span>
                        <label style="display:flex; align-items:center; gap:6px; font-weight:600; color:#2563eb; cursor:pointer;">
                            <input type="checkbox" id="cfg_enableOptCT" /> <span>启用下发</span>
                        </label>
                    </div>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>首选固定 IPv4 (留空则全自动采用微测网电信第一名)</label>
                        <input type="text" id="cfg_optCTIp" placeholder="例如: 104.25.18.145" />
                    </div>
                </div>

                <!-- 联通 -->
                <div class="carrier-card" style="border-left:4px solid #d97706;">
                    <div class="carrier-card-header">
                        <span style="font-weight:700; color:#d97706; font-size:14px;">🇨🇳 中国联通 (CU) 专属优选</span>
                        <label style="display:flex; align-items:center; gap:6px; font-weight:600; color:#d97706; cursor:pointer;">
                            <input type="checkbox" id="cfg_enableOptCU" /> <span>启用下发</span>
                        </label>
                    </div>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>首选固定 IPv4 (留空则全自动采用微测网联通第一名)</label>
                        <input type="text" id="cfg_optCUIp" placeholder="例如: 104.19.152.130" />
                    </div>
                </div>

                <!-- 移动 -->
                <div class="carrier-card" style="border-left:4px solid #16a34a;">
                    <div class="carrier-card-header">
                        <span style="font-weight:700; color:#16a34a; font-size:14px;">🇨🇳 中国移动 (CM) 专属优选</span>
                        <label style="display:flex; align-items:center; gap:6px; font-weight:600; color:#16a34a; cursor:pointer;">
                            <input type="checkbox" id="cfg_enableOptCM" /> <span>启用下发</span>
                        </label>
                    </div>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>首选固定 IPv4 (留空则全自动采用微测网移动第一名)</label>
                        <input type="text" id="cfg_optCMIp" placeholder="例如: 104.21.90.61" />
                    </div>
                </div>

                <!-- 官方 Anycast -->
                <div class="carrier-card" style="border-left:4px solid #64748b;">
                    <div class="carrier-card-header">
                        <span style="font-weight:700; color:#475569; font-size:14px;">🌐 Cloudflare 官方 Anycast 调度</span>
                        <label style="display:flex; align-items:center; gap:6px; font-weight:600; cursor:pointer;">
                            <input type="checkbox" id="cfg_enableOptOfficial" /> <span>启用下发</span>
                        </label>
                    </div>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>首选域名或 IP (留空则自动跟随节点主公网域名)</label>
                        <input type="text" id="cfg_optOfficialIp" placeholder="留空自动跟随主域名" />
                    </div>
                </div>

                <button class="btn btn-primary" style="padding:8px 20px;" onclick="saveCdnSettings()">💾 保存三网优选策略</button>
            </div>

            <!-- PANEL 3: 隧道穿透与系统变量 -->
            <div class="card-panel" id="panel_sys" style="display:none;">
                <div class="panel-header">
                    <div>
                        <div class="panel-title">⚡ Cloudflare Argo 穿透与系统全局参数</div>
                        <div class="panel-subtitle">配置 443 端口直连与用户自注册权限，修改结果实时回写持久化。</div>
                    </div>
                </div>

                <!-- Argo 隧道配置 -->
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; margin-bottom:20px;">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
                        <span style="font-weight:700; color:#16a34a; font-size:14px;">⚡ Cloudflare Argo 隧道 443 直通配置</span>
                        <span style="font-size:12px; color:#15803d;">免公网 IPv4 · 突破面板限制</span>
                    </div>
                    <div class="form-row">
                        <label>Cloudflare Argo 隧道 Token (ARGO_TOKEN)</label>
                        <textarea id="cfg_argoToken" rows="3" placeholder="在此粘贴 Cloudflare 零信任面板 (Zero Trust) 生成的 Tunnel Token (以 eyJh 开头)" style="font-family:Consolas, monospace; font-size:12px;"></textarea>
                        <span style="font-size:11px; color:#64748b; margin-top:4px; display:block;">保存后自动落盘到 settings.json 与 .env 文件。</span>
                    </div>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>Argo 隧道穿透主域名 (ARGO_DOMAIN)</label>
                        <input type="text" id="cfg_argoDomain" placeholder="例如: tunnel.yourdomain.com" />
                        <span style="font-size:11px; color:#64748b; margin-top:4px; display:block;">填入为此隧道映射的 Public Hostname，系统将自动生成 443 端口直连订阅！</span>
                    </div>
                </div>

                <!-- 注册与默认配额 -->
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px; margin-bottom:18px;">
                    <div class="form-row">
                        <label>前台用户自主注册总开关</label>
                        <select id="cfg_allowRegister">
                            <option value="true">🟢 开启前台注册 (允许新用户自建)</option>
                            <option value="false">🔴 关闭注册 (仅限后台已有老用户)</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label>新注册账号默认体验天数</label>
                        <input type="number" id="cfg_defaultDays" value="365" />
                    </div>
                    <div class="form-row">
                        <label>新注册账号默认配额流量 (GB)</label>
                        <input type="number" id="cfg_defaultTrafficGB" value="100" />
                    </div>
                    <div class="form-row">
                        <label>主公网域名或外网 IP (SUB_DOMAIN)</label>
                        <input type="text" id="cfg_subDomain" placeholder="如 51.75.118.151 或自定义域名" />
                    </div>
                </div>

                <!-- 管理员密码修改 -->
                <div style="border-top:1px dashed var(--border-color); padding-top:16px; margin-top:16px;">
                    <div style="font-weight:700; color:#dc2626; font-size:13px; margin-bottom:10px;">🔐 后台管理员密码热修改 (直接原子落盘 .env)</div>
                    <div class="form-row" style="max-width:400px;">
                        <label>新管理员密码 (留空则保持当前不变)</label>
                        <input type="password" id="cfg_newAdminPassword" placeholder="输入新密码 (至少5位)" />
                        <span style="font-size:11px; color:#64748b; margin-top:4px; display:block;">保存后立即更新内存并原子写入 .env，下次登录生效。</span>
                    </div>
                </div>

                <button class="btn btn-primary" style="padding:8px 20px;" onclick="saveSystemSettings()">💾 保存系统参数与新密码</button>
            </div>

            <!-- PANEL 4: 容器探针监控 -->
            <div class="card-panel" id="panel_status" style="display:none;">
                <div class="panel-header">
                    <div>
                        <div class="panel-title">📊 308MB 卡塔轻核容器深度探针</div>
                        <div class="panel-subtitle">实时掌控内存常驻指标与底层运行日志，杜绝 OOM 崩溃。</div>
                    </div>
                    <button class="btn" onclick="fetchStatus()">🔄 刷新探针数据</button>
                </div>

                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; margin-bottom:18px;">
                    <div style="background:#f8fafc; border:1px solid var(--border-color); border-radius:6px; padding:14px;">
                        <div style="font-size:11px; color:#64748b;">Node 真实物理常驻内存</div>
                        <div id="stat_memRss" style="font-size:20px; font-weight:700; color:#16a34a; margin-top:4px;">--</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">极低开销，完全规避 OOM</div>
                    </div>
                    <div style="background:#f8fafc; border:1px solid var(--border-color); border-radius:6px; padding:14px;">
                        <div style="font-size:11px; color:#64748b;">当前在线活跃连接数</div>
                        <div id="stat_conns" style="font-size:20px; font-weight:700; color:#2563eb; margin-top:4px;">0</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">单连接内存消耗 < 20KB</div>
                    </div>
                    <div style="background:#f8fafc; border:1px solid var(--border-color); border-radius:6px; padding:14px;">
                        <div style="font-size:11px; color:#64748b;">容器持续运行时长</div>
                        <div id="stat_uptime" style="font-size:20px; font-weight:700; color:#0f172a; margin-top:4px;">--</div>
                        <div style="font-size:11px; color:#94a3b8; margin-top:2px;">进程常驻自愈守护</div>
                    </div>
                </div>

                <div style="margin-top:12px;">
                    <div style="font-weight:600; font-size:12px; margin-bottom:6px; color:#334155;">实时核心运行终端视窗 (Console Log):</div>
                    <div class="terminal-box" id="terminalLogBox">> [Kernel] Kata-Tunnel Pro 核心微服务正在运行...
> [Memory] 规格 308MB RAM | 翼龙面板单端口专享
> [Security] 0 毫秒定向掐断引擎处于待命状态</div>
                </div>
            </div>
        </div>
    </div>

    <!-- 弹窗 1: 编辑用户账号信息 -->
    <div class="modal-mask" id="editUserModal">
        <div class="modal-card">
            <div class="modal-title-bar">
                <h3>✏️ 编辑用户账号与连接配置</h3>
                <span style="font-size:14px; cursor:pointer; color:#94a3b8;" onclick="closeAdminModal('editUserModal')">✕</span>
            </div>
            <input type="hidden" id="edit_orig_uuid" />
            <div class="form-row">
                <label>用户名 (登录账号名称)</label>
                <input type="text" id="edit_username" placeholder="用户账号名" />
            </div>
            <div class="form-row">
                <label>重设登录密码 (留空则保持原密码不变)</label>
                <input type="password" id="edit_new_pwd" placeholder="留空保持不变；输入新密码则覆盖重设" />
            </div>
            <div class="form-row">
                <label>专属连接 UUID (修改后将定向掐断旧连接，0ms换新)</label>
                <div style="display:flex; gap:6px;">
                    <input type="text" id="edit_uuid" style="font-family:Consolas, monospace; font-size:12px;" />
                    <button type="button" class="btn" onclick="genNewEditUuid()" style="white-space:nowrap;">🎲 随机UUID</button>
                </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div class="form-row">
                    <label>配额总流量 (GB)</label>
                    <input type="number" id="edit_limit_gb" min="1" />
                </div>
                <div class="form-row">
                    <label>已用流量</label>
                    <div style="display:flex; align-items:center; gap:6px; height:34px;">
                        <span id="disp_edit_used" style="font-size:12px; font-weight:600; color:#475569;">--</span>
                        <label style="font-size:12px; color:#2563eb; cursor:pointer; margin-left:auto; display:flex; align-items:center; gap:3px;">
                            <input type="checkbox" id="edit_reset_traffic" /> <span>清零</span>
                        </label>
                    </div>
                </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div class="form-row">
                    <label>到期日期</label>
                    <input type="date" id="edit_expire_date" />
                </div>
                <div class="form-row">
                    <label>账号状态</label>
                    <select id="edit_enabled">
                        <option value="true">🟢 正常启用</option>
                        <option value="false">🔴 封禁 (即时断连)</option>
                    </select>
                </div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button class="btn" onclick="closeAdminModal('editUserModal')">取消</button>
                <button class="btn btn-primary" onclick="submitEditUser()">💾 保存账号设置</button>
            </div>
        </div>
    </div>

    <!-- 弹窗 2: 添加新用户 -->
    <div class="modal-mask" id="addUserModal">
        <div class="modal-card">
            <div class="modal-title-bar">
                <h3>➕ 添加新接入用户</h3>
                <span style="font-size:14px; cursor:pointer; color:#94a3b8;" onclick="closeAdminModal('addUserModal')">✕</span>
            </div>
            <div class="form-row">
                <label>用户名 (至少3位)</label>
                <input type="text" id="add_username" placeholder="例如: testuser" />
            </div>
            <div class="form-row">
                <label>初始登录密码 (留空默认 123456)</label>
                <input type="password" id="add_password" placeholder="默认 123456" />
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                <div class="form-row">
                    <label>分配配额流量 (GB)</label>
                    <input type="number" id="add_traffic_gb" value="100" />
                </div>
                <div class="form-row">
                    <label>体验有效天数</label>
                    <input type="number" id="add_days" value="365" />
                </div>
            </div>
            <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button class="btn" onclick="closeAdminModal('addUserModal')">取消</button>
                <button class="btn btn-success" onclick="submitAddUser()">立即创建 (0ms可用)</button>
            </div>
        </div>
    </div>

    <script>
        let currentSettings = {};
        let cachedUsersList = [];
        let cachedUsersMap = new Map();

        const navTitles = {
            users: '用户风控中心',
            cdn: '三网优选调度',
            sys: '隧道与系统变量',
            status: '容器探针监控'
        };

        function switchNav(key) {
            ['users', 'cdn', 'sys', 'status'].forEach(k => {
                const menuItem = document.getElementById('menu_' + k);
                const panel = document.getElementById('panel_' + k);
                if (k === key) {
                    menuItem.classList.add('active');
                    panel.style.display = 'block';
                } else {
                    menuItem.classList.remove('active');
                    panel.style.display = 'none';
                }
            });
            document.getElementById('curNavTitle').innerText = navTitles[key] || '管理控制台';
            if (key === 'users') fetchUsers();
            if (key === 'status') fetchStatus();
        }

        async function fetchStatus() {
            try {
                const res = await fetch('/admin/api/status');
                const data = await res.json();
                if (res.ok) {
                    currentSettings = data.settings || {};
                    document.getElementById('kpi_rss').innerText = data.memoryRss || '--';
                    document.getElementById('kpi_conns').innerText = data.onlineConnections || '0';
                    document.getElementById('stat_memRss').innerText = data.memoryRss;
                    document.getElementById('stat_conns').innerText = data.onlineConnections;

                    const hours = Math.floor(data.uptime / 3600);
                    const mins = Math.floor((data.uptime % 3600) / 60);
                    document.getElementById('stat_uptime').innerText = hours + '小时 ' + mins + '分';

                    const wetestTime = currentSettings.wetestSyncTime || '未同步';
                    document.getElementById('kpi_wetest_time').innerText = '最近同步: ' + wetestTime;
                    document.getElementById('kpi_wetest_status').innerText = wetestTime !== '未同步' ? '正常运行' : '等待初次同步';

                    // 终端日志更新
                    const term = document.getElementById('terminalLogBox');
                    term.innerText = \`> [Kernel] Kata-Tunnel Pro 核心微服务正在运行...\\n> [Memory] 常驻 RSS: \${data.memoryRss} | 限额 308MB\\n> [Connections] 当前在线长连接: \${data.onlineConnections}\\n> [Wetest] 微测网最近更新: \${wetestTime}\\n> [Argo] 隧道穿透域名: \${currentSettings.argoDomain || '未绑定'}\\n> [Ready] 所有模块状态良好，0ms即刻响应\`;

                    // 回显配置
                    document.getElementById('cfg_allowRegister').value = String(currentSettings.allowRegister !== false);
                    document.getElementById('cfg_defaultDays').value = currentSettings.defaultDays || 365;
                    document.getElementById('cfg_defaultTrafficGB').value = currentSettings.defaultTrafficGB || 100;
                    document.getElementById('cfg_subDomain').value = currentSettings.subDomain || '';
                    document.getElementById('cfg_argoToken').value = currentSettings.argoToken || '';
                    document.getElementById('cfg_argoDomain').value = currentSettings.argoDomain || '';

                    document.getElementById('cfg_autoSyncWetest').checked = currentSettings.autoSyncWetest !== false;
                    document.getElementById('cfg_enableOptOfficial').checked = currentSettings.enableOptOfficial !== false;
                    document.getElementById('cfg_enableOptCT').checked = currentSettings.enableOptCT !== false;
                    document.getElementById('cfg_enableOptCU').checked = currentSettings.enableOptCU !== false;
                    document.getElementById('cfg_enableOptCM').checked = currentSettings.enableOptCM !== false;

                    document.getElementById('cfg_optOfficialIp').value = currentSettings.optOfficialIp || '';
                    document.getElementById('cfg_optCTIp').value = currentSettings.optCTIp || '';
                    document.getElementById('cfg_optCUIp').value = currentSettings.optCUIp || '';
                    document.getElementById('cfg_optCMIp').value = currentSettings.optCMIp || '';
                }
            } catch (err) {
                console.error(err);
            }
        }

        async function fetchUsers() {
            try {
                const res = await fetch('/admin/api/users');
                const data = await res.json();
                if (res.ok) {
                    cachedUsersList = data.users || [];
                    cachedUsersMap.clear();
                    cachedUsersList.forEach(u => cachedUsersMap.set(u.uuid, u));
                    document.getElementById('kpi_user_count').innerText = cachedUsersList.length;
                    filterUsers();
                }
            } catch (err) {
                console.error(err);
            }
        }

        function filterUsers() {
            const kw = (document.getElementById('userSearchInput').value || '').trim().toLowerCase();
            if (!kw) {
                renderUsersTable(cachedUsersList);
                return;
            }
            const filtered = cachedUsersList.filter(u => 
                (u.username && u.username.toLowerCase().includes(kw)) ||
                (u.uuid && u.uuid.toLowerCase().includes(kw))
            );
            renderUsersTable(filtered);
        }

        function renderUsersTable(list) {
            const tbody = document.getElementById('usersTbody');
            if (!list || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:24px; color:#94a3b8;">未找到匹配的用户数据</td></tr>';
                return;
            }
            tbody.innerHTML = list.map(u => {
                let statusHtml = '<span class="tag tag-ok">🟢 正常</span>';
                if (!u.enabled) statusHtml = '<span class="tag tag-ban">🔴 已封禁</span>';
                else if (u.isExpired) statusHtml = '<span class="tag tag-warn">⏰ 已到期</span>';
                else if (u.isExhausted) statusHtml = '<span class="tag tag-warn">⚠️ 流量超额</span>';

                const pct = Math.min(100, Math.round(((u.trafficUsed || 0) / (u.trafficLimit || 1)) * 100));

                return \`<tr>
                    <td>
                        <div style="font-weight:700; color:#0f172a;">\${u.username}</div>
                    </td>
                    <td>
                        <span class="uuid-badge" onclick="copyText('\${u.uuid}')" title="点击复制 UUID">\${u.uuid}</span>
                    </td>
                    <td>
                        <div style="font-size:11px; color:#475569;">\${u.trafficUsedStr} / \${u.trafficLimitStr}</div>
                        <div class="progress-bar-wrap">
                            <div class="progress-bar-inner" style="width:\${pct}%; background:\${pct > 90 ? '#dc2626' : (pct > 70 ? '#d97706' : '#2563eb')};"></div>
                        </div>
                    </td>
                    <td style="color:#475569;">\${u.expireDateStr}</td>
                    <td>\${statusHtml}</td>
                    <td style="font-weight:700; color:\${u.onlineConns > 0 ? '#16a34a' : '#94a3b8'};">\${u.onlineConns}</td>
                    <td>
                        <div style="display:flex; gap:4px; flex-wrap:nowrap;">
                            <button class="btn btn-sm btn-primary" onclick="openEditUserModal('\${u.uuid}')">✏️ 设置</button>
                            <button class="btn btn-sm" onclick="toggleBan('\${u.uuid}')">\${u.enabled ? '🚫 封禁' : '🔓 解封'}</button>
                            <button class="btn btn-sm" onclick="renewUser('\${u.uuid}')">⏳ +30天</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteUser('\${u.uuid}', '\${u.username}')">🗑️ 删除</button>
                        </div>
                    </td>
                </tr>\`;
            }).join('');
        }

        function openAdminModal(id) { document.getElementById(id).style.display = 'flex'; }
        function closeAdminModal(id) { document.getElementById(id).style.display = 'none'; }

        function openEditUserModal(uuid) {
            const u = cachedUsersMap.get(uuid);
            if (!u) return alert('未找到该用户数据');
            document.getElementById('edit_orig_uuid').value = u.uuid;
            document.getElementById('edit_username').value = u.username;
            document.getElementById('edit_new_pwd').value = '';
            document.getElementById('edit_uuid').value = u.uuid;
            document.getElementById('edit_limit_gb').value = u.trafficLimitGB || 100;
            document.getElementById('disp_edit_used').innerText = u.trafficUsedStr;
            document.getElementById('edit_reset_traffic').checked = false;
            document.getElementById('edit_expire_date').value = u.expireDateISO || '';
            document.getElementById('edit_enabled').value = String(u.enabled !== false);
            openAdminModal('editUserModal');
        }

        function genNewEditUuid() {
            if (window.crypto && window.crypto.randomUUID) {
                document.getElementById('edit_uuid').value = window.crypto.randomUUID();
            } else {
                document.getElementById('edit_uuid').value = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                });
            }
        }

        async function submitEditUser() {
            const origUuid = document.getElementById('edit_orig_uuid').value;
            const newUuid = document.getElementById('edit_uuid').value.trim();
            const username = document.getElementById('edit_username').value.trim();
            const newPassword = document.getElementById('edit_new_pwd').value.trim();
            const trafficLimitGB = parseInt(document.getElementById('edit_limit_gb').value, 10);
            const resetTraffic = document.getElementById('edit_reset_traffic').checked;
            const expireDate = document.getElementById('edit_expire_date').value;
            const enabled = document.getElementById('edit_enabled').value === 'true';

            if (!username) return alert('用户名不能为空');
            if (!newUuid) return alert('UUID 不能为空');

            const payload = {
                originalUuid: origUuid,
                newUuid,
                username,
                newPassword,
                trafficLimitGB,
                resetTraffic,
                expireDate,
                enabled
            };

            const res = await fetch('/admin/api/user/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const d = await res.json();
            if (res.ok) {
                alert('✅ 用户账号信息与连接配置已成功更新并落盘！');
                closeAdminModal('editUserModal');
                fetchUsers();
            } else {
                alert('保存失败: ' + (d.error || '未知错误'));
            }
        }

        function openAddUserModal() {
            document.getElementById('add_username').value = '';
            document.getElementById('add_password').value = '';
            document.getElementById('add_traffic_gb').value = currentSettings.defaultTrafficGB || 100;
            document.getElementById('add_days').value = currentSettings.defaultDays || 365;
            openAdminModal('addUserModal');
            document.getElementById('add_username').focus();
        }

        async function submitAddUser() {
            const username = document.getElementById('add_username').value.trim();
            const password = document.getElementById('add_password').value.trim();
            const trafficGB = parseInt(document.getElementById('add_traffic_gb').value, 10);
            const days = parseInt(document.getElementById('add_days').value, 10);

            if (!username || username.length < 3) return alert('用户名至少3位');

            const res = await fetch('/admin/api/user/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, trafficGB, days })
            });
            const d = await res.json();
            if (res.ok) {
                alert('✅ 用户添加成功，0毫秒即刻连通可用！');
                closeAdminModal('addUserModal');
                fetchUsers();
            } else {
                alert('添加失败: ' + (d.error || '未知错误'));
            }
        }

        function copyText(txt) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).then(() => alert('✅ UUID 已复制！')).catch(() => prompt('按 Ctrl+C 复制:', txt));
            } else {
                prompt('按 Ctrl+C 复制:', txt);
            }
        }

        async function toggleBan(uuid) {
            const res = await fetch('/admin/api/user/toggle-ban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid })
            });
            const d = await res.json();
            if (res.ok) {
                if (!d.enabled && d.disconnectedCount > 0) {
                    alert(\`⚡ 用户已封禁，并已0毫秒定向掐断当前正在通信的 \${d.disconnectedCount} 个活跃连接！\`);
                }
                fetchUsers();
            }
        }

        async function deleteUser(uuid, name) {
            if (!confirm(\`确认删除用户 "\${name}"？执行后将立即掐断该用户的所有现有连接，且对其他用户完全0影响！\`)) return;
            const res = await fetch('/admin/api/user/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid })
            });
            const d = await res.json();
            if (res.ok) {
                alert(d.message || '用户已删除');
                fetchUsers();
            }
        }

        async function renewUser(uuid) {
            const res = await fetch('/admin/api/user/renew', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid, days: 30 })
            });
            if (res.ok) fetchUsers();
        }

        async function manualSyncWetest() {
            const btn = document.getElementById('btnSyncWetest');
            btn.disabled = true;
            btn.innerText = '拉取中...';
            try {
                const res = await fetch('/admin/api/sync-wetest', { method: 'POST' });
                const d = await res.json();
                if (res.ok) {
                    alert('✅ 微测网三网 IP 动态库已全量拉取更新！');
                    fetchStatus();
                } else {
                    alert('同步失败: ' + d.error);
                }
            } finally {
                btn.disabled = false;
                btn.innerText = '🔄 立即全量拉取微测网';
            }
        }

        async function saveCdnSettings() {
            const payload = {
                autoSyncWetest: document.getElementById('cfg_autoSyncWetest').checked,
                enableOptOfficial: document.getElementById('cfg_enableOptOfficial').checked,
                enableOptCT: document.getElementById('cfg_enableOptCT').checked,
                enableOptCU: document.getElementById('cfg_enableOptCU').checked,
                enableOptCM: document.getElementById('cfg_enableOptCM').checked,
                optOfficialIp: document.getElementById('cfg_optOfficialIp').value.trim(),
                optCTIp: document.getElementById('cfg_optCTIp').value.trim(),
                optCUIp: document.getElementById('cfg_optCUIp').value.trim(),
                optCMIp: document.getElementById('cfg_optCMIp').value.trim()
            };
            const res = await fetch('/admin/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) alert('✅ 三网优选策略已保存并即时生效！');
        }

        async function saveSystemSettings() {
            const payload = {
                allowRegister: document.getElementById('cfg_allowRegister').value === 'true',
                defaultDays: parseInt(document.getElementById('cfg_defaultDays').value, 10),
                defaultTrafficGB: parseInt(document.getElementById('cfg_defaultTrafficGB').value, 10),
                subDomain: document.getElementById('cfg_subDomain').value.trim(),
                argoToken: document.getElementById('cfg_argoToken').value.trim(),
                argoDomain: document.getElementById('cfg_argoDomain').value.trim(),
                newAdminPassword: document.getElementById('cfg_newAdminPassword').value.trim()
            };
            const res = await fetch('/admin/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                alert('✅ 系统变量与 Argo 隧道配置已成功落盘！若修改了管理员密码，请使用新密码重新登录。');
                document.getElementById('cfg_newAdminPassword').value = '';
                fetchStatus();
            }
        }

        // 初始化
        fetchStatus();
        fetchUsers();
    </script>
</body>
</html>`;
}

// ==========================================
// 13. 启动 HTTP 监听
// ==========================================
server.listen(PORT, '0.0.0.0', () => {
    // ⚡ 本地多端口桥接兼容引擎：
    // 在容器本地额外激活 8001 和 8080 监听，完全复用主服务逻辑。
    // 无论用户在 Cloudflare 零信任面板习惯性填写 8001、8080 还是翼龙端口，均可全自动 100% 秒通！
    [8001, 8080].forEach(altPort => {
        if (PORT !== altPort) {
            try {
                const altServer = http.createServer((req, res) => server.emit('request', req, res));
                altServer.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
                altServer.listen(altPort, '127.0.0.1', () => {
                    console.log(`[Bridge] ⚡ 容器内部已激活 127.0.0.1:${altPort} 端口，完美兼容 Cloudflare 零信任设置！`);
                });
                altServer.on('error', () => {});
            } catch (e) {}
        }
    });
    console.log(`\n========================================================`);
    console.log(`🚀 Kata-Tunnel 纯原生 Node.js VLESS 隧道核心已成功启动！`);
    console.log(`📡 监听地址: http://0.0.0.0:${PORT}`);
    console.log(`🌐 微测网风格前台: http://127.0.0.1:${PORT}/`);
    console.log(`🛠️ Element UI 后台: http://127.0.0.1:${PORT}/admin`);
    if (siteSettings.argoToken) {
        startArgoTunnel(siteSettings.argoToken);
    }
    console.log(`🛡️ 内存使用: ${formatBytes(process.memoryUsage().rss)} (规格 308MB)`);
    console.log(`========================================================\n`);
});

// 优雅捕获异常防止崩溃
process.on('uncaughtException', err => {
    console.error('[System] 未捕获异常拦截 (防崩溃):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[System] 未处理 Promise 异常拦截 (防崩溃):', reason);
});
