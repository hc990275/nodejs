#!/bin/sh
# ==============================================================================
# V3 极轻量多协议节点管理中枢 - 全平台交互式一键部署系统
# 兼容: Alpine Linux / Ubuntu / Debian / CentOS / Rocky / Alma / Arch
# 协议支持: VLESS / VMess / Trojan / Reality / Hysteria 2 / ECH 订阅自适应
# ==============================================================================
set -e

# 终端高亮配色 (使用 printf 生成标准 ANSI 转义码，全发行版通用)
RED=$(printf '\033[0;31m')
GREEN=$(printf '\033[0;32m')
YELLOW=$(printf '\033[1;33m')
BLUE=$(printf '\033[0;34m')
CYAN=$(printf '\033[0;36m')
BOLD=$(printf '\033[1m')
NC=$(printf '\033[0m')

echo ""
echo "${BOLD}${CYAN}==============================================================${NC}"
echo "${BOLD}${CYAN}      V3 节点网关与自适应订阅中枢 - 通用一键部署系统          ${NC}"
echo "${BOLD}${CYAN}==============================================================${NC}"
echo ""

# 1. 提权与执行权限自适应
SUDO=""
if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        echo "${YELLOW}⚠️ 当前为非 root 用户，将自动通过 sudo 提权执行。${NC}"
    else
        echo "${RED}❌ 错误: 当前不是 root 用户且未安装 sudo，请切换到 root 后重试。${NC}"
        exit 1
    fi
fi

# 2. 交互式终端输入安全封装 (仅在输入时定向 /dev/tty，绝不劫持全局管道导致 curl 报 23 错误)
prompt_read() {
    _VAR_NAME="$1"
    if ( : < /dev/tty ) 2>/dev/null; then
        read -r "$_VAR_NAME" < /dev/tty
    else
        read -r "$_VAR_NAME"
    fi
}

# 3. 目标安装路径
INSTALL_DIR="${INSTALL_DIR:-/opt/v3-node}"
$SUDO mkdir -p "$INSTALL_DIR"

# 4. 操作系统类型与包管理器探测
OS_TYPE="unknown"
if [ -f /etc/alpine-release ]; then
    OS_TYPE="alpine"
elif [ -f /etc/debian_version ]; then
    OS_TYPE="debian"
elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ] || [ -f /etc/rocky-release ] || [ -f /etc/almalinux-release ]; then
    OS_TYPE="rhel"
elif [ -f /etc/arch-release ]; then
    OS_TYPE="arch"
fi

echo "${BLUE}🔍 识别到系统环境:${NC} ${BOLD}$OS_TYPE${NC}"

# 5. 依赖包自动补全 (curl, wget, tar, nodejs, openssl, ca-certificates)
echo "${BLUE}📦 检查并补全系统必要组件...${NC}"

ensure_cmd() {
    _CMD="$1"
    command -v "$_CMD" >/dev/null 2>&1
}

case "$OS_TYPE" in
    alpine)
        $SUDO apk update >/dev/null 2>&1 || true
        $SUDO apk add --no-cache curl wget tar nodejs npm openssl ca-certificates >/dev/null 2>&1 || true
        ;;
    debian)
        export DEBIAN_FRONTEND=noninteractive
        $SUDO apt-get update -y >/dev/null 2>&1 || true
        $SUDO apt-get install -y curl wget tar nodejs npm openssl ca-certificates >/dev/null 2>&1 || true
        ;;
    rhel)
        if command -v dnf >/dev/null 2>&1; then
            $SUDO dnf install -y curl wget tar nodejs openssl ca-certificates >/dev/null 2>&1 || true
        else
            $SUDO yum install -y curl wget tar nodejs openssl ca-certificates >/dev/null 2>&1 || true
        fi
        ;;
    arch)
        $SUDO pacman -Sy --noconfirm curl wget tar nodejs npm openssl ca-certificates >/dev/null 2>&1 || true
        ;;
    *)
        echo "${YELLOW}⚠️ 未知 Linux 发行版，尝试检查现存 nodejs 与下载工具...${NC}"
        ;;
esac

# 验证 nodejs 是否成功就绪
if ! ensure_cmd node; then
    echo "${RED}❌ 错误: 未能在当前系统安装 Node.js 运行时，请手动安装 Node.js (>= 18) 后再次运行本脚本。${NC}"
    exit 1
fi

NODE_VER="$(node -v 2>/dev/null || echo "v0")"
NODE_BIN="$(command -v node)"
echo "${GREEN}✅ Node.js 运行时就绪:${NC} $NODE_BIN ($NODE_VER)"

# 6. 计算内存防护阈值 (针对小内存 NAT 鸡 / 极简 VPS 进行防 OOM 注入)
TOTAL_RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo "512")
if [ "$TOTAL_RAM_MB" -le 256 ]; then
    MEM_LIMIT="48"
elif [ "$TOTAL_RAM_MB" -le 512 ]; then
    MEM_LIMIT="96"
else
    MEM_LIMIT="256"
fi
echo "${BLUE}🧠 宿主机内存:${NC} ${TOTAL_RAM_MB} MB (已自动配置防 OOM 上限: --max-old-space-size=${MEM_LIMIT})"

# 7. 自动探测公网 IPv4
echo "${BLUE}🌐 正在自动探测服务器公网 IPv4 地址...${NC}"
DETECTED_IP="$(curl -s4 -m 5 https://api.ipify.org 2>/dev/null || wget -qO- --timeout=5 https://api.ipify.org 2>/dev/null || curl -s4 -m 5 https://ifconfig.me 2>/dev/null || wget -qO- --timeout=5 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")"
echo "${GREEN}✅ 探测到公网 IPv4:${NC} ${BOLD}$DETECTED_IP${NC}"
echo ""

# 8. 交互式设定向导 (回溯端口、管理密码、回溯域名)
echo "${BOLD}${CYAN}──────────────────────────────────────────────────────────────${NC}"
echo "${BOLD}📋 交互式参数设定 (直接按 Enter 回车使用默认推荐值或自动生成)：${NC}"
echo "${BOLD}${CYAN}──────────────────────────────────────────────────────────────${NC}"

# (1) 回溯监听端口
IN_PORT="${PORT:-${SERVER_PORT:-}}"
if [ -z "$IN_PORT" ]; then
    while true; do
        printf "${BOLD}${BLUE}1. 请设置回溯监听端口 (SERVER_PORT)${NC} [默认: 21216]: "
        prompt_read IN_PORT
        IN_PORT="${IN_PORT:-21216}"
        case "$IN_PORT" in
            ''|*[!0-9]*)
                echo "${RED}   ✗ 端口必须为纯数字 (1-65535)，请重新输入${NC}"
                ;;
            *)
                if [ "$IN_PORT" -ge 1 ] && [ "$IN_PORT" -le 65535 ]; then
                    break
                else
                    echo "${RED}   ✗ 端口范围必须在 1 到 65535 之间，请重新输入${NC}"
                fi
                ;;
        esac
    done
else
    echo "1. 回溯监听端口: ${CYAN}$IN_PORT${NC} (由环境变量指定)"
fi

# (2) 管理后台密码
IN_TOKEN="${TOKEN:-${ADMIN_TOKEN:-}}"
if [ -z "$IN_TOKEN" ]; then
    DEFAULT_TOKEN="$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 10 || echo "Admin990299")"
    printf "${BOLD}${BLUE}2. 请设置管理后台密码 (ADMIN_TOKEN)${NC} [回车自动生成: %s]: " "$DEFAULT_TOKEN"
    prompt_read IN_TOKEN
    IN_TOKEN="${IN_TOKEN:-$DEFAULT_TOKEN}"
else
    echo "2. 管理后台密码: ${YELLOW}$IN_TOKEN${NC} (由环境变量指定)"
fi

# (3) 回溯域名 (可留空，后续后台填写)
IN_DOMAIN="${DOMAIN:-${SERVER_DOMAIN:-}}"
if [ -z "$IN_DOMAIN" ]; then
    printf "${BOLD}${BLUE}3. 请设置回溯域名 (SERVER_DOMAIN)${NC} [回车直接跳过，后续可在后台随时填写]: "
    prompt_read IN_DOMAIN
    IN_DOMAIN="${IN_DOMAIN:-}"
else
    echo "3. 回溯域名: ${CYAN}$IN_DOMAIN${NC} (由环境变量指定)"
fi

echo ""
echo "${GREEN}⚙️ 参数确认完毕:${NC}"
echo "  • 回溯监听端口 : ${CYAN}$IN_PORT${NC}"
echo "  • 管理后台密码 : ${YELLOW}$IN_TOKEN${NC}"
if [ -n "$IN_DOMAIN" ]; then
    echo "  • 回溯域名(CF) : ${CYAN}$IN_DOMAIN${NC}"
else
    echo "  • 回溯域名(CF) : ${YELLOW}(未设置，可在 Web 管理后台随时填写)${NC}"
fi
echo "  • 探测公网 IPv4: ${CYAN}$DETECTED_IP${NC}"
echo "${BOLD}${CYAN}──────────────────────────────────────────────────────────────${NC}"
echo ""

# 9. 拉取最新程序代码 (从 GitHub 仓库 hc990275/nodejs 的 node 目录)
echo "${BLUE}🚀 正在从云端拉取项目程序包...${NC}"
TMP_TAR="/tmp/v3_node_latest.tar.gz"
TMP_EXTRACT="/tmp/v3_node_extract_$$"

rm -rf "$TMP_TAR" "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"

DOWNLOAD_OK=0
REPO_TAR_URLS="
https://github.com/hc990275/nodejs/archive/refs/heads/main.tar.gz
https://ghproxy.net/https://github.com/hc990275/nodejs/archive/refs/heads/main.tar.gz
https://mirror.ghproxy.com/https://github.com/hc990275/nodejs/archive/refs/heads/main.tar.gz
"

fetch_url() {
    _U="$1"
    _D="$2"
    if ensure_cmd curl; then
        curl -fsSL -m 15 "$_U" -o "$_D" 2>/dev/null
    elif ensure_cmd wget; then
        wget -qO "$_D" --timeout=15 "$_U" 2>/dev/null
    else
        return 1
    fi
}

for u in $REPO_TAR_URLS; do
    if [ -n "$u" ]; then
        if fetch_url "$u" "$TMP_TAR"; then
            if tar -xzf "$TMP_TAR" -C "$TMP_EXTRACT" 2>/dev/null; then
                DOWNLOAD_OK=1
                break
            fi
        fi
    fi
done

if [ "$DOWNLOAD_OK" = "1" ] && [ -d "$TMP_EXTRACT/nodejs-main/node" ]; then
    echo "${GREEN}✅ 源代码包下载解压成功，正在同步至 $INSTALL_DIR ...${NC}"
    $SUDO cp -rf "$TMP_EXTRACT/nodejs-main/node/"* "$INSTALL_DIR/"
    $SUDO cp -rf "$TMP_EXTRACT/nodejs-main/node/".* "$INSTALL_DIR/" 2>/dev/null || true
    rm -rf "$TMP_TAR" "$TMP_EXTRACT"
else
    echo "${YELLOW}⚠️ 归档压缩包拉取受限，尝试通过 git 浅克隆...${NC}"
    if ensure_cmd git; then
        rm -rf /tmp/v3-git-clone
        if git clone --depth 1 https://github.com/hc990275/nodejs.git /tmp/v3-git-clone 2>/dev/null; then
            $SUDO cp -rf /tmp/v3-git-clone/node/* "$INSTALL_DIR/"
            $SUDO cp -rf /tmp/v3-git-clone/node/.* "$INSTALL_DIR/" 2>/dev/null || true
            rm -rf /tmp/v3-git-clone
            DOWNLOAD_OK=1
        fi
    fi
    if [ "$DOWNLOAD_OK" != "1" ]; then
        echo "${RED}❌ 无法从 GitHub 仓库下载项目文件，请检查当前服务器的国际互联网连接。${NC}"
        exit 1
    fi
fi

# 10. 生成/更新配置文件 .env
ENV_FILE="$INSTALL_DIR/.env"
echo "${GREEN}⚙️ 正在写入配置文件 $ENV_FILE ...${NC}"

$SUDO tee "$ENV_FILE" >/dev/null <<EOF
# ==============================================================================
# V3 节点网关环境变量配置文件 (.env)
# ==============================================================================

# ----------------- 1. 安全与管理后台口令 (必填) -----------------
ADMIN_TOKEN=$IN_TOKEN

# ----------------- 2. 网络监听与公网地址自适应 -----------------
SERVER_PORT=$IN_PORT
SERVER_IP=$DETECTED_IP
SERVER_DOMAIN=$IN_DOMAIN

# ----------------- 3. Cloudflare Argo 隧道与 CDN 优选 (选填) -----------------
ARGO_TOKEN=
ARGO_DOMAIN=
OPTIMIZED_DOMAIN=

# ----------------- 4. 多节点集群与异地节点扩展 (选填) -----------------
EXTRA_NODES=

# ----------------- 5. 极速协议参数配置 (Hy2 / TUIC / Reality) -----------------
UDP_QUIC_PROTOCOL=hy2
TUIC_PORT=
REALITY_DEST=www.apple.com:443
REALITY_SNI=www.apple.com
EOF

# 权限加固
$SUDO chmod -R 755 "$INSTALL_DIR"
$SUDO chmod 600 "$ENV_FILE" 2>/dev/null || true

# 11. 守护进程安装与自启动 (systemd / OpenRC 双自适应)
echo "${BLUE}🛠️ 正在配置系统级守护与自启服务...${NC}"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    # Systemd (Debian / Ubuntu / CentOS / Rocky)
    SERVICE_FILE="/etc/systemd/system/v3-node.service"
    $SUDO tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=V3 Multi-Protocol Airport Gateway Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN --max-old-space-size=$MEM_LIMIT index.js
Restart=always
RestartSec=3
LimitNOFILE=65535
LimitNPROC=65535

[Install]
WantedBy=multi-user.target
EOF

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable v3-node >/dev/null 2>&1 || true
    $SUDO systemctl restart v3-node
    echo "${GREEN}✅ systemd 服务 (v3-node) 已配置并自启启动！${NC}"

elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
    # OpenRC (Alpine Linux)
    OPENRC_FILE="/etc/init.d/v3-node"
    $SUDO tee "$OPENRC_FILE" >/dev/null <<EOF
#!/sbin/openrc-run

name="v3-node"
description="V3 Multi-Protocol Airport Gateway Service"
directory="$INSTALL_DIR"
command="$NODE_BIN"
command_args="--max-old-space-size=$MEM_LIMIT index.js"
command_background="yes"
pidfile="/run/v3-node.pid"
output_log="/var/log/v3-node.log"
error_log="/var/log/v3-node.log"

depend() {
    need net
    after firewall
}

start_pre() {
    checkpath -f -m 0644 -o root:root /var/log/v3-node.log
}
EOF
    $SUDO chmod +x "$OPENRC_FILE"
    $SUDO rc-update add v3-node default >/dev/null 2>&1 || true
    $SUDO rc-service v3-node restart
    echo "${GREEN}✅ OpenRC 服务 (v3-node) 已配置并自启启动！${NC}"

else
    # 极简容器 / 无守护系统兜底
    echo "${YELLOW}⚠️ 未检测到系统级 init 守护，使用 nohup 后台保活启动...${NC}"
    $SUDO pkill -f "$INSTALL_DIR/index.js" 2>/dev/null || true
    cd "$INSTALL_DIR"
    $SUDO nohup "$NODE_BIN" --max-old-space-size="$MEM_LIMIT" index.js > "$INSTALL_DIR/run.log" 2>&1 &
fi

# 12. 交付与凭据清单
echo ""
echo "${BOLD}${GREEN}==============================================================${NC}"
echo "${BOLD}${GREEN}  🎉 V3 极轻量节点网关与订阅中枢已全部部署成功！               ${NC}"
echo "${BOLD}${GREEN}==============================================================${NC}"
echo ""
echo "${BOLD}🌐 访问地址与凭据:${NC}"
echo "  • 服务器公网 IP : ${CYAN}$DETECTED_IP${NC}"
echo "  • 回溯监听端口  : ${CYAN}$IN_PORT${NC}"
echo "  • 前台用户中心  : ${BLUE}http://$DETECTED_IP:$IN_PORT/${NC}"
echo "  • 管理后台地址  : ${BLUE}http://$DETECTED_IP:$IN_PORT/admin${NC}"
echo "  • 后台免密直通  : ${BLUE}http://$DETECTED_IP:$IN_PORT/admin?token=$IN_TOKEN${NC}"
echo "  • 管理员密码    : ${YELLOW}$IN_TOKEN${NC}"
if [ -n "$IN_DOMAIN" ]; then
echo "  • Cloudflare回溯: ${CYAN}https://$IN_DOMAIN${NC}"
echo "  • 回溯订阅地址  : ${BLUE}https://$IN_DOMAIN/sub?token=<用户UUID>${NC}"
else
echo "  • 回溯域名      : ${YELLOW}(暂未设置，请登录后台手动填入回溯主域名)${NC}"
fi
echo ""
echo "${BOLD}📋 服务运维命令:${NC}"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
echo "  • 查看状态 : ${YELLOW}systemctl status v3-node${NC}"
echo "  • 重启服务 : ${YELLOW}systemctl restart v3-node${NC}"
echo "  • 查看日志 : ${YELLOW}journalctl -u v3-node -f -n 50${NC}"
elif command -v rc-service >/dev/null 2>&1; then
echo "  • 查看状态 : ${YELLOW}rc-service v3-node status${NC}"
echo "  • 重启服务 : ${YELLOW}rc-service v3-node restart${NC}"
echo "  • 查看日志 : ${YELLOW}tail -f /var/log/v3-node.log${NC}"
fi
echo "  • 配置文件 : ${YELLOW}$ENV_FILE${NC} (支持毫秒级热重载，保存即生效)"
echo "${BOLD}${GREEN}==============================================================${NC}"
echo ""
