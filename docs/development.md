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

程序使用系统的应用数据目录。里面的 `state.json` 保存微信凭据、dot 标识、消息队列和收取位置。ChatGPT 登录由使用者平常的 Chrome 保存。旧版留下的 `ChatGPT Browser` 资料会保留，扩展不读取它。发布目录只包含程序资源。

通常不用改配置。需要调试时，把 `config/example.json` 复制到应用数据目录，命名为 `config.json`。默认地址、超时和限制都在 `config/defaults.json`。

## 微信

`src/weixin` 从腾讯的 MIT 插件拆出所需协议，没有 OpenClaw 依赖。扫码取得账号和接收上下文；长轮询保存游标；发送沿用该上下文。数字消息 ID 按字符串解析。

## dot

`src/dot/client.ts` 集中处理网页适配。默认通过 Chrome 扩展使用现有登录状态。扩展创建自己的 ChatGPT 标签页；本地程序通过回环 WebSocket 请求读取 dot、检查输入框或发送文字。页面操作集中在 `src/dot/page.ts`，扩展执行打包好的方法，不接收任意脚本。

扩展只申请 ChatGPT 网站权限，消息监听只在 dot 页面运行，并只转发自己创建的标签页。连接地址、扩展公钥和超时在配置中。服务只监听 `127.0.0.1`，只接受对应扩展 Origin。会话信息仅在这台电脑的 Chrome 与程序之间传递；没有中转服务器。

发送仍使用网页输入框和发送按钮，由原网页准备请求。扩展观察原始请求 ID 和响应，完整回复才进入微信发送队列。程序重启后扩展会自动重连，通常在一分钟内。

接口结构参考本机 ChatGPT 26.1002.52244 的客户端资源。适配器没有复制或打包这些资源。当前路径见配置；线上兼容性以验证记录为准。

2026-10-08，独立浏览器实测反复遇到人机验证，平常的 Chrome 可以正常打开原 dot。因此默认改用扩展；真实收发仍待验证。遇到 HTTP 401／403 时暂停连接和自动识别，保留消息队列，等待用户明确操作。

## 窗口与后台运行

首次打开显示连接窗口。开始连接后收起；再次启动时，如果上次仍在连接，就在后台恢复。菜单栏／托盘提供连接设置、暂停、重新登录和退出。窗口随二维码、登录提示和错误内容调整高度，边界配置在 `desktop` 中。

Chrome 扩展的源文件位于 `src/extension`，构建输出在 `dist/extension`，安装包同时携带可加载的扩展文件夹。扩展尚未上架，开发版需要手动加载；还不能称为一键安装。旧的独立浏览器适配保留供排查，内嵌模式用于本地接口测试，两者都不是默认登录入口。

这套扩展流程仅用于开发验证，不是用户安装方案。调试时，在 Chrome 的 `chrome://extensions` 开启开发者模式，加载 `dist/extension`，再在扩展里连接本地程序。正式安装不能要求用户做这些操作。

2026-10-08 重新核对安装限制：[Chrome 官方文档](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)要求 macOS／Windows 的常规扩展分发使用 Chrome Web Store，即使由其他软件协助安装也需要用户确认。把未上架扩展放进安装包，不能自动变成普通用户可直接安装的版本。

OpenAI 的 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)允许开源程序通过系统浏览器授权使用 ChatGPT 套餐，但明确不授予原有聊天及其他账户上下文。[支持的调用入口](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)是 Responses API，不是 ChatGPT backend-api。因此不能把这个登录流程直接当成已验证的原有 dot 接入，也不能用一个新建聊天替代用户原来的 dot。

## 为什么当前没有改成 ChatGPT 插件

2026-10-08 已检查当前账号的自定义 MCP 入口。官方 [MCP Events](https://developers.openai.com/plugins/build/mcp-events) 支持向 dot 推送事件，但[接入 ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) 需要公网 HTTPS 服务或 Secure MCP Tunnel。[官方通道](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) 还需要 Platform 通道 ID 和运行凭据。直接把本地桥接包成插件，会增加服务部署或通道配置，暂时不能满足本项目的三步安装。

Chrome 扩展和 ChatGPT MCP 插件是不同入口。MCP Events 仍是待验证的替代方案；仅把代码放进插件目录不能提供云端 dot 的事件入口。[插件打包文档](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks) 要求远程 HTTPS 服务；本地 MCP 支持需要另外联系 OpenAI。未实现或验证 MCP Events 收发，也没有加入中转服务或要求使用者配置 API Key。

扩展实现参考 Chrome 的[页面脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)和[后台 WebSocket](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)文档。测试使用临时浏览器资料及只允许 localhost 的临时扩展：

```sh
npx playwright-core install chromium
WECHAT_DOT_TEST_BROWSER=extension node tests/desktop.mjs
```

## 发布

推送 `v` 开头的版本标签后，GitHub Actions 构建 macOS Apple Silicon、macOS Intel 和 Windows x64 安装包。包含 `-alpha` 的版本自动发布为预览版。

```sh
npm version prerelease --preid alpha
git push --follow-tags
```

未配置签名时提供未签名安装包。首次打开步骤放在 README。
