#!/bin/sh
# ========================================================
# VPS-Backtrack: 便捷管理与多功能运维控制台
# ========================================================

INSTALL_DIR="/opt/vps-backtrack"
if [ ! -d "${INSTALL_DIR}" ]; then
    INSTALL_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
fi
cd "${INSTALL_DIR}"
ENV_FILE="${INSTALL_DIR}/.env"

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
BOLD="\033[1m"
PLAIN="\033[0m"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

restart_service() {
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-backtrack.service"; then
        ${SUDO} systemctl restart vps-backtrack
    elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/vps-backtrack ]; then
        ${SUDO} rc-service vps-backtrack restart
    else
        ${SUDO} pkill -9 -f "node.*vps-backtrack/index.js" 2>/dev/null || true
        if [ -f "${ENV_FILE}" ]; then
            set -a
            . "${ENV_FILE}"
            set +a
        fi
        [ -z "${UV_THREADPOOL_SIZE}" ] && export UV_THREADPOOL_SIZE=16
        [ -z "${MALLOC_ARENA_MAX}" ] && export MALLOC_ARENA_MAX=2
        if [ -z "${NODE_OPTIONS}" ]; then
            export NODE_OPTIONS="--max-old-space-size=64 --expose-gc"
        fi
        nohup node index.js > /var/log/vps-backtrack.log 2>&1 &
    fi
}

show_info() {
    local port=$(grep "^PORT=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    port=${port:-19900}
    local pub_port=$(grep "^PUBLIC_PORT=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    pub_port=${pub_port:-$port}
    local domain=$(grep "^SUB_DOMAIN=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    domain=${domain:-127.0.0.1}
    local pwd=$(grep "^ADMIN_PASSWORD=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    local sip=$(grep "^SERVER_IP=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    sip=${sip:-$domain}

    local mem_used=$(free -m 2>/dev/null | awk '/Mem:/ {print $3}')
    local mem_tot=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}')
    local swap_used=$(free -m 2>/dev/null | awk '/Swap:/ {print $3}')
    local swap_tot=$(free -m 2>/dev/null | awk '/Swap:/ {print $2}')

    echo -e "\n${CYAN}================== 当前服务配置与访问地址 ==================${PLAIN}"
    echo -e "🌐 NAT直连主页:  ${BOLD}${GREEN}http://${sip}:${pub_port}/${PLAIN}"
    echo -e "🛠️  管理后台:    ${BOLD}${GREEN}http://${sip}:${pub_port}/admin${PLAIN}"
    echo -e "🔑 后台密码:    ${BOLD}${YELLOW}${pwd}${PLAIN}"
    echo -e "⚡ CDN回溯域名:  ${BOLD}${CYAN}https://${domain}/${PLAIN} (通过 CF Origin Rules 回溯至端口 ${pub_port})"
    local is_zram=""
    if grep -q "zram" /proc/swaps 2>/dev/null; then
        is_zram=" (⚡ ZRAM 内存压缩)"
    fi
    if [ -n "$mem_tot" ] && [ "$mem_tot" != "0" ]; then
        echo -e "💾 内存/Swap:    ${CYAN}内存 ${mem_used:-0}/${mem_tot}MB | Swap ${swap_used:-0}/${swap_tot:-0}MB${is_zram}${PLAIN}"
    fi
    echo -e "📜 日志文件:    /var/log/vps-backtrack.log (或 journalctl -u vps-backtrack -f)"
    echo -e "${CYAN}============================================================${PLAIN}\n"
}

case "$1" in
    start)
        restart_service
        echo -e "${GREEN}✅ VPS-Backtrack 已启动${PLAIN}"
        show_info
        ;;
    stop)
        if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-backtrack.service"; then
            ${SUDO} systemctl stop vps-backtrack
        elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/vps-backtrack ]; then
            ${SUDO} rc-service vps-backtrack stop
        else
            ${SUDO} pkill -9 -f "node.*vps-backtrack/index.js" 2>/dev/null || true
        fi
        echo -e "${YELLOW}🛑 VPS-Backtrack 已停止${PLAIN}"
        ;;
    restart)
        restart_service
        echo -e "${GREEN}🔄 VPS-Backtrack 已重启${PLAIN}"
        show_info
        ;;
    status)
        if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-backtrack.service"; then
            systemctl status vps-backtrack
        else
            if ps aux | grep -v grep | grep -q "vps-backtrack/index.js"; then
                echo -e "${GREEN}🟢 VPS-Backtrack 正在运行${PLAIN}"
            else
                echo -e "${RED}🔴 VPS-Backtrack 未运行${PLAIN}"
            fi
        fi
        show_info
        ;;
    info)
        show_info
        ;;
    log|logs)
        if command -v journalctl >/dev/null 2>&1; then
            journalctl -u vps-backtrack -n 50 -f
        elif [ -f /var/log/vps-backtrack.log ]; then
            tail -n 50 -f /var/log/vps-backtrack.log
        else
            echo -e "${YELLOW}未找到系统日志文件${PLAIN}"
        fi
        ;;
    *)
        echo -e "${CYAN}====================================================${PLAIN}"
        echo -e "${GREEN}🚀 VPS-Backtrack 端口回溯控制台使用方法:${PLAIN}"
        echo -e "  $0 start    - 启动服务"
        echo -e "  $0 stop     - 停止服务"
        echo -e "  $0 restart  - 重启服务"
        echo -e "  $0 status   - 查看运行状态"
        echo -e "  $0 info     - 查看配置信息与访问地址"
        echo -e "  $0 logs     - 查看实时运行日志"
        echo -e "${CYAN}====================================================${PLAIN}"
        show_info
        ;;
esac
