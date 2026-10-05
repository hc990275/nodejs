#!/bin/sh
# ========================================================
# VPS-Tunnel: 便捷启动与调试脚本
# ========================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
cd "${SCRIPT_DIR}"

SUDO=""
if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-tunnel.service"; then
    echo "发现已注册的 Systemd 服务，推荐通过系统服务管理："
    echo "  启动: ${SUDO} systemctl start vps-tunnel"
    echo "  重启: ${SUDO} systemctl restart vps-tunnel"
    echo "  日志: ${SUDO} journalctl -u vps-tunnel -f"
    echo ""
    printf "是否直接以 Systemd 方式重启并查看日志? (y/n): "
    read -r choice
    if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
        ${SUDO} systemctl restart vps-tunnel
        ${SUDO} journalctl -u vps-tunnel -f
        exit 0
    fi
elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/vps-tunnel ]; then
    echo "发现已注册的 OpenRC (Alpine) 服务，推荐通过系统服务管理："
    echo "  启动: ${SUDO} rc-service vps-tunnel start"
    echo "  重启: ${SUDO} rc-service vps-tunnel restart"
    echo "  日志: tail -f /var/log/vps-tunnel.log"
    echo ""
    printf "是否直接以 OpenRC 方式重启并查看日志? (y/n): "
    read -r choice
    if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
        ${SUDO} rc-service vps-tunnel restart
        tail -f /var/log/vps-tunnel.log
        exit 0
    fi
fi

export UV_THREADPOOL_SIZE=64
echo "正在以前台交互模式启动 (Ctrl+C 退出)..."
exec node index.js
