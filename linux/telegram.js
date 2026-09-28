/**
 * ==============================================================================
 *  Telegram 机器人服务与专属群组鉴权中心 (telegram.js - 增强版)
 *  特点：
 *  1. 原生零第三方依赖，纯 Node.js https/http 驱动；
 *  2. 严格保障单账号限制：每个 Telegram ID 仅限注册 1 个节点账号；
 *  3. 自动退群失效与进群自动恢复双保险 (chat_member 事件监听 + 定时后台健康巡检)；
 *  4. 退群秒切存量连接，Sing-box 彻底剔除用户 UUID，确凿 100% 无法连通；
 *  5. 异地登录与多地异常并发连接即时报警推送给管理员；
 *  6. 极具视觉质感的多功能交互式 Inline Keyboard 按钮矩阵 (签到领流量/节点大屏/订阅一键导入/站长控制台)。
 * ==============================================================================
 */

const https = require("https");
const http = require("http");
const url = require("url");
const crypto = require("crypto");

class TelegramBotManager {
    constructor(options = {}) {
        this.botToken = (options.botToken || process.env.TG_BOT_TOKEN || "").trim();
        this.adminId = (options.adminId || process.env.TG_ADMIN_ID || "5153827615").trim();
        this.requiredGroup = (options.requiredGroup || process.env.TG_REQUIRED_GROUP || "@s5gydl").trim();
        this.apiBase = (options.apiBase || process.env.TG_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

        // 宿主业务挂载钩子
        this.getUsers = options.getUsers || (() => []);
        this.createUser = options.createUser || null;
        this.deleteUser = options.deleteUser || null;
        this.unbindUser = options.unbindUser || null;
        this.setUserEnabled = options.setUserEnabled || null;
        this.disconnectUser = options.disconnectUser || null;
        this.checkinUser = options.checkinUser || null;
        this.getSiteSettings = options.getSiteSettings || (() => ({}));
        this.getBaseSubUrl = options.getBaseSubUrl || null;
        this.getAppImportUrl = options.getAppImportUrl || null;
        this.getSystemStats = options.getSystemStats || (() => ({}));
        this.getNodesSummary = options.getNodesSummary || (() => []);
        this.getRawNodesText = options.getRawNodesText || null;
        this.restartSingboxCore = options.restartSingboxCore || null;
        this.getUserActivity = options.getUserActivity || null;
        this.getOnlineIpsDetails = options.getOnlineIpsDetails || null;
        this.adminWebUrl = options.adminWebUrl || null;

        this.botInfo = null;
        this.isRunning = false;
        this.pollOffset = 0;
        this.reconnectTimer = null;
        this.auditIntervalTimer = null;
        this.isAuditing = false;
    }

    /**
     * 更新运行时配置（支持热更新）
     */
    updateConfig(cfg = {}) {
        if (cfg.botToken !== undefined) this.botToken = String(cfg.botToken || "").trim();
        if (cfg.adminId !== undefined) this.adminId = String(cfg.adminId || "").trim();
        if (cfg.requiredGroup !== undefined) this.requiredGroup = String(cfg.requiredGroup || "").trim();
        if (cfg.apiBase !== undefined) this.apiBase = String(cfg.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
        if (cfg.getUsers) this.getUsers = cfg.getUsers;
        if (cfg.createUser) this.createUser = cfg.createUser;
        if (cfg.deleteUser) this.deleteUser = cfg.deleteUser;
        if (cfg.unbindUser) this.unbindUser = cfg.unbindUser;
        if (cfg.setUserEnabled) this.setUserEnabled = cfg.setUserEnabled;
        if (cfg.disconnectUser) this.disconnectUser = cfg.disconnectUser;
        if (cfg.checkinUser) this.checkinUser = cfg.checkinUser;
        if (cfg.getSiteSettings) this.getSiteSettings = cfg.getSiteSettings;
        if (cfg.getBaseSubUrl) this.getBaseSubUrl = cfg.getBaseSubUrl;
        if (cfg.getAppImportUrl) this.getAppImportUrl = cfg.getAppImportUrl;
        if (cfg.getSystemStats) this.getSystemStats = cfg.getSystemStats;
        if (cfg.getNodesSummary) this.getNodesSummary = cfg.getNodesSummary;
        if (cfg.getRawNodesText) this.getRawNodesText = cfg.getRawNodesText;
        if (cfg.restartSingboxCore) this.restartSingboxCore = cfg.restartSingboxCore;
        if (cfg.getUserActivity) this.getUserActivity = cfg.getUserActivity;
        if (cfg.getOnlineIpsDetails) this.getOnlineIpsDetails = cfg.getOnlineIpsDetails;
        if (cfg.adminWebUrl) this.adminWebUrl = cfg.adminWebUrl;
    }

    /**
     * 底层调用 Telegram Bot API
     */
    request(method, data = {}, timeout = 35000) {
        return new Promise((resolve, reject) => {
            if (!this.botToken) {
                return reject(new Error("未配置 Telegram Bot Token (TG_BOT_TOKEN)"));
            }

            const payloadStr = JSON.stringify(data || {});
            const targetUrl = new URL(`${this.apiBase}/bot${this.botToken}/${method}`);
            const isHttps = targetUrl.protocol === "https:";
            const client = isHttps ? https : http;

            const reqOptions = {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payloadStr)
                },
                timeout: timeout
            };

            const req = client.request(reqOptions, (res) => {
                let chunks = "";
                res.on("data", (c) => { chunks += c; });
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(chunks || "{}");
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`响应 JSON 解析异常 (${res.statusCode}): ${e.message}`));
                    }
                });
            });

            req.on("timeout", () => {
                req.destroy(new Error(`Telegram API 请求超时 (${timeout}ms)`));
            });

            req.on("error", (err) => {
                reject(err);
            });

            req.write(payloadStr);
            req.end();
        });
    }

    /**
     * 发送文本消息 (所有发往群聊的消息均会在 1 分钟后自动定时删除，防止刷屏)
     */
    async sendMessage(chatId, text, extra = {}) {
        try {
            const { autoDeleteSeconds, ...restExtra } = extra;
            const data = {
                chat_id: chatId,
                text: text,
                parse_mode: restExtra.parse_mode !== undefined ? restExtra.parse_mode : "Markdown",
                disable_web_page_preview: restExtra.disable_web_page_preview !== undefined ? restExtra.disable_web_page_preview : true,
                ...restExtra
            };
            let sent = await this.request("sendMessage", data);

            // 🌟 核心容错 1：若报 BUTTON_URL_INVALID 或 URL 错误，自动清洗非法 scheme 按钮重试下发
            if (sent && !sent.ok && sent.description && (sent.description.includes("BUTTON_URL_INVALID") || sent.description.includes("url") || sent.description.includes("wrong url"))) {
                console.warn(`[TG-Bot] 检测到按钮包含非法 URL (${sent.description})，自动清洗重发...`);
                const safeData = JSON.parse(JSON.stringify(data));
                if (safeData.reply_markup && Array.isArray(safeData.reply_markup.inline_keyboard)) {
                    safeData.reply_markup.inline_keyboard = safeData.reply_markup.inline_keyboard.map((row) =>
                        row.map((btn) => {
                            if (btn.url && !/^(https?|tg):\/\//i.test(btn.url)) {
                                return { text: btn.text, callback_data: "cmd_my" };
                            }
                            return btn;
                        })
                    );
                }
                sent = await this.request("sendMessage", safeData);
            }

            // 🌟 核心容错 2：若 Telegram 因 Markdown 实体解析报错，自动剥离 parse_mode 降级为纯文本重发
            if (sent && !sent.ok && sent.description && (sent.description.includes("can't parse entities") || sent.description.includes("entity") || sent.description.includes("parse"))) {
                console.warn(`[TG-Bot] Markdown 解析失败 (${sent.description})，自动降级为纯文本重试下发...`);
                const fallbackData = { ...data };
                delete fallbackData.parse_mode;
                sent = await this.request("sendMessage", fallbackData);
            }

            // 🌟 核心容错 3：终极兜底，若依然失败，剥离 reply_markup 与 parse_mode 重发纯文本
            if (sent && !sent.ok) {
                console.warn(`[TG-Bot] 消息下发最终兜底 (${sent.description})，纯文本裸发...`);
                sent = await this.request("sendMessage", {
                    chat_id: chatId,
                    text: text.replace(/[*_`\[\]()]/g, ""),
                    disable_web_page_preview: true
                });
            }

            // 群聊中机器人发送的消息 60 秒后自动撤回自毁 (保持群版面清爽)；私聊消息永不删除；用户消息绝对不删
            const isGroup = sent && sent.result && sent.result.chat && (
                sent.result.chat.type === "group" ||
                sent.result.chat.type === "supergroup" ||
                sent.result.chat.type === "channel" ||
                Number(chatId) < 0
            );
            const delaySec = autoDeleteSeconds !== undefined ? autoDeleteSeconds : (isGroup ? 60 : 0);
            if (sent && sent.ok && sent.result && sent.result.chat && delaySec > 0) {
                setTimeout(() => {
                    this.deleteMessage(sent.result.chat.id, sent.result.message_id).catch(() => {});
                }, delaySec * 1000);
            }

            return sent;
        } catch (e) {
            console.warn(`[TG-Bot] 发送消息给 [${chatId}] 异常:`, e.message);
            return null;
        }
    }

    /**
     * 自动删除指定消息 (deleteMessage)
     */
    async deleteMessage(chatId, messageId) {
        try {
            const res = await this.request("deleteMessage", {
                chat_id: chatId,
                message_id: messageId
            });
            if (res && res.ok) {
                console.log(`[TG-Bot] 群聊消息已定时安全撤回自毁 (Chat: ${chatId}, Msg: ${messageId})`);
            } else {
                console.warn(`[TG-Bot] 撤回群消息失败 (Chat: ${chatId}, Msg: ${messageId}):`, res ? res.description : "未知错误");
            }
            return res;
        } catch (err) {
            console.warn(`[TG-Bot] 撤回群消息网络异常:`, err.message);
            return null;
        }
    }

    /**
     * 响应回调查询
     */
    async answerCallbackQuery(callbackQueryId, text = "", showAlert = false) {
        try {
            return await this.request("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                text,
                show_alert: showAlert
            });
        } catch (_) {
            return null;
        }
    }

    /**
     * 校验用户是否属于指定群组
     */
    async verifyUserInRequiredGroup(userId) {
        if (!this.requiredGroup) {
            return { inGroup: true, status: "ignored" };
        }

        let targetChat = this.requiredGroup.trim();
        if (!targetChat.startsWith("@") && !/^-?\d+$/.test(targetChat)) {
            targetChat = "@" + targetChat;
        }

        try {
            const res = await this.request("getChatMember", {
                chat_id: targetChat,
                user_id: parseInt(userId, 10)
            }, 10000);

            if (res && res.ok && res.result) {
                const status = res.result.status;
                const validMemberStatuses = ["creator", "administrator", "member", "restricted"];
                if (validMemberStatuses.includes(status)) {
                    return { inGroup: true, status, user: res.result.user };
                } else {
                    return { inGroup: false, status, reason: "not_in_group" };
                }
            }

            const errMsg = (res && res.description) || "未知群组错误";
            return { inGroup: false, error: errMsg };
        } catch (e) {
            return { inGroup: false, error: e.message };
        }
    }

    /**
     * 启动机器人引擎
     */
    async start() {
        if (this.isRunning) return;
        if (!this.botToken) {
            console.log("[TG-Bot] 未设置 TG_BOT_TOKEN，Telegram 机器人自动服务保持待命。");
            return;
        }

        this.isRunning = true;
        console.log("[TG-Bot] 正在初始化 Telegram 机器人联机测试...");

        try {
            const meRes = await this.request("getMe", {}, 10000);
            if (meRes && meRes.ok && meRes.result) {
                this.botInfo = meRes.result;
                console.log(`[TG-Bot] ✅ 成功联机 Telegram 机器人: @${this.botInfo.username} (ID: ${this.botInfo.id})`);
                console.log(`[TG-Bot] 📌 专属限定注册群: ${this.requiredGroup}`);
                if (this.adminId) {
                    console.log(`[TG-Bot] 👑 管理员 Telegram ID: ${this.adminId}`);
                }
            } else {
                console.warn(`[TG-Bot] ⚠️ 获取 Bot 信息返回非成功:`, meRes);
            }
        } catch (e) {
            console.warn(`[TG-Bot] ⚠️ 初始联机探测受阻 (${e.message})，守护引擎将持续后台静默重试...`);
        }

        // 启动长轮询更新循环
        this.runPollingLoop();

        // 启动退群后台定时健康巡检双保险 (每 15 分钟运行一次)
        this.startMembershipAuditor(15 * 60 * 1000);
    }

    /**
     * 停止机器人引擎
     */
    stop() {
        this.isRunning = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.auditIntervalTimer) {
            clearInterval(this.auditIntervalTimer);
            this.auditIntervalTimer = null;
        }
        console.log("[TG-Bot] Telegram 机器人已安全离线。");
    }

    /**
     * 长轮询接收 updates 消息死循环
     */
    async runPollingLoop() {
        while (this.isRunning) {
            try {
                const res = await this.request("getUpdates", {
                    offset: this.pollOffset,
                    timeout: 25,
                    allowed_updates: ["message", "callback_query", "chat_member"]
                }, 35000);

                if (res && res.ok && Array.isArray(res.result)) {
                    for (const update of res.result) {
                        if (update.update_id >= this.pollOffset) {
                            this.pollOffset = update.update_id + 1;
                        }
                        this.handleUpdate(update).catch((err) => {
                            console.warn("[TG-Bot] 处理消息异常:", err.message);
                        });
                    }
                } else if (res && res.error_code === 409) {
                    console.warn("[TG-Bot] 检测到 Update 冲突 (409 Conflict)，可能存在并发实例，等待 5 秒重试...");
                    await new Promise((r) => setTimeout(r, 5000));
                }
            } catch (err) {
                if (!this.isRunning) break;
                await new Promise((r) => setTimeout(r, 3000));
            }
        }
    }

    /**
     * 分发处理消息 Update
     */
    async handleUpdate(update) {
        if (update.chat_member) {
            await this.handleChatMemberEvent(update.chat_member);
        } else if (update.message) {
            await this.handleMessage(update.message);
        } else if (update.callback_query) {
            await this.handleCallbackQuery(update.callback_query);
        }
    }

    /**
     * 🚨 核心机制一：Telegram 原生 chat_member 退群与进群实时事件感知
     */
    async handleChatMemberEvent(memberUpdate) {
        try {
            const chat = memberUpdate.chat;
            const newMember = memberUpdate.new_chat_member;
            const oldMember = memberUpdate.old_chat_member;
            if (!chat || !newMember) return;

            // 仅监听限定的目标群组
            const currentChatTitle = chat.username ? `@${chat.username}` : String(chat.id);
            const reqGroupClean = this.requiredGroup.replace(/^@/, "").toLowerCase();
            const eventGroupClean = (chat.username || "").toLowerCase();
            if (eventGroupClean !== reqGroupClean && String(chat.id) !== this.requiredGroup) {
                return;
            }

            const targetTgId = String(newMember.user.id);
            const newStatus = newMember.status;
            const oldStatus = oldMember ? oldMember.status : "";

            const allUsers = this.getUsers();
            const boundUser = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === targetTgId);
            if (!boundUser) return; // 该用户尚未绑定系统账号，无需动作

            // 1. 用户退群或被踢出 -> 立即停用账号并切断连接
            if (newStatus === "left" || newStatus === "kicked") {
                if (boundUser.enabled) {
                    console.log(`[TG-Audit] 🚨 监听到用户 [${boundUser.username}] (TG: ${targetTgId}) 退出群组 ${this.requiredGroup}，执行自动停用！`);
                    if (this.setUserEnabled) {
                        this.setUserEnabled(boundUser.uuid, false, "退群自动停用");
                    }
                    if (this.disconnectUser) {
                        this.disconnectUser(boundUser.uuid, "退群切断存量在线连接");
                    }

                    // 私信通知用户
                    const groupLink = this.requiredGroup.startsWith("@") ? `https://t.me/${this.requiredGroup.slice(1)}` : "https://t.me/s5gydl";
                    this.sendMessage(targetTgId,
                        `⚠️ *节点加速服务已暂停通知*

检测到您已退出官方交流群 [${this.requiredGroup}](${groupLink})。
根据群专属运营策略，您的节点账号 \`${boundUser.username}\` 已自动冻结断网。

👉 *如何恢复*：
重新加入群组后，系统将自动秒级为您恢复节点连接权限！`, {
                        reply_markup: {
                            inline_keyboard: [[{ text: `👉 重新加入群组 ${this.requiredGroup}`, url: groupLink }]]
                        }
                    }).catch(() => { });

                    // 通知管理员
                    if (this.adminId) {
                        this.sendMessage(this.adminId,
                            `⚠️ *群员退群触发停用通知*
• 用户账号: \`${boundUser.username}\`
• Telegram ID: \`${targetTgId}\`
• 动作: 退出群组 ${this.requiredGroup}
• 处理: 账号已立即设为禁用，存量连接已切断，Sing-box 配置已同步剔除。`).catch(() => { });
                    }
                }
            }
            // 2. 用户重新入群 -> 自动秒级恢复账号权限
            else if (["member", "administrator", "creator", "restricted"].includes(newStatus)) {
                if (!boundUser.enabled && boundUser.disableReason !== "管理员手动禁用") {
                    console.log(`[TG-Audit] 🟢 监听到用户 [${boundUser.username}] 重新加入群组 ${this.requiredGroup}，自动激活恢复权限！`);
                    if (this.setUserEnabled) {
                        this.setUserEnabled(boundUser.uuid, true, "进群自动恢复");
                    }

                    // 私信通知用户本人
                    this.sendMessage(targetTgId,
                        `🎉 *欢迎回群！节点权限已自动恢复*

系统检测到您已重新加入官方群组 ${this.requiredGroup}。
您的账号 \`${boundUser.username}\` 现已重新激活，所有高速节点恢复正常使用！

💡 发送 \`/my\` 可刷新并提取最新订阅链接。`, {
                        reply_markup: {
                            inline_keyboard: [[{ text: "📦 查看我的订阅 (/my)", callback_data: "cmd_my" }]]
                        }
                    }).catch(() => { });

                    // 同步发送通知给管理员，确保图2状态闭环
                    if (this.adminId) {
                        this.sendMessage(this.adminId,
                            `🎉 *群员回群触发解封通知*
• 用户账号: \`${boundUser.username}\`
• Telegram ID: \`${targetTgId}\`
• 动作: 重新加入群组 ${this.requiredGroup}
• 处理: 账号已解除冻结，Sing-box 配置已同步热重载，节点加速服务全面恢复正常！`).catch(() => { });
                    }
                }
            }
        } catch (e) {
            console.warn("[TG-Bot] 处理 chat_member 事件异常:", e.message);
        }
    }

    /**
     * 🚨 核心机制二：后台定时健康巡检双保险 (Cron/Interval)
     * 无论是否收到 Telegram Webhook，每 15 分钟全面排查所有在册用户的加群状态
     */
    startMembershipAuditor(intervalMs = 900000) {
        if (this.auditIntervalTimer) clearInterval(this.auditIntervalTimer);
        this.auditIntervalTimer = setInterval(() => {
            this.auditAllMembers(false).catch((e) => {
                console.warn("[TG-Audit] 定时后台巡检异常:", e.message);
            });
        }, intervalMs);
    }

    /**
     * 执行全量在群状态排查巡检
     */
    async auditAllMembers(isManual = false) {
        if (this.isAuditing) return { busy: true };
        this.isAuditing = true;

        const allUsers = this.getUsers();
        const tgUsers = allUsers.filter((u) => u.telegramId && String(u.telegramId).trim() !== "");
        let disabledCount = 0;
        let restoredCount = 0;

        try {
            for (const u of tgUsers) {
                const check = await this.verifyUserInRequiredGroup(u.telegramId);
                // 1. 不在群内，但账号当前处于启用 -> 停用
                if (!check.inGroup && u.enabled) {
                    console.log(`[TG-Audit-Cron] 巡检查出用户 [${u.username}] 不在群 ${this.requiredGroup}，执行停用断网`);
                    if (this.setUserEnabled) this.setUserEnabled(u.uuid, false, "退群自动停用");
                    if (this.disconnectUser) this.disconnectUser(u.uuid, "退群巡检查出并断链");
                    disabledCount++;
                }
                // 2. 在群内，但此前因退群被停用 -> 恢复
                else if (check.inGroup && !u.enabled && u.disableReason !== "管理员手动禁用") {
                    console.log(`[TG-Audit-Cron] 巡检查出用户 [${u.username}] 已回群，自动恢复权限`);
                    if (this.setUserEnabled) this.setUserEnabled(u.uuid, true, "进群自动恢复");
                    restoredCount++;

                    this.sendMessage(u.telegramId,
                        `🎉 *检测到您已在群内，节点权限已自动恢复*

系统检测到您当前已在官方交流群 ${this.requiredGroup}。
您的账号 \`${u.username}\` 现已重新激活，所有高速节点恢复正常使用！

💡 发送 \`/my\` 可刷新并提取最新订阅链接。`, {
                        reply_markup: {
                            inline_keyboard: [[{ text: "📦 查看我的订阅 (/my)", callback_data: "cmd_my" }]]
                        }
                    }).catch(() => { });

                    if (this.adminId) {
                        this.sendMessage(this.adminId,
                            `🎉 *群员回群触发解封通知 (后台巡检恢复)*
• 用户账号: \`${u.username}\`
• Telegram ID: \`${u.telegramId}\`
• 状态: 确认已在群组 ${this.requiredGroup}
• 处理: 账号已解除冻结，Sing-box 配置已同步热重载，节点加速服务全面恢复正常！`).catch(() => { });
                    }
                }
                await new Promise((r) => setTimeout(r, 120)); // 平滑流控
            }
        } finally {
            this.isAuditing = false;
        }

        const report = `巡检完成：检查 ${tgUsers.length} 位用户，自动停用退群者 ${disabledCount} 人，自动恢复回群者 ${restoredCount} 人。`;
        if (disabledCount > 0 || restoredCount > 0 || isManual) {
            console.log(`[TG-Audit] ${report}`);
        }
        return { total: tgUsers.length, disabledCount, restoredCount, report };
    }

    /**
     * 🚨 核心机制三：异地登录与连接异常实时告警给管理员
     */
    async sendAdminAlert(alertType, payload = {}) {
        if (!this.adminId) return;

        let title = "⚠️ 【系统安全告警】";
        let content = "";
        const nowStr = new Date().toLocaleString("zh-CN", { hour12: false });

        if (alertType === "admin_login_ip_change") {
            title = "🚨 【管理员后台异地登录安全警报】";
            content =
                `${title}
• 登录时间: \`${nowStr}\`
• 登录账号: \`管理员 (ADMIN_TOKEN)\`
• 当前登录 IP: \`${payload.currentIp || "未知"}\` (${payload.location || "归属地解析中"})
• 上次记录 IP: \`${payload.previousIp || "首次登录"}\`
• 设备 User-Agent: \`${payload.userAgent || "未知"}\`

⚠️ *若非您本人操作，可能管理凭据已泄露！请立即登录服务器更换 ADMIN_TOKEN 并核查防火墙日志！*`;
        } else if (alertType === "user_abnormal_concurrent_ip") {
            title = "⚠️ 【用户异常跨地域并发告警】";
            content =
                `${title}
• 告警时间: \`${nowStr}\`
• 用户名称: \`${payload.username}\` (TG: @${payload.tgUsername || "无"})
• 异常原因: \`检测到短时间内跨省/跨国异地 IP 连接，疑似账号外借共享\`
• 新接入 IP: \`${payload.newIp}\` (${payload.newLocation || "未知地区"})
• 原活跃 IP: \`${payload.oldIp}\` (${payload.oldLocation || "未知地区"})
• 采取策略: \`${payload.policyTaken || "记录并监控"}\``;
        } else if (alertType === "system_singbox_down") {
            title = "🔴 【Sing-box 核心异常崩溃告警】";
            content =
                `${title}
• 告警时间: \`${nowStr}\`
• 节点位置: \`${payload.serverLocation || "本地"}\`
• 状态: 核心进程发生意外中断，守护引擎已自动触发重启自愈。`;
        }

        if (content) {
            await this.sendMessage(this.adminId, content, {
                reply_markup: {
                    inline_keyboard: [[{ text: "📊 登录后台查看详情", url: payload.adminUrl || "http://127.0.0.1:10809/admin" }]]
                }
            });
        }
    }

    /**
     * 处理消息交互
     */
    async handleMessage(msg) {
        const from = msg.from;
        const chat = msg.chat;
        if (!chat) return;

        // 🌟 核心功能：监听新成员进群事件 (new_chat_members) 仅引导直达私聊
        if (msg.new_chat_members && Array.isArray(msg.new_chat_members) && msg.new_chat_members.length > 0) {
            const botUser = this.botInfo ? this.botInfo.username : "";
            for (const newMember of msg.new_chat_members) {
                if (newMember.is_bot) continue; // 过滤机器人
                const memberName = this.escapeMd(newMember.first_name || "新朋友");
                const welcomeCard = 
`🎉 欢迎 ${memberName} 加入官方交流群！

💡 提示：本群所有节点开通、订阅提取与服务查询仅限与机器人【私聊】操作，群聊不做任何服务与响应。
👉 请点击下方按钮进入私聊，轻按屏幕正下方的【START / 开始】即可使用！`;

                const keyboard = botUser ? {
                    inline_keyboard: [
                        [{ text: "👉 点击直达私聊机器人 开启服务", url: `https://t.me/${botUser}?start=start` }]
                    ]
                } : undefined;

                await this.sendMessage(chat.id, welcomeCard, { reply_markup: keyboard, parse_mode: undefined });
            }
            return;
        }

        const text = (msg.text || "").trim();
        if (!from || !text) return;

        const isPrivate = chat.type === "private";
        const senderId = String(from.id);
        const isAdmin = this.adminId && senderId === this.adminId;

        let fullCmd = text.split(/\s+/)[0] || "";
        const argsStr = text.slice(fullCmd.length).trim();
        if (fullCmd.includes("@")) {
            fullCmd = fullCmd.split("@")[0];
        }
        const cmd = fullCmd.toLowerCase();

        // 🌟 群聊铁律：群聊只能引导用户私聊机器人，不做任何东西！
        if (!isPrivate) {
            const botUser = this.botInfo ? this.botInfo.username : "";
            const isBotMentioned = botUser && (text.includes(`@${botUser}`) || fullCmd.toLowerCase().includes(`@${botUser.toLowerCase()}`));
            const isCommand = text.startsWith("/");
            const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
            const hasKeyword = [
                "开通", "注册", "节点", "订阅", "签到", "我的", "帮助", "后台", "管理", "试用", "流量", "续费"
            ].some((kw) => text.includes(kw));

            // 只要群内触发了命令、@机器人、回复机器人或意图关键词，唯一动作：仅发送一条直达私聊引导，不做任何业务！
            if (isCommand || isBotMentioned || isReplyToBot || hasKeyword) {
                const replyMsg = `👋 您好！为保护您的订阅与账号隐私，机器人所有功能仅限私聊操作，群聊不做任何服务！\n👉 请点击下方按钮进入私聊，轻点屏幕正下方的【START / 开始】即可使用！`;
                const keyboard = botUser ? {
                    inline_keyboard: [
                        [{ text: "👉 点击直达私聊机器人 开启服务", url: `https://t.me/${botUser}?start=start` }]
                    ]
                } : undefined;

                // 用户发的信息绝对不删除，完整保留群员发言与聊天记录；机器人回复卡片 60 秒后必定自动撤回
                await this.sendMessage(chat.id, replyMsg, {
                    reply_to_message_id: msg.message_id,
                    reply_markup: keyboard,
                    parse_mode: undefined,
                    autoDeleteSeconds: 60
                });
            }
            // 无论是否触发，非私聊一律阻断退出，绝对不穿透到后续任何业务逻辑！
            return;
        }

        if (cmd === "/start") {
            const cleanArg = (argsStr || "").trim().toLowerCase();
            if (cleanArg === "my" || cleanArg === "sub") {
                return await this.handleMySubscriptionCommand(chat.id, from);
            }
            if (cleanArg === "raw" || cleanArg === "nodes") {
                return await this.handleExtractRawNodesCommand(chat.id, from);
            }
            if (cleanArg === "admin" && isAdmin) {
                return await this.handleAdminDashboardCommand(chat.id);
            }
            if (cleanArg === "checkin") {
                return await this.handleCheckinCommand(chat.id, from);
            }
            return await this.handleStartCommand(chat.id, from);
        }
        if (cmd === "/help") {
            return await this.handleHelpCommand(chat.id, from, isAdmin);
        }
        if (cmd === "/reg" || cmd === "/register") {
            return await this.handleRegisterCommand(chat.id, from, argsStr);
        }
        if (cmd === "/my" || cmd === "/sub") {
            return await this.handleMySubscriptionCommand(chat.id, from);
        }
        if (cmd === "/checkin" || cmd === "/qiandao") {
            return await this.handleCheckinCommand(chat.id, from);
        }
        if (cmd === "/nodes") {
            return await this.handleNodesCommand(chat.id);
        }

        // 管理员特权指令
        if (isAdmin) {
            if (cmd === "/status" || cmd === "/admin") {
                return await this.handleAdminDashboardCommand(chat.id);
            }
            if (cmd === "/restart") {
                return await this.handleAdminRestartCoreCommand(chat.id);
            }
            if (cmd === "/users") {
                return await this.handleAdminListUsersCommand(chat.id);
            }
            if (cmd === "/ips") {
                return await this.handleAdminOnlineIpsCommand(chat.id);
            }
            if (cmd === "/grantall") {
                return await this.handleAdminGrantAllCommand(chat.id);
            }
            if (cmd === "/audit") {
                return await this.handleAdminAuditCommand(chat.id);
            }
            if (cmd === "/unbind") {
                return await this.handleAdminUnbindCommand(chat.id, argsStr);
            }
            if (cmd === "/deluser") {
                return await this.handleAdminDelUserCommand(chat.id, argsStr);
            }
            if (cmd === "/clearall") {
                return await this.handleAdminClearAllCommand(chat.id, argsStr, "all");
            }
            if (cmd === "/cleartg") {
                return await this.handleAdminClearAllCommand(chat.id, argsStr, "tg_only");
            }
            if (cmd === "/broadcast") {
                return await this.handleAdminBroadcastCommand(chat.id, argsStr);
            }
        }
    }

    /**
     * 🌟 现代化多功能 Inline Keyboard 按钮矩阵 (/start)
     */
    async handleStartCommand(chatId, from) {
        const groupLink = this.requiredGroup.startsWith("@") ? `https://t.me/${this.requiredGroup.slice(1)}` : "https://t.me/s5gydl";
        const groupName = this.requiredGroup || "@s5gydl";
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === String(from.id));

        const welcomeText =
            `🚀 *欢迎使用极速云全球多协议网络加速中枢！*

你好，*${this.escapeMd(from.first_name || "朋友")}*！
本服务为官方交流群专属福利，已实现全协议智能调度与机器人全自动开通。

📌 *注册条件与权益*：
• 🎯 *群员专享*：仅对官方群组 [${groupName}](${groupLink}) 成员开放；
• 🛡️ *一客一号*：每个 Telegram 仅限绑定 1 个专属账号；
• ⚡ *退群管控*：退群自动停用断网，重新进群秒级自愈复通；
• 🎁 *每日签到*：群员每天可通过机器人免费打卡领高速流量！

──────────────
📝 *快速注册方法 (私聊发送)*：
\`/reg <账号> <密码>\`
_例如：\`/reg test888 12345678\` (留空密码将自动生成随机密码)_

💡 *当前状态*：${user ? `已开通账号 (\`${user.username}\`)` : "未开通，请发送 /reg 注册"}`;

        // 现代高质感按钮矩阵
        const inlineRows = [];
        if (!user) {
            inlineRows.push([{ text: "🚀 一键极速开通节点 (无需输入)", callback_data: "cmd_quick_reg" }]);
        } else {
            inlineRows.push([
                { text: "📦 我的节点面板 (/my)", callback_data: "cmd_my" },
                { text: "🔗 提取通用订阅", callback_data: "cmd_copy_sub" }
            ]);
            const clashJumpUrl = (this.getAppImportUrl && user.uuid) ? this.getAppImportUrl(user.uuid, "clash") : "";
            const rocketJumpUrl = (this.getAppImportUrl && user.uuid) ? this.getAppImportUrl(user.uuid, "rocket") : "";
            const quickRow = [];
            if (rocketJumpUrl) quickRow.push({ text: "🚀 一键导入小火箭", url: rocketJumpUrl });
            if (clashJumpUrl) quickRow.push({ text: "⚡ 一键导入 Clash", url: clashJumpUrl });
            if (quickRow.length > 0) inlineRows.push(quickRow);
        }
        inlineRows.push([{ text: `👉 官方交流群 ${groupName}`, url: groupLink }]);
        inlineRows.push([
            { text: "🎁 每日签到打卡", callback_data: "cmd_checkin" },
            { text: "🌐 节点矩阵状态", callback_data: "cmd_nodes" }
        ]);
        inlineRows.push([
            { text: "💬 联系客服支持", url: groupLink }
        ]);

        const keyboard = { inline_keyboard: inlineRows };

        return await this.sendMessage(chatId, welcomeText, { reply_markup: keyboard });
    }

    /**
     * 🎁 每日签到领流量功能 (/checkin)
     */
    async handleCheckinCommand(chatId, from) {
        const senderId = String(from.id);
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === senderId);

        if (!user) {
            return await this.sendMessage(chatId, "⚠️ 您尚未注册账号，请先发送 `/reg <账号> [密码]` 注册后再参与签到！");
        }

        // 校验群成员身份 (退群人员不可签到)
        const check = await this.verifyUserInRequiredGroup(senderId);
        if (!check.inGroup) {
            return await this.sendMessage(chatId, `⚠️ 签到受限：您当前不在群组 ${this.requiredGroup} 中，无法参与签到领流量！`);
        }

        if (!this.checkinUser) {
            return await this.sendMessage(chatId, "系统未挂载签到引擎。");
        }

        const res = this.checkinUser(user.uuid);
        if (!res.success) {
            return await this.sendMessage(chatId, `⏳ *今日已完成签到*\n\n您今天已经打过卡啦，明天再来领取吧！\n下次可签到时间：\`明日 00:00 后\``);
        }

        const addTrafficMB = (res.addedBytes / (1024 * 1024)).toFixed(0);
        const totalGB = (res.newLimit / (1024 * 1024 * 1024)).toFixed(2);

        const checkinMsg =
            `🎉 *每日签到成功！*

• 🎁 本次签到奖励: \`+${addTrafficMB} MB\` 高速流量
• ⏳ 有效期限顺延: \`+1 天\` (至 ${new Date(res.newExpire).toLocaleDateString("zh-CN")})
• 📦 当前总配额: \`${totalGB} GB\`

感谢您对 [${this.requiredGroup}] 官方社群的支持！明日继续打卡可享持续复利！`;

        return await this.sendMessage(chatId, checkinMsg, {
            reply_markup: {
                inline_keyboard: [[{ text: "📦 查看我的订阅 (/my)", callback_data: "cmd_my" }]]
            }
        });
    }

    /**
     * 🌐 节点矩阵状态 (/nodes)
     */
    async handleNodesCommand(chatId) {
        const nodes = this.getNodesSummary ? this.getNodesSummary() : [];
        if (nodes.length === 0) {
            return await this.sendMessage(chatId, "🌐 正在实时探测节点矩阵状态，请稍后刷新。");
        }

        let msg = `🌐 *极速云节点网络矩阵实时大屏*\n\n`;
        nodes.forEach((n, idx) => {
            const statusEmoji = n.alive ? "🟢" : "🔴";
            msg += `${statusEmoji} *${idx + 1}. ${n.name}*\n   • 协议: \`${n.proto}\` | 端口: \`${n.port}\`\n   • 归属: \`${n.location || "主控节点"}\`\n`;
        });
        msg += `\n──────────────\n_所有节点均支持 UDP/Hysteria2/Reality 高抗封锁技术_`;

        return await this.sendMessage(chatId, msg, {
            reply_markup: {
                inline_keyboard: [[{ text: "🔄 刷新节点大屏", callback_data: "cmd_nodes" }]]
            }
        });
    }

    /**
     * 📖 客户端教程与一键导入引导
     */
    async handleClientGuide(chatId, from) {
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === String(from.id));
        const baseSubUrl = (user && this.getBaseSubUrl) ? this.getBaseSubUrl(user.uuid) : "";
        const clashSubUrl = baseSubUrl ? `${baseSubUrl}&type=clash` : "";

        const guideText =
            `📖 *主流代理客户端保姆级导入指南*

1️⃣ *Clash / Mihomo (推荐)*：
点击下方“一键导入 Clash”按钮，客户端将全自动添加配置并更新节点列表。

2️⃣ *Shadowrocket (小火箭)*：
打开小火箭右上角 [+] -> 类型选择 [Sub] -> 粘贴下方通用订阅地址并保存。

3️⃣ *v2rayN / Sing-box (Windows / Linux)*：
复制通用订阅地址 -> 点击“订阅分组” -> “添加/更新订阅”即可。

──────────────
🔗 *您的通用订阅地址*：
\`${baseSubUrl || "请先完成注册生成"}\``;

        const clashJumpUrl = (user && this.getAppImportUrl) ? this.getAppImportUrl(user.uuid, "clash") : "";

        const keyboard = {
            inline_keyboard: [
                clashJumpUrl ? [{ text: "⚡ 一键导入 Clash", url: clashJumpUrl }] : [],
                [{ text: "📦 返回我的面板", callback_data: "cmd_my" }]
            ].filter((r) => r.length > 0)
        };

        return await this.sendMessage(chatId, guideText, { reply_markup: keyboard });
    }

    /**
     * 👑 管理员控制台与可视化大屏 (/admin)
     */
    async handleAdminDashboardCommand(chatId) {
        const stats = this.getSystemStats ? this.getSystemStats() : {};
        const allUsers = this.getUsers();
        const tgBoundUsers = allUsers.filter((u) => u.telegramId).length;
        const activeUsersCount = allUsers.filter((u) => u.enabled).length;

        const memUsage = process.memoryUsage();
        const rssMB = (memUsage.rss / (1024 * 1024)).toFixed(1);
        const heapUsedMB = (memUsage.heapUsed / (1024 * 1024)).toFixed(1);

        const statusMsg =
            `👑 *极速云站长智能管理控制中心*

• 🌐 宿主公网: \`${stats.serverLocation || "自适应"}\`
• 🔌 活跃在线 IP: \`${stats.activeIpsCount || 0} 个\`
• 👥 总注册用户: \`${allUsers.length} 人\` (正常启用: \`${activeUsersCount}\` / TG绑定: \`${tgBoundUsers}\`)
• 🤖 限定审核群: \`${this.requiredGroup}\`
• 💾 进程内存占用: \`RSS ${rssMB} MB / 堆 ${heapUsedMB} MB\`
• ⏱️ 系统已运行: \`${Math.floor(process.uptime() / 60)} 分钟\`
• 🛡️ Sing-box 核心: \`${stats.singboxAlive ? "🟢 正常运行中" : "🔴 异常未运行"}\``;

        const webUrl = typeof this.adminWebUrl === "function" ? this.adminWebUrl() : (this.adminWebUrl || "");
        const keyboard = {
            inline_keyboard: [
                [
                    { text: "🔄 强启 Sing-box 核心", callback_data: "admin_restart_core" },
                    { text: "📊 查看最新用户列表", callback_data: "admin_list_users" }
                ],
                [
                    { text: "🔍 立即全员在群巡检", callback_data: "admin_audit" },
                    { text: "🌐 在线活跃 IP 监控", callback_data: "admin_online_ips" }
                ],
                [
                    { text: "📡 节点矩阵与大屏", callback_data: "cmd_nodes" },
                    { text: "📢 全员广播群发推送", callback_data: "admin_broadcast_tip" }
                ],
                [
                    webUrl ? { text: "🖥️ 打开 Web 管理后台", url: webUrl } : { text: "🖥️ Web 后台地址", callback_data: "admin_web_tip" },
                    { text: "🎁 全员发放 5GB 流量", callback_data: "admin_grant_all_5g" }
                ],
                [
                    { text: "🧹 清理 0 流量空账号", callback_data: "admin_clean_inactive" },
                    { text: "⚠️ 一键重置清空全库", callback_data: "admin_clear_dialog" }
                ],
                [
                    { text: "🔄 刷新系统监控大屏", callback_data: "admin_refresh" }
                ]
            ]
        };

        return await this.sendMessage(chatId, statusMsg, { reply_markup: keyboard });
    }

    /**
     * 强启 Sing-box 核心指令 (/restart)
     */
    async handleAdminRestartCoreCommand(chatId) {
        if (!this.restartSingboxCore) {
            return await this.sendMessage(chatId, "⚠️ 系统未挂载 Sing-box 核心控制引擎。");
        }
        await this.sendMessage(chatId, "⏳ 正在强制重启 Sing-box 核心进程并重载全量规则...");
        const res = this.restartSingboxCore();
        if (res.success) {
            return await this.sendMessage(chatId,
                `✅ *Sing-box 核心强启与重载成功！*
                
• 🚀 核心状态: \`🟢 正在平稳运行\`
• 🆔 最新进程 PID: \`${res.pid || "已接管"}\`
• ⏱️ 重启时间: \`${res.time || new Date().toLocaleTimeString("zh-CN")}\``,
                {
                    reply_markup: {
                        inline_keyboard: [[{ text: "👑 返回管理主屏", callback_data: "admin_refresh" }]]
                    }
                }
            );
        } else {
            return await this.sendMessage(chatId, `❌ 核心重启失败: ${res.error || "未知异常"}`);
        }
    }

    /**
     * 查看最新用户列表指令 (/users)
     */
    async handleAdminListUsersCommand(chatId) {
        const allUsers = this.getUsers();
        if (!allUsers || allUsers.length === 0) {
            return await this.sendMessage(chatId, "ℹ️ 当前用户库为空，暂无注册用户。", {
                reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }]] }
            });
        }
        const latestUsers = [...allUsers].reverse().slice(0, 10);
        let text = `📊 *最新注册用户速览 (共 ${allUsers.length} 人，展示最新 10 人)*\n\n`;
        latestUsers.forEach((u, i) => {
            const status = u.enabled ? "🟢" : "🔴";
            const tgStr = u.telegramId ? `[TG:${u.telegramUsername ? "@" + u.telegramUsername : u.telegramId}]` : "[未绑定TG]";
            const usedMB = ((u.trafficUsed || 0) / (1024 * 1024)).toFixed(1);
            const limitMB = ((u.trafficLimit || 0) / (1024 * 1024)).toFixed(0);
            const expireStr = u.expireTime ? new Date(u.expireTime).toLocaleDateString("zh-CN") : "长期";
            text += `${i + 1}. ${status} \`${u.username}\` ${tgStr}\n   • 流量: \`${usedMB}/${limitMB} MB\` | 到期: \`${expireStr}\`\n`;
        });
        text += `\n💡 提示: 发送 \`/deluser <用户名>\` 可精准删除，发送 \`/unbind <用户名或TG-ID>\` 可解绑。`;
        return await this.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🔄 刷新用户列表", callback_data: "admin_list_users" },
                        { text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }
                    ]
                ]
            }
        });
    }

    /**
     * 查看活跃在线 IP 监控 (/ips)
     */
    async handleAdminOnlineIpsCommand(chatId) {
        const details = this.getOnlineIpsDetails ? this.getOnlineIpsDetails() : [];
        if (!details || details.length === 0) {
            return await this.sendMessage(chatId, "🔌 *当前活跃在线 IP 监控*\n\n当前暂无活跃客户端长连接或所有用户处于休眠状态。", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🔄 刷新在线监控", callback_data: "admin_online_ips" },
                            { text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }
                        ]
                    ]
                }
            });
        }
        let text = `🔌 *当前活跃在线 IP 监控 (共 ${details.length} 个活跃账号)*\n\n`;
        details.slice(0, 15).forEach((item, idx) => {
            text += `${idx + 1}. 👤 \`${item.username}\` (活跃连接: ${item.activeConnections})\n`;
            item.ips.forEach((ip) => {
                text += `   • IP: \`${ip}\`\n`;
            });
        });
        return await this.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🔄 刷新在线监控", callback_data: "admin_online_ips" },
                        { text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }
                    ]
                ]
            }
        });
    }

    /**
     * 全员发放 5GB 流量补贴 (/grantall)
     */
    async handleAdminGrantAllCommand(chatId) {
        const allUsers = this.getUsers();
        if (!allUsers || allUsers.length === 0) {
            return await this.sendMessage(chatId, "⚠️ 当前没有注册用户可发放补贴。");
        }
        const addBytes = 5 * 1024 * 1024 * 1024;
        const addDaysMs = 7 * 86400000;
        const now = Date.now();
        let count = 0;
        allUsers.forEach((u) => {
            if (u.enabled) {
                u.trafficLimit = (u.trafficLimit || 0) + addBytes;
                u.expireTime = Math.max(now, u.expireTime || now) + addDaysMs;
                count++;
            }
        });
        return await this.sendMessage(chatId, `🎉 *全员福利发放完毕！*\n\n已成功为全部 \`${count}\` 位正常启用的用户追加：\n• 🎁 每人免费追加: \`5 GB\` 流量\n• ⏳ 有效期统一顺延: \`7 天\``, {
            reply_markup: {
                inline_keyboard: [[{ text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }]]
            }
        });
    }

    /**
     * 清理 0 流量空账号诊断
     */
    async handleAdminCleanInactiveCommand(chatId) {
        const allUsers = this.getUsers();
        const now = Date.now();
        const inactiveUsers = allUsers.filter((u) => {
            const isExpired = u.expireTime && u.expireTime < now - 3 * 86400000;
            const noTraffic = (u.trafficUsed || 0) === 0;
            return isExpired && noTraffic;
        });
        if (inactiveUsers.length === 0) {
            return await this.sendMessage(chatId, "✅ 经系统智能分析，当前未检测到长期过期且 0 流量的废弃账号，数据库非常健康！", {
                reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }]] }
            });
        }
        return await this.sendMessage(chatId, `🧹 *废弃死号排查报告*\n\n共扫描出 \`${inactiveUsers.length}\` 个长期过期且 0 流量账号。\n如需彻底清理，可发送命令：\n\`/deluser <用户名>\` 或进行一键清理。`, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回后台主屏", callback_data: "admin_refresh" }]] }
        });
    }

    /**
     * 一键清空全库防呆确认弹窗
     */
    async handleAdminClearDialog(chatId) {
        const text = `⚠️ *危险操作确认：一键清空用户数据*
        
请选择清空模式：
1. 【清空所有账号】：重置整个用户库 (包含 Web 与 TG 注册的所有账号)
2. 【仅清空 TG 账号】：仅清理通过 Telegram 注册绑定的账号，保留纯 Web 手动创建账号
        
⚠️ 此操作不可撤销，请谨慎点击！`;
        const keyboard = {
            inline_keyboard: [
                [{ text: "💥 确认清空全部账号 (模式:全部)", callback_data: "admin_clear_all" }],
                [{ text: "👥 仅清空 Telegram 绑定的账号", callback_data: "admin_clear_tg_only" }],
                [{ text: "❌ 取消并返回后台大屏", callback_data: "admin_refresh" }]
            ]
        };
        return await this.sendMessage(chatId, text, { reply_markup: keyboard });
    }

    /**
     * 管理员执行全员退群扫描指令 (/audit)
     */
    async handleAdminAuditCommand(chatId) {
        await this.sendMessage(chatId, "⏳ 正在启动全员 Telegram 在群健康巡检，请稍候...");
        const res = await this.auditAllMembers(true);
        return await this.sendMessage(chatId, `✅ *巡检报告结果*\n\n${res.report}`);
    }

    /**
     * 核心注册逻辑：/reg <用户名> [密码]
     */
    async handleRegisterCommand(chatId, from, argsStr) {
        const senderId = String(from.id);
        const groupLink = this.requiredGroup.startsWith("@") ? `https://t.me/${this.requiredGroup.slice(1)}` : "https://t.me/s5gydl";
        const groupName = this.requiredGroup || "@s5gydl";

        const parts = argsStr ? argsStr.split(/\s+/) : [];
        const cleanUser = parts[0] ? parts[0].trim() : "";
        let cleanPwd = parts[1] ? parts[1].trim() : "";

        if (!cleanUser) {
            return await this.sendMessage(chatId,
                `⚠️ *注册指令格式说明*

请指定您心仪的账号名称，格式如下：
\`/reg <用户名> [密码]\`

*示例 1 (自定义密码)*：
\`/reg tom888 12345678\`

*示例 2 (自动生成密码)*：
\`/reg tom888\`

_提示：用户名必须为 3-32 位字母、数字或下划线。_`);
        }

        if (!/^[a-zA-Z0-9_\-]{3,32}$/.test(cleanUser)) {
            return await this.sendMessage(chatId, "❌ *注册失败*：用户名仅支持 3-32 位的英文字母、数字、减号与下划线，请重新输入！");
        }

        if (!cleanPwd) {
            cleanPwd = crypto.randomBytes(4).toString("hex");
        } else if (cleanPwd.length < 4) {
            return await this.sendMessage(chatId, "❌ *注册失败*：密码长度不得少于 4 位字符！");
        }

        // 1. 严格校验群组 @s5gydl 成员身份
        const groupCheck = await this.verifyUserInRequiredGroup(senderId);
        if (!groupCheck.inGroup) {
            return await this.sendMessage(chatId,
                `🚫 *抱歉，您暂未取得注册资格！*

本节点加速中枢仅限官方交流群 [${groupName}](${groupLink}) 的正式成员专享免费注册。

👉 *开通步骤*：
1. 点击下方按钮加入官方群组；
2. 加入群组后，回到此处重新发送：\`/reg ${cleanUser} ${cleanPwd}\` 即可完成开通！`, {
                reply_markup: {
                    inline_keyboard: [[{ text: `👉 点击加入官方交流群 ${groupName}`, url: groupLink }]]
                }
            });
        }

        // 2. 严格保障一个 Telegram ID 只能注册 1 个账号
        const allUsers = this.getUsers();
        const existingTgUser = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === senderId);
        if (existingTgUser) {
            return await this.sendMessage(chatId,
                `⚠️ *注册受限：每个 Telegram 仅限拥有 1 个节点账号！*

您当前已绑定的账号为：\`${existingTgUser.username}\`

💡 发送 \`/my\` 可直接查看您的订阅地址与节点信息。`, {
                reply_markup: {
                    inline_keyboard: [[{ text: "📦 查询我的订阅 (/my)", callback_data: "cmd_my" }]]
                }
            });
        }

        // 3. 用户名重名校验
        const userLower = cleanUser.toLowerCase();
        if (allUsers.some((u) => u.username && u.username.toLowerCase() === userLower)) {
            return await this.sendMessage(chatId, `❌ *注册失败*：用户名 \`${cleanUser}\` 已被他人注册占用，请更换其他用户名重试！`);
        }

        if (!this.createUser) {
            return await this.sendMessage(chatId, "❌ 系统异常：未挂载用户创建引擎，请联系管理员。");
        }

        try {
            const newUser = await this.createUser({
                username: cleanUser,
                password: cleanPwd,
                telegramId: senderId,
                telegramUsername: from.username || "",
                telegramFirstName: from.first_name || ""
            });

            const baseSubUrl = this.getBaseSubUrl ? this.getBaseSubUrl(newUser.uuid) : "";
            const clashSubUrl = baseSubUrl ? `${baseSubUrl}&type=clash` : "";
            const expireDateStr = newUser.expireTime ? new Date(newUser.expireTime).toLocaleDateString("zh-CN") : "长期有效";
            const trafficLimitGB = (newUser.trafficLimit / (1024 * 1024 * 1024)).toFixed(2);

            const successMsg =
                `👤 *我的节点账号状态面板*

• 账号名称: \`${cleanUser}\`
• 服务状态: 🟢 正常可用
• 已用流量: \`0.00 GB / ${trafficLimitGB} GB\` (已用 0.0%)
• 剩余流量: \`${trafficLimitGB} GB\`
• 到期时间: \`${expireDateStr}\`

══════════════════════
🔗 *通用订阅链接 (小火箭 / v2rayN / Sing-box)*：
\`${baseSubUrl}\`

🚀 *Clash / Mihomo 专属订阅*：
\`${clashSubUrl}\`
══════════════════════`;

            const clashJumpUrl = (this.getAppImportUrl && newUser.uuid) ? this.getAppImportUrl(newUser.uuid, "clash") : "";
            const rocketJumpUrl = (this.getAppImportUrl && newUser.uuid) ? this.getAppImportUrl(newUser.uuid, "rocket") : "";
            const keyboard = {
                inline_keyboard: [
                    [
                        clashJumpUrl ? { text: "⚡ 一键导入 Clash", url: clashJumpUrl } : null,
                        rocketJumpUrl ? { text: "🚀 一键导入小火箭", url: rocketJumpUrl } : null
                    ].filter(Boolean),
                    [
                        { text: "📋 提取所有明文节点", callback_data: "cmd_copy_raw_nodes" },
                        { text: "🔗 提取通用订阅链接", callback_data: "cmd_copy_sub" }
                    ],
                    [
                        { text: "🎁 每日签到领流量", callback_data: "cmd_checkin" },
                        { text: "📦 刷新状态 (/my)", callback_data: "cmd_my" }
                    ]
                ]
            };

            await this.sendMessage(chatId, successMsg, { reply_markup: keyboard });

            if (this.adminId && this.adminId !== senderId) {
                const adminNotice =
                    `🔔 *新用户通过 Telegram 注册成功*
• 用户账号: \`${cleanUser}\`
• Telegram ID: \`${senderId}\`
• TG 用户名: @${from.username || "无"} (${this.escapeMd(from.first_name || "")})
• 认证来源群: ${groupName} (已通过)
• 配额: ${trafficLimitGB} GB / 到期: ${expireDateStr}`;
                this.sendMessage(this.adminId, adminNotice).catch(() => { });
            }

        } catch (e) {
            console.error("[TG-Bot] 创建用户异常:", e);
            return await this.sendMessage(chatId, `❌ *开通失败*：系统处理异常 (${e.message})，请联系站长处理。`);
        }
    }

    /**
     * /my 或 /sub 查询自己绑定的账号与订阅
     */
    async handleMySubscriptionCommand(chatId, from) {
        const senderId = String(from.id);
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === senderId);

        if (!user) {
            return await this.sendMessage(chatId,
                `⚠️ *未查询到已绑定的节点账号*

您当前尚未在系统中注册开通服务。
👉 发送指令：\`/reg <用户名> [密码]\` 即可立即免费开通！`, {
                reply_markup: {
                    inline_keyboard: [[{ text: "📖 查看注册指引 (/start)", callback_data: "cmd_start" }]]
                }
            });
        }

        const baseSubUrl = this.getBaseSubUrl ? this.getBaseSubUrl(user.uuid) : "";
        const clashSubUrl = baseSubUrl ? `${baseSubUrl}&type=clash` : "";

        const trafficLimitGB = (user.trafficLimit / (1024 * 1024 * 1024)).toFixed(2);
        const trafficUsedGB = (user.trafficUsed / (1024 * 1024 * 1024)).toFixed(2);
        const remainingGB = Math.max(0, (user.trafficLimit - user.trafficUsed) / (1024 * 1024 * 1024)).toFixed(2);
        const percent = user.trafficLimit > 0 ? Math.min(100, (user.trafficUsed / user.trafficLimit * 100)).toFixed(1) : "0.0";
        const expireStr = user.expireTime ? (user.expireTime < Date.now() ? "⚠️ 已过期" : new Date(user.expireTime).toLocaleDateString("zh-CN")) : "长期有效";
        const statusStr = user.enabled ? "🟢 正常可用" : `🔴 暂停中 (${user.disableReason || "已被禁用"})`;

        const infoText =
            `👤 *我的节点账号状态面板*

• 账号名称: \`${user.username}\`
• 服务状态: ${statusStr}
• 已用流量: \`${trafficUsedGB} GB / ${trafficLimitGB} GB\` (已用 ${percent}%)
• 剩余流量: \`${remainingGB} GB\`
• 到期时间: \`${expireStr}\`

══════════════════════
🔗 *通用订阅链接 (小火箭 / v2rayN / Sing-box)*：
\`${baseSubUrl}\`

🚀 *Clash / Mihomo 专属订阅*：
\`${clashSubUrl}\`
══════════════════════`;

        const clashJumpUrl = (this.getAppImportUrl && user.uuid) ? this.getAppImportUrl(user.uuid, "clash") : "";
        const rocketJumpUrl = (this.getAppImportUrl && user.uuid) ? this.getAppImportUrl(user.uuid, "rocket") : "";
        const inlineRows = [];

        // 1. 客户端专属一键导入 (通过服务端 HTTPS 安全跳板唤起，完全符合 Telegram Bot API 规范)
        const importRow = [];
        if (rocketJumpUrl) {
            importRow.push({ text: "🚀 一键导入小火箭", url: rocketJumpUrl });
        }
        if (clashJumpUrl) {
            importRow.push({ text: "⚡ 一键导入 Clash", url: clashJumpUrl });
        }
        if (importRow.length > 0) inlineRows.push(importRow);

        // 2. 独立纯文本提取通道（单行发送，手机一键长按复制，免去长文本筛选烦恼）
        inlineRows.push([
            { text: "🔗 提取通用订阅 (单行秒复制)", callback_data: "cmd_copy_sub" },
            { text: "📋 提取明文节点 (免订阅直连)", callback_data: "cmd_copy_raw_nodes" }
        ]);

        // 3. 运营与打卡
        inlineRows.push([
            { text: "🎁 每日签到领流量", callback_data: "cmd_checkin" },
            { text: "🔄 刷新数据 (/my)", callback_data: "cmd_my" }
        ]);

        const keyboard = { inline_keyboard: inlineRows };

        return await this.sendMessage(chatId, infoText, { reply_markup: keyboard });
    }

    /**
     * 🔗 独立提取通用订阅链接（单行发送，极其方便手机端一键点选复制）
     */
    async handleExtractUniversalSubCommand(chatId, from) {
        const senderId = String(from.id);
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === senderId);
        if (!user) {
            return await this.sendMessage(chatId, "⚠️ 您尚未注册开通节点服务，请发送 `/reg <用户名> [密码]` 注册后再提取！");
        }

        const baseSubUrl = this.getBaseSubUrl ? this.getBaseSubUrl(user.uuid) : "";
        if (!baseSubUrl) {
            return await this.sendMessage(chatId, "⚠️ 订阅链接生成异常，请联系站长配置服务器公网域名。");
        }

        const shadowrocketUrl = `sub://${Buffer.from(baseSubUrl).toString("base64")}`;
        const subMsg =
`📦 *您的专属通用节点订阅链接已生成*
适用客户端：*Shadowrocket (小火箭) / v2rayN / Sing-box / Loon / Quantumult X*

👇 *长按或轻触下方单行代码块一键复制*：
\`${baseSubUrl}\`

──────────────
💡 *推荐快捷使用*：
• 苹果 iOS 用户推荐直接点击下方按钮一键导入小火箭；
• 复制上方链接可在任意客户端添加为 Remote 远程订阅源。`;

        return await this.sendMessage(chatId, subMsg, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🚀 一键自动导入 Shadowrocket (小火箭)", url: shadowrocketUrl }],
                    [{ text: "📦 返回我的面板", callback_data: "cmd_my" }]
                ]
            }
        });
    }

    /**
     * 📋 独立提取明文单节点直连链接（适用不支持订阅的老旧客户端或离线直连）
     */
    async handleExtractRawNodesCommand(chatId, from) {
        const senderId = String(from.id);
        const allUsers = this.getUsers();
        const user = allUsers.find((u) => u.telegramId && String(u.telegramId).trim() === senderId);
        if (!user) {
            return await this.sendMessage(chatId, "⚠️ 您尚未注册开通节点服务，请发送 `/reg <用户名> [密码]` 注册后再提取！");
        }

        if (!this.getRawNodesText) {
            return await this.sendMessage(chatId, "⚠️ 系统未挂载明文节点生成引擎。");
        }

        const rawNodes = this.getRawNodesText(user);
        if (!rawNodes || !rawNodes.trim()) {
            return await this.sendMessage(chatId, "⚠️ 暂无可用的节点直连配置，请联系站长。");
        }

        const rawMsg =
`📋 *您的专属明文单节点链接列表* (免订阅直接导入)

👇 *长按或轻触下方区域复制所有节点*：
\`\`\`text
${rawNodes.trim()}
\`\`\`

──────────────
💡 *使用方法*：
复制以上以 \`vless://\`、\`vmess://\`、\`hysteria2://\`、\`trojan://\` 开头的全部内容，直接在小火箭 / v2rayN 中从剪贴板一键批量导入即可！`;

        return await this.sendMessage(chatId, rawMsg, {
            reply_markup: {
                inline_keyboard: [[{ text: "📦 返回我的面板", callback_data: "cmd_my" }]]
            }
        });
    }

    /**
     * /help 帮助说明
     */
    async handleHelpCommand(chatId, from, isAdmin) {
        let helpText =
            `📖 *Telegram 机器人功能指令大全*

🔹 *用户基础指令*：
• \`/start\` - 唤醒机器人并展示 6 宫格交互式面板
• \`/reg <账号> [密码]\` - 注册专属节点账号 (限群成员)
• \`/checkin\` - 每日打卡签到，免费领取流量与顺延天数
• \`/my\` - 查询已绑定账号状态与最新订阅链接
• \`/nodes\` - 查看实时节点网络矩阵健康大屏
• \`/help\` - 显示本帮助菜单`;

        if (isAdmin) {
            helpText +=
                `\n\n👑 *站长/管理员特权指令*：
• \`/admin\` 或 \`/status\` - 打开可视化站长控制台全功能大屏
• \`/restart\` - 强制重启 Sing-box 核心进程并重载全量规则
• \`/users\` - 快速列出最新注册用户及其流量与状态
• \`/ips\` - 查看当前活跃在线客户端 IP 与账号连接
• \`/grantall\` - 为全员正常用户发放 5GB 流量并顺延 7 天
• \`/audit\` - 立即手动触发全员在群状态深度巡检扫描
• \`/unbind <用户名或TG_ID>\` - 解除用户的 Telegram 账号绑定
• \`/deluser <用户名>\` - 从系统数据库中彻底删除用户
• \`/clearall confirm\` - 一键清空全库数据并断开全量连接
• \`/cleartg confirm\` - 仅清空 Telegram 绑定的账号
• \`/broadcast <通知内容>\` - 向所有绑定了 Telegram 的用户推送群发通知`;
        }

        return await this.sendMessage(chatId, helpText);
    }

    /**
     * 管理员 /unbind 解绑 TG
     */
    async handleAdminUnbindCommand(chatId, argsStr) {
        const target = (argsStr || "").trim();
        if (!target) return await this.sendMessage(chatId, "用法：`/unbind <用户名或TelegramID>`");
        if (!this.unbindUser) return await this.sendMessage(chatId, "系统未挂载解绑接口。");

        const res = this.unbindUser(target);
        if (res.success) {
            return await this.sendMessage(chatId, `✅ 成功解绑用户 \`${res.username}\` 的 Telegram 绑定关系，该用户现可重新注册！`);
        } else {
            return await this.sendMessage(chatId, `❌ 解绑失败: ${res.error || "未找到目标用户"}`);
        }
    }

    /**
     * 管理员 /deluser 删除用户
     */
    async handleAdminDelUserCommand(chatId, argsStr) {
        const target = (argsStr || "").trim();
        if (!target) return await this.sendMessage(chatId, "用法：`/deluser <用户名>`");
        if (!this.deleteUser) return await this.sendMessage(chatId, "系统未挂载删除接口。");

        const res = this.deleteUser(target);
        if (res.success) {
            return await this.sendMessage(chatId, `🗑️ 已成功从系统与 Sing-box 核心中彻底删除用户 \`${target}\`！`);
        } else {
            return await this.sendMessage(chatId, `❌ 删除失败: ${res.error || "未找到目标用户"}`);
        }
    }

    /**
     * 管理员一键清空用户账号 (/clearall /cleartg)
     */
    async handleAdminClearAllCommand(chatId, argsStr, mode = "all") {
        const confirmFlag = (argsStr || "").trim().toLowerCase();
        const isTgOnly = mode === "tg_only";
        const modeDesc = isTgOnly ? "所有通过 Telegram 绑定的用户" : "系统全部用户账号 (彻底清库)";
        const cmdName = isTgOnly ? "/cleartg" : "/clearall";

        if (confirmFlag !== "confirm") {
            const warnText = 
`⚠️ *【高危清空操作二次确认】*

您正在申请一键清空：*${modeDesc}*
• 动作：彻底删除对应用户数据、切断存量在线网络连接，并实时热重载 Sing-box 核心配置！
• 注意：此操作*完全不可逆*！

👉 *如果您确认立即清空，请点击下方确认按钮或私聊发送*：
\`${cmdName} confirm\``;

            return await this.sendMessage(chatId, warnText, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: `⚠️ 确认彻底清空 (${isTgOnly ? "仅清空TG用户" : "清空全部用户"})`, callback_data: `admin_clear_${mode}` }]
                    ]
                }
            });
        }

        if (!this.clearAllUsers) {
            return await this.sendMessage(chatId, "❌ 系统未挂载清空用户核心接口。");
        }

        const res = this.clearAllUsers(mode);
        return await this.sendMessage(chatId, 
`🗑️ *一键清空执行完成！*
• 清空范围: *${modeDesc}*
• 共清理账号数: \`${res.clearedCount || 0} 个\`
• 存量连接已切断，Sing-box 核心配置已同步实时清空！`);
    }

    /**
     * 管理员 /broadcast 群发通知
     */
    async handleAdminBroadcastCommand(chatId, content) {
        if (!content || !content.trim()) return await this.sendMessage(chatId, "用法：`/broadcast <广播通知内容>`");
        const allUsers = this.getUsers();
        const tgUsers = allUsers.filter((u) => u.telegramId && String(u.telegramId).trim() !== "");
        if (tgUsers.length === 0) return await this.sendMessage(chatId, "当前系统中暂无绑定 Telegram 的用户。");

        await this.sendMessage(chatId, `📢 开始向 ${tgUsers.length} 位用户推送广播...`);
        let sent = 0, failed = 0;
        const broadText = `📢 *官方系统重要通知*\n\n${content}\n\n──────────────\n_来自站长广播推送_`;

        for (const u of tgUsers) {
            try {
                await this.sendMessage(u.telegramId, broadText);
                sent++;
                await new Promise((r) => setTimeout(r, 100));
            } catch (_) {
                failed++;
            }
        }
        return await this.sendMessage(chatId, `✅ 广播推送完成！成功到达: ${sent} 人，失败: ${failed} 人。`);
    }

    /**
     * 处理按钮回调
     */
    async handleCallbackQuery(cb) {
        const data = cb.data;
        const from = cb.from;
        const msg = cb.message;
        if (!from || !msg) return;

        await this.answerCallbackQuery(cb.id);

        const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup" || Number(msg.chat.id) < 0;

        // 🌟 群聊铁律：群聊只引导私聊，不做任何业务响应
        if (isGroup) {
            const botUser = this.botInfo ? this.botInfo.username : "";
            const jumpUrl = botUser ? `https://t.me/${botUser}?start=start` : "";
            await this.answerCallbackQuery(cb.id, { text: "💡 群聊不处理任何业务，请点击按钮前往机器人私聊操作！", show_alert: true });
            if (jumpUrl) {
                await this.sendMessage(msg.chat.id, `👋 为保护账号隐私，群聊不处理任何业务。\n👉 请点击下方按钮进入机器人私聊操作：`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: "👉 点击直达私聊机器人 开启服务", url: jumpUrl }]]
                    },
                    parse_mode: undefined
                });
            }
            return;
        }

        if (data === "cmd_my") {
            await this.handleMySubscriptionCommand(msg.chat.id, from);
        } else if (data === "cmd_copy_sub") {
            await this.handleExtractUniversalSubCommand(msg.chat.id, from);
        } else if (data === "cmd_copy_raw_nodes") {
            await this.handleExtractRawNodesCommand(msg.chat.id, from);
        } else if (data === "cmd_quick_reg") {
            const rawName = from.username ? from.username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) : ("u" + String(from.id).slice(-6));
            const finalUser = (rawName && rawName.length >= 3) ? rawName : ("u" + String(from.id).slice(-8));
            await this.handleRegisterCommand(msg.chat.id, from, finalUser);
        } else if (data === "cmd_start") {
            await this.handleStartCommand(msg.chat.id, from);
        } else if (data === "cmd_checkin") {
            await this.handleCheckinCommand(msg.chat.id, from);
        } else if (data === "cmd_nodes") {
            await this.handleNodesCommand(msg.chat.id);
        } else if (data === "cmd_client_guide") {
            await this.handleClientGuide(msg.chat.id, from);
        } else if (data === "admin_restart_core") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminRestartCoreCommand(msg.chat.id);
            }
        } else if (data === "admin_list_users") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminListUsersCommand(msg.chat.id);
            }
        } else if (data === "admin_online_ips") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminOnlineIpsCommand(msg.chat.id);
            }
        } else if (data === "admin_grant_all_5g") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminGrantAllCommand(msg.chat.id);
            }
        } else if (data === "admin_clean_inactive") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminCleanInactiveCommand(msg.chat.id);
            }
        } else if (data === "admin_clear_dialog") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminClearDialog(msg.chat.id);
            }
        } else if (data === "admin_web_tip") {
            if (this.adminId && String(from.id) === this.adminId) {
                const webUrl = typeof this.adminWebUrl === "function" ? this.adminWebUrl() : (this.adminWebUrl || "");
                await this.sendMessage(msg.chat.id, `🖥️ *Web 后台管理地址*\n\n\`${webUrl || "请查看服务器 IP:端口/admin"}\``);
            }
        } else if (data === "admin_audit") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminAuditCommand(msg.chat.id);
            }
        } else if (data === "admin_refresh") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.handleAdminDashboardCommand(msg.chat.id);
            }
        } else if (data === "admin_broadcast_tip") {
            if (this.adminId && String(from.id) === this.adminId) {
                await this.sendMessage(msg.chat.id, "💡 请直接在私聊输入：\`/broadcast 想要发送的内容\` 即可执行全员群发！");
            }
        } else if (data === "admin_clear_all" || data === "admin_clear_tg_only") {
            if (this.adminId && String(from.id) === this.adminId) {
                const mode = data === "admin_clear_tg_only" ? "tg_only" : "all";
                await this.handleAdminClearAllCommand(msg.chat.id, "confirm", mode);
            }
        }
    }

    /**
     * 转义 Markdown 特殊字符
     */
    escapeMd(str) {
        if (!str) return "";
        // Telegram MarkdownV1 仅支持反斜杠转义 _ * ` [ 四种符号
        return String(str).replace(/([_*`\[])/g, "\\$1");
    }
    /**
     * 平滑热重启机器人引擎
     */
    async restart() {
        this.stop();
        await new Promise((r) => setTimeout(r, 600));
        return await this.start();
    }
}

// 单例实例与导出
let tgManagerInstance = null;

function initTelegramBot(options = {}) {
    if (!tgManagerInstance) {
        tgManagerInstance = new TelegramBotManager(options);
        tgManagerInstance.start().catch((e) => {
            console.warn("[TG-Bot] 启动异常:", e.message);
        });
    } else {
        tgManagerInstance.updateConfig(options);
        tgManagerInstance.restart().catch((e) => {
            console.warn("[TG-Bot] 热重启异常:", e.message);
        });
    }
    return tgManagerInstance;
}

function stopTelegramBot() {
    if (tgManagerInstance) {
        tgManagerInstance.stop();
    }
}

function getTelegramBotInstance() {
    return tgManagerInstance;
}

module.exports = {
    TelegramBotManager,
    initTelegramBot,
    stopTelegramBot,
    getTelegramBotInstance
};
