import os
import urllib.request
import hashlib
import subprocess
import sys

# ================= 配置区 =================
# 自动读取翼龙面板分配的端口
PORT = int(os.environ.get('SERVER_PORT', 1080))

# 密码设定为 TG@robberer
SECRET_BASE = "TG@robberer"
SECRET_HEX = hashlib.md5(SECRET_BASE.encode()).hexdigest()

# 👇 请将 @MTProxybot 给你的 Tag 填在下面的引号里
AD_TAG = "c59cbd8abdfb43370ae3b28522791be1"
# ==========================================

def install_dependencies():
    try:
        import pyaes
    except ImportError:
        print("📦 正在安装轻量级加密依赖 (pyaes)...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyaes", "--quiet", "--no-cache-dir"])

def download_core():
    url = "https://raw.githubusercontent.com/alexbers/mtprotoproxy/master/mtprotoproxy.py"
    if not os.path.exists("mtprotoproxy.py"):
        print("📦 正在拉取 Python 全功能核心源码...")
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as resp, open("mtprotoproxy.py", "wb") as f:
                f.write(resp.read())
        except Exception as e:
            print(f"❌ 下载核心文件失败: {e}")
            sys.exit(1)

def write_config():
    # 动态生成配置，强制 WORKERS=1 以防面板内存超载
    config_data = f"""
PORT = {PORT}
USERS = {{
    "TG": "{SECRET_HEX}"
}}
AD_TAG = "{AD_TAG}"
WORKERS = 1
"""
    with open("config.py", "w", encoding="utf-8") as f:
        f.write(config_data.strip())

def get_ip():
    try:
        req = urllib.request.Request("http://api.ipify.org", headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as resp:
            return resp.read().decode('utf-8').strip()
    except:
        return "YOUR_IP"

def main():
    print("----------------------------------------------------")
    print("预检系统环境...")
    install_dependencies()
    download_core()
    write_config()

    ip = get_ip()
    # Python 框架默认会处理普通链接，这里生成的是标准直连链接
    link = f"https://t.me/proxy?server={ip}&port={PORT}&secret={SECRET_HEX}"
    
    print("\n\033[32m====================================================\033[0m")
    print("\033[36m🛡️  Python 赞助频道代理部署就绪\033[0m")
    print(f"\033[33m🔗 你的直连链接:\033[0m")
    print(f"\033[1m\033[34m{link}\033[0m")
    print("\033[32m----------------------------------------------------\033[0m")
    print(f"📍 IP: {ip} | 🔢 Port: {PORT}")
    print(f"🔑 Secret: {SECRET_HEX}")
    print(f"🏷️  已加载赞助频道 Tag: {AD_TAG if AD_TAG else '未设置'}")
    print("\033[32m====================================================\033[0m\n")
    print("🚀 正在启动代理服务...")

    # 启动代理主程序
    subprocess.run([sys.executable, "mtprotoproxy.py"])

if __name__ == "__main__":
    main()
