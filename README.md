在微信里和你的 dot 聊天。

[安装包（尚未发布）](https://github.com/Yugo616/wechat-dot/releases)

1. 下载并打开：Mac 选 `.dmg`，Windows 选 `.exe`。
2. 用微信扫码，在弹出的 Chrome／Edge 窗口登录 ChatGPT，然后点「登录完成」。
3. 程序找到你的 dot 后，点击「开始连接」。

不需要装 Node，也不用填 API Key。

![程序实际截图](assets/screenshot.png)

目前是文字联调版：文字收发、dot 主动消息、暂停和重启恢复。图片、文件和语音接下来接入。真实账号联调进度见[验证记录](docs/testing.md)。

### 电脑要一直开着吗？

要。电脑需要在线。关闭窗口后程序仍在托盘运行；点「退出」才会停止。

### 用的是我原来的 dot 吗？

是，连接当前 ChatGPT 账号里的默认 dot。你需要先在 ChatGPT 里拥有一个能聊天的 dot。

### 首次打开被系统拦住怎么办？

当前安装包尚未签名。macOS 在「系统设置 → 隐私与安全性」中选择「仍要打开」；Windows 点击「更多信息 → 仍要运行」。

### Google 登录能用吗？

登录时使用电脑里的 Chrome 或 Edge。登录完成后，程序才连接这份独立会话。Mac 如未安装这两个浏览器，可先安装一个。

### 登录过期了怎么办？

在程序里点「重新扫码」或「重新登录」。登录数据只保存在这台电脑上。

[开发说明](docs/development.md) · [上游版权](THIRD_PARTY_NOTICES.md) · [MIT](LICENSE)
