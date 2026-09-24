/**
 * 极速云专线 - 商业级高速多协议机场官网主页视图模块
 * 采用 Element UI 极简明亮商业级设计规范
 */

function renderLandingPage(req, res, options, sendHtmlResponseArg) {
    let siteSettings, currentUser, sendHtmlResponse;
    if (options && typeof options.sendHtmlResponse === "function") {
        siteSettings = options.siteSettings || {};
        currentUser = options.currentUser || null;
        sendHtmlResponse = options.sendHtmlResponse;
    } else {
        siteSettings = options || {};
        currentUser = null;
        sendHtmlResponse = sendHtmlResponseArg;
    }

    const isV3Prefix = req.url.startsWith("/v3");
    const basePrefix = isV3Prefix ? "/v3" : "";
    const contactText = siteSettings.contactText || "Telegram: @robberer";
    const contactUrl = siteSettings.contactUrl || "https://t.me/s5gydl";
    const defaultDays = siteSettings.defaultDays !== undefined ? siteSettings.defaultDays : 3;
    const defaultTrafficVal = siteSettings.defaultTrafficVal !== undefined ? siteSettings.defaultTrafficVal : (siteSettings.defaultTrafficGB || 10);
    const defaultTrafficUnit = siteSettings.defaultTrafficUnit || "GB";
    const allowRegister = siteSettings.allowRegister !== false;

    // 从 siteSettings 读取各协议端口（index.js 调用时注入，未配置为 0）
    const ports = {
        PORT_HY2:       siteSettings.PORT_HY2       || 0,
        PORT_TUIC:      siteSettings.PORT_TUIC      || 0,
        PORT_REALITY:   siteSettings.PORT_REALITY   || 0,
        PORT_VLESS_TCP: siteSettings.PORT_VLESS_TCP || 0,
        PORT_TROJAN_TCP:siteSettings.PORT_TROJAN_TCP|| 0,
        PORT_SS:        siteSettings.PORT_SS        || 0,
        PORT_SOCKS5:    siteSettings.PORT_SOCKS5    || 0,
        HY2_HOP_PORTS:  siteSettings.HY2_HOP_PORTS  || '',
    };

    const publicSettingsJson = JSON.stringify({
        allowRegister,
        defaultDays,
        defaultTrafficVal,
        defaultTrafficUnit,
        contactText,
        contactUrl
    });

    return sendHtmlResponse(res, 200, `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <title>极速云专线 - 全球新一代智能多协议高速商业机场</title>
    <style>
        :root {
            --el-bg: #f5f7fa;
            --el-card: #ffffff;
            --el-border: #dcdfe6;
            --el-border-light: #e4e7ed;
            --el-text-main: #303133;
            --el-text-regular: #606266;
            --el-text-secondary: #909399;
            --el-primary: #409eff;
            --el-primary-hover: #66b1ff;
            --el-primary-active: #3a8ee6;
            --el-success: #67c23a;
            --el-warning: #e6a23c;
            --el-danger: #f56c6c;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            background: var(--el-bg);
            color: var(--el-text-main);
            min-height: 100vh;
            line-height: 1.6;
            -webkit-font-smoothing: antialiased;
        }

        /* 顶部导航栏 */
        .airport-nav {
            background: #ffffff;
            border-bottom: 1px solid var(--el-border);
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .nav-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 0 24px;
            height: 64px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .brand-logo {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 18px;
            font-weight: 700;
            color: var(--el-text-main);
            text-decoration: none;
        }
        .brand-badge {
            background: #ecf5ff;
            color: var(--el-primary);
            border: 1px solid #d9ecff;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .nav-links {
            display: flex;
            align-items: center;
            gap: 28px;
            list-style: none;
        }
        .nav-links a {
            color: var(--el-text-regular);
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            transition: color 0.2s;
        }
        .nav-links a:hover { color: var(--el-primary); }
        .nav-actions { display: flex; align-items: center; gap: 12px; }

        /* 按钮体系 */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 9px 18px;
            font-size: 14px;
            font-weight: 500;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            border: 1px solid transparent;
            outline: none;
        }
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
        .btn-primary:hover {
            background: var(--el-primary-hover);
            border-color: var(--el-primary-hover);
        }
        .btn-lg {
            padding: 12px 28px;
            font-size: 15px;
            font-weight: 600;
        }

        /* Hero 横幅 */
        .hero-section {
            background: #ffffff;
            border-bottom: 1px solid var(--el-border-light);
            padding: 64px 24px;
            text-align: center;
        }
        .hero-container {
            max-width: 900px;
            margin: 0 auto;
        }
        .hero-title {
            font-size: 38px;
            font-weight: 800;
            color: var(--el-text-main);
            letter-spacing: -0.5px;
            margin-bottom: 16px;
        }
        .hero-subtitle {
            font-size: 16px;
            color: var(--el-text-regular);
            margin-bottom: 28px;
            line-height: 1.8;
        }
        .tag-list {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 10px;
            margin-bottom: 32px;
        }
        .tag-item {
            background: #f0f2f5;
            border: 1px solid var(--el-border);
            color: var(--el-text-regular);
            padding: 5px 12px;
            border-radius: 4px;
            font-size: 13px;
            font-weight: 500;
        }
        .tag-item.active {
            background: #ecf5ff;
            border-color: #b3d8ff;
            color: var(--el-primary);
        }
        .hero-cta {
            display: flex;
            justify-content: center;
            gap: 16px;
        }

        /* 页面主体网格 */
        .main-container {
            max-width: 1200px;
            margin: 40px auto;
            padding: 0 24px;
        }
        .section-header {
            text-align: center;
            margin-bottom: 36px;
        }
        .section-title {
            font-size: 26px;
            font-weight: 700;
            color: var(--el-text-main);
            margin-bottom: 8px;
        }
        .section-desc {
            font-size: 14px;
            color: var(--el-text-secondary);
        }

        /* 套餐价格网格 */
        .pricing-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 24px;
            margin-bottom: 56px;
        }
        .pricing-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 32px 28px;
            position: relative;
            display: flex;
            flex-direction: column;
            transition: all 0.25s ease;
        }
        .pricing-card:hover {
            border-color: var(--el-primary);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
            transform: translateY(-2px);
        }
        .pricing-card.featured {
            border-color: var(--el-primary);
            border-width: 2px;
        }
        .pricing-badge {
            position: absolute;
            top: -12px;
            right: 24px;
            background: var(--el-primary);
            color: #ffffff;
            font-size: 12px;
            font-weight: 600;
            padding: 2px 10px;
            border-radius: 12px;
        }
        .plan-name {
            font-size: 20px;
            font-weight: 700;
            color: var(--el-text-main);
            margin-bottom: 8px;
        }
        .plan-price-row {
            display: flex;
            align-items: baseline;
            gap: 4px;
            margin-bottom: 20px;
            padding-bottom: 20px;
            border-bottom: 1px solid var(--el-border-light);
        }
        .plan-currency {
            font-size: 20px;
            font-weight: 600;
            color: var(--el-danger);
        }
        .plan-amount {
            font-size: 36px;
            font-weight: 800;
            color: var(--el-danger);
            line-height: 1;
        }
        .plan-cycle {
            font-size: 14px;
            color: var(--el-text-secondary);
        }
        .plan-features {
            list-style: none;
            margin-bottom: 28px;
            flex-grow: 1;
        }
        .plan-features li {
            font-size: 14px;
            color: var(--el-text-regular);
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .plan-features li svg {
            color: var(--el-success);
            flex-shrink: 0;
        }

        /* 核心技术特性 */
        .feature-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
            gap: 20px;
            margin-bottom: 56px;
        }
        .feature-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 24px;
        }
        .feature-icon-box {
            width: 44px;
            height: 44px;
            background: #ecf5ff;
            color: var(--el-primary);
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 16px;
        }
        .feature-title {
            font-size: 16px;
            font-weight: 700;
            color: var(--el-text-main);
            margin-bottom: 8px;
        }
        .feature-desc {
            font-size: 13px;
            color: var(--el-text-secondary);
            line-height: 1.7;
        }

        /* 节点状态展示表格 */
        .node-preview-card {
            background: #ffffff;
            border: 1px solid var(--el-border);
            border-radius: 8px;
            padding: 24px;
            margin-bottom: 56px;
        }
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
            display: inline-block;
            background: var(--el-success);
            margin-right: 6px;
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

        /* 底部 Footer */
        .airport-footer {
            background: #ffffff;
            border-top: 1px solid var(--el-border);
            padding: 40px 24px;
            text-align: center;
            font-size: 13px;
            color: var(--el-text-secondary);
        }
        .footer-contact { margin-bottom: 16px; }
        .footer-contact a {
            color: var(--el-primary);
            text-decoration: none;
            font-weight: 600;
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
            max-width: 400px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            overflow: hidden;
            animation: modalFadeIn 0.2s ease-out;
        }
        @keyframes modalFadeIn {
            from { opacity: 0; transform: scale(0.96); }
            to { opacity: 1; transform: scale(1); }
        }
        .modal-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--el-border-light);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .modal-title { font-size: 16px; font-weight: 700; color: var(--el-text-main); }
        .modal-close {
            background: none;
            border: none;
            font-size: 20px;
            color: var(--el-text-secondary);
            cursor: pointer;
            line-height: 1;
        }
        .modal-close:hover { color: var(--el-danger); }
        .modal-body { padding: 24px; }
        .form-group { margin-bottom: 18px; }
        .form-label {
            display: block;
            font-size: 13px;
            font-weight: 500;
            color: var(--el-text-regular);
            margin-bottom: 6px;
        }
        .form-control {
            width: 100%;
            height: 38px;
            padding: 0 12px;
            font-size: 14px;
            border: 1px solid var(--el-border);
            border-radius: 4px;
            outline: none;
            transition: border-color 0.2s;
            color: var(--el-text-main);
        }
        .form-control:focus { border-color: var(--el-primary); }
        .trial-tip {
            background: #f0f9eb;
            border: 1px solid #e1f3d8;
            color: var(--el-success);
            padding: 10px 12px;
            border-radius: 4px;
            font-size: 12px;
            margin-bottom: 18px;
            line-height: 1.5;
        }
        .auth-error {
            background: #fef0f0;
            border: 1px solid #fde2e2;
            color: var(--el-danger);
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            margin-bottom: 16px;
            display: none;
        }

        @media (max-width: 768px) {
            .nav-links { display: none; }
            .hero-title { font-size: 28px; }
            .pricing-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>

    <!-- 顶部导航栏 -->
    <header class="airport-nav">
        <div class="nav-container">
            <a href="${basePrefix}/" class="brand-logo">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#409eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path></svg>
                <span>极速云专线</span>
                <span class="brand-badge">商业机场</span>
            </a>
            <ul class="nav-links">
                <li><a href="#plans">套餐方案</a></li>
                <li><a href="#features">核心优势</a></li>
                <li><a href="#nodes">节点矩阵</a></li>
                <li><a href="${contactUrl}" target="_blank" rel="noopener noreferrer">官方客服</a></li>
            </ul>
            <div class="nav-actions">
                ${currentUser ? `
                    <a href="${basePrefix}/dashboard" class="btn btn-primary" style="text-decoration:none;">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                        进入控制台 (${currentUser.username})
                    </a>
                    <a href="${basePrefix}/logout" class="btn btn-default" style="color:var(--el-danger); border-color:#fbc4c4; text-decoration:none;" title="安全退出当前账号">退出</a>
                ` : `
                    <button class="btn btn-default" onclick="openAuthModal('login')">控制台登录</button>
                    <button class="btn btn-primary" onclick="openAuthModal('register')">免费注册</button>
                `}
            </div>
        </div>
    </header>

    <!-- Hero 横幅区 -->
    <section class="hero-section">
        <div class="hero-container">
            <h1 class="hero-title">新一代多协议极速智能专线机场</h1>
            <p class="hero-subtitle">
                全球优质高带宽骨干专线，原生解锁 ChatGPT / Netflix / Disney+ / YouTube 4K。<br>
                采用全新架构，支持 UDP 智能跳跃抗封锁、Hysteria 2 极速双向加速与 VLESS Reality 无特征隧道。
            </p>
            <div class="tag-list">
                ${ports.PORT_HY2 > 0 ? `<span class="tag-item active">⚡ Hysteria 2 [${ports.PORT_HY2}]</span>` : ''}
                ${ports.PORT_HY2 > 0 && ports.HY2_HOP_PORTS ? `<span class="tag-item active">🔀 UDP 智能跳跃 [${ports.HY2_HOP_PORTS}]</span>` : ''}
                ${ports.PORT_REALITY > 0 ? `<span class="tag-item active">🛡️ VLESS Reality 无证书0特征 [${ports.PORT_REALITY}]</span>` : ''}
                ${ports.PORT_TUIC > 0 ? `<span class="tag-item active">🚀 TUIC v5 0-RTT 极速握手 [${ports.PORT_TUIC}]</span>` : ''}
                ${ports.PORT_SS > 0 ? `<span class="tag-item">🔒 SS-2022 AEAD [${ports.PORT_SS}]</span>` : ''}
                <span class="tag-item">📱 全平台客户端一键秒连</span>
            </div>
            <div class="hero-cta">
                ${currentUser ? `
                    <a href="${basePrefix}/dashboard" class="btn btn-primary btn-lg" style="text-decoration:none;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
                        进入我的用户控制台
                    </a>
                    <button class="btn btn-default btn-lg" onclick="openAuthModal('login')">
                        切换账号登录
                    </button>
                ` : `
                    <button class="btn btn-primary btn-lg" onclick="openAuthModal('register')">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" y1="8" x2="19" y2="14"></line><line x1="22" y1="11" x2="16" y2="11"></line></svg>
                        立即免费注册领取体验
                    </button>
                    <button class="btn btn-default btn-lg" onclick="openAuthModal('login')">
                        控制台登录
                    </button>
                `}
            </div>
        </div>
    </section>

    <!-- 套餐矩阵 -->
    <main class="main-container">
        <div class="section-header" id="plans">
            <h2 class="section-title">订阅套餐计划</h2>
            <p class="section-desc">灵活按期与体验方案，全节点全速解锁，支持秒速一键订阅</p>
        </div>

        <div class="pricing-grid">
            <!-- 体验套餐 -->
            <div class="pricing-card">
                <div class="plan-name">轻量体验套餐</div>
                <div class="plan-price-row">
                    <span class="plan-currency">¥</span>
                    <span class="plan-amount">0</span>
                    <span class="plan-cycle">/ 新人赠送</span>
                </div>
                <ul class="plan-features">
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><b>${defaultTrafficVal} ${defaultTrafficUnit}</b> 高速流量配额</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><b>${defaultDays} 天</b> 完整使用时效</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>全协议节点解锁 (Hy2 / Reality / TUIC)</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>4K 超清秒开，无缓冲体验</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>一键导入 Clash / Shadowrocket / v2rayN</li>
                </ul>
                <button class="btn btn-default" onclick="openAuthModal('register')">立即免费领取</button>
            </div>

            <!-- 月付套餐 (推荐) -->
            <div class="pricing-card featured">
                <span class="pricing-badge">最受欢迎</span>
                <div class="plan-name">极速畅享月付</div>
                <div class="plan-price-row">
                    <span class="plan-currency">¥</span>
                    <span class="plan-amount">15</span>
                    <span class="plan-cycle">/ 月</span>
                </div>
                <ul class="plan-features">
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><b>100 GB</b> 每月高速专属流量</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>亚太优化直连专线 + UDP 端口跳跃</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>ChatGPT / Netflix / Disney+ 原生解锁</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>SLA 99.9% 稳定率保障</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>不限在线设备与并发数</li>
                </ul>
                <button class="btn btn-primary" onclick="openAuthModal('register')">立即订阅开通</button>
            </div>

            <!-- 年付套餐 -->
            <div class="pricing-card">
                <div class="plan-name">极客旗舰年付</div>
                <div class="plan-price-row">
                    <span class="plan-currency">¥</span>
                    <span class="plan-amount">128</span>
                    <span class="plan-cycle">/ 年 (省52元)</span>
                </div>
                <ul class="plan-features">
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><b>1000 GB</b> 超大容量独享流量</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>365 天无忧服务期</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>优先享有突发峰值 1000Mbps</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>低延迟电竞与高吞吐 AI 算力优化</li>
                    <li><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>1对1 专属站长 VIP 技术支持</li>
                </ul>
                <button class="btn btn-default" onclick="openAuthModal('register')">立即订阅开通</button>
            </div>
        </div>

        <!-- 4大核心优势 -->
        <div class="section-header" id="features">
            <h2 class="section-title">商业级技术保障</h2>
            <p class="section-desc">全新架构设计，无惧网络波动与封锁</p>
        </div>
        <div class="feature-grid">
            <div class="feature-card">
                <div class="feature-icon-box">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                </div>
                <div class="feature-title">全协议智能穿透</div>
                <div class="feature-desc">全栈集成 Hysteria 2、VLESS Reality、TUIC v5、Shadowsocks-2022。无论处在何种复杂网络环境，均可自动匹配最优握手协议。</div>
            </div>

            <div class="feature-card">
                <div class="feature-icon-box">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><path d="M4 4l5 5"></path></svg>
                </div>
                <div class="feature-title">UDP 智能端口跳跃</div>
                <div class="feature-desc">针对晚高峰运营商对 UDP 协议的恶意限速与 QoS，系统部署 10900-10909 多端口动态跳跃，连接永不降速、稳定如丝。</div>
            </div>

            <div class="feature-card">
                <div class="feature-icon-box">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>
                </div>
                <div class="feature-title">多平台零门槛配置</div>
                <div class="feature-desc">完美适配 Clash Verge、FlClash、Shadowrocket (小火箭)、Sing-box 及 v2rayN，一键导入全量订阅，即装即用。</div>
            </div>

            <div class="feature-card">
                <div class="feature-icon-box">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                </div>
                <div class="feature-title">SLA 99.9% 稳定可用</div>
                <div class="feature-desc">系统基于 Alpine 3.22 原生轻量化内核与 OpenRC 进程热重载守护，具备毫秒级故障转移与自愈能力，全天候保障节点永不失联。</div>
            </div>
        </div>

        <!-- 节点列表概览 -->
        <div class="section-header" id="nodes">
            <h2 class="section-title">全协议节点网络矩阵</h2>
            <p class="section-desc">当前在线节点全天候监控，倍率 1.0x 极速分发</p>
        </div>
        <div class="node-preview-card">
            <div class="table-responsive">
                <table class="node-table">
                    <thead>
                        <tr>
                            <th>节点名称</th>
                            <th>协议类型</th>
                            <th>服务端口</th>
                            <th>节点倍率</th>
                            <th>网络状态</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>🇺🇸 极速专线-Hysteria2</td>
                            <td><span class="badge-protocol">Hysteria 2</span></td>
                            <td>${ports.PORT_HY2}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-Hy2端口跳跃[10900-10909]</td>
                            <td><span class="badge-protocol">Hy2-Hop (抗QoS)</span></td>
                            <td>10900-10909</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-VLESS Reality</td>
                            <td><span class="badge-protocol">VLESS Reality</span></td>
                            <td>${ports.PORT_REALITY}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-TUICv5</td>
                            <td><span class="badge-protocol">TUIC v5 (0-RTT)</span></td>
                            <td>${ports.PORT_TUIC}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-VLESS-TCP</td>
                            <td><span class="badge-protocol">VLESS TCP</span></td>
                            <td>${ports.PORT_VLESS_TCP}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-Trojan-TCP</td>
                            <td><span class="badge-protocol">Trojan TCP</span></td>
                            <td>${ports.PORT_TROJAN_TCP}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                        <tr>
                            <td>🇺🇸 极速专线-SS2022</td>
                            <td><span class="badge-protocol">SS-2022</span></td>
                            <td>${ports.PORT_SS}</td>
                            <td>1.0x</td>
                            <td><span class="node-status-dot"></span>正常在线</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </main>

    <!-- 底部 Footer -->
    <footer class="airport-footer">
        <div class="footer-contact">
            官方交流与客服支持: 
            <a href="${contactUrl}" target="_blank" rel="noopener noreferrer">${contactText}</a>
        </div>
        <div>© 2026 极速云专线 · 商业级高速智能专线机场 · 版权所有</div>
    </footer>

    <!-- 登录/注册 Modal -->
    <div class="modal-overlay" id="authModal">
        <div class="modal-card">
            <div class="modal-header">
                <span class="modal-title" id="authModalTitle">控制台登录</span>
                <button class="modal-close" onclick="closeAuthModal()">×</button>
            </div>
            <div class="modal-body">
                <div class="auth-error" id="authError"></div>

                ${currentUser ? `
                <div style="background:#ecf5ff; border:1px solid #d9ecff; color:var(--el-primary); padding:10px 14px; border-radius:6px; font-size:13px; margin-bottom:14px; line-height:1.6;">
                    ℹ️ 当前已登录账号：<b>${currentUser.username}</b><br>
                    如需使用其他账号，可直接输入新密码登录；亦可点击 <a href="${basePrefix}/logout" style="color:var(--el-danger); font-weight:600; text-decoration:underline;">退出当前账号</a>。
                </div>
                ` : ''}

                <div class="trial-tip" id="registerTip" style="display:none;">
                    🎁 <b>新用户注册特权</b>：注册即享 <b>${defaultTrafficVal} ${defaultTrafficUnit}</b> 试用流量，有效期 <b>${defaultDays} 天</b>！
                </div>

                <div class="form-group">
                    <label class="form-label">账号 / 用户名</label>
                    <input type="text" class="form-control" id="authUsername" placeholder="请输入您的账号" autocomplete="off" />
                </div>
                <div class="form-group">
                    <label class="form-label">登录密码</label>
                    <input type="password" class="form-control" id="authPassword" placeholder="请输入密码" autocomplete="off" />
                </div>

                <button class="btn btn-primary" id="authSubmitBtn" style="width:100%; margin-top:8px;" onclick="submitAuth()">立即登录</button>
                <div style="margin-top:16px; text-align:center; font-size:13px; color:var(--el-text-secondary);">
                    <span id="authToggleHint">还没有账号？</span>
                    <a href="javascript:void(0)" onclick="toggleAuthMode()" id="authToggleLink" style="color:var(--el-primary); text-decoration:none; font-weight:600;">免费注册</a>
                </div>
            </div>
        </div>
    </div>

    <script>
        const siteConfig = ${publicSettingsJson};
        let currentMode = "login";

        function openAuthModal(mode) {
            currentMode = mode || "login";
            updateModalUI();
            document.getElementById("authError").style.display = "none";
            document.getElementById("authModal").style.display = "flex";
        }

        function closeAuthModal() {
            document.getElementById("authModal").style.display = "none";
        }

        function toggleAuthMode() {
            currentMode = currentMode === "login" ? "register" : "login";
            updateModalUI();
        }

        function updateModalUI() {
            const titleEl = document.getElementById("authModalTitle");
            const submitBtn = document.getElementById("authSubmitBtn");
            const toggleHint = document.getElementById("authToggleHint");
            const toggleLink = document.getElementById("authToggleLink");
            const registerTip = document.getElementById("registerTip");

            if (currentMode === "register") {
                titleEl.innerText = "新用户注册";
                submitBtn.innerText = "立即注册并开通";
                toggleHint.innerText = "已有账号？";
                toggleLink.innerText = "直接登录";
                registerTip.style.display = siteConfig.allowRegister ? "block" : "none";
            } else {
                titleEl.innerText = "控制台登录";
                submitBtn.innerText = "立即登录";
                toggleHint.innerText = "还没有账号？";
                toggleLink.innerText = "免费注册";
                registerTip.style.display = "none";
            }
        }

        async function submitAuth() {
            const u = document.getElementById("authUsername").value.trim();
            const p = document.getElementById("authPassword").value.trim();
            const errorEl = document.getElementById("authError");
            const btn = document.getElementById("authSubmitBtn");

            errorEl.style.display = "none";

            if (!u || !p) {
                errorEl.innerText = "请输入用户名和密码";
                errorEl.style.display = "block";
                return;
            }

            const originText = btn.innerText;
            btn.innerText = "正在验证中...";
            btn.disabled = true;

            const basePrefix = location.pathname.startsWith("/v3") ? "/v3" : "";
            const endpoint = currentMode === "register" ? basePrefix + "/api/register" : basePrefix + "/api/login";

            try {
                const res = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ username: u, password: p })
                });
                const data = await res.json();
                if (res.ok) {
                    if (currentMode === "register") {
                        alert("🎉 账号注册成功！已为您自动发放试用流量与权限，正在跳转控制台...");
                    }
                    location.href = basePrefix + "/dashboard?t=" + Date.now();
                } else {
                    errorEl.innerText = data.error || "请求失败，请稍后重试";
                    errorEl.style.display = "block";
                }
            } catch (err) {
                errorEl.innerText = "网络异常: " + err.message;
                errorEl.style.display = "block";
            } finally {
                btn.innerText = originText;
                btn.disabled = false;
            }
        }

        document.addEventListener("DOMContentLoaded", function() {
            const pInput = document.getElementById("authPassword");
            if (pInput) {
                pInput.addEventListener("keydown", function(e) {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        submitAuth();
                    }
                });
            }
            const params = new URLSearchParams(location.search);
            if (params.get("action") === "register") {
                openAuthModal("register");
            } else if (params.get("action") === "login") {
                openAuthModal("login");
            }
        });
    </script>
</body>
</html>
`);
}

module.exports = {
    renderLandingPage
};
