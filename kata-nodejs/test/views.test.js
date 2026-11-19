'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8').replace(/\r\n/g, '\n');
const machineTag = () => '🇲🇳蒙古·25206';
const escapeHtml = value => String(value);
function declaration(name) {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
test('rendered page scripts parse and initialize in their own page context', () => {
    for (const name of ['renderHomepage', 'renderAdminLoginPage', 'renderAdminDashboardPage']) {
        const callbacks = [];
        const context = {
            siteSettings: { cfNodes: { ct: [], cu: [], cm: [], official: [] } },
            PORT: 20255, process, formatBytes: () => '-', machineTag, escapeHtml,
            renderCarrierRows: () => '',
            document: { getElementById: () => ({ value: '', style: {}, dataset: {}, focus() {}, addEventListener() {} }) },
            window: { addEventListener: (event, callback) => callbacks.push(callback) },
            fetch: async path => path === '/admin/api/users'
                ? { ok: true, json: async () => ({ users: [] }) }
                : { ok: false, status: 401, json: async () => ({}) },
            setInterval: () => 0, setTimeout: () => 0, console
        };
        vm.createContext(context);
        vm.runInContext(declaration(name), context);
        const html = vm.runInContext(name + '(null)', context);
        assert.match(html, /<!DOCTYPE html>/);
        assert.match(html, /<title>🇲🇳蒙古·25206 · Kata/);
        if (name === 'renderAdminLoginPage') {
            assert.doesNotMatch(html, /id="setupToken"/);
            const setup = vm.runInContext('renderAdminLoginPage(true)', context);
            assert.match(setup, /id="setupToken"/);
            assert.match(setup, /首次设置管理员密码/);
        }
        for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
            vm.runInContext(script[1], context);
        }
        for (const callback of callbacks) callback();
    }
});

test('admin user list renders existing users as text and sorts both ways', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value:'', innerHTML:'', style:{}, dataset:{} });
        return elements.get(id);
    };
    const context = {
        document:{getElementById:element}, location:{origin:'https://example.test'}, machineTag, escapeHtml,
        fetch: async path => path === '/admin/api/users'
            ? { ok: true, json: async () => ({ users: [] }) }
            : { ok: false, status: 401, json: async () => ({}) },
        console, setInterval:()=>0, setTimeout:()=>0
    };
    vm.createContext(context);
    vm.runInContext(declaration('renderAdminDashboardPage'),context);
    const html = vm.runInContext('renderAdminDashboardPage()',context);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1],context);
    vm.runInContext(`cachedUsersList = [
        {uuid:'a',username:'<img src=x>',trafficUsed:20,trafficUsedStr:'20 MB',enabled:true},
        {uuid:'b',username:'second',trafficUsed:100,trafficUsedStr:'100 MB',enabled:true}
    ]; filterUsers();`,context);
    const output = element('usersTbody').innerHTML;
    assert.match(output, /&lt;img src=x&gt;/);
    assert.doesNotMatch(output, /<img/);
    assert.match(output, /data-uuid="a"/);
    assert.match(output, /second/);
    vm.runInContext("toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'b');
    vm.runInContext("toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'a');
    vm.runInContext("toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'b');
    vm.runInContext("copyText = value => { globalThis.copied = value; }; copyUserSubscription('user-id')",context);
    assert.equal(context.copied,'https://example.test/sub?token=user-id');
    for (const field of ['trafficUsed', 'createdTime', 'onlineConns']) {
        assert.ok(html.includes(`id="th_sort_${field}"`));
    }
});

test('panel region code resolves to a localized country label', () => {
    const context = vm.createContext({});
    vm.runInContext(declaration('countryLabel'), context);
    assert.equal(vm.runInContext("countryLabel('mn')", context), '🇲🇳蒙古');
    assert.equal(vm.runInContext("countryLabel('sg')", context), '🇸🇬新加坡');
    assert.equal(vm.runInContext("countryLabel('invalid')", context), '');
});

test('first-run admin setup requires the initialization token and a successful write', () => {
    const start = source.indexOf("    if (pathname === '/admin/api/setup-password'");
    const end = source.indexOf("    if (pathname === '/admin/logout'", start);
    const route = new vm.Script('(function () {' + source.slice(start, end) + '})()');
    const initializationToken = 'test-only-initialization-token';
    const replies = [];
    const pendingBodies = [];
    const writes = [];
    let failWrite = true;
    const context = vm.createContext({
        pathname: '/admin/api/setup-password', method: 'POST', req: {},
        ENV_FILE: '.env', process: { env: {} }, crypto: require('node:crypto'),
        parseEnvFile: () => ({ ADMIN_SETUP_TOKEN: initializationToken }),
        isSameOriginRequest: () => true, getClientIp: () => 'local-test',
        passwordSetupRequired: true, ADMIN_PASSWORD: '', adminSessions: new Map(),
        adminLoginLimiter: { blocked: () => false, fail() {}, clear() {} },
        readBody: callback => pendingBodies.push(callback),
        sendJson: (response, status = 200) => replies.push({ status, response }),
        updateEnvFile: values => {
            if (failWrite) throw new Error('test write failure');
            writes.push(values);
        },
        cookieOptions: () => '', res: { setHeader() {} }, console: { log() {} }
    });
    const body = { setupToken: initializationToken, password: 'test-password-2026', confirm: 'test-password-2026' };
    const submit = data => {
        route.runInContext(context);
        pendingBodies.shift()(data);
        return replies.at(-1).status;
    };
    assert.equal(submit({ password: body.password, confirm: body.confirm }), 403);
    assert.equal(submit({ ...body, password: 'short', confirm: 'short' }), 400);
    assert.equal(submit(body), 500);
    assert.equal(context.passwordSetupRequired, true);
    assert.equal(context.adminSessions.size, 0);
    failWrite = false;
    route.runInContext(context);
    assert.equal(submit(body), 200);
    pendingBodies.shift()(body);
    assert.equal(replies.at(-1).status, 409);
    assert.equal(context.passwordSetupRequired, false);
    assert.equal(context.adminSessions.size, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].ADMIN_PASSWORD, body.password);
    assert.equal(writes[0].ADMIN_SETUP_TOKEN, '');
});
