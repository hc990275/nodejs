/**
 * 极速云专线 - 现代化专线机场用户控制中心 (Dashboard)
 * 深度参考魔戒机场风格，侧边栏导航 + 三格数据指标 + 一键四端快捷订阅 + 节点矩阵
 */

function renderDashboard(req, res, ctx) {
    const {
        currentUser,
        siteSettings,
        clientDownloads,
        getStructuredNodesForUser,
        isTunnelAvailable,
        ARGO_DOMAIN,
        DIRECT_IP,
        SERVER_PORT,
        sendHtmlResponse
    } = ctx;
    const isV3Prefix = req.url.startsWith("/v3");
    const basePrefix = isV3Prefix ? "/v3" : "";
    const reqHost = req.headers['x-forwarded-host'] || req.headers.host || `${DIRECT_IP}:${SERVER_PORT}`;
    const reqProto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
    const baseSubUrl = `${reqProto}://${reqHost}/sub?token=${currentUser.uuid}`;
    const clashSubUrl = `${baseSubUrl}&type=clash`;
    const surgeSubUrl = `${baseSubUrl}&type=surge`;

    const trafficLimitGB = (currentUser.trafficLimit / (1024 * 1024 * 1024)).toFixed(2);
    const trafficUsedGB = (currentUser.trafficUsed / (1024 * 1024 * 1024)).toFixed(2);
    const trafficRemainingGB = Math.max(0, (currentUser.trafficLimit - currentUser.trafficUsed) / (1024 * 1024 * 1024)).toFixed(2);
    const percentage = currentUser.trafficLimit > 0
        ? Math.min(100, (currentUser.trafficUsed / currentUser.trafficLimit * 100)).toFixed(1)
        : 0;

    const isExpired = currentUser.expireTime > 0 && currentUser.expireTime < Date.now();
    const isTrafficExhausted = currentUser.trafficLimit > 0 && currentUser.trafficUsed >= currentUser.trafficLimit;
    const expireDateStr = currentUser.expireTime > 0
        ? new Date(currentUser.expireTime).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
        : "长期有效";
    const daysLeft = currentUser.expireTime > 0
        ? Math.max(0, Math.ceil((currentUser.expireTime - Date.now()) / 86400000))
        : 999;

    const contactText = siteSettings.contactText || "Telegram: @robberer";
    const contactUrl = siteSettings.contactUrl || "https://t.me/s5gydl";

    // 格式化客户端下载表格
    let clientDownloadsHtml = "";
    if (siteSettings.enableClientDownload !== false && Array.isArray(clientDownloads) && clientDownloads.length > 0) {
        clientDownloadsHtml = clientDownloads.map((item, idx) => {
            const bg = idx % 2 === 0 ? "#ffffff" : "#fbfbfc";
            return `
                <tr style="background:${bg}; border-bottom:1px solid var(--el-border-light);">
                    <td style="padding:12px 16px; font-weight:600; color:var(--el-text-main); font-size:13px;">${item.platform}</td>
                    <td style="padding:12px 16px;">
                        <a href="${item.url}" target="_blank" rel="noopener noreferrer" style="color:var(--el-primary); text-decoration:none; font-family:Consolas, monospace; font-size:13px; font-weight:500; display:inline-flex; align-items:center; gap:6px;">
                            <span>${item.fileName}</span>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                        </a>
                    </td>
                </tr>
            `;
        }).join("");
    }

    // 获取为该用户生成的结构化节点
    const userNodes = getStructuredNodesForUser(currentUser);
    const nodesTableRows = userNodes.map((node) => {
        let protoBadgeClass = "badge-protocol";
        let protoLabel = node.type.toUpperCase();
        let portDisplay = node.ports || node.port;

        return `
            <tr style="border-bottom: 1px solid var(--el-border-light);">
                <td style="padding:12px 16px; font-weight:600; color:var(--el-text-main); display:flex; align-items:center; gap:8px;">
                    <span class="node-status-dot"></span>
                    <span>${node.name}</span>
                </td>
                <td style="padding:12px 16px;"><span class="${protoBadgeClass}">${protoLabel}</span></td>
                <td style="padding:12px 16px; font-family:Consolas, monospace; color:var(--el-text-regular);">${portDisplay}</td>
                <td style="padding:12px 16px; color:var(--el-success); font-weight:600;">1.0x</td>
                <td style="padding:12px 16px;">
                    <span style="display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--el-success); background:#f0f9eb; border:1px solid #e1f3d8; padding:2px 8px; border-radius:4px;">
                        正常在线
                    </span>
                </td>
                <td style="padding:12px 16px; text-align:right;">
                    <button class="btn btn-default btn-sm" onclick="copyNodeUri('${node.name}')">复制节点</button>
                </td>
            </tr>
        `;
    }).join("");

    return sendHtmlResponse(res, 200, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title>用户控制台 - 极速云专线机场</title>
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
            --el-success: #67c23a;
            --el-warning: #e6a23c;
            --el-danger: #f56c6c;
            --sidebar-width: 240px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            background: var(--el-bg);
            color: var(--el-text-main);
            min-height: 100vh;
            display: flex;
            -webkit-font-smoothing: antialiased;
        }

        /* 侧边栏 (魔戒风格) */
        .sidebar {
            width: var(--sidebar-width);
            background: #ffffff;
            border-right: 1px solid var(--el-border);
            display: flex;
            flex-direction: column;
            position: fixed;
            top: 0; bottom: 0; left: 0;
            z-index: 100;
        }
        .sidebar-brand {
            height: 64px;
            padding: 0 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            border-bottom: 1px solid var(--el-border-light);
            font-size: 16px;
            font-weight: 700;
            color: var(--el-text-main);
            text-decoration: none;
        }
        .sidebar-menu {
            list-style: none;
            padding: 16px 12px;
            flex-grow: 1;
        }
        .menu-item { margin-bottom: 4px; }
        .menu-link {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 14px;
            border-radius: 6px;
            color: var(--el-text-regular);
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .menu-link:hover {
            color: var(--el-primary);
            background: #ecf5ff;
        }
        .menu-link.active {
            color: var(--el-primary);
            background: #ecf5ff;
            font-weight: 600;
        }
        .sidebar-user {
            padding: 16px 20px;
            border-top: 1px solid var(--el-border-light);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .user-info-text { font-size: 13px; }
        .user-name {
            font-weight: 700;
            color: var(--el-text-main);
            margin-bottom: 2px;
        }
        .user-vip {
            font-size: 11px;
            color: var(--el-success);
            font-weight: 600;
        }

        /* 主工作区 */
        .content-wrapper {
            margin-left: var(--sidebar-width);
            flex-grow: 1;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* 顶部 Header */
        .header-bar {
            height: 64px;
            background: #ffffff;
            border-bottom: 1px solid var(--el-border);
            padding: 0 32px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: sticky;
            top: 0;
            z-index: 90;
        }
        .header-title { font-size: 16px; font-weight: 600; color: var(--el-text-main); }
        .header-actions { display: flex; align-items: center; gap: 12px; }

        /* 内容区主体 */
        .dashboard-body {
            padding: 24px 32px 48px;
            max-width: 1400px;
            width: 100%;
        }

        /* 欢迎横幅 */
        .welcome-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 24px 28px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .welcome-title {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 6px;
            color: var(--el-text-main);
        }
        .welcome-desc { font-size: 13px; color: var(--el-text-secondary); }

        /* 核心三格统计卡片 (魔戒风格) */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 24px;
        }
        .stat-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 20px 24px;
        }
        .stat-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            color: var(--el-text-secondary);
            font-size: 13px;
            font-weight: 500;
        }
        .stat-value-row {
            display: flex;
            align-items: baseline;
            gap: 6px;
            margin-bottom: 14px;
        }
        .stat-big {
            font-size: 28px;
            font-weight: 800;
            color: var(--el-text-main);
            line-height: 1;
        }
        .stat-unit { font-size: 14px; color: var(--el-text-secondary); }
        .progress-bar-bg {
            height: 8px;
            background: #ebeef5;
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        .progress-bar-inner {
            height: 100%;
            background: var(--el-primary);
            border-radius: 4px;
            transition: width 0.3s;
        }
        .stat-footer-text {
            font-size: 12px;
            color: var(--el-text-secondary);
            display: flex;
            justify-content: space-between;
        }

        /* 通用区块卡片 */
        .panel-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 24px;
            margin-bottom: 24px;
        }
        .panel-title {
            font-size: 16px;
            font-weight: 700;
            color: var(--el-text-main);
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        /* 一键订阅导入按钮矩阵 */
        .sub-import-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 12px;
            margin-bottom: 16px;
        }
        .sub-import-btn {
            background: #ffffff;
            border: 1px solid var(--el-border);
            padding: 12px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            color: var(--el-text-main);
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
        }
        .sub-import-btn:hover {
            border-color: var(--el-primary);
            color: var(--el-primary);
            background: #ecf5ff;
        }
        .sub-url-box {
            background: #f8f9fa;
            border: 1px solid var(--el-border);
            border-radius: 6px;
            padding: 10px 14px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .sub-url-text {
            flex-grow: 1;
            font-family: Consolas, monospace;
            font-size: 13px;
            color: var(--el-text-regular);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 按钮与通用工具类 */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: 500;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            border: 1px solid transparent;
            outline: none;
        }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .btn-default {
            background: #ffffff;
            border-color: var(--el-border);
            color: var(--el-text-regular);
        }
        .btn-default:hover {
            color: var(--el-primary);
            border-color: #c6e2ff;
            background: #ecf5ff;
        }
        .btn-primary {
            background: var(--el-primary);
            border-color: var(--el-primary);
            color: #ffffff;
        }
        .btn-primary:hover { background: var(--el-primary-hover); }
        .btn-danger {
            background: #ffffff;
            border-color: #fde2e2;
            color: var(--el-danger);
        }
        .btn-danger:hover { background: #fef0f0; }

        /* 节点状态与表格 */
        .table-responsive { width: 100%; overflow-x: auto; }
        .node-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
            text-align: left;
        }
        .node-table th {
            background: #f8f9fa;
            color: var(--el-text-secondary);
            padding: 12px 16px;
            font-weight: 600;
            border-bottom: 1px solid var(--el-border);
        }
        .node-table td {
            padding: 12px 16px;
            border-bottom: 1px solid var(--el-border-light);
            color: var(--el-text-main);
        }
        .node-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--el-success);
            display: inline-block;
        }
        .badge-protocol {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
            background: #ecf5ff;
            color: var(--el-primary);
            border: 1px solid #d9ecff;
        }

        /* 弹窗 Modal */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.45);
            z-index: 1000;
            align-items: center;
            justify-content: center;
            padding: 16px;
        }
        .modal-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            width: 100%;
            max-width: 460px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            overflow: hidden;
        }
        .modal-header {
            padding: 16px 20px;
            border-bottom: 1px solid var(--el-border-light);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .modal-title { font-size: 15px; font-weight: 700; }
        .modal-close {
            background: none;
            border: none;
            font-size: 20px;
            color: var(--el-text-secondary);
            cursor: pointer;
        }
        .modal-body { padding: 20px; }

        @media (max-width: 900px) {
            .sidebar { display: none; }
            .content-wrapper { margin-left: 0; }
            .dashboard-body { padding: 16px; }
            .welcome-card { flex-direction: column; align-items: flex-start; gap: 16px; }
        }
    </style>
</head>
<body>

    <!-- 侧边栏 (魔戒机场风格) -->
    <aside class="sidebar">
        <a href="${basePrefix}/dashboard" class="sidebar-brand">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#409eff" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
            <span>极速云专线</span>
        </a>

        <ul class="sidebar-menu">
            <li class="menu-item"><a href="${basePrefix}/" class="menu-link">🏠 机场官网 (Home)</a></li>
            <li class="menu-item"><a href="${basePrefix}/dashboard" class="menu-link active">📊 仪表盘 (Dashboard)</a></li>
            <li class="menu-item"><a href="#nodesSection" class="menu-link">🌐 节点状态 (Nodes)</a></li>
            <li class="menu-item"><a href="javascript:void(0)" onclick="openShopModal()" class="menu-link">🛒 购买套餐 (Shop)</a></li>
            <li class="menu-item"><a href="#clientSection" class="menu-link">📲 客户端下载 (Clients)</a></li>
            <li class="menu-item"><a href="${contactUrl}" target="_blank" rel="noopener noreferrer" class="menu-link">💬 官方客服 (Support)</a></li>
        </ul>

        <div class="sidebar-user">
            <div class="user-info-text">
                <div class="user-name">${currentUser.username}</div>
                <div class="user-vip">VIP 1 尊贵会员</div>
            </div>
            <a href="${basePrefix}/logout" class="btn btn-danger btn-sm" title="退出登录">退出</a>
        </div>
    </aside>

    <!-- 主工作区 -->
    <div class="content-wrapper">
        <header class="header-bar">
            <div class="header-title">用户中心 · 极速多协议智能专线</div>
            <div class="header-actions">
                <button class="btn btn-default" onclick="openQrModal()">📱 订阅二维码</button>
                <button class="btn btn-primary" onclick="openShopModal()">🛒 续费 / 升级套餐</button>
            </div>
        </header>

        <main class="dashboard-body">
            <!-- 欢迎横幅 -->
            <div class="welcome-card">
                <div>
                    <h2 class="welcome-title">欢迎回来，${currentUser.username}！</h2>
                    <p class="welcome-desc">您的节点专线全协议就绪，UDP 端口跳跃已激活，畅享全球无界连接。</p>
                </div>
                <div style="display:flex; gap:10px;">
                    <a href="${contactUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-default">
                        💬 官方交流群
                    </a>
                    <button class="btn btn-primary" onclick="copySubscriptionUrl()">
                        📋 复制通用订阅
                    </button>
                </div>
            </div>

            <!-- 核心三格统计指标 -->
            <div class="stats-grid">
                <!-- 流量监控 -->
                <div class="stat-card">
                    <div class="stat-header">
                        <span>高速流量使用状况</span>
                        <span>${percentage}%</span>
                    </div>
                    <div class="stat-value-row">
                        <span class="stat-big">${trafficRemainingGB}</span>
                        <span class="stat-unit">GB 可用 / 共 ${trafficLimitGB} GB</span>
                    </div>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-inner" style="width: ${percentage}%;"></div>
                    </div>
                    <div class="stat-footer-text">
                        <span>已消耗: ${trafficUsedGB} GB</span>
                        <span>重置日: 永久</span>
                    </div>
                </div>

                <!-- 会员时效 -->
                <div class="stat-card">
                    <div class="stat-header">
                        <span>账号会员有效期</span>
                        <span style="color:var(--el-success); font-weight:600;">正常运行</span>
                    </div>
                    <div class="stat-value-row">
                        <span class="stat-big">${daysLeft === 999 ? "长期" : daysLeft}</span>
                        <span class="stat-unit">${daysLeft === 999 ? "有效" : "天后到期"}</span>
                    </div>
                    <div style="height:8px; margin-bottom:8px;"></div>
                    <div class="stat-footer-text">
                        <span>到期时间: ${expireDateStr}</span>
                        <a href="javascript:void(0)" onclick="openShopModal()" style="color:var(--el-primary); text-decoration:none;">续期</a>
                    </div>
                </div>

                <!-- 在线设备与限制 -->
                <div class="stat-card">
                    <div class="stat-header">
                        <span>在线设备与连接策略</span>
                        <span>智能防蹭网</span>
                    </div>
                    <div class="stat-value-row">
                        <span class="stat-big">无限制</span>
                        <span class="stat-unit">设备并发</span>
                    </div>
                    <div style="height:8px; margin-bottom:8px;"></div>
                    <div class="stat-footer-text">
                        <span>超限策略: 踢出最早连接</span>
                        <span>空闲断连: 60秒</span>
                    </div>
                </div>
            </div>

            <!-- 一键订阅面板 -->
            <div class="panel-card">
                <div class="panel-title">
                    <span>⚡ 一键快速导入订阅</span>
                    <span style="font-size:13px; font-weight:normal; color:var(--el-text-secondary);">支持全平台主流客户端</span>
                </div>

                <div class="sub-import-grid">
                    <a href="clash://install-config?url=${encodeURIComponent(clashSubUrl)}" class="sub-import-btn">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#409eff" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        <span>一键导入 Clash</span>
                    </a>
                    <a href="sub://${Buffer.from(baseSubUrl).toString('base64')}" class="sub-import-btn">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#67c23a" stroke-width="2"><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path></svg>
                        <span>一键导入 Shadowrocket</span>
                    </a>
                    <button class="sub-import-btn" onclick="copySubscriptionUrl()">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e6a23c" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        <span>导入 v2rayN / Sing-box</span>
                    </button>
                    <button class="sub-import-btn" onclick="openQrModal()">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#909399" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                        <span>手机扫码配置</span>
                    </button>
                </div>

                <div class="sub-url-box">
                    <span style="font-size:12px; font-weight:600; color:var(--el-text-main); flex-shrink:0;">通用订阅地址:</span>
                    <span class="sub-url-text" id="subUrlDisplay">${baseSubUrl}</span>
                    <button class="btn btn-default btn-sm" onclick="copySubscriptionUrl()">复制</button>
                </div>
            </div>

            <!-- 节点列表与状态 -->
            <div class="panel-card" id="nodesSection">
                <div class="panel-title">
                    <span>🌐 节点网络矩阵 (共 ${userNodes.length} 个节点)</span>
                    <button class="btn btn-default btn-sm" onclick="location.reload()">🔄 刷新状态</button>
                </div>
                <div class="table-responsive">
                    <table class="node-table">
                        <thead>
                            <tr>
                                <th>节点名称</th>
                                <th>协议类型</th>
                                <th>端口/跳跃</th>
                                <th>倍率</th>
                                <th>状态</th>
                                <th style="text-align:right;">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${nodesTableRows}
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- 客户端下载专区 -->
            <div class="panel-card" id="clientSection">
                <div class="panel-title">
                    <span>📲 全平台客户端推荐下载 (FlClash / v2rayN 等)</span>
                </div>
                <div class="table-responsive">
                    <table class="node-table">
                        <thead>
                            <tr>
                                <th style="width:200px;">操作系统平台</th>
                                <th>官方适配下载链接 (包含各平台多架构包)</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${clientDownloadsHtml || `
                                <tr>
                                    <td colspan="2" style="padding:16px; text-align:center; color:var(--el-text-secondary);">
                                        暂无客户端配置，请直接使用 Clash Verge、v2rayN 或 FlClash 导入订阅。
                                    </td>
                                </tr>
                            `}
                        </tbody>
                    </table>
                </div>
            </div>
        </main>
    </div>

    <!-- 订阅二维码弹窗 -->
    <div class="modal-overlay" id="qrModal">
        <div class="modal-card">
            <div class="modal-header">
                <span class="modal-title">手机扫码一键导入订阅</span>
                <button class="modal-close" onclick="closeQrModal()">×</button>
            </div>
            <div class="modal-body" style="text-align:center;">
                <div style="margin-bottom:16px;">
                    <img id="qrImage" src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(baseSubUrl)}" style="width:220px; height:220px; border:1px solid var(--el-border); border-radius:6px; padding:8px;" alt="QR Code" />
                </div>
                <p style="font-size:13px; color:var(--el-text-secondary); margin-bottom:16px;">
                    使用手机相机、Shadowrocket 或小火箭扫码即可自动导入节点配置
                </p>
                <button class="btn btn-primary" onclick="copySubscriptionUrl()">复制订阅链接</button>
            </div>
        </div>
    </div>

    <!-- 续费/购买套餐弹窗 -->
    <div class="modal-overlay" id="shopModal">
        <div class="modal-card" style="max-width:540px;">
            <div class="modal-header">
                <span class="modal-title">🛒 续费 / 升级订阅套餐</span>
                <button class="modal-close" onclick="closeShopModal()">×</button>
            </div>
            <div class="modal-body">
                <div style="font-size:13px; color:var(--el-text-regular); margin-bottom:16px;">
                    当前为极速专线商业机场直连系统。如需购买套餐、重置流量配额或延长时效，请点击下方联系站长客服一键开通：
                </div>
                <div style="background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:16px; margin-bottom:20px;">
                    <div style="font-weight:700; font-size:14px; margin-bottom:8px;">💎 推荐套餐方案：</div>
                    <div style="font-size:13px; line-height:1.8; color:var(--el-text-regular);">
                        • <b>极速畅享月付</b>：¥15 / 月 (100GB 高速流量，亚太直连专线)<br>
                        • <b>极客旗舰年付</b>：¥128 / 年 (1000GB 独享流量，UDP 智能跳跃)<br>
                        • <b>流量重置加油包</b>：¥10 / 50GB (临时高速应急包)
                    </div>
                </div>
                <div style="display:flex; justify-content:flex-end; gap:12px;">
                    <button class="btn btn-default" onclick="closeShopModal()">关闭</button>
                    <a href="${contactUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
                        💬 立即联系客服开通 (${contactText})
                    </a>
                </div>
            </div>
        </div>
    </div>

    <script>
        const rawSubUrl = "${baseSubUrl}";

        function copySubscriptionUrl() {
            navigator.clipboard.writeText(rawSubUrl).then(() => {
                alert("✅ 通用订阅地址已成功复制到剪贴板！\\n可在 Clash、Shadowrocket、v2rayN 或 Sing-box 中直接粘贴更新。");
            }).catch(() => {
                const input = document.createElement("input");
                input.value = rawSubUrl;
                document.body.appendChild(input);
                input.select();
                document.execCommand("copy");
                document.body.removeChild(input);
                alert("✅ 通用订阅地址已复制！");
            });
        }

        function copyNodeUri(nodeName) {
            // 请求后端获取单节点 URI
            fetch("${basePrefix}/sub?token=${currentUser.uuid}").then(r => r.text()).then(text => {
                const lines = atob(text.trim()).split("\\n");
                const found = lines.find(l => l.includes(encodeURIComponent(nodeName)) || l.includes(nodeName));
                const target = found || lines[0] || rawSubUrl;
                navigator.clipboard.writeText(target).then(() => {
                    alert("✅ 节点链接已复制到剪贴板！");
                });
            }).catch(() => {
                copySubscriptionUrl();
            });
        }

        function openQrModal() {
            document.getElementById("qrModal").style.display = "flex";
        }
        function closeQrModal() {
            document.getElementById("qrModal").style.display = "none";
        }

        function openShopModal() {
            document.getElementById("shopModal").style.display = "flex";
        }
        function closeShopModal() {
            document.getElementById("shopModal").style.display = "none";
        }
    </script>
</body>
</html>
`);
}

module.exports = {
    renderDashboard
};
