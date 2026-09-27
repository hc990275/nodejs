#!/usr/bin/env bash
# ==============================================================================
# 极速云专线 - 分布式集群副机 (Worker Node) 一键极速部署与心跳守护脚本
# ==============================================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}==============================================================================${NC}"
echo -e "${CYAN}   🚀 极速云专线 · 分布式节点集群副机 (Worker Node) 接入程序                ${NC}"
echo -e "${CYAN}==============================================================================${NC}"

MASTER_URL=""
SECRET=""
NODE_NAME=""
PORT="18800"

# 解析命令行参数
for arg in "$@"; do
    case $arg in
        --master=*)
            MASTER_URL="${arg#*=}"
            shift
            ;;
        --secret=*)
            SECRET="${arg#*=}"
            shift
            ;;
        --name=*)
            NODE_NAME="${arg#*=}"
            shift
            ;;
        --port=*)
            PORT="${arg#*=}"
            shift
            ;;
        *)
            ;;
    esac
done

# 若未提供参数，交互式输入
if [ -z "$MASTER_URL" ]; then
    echo -ne "${YELLOW}请输入主控服务器地址 (例如: https://us.995677.xyz): ${NC}"
    read -r MASTER_URL
fi

if [ -z "$SECRET" ]; then
    echo -ne "${YELLOW}请输入集群通信密钥 (NODE_SECRET): ${NC}"
    read -r SECRET
fi

# 去除主控末尾的 /
MASTER_URL="${MASTER_URL%/}"

if [ -z "$MASTER_URL" ] || [ -z "$SECRET" ]; then
    echo -e "${RED}❌ 错误: 主控地址与集群密钥为必填项！${NC}"
    exit 1
fi

echo -e "${BLUE}▶ 主控服务器: ${NC}${MASTER_URL}"
echo -e "${BLUE}▶ 集群通信密钥: ${NC}${SECRET}"
echo -e "${BLUE}▶ 节点显示名称: ${NC}${NODE_NAME:-[根据公网IP自动识别地区与国旗]}"
echo -e "${BLUE}▶ 本地通信端口: ${NC}${PORT}"

# 1. 检查并安装运行基础环境 (Node.js & Git)
echo -e "\n${YELLOW}[1/4] 检查系统环境与基础依赖...${NC}"

install_dependencies() {
    if [ -f /etc/debian_version ]; then
        apt-get update -y >/dev/null 2>&1 || true
        apt-get install -y curl git ca-certificates >/dev/null 2>&1 || true
    elif [ -f /etc/redhat-release ]; then
        yum install -y curl git ca-certificates >/dev/null 2>&1 || true
    elif [ -f /etc/alpine-release ]; then
        apk add --no-cache curl git ca-certificates nodejs npm >/dev/null 2>&1 || true
    fi
}

install_dependencies

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
    echo -e "${YELLOW}未检测到 Node.js，正在自动安装 Node.js LTS...${NC}"
    if [ -f /etc/debian_version ]; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
        apt-get install -y nodejs >/dev/null 2>&1
    elif [ -f /etc/redhat-release ]; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
        yum install -y nodejs >/dev/null 2>&1
    else
        echo -e "${RED}无法自动安装 Node.js，请手动安装 Node.js 18+ 后重试。${NC}"
        exit 1
    fi
fi

NODE_VER=$(node -v 2>/dev/null || echo "unknown")
echo -e "${GREEN}✓ Node.js 环境就绪: ${NODE_VER}${NC}"

# 2. 检查工作目录与源码拉取
echo -e "\n${YELLOW}[2/4] 准备副机运行程序源码...${NC}"

WORK_DIR="/opt/v3-worker-node"
if [ -f "index.js" ] && [ -d "views" ]; then
    # 当前已在 linux 目录下直接执行
    WORK_DIR="$(pwd)"
    echo -e "${GREEN}✓ 使用当前目录源码: ${WORK_DIR}${NC}"
else
    mkdir -p "$WORK_DIR"
    cd "$WORK_DIR"
    if [ ! -d ".git" ]; then
        echo -e "${BLUE}正在从 GitHub 拉取节点最新核心仓库...${NC}"
        git clone --depth=1 https://github.com/hc990275/nodejs.git .
    else
        echo -e "${BLUE}正在更新最新核心程序...${NC}"
        git pull || true
    fi
    if [ -d "linux" ]; then
        cd linux
        WORK_DIR="$(pwd)"
    fi
fi

# 3. 生成专属 Worker .env 配置文件
echo -e "\n${YELLOW}[3/4] 写入副机专属集群环境配置 (.env)...${NC}"

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

echo -e "${GREEN}✓ .env 配置写入完毕${NC}"

# 4. 启动服务与后台保活
echo -e "\n${YELLOW}[4/4] 启动副机并与主控建立心跳连线...${NC}"

# 优先尝试使用 PM2 进行开机守护
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2 >/dev/null 2>&1 || true
fi

if command -v pm2 >/dev/null 2>&1; then
    pm2 stop v3-worker >/dev/null 2>&1 || true
    pm2 delete v3-worker >/dev/null 2>&1 || true
    pm2 start index.js --name "v3-worker" --cwd "$WORK_DIR"
    pm2 save >/dev/null 2>&1 || true
    echo -e "${GREEN}✓ 已使用 PM2 成功启动并设置后台守护进程 (v3-worker)${NC}"
else
    # 回退使用 systemd 服务
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
    echo -e "${GREEN}✓ 已使用 systemd 成功启动并启用开机自启 (v3-worker.service)${NC}"
fi

echo -e "\n${GREEN}==============================================================================${NC}"
echo -e "${GREEN}🎉 恭喜！副机节点已成功接入集群并与主控建立 5 秒心跳！${NC}"
echo -e "${CYAN}▶ 主控管理地址: ${NC}${MASTER_URL}/admin"
echo -e "${CYAN}▶ 您现在可以直接在主控后台【集群分机管理】弹窗中：${NC}"
echo -e "   1. 实时查看此副机状态、公网IP与心跳延迟"
echo -e "   2. 远程一键勾选/取消开启 Hy2、Reality、TUIC、VLESS、Trojan 等任意协议"
echo -e "   3. 远程自定义端口与国家地区标识，保存后主控心跳直接下发自动重载！"
echo -e "${GREEN}==============================================================================${NC}\n"
