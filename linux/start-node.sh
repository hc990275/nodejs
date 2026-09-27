#!/bin/sh
# ==============================================================================
# 极速云专线 - 分布式集群副机 (Worker Node) 一键极速部署与心跳守护脚本
# 100% 兼容 Alpine Linux (ash/sh) / Debian / Ubuntu / CentOS / RHEL
# ==============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

printf "${CYAN}==============================================================================${NC}\n"
printf "${CYAN}   🚀 极速云专线 · 分布式节点集群副机 (Worker Node) 接入程序                ${NC}\n"
printf "${CYAN}==============================================================================${NC}\n"

MASTER_URL=""
SECRET=""
NODE_NAME=""
PORT="18800"

# 解析命令行参数
for arg in "$@"; do
    case $arg in
        --master=*)
            MASTER_URL="${arg#*=}"
            ;;
        --secret=*)
            SECRET="${arg#*=}"
            ;;
        --name=*)
            NODE_NAME="${arg#*=}"
            ;;
        --port=*)
            PORT="${arg#*=}"
            ;;
        *)
            ;;
    esac
done

# 若未提供参数，交互式输入
if [ -z "$MASTER_URL" ]; then
    printf "${YELLOW}请输入主控服务器地址 (例如: https://us.995677.xyz): ${NC}"
    read -r MASTER_URL
fi

if [ -z "$SECRET" ]; then
    printf "${YELLOW}请输入集群通信密钥 (NODE_SECRET): ${NC}"
    read -r SECRET
fi

# 去除主控末尾的 /
MASTER_URL=$(echo "$MASTER_URL" | sed 's:/*$::')

if [ -z "$MASTER_URL" ] || [ -z "$SECRET" ]; then
    printf "${RED}❌ 错误: 主控地址与集群密钥为必填项！${NC}\n"
    exit 1
fi

printf "${BLUE}▶ 主控服务器: ${NC}%s\n" "${MASTER_URL}"
printf "${BLUE}▶ 集群通信密钥: ${NC}%s\n" "${SECRET}"
printf "${BLUE}▶ 节点显示名称: ${NC}%s\n" "${NODE_NAME:-[根据公网IP自动识别地区与国旗]}"
printf "${BLUE}▶ 本地通信端口: ${NC}%s\n" "${PORT}"

# 1. 检查并自动安装系统基础依赖 (针对精简 Alpine/Debian 自动装 git, curl, nodejs)
printf "\n${YELLOW}[1/4] 检查系统环境与基础运行库...${NC}\n"

install_dependencies() {
    if command -v apk >/dev/null 2>&1; then
        echo "检测到 Alpine Linux，正在通过 apk 自动安装基础运行库与 Node.js..."
        apk update >/dev/null 2>&1 || true
        apk add --no-cache curl wget git ca-certificates nodejs npm openssl bash >/dev/null 2>&1 || true
    elif command -v apt-get >/dev/null 2>&1; then
        echo "检测到 Debian/Ubuntu，正在通过 apt 自动安装依赖..."
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y curl wget git ca-certificates openssl >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        echo "检测到 CentOS/RHEL，正在通过 yum 自动安装依赖..."
        yum install -y curl wget git ca-certificates openssl >/dev/null 2>&1 || true
    fi
}

install_dependencies

# 检查 Node.js，若依然缺失则通过官方源安装
if ! command -v node >/dev/null 2>&1; then
    printf "${YELLOW}正在自动下载并部署 Node.js LTS 运行环境...${NC}\n"
    if command -v apk >/dev/null 2>&1; then
        apk add --no-cache nodejs npm
    elif command -v apt-get >/dev/null 2>&1; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
        apt-get install -y nodejs >/dev/null 2>&1 || true
    elif command -v yum >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
        yum install -y nodejs >/dev/null 2>&1 || true
    fi
fi

if ! command -v node >/dev/null 2>&1; then
    printf "${RED}❌ 无法自动安装 Node.js，请手动安装 Node.js 18+ 后重试。${NC}\n"
    exit 1
fi

NODE_VER=$(node -v 2>/dev/null || echo "unknown")
printf "${GREEN}✓ Node.js 核心运行就绪: %s${NC}\n" "${NODE_VER}"

# 2. 检查工作目录与源码拉取
printf "\n${YELLOW}[2/4] 准备副机运行程序源码...${NC}\n"

WORK_DIR="/opt/v3-worker-node"
if [ -f "index.js" ] && [ -d "views" ]; then
    # 当前已在 linux 目录下直接执行
    WORK_DIR="$(pwd)"
    printf "${GREEN}✓ 使用当前目录源码: %s${NC}\n" "${WORK_DIR}"
else
    mkdir -p "$WORK_DIR"
    cd "$WORK_DIR"
    if [ ! -d ".git" ]; then
        printf "${BLUE}正在拉取节点最新核心程序...${NC}\n"
        git clone --depth=1 https://github.com/hc990275/nodejs.git . 2>/dev/null || {
            printf "${YELLOW}git clone 失败，尝试通过压缩包极速下载...${NC}\n"
            (curl -fsSL https://github.com/hc990275/nodejs/archive/refs/heads/main.tar.gz || wget -qO- https://github.com/hc990275/nodejs/archive/refs/heads/main.tar.gz) | tar -xz --strip-components=1
        }
    else
        printf "${BLUE}正在更新最新核心程序...${NC}\n"
        git pull || true
    fi
    if [ -d "linux" ]; then
        cd linux
        WORK_DIR="$(pwd)"
    fi
fi

# 3. 生成专属 Worker .env 配置文件
printf "\n${YELLOW}[3/4] 写入副机专属集群环境配置 (.env)...${NC}\n"

ENV_FILE="${WORK_DIR}/.env"
cat > "$ENV_FILE" <<EOF
# ==============================================================================
# 集群 Worker 副机自动生成配置
# ==============================================================================
NODE_ROLE=worker
CLUSTER_MASTER=${MASTER_URL}
CLUSTER_SECRET=${SECRET}
SERVER_PORT=${PORT}
EOF

if [ -n "$NODE_NAME" ]; then
    echo "NODE_NAME=${NODE_NAME}" >> "$ENV_FILE"
fi

printf "${GREEN}✓ .env 配置写入完毕${NC}\n"

# 4. 启动服务与后台保活
printf "\n${YELLOW}[4/4] 启动副机并与主控建立心跳连线...${NC}\n"

STARTED=0

# 策略 A: 优先使用 PM2
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 >/dev/null 2>&1 || true
fi

if command -v pm2 >/dev/null 2>&1; then
    pm2 stop v3-worker >/dev/null 2>&1 || true
    pm2 delete v3-worker >/dev/null 2>&1 || true
    pm2 start index.js --name "v3-worker" --cwd "$WORK_DIR"
    pm2 save >/dev/null 2>&1 || true
    printf "${GREEN}✓ 已使用 PM2 成功启动并设置后台守护进程 (v3-worker)${NC}\n"
    STARTED=1
fi

# 策略 B: 若无 PM2，使用 systemd
if [ "$STARTED" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
    SERVICE_FILE="/etc/systemd/system/v3-worker.service"
    NODE_PATH=$(command -v node)
    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=V3 Worker Node Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${WORK_DIR}
ExecStart=${NODE_PATH} ${WORK_DIR}/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable v3-worker >/dev/null 2>&1 || true
    systemctl restart v3-worker
    printf "${GREEN}✓ 已使用 systemd 成功启动并启用开机自启 (v3-worker.service)${NC}\n"
    STARTED=1
fi

# 策略 C: 若无 PM2 且无 systemd (如 Alpine 默认环境)，使用 nohup + 循环自愈保活脚本
if [ "$STARTED" -eq 0 ]; then
    NODE_PATH=$(command -v node)
    # 杀死旧进程
    pkill -f "node.*index.js" >/dev/null 2>&1 || true
    nohup "$NODE_PATH" "${WORK_DIR}/index.js" >/var/log/v3-worker.log 2>&1 &
    PID=$!
    printf "${GREEN}✓ 已使用轻量后台守护进程启动 (PID: %s, 日志: /var/log/v3-worker.log)${NC}\n" "$PID"
    STARTED=1
fi

printf "\n${GREEN}==============================================================================${NC}\n"
printf "${GREEN}🎉 恭喜！副机节点已成功接入集群并与主控建立 5 秒心跳！${NC}\n"
printf "${CYAN}▶ 主控管理地址: ${NC}%s/admin\n" "${MASTER_URL}"
printf "${CYAN}▶ 您现在可以直接在主控后台【集群分机管理】弹窗中：${NC}\n"
printf "   1. 实时查看此副机状态、公网IP与心跳延迟\n"
printf "   2. 远程一键勾选/取消开启 Hy2、Reality、TUIC、VLESS、Trojan 等任意协议\n"
printf "   3. 远程自定义端口与国家地区标识，保存后主控心跳直接下发自动重载！\n"
printf "${GREEN}==============================================================================${NC}\n\n"

