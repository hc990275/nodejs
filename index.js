const { execSync, spawn } = require('child_process');
const fs = require('fs');

// 1. 自动获取 Lunes Host 或系统分配的端口
// Lunes Host / Pterodactyl 通常使用 SERVER_PORT
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

console.log(`\n=== [Kata-Node for Lunes] 启动引导 ===`);
console.log(`[检测端口] ${PORT}`);

// 2. 检查是否已经安装过 (检查 start.sh 是否存在)
if (fs.existsSync('./start.sh')) {
    console.log('[状态] 检测到已安装，正在启动服务...');
    // 直接执行 start.sh
    try {
        execSync('bash start.sh', { stdio: 'inherit' });
    } catch (err) {
        console.error('[错误] 服务启动失败，可能需要重新安装。');
    }
} else {
    // 3. 初次安装逻辑
    console.log('[状态] 未检测到配置文件，准备执行安装脚本...');
    
    try {
        // 赋予 install.sh 执行权限
        execSync('chmod +x install.sh', { stdio: 'inherit' });

        // 执行本地 install.sh，并将端口作为参数传入
        // 使用 spawn 或 execSync 均可，这里用 execSync 以便在日志中看到输出
        execSync(`./install.sh "${PORT}"`, { 
            stdio: 'inherit', 
            shell: '/bin/bash' 
        });

    } catch (error) {
        console.error('[注意] 安装脚本执行完成或已接管进程。');
    }
}
