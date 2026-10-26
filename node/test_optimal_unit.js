const assert = require("assert");
const fs = require("fs");
const path = require("path");

// 读取 index.js 中的关键函数进行单元测试
const indexCode = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

// 提取 parseCmApiLines 函数
const parseCmApiLinesFn = new Function(indexCode.match(/function parseCmApiLines\([\s\S]*?\n\}/)[0] + "; return parseCmApiLines;")();

// 提取 parseCustomDomainLine 函数
const parseCustomDomainLineFn = new Function(indexCode.match(/function parseCustomDomainLine\([\s\S]*?\n\}/)[0] + "; return parseCustomDomainLine;")();

console.log("=== 1. 测试 CM佬 API 解析器 ===");
const sampleApiText = `
104.16.1.1:443#香港
104.16.2.2#默认443
# 这是注释行
104.16.3.3:8443
`;
const parsedCm = parseCmApiLinesFn(sampleApiText);
console.log("解析出的 CM IP:", parsedCm);
assert.strictEqual(parsedCm.length, 3);
assert.strictEqual(parsedCm[0].ip, "104.16.1.1");
assert.strictEqual(parsedCm[0].port, 443);
assert.strictEqual(parsedCm[1].ip, "104.16.2.2");
assert.strictEqual(parsedCm[1].port, 443);
assert.strictEqual(parsedCm[2].ip, "104.16.3.3");
assert.strictEqual(parsedCm[2].port, 8443);
console.log("✅ CM佬 API 文本解析测试通过！");

console.log("=== 2. 测试批量自定义优选域名解析器 ===");
const custom1 = parseCustomDomainLineFn("cf.090227.xyz");
assert.strictEqual(custom1.host, "cf.090227.xyz");
assert.strictEqual(custom1.port, 443);
assert.strictEqual(custom1.remark, "cf.090227.xyz");

const custom2 = parseCustomDomainLineFn("cf.090227.xyz#香港高防CDN");
assert.strictEqual(custom2.host, "cf.090227.xyz");
assert.strictEqual(custom2.port, 443);
assert.strictEqual(custom2.remark, "香港高防CDN");

const custom3 = parseCustomDomainLineFn("hk.example.com:8443#香港8443");
assert.strictEqual(custom3.host, "hk.example.com");
assert.strictEqual(custom3.port, 8443);
assert.strictEqual(custom3.remark, "香港8443");

const custom4 = parseCustomDomainLineFn("hk.example.com:2053");
assert.strictEqual(custom4.host, "hk.example.com");
assert.strictEqual(custom4.port, 2053);

console.log("✅ 批量自定义加速域名解析测试通过！");

console.log("=== 3. 验证 Hysteria 2 URI 格式规范 ===");
const hy2Regex = /linkList\.push\(`hysteria2:\/\/\$\{n\.password\}@\$\{n\.server\}:\$\{n\.port\}\/\?sni=\$\{n\.sni\}&alpn=h3&insecure=1&allowInsecure=1#\$\{encName\}`\);/;
assert(hy2Regex.test(indexCode), "Hysteria 2 单链接 URI 必须包含标准根斜杠 /?、alpn=h3、insecure=1 以及 allowInsecure=1！");
console.log("✅ Hysteria 2 URI 兼容性格式测试通过！");

console.log("=== 4. 验证 TUIC URI 格式规范 ===");
const tuicRegex = /linkList\.push\(`tuic:\/\/\$\{n\.uuid\}:\$\{n\.password\}@\$\{n\.server\}:\$\{n\.port\}\/\?congestion_control=\$\{n\.congestion_control\}&sni=\$\{n\.sni\}&alpn=h3&allow_insecure=1&insecure=1#\$\{encName\}`\);/;
assert(tuicRegex.test(indexCode), "TUIC 单链接 URI 必须包含标准根斜杠 /?、alpn=h3、allow_insecure=1 以及 insecure=1！");
console.log("✅ TUIC URI 兼容性格式测试通过！");

console.log("=== 5. 验证 Clash 策略组中三网优选与权威 DoH ===");
assert(indexCode.includes("🇨🇳 电信优选"), "Clash 策略组必须包含电信优选");
assert(indexCode.includes("🇨🇳 联通优选"), "Clash 策略组必须包含联通优选");
assert(indexCode.includes("🇨🇳 移动优选"), "Clash 策略组必须包含移动优选");
assert(indexCode.includes("https://dns.alidns.com/dns-query"), "Clash 配置必须包含阿里 DoH");
assert(indexCode.includes("https://doh.pub/dns-query"), "Clash 配置必须包含腾讯 DoH");
console.log("✅ Clash 策略组与权威 DoH 验证通过！");

console.log("🎉 所有逻辑单元测试 100% 验证成功！");
