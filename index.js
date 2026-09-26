const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Kata-Node & Lunes Host 统一自动部署脚本 (v4.1.0)
 * 采用全新的 hc990275 统一命名规范，不再区分平台前缀。
 * 强制执行 Scheme A (面板直连拉起流)，确保全自动零配置。
 */

// Pterodactyl 环境变量探测 (用于捕捉分配端口)
let PORT = process.env.SERVER_PORT || process.env.PORT || 8080;
if (PORT === '-1') PORT = 8080;

console.log(`\n=== [hc990275-Node] 启动 Sing-Box 统一自动部署模式 ===`);
console.log(`[工作侦听端口] ${PORT}`);

// 统一节点名称
const TUIC_NAME = "hc990275-TUIC";
const REALITY_NAME = "hc990275-vless";

const bashScript = `#!/bin/bash
set -e

export PORT="${PORT}"
export TUIC_PORT="\${PORT}"
export REALITY_PORT="\${PORT}"

# ================== 基础配置 ==================
TUIC_NAME="${TUIC_NAME}"
REALITY_NAME="${REALITY_NAME}"
export FILE_PATH="\${PWD}/.node_cache"
mkdir -p "\${FILE_PATH}"
cd "\${FILE_PATH}"

# ================== UUID 生成 ==================
UUID_FILE="uuid.txt"
if [ -f "\$UUID_FILE" ]; then
    UUID=\$(cat "\$UUID_FILE")
else
    UUID=\$(cat /proc/sys/kernel/random/uuid 2>/dev/null || node -e "console.log(require('crypto').randomUUID())")
    echo "\$UUID" > "\$UUID_FILE"
    chmod 600 "\$UUID_FILE" 2>/dev/null || true
fi
echo "🔹 [UUID] \$UUID"

# ================== 下载核心 ==================
ARCH=\$(uname -m)
case "\$ARCH" in
    arm*|aarch64) URL="https://arm64.ssss.nyc.mn/sb" ;;
    amd64*|x86_64) URL="https://amd64.ssss.nyc.mn/sb" ;;
    s390x) URL="https://s390x.ssss.nyc.mn/sb" ;;
    *) echo "❌ 架构不支持 \$ARCH"; exit 1 ;;
esac

SB="sb"
if [ ! -f "\$SB" ]; then
    echo "⬇️ 正在拉取 Sing-box 核心..."
    if command -v curl >/dev/null; then 
        curl -L -sS -o "\$SB" "\$URL"
    else 
        wget -q -O "\$SB" "\$URL"
    fi
    chmod +x "\$SB" 2>/dev/null || true
fi

# ================== 密钥 & 证书 ==================
KEY="key.txt"
[ ! -f "\$KEY" ] && ./"\$SB" generate reality-keypair > "\$KEY"
PRIVATE_KEY=\$(grep "PrivateKey:" "\$KEY" | awk '{print \$2}')
PUBLIC_KEY=\$(grep "PublicKey:" "\$KEY" | awk '{print \$2}')

if ! command -v openssl >/dev/null; then
  cat > "private.key" << 'KEYEOF'
-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIM4792SEtPqIt1ywqTd/0bYidBqpYV/+siNnfBYsdUYsAoGCCqGSM49
AwEHoUQDQgAE1kHafPj07rJG+HboH2ekAI4r+e6TL38GWASAnngZreoQDF16ARa
/TsyLyFoPkhTxSbehH/OBEjHtSZGaDhMqQ==
-----END EC PRIVATE KEY-----
KEYEOF
  cat > "cert.pem" << 'CERTEOF'
-----BEGIN CERTIFICATE-----
MIIBejCCASGgAwIBAgIUFWeQL3556PNJLp/veCFxGNj9crkwCgYIKoZIzj0EAwIw
EzERMA8GA1UEAwwIYmluZy5jb20wHhcNMjUwMTAxMDEwMTAwWhcNMzUwMTAxMDEw
MTAwWjATMREwDwYDVQQDDAhiaW5nLmNvbTBNBgqgGzM9AgEGCCqGSM49AwEHA0IA
BNZB2nz49O6yRvh26B9npACOK/nuky9/BlgEgDZ54Ga3qEAxdeWv07Mi8h
d5IR8Um3oR/zQRIx7UmRmg4TKmjUzBRMB0GA1UdDgQWBQTV1cFID7UISE7PLTBR
BfGbgrkMNzAfBgNVHSMEGDAWgBTV1cFID7UISE7PLTBRBfGbgrkMNzAPBgNVHRMB
Af8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIARDAJvg0vd/ytrQVvEcSm6XTlB+
eQ6OFb9LbLYL9Zi+AiffoMbi4y/0YUQlTtz7as9S8/lciBF5VCUoVIKS+vX2g==
-----END CERTIFICATE-----
CERTEOF
else
  openssl ecparam -genkey -name prime256v1 -out "private.key" 2>/dev/null || true
  openssl req -new -x509 -days 3650 -key "private.key" -out "cert.pem" -subj "/CN=bing.com" 2>/dev/null || true
fi

# ================== 生成 Config ==================
cat > "config.json" << CONF
{
    "log": { "disabled": false, "level": "error" },
    "inbounds": [
        {
            "type": "tuic", "listen": "0.0.0.0", "listen_port": \${TUIC_PORT},
            "users": [{ "uuid": "\${UUID}", "password": "admin" }],
            "congestion_control": "bbr",
            "tls": { "enabled": true, "alpn": ["h3"], "certificate_path": "cert.pem", "key_path": "private.key" }
        },
        {
            "type": "vless", "listen": "0.0.0.0", "listen_port": \${REALITY_PORT},
            "users": [{ "uuid": "\${UUID}", "flow": "xtls-rprx-vision" }],
            "tls": {
                "enabled": true, "server_name": "www.nazhumi.com",
                "reality": { "enabled": true, "handshake": { "server": "www.nazhumi.com", "server_port": 443 }, "private_key": "\${PRIVATE_KEY}", "short_id": [""] }
            }
        }
    ],
    "outbounds": [{ "type": "direct" }]
}
CONF

# ================== 启动 & 订阅 ==================
./"\$SB" run -c "config.json" &
PID=\$!
IP=\$(curl -s --max-time 5 ipv4.ip.sb || echo "面板外网域名IP")

urlencode() {
  local s="\${1}"; local l=\${#s}; local e=""; local p c o
  for ((p=0; p<l; p++)); do
    c=\${s:\$p:1}
    case "\$c" in [-_.~a-zA-Z0-9]) o="\${c}";; *) printf -v o '%%%02x' "'\$c";; esac
    e+="\${o}"
  done
  echo "\${e}"
}

echo -e "\n============================================="
echo -e "🎉 节点全自动配置完毕 (Sing-Box TUIC / vless)"
echo -e "============================================="
echo "tuic://\${UUID}:admin@\${IP}:\${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#\$(urlencode "\$TUIC_NAME")" | tee "list.txt"
echo "vless://\${UUID}@\${IP}:\${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=\${PUBLIC_KEY}&type=tcp#\$(urlencode "\$REALITY_NAME")" | tee -a "list.txt"

echo -e "\n============================================="
echo "🛡️ 守护进程已拉起..."

# ================== 守护进程 ==================
while true; do
  if ! kill -0 \$PID 2>/dev/null; then
    echo "⚠️ 核心进程已断开，子进程接管重启中..."
    ./"\$SB" run -c "config.json" &
    PID=\$!
  fi
  sleep 15
done
`;

const runnerFile = 'sb_runner.sh';
fs.writeFileSync(runnerFile, bashScript);

try {
    execSync(`bash ${runnerFile}`, { stdio: 'inherit' });
} catch (error) {
    console.log("⚠️ 守护主服务终止结束。");
}