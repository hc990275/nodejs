#!/bin/sh
# ==============================================================================
# 极速云专线 - 全Linux发行版 (Ubuntu / Debian / Alpine / CentOS / Arch) 自适应启动脚本
# ==============================================================================
# 注意: 不使用 set -e，避免守护进程因检测命令非零返回值被意外终止

echo "=== [Adaptive-Linux] 启动环境自愈与发行版预检 ==="

# 1. 探测 OS 发行版
OS_ID="unknown"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="$ID"
elif [ -f /etc/alpine-release ]; then
  OS_ID="alpine"
fi

echo "[Adaptive-Linux] 当前系统识别: ${PRETTY_NAME:-$OS_ID} (ID: $OS_ID)"

# 2. 检查与自动补齐 Node.js 运行环境
if ! command -v node >/dev/null 2>&1; then
  echo "[Adaptive-Linux] 未检测到 Node.js，正在根据发行版自动补齐安装..."
  if [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "debian" ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y && apt-get install -y --no-install-recommends nodejs npm curl tar ca-certificates openssl iptables procps
  elif [ "$OS_ID" = "alpine" ]; then
    apk update && apk add --no-cache nodejs npm curl tar ca-certificates openssl iptables
  elif [ "$OS_ID" = "centos" ] || [ "$OS_ID" = "rhel" ] || [ "$OS_ID" = "rocky" ] || [ "$OS_ID" = "almalinux" ] || [ "$OS_ID" = "fedora" ]; then
    (command -v dnf >/dev/null 2>&1 && dnf install -y nodejs npm curl tar ca-certificates openssl iptables procps) || yum install -y nodejs npm curl tar ca-certificates openssl iptables procps
  elif [ "$OS_ID" = "arch" ] || [ "$OS_ID" = "manjaro" ]; then
    pacman -Sy --noconfirm nodejs npm curl tar ca-certificates openssl iptables procps-ng
  else
    echo "[Adaptive-Linux] 未知系统发行版，尝试通用包管理器或请预先安装 Node.js..."
  fi
fi

# 3. 检查基础工具链
for cmd in curl tar openssl iptables; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[Adaptive-Linux] 正在补充安装 $cmd..."
    if [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "debian" ]; then
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -y && apt-get install -y --no-install-recommends "$cmd" || true
    elif [ "$OS_ID" = "alpine" ]; then
      apk add --no-cache "$cmd" || true
    elif [ "$OS_ID" = "centos" ] || [ "$OS_ID" = "rhel" ] || [ "$OS_ID" = "rocky" ] || [ "$OS_ID" = "almalinux" ] || [ "$OS_ID" = "fedora" ]; then
      (command -v dnf >/dev/null 2>&1 && dnf install -y "$cmd") || yum install -y "$cmd" || true
    fi
  fi
done

# 4. 授予执行权限
chmod +x index.js 2>/dev/null || true
if [ -f "./sing-box" ]; then
  chmod +x ./sing-box 2>/dev/null || true
fi

# 5. 极小内存 (256MB) 激进轻量化调优 (防止 Sing-box 内存膨胀与 GC 风暴)
export GOMEMLIMIT=40MiB
export GOGC=20

echo "=== [Adaptive-Linux] 环境检查就绪，正在拉起机场主程序 (已开启 64MB 堆内存保护) ==="
exec node --max-old-space-size=64 index.js
