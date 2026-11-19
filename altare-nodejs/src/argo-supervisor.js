'use strict';

const http = require('node:http');

function connectorReady(port) {
    return new Promise(resolve => {
        const request = http.get({ host: '127.0.0.1', port, path: '/ready', signal: AbortSignal.timeout(2500) }, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
    });
}

function effectiveToken(fileEnv, processEnv, normalize) {
    return normalize(Object.hasOwn(fileEnv, 'ARGO_TOKEN') ? fileEnv.ARGO_TOKEN : processEnv.ARGO_TOKEN);
}

function createArgoSupervisor({ launch, onState, onLog, probe = connectorReady,
    later = setTimeout, cancel = clearTimeout, now = Date.now }) {
    let token = '';
    let current = null;
    let launching = false;
    let retryTimer;
    let delay = 3000;
    let closed = false;

    const defer = (fn, ms) => {
        const timer = later(fn, ms);
        timer?.unref?.();
        return timer;
    };

    function retry() {
        if (closed || !token || current || launching || retryTimer !== undefined) return;
        onState('reconnecting');
        retryTimer = defer(() => {
            retryTimer = undefined;
            void reconcile();
        }, delay);
        delay = Math.min(60000, delay * 2);
    }

    function retire(connection, replaceImmediately = false) {
        if (connection.retiring) return;
        connection.retiring = true;
        connection.replaceImmediately = replaceImmediately;
        if (connection.healthTimer !== undefined) cancel(connection.healthTimer);
        connection.killTimer = defer(() => {
            if (current === connection) connection.child.kill('SIGKILL');
        }, 5000);
        connection.child.kill('SIGTERM');
    }

    function observe(child, activeToken) {
        const connection = { child, started: now(), failed: 0, port: 0, partial: '', retiring: false };
        current = connection;
        function finished() {
            if (current !== connection) return;
            if (connection.healthTimer !== undefined) cancel(connection.healthTimer);
            if (connection.killTimer !== undefined) cancel(connection.killTimer);
            current = null;
            if (closed || !token) onState('stopped');
            else if (connection.replaceImmediately) void reconcile();
            else retry();
        }
        child.once('exit', finished);
        child.on('error', () => {
            if (current !== connection) return;
            if (!child.pid) finished();
            else onLog('cloudflared process signal failed');
        });
        function log(chunk) {
            if (current !== connection || connection.retiring) return;
            const text = connection.partial + String(chunk);
            const lines = text.split(/\r?\n/);
            connection.partial = lines.pop().slice(-8192);
            for (const line of lines) {
                const port = /Starting metrics server on 127\.0\.0\.1:(\d+)\/metrics/.exec(line)?.[1];
                if (port) connection.port = Number(port);
                if (line) onLog(line.split(activeToken).join('[redacted]'));
            }
        }
        child.stdout?.on('data', log);
        child.stderr?.on('data', log);

        async function health() {
            if (current !== connection || connection.retiring) return;
            let ready = false;
            try {
                if (connection.port) ready = await probe(connection.port);
            } catch (_) { /* Treat a failed readiness check as unavailable. */ }
            if (current !== connection || connection.retiring) return;
            if (ready) {
                connection.failed = 0;
                delay = 3000;
                onState('connected');
            } else {
                connection.failed++;
                if (connection.failed >= 3 && now() - connection.started >= 90000) {
                    onLog('Cloudflare connector failed consecutive readiness checks');
                    onState('reconnecting');
                    retire(connection);
                    return;
                }
            }
            connection.healthTimer = defer(health, 30000);
        }
        connection.healthTimer = defer(health, 5000);
    }

    async function reconcile() {
        if (closed || !token || current || launching) return;
        launching = true;
        const activeToken = token;
        const stillWanted = () => !closed && token === activeToken;
        onState('starting');
        try {
            const child = await launch(activeToken, stillWanted);
            launching = false;
            if (child) observe(child, activeToken);
            if (!stillWanted()) {
                if (current) retire(current, true);
                else void reconcile();
            } else if (!child) retry();
        } catch (_) {
            launching = false;
            if (!stillWanted()) return void reconcile();
            onLog('Unable to start cloudflared');
            retry();
        }
    }

    function configure(nextToken) {
        if (closed || token === nextToken) return;
        token = nextToken;
        delay = 3000;
        if (retryTimer !== undefined) cancel(retryTimer);
        retryTimer = undefined;
        if (!token) onState('stopped');
        else onState('starting');
        if (current) retire(current, true);
        else void reconcile();
    }

    function shutdown() {
        configure('');
        closed = true;
    }

    return { configure, shutdown };
}

module.exports = { createArgoSupervisor, effectiveToken };
