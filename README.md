在微信里和你的 dot 聊天。

[安装包（尚未发布）](https://github.com/Yugo616/wechat-dot/releases)

开发中，真实微信收发尚未跑通，暂不发布安装包。当前改用 Chrome 扩展连接，扩展还需手动加载。

1. 打开程序，点「安装 Chrome 扩展」加载扩展。
2. 用微信扫码；在平常的 Chrome 中登录 ChatGPT。
3. 扩展里点「连接 dot」，程序里点「开始连接」。

不需要装 Node，也不用填 API Key。

![程序实际截图](assets/screenshot.png)

文字收发、主动消息和重启恢复已通过本地模拟测试。图片、文件和语音尚未接入。真实账号进度见[验证记录](docs/testing.md)。

### 电脑要一直开着吗？

要，Chrome 也需要开着。程序平时留在 Mac 菜单栏或 Windows 托盘里；点击图标可以暂停或退出。关闭连接窗口不会停止收发。

### 用的是我原来的 dot 吗？

是，连接当前 ChatGPT 账号里的默认 dot。你需要先在 ChatGPT 里拥有一个能聊天的 dot。

### 首次打开被系统拦住怎么办？

当前安装包尚未签名。macOS 在「系统设置 → 隐私与安全性」中选择「仍要打开」；Windows 点击「更多信息 → 仍要运行」。

### 扩展怎么装？

扩展尚未上架。点「安装 Chrome 扩展」打开文件夹。在 Chrome 的 `chrome://extensions` 打开「开发者模式」，点「加载已解压的扩展」，选刚才的文件夹。只需要装一次。

### 还需要重新登录 ChatGPT 吗？

扩展使用平常 Chrome 里的登录状态。旧版的独立登录窗口反复要求人机验证，已经停用。扩展的真实账号收发还在验证。

### 登录过期了怎么办？

微信在程序里重新扫码；ChatGPT 在 Chrome 中正常登录后点「重新识别」。登录数据只保存在这台电脑上。

[开发说明](docs/development.md) · [上游版权](THIRD_PARTY_NOTICES.md) · [MIT](LICENSE)
