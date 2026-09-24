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
    CFG_PORT_HY2=""
    CFG_HY2_HOP=""
    CFG_PORT_TUIC=""
    CFG_PORT_REALITY=""
    CFG_PORT_VLESS_TCP=""
    CFG_PORT_TROJAN_TCP=""
    CFG_PORT_SS=""
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

    # ── 第 7 组：SS2022 / Socks5 ─────────────────────────────────────────────────
    echo "${BOLD}=== 第 7 组：Shadowsocks 2022 / Socks5 ===${NC}"
    ask CFG_PORT_SS     "SS2022 端口 (例: 10805，留空=禁用)" optional ""
    ask CFG_PORT_SOCKS5 "Socks5 端口 (例: 10806，留空=禁用)" optional ""
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
_SOCKS5_ENABLE="false"
[ -n "$CFG_PORT_SOCKS5" ] && _SOCKS5_ENABLE="true"

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
REALITY_DEST=addons.mozilla.org
REALITY_PORT=443

# ── 第 6 组：TCP 直连 ──
PORT_VLESS_TCP=${CFG_PORT_VLESS_TCP}
ENABLE_VLESS_TCP=${_VLESS_TCP_ENABLE}
PORT_TROJAN_TCP=${CFG_PORT_TROJAN_TCP}
ENABLE_TROJAN_TCP=${_TROJAN_ENABLE}

# ── 第 7 组：SS2022 / Socks5 ──
PORT_SS=${CFG_PORT_SS}
ENABLE_SS=${_SS_ENABLE}
SS_METHOD=2022-blake3-aes-128-gcm
PORT_SOCKS5=${CFG_PORT_SOCKS5}
ENABLE_SOCKS5=${_SOCKS5_ENABLE}

# ── 第 8 组：Argo 隧道 ──
ARGO_TOKEN=${CFG_ARGO_TOKEN}
ARGO_DOMAIN=${CFG_ARGO_DOMAIN}
OPTIMIZED_DOMAIN=

# ── 第 9 组：系统自适应 ──
LINUX_AUTO_INSTALL=true
__ENVEOF__

echo "${GREEN}  ✓ .env 已写入${NC}"
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
echo "  Socks5:        ${BOLD}${CFG_PORT_SOCKS5:-（禁用）}${NC}"
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
echo "${BOLD}${GREEN}=== 正在安装并启动服务... ===${NC}"
chmod +x "$WORK_DIR/install_service.sh"
"$WORK_DIR/install_service.sh"
