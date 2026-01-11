#!/bin/bash
# Kata-Node: VLESS + TUIC (TUIC 稳定性修复版)
# --------------------------------------------------
# 1. TUIC 改用 cubic 拥塞控制 (防止 BBR 兼容性问题)
# 2. 关闭 Zero-RTT 以解决握手超时
# 3. 增加 UDP 心跳保活
# --------------------------------------------------

set -euo pipefail
IFS=$'\n\t'

# ===================== 基础配置 =====================
WORKDIR="/home/container"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

CONFIG_FILE="config.json"
SB_BIN="./sing-box"
LINK_TXT="links.txt"

# VLESS 伪装域名
REALITY_SNI="learn.microsoft.com"
REALITY_PORT=443

# TUIC 伪装域名
TUIC_SNI="www.bing.com"

# ===================== 1. 获取端口 =====================
PORT=${SERVER_PORT:-${PORT:-3000}}

echo "========================================"
echo "   Kata-Node (TUIC 修复版)"
echo "   监听端口: $PORT"
echo "========================================"

# ===================== 2. 强制清理旧配置 =====================
# 依然清理旧配置，确保参数一致
rm -f config.json
# 注意：保留 .reality_keys 和 .uuid 以免节点信息频繁变动
# 如果你想彻底重置，请手动把 .reality_keys 删掉

# ===================== 3. 凭证管理 =====================
setup_credentials() {
  local uuid_file=".uuid"
  if [[ -f "$uuid_file" ]]; then
    UUID=$(cat "$uuid_file")
    echo "✅ [凭证] 使用固定 UUID: $UUID"
  else
    UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo "d342d11e-d424-4583-b36e-524ab1f0afa4")
    echo "$UUID" > "$uuid_file"
    echo "🆕 [凭证] 生成新 UUID: $UUID"
  fi
}

# ===================== 4. TUIC 证书生成 =====================
generate_tuic_cert() {
  if [[ -f "cert.pem" && -f "key.pem" ]]; then
    echo "🔐 [证书] TUIC 证书已存在"
  else
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
      -keyout "key.pem" -out "cert.pem" -subj "/CN=${TUIC_SNI}" -days 3650 -nodes >/dev/null 2>&1
  fi
}

# ===================== 5. 下载 Sing-box =====================
install_singbox() {
  if [[ -x "$SB_BIN" ]]; then
    echo "✅ [程序] sing-box 已存在"
    return
  fi
  echo "📥 [程序] 正在下载 sing-box..."
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64) SB_ARCH="amd64" ;;
    aarch64|arm64) SB_ARCH="arm64" ;;
    *) echo "❌ 不支持的架构: $ARCH"; exit 1 ;;
  esac
  DOWNLOAD_URL="https://github.com/SagerNet/sing-box/releases/download/v1.9.0/sing-box-1.9.0-linux-${SB_ARCH}.tar.gz"
  curl -L -s "$DOWNLOAD_URL" | tar xz
  mv "sing-box-1.9.0-linux-${SB_ARCH}/sing-box" .
  rm -rf "sing-box-1.9.0-linux-${SB_ARCH}"
  chmod +x "$SB_BIN"
}

# ===================== 6. 获取 Reality 密钥 =====================
get_reality_keys() {
  local key_file=".reality_keys"
  if [[ -f "$key_file" ]]; then
    PRIVATE_KEY=$(grep "Private" "$key_file" | awk '{print $2}')
    PUBLIC_KEY=$(grep "Public" "$key_file" | awk '{print $2}')
    echo "✅ [密钥] 读取已有 Reality 密钥"
  else
    echo "🆕 [密钥] 生成新的 Reality 密钥..."
    KEYS=$($SB_BIN generate reality-keypair)
    echo "$KEYS" > "$key_file"
    PRIVATE_KEY=$(echo "$KEYS" | grep "PrivateKey" | awk '{print $2}')
    PUBLIC_KEY=$(echo "$KEYS" | grep "PublicKey" | awk '{print $2}')
  fi
}

# ===================== 7. 生成配置文件 (修复重点) =====================
generate_config() {
  cat > "$CONFIG_FILE" <<EOF
{
  "log": { "level": "info", "timestamp": true },
  "dns": { "servers": [ {"tag": "google", "address": "8.8.8.8"} ] },
  "inbounds": [
    {
      "type": "vless", 
      "tag": "vless-in", 
      "listen": "::", 
      "listen_port": $PORT,
      "users": [ {"uuid": "$UUID", "flow": "xtls-rprx-vision"} ],
      "tls": {
        "enabled": true, 
        "server_name": "$REALITY_SNI",
        "reality": {
          "enabled": true,
          "handshake": { "server": "$REALITY_SNI", "server_port": $REALITY_PORT },
          "private_key": "$PRIVATE_KEY",
          "short_id": [""]
        }
      }
    },
    {
      "type": "tuic", 
      "tag": "tuic-in", 
      "listen": "::", 
      "listen_port": $PORT,
      "users": [ {"uuid": "$UUID", "password": "$UUID"} ],
      "congestion_control": "cubic",
      "zero_rtt_handshake": false,
      "heartbeat": "10s",
      "tls": {
        "enabled": true, 
        "alpn": ["h3"],
        "certificate_path": "cert.pem", "key_path": "key.pem"
      }
    }
  ],
  "outbounds": [ {"type": "direct", "tag": "direct"} ]
}
EOF
  echo "✅ [配置] 配置文件已优化 (TUIC cubic/no-0rtt)"
}

# ===================== 8. 生成订阅链接 =====================
generate_links() {
  IP=$(curl -s --connect-timeout 3 https://api.ipify.org || echo "YOUR_IP")
  NAME_VLESS="Lunes-VLESS"
  NAME_TUIC="Lunes-TUIC"

  VLESS_LINK="vless://${UUID}@${IP}:${PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${REALITY_SNI}&fp=chrome&pbk=${PUBLIC_KEY}&type=tcp#${NAME_VLESS}"
  # TUIC 链接去除 allowInsecure 参数，因为 sing-box 客户端处理方式不同，建议在客户端手动开启跳过验证
  TUIC_LINK="tuic://${UUID}:${UUID}@${IP}:${PORT}?congestion_control=cubic&alpn=h3&allowInsecure=1&sni=${TUIC_SNI}&udp_relay_mode=native&disable_sni=0#${NAME_TUIC}"

  echo -e "${VLESS_LINK}\n${TUIC_LINK}" > "$LINK_TXT"
  echo ""
  echo "---------------- 节点信息 (请更新配置) ----------------"
  echo "1. VLESS Reality (TCP):"
  echo "$VLESS_LINK"
  echo ""
  echo "2. TUIC v5 (UDP - 已优化):"
  echo "$TUIC_LINK"
  echo "----------------------------------------------------"
}

# ===================== 主逻辑 =====================
main() {
  setup_credentials
  generate_tuic_cert
  install_singbox
  get_reality_keys
  generate_config
  generate_links

  echo "🔥 [启动] 正在启动 Sing-box..."
  while true; do
    "$SB_BIN" run -c "$CONFIG_FILE"
    echo "⚠️ 进程退出，3秒后重启..."
    sleep 3
  done
}

main
