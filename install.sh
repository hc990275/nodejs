#!/bin/bash

# 1. 获取端口 (优先使用传入的参数 $1，否则使用环境变量)
PORT="${1:-$SERVER_PORT}"
PORT="${PORT:-$PORT}"

# 如果依然没有端口，给一个默认值 (避免脚本报错)
if [ -z "$PORT" ]; then
  echo "[警告] 未检测到端口，使用默认端口 3000"
  PORT=3000
fi

# 定义端口分配：
# 由于 Sing-box 不能在同一端口同时监听两个协议，我们必须分开。
# Lunes 免费版通常只开放一个端口，所以建议主力使用 Reality。
# TUIC 端口设为 PORT + 1 (如果是 NAT 机器可能无法从外部连接，但能避免程序崩溃)
REALITY_PORT=$PORT
TUIC_PORT=$((PORT + 1))

echo "========================================"
echo " 正在配置 Lunes.host 节点"
echo " 主端口 (Reality): $REALITY_PORT"
echo " 副端口 (TUIC)   : $TUIC_PORT (可能无法直连)"
echo "========================================"

# 2. 生成 package.json
# 注意：Lunes 面板通常在启动前检测 package.json。
# 如果你上传了此脚本生成的 package.json，面板会自动 npm install。
cat > package.json << 'EOF'
{
  "name": "kata-node-lunes",
  "version": "1.0.0",
  "description": "Sing-box on PaaS",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {},
  "engines": {
    "node": ">=18"
  }
}
EOF

# 3. 生成 start.sh (核心逻辑)
cat > start.sh <<EOF
#!/bin/bash
set -e

# ================== 端口配置 ==================
export TUIC_PORT="${TUIC_PORT}"
export REALITY_PORT="${REALITY_PORT}"

# ================== 基础配置 ==================
TUIC_NAME="Lunes-Tuic"
REALITY_NAME="Lunes-Reality"
cd "\$(dirname "\$0")"
export FILE_PATH="\${PWD}/.npm"
mkdir -p "\$FILE_PATH"

# ================== UUID ==================
UUID_FILE="\${FILE_PATH}/uuid.txt"
if [ -f "\$UUID_FILE" ]; then
  UUID=\$(cat "\$UUID_FILE")
else
  UUID=\$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "d342d11e-d424-4583-b36e-524ab1f0afa4")
  echo "\$UUID" > "\$UUID_FILE"
  chmod 600 "\$UUID_FILE"
fi
echo "[UUID] \$UUID"

# ================== 下载 sing-box ==================
# 增加错误重试和备用源逻辑
ARCH=\$(uname -m)
case "\$ARCH" in
  arm*|aarch64) URL="https://arm64.ssss.nyc.mn/sb" ;;
  amd64*|x86_64) URL="https://amd64.ssss.nyc.mn/sb" ;;
  s390x) URL="https://s390x.ssss.nyc.mn/sb" ;;
  *) echo "架构不支持"; exit 1 ;;
esac

SB="\${FILE_PATH}/sb"
if [ ! -f "\$SB" ]; then
  echo "正在下载 Sing-box..."
  if command -v curl >/dev/null; then 
    curl -L -sS -o "\$SB" "\$URL" || { echo "下载失败"; exit 1; }
  else 
    wget -q -O "\$SB" "\$URL" || { echo "下载失败"; exit 1; }
  fi
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
# 关键修改：分开配置 Inbounds 端口，避免冲突
cat > "\${FILE_PATH}/config.json" <<CONF
{
  "log": { "disabled": false, "level": "info", "timestamp": true },
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
# 使用 exec 替换当前 shell 启动 sing-box，以便正确处理信号
"\$SB" run -c "\${FILE_PATH}/config.json" &
PID=\$!
IP=\$(curl -s --max-time 2 ipv4.ip.sb || echo "127.0.0.1")

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

# 挂起脚本以保持容器运行
wait \$PID
EOF

# 4. 赋予 start.sh 权限并执行
chmod +x start.sh

# Lunes 可能不需要手动运行 npm install (面板会做)，但跑一下也无妨
# npm install 

echo "[完成] 安装结束，正在启动..."
./start.sh
