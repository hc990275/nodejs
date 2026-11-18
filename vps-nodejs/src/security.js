'use strict';

const crypto = require('node:crypto');

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_BYTES = 32;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(String(password), salt, PASSWORD_ITERATIONS, PASSWORD_BYTES, 'sha256').toString('hex');
    return `pbkdf2$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
    if (typeof encoded !== 'string') return false;
    const match = /^pbkdf2\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
    if (match) {
        const [, rounds, salt, expected] = match;
        const actual = crypto.pbkdf2Sync(String(password), salt, Number(rounds), PASSWORD_BYTES, 'sha256');
        return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
    }
    // 兼容旧版 SHA-256 哈希：常数时间校验，登录成功后由调用方透明升级为 PBKDF2
    if (/^[a-f0-9]{64}$/i.test(encoded)) {
        const actual = crypto.createHash('sha256').update(String(password)).digest();
        return crypto.timingSafeEqual(actual, Buffer.from(encoded, 'hex'));
    }
    return false;
}

function isLegacyHash(encoded) {
    return typeof encoded === 'string' && /^[a-f0-9]{64}$/i.test(encoded) && !encoded.startsWith('pbkdf2$');
}

// 用户名白名单：3-48 位，字母（含中文）/数字/点/下划线/连字符
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,48}$/u;

// HTML 转义：所有插入 innerHTML 的动态字段必须先过此函数
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isSameOriginRequest(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        const host = req.headers.host;
        return Boolean(host && parsed.host.toLowerCase() === host.toLowerCase());
    } catch (_) {
        return false;
    }
}

module.exports = { hashPassword, verifyPassword, isLegacyHash, USERNAME_RE, esc, isSameOriginRequest };
