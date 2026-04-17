/**
 * 翼龙面板专用：Socks5 代理单文件自启动版
 * 修正了依赖检测顺序，防止 MODULE_NOT_FOUND 报错
 */

const { execSync } = require('child_process');
const fs = require('fs');

// --- 自定义配置区 ---
const MY_USER = "TG@robberer";    // 修改你的用户名
const MY_PASS = "TG@robberer";   // 修改你的密码
const PORT = process.env.SERVER_PORT || 1080; 
// -------------------

// 1. 强制依赖安装检查
if (!fs.existsSync('./node_modules/socksv5')) {
    console.log('----------------------------------------------------');
    console.log('检测到缺少必要组件，正在初始化环境...');
    console.log('这可能需要 10-30 秒，请稍候...');
    try {
        // 执行安装命令
        execSync('npm install socksv5 --no-audit --no-fund --quiet');
        console.log('组件安装成功！继续启动服务...');
        console.log('----------------------------------------------------');
    } catch (err) {
        console.error('组件安装失败，请检查容器网络是否通畅。');
        process.exit(1);
    }
}

// 2. 依赖安装完成后，再引用模块 (延迟加载)
const socks5 = require('socksv5');
const http = require('http');

// 3. 打印直连链接逻辑
function printTGLink(port, user, pass) {
    http.get({ host: 'api.ipify.org', port: 80, path: '/' }, (resp) => {
        resp.on('data', (ip) => {
            const publicIP = ip.toString();
            const link = `https://t.me/socks?server=${publicIP}&port=${port}&user=${user}&pass=${pass}`;
            
            console.log("\n\x1b[32m====================================================\x1b[0m");
            console.log("\x1b[36m🚀 TG 代理部署成功！\x1b[0m");
            console.log("\x1b[33m🔗 你的直连链接 (复制到 TG 即可使用):\x1b[0m");
            console.log("\x1b[1m\x1b[34m" + link + "\x1b[0m");
            console.log("\x1b[32m====================================================\x1b[0m\n");
        });
    }).on('error', () => {
        console.log(`\n[注意] 无法自动获取 IP，请手动填写 IP:`);
        console.log(`https://t.me/socks?server=你的服务器IP&port=${port}&user=${user}&pass=${pass}`);
    });
}

// 4. 启动代理服务
const srv = socks5.createServer((info, accept, deny) => {
    accept();
});

srv.useAuth(socks5.auth.UserPassword((user, pass, cb) => {
    if (user === MY_USER && pass === MY_PASS) return cb(true);
    cb(false);
}));

srv.listen(PORT, '0.0.0.0', () => {
    printTGLink(PORT, MY_USER, MY_PASS);
    console.log(`服务已在端口 ${PORT} 运行...`);
});

srv.on('error', (err) => {
    console.error(`运行异常: ${err.message}`);
});
