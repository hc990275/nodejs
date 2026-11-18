"use strict";
const net = require("node:net");
const YAML = require("./yaml-lite");
// 本地生成模式：本项目从 VLESS URI 生成节点，不联网拉取订阅。
// 保留 fetchSubscription 签名以兼容导出，实际不会被调用。
const fetchSubscription = async () => { throw new Error("本项目不使用远程订阅拉取"); };
const MAX_NODES = 2000;
const decode = s => Buffer.from(s, "base64").toString("utf8");
const encode = s => Buffer.from(s).toString("base64");
const hostname = s => String(s || "").replace(/^\[|\]$/g, "");
const address = n => `${net.isIP(n.server) === 6 ? `[${n.server}]` : n.server}:${n.port}`;

function parseAlpn(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  if (values.length > 16 || values.some(v => typeof v !== "string" || !/^[\x21-\x7e]{1,255}$/.test(v.trim()))) throw new Error("ALPN 格式无效");
  return [...new Set(values.map(v => v.trim()))];
}
function getAlpn(n) {
  if (!n.tls) return [];
  // 启用 ECH 的节点不输出 alpn：ECH 握手由 ECHConfigList 决定，显式 alpn 可能与之冲突
  if (n.echEnabled || n.echConfigList || n.echQueryName) return [];
  if (["ws", "httpupgrade"].includes(n.network)) return ["http/1.1"];
  if (n.network === "grpc") return ["h2"];
  return parseAlpn(n.alpn);
}
function parseEch(value) {
  if (!value) return null;
  let text = String(value).trim();
  if (text.length > 16384) throw new Error("ECH 配置过长");
  // Legacy share URLs often leave '+' unescaped; URLSearchParams decodes it as a space.
  // Neither DNS expressions nor Base64 ECHConfigList contain literal spaces.
  if (!text.startsWith('-----BEGIN ')) text = text.replace(/ /g, '+');
  const query = text.match(/^(?:([a-zA-Z0-9.-]+)\+)?((?:https|udp|h2c):\/\/\S+)$/);
  if (query) {
    const u = new URL(query[2]);
    if (u.username || u.password) throw new Error("ECH 查询地址无效");
    return { value: text, resolver: query[2], queryName: query[1] || "" };
  }
  text = text.replace(/^-----BEGIN (?:ECH CONFIGS|ECHCONFIG)-----\s*/, "").replace(/\s*-----END (?:ECH CONFIGS|ECHCONFIG)-----$/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error("ECH 需要 Base64 ECHConfigList 或 DNS 查询地址");
  const bytes = Buffer.from(text, "base64");
  if (bytes.length < 7 || bytes.readUInt16BE(0) !== bytes.length - 2) throw new Error("ECHConfigList 长度无效");
  let pos = 2;
  while (pos < bytes.length) {
    if (pos + 4 > bytes.length) throw new Error("ECHConfigList 截断");
    pos += 4 + bytes.readUInt16BE(pos + 2);
  }
  if (pos !== bytes.length) throw new Error("ECHConfigList 截断");
  return { value: bytes.toString("base64"), config: bytes.toString("base64") };
}
function normalize(n) {
  n.server = hostname(n.server); n.port = Number(n.port);
  if (!n.server || /[\s\x00-\x1f,=/#?]/.test(n.server) || !Number.isInteger(n.port) || n.port < 1 || n.port > 65535) throw new Error("节点地址无效");
  if (!["vless", "vmess", "trojan", "ss", "hysteria2"].includes(n.type)) throw new Error("暂不支持的协议");
  if (["vless", "vmess"].includes(n.type) && !n.uuid) throw new Error("缺少 UUID");
  if (["trojan", "ss", "hysteria2"].includes(n.type) && !n.password) throw new Error("缺少密码");
  n.name = String(n.name || `${n.server}:${n.port}`).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  n.network = ({ raw: "tcp", websocket: "ws", h2: "http" })[n.network] || n.network || "tcp";
  n.alpn = parseAlpn(n.alpn);
  if (n.sni && !/^[a-zA-Z0-9._:[\]-]{1,253}$/.test(n.sni)) throw new Error("SNI 格式无效");
  const ech = parseEch(n.echConfigList);
  if ((ech || n.echEnabled) && (!n.tls || n.reality)) throw new Error("ECH 需要 TLS，不能与 Reality 叠加");
  if (ech) { n.echConfigList = ech.value; n.echEnabled = true; }
  n.shortId = n.shortId === undefined || n.shortId === null ? "" : String(n.shortId);
  if (n.reality && (!/^[A-Za-z0-9_-]{43}$/.test(n.publicKey || "") || !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(n.shortId))) throw new Error("Reality 参数无效");
  return n;
}
function parseNode(link) {
  if (typeof link !== "string" || link.length > 32768) return null;
  link = link.trim();
  try {
    if (link.startsWith("vmess://")) {
      const v = JSON.parse(decode(link.slice(8)));
      return normalize({ type: "vmess", name: v.ps, server: v.add, port: v.port, uuid: v.id, alterId: Number(v.aid || 0), cipher: v.scy || "auto", network: v.net, tls: ["tls", "1", true].includes(v.tls), sni: v.sni || "", host: v.host || "", path: v.path || "", fingerprint: v.fp || "", alpn: v.alpn, insecure: [true,1,'1','true'].includes(v.insecure || v.allowInsecure), echConfigList: v.ech || v.echConfigList, raw: link });
    }
    if (link.startsWith("ss://")) {
      const [main, fragment = ""] = link.slice(5).split("#");
      const expanded = main.includes("@") ? main : decode(main);
      const at = expanded.lastIndexOf("@");
      if (at < 0) return null;
      const credentials = expanded.slice(0, at);
      const text = credentials.includes(":") ? decodeURIComponent(credentials) : decode(credentials);
      const colon = text.indexOf(":");
      if (colon < 1) return null;
      const u = new URL("ss://" + expanded.slice(at + 1));
      return normalize({ type: "ss", name: decodeURIComponent(fragment), server: u.hostname, port: u.port, cipher: text.slice(0, colon), password: text.slice(colon + 1), plugin: u.searchParams.get("plugin") || "", raw: link });
    }
    const u = new URL(link), p = u.searchParams;
    const type = u.protocol === "hy2:" ? "hysteria2" : u.protocol.slice(0, -1);
    return normalize({ type, name: decodeURIComponent(u.hash.slice(1)), server: u.hostname, port: u.port || 443,
      uuid: decodeURIComponent(u.username), password: decodeURIComponent(u.username + (u.password ? ":" + u.password : "")),
      tls: type !== "vless" || ["tls", "reality"].includes(p.get("security")), reality: p.get("security") === "reality",
      network: p.get("type") || "tcp", flow: p.get("flow") || "", sni: p.get("sni") || p.get("peer") || p.get('servername') || "", udp: p.get('udp') !== '0' && p.get('udp') !== 'false', encryption: p.get('encryption') || 'none',
      host: p.get("host") || "", path: p.get("path") || "", serviceName: p.get("serviceName") || "", mode: p.get("mode") || "",
      fingerprint: p.get("fp") || "", publicKey: p.get("pbk") || "", shortId: p.get("sid") || "", alpn: p.get("alpn"),
      echConfigList: p.get("ech") || p.get("echConfigList") || p.get("ech_config_list"),
      insecure: ["1", "true"].includes(p.get("allowInsecure") || p.get("insecure")),
      pin: p.get("pcs") || p.get('pinSHA256') || "", ports: p.get('mport') || p.get('ports') || '', obfs: p.get("obfs"), obfsPassword: p.get("obfs-password"), upMbps: p.has('upmbps') ? Number(p.get('upmbps')) : undefined, downMbps: p.has('downmbps') ? Number(p.get('downmbps')) : undefined, raw: link });
  } catch { return null; }
}
function nodeToUri(node) {
  const n = normalize({ ...node });
  if (n.type === "vmess") {
    let v = {};
    if (n.raw?.startsWith("vmess://")) { try { v = JSON.parse(decode(n.raw.slice(8))); } catch {} }
    Object.assign(v, { v: "2", ps: n.name, add: n.server, port: String(n.port), id: n.uuid, aid: n.alterId || 0, scy: n.cipher || "auto", net: n.network, tls: n.tls ? "tls" : "", sni: n.sni || "", host: n.host || "", path: n.path || "", alpn: getAlpn(n).join(","), fp: n.fingerprint || "" });
    if (n.echConfigList) v.echConfigList = n.echConfigList;
    return "vmess://" + encode(JSON.stringify(v));
  }
  if (n.type === "ss") {
    if (n.raw) return n.raw.split('#')[0] + '#' + encodeURIComponent(n.name);
    return `ss://${Buffer.from(`${n.cipher}:${n.password}`).toString("base64url")}@${address(n)}${n.plugin ? "?plugin=" + encodeURIComponent(n.plugin) : ""}#${encodeURIComponent(n.name)}`;
  }
  let p = new URLSearchParams();
  if (n.raw) { try { p = new URL(n.raw).searchParams; } catch {} }
  const fields = { type: n.network, security: n.reality ? "reality" : n.tls ? "tls" : "none", sni: n.sni, host: n.host, path: n.path, flow: n.flow, fp: n.fingerprint, pbk: n.publicKey, sid: n.shortId, serviceName: n.serviceName, mode: n.mode, ech: n.echConfigList, alpn: getAlpn(n).join(","), pcs: n.pin, obfs: n.obfs, "obfs-password": n.obfsPassword };
  if (n.insecure) fields.allowInsecure = "1";
  for (const [key, value] of Object.entries(fields)) if (value) p.set(key, value);
  // 清除从原始 URI 继承的非标准字段：分享链接标准用 ech，不使用 echConfigList
  p.delete("echConfigList");
  return `${n.type}://${encodeURIComponent(n.type === "vless" ? n.uuid : n.password)}@${address(n)}?${p}#${encodeURIComponent(n.name)}`;
}
function parseClashYamlProxies(text) {
  const doc = YAML.parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("YAML 格式无效");
  // Numeric-looking short IDs and passwords are strings in proxy schemas.
  YAML.visit(doc, { Pair(_key, pair) {
    if (["short-id", "password", "uuid", "public-key"].includes(pair.key?.value) && YAML.isScalar(pair.value) && typeof pair.value.value === "number") pair.value.value = pair.value.source;
  } });
  const data = doc.toJS({ maxAliasCount: 30 });
  if (!Array.isArray(data?.proxies)) return [];
  if (data.proxies.length > MAX_NODES) throw new Error('节点数量超过 2000 限制');
  return data.proxies.flatMap(p => {
    try {
      const t = p[`${p.network}-opts`] || {}, e = p["ech-opts"];
      const n = normalize({ type: p.type, name: p.name, server: p.server, port: p.port, uuid: p.uuid, password: p.password, cipher: p.cipher,
        alterId: p.alterId, network: t["v2ray-http-upgrade"] ? "httpupgrade" : p.network || "tcp", tls: p.tls === true || ["trojan", "hysteria2"].includes(p.type),
        sni: p.servername || p.sni || "", host: t.headers?.Host || t.host || "", path: Array.isArray(t.path) ? t.path[0] : t.path || "", serviceName: t["grpc-service-name"] || "", mode: t.mode,
        flow: p.flow, fingerprint: p["client-fingerprint"], pin: p.fingerprint, alpn: p.alpn, insecure: p["skip-cert-verify"] === true,
        reality: Boolean(p["reality-opts"]), publicKey: p["reality-opts"]?.["public-key"], shortId: p["reality-opts"]?.["short-id"],
        echEnabled: e?.enable === true, echConfigList: e?.enable ? e.config || "" : "", echQueryName: e?.["query-server-name"] || "",
        obfs: p.obfs, obfsPassword: p["obfs-password"], plugin: p.plugin, clashOriginal: p });
      if (Array.isArray(n.host)) n.host = n.host[0] || "";
      return [n];
    } catch { return []; }
  });
}
function uniqueNodes(nodes, prefix = "") {
  if (nodes.length > MAX_NODES) throw new Error('节点数量超过 2000 限制');
  const used = new Set(["direct", "block", "DIRECT", "🚀 节点选择", "♻️ 自动选择"]);
  return nodes.map(n => {
    const base = (prefix + n.name).slice(0, 200); let name = base, i = 2;
    while (used.has(name)) name = `${base} (${i++})`;
    used.add(name); return { ...n, name };
  });
}
function parseNodesFromContent(content, prefix = "") {
  if (typeof content !== "string" || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("订阅内容超过限制");
  let text = content.trim();
  if (!text) return [];
  if (!/^\s*proxies\s*:/m.test(text) && !text.includes("://") && !text.startsWith("{")) text = decode(text);
  const yaml = /^\s*proxies\s*:/m.test(text) || /^\s*\{\s*"proxies"/.test(text);
  return uniqueNodes(yaml ? parseClashYamlProxies(text) : text.split(/\r?\n/).map(parseNode).filter(Boolean), String(prefix).slice(0, 100));
}
function compatibility(n, target) {
  const ech = parseEch(n.echConfigList);
  // Surge / Quantumult X / Loon 为"尽力而为"格式：绝大多数节点都能输出（无法表达的高级 TLS 字段被忽略即可）。
  // 采用快速放行，只拦截真正无法构造一行配置的情况，避免大量节点被过滤触发订阅整体 422。
  if (["surge", "quantumultx", "loon"].includes(target)) {
    if (!n.server || !n.port) return "节点缺少地址或端口";
    // 所有协议尽量放行（hysteria2 等小众协议即使降级输出也比整份订阅 422 强）
    return null;
  }
  if (n.clashOriginal && target === "clash") return null;
  if (n.clashOriginal) {
    const known = new Set(['name','type','server','port','uuid','password','cipher','alterId','network','tls','servername','sni','flow','client-fingerprint','fingerprint','alpn','skip-cert-verify','reality-opts','ech-opts','obfs','obfs-password','udp','ws-opts','grpc-opts','http-opts','h2-opts']);
    if (Object.keys(n.clashOriginal).some(k => !known.has(k))) return "节点包含目标未实现的 Clash 专用选项";
    const opts = n.clashOriginal[`${n.clashOriginal.network}-opts`] || {};
    const keys = n.network === 'ws' ? ['path','headers'] : n.network === 'grpc' ? ['grpc-service-name'] : [];
    if (Object.keys(opts).some(k => !keys.includes(k)) || Object.keys(opts.headers || {}).some(k => k !== 'Host')) return "传输专用选项无法完整转换";
    for (const [field, allowed] of [['reality-opts', ['public-key', 'short-id']], ['ech-opts', ['enable', 'config', 'query-server-name']]]) {
      if (Object.keys(n.clashOriginal[field] || {}).some(k => !allowed.includes(k))) return "TLS 专用选项无法完整转换";
    }
    if (target === 'base64' && (n.pin || n.echQueryName || (n.alterId && n.type !== 'vmess'))) return "TLS 专用选项没有通用 URI 表达";
    if (target === 'base64' && n.type === 'vmess' && n.network === 'grpc') return "VMess gRPC 分享格式不统一";
  }
  if (target === "base64") return n.echEnabled && !ech ? "DNS 自动 ECH 没有通用分享 URI 表达" : null;
  if (ech?.resolver) return n.echResolutionFailed ? "ECH DNS 查询失败，暂时无法转换；通用 URI 仍保留原配置" : "ECH DNS 配置将在生成订阅时自动查询并转换";
  if (n.raw?.startsWith('vmess://')) {
    const original = JSON.parse(decode(n.raw.slice(8)));
    const known = new Set(['v','ps','add','port','id','aid','scy','net','tls','sni','host','path','fp','alpn','ech','echConfigList','type','insecure','allowInsecure']);
    if (Object.keys(original).some(k => !known.has(k)) || (original.type && !['none','auto',n.network].includes(original.type))) return "VMess 专用选项无法完整转换";
  }
  if (n.raw?.startsWith('ss://') && n.raw.split('#')[0].includes('?') && [...new URL('ss://'+n.raw.slice(5).split('@').pop()).searchParams].some(([k,v]) => v && k !== 'plugin')) return "SS URI 扩展选项仅原样保留";
  if (n.raw && !n.raw.startsWith('vmess://') && !n.raw.startsWith('ss://')) {
    const known = new Set(['type','security','sni','peer','servername','host','path','flow','fp','pbk','sid','serviceName','mode','ech','echConfigList','ech_config_list','alpn','allowInsecure','insecure','pcs','obfs','obfs-password','encryption','headerType','udp']);
    const params = new URL(n.raw).searchParams;
    if (n.type === 'hysteria2') { for (const key of ['upmbps','downmbps','mport','ports','pinSHA256']) known.add(key); }
    if (params.get('quicSecurity') === 'none' && n.network !== 'quic') known.add('quicSecurity');
    if (params.get('headerType') && params.get('headerType') !== 'none') return 'TCP 伪装头暂不支持跨格式转换';
    if ([n.upMbps, n.downMbps].some(v => v !== undefined && (!Number.isFinite(v) || v <= 0 || v > 1000000))) return 'Hysteria2 带宽参数无效';
    if ([...params.keys()].some(k => !known.has(k) && params.get(k))) return "URI 包含目标未实现的专用选项";
    if (n.encryption !== 'none' && n.encryption && (target !== 'clash' || n.type !== 'vless')) return '该目标暂不支持 VLESS encryption，请使用 Mihomo 或通用 URI';
  }
  if (n.plugin) return "该目标暂不转换插件节点";
  if (n.network === 'grpc' && n.mode && n.mode !== 'gun') return "gRPC 模式无法完整转换";
  if (n.flow && n.type !== 'vless') return "flow 仅适用于 VLESS";
  if (['ss','hysteria2'].includes(n.type) && n.network !== 'tcp') return "该协议不支持此传输组合";
  if (n.type === 'hysteria2' && n.fingerprint && target === 'singbox') return "QUIC 不支持 uTLS 指纹";
  if (["singbox", "clash"].includes(target)) {
    if (!["tcp", "ws", "grpc", "http", "httpupgrade", ...(target==='clash'&&n.type==='vless'?['xhttp']:[])].includes(n.network)) return "该传输暂不支持跨格式转换";
    if (n.pin && (target !== 'clash' || !/^(?:[a-fA-F0-9]{2}:?){32}$/.test(n.pin))) return "证书固定需要支持完整证书 SHA256 的内核版本；请使用 Mihomo 或通用 URI";
    if (n.ports && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(n.ports)) return '端口跳跃范围无效';
    if (n.type === "vmess" && n.network === "grpc" && !n.serviceName) return "VMess gRPC 分享格式缺少 serviceName";
    return null;
  }
  // Surge / Quantumult X 对 ECH/alpn/fingerprint 无法完整表达，但应尽量保留节点：
  // 这些扩展在目标格式里忽略即可，不应因此丢弃节点。reality/pin 仍属无法安全降级，保留过滤。
  if (n.reality || n.pin) return "该目标无法可靠保留节点 TLS 扩展";
  if (["surge", "quantumultx"].includes(target)) {
    if (n.echEnabled || n.alpn?.length || n.fingerprint) {
      // 允许输出，扩展字段在生成时被忽略（Surge/QX 不支持这些 TLS 扩展）
    }
  } else if (n.echEnabled || n.alpn?.length || n.fingerprint) {
    return "该目标无法可靠保留节点 TLS 扩展";
  }
  if (n.type === 'vmess' && (n.alterId || (n.cipher && !['auto','aes-128-gcm'].includes(n.cipher)))) return "VMess 加密选项无法完整转换";
  // Surge / Quantumult X 也支持 VLESS（Surge 用 vless + username=uuid；QX 用 vless），放宽协议白名单
  const allowedTypes = ["ss", "vmess", "trojan", ...(["surge", "quantumultx"].includes(target) ? ["vless"] : [])];
  if (!allowedTypes.includes(n.type) || !["tcp", "ws"].includes(n.network) || (n.type === "trojan" && n.network !== "tcp")) return "该目标不支持此协议或传输";
  if (/[\x00-\x1f\x7f,=;#]/.test([n.name, n.password, n.host, n.path, n.sni, n.uuid, n.cipher].join(""))) return "配置字段含目标格式分隔符";
  return null;
}
function selectNodes(nodes, target) { return uniqueNodes(nodes).filter(n => !compatibility(n, target)); }
function echFor(n, target) {
  const e = parseEch(n.echConfigList);
  if (target === "clash") return { enable: true, ...(e?.config ? { config: e.config } : n.echQueryName ? { "query-server-name": n.echQueryName } : {}) };
  // sing-box 1.13+ 的 tls.ech 只有 config / query_server_name / config_path，没有 enabled 字段。
  // config 为 PEM 行数组；DNS 查询表达式用 query_server_name 指定查询域名（sing-box 用系统 DNS 查 HTTPS 记录）。
  return { ...(e?.config ? { config: ["-----BEGIN ECH CONFIGS-----", ...e.config.match(/.{1,64}/g), "-----END ECH CONFIGS-----"] } : (n.echQueryName || e?.queryName) ? { query_server_name: n.echQueryName || e.queryName } : {}) };
}
function generateClashYaml(nodes) {
  const proxies = selectNodes(nodes, "clash").map(n => {
    const p = n.clashOriginal ? structuredClone(n.clashOriginal) : { type: n.type, server: n.server, port: n.port, udp: n.udp !== false };
    p.name = n.name;
    if (["vless", "vmess"].includes(n.type)) p.uuid = n.uuid; else p.password = n.password;
    if (n.type === "ss") p.cipher = n.cipher;
    if (n.type === "vmess") { p.alterId = n.alterId || 0; p.cipher = n.cipher || "auto"; }
    if (n.flow) p.flow = n.flow;
    if (n.type === 'vless' && n.encryption && n.encryption !== 'none') p.encryption = n.encryption;
    if (n.tls) {
      p.tls = true; p[["trojan", "hysteria2"].includes(n.type) ? "sni" : "servername"] = n.sni || n.server;
      if (getAlpn(n).length) p.alpn = getAlpn(n);
      p["skip-cert-verify"] = Boolean(n.insecure);
      if (n.fingerprint) p["client-fingerprint"] = n.fingerprint;
      if (n.pin) p.fingerprint = n.pin;
      if (n.reality) p["reality-opts"] = { ...p["reality-opts"], "public-key": n.publicKey, "short-id": n.shortId || "" };
      if (n.echEnabled) p["ech-opts"] = { ...p['ech-opts'], ...echFor(n, "clash") };
    }
    if (n.network !== "tcp" && !n.clashOriginal) {
      p.network = n.network;
      if (["ws", "httpupgrade"].includes(n.network)) { p.network = "ws"; p["ws-opts"] = { path: n.path || "/", headers: n.host ? { Host: n.host } : {}, ...(n.network === "httpupgrade" ? { "v2ray-http-upgrade": true } : {}) }; }
      if (n.network === "grpc") p["grpc-opts"] = { "grpc-service-name": n.serviceName || "" };
      if (n.network === "http") { p.network='h2'; p['h2-opts'] = { path: n.path || '/', ...(n.host?{host:[n.host]}:{}) }; }
      if (n.network === 'xhttp') p['xhttp-opts'] = { path:n.path||'/', host:n.host||'', mode:n.mode||'auto' };
    }
    if (n.obfs) { p.obfs = n.obfs; p["obfs-password"] = n.obfsPassword; }
    if (n.type === 'hysteria2') { if (n.upMbps) p.up = n.upMbps; if (n.downMbps) p.down = n.downMbps; if (n.ports) p.ports = n.ports; }
    return p;
  });
  const names = proxies.map(p => p.name);
  return YAML.stringify({ "mixed-port": 7890, "allow-lan": false, mode: "rule", "log-level": "info", proxies,
    "proxy-groups": [{ name: "🚀 节点选择", type: "select", proxies: names.length ? ["♻️ 自动选择", ...names, "DIRECT"] : ["DIRECT"] }, ...(names.length ? [{ name: "♻️ 自动选择", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300 }] : [])], rules: ["GEOIP,LAN,DIRECT,no-resolve", "GEOIP,CN,DIRECT", "MATCH,🚀 节点选择"] });
}
function generateSingboxJson(nodes) {
  const outbounds = selectNodes(nodes, "singbox").map(n => {
    const o = { type: n.type === "ss" ? "shadowsocks" : n.type, tag: n.name, server: n.server, server_port: n.port };
    if (["vless", "vmess"].includes(n.type)) o.uuid = n.uuid; else o.password = n.password;
    if (n.type === "ss") o.method = n.cipher;
    if (n.type === "vmess") { o.security = n.cipher || "auto"; o.alter_id = n.alterId || 0; }
    if (n.flow) o.flow = n.flow;
    if (n.udp === false) o.network = 'tcp';
    if (n.tls) {
      o.tls = { enabled: true, server_name: n.sni || n.server, insecure: Boolean(n.insecure) };
      if (getAlpn(n).length) o.tls.alpn = getAlpn(n);
      if (n.fingerprint) o.tls.utls = { enabled: true, fingerprint: n.fingerprint };
      if (n.reality) { o.tls.utls ||= { enabled: true, fingerprint: "chrome" }; o.tls.reality = { enabled: true, public_key: n.publicKey, short_id: n.shortId || "" }; }
      if (n.echEnabled) o.tls.ech = echFor(n, "singbox");
    }
    if (n.network !== "tcp") {
      o.transport = { type: n.network };
      if (n.network === "grpc") o.transport.service_name = n.serviceName || "";
      else { o.transport.path = n.path || "/"; if (n.host) { if (["http", "httpupgrade"].includes(n.network)) o.transport.host = n.network === "http" ? [n.host] : n.host; else o.transport.headers = { Host: n.host }; } }
    }
    if (n.obfs) o.obfs = { type: n.obfs, password: n.obfsPassword };
    if (n.type === 'hysteria2') { if (n.upMbps) o.up_mbps = n.upMbps; if (n.downMbps) o.down_mbps = n.downMbps; if (n.ports) { delete o.server_port; o.server_ports=n.ports.split(',').map(p=>p.replace('-',':')); } }
    return o;
  });
  const tags = outbounds.map(o => o.tag);
  return JSON.stringify({ log: { level: "info" }, inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 2080 }],
    outbounds: [{ type: "selector", tag: "🚀 节点选择", outbounds: [...(tags.length ? ["♻️ 自动选择"] : []), ...tags, "direct"] }, ...(tags.length ? [{ type: "urltest", tag: "♻️ 自动选择", outbounds: tags, url: "https://www.gstatic.com/generate_204", interval: "3m" }] : []), ...outbounds, { type: "direct", tag: "direct" }],
    route: { rules: [{ ip_is_private: true, outbound: "direct" }], final: "🚀 节点选择", auto_detect_interface: true } }, null, 2);
}
function generateSurgeConf(nodes) {
  const selected = selectNodes(nodes, "surge");
  const lines = selected.map(n => {
    let line = `${n.name} = ${n.type}, ${n.server}, ${n.port}`;
    if (n.type === "ss") line += `, encrypt-method=${n.cipher}, password=${n.password}`;
    else if (n.type === "trojan") line += `, password=${n.password}, sni=${n.sni || n.server}, skip-cert-verify=${Boolean(n.insecure)}`;
    else { const id = n.uuid || n.password || ""; line += `, username=${id}, tls=${Boolean(n.tls)}, ws=${n.network === "ws"}`; if (n.tls) line += `, sni=${n.sni || n.server}, skip-cert-verify=${Boolean(n.insecure)}`; if (n.network === "ws") line += `, ws-path=${n.path || "/"}${n.host ? ", ws-headers=Host:" + n.host : ""}`; }
    return line;
  });
  return `[General]\nloglevel = notify\n\n[Proxy]\n${lines.join("\n")}\n\n[Proxy Group]\n节点选择 = select, ${[...selected.map(n => n.name), "DIRECT"].join(", ")}\n\n[Rule]\nGEOIP,CN,DIRECT\nFINAL,节点选择\n`;
}
function generateQuantumultXConfig(nodes) {
  const selected = selectNodes(nodes, "quantumultx");
  const lines = selected.map(n => {
    // QX 的 vmess/vless 均把 uuid 放在 password 字段
    const qxPassword = (n.type === "vmess" || n.type === "vless") ? (n.uuid || "") : (n.password || "");
    let line = `${n.type === "ss" ? "shadowsocks" : n.type}=${address(n)}, password=${qxPassword}`;
    // QX 官方格式：vless 的 method 必须为 none；vmess 用 none（或协商）；ss 用 cipher；trojan 不需要 method
    if (n.type === "ss") line += `, method=${n.cipher}`;
    else if (n.type === "vless") line += `, method=none`;
    else if (n.type === "vmess") line += `, method=none`;
    if (n.network === "ws") line += `, obfs=${n.tls ? "wss" : "ws"}, obfs-host=${n.host || n.sni || n.server}, obfs-uri=${n.path || "/"}`;
    else if (n.tls) line += n.type === "trojan" ? ", over-tls=true" : ", obfs=over-tls";
    if (n.tls) line += `, tls-host=${n.sni || n.server}, tls-verification=${!n.insecure}`;
    return line + `, tag=${n.name}`;
  });
  return `[general]\nserver_check_url=https://www.gstatic.com/generate_204\n\n[policy]\nstatic=节点选择, ${[...selected.map(n => n.name), "direct"].join(", ")}\n\n[server_local]\n${lines.join("\n")}\n\n[filter_local]\ngeoip, cn, direct\nfinal, 节点选择\n`;
}
// Loon 节点格式（依据 Loon 官方文档 nsloon.app/docs/Node）：
// 节点名 = 协议,服务器,端口,必填参数,可选参数  —— 参数值含逗号时用双引号包裹
function generateLoonConfig(nodes) {
  const selected = selectNodes(nodes, "loon");
  const q = s => `"${String(s ?? "").replace(/"/g, '\\"')}"`; // Loon 双引号转义
  const lines = selected.map(n => {
    const name = /[,\n"]/.test(n.name) ? q(n.name) : n.name;
    let line;
    if (n.type === "ss") {
      line = `${name} = Shadowsocks,${n.server},${n.port},${n.cipher || "aes-128-gcm"},${q(n.password)}`;
    } else if (n.type === "vmess") {
      line = `${name} = VMess,${n.server},${n.port},${n.cipher && n.cipher !== "auto" ? n.cipher : "auto"},${q(n.uuid)}`;
      line += `,transport=${["ws", "http"].includes(n.network) ? n.network : "tcp"},alterId=${n.alterId || 0}`;
      if (n.network === "ws" || n.network === "http") line += `,path=${n.path || "/"},host=${n.host || n.sni || n.server}`;
    } else if (n.type === "trojan") {
      line = `${name} = Trojan,${n.server},${n.port},${q(n.password)}`;
    } else if (n.type === "hysteria2") {
      line = `${name} = Hysteria2,${n.server},${n.port},${q(n.password)}`;
      if (n.sni) line += `,sni=${n.sni}`;
      if (n.obfs) line += `,salamander-password=${q(n.obfsPassword || "")}`;
    } else {
      // VLESS 及其它按 VLESS 处理
      line = `${name} = VLESS,${n.server},${n.port},${q(n.uuid)}`;
      line += `,transport=${["ws", "http"].includes(n.network) ? n.network : "tcp"}`;
      if (n.flow) line += `,flow=${n.flow}`;
      if (n.network === "ws" || n.network === "http") line += `,path=${n.path || "/"},host=${n.host || n.sni || n.server}`;
    }
    if (n.tls) {
      line += `,over-tls=true`;
      if (n.sni) line += `,sni=${n.sni}`;
      if (n.insecure) line += `,skip-cert-verify=true`;
    }
    line += `,udp=true`;
    return line;
  });
  return `[Proxy]\n${lines.join("\n")}\n`;
}
function generateBase64(nodes) { return encode(selectNodes(nodes, "base64").map(nodeToUri).join("\n")); }
function diagnostics(nodes) {
  return Object.fromEntries(["base64", "clash", "singbox", "surge", "quantumultx", "loon"].map(target => {
    const reasons = nodes.map(n => compatibility(n, target)).filter(Boolean);
    return [target, { supported: nodes.length - reasons.length, skipped: reasons.length, reasons: [...new Set(reasons)] }];
  }));
}
module.exports = { fetchSubscription, parseNode, nodeToUri, parseNodesFromContent, parseClashYamlProxies, uniqueNodes, parseAlpn, getAlpn, parseEch, compatibility, selectNodes, diagnostics, generateClashYaml, generateSingboxJson, generateSurgeConf, generateQuantumultXConfig, generateLoonConfig, generateBase64 };
