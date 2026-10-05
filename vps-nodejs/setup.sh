#!/usr/bin/env bash
# ========================================================
# VPS-Tunnel: Linux VPS 一键全能部署与开机自启程序
# 适配全系操作系统:
#  - Alpine Linux 3.16+ (apk + OpenRC)
#  - Debian 10+ / Ubuntu 20.04+ (apt-get + systemd)
#  - CentOS 8+ / Rocky Linux / AlmaLinux / Fedora (dnf/yum + systemd)
# ========================================================

set -e

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
BOLD="\033[1m"
PLAIN="\033[0m"

echo -e "${CYAN}========================================================${PLAIN}"
echo -e "${GREEN}🚀 VPS-Tunnel 纯原生 Node.js VLESS 隧道一键安装程序${PLAIN}"
echo -e "${CYAN}========================================================${PLAIN}"

if [ "$(id -u)" != "0" ]; then
    echo -e "${RED}[Error] 必须使用 root 用户执行此脚本！${PLAIN}"
    exit 1
fi

INSTALL_DIR="/opt/vps-tunnel"

# 1. 检查并安装 Node.js 运行环境与必备系统工具
echo -e "${YELLOW}[1/5] 检查系统环境与包管理器...${PLAIN}"

if command -v apk >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 Alpine Linux 环境，使用 apk 快速装配运行环境...${PLAIN}"
    apk update
    apk add --no-cache nodejs npm curl bash openssh-server openssl ca-certificates openrc cloudflared 2>/dev/null || \
    apk add --no-cache nodejs npm curl bash openssh-server openssl ca-certificates openrc

    # 针对 Alpine 容器：自动配置与激活 SSHD 服务，确保映射端口畅通
    if [ -f /etc/ssh/sshd_config ]; then
        sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
        sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
        ssh-keygen -A 2>/dev/null || true
        rc-update add sshd default 2>/dev/null || true
        rc-service sshd restart 2>/dev/null || /usr/sbin/sshd 2>/dev/null || true
        echo -e "${GREEN}✅ Alpine SSHD 服务已激活并放行 root 远程连接${PLAIN}"
    fi

elif command -v apt-get >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 Debian/Ubuntu 环境，更新软件源...${PLAIN}"
    apt-get update -y
    apt-get install -y curl ca-certificates gnupg openssl bash
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}未检测到 Node.js，正在自动从官方源安装最新 LTS...${PLAIN}"
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    fi

elif command -v dnf >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 RHEL/Fedora 环境...${PLAIN}"
    dnf install -y curl openssl ca-certificates bash
    if ! command -v node >/dev/null 2>&1; then
        dnf module install -y nodejs:20 || dnf install -y nodejs
    fi

elif command -v yum >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 CentOS 环境...${PLAIN}"
    yum install -y curl openssl ca-certificates bash
    if ! command -v node >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
    fi

else
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${RED}[Error] 未知包管理器且未检测到 Node.js，请手动安装 Node.js 18+！${PLAIN}"
        exit 1
    fi
fi

NODE_VER=$(node -v)
echo -e "${GREEN}✅ Node.js 运行环境已就绪: ${NODE_VER}${PLAIN}"

# 2. 创建安装目录并部署文件
echo -e "${YELLOW}[2/5] 部署应用文件至 ${INSTALL_DIR}...${PLAIN}"
mkdir -p "${INSTALL_DIR}/data"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_URL="https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs"
GH_PROXY="https://gh-proxy.net/${RAW_URL}"

# 探测本地文件是否存在；若不存在（例如通过 curl 管道直接执行），则从远程高速拉取
if [ -f "${SCRIPT_DIR}/index.js" ]; then
    echo -e "${CYAN}检测到本地源码，正在从当前目录部署...${PLAIN}"
    cp -f "${SCRIPT_DIR}/index.js" "${INSTALL_DIR}/"
    cp -f "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/start.sh" ] && cp -f "${SCRIPT_DIR}/start.sh" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/optimize_bbr.sh" ] && cp -f "${SCRIPT_DIR}/optimize_bbr.sh" "${INSTALL_DIR}/"
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        if [ -f "${SCRIPT_DIR}/.env" ]; then
            cp -f "${SCRIPT_DIR}/.env" "${INSTALL_DIR}/"
        elif [ -f "${SCRIPT_DIR}/.env.example" ]; then
            cp -f "${SCRIPT_DIR}/.env.example" "${INSTALL_DIR}/.env"
        fi
    fi
else
    echo -e "${CYAN}检测到远程在线安装模式，正在高速下载项目文件...${PLAIN}"
    download_remote() {
        local fname="$1"
        local target="${INSTALL_DIR}/${fname}"
        if ! curl -fsSL --connect-timeout 8 -m 30 "${RAW_URL}/${fname}" -o "${target}"; then
            curl -fsSL --connect-timeout 8 -m 30 "${GH_PROXY}/${fname}" -o "${target}"
        fi
    }
    download_remote "index.js"
    download_remote "package.json"
    download_remote "start.sh"
    download_remote "optimize_bbr.sh"
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        download_remote ".env.example"
        cp -f "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    fi
fi

# 确保 .env 文件存在并根据环境变量或随机安全口令初始化
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    GEN_PWD=$(head -c 32 /dev/urandom 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 16 || echo "Admin$(date +%s)")
    cat << EOF > "${INSTALL_DIR}/.env"
UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "c82662c1-bb38-4e8c-850f-ae5be201c107")
ARGO_DOMAIN=
ARGO_TOKEN=
PORT=19900
ADMIN_PASSWORD=${GEN_PWD}
RETRY_MAX=3
EOF
    echo -e "${GREEN}🔐 已为您自动生成初始高强度管理员口令: ${BOLD}${GEN_PWD}${PLAIN}${GREEN} (已落盘至 .env)${PLAIN}"
fi

# 若安装时显式注入了环境变量，则自动热写入 .env
if [ -n "$SET_UUID" ]; then
    sed -i "s/^UUID=.*/UUID=${SET_UUID}/" "${INSTALL_DIR}/.env"
fi
if [ -n "$SET_PORT" ]; then
    sed -i "s/^PORT=.*/PORT=${SET_PORT}/" "${INSTALL_DIR}/.env"
fi
if [ -n "$SET_ADMIN_PASSWORD" ]; then
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${SET_ADMIN_PASSWORD}/" "${INSTALL_DIR}/.env"
fi
if [ -n "$SET_ARGO_DOMAIN" ]; then
    sed -i "s/^ARGO_DOMAIN=.*/ARGO_DOMAIN=${SET_ARGO_DOMAIN}/" "${INSTALL_DIR}/.env"
fi
if [ -n "$SET_ARGO_TOKEN" ]; then
    # 对 Token 采用安全替换
    grep -q "^ARGO_TOKEN=" "${INSTALL_DIR}/.env" && sed -i '/^ARGO_TOKEN=/d' "${INSTALL_DIR}/.env"
    echo "ARGO_TOKEN=${SET_ARGO_TOKEN}" >> "${INSTALL_DIR}/.env"
fi

chmod +x "${INSTALL_DIR}"/*.sh 2>/dev/null || true

# 3. 注册守护进程 (适配 Systemd 或 OpenRC)
echo -e "${YELLOW}[3/5] 配置系统自启守护进程...${PLAIN}"
NODE_BIN=$(command -v node)

IS_SYSTEMD=false
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    IS_SYSTEMD=true
fi

if [ "$IS_SYSTEMD" = "true" ]; then
    echo -e "${CYAN}系统环境: Systemd，正在生成服务单元...${PLAIN}"
    cat <<EOF > /etc/systemd/system/vps-tunnel.service
[Unit]
Description=VPS-Tunnel High Performance Native Node.js VLESS Proxy & Wetest Hub
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=-${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} index.js
Restart=always
RestartSec=5s
LimitNOFILE=65535
LimitNPROC=65535
StandardOutput=journal
StandardError=journal
SyslogIdentifier=vps-tunnel

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable vps-tunnel
    systemctl restart vps-tunnel

elif command -v rc-service >/dev/null 2>&1 || [ -d /etc/init.d ]; then
    echo -e "${CYAN}系统环境: OpenRC (Alpine)，正在配置 /etc/init.d/vps-tunnel...${PLAIN}"
    cat <<'EOF' > /etc/init.d/vps-tunnel
#!/sbin/openrc-run
description="VPS-Tunnel High Performance Native Node.js VLESS Proxy"

supervisor="supervise-daemon"
respawn_delay=2
respawn_max=0

VDIR="/opt/vps-tunnel"
command="/usr/bin/node"
command_args="index.js"
command_dir="${VDIR}"
pidfile="/run/vps-tunnel.pid"
output_log="/var/log/vps-tunnel.log"
error_log="/var/log/vps-tunnel.log"

depend() {
    need net
    after firewall
}

start_pre() {
    cd "${VDIR}"
    if [ -f "${VDIR}/.env" ]; then
        set -a
        . "${VDIR}/.env"
        set +a
    fi
    export UV_THREADPOOL_SIZE=64

    # 🚀 全自动动态探测系统/容器内存上限 (绝不硬编码)
    TOTAL_MEM_BYTES=0
    if [ -f /sys/fs/cgroup/memory.max ]; then
        CG_V2=$(cat /sys/fs/cgroup/memory.max 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V2" ] && [ "$CG_V2" != "max" ]; then
            TOTAL_MEM_BYTES=$CG_V2
        fi
    fi
    if [ "$TOTAL_MEM_BYTES" -eq 0 ] && [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        CG_V1=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V1" ] && [ "$CG_V1" -lt 9223372036854771712 ] 2>/dev/null; then
            TOTAL_MEM_BYTES=$CG_V1
        fi
    fi
    if [ "$TOTAL_MEM_BYTES" -eq 0 ] && [ -f /proc/meminfo ]; then
        MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        if [ -n "$MEM_KB" ]; then
            TOTAL_MEM_BYTES=$(( MEM_KB * 1024 ))
        fi
    fi

    # 自适应计算 Node.js V8 堆内存上限 (取物理可用总内存的 45%，其余预留给 cloudflared 与系统网络栈)
    if [ "$TOTAL_MEM_BYTES" -gt 0 ]; then
        HEAP_MB=$(( TOTAL_MEM_BYTES * 45 / 100 / 1024 / 1024 ))
        if [ "$HEAP_MB" -lt 32 ]; then
            HEAP_MB=32
        fi
        export NODE_OPTIONS="--max-old-space-size=${HEAP_MB} --expose-gc"
        echo "[OpenRC] ⚡ 动态硬件探测完成: 总内存=$(( TOTAL_MEM_BYTES / 1024 / 1024 ))MB | 自动分配堆上限=${HEAP_MB}MB (--expose-gc 已激活)" >> "${output_log}"
    fi
}

stop_post() {
    pkill -f "cloudflared tunnel" 2>/dev/null || true
}
EOF
    chmod +x /etc/init.d/vps-tunnel
    rc-update add vps-tunnel default 2>/dev/null || true
    rc-service vps-tunnel restart 2>/dev/null || /etc/init.d/vps-tunnel restart 2>/dev/null || true

else
    echo -e "${YELLOW}未检测到标准 init 系统，采用轻量级后台常驻模式拉起...${PLAIN}"
    pkill -f "node index.js" 2>/dev/null || true
    cd "${INSTALL_DIR}"
    nohup "${NODE_BIN}" index.js > /var/log/vps-tunnel.log 2>&1 &
fi

# 4. 自动放行防火墙端口 (若有防火墙管理器)
echo -e "${YELLOW}[4/5] 检查系统防火墙...${PLAIN}"
CURRENT_PORT=$(grep "^PORT=" "${INSTALL_DIR}/.env" 2>/dev/null | cut -d'=' -f2 || echo "19900")
CURRENT_PORT=${CURRENT_PORT:-19900}

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp || true
    ufw allow 443/tcp || true
    ufw allow "${CURRENT_PORT}"/tcp || true
    echo -e "${GREEN}✅ UFW 防火墙已放行 80 / 443 / ${CURRENT_PORT} 端口${PLAIN}"
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --zone=public --add-port=80/tcp --permanent || true
    firewall-cmd --zone=public --add-port=443/tcp --permanent || true
    firewall-cmd --zone=public --add-port="${CURRENT_PORT}"/tcp --permanent || true
    firewall-cmd --reload || true
    echo -e "${GREEN}✅ Firewalld 防火墙已放行 80 / 443 / ${CURRENT_PORT} 端口${PLAIN}"
fi

# 5. 校验运行状态
echo -e "${YELLOW}[5/5] 校验服务运行状态...${PLAIN}"
sleep 2

STATUS_OK=false
if [ "$IS_SYSTEMD" = "true" ]; then
    systemctl is-active --quiet vps-tunnel && STATUS_OK=true
else
    pgrep -f "node index.js" >/dev/null 2>&1 && STATUS_OK=true
fi

echo -e "${CYAN}========================================================${PLAIN}"
if [ "$STATUS_OK" = "true" ]; then
    echo -e "${GREEN}🎉 VPS-Tunnel 服务已成功部署并运行中！${PLAIN}"
else
    echo -e "${YELLOW}💡 服务已完成装配并已在后台拉起，请检查日志验证！${PLAIN}"
fi
echo -e "📁 工作目录: ${INSTALL_DIR}"
echo -e "⚙️ 配置文件: ${INSTALL_DIR}/.env"
echo -e "📜 日志文件: /var/log/vps-tunnel.log"
if [ "$IS_SYSTEMD" = "true" ]; then
    echo -e "📋 运行状态: systemctl status vps-tunnel"
    echo -e "🔄 重启服务: systemctl restart vps-tunnel"
else
    echo -e "📋 OpenRC 命令: rc-service vps-tunnel status"
    echo -e "🔄 重启服务: rc-service vps-tunnel restart"
fi
echo -e "${CYAN}========================================================${PLAIN}"
