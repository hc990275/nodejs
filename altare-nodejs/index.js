/**
 * =========================================================================
 * 🚀 Altare-Tunnel: 纯原生 Node.js VLESS-WebSocket 隧道与微测网三网优选管理中枢
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
const { hashPassword, verifyPassword, safeUser, createRateLimiter, MAX_BODY_BYTES } = require('./src/security');
// 现代订阅转换引擎（六格式）：从 liuyang 移植，零依赖，支持 ECH 规范处理
const subConverter = require('./src/sub_converter');
const { createWsBinaryFrame: createSafeWsBinaryFrame, WsFrameDecoder: SafeWsFrameDecoder, parseVlessHeader: parseSafeVlessHeader } = require('./src/protocol');

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
    fs.writeFileSync(tmpFile, newLines.join('\n'), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
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
let argoStatus = 'stopped'; // 'connected', 'running', 'downloading', 'stopped', 'error', 'reconnecting'
let argoLastLog = '';
let isArgoDownloading = false;
// 隧道自愈：区分「主动停止」与「异常掉线」。只有清空 token 或程序关闭才算主动停止，
// 其它任何退出（崩溃、SIGTERM、网络抖动）只要 token 仍在，就带退避自动重连。
let argoStopRequested = false;      // 是否为主动停止（token 清空 / 程序退出）
let argoReconnectTimer = null;      // 重连定时器
let argoReconnectDelay = 3000;      // 当前退避间隔（毫秒）
const ARGO_RECONNECT_MAX_DELAY = 60000; // 退避上限 60 秒
let argoHealthTimer = null;         // 健康检查定时器
const ARGO_HEALTH_CHECK_MS = 60000; // 每 60 秒检测一次隧道是否仍连通
let argoLastConnectedAt = 0;        // 上次握手成功的时间戳
const ARGO_STALE_CONNECT_MS = 180000; // 超过 3 分钟未握手视为假死

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

// 重连调度：仅在 token 仍配置且非主动停止时，带指数退避自动拉起隧道
function scheduleArgoReconnect(reason) {
    if (argoStopRequested) return;
    if (!siteSettings.argoToken || !siteSettings.argoToken.trim()) return;
    if (argoReconnectTimer) return; // 已有重连在排队
    argoStatus = 'reconnecting';
    console.log(`[Argo] 🔄 ${reason || '隧道掉线'}，${argoReconnectDelay / 1000}s 后自动重连...`);
    argoReconnectTimer = setTimeout(() => {
        argoReconnectTimer = null;
        if (argoStopRequested) return;
        if (!siteSettings.argoToken || !siteSettings.argoToken.trim()) return;
        // 递增退避；传 true 表示自愈重连，避免在 startArgoTunnel 里重置退避
        argoReconnectDelay = Math.min(argoReconnectDelay * 2, ARGO_RECONNECT_MAX_DELAY);
        startArgoTunnel(siteSettings.argoToken, true);
    }, argoReconnectDelay);
}

// 隧道健康检查：检测进程存活 + 是否真正连上，异常则自动重连/重启
function startArgoHealthCheck() {
    if (argoHealthTimer) return;
    argoHealthTimer = setInterval(() => {
        if (argoStopRequested) return;
        if (!siteSettings.argoToken || !siteSettings.argoToken.trim()) return;
        // 情形1：进程已不在 → 重连
        if (!argoProcess) {
            console.log('[Argo] 🩺 健康检查发现隧道进程离线，准备自动重连...');
            scheduleArgoReconnect('健康检查-进程离线');
            return;
        }
        // 情形2：进程在但长时间未握手成功（假死）→ 主动重启
        if (argoStatus !== 'connected' && argoLastConnectedAt &&
            Date.now() - argoLastConnectedAt > ARGO_STALE_CONNECT_MS) {
            console.log('[Argo] 🩺 健康检查发现隧道长时间未连通（假死），准备重启...');
            if (argoReconnectTimer) { clearTimeout(argoReconnectTimer); argoReconnectTimer = null; }
            scheduleArgoReconnect('健康检查-假死');
        }
    }, ARGO_HEALTH_CHECK_MS);
    argoHealthTimer.unref();
}

async function startArgoTunnel(token, isAutoReconnect = false) {
    if (!token || token.trim() === '') {
        // 空 token = 主动停止，不再自愈
        argoStopRequested = true;
        if (argoReconnectTimer) { clearTimeout(argoReconnectTimer); argoReconnectTimer = null; }
        stopArgoTunnel();
        return;
    }
    // 有 token = 期望隧道运行，关闭「主动停止」标志并启动健康检查
    argoStopRequested = false;
    if (!isAutoReconnect) argoReconnectDelay = 3000; // 仅首次启动/手动重启重置退避
    startArgoHealthCheck();
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
                argoLastConnectedAt = Date.now();
                console.log(`[Argo] 🟢 隧道已成功握手接入 Cloudflare 全球边缘网络！443端口直通与三网优选已全面激活！`);
            }
            console.log(`[Argo LOG] ${argoLastLog}`);
        });

        argoProcess.on('exit', (code, signal) => {
            console.log(`[Argo] 进程退出: code=${code}, signal=${signal}`);
            argoProcess = null;
            argoStatus = 'stopped';
            // 自愈：非主动停止且 token 仍在 → 自动重连
            if (!argoStopRequested && siteSettings.argoToken && siteSettings.argoToken.trim()) {
                scheduleArgoReconnect('进程退出');
            }
        });

        argoProcess.on('error', err => {
            console.error(`[Argo] 进程异常: ${err.message}`);
            argoProcess = null;
            argoStatus = 'error';
            if (!argoStopRequested && siteSettings.argoToken && siteSettings.argoToken.trim()) {
                scheduleArgoReconnect('进程异常');
            }
        });
    } catch (err) {
        console.error(`[Argo] 进程启动抛出异常: ${err.message}`);
        argoStatus = 'error';
    }
}

function stopArgoTunnel() {
    if (argoReconnectTimer) { clearTimeout(argoReconnectTimer); argoReconnectTimer = null; }
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

// ==========================================
// 2.2 .env 文件变更智能监听与双向热重载
// ==========================================
let envWatchDebounce = null;
function reloadEnvHot() {
    if (!fs.existsSync(ENV_FILE)) return;
    try {
        const newEnv = parseEnvFile(ENV_FILE);
        console.log('[Env] ⚡ 监听到外部 .env 文件变动，正在执行内存双向热重载...');

        if (newEnv.ADMIN_PASSWORD && newEnv.ADMIN_PASSWORD !== ADMIN_PASSWORD) {
            ADMIN_PASSWORD = newEnv.ADMIN_PASSWORD;
            passwordSetupRequired = false;
            console.log('[Env] 🔑 管理员密码已即时热更新！');
        }
        if (newEnv.DEFAULT_ALLOW_REGISTER !== undefined) siteSettings.allowRegister = newEnv.DEFAULT_ALLOW_REGISTER.trim() === 'true';
        if (newEnv.DEFAULT_DAYS !== undefined) siteSettings.defaultDays = parseInt(newEnv.DEFAULT_DAYS, 10) || siteSettings.defaultDays;
        if (newEnv.DEFAULT_TRAFFIC_GB !== undefined) siteSettings.defaultTrafficGB = parseInt(newEnv.DEFAULT_TRAFFIC_GB, 10) || siteSettings.defaultTrafficGB;
        if (newEnv.WETEST_API_URL !== undefined) siteSettings.wetestApiUrl = newEnv.WETEST_API_URL.trim();

        if (newEnv.ARGO_TOKEN !== undefined) {
            const diskToken = (newEnv.ARGO_TOKEN || '').trim();
            const memToken = (siteSettings.argoToken || '').trim();
            // 后台表单留空不会写 .env，所以只有这里才会出现 token 真正变化。
            // 用 trim 后比较，避免空格/换行差异造成误判；空值代表主动清空 -> 停止隧道。
            if (diskToken !== memToken) {
                siteSettings.argoToken = diskToken;
                startArgoTunnel(siteSettings.argoToken); // 空=停止；非空=启动/重启
                console.log('[Env] ⚡ Argo Token 已变更（' + (diskToken ? '重启' : '停止') + '）');
            }
        }

        if (newEnv.ARGO_DOMAIN !== undefined && newEnv.ARGO_DOMAIN !== siteSettings.argoDomain) {
            siteSettings.argoDomain = newEnv.ARGO_DOMAIN.trim();
            console.log('[Env] 🌐 Argo 穿透域名已热更新:', siteSettings.argoDomain);
        }

        if (newEnv.SUB_DOMAIN !== undefined && newEnv.SUB_DOMAIN !== siteSettings.subDomain) {
            siteSettings.subDomain = newEnv.SUB_DOMAIN.trim();
            console.log('[Env] 📡 节点主公网域名/IP已热更新:', siteSettings.subDomain);
        }

        if (newEnv.IP_REGISTER_COOLDOWN_SEC !== undefined) {
            siteSettings.ipRegisterCooldownSec = Math.max(0, parseInt(newEnv.IP_REGISTER_COOLDOWN_SEC, 10) || 0);
            console.log('[Env] 🛡️ 单 IP 注册冷却时间已热重载:', siteSettings.ipRegisterCooldownSec, '秒');
        }

                if (newEnv.SUBAPI !== undefined) {
            siteSettings.subApi = newEnv.SUBAPI.trim();
            console.log('[Env] 🔄 订阅转换后端已热更新:', siteSettings.subApi);
        }
        if (newEnv.SUBCONFIG !== undefined) {
            siteSettings.subConfig = newEnv.SUBCONFIG.trim();
        }
        if (newEnv.IP_DAILY_REGISTER_LIMIT !== undefined) {
            siteSettings.ipDailyRegisterLimit = Math.max(0, parseInt(newEnv.IP_DAILY_REGISTER_LIMIT, 10) || 0);
            console.log('[Env] 🛡️ 单 IP 每日注册上限已热重载:', siteSettings.ipDailyRegisterLimit, '个');
        }

        if (newEnv.ENABLE_ECH !== undefined) {
            siteSettings.enableECH = newEnv.ENABLE_ECH.trim() === 'true';
            console.log('[Env] 🛡️ ECH 开关已热更新:', siteSettings.enableECH);
        }
        if (newEnv.ECH_SNI !== undefined) {
            siteSettings.echSni = newEnv.ECH_SNI.trim();
            console.log('[Env] 🛡️ ECH SNI 已热更新:', siteSettings.echSni);
        }
        if (newEnv.ECH_DNS !== undefined) {
            siteSettings.echDns = newEnv.ECH_DNS.trim();
            console.log('[Env] 🛡️ ECH DoH 服务器已热更新:', siteSettings.echDns);
        }
        if (newEnv.CLIENT_FINGERPRINT !== undefined) {
            siteSettings.clientFingerprint = newEnv.CLIENT_FINGERPRINT.trim();
            console.log('[Env] 🛡️ 客户端混淆指纹已热更新:', siteSettings.clientFingerprint);
        }
    } catch (e) {
        console.error('[Env] 热重载异常:', e.message);
    }
}

if (fs.existsSync(ENV_FILE)) {
    try {
        fs.watch(ENV_FILE, (eventType) => {
            if (eventType === 'change' || eventType === 'rename') {
                if (envWatchDebounce) clearTimeout(envWatchDebounce);
                envWatchDebounce = setTimeout(() => {
                    reloadEnvHot();
                }, 500);
            }
        });
    } catch (e) {}
}

function getEnv(key, defVal = '') {
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    if (initialEnv[key] !== undefined && initialEnv[key] !== '') return initialEnv[key];
    return defVal;
}

// 公网 IPv4 自动探测：不写死 IP，启动时异步拉取，失败时留空（由访问者 Host / 隧道域名兜底）
let detectedPublicIp = '';
function detectPublicIp() {
    const sources = [
        'https://api.ipify.org',
        'https://ipv4.icanhazip.com',
        'https://ifconfig.me/ip'
    ];
    let done = false;
    sources.forEach(src => {
        if (done) return;
        try {
            const lib = src.startsWith('https') ? require('https') : http;
            const req = lib.get(src, { timeout: 4000 }, res => {
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    const ip = data.trim();
                    if (!done && net.isIPv4(ip)) {
                        done = true;
                        detectedPublicIp = ip;
                        console.log('[Net] 🌐 自动探测公网 IPv4:', ip);
                        if (!detectedGeo && !net.isIPv4(configuredIp)) detectGeoByIp(ip);
                    }
                });
            });
            req.on('error', () => {});
            req.on('timeout', () => req.destroy());
        } catch (_) {}
    });
}

// 优先使用面板机房地区（例如 mn-uln），未提供机房地区时才查询公网 IP。
function countryLabel(value) {
    if (typeof value !== 'string' || !/^[A-Z]{2}$/i.test(value)) return '';
    const code = value.toUpperCase();
    const names = new Intl.DisplayNames(['zh-CN'], { type: 'region', fallback: 'none' });
    const name = names.of(code);
    if (!name) return '';
    const flag = String.fromCodePoint(...Array.from(code, letter => 0x1F1E6 + letter.charCodeAt(0) - 65));
    return `${flag}${name}`;
}

const panelLocation = getEnv('P_SERVER_LOCATION').trim();
const panelCountry = /^([a-z]{2})(?:-[a-z0-9-]+)?$/i.exec(panelLocation)?.[1];
let detectedGeo = countryLabel(panelCountry);
const configuredIp = getEnv('SERVER_IP').trim();

function detectGeoByIp(ip) {
    const req = require('node:https').get(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(6000) }, res => {
        if (res.statusCode !== 200) return res.resume();
        let body = '';
        res.setEncoding('utf8');
        res.on('error', () => {});
        res.on('data', chunk => {
            body += chunk;
            if (body.length > 8192) res.destroy();
        });
        res.on('end', () => {
            try {
                detectedGeo = countryLabel(JSON.parse(body).country);
            } catch (_) { /* 保留未知地区 */ }
        });
    });
    req.on('error', () => {});
}

if (!detectedGeo && net.isIPv4(configuredIp)) detectGeoByIp(configuredIp);
detectPublicIp();

function machineTag() {
    return [detectedGeo || '🌐未知地区', PORT].filter(Boolean).join('·');
}

function escapeHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

// 端口自动探测：适配翼龙面板（Altare/Lunes）纯 Node.js 环境
// 依次从显式配置 → process.env → /proc/1/environ → 命令行 → 模糊匹配中探测面板分配端口
function resolvePanelPort() {
    const rawEnv = (process.env.SERVER_PORT || process.env.PORT || initialEnv.SERVER_PORT || initialEnv.PORT || '').trim();
    if (rawEnv && parseInt(rawEnv, 10) > 0) return parseInt(rawEnv, 10);
    const portKeys = /^(?:SERVER_PORT|SERVERPORT|PORT|ALLOCATION_PORT|P_SERVER_PORT|ALLOCATION|APP_PORT|NODE_PORT|CONTAINER_PORT|SERVICE_PORT|WEB_PORT|LISTENING_PORT|KATABUMP_PORT)$/i;
    for (const [key, val] of Object.entries(process.env)) {
        if (!val || typeof val !== 'string' || !key.match(portKeys)) continue;
        const p = parseInt(val.trim(), 10);
        if (p > 0 && p <= 65535) return p;
    }
    for (const procPath of ['/proc/1/environ', '/proc/self/environ']) {
        try {
            if (!fs.existsSync(procPath)) continue;
            const raw = fs.readFileSync(procPath, 'utf8');
            for (const entry of raw.split('\u0000')) {
                const eq = entry.indexOf('=');
                if (eq === -1) continue;
                const k = entry.slice(0, eq).trim();
                const v = entry.slice(eq + 1).trim();
                if (k.match(portKeys)) {
                    const p = parseInt(v, 10);
                    if (p > 0 && p <= 65535) return p;
                }
            }
        } catch (_) {}
    }
    for (let i = 2; i < process.argv.length; i++) {
        const arg = (process.argv[i] || '').trim();
        if (/^--port=/.test(arg) || /^-p=/.test(arg)) {
            const p = parseInt(arg.split('=')[1], 10);
            if (p >= 1024 && p <= 65535) return p;
        }
        const p = parseInt(arg, 10);
        if (p >= 1024 && p <= 65535) return p;
    }
    for (const [key, val] of Object.entries(process.env)) {
        if (!val || typeof val !== 'string') continue;
        const upper = key.toUpperCase();
        if (upper.includes('PORT') && !upper.includes('PATH') && !upper.includes('SUPPORT')) {
            const p = parseInt(val.trim(), 10);
            if (p >= 1024 && p <= 65535 && ![8001, 10011, 10012, 10013, 10014].includes(p)) return p;
        }
    }
    return null;
}
const detectedPort = resolvePanelPort();
const PORT = detectedPort;
if (!Number.isInteger(PORT)) {
    console.warn('[Startup] ⚠️ 未自动探测到面板端口，服务挂起等待端口配置；不监听假端口。');
}
let ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD', '');
let passwordSetupRequired = !ADMIN_PASSWORD; // 未在 .env 预置密码时，首次进入后台强制设置
if (passwordSetupRequired) {
    console.warn('[Security] ⚠️ 未在 .env 检测到 ADMIN_PASSWORD：将要求管理员首次进入后台时设置密码（设置前禁止进入）。');
}

// ==========================================
// 3. 运营配置与三网优选池持久化
// ==========================================

// ==========================================
// 🚀 ECH (Encrypted Client Hello) RFC 1035 / RFC 8484 DNS Type 65 Wire-Format 权威解析引擎
// ==========================================
const echMemoryCache = new Map(); // sni -> { pem, expiresAt }

async function getCachedECH(sni = 'cloudflare-ech.com', dnsUrl = 'https://dns.alidns.com/dns-query') {
    const cacheKey = `${sni}@${dnsUrl}`;
    const now = Date.now();
    const cached = echMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > now && cached.pem) {
        return cached.pem;
    }

    try {
        const labels = sni.split('.');
        const qnameParts = [];
        for (const l of labels) {
            const buf = Buffer.from(l, 'utf8');
            qnameParts.push(Buffer.from([buf.length]), buf);
        }
        qnameParts.push(Buffer.from([0]));
        const qname = Buffer.concat(qnameParts);

        // Header: 12 bytes, ID: random, Flags: 0x0100 (RD=1), QDCOUNT: 1
        const id = Math.floor(Math.random() * 65535);
        const header = Buffer.alloc(12);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(0x0100, 2);
        header.writeUInt16BE(1, 4);

        // Question: qname + QTYPE(65) + QCLASS(1)
        const qtail = Buffer.alloc(4);
        qtail.writeUInt16BE(65, 0); // Type 65 (HTTPS)
        qtail.writeUInt16BE(1, 2);  // Class 1 (IN)
        const dnsMsg = Buffer.concat([header, qname, qtail]);

        const parsedDns = url.parse(dnsUrl);
        const httpModule = parsedDns.protocol === 'http:' ? http : https;
        const options = {
            hostname: parsedDns.hostname,
            port: parsedDns.port || (parsedDns.protocol === 'http:' ? 80 : 443),
            path: parsedDns.path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message',
                'Content-Length': dnsMsg.length
            },
            timeout: 2500
        };

        const resBuf = await new Promise((resolve, reject) => {
            const req = httpModule.request(options, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('DoH status ' + res.statusCode));
                }
                const chunks = [];
                res.on('data', d => chunks.push(d));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('DoH timeout')); });
            req.on('error', reject);
            req.write(dnsMsg);
            req.end();
        });

        if (resBuf.length >= 12) {
            const qdcount = resBuf.readUInt16BE(4);
            const ancount = resBuf.readUInt16BE(6);

            let p = 12;
            // Skip Question Section
            for (let i = 0; i < qdcount; i++) {
                while (p < resBuf.length) {
                    const len = resBuf[p++];
                    if (len === 0) break;
                    if ((len & 0xc0) === 0xc0) { p++; break; }
                    p += len;
                }
                p += 4;
            }

            // Parse Answer Section
            for (let i = 0; i < ancount && p < resBuf.length; i++) {
                if ((resBuf[p] & 0xc0) === 0xc0) {
                    p += 2;
                } else {
                    while (p < resBuf.length && resBuf[p] !== 0) {
                        p += resBuf[p] + 1;
                    }
                    p++;
                }
                if (p + 10 > resBuf.length) break;
                const rtype = resBuf.readUInt16BE(p);
                p += 8;
                const rdlen = resBuf.readUInt16BE(p);
                p += 2;

                if (rtype === 65 && p + rdlen <= resBuf.length) {
                    const rdata = resBuf.subarray(p, p + rdlen);
                    let np = 2; // Priority
                    while (np < rdata.length && rdata[np] !== 0) {
                        if ((rdata[np] & 0xc0) === 0xc0) { np += 2; break; }
                        np += rdata[np] + 1;
                    }
                    if (np < rdata.length && rdata[np] === 0) np++;

                    // SvcParams
                    while (np + 4 <= rdata.length) {
                        const key = rdata.readUInt16BE(np);
                        const valLen = rdata.readUInt16BE(np + 2);
                        np += 4;
                        if (key === 5 && np + valLen <= rdata.length) { // key 5 = ech
                            const echBytes = rdata.subarray(np, np + valLen);
                            const b64 = echBytes.toString('base64');
                            const pem = `-----BEGIN ECH CONFIGS-----\n${b64}\n-----END ECH CONFIGS-----`;
                            echMemoryCache.set(cacheKey, { pem, expiresAt: now + 30 * 60 * 1000 });
                            return pem;
                        }
                        np += valLen;
                    }
                }
                p += rdlen;
            }
        }
    } catch (e) {
        if (cached && cached.pem) return cached.pem;
    }
    return null;
}

// 把节点里的 ECH DNS 查询表达式预解析成 PEM（复用 getCachedECH 的缓存），
// 使 sub_converter 的 compatibility 放行 ECH 节点（否则会被误判为不兼容而过滤）。
async function prepareNodesEch(nodes) {
    const out = nodes.map(n => ({ ...n }));
    const tasks = [];
    for (const n of out) {
        if (!n.echConfigList || typeof n.echConfigList !== 'string') continue;
        if (!/^(?:[a-zA-Z0-9.-]+\+)?(?:https|udp|h2c):\/\//.test(n.echConfigList)) continue;
        const expr = subConverter.parseEch(n.echConfigList);
        if (!expr || !expr.resolver) continue;
        const queryName = expr.queryName || n.sni || 'cloudflare-ech.com';
        tasks.push((async () => {
            const pem = await getCachedECH(queryName, siteSettings.echDns || 'https://dns.alidns.com/dns-query');
            if (pem) { n.echConfigList = pem; n.echEnabled = true; }
            else { n.echResolutionFailed = true; n.echConfigList = ''; n.echEnabled = false; }
        })());
    }
    if (tasks.length) await Promise.allSettled(tasks);
    return out;
}

function patchClashWithECH(yamlStr, echSni = 'cloudflare-ech.com', echDns = 'https://dns.alidns.com/dns-query', fp = 'chrome', targetHost = '') {
    try {
        let content = yamlStr;
        const hostEntry = targetHost ? `    "${targetHost}":\n      - ${echDns}\n` : '';
        const policySnippet = `${hostEntry}    "${echSni}":\n      - ${echDns}`;

        if (/^\s{2}nameserver-policy:\s*(?:\n|$)/m.test(content)) {
            content = content.replace(/^(\s{2}nameserver-policy:\s*\n)/m, `$1${policySnippet}\n`);
        } else if (/^dns:\s*$/m.test(content)) {
            content = content.replace(/^dns:\s*$/m, `dns:\n  nameserver-policy:\n${policySnippet}`);
        } else if (!/^dns:\s*(?:\n|$)/m.test(content)) {
            content = `dns:\n  enable: true\n  nameserver-policy:\n${policySnippet}\n` + content;
        }

        const lines = content.split('\n');
        const newLines = [];
        let inProxies = false;
        let currentProxyLines = [];
        let baseIndent = 2;

        const flushProxy = () => {
            if (currentProxyLines.length === 0) return;
            const fullBlock = currentProxyLines.join('\n');
            const isTls = /tls:\s*true/i.test(fullBlock);
            if (isTls) {
                let hasFp = false;
                for (let i = 0; i < currentProxyLines.length; i++) {
                    if (/^\s*client-fingerprint:/i.test(currentProxyLines[i])) {
                        currentProxyLines[i] = currentProxyLines[i].replace(/client-fingerprint:\s*.*/, `client-fingerprint: ${fp}`);
                        hasFp = true;
                        break;
                    }
                }
                if (!hasFp) {
                    const indent = ' '.repeat(baseIndent + 2);
                    currentProxyLines.push(`${indent}client-fingerprint: ${fp}`);
                }

                if (!/ech-opts:/i.test(fullBlock)) {
                    const indent = ' '.repeat(baseIndent + 2);
                    currentProxyLines.push(`${indent}ech-opts:`);
                    currentProxyLines.push(`${indent}  enable: true`);
                    currentProxyLines.push(`${indent}  query-server-name: ${echSni}`);
                }
            }
            newLines.push(...currentProxyLines);
            currentProxyLines = [];
        };

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            if (/^proxies:\s*$/i.test(trimmed)) {
                inProxies = true;
                newLines.push(line);
                continue;
            }

            if (inProxies && /^[a-zA-Z0-9_-]+:\s*$/i.test(trimmed) && !trimmed.startsWith('-')) {
                flushProxy();
                inProxies = false;
                newLines.push(line);
                continue;
            }

            if (inProxies) {
                if (trimmed.startsWith('- name:')) {
                    flushProxy();
                    baseIndent = line.search(/\S/);
                    currentProxyLines.push(line);
                } else if (currentProxyLines.length > 0) {
                    currentProxyLines.push(line);
                } else {
                    newLines.push(line);
                }
            } else {
                newLines.push(line);
            }
        }
        flushProxy();

        return newLines.join('\n');
    } catch (e) {
        return yamlStr;
    }
}

function patchSingboxWithECH(jsonStr, echPem, fp = 'chrome') {
    try {
        const obj = JSON.parse(jsonStr);
        if (Array.isArray(obj.outbounds)) {
            obj.outbounds.forEach(out => {
                if (out && out.tls && out.tls.enabled !== false) {
                    out.tls.utls = {
                        enabled: true,
                        fingerprint: fp
                    };
                    if (echPem) {
                        out.tls.ech = {
                            enabled: true,
                            config: echPem
                        };
                    }
                }
            });
        }
        return JSON.stringify(obj, null, 2);
    } catch (e) {
        return jsonStr;
    }
}

const DEFAULT_SETTINGS = {
    allowRegister: getEnv('DEFAULT_ALLOW_REGISTER', 'false') === 'true',
    defaultDays: parseInt(getEnv('DEFAULT_DAYS', '30'), 10),
    defaultTrafficGB: parseInt(getEnv('DEFAULT_TRAFFIC_GB', '10'), 10),
    ipRegisterCooldownSec: parseInt(getEnv('IP_REGISTER_COOLDOWN_SEC', '60'), 10), // 单 IP 注册冷却时间 (秒)
    ipDailyRegisterLimit: parseInt(getEnv('IP_DAILY_REGISTER_LIMIT', '3'), 10),     // 单 IP 24小时注册配额上限 (个)
    subApi: getEnv('SUBAPI', 'local'), // 订阅转换服务: local(本地原生零外传引擎) 或 https://api.v1.mk 等公网Subconverter
    subConfig: getEnv('SUBCONFIG', 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini'),
    // SUB_DOMAIN 自动：隧道域名优先，否则留空由 detectedPublicIp 兜底（见 resolvePublicHost）
    subDomain: getEnv('SUB_DOMAIN', '') || getEnv('ARGO_DOMAIN', ''),
    argoToken: getEnv('ARGO_TOKEN', ''),
    argoDomain: getEnv('ARGO_DOMAIN', ''),

    // 🚀 ECH 全局安全防探测与客户端混淆指纹
    enableECH: getEnv('ENABLE_ECH', 'true') === 'true',
    echSni: getEnv('ECH_SNI', 'cloudflare-ech.com'),
    echDns: getEnv('ECH_DNS', 'https://dns.alidns.com/dns-query'),
    clientFingerprint: getEnv('CLIENT_FINGERPRINT', 'chrome'),

    // 微测网三网优选独立开关 (彻底无 AWS)
    wetestApiUrl: getEnv('WETEST_API_URL', ''),
    enableOptOfficial: true,
    enableOptCT: true,
    enableOptCU: true,
    enableOptCM: true,
    autoSyncWetest: true,

    // 🚀 自定义批量优选域名池 (支持纯域名、域名#备注、域名:端口#备注、域名:端口)
    // 默认开启并内置一批优选域名；管理员可在后台随时增删或关闭
    enableCustomDomains: true,
    customDomainsText: [
        'www.visa.comshopify.com',
        'www.shopify.com',
        'www.digitalocean.com',
        'icook.tw',
        'icook.hk',
        'ip.sb',
        'forum.gamer.com.tw',
        'saas.sin.fan',
        'www.web.com',
        'www.visa.com.sg'
    ].join('\n'),

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
        // settings.json 里可能残留空的 argoToken（历史保存写入），
        // 若 .env 中存在有效 token，则以 .env 为准，避免空值覆盖导致隧道不启动。
        if ((!siteSettings.argoToken || !siteSettings.argoToken.trim()) &&
            DEFAULT_SETTINGS.argoToken && DEFAULT_SETTINGS.argoToken.trim()) {
            siteSettings.argoToken = DEFAULT_SETTINGS.argoToken;
        }
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
    if (users.size === 0) console.log('[Users] 用户库为空；不会创建默认账号，请由已认证管理员创建用户。');
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
            rtt = parseInt(item.rtt_avg || item.rtt || item.ping || item.latency || 0, 10);
        }
        return { ip, colo, rtt };
    }).filter(x => x.ip && /^[\d\.]+$/.test(x.ip));
}

async function fetchWetestCleanIps() {
    console.log('[Wetest] 开始从微测网全量动态拉取三网 Cloudflare 优选 IP (不含 AWS)...');
    const cfUrl = (siteSettings.wetestApiUrl || getEnv('WETEST_API_URL', '')).trim();
    if (!cfUrl) return { success: false, error: '尚未配置 WETEST_API_URL；保留当前节点池' };
    try {
        const cfRes = await fetchJsonUrl(cfUrl, 10000);
        if (cfRes && (cfRes.code === 200 || cfRes.status === 'success' || cfRes.info)) {
            const rawData = cfRes.data || cfRes.info || {};
            const cleanCT = normalizeWetestItemList(rawData.CT || rawData.ct || rawData.dx || rawData.telecom);
            const cleanCU = normalizeWetestItemList(rawData.CU || rawData.cu || rawData.lt || rawData.unicom);
            const cleanCM = normalizeWetestItemList(rawData.CM || rawData.cm || rawData.yd || rawData.mobile);
            const cleanCN = normalizeWetestItemList(rawData.CN || rawData.cn || rawData.all || rawData.anycast || []);

            const sortByRtt = (list) => list.sort((a, b) => (a.rtt || 999) - (b.rtt || 999));

            // 有多少抓多少！全量保留微测网抓取到的所有合格 IP，彻底解除人为数量限制
            if (cleanCT.length > 0) siteSettings.cfNodes.ct = sortByRtt(cleanCT);
            if (cleanCU.length > 0) siteSettings.cfNodes.cu = sortByRtt(cleanCU);
            if (cleanCM.length > 0) siteSettings.cfNodes.cm = sortByRtt(cleanCM);
            if (cleanCN.length > 0) siteSettings.cfNodes.official = sortByRtt(cleanCN);

            siteSettings.wetestSyncTime = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
            saveSettings();
            console.log(`[Wetest] ✅ 微测网三网 IP 抓取成功！CT:${siteSettings.cfNodes.ct.length}, CU:${siteSettings.cfNodes.cu.length}, CM:${siteSettings.cfNodes.cm.length}`);
            return { success: true, settings: publicSettings() };
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
function createLegacyWsBinaryFrame(buffer) {
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
class LegacyWsFrameDecoder {
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
function parseLegacyVlessHeader(buffer) {
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

    const decoder = new SafeWsFrameDecoder(
        (data) => {
            if (!isHeaderProcessed) {
                isHeaderProcessed = true;
                const header = parseSafeVlessHeader(data);
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
                clientSocket.write(createSafeWsBinaryFrame(vlessResp));

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
                    const frame = createSafeWsBinaryFrame(chunk);
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
// 解析自定义优选域名行：纯域名 / 域名#备注 / 域名:端口#备注 / 域名:端口
function parseCustomDomainLine(line) {
    let trimmed = (line || '').trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith(';')) return null;

    let remark = '';
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) {
        remark = trimmed.substring(hashIdx + 1).trim();
        trimmed = trimmed.substring(0, hashIdx).trim();
    }
    if (!trimmed) return null;

    let host = trimmed;
    let port = 443;
    const colonIdx = trimmed.lastIndexOf(':');
    if (colonIdx !== -1 && !trimmed.endsWith(']')) {
        const portStr = trimmed.substring(colonIdx + 1).trim();
        const p = parseInt(portStr, 10);
        if (!isNaN(p) && p > 0 && p <= 65535) {
            port = p;
            host = trimmed.substring(0, colonIdx).trim();
        }
    }
    if (!host) return null;

    return {
        host,
        port,
        remark: remark || (port === 443 ? host : `${host}:${port}`)
    };
}

// 统一公网 host 解析：优先 SUB_DOMAIN(或隧道域名) → 探测到的公网 IPv4 → 空
function resolvePublicHost() {
    return siteSettings.subDomain || siteSettings.argoDomain || detectedPublicIp || getEnv('SERVER_IP', '') || '';
}

// 直连节点专用 host：必须是公网 IPv4（域名经 CF 只暴露 443，不会转发到面板端口）
function resolveDirectIp() {
    return getEnv('SERVER_IP', '') || detectedPublicIp || (net.isIP(siteSettings.subDomain) ? siteSettings.subDomain : '') || '';
}

function generateUserNodes(user) {
    const list = [];
    const host = resolvePublicHost();
    // 端口回溯域名优先作为 CDN 优选与端口回溯的承载域名；若未配置回溯域名则回退至 argo 域名或 host
    const hasBacktrackDomain = siteSettings.subDomain && !/^[0-9.]+$/.test(siteSettings.subDomain) && !siteSettings.subDomain.includes(':');
    const domain = hasBacktrackDomain ? siteSettings.subDomain : (siteSettings.argoDomain || host);
    const effectiveSni = domain;

    const fp = siteSettings.clientFingerprint || 'chrome';
    const echSni = siteSettings.echSni || 'cloudflare-ech.com';
    const echDns = siteSettings.echDns || 'https://dns.alidns.com/dns-query';
    const echVal = `${echSni}+${echDns}`;

    // 完美补齐 v2rayN 界面所需字段: Fingerprint, Alpn 以及 EchConfigList
    const tlsExtra = (siteSettings.enableECH !== false)
        ? `&fp=${fp}&ech=${echVal}&echConfigList=${echVal}`
        : `&fp=${fp}`;

    // 1. Altare 原生端口直连节点 (直连宿主机公网 IP + 面板端口，必须走 IP 不能用域名)
    const directIp = resolveDirectIp() || host;
    const directTag = `【${machineTag()}·原生直连·Altare】-VLESS-WS`;
    list.push(`vless://${user.uuid}@${directIp}:${PORT}?encryption=none&security=none&type=ws&host=${encodeURIComponent(directIp)}&path=%2F#${encodeURIComponent(directTag)}`);

    // 1.1 若配置了 Cloudflare Argo 隧道域名，额外下发专属 443 端口隧道直连节点
    if (siteSettings.argoDomain) {
        const argoTag = `【${machineTag()}·CF·Argo隧道·443】-VLESS-WS`;
        list.push(`vless://${user.uuid}@${siteSettings.argoDomain}:443?encryption=none&security=tls&sni=${encodeURIComponent(siteSettings.argoDomain)}&type=ws&host=${encodeURIComponent(siteSettings.argoDomain)}&path=%2F${tlsExtra}#${encodeURIComponent(argoTag)}`);
    }

    // 1.2 若配置了端口回溯域名，下发专属 443 端口回溯直连节点
    if (hasBacktrackDomain) {
        const btTag = `【${machineTag()}·CF·端口回溯·443】-VLESS-WS`;
        list.push(`vless://${user.uuid}@${siteSettings.subDomain}:443?encryption=none&security=tls&sni=${encodeURIComponent(siteSettings.subDomain)}&type=ws&host=${encodeURIComponent(siteSettings.subDomain)}&path=%2F${tlsExtra}#${encodeURIComponent(btTag)}`);
    }

    // 2. CF 官方 Anycast
    if (siteSettings.enableOptOfficial !== false) {
        const anyIp = siteSettings.optOfficialIp || (siteSettings.cfNodes.official[0] && siteSettings.cfNodes.official[0].ip) || domain;
        const tag = `【${machineTag()}·CF·Anycast·443】-VLESS-WS`;
        list.push(`vless://${user.uuid}@${anyIp}:443?encryption=none&security=tls&sni=${encodeURIComponent(effectiveSni)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F${tlsExtra}#${encodeURIComponent(tag)}`);
    }

    // 3. CF 中国电信 (CT) 优选
    if (siteSettings.enableOptCT !== false) {
        const ctList = siteSettings.cfNodes.ct || [];
        ctList.forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCTIp) ? siteSettings.optCTIp : n.ip;
            const tag = `【${machineTag()}·CF·电信优选·${idx + 1}·${n.colo || 'FRA'}】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(effectiveSni)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F${tlsExtra}#${encodeURIComponent(tag)}`);
        });
    }

    // 4. CF 中国联通 (CU) 优选
    if (siteSettings.enableOptCU !== false) {
        const cuList = siteSettings.cfNodes.cu || [];
        cuList.forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCUIp) ? siteSettings.optCUIp : n.ip;
            const tag = `【${machineTag()}·CF·联通优选·${idx + 1}·${n.colo || 'SJC'}】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(effectiveSni)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F${tlsExtra}#${encodeURIComponent(tag)}`);
        });
    }

    // 5. CF 中国移动 (CM) 优选
    if (siteSettings.enableOptCM !== false) {
        const cmList = siteSettings.cfNodes.cm || [];
        cmList.forEach((n, idx) => {
            const ip = (idx === 0 && siteSettings.optCMIp) ? siteSettings.optCMIp : n.ip;
            const tag = `【${machineTag()}·CF·移动优选·${idx + 1}·${n.colo || 'HKG'}】-VLESS-WS`;
            list.push(`vless://${user.uuid}@${ip}:443?encryption=none&security=tls&sni=${encodeURIComponent(effectiveSni)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F${tlsExtra}#${encodeURIComponent(tag)}`);
        });
    }

    // 6. 🚀 自定义批量优选域名池 (纯域名、域名#备注、域名:端口#备注、域名:端口)
    if (siteSettings.enableCustomDomains && siteSettings.customDomainsText) {
        const lines = siteSettings.customDomainsText.split(/\r?\n/);
        lines.forEach(line => {
            const item = parseCustomDomainLine(line);
            if (item) {
                const tag = `【${machineTag()}·自定义·${item.remark}】-VLESS-WS`;
                list.push(`vless://${user.uuid}@${item.host}:${item.port}?encryption=none&security=tls&sni=${encodeURIComponent(domain)}&type=ws&host=${encodeURIComponent(domain)}&path=%2F${tlsExtra}#${encodeURIComponent(tag)}`);
            }
        });
    }

    return list;
}

// ==========================================
// 9. HTTP 路由分发与 Session 鉴权
// ==========================================
const adminSessions = new Map(); // token -> expiresAt
const userSessions = new Map(); // token -> uuid
const adminLoginLimiter = createRateLimiter();
const userLoginLimiter = createRateLimiter();
// 🛡️ 防薅风控核心：clientIp -> Array<number> (最近24小时内所有成功注册的时间戳毫秒列表)
const registerIpHistory = new Map();

// 辅助方法：获取客户端 IP 在过去 24 小时内的所有有效注册记录
function getRecentIpRegistrations(clientIp) {
    const now = Date.now();
    const oneDayAgo = now - 24 * 3600 * 1000;
    const history = registerIpHistory.get(clientIp) || [];
    const valid = history.filter(t => t > oneDayAgo);
    if (valid.length !== history.length) {
        if (valid.length === 0) {
            registerIpHistory.delete(clientIp);
        } else {
            registerIpHistory.set(clientIp, valid);
        }
    }
    return valid;
}

// 每 10 分钟自动清理 24 小时前的过期注册 IP 记录，彻底防止内存泄漏
setInterval(() => {
    const oneDayAgo = Date.now() - 24 * 3600 * 1000;
    for (const [ip, list] of registerIpHistory.entries()) {
        const valid = list.filter(t => t > oneDayAgo);
        if (valid.length === 0) {
            registerIpHistory.delete(ip);
        } else {
            registerIpHistory.set(ip, valid);
        }
    }
}, 10 * 60 * 1000).unref();

function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp.trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    const xReal = req.headers['x-real-ip'];
    if (xReal) return xReal.trim();
    return req.socket ? (req.socket.remoteAddress || '') : '';
}

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach(c => {
            const separator = c.indexOf('=');
            if (separator < 1) return;
            const key = c.slice(0, separator).trim();
            const value = c.slice(separator + 1).trim();
            if (!/^[A-Za-z0-9_-]+$/.test(key)) return;
            try { list[key] = decodeURIComponent(value); } catch (_) {}
        });
    }
    return list;
}

function pruneSessions() {
    const now = Date.now();
    for (const [token, expiry] of adminSessions) if (expiry <= now) adminSessions.delete(token);
    for (const [token, uuid] of userSessions) {
        const user = users.get(uuid);
        if (!user || user.enabled === false || user.expireTime <= now) userSessions.delete(token);
    }
}
setInterval(pruneSessions, 5 * 60 * 1000).unref();

function checkAdminAuth(req) {
    const cookies = parseCookies(req);
    const expiresAt = cookies.admin_token && adminSessions.get(cookies.admin_token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        adminSessions.delete(cookies.admin_token);
        return false;
    }
    return true;
}

function publicSettings() {
        const { argoToken, ...visible } = siteSettings;
    return { ...visible, argoTokenConfigured: Boolean(argoToken) };
}

function cookieOptions(maxAge) {
    // 会话 Cookie 必须为 Secure：本服务对外只应经 HTTPS（Cloudflare / Altare 边缘）暴露，
    // 避免直连 HTTP 时 admin_token / user_token 明文传输被窃取。
    return `Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;
}

function isSameOriginRequest(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        const originHost = parsed.host.toLowerCase().split(':')[0];
        // 只信任两类来源：请求的 Host（浏览器不可伪造），以及服务端已配置的
        // 对外域名（SUB_DOMAIN / ARGO_DOMAIN）。严禁采信 X-Forwarded-Host 等
        // 客户端可任意设置的请求头，否则攻击者可用自洽的 Origin+XFF 绕过同源校验。
        const trusted = new Set();
        const host = req.headers.host;
        if (host) trusted.add(host.toLowerCase().split(':')[0]);
        // 对外域名同时取 settings.json 与 .env（DEFAULT_SETTINGS）：
        // settings.json 可能残留空 subDomain 覆盖 .env，导致反代回源 Host 与
        // Origin 不一致而误杀登录。补入 .env 中的值，避免重启后再次 403。
        for (const c of [siteSettings.subDomain, siteSettings.argoDomain,
                         DEFAULT_SETTINGS.subDomain, DEFAULT_SETTINGS.argoDomain]) {
            if (!c) continue;
            try { trusted.add(new URL(c.includes('://') ? c : 'https://' + c).hostname.toLowerCase()); }
            catch (_) { trusted.add(String(c).toLowerCase().split(':')[0]); }
        }
        return trusted.has(originHost);
    } catch (_) {
        return false;
    }
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
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // 通用 JSON 辅助
    const securityHeaders = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        'Content-Security-Policy': "default-src 'self' data: blob:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        'Cache-Control': 'no-store'
    };
    const sendJson = (data, code = 200) => {
        res.writeHead(code, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    };
    const sendHtml = (html, code = 200) => {
        res.writeHead(code, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    };

    // 读取 POST Body
    const readBody = (callback) => {
        let body = '';
        let size = 0;
        let rejected = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                rejected = true;
                req.pause();
                sendJson({ error: '请求体过大' }, 413);
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            if (rejected || res.writableEnded) return;
            try {
                callback(JSON.parse(body || '{}'));
            } catch (e) {
                sendJson({ error: '无效 JSON 请求' }, 400);
            }
        });
    };


// ========================================================
// 8.1 全能订阅转换与零信任安全脱敏引擎 (Universal Converter SOP)
// ========================================================
function parseVlessUri(uri) {
    try {
        const u = new URL(uri);
        const uuid = u.username;
        const server = u.hostname;
        const port = parseInt(u.port || '443', 10);
        const name = decodeURIComponent(u.hash.replace(/^#/, '')) || `${server}:${port}`;
        const params = u.searchParams;
        const tls = params.get('security') === 'tls';
        const sni = params.get('sni') || params.get('host') || server;
        const host = params.get('host') || sni;
        const path = params.get('path') || '/';
        const type = params.get('type') || 'ws';
        if (u.protocol !== 'vless:' || !/^[a-f0-9-]{36}$/i.test(uuid) || !Number.isInteger(port) || port < 1 || port > 65535 || type !== 'ws') return null;
        const fp = params.get('fp') || siteSettings.clientFingerprint || 'chrome';
        const ech = params.get('ech') || '';
        return { name, uuid, server, port, tls, sni, host, path, type, fp, ech };
    } catch (e) {
        return null;
    }
}

function generateClashConfig(parsedNodes, subName = 'Altare-Tunnel') {
    const validNodes = parsedNodes.filter(n => n !== null);
    const nodeNames = validNodes.map(n => n.name);
    const domain = resolvePublicHost();

    let proxiesYaml = validNodes.map(n => {
        let block = `  - name: "${n.name}"
    type: vless
    server: "${n.server}"
    port: ${n.port}
    uuid: "${n.uuid}"
    cipher: auto
    udp: true
    tls: ${n.tls}
    skip-cert-verify: false
    servername: "${n.sni}"
    network: ws
    ws-opts:
      path: "${n.path}"
      headers:
        Host: "${n.host}"`;
        if (n.tls) {
            block += `
    client-fingerprint: "${n.fp || siteSettings.clientFingerprint || 'chrome'}"`;
            if (siteSettings.enableECH !== false) {
                block += `
    ech-opts:`;
                block += `
      enable: true`;
                block += `
      query-server-name: "${siteSettings.echSni || 'cloudflare-ech.com'}"`;
            }
        }
        return block;
    }).join('\n');

    const ctNames = validNodes.filter(n => n.name.includes('电信')).map(n => `"${n.name}"`);
    const cuNames = validNodes.filter(n => n.name.includes('联通')).map(n => `"${n.name}"`);
    const cmNames = validNodes.filter(n => n.name.includes('移动')).map(n => `"${n.name}"`);
    const directNames = validNodes.filter(n => n.name.includes('直连')).map(n => `"${n.name}"`);

    const quotedAll = nodeNames.map(n => `"${n}"`);

    let groupsYaml = `  - name: "🚀 节点选择"
    type: select
    proxies:
      - "⚡ 自动优选"
      - "🇨🇳 电信优选"
      - "🇨🇳 联通优选"
      - "🇨🇳 移动优选"
      - "🌐 直连优选"
      - DIRECT
      ${quotedAll.map(n => '- ' + n).join('\n      ')}

  - name: "⚡ 自动优选"
    type: url-test
    url: http://cp.cloudflare.com/generate_204
    interval: 300
    tolerance: 50
    proxies:
      ${quotedAll.map(n => '- ' + n).join('\n      ')}

  - name: "🇨🇳 电信优选"
    type: select
    proxies:
      ${(ctNames.length > 0 ? ctNames : quotedAll).map(n => '- ' + n).join('\n      ')}

  - name: "🇨🇳 联通优选"
    type: select
    proxies:
      ${(cuNames.length > 0 ? cuNames : quotedAll).map(n => '- ' + n).join('\n      ')}

  - name: "🇨🇳 移动优选"
    type: select
    proxies:
      ${(cmNames.length > 0 ? cmNames : quotedAll).map(n => '- ' + n).join('\n      ')}

  - name: "🌐 直连优选"
    type: select
    proxies:
      ${(directNames.length > 0 ? directNames : quotedAll).map(n => '- ' + n).join('\n      ')}

  - name: "🐟 漏网之鱼"
    type: select
    proxies:
      - "🚀 节点选择"
      - "⚡ 自动优选"
      - DIRECT`;

    return `# ========================================================
# 🚀 ${subName} Clash / Meta 专属开箱即用订阅配置
# 🛡️ 零信任安全脱敏架构 · ECH 强加密与三网自动测速
# ========================================================
port: 7890
socks-port: 7891
mixed-port: 7890
allow-lan: false
mode: rule
log-level: info
ipv6: false
external-controller: 127.0.0.1:9090

dns:
  enable: true
  listen: 0.0.0.0:1053
  ipv6: false
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  nameserver-policy:
    "${domain}":
      - "${siteSettings.echDns || 'https://dns.alidns.com/dns-query'}"
    "${siteSettings.echSni || 'cloudflare-ech.com'}":
      - "${siteSettings.echDns || 'https://dns.alidns.com/dns-query'}"
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
  - GEOIP,LAN,DIRECT
  - GEOIP,CN,DIRECT
  - GEOSITE,CN,DIRECT
  - MATCH,🚀 节点选择
`;
}

function generateSingboxConfig(parsedNodes, subName = 'Altare-Tunnel', echPem = null) {
    const validNodes = parsedNodes.filter(n => n !== null);
    const nodeTags = validNodes.map(n => n.name);

    const outbounds = [
        {
            type: "selector",
            tag: "🚀 节点选择",
            outbounds: ["⚡ 自动优选", ...nodeTags, "direct"]
        },
        {
            type: "urltest",
            tag: "⚡ 自动优选",
            outbounds: nodeTags,
            url: "http://cp.cloudflare.com/generate_204",
            interval: "3m",
            tolerance: 50
        }
    ];

    validNodes.forEach(n => {
        const tlsConfig = {
            enabled: n.tls,
            server_name: n.sni,
            insecure: false
        };
        if (n.tls) {
            tlsConfig.utls = {
                enabled: true,
                fingerprint: n.fp || siteSettings.clientFingerprint || 'chrome'
            };
            if (siteSettings.enableECH !== false && echPem) {
                tlsConfig.ech = {
                    enabled: true,
                    config: echPem
                };
            }
        }
        outbounds.push({
            type: "vless",
            tag: n.name,
            server: n.server,
            server_port: n.port,
            uuid: n.uuid,
            packet_encoding: "xudp",
            transport: {
                type: "ws",
                path: n.path,
                headers: {
                    Host: n.host
                }
            },
            tls: tlsConfig
        });
    });

    outbounds.push(
        { type: "direct", tag: "direct" },
        { type: "block", tag: "block" },
        { type: "dns", tag: "dns-out" }
    );

    const config = {
        log: { level: "info", timestamp: true },
        dns: {
            servers: [
                { tag: "dns-remote", address: "https://1.1.1.1/dns-query", address_resolver: "dns-local", strategy: "ipv4_only", detour: "🚀 节点选择" },
                { tag: "dns-local", address: "223.5.5.5", detour: "direct", strategy: "ipv4_only" },
                { tag: "dns-block", address: "rcode://success" }
            ],
            rules: [
                { outbound: "any", server: "dns-local" },
                { geosite: "cn", server: "dns-local" },
                { clash_mode: "Global", server: "dns-remote" }
            ],
            strategy: "ipv4_only"
        },
        inbounds: [
            {
                type: "mixed",
                tag: "mixed-in",
                listen: "127.0.0.1",
                listen_port: 2080,
                sniff: true,
                sniff_override_destination: false
            }
        ],
        outbounds: outbounds,
        route: {
            rules: [
                { protocol: "dns", outbound: "dns-out" },
                { ip_is_private: true, outbound: "direct" },
                { geosite: "cn", outbound: "direct" },
                { geoip: "cn", outbound: "direct" },
                { clash_mode: "Direct", outbound: "direct" },
                { clash_mode: "Global", outbound: "🚀 节点选择" }
            ],
            auto_detect_interface: true
        }
    };

    return JSON.stringify(config, null, 2);
}


function generateQuantumultXConfig(parsedNodes, subName = 'Altare-Tunnel') {
    const validNodes = parsedNodes.filter(n => n !== null);

    // QX server_local 规范格式:
    // vless=server:port, method=none, password=uuid, obfs=ws, obfs-host=host, obfs-uri=path, fast-open=false, udp-relay=true, tag=名称, [tls=true, tls-verification=true, tls-host=sni]
    const serverLines = validNodes.map(n => {
        const cleanTag = n.name.replace(/[=,]/g, ' ');
        let line = `vless=${n.server}:${n.port}, method=none, password=${n.uuid}, obfs=ws, obfs-host=${n.host}, obfs-uri=${n.path}, fast-open=false, udp-relay=true, tag=${cleanTag}`;
        if (n.tls) {
            line += `, tls=true, tls-verification=true, tls-host=${n.sni}`;
        }
        return line;
    });

    const tags = validNodes.map(n => n.name.replace(/[=,]/g, ' '));
    const ctTags = validNodes.filter(n => n.name.includes('电信')).map(n => n.name.replace(/[=,]/g, ' '));
    const cuTags = validNodes.filter(n => n.name.includes('联通')).map(n => n.name.replace(/[=,]/g, ' '));
    const cmTags = validNodes.filter(n => n.name.includes('移动')).map(n => n.name.replace(/[=,]/g, ' '));

    const ctPolicy = ctTags.length > 0 ? `static=🇨🇳 电信优选, ${ctTags.join(', ')}, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/ChinaTelecom.png` : '';
    const cuPolicy = cuTags.length > 0 ? `static=🇨🇳 联通优选, ${cuTags.join(', ')}, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/ChinaUnicom.png` : '';
    const cmPolicy = cmTags.length > 0 ? `static=🇨🇳 移动优选, ${cmTags.join(', ')}, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/ChinaMobile.png` : '';

    const allTagsStr = tags.length > 0 ? tags.join(', ') : 'direct';

    return `# ========================================================
# 🚀 ${subName} Quantumult X 专属配置文件
# 🛡️ 零信任安全脱敏架构 · 极速策略分流
# ========================================================

[general]
server_check_url = http://www.gstatic.com/generate_204
dns_exclusion_list = *.cmpassport.com, *.id6.me, *.open.e.189.cn
excluded_routes = 192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8

[dns]
server = 223.5.5.5
server = 119.29.29.29
server = 1.1.1.1

[policy]
static=🚀 节点选择, ⚡ 自动优选${ctTags.length > 0 ? ', 🇨🇳 电信优选' : ''}${cuTags.length > 0 ? ', 🇨🇳 联通优选' : ''}${cmTags.length > 0 ? ', 🇨🇳 移动优选' : ''}, direct, ${allTagsStr}, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Rocket.png
url-latency-benchmark=⚡ 自动优选, ${allTagsStr}, check-interval=300, tolerance=50, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Auto.png
${ctPolicy}
${cuPolicy}
${cmPolicy}
static=🐟 漏网之鱼, 🚀 节点选择, ⚡ 自动优选, direct, img-url=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/Final.png

[server_local]
${serverLines.join('\n')}

[filter_local]
geoip, cn, direct
final, 🚀 节点选择
`.replace(/\n\s*\n\s*\n/g, '\n\n');
}

function generateSurgeConfig(parsedNodes, subName = 'Altare-Tunnel') {
    const validNodes = parsedNodes.filter(n => n !== null);

    const proxyLines = validNodes.map(n => {
        const cleanName = n.name.replace(/[=,]/g, ' ');
        return `${cleanName} = vless, ${n.server}, ${n.port}, username=${n.uuid}, ws=true, ws-path=${n.path}, ws-headers=Host:${n.host}, tls=${n.tls}, sni=${n.sni}, skip-cert-verify=false, udp-relay=true`;
    });

    const cleanNames = validNodes.map(n => n.name.replace(/[=,]/g, ' '));
    const ctNames = validNodes.filter(n => n.name.includes('电信')).map(n => n.name.replace(/[=,]/g, ' '));
    const cuNames = validNodes.filter(n => n.name.includes('联通')).map(n => n.name.replace(/[=,]/g, ' '));
    const cmNames = validNodes.filter(n => n.name.includes('移动')).map(n => n.name.replace(/[=,]/g, ' '));

    const ctGroup = ctNames.length > 0 ? `🇨🇳 电信优选 = url-test, ${ctNames.join(', ')}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50` : '';
    const cuGroup = cuNames.length > 0 ? `🇨🇳 联通优选 = url-test, ${cuNames.join(', ')}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50` : '';
    const cmGroup = cmNames.length > 0 ? `🇨🇳 移动优选 = url-test, ${cmNames.join(', ')}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50` : '';

    const autoAll = cleanNames.length > 0 ? cleanNames.join(', ') : 'DIRECT';

    return `#!MANAGEMENT
# ========================================================
# 🚀 ${subName} Surge 专属托管配置
# 🛡️ 零信任安全脱敏架构 · 极速分流策略
# ========================================================

[General]
loglevel = notify
bypass-system = true
skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local
dns-server = 223.5.5.5, 119.29.29.29, 1.1.1.1
enhanced-mode-by-rule = false
show-error-page-for-reject = true
always-real-ip = *.srv.nintendo.net, *.stun.playstation.net, xbox.*.microsoft.com, *.xboxlive.com

[Proxy]
${proxyLines.join('\n')}

[Proxy Group]
🚀 节点选择 = select, ⚡ 自动优选${ctNames.length > 0 ? ', 🇨🇳 电信优选' : ''}${cuNames.length > 0 ? ', 🇨🇳 联通优选' : ''}${cmNames.length > 0 ? ', 🇨🇳 移动优选' : ''}, DIRECT, ${autoAll}
⚡ 自动优选 = url-test, ${autoAll}, url=http://www.gstatic.com/generate_204, interval=300, tolerance=50
${ctGroup}
${cuGroup}
${cmGroup}
🐟 漏网之鱼 = select, 🚀 节点选择, ⚡ 自动优选, DIRECT

[Rule]
DOMAIN-SUFFIX,local,DIRECT
IP-CIDR,127.0.0.0/8,DIRECT
IP-CIDR,172.16.0.0/12,DIRECT
IP-CIDR,192.168.0.0/16,DIRECT
IP-CIDR,10.0.0.0/8,DIRECT
IP-CIDR,100.64.0.0/10,DIRECT
GEOIP,CN,DIRECT
FINAL,🚀 节点选择,dns-failed
`.replace(/\n\s*\n\s*\n/g, '\n\n');
}

async function convertSubWithZeroTrust(user, target, rawNodes, settings, localEngineFn, echPem = null) {
    const subApi = (settings.subApi || '').trim();
    // 本地原生零外传引擎模式 (物理级内网闭环)
    if (!subApi || subApi === 'local' || !subApi.startsWith('http')) {
        return localEngineFn();
    }

    try {
        const httpLib = subApi.startsWith('https') ? https : http;
        // 1. 零信任虚拟占位脱敏 (铁律：绝不向公网Subconverter发送真实UUID与真实域名)
        const currentTargetHost = resolvePublicHost();
        const maskedNodes = rawNodes.map(uri => {
            return uri
                .replace(user.uuid, '00000000-0000-4000-8000-000000000000')
                .replace(currentTargetHost, 'placeholder.example.com');
        });
        const maskedBase64 = Buffer.from(maskedNodes.join('\n      '), 'utf-8').toString('base64');
        const subConfig = encodeURIComponent(settings.subConfig || 'https://raw.githubusercontent.com/ACL4SSR/ACL4SSR/master/Clash/config/ACL4SSR_Online.ini');
        const sourceUrl = encodeURIComponent(`data:text/plain;base64,${maskedBase64}`);
        const apiUrl = `${subApi}/sub?target=${target}&url=${sourceUrl}&config=${subConfig}&emoji=true&list=false&udp=true&scv=true`;

        // 2. 发起转换 (带 3 秒硬超时熔断保护)
        const converted = await new Promise((resolve, reject) => {
            const req = httpLib.get(apiUrl, { timeout: 3000 }, (res) => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`Subconverter HTTP ${res.statusCode}`));
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve(body));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('Subconverter timeout 3000ms')); });
            req.on('error', reject);
        });

        // 3. 内存原子回填真实凭据
        let restored = converted
            .replace(/00000000-0000-4000-8000-000000000000/g, user.uuid)
            .replace(/example\.com/g, currentTargetHost);

        // 4. 🚀 注入 ECH 与客户端指纹
        if (settings.enableECH !== false) {
            if (target === 'clash') {
                restored = patchClashWithECH(restored, settings.echSni, settings.echDns, settings.clientFingerprint, currentTargetHost);
            } else if (target === 'singbox') {
                restored = patchSingboxWithECH(restored, echPem, settings.clientFingerprint);
            }
        }

        return restored;
    } catch (err) {
        console.warn(`[SubConvert] ⚠️ 外部转换后端不可用 (${err.message})，已自愈降级为本地原生引擎！`);
        return localEngineFn();
    }
}

    // ──────────────── 1. 订阅导出 /sub (全能自适应与零信任脱敏) ────────────────
    if (pathname === '/sub') {
        const token = parsedUrl.query.token || parsedUrl.query.uuid;
        if (!token) return sendJson({ error: '缺少 token 或 uuid 参数' }, 400);
        const user = users.get(token);
        if (!user || !user.enabled || Date.now() > user.expireTime || user.trafficUsed >= user.trafficLimit) {
            return sendJson({ error: '订阅无效、已被封禁或已到期/超额' }, 403);
        }

        const rawNodes = generateUserNodes(user);
        // 用现代转换引擎解析 VLESS URI 为标准节点，并预解析 ECH 查询表达式为 PEM
        let nodes;
        try { nodes = subConverter.parseNodesFromContent(rawNodes.join('\n')); }
        catch (e) { nodes = rawNodes.map(parseVlessUri).filter(Boolean).map(n => ({ ...n, type: 'vless', network: n.type, uuid: n.uuid, tls: n.tls, sni: n.sni, host: n.host, path: n.path, name: n.name, server: n.server, port: n.port })); }
        if (nodes.length && siteSettings.enableECH !== false) {
            try { nodes = await prepareNodesEch(nodes); } catch (e) {}
        }

        const ua = (req.headers['user-agent'] || '').toLowerCase();
        const queryTarget = (parsedUrl.query.target || '').toLowerCase();

        let target = 'base64';
        if (queryTarget === 'loon' || parsedUrl.query.loon !== undefined || ua.includes('loon')) {
            target = 'loon';
        } else if (queryTarget === 'clash' || parsedUrl.query.clash !== undefined || ua.includes('clash') || ua.includes('meta') || ua.includes('mihomo') || ua.includes('stash')) {
            target = 'clash';
        } else if (queryTarget === 'singbox' || queryTarget === 'sb' || parsedUrl.query.singbox !== undefined || parsedUrl.query.sb !== undefined || ua.includes('singbox') || ua.includes('sing-box')) {
            target = 'singbox';
        } else if (queryTarget === 'surge' || parsedUrl.query.surge !== undefined || ua.includes('surge')) {
            target = 'surge';
        } else if (queryTarget === 'qx' || queryTarget === 'quantumultx' || queryTarget === 'quantumult' || parsedUrl.query.qx !== undefined || ua.includes('quantumult')) {
            target = 'quantumultx';
        }

        const commonHeaders = {
            'Profile-Update-Interval': '24',
            'Subscription-Userinfo': `upload=0; download=${user.trafficUsed}; total=${user.trafficLimit}; expire=${Math.floor(user.expireTime / 1000)}`,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Access-Control-Allow-Origin': '*'
        };

        const safeName = encodeURIComponent(user.username || 'user');
        const asciiName = (user.username || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');

        if (target === 'clash') {
            const c = subConverter.generateClashYaml(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'application/x-yaml; charset=utf-8',
                'Content-Disposition': `attachment; filename="clash_${asciiName}.yaml"; filename*=UTF-8''clash_${safeName}.yaml` });
            return res.end(c);
        } else if (target === 'singbox') {
            const c = subConverter.generateSingboxJson(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="singbox_${asciiName}.json"; filename*=UTF-8''singbox_${safeName}.json` });
            return res.end(c);
        } else if (target === 'surge') {
            const c = subConverter.generateSurgeConf(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="surge_${asciiName}.conf"` });
            return res.end(c);
        } else if (target === 'quantumultx') {
            const c = subConverter.generateQuantumultXConfig(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="quantumultx_${asciiName}.conf"` });
            return res.end(c);
        } else if (target === 'loon') {
            const c = subConverter.generateLoonConfig(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="loon_${asciiName}.conf"` });
            return res.end(c);
        } else {
            const base64Data = subConverter.generateBase64(nodes);
            res.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="sub_${asciiName}.txt"; filename*=UTF-8''sub_${safeName}.txt` });
            return res.end(base64Data);
        }
    }

    // ──────────────── 2. 用户注册与登录 API ────────────────
    if (pathname === '/api/register' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        if (siteSettings.allowRegister === false) {
            return sendJson({ error: '当前系统已关闭新用户自主注册' }, 403);
        }

        const clientIp = getClientIp(req) || '127.0.0.1';
        const now = Date.now();
        const cooldownSec = siteSettings.ipRegisterCooldownSec !== undefined ? Number(siteSettings.ipRegisterCooldownSec) : 60;
        const dailyLimit = siteSettings.ipDailyRegisterLimit !== undefined ? Number(siteSettings.ipDailyRegisterLimit) : 3;

        const recentRegistrations = getRecentIpRegistrations(clientIp);

        // 1. 单 IP 24小时注册配额上限检测 (dailyLimit > 0 时生效)
        if (dailyLimit > 0 && recentRegistrations.length >= dailyLimit) {
            const earliestTime = recentRegistrations[0];
            const unlockTime = earliestTime + 24 * 3600 * 1000;
            const remainHours = Math.max(1, Math.ceil((unlockTime - now) / (3600 * 1000)));
            return sendJson({
                error: `防薅保护：同一 IP 24 小时内最多仅允许注册 ${dailyLimit} 个账号，您今日配额已用尽（预计 ${remainHours} 小时后恢复）`
            }, 429);
        }

        // 2. 单 IP 注册冷却间隔检测 (cooldownSec > 0 时生效)
        if (cooldownSec > 0 && recentRegistrations.length > 0) {
            const lastRegTime = recentRegistrations[recentRegistrations.length - 1];
            const cooldownMs = cooldownSec * 1000;
            if (now - lastRegTime < cooldownMs) {
                const remainSec = Math.ceil((cooldownMs - (now - lastRegTime)) / 1000);
                return sendJson({
                    error: `防薅保护：同一 IP 需间隔 ${cooldownSec} 秒才能再次注册，请等待 ${remainSec} 秒后再试`
                }, 429);
            }
        }

        readBody(data => {
            const username = (data.username || '').trim();
            const password = (data.password || '').trim();
            if (!username || username.length < 3 || username.length > 48 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) return sendJson({ error: '用户名需为 3 至 48 位字母、数字、点、下划线或连字符' }, 400);
            if (!password || password.length < 10 || password.length > 256) return sendJson({ error: '密码长度需为 10 至 256 位' }, 400);

            for (const u of users.values()) {
                if (u.username === username) return sendJson({ error: '用户名已被注册' }, 400);
            }

            // 注册成功，记录到该 IP 的 24 小时历史时间线
            const updatedHistory = registerIpHistory.get(clientIp) || [];
            updatedHistory.push(Date.now());
            registerIpHistory.set(clientIp, updatedHistory);

            const uuid = crypto.randomUUID();
            const newUser = {
                uuid,
                username,
                passwordHash: hashPassword(password),
                trafficLimit: siteSettings.defaultTrafficGB * 1024 * 1024 * 1024,
                trafficUsed: 0,
                expireTime: Date.now() + siteSettings.defaultDays * 86400 * 1000,
                enabled: true,
                createdAt: new Date().toISOString()
            };
            users.set(uuid, newUser);
            saveUsers();
            console.log(`[Auth] 🆕 用户注册成功: ${username} (IP: ${clientIp}) | 1分钟防薅锁已生效`);
            const sessionToken = crypto.randomBytes(16).toString('hex');
            userSessions.set(sessionToken, uuid);
            res.setHeader('Set-Cookie', `user_token=${sessionToken}; ${cookieOptions(2592000)}`);
            sendJson({ success: true, message: '注册并登录成功', uuid, user: { username, uuid } });
        });
        return;
    }

    if (pathname === '/api/login' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        const rateKey = `user:${getClientIp(req) || 'unknown'}`;
        if (userLoginLimiter.blocked(rateKey)) return sendJson({ error: '尝试次数过多，请稍后再试' }, 429);
        readBody(data => {
            const username = typeof data.username === 'string' ? data.username.trim() : '';
            const password = typeof data.password === 'string' ? data.password : '';

            for (const u of users.values()) {
                if (u.username === username && u.enabled !== false && u.expireTime > Date.now() && (u.trafficUsed || 0) < (u.trafficLimit || 0) && verifyPassword(password, u.passwordHash)) {
                    if (!String(u.passwordHash).startsWith('pbkdf2$')) {
                        u.passwordHash = hashPassword(password);
                        saveUsers();
                    }
                    userLoginLimiter.clear(rateKey);
                    const sessionToken = crypto.randomBytes(16).toString('hex');
                    userSessions.set(sessionToken, u.uuid);
                    res.setHeader('Set-Cookie', `user_token=${sessionToken}; ${cookieOptions(2592000)}`);
                    return sendJson({ success: true, user: { username: u.username, uuid: u.uuid } });
                }
            }
            userLoginLimiter.fail(rateKey);
            sendJson({ error: '用户名或密码错误' }, 401);
        });
        return;
    }

    if (pathname === '/api/me' && method === 'GET') {
        const cookies = parseCookies(req);
        const uuid = userSessions.get(cookies.user_token);
        const user = uuid && users.get(uuid);
        if (!user || user.enabled === false || user.expireTime <= Date.now()) return sendJson({ user: null }, 401);
        return sendJson({ user: {
            username: user.username,
            uuid: user.uuid,
            trafficUsed: user.trafficUsed || 0,
            trafficLimit: user.trafficLimit || 0,
            expireTime: user.expireTime
        } });
    }

    if (pathname === '/api/logout' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        const cookies = parseCookies(req);
        if (cookies.user_token) userSessions.delete(cookies.user_token);
        res.setHeader('Set-Cookie', `user_token=; ${cookieOptions(0)}`);
        res.writeHead(302, { Location: '/' });
        return res.end();
    }

    // ──────────────── 3. 管理员鉴权 API ────────────────
    if (pathname === '/admin/api/login' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        if (passwordSetupRequired) return sendJson({ error: '请先设置管理员密码' }, 409);
        const rateKey = `admin:${getClientIp(req) || 'unknown'}`;
        if (adminLoginLimiter.blocked(rateKey)) return sendJson({ error: '尝试次数过多，请稍后再试' }, 429);
        readBody(data => {
            const pwd = typeof data.password === 'string' ? data.password : '';
            if (ADMIN_PASSWORD && pwd === ADMIN_PASSWORD) {
                const sToken = crypto.randomBytes(16).toString('hex');
                adminSessions.set(sToken, Date.now() + 8 * 60 * 60 * 1000);
                adminLoginLimiter.clear(rateKey);
                res.setHeader('Set-Cookie', `admin_token=${sToken}; ${cookieOptions(28800)}`);
                return sendJson({ success: true });
            }
            adminLoginLimiter.fail(rateKey);
            sendJson({ error: '管理员密码错误' }, 401);
        });
        return;
    }

    // 仅部署者可以完成首次设置。落盘成功后才启用登录，避免并发请求覆盖密码。
    if (pathname === '/admin/api/setup-password' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        if (!passwordSetupRequired) return sendJson({ error: '管理员密码已设置，无需重复设置' }, 409);
        readBody(data => {
            if (!passwordSetupRequired) return sendJson({ error: '管理员密码已设置，无需重复设置' }, 409);
            const expected = (process.env.ADMIN_SETUP_TOKEN || parseEnvFile(ENV_FILE).ADMIN_SETUP_TOKEN || '').trim();
            if (expected.length < 20) return sendJson({ error: '请先在部署配置中设置至少 20 位的随机初始化口令' }, 503);
            const rateKey = `admin-setup:${getClientIp(req) || 'unknown'}`;
            if (adminLoginLimiter.blocked(rateKey)) return sendJson({ error: '尝试次数过多，请稍后再试' }, 429);
            const supplied = typeof data?.setupToken === 'string' ? data.setupToken.trim() : '';
            const digest = value => crypto.createHash('sha256').update(value).digest();
            if (!crypto.timingSafeEqual(digest(supplied), digest(expected))) {
                adminLoginLimiter.fail(rateKey);
                return sendJson({ error: '初始化口令无效' }, 403);
            }
            const pwd = typeof data.password === 'string' ? data.password.trim() : '';
            const confirm = typeof data.confirm === 'string' ? data.confirm.trim() : '';
            if (pwd.length < 10 || pwd.length > 256 || /[\r\n\0]/.test(pwd)) {
                return sendJson({ error: '密码须为 10 至 256 位，且不能包含换行或空字符' }, 400);
            }
            if (pwd !== confirm) return sendJson({ error: '两次输入的密码不一致' }, 400);
            try {
                updateEnvFile({ ADMIN_PASSWORD: pwd, ADMIN_SETUP_TOKEN: '' });
            } catch (_) {
                return sendJson({ error: '无法保存密码，请检查 .env 写入权限后重试' }, 500);
            }
            ADMIN_PASSWORD = pwd;
            passwordSetupRequired = false;
            adminLoginLimiter.clear(rateKey);
            const sToken = crypto.randomBytes(16).toString('hex');
            adminSessions.set(sToken, Date.now() + 8 * 60 * 60 * 1000);
            res.setHeader('Set-Cookie', `admin_token=${sToken}; ${cookieOptions(28800)}`);
            sendJson({ success: true });
            console.log('[Security] 🔐 管理员首次密码已设置并持久化到 .env');
        });
        return;
    }

    if (pathname === '/admin/logout' && method === 'POST') {
        if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
        const cookies = parseCookies(req);
        if (cookies.admin_token) adminSessions.delete(cookies.admin_token);
        res.setHeader('Set-Cookie', `admin_token=; ${cookieOptions(0)}`);
        res.writeHead(302, { Location: '/admin' });
        return res.end();
    }

    // 管理员 API 保护门禁
    if (pathname.startsWith('/admin/api/')) {
        if (!checkAdminAuth(req)) return sendJson({ error: '未授权访问' }, 401);
        if (pathname === '/admin/api/restart' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
            sendJson({ success: true, message: '核心微服务正在安全自愈重启中，平台守护将即刻载入最新代码...' });
            setTimeout(() => {
                console.log('[Kernel] 🔄 管理员下发重启指令，进程即将退出由翼龙平台守护自动恢复...');
                process.exit(1);
            }, 300);
            return;
        }


        if (pathname === '/admin/api/status') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
                domain: resolvePublicHost(),
                settings: publicSettings(),
                usersCount: users.size
            });
        }

        if (pathname === '/admin/api/sync-wetest' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
            fetchWetestCleanIps().then(result => {
                if (result.success) {
                    sendJson({ success: true, message: '微测网三网 IP 全量更新成功', settings: publicSettings() });
                } else {
                    sendJson({ error: result.error || '同步失败' }, 500);
                }
            });
            return;
        }

        if (pathname === '/admin/api/settings' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
            readBody(data => {
                const envUpdates = {};

                // 1. 密码热修改与回写 .env
                if (typeof data.newAdminPassword === 'string' && data.newAdminPassword.trim()) {
                    ADMIN_PASSWORD = data.newAdminPassword.trim();
                    envUpdates.ADMIN_PASSWORD = ADMIN_PASSWORD;
                    adminSessions.clear();
                    console.log('[Auth] 管理员密码已更改，旧会话已撤销。');
                }

                // 2. 运营配置
                if (data.allowRegister !== undefined) {
                    siteSettings.allowRegister = Boolean(data.allowRegister);
                    envUpdates.DEFAULT_ALLOW_REGISTER = String(siteSettings.allowRegister);
                }
                if (data.defaultDays !== undefined) {
                    siteSettings.defaultDays = parseInt(data.defaultDays, 10);
                    envUpdates.DEFAULT_DAYS = siteSettings.defaultDays;
                }
                if (data.defaultTrafficGB !== undefined) {
                    siteSettings.defaultTrafficGB = parseInt(data.defaultTrafficGB, 10);
                    envUpdates.DEFAULT_TRAFFIC_GB = siteSettings.defaultTrafficGB;
                }
                if (data.ipRegisterCooldownSec !== undefined) {
                    siteSettings.ipRegisterCooldownSec = Math.max(0, parseInt(data.ipRegisterCooldownSec, 10) || 0);
                    envUpdates.IP_REGISTER_COOLDOWN_SEC = siteSettings.ipRegisterCooldownSec;
                }
                                if (data.subApi !== undefined) {
                    siteSettings.subApi = data.subApi.trim();
                    envUpdates.SUBAPI = siteSettings.subApi;
                }
                if (data.subConfig !== undefined) {
                    siteSettings.subConfig = data.subConfig.trim();
                    envUpdates.SUBCONFIG = siteSettings.subConfig;
                }
                if (data.ipDailyRegisterLimit !== undefined) {
                    siteSettings.ipDailyRegisterLimit = Math.max(0, parseInt(data.ipDailyRegisterLimit, 10) || 0);
                    envUpdates.IP_DAILY_REGISTER_LIMIT = siteSettings.ipDailyRegisterLimit;
                }

                // 🚀 ECH 参数接收与回写
                if (data.enableECH !== undefined) {
                    siteSettings.enableECH = Boolean(data.enableECH);
                    envUpdates.ENABLE_ECH = String(siteSettings.enableECH);
                }
                if (data.echSni !== undefined) {
                    siteSettings.echSni = data.echSni.trim() || 'cloudflare-ech.com';
                    envUpdates.ECH_SNI = siteSettings.echSni;
                }
                if (data.echDns !== undefined) {
                    siteSettings.echDns = data.echDns.trim() || 'https://dns.alidns.com/dns-query';
                    envUpdates.ECH_DNS = siteSettings.echDns;
                }
                if (data.clientFingerprint !== undefined) {
                    siteSettings.clientFingerprint = data.clientFingerprint.trim() || 'chrome';
                    envUpdates.CLIENT_FINGERPRINT = siteSettings.clientFingerprint;
                }
                if (data.subDomain !== undefined) {
                    siteSettings.subDomain = data.subDomain.trim();
                    envUpdates.SUB_DOMAIN = siteSettings.subDomain;
                }
                if (data.wetestApiUrl !== undefined) {
                    siteSettings.wetestApiUrl = data.wetestApiUrl.trim();
                    envUpdates.WETEST_API_URL = siteSettings.wetestApiUrl;
                }

                // 3. Cloudflare Argo 隧道配置
                if (typeof data.argoToken === 'string' && data.argoToken.trim()) {
                    const nextToken = data.argoToken.trim();
                    const tokenChanged = nextToken !== siteSettings.argoToken;
                    siteSettings.argoToken = nextToken;
                    envUpdates.ARGO_TOKEN = siteSettings.argoToken;
                    // 后台保存即刻拉起/重载隧道，不依赖 fs.watch（容器里可能不触发）
                    if (tokenChanged) {
                        startArgoTunnel(siteSettings.argoToken);
                        console.log('[Env] ⚡ 后台保存隧道 Token，已直接拉起/重载 cloudflared 进程');
                    }
                }
                if (data.argoDomain !== undefined) {
                    siteSettings.argoDomain = data.argoDomain.trim();
                    envUpdates.ARGO_DOMAIN = siteSettings.argoDomain;
                }

                // 4. 三网优选开关
                if (data.enableOptOfficial !== undefined) siteSettings.enableOptOfficial = Boolean(data.enableOptOfficial);
                if (data.enableCustomDomains !== undefined) siteSettings.enableCustomDomains = Boolean(data.enableCustomDomains);
                if (data.customDomainsText !== undefined) siteSettings.customDomainsText = String(data.customDomainsText).trim();
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
                sendJson({ success: true, message: '系统参数与隧道配置已成功落盘热生效！', settings: publicSettings() });
            });
            return;
        }

        // 用户管理 API: 增、删、改、查、封、解封、重置、续期
        if (pathname === '/admin/api/users') {
            const list = Array.from(users.values()).map(u => ({
                uuid: u.uuid,
                username: u.username,
                trafficUsed: u.trafficUsed || 0,
                trafficLimit: u.trafficLimit || 0,
                trafficUsedStr: formatBytes(u.trafficUsed || 0),
                trafficLimitStr: formatBytes(u.trafficLimit || 0),
                trafficLimitGB: Math.round((u.trafficLimit || 0) / (1024 * 1024 * 1024)),
                trafficUsedMB: Math.round((u.trafficUsed || 0) / (1024 * 1024)),
                expireTime: u.expireTime,
                expireDateStr: new Date(u.expireTime).toLocaleDateString('zh-CN'),
                expireDateISO: new Date(u.expireTime).toISOString().split('T')[0],
                enabled: u.enabled,
                isExpired: Date.now() > u.expireTime,
                isExhausted: (u.trafficUsed || 0) >= (u.trafficLimit || 0),
                onlineConns: (activeConnections.get(u.uuid) || new Set()).size,
                createdAt: u.createdAt || null,
                createdTime: u.createdAt ? new Date(u.createdAt).getTime() : (u.expireTime ? (u.expireTime - 30 * 86400 * 1000) : 0),
                createdDateStr: u.createdAt ? new Date(u.createdAt).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : (u.expireTime ? new Date(u.expireTime - 30 * 86400 * 1000).toLocaleDateString('zh-CN') : '-')
            }));
            return sendJson({ users: list });
        }

        if (pathname === '/admin/api/user/add' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
            readBody(data => {
                const username = (data.username || '').trim();
                if (!username) return sendJson({ error: '用户名不能为空' }, 400);
                // 与自助注册保持一致的字符白名单，防止 HTML/属性注入
                if (!/^[\p{L}\p{N}_.-]{3,48}$/u.test(username)) return sendJson({ error: '用户名需为 3 至 48 位字母、数字、点、下划线或连字符' }, 400);
                for (const u of users.values()) {
                    if (u.username === username) return sendJson({ error: '该用户名已存在' }, 400);
                }
                const rawUuid = data.uuid && data.uuid.trim() ? data.uuid.trim() : '';
                // 自定义 UUID 仅允许 URL 安全字符，杜绝 < > " 等注入字符
                if (rawUuid && !/^[A-Za-z0-9_-]{10,64}$/.test(rawUuid)) return sendJson({ error: 'UUID 只能包含字母、数字、下划线或连字符（10-64 位）' }, 400);
                const uuid = (rawUuid && rawUuid.length >= 32) ? rawUuid : crypto.randomUUID();
                if (users.has(uuid)) return sendJson({ error: '该 UUID 已存在冲突' }, 400);
                const pwd = typeof data.password === 'string' && data.password.length >= 10 ? data.password : crypto.randomBytes(18).toString('base64url');
                const days = parseInt(data.days || siteSettings.defaultDays, 10);
                const trafficGB = parseInt(data.trafficGB || siteSettings.defaultTrafficGB, 10);

                const newUser = {
                    uuid,
                    username,
                    passwordHash: hashPassword(pwd),
                    trafficLimit: trafficGB * 1024 * 1024 * 1024,
                    trafficUsed: 0,
                    expireTime: Date.now() + days * 86400 * 1000,
                    enabled: true,
                    createdAt: new Date().toISOString()
                };
                users.set(uuid, newUser);
                saveUsers();
                console.log(`[Users] ➕ 管理员新增用户: ${username} (${uuid}) | 0ms即刻连接`);
                sendJson({ success: true, message: '用户添加成功', user: safeUser(newUser), temporaryPassword: data.password ? undefined : pwd });
            });
            return;
        }

        if (pathname === '/admin/api/user/update' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
            readBody(data => {
                const originalUuid = (data.originalUuid || '').trim();
                const user = users.get(originalUuid);
                if (!user) return sendJson({ error: '目标用户不存在' }, 404);

                let targetUuid = originalUuid;
                // 1. 修改 UUID
                if (data.newUuid && data.newUuid.trim() && data.newUuid.trim() !== originalUuid) {
                    const candidate = data.newUuid.trim();
                    if (!/^[A-Za-z0-9_-]{10,64}$/.test(candidate)) return sendJson({ error: 'UUID 只能包含字母、数字、下划线或连字符（10-64 位）' }, 400);
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
                    if (!/^[\p{L}\p{N}_.-]{3,48}$/u.test(newName)) return sendJson({ error: '用户名需为 3 至 48 位字母、数字、点、下划线或连字符' }, 400);
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
                    if (data.newPassword.trim().length < 10 || data.newPassword.trim().length > 256) return sendJson({ error: '新密码长度需为 10 至 256 位' }, 400);
                    user.passwordHash = hashPassword(data.newPassword.trim());
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
                sendJson({ success: true, message: '用户信息已成功保存！', user: safeUser(user) });
            });
            return;
        }

        if (pathname === '/admin/api/user/toggle-ban' && method === 'POST') {
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
            if (!isSameOriginRequest(req)) return sendJson({ error: '请求来源无效' }, 403);
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
            return sendHtml(renderAdminLoginPage(passwordSetupRequired));
        }
        return sendHtml(renderAdminDashboardPage());
    }

    // ──────────────── 5. 首页 HTML 渲染 (微测网风格三网大屏) ────────────────
    const cookies = parseCookies(req);
    let currentUser = null;
    if (cookies.user_token && userSessions.has(cookies.user_token)) {
        currentUser = users.get(userSessions.get(cookies.user_token));
        if (!currentUser || currentUser.enabled === false || currentUser.expireTime <= Date.now() || currentUser.trafficUsed >= currentUser.trafficLimit) {
            userSessions.delete(cookies.user_token);
            currentUser = null;
        }
    }
    return sendHtml(renderHomepage(currentUser));
});

// ==========================================
// 11. WebSocket Upgrade 监听处理
// ==========================================
server.on('upgrade', (req, socket, head) => {
    const secKey = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const connection = String(req.headers.connection || '').toLowerCase();
    if (!secKey || upgrade !== 'websocket' || !connection.split(',').map(value => value.trim()).includes('upgrade') || req.headers['sec-websocket-version'] !== '13') {
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
    const subUrl = currentUser ? `/sub?token=${encodeURIComponent(currentUser.uuid)}` : '';
    const trafficPercent = currentUser ? Math.min(100, Math.round((currentUser.trafficUsed / currentUser.trafficLimit) * 100)) : 0;
    const daysLeft = currentUser ? Math.max(0, Math.ceil((currentUser.expireTime - Date.now()) / (86400 * 1000))) : 0;
    const isArgoActive = !!siteSettings.argoDomain;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>${escapeHtml(machineTag())} · Altare Tunnel</title>
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
            font-size: clamp(0.95rem, 0.9rem + 0.2vw, 1.05rem);
            padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
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
            min-height: 44px;
            padding: 8px 16px;
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
        .btn-sm { min-height: 44px; padding: 6px 12px; font-size: 12px; }
        .toast-stack { position: fixed; right: 18px; bottom: 18px; bottom: calc(18px + env(safe-area-inset-bottom)); z-index: 3000; display: grid; gap: 8px; width: min(360px, calc(100vw - 36px)); }
        .toast { background: #0f172a; color: #f8fafc; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 12px 14px; box-shadow: 0 12px 30px rgba(15,23,42,.18); font-size: 13px; }
        .toast.error { background: #7f1d1d; }
        .toast.success { background: #065f46; }

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

        /* 移动端深度自适应适配 (iPhone / Android / 平板) */
        @media (max-width: 768px) {
            .container { padding: 12px 10px 30px; }
            header.top-nav {
                flex-direction: column;
                align-items: stretch;
                padding: 12px 14px;
                gap: 12px;
            }
            .nav-brand { justify-content: flex-start; }
            .nav-right {
                justify-content: space-between;
                width: 100%;
                border-top: 1px dashed var(--border);
                padding-top: 10px;
            }
            .kpi-row {
                grid-template-columns: 1fr 1fr;
                gap: 10px;
            }
            .kpi-card { padding: 12px 14px; }
            .kpi-metric { font-size: 16px; }
            .kpi-icon-box { width: 36px; height: 36px; font-size: 16px; }
            .user-console-card { padding: 16px 14px; }
            .sub-input-row { flex-direction: column; align-items: stretch; }
            .sub-url-field { width: 100%; min-width: auto; }
            .sub-input-row .btn { width: 100%; height: 36px; }
            .section-panel { padding: 16px 12px; }
            .table-wrap {
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
            }
            .table-wrap table {
                min-width: 540px;
            }
            .modal-dialog {
                width: 95%;
                padding: 18px 16px;
            }
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
                    <h1>Altare Tunnel · ${escapeHtml(machineTag())}</h1>
                    <p>三网节点与订阅控制台</p>
                </div>
            </div>
            <div class="nav-right">
                ${currentUser ? `
                    <span style="font-size:13px; color:var(--text-sub);">👤 <strong>${currentUser.username}</strong></span>
                    <button type="button" class="btn btn-sm" onclick="logoutUser()">退出登录</button>
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
                    <div class="kpi-hint">规格 512MB (占用约 8%)</div>
                </div>
                <div class="kpi-icon-box" style="background:#f0fdf4; color:#16a34a;">🧠</div>
            </div>
        </div>

        <!-- 用户登录后控制台 -->
        <section id="accountPanel" class="user-console-card" hidden>
            <div class="user-console-header"><div class="user-welcome">个人通道 <strong id="accountName"></strong></div><div class="user-expire-tag">到期：<strong id="accountExpiry">-</strong></div></div>
            <div class="account-usage"><span id="accountTraffic">流量：-</span><span id="accountPercent">0%</span></div>
            <div class="traffic-progress-bar"><div id="accountProgress" class="traffic-progress-fill" style="width:0%"></div></div>
            <label for="subUrlInput">订阅地址</label>
            <div class="sub-input-row" style="margin-bottom:8px;">
                <input type="text" id="subUrlInput" readonly value="" onclick="this.select()" title="点击即可全选复制" class="sub-url-field" />
                <button class="btn btn-sm btn-primary" onclick="copySubUrlUniversal('')">复制通用订阅</button>
                <button class="btn btn-sm" onclick="showNodeModal()">节点明文</button>
            </div>
            <div class="client-actions">
                <button class="btn btn-sm" onclick="copySubUrlUniversal('&target=clash')">Clash</button>
                <button class="btn btn-sm" onclick="copySubUrlUniversal('&target=singbox')">sing-box</button>
                <button class="btn btn-sm" onclick="copySubUrlUniversal('&target=surge')">Surge</button>
                <button class="btn btn-sm" onclick="copySubUrlUniversal('&target=qx')">Quantumult X</button>
                <button class="btn btn-sm" onclick="oneClickImportClash()">导入 Clash</button>
                <button class="btn btn-sm" onclick="oneClickImportSurge()">导入 Surge</button>
                <button class="btn btn-sm" onclick="oneClickImportQX()">导入 QX</button>
            </div>
        </section>
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
            <p>Altare-Tunnel 纯原生 Node.js VLESS 极速中枢 · 512MB RAM 轻量规格专享</p>
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
        function showToast(message, kind = '') {
            let stack = document.getElementById('toastStack');
            if (!stack) { stack = document.createElement('div'); stack.id = 'toastStack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
            const item = document.createElement('div'); item.className = 'toast ' + kind; item.textContent = message; stack.appendChild(item);
            setTimeout(() => item.remove(), 4200);
        }
        async function logoutUser() {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
            location.reload();
        }
        function confirmAction(message) {
            return new Promise(resolve => {
                const mask = document.createElement('div');
                mask.className = 'modal-mask';
                mask.style.display = 'flex';
                const card = document.createElement('section');
                card.className = 'modal-dialog';
                const text = document.createElement('p'); text.textContent = message;
                const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:20px';
                const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = '取消';
                const accept = document.createElement('button'); accept.className = 'btn btn-primary'; accept.textContent = '确认';
                const finish = value => { mask.remove(); resolve(value); };
                cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
                mask.onclick = event => { if (event.target === mask) finish(false); };
                actions.append(cancel, accept); card.append(text, actions); mask.append(card); document.body.append(mask); accept.focus();
            });
        }
        function openModal(id) {
            document.getElementById(id).style.display = 'flex';
            if (id === 'loginModal') document.getElementById('loginUser').focus();
            if (id === 'regModal') document.getElementById('regUser').focus();
        }
        function closeModal(id) { document.getElementById(id).style.display = 'none'; }

        function formatBytes(value) {
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let size = Math.max(0, Number(value) || 0), index = 0;
            while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
            return size.toFixed(index ? 2 : 0) + ' ' + units[index];
        }
        async function refreshAccount() {
            const panel = document.getElementById('accountPanel');
            try {
                const response = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
                if (!response.ok) { panel.hidden = true; return; }
                const { user } = await response.json();
                if (!user) { panel.hidden = true; return; }
                panel.hidden = false;
                document.getElementById('accountName').textContent = user.username;
                document.getElementById('accountExpiry').textContent = new Date(user.expireTime).toLocaleDateString();
                const used = Number(user.trafficUsed) || 0, limit = Number(user.trafficLimit) || 0;
                const percent = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
                document.getElementById('accountTraffic').textContent = formatBytes(used) + ' / ' + formatBytes(limit);
                document.getElementById('accountPercent').textContent = percent + '%';
                document.getElementById('accountProgress').style.width = percent + '%';
                document.getElementById('subUrlInput').value = location.origin + '/sub?token=' + encodeURIComponent(user.uuid);
            } catch (_) { showToast('账户状态暂时无法刷新', 'error'); }
        }

        async function doLogin() {
            const u = document.getElementById('loginUser').value.trim();
            const p = document.getElementById('loginPwd').value.trim();
            const btn = document.getElementById('btnLoginSubmit');
            if (!u || !p) return showToast('请输入用户名和密码', 'error');
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
                    showToast('登录失败：' + (d.error || '账号或密码不正确'), 'error');
                }
            } catch(e) {
                showToast('网络连接错误，请重试', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = '登 录';
            }
        }

        async function doRegister() {
            const u = document.getElementById('regUser').value.trim();
            const p = document.getElementById('regPwd').value.trim();
            const btn = document.getElementById('btnRegSubmit');
            if (!u || !p) return showToast('请完整填写用户名与密码', 'error');
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
                    showToast('注册成功，正在进入专属通道', 'success');
                    location.reload();
                } else {
                    showToast('注册失败：' + (d.error || '未知错误'), 'error');
                }
            } catch(e) {
                showToast('网络错误，请重试', 'error');
            } finally {
                btn.disabled = false;
                btn.innerText = '立即注册';
            }
        }

        function copyTextUniversal(text, successMsg = '已复制') {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => showToast(successMsg, 'success')).catch(() => showToast('复制失败，请检查浏览器剪贴板权限', 'error'));
            } else {
                showToast('浏览器不支持剪贴板，请手动选中订阅地址', 'error');
            }
        }

        function copySubUrlUniversal(extra = '') {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) {
                fullUrl = window.location.origin + fullUrl;
            }
            if (extra) {
                fullUrl += extra;
            }
            copyTextUniversal(fullUrl, '✅ 专属订阅链接已成功复制！可直接导入客户端使用。');
        }

        function oneClickImportClash() {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) fullUrl = window.location.origin + fullUrl;
            const clashUrl = fullUrl + '&target=clash';
            window.location.href = 'clash://install-config?url=' + encodeURIComponent(clashUrl);
        }

        function oneClickImportSurge() {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) fullUrl = window.location.origin + fullUrl;
            const surgeUrl = fullUrl + '&target=surge';
            window.location.href = 'surge:///install-config?url=' + encodeURIComponent(surgeUrl);
        }

        function oneClickImportQX() {
            const el = document.getElementById('subUrlInput');
            if (!el) return;
            let fullUrl = el.value;
            if (fullUrl.startsWith('/')) fullUrl = window.location.origin + fullUrl;
            const qxUrl = fullUrl + '&target=qx';
            window.location.href = 'quantumult-x:///update-configuration?remote-resource=' + encodeURIComponent(qxUrl);
        }


        function copyDecodedLink(encLink) {
            try {
                const link = decodeURIComponent(encLink);
                copyTextUniversal(link, '✅ 该节点直连链接已成功复制到剪贴板！');
            } catch(e) {
                copyTextUniversal(encLink, '✅ 该节点直连链接已成功复制！');
            }
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
                // 确保拉取通用 Base64 或明文
                const fetchUrl = fullUrl.includes('?') ? (fullUrl + '&b64=1') : (fullUrl + '?b64=1');
                const res = await fetch(fetchUrl);
                const txt = await res.text();
                let rawTxt = txt.trim();

                // 智能 Base64 解码：若返回是 Base64 编码，自动还原为换行明文
                if (rawTxt.indexOf('vless://') === -1) {
                    try {
                        rawTxt = atob(rawTxt);
                    } catch(e) {
                        try {
                            rawTxt = decodeURIComponent(escape(atob(rawTxt)));
                        } catch(e2) {}
                    }
                }

                // 安全按换行符拆分节点 (使用 String.fromCharCode 彻底消除正则断行语法错误)
                const lf = String.fromCharCode(10);
                const cr = String.fromCharCode(13);
                const lines = rawTxt.split(lf).map(function(l) {
                    return l.replace(cr, '').trim();
                }).filter(function(l) {
                    return l.indexOf('vless://') === 0;
                });
                if (lines.length === 0) {
                    cont.innerHTML = '<div style="text-align:center; padding:16px; color:#dc2626;">未解析到节点配置，请检查账号状态</div>';
                    return;
                }

                cont.innerHTML = lines.map(function(link, idx) {
                    let label = '节点 #' + (idx + 1);
                    const hashIdx = link.indexOf('#');
                    if (hashIdx !== -1) {
                        try { label = decodeURIComponent(link.substring(hashIdx + 1)); } catch(e){}
                    }
                    const encLink = encodeURIComponent(link);
                    return '<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:10px;">' +
                        '<div style="flex:1; min-width:0;">' +
                            '<div style="font-weight:700; color:#0f172a; font-size:12px; margin-bottom:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + label + '</div>' +
                            '<div style="font-family:Consolas, monospace; font-size:11px; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + link + '</div>' +
                        '</div>' +
                        '<button class="btn btn-sm btn-primary" data-link="' + encLink + '" onclick="copyDecodedLink(this.dataset.link)">复制</button>' +
                    '</div>';
                }).join('');
            } catch(e) {
                cont.innerHTML = '<div style="color:#dc2626; padding:16px; text-align:center;">获取节点失败: ' + (e.message || '网络异常') + '</div>';
            }
        }

        window.addEventListener('load', () => {
            refreshAccount();
            setInterval(refreshAccount, 60000);
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
        return `<tr><td colspan="4" style="text-align:center; padding:16px; color:#94a3b8;">微测网动态抓取中...</td></tr>`;
    }
    return list.map((item, idx) => {
        const isOverride = idx === 0 && overrideIp && overrideIp !== item.ip;
        const displayIp = isOverride ? overrideIp : item.ip;
        return `<tr>
            <td>
                <strong style="font-family:Consolas, monospace; font-size:13px; color:#0f172a;">${displayIp}</strong>
                ${isOverride ? '<span style="font-size:10px; color:#d97706; background:#fffbeb; padding:1px 5px; border-radius:3px; border:1px solid #fde68a; margin-left:4px;">首选覆盖</span>' : ''}
            </td>
            <td>
                <span style="font-weight:700; color:#2563eb; background:#eff6ff; padding:2px 8px; border-radius:4px; border:1px solid #dbeafe; font-family:Consolas, monospace;">${item.colo || 'HKG'}</span>
            </td>
            <td>
                <span class="rtt-pill">${item.rtt ? item.rtt + ' ms' : '--'}</span>
            </td>
            <td>
                <div style="display:flex; align-items:center; gap:8px;">
                    <span class="badge-carrier ${badgeClass}">${carrierName}</span>
                    <span style="color:#16a34a; font-weight:600; font-size:12px;">🟢 畅通直连</span>
                    <span style="font-size:11px; color:#64748b;">(第 ${idx + 1} 优选)</span>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ──────────────── 管理后台页面渲染 ────────────────
// ──────────────── 管理后台页面渲染 ────────────────
function renderAdminLoginPage(setupMode = false) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(machineTag())} · Altare-Tunnel 登录</title>
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
            <div class="brand-title">Altare-Tunnel 运维控制台</div>
            <div class="brand-desc">512MB 原生轻核 · 0依赖高性能隧道</div>
        </div>

        <div id="errMsg" class="error-alert"></div>

        ${setupMode ? `
        <form id="adminLoginForm" onsubmit="event.preventDefault(); doSetupPassword();">
            <div class="form-group">
                <label class="form-label" for="setupToken">初始化口令</label>
                <input type="password" id="setupToken" class="input-control" autocomplete="off" required />
            </div>
            <div class="form-group">
                <label class="form-label" for="pwd">首次设置管理员密码</label>
                <input type="password" id="pwd" class="input-control" placeholder="设置管理员密码" autocomplete="new-password" minlength="10" maxlength="256" required />
            </div>
            <div class="form-group">
                <label class="form-label" for="pwd2">确认管理员密码</label>
                <input type="password" id="pwd2" class="input-control" placeholder="再次输入密码" autocomplete="new-password" />
            </div>
            <button type="submit" id="btnSubmit" class="submit-btn">设置密码并进入</button>
        </form>
        <div class="card-footer"><span>输入部署时配置的初始化口令。设置成功后即可进入后台。</span></div>
        ` : `
        <form id="adminLoginForm" onsubmit="event.preventDefault(); doAdminLogin();">
            <div class="form-group">
                <label class="form-label" for="pwd">管理员认证密钥 (ADMIN_PASSWORD)</label>
                <input type="password" id="pwd" class="input-control" placeholder="请输入管理员登录密码并回车" autofocus autocomplete="current-password" onkeydown="if(event.key==='Enter'||event.keyCode===13){event.preventDefault();doAdminLogin();}" />
            </div>
            <button type="submit" id="btnSubmit" class="submit-btn">登 录 控 制 台</button>
        </form>
        <div class="card-footer"><span>翼龙面板单端口专享 · 敲击回车直接登录</span></div>
        `}
    </div>

    <script>
        const SETUP_MODE = ${setupMode};
        async function doSetupPassword() {
            const p = document.getElementById('pwd');
            const p2 = document.getElementById('pwd2');
            const errDiv = document.getElementById('errMsg');
            const btn = document.getElementById('btnSubmit');
            const setupToken = document.getElementById('setupToken').value.trim();
            const pwd = p.value.trim(), confirm = p2.value.trim();
            if (!pwd) {
                errDiv.style.display = 'flex'; errDiv.innerText = '⚠️ 请输入密码'; p.focus(); return;
            }
            if (pwd !== confirm) {
                errDiv.style.display = 'flex'; errDiv.innerText = '⚠️ 两次密码不一致'; p2.select(); return;
            }
            errDiv.style.display = 'none'; btn.disabled = true; btn.innerText = '正在设置...';
            try {
                const res = await fetch('/admin/api/setup-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ setupToken, password: pwd, confirm })
                });
                const data = await res.json();
                if (res.ok) { location.href = '/admin'; }
                else { errDiv.style.display = 'flex'; errDiv.innerText = '❌ ' + (data.error || '设置失败'); }
            } catch (e) {
                errDiv.style.display = 'flex'; errDiv.innerText = '❌ 网络异常';
            } finally { btn.disabled = false; btn.innerText = '设置密码并进入'; }
        }

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
                        if (SETUP_MODE) doSetupPassword(); else doAdminLogin();
                    }
                });
            }
            const pwd2 = document.getElementById('pwd2');
            if (pwd2) pwd2.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); doSetupPassword(); }
            });
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
    <title>${escapeHtml(machineTag())} · Altare-Tunnel 后台</title>
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
            min-height: 44px;
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
        .toast-stack { position: fixed; right: 18px; bottom: 18px; bottom: calc(18px + env(safe-area-inset-bottom)); z-index: 3000; display: grid; gap: 8px; width: min(360px, calc(100vw - 36px)); }
        .toast { background: #18181b; color: #f4f4f5; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 12px 14px; box-shadow: 0 12px 30px rgba(15,23,42,.18); }
        .toast.error { background: #7f1d1d; }
        .toast.success { background: #065f46; }
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
        th.sortable {
            cursor: pointer;
            user-select: none;
            transition: all 0.2s ease;
        }
        .mobile-clickable-cell {
            cursor: pointer;
            padding: 3px 5px;
            border-radius: 4px;
            transition: all 0.15s ease;
        }
        .mobile-clickable-cell:hover {
            background: #eff6ff;
        }
        .mobile-sub-tag {
            display: none;
        }
        th.sortable:hover {
            background-color: #f1f5f9;
            color: var(--primary);
        }
        .sort-icon {
            display: inline-block;
            margin-left: 3px;
            font-size: 11px;
            opacity: 0.75;
        }

        /* 现代化 Element UI 风格分页器 */
        .pagination-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            border-top: 1px solid var(--border-color);
            background: #ffffff;
            flex-wrap: wrap;
            gap: 10px;
        }
        .page-btn {
            min-width: 30px;
            height: 30px;
            padding: 0 8px;
            font-size: 12px;
            font-weight: 500;
            border: 1px solid var(--border-color);
            background: #ffffff;
            color: var(--text-main);
            border-radius: 4px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s ease-in-out;
            user-select: none;
        }
        .page-btn:hover:not(:disabled) {
            color: var(--primary);
            border-color: var(--primary);
            background: var(--primary-light);
        }
        .page-btn.active {
            background: var(--primary);
            color: #ffffff;
            border-color: var(--primary);
            font-weight: 600;
        }
        .page-btn:disabled {
            color: #cbd5e1;
            background: #f8fafc;
            border-color: #e2e8f0;
            cursor: not-allowed;
        }
        .page-ellipsis {
            padding: 0 4px;
            color: #94a3b8;
            font-size: 12px;
            user-select: none;
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
        .form-row input, .form-row select, .form-row textarea, .search-box input { font-size: 16px; min-height: 44px; }
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
            gap: 8px;
            background: #ffffff;
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            padding: 8px 12px;
            min-height: 44px;
            box-sizing: border-box;
        }
        .search-box input {
            border: none;
            outline: none;
            font-size: 14px;
            width: 100%;
            min-width: 0;
            min-height: auto !important;
            background: transparent;
        }

        /* 移动端深度自适应适配 (Element Plus Pro 移动端规范) */
        @media (max-width: 768px) {
            body {
                flex-direction: column;
            }
            aside.sidebar {
                width: 100%;
                min-height: auto;
                border-right: none;
                border-bottom: 1px solid #1e293b;
            }
            .sidebar-brand {
                height: 48px;
                padding: 0 14px;
            }
            .sidebar-menu {
                flex-direction: row;
                overflow-x: hidden;
                padding: 6px 8px;
                gap: 4px;
                display: flex;
                width: 100%;
            }
            .menu-item {
                padding: 6px 4px;
                font-size: 11px;
                white-space: nowrap;
                flex: 1 1 0;
                min-width: 0;
                text-align: center;
                justify-content: center;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .menu-item#menu_status { display: none; } /* 手机端隐藏第4个探针tab，图2只显示3个 */
            .sidebar-footer { display: none; }
            header.top-header {
                height: 48px;
                padding: 0 14px;
            }
            .header-title-box { display: none !important; }
            .header-actions { width: 100%; }
            .header-actions .btn { flex: 1; }
            .content-container {
                padding: 12px 10px;
            }
            .kpi-grid {
                grid-template-columns: 1fr 1fr;
                gap: 10px;
            }
            .kpi-card { padding: 12px 14px; }
            .kpi-val { font-size: 17px; }
            .kpi-icon-wrap { width: 36px; height: 36px; font-size: 16px; }
            .card-panel { padding: 14px 12px; }
            .panel-header {
                flex-direction: column;
                align-items: stretch;
                gap: 10px;
            }
            .search-box { width: 100%; }
            .search-box input { width: 100%; }
            .table-wrap {
                overflow-x: hidden !important;
            }
            .table-wrap table {
                min-width: 100% !important;
                width: 100% !important;
                table-layout: fixed;
            }
            .table-wrap th, .table-wrap td {
                padding: 8px 6px !important;
            }
            /* 手机端隐藏冗余列：UUID、注册时间、到期时间、状态标签、桌面操作按钮 */
            .col-desktop {
                display: none !important;
            }
            /* 手机端 3 列专属自适应比例 */
            .col-mobile-user {
                width: 44% !important;
            }
            .col-mobile-traffic {
                width: 38% !important;
            }
            .col-mobile-online {
                width: 18% !important;
                text-align: center !important;
            }
            .mobile-clickable-cell {
                cursor: pointer;
                border-radius: 4px;
                padding: 4px 6px;
                background: #f8fafc;
                border: 1px dashed #cbd5e1;
                transition: background 0.15s ease;
            }
            .mobile-clickable-cell:active {
                background: #e2e8f0;
            }
            .mobile-sub-tag {
                display: block !important;
                font-size: 10px;
                color: #64748b;
                margin-top: 2px;
            }
            .panel-toolbar {
                display: flex;
                flex-direction: column;
                gap: 8px;
                width: 100%;
            }
            .panel-toolbar .search-box,
            .panel-toolbar select {
                width: 100% !important;
                box-sizing: border-box;
            }
            .panel-toolbar-btns {
                display: flex;
                gap: 8px;
                width: 100%;
            }
            .panel-toolbar-btns .btn {
                flex: 1;
                justify-content: center;
            }
            .modal-card {
                width: 95%;
                max-width: 440px;
                max-height: 88vh;
                overflow-y: auto;
                padding: 16px 14px;
            }
            body { padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
            aside.sidebar { position: sticky; top: 0; z-index: 120; }
            .sidebar-menu { padding-bottom: max(6px, env(safe-area-inset-bottom)); }
            .top-header { gap: 8px; }
            .header-actions { gap: 6px; }
            .header-actions .status-badge { display: none; }
            .header-actions .btn { min-height: 44px; padding: 6px 9px; }
            .table-wrap:not(.user-list-wrap) { overflow: visible; border: 0; }
            .table-wrap:not(.user-list-wrap) table, .table-wrap:not(.user-list-wrap) tbody, .table-wrap:not(.user-list-wrap) tr, .table-wrap:not(.user-list-wrap) td { display: block; width: 100%; }
            .table-wrap:not(.user-list-wrap) thead { display: none; }
            .table-wrap:not(.user-list-wrap) tbody { display: grid; gap: 10px; }
            .table-wrap:not(.user-list-wrap) tbody tr { border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); padding: 8px; }
            .table-wrap:not(.user-list-wrap) tbody td { border: 0; padding: 8px 6px !important; }
            .table-wrap:not(.user-list-wrap) tbody td.col-desktop { display: block !important; }
            .table-wrap:not(.user-list-wrap) tbody td:nth-child(2)::before { content: 'UUID'; display: block; color: #64748b; font-size: 11px; margin-bottom: 5px; }
            .table-wrap:not(.user-list-wrap) tbody td:nth-child(4)::before { content: '注册时间'; display: block; color: #64748b; font-size: 11px; margin-bottom: 4px; }
            .table-wrap:not(.user-list-wrap) tbody td:nth-child(5)::before { content: '到期时间'; display: block; color: #64748b; font-size: 11px; margin-bottom: 4px; }
            .table-wrap:not(.user-list-wrap) tbody td:last-child > div { flex-wrap: wrap !important; }
            .table-wrap tbody td:last-child .btn { min-height: 44px; }
            .pagination-bar { align-items: stretch; }
            .pagination-controls { flex-wrap: wrap; }
            input, select, textarea { font-size: 16px !important; }
        }
</style>
</head>
<body>
    <style>
        .user-sort-bar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 0 12px; color:#64748b; font-size:13px; }
        .user-sort-bar .btn { min-height:44px; border-radius:8px; background:transparent; }
        .users-empty { text-align:center; padding:24px; color:#64748b; }
        @media(max-width:768px) {
            .user-list-wrap .pagination-controls { gap:4px !important; }
        }
    </style>
    <div id="toastStack" class="toast-stack" aria-live="polite" aria-atomic="false"></div>
    <!-- 左侧侧边栏导航 -->
    <aside class="sidebar">
        <div class="sidebar-brand">
            <div class="brand-logo">🛡️</div>
            <div class="brand-name">Altare-Tunnel</div>
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
            <div style="color:#e2e8f0; font-weight:600;">Altare 512MB 轻量中枢</div>
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
                <button class="btn btn-sm" onclick="restartCoreService()" style="background:#eff6ff; color:#2563eb; border-color:#bfdbfe;" title="平滑重启 Node 微服务以应用全新配置">🔄 重启核心</button>
                <a href="/" target="_blank" class="btn btn-sm">🌐 前台微测网 ↗</a>
                <button type="button" class="btn btn-sm btn-danger" onclick="logoutAdmin()">退出登录</button>
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
                        <div class="kpi-sub">占 512MB 限额约 8%~10%</div>
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
                    <div class="panel-toolbar" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <div class="search-box" style="position:relative; display:flex; align-items:center; min-width:220px;">
                            <span>🔍</span>
                            <input type="text" id="userSearchInput" placeholder="输入用户名或 UUID 实时搜索..." oninput="filterUsers()" style="padding-right:24px;" />
                            <span id="clearUserSearchBtn" onclick="clearUserSearch()" style="position:absolute; right:8px; cursor:pointer; color:#94a3b8; font-size:12px; display:none;" title="清空搜索">✕</span>
                        </div>
                        <div class="panel-toolbar-btns">
                            <button class="btn btn-primary" onclick="openAddUserModal()">➕ 添加新用户</button>
                            <button class="btn" onclick="fetchUsers()">🔄 刷新</button>
                        </div>
                    </div>
                </div>

                <div class="table-wrap user-list-wrap">
                    <table class="compact-user-table">
                        <thead>
                            <tr>
                                <th class="col-mobile-user" style="width:120px;">账号名称</th>
                                <th class="col-desktop" style="width:240px;">专属连接 UUID (点击复制)</th>
                                <th class="col-mobile-traffic sortable" style="width:150px;" onclick="toggleUserSort('trafficUsed')" id="th_sort_trafficUsed" title="点击切换流量使用正序/降序">已用流量 <span class="sort-icon" id="icon_sort_trafficUsed">⇅</span></th>
                                <th class="col-desktop sortable" style="width:130px;" onclick="toggleUserSort('createdTime')" id="th_sort_createdTime" title="点击切换注册时间正序/降序">注册时间 <span class="sort-icon" id="icon_sort_createdTime">⇅</span></th>
                                <th class="col-desktop" style="width:100px;">到期时间</th>
                                <th class="col-desktop" style="width:80px;">状态</th>
                                <th class="col-mobile-online sortable" style="width:85px; text-align:center;" onclick="toggleUserSort('onlineConns')" id="th_sort_onlineConns" title="点击切换在线连接正序/降序">在线 <span class="sort-icon" id="icon_sort_onlineConns">⇅</span></th>
                                <th class="col-desktop" style="min-width:220px;">运维与设置</th>
                            </tr>
                        </thead>
                        <tbody id="usersTbody" class="compact-user-body">
                            <tr><td colspan="8" style="text-align:center; padding:24px; color:var(--text-muted);">正在载入用户数据...</td></tr>
                        </tbody>
                    </table>

                    <!-- 现代化分页导航条 (每页固定5条) -->
                    <div id="usersPagination" class="pagination-bar">
                        <div class="pagination-info" id="usersPaginationInfo" style="font-size:12px; color:var(--text-sub);">
                            共 <b id="totalUsersCount" style="color:var(--text-main);">0</b> 条用户 · 每页 <b>5</b> 条 · 第 <b id="currentUserPageNum" style="color:var(--primary);">1</b> / <span id="totalUserPagesNum">1</span> 页
                        </div>
                        <div class="pagination-controls" style="display:flex; gap:6px; align-items:center;">
                            <button class="page-btn" id="btnUserPrevPage" onclick="prevUserPage()" title="上一页">‹ 上一页</button>
                            <div id="userPageNumbers" style="display:flex; gap:4px; align-items:center;"></div>
                            <button class="page-btn" id="btnUserNextPage" onclick="nextUserPage()" title="下一页">下一页 ›</button>
                        </div>
                    </div>
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

                <!-- 🚀 批量自定义优选域名池 -->
                <div style="background:#f5f3ff; border:1px solid #ddd6fe; border-radius:6px; padding:12px 16px; margin-bottom:16px;">
                    <div style="font-weight:700; color:#6d28d9; font-size:14px; margin-bottom:8px;">🚀 批量自定义优选域名池 (Custom Optimal Domains)</div>
                    <label style="display:flex; align-items:center; gap:8px; font-weight:600; cursor:pointer; margin-bottom:10px;">
                        <input type="checkbox" id="cfg_enableCustomDomains" /> <span style="color:#6d28d9;">启用域名下发</span>
                    </label>
                    <div class="form-row" style="margin-bottom:0;">
                        <label>优选域名列表（每行一个，支持：纯域名 / 域名#备注 / 域名:端口#备注 / 域名:端口）</label>
                        <textarea id="cfg_customDomainsText" rows="6" placeholder="支持批量添加，每行一个，支持以下格式：&#10;1. 纯域名：cf.090227.xyz&#10;2. 域名#备注：cf.090227.xyz#香港优选CDN&#10;3. 域名:端口#备注：cf.090227.xyz:8443#香港高防8443&#10;4. 域名:端口：cf.090227.xyz:2053" style="font-family:Consolas, Monaco, monospace; font-size:13px; line-height:1.5;"></textarea>
                    </div>
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
                        <label>⚡ 端口回溯 CDN 主域名 / 公网 IP (SUB_DOMAIN)</label>
                        <input type="text" id="cfg_subDomain" placeholder="如 example.com (开启小黄云与 Origin Rules 回溯)" />
                        <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">在 Cloudflare 配置 Origin Rules 将 443 回溯至Altare 端口后填入，所有三网优选节点将自动以此域名完成端口回溯穿透！</span>
                    </div>
                    <div class="form-row">
                        <label>🛡️ 单 IP 注册冷却时间 (秒)</label>
                        <input type="number" id="cfg_ipRegisterCooldownSec" value="60" min="0" />
                        <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">防刷冷却期，默认 60 秒 (填 0 则关闭冷却)。</span>
                    </div>
                    <div class="form-row">
                        <label>🛡️ 单 IP 24小时注册上限 (个)</label>
                        <input type="number" id="cfg_ipDailyRegisterLimit" value="3" min="0" />
                        <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">单 IP 每日配额，默认 3 个 (填 0 不限制，防止挂机脚本薅号)。</span>
                    </div>
                </div>

                <!-- 订阅转换与规则模板配置 -->
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:18px;">
                    <div style="font-weight:700; color:#2563eb; font-size:13px; margin-bottom:10px;">🔄 全能订阅转换与零信任安全脱敏配置</div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px;">
                        <div class="form-row" style="margin-bottom:0;">
                            <label>订阅转换后端 (SUBAPI)</label>
                            <input type="text" id="cfg_subApi" placeholder="填 local (本地原生零外传引擎) 或外部地址" />
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">推荐填 local (物理级内网闭环，绝无任何外传风险) 或 https://subapi.cmliussss.net 等。</span>
                        </div>
                        <div class="form-row" style="margin-bottom:0;">
                            <label>Clash 分流规则模板 (SUBCONFIG)</label>
                            <input type="text" id="cfg_subConfig" placeholder="留空使用默认 ACL4SSR 经典模板" />
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">仅在调用外部 Subconverter 时生效，支持自定义分流规则集。</span>
                        </div>
                    </div>
                </div>

                <!-- 🛡️ ECH (Encrypted Client Hello) 强安全混淆模块 -->
                <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; margin-bottom:18px;">
                    <div style="font-weight:700; color:#16a34a; font-size:13px; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
                        <span>🛡️ ECH (Encrypted Client Hello) 全局防探测与指纹混淆</span>
                        <span style="font-size:11px; color:#15803d; font-weight:600;">RFC 1035/8484 Type 65 权威解析</span>
                    </div>
                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:16px;">
                        <div class="form-row" style="margin-bottom:0;">
                            <label>ECH 全局加密开关</label>
                            <select id="cfg_enableECH">
                                <option value="true">🟢 开启 ECH 防探测 (全客户端矩阵适配)</option>
                                <option value="false">⚪ 关闭 ECH (仅标准 TLS)</option>
                            </select>
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">自动为 Clash Meta、Sing-box、v2rayN、Shadowrocket 注入 ECH 配置。</span>
                        </div>
                        <div class="form-row" style="margin-bottom:0;">
                            <label>ECH SNI 探测域名 (ECH_SNI)</label>
                            <input type="text" id="cfg_echSni" placeholder="默认: cloudflare-ech.com" />
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">用于请求 DNS Type 65 HTTPS 记录提取 ECH PEM 证书的公网权威 SNI。</span>
                        </div>
                        <div class="form-row" style="margin-bottom:0;">
                            <label>ECH DoH 解析服务器 (ECH_DNS)</label>
                            <input type="text" id="cfg_echDns" placeholder="默认: https://dns.alidns.com/dns-query" />
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">支持阿里 DoH、腾讯 DNSPod 或 Cloudflare DoH。</span>
                        </div>
                        <div class="form-row" style="margin-bottom:0;">
                            <label>客户端 uTLS 指纹混淆 (CLIENT_FINGERPRINT)</label>
                            <input type="text" id="cfg_clientFingerprint" placeholder="默认: chrome" />
                            <span style="font-size:11px; color:#64748b; margin-top:3px; display:block;">推荐 chrome、firefox、safari、ios 或 randomized。</span>
                        </div>
                    </div>
                </div>

                <!-- 管理员密码修改 -->
                <div style="border-top:1px dashed var(--border-color); padding-top:16px; margin-top:16px;">
                    <div style="font-weight:700; color:#dc2626; font-size:13px; margin-bottom:10px;">🔐 后台管理员密码热修改 (直接原子落盘 .env)</div>
                    <div class="form-row" style="max-width:400px;">
                        <label>新管理员密码 (留空则保持当前不变)</label>
                    <input type="password" id="cfg_newAdminPassword" placeholder="输入新密码" autocomplete="new-password" />
                        <span style="font-size:11px; color:#64748b; margin-top:4px; display:block;">保存后立即更新内存并原子写入 .env，下次登录生效。</span>
                    </div>
                </div>

                <button class="btn btn-primary" style="padding:8px 20px;" onclick="saveSystemSettings()">💾 保存系统参数与新密码</button>
            </div>

            <!-- PANEL 4: 容器探针监控 -->
            <div class="card-panel" id="panel_status" style="display:none;">
                <div class="panel-header">
                    <div>
                        <div class="panel-title">📊 512MB Altare 轻核容器深度探针</div>
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
                    <div class="terminal-box" id="terminalLogBox">> [Kernel] Altare-Tunnel Pro 核心微服务正在运行...
> [Memory] 规格 512MB RAM | 翼龙面板单端口专享
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
                    <input type="text" id="edit_uuid" style="font-family:Consolas, monospace; font-size:12px; flex:1;" />
                    <button type="button" class="btn" onclick="copyText(document.getElementById('edit_uuid').value)" style="white-space:nowrap;">📋 复制</button>
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
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:20px; flex-wrap:wrap;">
                <div style="display:flex; gap:6px;">
                    <button type="button" class="btn btn-sm" onclick="renewUserFromModal()">⏳ +30天</button>
                    <button type="button" class="btn btn-sm btn-danger" onclick="deleteUserFromModal()">🗑️ 删除</button>
                </div>
                <div style="display:flex; gap:8px; margin-left:auto;">
                    <button type="button" class="btn" onclick="closeAdminModal('editUserModal')">取消</button>
                    <button type="button" class="btn btn-primary" onclick="submitEditUser()">💾 保存设置</button>
                </div>
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
        async function logoutAdmin() {
            await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
            location.href = '/admin';
        }
        function showToast(message, kind = '') {
            let stack = document.getElementById('toastStack');
            if (!stack) { stack = document.createElement('div'); stack.id = 'toastStack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
            const item = document.createElement('div'); item.className = 'toast ' + kind; item.textContent = message;
            stack.appendChild(item); item.scrollIntoView({ block: 'nearest' });
            setTimeout(() => item.remove(), 6000);
        }
        function confirmAction(message) {
            return new Promise(resolve => {
                const mask = document.createElement('div'); mask.className = 'modal-mask'; mask.style.display = 'flex';
                const card = document.createElement('section'); card.className = 'modal-card';
                const text = document.createElement('p'); text.textContent = message;
                const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:20px';
                const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = '取消';
                const accept = document.createElement('button'); accept.className = 'btn btn-primary'; accept.textContent = '确认';
                const finish = value => { mask.remove(); resolve(value); };
                cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
                mask.onclick = event => { if (event.target === mask) finish(false); };
                actions.append(cancel, accept); card.append(text, actions); mask.append(card); document.body.append(mask); accept.focus();
            });
        }
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
                    const logLines = [
                        '> [Kernel] Altare-Tunnel Pro 核心微服务正在运行...',
                        '> [Memory] 常驻 RSS: ' + (data.memoryRss || '--') + ' | 限额 512MB',
                        '> [Connections] 当前在线长连接: ' + (data.onlineConnections || 0),
                        '> [Wetest] 微测网最近更新: ' + wetestTime,
                        '> [Argo] 隧道穿透域名: ' + (currentSettings.argoDomain || '未绑定'),
                        '> [Ready] 所有模块状态良好，0ms即刻响应'
                    ];
                    term.innerText = logLines.join(String.fromCharCode(10));

                    // 回显配置
                    document.getElementById('cfg_allowRegister').value = String(currentSettings.allowRegister !== false);
                    document.getElementById('cfg_defaultDays').value = currentSettings.defaultDays || 365;
                    document.getElementById('cfg_defaultTrafficGB').value = currentSettings.defaultTrafficGB || 100;
                    document.getElementById('cfg_ipRegisterCooldownSec').value = currentSettings.ipRegisterCooldownSec !== undefined ? currentSettings.ipRegisterCooldownSec : 60;
                    document.getElementById('cfg_ipDailyRegisterLimit').value = currentSettings.ipDailyRegisterLimit !== undefined ? currentSettings.ipDailyRegisterLimit : 3;
                    document.getElementById('cfg_subDomain').value = currentSettings.subDomain || '';
                    document.getElementById('cfg_subApi').value = currentSettings.subApi || 'local';
                    document.getElementById('cfg_subConfig').value = currentSettings.subConfig || '';
                    document.getElementById('cfg_enableECH').value = String(currentSettings.enableECH !== false);
                    document.getElementById('cfg_echSni').value = currentSettings.echSni || 'cloudflare-ech.com';
                    document.getElementById('cfg_echDns').value = currentSettings.echDns || 'https://dns.alidns.com/dns-query';
                    document.getElementById('cfg_clientFingerprint').value = currentSettings.clientFingerprint || 'chrome';
                    document.getElementById('cfg_argoToken').value = '';
                    document.getElementById('cfg_argoToken').placeholder = currentSettings.argoTokenConfigured ? '已配置；留空保持不变，输入新值可轮换' : '尚未配置；粘贴 Tunnel Token';
                    document.getElementById('cfg_argoDomain').value = currentSettings.argoDomain || '';

                    document.getElementById('cfg_autoSyncWetest').checked = currentSettings.autoSyncWetest !== false;
                    if (document.getElementById('cfg_enableCustomDomains')) document.getElementById('cfg_enableCustomDomains').checked = currentSettings.enableCustomDomains === true;
                    if (document.getElementById('cfg_customDomainsText')) document.getElementById('cfg_customDomainsText').value = currentSettings.customDomainsText || '';
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
                if (res.status === 401) {
                    showToast('登录已失效，请刷新页面后重新登录', 'error');
                    return;
                }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                if (!Array.isArray(data.users)) throw new Error('无效的用户列表');
                cachedUsersList = data.users;
                cachedUsersMap.clear();
                cachedUsersList.forEach(u => cachedUsersMap.set(u.uuid, u));
                document.getElementById('kpi_user_count').innerText = cachedUsersList.length;
                filterUsers();
            } catch (err) {
                console.error(err);
                showToast('用户列表加载失败，请点击刷新重试', 'error');
            }
        }

        // ── 用户列表分页与多维排序搜索控制器 (每页固定 5 条) ──
        let userCurrentPage = 1;
        const userPageSize = 5;
        let filteredUsersList = [];
        let userSortKey = 'onlineConns';
        let userSortOrder = 'desc';

        function toggleUserSort(field) {
            if (userSortKey === field) {
                if (userSortOrder === 'desc') {
                    userSortOrder = 'asc';
                } else {
                    userSortOrder = 'desc';
                }
            } else {
                userSortKey = field;
                userSortOrder = 'desc';
            }
            syncUserSortUI();
            filterUsers();
        }

        function changeUserSortSelect(val) {
            if (!val || val === 'default') {
                userSortKey = 'default';
                userSortOrder = 'desc';
            } else {
                const parts = val.split('_');
                userSortKey = parts[0];
                userSortOrder = parts[1] || 'desc';
            }
            syncUserSortUI();
            filterUsers();
        }

        function syncUserSortUI() {
            const selectEl = document.getElementById('userSortSelect');
            if (selectEl) {
                selectEl.value = (userSortKey === 'default') ? 'default' : (userSortKey + '_' + userSortOrder);
            }
            const fields = ['trafficUsed', 'createdTime', 'onlineConns'];
            fields.forEach(function(f) {
                const th = document.getElementById('th_sort_' + f);
                const icon = document.getElementById('icon_sort_' + f);
                if (th && icon) {
                    if (userSortKey === f) {
                        th.style.color = '#2563eb';
                        icon.innerHTML = (userSortOrder === 'asc') ? '▲' : '▼';
                    } else {
                        th.style.color = '';
                        icon.innerHTML = '⇅';
                    }
                }
            });
        }

        function clearUserSearch() {
            document.getElementById('userSearchInput').value = '';
            filterUsers();
        }

        function filterUsers() {
            const kw = (document.getElementById('userSearchInput').value || '').trim().toLowerCase();
            const clearBtn = document.getElementById('clearUserSearchBtn');
            if (clearBtn) clearBtn.style.display = kw ? 'inline' : 'none';

            let list = [];
            if (!kw) {
                list = cachedUsersList ? [...cachedUsersList] : [];
            } else {
                list = (cachedUsersList || []).filter(function(u) {
                    return (u.username && u.username.toLowerCase().indexOf(kw) !== -1) ||
                           (u.uuid && u.uuid.toLowerCase().indexOf(kw) !== -1);
                });
            }

            if (userSortKey !== 'default') {
                list.sort(function(a, b) {
                    let valA = a[userSortKey];
                    let valB = b[userSortKey];
                    if (valA === undefined || valA === null) valA = 0;
                    if (valB === undefined || valB === null) valB = 0;
                    if (userSortOrder === 'asc') {
                        return valA > valB ? 1 : (valA < valB ? -1 : 0);
                    } else {
                        return valA < valB ? 1 : (valA > valB ? -1 : 0);
                    }
                });
            }

            filteredUsersList = list;
            userCurrentPage = 1;
            renderPaginatedUsers();
        }

        function renderPaginatedUsers() {
            const total = filteredUsersList.length;
            const totalPages = Math.max(1, Math.ceil(total / userPageSize));
            if (userCurrentPage > totalPages) userCurrentPage = totalPages;
            if (userCurrentPage < 1) userCurrentPage = 1;

            const startIndex = (userCurrentPage - 1) * userPageSize;
            const endIndex = Math.min(startIndex + userPageSize, total);
            const currentPageUsers = filteredUsersList.slice(startIndex, endIndex);

            // 1. 渲染表格主体行
            renderLegacyUsersTableRows(currentPageUsers);

            // 2. 渲染分页底部统计信息
            const infoEl = document.getElementById('usersPaginationInfo');
            if (infoEl) {
                const currentDisplay = total === 0 ? 0 : userCurrentPage;
                infoEl.innerHTML = '共 <b style="color:var(--text-main);">' + total + '</b> 条用户 · 每页 <b>' + userPageSize + '</b> 条 · 第 <b style="color:var(--primary);">' + currentDisplay + '</b> / <span>' + totalPages + '</span> 页';
            }

            // 3. 上一页 / 下一页禁用状态切换
            const btnPrev = document.getElementById('btnUserPrevPage');
            const btnNext = document.getElementById('btnUserNextPage');
            if (btnPrev) btnPrev.disabled = userCurrentPage <= 1;
            if (btnNext) btnNext.disabled = userCurrentPage >= totalPages || total === 0;

            // 4. 渲染页码按钮组
            renderUserPageButtons(totalPages, userCurrentPage);
        }

        function renderUserPageButtons(totalPages, current) {
            const container = document.getElementById('userPageNumbers');
            if (!container) return;
            if (totalPages <= 1) {
                container.innerHTML = filteredUsersList.length > 0 ? '<button class="page-btn active" onclick="goToUserPage(1)">1</button>' : '';
                return;
            }

            let pages = [];
            if (totalPages <= 7) {
                for (let i = 1; i <= totalPages; i++) pages.push(i);
            } else {
                if (current <= 4) {
                    pages = [1, 2, 3, 4, 5, '...', totalPages];
                } else if (current >= totalPages - 3) {
                    pages = [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
                } else {
                    pages = [1, '...', current - 1, current, current + 1, '...', totalPages];
                }
            }

            let btnsHtml = '';
            for (let i = 0; i < pages.length; i++) {
                const p = pages[i];
                if (p === '...') {
                    btnsHtml += '<span class="page-ellipsis">...</span>';
                } else {
                    const isActive = p === current ? 'active' : '';
                    btnsHtml += '<button class="page-btn ' + isActive + '" onclick="goToUserPage(' + p + ')">' + p + '</button>';
                }
            }
            container.innerHTML = btnsHtml;
        }

        function goToUserPage(page) {
            const totalPages = Math.max(1, Math.ceil(filteredUsersList.length / userPageSize));
            if (page < 1 || page > totalPages) return;
            userCurrentPage = page;
            renderPaginatedUsers();
        }

        function prevUserPage() {
            if (userCurrentPage > 1) {
                userCurrentPage--;
                renderPaginatedUsers();
            }
        }

        function nextUserPage() {
            const totalPages = Math.max(1, Math.ceil(filteredUsersList.length / userPageSize));
            if (userCurrentPage < totalPages) {
                userCurrentPage++;
                renderPaginatedUsers();
            }
        }

        const expandedUsers = new Set();
        function esc(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }
        function toggleUserDetails(uuid) {
            if (expandedUsers.has(uuid)) expandedUsers.delete(uuid);
            else expandedUsers.add(uuid);
            renderPaginatedUsers();
        }
        function copyUserSubscription(uuid) {
            copyText(location.origin + '/sub?token=' + encodeURIComponent(uuid));
        }
        function renderUsersTableRows(list) {
            const tbody = document.getElementById('usersTbody');
            if (!list || !list.length) {
                tbody.innerHTML = '<tr><td colspan="8"><div class="users-empty">没有匹配的用户</div></td></tr>';
                return;
            }
            tbody.innerHTML = list.map(u => {
                const id = esc(u.uuid), name = esc(u.username);
                const status = !u.enabled ? '已封禁' : u.isExpired ? '已到期' : u.isExhausted ? '流量用尽' : '正常';
                const open = expandedUsers.has(u.uuid);
                return '<tr class="compact-user-row"><td colspan="8"><article class="compact-user">' +
                    '<div class="user-summary"><button type="button" class="user-expand" aria-expanded="' + open + '" data-uuid="' + id + '" onclick="toggleUserDetails(this.dataset.uuid)">' +
                    '<span class="user-identity"><strong>' + name + '</strong><span class="user-status">' + status + '</span></span>' +
                    '<span class="user-traffic">' + esc(u.trafficUsedStr || '0 B') + '<small>已用流量</small></span><span class="user-chevron">' + (open ? '−' : '+') + '</span></button>' +
                    '<button class="btn subscription-copy" data-uuid="' + id + '" onclick="copyUserSubscription(this.dataset.uuid)">复制订阅</button></div>' +
                    (open ? '<div class="user-details"><dl><div><dt>流量配额</dt><dd>' + esc(u.trafficLimitStr || '0 B') + '</dd></div><div><dt>在线连接</dt><dd>' + esc(u.onlineConns || 0) + '</dd></div><div><dt>注册时间</dt><dd>' + esc(u.createdDateStr || '—') + '</dd></div><div><dt>到期时间</dt><dd>' + esc(u.expireDateStr || '—') + '</dd></div></dl>' +
                    '<button class="user-uuid" data-uuid="' + id + '" onclick="copyText(this.dataset.uuid)">UUID：' + id + '</button>' +
                    '<div class="user-detail-actions"><button class="btn" data-uuid="' + id + '" onclick="openEditUserModal(this.dataset.uuid)">编辑</button><button class="btn" data-uuid="' + id + '" onclick="toggleBan(this.dataset.uuid)">' + (u.enabled ? '封禁' : '解封') + '</button><button class="btn" data-uuid="' + id + '" onclick="renewUser(this.dataset.uuid)">续期 30 天</button><button class="btn btn-danger" data-uuid="' + id + '" data-name="' + name + '" onclick="deleteUser(this.dataset.uuid,this.dataset.name)">删除</button></div></div>' : '') +
                    '</article></td></tr>';
            }).join('');
        }
        function renderLegacyUsersTableRows(list) {
            const tbody = document.getElementById('usersTbody');
            if (!list || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:#94a3b8;">未找到匹配的用户数据</td></tr>';
                return;
            }
            tbody.innerHTML = list.map(function(u) {
                const safeUuid = esc(u.uuid);
                const safeName = esc(u.username || '');
                const safeTrafficUsed = esc(u.trafficUsedStr || '0 B');
                const safeTrafficLimit = esc(u.trafficLimitStr || '0 B');
                const safeCreated = esc(u.createdDateStr || '-');
                const safeExpire = esc(u.expireDateStr || '-');
                const safeOnline = esc(u.onlineConns || 0);
                let statusDot = u.enabled ? (u.isExpired ? '到期' : (u.isExhausted ? '超额' : '正常')) : '封禁';
                let statusColor = u.enabled ? (u.isExpired || u.isExhausted ? '#d97706' : '#16a34a') : '#dc2626';
                let statusHtml = '<span class="tag tag-ok">● 正常</span>';
                if (!u.enabled) statusHtml = '<span class="tag tag-ban">● 已封禁</span>';
                else if (u.isExpired) statusHtml = '<span class="tag tag-warn">● 已到期</span>';
                else if (u.isExhausted) statusHtml = '<span class="tag tag-warn">● 流量超额</span>';

                const pct = Math.min(100, Math.round(((u.trafficUsed || 0) / (u.trafficLimit || 1)) * 100));
                const connBadge = (u.onlineConns > 0)
                    ? ('<span style="display:inline-flex; align-items:center; gap:5px; padding:4px 12px; border-radius:999px; background:#dcfce7; color:#15803d; font-size:15px; font-weight:700;"><span style="width:12px;height:12px;border-radius:50%;background:#4d9f2e;display:inline-block;"></span>' + safeOnline + '</span>')
                    : '<span style="color:#94a3b8; font-size:14px;">0</span>';
                const banBtnText = u.enabled ? '🚫 封禁' : '🔓 解封';

                return '<tr>' +
                    // 1. 账号名称（点击直接打开弹窗编辑，手机/PC通用，极致顺手）
                    '<td class="col-mobile-user">' +
                        '<div class="mobile-clickable-cell" data-uuid="' + safeUuid + '" onclick="openEditUserModal(this.dataset.uuid)" title="点击直接编辑该账号">' +
                            '<div style="font-weight:700; color:#2563eb; display:flex; align-items:center; justify-content:space-between;">' +
                                '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + safeName + '</span>' +
                                '<span style="font-size:11px; opacity:0.75; margin-left:2px;">✏️</span>' +
                            '</div>' +
                            '<div class="mobile-sub-tag" style="color:' + statusColor + ';">● ' + statusDot + '</div>' +
                        '</div>' +
                    '</td>' +
                    // 2. UUID（手机端隐藏）
                    '<td class="col-desktop"><span class="uuid-badge" onclick="copyText(this.innerText)" title="点击复制 UUID">' + safeUuid + '</span></td>' +
                    // 3. 已用流量
                    '<td class="col-mobile-traffic">' +
                        '<div style="font-size:15px; color:#334155; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + safeTrafficUsed + ' / ' + (u.trafficLimitGB ? esc(u.trafficLimitGB) + 'G' : safeTrafficLimit) + '</div>' +
                        '<div class="progress-bar-wrap" style="margin-top:5px;"><div class="progress-bar-inner" style="width:' + pct + '%; background:#cbd5e1;"></div></div>' +
                    '</td>' +
                    // 4. 注册时间（手机端隐藏）
                    '<td class="col-desktop" style="color:#475569; font-size:12px; white-space:nowrap;">' + safeCreated + '</td>' +
                    // 5. 到期时间（手机端隐藏）
                    '<td class="col-desktop" style="color:#475569; font-size:12px; white-space:nowrap;">' + safeExpire + '</td>' +
                    // 6. 状态（手机端隐藏）
                    '<td class="col-desktop">' + statusHtml + '</td>' +
                    // 7. 在线
                    '<td class="col-mobile-online" style="text-align:center;">' + connBadge + '</td>' +
                    // 8. 运维按钮（手机端隐藏）
                    '<td class="col-desktop"><div style="display:flex; gap:4px; flex-wrap:nowrap;">' +
                        '<button class="btn btn-sm btn-primary" data-uuid="' + safeUuid + '" onclick="openEditUserModal(this.dataset.uuid)">✏️ 设置</button>' +
                        '<button class="btn btn-sm" data-uuid="' + safeUuid + '" onclick="toggleBan(this.dataset.uuid)">' + banBtnText + '</button>' +
                        '<button class="btn btn-sm" data-uuid="' + safeUuid + '" onclick="renewUser(this.dataset.uuid)">⏳ +30天</button>' +
                        '<button class="btn btn-sm btn-danger" data-uuid="' + safeUuid + '" data-name="' + safeName + '" onclick="deleteUser(this.dataset.uuid, this.dataset.name)">🗑️ 删除</button>' +
                    '</div></td>' +
                '</tr>';
            }).join('');
        }

        async function restartCoreService() {
            if (!await confirmAction('确定重启核心服务？当前连接会中断，面板守护程序将尝试重新拉起。')) return;
            try {
                const res = await fetch('/admin/api/restart', { method: 'POST' });
                const d = await res.json();
                showToast(d.message || '服务正在重启', 'success');
            } catch (e) {}
            setTimeout(function() { window.location.reload(); }, 1500);
        }

        function openAdminModal(id) { document.getElementById(id).style.display = 'flex'; }
        function closeAdminModal(id) { document.getElementById(id).style.display = 'none'; }

        function renewUserFromModal() {
            const uuid = document.getElementById('edit_orig_uuid').value;
            if (uuid) renewUser(uuid);
        }

        function deleteUserFromModal() {
            const uuid = document.getElementById('edit_orig_uuid').value;
            const name = document.getElementById('edit_username').value;
            if (uuid) {
                closeAdminModal('editUserModal');
                deleteUser(uuid, name);
            }
        }

        function openEditUserModal(uuid) {
            const u = cachedUsersMap.get(uuid);
            if (!u) return showToast('未找到该用户数据', 'error');
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

            if (!username) return showToast('用户名不能为空', 'error');
            if (!newUuid) return showToast('UUID 不能为空', 'error');

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
                showToast('用户账号已保存', 'success');
                closeAdminModal('editUserModal');
                fetchUsers();
            } else {
                showToast('保存失败：' + (d.error || '未知错误'), 'error');
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

            if (!username || username.length < 3) return showToast('用户名至少 3 位', 'error');

            const res = await fetch('/admin/api/user/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, trafficGB, days })
            });
            const d = await res.json();
            if (res.ok) {
                showToast('用户添加成功', 'success');
                if (d.temporaryPassword) showToast('临时密码：' + d.temporaryPassword);
                closeAdminModal('addUserModal');
                fetchUsers();
            } else {
                showToast('添加失败：' + (d.error || '未知错误'), 'error');
            }
        }

        function copyText(txt) {
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => showToast('UUID 已复制', 'success')).catch(() => showToast('复制失败，请检查剪贴板权限', 'error'));
            else showToast('浏览器不支持剪贴板', 'error');
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
                    showToast('用户已封禁并断开 ' + d.disconnectedCount + ' 个连接', 'success');
                }
                fetchUsers();
            }
        }

        async function deleteUser(uuid, name) {
            if (!await confirmAction('删除用户“' + name + '”？此操作会立即断开该用户的连接。')) return;
            const res = await fetch('/admin/api/user/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ uuid })
            });
            const d = await res.json();
            if (res.ok) {
                showToast(d.message || '用户已删除', 'success');
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
                    showToast('节点池已更新', 'success');
                    fetchStatus();
                } else {
                    showToast('同步失败：' + d.error, 'error');
                }
            } finally {
                btn.disabled = false;
                btn.innerText = '🔄 立即全量拉取微测网';
            }
        }

        async function saveCdnSettings() {
            const payload = {
                autoSyncWetest: document.getElementById('cfg_autoSyncWetest').checked,
                enableCustomDomains: document.getElementById('cfg_enableCustomDomains').checked,
                customDomainsText: document.getElementById('cfg_customDomainsText').value.trim(),
                enableOptOfficial: document.getElementById('cfg_enableOptOfficial').checked,
                enableOptCT: document.getElementById('cfg_enableOptCT').checked,
                enableOptCU: document.getElementById('cfg_enableOptCU').checked,
                enableOptCM: document.getElementById('cfg_enableOptCM').checked,
                optOfficialIp: document.getElementById('cfg_optOfficialIp').value.trim(),
                optCTIp: document.getElementById('cfg_optCTIp').value.trim(),
                optCUIp: document.getElementById('cfg_optCUIp').value.trim(),
                optCMIp: document.getElementById('cfg_optCMIp').value.trim()
            };
            try {
                const res = await fetch('/admin/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const d = await res.json().catch(() => ({}));
                if (res.ok) showToast('三网优选策略已保存', 'success');
                else showToast('保存失败：' + (d.error || '请求未成功'), 'error');
            } catch (e) {
                showToast('保存失败：网络异常，请检查连接', 'error');
            }
        }

        async function saveSystemSettings() {
            const payload = {
                allowRegister: document.getElementById('cfg_allowRegister').value === 'true',
                defaultDays: parseInt(document.getElementById('cfg_defaultDays').value, 10),
                defaultTrafficGB: parseInt(document.getElementById('cfg_defaultTrafficGB').value, 10),
                ipRegisterCooldownSec: parseInt(document.getElementById('cfg_ipRegisterCooldownSec').value, 10) || 0,
                ipDailyRegisterLimit: parseInt(document.getElementById('cfg_ipDailyRegisterLimit').value, 10) || 0,
                subDomain: document.getElementById('cfg_subDomain').value.trim(),
                subApi: document.getElementById('cfg_subApi').value.trim(),
                subConfig: document.getElementById('cfg_subConfig').value.trim(),
                enableECH: document.getElementById('cfg_enableECH').value === 'true',
                echSni: document.getElementById('cfg_echSni').value.trim(),
                echDns: document.getElementById('cfg_echDns').value.trim(),
                clientFingerprint: document.getElementById('cfg_clientFingerprint').value.trim(),
                argoToken: document.getElementById('cfg_argoToken').value,
                argoDomain: document.getElementById('cfg_argoDomain').value.trim(),
                newAdminPassword: document.getElementById('cfg_newAdminPassword').value.trim()
            };
            try {
                const res = await fetch('/admin/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const d = await res.json().catch(() => ({}));
                if (res.ok) {
                    showToast('系统配置已保存；如修改管理员密码，请重新登录', 'success');
                    const pwdField = document.getElementById('cfg_newAdminPassword');
                    if (pwdField) pwdField.value = '';
                    fetchStatus();
                } else {
                    showToast('保存失败：' + (d.error || '请求未成功'), 'error');
                }
            } catch (e) {
                showToast('保存失败：网络异常，请检查连接', 'error');
            }
        }

        // 初始化
        syncUserSortUI();
        fetchStatus();
        fetchUsers();
    </script>
</body>
</html>`;
}

// ==========================================
// 13. 启动 HTTP 监听
// ==========================================
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('[Startup] ⚠️ 未自动探测到面板分配端口，服务挂起等待端口配置；不监听假端口。');
} else {
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
    console.log(`🚀 Altare-Tunnel 纯原生 Node.js VLESS 隧道核心已成功启动！`);
    console.log(`📡 监听地址: http://0.0.0.0:${PORT}`);
    console.log(`🌐 微测网风格前台: http://127.0.0.1:${PORT}/`);
    console.log(`🛠️ Element UI 后台: http://127.0.0.1:${PORT}/admin`);
    if (siteSettings.argoToken) {
        startArgoTunnel(siteSettings.argoToken);
    }
    console.log(`🛡️ 内存使用: ${formatBytes(process.memoryUsage().rss)} (规格 512MB)`);
    console.log(`========================================================\n`);
});
}

let shuttingDown = false;
function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[System] 收到 ${signal}，正在关闭服务并保存用户数据...`);
    saveUsers();
    argoStopRequested = true; // 程序关闭属于主动停止，禁止自愈重连
    if (argoReconnectTimer) { clearTimeout(argoReconnectTimer); argoReconnectTimer = null; }
    if (argoHealthTimer) { clearInterval(argoHealthTimer); argoHealthTimer = null; }
    stopArgoTunnel();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 优雅捕获异常防止崩溃
process.on('uncaughtException', err => {
    console.error('[System] 未捕获异常拦截 (防崩溃):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('[System] 未处理 Promise 异常拦截 (防崩溃):', reason);
});
