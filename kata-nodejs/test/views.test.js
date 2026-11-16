'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../index.js'), 'utf8').replace(/\r\n/g, '\n');
function declaration(name) {
    const start = source.indexOf('function ' + name + '(');
    return source.slice(start, source.indexOf('\n}', start) + 2);
}
test('rendered page scripts parse and initialize in their own page context', () => {
    for (const name of ['renderHomepage', 'renderAdminLoginPage', 'renderAdminDashboardPage']) {
        const callbacks = [];
        const context = {
            siteSettings: { cfNodes: { ct: [], cu: [], cm: [], official: [] } },
            PORT: 20255, process, formatBytes: () => '-',
            renderCarrierRows: () => '',
            document: { getElementById: () => ({ value: '', style: {}, dataset: {}, focus() {}, addEventListener() {} }) },
            window: { addEventListener: (event, callback) => callbacks.push(callback) },
            fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
            setInterval: () => 0, setTimeout: () => 0, console
        };
        vm.createContext(context);
        vm.runInContext(declaration(name), context);
        const html = vm.runInContext(name + '(null)', context);
        assert.match(html, /<!DOCTYPE html>/);
        for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
            vm.runInContext(script[1], context);
        }
        for (const callback of callbacks) callback();
    }
});

test('admin compact users expand on demand, escape content, sort both ways and copy subscriptions', () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { value:'', innerHTML:'', style:{}, dataset:{} });
        return elements.get(id);
    };
    const context = {
        document:{getElementById:element}, location:{origin:'https://example.test'},
        fetch:async()=>({ok:false,json:async()=>({})}), console, setInterval:()=>0, setTimeout:()=>0
    };
    vm.createContext(context);
    vm.runInContext(declaration('renderAdminDashboardPage'),context);
    const html = vm.runInContext('renderAdminDashboardPage()',context);
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1],context);
    vm.runInContext(`cachedUsersList = [
        {uuid:'a',username:'<img src=x>',trafficUsed:20,trafficUsedStr:'20 MB',enabled:true},
        {uuid:'b',username:'second',trafficUsed:100,trafficUsedStr:'100 MB',enabled:true}
    ]; filterUsers();`,context);
    let output=element('usersTbody').innerHTML;
    assert.match(output,/aria-expanded="false"/);
    assert.match(output,/复制订阅/);
    assert.doesNotMatch(output,/class="user-details"/);
    assert.match(output,/&lt;img src=x&gt;/);
    vm.runInContext("toggleUserDetails('a')",context);
    assert.match(element('usersTbody').innerHTML,/class="user-details"/);
    vm.runInContext("toggleUserDetails('a'); toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'b');
    vm.runInContext("toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'a');
    vm.runInContext("toggleUserSort('trafficUsed')",context);
    assert.equal(vm.runInContext('filteredUsersList[0].uuid',context),'b');
    vm.runInContext("copyText = value => { globalThis.copied = value; }; copyUserSubscription('user-id')",context);
    assert.equal(context.copied,'https://example.test/sub?token=user-id');
    assert.match(html,/class="user-sort-bar"/);
});
