#!/bin/sh
# ========================================================
# VPS-Backtrack: Linux NAT VPS 一键全能部署与端口回溯引擎
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
echo -e "${GREEN}🚀 VPS-Backtrack 纯原生 Node.js VLESS 端口回溯一键安装程序${PLAIN}"
echo -e "${CYAN}========================================================${PLAIN}"

# ========================================================
# 1. 权限与运行环境智能感知 (Root & Sudo Auto-Detector)
# ========================================================
SUDO=""
if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
        echo -e "${YELLOW}⚡ 检测到当前非 root 用户，系统具备 sudo，正在自动应用提权执行...${PLAIN}"
        SUDO="sudo"
        if [ -n "$0" ] && [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "bash" ]; then
            exec sudo sh "$0" "$@"
        fi
    else
        echo -e "${RED}[Error] 部署系统服务需要 root 特权，且当前系统未安装 sudo！${PLAIN}"
        echo -e "${YELLOW}请先运行 'su -' 切换至 root 用户后再执行此脚本。${PLAIN}"
        exit 1
    fi
fi

INSTALL_DIR="/opt/vps-backtrack"

# ========================================================
# 2. 虚拟 Swap 缓冲自动感知与挂载 (专为 128M / 256M NAT 小鸡打造)
# ========================================================
ensure_swap_buffer() {
    local DETECTED_MEM_KB=0
    if [ -f /sys/fs/cgroup/memory.max ]; then
        local CG_V2=$(cat /sys/fs/cgroup/memory.max 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V2" ] && [ "$CG_V2" != "max" ]; then
            DETECTED_MEM_KB=$(( CG_V2 / 1024 ))
        fi
    fi
    if [ "$DETECTED_MEM_KB" -eq 0 ] && [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        local CG_V1=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V1" ] && [ "$CG_V1" -lt 9223372036854771712 ] 2>/dev/null; then
            DETECTED_MEM_KB=$(( CG_V1 / 1024 ))
        fi
    fi
    if [ "$DETECTED_MEM_KB" -eq 0 ] && [ -f /proc/meminfo ]; then
        DETECTED_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' | tr -cd '0-9')
    fi
    case "$DETECTED_MEM_KB" in
        ''|*[!0-9]*) DETECTED_MEM_KB=0 ;;
    esac

    local SWAP_TOTAL_KB=0
    if [ -f /proc/meminfo ]; then
        SWAP_TOTAL_KB=$(grep SwapTotal /proc/meminfo 2>/dev/null | awk '{print $2}' | tr -cd '0-9' || echo 0)
    fi
    case "$SWAP_TOTAL_KB" in
        ''|*[!0-9]*) SWAP_TOTAL_KB=0 ;;
    esac

    if [ "$DETECTED_MEM_KB" -gt 0 ] && [ "$DETECTED_MEM_KB" -le 614400 ] && [ "$SWAP_TOTAL_KB" -le 10240 ]; then
        local SWAP_SIZE_MB=256
        if [ "$DETECTED_MEM_KB" -gt 307200 ]; then
            SWAP_SIZE_MB=512
        fi
        echo -e "${YELLOW}⚡ 检测到当前系统为入门小内存架构 (约 $(( DETECTED_MEM_KB / 1024 ))MB RAM) 且未配置 Swap 缓冲！${PLAIN}"

        local ZRAM_ACTIVATED=false
        if command -v modprobe >/dev/null 2>&1; then
            modprobe zram num_devices=1 2>/dev/null || true
        fi

        if [ -b /dev/zram0 ] || [ -d /sys/block/zram0 ]; then
            if grep -q "zram0" /proc/swaps 2>/dev/null; then
                echo -e "${GREEN}✅ 系统已原生挂载 ZRAM 内存压缩缓冲！${PLAIN}"
                ZRAM_ACTIVATED=true
            else
                echo -e "${CYAN}检测到系统内核支持 ZRAM 模块，正在配置 ${SWAP_SIZE_MB}MB 内存压缩块设备 (/dev/zram0)...${PLAIN}"
                if [ -f /sys/block/zram0/comp_algorithm ]; then
                    grep -q "lz4" /sys/block/zram0/comp_algorithm 2>/dev/null && echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true
                fi
                echo "${SWAP_SIZE_MB}M" > /sys/block/zram0/disksize 2>/dev/null || true
                if mkswap /dev/zram0 >/dev/null 2>&1; then
                    if swapon -p 32767 /dev/zram0 >/dev/null 2>&1; then
                        echo -e "${GREEN}✅ ZRAM 内存压缩极速缓冲挂载成功！(零磁盘开销，彻底杜绝小内存 OOM 崩溃)${PLAIN}"
                        ZRAM_ACTIVATED=true
                    fi
                fi
            fi
        fi

        if [ "$ZRAM_ACTIVATED" != "true" ]; then
            local SWAP_FILE="/swapfile"
            if [ ! -f "$SWAP_FILE" ]; then
                echo -e "${CYAN}正在创建 ${SWAP_SIZE_MB}MB 虚拟内存交换文件以保障稳定运行...${PLAIN}"
                if command -v fallocate >/dev/null 2>&1; then
                    fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE" 2>/dev/null || dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" 2>/dev/null
                else
                    dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" 2>/dev/null
                fi
                chmod 600 "$SWAP_FILE"
                mkswap "$SWAP_FILE" >/dev/null 2>&1
                swapon "$SWAP_FILE" >/dev/null 2>&1
                if ! grep -q "$SWAP_FILE" /etc/fstab 2>/dev/null; then
                    echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
                fi
                echo -e "${GREEN}✅ 磁盘 Swap 虚拟内存交换文件已成功激活挂载！${PLAIN}"
            fi
        fi
    fi
}
ensure_swap_buffer

# ========================================================
# 3. 安装依赖与 Node.js 运行时
# ========================================================
echo -e "${YELLOW}[1/4] 检查并安装系统核心依赖与 Node.js 运行时...${PLAIN}"

if command -v apk >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 Alpine Linux 环境...${PLAIN}"
    apk update
    apk add --no-cache nodejs npm curl openssl ca-certificates bash
elif command -v apt-get >/dev/null 2>&1; then
    echo -e "${CYAN}检测到 Debian/Ubuntu 环境...${PLAIN}"
    apt-get update -y
    apt-get install -y curl openssl ca-certificates bash
    if ! command -v node >/dev/null 2>&1; then
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

# ========================================================
# 4. 部署应用文件至 /opt/vps-backtrack
# ========================================================
echo -e "${YELLOW}[2/4] 部署应用文件至 ${INSTALL_DIR}...${PLAIN}"
mkdir -p "${INSTALL_DIR}/data"

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
RAW_URL="https://raw.githubusercontent.com/hc990275/nodejs/main/vps-backtrack"
GH_PROXY="https://ghfast.top/${RAW_URL}"

if [ -f "${SCRIPT_DIR}/index.js" ]; then
    echo -e "${CYAN}检测到本地源码，正在从当前目录部署...${PLAIN}"
    cp -f "${SCRIPT_DIR}/index.js" "${INSTALL_DIR}/"
    cp -f "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/start.sh" ] && cp -f "${SCRIPT_DIR}/start.sh" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/optimize_bbr.sh" ] && cp -f "${SCRIPT_DIR}/optimize_bbr.sh" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/.env.example" ] && cp -f "${SCRIPT_DIR}/.env.example" "${INSTALL_DIR}/.env.example"
    if [ ! -f "${INSTALL_DIR}/.env" ] && [ -f "${SCRIPT_DIR}/.env" ]; then
        cp -f "${SCRIPT_DIR}/.env" "${INSTALL_DIR}/"
    fi
else
    echo -e "${CYAN}检测到远程在线安装模式，正在高速下载项目文件...${PLAIN}"
    download_remote() {
        local fname="$1"
        local target="${INSTALL_DIR}/${fname}"
        if command -v curl >/dev/null 2>&1; then
            if ! curl -fsSL --connect-timeout 8 -m 30 "${RAW_URL}/${fname}" -o "${target}"; then
                curl -fsSL --connect-timeout 8 -m 30 "${GH_PROXY}/${fname}" -o "${target}"
            fi
        elif command -v wget >/dev/null 2>&1; then
            if ! wget -q -T 30 "${RAW_URL}/${fname}" -O "${target}"; then
                wget -q -T 30 "${GH_PROXY}/${fname}" -O "${target}"
            fi
        fi
    }
    download_remote "index.js"
    download_remote "package.json"
    download_remote "start.sh"
    download_remote "optimize_bbr.sh"
    download_remote ".env.example"
fi

# ========================================================
# 5. 交互式环境变量检测与配置向导 (检测现有值 -> 回车保持不变)
# ========================================================
ENV_FILE="${INSTALL_DIR}/.env"
[ -f "$ENV_FILE" ] || touch "$ENV_FILE"

# 读取已有配置键值
get_existing_env() {
    local key="$1"
    if [ -f "$ENV_FILE" ]; then
        grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '\r"'
    fi
}

PUBLIC_IP=$(curl -fsSL --connect-timeout 3 -m 5 https://api.ipify.org 2>/dev/null || curl -fsSL --connect-timeout 3 -m 5 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")

read_interactive() {
    local prompt="$1"
    local default_val="$2"
    local result=""
    if [ -n "$NON_INTERACTIVE" ] || [ -n "$CI" ]; then
        echo "${default_val}"
        return 0
    fi
    if [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
        printf "%b" "${prompt}" > /dev/tty
        if ! read -r result < /dev/tty; then
            result=""
        fi
    elif [ -t 0 ]; then
        printf "%b" "${prompt}"
        if ! read -r result; then
            result=""
        fi
    fi
    result=$(echo "${result}" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -z "${result}" ]; then
        result="${default_val}"
    fi
    echo "${result}"
}

echo -e "\n${CYAN}========================================================${PLAIN}"
echo -e "${GREEN}⚙️  服务参数交互配置向导 (检测到已有配置按回车直接沿用)${PLAIN}"
echo -e "${CYAN}========================================================${PLAIN}"

# 1. 服务监听端口 PORT
EX_PORT=$(get_existing_env "PORT")
DEFAULT_PORT="${EX_PORT:-${SET_PORT:-19900}}"
if [ -n "$EX_PORT" ]; then
    PORT_PROMPT="${YELLOW}👉 请输入服务监听端口 [当前已配置: ${BOLD}${EX_PORT}${PLAIN}${YELLOW}, 回车保持不变]: ${PLAIN}"
else
    PORT_PROMPT="${YELLOW}👉 请输入服务监听端口 (NAT 小鸡本地端口，默认: ${BOLD}${DEFAULT_PORT}${PLAIN}${YELLOW}): ${PLAIN}"
fi
RAW_PORT=$(read_interactive "$PORT_PROMPT" "$DEFAULT_PORT")
INPUT_PORT=$(echo "$RAW_PORT" | tr -cd '0-9')
[ -z "$INPUT_PORT" ] && INPUT_PORT="$DEFAULT_PORT"
echo -e "${GREEN}✅ 已确认服务监听端口: ${BOLD}${INPUT_PORT}${PLAIN}"

# 2. NAT 宿主机外部映射公网端口 PUBLIC_PORT
EX_PUB_PORT=$(get_existing_env "PUBLIC_PORT")
DEFAULT_PUB_PORT="${EX_PUB_PORT:-${SET_PUBLIC_PORT:-$INPUT_PORT}}"
if [ -n "$EX_PUB_PORT" ]; then
    PUB_PROMPT="${YELLOW}👉 请输入 NAT 外部映射公网端口 [当前已配置: ${BOLD}${EX_PUB_PORT}${PLAIN}${YELLOW}, 回车保持不变]: ${PLAIN}"
else
    PUB_PROMPT="${YELLOW}👉 请输入 NAT 外部映射公网端口 (若无映射直接回车同 ${INPUT_PORT}): ${PLAIN}"
fi
RAW_PUB_PORT=$(read_interactive "$PUB_PROMPT" "$DEFAULT_PUB_PORT")
INPUT_PUB_PORT=$(echo "$RAW_PUB_PORT" | tr -cd '0-9')
[ -z "$INPUT_PUB_PORT" ] && INPUT_PUB_PORT="$DEFAULT_PUB_PORT"
echo -e "${GREEN}✅ 已确认外部映射公网端口: ${BOLD}${INPUT_PUB_PORT}${PLAIN}"

# 3. Cloudflare CDN 回源域名 SUB_DOMAIN
EX_DOMAIN=$(get_existing_env "SUB_DOMAIN")
DEFAULT_DOMAIN="${EX_DOMAIN:-${SET_SUB_DOMAIN:-backtrack.example.com}}"
if [ -n "$EX_DOMAIN" ] && [ "$EX_DOMAIN" != "backtrack.example.com" ]; then
    DOMAIN_PROMPT="${YELLOW}👉 请输入 Cloudflare 接入域名 (小黄云回溯) [当前: ${BOLD}${EX_DOMAIN}${PLAIN}${YELLOW}, 回车保持不变]: ${PLAIN}"
else
    DOMAIN_PROMPT="${YELLOW}👉 请输入 Cloudflare 接入域名 (开启小黄云回溯，如 cf.abc.com): ${PLAIN}"
fi
RAW_DOMAIN=$(read_interactive "$DOMAIN_PROMPT" "$DEFAULT_DOMAIN")
INPUT_DOMAIN=$(echo "$RAW_DOMAIN" | tr -d ' ' | tr -d '\r')
[ -z "$INPUT_DOMAIN" ] && INPUT_DOMAIN="$DEFAULT_DOMAIN"
echo -e "${GREEN}✅ 已确认 CDN 回源域名: ${BOLD}${INPUT_DOMAIN}${PLAIN}"

# 4. Cloudflare Origin Rules 回溯端口 BACKTRACK_PORT
EX_BT_PORT=$(get_existing_env "BACKTRACK_PORT")
DEFAULT_BT_PORT="${EX_BT_PORT:-${SET_BACKTRACK_PORT:-$INPUT_PUB_PORT}}"
if [ -n "$EX_BT_PORT" ]; then
    BT_PROMPT="${YELLOW}👉 请输入 CF Origin Rules 回溯端口 [当前: ${BOLD}${EX_BT_PORT}${PLAIN}${YELLOW}, 回车保持不变]: ${PLAIN}"
else
    BT_PROMPT="${YELLOW}👉 请输入 CF Origin Rules 回溯目标端口 (默认对齐外部端口 ${INPUT_PUB_PORT}): ${PLAIN}"
fi
RAW_BT_PORT=$(read_interactive "$BT_PROMPT" "$DEFAULT_BT_PORT")
INPUT_BT_PORT=$(echo "$RAW_BT_PORT" | tr -cd '0-9')
[ -z "$INPUT_BT_PORT" ] && INPUT_BT_PORT="$DEFAULT_BT_PORT"
echo -e "${GREEN}✅ 已确认回溯目标端口: ${BOLD}${INPUT_BT_PORT}${PLAIN}"

# 5. 管理后台密码 ADMIN_PASSWORD
EX_PWD=$(get_existing_env "ADMIN_PASSWORD")
RANDOM_GEN_PWD=$(head -c 32 /dev/urandom 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 16 || echo "Admin$(date +%s)")
DEFAULT_PWD="${EX_PWD:-${SET_ADMIN_PASSWORD:-$RANDOM_GEN_PWD}}"
if [ -n "$EX_PWD" ]; then
    PWD_PROMPT="${YELLOW}👉 请输入管理后台密码 [当前已配置, 直接回车保持不变]: ${PLAIN}"
else
    PWD_PROMPT="${YELLOW}👉 请输入管理后台密码 [直接回车随机采用: ${BOLD}${DEFAULT_PWD}${PLAIN}${YELLOW}]: ${PLAIN}"
fi
RAW_PWD=$(read_interactive "$PWD_PROMPT" "$DEFAULT_PWD")
INPUT_PWD=$(echo "$RAW_PWD" | tr -d ' ' | tr -d '\r')
[ -z "$INPUT_PWD" ] && INPUT_PWD="$DEFAULT_PWD"
echo -e "${GREEN}✅ 已确认管理后台密码: ${BOLD}${INPUT_PWD}${PLAIN}"

# 6. NAT 宿主机公网 IP / DDNS 域名 SERVER_IP
EX_SERVER_IP=$(get_existing_env "SERVER_IP")
DEFAULT_SERVER_IP="${EX_SERVER_IP:-${SET_SERVER_IP:-$PUBLIC_IP}}"
if [ -n "$EX_SERVER_IP" ]; then
    SIP_PROMPT="${YELLOW}👉 请输入 NAT 母鸡公网 IP 或 DDNS [当前: ${BOLD}${EX_SERVER_IP}${PLAIN}${YELLOW}, 回车保持不变]: ${PLAIN}"
else
    SIP_PROMPT="${YELLOW}👉 请输入 NAT 母鸡公网 IP 或 DDNS [自动探测: ${BOLD}${DEFAULT_SERVER_IP}${PLAIN}${YELLOW}, 回车使用]: ${PLAIN}"
fi
RAW_SERVER_IP=$(read_interactive "$SIP_PROMPT" "$DEFAULT_SERVER_IP")
INPUT_SERVER_IP=$(echo "$RAW_SERVER_IP" | tr -d ' ' | tr -d '\r')
[ -z "$INPUT_SERVER_IP" ] && INPUT_SERVER_IP="$DEFAULT_SERVER_IP"
echo -e "${GREEN}✅ 已确认母鸡公网 IP / DDNS: ${BOLD}${INPUT_SERVER_IP}${PLAIN}"

# 安全写入 .env
update_env_kv() {
    local key="$1"
    local val="$2"
    local file="${INSTALL_DIR}/.env"
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

update_env_kv "PORT" "${INPUT_PORT}"
update_env_kv "SERVER_PORT" "${INPUT_PORT}"
update_env_kv "PUBLIC_PORT" "${INPUT_PUB_PORT}"
update_env_kv "SUB_DOMAIN" "${INPUT_DOMAIN}"
update_env_kv "BACKTRACK_PORT" "${INPUT_BT_PORT}"
update_env_kv "ADMIN_PASSWORD" "${INPUT_PWD}"
update_env_kv "SERVER_IP" "${INPUT_SERVER_IP}"
update_env_kv "DEFAULT_ALLOW_REGISTER" "true"
update_env_kv "DEFAULT_DAYS" "365"
update_env_kv "DEFAULT_TRAFFIC_GB" "100"

# 清理旧的 ARGO 参数 (如果有)
sed -i '/^ARGO_/d' "${INSTALL_DIR}/.env" 2>/dev/null || true

echo -e "${GREEN}✅ 环境变量配置完成并已原子写入: ${INSTALL_DIR}/.env${PLAIN}"

# ========================================================
# 6. 配置系统守护进程 (Systemd / OpenRC)
# ========================================================
echo -e "${YELLOW}[3/4] 配置开机自启系统守护进程...${PLAIN}"

if [ -d /run/systemd/system ] || command -v systemctl >/dev/null 2>&1; then
    SERVICE_FILE="/etc/systemd/system/vps-backtrack.service"
    cat << EOF > "$SERVICE_FILE"
[Unit]
Description=VPS-Backtrack Native Node.js Port-Backtrack VLESS Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v node) ${INSTALL_DIR}/index.js
Restart=always
RestartSec=3s
LimitNOFILE=65535
LimitNPROC=65535
Environment=NODE_ENV=production
Environment=UV_THREADPOOL_SIZE=16
Environment=MALLOC_ARENA_MAX=2

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable vps-backtrack.service >/dev/null 2>&1
    systemctl restart vps-backtrack.service
    echo -e "${GREEN}✅ Systemd 服务已成功拉起并配置开机自启！${PLAIN}"

elif [ -f /etc/init.d/cron ] || command -v rc-service >/dev/null 2>&1; then
    INIT_SCRIPT="/etc/init.d/vps-backtrack"
    cat << 'EOF' > "$INIT_SCRIPT"
#!/sbin/openrc-run
description="VPS-Backtrack Native Node.js Port-Backtrack VLESS Service"
directory="/opt/vps-backtrack"
command="/usr/bin/node"
command_args="/opt/vps-backtrack/index.js"
command_background="true"
pidfile="/run/vps-backtrack.pid"

depend() {
    need net
    after firewall
}
EOF
    chmod +x "$INIT_SCRIPT"
    rc-update add vps-backtrack default >/dev/null 2>&1 || true
    rc-service vps-backtrack restart || rc-service vps-backtrack start
    echo -e "${GREEN}✅ OpenRC 服务已成功启动并配置开机自启！${PLAIN}"
else
    # 兜底 nohup
    pkill -9 -f "node.*vps-backtrack/index.js" 2>/dev/null || true
    nohup node "${INSTALL_DIR}/index.js" > "${INSTALL_DIR}/vps-backtrack.log" 2>&1 &
    echo -e "${GREEN}✅ 已通过后台常驻进程拉起 VPS-Backtrack 服务！${PLAIN}"
fi

# ========================================================
# 7. 部署完成输出提示卡片
# ========================================================
echo -e "\n${CYAN}================================================================${PLAIN}"
echo -e "${GREEN}🎉 VPS-Backtrack 端口回溯网络中枢部署成功！${PLAIN}"
echo -e "${CYAN}================================================================${PLAIN}"
echo -e "🔹 ${BOLD}本地监听端口${PLAIN} : ${CYAN}${INPUT_PORT}${PLAIN}"
echo -e "🔹 ${BOLD}NAT 公网端口${PLAIN} : ${CYAN}${INPUT_PUB_PORT}${PLAIN}"
echo -e "🔹 ${BOLD}CDN 回源域名${PLAIN} : ${CYAN}${INPUT_DOMAIN}${PLAIN}"
echo -e "🔹 ${BOLD}管理后台地址${PLAIN} : ${GREEN}http://${INPUT_SERVER_IP}:${INPUT_PUB_PORT}/admin${PLAIN}"
echo -e "🔹 ${BOLD}管理访问密码${PLAIN} : ${YELLOW}${INPUT_PWD}${PLAIN}"
echo -e "${CYAN}----------------------------------------------------------------${PLAIN}"
echo -e "${BOLD}⚡ Cloudflare Origin Rules (源服务器规则) 端口回溯配置步骤:${PLAIN}"
echo -e " 1. 登录 Cloudflare 控制台，进入域名 ${INPUT_DOMAIN}；"
echo -e " 2. 点击左侧菜单: 【规则 (Rules)】 ➔ 【源服务器规则 (Origin Rules)】；"
echo -e " 3. 点击【创建规则】，规则名称填: ${CYAN}vps-backtrack${PLAIN}；"
echo -e " 4. 匹配字段选择: 【主机名 (Hostname)】 【等于】 ${CYAN}${INPUT_DOMAIN}${PLAIN}；"
echo -e " 5. 目标操作选择: 【重写到... (Rewrite to...)】 ➔ 【端口】 填: ${YELLOW}${INPUT_BT_PORT}${PLAIN}；"
echo -e " 6. 点击保存！随后三网优选 IP 与客户端 443 请求将全部自动回溯至您的 NAT 端口！"
echo -e "${CYAN}================================================================${PLAIN}\n"
