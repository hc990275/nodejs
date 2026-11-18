'use strict';
// 轻量 YAML 序列化器（零依赖）：仅实现 Clash 配置生成所需的 stringify。
// 输入侧（parseDocument/visit/isScalar）在本项目用不到——订阅输入是 VLESS URI，不是 Clash YAML，
// 因此提供空壳实现以保持 sub_converter.js 逻辑原样可用。

function quote(v) {
  const s = String(v ?? '');
  // 与 yaml 库对齐：只在必要时加引号。
  // - 空串 / 首尾空白
  // - 看起来像数字/bool/null（会被 YAML 当成非字符串）
  // - 含 ": "（冒号+空格）或 " #"（空格+井号）—— 会被当成分隔符
  // - 含换行/制表符、或以 YAML 指示符开头（- ? : , [ ] { } # & * ! | > ' " % @ `）
  // 注意：URL 里的 "://"（冒号后跟斜杠）、普通逗号（如 GEOIP,CN,DIRECT）都不需要引号。
  const indicatorStart = /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s);
  const need = s === '' || /^[\s]|[\s]$/.test(s) ||
    /^[-+]?\d+(\.\d+)?$/.test(s) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(s) ||
    /[:]\s|\s[#]/.test(s) ||
    /[\n\r\t]/.test(s) ||
    indicatorStart;
  return need ? JSON.stringify(s) : s;
}

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return quote(v);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// 把对象/数组序列化为 YAML 行数组
function dumpValue(val, indent) {
  const pad = ' '.repeat(indent);
  const out = [];
  if (Array.isArray(val)) {
    if (val.length === 0) { out.push(pad + '[]'); return out; }
    for (const item of val) {
      if (isPlainObject(item)) {
        const keys = Object.keys(item);
        if (keys.length === 0) { out.push(pad + '- {}'); continue; }
        keys.forEach((k, idx) => {
          const v = item[k];
          const lead = idx === 0 ? pad + '- ' : pad + '  ';
          if (isPlainObject(v) || Array.isArray(v)) {
            out.push(lead + quote(k) + ':');
            out.push(...dumpValue(v, indent + (idx === 0 ? 4 : 4)));
          } else {
            out.push(lead + quote(k) + ': ' + scalar(v));
          }
        });
      } else if (Array.isArray(item)) {
        out.push(pad + '-');
        out.push(...dumpValue(item, indent + 2));
      } else {
        out.push(pad + '- ' + scalar(item));
      }
    }
    return out;
  }
  if (isPlainObject(val)) {
    const keys = Object.keys(val);
    if (keys.length === 0) { out.push(pad + '{}'); return out; }
    for (const k of keys) {
      const v = val[k];
      if (isPlainObject(v) || Array.isArray(v)) {
        out.push(pad + quote(k) + ':');
        out.push(...dumpValue(v, indent + 2));
      } else {
        out.push(pad + quote(k) + ': ' + scalar(v));
      }
    }
    return out;
  }
  out.push(pad + scalar(val));
  return out;
}

function stringify(obj) {
  return dumpValue(obj, 0).join('\n') + '\n';
}

// 以下为空壳：本项目的订阅输入是 VLESS URI 文本，不会走 Clash YAML 解析分支。
// 保留函数签名仅为兼容 sub_converter.js 中 parseClashYamlProxies 的引用（不会被调用）。
function parseDocument() {
  return { errors: [], toJS: () => ({}), };
}
function visit() {}
function isScalar() { return false; }

module.exports = { stringify, parseDocument, visit, isScalar };
