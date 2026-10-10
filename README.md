在微信里和你的 dot 聊天。

[下载预览版](https://github.com/Yugo616/wechat-dot/releases/tag/v0.1.0-alpha.4)

免费开源，运行在你的 Mac 或 Windows 电脑上。连接你已有的 ChatGPT dot，不需要另购 API 或租服务器。

基于腾讯的 [openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) 改造，沿用微信扫码和消息收发，把原来连接 OpenClaw 的一端换成你自己的 ChatGPT dot。

安装只需三步：

1. 下载并打开安装包。
2. 扫微信二维码，登录 ChatGPT。
3. 点击「开始连接」。

电脑需已安装 Chrome 或 Edge，能正常打开 ChatGPT，账号中已有可用的 dot。不用装浏览器扩展、Node，也不用填写 API Key。

![WeChat Dot 实际界面](https://github.com/user-attachments/assets/a5f79a52-c400-4f8a-9c9d-2d0629c58e60)

文字、连续对话、dot 主动消息已在 Mac 上实测。图片、文件、语音输入已接入，真实收发仍在测试。详细进度见[验证记录](docs/testing.md)。

### 电脑要一直开着吗？

要保持开机、联网、不休眠。关机、休眠或退出程序后，微信和 dot 之间会停止收发。只关掉连接窗口没关系，程序仍在 Mac 菜单栏或 Windows 托盘里运行。

### 重新开机后，要重新扫码吗？

通常不用。当前版本不会开机自启，开机后打开 WeChat Dot 即可。上次处于连接状态、登录仍有效时，会自动恢复连接，接着原来的上下文聊。

如果之前主动点了「暂停连接」，程序不会自动恢复；按界面提示重新连接即可。登录资料保存在本机，不用每次扫码。

### 断网后会自动恢复吗？

短暂断网后，程序会继续尝试连接，联网后接着处理已保存的消息。如果界面提示登录过期，或要求核对某条消息，按提示处理即可。

### 用的是我原来的 dot 吗？

是，连接你已有的 dot，接着原来的上下文聊。

### 首次打开被系统拦住怎么办？

当前安装包尚未签名。macOS 在「系统设置 → 隐私与安全性」中选择「仍要打开」；Windows 点击「更多信息 → 仍要运行」。

### 登录过期了怎么办？

只需重新登录过期的那一端：微信重新扫码；ChatGPT 在打开的浏览器中登录后，点「登录完成」，再点「开始连接」。

[开发说明](docs/development.md) · [上游版权](THIRD_PARTY_NOTICES.md) · [MIT](LICENSE)
