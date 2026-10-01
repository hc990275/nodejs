#!/bin/sh
# ==============================================================================
# 极速云专线 - 交互式配置向导 (自动生成 .env 并安装启动服务)
# 兼容: Ubuntu / Debian / Alpine / CentOS / Rocky Linux
# ==============================================================================

WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$WORK_DIR/.env"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo "${BOLD}${CYAN}=================================================${NC}"
echo "${BOLD}${CYAN}    极速云专线 - 交互式配置向导 v1.0${NC}"
echo "${BOLD}${CYAN}=================================================${NC}"
echo ""
echo "${YELLOW}提示：直接按 Enter 跳过选填项（对应协议将被禁用）${NC}"
echo "${YELLOW}配置将保存至: $ENV_FILE${NC}"
echo ""

# 输入函数: ask <变量名> <提示> <required/optional>
ask() {
    _VAR="$1"
    _PROMPT="$2"
    _REQ="$3"
    _DEFAULT="$4"
    while true; do
        if [ -n "$_DEFAULT" ]; then
            printf "${BOLD}${BLUE}> $_PROMPT${NC} [默认: $_DEFAULT]: "
        else
            printf "${BOLD}${BLUE}> $_PROMPT${NC}: "
        fi
        read -r _INPUT
        if [ -z "$_INPUT" ] && [ -n "$_DEFAULT" ]; then
            _INPUT="$_DEFAULT"
        fi
        if [ "$_REQ" = "required" ] && [ -z "$_INPUT" ]; then
            echo "${RED}  ✗ 此项不能为空，请重新输入${NC}"
            continue
        fi
        break
    done
    eval "${_VAR}=\"\$_INPUT\""
}

# ── 模式选择 ──────────────────────────────────────────────────────────────────
echo "${BOLD}请选择安装配置模式：${NC}"
echo "  ${GREEN}1) 极速秒装模式 (推荐: 仅确认主端口，全部协议端口一键跳过并在后台可视化修改)${NC} [默认]"
echo "  ${BLUE}2) 完整专家模式 (手动逐项输入 Hysteria 2 / TUIC / Reality 等每个独立端口)${NC}"
printf "${BOLD}${BLUE}> 请输入选项 [1/2, 默认回车进入 1]: ${NC}"
read -r CFG_MODE

if [ "$CFG_MODE" != "2" ] && [ "$1" != "--full" ]; then
    echo ""
    echo "${GREEN}⚡ 已激活【极速秒装模式】！${NC}"
    echo "${YELLOW}💡 提示：所有协议端口已跳过，后续可在 Web 管理后台 [/admin] 可视化修改与热重载。${NC}"
    echo ""
    ask CFG_SERVER_PORT "主监听端口 SERVER_PORT (翼龙面板填分配端口，普通VPS填 19900 或 8080)" optional "19900"
    ask CFG_ADMIN_TOKEN "管理员密码 ADMIN_TOKEN (留空=系统自动生成随机高强度密码)" optional ""
    CFG_SERVER_IP=""
    CFG_PORT_HY2="18800"
    CFG_HY2_HOP="18806-18817"
    CFG_PORT_TUIC="18801"
    CFG_PORT_REALITY="18802"
    CFG_PORT_VLESS_TCP="18803"
    CFG_PORT_TROJAN_TCP="18804"
    CFG_PORT_SS="18805"
    CFG_PORT_SOCKS5=""
    CFG_ARGO_TOKEN=""
    CFG_ARGO_DOMAIN=""
    echo ""
else
    # ── 第 1 组：基础网络 ──────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 1 组：服务器基础配置 ===${NC}"
    ask CFG_SERVER_PORT "主监听端口 (翼龙面板填分配端口，普通VPS可填 8080)" required ""
    ask CFG_SERVER_IP   "服务器公网 IPv4 (留空=系统自动探测)" optional ""
    echo ""

    # ── 第 2 组：管理员认证 ────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 2 组：管理员密码 ===${NC}"
    echo "${YELLOW}  用于登录 /admin 后台，建议 8 位以上${NC}"
    ask CFG_ADMIN_TOKEN "管理员密码 ADMIN_TOKEN (留空=系统随机生成)" optional ""
    echo ""

    # ── 第 3 组：Hysteria 2 ────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 3 组：Hysteria 2 协议 (UDP/QUIC 极速抗丢包) ===${NC}"
    ask CFG_PORT_HY2  "Hysteria 2 端口 (例: 10800，留空=禁用)" optional ""
    if [ -n "$CFG_PORT_HY2" ]; then
        ask CFG_HY2_HOP "端口跳跃范围 (例: 10900-10909，留空=不启用)" optional ""
    else
        CFG_HY2_HOP=""
    fi
    echo ""

    # ── 第 4 组：TUIC v5 ──────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 4 组：TUIC v5 协议 (0-RTT 极低延迟) ===${NC}"
    ask CFG_PORT_TUIC "TUIC v5 端口 (例: 10801，留空=禁用)" optional ""
    echo ""

    # ── 第 5 组：VLESS Reality ────────────────────────────────────────────────────
    echo "${BOLD}=== 第 5 组：VLESS Reality 协议 (0 特征 TLS) ===${NC}"
    ask CFG_PORT_REALITY "VLESS Reality 端口 (例: 10802，留空=禁用)" optional ""
    echo ""

    # ── 第 6 组：TCP 直连 ─────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 6 组：TCP 原生直连协议 ===${NC}"
    ask CFG_PORT_VLESS_TCP  "VLESS TCP 端口 (例: 10803，留空=禁用)" optional ""
    ask CFG_PORT_TROJAN_TCP "Trojan TCP 端口 (例: 10804，留空=禁用)" optional ""
    echo ""

    # ── 第 7 组：SS2022 ──────────────────────────────────────────────────────────
    echo "${BOLD}=== 第 7 组：Shadowsocks 2022 (AEAD 多用户专属密钥模式) ===${NC}"
    ask CFG_PORT_SS     "SS2022 端口 (例: 10805，留空=禁用)" optional ""
    echo ""

    # ── 第 8 组：Argo 隧道 ───────────────────────────────────────────────────────
    echo "${BOLD}=== 第 8 组：Cloudflare Argo 隧道 (无公网IP可用此项) ===${NC}"
    ask CFG_ARGO_TOKEN "Argo Token (留空=不使用)" optional ""
    if [ -n "$CFG_ARGO_TOKEN" ]; then
        ask CFG_ARGO_DOMAIN "Argo 绑定域名 (例: tunnel.example.com)" required ""
    else
        CFG_ARGO_DOMAIN=""
    fi
    echo ""
fi

# ── 生成 .env ─────────────────────────────────────────────────────────────────
echo "${GREEN}=== 正在生成 .env 配置文件... ===${NC}"

_HY2_ENABLE="false"
[ -n "$CFG_PORT_HY2" ] && _HY2_ENABLE="true"
_HY2_HOP_ENABLE="false"
[ -n "$CFG_HY2_HOP" ] && _HY2_HOP_ENABLE="true"
_TUIC_ENABLE="false"
[ -n "$CFG_PORT_TUIC" ] && _TUIC_ENABLE="true"
_REALITY_ENABLE="false"
[ -n "$CFG_PORT_REALITY" ] && _REALITY_ENABLE="true"
_VLESS_TCP_ENABLE="false"
[ -n "$CFG_PORT_VLESS_TCP" ] && _VLESS_TCP_ENABLE="true"
_TROJAN_ENABLE="false"
[ -n "$CFG_PORT_TROJAN_TCP" ] && _TROJAN_ENABLE="true"
_SS_ENABLE="false"
[ -n "$CFG_PORT_SS" ] && _SS_ENABLE="true"

cat > "$ENV_FILE" << __ENVEOF__
# 由交互向导自动生成 - $(date)

# ── 第 1 组：服务器网络基础 ──
SERVER_PORT=${CFG_SERVER_PORT}
PORT=${CFG_SERVER_PORT}
SERVER_IP=${CFG_SERVER_IP}

# ── 第 2 组：管理员认证 ──
ADMIN_TOKEN=${CFG_ADMIN_TOKEN}
ADMIN_PASSWORD=${CFG_ADMIN_TOKEN}

# ── 第 3 组：Hysteria 2 ──
PORT_HY2=${CFG_PORT_HY2}
ENABLE_HY2=${_HY2_ENABLE}
ENABLE_HY2_HOP=${_HY2_HOP_ENABLE}
HY2_HOP_PORTS=${CFG_HY2_HOP}
HY2_HOP_INTERVAL=30s

# ── 第 4 组：TUIC v5 ──
PORT_TUIC=${CFG_PORT_TUIC}
ENABLE_TUIC=${_TUIC_ENABLE}

# ── 第 5 组：VLESS Reality ──
PORT_REALITY=${CFG_PORT_REALITY}
ENABLE_REALITY=${_REALITY_ENABLE}
REALITY_DEST=www.apple.com
REALITY_PORT=443

# ── 第 6 组：TCP 直连 ──
PORT_VLESS_TCP=${CFG_PORT_VLESS_TCP}
ENABLE_VLESS_TCP=${_VLESS_TCP_ENABLE}
PORT_TROJAN_TCP=${CFG_PORT_TROJAN_TCP}
ENABLE_TROJAN_TCP=${_TROJAN_ENABLE}

# ── 第 7 组：SS2022 (AEAD 多用户专属模式) ──
PORT_SS=${CFG_PORT_SS}
ENABLE_SS=${_SS_ENABLE}
SS_METHOD=2022-blake3-aes-128-gcm

# ── 第 8 组：Argo 隧道 ──
ARGO_TOKEN=${CFG_ARGO_TOKEN}
ARGO_DOMAIN=${CFG_ARGO_DOMAIN}
OPTIMIZED_DOMAIN=

# ── 第 9 组：系统自适应与运营默认配额 ──
LINUX_AUTO_INSTALL=true
DEFAULT_ALLOW_REGISTER=false
DEFAULT_DAYS=365
DEFAULT_TRAFFIC_VAL=10
DEFAULT_TRAFFIC_UNIT=TB
TG_ADMIN_ID=5153827615
TG_REQUIRED_GROUP=@s5gydl
TG_API_BASE=https://api.telegram.org
SUB_DOMAIN=db.995677.xyz
__ENVEOF__

# 同步初始化系统级持久化数据目录，确保即便仓库重置也能秒级恢复用户库
mkdir -p /etc/v3-airport/data /var/lib/v3-airport/data /root/.v3_airport_data 2>/dev/null || true
if [ -f "$WORK_DIR/data/v3_users.json" ]; then
    cp -n "$WORK_DIR/data/v3_users.json" /etc/v3-airport/data/ 2>/dev/null || true
fi

echo "${GREEN}  ✓ .env 已写入并激活系统级防丢持久化${NC}"
echo ""

# ── 配置汇总 ──────────────────────────────────────────────────────────────────
echo "${BOLD}${CYAN}=================================================${NC}"
echo "${BOLD}${CYAN}              配置汇总确认${NC}"
echo "${BOLD}${CYAN}=================================================${NC}"
echo "  主端口:         ${BOLD}${CFG_SERVER_PORT}${NC}"
echo "  公网IP:         ${BOLD}${CFG_SERVER_IP:-（自动探测）}${NC}"
echo "  管理密码:       ${BOLD}${CFG_ADMIN_TOKEN:-（系统随机生成）}${NC}"
echo "  Hysteria 2:    ${BOLD}${CFG_PORT_HY2:-（禁用）}${NC}"
echo "  端口跳跃:       ${BOLD}${CFG_HY2_HOP:-（未启用）}${NC}"
echo "  TUIC v5:       ${BOLD}${CFG_PORT_TUIC:-（禁用）}${NC}"
echo "  VLESS Reality: ${BOLD}${CFG_PORT_REALITY:-（禁用）}${NC}"
echo "  VLESS TCP:     ${BOLD}${CFG_PORT_VLESS_TCP:-（禁用）}${NC}"
echo "  Trojan TCP:    ${BOLD}${CFG_PORT_TROJAN_TCP:-（禁用）}${NC}"
echo "  SS2022:        ${BOLD}${CFG_PORT_SS:-（禁用）}${NC}"
echo "  Argo:          ${BOLD}${CFG_ARGO_TOKEN:+已配置（$CFG_ARGO_DOMAIN）}${CFG_ARGO_TOKEN:-（未启用）}${NC}"
echo ""
printf "${BOLD}${YELLOW}确认配置并安装启动服务？[Y/n]: ${NC}"
read -r CONFIRM
CONFIRM="${CONFIRM:-Y}"
if [ "$CONFIRM" = "n" ] || [ "$CONFIRM" = "N" ]; then
    echo "${YELLOW}已取消。可手动编辑 $ENV_FILE 后再运行 ./install_service.sh${NC}"
    exit 0
fi

echo ""
echo "${BOLD}${GREEN}=== [256MB轻量小鸡极速网络调优与ZRAM内存压缩] 正在注入内核调优与内存保护... ===${NC}"
if [ "$(id -u)" = "0" ]; then
    # 1. 宿主机内核轻量网络调优持久化 (针对 256MB RAM 精确配比，避免大缓存溢出)
    mkdir -p /etc/sysctl.d 2>/dev/null || true
    cat << 'EOF' > /etc/sysctl.d/99-v3-adaptive.conf
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 8388608
net.core.wmem_max = 8388608
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 20000
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_base_mss = 1024
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.ip_local_port_range = 1024 65535
net.core.somaxconn = 8192
net.ipv4.tcp_max_syn_backlog = 8192
fs.file-max = 200000
vm.swappiness = 100
vm.vfs_cache_pressure = 50
EOF
    sysctl --system >/dev/null 2>&1 || sysctl -p /etc/sysctl.d/99-v3-adaptive.conf >/dev/null 2>&1 || true
    echo "${GREEN}  ✓ 已持久化激活 TCP BBR、8MB轻量缓冲、TCP Fast Open(0-RTT)与MTU黑洞探测${NC}"

    # 2. 系统文件描述符与锁内存提升
    if [ -f /etc/security/limits.conf ]; then
        cat << 'EOF' >> /etc/security/limits.conf
* soft nofile 65535
* hard nofile 65535
* soft memlock unlimited
* hard memlock unlimited
EOF
    fi
    ulimit -n 65535 2>/dev/null || true
    echo "${GREEN}  ✓ 已优化进程句柄与内存锁定限制 (nofile=65535)${NC}"

    # 3. 网卡硬件级 UDP GRO 卸载 (大幅降低单核 CPU 软中断开销)
    DEF_NIC=$(ip route show default 2>/dev/null | awk '{print $5}' | head -n1)
    if [ -n "$DEF_NIC" ]; then
        (command -v ethtool >/dev/null 2>&1 || (apt-get update -y && apt-get install -y ethtool || apk add --no-cache ethtool)) >/dev/null 2>&1 || true
        if command -v ethtool >/dev/null 2>&1; then
            ethtool -K "$DEF_NIC" rx-udp-gro-forwarding on rx-gro-list off >/dev/null 2>&1 || true
            echo "${GREEN}  ✓ 网卡 [$DEF_NIC] 已激活 UDP GRO 硬件级报文卸载${NC}"
        fi
    fi

    # 4. ZRAM 内存压缩防卡死机制 (针对 256MB RAM 挂载 256MB-384MB 极速虚拟内存，杜绝 OOM)
    if ! grep -q "zram" /proc/swaps 2>/dev/null; then
        # 4.1 Debian / Ubuntu 体系
        if command -v apt-get >/dev/null 2>&1; then
            (apt-get update -y >/dev/null 2>&1 && apt-get install -y zram-tools >/dev/null 2>&1 && sed -i 's/^#*PERCENT=.*/PERCENT=100/' /etc/default/zramswap && systemctl restart zramswap >/dev/null 2>&1) || true
            if grep -q "zram" /proc/swaps 2>/dev/null; then
                echo "${GREEN}  ✓ 已激活 ZRAM 内存压缩防卡死机制 (zram-tools 100% 物理内存扩展)${NC}"
            fi
        # 4.2 Alpine Linux 体系
        elif command -v apk >/dev/null 2>&1; then
            (apk add --no-cache zram-init >/dev/null 2>&1 && rc-update add zram-init default >/dev/null 2>&1 && rc-service zram-init start >/dev/null 2>&1) || true
            if grep -q "zram" /proc/swaps 2>/dev/null; then
                echo "${GREEN}  ✓ 已激活 Alpine ZRAM 内存压缩防卡死服务${NC}"
            fi
        fi

        # 4.3 若以上包管理器未生效，采用 Linux 原生 modprobe zram 脚本兜底挂载 256M
        if ! grep -q "zram" /proc/swaps 2>/dev/null; then
            modprobe zram num_devices=1 2>/dev/null || true
            if [ -b /dev/zram0 ]; then
                echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || echo zstd > /sys/block/zram0/comp_algorithm 2>/dev/null || true
                echo 256M > /sys/block/zram0/disksize 2>/dev/null || true
                mkswap /dev/zram0 >/dev/null 2>&1 || true
                swapon -p 100 /dev/zram0 >/dev/null 2>&1 || true
                if grep -q "zram" /proc/swaps 2>/dev/null; then
                    echo "${GREEN}  ✓ 已通过内核模块挂载 256MB 原生 ZRAM 压缩内存${NC}"
                fi
            fi
        fi
    else
        echo "${GREEN}  ✓ 检测到系统已激活 ZRAM 压缩内存，保持活跃${NC}"
    fi
fi

echo ""
echo "${BOLD}${GREEN}=== 正在安装并启动服务... ===${NC}"
chmod +x "$WORK_DIR/install_service.sh"
"$WORK_DIR/install_service.sh"
