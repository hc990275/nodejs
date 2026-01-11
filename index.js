const { execSync } = require('child_process');
const fs = require('fs');

// 1. 自动获取 Lunes Host 或系统分配的端口
// 如果都没有，默认使用 3000
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

console.log(`\n=== [Kata-Node for Lunes] 远程安装模式 ===`);
console.log(`[目标端口] ${PORT}`);

// 2. 检查是否已经安装过 (通过检查 start.sh 是否存在)
if (fs.existsSync('./start.sh')) {
    console.log('[状态] 检测到已安装，正在启动服务...');
    try {
        // 直接启动
        execSync('bash start.sh', { stdio: 'inherit' });
    } catch (err) {
        console.error('[错误] 服务启动中断或崩溃，请检查日志。');
    }
} else {
    // 3. 初次安装逻辑：下载并执行远程脚本
    console.log('[状态] 未检测到配置文件，准备从 GitHub 下载安装脚本...');
    
    // 你的 GitHub 脚本 Raw 地址
    const REMOTE_SCRIPT_URL = "https://raw.githubusercontent.com/hc990275/kata-new-nodejs/lunes/install.sh";
    const INSTALL_FILE = "install.sh";

    try {
        // 步骤 A: 下载脚本
        // 使用 curl -sL (静默+跟随重定向) 下载到本地 install.sh
        console.log(`[下载] 正在拉取: ${REMOTE_SCRIPT_URL}`);
        execSync(`curl -sL -o ${INSTALL_FILE} ${REMOTE_SCRIPT_URL}`, { stdio: 'inherit' });

        // 步骤 B: 赋予执行权限
        console.log('[配置] 赋予脚本执行权限...');
        execSync(`chmod +x ${INSTALL_FILE}`, { stdio: 'inherit' });

        // 步骤 C: 执行安装脚本，并传入端口号
        // 注意：这里使用 bash 直接运行，并传入 PORT 变量
        console.log(`[安装] 开始执行安装脚本，端口: ${PORT}...`);
        execSync(`./${INSTALL_FILE} "${PORT}"`, { 
            stdio: 'inherit', 
            shell: '/bin/bash' 
        });

    } catch (error) {
        // 如果安装脚本最后启动了服务（npm start 或循环），execSync 可能会在这里等待或报错，这是正常的
        console.log('[提示] 安装脚本执行结束或已接管进程。如果服务器显示 Running，请忽略此消息。');
    }
}
