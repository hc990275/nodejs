# Kata-Tunnel 架构排坑与经验沉淀报告 (Error Report)

## [BUG-001] Node.js HTTP 响应头 ERR_INVALID_CHAR 中文字符异常
- **问题现象**：
  服务端控制台报错：
  `TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["Content-Disposition"] at ServerResponse.writeHead`。
  用户订阅请求直接被异常中断。
- **根本原因**：
  在下发订阅文件时，代码使用 `Content-Disposition: attachment; filename="clash_${user.username}.yaml"`。当用户注册的用户名为中文字符（如“淡蓝泡泡”）时，其 Unicode 字符码点超过了 HTTP Header 规范允许的 ByteString 范围（0x00 - 0xFF），导致 Node.js `_http_outgoing.js` 抛出硬性 TypeError 异常。
- **解决方案**：
  严格遵循 RFC 5987 / RFC 6266 标准：
  对非 ASCII 字符执行 `encodeURIComponent`，并使用双字段兜底方案：
  `attachment; filename="${asciiName}.yaml"; filename*=UTF-8''${safeName}.yaml`。
  确保传给 Node.js 响应头的字段值 100% 为合法 ASCII 字符，彻底解决多语言用户名支持问题。

---

## [BUG-002] 服务端模板字符串嵌套致使前端客户端出现正则表达式与单引号 SyntaxError
- **问题现象**：
  管理后台或前台首页加载后，所有按钮点击失效，表单无法提交，数据无法载入。
- **根本原因**：
  Node.js 服务端使用反引号模板字符串直接渲染包含 `<script>` 的 HTML 时：
  1. 正则表达式 `/\r?\n/` 中的 `\r` 和 `\n` 被提前解释为真实的回车换行，造成浏览器收到的 JS 代码中正则表达式断行，抛出 `SyntaxError: Invalid regular expression: missing /`；
  2. HTML 属性内拼接的转义单引号 `\'` 在服务端外层模板字符串中被吃掉反斜杠，输出到浏览器时变成了连续未闭合单引号，抛出 `SyntaxError: Unexpected string`。
- **解决方案**：
  1. 彻底禁止在内嵌客户端脚本中使用未转义的跨行字符与模板字符串；
  2. 换行与回车改用标准纯 JavaScript 函数 `String.fromCharCode(10)` 与 `String.fromCharCode(13)`；
  3. 属性绑定改用 HTML5 标准 `data-uuid` 与 `this.dataset.uuid`，完全摆脱在 HTML 属性中拼接单引号的风险。

---

## [BUG-003] 前台节点明文弹窗未做 Base64 自动解密
- **问题现象**：
  前台点击「👁️ 节点明文」弹窗提示“未解析到节点配置”。
- **根本原因**：
  订阅接口 `/sub` 对通用浏览器客户端下发的是经过 Base64 编码的聚合节点池，前端直接按 `vless://` 前缀按行筛选，匹配数为 0。
- **解决方案**：
  在前端 `showNodeModal` 中加入智能 Base64 自动探测与解码还原机制，利用 `atob` 与 UTF-8 编码器先解码再拆分行，成功还原全量 18 个可用节点的卡片与一键复制功能。

---

## [BUG-004] 翼龙面板 (Pterodactyl) / Docker 容器服务自愈重启退出码陷阱
- **问题现象**：
  通过 `/admin/api/restart` 接口触发平滑重启后，服务器端口持续报 `HTTP 502 Bad Gateway`，容器状态转为 Stopped 而未自动恢复。
- **根本原因**：
  原重启代码使用了 `process.exit(0)`。在 Docker 和翼龙面板的守护策略中（默认 `restart: on-failure`），退出码 0 代表“正常关机 / 维护下线”，守护进程不会主动拉起正常退出的容器；只有非 0 退出码（如异常退出）才会被判定为崩溃并立即触发自愈拉起。
- **解决方案**：
  将内部重启指令由 `process.exit(0)` 更改为 `process.exit(1)`。当翼龙平台守护捕获到非零退出码后，可在 1 秒内毫秒级重新启动 Node.js 核心容器，完美实现无人值守的平滑代码热重载。

