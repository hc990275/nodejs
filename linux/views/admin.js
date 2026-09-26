/**
 * 极速云专线 - 现代化节点服务集群与机场运营总控制台 (Admin Dashboard)
 * 采用 Element UI 极简明亮后台设计，具备全节点监控、用户管理、实时IP感知与安全落盘配置中心
 */

function renderAdminPage(req, res, ctx) {
    const {
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
    } = ctx;

const totalUsers = usersDatabase.length;
        const activeUsersCount = getActiveUsers().length;
        const totalTrafficSum = usersDatabase.reduce((acc, u) => acc + (u.trafficUsed || 0), 0);

        // 统计实时全站在线连接数
        let totalLiveConnections = 0;
        userActivityMap.forEach((act) => {
            totalLiveConnections += (act.activeConnections || 0);
        });

        const clientUsers = usersDatabase.map((u, idx) => {
            const invalidMsg = isUserInvalid(u);
            const act = getUserActivity(u.uuid);
            const dateStr = formatExpireDate(u.expireTime);
            const parsedLimit = parseBytesToInput(u.trafficLimit);

            const reqHost = req.headers['x-forwarded-host'] || req.headers.host || `${DIRECT_IP}:${SERVER_PORT}`;
            const reqProto = req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : 'http');
            const baseSubUrl = `${reqProto}://${reqHost}/sub?token=${u.uuid}`;
            const clashSubUrl = `${baseSubUrl}&type=clash`;
            const surgeSubUrl = `${baseSubUrl}&type=surge`;

            return {
                idx: idx + 1,
                uuid: u.uuid,
                username: u.username,
                trafficUsed: u.trafficUsed || 0,
                trafficLimit: u.trafficLimit || 0,
                trafficUsedStr: formatBytes(u.trafficUsed),
                trafficLimitStr: formatBytes(u.trafficLimit),
                expireTime: u.expireTime || 0,
                expireDateStr: dateStr,
                enabled: u.enabled,
                invalidMsg: invalidMsg,
                activeConnections: act.activeConnections || 0,
                lastSeenAt: act.lastSeenAt || 0,
                lastSeenStr: formatRelativeTime(act.lastSeenAt),
                lastIp: act.lastIp || "",
                lastLocation: act.lastLocation || (act.lastIp ? (ipGeoCache.get(act.lastIp) || "公网地址") : ""),
                activeList: (act.activeList || []).slice().sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0)).map((c) => ({
                    id: c.id,
                    ip: c.ip,
                    location: c.location || ipGeoCache.get(c.ip) || "公网地址",
                    proto: c.proto,
                    connectedAt: c.connectedAt,
                    connectedStr: formatRelativeTime(c.connectedAt)
                })),
                createdAt: u.createdAt || (Date.now() - (usersDatabase.length - idx) * 3600000),
                baseSubUrl,
                clashSubUrl,
                surgeSubUrl,
                limitVal: parsedLimit.val,
                limitUnit: parsedLimit.unit,
                maxOnlineIps: u.maxOnlineIps !== undefined ? u.maxOnlineIps : 0,
                ipLimitPolicy: u.ipLimitPolicy || "kick_oldest",
                idleDisconnectEnabled: u.idleDisconnectEnabled !== undefined ? u.idleDisconnectEnabled : true,
                idleTimeoutSeconds: u.idleTimeoutSeconds ? parseInt(u.idleTimeoutSeconds, 10) : 60
            };
        });
        const clientUsersJson = JSON.stringify(clientUsers);
        const clientSettingsJson = JSON.stringify(siteSettings);

                let clientDownloadCardHtml = "";
        if (siteSettings.enableClientDownload !== false) {
            const tableRows = (clientDownloads || []).map((item, idx) => {
                const bg = idx % 2 === 0 ? "#ffffff" : "#fbfbfc";
                return `
                    <tr data-platform="${item.platform}" style="background:${bg}; border-bottom:1px solid var(--el-border-light);">
                        <td style="padding:10px 16px; font-weight:500; color:var(--el-text-main); font-size:13px;" class="platform-name-cell">${item.platform}</td>
                        <td style="padding:10px 16px;">
                            <a href="${item.url}" target="_blank" rel="noopener noreferrer" style="color:var(--el-primary); text-decoration:none; font-family:Consolas, monospace; font-size:13px; font-weight:500; display:inline-flex; align-items:center; gap:4px; word-break:break-all;">
                                <span>${item.fileName}</span>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                            </a>
                        </td>
                    </tr>
                `;
            }).join("");

            clientDownloadCardHtml = `
                    <!-- 推荐客户端下载卡片 (FlClash) -->
                    <div class="dashboard-card" style="margin-top: 16px;">
                        <div class="sub-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="color:var(--el-primary);"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
                                <span>推荐客户端下载 (FlClash)</span>
                            </div>
                            <span style="font-size:12px; color:var(--el-success); font-weight:normal; display:flex; align-items:center; gap:4px;">
                                <span style="width:6px; height:6px; border-radius:50%; background:var(--el-success); display:inline-block;"></span>
                                官方直连
                            </span>
                        </div>
                        <div class="sub-section-desc">全平台通用代理客户端，已内置规则支持，点击即可直接下载：</div>
                        <div style="border:1px solid var(--el-border); border-radius:6px; overflow:hidden; margin-top:12px; background:#ffffff;">
                            <table style="width:100%; border-collapse:collapse; text-align:left;">
                                <thead>
                                    <tr style="background:#f5f7fa; border-bottom:1px solid var(--el-border); font-size:13px; color:var(--el-text-regular);">
                                        <th style="padding:10px 16px; font-weight:600; width:36%;">平台</th>
                                        <th style="padding:10px 16px; font-weight:600;">文件下载</th>
                                    </tr>
                                </thead>
                                <tbody id="clientDownloadTableBody">
                                    ${tableRows}
                                </tbody>
                            </table>
                        </div>
                    </div>
            `;
        }

return sendHtmlResponse(res, 200, `
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
                    
                    /* 数据统计网格 - 现代 Element UI 明亮微质感看板 */
                    .stats-grid {
                        display: grid;
                        grid-template-columns: repeat(4, 1fr);
                        gap: 14px;
                        margin-bottom: 16px;
                    }
                    .stat-card {
                        background: var(--el-card);
                        border: 1px solid var(--el-border);
                        border-radius: 8px;
                        padding: 16px 18px;
                        box-shadow: 0 1px 4px 0 rgba(0, 0, 0, 0.05);
                        position: relative;
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        transition: transform 0.2s ease, box-shadow 0.2s ease;
                    }
                    .stat-card:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 4px 14px 0 rgba(0, 0, 0, 0.08);
                    }
                    .stat-info { display: flex; flex-direction: column; }
                    .stat-title { font-size: 13px; color: var(--el-text-secondary); margin-bottom: 4px; font-weight: 500; }
                    .stat-value { font-size: 22px; font-weight: 700; color: var(--el-text-main); display: flex; align-items: baseline; gap: 4px; }
                    .stat-unit { font-size: 12px; color: var(--el-text-secondary); font-weight: normal; }
                    .stat-icon-wrap {
                        width: 44px;
                        height: 44px;
                        border-radius: 8px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        flex-shrink: 0;
                    }
                    .stat-icon-wrap.c1 { background: #ecf5ff; color: var(--el-primary); }
                    .stat-icon-wrap.c2 { background: #f0f9eb; color: var(--el-success); }
                    .stat-icon-wrap.c3 { background: #fdf6ec; color: var(--el-warning); }
                    .stat-icon-wrap.c4 { background: #f4f4f5; color: #909399; }

                    /* 胶囊流量进度条 */
                    .traffic-progress-wrap {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                        min-width: 140px;
                    }
                    .traffic-progress-bar {
                        width: 100%;
                        height: 6px;
                        background: #ebeef5;
                        border-radius: 3px;
                        overflow: hidden;
                    }
                    .traffic-progress-inner {
                        height: 100%;
                        border-radius: 3px;
                        transition: width 0.3s ease;
                    }
                    .traffic-progress-text {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        font-size: 11px;
                        color: var(--el-text-secondary);
                    }

                    /* UUID 微徽章与一键生成/轮换 */
                    .uuid-pill {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        background: #f4f4f5;
                        border: 1px solid #e9e9eb;
                        padding: 2px 6px;
                        border-radius: 4px;
                        margin-top: 3px;
                    }
                    .uuid-text {
                        font-family: Consolas, monospace;
                        font-size: 11px;
                        color: var(--el-text-regular);
                        cursor: pointer;
                    }
                    .uuid-text:hover { color: var(--el-primary); }
                    .btn-mini-icon {
                        border: none;
                        background: transparent;
                        cursor: pointer;
                        padding: 1px 3px;
                        border-radius: 3px;
                        font-size: 11px;
                        line-height: 1;
                        transition: background 0.15s;
                    }
                    .btn-mini-icon:hover { background: #e4e7ed; }

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
                    .btn-action-rotate {
                        background: #fdf6ec; border: 1px solid #faecd8;
                        color: #e6a23c; padding: 4px 8px; font-size: 12px; border-radius: 4px; cursor: pointer; transition: all 0.2s;
                    }
                    .btn-action-rotate:hover { background: #e6a23c; color: #fff; }
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

                    /* 搜索与排序工具栏 */
                    .table-toolbar {
                        display: flex;
                        flex-wrap: wrap;
                        align-items: center;
                        justify-content: space-between;
                        gap: 12px;
                        margin-bottom: 14px;
                        padding: 10px 14px;
                        background: #fafafa;
                        border: 1px solid var(--el-border-light);
                        border-radius: 6px;
                    }
                    .toolbar-left {
                        display: flex;
                        flex-wrap: wrap;
                        align-items: center;
                        gap: 10px;
                        flex: 1;
                    }
                    .toolbar-right {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 13px;
                        color: var(--el-text-secondary);
                    }
                    .search-input-wrap {
                        position: relative;
                        min-width: 200px;
                        flex: 1;
                        max-width: 280px;
                    }
                    .search-input {
                        width: 100%;
                        padding: 7px 12px 7px 32px;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        font-size: 13px;
                        outline: none;
                        transition: all 0.2s;
                        background: #ffffff;
                        color: var(--el-text-main);
                    }
                    .search-input:focus {
                        border-color: var(--el-primary);
                        box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
                    }
                    .search-icon {
                        position: absolute;
                        left: 10px;
                        top: 50%;
                        transform: translateY(-50%);
                        color: var(--el-text-secondary);
                        pointer-events: none;
                    }
                    .sort-select {
                        padding: 7px 12px;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        font-size: 13px;
                        outline: none;
                        background: #ffffff;
                        color: var(--el-text-main);
                        cursor: pointer;
                        transition: border-color 0.2s;
                    }
                    .sort-select:focus {
                        border-color: var(--el-primary);
                    }
                    .btn-sort-dir {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        padding: 7px 12px;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        background: #ffffff;
                        color: var(--el-text-regular);
                        font-size: 13px;
                        cursor: pointer;
                        transition: all 0.2s;
                        user-select: none;
                    }
                    .btn-sort-dir:hover {
                        color: var(--el-primary);
                        border-color: var(--el-primary-border);
                        background: var(--el-primary-light);
                    }

                    /* 分页条 Pagination */
                    .pagination-container {
                        display: flex;
                        flex-wrap: wrap;
                        align-items: center;
                        justify-content: space-between;
                        gap: 12px;
                        margin-top: 16px;
                        padding-top: 14px;
                        border-top: 1px solid var(--el-border-light);
                    }
                    .pagination-info {
                        font-size: 13px;
                        color: var(--el-text-secondary);
                    }
                    .pagination-controls {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .page-btn {
                        min-width: 32px;
                        height: 32px;
                        padding: 0 10px;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        background: #ffffff;
                        color: var(--el-text-regular);
                        font-size: 13px;
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        cursor: pointer;
                        transition: all 0.2s;
                        user-select: none;
                    }
                    .page-btn:hover:not(:disabled) {
                        color: var(--el-primary);
                        border-color: var(--el-primary-border);
                        background: var(--el-primary-light);
                    }
                    .page-btn:disabled {
                        cursor: not-allowed;
                        color: #c0c4cc;
                        border-color: var(--el-border-light);
                        background: #f5f7fa;
                    }
                    .page-btn.active {
                        background: var(--el-primary);
                        border-color: var(--el-primary);
                        color: #ffffff;
                        font-weight: 600;
                    }
                    .page-ellipsis {
                        min-width: 24px;
                        text-align: center;
                        color: var(--el-text-secondary);
                        font-size: 13px;
                    }

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
                    /* 实时在线感知与 IP 归属地 (IP138级) UI 样式 */
                    .perception-cell {
                        display: flex;
                        flex-direction: column;
                        gap: 4px;
                    }
                    .live-ip-chip {
                        display: inline-flex;
                        align-items: center;
                        gap: 5px;
                        background: #ecf5ff;
                        border: 1px solid #d9ecff;
                        border-radius: 4px;
                        padding: 2px 7px;
                        font-size: 11px;
                        max-width: 250px;
                    }
                    .ip-proto-tag {
                        background: var(--el-primary);
                        color: #ffffff;
                        font-size: 10px;
                        font-weight: 600;
                        padding: 0 4px;
                        border-radius: 2px;
                        line-height: 16px;
                    }
                    .live-ip-chip .ip-addr {
                        font-family: Consolas, monospace;
                        font-weight: 600;
                        color: var(--el-primary);
                    }
                    .live-ip-chip .ip-geo {
                        color: #606266;
                        font-size: 11px;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        max-width: 130px;
                    }
                    .ip-more-badge {
                        background: var(--el-warning);
                        color: #ffffff;
                        font-size: 10px;
                        font-weight: 600;
                        padding: 0 5px;
                        border-radius: 8px;
                        cursor: pointer;
                        user-select: none;
                    }
                    .last-ip-bar {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 11px;
                        color: var(--el-text-secondary);
                    }
                    .last-ip-bar .last-ip {
                        font-family: Consolas, monospace;
                        color: #606266;
                    }
                    .last-ip-bar .last-geo {
                        color: #909399;
                        font-size: 11px;
                    }
                    .modal-large {
                        max-width: 860px !important;
                        width: 95% !important;
                    }
                    .visitors-table-wrapper {
                        max-height: 420px;
                        overflow-y: auto;
                        border: 1px solid var(--el-border);
                        border-radius: 4px;
                        margin-bottom: 14px;
                    }
                    .visitors-table-wrapper table {
                        width: 100%;
                        border-collapse: collapse;
                    }
                    .visitors-table-wrapper th {
                        background: #f5f7fa;
                        padding: 10px 12px;
                        font-size: 12px;
                        font-weight: 600;
                        color: var(--el-text-regular);
                        border-bottom: 1px solid var(--el-border);
                        text-align: left;
                        position: sticky;
                        top: 0;
                        z-index: 2;
                    }
                    .visitors-table-wrapper td {
                        padding: 9px 12px;
                        font-size: 13px;
                        border-bottom: 1px solid var(--el-border-light);
                        color: var(--el-text-main);
                    }
                    .visitors-table-wrapper tr:hover td {
                        background: #fafafa;
                    }
                    .ip-tag {
                        font-family: Consolas, monospace;
                        font-weight: 600;
                        color: var(--el-primary);
                        background: #ecf5ff;
                        padding: 2px 6px;
                        border-radius: 3px;
                        border: 1px solid #d9ecff;
                        cursor: pointer;
                        user-select: all;
                    }
                    .geo-tag {
                        color: #303133;
                        font-size: 12px;
                    }
                    .proto-badge {
                        display: inline-block;
                        padding: 1px 6px;
                        border-radius: 3px;
                        font-size: 11px;
                        font-weight: 600;
                        color: #ffffff;
                        background: #409eff;
                    }
                    .proto-vless { background: #67c23a; }
                    .proto-vmess { background: #409eff; }
                    .proto-trojan { background: #e6a23c; }

                    /* 使用者 IP 信息列多用户/多设备展示样式 */
                    .user-ip-list {
                        display: flex;
                        flex-direction: column;
                        gap: 5px;
                        min-width: 250px;
                        max-width: 340px;
                        max-height: 180px;
                        overflow-y: auto;
                        padding-right: 2px;
                    }
                    .multi-user-alert {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        background: #fdf6ec;
                        border: 1px solid #faecd8;
                        color: #e6a23c;
                        border-radius: 3px;
                        padding: 2px 7px;
                        font-size: 11px;
                        font-weight: 600;
                        margin-bottom: 2px;
                    }
                    .user-ip-row {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        background: #f8f9fa;
                        border: 1px solid #e4e7ed;
                        border-radius: 4px;
                        padding: 4px 8px;
                        font-size: 12px;
                        transition: all 0.15s ease;
                    }
                    .user-ip-row:hover {
                        background: #f0f7ff;
                        border-color: #d9ecff;
                    }
                    .user-ip-row .ip-address {
                        font-family: Consolas, Monaco, monospace;
                        font-weight: 600;
                        color: #409eff;
                        cursor: pointer;
                        user-select: all;
                    }
                    .user-ip-row .ip-location-tag {
                        color: #303133;
                        font-size: 11px;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        max-width: 140px;
                    }
                    .user-ip-row .ip-time-tag {
                        font-size: 10px;
                        color: #909399;
                        margin-left: auto;
                        white-space: nowrap;
                    }
                    .last-ip-card {
                        display: inline-flex;
                        align-items: center;
                        gap: 6px;
                        font-size: 12px;
                        color: #909399;
                        background: #fafafa;
                        border: 1px dashed #dcdfe6;
                        border-radius: 4px;
                        padding: 4px 8px;
                        max-width: 320px;
                    }
                    .last-ip-card .ip-address {
                        font-family: Consolas, monospace;
                        color: #606266;
                        font-weight: 500;
                        cursor: pointer;
                    }
                    .badge-multi-online {
                        display: inline-flex;
                        align-items: center;
                        gap: 4px;
                        background: #fdf6ec;
                        border: 1px solid #faecd8;
                        color: #e6a23c;
                        font-size: 10px;
                        font-weight: 600;
                        padding: 1px 6px;
                        border-radius: 3px;
                        margin-top: 4px;
                        width: fit-content;
                    }
                    /* 异地并发异常高危警示徽章 (精炼紧凑四个字，支持点开展开) */
                    .badge-geo-alert {
                        display: inline-flex;
                        align-items: center;
                        gap: 3px;
                        background: #fef0f0;
                        border: 1px solid #fde2e2;
                        color: #f56c6c;
                        font-size: 11px;
                        font-weight: 600;
                        padding: 2px 6px;
                        border-radius: 4px;
                        margin-top: 3px;
                        width: fit-content;
                        cursor: pointer;
                        user-select: none;
                        transition: all 0.2s ease;
                    }
                    .badge-geo-alert:hover {
                        background: #fde2e2;
                        border-color: #fbc4c4;
                        color: #d93025;
                    }
                    .badge-geo-alert .geo-arrow {
                        font-size: 9px;
                        color: #f56c6c;
                        margin-left: 1px;
                        display: inline-block;
                        transition: transform 0.2s ease;
                    }
                    /* 异地并发详细分布面板 */
                    .geo-detail-box {
                        margin-top: 4px;
                        padding: 6px 9px;
                        background: #fffafa;
                        border: 1px dashed #fbc4c4;
                        border-radius: 4px;
                        font-size: 11px;
                        color: #303133;
                        line-height: 1.4;
                        min-width: 210px;
                        max-width: 280px;
                        box-shadow: 0 1px 4px rgba(245, 108, 108, 0.08);
                    }
                    .geo-detail-item {
                        display: flex;
                        align-items: flex-start;
                        gap: 4px;
                        padding: 3px 0;
                        border-bottom: 1px solid #fef0f0;
                    }
                    .geo-detail-item:last-child {
                        border-bottom: none;
                    }
                    .geo-detail-dot {
                        color: #f56c6c;
                        font-weight: bold;
                        line-height: 1;
                        margin-top: 2px;
                    }
                    .geo-detail-content {
                        flex: 1;
                        word-break: break-all;
                    }
                    .geo-detail-loc {
                        font-weight: 600;
                        color: #d93025;
                        font-size: 11px;
                    }
                    .geo-detail-meta {
                        color: #909399;
                        font-size: 10px;
                        margin-top: 1px;
                    }
                    .geo-detail-footer {
                        margin-top: 5px;
                        padding-top: 4px;
                        border-top: 1px dashed #fde2e2;
                        display: flex;
                        justify-content: flex-end;
                    }
                    .geo-detail-footer a {
                        color: #409eff;
                        text-decoration: none;
                        font-size: 11px;
                        font-weight: 500;
                    }
                    .geo-detail-footer a:hover {
                        text-decoration: underline;
                    }
                    /* 单元格弹窗触发按钮 (清爽微卡片，告别拥挤) */
                    .btn-user-ip-modal {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        gap: 4px;
                        padding: 4px 9px;
                        border-radius: 4px;
                        font-size: 12px;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        border: 1px solid var(--el-border);
                        background: #ffffff;
                        color: var(--el-text-main);
                        max-width: 155px;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        user-select: none;
                    }
                    .btn-user-ip-modal.live {
                        background: #f0f9eb;
                        border-color: #e1f3d8;
                        color: #67c23a;
                        font-weight: 600;
                    }
                    .btn-user-ip-modal.live:hover {
                        background: #e1f3d8;
                        border-color: #67c23a;
                    }
                    .btn-user-ip-modal.history {
                        background: #fafafa;
                        border-color: #dcdfe6;
                        color: #606266;
                        font-family: Consolas, monospace;
                    }
                    .btn-user-ip-modal.history:hover {
                        background: #ecf5ff;
                        border-color: #409eff;
                        color: #409eff;
                    }
                    @keyframes pulseAlert {
                        0% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0.4); }
                        70% { box-shadow: 0 0 0 6px rgba(245, 108, 108, 0); }
                        100% { box-shadow: 0 0 0 0 rgba(245, 108, 108, 0); }
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
                        .table-toolbar {
                            flex-direction: column;
                            align-items: stretch;
                        }
                        .toolbar-left {
                            flex-direction: column;
                            align-items: stretch;
                        }
                        .search-input-wrap {
                            max-width: 100%;
                            width: 100%;
                        }
                        .sort-select, .btn-sort-dir {
                            width: 100%;
                            justify-content: center;
                        }
                        .pagination-container {
                            flex-direction: column;
                            align-items: center;
                            gap: 10px;
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
                            <a href="/v3/admin/logout" class="logout-btn">退出管理</a>
                        </div>
                    </div>

                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-info">
                                <div class="stat-title">全站注册用户</div>
                                <div class="stat-value">${totalUsers} <span class="stat-unit">人</span></div>
                            </div>
                            <div class="stat-icon-wrap c1">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-info">
                                <div class="stat-title">有效通行凭证</div>
                                <div class="stat-value" style="color:var(--el-success);">${activeUsersCount} <span class="stat-unit">活跃</span></div>
                            </div>
                            <div class="stat-icon-wrap c2">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>
                            </div>
                        </div>
                        <div class="stat-card" onclick="openAllVisitorsModal()" style="cursor:pointer;" title="点击查看全站当前实时在线访客与IP归属地">
                            <div class="stat-info">
                                <div class="stat-title">实时活跃连线 (点击监控)</div>
                                <div class="stat-value" style="color:var(--el-warning);">${totalLiveConnections} <span class="stat-unit">连接</span></div>
                            </div>
                            <div class="stat-icon-wrap c3">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2"></circle><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path></svg>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-info">
                                <div class="stat-title">全站已用总流量</div>
                                <div class="stat-value" style="color:var(--el-primary);">${formatBytes(totalTrafficSum)}</div>
                            </div>
                            <div class="stat-icon-wrap c4">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                            </div>
                        </div>
                    </div>

                    <div class="panel">
                        <div class="panel-header">
                            <div class="panel-title">用户清单与权限详情</div>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-primary); font-weight:500;" onclick="openAllVisitorsModal()">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                                    实时访客IP监控
                                </button>
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-main); font-weight:500;" onclick="openSettingsModal()">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                                    站点与注册配置
                                </button>
                                <button class="btn btn-primary" onclick="openAddModal()">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                    新增用户授权
                                </button>
                            </div>
                        </div>

                        <!-- 搜索与排序工具栏 -->
                        <div class="table-toolbar">
                            <div class="toolbar-left">
                                <div class="search-input-wrap">
                                    <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                    <input type="text" id="searchInput" class="search-input" placeholder="输入账号名称或UUID检索..." oninput="onSearchInput(this.value)" />
                                </div>
                                <select id="sortFieldSelect" class="sort-select" onchange="onSortFieldChange(this.value)">
                                    <option value="connections" selected>按在线活跃倒序 (在线且时间最近在最上)</option>
                                    <option value="register">按最后注册排序</option>
                                    <option value="trafficUsed">按使用流量排序</option>
                                    <option value="trafficLimit">按总流量配额排序</option>
                                </select>
                                <button id="sortOrderBtn" class="btn-sort-dir" onclick="toggleSortOrder()" title="点击切换正序/倒序">
                                    <span id="sortOrderIcon">↓</span>
                                    <span id="sortOrderText">倒序</span>
                                </button>
                            </div>
                            <div class="toolbar-right" id="toolbarStats">
                                正在计算...
                            </div>
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
                                        <th>使用者IP详情</th>
                                        <th>专属订阅 (普通 / Clash)</th>
                                        <th>运维操作</th>
                                    </tr>
                                </thead>
                                <tbody id="usersTableBody"></tbody>
                            </table>
                        </div>

                        <!-- 分页条 (每页固定10人) -->
                        <div class="pagination-container" id="paginationContainer">
                            <div class="pagination-info" id="paginationInfo">正在载入用户数据...</div>
                            <div class="pagination-controls" id="paginationControls"></div>
                        </div>
                    </div>

                    <!-- 新建用户弹窗 -->
                                        <!-- 站点与集群全量协议配置控制中心模态框 -->
                    <div class="modal-mask" id="settingsModal">
                        <div class="modal" style="max-width: 640px; max-height: 90vh; overflow-y: auto;">
                            <h4>⚙️ 节点集群与参数控制中心</h4>
                            
                            <!-- 选项卡切换器 -->
                            <div style="display:flex; border-bottom:2px solid #ebeef5; margin-bottom:16px; gap:6px;">
                                <button type="button" class="tab-btn active" id="tab_btn_ops" onclick="switchSettingsTab('ops')" style="padding:8px 14px; background:none; border:none; border-bottom:2px solid var(--el-primary); font-weight:600; color:var(--el-primary); cursor:pointer; font-size:13px;">🏢 运营与注册</button>
                                <button type="button" class="tab-btn" id="tab_btn_proto" onclick="switchSettingsTab('proto')" style="padding:8px 14px; background:none; border:none; border-bottom:2px solid transparent; font-weight:500; color:var(--el-text-regular); cursor:pointer; font-size:13px;">⚡ 节点协议与端口</button>
                                <button type="button" class="tab-btn" id="tab_btn_net" onclick="switchSettingsTab('net')" style="padding:8px 14px; background:none; border:none; border-bottom:2px solid transparent; font-weight:500; color:var(--el-text-regular); cursor:pointer; font-size:13px;">🌐 网络与公网IP</button>
                            </div>

                            <!-- TAB 1: 运营与注册 -->
                            <div id="tab_content_ops">
                                <div class="field-box">
                                    <label>推荐客户端下载 (FlClash 各平台全适配)</label>
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding:8px 12px; background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px;">
                                        <div style="display:flex; gap:16px;">
                                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
                                                <input type="radio" name="set_enableClientDownload" value="1" id="set_enableClientDownload_1" />
                                                <span style="color:var(--el-success); font-weight:600;">开启推荐客户端</span>
                                            </label>
                                            <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
                                                <input type="radio" name="set_enableClientDownload" value="0" id="set_enableClientDownload_0" />
                                                <span style="color:var(--el-danger); font-weight:600;">关闭显示</span>
                                            </label>
                                        </div>
                                        <button type="button" class="btn" style="padding:4px 10px; font-size:12px; background:#ffffff; border:1px solid var(--el-border); color:var(--el-primary);" onclick="manualSyncClientDownloads(this)">
                                            🔄 立即爬取同步
                                        </button>
                                    </div>
                                </div>
                                <div class="field-box">
                                    <label>开放游客自主注册</label>
                                    <div style="display:flex; gap:16px; margin-top:8px; padding:8px 12px; background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px;">
                                        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
                                            <input type="radio" name="set_allowRegister" value="1" id="set_allowRegister_1" />
                                            <span style="color:var(--el-success); font-weight:600;">允许自主注册</span>
                                        </label>
                                        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;">
                                            <input type="radio" name="set_allowRegister" value="0" id="set_allowRegister_0" />
                                            <span style="color:var(--el-danger); font-weight:600;">关闭注册 (仅站长添加)</span>
                                        </label>
                                    </div>
                                </div>
                                <div style="display:flex; gap:12px;">
                                    <div class="field-box" style="flex:1;">
                                        <label>注册试用天数 (天)</label>
                                        <input type="number" id="set_defaultDays" placeholder="例如: 3" value="3" min="0" />
                                    </div>
                                    <div class="field-box" style="flex:1.2;">
                                        <label>注册初始流量配额</label>
                                        <div class="input-unit-group" style="display:flex; gap:6px;">
                                            <input type="number" id="set_defaultTrafficVal" step="0.1" placeholder="例如: 10" value="10" min="0" style="flex:2;" />
                                            <select id="set_defaultTrafficUnit" style="flex:1; border:1px solid var(--el-border); border-radius:6px; padding:0 8px; background:#ffffff; font-size:13px; color:var(--el-text-main);">
                                                <option value="MB">MB</option>
                                                <option value="GB" selected>GB</option>
                                                <option value="TB">TB</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                                <div class="field-box">
                                    <label>站长联系方式展示文案</label>
                                    <input type="text" id="set_contactText" placeholder="例如: Telegram: @mybot 或 微信: abc" />
                                </div>
                                <div class="field-box">
                                    <label>站长联系直达链接 (URL)</label>
                                    <input type="text" id="set_contactUrl" placeholder="例如: https://t.me/mybot (无跳转可留空)" />
                                </div>
                            </div>

                            <!-- TAB 2: 节点协议与端口 -->
                            <div id="tab_content_proto" style="display:none;">
                                <div style="font-size:12px; color:var(--el-text-secondary); margin-bottom:12px; background:#f0f2f5; padding:8px 12px; border-radius:6px;">
                                    💡 提示：端口填写为 0 或留空即代表禁用对应协议；保存后系统将自动更新 .env 并平滑热重载 Sing-box 核心。
                                </div>

                                <!-- Hysteria 2 -->
                                <div style="background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px; margin-bottom:12px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <div style="font-weight:600; font-size:13px; color:#2c3e50;">🚀 Hysteria 2 协议 (UDP/QUIC 抗丢包)</div>
                                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                                            <input type="checkbox" id="env_ENABLE_HY2" /> 启用该协议
                                        </label>
                                    </div>
                                    <div style="display:flex; gap:10px;">
                                        <div class="field-box" style="flex:1; margin-bottom:0;">
                                            <label style="font-size:11px;">监听端口 (PORT_HY2)</label>
                                            <input type="number" id="env_PORT_HY2" placeholder="如: 10800" />
                                        </div>
                                        <div class="field-box" style="flex:1.5; margin-bottom:0;">
                                            <label style="font-size:11px;">端口跳跃范围 (例: 10900-10909)</label>
                                            <input type="text" id="env_HY2_HOP_PORTS" placeholder="留空则不开启跳跃" />
                                        </div>
                                    </div>
                                </div>

                                <!-- TUIC v5 -->
                                <div style="background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px; margin-bottom:12px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <div style="font-weight:600; font-size:13px; color:#2c3e50;">⚡ TUIC v5 协议 (0-RTT 极低延迟)</div>
                                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                                            <input type="checkbox" id="env_ENABLE_TUIC" /> 启用该协议
                                        </label>
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:11px;">监听端口 (PORT_TUIC)</label>
                                        <input type="number" id="env_PORT_TUIC" placeholder="如: 10801" />
                                    </div>
                                </div>

                                <!-- VLESS-Reality -->
                                <div style="background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px; margin-bottom:12px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                        <div style="font-weight:600; font-size:13px; color:#2c3e50;">🛡️ VLESS Reality (0 特征/偷跑证书)</div>
                                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                                            <input type="checkbox" id="env_ENABLE_REALITY" /> 启用该协议
                                        </label>
                                    </div>
                                    <div style="display:flex; gap:10px;">
                                        <div class="field-box" style="flex:1; margin-bottom:0;">
                                            <label style="font-size:11px;">监听端口 (PORT_REALITY)</label>
                                            <input type="number" id="env_PORT_REALITY" placeholder="如: 10802" />
                                        </div>
                                        <div class="field-box" style="flex:1.5; margin-bottom:0;">
                                            <label style="font-size:11px;">伪装偷跑域名 (REALITY_DEST)</label>
                                            <input type="text" id="env_REALITY_DEST" placeholder="addons.mozilla.org" />
                                        </div>
                                    </div>
                                </div>

                                <!-- 直连 TCP 协议 -->
                                <div style="display:flex; gap:10px; margin-bottom:12px;">
                                    <div style="flex:1; background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                            <span style="font-weight:600; font-size:12px;">VLESS-TCP 直连</span>
                                            <input type="checkbox" id="env_ENABLE_VLESS_TCP" />
                                        </div>
                                        <input type="number" id="env_PORT_VLESS_TCP" placeholder="端口如: 10803" />
                                    </div>
                                    <div style="flex:1; background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                            <span style="font-weight:600; font-size:12px;">Trojan-TCP 直连</span>
                                            <input type="checkbox" id="env_ENABLE_TROJAN_TCP" />
                                        </div>
                                        <input type="number" id="env_PORT_TROJAN_TCP" placeholder="端口如: 10804" />
                                    </div>
                                </div>

                                <!-- Shadowsocks 2022 (AEAD 多用户独立密钥) -->
                                <div style="background:#f8f9fa; border:1px solid var(--el-border); border-radius:6px; padding:10px 12px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                        <div>
                                            <span style="font-weight:600; font-size:12px; color:#2c3e50;">🔒 Shadowsocks 2022 (AEAD 多用户专属密钥模式)</span>
                                            <span style="font-size:11px; color:var(--el-success); margin-left:6px;">• 严格跟随用户到期断流</span>
                                        </div>
                                        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
                                            <input type="checkbox" id="env_ENABLE_SS" /> 启用该协议
                                        </label>
                                    </div>
                                    <div class="field-box" style="margin-bottom:0;">
                                        <label style="font-size:11px;">监听端口 (PORT_SS)</label>
                                        <input type="number" id="env_PORT_SS" placeholder="端口如: 10805" />
                                    </div>
                                </div>
                            </div>

                            <!-- TAB 3: 原生直连网络模式 -->
                            <div id="tab_content_net" style="display:none;">
                                <div style="background:#f0f9eb; border:1px solid #c2e7b0; border-radius:6px; padding:12px 14px; margin-bottom:14px; color:#67c23a;">
                                    <div style="font-size:13px; font-weight:600; margin-bottom:4px;">⚡ 已启用纯原生直连网络架构 (零隧道开销)</div>
                                    <div style="font-size:12px; color:#529b2e;">所有节点直接绑定 VPS 真实公网 IP，彻底剔除 Cloudflared 隧道长连接，释放 35MB+ 内存，大幅削减 CPU 占用。</div>
                                </div>

                                <div class="field-box">
                                    <label>宿主机外网公网 IPv4 (SERVER_IP / DIRECT_IP)</label>
                                    <input type="text" id="env_DIRECT_IP" placeholder="留空则由系统权威接口自动探测真实公网 IP" />
                                    <span style="font-size:11px; color:var(--el-text-secondary); margin-top:4px; display:block;">留空时由服务器自动探测并广播公网 IP，换 VPS 机房或云服务器迁移时通常保持留空即可。</span>
                                </div>
                            </div>

                            <div class="modal-footer" style="margin-top:16px;">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeSettingsModal()">取消</button>
                                <button class="btn btn-primary" id="saveSettingsBtn" onclick="saveSiteSettings()">保存所有配置</button>
                            </div>
                        </div>
                    </div>

                    <div class="modal-mask" id="addModal">
                        <div class="modal">
                            <h4>新增用户授权</h4>
                            <div class="field-box">
                                <label>用户账号名称</label>
                                <input type="text" id="add_user" placeholder="请输入用户名" />
                            </div>
                            <div class="field-box">
                                <label style="display:flex; justify-content:space-between; align-items:center;">
                                    <span>节点通行凭证 (UUID)</span>
                                    <button type="button" class="btn" style="padding:2px 8px; font-size:11px; background:var(--el-primary-light); color:var(--el-primary); border:1px solid var(--el-primary-border);" onclick="generateNewAddUuid()">🎲 随机生成</button>
                                </label>
                                <input type="text" id="add_uuid" placeholder="留空则自动随机生成" style="font-family:Consolas, monospace; font-size:12px;" />
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
                            <div class="field-box">
                                <label>多端并发限制规则 (最大同时在线 IP 数，0 为不限)</label>
                                <div style="display:flex; gap:8px;">
                                    <input type="number" id="add_max_ips" min="0" placeholder="0 为不限制" value="0" style="flex:1;" />
                                    <select id="add_ip_policy" style="flex:1.5;">
                                        <option value="kick_oldest">超限踢出最早设备 (推荐)</option>
                                        <option value="reject_new">超限拒绝新设备握手</option>
                                    </select>
                                </div>
                            </div>
                            <div class="field-box">
                                <label>无连接信息产生就断链 (空闲超时守护)</label>
                                <div style="display:flex; gap:8px;">
                                    <select id="add_idle_enabled" style="flex:1.5;">
                                        <option value="true">开启空闲自动断链</option>
                                        <option value="false">关闭 (保持空闲挂起)</option>
                                    </select>
                                    <div style="flex:1; display:flex; align-items:center; gap:4px;">
                                        <input type="number" id="add_idle_sec" min="10" max="3600" value="60" style="width:100%;" />
                                        <span style="font-size:12px; color:var(--el-text-secondary);">秒</span>
                                    </div>
                                </div>
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
                            <div class="field-box">
                                <label style="display:flex; justify-content:space-between; align-items:center;">
                                    <span>节点通行凭证 (UUID)</span>
                                    <button type="button" class="btn" style="padding:2px 8px; font-size:11px; background:var(--el-warning-light); color:var(--el-warning); border:1px solid var(--el-warning-border);" onclick="generateNewEditUuid()">🎲 随机换新UUID</button>
                                </label>
                                <div style="display:flex; gap:6px;">
                                    <input type="text" id="edit_uuid" readonly style="font-family:Consolas, monospace; font-size:12px; background:#f5f7fa; color:var(--el-text-main); flex:1;" />
                                </div>
                                <span style="font-size:11px; color:var(--el-text-secondary); margin-top:3px; display:block;">更换后旧订阅立即作废，该用户当前已建立的所有长连接将被瞬间切断</span>
                            </div>
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
                            <div class="field-box">
                                <label>多端并发限制规则 (最大同时在线 IP 数，0 为不限)</label>
                                <div style="display:flex; gap:8px;">
                                    <input type="number" id="edit_max_ips" min="0" placeholder="0 为不限制" style="flex:1;" />
                                    <select id="edit_ip_policy" style="flex:1.5;">
                                        <option value="kick_oldest">超限踢出最早设备 (推荐)</option>
                                        <option value="reject_new">超限拒绝新设备握手</option>
                                    </select>
                                </div>
                            </div>
                            <div class="field-box">
                                <label>无连接信息产生就断链 (空闲超时清理开关)</label>
                                <div style="display:flex; gap:8px;">
                                    <select id="edit_idle_enabled" style="flex:1.5;">
                                        <option value="true">开启空闲自动断链 (防僵尸占用)</option>
                                        <option value="false">关闭 (允许长期无流量保持)</option>
                                    </select>
                                    <div style="flex:1; display:flex; align-items:center; gap:4px;">
                                        <input type="number" id="edit_idle_sec" min="10" max="3600" value="60" style="width:100%;" />
                                        <span style="font-size:12px; color:var(--el-text-secondary);">秒</span>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-footer">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeEditModal()">取消</button>
                                <button class="btn btn-primary" id="saveEditBtn" onclick="submitEdit()">保存更新</button>
                            </div>
                        </div>
                    </div>

                    <!-- 用户专属 IP 连线与使用者信息详情弹窗 -->
                    <div class="modal-mask" id="userIpDetailModal">
                        <div class="modal modal-large">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                                <h4 style="margin:0; display:flex; align-items:center; gap:8px;">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" color="var(--el-primary)"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                                    <span id="userIpDetailTitle">使用者 IP 连线详情</span>
                                </h4>
                                <div style="display:flex; gap:8px; align-items:center;">
                                    <button id="userIpSortToggleBtn" class="btn" style="padding:4px 10px; font-size:12px; background:#f4f4f5; border:1px solid var(--el-border); color:var(--el-text-main); font-weight:600; cursor:pointer;" onclick="toggleUserIpModalSort()" title="点击在倒序(最新在前)与正序(最早在前)之间自由切换">
                                        <span id="userIpSortIcon">↓</span> <span id="userIpSortText">倒序 (最新在前)</span>
                                    </button>
                                    <button class="btn" style="padding:4px 10px; font-size:12px; background:#ffffff; border:1px solid var(--el-border); color:var(--el-primary);" onclick="refreshUserIpModal()">刷新数据</button>
                                </div>
                            </div>

                            <!-- 异地异常或并发警告横幅 -->
                            <div id="userIpDetailAlert" style="margin-bottom:12px;"></div>

                            <!-- 实时活跃连线区域 -->
                            <div style="margin-bottom:14px;">
                                <div style="font-size:13px; font-weight:600; color:var(--el-text-main); margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;">
                                    <span>🟢 当前实时在线连线 (支持多端共用 - 倒序查看)</span>
                                    <span style="font-size:12px; font-weight:normal; color:var(--el-text-secondary);" id="userIpLiveCount">0 个在线连接</span>
                                </div>
                                <div class="visitors-table-wrapper" style="max-height:220px; margin-bottom:0;">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th style="width:85px;">协议类型</th>
                                                <th style="width:150px;">访问者真实 IP</th>
                                                <th>IP138 级省市与运营商归属地</th>
                                                <th style="width:180px; cursor:pointer;" onclick="toggleUserIpModalSort()" title="点击切换按时间正序/倒序排列">
                                                    连入时刻 / 时长 <span id="thSortIcon" style="color:var(--el-primary); font-weight:bold;">↓ (最新)</span>
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody id="userIpDetailTableBody"></tbody>
                                    </table>
                                </div>
                            </div>

                            <!-- 历史与风控规则区域 -->
                            <div style="background:#fafafa; border:1px solid #ebeef5; border-radius:6px; padding:12px 16px; margin-bottom:14px;">
                                <div style="font-size:13px; font-weight:600; color:var(--el-text-main); margin-bottom:8px;">📌 最近历史记录与风控规则</div>
                                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; font-size:12px; color:#606266;">
                                    <div>最近连线 IP: <strong id="userIpDetailLastIp" style="font-family:Consolas, monospace; color:var(--el-primary); cursor:pointer;">-</strong></div>
                                    <div>最近归属地: <span id="userIpDetailLastGeo" style="color:#303133;">-</span></div>
                                    <div>最后活跃时间: <span id="userIpDetailLastSeen">-</span></div>
                                    <div>最大并发限制: <span id="userIpDetailMaxIps" style="font-weight:600; color:#303133;">2 个 IP</span></div>
                                    <div>空闲自动断链: <span id="userIpDetailIdleSec" style="color:var(--el-success); font-weight:600;">开启 (60秒)</span></div>
                                </div>
                            </div>

                            <div class="modal-footer" style="margin-top:0; padding-top:10px; display:flex; justify-content:flex-end;">
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeUserIpModal()">关闭窗口</button>
                            </div>
                        </div>
                    </div>

                    <!-- 全站实时访客与真实 IP 归属地监控弹窗 (IP138级) -->
                    <div class="modal-mask" id="visitorsModal">
                        <div class="modal modal-large">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                                <h4 style="margin:0; display:flex; align-items:center; gap:8px;">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" color="var(--el-primary)"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                                    <span id="visitorsModalTitle">全站实时在线访客与 IP 归属地监控</span>
                                </h4>
                                <div style="display:flex; gap:8px; align-items:center;">
                                    <span id="visitorsAutoRefreshStatus" style="font-size:12px; color:var(--el-success); display:flex; align-items:center; gap:4px;">
                                        <span class="badge-dot-live"></span>每4秒自动刷新
                                    </span>
                                    <button class="btn" style="padding:4px 10px; font-size:12px; background:#ffffff; border:1px solid var(--el-border);" onclick="fetchVisitors(true)">手动刷新</button>
                                </div>
                            </div>
                            <div class="visitors-table-wrapper">
                                <table>
                                    <thead>
                                        <tr>
                                            <th style="width:140px;">连线账号</th>
                                            <th style="width:90px;">协议类型</th>
                                            <th style="width:150px;">访问者真实 IP</th>
                                            <th>IP 归属地与运营商 (IP138级)</th>
                                            <th style="width:130px;">已连接时长 (最新在前)</th>
                                            <th style="width:80px; text-align:center;">状态</th>
                                        </tr>
                                    </thead>
                                    <tbody id="visitorsTableBody">
                                        <tr><td colspan="6" style="text-align:center; padding:30px 0; color:var(--el-text-secondary);">正在拉取实时访客连线...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                            <div class="modal-footer" style="margin-top:10px; padding-top:10px; display:flex; justify-content:space-between; align-items:center;">
                                <div style="font-size:12px; color:var(--el-text-secondary);" id="visitorsSummary">当前活跃连线: 0</div>
                                <button class="btn" style="background:#ffffff; border:1px solid var(--el-border); color:var(--el-text-regular);" onclick="closeVisitorsModal()">关闭窗口</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    // 注入全量用户数据与全局配置
                    window.__CLIENT_USERS__ = ${clientUsersJson};
                    window.__SITE_SETTINGS__ = ${clientSettingsJson};

                    function getAdminToken() {
                        const q = new URLSearchParams(location.search);
                        if (q.get("token")) return q.get("token");
                        const m = (document.cookie || "").match(/v3_admin_token=([^;]+)/);
                        if (m) return m[1];
                        return "";
                    }

                    function switchSettingsTab(tabKey) {
                        const tabs = ["ops", "proto", "net"];
                        tabs.forEach((k) => {
                            const btn = document.getElementById("tab_btn_" + k);
                            const content = document.getElementById("tab_content_" + k);
                            if (btn && content) {
                                if (k === tabKey) {
                                    btn.style.borderBottom = "2px solid var(--el-primary)";
                                    btn.style.color = "var(--el-primary)";
                                    btn.style.fontWeight = "600";
                                    content.style.display = "block";
                                } else {
                                    btn.style.borderBottom = "2px solid transparent";
                                    btn.style.color = "var(--el-text-regular)";
                                    btn.style.fontWeight = "500";
                                    content.style.display = "none";
                                }
                            }
                        });
                    }

                    async function openSettingsModal() {
                        const token = getAdminToken();
                        const basePrefix = location.pathname.startsWith("/v3") ? "/v3" : "";
                        try {
                            const res = await fetch(basePrefix + "/admin/api/settings" + (token ? "?token=" + encodeURIComponent(token) : ""), {
                                headers: token ? { "x-admin-token": token } : {}
                            });
                            if (res.ok) {
                                const realSettings = await res.json();
                                window.__SITE_SETTINGS__ = Object.assign({}, window.__SITE_SETTINGS__ || {}, realSettings);
                            }
                        } catch (_) {}

                        const s = window.__SITE_SETTINGS__ || {};
                        const env = s.envSettings || {};

                        // 填充运营配置
                        const reg1 = document.getElementById("set_allowRegister_1");
                        const reg0 = document.getElementById("set_allowRegister_0");
                        if (reg1 && reg0) {
                            if (s.allowRegister !== false) reg1.checked = true;
                            else reg0.checked = true;
                        }
                        const dInput = document.getElementById("set_defaultDays");
                        if (dInput) dInput.value = s.defaultDays !== undefined ? s.defaultDays : 3;

                        const tVal = s.defaultTrafficVal !== undefined ? s.defaultTrafficVal : (s.defaultTrafficGB !== undefined ? s.defaultTrafficGB : 10);
                        const tUnit = s.defaultTrafficUnit || "GB";
                        const tValInput = document.getElementById("set_defaultTrafficVal");
                        if (tValInput) tValInput.value = tVal;
                        const tUnitSelect = document.getElementById("set_defaultTrafficUnit");
                        if (tUnitSelect) tUnitSelect.value = tUnit;

                        const cText = document.getElementById("set_contactText");
                        if (cText) cText.value = s.contactText || "";

                        const cUrl = document.getElementById("set_contactUrl");
                        if (cUrl) cUrl.value = s.contactUrl || "";

                        const cd1 = document.getElementById("set_enableClientDownload_1");
                        const cd0 = document.getElementById("set_enableClientDownload_0");
                        if (cd1 && cd0) {
                            if (s.enableClientDownload !== false) cd1.checked = true;
                            else cd0.checked = true;
                        }

                        // 填充协议与端口配置
                        const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = Boolean(val); };
                        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val !== undefined && val !== null ? val : ""; };

                        setCheck("env_ENABLE_HY2", env.ENABLE_HY2 !== false);
                        setVal("env_PORT_HY2", env.PORT_HY2 || "");
                        setVal("env_HY2_HOP_PORTS", env.HY2_HOP_PORTS || "");

                        setCheck("env_ENABLE_TUIC", env.ENABLE_TUIC !== false);
                        setVal("env_PORT_TUIC", env.PORT_TUIC || "");

                        setCheck("env_ENABLE_REALITY", env.ENABLE_REALITY !== false);
                        setVal("env_PORT_REALITY", env.PORT_REALITY || "");
                        setVal("env_REALITY_DEST", env.REALITY_DEST || "addons.mozilla.org");

                        setCheck("env_ENABLE_VLESS_TCP", env.ENABLE_VLESS_TCP !== false);
                        setVal("env_PORT_VLESS_TCP", env.PORT_VLESS_TCP || "");

                        setCheck("env_ENABLE_TROJAN_TCP", env.ENABLE_TROJAN_TCP !== false);
                        setVal("env_PORT_TROJAN_TCP", env.PORT_TROJAN_TCP || "");

                        setCheck("env_ENABLE_SS", env.ENABLE_SS !== false);
                        setVal("env_PORT_SS", env.PORT_SS || "");

                        setVal("env_DIRECT_IP", env.DIRECT_IP || "");

                        switchSettingsTab("ops");
                        const modal = document.getElementById("settingsModal");
                        if (modal) modal.style.display = "flex";
                    }

                    async function manualSyncClientDownloads(btn) {
                        const originText = btn.innerText;
                        btn.innerText = "爬取中...";
                        btn.disabled = true;
                        const token = getAdminToken();
                        try {
                            const basePrefix = location.pathname.startsWith("/v3") ? "/v3" : "";
                            const reqUrl = basePrefix + "/admin/api/sync-client-downloads" + (token ? "?token=" + encodeURIComponent(token) : "");
                            const reqHeaders = {};
                            if (token) reqHeaders["x-admin-token"] = token;
                            const res = await fetch(reqUrl, { method: "POST", headers: reqHeaders });
                            const data = await res.json();
                            if (res.ok) {
                                alert("爬取同步成功！已更新 " + data.count + " 个客户端项目。");
                                location.reload();
                            } else {
                                alert("同步失败: " + (data.error || "未知异常"));
                            }
                        } catch (e) {
                            alert("异常: " + e.message);
                        } finally {
                            btn.innerText = originText;
                            btn.disabled = false;
                        }
                    }

                    function closeSettingsModal() {
                        const modal = document.getElementById("settingsModal");
                        if (modal) modal.style.display = "none";
                    }

                    async function saveSiteSettings() {
                        const reg1 = document.getElementById("set_allowRegister_1");
                        const allowRegister = reg1 ? reg1.checked : true;
                        const defaultDays = parseInt(document.getElementById("set_defaultDays").value, 10) || 0;
                        const defaultTrafficVal = parseFloat(document.getElementById("set_defaultTrafficVal").value) || 0;
                        const defaultTrafficUnit = document.getElementById("set_defaultTrafficUnit").value || "GB";
                        const contactText = document.getElementById("set_contactText").value.trim();
                        const contactUrl = document.getElementById("set_contactUrl").value.trim();
                        const cd1 = document.getElementById("set_enableClientDownload_1");
                        const enableClientDownload = cd1 ? cd1.checked : true;

                        // 读取全量协议与原生网络变量
                        const getCheck = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
                        const getInt = (id) => { const el = document.getElementById(id); return el && el.value ? parseInt(el.value, 10) || 0 : 0; };
                        const getStr = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };

                        const envSettings = {
                            ENABLE_HY2: getCheck("env_ENABLE_HY2"),
                            PORT_HY2: getInt("env_PORT_HY2"),
                            ENABLE_HY2_HOP: Boolean(getStr("env_HY2_HOP_PORTS")),
                            HY2_HOP_PORTS: getStr("env_HY2_HOP_PORTS"),
                            ENABLE_TUIC: getCheck("env_ENABLE_TUIC"),
                            PORT_TUIC: getInt("env_PORT_TUIC"),
                            ENABLE_REALITY: getCheck("env_ENABLE_REALITY"),
                            PORT_REALITY: getInt("env_PORT_REALITY"),
                            REALITY_DEST: getStr("env_REALITY_DEST") || "addons.mozilla.org",
                            ENABLE_VLESS_TCP: getCheck("env_ENABLE_VLESS_TCP"),
                            PORT_VLESS_TCP: getInt("env_PORT_VLESS_TCP"),
                            ENABLE_TROJAN_TCP: getCheck("env_ENABLE_TROJAN_TCP"),
                            PORT_TROJAN_TCP: getInt("env_PORT_TROJAN_TCP"),
                            ENABLE_SS: getCheck("env_ENABLE_SS"),
                            PORT_SS: getInt("env_PORT_SS"),
                            DIRECT_IP: getStr("env_DIRECT_IP")
                        };

                        const btn = document.getElementById("saveSettingsBtn");
                        const originText = btn ? btn.innerText : "保存所有配置";
                        if (btn) {
                            btn.innerText = "正在落盘并热重载...";
                            btn.disabled = true;
                        }

                        const token = getAdminToken();
                        const basePrefix = location.pathname.startsWith("/v3") ? "/v3" : "";
                        const reqUrl = basePrefix + "/admin/api/settings" + (token ? "?token=" + encodeURIComponent(token) : "");
                        const reqHeaders = { "Content-Type": "application/json" };
                        if (token) reqHeaders["x-admin-token"] = token;

                        try {
                            const res = await fetch(reqUrl, {
                                method: "POST",
                                headers: reqHeaders,
                                body: JSON.stringify({
                                    allowRegister,
                                    enableClientDownload,
                                    defaultDays,
                                    defaultTrafficVal,
                                    defaultTrafficUnit,
                                    contactText,
                                    contactUrl,
                                    envSettings
                                })
                            });
                            const text = await res.text();
                            let data = {};
                            try { data = JSON.parse(text || "{}"); } catch (_) {}
                            if (res.ok) {
                                window.__SITE_SETTINGS__ = Object.assign({}, data.settings || {}, { envSettings });
                                alert("✅ 站点运营与全部协议变量已成功保存并立即落盘热生效！");
                                closeSettingsModal();
                                const contactDisplay = document.querySelector(".contact-display-val");
                                if (contactDisplay) contactDisplay.innerText = contactText || "未设置";
                            } else {
                                alert("❌ 保存失败: " + (data.error || text || "未授权或服务器异常"));
                            }
                        } catch (e) {
                            alert("❌ 网络请求异常: " + e.message);
                        } finally {
                            if (btn) {
                                btn.innerText = originText;
                                btn.disabled = false;
                            }
                        }
                    }

                    // 分页与排序全局状态
                    let allUsers = Array.isArray(window.__CLIENT_USERS__) ? window.__CLIENT_USERS__ : [];
                    let currentPage = 1;
                    const pageSize = 10;
                    let searchQuery = "";
                    let sortField = "connections";  // 默认按在线状态与活跃时间倒序
                    let sortOrder = "desc";         // 'desc' | 'asc'

                    function onSearchInput(val) {
                        searchQuery = (val || "").trim().toLowerCase();
                        currentPage = 1;
                        renderTable();
                    }

                    function onSortFieldChange(val) {
                        sortField = val;
                        currentPage = 1;
                        renderTable();
                    }

                    function toggleSortOrder() {
                        sortOrder = (sortOrder === "desc" ? "asc" : "desc");
                        const iconEl = document.getElementById("sortOrderIcon");
                        const textEl = document.getElementById("sortOrderText");
                        if (iconEl) iconEl.innerText = (sortOrder === "desc" ? "↓" : "↑");
                        if (textEl) textEl.innerText = (sortOrder === "desc" ? "倒序" : "正序");
                        currentPage = 1;
                        renderTable();
                    }

                    function getFilteredAndSortedUsers() {
                        let list = allUsers.slice();

                        // 1. 按照用户名或 UUID 关键字模糊搜索
                        if (searchQuery) {
                            list = list.filter(u => {
                                const uname = (u.username || "").toLowerCase();
                                const uuid = (u.uuid || "").toLowerCase();
                                return uname.includes(searchQuery) || uuid.includes(searchQuery);
                            });
                        }

                        // 2. 排序比对逻辑
                        list.sort((a, b) => {
                            let diff = 0;
                            if (sortField === "register") {
                                // 按最后注册时间排序
                                const aTime = a.createdAt || a.idx || 0;
                                const bTime = b.createdAt || b.idx || 0;
                                diff = aTime - bTime;
                            } else if (sortField === "trafficUsed") {
                                // 按使用流量排序
                                diff = (a.trafficUsed || 0) - (b.trafficUsed || 0);
                            } else if (sortField === "trafficLimit") {
                                // 按总流量配额排序
                                diff = (a.trafficLimit || 0) - (b.trafficLimit || 0);
                            } else if (sortField === "connections") {
                                // 在线连接数排序 (不在线的按照最后使用时间)
                                const aConn = a.activeConnections || 0;
                                const bConn = b.activeConnections || 0;
                                const aOnline = aConn > 0;
                                const bOnline = bConn > 0;

                                const aSeen = a.lastSeenAt || a.createdAt || 0;
                                const bSeen = b.lastSeenAt || b.createdAt || 0;
                                if (aOnline && bOnline) {
                                    // 都在线：比对最后活跃/在线时间，在线时间最近的在上面
                                    diff = aSeen - bSeen;
                                    if (diff === 0) diff = aConn - bConn;
                                } else if (aOnline && !bOnline) {
                                    // 在线的排在前面
                                    diff = 1;
                                } else if (!aOnline && bOnline) {
                                    // 在线的排在前面
                                    diff = -1;
                                } else {
                                    // 都离线：最后在线活跃时间最近的在上面
                                    diff = aSeen - bSeen;
                                }
                            }

                            return sortOrder === "desc" ? -diff : diff;
                        });

                        return list;
                    }

                    function goToPage(page) {
                        currentPage = page;
                        renderTable();
                    }

                    function renderTable() {
                        const filteredUsers = getFilteredAndSortedUsers();
                        const totalCount = filteredUsers.length;
                        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

                        if (currentPage > totalPages) currentPage = totalPages;
                        if (currentPage < 1) currentPage = 1;

                        const startIdx = (currentPage - 1) * pageSize;
                        const pageUsers = filteredUsers.slice(startIdx, startIdx + pageSize);

                        const tbody = document.getElementById("usersTableBody");
                        if (!tbody) return;

                        if (pageUsers.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:36px 0; color:var(--el-text-secondary);">未检索到匹配的用户记录</td></tr>';
                        } else {
                            tbody.innerHTML = pageUsers.map(function(u) {
                                var statusBadge = '<span class="badge badge-success"><span class="badge-dot"></span>有效活跃</span>';
                                if (!u.enabled) statusBadge = '<span class="badge badge-danger"><span class="badge-dot"></span>手动阻断</span>';
                                else if (u.invalidMsg === "账号已过有效期限") statusBadge = '<span class="badge badge-danger"><span class="badge-dot"></span>已过期</span>';
                                else if (u.invalidMsg === "流量配额已耗尽") statusBadge = '<span class="badge badge-warning"><span class="badge-dot"></span>已超额</span>';

                                // 检测异地并发异常冲突 (只显示“异地异常”四个字，支持点开查看详细)
                                var geoAlertHtml = '';
                                var conns = u.activeList || [];
                                if (conns.length > 1) {
                                    var regionMap = {};
                                    var detailItems = [];
                                    conns.forEach(function(c) {
                                        var loc = c.location || "";
                                        var ip = c.ip || "";
                                        if (!loc || loc === "公网地址" || loc === "局域网 / 回环地址" || loc === "查询中...") {
                                            loc = ip ? ("IP " + ip) : "未知位置";
                                        }
                                        var clean = loc.replace(/中国|省|市/g, " ").trim();
                                        var mainReg = clean.split(/\s+/).slice(0, 2).join(" ");
                                        if (!mainReg) mainReg = loc;
                                        regionMap[mainReg] = (regionMap[mainReg] || 0) + 1;
                                        detailItems.push({
                                            loc: loc,
                                            ip: ip,
                                            proto: c.proto || "WS",
                                            time: c.connectedStr || "刚刚"
                                        });
                                    });
                                    var uniqueRegs = Object.keys(regionMap);
                                    if (uniqueRegs.length >= 2) {
                                        var isExp = window.expandedGeoUuids && window.expandedGeoUuids.has(u.uuid);
                                        var itemsHtml = detailItems.map(function(item) {
                                            return '<div class="geo-detail-item">' +
                                                '<span class="geo-detail-dot">▪</span>' +
                                                '<div class="geo-detail-content">' +
                                                    '<div class="geo-detail-loc">' + escapeHtml(item.loc) + '</div>' +
                                                    '<div class="geo-detail-meta">' + escapeHtml(item.ip) + ' · ' + escapeHtml(item.proto) + ' · ' + escapeHtml(item.time) + '</div>' +
                                                '</div>' +
                                            '</div>';
                                        }).join('');

                                        geoAlertHtml = '<div class="badge-geo-alert" id="geo-btn-' + u.uuid + '" data-uuid="' + u.uuid + '" onclick="toggleGeoDetail(this.dataset.uuid, event)" title="检测到异地多端并发！点击' + (isExp ? '收起' : '展开') + '详细分布">' +
                                            '<span>🚨 异地异常</span>' +
                                            '<span class="geo-arrow" id="geo-arrow-' + u.uuid + '">' + (isExp ? '▲' : '▼') + '</span>' +
                                        '</div>' +
                                        '<div class="geo-detail-box" id="geo-box-' + u.uuid + '" style="' + (isExp ? 'display:block;' : 'display:none;') + '" onclick="event.stopPropagation();">' +
                                            '<div style="font-size:10px; color:#909399; margin-bottom:4px; font-weight:600;">共检测到 ' + uniqueRegs.length + ' 处不同地区连线：</div>' +
                                            itemsHtml +
                                            '<div class="geo-detail-footer">' +
                                                '<a href="javascript:void(0)" data-uuid="' + u.uuid + '" onclick="openUserIpModal(this.dataset.uuid); event.stopPropagation();">查看完整管理弹窗 &raquo;</a>' +
                                            '</div>' +
                                        '</div>';
                                    }
                                }

                                // 1. 实时在线感知列 (状态与并发端数)
                                var onlineBadge = '';
                                if (u.activeConnections > 0) {
                                    onlineBadge = '<div style="display:flex; flex-direction:column; gap:3px;">' +
                                        '<span class="badge-online-live"><span class="badge-dot-live"></span>在线 (' + u.activeConnections + ' 连线)</span>';
                                    if (geoAlertHtml) {
                                        onlineBadge += geoAlertHtml;
                                    } else if (u.activeConnections > 1) {
                                        onlineBadge += '<span class="badge-multi-online" title="检测到多个不同客户端/IP同时在线连接">👥 ' + u.activeConnections + ' 端并发共用</span>';
                                    }
                                    onlineBadge += '</div>';
                                } else {
                                    onlineBadge = '<span class="badge-online-offline">⚪ 离线 (' + (u.lastSeenStr || "从未在线") + ')</span>';
                                }

                                // 2. 独立新增列：使用者IP详情 (弹窗形式查看，彻底告别拥挤)
                                var userIpHtml = '';
                                var conns = u.activeList || [];
                                if (u.activeConnections > 0) {
                                    var btnText = '🟢 ' + conns.length + '端在线 🔍';
                                    if (geoAlertHtml) btnText = '🚨 ' + conns.length + '端(异地) 🔍';
                                    userIpHtml = '<button class="btn-user-ip-modal live" data-uuid="' + u.uuid + '" onclick="openUserIpModal(this.dataset.uuid)" title="点击弹窗查看当前全部 ' + conns.length + ' 个使用者的真实IP与归属地">' + btnText + '</button>';
                                } else if (u.lastIp) {
                                    userIpHtml = '<button class="btn-user-ip-modal history" data-uuid="' + u.uuid + '" onclick="openUserIpModal(this.dataset.uuid)" title="点击弹窗查看该账号最近连接历史及IP138归属地">' + u.lastIp + ' 🔍</button>';
                                } else {
                                    userIpHtml = '<span style="color:var(--el-text-secondary); font-size:12px;">无连线记录</span>';
                                }

                                var safeUname = (u.username || "").replace(/"/g, '&quot;');
                                var avatarChar = (u.username || "?").substring(0, 1).toUpperCase();
                                var uuidSub = (u.uuid || "").substring(0, 8) + '...';

                                // 计算流量百分比与胶囊进度条颜色
                                var pct = 0;
                                if (u.trafficLimit > 0) {
                                    pct = Math.min(100, Math.round((u.trafficUsed / u.trafficLimit) * 1000) / 10);
                                }
                                var barColor = 'var(--el-primary)';
                                if (pct >= 100) barColor = 'var(--el-danger)';
                                else if (pct >= 85) barColor = 'var(--el-warning)';

                                var row = '<tr>';
                                row += '<td data-label="用户主体">';
                                row +=   '<div class="user-cell">';
                                row +=     '<span class="avatar">' + avatarChar + '</span>';
                                row +=     '<div class="user-info">';
                                row +=       '<span class="uname">' + escapeHtml(u.username) + '</span>';
                                row +=       '<div class="uuid-pill" title="完整UUID: ' + u.uuid + ' (点击复制)">';
                                row +=         '<span class="uuid-text" data-copy="' + u.uuid + '" onclick="copyText(this.dataset.copy)">' + uuidSub + '</span>';
                                row +=         '<button type="button" class="btn-mini-icon" data-copy="' + u.uuid + '" onclick="copyText(this.dataset.copy)" title="复制完整UUID">📋</button>';
                                row +=         '<button type="button" class="btn-mini-icon" data-uuid="' + u.uuid + '" data-uname="' + safeUname + '" onclick="quickRotateUuid(this.dataset.uuid, this.dataset.uname)" title="一键随机换新UUID">🎲</button>';
                                row +=       '</div>';
                                row +=     '</div>';
                                row +=   '</div>';
                                row += '</td>';
                                row += '<td data-label="用量/限额">';
                                row +=   '<div class="traffic-progress-wrap">';
                                row +=     '<div class="traffic-progress-bar"><div class="traffic-progress-inner" style="width:' + pct + '%; background:' + barColor + ';"></div></div>';
                                row +=     '<div class="traffic-progress-text"><span>' + u.trafficUsedStr + ' / ' + u.trafficLimitStr + '</span><span style="font-weight:600; color:' + barColor + ';">' + pct + '%</span></div>';
                                row +=   '</div>';
                                row += '</td>';
                                row += '<td data-label="到期时间" class="date-cell">' + u.expireDateStr + '</td>';
                                row += '<td data-label="账号状态">' + statusBadge + '</td>';
                                row += '<td data-label="实时感知">' + onlineBadge + '</td>';
                                row += '<td data-label="使用者IP信息">' + userIpHtml + '</td>';
                                row += '<td data-label="专属订阅">';
                                row +=   '<div class="sub-btn-group">';
                                row +=     '<button class="btn btn-copy-sub" data-copy="' + u.baseSubUrl + '" onclick="copyText(this.dataset.copy)">通用订阅</button>';
                                row +=     '<button class="btn btn-copy-clash" data-copy="' + u.clashSubUrl + '" onclick="copyText(this.dataset.copy)">Clash</button>';
                                row +=   '</div>';
                                row += '</td>';
                                row += '<td data-label="运维操作">';
                                row +=   '<div class="actions-group">';
                                row +=     '<button class="btn-action-edit" data-uuid="' + u.uuid + '" onclick="openEditModal(this.dataset.uuid)">编辑</button>';
                                row +=     '<button class="btn-action-rotate" data-uuid="' + u.uuid + '" data-uname="' + safeUname + '" onclick="quickRotateUuid(this.dataset.uuid, this.dataset.uname)" title="随机换新UUID并热重载">🎲 换UUID</button>';
                                row +=     '<button class="btn-action-reset" data-uuid="' + u.uuid + '" onclick="resetTraffic(this.dataset.uuid)">重置</button>';
                                row +=     '<button class="btn-action-del" data-uuid="' + u.uuid + '" onclick="deleteUser(this.dataset.uuid)">注销</button>';
                                row +=   '</div>';
                                row += '</td>';
                                row += '</tr>';
                                return row;
                            }).join("");
                        }

                        // 更新统计标签
                        var statsEl = document.getElementById("toolbarStats");
                        if (statsEl) {
                            statsEl.innerText = '筛选出 ' + totalCount + ' 位用户 · 每页 ' + pageSize + ' 人';
                        }

                        // 更新分页控件
                        renderPagination(totalCount, totalPages);
                    }

                    function renderPagination(totalCount, totalPages) {
                        var infoEl = document.getElementById("paginationInfo");
                        if (infoEl) {
                            infoEl.innerText = '共 ' + totalCount + ' 位用户 · 第 ' + currentPage + '/' + totalPages + ' 页';
                        }

                        var ctrlEl = document.getElementById("paginationControls");
                        if (!ctrlEl) return;

                        var html = "";
                        // 上一页
                        html += '<button class="page-btn" ' + (currentPage <= 1 ? "disabled" : "") + ' onclick="goToPage(' + (currentPage - 1) + ')">上一页</button>';

                        // 数字页码按钮（支持 1, 2, 3... 折叠）
                        var pagesToShow = [];
                        if (totalPages <= 7) {
                            for (var i = 1; i <= totalPages; i++) pagesToShow.push(i);
                        } else {
                            pagesToShow.push(1);
                            var left = Math.max(2, currentPage - 1);
                            var right = Math.min(totalPages - 1, currentPage + 1);

                            if (currentPage <= 3) {
                                left = 2;
                                right = 4;
                            } else if (currentPage >= totalPages - 2) {
                                left = totalPages - 3;
                                right = totalPages - 1;
                            }

                            if (left > 2) pagesToShow.push("...");
                            for (var j = left; j <= right; j++) pagesToShow.push(j);
                            if (right < totalPages - 1) pagesToShow.push("...");
                            pagesToShow.push(totalPages);
                        }

                        pagesToShow.forEach(function(p) {
                            if (p === "...") {
                                html += '<span class="page-ellipsis">...</span>';
                            } else {
                                var isActive = (p === currentPage);
                                html += '<button class="page-btn ' + (isActive ? "active" : "") + '" onclick="goToPage(' + p + ')">' + p + '</button>';
                            }
                        });

                        // 下一页
                        html += '<button class="page-btn" ' + (currentPage >= totalPages ? "disabled" : "") + ' onclick="goToPage(' + (currentPage + 1) + ')">下一页</button>';

                        ctrlEl.innerHTML = html;
                    }

                    // 初始运行渲染
                    document.addEventListener("DOMContentLoaded", () => {
                        renderTable();
                    });
                    // 保证即时执行
                    renderTable();

                    function detectUserOS() {
                        const ua = (navigator.userAgent || '').toLowerCase();
                        const plat = (navigator.platform || '').toLowerCase();
                        if (ua.includes('android')) return 'android';
                        if (/iphone|ipad|ipod/.test(ua) || (plat === 'macintel' && navigator.maxTouchPoints > 1)) return 'ios';
                        if (ua.includes('windows') || plat.includes('win')) return 'windows';
                        if (ua.includes('macintosh') || plat.includes('mac')) return 'macos';
                        if (ua.includes('linux') || plat.includes('linux')) return 'linux';
                        return 'unknown';
                    }

                    function autoHighlightRecommendedClient() {
                        const tbody = document.getElementById('clientDownloadTableBody');
                        if (!tbody) return;
                        const os = detectUserOS();
                        const rows = Array.from(tbody.querySelectorAll('tr'));
                        if (!rows.length) return;

                        let targetRow = null;
                        let badgeText = '推荐当前设备';

                        if (os === 'windows') {
                            targetRow = rows.find(r => (r.getAttribute('data-platform') || '').includes('Windows (安装程序)')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('Windows'));
                            badgeText = '适合当前 Windows 设备';
                        } else if (os === 'android') {
                            targetRow = rows.find(r => (r.getAttribute('data-platform') || '').includes('安卓 (arm64)')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('安卓'));
                            badgeText = '适合当前 Android 手机';
                        } else if (os === 'macos') {
                            const isArm = /arm64|aarch64/.test((navigator.userAgent || '').toLowerCase());
                            targetRow = isArm ? (rows.find(r => (r.getAttribute('data-platform') || '').includes('macOS (ARM)')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('macOS (Intel)')))
                                              : (rows.find(r => (r.getAttribute('data-platform') || '').includes('macOS (Intel)')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('macOS (ARM)')));
                            badgeText = '适合当前 Mac 电脑';
                        } else if (os === 'linux') {
                            targetRow = rows.find(r => (r.getAttribute('data-platform') || '').includes('AppImage')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('Debian')) || rows.find(r => (r.getAttribute('data-platform') || '').includes('Linux'));
                            badgeText = '适合当前 Linux 设备';
                        }

                        if (targetRow) {
                            tbody.insertBefore(targetRow, tbody.firstChild);
                            targetRow.style.background = 'var(--el-primary-light)';
                            targetRow.style.borderLeft = '3px solid var(--el-primary)';
                            const cell = targetRow.querySelector('.platform-name-cell') || targetRow.querySelector('td:first-child');
                            if (cell && !cell.querySelector('.client-recommend-pill')) {
                                const pill = document.createElement('span');
                                pill.className = 'client-recommend-pill';
                                pill.style.cssText = 'display:inline-flex; align-items:center; gap:3px; margin-left:8px; padding:2px 7px; border-radius:4px; font-size:11px; font-weight:600; background:var(--el-primary); color:#ffffff; vertical-align:middle;';
                                pill.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>' + badgeText;
                                cell.appendChild(pill);
                            }
                            const a = targetRow.querySelector('a');
                            if (a) a.style.fontWeight = '700';
                        }
                    }

                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', autoHighlightRecommendedClient);
                    } else {
                        autoHighlightRecommendedClient();
                    }

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

                    function generateUuidV4() {
                        if (window.crypto && window.crypto.randomUUID) {
                            return window.crypto.randomUUID();
                        }
                        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                            return v.toString(16);
                        });
                    }

                    function generateNewAddUuid() {
                        const el = document.getElementById("add_uuid");
                        if (el) {
                            el.value = generateUuidV4();
                            showToast("已自动随机生成新 UUID！");
                        }
                    }

                    function generateNewEditUuid() {
                        const el = document.getElementById("edit_uuid");
                        if (el) {
                            el.value = generateUuidV4();
                            showToast("已生成新 UUID，点击【保存更新】后立即生效！");
                        }
                    }

                    async function quickRotateUuid(uuid, uname) {
                        const displayName = uname || (uuid ? uuid.substring(0, 8) : "");
                        if (!confirm("⚠️ 确定要为用户「" + displayName + "」一键随机轮换新 UUID 吗？\\n\\n• 当前已建立的所有长连接将被瞬间切断！\\n• 旧订阅链接将即刻作废，用户需刷新配置重新连接。\\n• 系统将自动平滑热重载 Sing-box 核心。")) {
                            return;
                        }
                        try {
                            const res = await fetch("/v3/admin/api/rotate-uuid", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ uuid: uuid })
                            });
                            const data = await res.json();
                            if (res.ok && data.success) {
                                showToast("UUID 轮换成功！新凭据已生效");
                                setTimeout(() => location.reload(), 600);
                            } else {
                                alert(data.error || "轮换 UUID 失败");
                            }
                        } catch (err) {
                            alert("网络请求异常: " + err.message);
                        }
                    }

                    function openAddModal() {
                        document.getElementById("add_user").value = "";
                        document.getElementById("add_pwd").value = "123456";
                        document.getElementById("add_uuid").value = generateUuidV4();
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
                            const customUuid = (document.getElementById("add_uuid").value || "").trim();
                            const limitVal = document.getElementById("add_val").value;
                            const limitUnit = document.getElementById("add_unit").value;
                            const days = document.getElementById("add_days").value;
                            if (!username) return alert("请填写用户名");

                            const maxOnlineIps = parseInt(document.getElementById("add_max_ips").value || "0", 10);
                            const ipLimitPolicy = document.getElementById("add_ip_policy").value;
                            const idleDisconnectEnabled = document.getElementById("add_idle_enabled").value === "true";
                            const idleTimeoutSeconds = parseInt(document.getElementById("add_idle_sec").value || "60", 10);

                            const res = await fetch("/v3/admin/api/add", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ 
                                    username, password, customUuid, limitVal, limitUnit, days,
                                    maxOnlineIps, ipLimitPolicy, idleDisconnectEnabled, idleTimeoutSeconds
                                })
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
                        const u = allUsers.find(item => item.uuid === uuid) || {};
                        const safeName = uname || u.username || "";
                        const safeVal = val !== undefined ? val : (u.limitVal !== undefined ? u.limitVal : 50);
                        const safeUnit = unit || u.limitUnit || "GB";
                        const safeDate = dateStr !== undefined ? dateStr : (u.expireDateStr || "永久有效");
                        const safeEnabled = enabled !== undefined ? enabled : (u.enabled !== undefined ? u.enabled : true);

                        document.getElementById("editModalTitle").innerText = "编辑用户: " + safeName;
                        document.getElementById("edit_uuid").value = uuid;
                        document.getElementById("edit_pwd").value = "";
                        document.getElementById("edit_val").value = safeVal;
                        document.getElementById("edit_unit").value = safeUnit;
                        document.getElementById("edit_expire").value = (safeDate === "永久有效" ? "" : safeDate);
                        document.getElementById("edit_enabled").value = String(safeEnabled);
                        document.getElementById("edit_max_ips").value = (u.maxOnlineIps !== undefined ? u.maxOnlineIps : 0);
                        document.getElementById("edit_ip_policy").value = (u.ipLimitPolicy || "kick_oldest");
                        document.getElementById("edit_idle_enabled").value = String(u.idleDisconnectEnabled !== undefined ? u.idleDisconnectEnabled : true);
                        document.getElementById("edit_idle_sec").value = (u.idleTimeoutSeconds || 60);
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
                            const newUuid = document.getElementById("edit_uuid").value.trim();
                            const newPassword = document.getElementById("edit_pwd").value;
                            const trafficLimitVal = document.getElementById("edit_val").value;
                            const trafficLimitUnit = document.getElementById("edit_unit").value;
                            const expireDate = document.getElementById("edit_expire").value;
                            const enabled = document.getElementById("edit_enabled").value === "true";
                            const maxOnlineIps = parseInt(document.getElementById("edit_max_ips").value || "0", 10);
                            const ipLimitPolicy = document.getElementById("edit_ip_policy").value;
                            const idleDisconnectEnabled = document.getElementById("edit_idle_enabled").value === "true";
                            const idleTimeoutSeconds = parseInt(document.getElementById("edit_idle_sec").value || "60", 10);

                            const res = await fetch("/v3/admin/api/update", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ 
                                    uuid, newUuid, newPassword, trafficLimitVal, trafficLimitUnit, expireDate, enabled,
                                    maxOnlineIps, ipLimitPolicy, idleDisconnectEnabled, idleTimeoutSeconds
                                })
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
                        await fetch("/v3/admin/api/reset", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }

                    async function deleteUser(uuid) {
                        if (!confirm("确定注销此账号？其节点连接将即刻失效！")) return;
                        await fetch("/v3/admin/api/delete", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ uuid })
                        });
                        location.reload();
                    }

                    // ================= 用户专属 IP 连线详情弹窗逻辑 =================
                    let currentUserIpModalUuid = null;
                    let modalSortOrder = "desc"; // 默认严格倒序 (最新连接排在第1项)

                    function formatExactTime(ts) {
                        if (!ts) return "刚刚";
                        try {
                            const d = new Date(Number(ts));
                            const hh = String(d.getHours()).padStart(2, '0');
                            const mm = String(d.getMinutes()).padStart(2, '0');
                            const ss = String(d.getSeconds()).padStart(2, '0');
                            return hh + ':' + mm + ':' + ss;
                        } catch (_) {
                            return "刚刚";
                        }
                    }

                    // HTML 转义防注入工具
                    function escapeHtml(str) {
                        if (!str) return "";
                        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    }

                    // 异地异常详情展开/收起状态保持
                    window.expandedGeoUuids = window.expandedGeoUuids || new Set();
                    function toggleGeoDetail(uuid, event) {
                        if (event) {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                        var box = document.getElementById('geo-box-' + uuid);
                        var arrow = document.getElementById('geo-arrow-' + uuid);
                        var btn = document.getElementById('geo-btn-' + uuid);
                        if (!box) return;
                        if (box.style.display === 'none' || !box.style.display) {
                            box.style.display = 'block';
                            if (arrow) arrow.innerText = '▲';
                            if (btn) btn.title = '检测到异地多端并发！点击收起详细分布';
                            window.expandedGeoUuids.add(uuid);
                        } else {
                            box.style.display = 'none';
                            if (arrow) arrow.innerText = '▼';
                            if (btn) btn.title = '检测到异地多端并发！点击展开详细分布';
                            window.expandedGeoUuids.delete(uuid);
                        }
                    }

                    function toggleUserIpModalSort() {
                        modalSortOrder = (modalSortOrder === "desc" ? "asc" : "desc");
                        const iconEl = document.getElementById("userIpSortIcon");
                        const textEl = document.getElementById("userIpSortText");
                        const thIconEl = document.getElementById("thSortIcon");
                        if (iconEl) iconEl.innerText = (modalSortOrder === "desc" ? "↓" : "↑");
                        if (textEl) textEl.innerText = (modalSortOrder === "desc" ? "倒序 (最新在前)" : "正序 (最早在前)");
                        if (thIconEl) thIconEl.innerText = (modalSortOrder === "desc" ? "↓ (最新)" : "↑ (最早)");
                        renderUserIpModalData();
                    }

                    function openUserIpModal(uuid) {
                        currentUserIpModalUuid = uuid;
                        modalSortOrder = "desc"; // 每次重新打开弹窗默认按倒序
                        const iconEl = document.getElementById("userIpSortIcon");
                        const textEl = document.getElementById("userIpSortText");
                        const thIconEl = document.getElementById("thSortIcon");
                        if (iconEl) iconEl.innerText = "↓";
                        if (textEl) textEl.innerText = "倒序 (最新在前)";
                        if (thIconEl) thIconEl.innerText = "↓ (最新)";
                        renderUserIpModalData();
                        document.getElementById("userIpDetailModal").style.display = "flex";
                    }

                    function closeUserIpModal() {
                        document.getElementById("userIpDetailModal").style.display = "none";
                        currentUserIpModalUuid = null;
                    }

                    async function refreshUserIpModal() {
                        if (!currentUserIpModalUuid) return;
                        try {
                            const res = await fetch("/v3/admin/api/visitors");
                            if (res.ok) {
                                const data = await res.json();
                                const visitors = data.visitors || [];
                                allUsers.forEach(u => {
                                    const userConns = visitors.filter(v => v.uuid === u.uuid).sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
                                    u.activeConnections = userConns.length;
                                    u.activeList = userConns;
                                    if (userConns.length > 0) {
                                        u.lastIp = userConns[0].ip;
                                        u.lastLocation = userConns[0].location;
                                        u.lastSeenStr = "刚刚";
                                    }
                                });
                                renderUserIpModalData();
                                renderTable();
                            }
                        } catch (_) {}
                    }

                    function renderUserIpModalData() {
                        if (!currentUserIpModalUuid) return;
                        const u = allUsers.find(item => item.uuid === currentUserIpModalUuid);
                        if (!u) return;

                        document.getElementById("userIpDetailTitle").innerText = "用户 [" + u.username + "] 的使用者 IP 连线详情";

                        // 严格根据 modalSortOrder 排序 (默认 desc: 最新连入排在第1项)
                        const rawConns = u.activeList || [];
                        const conns = rawConns.slice().sort((a, b) => {
                            const tA = a.connectedAt ? Number(a.connectedAt) : 0;
                            const tB = b.connectedAt ? Number(b.connectedAt) : 0;
                            return modalSortOrder === "desc" ? (tB - tA) : (tA - tB);
                        });
                        const tbody = document.getElementById("userIpDetailTableBody");
                        const countEl = document.getElementById("userIpLiveCount");
                        const alertEl = document.getElementById("userIpDetailAlert");

                        if (countEl) {
                            countEl.innerText = conns.length + " 个在线连接";
                        }

                        // 检测异地并发冲突
                        let geoAnomaly = null;
                        if (conns.length > 1) {
                            const regMap = {};
                            conns.forEach(c => {
                                const loc = c.location || "";
                                if (!loc || loc === "公网地址" || loc === "局域网 / 回环地址" || loc === "查询中...") return;
                                const clean = loc.replace(/中国|省|市/g, " ").trim();
                                const first = clean.split(/\s+/)[0];
                                if (first && first.length >= 2) regMap[first] = true;
                            });
                            const regs = Object.keys(regMap);
                            if (regs.length >= 2) geoAnomaly = regs.join(" 与 ");
                        }

                        if (geoAnomaly) {
                            alertEl.innerHTML = '<div style="background:#fef0f0; border:1px solid #fde2e2; color:#f56c6c; padding:10px 14px; border-radius:6px; font-size:13px; font-weight:600; display:flex; align-items:center; gap:8px;">' +
                                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>' +
                                '高危预警：检测到该账号当前正由来自【' + geoAnomaly + '】的不同地区 IP 同时连接在线，疑似跨地区倒卖共享！' +
                            '</div>';
                        } else if (conns.length > 1) {
                            alertEl.innerHTML = '<div style="background:#fdf6ec; border:1px solid #faecd8; color:#e6a23c; padding:8px 14px; border-radius:6px; font-size:12px; font-weight:600;">' +
                                '⚠️ 多端提醒：当前该账号有 ' + conns.length + ' 个不同客户端或 IP 同时在线。' +
                            '</div>';
                        } else {
                            alertEl.innerHTML = '';
                        }

                        // 渲染实时连接表格 (显示精确到秒的连入时刻 + 序号高亮)
                        if (conns.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:24px 0; color:var(--el-text-secondary);">⚪ 当前该账号暂无实时在线客户端连接</td></tr>';
                        } else {
                            tbody.innerHTML = conns.map((c, idx) => {
                                const pClass = "proto-" + (c.proto || "").toLowerCase();
                                const exact = formatExactTime(c.connectedAt);
                                const rel = c.connectedStr || "刚刚";
                                const isFirst = (idx === 0 && modalSortOrder === "desc");
                                const badgeStyle = isFirst
                                    ? 'background:#ecf5ff; color:#409eff; font-weight:600; border:1px solid #d9ecff;'
                                    : 'background:#f4f4f5; color:#909399;';
                                const badgeLabel = '#' + (idx + 1) + (isFirst ? ' 最新' : '');

                                return '<tr>' +
                                    '<td><span class="proto-badge ' + pClass + '">' + (c.proto || "WS") + '</span></td>' +
                                    '<td><span class="ip-tag" data-copy="' + c.ip + '" onclick="copyText(this.dataset.copy)" title="点击复制真实IP">' + c.ip + '</span></td>' +
                                    '<td><span class="geo-tag">📍 ' + (c.location || "公网地址") + '</span></td>' +
                                    '<td style="font-size:12px; white-space:nowrap;">' +
                                        '<span style="display:inline-block; font-size:11px; padding:1px 5px; border-radius:3px; margin-right:5px; ' + badgeStyle + '">' + badgeLabel + '</span>' +
                                        '<strong style="color:var(--el-text-main); font-family:Consolas, monospace;">' + exact + '</strong> ' +
                                        '<span style="color:#909399; font-size:11px;">(' + rel + ')</span>' +
                                    '</td>' +
                                '</tr>';
                            }).join("");
                        }

                        // 填充历史记录与风控规则
                        const lastIpEl = document.getElementById("userIpDetailLastIp");
                        const lastGeoEl = document.getElementById("userIpDetailLastGeo");
                        const lastSeenEl = document.getElementById("userIpDetailLastSeen");
                        const maxIpsEl = document.getElementById("userIpDetailMaxIps");
                        const idleSecEl = document.getElementById("userIpDetailIdleSec");

                        if (lastIpEl) {
                            lastIpEl.innerText = u.lastIp || "无记录";
                            if (u.lastIp) lastIpEl.setAttribute("onclick", "copyText('" + u.lastIp + "')");
                        }
                        if (lastGeoEl) lastGeoEl.innerText = u.lastLocation || "无记录";
                        if (lastSeenEl) lastSeenEl.innerText = u.lastSeenStr || "从未在线";
                        if (maxIpsEl) {
                            const maxVal = u.maxOnlineIps !== undefined ? u.maxOnlineIps : 0;
                            const pol = u.ipLimitPolicy === "reject_new" ? "拒绝新连接" : "踢出最早设备";
                            maxIpsEl.innerText = (maxVal === 0 ? "不限制" : maxVal + " 个 IP (" + pol + ")");
                        }
                        if (idleSecEl) {
                            const isIdle = u.idleDisconnectEnabled !== false;
                            const sec = u.idleTimeoutSeconds || 60;
                            idleSecEl.innerText = isIdle ? "开启 (" + sec + "秒超时断开)" : "已关闭";
                            idleSecEl.style.color = isIdle ? "var(--el-success)" : "var(--el-danger)";
                        }
                    }

                    // ================= 实时访客与真实 IP 监控逻辑 =================
                    let visitorsTimer = null;
                    let targetUserUuidFilter = null;

                    function openAllVisitorsModal() {
                        targetUserUuidFilter = null;
                        document.getElementById("visitorsModalTitle").innerText = "全站实时在线访客与 IP 归属地监控";
                        document.getElementById("visitorsModal").style.display = "flex";
                        fetchVisitors(true);
                        startVisitorsPolling();
                    }

                    function showUserConnections(uuid) {
                        targetUserUuidFilter = uuid;
                        const u = allUsers.find(item => item.uuid === uuid);
                        const uname = u ? u.username : uuid;
                        document.getElementById("visitorsModalTitle").innerText = "用户 [" + uname + "] 的实时活跃连接详情";
                        document.getElementById("visitorsModal").style.display = "flex";
                        fetchVisitors(true);
                        startVisitorsPolling();
                    }

                    function closeVisitorsModal() {
                        document.getElementById("visitorsModal").style.display = "none";
                        stopVisitorsPolling();
                    }

                    function startVisitorsPolling() {
                        stopVisitorsPolling();
                        visitorsTimer = setInterval(() => {
                            fetchVisitors(false);
                        }, 4000);
                    }

                    function stopVisitorsPolling() {
                        if (visitorsTimer) {
                            clearInterval(visitorsTimer);
                            visitorsTimer = null;
                        }
                    }

                    async function fetchVisitors(showLoading = false) {
                        const tbody = document.getElementById("visitorsTableBody");
                        if (showLoading && tbody && (!tbody.children || tbody.children.length === 0 || tbody.innerHTML.includes("未检索") || tbody.innerHTML.includes("正在拉取"))) {
                            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px 0; color:var(--el-text-secondary);">正在实时探测访客与解析IP归属地...</td></tr>';
                        }
                        try {
                            const res = await fetch("/v3/admin/api/visitors");
                            if (res.ok) {
                                const data = await res.json();
                                let visitors = data.visitors || [];
                                if (targetUserUuidFilter) {
                                    visitors = visitors.filter(v => v.uuid === targetUserUuidFilter);
                                }
                                renderVisitorsTable(visitors);
                                const summaryEl = document.getElementById("visitorsSummary");
                                if (summaryEl) {
                                    summaryEl.innerText = (targetUserUuidFilter ? "该用户活跃连接: " : "全站实时活跃连线: ") + visitors.length + " 个";
                                }
                            }
                        } catch (_) {}
                    }

                    function renderVisitorsTable(visitors) {
                        const tbody = document.getElementById("visitorsTableBody");
                        if (!tbody) return;
                        if (!visitors || visitors.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:36px 0; color:var(--el-text-secondary);">当前无活跃在线访客连接</td></tr>';
                            return;
                        }
                        tbody.innerHTML = visitors.map(v => {
                            let protoClass = "proto-" + (v.proto || "").toLowerCase();
                            return '<tr>' +
                                '<td><strong style="color:var(--el-text-main);">' + v.username + '</strong></td>' +
                                '<td><span class="proto-badge ' + protoClass + '">' + (v.proto || "WS") + '</span></td>' +
                                '<td><span class="ip-tag" data-copy="' + v.ip + '" onclick="copyText(this.dataset.copy)" title="点击复制真实IP">' + v.ip + '</span></td>' +
                                '<td><span class="geo-tag">' + (v.location || "公网地址") + '</span></td>' +
                                '<td style="font-size:12px; color:var(--el-text-secondary);">' + (v.connectedStr || "刚刚") + '</td>' +
                                '<td style="text-align:center;"><span style="color:var(--el-success); font-weight:600; font-size:12px;">● 在线</span></td>' +
                            '</tr>';
                        }).join("");
                    }

                    // 全站在线感知静默轮询更新 (每 5 秒同步一次，让主表格连线状态动态跳动无需 F5 刷新)
                    setInterval(async () => {
                        try {
                            const res = await fetch("/v3/admin/api/visitors");
                            if (res.ok) {
                                const data = await res.json();
                                const visitors = data.visitors || [];
                                allUsers.forEach(u => {
                                    const userConns = visitors.filter(v => v.uuid === u.uuid).sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
                                    u.activeConnections = userConns.length;
                                    u.activeList = userConns;
                                    if (userConns.length > 0) {
                                        u.lastIp = userConns[0].ip;
                                        u.lastLocation = userConns[0].location;
                                        u.lastSeenStr = "刚刚";
                                    }
                                });
                                renderTable();
                                const cardEl = document.querySelector(".stat-card.c3 .stat-value");
                                if (cardEl) {
                                    cardEl.innerHTML = visitors.length + ' <span class="stat-unit">连接</span>';
                                }
                            }
                        } catch (_) {}
                    }, 5000);
                
                    // 页面加载完成后立即渲染表格与状态，读出用户数据
                    document.addEventListener("DOMContentLoaded", function() {
                        renderTable();
                        fetchVisitors(true);
                    });
                    // 如果 DOM 已经加载完成，立即调用
                    if (document.readyState === "complete" || document.readyState === "interactive") {
                        setTimeout(function() {
                            renderTable();
                            fetchVisitors(false);
                        }, 10);
                    }
</script>
            </body>
            </html>
        `);
}

module.exports = {
    renderAdminPage
};
