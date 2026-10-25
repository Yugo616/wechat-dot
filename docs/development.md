# 开发

需要 Node.js 22.12 以上、Rust stable 和对应系统的编译工具（Mac 使用 Xcode Command Line Tools，Windows 使用 Visual Studio C++ Build Tools）。正式程序不需要用户安装这些工具。

```sh
npm ci
npm start
```

```sh
npm run check
npm run smoke
node tests/desktop.mjs
node tests/backlog-ui.mjs
npm run release:native
```

`npm start` 保留 Electron 作为开发测试窗口。正式分发使用 `npm run build:native` 构建 Tauri 窗口和自带 Node 的后台；`npm run release:native` 生成安装包。

`check` 跑类型检查、单元测试和编译；`smoke` 打开真实窗口；`desktop.mjs` 用临时目录和本地接口验证文字、媒体、去重、重启、主动回复和托盘运行。

图标源文件是 `assets/icon.svg` 和 `assets/tray.svg`。修改后运行 `npm run icons`，再打包。应用、Dock、Windows 桌面／任务栏和安装器使用同一份带透明边距的图标；菜单栏／托盘使用单色小图标。

程序使用系统的应用数据目录。里面的 `state.json` 保存微信凭据、dot 标识、消息队列和收取位置。专用浏览器位于 `Browser Runtime`，登录资料位于配置指定的 `ChatGPT Browser v2`。不读取日常浏览器的资料，也不迁移旧 Chrome 的加密凭据。发布目录只包含程序资源。

通常不用改配置。需要调试时，把 `config/example.json` 复制到应用数据目录，命名为 `config.json`。默认地址、超时和限制都在 `config/defaults.json`。

## 微信

`src/weixin` 从腾讯的 MIT 插件拆出所需协议，没有 OpenClaw 依赖。扫码取得账号和接收上下文；长轮询保存游标；发送沿用该上下文。数字消息 ID 按字符串解析。

## dot

`src/dot/client.ts` 集中处理网页适配。`src/dot/runtime.ts` 从 Google 官方地址下载独立的 [Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)，版本、平台、路径和等待时间在默认配置里。下载与解压完成后才写入可用标记；中断会清理临时文件，重试完成后复用缓存。Windows 使用浏览器自带的 `setup.exe` 配置沙盒目录权限。

不再查找或启动用户安装的 Chrome／Edge。单独的资料目录不能隔离 macOS 应用身份：旧版本退出普通 Chrome 后，Dock 会把后续打开请求送到仍运行的专用资料实例。现在两者使用不同的应用程序和资料目录；新版本也不会连接旧实例留下的调试端口。

登录和转发共用同一个普通浏览器窗口；点击「登录完成」不会关闭窗口或切换调试模式。安装包内置页面连接组件，程序自动装入自己的 Chrome for Testing，无需用户安装扩展。连接组件通过本机随机端口通信，每次启动生成新的连接令牌，令牌只保存在扩展自己的文件中，不注入网页。异常退出后重新读取连接信息，复用仍打开的页面。页面操作集中在 `src/dot/page.ts`，发送走网页原来的输入框和按钮。

Windows 浏览器作为独立子进程启动，避免程序意外退出时被一并结束；[Node 的进程说明](https://nodejs.org/api/child_process.html#optionsdetached)解释了这项平台差异。正常退出仍只关闭程序自己的浏览器。连接信息原子替换，Windows 临时占用文件时自动重试，暂停可取消等待。

程序观察原始请求 ID 和响应，完整回复才进入微信发送队列。暂停状态下重启只打开连接设置；只有上次仍在连接时，才自动恢复浏览器和收发。无需 API Key、中转服务器或安装扩展。

录入完成后先核对输入内容并等待发送按钮可用，再持久化提交状态。上传或录入阶段出错仍可重试，只有实际点击提交后的不确定结果才需要核对。准备过的文字和本机文件会保留；自己留下的附件草稿核对后重新准备，不覆盖用户修改过的草稿。

接口结构参考本机 ChatGPT 26.1002.52244 的客户端资源。适配器没有复制或打包这些资源。当前路径见配置；线上兼容性以验证记录为准。

2026-10-08，独立浏览器实测曾反复遇到人机验证，平常的 Chrome 可以正常打开原 dot。2026-10-09 按确认的免费本地方案恢复普通浏览器入口；用户已完成独立 Chrome 登录，程序已识别原有 dot，真实收发继续验证。遇到 HTTP 401／403 时暂停连接和自动识别，保留消息队列，等待用户明确操作。

2026-10-09 网页只读检查确认：旧 `/dots/{threadId}` 地址会跳转到 `/dots/home`，繁体中文界面的发送按钮为 `aria-label="傳送"`，没有旧的 `data-testid`。默认页面地址和按钮选择器已对应更新；本地测试覆盖跳转、真实可编辑输入框和繁体中文按钮。

同日，实际启动连接时，消息接口返回 HTTP 422：`query.limit` 最大为 32。分页默认值从 50 改为原客户端使用的 20，并在本地接口测试中加入这个上限。

## 待发送消息

待发送消息按产生时间保留最近 10 分钟，窗口由 `storage.maxBacklogAgeMs` 配置。缺少服务端时间时保存首次收到的时间，重启后不重新计时。过期只结束本机的转发工作，保留消息 ID 用于去重，不删除 dot 对话或重设收取位置。旧的未完成生成也会跳过，避免挡住后续回复。程序自己留下的过期输入草稿核对后清理，用户改过的草稿仍提示处理。

`src/backlog.ts` 从原队列生成暂存列表，不另建数据库。恢复保留原消息 ID、请求 ID 和已发送片段位置，以 `restoredAt` 重新计算 10 分钟；发送结果不确定的微信问题仍先核对原请求。未完成的 dot 回复重新加入待取列表，获得完整内容后才转发。操作携带账号组合和列表里的记录标识，账号切换或新消息到达不会误清其他记录。

清空移除暂存内容和附件引用，保留最小去重记录；程序仍需清理自己留下的输入草稿时，先保留这份草稿，处理完再释放内容。仍可恢复的附件不被日常清理删掉，旧版已经清掉缓存的附件恢复时重新获取。列表仅在打开或内容变化时读取；空收取结果和不变的微信游标不再写入状态文件。

微信收取、dot 收取、问题提交、文字回传、附件回传分别运行；同一方向的文字保持顺序。附件延迟不会阻塞文字和新问题。每次提交前再检查有效期，下载、上传和微信发送进度继续保存在本机；已确认的部分不重发。各项任务单独记录重试次数与下一次尝试时间，其他任务成功不会清掉它的失败状态。

## 媒体处理

微信图片、文件和语音按上游 AES-128-ECB 格式解密。语音优先用微信转写；缺少文字时用 `silk-wasm` 解码成 WAV，提交当前 ChatGPT 会话的 `/transcribe`。上传附件使用网页原生文件输入框，观察 `/messaging/rooms/{roomId}/files` 的结果，再通过原来的发送按钮提交。

dot 回复中的文件从文件元数据取得下载地址，生成图片保留媒体地址。下载后的本机文件和微信上传结果持久化，失败重试不依赖原下载地址继续有效。缓存位于系统应用数据目录的 `media` 中；启动时清理过期文件，保留所有未完成队列引用的文件。地址、大小、保留时间和等待时间集中在默认配置。

## 窗口与后台运行

首次打开显示设置窗口。账号的「已绑定」表示本机保存了账号资料，不表示消息正在转发。唯一的主开关是「开始转发／暂停转发」；开始时先检查当前 ChatGPT 会话，再启动收发。检查过程中可以暂停，迟到的检查结果不会恢复转发。

开始后窗口收起。再次启动时，上次正在转发才会在后台恢复；上次暂停则保留暂停，也不打开浏览器。浏览器意外断开会清理失效会话，正在转发时尝试使用原登录恢复，暂停时不自动重启。401／403 停止自动重试并显示具体原因。菜单栏／托盘与主窗口使用相同开关。窗口随二维码、登录提示和错误内容调整高度，边界配置在 `desktop` 中。

连接组件源码位于 `src/extension`，打包到应用资源目录 `browser-connection`，运行时由 `src/dot/extension-runtime.ts` 写入本机配置。Chrome for Testing 支持启动时加载该组件，[Chrome 扩展团队说明](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)区分了它与普通 Chrome 的扩展加载限制。内嵌模式用于本地接口测试。

显式配置 `dot.browser="extension"` 的手动扩展模式仅供开发验证，使用单独的固定端口；默认模式不接受这个旧连接。正式用户无需打开扩展设置。

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

从 1.2.0 起，安装包使用 Tauri 系统窗口，不再包含 Electron / Chromium 框架。`src/controller.ts` 管理原有业务；`src/native/backend.ts` 在随包提供的官方 Node 中运行，通过父子进程管道与窗口通信。窗口退出会关闭后台，后台异常退出会自动恢复。Mac 使用系统 WebKit，Windows 使用 WebView2；缺少 WebView2 时安装器自动运行微软官方引导程序。专用 Chrome for Testing 和用户资料继续使用原来的目录。

Node 的版本、下载来源和校验值在 `config/node-runtime.json`，Windows 显示组件在 `config/windows-runtime.json`。账号、路径和程序版本由当前安装动态获取。打包仍使用 electron-builder 的 prepackaged 模式，保持旧安装器、差分文件和更新入口兼容。

正式版只读取 GitHub 的稳定 Release。点击「检查更新」后下载，点击「重启更新」才安装。`electron-updater` 处理版本、差分和校验；Windows 用 NSIS 安装，Mac 校验 ZIP 内的应用标识和版本后替换应用包，成功启动后清理旧包。首次没有缓存时下载完整文件。

Mac M 系列、Intel 分别发布 `latest-arm64-mac.yml`、`latest-x64-mac.yml`，Windows 发布 `latest.yml`；安装包及 `.blockmap` 文件与它们放在同一个 Release。`native-package.mjs` 自动准备更新清单。`tests/native-updater.mjs` 检查完整与差分下载、校验失败和消息保留；`tests/legacy-app.mjs` 下载指定的旧正式版，配合 `WECHAT_DOT_UPDATE_NATIVE=1 node tests/updater.mjs` 验证旧 Electron 程序直接升级到原生程序。所有测试使用临时账号和目录。

`tests/native-browser.mjs` 使用安装包里的 Node 和独立浏览器检查文字、图片、文件、语音及主动消息；Mac 的 `tests/native-smoke.mjs` 检查系统窗口连接与退出清理，Windows 安装后运行 `tests/native-windows-ui.mjs` 操作真正的 WebView2 窗口。

推送 `v` 开头的版本标签后，GitHub Actions 构建 macOS Apple Silicon、macOS Intel 和 Windows x64 安装包。包含 `-alpha` 的版本自动发布为预览版。

```sh
npm version prerelease --preid alpha
git push --follow-tags
```

未配置签名时提供未签名安装包。首次打开步骤放在 README。
