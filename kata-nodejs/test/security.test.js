'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, safeUser, createRateLimiter, MAX_BODY_BYTES } = require('../src/security');

test('password hashes use salted PBKDF2 and verify without timing-sensitive string comparison', () => {
    const first = hashPassword('correct horse battery staple');
    const second = hashPassword('correct horse battery staple');
    assert.match(first, /^pbkdf2\$210000\$/);
    assert.notEqual(first, second);
    assert.equal(verifyPassword('correct horse battery staple', first), true);
    assert.equal(verifyPassword('wrong password', first), false);
});

test('legacy SHA-256 password hashes remain verifiable for migration', () => {
    const crypto = require('node:crypto');
    const legacy = crypto.createHash('sha256').update('legacy-pass').digest('hex');
    assert.equal(verifyPassword('legacy-pass', legacy), true);
    assert.equal(verifyPassword('incorrect', legacy), false);
});

test('public user serialization never includes password hashes', () => {
    const user = { uuid: 'id', username: 'alice', passwordHash: 'private', trafficUsed: 3 };
    assert.deepEqual(safeUser(user), { uuid: 'id', username: 'alice', trafficUsed: 3 });
    assert.equal(safeUser(null), null);
});

test('login rate limiter locks after configured failures and clears after success', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    assert.equal(limiter.blocked('ip'), false);
    limiter.fail('ip');
    limiter.fail('ip');
    assert.equal(limiter.blocked('ip'), true);
    limiter.clear('ip');
    assert.equal(limiter.blocked('ip'), false);
    limiter.fail('ip');
    now += 1001;
    assert.equal(limiter.blocked('ip'), false);
});

test('JSON request body limit is bounded', () => {
    assert.equal(MAX_BODY_BYTES, 64 * 1024);
});
