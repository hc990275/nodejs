#!/bin/bash

# 1. 交互式询问端口
read -p "请输入您想要的端口号: " PORT

if [ -z "$PORT" ]; then
  echo "端口不能为空"
  exit 1
fi

echo "正在配置端口: $PORT (Hy2已禁用)..."

# 2. 生成 package.json
cat > package.json << 'EOF'
{
  "name": "kata-node",
  "version": "1.0.0",
  "scripts": {
    "start": "node index.js"
  },
  "engines": {
    "node": ">=18"
  }
}
EOF

# 3. 生成 index.js
cat > index.js << 'EOF'
#!/usr/bin/env node
require('child_process').execSync('bash start.sh', { stdio: 'inherit' });
EOF

# 4. 生成 start.sh (核心逻辑)
cat > start.sh <<EOF
#!/bin/bash
set -e

# ================== 端口配置 ==================
export TUIC_PORT="${PORT}"
export REALITY_PORT="${PORT}"
export HY2_PORT=""

# ================== 基础配置 ==================
TUIC_NAME="tuic法国"
REALITY_NAME="vless法国"
cd "\$(dirname "\$0")"
export FILE_PATH="\${PWD}/.npm"
mkdir -p "\$FILE_PATH"

# ================== UUID ==================
UUID_FILE="\${FILE_PATH}/uuid.txt"
if [ -f "\$UUID_FILE" ]; then
  UUID=\$(cat "\$UUID_FILE")
else
  UUID=\$(cat /proc/sys/kernel/random/uuid)
  echo "\$UUID" > "\$UUID_FILE"
  chmod 600 "\$UUID_FILE"
fi
echo "[UUID] \$UUID"

# ================== 下载 sing-box ==================
ARCH=\$(uname -m)
case "\$ARCH" in
  arm*|aarch64) URL="https://arm64.ssss.nyc.mn/sb" ;;
  amd64*|x86_64) URL="https://amd64.ssss.nyc.mn/sb" ;;
  s390x) URL="https://s390x.ssss.nyc.mn/sb" ;;
  *) echo "架构不支持"; exit 1 ;;
esac

SB="\${FILE_PATH}/sb"
if [ ! -f "\$SB" ]; then
  if command -v curl >/dev/null; then curl -L -sS -o "\$SB" "\$URL"; else wget -q -O "\$SB" "\$URL"; fi
  chmod +x "\$SB"
fi

# ================== 密钥 & 证书 ==================
KEY="\${FILE_PATH}/key.txt"
[ ! -f "\$KEY" ] && "\$SB" generate reality-keypair > "\$KEY"
PRIVATE_KEY=\$(grep "PrivateKey:" "\$KEY" | awk '{print \$2}')
PUBLIC_KEY=\$(grep "PublicKey:" "\$KEY" | awk '{print \$2}')

if ! command -v openssl >/dev/null; then
  echo "OpenSSL is required to generate a unique local TLS key; install it before continuing." >&2
  exit 1
else
  openssl ecparam -genkey -name prime256v1 -out "\${FILE_PATH}/private.key" 2>/dev/null
  openssl req -new -x509 -days 3650 -key "\${FILE_PATH}/private.key" -out "\${FILE_PATH}/cert.pem" -subj "/CN=bing.com" 2>/dev/null
fi

# ================== 生成 Config ==================
cat > "\${FILE_PATH}/config.json" <<CONF
{
  "log": { "disabled": true },
  "inbounds": [
    {
      "type": "tuic", "listen": "::", "listen_port": \$TUIC_PORT,
      "users": [{"uuid": "\$UUID", "password": "admin"}],
      "congestion_control": "bbr",
      "tls": {"enabled": true, "alpn": ["h3"], "certificate_path": "\${FILE_PATH}/cert.pem", "key_path": "\${FILE_PATH}/private.key"}
    },
    {
      "type": "vless", "listen": "::", "listen_port": \$REALITY_PORT,
      "users": [{"uuid": "\$UUID", "flow": "xtls-rprx-vision"}],
      "tls": {
        "enabled": true, "server_name": "www.nazhumi.com",
        "reality": { "enabled": true, "handshake": {"server": "www.nazhumi.com", "server_port": 443}, "private_key": "\$PRIVATE_KEY", "short_id": [""] }
      }
    }
  ],
  "outbounds": [{"type": "direct"}]
}
CONF

# ================== 启动 & 订阅 ==================
"\$SB" run -c "\${FILE_PATH}/config.json" &
PID=\$!
IP=\$(curl -s --max-time 2 ipv4.ip.sb || echo "IP_ERROR")

urlencode() {
  local s="\${1}"; local l=\${#s}; local e=""; local p c o
  for (( p=0 ; p<l ; p++ )); do
    c=\${s:\$p:1}
    case "\$c" in [-_.~a-zA-Z0-9] ) o="\${c}" ;; * ) printf -v o '%%%02x' "'\$c" ;; esac
    e+="\${o}"
  done
  echo "\${e}"
}

echo -e "\n--- 节点列表 ---"
echo "tuic://\${UUID}:admin@\${IP}:\${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#\$(urlencode "\$TUIC_NAME")" | tee "\${FILE_PATH}/list.txt"
echo "vless://\${UUID}@\${IP}:\${REALITY_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.nazhumi.com&fp=firefox&pbk=\${PUBLIC_KEY}&type=tcp#\$(urlencode "\$REALITY_NAME")" | tee -a "\${FILE_PATH}/list.txt"

base64 "\${FILE_PATH}/list.txt" | tr -d '\n' > "\${FILE_PATH}/sub.txt"
echo -e "\n[订阅文件] \${FILE_PATH}/sub.txt"

# ================== 守护进程 (00:03重启) ==================
while true; do
  now=\$(date +%s)
  bj=\$((now + 28800))
  H=\$(( (bj/3600)%24 ))
  M=\$(( (bj/60)%60 ))
  if [ "\$H" -eq 0 ] && [ "\$M" -eq 3 ]; then
     kill "\$PID" 2>/dev/null
     sleep 3
     "\$SB" run -c "\${FILE_PATH}/config.json" &
     PID=\$!
     sleep 60
  fi
  sleep 30
done
EOF

# 5. 执行
chmod +x start.sh
npm install
npm start
