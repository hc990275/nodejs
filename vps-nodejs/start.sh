#!/bin/sh
# ========================================================
# VPS-Tunnel: 便捷管理与多功能运维控制台
# ========================================================

INSTALL_DIR="/opt/vps-tunnel"
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
    # 彻底清理残留的孤儿 node 和 cloudflared 实例，杜绝端口冲突与 100% CPU 死循环
    ${SUDO} pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-tunnel.service"; then
        ${SUDO} systemctl restart vps-tunnel
    elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/vps-tunnel ]; then
        ${SUDO} rc-service vps-tunnel restart
    else
        ${SUDO} pkill -9 -f "node index.js" 2>/dev/null || true
        if [ -f "${ENV_FILE}" ]; then
            set -a
            . "${ENV_FILE}"
            set +a
        fi
        [ -z "${UV_THREADPOOL_SIZE}" ] && export UV_THREADPOOL_SIZE=16
        [ -z "${MALLOC_ARENA_MAX}" ] && export MALLOC_ARENA_MAX=2
        [ -z "${GOGC}" ] && export GOGC=50
        if [ -z "${NODE_OPTIONS}" ]; then
            # 针对 64M / 128M / 256M NAT 鸡自适应注入
            MEM_TOTAL_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
            HEAP_LIMIT=96
            GO_LIMIT="40MiB"
            POOL_SIZE=16
            EXTRA_FLAGS=""
            if [ "$MEM_TOTAL_KB" -gt 0 ] && [ "$MEM_TOTAL_KB" -le 81920 ]; then
                HEAP_LIMIT=32
                GO_LIMIT="16MiB"
                POOL_SIZE=8
                EXTRA_FLAGS="--max-semi-space-size=4"
            elif [ "$MEM_TOTAL_KB" -gt 0 ] && [ "$MEM_TOTAL_KB" -le 163840 ]; then
                HEAP_LIMIT=64
                GO_LIMIT="25MiB"
                POOL_SIZE=16
            elif [ "$MEM_TOTAL_KB" -gt 0 ] && [ "$MEM_TOTAL_KB" -le 307200 ]; then
                HEAP_LIMIT=128
                GO_LIMIT="35MiB"
                POOL_SIZE=16
            fi
            export UV_THREADPOOL_SIZE="${POOL_SIZE}"
            export GOMEMLIMIT="${GO_LIMIT}"
            export NODE_OPTIONS="--max-old-space-size=${HEAP_LIMIT} --expose-gc ${EXTRA_FLAGS}"
        fi
        nohup node index.js > /var/log/vps-tunnel.log 2>&1 &
    fi
}

show_info() {
    local port=$(grep "^PORT=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    port=${port:-19900}
    local domain=$(grep "^SUB_DOMAIN=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    domain=${domain:-127.0.0.1}
    local pwd=$(grep "^ADMIN_PASSWORD=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)
    local argo_d=$(grep "^ARGO_DOMAIN=" "${ENV_FILE}" 2>/dev/null | cut -d'=' -f2)

    local mem_used=$(free -m 2>/dev/null | awk '/Mem:/ {print $3}')
    local mem_tot=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}')
    local swap_used=$(free -m 2>/dev/null | awk '/Swap:/ {print $3}')
    local swap_tot=$(free -m 2>/dev/null | awk '/Swap:/ {print $2}')

    echo -e "\n${CYAN}================== 当前服务配置与访问地址 ==================${PLAIN}"
    echo -e "🌐 直连主页:   ${BOLD}${GREEN}http://${domain}:${port}/${PLAIN}"
    echo -e "🛠️  管理后台:   ${BOLD}${GREEN}http://${domain}:${port}/admin${PLAIN}"
    echo -e "🔑 后台密码:   ${BOLD}${YELLOW}${pwd}${PLAIN}"
    if [ -n "$argo_d" ]; then
        echo -e "⚡ Argo域名:   ${BOLD}${CYAN}https://${argo_d}/${PLAIN}"
    fi
    local is_zram=""
    if grep -q "zram" /proc/swaps 2>/dev/null; then
        is_zram=" (⚡ ZRAM 内存压缩)"
    fi
    if [ -n "$mem_tot" ] && [ "$mem_tot" != "0" ]; then
        echo -e "💾 内存/Swap:   ${CYAN}内存 ${mem_used:-0}/${mem_tot}MB | Swap ${swap_used:-0}/${swap_tot:-0}MB${is_zram}${PLAIN}"
    fi
    echo -e "📜 日志文件:   /var/log/vps-tunnel.log"
    echo -e "${CYAN}============================================================${PLAIN}\n"
}

# 安全原子更新 .env 键值 (支持任何含斜杠、特殊符号的密码与 Token)
update_env_kv() {
    local key="$1"
    local val="$2"
    local file="${ENV_FILE}"
    node -e '
        const fs = require("fs");
        const file = process.argv[1];
        const key = process.argv[2];
        const val = process.argv[3];
        let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        const lines = content.split(/\r?\n/);
        let found = false;
        const newLines = lines.map(line => {
            const trimmed = line.trim();
            if (trimmed.startsWith(key + "=") || trimmed.startsWith("# " + key + "=")) {
                found = true;
                return `${key}=${val}`;
            }
            return line;
        });
        if (!found) {
            newLines.push(`${key}=${val}`);
        }
        fs.writeFileSync(file, newLines.join("\n").replace(/\n+$/, "") + "\n", "utf8");
    ' "$file" "$key" "$val" 2>/dev/null || {
        sed -i "s|^${key}=.*|${key}=${val}|" "$file" 2>/dev/null || echo -e "\n${key}=${val}" >> "$file"
    }
}

change_port() {
    local new_port="$1"
    if [ -z "$new_port" ]; then
        printf "${YELLOW}请输入新的服务监听端口 (1-65535): ${PLAIN}"
        read -r new_port
    fi
    if [ -n "$new_port" ]; then
        update_env_kv "PORT" "${new_port}"
        update_env_kv "SERVER_PORT" "${new_port}"
        echo -e "${GREEN}✅ 端口已变更为 ${new_port}，正在重启服务...${PLAIN}"
        restart_service
        sleep 1
        show_info
    fi
}

change_password() {
    printf "${YELLOW}请输入新的后台管理密码: ${PLAIN}"
    read -r new_pwd
    if [ -n "$new_pwd" ]; then
        update_env_kv "ADMIN_PASSWORD" "${new_pwd}"
        echo -e "${GREEN}✅ 后台密码已更新，正在重启服务...${PLAIN}"
        restart_service
        sleep 1
        show_info
    fi
}

change_domain() {
    local auto_ip=$(curl -fsSL --connect-timeout 3 -m 5 https://api.ipify.org 2>/dev/null || curl -fsSL --connect-timeout 3 -m 5 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")
    printf "${YELLOW}请输入节点绑定的公网 IP 或域名 [检测到公网IP: ${auto_ip}]: ${PLAIN}"
    read -r new_dom
    new_dom=${new_dom:-$auto_ip}
    if [ -n "$new_dom" ]; then
        update_env_kv "SUB_DOMAIN" "${new_dom}"
        echo -e "${GREEN}✅ 绑定地址已更新为 ${new_dom}，正在重启服务...${PLAIN}"
        restart_service
        sleep 1
        show_info
    fi
}

# 命令行快捷参数支持
case "$1" in
    port)
        change_port "$2"
        exit 0
        ;;
    restart)
        echo -e "${YELLOW}正在重启服务...${PLAIN}"
        restart_service
        echo -e "${GREEN}✅ 重启指令已完成！${PLAIN}"
        exit 0
        ;;
    status)
        show_info
        exit 0
        ;;
    log)
        if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-tunnel.service"; then
            ${SUDO} journalctl -u vps-tunnel -f
        else
            tail -f /var/log/vps-tunnel.log
        fi
        exit 0
        ;;
esac

# 交互式管理菜单
while true; do
    echo -e "${CYAN}========================================================${PLAIN}"
    echo -e "${GREEN}🚀 VPS-Tunnel 快捷运维管理菜单${PLAIN}"
    echo -e "${CYAN}========================================================${PLAIN}"
    echo -e " 1. 查看当前服务状态与访问链接"
    echo -e " 2. 修改服务运行端口 (Port)"
    echo -e " 3. 修改后台管理密码"
    echo -e " 4. 重新检测并绑定公网 IP / 域名"
    echo -e " 5. 重启服务并查看实时日志"
    echo -e " 6. 直接重启服务"
    echo -e " 0. 退出菜单"
    echo -e "${CYAN}========================================================${PLAIN}"
    printf "${YELLOW}请选择操作 [0-6]: ${PLAIN}"
    read -r choice
    case "$choice" in
        1)
            show_info
            ;;
        2)
            change_port
            ;;
        3)
            change_password
            ;;
        4)
            change_domain
            ;;
        5)
            restart_service
            if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "vps-tunnel.service"; then
                ${SUDO} journalctl -u vps-tunnel -f
            else
                tail -f /var/log/vps-tunnel.log
            fi
            ;;
        6)
            restart_service
            echo -e "${GREEN}✅ 服务已完成重启！${PLAIN}"
            ;;
        0|q|exit)
            exit 0
            ;;
        *)
            echo -e "${RED}输入有误，请重新选择！${PLAIN}"
            ;;
    esac
    echo ""
done
