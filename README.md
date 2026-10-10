在微信里和你的 dot 聊天。

[下载安装包（准备中）](https://github.com/Yugo616/wechat-dot/releases)

免费开源，运行在你的 Mac 或 Windows 电脑上。连接你已有的 ChatGPT dot，不需要另购 API 或租服务器。

安装包发布后，只需三步：

1. 下载并打开安装包。
2. 扫微信二维码，登录 ChatGPT。
3. 点击「开始连接」。

不用装浏览器扩展、Node，也不用填写 API Key。程序会打开电脑上的 Chrome 或 Edge 完成登录。

![WeChat Dot 实际界面](assets/screenshot.png)

文字、连续对话、dot 主动消息已在 Mac 上实测。图片、文件、语音输入已接入，真实收发仍在测试。详细进度见[验证记录](docs/testing.md)。

### 电脑要一直开着吗？

要。程序平时留在 Mac 菜单栏或 Windows 托盘里；点击图标可以暂停或退出。关闭连接窗口不会停止收发。

### 用的是我原来的 dot 吗？

是，连接你已有的 dot，接着原来的上下文聊。

### 首次打开被系统拦住怎么办？

当前安装包尚未签名。macOS 在「系统设置 → 隐私与安全性」中选择「仍要打开」；Windows 点击「更多信息 → 仍要运行」。

### 登录过期了怎么办？

微信在程序里重新扫码；ChatGPT 在打开的浏览器中登录后，点「登录完成」。登录数据只保存在这台电脑上。

[开发说明](docs/development.md) · [上游版权](THIRD_PARTY_NOTICES.md) · [MIT](LICENSE)
