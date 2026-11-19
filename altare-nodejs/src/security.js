'use strict';

const crypto = require('node:crypto');

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_BYTES = 32;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

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
    // Existing installations use SHA-256. Verify old hashes in constant time,
    // then callers can upgrade them after a successful login.
    if (/^[a-f0-9]{64}$/i.test(encoded)) {
        const actual = crypto.createHash('sha256').update(String(password)).digest();
        return crypto.timingSafeEqual(actual, Buffer.from(encoded, 'hex'));
    }
    return false;
}

function safeUser(user) {
    if (!user || typeof user !== 'object') return null;
    const { passwordHash, ...publicUser } = user;
    return publicUser;
}

function createRateLimiter({ limit = MAX_FAILED_ATTEMPTS, windowMs = LOCKOUT_MS, now = Date.now } = {}) {
    const attempts = new Map();
    return {
        blocked(key) {
            const current = (attempts.get(key) || []).filter(time => now() - time < windowMs);
            if (current.length) attempts.set(key, current);
            else attempts.delete(key);
            return current.length >= limit;
        },
        fail(key) {
            const current = (attempts.get(key) || []).filter(time => now() - time < windowMs);
            current.push(now());
            attempts.set(key, current);
        },
        clear(key) {
            attempts.delete(key);
        },
        prune() {
            const cutoff = now() - windowMs;
            for (const [key, values] of attempts) {
                const current = values.filter(time => time >= cutoff);
                if (current.length) attempts.set(key, current);
                else attempts.delete(key);
            }
        }
    };
}

module.exports = {
    MAX_BODY_BYTES,
    hashPassword,
    verifyPassword,
    safeUser,
    createRateLimiter
};
