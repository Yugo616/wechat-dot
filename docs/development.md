# 开发

需要 Node.js 22.12 以上。

```sh
npm ci
npm start
```

```sh
npm run check
npm run smoke
node tests/desktop.mjs
npm run release
```

`check` 跑类型检查、单元测试和编译；`smoke` 打开真实窗口；`desktop.mjs` 用临时目录和本地接口验证文字、去重、重启、主动回复和托盘运行。

程序使用系统的应用数据目录。里面的 `state.json` 保存微信凭据、dot 标识、消息队列和收取位置，`ChatGPT Browser` 保存独立的 Chrome／Edge 会话（内嵌浏览器模式使用 `Partitions/chatgpt`）。发布目录只包含程序资源，不包含这些文件。

通常不用改配置。需要调试时，把 `config/example.json` 复制到应用数据目录，命名为 `config.json`。默认地址、超时和限制都在 `config/defaults.json`。

## 微信

`src/weixin` 从腾讯的 MIT 插件拆出所需协议，没有 OpenClaw 依赖。扫码取得账号和接收上下文；长轮询保存游标；发送沿用该上下文。数字消息 ID 按字符串解析。

## dot

`src/dot/client.ts` 集中处理网页适配。先通过独立 Chrome／Edge 资料正常登录，登录阶段不连接调试协议。使用者点击「登录完成」后，程序关闭该独立窗口，再用同一份资料连接浏览器，读取当前 dot 和消息房间。发消息时填写网页输入框并点击网页发送按钮；请求准备由原网页完成。程序观察请求 ID 和响应，完整回复才进入微信发送队列。

接口结构参考本机 ChatGPT 26.1002.52244 的客户端资源。适配器没有复制或打包这些资源。当前路径见配置；线上兼容性以验证记录为准。

## 窗口与后台运行

首次打开显示连接窗口。开始连接后收起；再次启动时，如果上次仍在连接，就在后台恢复。菜单栏／托盘提供连接设置、暂停、重新登录和退出。窗口随二维码、登录提示和错误内容调整高度，边界配置在 `desktop` 中。

默认使用普通 Chrome／Edge 登录，不再自动回退到会被 Google 拒绝的内嵌登录窗口。内嵌模式仍可用于本地接口测试。浏览器会话和桥接进程都运行在安装者电脑上；连接后专用浏览器最小化，打开 dot 时恢复。

## 为什么当前没有改成 ChatGPT 插件

2026-10-08 已检查当前账号的自定义 MCP 入口。官方 [MCP Events](https://developers.openai.com/plugins/build/mcp-events) 支持向 dot 推送事件，但[接入 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) 需要公网 HTTPS 服务或 Secure MCP Tunnel。[官方通道](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 还需要 Platform 通道 ID 和运行凭据。直接把本地桥接包成插件，会增加服务部署或通道配置，暂时不能满足本项目的三步安装。

本版保留本地桥接，缩小设置窗口。未实现或验证 MCP Events 收发，也没有要求使用者配置 API Key。后续若能提供无需额外配置的固定通道，再单独验证事件是否进入原有 dot、主动回复和附件能否正常往返。

## 发布

推送 `v` 开头的版本标签后，GitHub Actions 构建 macOS Apple Silicon、macOS Intel 和 Windows x64 安装包。包含 `-alpha` 的版本自动发布为预览版。

```sh
npm version prerelease --preid alpha
git push --follow-tags
```

未配置签名时提供未签名安装包。首次打开步骤放在 README。
