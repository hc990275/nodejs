#!/usr/bin/env bash
# ========================================================
# VPS-Tunnel: 便捷启动与调试脚本
# ========================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "vps-tunnel.service"; then
    echo "发现已注册的 Systemd 服务，推荐通过系统服务管理："
    echo "  启动: sudo systemctl start vps-tunnel"
    echo "  重启: sudo systemctl restart vps-tunnel"
    echo "  日志: sudo journalctl -u vps-tunnel -f"
    echo ""
    read -p "是否直接以 Systemd 方式重启并查看日志? (y/n): " choice
    if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
        sudo systemctl restart vps-tunnel
        sudo journalctl -u vps-tunnel -f
        exit 0
    fi
elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/vps-tunnel ]; then
    echo "发现已注册的 OpenRC (Alpine) 服务，推荐通过系统服务管理："
    echo "  启动: sudo rc-service vps-tunnel start"
    echo "  重启: sudo rc-service vps-tunnel restart"
    echo "  日志: tail -f /var/log/vps-tunnel.log"
    echo ""
    read -p "是否直接以 OpenRC 方式重启并查看日志? (y/n): " choice
    if [ "$choice" = "y" ] || [ "$choice" = "Y" ]; then
        sudo rc-service vps-tunnel restart
        tail -f /var/log/vps-tunnel.log
        exit 0
    fi
fi

export UV_THREADPOOL_SIZE=64
echo "正在以前台交互模式启动 (Ctrl+C 退出)..."
exec node index.js
