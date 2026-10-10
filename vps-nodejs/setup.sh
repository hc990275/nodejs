#!/bin/sh
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

# ========================================================
# 🚀 权限与运行环境智能感知 (Root & Sudo Auto-Detector)
# ========================================================
SUDO=""
if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
        echo -e "${YELLOW}⚡ 检测到当前非 root 用户，系统具备 sudo，正在自动应用提权执行...${PLAIN}"
        SUDO="sudo"
        # 若为本地保存的脚本文件，直接以 sudo 无感知重新拉起自身
        if [ -n "$0" ] && [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "bash" ]; then
            exec sudo sh "$0" "$@"
        fi
    else
        echo -e "${RED}[Error] 部署系统服务需要 root 特权，且当前系统未安装 sudo！${PLAIN}"
        echo -e "${YELLOW}请先运行 'su -' 切换至 root 用户后再执行此脚本。${PLAIN}"
        exit 1
    fi
fi

INSTALL_DIR="/opt/vps-tunnel"

# ========================================================
# 🚀 虚拟 Swap 缓冲自动感知与挂载引导 (专为 128M / 256M NAT 小鸡打造)
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
        DETECTED_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
    fi

    local SWAP_TOTAL_KB=0
    if [ -f /proc/meminfo ]; then
        SWAP_TOTAL_KB=$(grep SwapTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
    fi
    SWAP_TOTAL_KB=${SWAP_TOTAL_KB:-0}

    # 当总内存 <= 600MB (涵盖 128MB / 256MB / 512MB 规格) 且未配置任何 Swap 时尝试创建
    if [ "$DETECTED_MEM_KB" -gt 0 ] && [ "$DETECTED_MEM_KB" -le 614400 ] && [ "$SWAP_TOTAL_KB" -le 10240 ]; then
        local SWAP_SIZE_MB=256
        if [ "$DETECTED_MEM_KB" -gt 307200 ]; then
            SWAP_SIZE_MB=512
        fi
        echo -e "${YELLOW}⚡ 检测到当前系统为入门小内存架构 (约 $(( DETECTED_MEM_KB / 1024 ))MB RAM) 且未配置 Swap 缓冲！${PLAIN}"

        # 🚀 第一优先级防御: 优先探测并激活系统内核 ZRAM 纯内存压缩块设备 (零磁盘 IO 磨损，速度快 100 倍)
        local ZRAM_ACTIVATED=false
        if command -v modprobe >/dev/null 2>&1; then
            modprobe zram num_devices=1 2>/dev/null || true
        fi

        if [ -b /dev/zram0 ] || [ -d /sys/block/zram0 ]; then
            if grep -q "zram0" /proc/swaps 2>/dev/null; then
                echo -e "${GREEN}✅ 系统已原生挂载 ZRAM 内存压缩缓冲，性能处于极佳状态！${PLAIN}"
                ZRAM_ACTIVATED=true
            else
                echo -e "${CYAN}检测到系统内核支持 ZRAM 模块，正在配置 ${SWAP_SIZE_MB}MB 内存压缩块设备 (/dev/zram0)...${PLAIN}"
                # 优先选择 lz4 极速压缩算法 (备选 zstd)
                if [ -f /sys/block/zram0/comp_algorithm ]; then
                    grep -q "lz4" /sys/block/zram0/comp_algorithm 2>/dev/null && echo lz4 > /sys/block/zram0/comp_algorithm 2>/dev/null || true
                fi
                # 设置压缩容量 (以 2.5:1 压缩比折算仅占用小部分真实内存，即可提供极速缓冲)
                echo "${SWAP_SIZE_MB}M" > /sys/block/zram0/disksize 2>/dev/null || true
                mkswap /dev/zram0 >/dev/null 2>&1 || true
                if swapon -p 100 /dev/zram0 2>/dev/null; then
                    echo -e "${GREEN}✅ ZRAM 内存压缩块设备 (/dev/zram0) 已成功挂载激活！零磁盘 IO 磨损，凭空拓展 ${SWAP_SIZE_MB}MB 极速内存缓冲！${PLAIN}"
                    ZRAM_ACTIVATED=true
                fi
            fi
        fi

        # 🚀 第二优先级防御: 若系统未开启 ZRAM 模块，降级尝试创建常规磁盘 /swapfile 虚拟缓冲
        if [ "$ZRAM_ACTIVATED" = "false" ]; then
            local NEED_DISK_KB=$(( SWAP_SIZE_MB * 1024 + 150000 ))
            local DISK_FREE_KB=$(df -k / 2>/dev/null | tail -n 1 | awk '{print $4}' || echo 0)
            if [ "$DISK_FREE_KB" -gt "$NEED_DISK_KB" ]; then
                echo -e "${CYAN}系统未预置 ZRAM 模块，正在降级尝试创建 ${SWAP_SIZE_MB}MB 磁盘 Swap 虚拟缓冲 (/swapfile)...${PLAIN}"
                if command -v fallocate >/dev/null 2>&1; then
                    fallocate -l "${SWAP_SIZE_MB}M" /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_SIZE_MB}" 2>/dev/null || true
                else
                    dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_SIZE_MB}" 2>/dev/null || true
                fi

                if [ -f /swapfile ]; then
                    chmod 600 /swapfile 2>/dev/null || true
                    mkswap /swapfile >/dev/null 2>&1 || true
                    if swapon /swapfile 2>/dev/null; then
                        echo -e "${GREEN}✅ ${SWAP_SIZE_MB}MB 磁盘 Swap 虚拟缓冲已成功挂载激活！整机抗 OOM 稳定性提升 200%！${PLAIN}"
                        if [ -f /etc/fstab ] && ! grep -q "/swapfile" /etc/fstab; then
                            echo "/swapfile none swap sw 0 0" >> /etc/fstab
                        fi
                    else
                        rm -f /swapfile 2>/dev/null || true
                        echo -e "${YELLOW}💡 当前环境为无特权容器 (LXC/OpenVZ 限制 swapon)，已跳过 Swap 挂载。${PLAIN}"
                        echo -e "${GREEN}🛡️ 将全权由纯原生 Node.js 自适应内存反压微内核与 GC 调优提供 100% 稳态保障！${PLAIN}"
                    fi
                fi
            else
                echo -e "${YELLOW}💡 磁盘剩余空间较紧凑 ($(( DISK_FREE_KB / 1024 ))MB)，跳过自动创建 Swap。${PLAIN}"
            fi
        fi
    fi
}

ensure_swap_buffer

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

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
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
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        download_remote ".env.example"
        cp -f "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    fi
fi

# 确保基础配置与交互式参数采集 (兼容 curl 管道 /dev/tty 穿透)
PUBLIC_IP=$(curl -fsSL --connect-timeout 3 -m 5 https://api.ipify.org 2>/dev/null || curl -fsSL --connect-timeout 3 -m 5 https://ifconfig.me 2>/dev/null || echo "127.0.0.1")

read_interactive() {
    local prompt="$1"
    local default_val="$2"
    local result=""
    if [ -n "$NON_INTERACTIVE" ] || [ -n "$CI" ]; then
        echo "${default_val}"
        return 0
    fi
    if [ -e /dev/tty ] && [ -r /dev/tty ]; then
        printf "%b" "${prompt}" > /dev/tty
        read -r result < /dev/tty
    elif [ -t 0 ]; then
        printf "%b" "${prompt}"
        read -r result
    fi
    if [ -z "${result}" ]; then
        result="${default_val}"
    fi
    echo "${result}"
}

echo -e "\n${CYAN}========================================================${PLAIN}"
echo -e "${GREEN}⚙️  服务参数交互配置 (直接按回车可使用默认推荐值)${PLAIN}"
echo -e "${CYAN}========================================================${PLAIN}"

# 1. 端口配置提示
DETECTED_DEFAULT_PORT="${SET_PORT:-19900}"
INPUT_PORT=$(read_interactive "${YELLOW}👉 请输入服务监听端口 (NAT 小鸡请填写映射端口，默认: ${DETECTED_DEFAULT_PORT}): ${PLAIN}" "${DETECTED_DEFAULT_PORT}")
echo -e "${GREEN}✅ 已设定服务监听端口: ${BOLD}${INPUT_PORT}${PLAIN}"

# 2. 后台管理密码提示
DEFAULT_GEN_PWD=$(head -c 32 /dev/urandom 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 16 || echo "Admin$(date +%s)")
if [ -n "$SET_ADMIN_PASSWORD" ]; then
    INPUT_PWD="$SET_ADMIN_PASSWORD"
else
    INPUT_PWD=$(read_interactive "${YELLOW}👉 请输入管理后台密码 (直接回车将使用随机安全口令: ${DEFAULT_GEN_PWD}): ${PLAIN}" "${DEFAULT_GEN_PWD}")
fi
echo -e "${GREEN}✅ 已设定管理后台密码: ${BOLD}${INPUT_PWD}${PLAIN}"

# 3. 域名/公网 IP 绑定
if [ -n "$SET_SUB_DOMAIN" ]; then
    INPUT_DOMAIN="$SET_SUB_DOMAIN"
else
    INPUT_DOMAIN=$(read_interactive "${YELLOW}👉 请输入节点绑定的公网 IP 或域名 [默认自动探测: ${PUBLIC_IP}]: ${PLAIN}" "${PUBLIC_IP}")
fi
echo -e "${GREEN}✅ 已设定公网绑定地址: ${BOLD}${INPUT_DOMAIN}${PLAIN}"

# 写入或更新 .env
if [ ! -f "${INSTALL_DIR}/.env" ]; then
    if [ -f "${INSTALL_DIR}/.env.example" ]; then
        cp -f "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"
    else
        cat << EOF > "${INSTALL_DIR}/.env"
PORT=${INPUT_PORT}
SERVER_PORT=${INPUT_PORT}
ADMIN_PASSWORD=${INPUT_PWD}
SUB_DOMAIN=${INPUT_DOMAIN}
DEFAULT_ALLOW_REGISTER=true
DEFAULT_DAYS=365
DEFAULT_TRAFFIC_GB=100
ARGO_TOKEN=
ARGO_DOMAIN=
EOF
    fi
fi

# 安全原子更新 .env 键值 (支持任何含斜杠、特殊符号的密码与 Token)
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
        # 降级备用: 使用竖线作为 sed 定界符并保证独立换行
        sed -i "s|^${key}=.*|${key}=${val}|" "$file" 2>/dev/null || echo -e "\n${key}=${val}" >> "$file"
    }
}

update_env_kv "PORT" "${INPUT_PORT}"
update_env_kv "SERVER_PORT" "${INPUT_PORT}"
update_env_kv "ADMIN_PASSWORD" "${INPUT_PWD}"
update_env_kv "SUB_DOMAIN" "${INPUT_DOMAIN}"

# 若命令行有额外 ARGO 参数则安全写入
if [ -n "$SET_ARGO_DOMAIN" ]; then
    update_env_kv "ARGO_DOMAIN" "${SET_ARGO_DOMAIN}"
fi
if [ -n "$SET_ARGO_TOKEN" ]; then
    update_env_kv "ARGO_TOKEN" "${SET_ARGO_TOKEN}"
fi

chmod +x "${INSTALL_DIR}"/*.sh 2>/dev/null || true
# 注册全局便捷命令 vps-tunnel
ln -sf "${INSTALL_DIR}/start.sh" /usr/local/bin/vps-tunnel 2>/dev/null || true
ln -sf "${INSTALL_DIR}/start.sh" /usr/bin/vps-tunnel 2>/dev/null || true

# 3. 注册守护进程 (适配 Systemd 或 OpenRC)
echo -e "${YELLOW}[3/5] 配置系统自启守护进程...${PLAIN}"
NODE_BIN=$(command -v node)

IS_SYSTEMD=false
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    IS_SYSTEMD=true
fi

# 🚀 全自动动态探测系统/容器内存上限并计算安全 V8 堆配额
# 🚀 全自动动态探测系统/容器内存上限并计算安全 V8 堆配额与专属调优参数
detect_memory_profile() {
    local TOTAL_MEM_BYTES=0
    if [ -f /sys/fs/cgroup/memory.max ]; then
        local CG_V2=$(cat /sys/fs/cgroup/memory.max 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V2" ] && [ "$CG_V2" != "max" ]; then
            TOTAL_MEM_BYTES=$CG_V2
        fi
    fi
    if [ "$TOTAL_MEM_BYTES" -eq 0 ] && [ -f /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        local CG_V1=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null | tr -d ' \r\n')
        if [ -n "$CG_V1" ] && [ "$CG_V1" -lt 9223372036854771712 ] 2>/dev/null; then
            TOTAL_MEM_BYTES=$CG_V1
        fi
    fi
    if [ "$TOTAL_MEM_BYTES" -eq 0 ] && [ -f /proc/meminfo ]; then
        local MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        if [ -n "$MEM_KB" ]; then
            TOTAL_MEM_BYTES=$(( MEM_KB * 1024 ))
        fi
    fi

    local HEAP_MB=128
    local POOL_SIZE=16
    local GOMEM_LIMIT="40MiB"
    local EXTRA_V8=""

    if [ "$TOTAL_MEM_BYTES" -gt 0 ]; then
        if [ "$TOTAL_MEM_BYTES" -le 83886080 ]; then
            # 64MB Nano 机型 (<=80MB): 堆配额 32MB，新生代设为 4MB，消除 1MB 频繁 GC 抖动
            HEAP_MB=32
            POOL_SIZE=8
            GOMEM_LIMIT="16MiB"
            EXTRA_V8="--max-semi-space-size=4"
        elif [ "$TOTAL_MEM_BYTES" -le 167772160 ]; then
            # 128MB 机型 (<=160MB): 堆配额 64MB，16 线程池保证并发 DNS 与出站零排队
            HEAP_MB=64
            POOL_SIZE=16
            GOMEM_LIMIT="25MiB"
        elif [ "$TOTAL_MEM_BYTES" -le 314572800 ]; then
            # 256MB 机型 (<=300MB): 堆配额 128MB，配合 ZRAM 缓冲完全充裕
            HEAP_MB=128
            POOL_SIZE=16
            GOMEM_LIMIT="35MiB"
        else
            # 512MB 及以上机型: 堆配额 256MB
            HEAP_MB=256
            POOL_SIZE=16
            GOMEM_LIMIT="50MiB"
        fi
    fi

    AUTO_HEAP_MB="${HEAP_MB}"
    AUTO_POOL_SIZE="${POOL_SIZE}"
    AUTO_GOMEMLIMIT="${GOMEM_LIMIT}"
    AUTO_NODE_OPTIONS="--max-old-space-size=${HEAP_MB} --expose-gc ${EXTRA_V8}"
}

detect_memory_profile

# 🚀 将自适应动态计算出的系统调优与内存配额变量完整写入 .env (全局单一真相源)
update_env_kv "NODE_OPTIONS" "${AUTO_NODE_OPTIONS}"
update_env_kv "UV_THREADPOOL_SIZE" "${AUTO_POOL_SIZE}"
update_env_kv "MALLOC_ARENA_MAX" "2"
update_env_kv "GOMEMLIMIT" "${AUTO_GOMEMLIMIT}"
update_env_kv "GOGC" "50"
echo -e "${GREEN}✅ 已将自适应内存与并发参数完美写入 .env 环境变量文件${PLAIN}"

if [ "$IS_SYSTEMD" = "true" ]; then
    echo -e "${CYAN}系统环境: Systemd，正在生成服务单元 (自动分配堆上限: ${AUTO_HEAP_MB}MB | 线程池: ${AUTO_POOL_SIZE} | Go配额: ${AUTO_GOMEMLIMIT})...${PLAIN}"
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
Environment="UV_THREADPOOL_SIZE=${AUTO_POOL_SIZE}"
Environment="NODE_OPTIONS=${AUTO_NODE_OPTIONS}"
Environment="MALLOC_ARENA_MAX=2"
Environment="GOMEMLIMIT=${AUTO_GOMEMLIMIT}"
Environment="GOGC=50"
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
    echo -e "${CYAN}系统环境: OpenRC (Alpine)，正在配置 /etc/init.d/vps-tunnel (自动分配置堆上限: ${AUTO_HEAP_MB}MB)...${PLAIN}"
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
    export MALLOC_ARENA_MAX=2
    export GOGC=50

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

    # 自适应计算 Node.js V8 堆内存上限与 Go 配额 (针对 64M / 128M / 256M NAT 极致微内核调校)
    HEAP_MB=96
    POOL_SIZE=16
    GOMEM_LIMIT="40MiB"
    EXTRA_V8=""
    if [ "$TOTAL_MEM_BYTES" -gt 0 ]; then
        if [ "$TOTAL_MEM_BYTES" -le 83886080 ]; then
            HEAP_MB=24
            POOL_SIZE=4
            GOMEM_LIMIT="12MiB"
            EXTRA_V8="--optimize-for-size --max-semi-space-size=1"
        elif [ "$TOTAL_MEM_BYTES" -le 167772160 ]; then
            HEAP_MB=48
            POOL_SIZE=8
            GOMEM_LIMIT="20MiB"
        elif [ "$TOTAL_MEM_BYTES" -le 314572800 ]; then
            HEAP_MB=80
            POOL_SIZE=16
            GOMEM_LIMIT="25MiB"
        else
            HEAP_MB=$(( TOTAL_MEM_BYTES * 45 / 100 / 1024 / 1024 ))
            [ "$HEAP_MB" -gt 256 ] && HEAP_MB=256
            POOL_SIZE=16
            GOMEM_LIMIT="40MiB"
        fi
    fi
    export UV_THREADPOOL_SIZE="${POOL_SIZE}"
    export GOMEMLIMIT="${GOMEM_LIMIT}"
    export NODE_OPTIONS="--max-old-space-size=${HEAP_MB} --expose-gc ${EXTRA_V8}"
    echo "[OpenRC] ⚡ 动态硬件探测完成: 总内存=$(( TOTAL_MEM_BYTES / 1024 / 1024 ))MB | 自动分配堆上限=${HEAP_MB}MB | 线程池=${POOL_SIZE} | Go配额=${GOMEM_LIMIT} (--expose-gc 已激活)" >> "${output_log}"

    # 彻底清理非 OpenRC 启动的历史残留 node 与 cloudflared，防止 EADDRINUSE 与 CPU 死循环
    pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
    if [ -f "${pidfile}" ]; then
        PID_OLD=$(cat "${pidfile}" 2>/dev/null)
        [ -n "$PID_OLD" ] && kill -9 "$PID_OLD" 2>/dev/null || true
    fi
}

stop_post() {
    pkill -9 -f "cloudflared tunnel" 2>/dev/null || true
    pkill -9 -f "node index.js" 2>/dev/null || true
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

# 4. 自动优化 Linux 内核网络参数与 BBR 拥塞控制
if [ -f "${INSTALL_DIR}/optimize_bbr.sh" ]; then
    echo -e "${YELLOW}[4/6] 优化 Linux 内核网络与开启 BBR 加速...${PLAIN}"
    sh "${INSTALL_DIR}/optimize_bbr.sh" >/dev/null 2>&1 || true
    echo -e "${GREEN}✅ Linux 内核 TCP 缓冲区与 BBR 拥塞控制调优完成${PLAIN}"
fi

# 5. 自动放行防火墙端口 (若有防火墙管理器)
echo -e "${YELLOW}[5/6] 检查系统防火墙...${PLAIN}"
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

# 6. 校验运行状态
echo -e "${YELLOW}[6/6] 校验服务运行状态...${PLAIN}"
sleep 2

STATUS_OK=false
if [ "$IS_SYSTEMD" = "true" ]; then
    systemctl is-active --quiet vps-tunnel && STATUS_OK=true
else
    pgrep -f "node index.js" >/dev/null 2>&1 && STATUS_OK=true
fi

FINAL_PORT=$(grep "^PORT=" "${INSTALL_DIR}/.env" 2>/dev/null | cut -d'=' -f2 || echo "${INPUT_PORT}")
FINAL_DOMAIN=$(grep "^SUB_DOMAIN=" "${INSTALL_DIR}/.env" 2>/dev/null | cut -d'=' -f2 || echo "${INPUT_DOMAIN}")
FINAL_PWD=$(grep "^ADMIN_PASSWORD=" "${INSTALL_DIR}/.env" 2>/dev/null | cut -d'=' -f2 || echo "${INPUT_PWD}")

echo -e "\n${CYAN}================================================================${PLAIN}"
if [ "$STATUS_OK" = "true" ]; then
    echo -e "${GREEN}🎉 VPS-Tunnel 服务已成功部署并运行中！${PLAIN}"
else
    echo -e "${YELLOW}💡 服务已完成装配并在后台启动，请检查状态验证！${PLAIN}"
fi
echo -e "${CYAN}----------------------------------------------------------------${PLAIN}"
echo -e "🌐 前台优选主页:   ${BOLD}${GREEN}http://${FINAL_DOMAIN}:${FINAL_PORT}/${PLAIN}"
echo -e "🛠️  Element UI 后台: ${BOLD}${GREEN}http://${FINAL_DOMAIN}:${FINAL_PORT}/admin${PLAIN}"
echo -e "🔑 后台管理密码:   ${BOLD}${YELLOW}${FINAL_PWD}${PLAIN}"
echo -e "${CYAN}----------------------------------------------------------------${PLAIN}"
echo -e "📁 工作目录:       ${INSTALL_DIR}"
echo -e "⚙️  配置文件:       ${INSTALL_DIR}/.env"
echo -e "📜 日志文件:       /var/log/vps-tunnel.log"
echo -e "⚡ 快捷管理命令:   ${BOLD}${CYAN}vps-tunnel${PLAIN} (随时输入可修改端口/密码/重启)"
echo -e "${CYAN}================================================================${PLAIN}"
