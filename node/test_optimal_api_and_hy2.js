const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.SERVER_PORT = "19993";
const nodeCore = require("./index.js");

console.log("=== 1. 执行 generateSingboxConfig 并校验生成的 config.json ===");
nodeCore.generateSingboxConfig();

const configPath = path.join(__dirname, "config.json");
assert(fs.existsSync(configPath), "config.json 必须存在");
const singboxCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

// 校验 DNS 模块
assert(singboxCfg.dns, "sing-box 配置必须包含 dns 模块");
assert(Array.isArray(singboxCfg.dns.servers), "dns.servers 必须为数组");
assert.strictEqual(singboxCfg.dns.servers[0].address, "tcp://1.1.1.1", "主 DNS 必须为 tcp://1.1.1.1");
assert.strictEqual(singboxCfg.dns.servers[1].address, "tcp://8.8.8.8", "备用 DNS 必须为 tcp://8.8.8.8");

// 校验 Outbounds 模块必须包含 direct 与 dns-out
assert(singboxCfg.outbounds && singboxCfg.outbounds.length >= 2, "outbounds 必须至少包含 direct 与 dns-out");
const dnsOut = singboxCfg.outbounds.find(o => o.type === "dns" && o.tag === "dns-out");
assert(dnsOut, "必须包含 tag 为 dns-out 的 dns 类型出站，接管客户端 DNS 查询");

// 校验 Route 模块
assert(singboxCfg.route, "sing-box 配置必须包含 route 模块");
assert(singboxCfg.route.rules && singboxCfg.route.rules.length > 0, "route 模块必须包含转发规则");
assert.strictEqual(singboxCfg.route.rules[0].protocol, "dns", "第一条路由必须匹配 dns 协议");
assert.strictEqual(singboxCfg.route.rules[0].outbound, "dns-out", "第一条路由必须指向 dns-out 出站接管解析");

// 校验 Hysteria 2 inbound
const hy2Inbound = singboxCfg.inbounds.find(i => i.type === "hysteria2");
assert(hy2Inbound, "必须包含 hysteria2 入站");
assert(hy2Inbound.users && hy2Inbound.users[0].name, "hy2 入站必须包含带有 name 属性的标准 user 对象");
assert.strictEqual(hy2Inbound.ignore_client_bandwidth, false, "hy2 入站 ignore_client_bandwidth 必须为 false");
assert.strictEqual(hy2Inbound.up_mbps, 2000, "hy2 入站 up_mbps 必须为 2000");

console.log("✅ 1. Sing-box 核心配置 (DNS / Route / dns-out / Hy2 带宽) 校验完全正确！");

console.log("=== 2. 校验三网优选 API 配置与数据结构 (微测网 + CM佬) ===");
// 校验微测网
assert(nodeCore.siteSettings.enableOptWetest !== undefined, "必须包含 enableOptWetest 配置项");
assert(nodeCore.siteSettings.wetestNodes, "必须包含 wetestNodes 优选池对象");
assert(Array.isArray(nodeCore.siteSettings.wetestNodes.ct), "必须包含微测网电信优选列表");
assert(Array.isArray(nodeCore.siteSettings.wetestNodes.cu), "必须包含微测网联通优选列表");
assert(Array.isArray(nodeCore.siteSettings.wetestNodes.cm), "必须包含微测网移动优选列表");

// 校验 CM 佬
assert(nodeCore.siteSettings.enableOptCMApi !== undefined, "必须包含 enableOptCMApi 配置项");
assert(nodeCore.siteSettings.cmNodes, "必须包含 cmNodes 优选池对象");
assert(Array.isArray(nodeCore.siteSettings.cmNodes.ct), "必须包含 CM电信优选列表");
assert(Array.isArray(nodeCore.siteSettings.cmNodes.cu), "必须包含 CM联通优选列表");
assert(Array.isArray(nodeCore.siteSettings.cmNodes.cm), "必须包含 CM移动优选列表");

console.log("✅ 2. 三网优选 API (微测网 + CM佬) 配置与持久化数据结构校验完全正确！");

console.log("=== 3. 校验回溯域名下微测网、CM优选与自定义域名节点生成 ===");
// 模拟注入微测网节点
nodeCore.siteSettings.enableOptWetest = true;
nodeCore.siteSettings.wetestNodes.ct = [{ ip: "162.159.140.1", colo: "HKG", rtt: 18 }];
nodeCore.siteSettings.wetestNodes.cu = [{ ip: "162.159.141.1", colo: "SJC", rtt: 120 }];
nodeCore.siteSettings.wetestNodes.cm = [{ ip: "162.159.142.1", colo: "TYO", rtt: 45 }];

// 模拟注入 CM 优选节点
nodeCore.siteSettings.enableOptCMApi = true;
nodeCore.siteSettings.cmNodes.ct = [{ ip: "104.16.10.1", port: 443 }];
nodeCore.siteSettings.cmNodes.cu = [{ ip: "104.16.20.1", port: 443 }];
nodeCore.siteSettings.cmNodes.cm = [{ ip: "104.16.30.1", port: 443 }];
nodeCore.siteSettings.enableCustomDomains = true;
nodeCore.siteSettings.customDomainsText = "cf.090227.xyz#测试优选CDN\nhk.test.com:8443#高防8443";

const mockUser = {
    uuid: "11111111-2222-3333-4444-555555555555",
    username: "testuser",
    trafficLimit: 10737418240,
    trafficUsed: 0,
    expireTime: Date.now() + 86400000,
    enabled: true
};

const mockReqWithDomain = {
    headers: { host: "shop.995677.xyz" }
};

const structuredNodes = nodeCore.getStructuredNodesForUser(mockUser, mockReqWithDomain);
console.log("生成的节点总数:", structuredNodes.length);
const nodeNames = structuredNodes.map(n => n.name);
console.log("节点名称清单:", nodeNames);

assert(nodeNames.some(n => n.includes("微测·电信优选1")), "必须包含微测电信优选节点");
assert(nodeNames.some(n => n.includes("微测·联通优选1")), "必须包含微测联通优选节点");
assert(nodeNames.some(n => n.includes("微测·移动优选1")), "必须包含微测移动优选节点");
assert(nodeNames.some(n => n.includes("电信优选1")), "必须包含 CM电信优选节点");
assert(nodeNames.some(n => n.includes("联通优选1")), "必须包含 CM联通优选节点");
assert(nodeNames.some(n => n.includes("移动优选1")), "必须包含 CM移动优选节点");
assert(nodeNames.some(n => n.includes("测试优选CDN")), "必须包含自定义域名节点 1");
assert(nodeNames.some(n => n.includes("高防8443")), "必须包含自定义域名节点 2");
assert(nodeNames.some(n => n.includes("直连-Hysteria2")), "必须保留直连-Hysteria2 节点");

// 校验 Hysteria 2 单链接导出格式
const rawSubBase64 = nodeCore.getNodesForUser(mockUser, mockReqWithDomain);
const subText = Buffer.from(rawSubBase64, "base64").toString("utf8");
console.log("Base64 订阅解码后内容前缀:\n", subText.split("\n").slice(0, 5).join("\n"));

const hy2Line = subText.split("\n").find(l => l.startsWith("hysteria2://"));
assert(hy2Line, "订阅中必须包含 hysteria2 链接");
assert(hy2Line.includes("/?") && hy2Line.includes("upmbps=2000") && hy2Line.includes("insecure=1") && hy2Line.includes("allowInsecure=1"), "Hysteria 2 链接必须包含标准根路径斜杠 /?、upmbps=2000、insecure=1 与 allowInsecure=1！");

// 校验 Clash YAML 配置
const clashYaml = nodeCore.generateClashConfig(mockUser, mockReqWithDomain);
assert(clashYaml.includes("🇨🇳 电信优选"), "Clash 必须包含电信优选策略组");
assert(clashYaml.includes("🇨🇳 联通优选"), "Clash 必须包含联通优选策略组");
assert(clashYaml.includes("🇨🇳 移动优选"), "Clash 必须包含移动优选策略组");
assert(clashYaml.includes("⚡ 自动优选"), "Clash 必须包含自动优选策略组");
assert(clashYaml.includes("https://dns.alidns.com/dns-query"), "Clash 必须包含权威 DoH DNS");

console.log("✅ 3. 三网优选节点下发、URI 标准格式与 Clash 策略组校验 100% 通过！");
console.log("🎉 全部自动化测试绿灯圆满通过！");
process.exit(0);
