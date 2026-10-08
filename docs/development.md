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

`check` 跑类型检查、单元测试和编译；`smoke` 打开真实窗口；`desktop.mjs` 用临时目录和本地接口验证文字、去重、重启及主动回复。

程序使用系统的应用数据目录。里面的 `state.json` 保存微信凭据、dot 标识、消息队列和收取位置，`ChatGPT Browser` 保存独立的 Chrome／Edge 会话（内嵌浏览器模式使用 `Partitions/chatgpt`）。发布目录只包含程序资源，不包含这些文件。

通常不用改配置。需要调试时，把 `config/example.json` 复制到应用数据目录，命名为 `config.json`。默认地址、超时和限制都在 `config/defaults.json`。

## 微信

`src/weixin` 从腾讯的 MIT 插件拆出所需协议，没有 OpenClaw 依赖。扫码取得账号和接收上下文；长轮询保存游标；发送沿用该上下文。数字消息 ID 按字符串解析。

## dot

`src/dot/client.ts` 集中处理网页适配。先通过独立 Chrome／Edge 资料正常登录，登录阶段不连接调试协议。使用者点击「登录完成」后，程序关闭该独立窗口，再用同一份资料连接浏览器，读取当前 dot 和消息房间。发消息时填写网页输入框并点击网页发送按钮；请求准备由原网页完成。程序观察请求 ID 和响应，完整回复才进入微信发送队列。

接口结构参考本机 ChatGPT 26.1002.52244 的客户端资源。适配器没有复制或打包这些资源。当前路径见配置；线上兼容性以验证记录为准。

## 发布

推送 `v` 开头的版本标签后，GitHub Actions 构建 macOS Apple Silicon、macOS Intel 和 Windows x64 安装包。包含 `-alpha` 的版本自动发布为预览版。

```sh
npm version prerelease --preid alpha
git push --follow-tags
```

未配置签名时提供未签名安装包。首次打开步骤放在 README。
