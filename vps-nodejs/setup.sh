#!/usr/bin/env bash
# ========================================================
# VPS-Tunnel: Linux VPS 一键部署与开机自启安装脚本
# 支持系统: Debian 10+ / Ubuntu 20.04+ / CentOS 8+ / Rocky / AlmaLinux
# ========================================================

set -e

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
PLAIN="\033[0m"

echo -e "${CYAN}========================================================${PLAIN}"
echo -e "${GREEN}🚀 VPS-Tunnel 纯原生 Node.js VLESS 隧道一键安装程序${PLAIN}"
echo -e "${CYAN}========================================================${PLAIN}"

if [ "$(id -u)" != "0" ]; then
    echo -e "${RED}[Error] 必须使用 root 用户执行此脚本！${PLAIN}"
    exit 1
fi

INSTALL_DIR="/opt/vps-tunnel"

# 1. 检查并安装 Node.js 运行环境 (LTS)
echo -e "${YELLOW}[1/5] 检查系统 Node.js 运行环境...${PLAIN}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${YELLOW}未检测到 Node.js，正在自动从官方源安装最新 LTS...${PLAIN}"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y curl ca-certificates gnupg
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
        dnf module install -y nodejs:20
    elif command -v yum >/dev/null 2>&1; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
    else
        echo -e "${RED}[Error] 未知包管理器，请手动安装 Node.js 18+！${PLAIN}"
        exit 1
    fi
fi

NODE_VER=$(node -v)
echo -e "${GREEN}✅ Node.js 环境已就绪: ${NODE_VER}${PLAIN}"

# 2. 创建安装目录并部署文件
echo -e "${YELLOW}[2/5] 部署应用文件至 ${INSTALL_DIR}...${PLAIN}"
mkdir -p "${INSTALL_DIR}/data"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAW_URL="https://raw.githubusercontent.com/hc990275/nodejs/main/vps-nodejs"
GH_PROXY="https://gh-proxy.net/${RAW_URL}"

# 探测本地文件是否存在；若不存在（例如通过 curl 管道直接执行），则从远程拉取
if [ -f "${SCRIPT_DIR}/index.js" ]; then
    echo -e "${CYAN}检测到本地源码，正在从当前目录部署...${PLAIN}"
    cp -f "${SCRIPT_DIR}/index.js" "${INSTALL_DIR}/"
    cp -f "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/start.sh" ] && cp -f "${SCRIPT_DIR}/start.sh" "${INSTALL_DIR}/"
    [ -f "${SCRIPT_DIR}/optimize_bbr.sh" ] && cp -f "${SCRIPT_DIR}/optimize_bbr.sh" "${INSTALL_DIR}/"
    if [ ! -f "${INSTALL_DIR}/.env" ]; then
        if [ -f "${SCRIPT_DIR}/.env" ]; then
            cp -f "${SCRIPT_DIR}/.env" "${INSTALL_DIR}/"
        else
            cp -f "${SCRIPT_DIR}/.env.example" "${INSTALL_DIR}/.env"
        fi
    fi
else
    echo -e "${CYAN}检测到远程在线安装模式，正在高速下载项目文件...${PLAIN}"
    download_remote() {
        local fname="$1"
        local target="${INSTALL_DIR}/${fname}"
        if ! curl -fsSL --connect-timeout 8 -m 30 "${RAW_URL}/${fname}" -o "${target}"; then
            curl -fsSL --connect-timeout 8 -m 30 "${GH_PROXY}/${fname}" -o "${target}"
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

chmod +x "${INSTALL_DIR}"/*.sh 2>/dev/null || true

# 3. 注册 Systemd 系统服务
echo -e "${YELLOW}[3/5] 注册 Systemd 守护进程...${PLAIN}"
NODE_BIN=$(command -v node)

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

# 4. 自动放行防火墙端口 (UFW / Firewalld)
echo -e "${YELLOW}[4/5] 检查系统防火墙...${PLAIN}"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp || true
    ufw allow 443/tcp || true
    echo -e "${GREEN}✅ UFW 防火墙已放行 80 / 443 端口${PLAIN}"
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --zone=public --add-port=80/tcp --permanent || true
    firewall-cmd --zone=public --add-port=443/tcp --permanent || true
    firewall-cmd --reload || true
    echo -e "${GREEN}✅ Firewalld 防火墙已放行 80 / 443 端口${PLAIN}"
fi

# 5. 启动服务
echo -e "${YELLOW}[5/5] 正在拉起服务...${PLAIN}"
systemctl restart vps-tunnel

sleep 2
if systemctl is-active --quiet vps-tunnel; then
    echo -e "${CYAN}========================================================${PLAIN}"
    echo -e "${GREEN}🎉 VPS-Tunnel 服务已成功安装并处于运行中！${PLAIN}"
    echo -e "📁 工作目录: ${INSTALL_DIR}"
    echo -e "📋 运行状态: systemctl status vps-tunnel"
    echo -e "📜 实时日志: journalctl -u vps-tunnel -f"
    echo -e "🛑 停止服务: systemctl stop vps-tunnel"
    echo -e "🔄 重启服务: systemctl restart vps-tunnel"
    echo -e "${CYAN}========================================================${PLAIN}"
else
    echo -e "${RED}⚠️ 服务启动可能遇到问题，请执行 journalctl -u vps-tunnel -xe 查看详细日志！${PLAIN}"
fi
