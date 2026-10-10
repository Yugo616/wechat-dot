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

`check` 跑类型检查、单元测试和编译；`smoke` 打开真实窗口；`desktop.mjs` 用临时目录和本地接口验证文字、媒体、去重、重启、主动回复和托盘运行。

程序使用系统的应用数据目录。里面的 `state.json` 保存微信凭据、dot 标识、消息队列和收取位置。Chrome／Edge 使用其中的 `ChatGPT Browser` 独立资料目录保存登录，不读取日常浏览器的登录数据。发布目录只包含程序资源。

通常不用改配置。需要调试时，把 `config/example.json` 复制到应用数据目录，命名为 `config.json`。默认地址、超时和限制都在 `config/defaults.json`。

## 微信

`src/weixin` 从腾讯的 MIT 插件拆出所需协议，没有 OpenClaw 依赖。扫码取得账号和接收上下文；长轮询保存游标；发送沿用该上下文。数字消息 ID 按字符串解析。

## dot

`src/dot/client.ts` 集中处理网页适配。默认使用普通 Chrome／Edge 的独立窗口。登录阶段不启用调试连接；点击「登录完成」后，程序用同一份浏览器资料连接自己的窗口。页面操作集中在 `src/dot/page.ts`，发送走网页原来的输入框和按钮。

程序观察原始请求 ID 和响应，完整回复才进入微信发送队列。暂停状态下重启只打开连接设置；只有上次仍在连接时，才自动恢复浏览器和收发。无需 API Key、中转服务器或安装扩展。

录入完成后先核对输入内容并等待发送按钮可用，再持久化提交状态。上传或录入阶段出错仍可重试，只有实际点击提交后的不确定结果才需要核对。准备过的文字和本机文件会保留；自己留下的附件草稿核对后重新准备，不覆盖用户修改过的草稿。

接口结构参考本机 ChatGPT 26.1002.52244 的客户端资源。适配器没有复制或打包这些资源。当前路径见配置；线上兼容性以验证记录为准。

2026-10-08，独立浏览器实测曾反复遇到人机验证，平常的 Chrome 可以正常打开原 dot。2026-10-09 按确认的免费本地方案恢复普通浏览器入口；用户已完成独立 Chrome 登录，程序已识别原有 dot，真实收发继续验证。遇到 HTTP 401／403 时暂停连接和自动识别，保留消息队列，等待用户明确操作。

2026-10-09 网页只读检查确认：旧 `/dots/{threadId}` 地址会跳转到 `/dots/home`，繁体中文界面的发送按钮为 `aria-label="傳送"`，没有旧的 `data-testid`。默认页面地址和按钮选择器已对应更新；本地测试覆盖跳转、真实可编辑输入框和繁体中文按钮。

同日，实际启动连接时，消息接口返回 HTTP 422：`query.limit` 最大为 32。分页默认值从 50 改为原客户端使用的 20，并在本地接口测试中加入这个上限。

## 媒体

微信图片、文件和语音按上游 AES-128-ECB 格式解密。语音优先用微信转写；缺少文字时用 `silk-wasm` 解码成 WAV，提交当前 ChatGPT 会话的 `/transcribe`。上传附件使用网页原生文件输入框，观察 `/messaging/rooms/{roomId}/files` 的结果，再通过原来的发送按钮提交。

dot 回复中的文件从文件元数据取得下载地址，生成图片保留媒体地址。下载后的本机文件和微信上传结果持久化，失败重试不依赖原下载地址继续有效。缓存位于系统应用数据目录的 `media` 中；启动时清理过期文件，保留所有未完成队列引用的文件。地址、大小、保留时间和等待时间集中在默认配置。

## 窗口与后台运行

首次打开显示连接窗口。开始连接后收起；再次启动时，如果上次仍在连接，就在后台恢复。菜单栏／托盘提供连接设置、暂停、重新登录和退出。窗口随二维码、登录提示和错误内容调整高度，边界配置在 `desktop` 中。

旧 Chrome 扩展的源文件位于 `src/extension`，仅保留作开发对照；它不是默认连接方式。内嵌模式用于本地接口测试。

这套扩展流程仅用于开发验证，不是用户安装方案。调试时，在 Chrome 的 `chrome://extensions` 开启开发者模式，加载 `dist/extension`，再在扩展里连接本地程序。正式安装不能要求用户做这些操作。

2026-10-08 重新核对安装限制：[Chrome 官方文档](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)要求 macOS／Windows 的常规扩展分发使用 Chrome Web Store，即使由其他软件协助安装也需要用户确认。把未上架扩展放进安装包，不能自动变成普通用户可直接安装的版本。

OpenAI 的 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source)允许开源程序通过系统浏览器授权使用 ChatGPT 套餐，但明确不授予原有聊天及其他账户上下文。[支持的调用入口](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)是 Responses API，不是 ChatGPT backend-api。因此不能把这个登录流程直接当成已验证的原有 dot 接入，也不能用一个新建聊天替代用户原来的 dot。

## 能否直接绑定本机 ChatGPT

2026-10-09 检查了本机 ChatGPT 26.1007.21159 的安装信息、链接路由和本地通信代码。`codex://dots` 可以打开 dot 入口；已检查的路由没有发送文字和订阅回复的方法。本地管道用于客户端工具和浏览器协作，目前没有找到供本项目直接绑定 dot 的消息入口。这次只检查程序资源，没有进行客户端收发实测，也没有实现新的连接方式。

[dot 的电脑连接说明](https://learn.chatgpt.com/docs/dots/computers-and-apps)区分了消息渠道与电脑访问：dot 运行在云端，连接电脑是让它使用本机文件、应用和任务。自动找到 ChatGPT 安装位置，只能完成程序发现，不能证明可以转发微信消息。

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
