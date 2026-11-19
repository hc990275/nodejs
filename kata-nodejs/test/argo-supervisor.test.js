'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createArgoSupervisor, effectiveToken } = require('../src/argo-supervisor');

function fixture() {
    const children = [];
    const states = [];
    const timers = new Set();
    let now = 0;
    let ready = false;
    const supervisor = createArgoSupervisor({
        async launch() {
            const child = Object.assign(new EventEmitter(), {
                pid: children.length + 1, stderr: new EventEmitter(), signals: [],
                kill(signal) { this.signals.push(signal); }
            });
            children.push(child);
            return child;
        },
        onState: state => states.push(state), onLog() {}, probe: async () => ready,
        now: () => now,
        later(fn, ms) {
            const timer = { fn, at: now + ms };
            timers.add(timer);
            return timer;
        },
        cancel: timer => timers.delete(timer)
    });
    return { supervisor, children, states, timers, markReady() { ready = true; }, async advance(ms) {
        const until = now + ms;
        for (;;) {
            const timer = [...timers].sort((a, b) => a.at - b.at)[0];
            if (!timer || timer.at > until) break;
            timers.delete(timer);
            now = timer.at;
            await timer.fn();
            await Promise.resolve();
        }
        now = until;
    } };
}

test('unexpected exit retries with backoff; identical credentials leave the process alone', async () => {
    const { supervisor, children, states, advance } = fixture();
    supervisor.configure('first');
    await advance(0);
    supervisor.configure('first');
    assert.deepEqual(children[0].signals, []);
    children[0].emit('exit', 1);
    assert.equal(states.at(-1), 'reconnecting');
    await advance(3000);
    assert.equal(children.length, 2);
    children[1].emit('exit', 1);
    await advance(5999);
    assert.equal(children.length, 2);
    await advance(1);
    assert.equal(children.length, 3);
});

test('credential rotation waits for the old child and ignores its late events; clearing cancels restart', async () => {
    const { supervisor, children, states, advance } = fixture();
    supervisor.configure('first');
    await advance(0);
    supervisor.configure('second');
    assert.equal(children.length, 1);
    const old = children[0];
    assert.deepEqual(old.signals, ['SIGTERM']);
    old.emit('exit', 0);
    await advance(0);
    const replacement = children[1];
    old.emit('error', new Error('late event'));
    supervisor.configure('');
    assert.deepEqual(replacement.signals, ['SIGTERM']);
    replacement.emit('exit', 0);
    await advance(60000);
    assert.equal(states.at(-1), 'stopped');
    assert.equal(children.length, 2);
});

test('readiness is checked repeatedly and restarts a connector that never becomes ready', async () => {
    const { supervisor, children, states, advance, markReady } = fixture();
    supervisor.configure('first');
    await advance(0);
    const child = children[0];
    child.stderr.emit('data', 'Starting metrics server on 127.0.0.1:22222/metrics\n');
    await advance(94000);
    assert.deepEqual(child.signals, []);
    await advance(1000);
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('exit', 0);
    await advance(3000);
    children[1].stderr.emit('data', 'Starting metrics server on 127.0.0.1:22223/metrics\n');
    markReady();
    await advance(5000);
    assert.equal(states.at(-1), 'connected');
    supervisor.shutdown();
    children[1].emit('exit', 0);
    await advance(60000);
    assert.equal(children.length, 2);
});

test('an explicitly cleared .env value overrides a stale process environment', () => {
    const normalize = value => value?.trim() || '';
    assert.equal(effectiveToken({ ARGO_TOKEN: '' }, { ARGO_TOKEN: 'stale' }, normalize), '');
    assert.equal(effectiveToken({ ARGO_TOKEN: ' updated ' }, { ARGO_TOKEN: 'stale' }, normalize), 'updated');
    assert.equal(effectiveToken({}, { ARGO_TOKEN: 'configured' }, normalize), 'configured');
});
