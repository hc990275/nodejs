#!/bin/sh
# ==============================================================================
# 极速云专线 - 一键开机自启安装器 (自动识别 systemd 与 OpenRC)
# ==============================================================================
set -e

WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "=== [Service Installer] 开始配置开机自启守护服务 ==="
echo "服务程序目录: $WORK_DIR"

NODE_BIN="$(command -v node 2>/dev/null || echo "/usr/bin/node")"

# 1. 优先检测现代 Linux systemd (Ubuntu 20.04/22.04/24.04, Debian 10/11/12, CentOS 7/8/9, Rocky)
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  echo "[Service Installer] 识别到 systemd 守护体系 (Ubuntu / Debian / CentOS / Rocky / Alma)"
  
  SERVICE_FILE="/etc/systemd/system/v3.service"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=V3 Adaptive Multi-Protocol Airport Service
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$WORK_DIR
ExecStart=/bin/sh $WORK_DIR/start.sh
Restart=always
RestartSec=3
LimitNOFILE=65535
LimitNPROC=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable v3
  systemctl restart v3
  echo "=========================================================="
  echo "✅ systemd 服务已成功安装并启动！"
  echo "状态查看: systemctl status v3"
  echo "重启服务: systemctl restart v3"
  echo "停止服务: systemctl stop v3"
  echo "查看日志: journalctl -u v3 -f -n 50"
  echo "=========================================================="
  exit 0
fi

# 2. 检测 Alpine Linux OpenRC 体系
if command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
  echo "[Service Installer] 识别到 OpenRC 守护体系 (Alpine Linux)"
  
  sed "s|V3_DIR=.*|V3_DIR=\"\${V3_DIR:-$WORK_DIR}\"|" "$WORK_DIR/v3.openrc" > /etc/init.d/v3
  chmod +x /etc/init.d/v3
  rc-update add v3 default 2>/dev/null || true
  rc-service v3 restart
  echo "=========================================================="
  echo "✅ OpenRC 服务已成功安装并启动！"
  echo "状态查看: rc-service v3 status"
  echo "重启服务: rc-service v3 restart"
  echo "停止服务: rc-service v3 stop"
  echo "查看日志: tail -f /var/log/v3.log"
  echo "=========================================================="
  exit 0
fi

# 3. 极简容器 / 无 init 体系兜底提示
echo "⚠️ 未检测到 systemd 或 OpenRC 守护系统，当前可能处于受限 Docker 容器或云面板环境中。"
echo "推荐直接使用标准后台守护启动："
echo "  nohup $WORK_DIR/start.sh > $WORK_DIR/run.log 2>&1 &"
