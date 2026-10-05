#!/bin/sh
# ========================================================
# VPS-Tunnel: Linux VPS 内核网络高并发与 BBR 加速调优脚本
# ========================================================

if [ "$(id -u)" != "0" ]; then
    if command -v sudo >/dev/null 2>&1; then
        echo "⚡ 检测到当前非 root，自动应用 sudo 提权执行..."
        exec sudo sh "$0" "$@"
    else
        echo "错误：必须使用 root 权限执行此优化脚本！请先运行 'su -' 切换用户。"
        exit 1
    fi
fi

echo "正在优化 Linux 内核 TCP 参数与开启 BBR 拥塞控制算法..."

# 1. 开启 BBR
cat <<EOF > /etc/sysctl.d/99-vps-tunnel.conf
# 开启 BBR 拥塞控制
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr

# 提升文件描述符与端口复用能力
fs.file-max = 1000000
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.netdev_max_backlog = 10000
net.core.somaxconn = 65535

# TCP 连接优化
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 1200
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_max_tw_buckets = 5000
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_tw_reuse = 1
EOF

sysctl --system >/dev/null 2>&1

# 2. 提升用户级 ulimit
cat <<EOF >> /etc/security/limits.conf
* soft nofile 65535
* hard nofile 65535
* soft nproc 65535
* hard nproc 65535
EOF

echo "✅ Linux 内核优化完成！当前拥塞控制算法："
sysctl net.ipv4.tcp_congestion_control
