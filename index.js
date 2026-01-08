const { execSync } = require('child_process');

// 1. 自动获取 Katabump 或系统分配的端口
// 如果都没有，随机生成一个 (10000-65000)
const PORT = process.env.SERVER_PORT || process.env.PORT || Math.floor(Math.random() * (65000 - 10000 + 1)) + 10000;

console.log(`\n=== [Kata-Node] 自动安装模式 ===`);
console.log(`[目标端口] ${PORT}`);

try {
  // 2. 构造命令：echo 端口 | bash <(curl ...)
  // echo "${PORT}" 会自动回答脚本中的 "请输入端口" 提问
  const installCmd = `echo "${PORT}" | bash <(curl -sL https://raw.githubusercontent.com/hc990275/kata-nodejs/main/install.sh)`;

  console.log(`[执行操作] 正在拉取脚本并自动安装...`);
  
  // 3. 执行命令
  // 关键修正：shell: '/bin/bash' 解决了 "Syntax error"
  // 关键修正：stdio: 'inherit' 让我们可以看到脚本的输出
  execSync(installCmd, { 
    stdio: 'inherit', 
    shell: '/bin/bash' 
  });

} catch (error) {
  // 注意：安装脚本最后会运行 npm start，这可能会导致 execSync 这里的代码看起来像"卡住"或报错，
  // 但只要服务器跑起来了，这里的报错可以忽略。
  console.log('[提示] 安装脚本执行结束或接管了进程。如果服务器已显示 Running，请忽略此消息。');
}
