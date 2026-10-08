import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { gt, valid } from 'semver';
import { loadConfig } from './config';
import { StateStore } from './state';
import { WeixinClient } from './weixin/client';
import { DotClient } from './dot/client';
import { DotAccessError } from './dot/errors';
import { sameDotConnection } from './dot/profile';
import { Bridge } from './bridge';
import type { AppStatus } from './types';

app.setName('WeChat Dot');
if (process.env.WECHAT_DOT_DATA) app.setPath('userData', process.env.WECHAT_DOT_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else void run().catch(e => { console.error(e.message); app.quit(); });

async function run(): Promise<void> {
  await app.whenReady();
  const config = await loadConfig(app.getAppPath(), app.getPath('userData'));
  const store = new StateStore(app.getPath('userData')); await store.load();
  const weixin = new WeixinClient(config.weixin, app.getVersion(), store.data.weixin);
  const dot = new DotClient(config.dot);
  let quitting = false, qrController: AbortController | undefined, verifyCode = '', discoveryBusy = false;
  let status: AppStatus = { weixin: store.data.weixin ? 'ready' : 'idle', dot: 'idle', running: false,
    weixinDetail: store.data.weixin ? '微信已登录' : '用手机微信扫码', dotDetail: config.dot.browser === 'extension' ? '使用平常 Chrome 里的账号' : '在浏览器中登录 ChatGPT', detail: '先连接微信和 ChatGPT。', version: app.getVersion(), extension: config.dot.browser === 'extension' };
  const resumeInBackground = Boolean(store.data.enabled && store.data.weixin && store.data.dot);
  const window = new BrowserWindow({ width: config.desktop.windowWidth, height: config.desktop.minContentHeight, useContentSize: true,
    show: false, resizable: false, maximizable: false, fullscreenable: false, title: 'WeChat Dot', backgroundColor: '#f5f5f5',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  if (process.platform === 'darwin') void app.dock?.hide();
  const trayIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'tray.png'));
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  const tray = new Tray(trayIcon); tray.setToolTip('WeChat Dot');
  const show = () => { window.show(); window.focus(); };
  window.once('ready-to-show', () => { if (!resumeInBackground) show(); });
  function publish(patch: Partial<AppStatus>): void {
    const wasRunning = status.running;
    const hadDotError = status.dot === 'error';
    status = { ...status, ...patch };
    if (!window.isDestroyed()) window.webContents.send('status', status);
    const needsAttention = Boolean(status.problem || status.needsReview || status.weixin === 'error' || status.dot === 'error');
    const title = needsAttention ? '需要处理' : status.running ? '已连接' : '未连接';
    tray.setToolTip(`WeChat Dot · ${title}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: title, enabled: false },
      { label: '连接设置…', click: show },
      { label: status.running ? '暂停连接' : '开始连接', enabled: status.running || (status.weixin === 'ready' && status.dot === 'ready'), click: () => { void action(status.running ? 'pause' : 'start'); } },
      { type: 'separator' },
      { label: '打开 dot', enabled: status.dot === 'ready', click: () => { void action('show-dot'); } },
      { label: '重新登录', submenu: [
        { label: '微信', click: () => { show(); void action('weixin'); } },
        { label: 'ChatGPT', click: () => { show(); void action('dot'); } }
      ] },
      { label: status.updateUrl ? '下载新版本…' : '检查更新…', click: () => { void action('download'); } },
      { type: 'separator' }, { label: '退出 WeChat Dot', click: () => app.quit() }
    ]));
    if (status.running && !wasRunning) {
      window.hide();
      void dot.window?.hide().catch(() => {});
    }
    if (status.dot === 'error' && !hadDotError) show();
  }
  const bridge = new Bridge(store, weixin, dot, config, publish);
  window.on('close', e => { if (!quitting) { e.preventDefault(); window.hide(); } });
  app.on('second-instance', show); app.on('activate', show);
  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault(); quitting = true; qrController?.abort();
    void dot.dispose().finally(() => app.quit());
  });
  dot.on('problem', e => publish({ problem: e.message }));

  async function discover(): Promise<void> {
    if (discoveryBusy || !dot.window) return;
    discoveryBusy = true;
    try {
      const profile = await dot.discover();
      const previous = store.data.dot;
      if (previous && !sameDotConnection(previous, profile)) {
        await bridge.pause();
      }
      await store.connectDot(profile);
      dot.profile = store.data.dot;
      publish({ dot: 'ready', dotName: profile.name, dotDetail: profile.name, detail: '准备好了，点击开始连接。', problem: undefined });
      if (store.data.enabled && store.data.weixin && !status.running) await bridge.start();
    } catch (e) {
      if (e instanceof DotAccessError) {
        await bridge.pause();
        publish({ dot: 'error', dotDetail: e.message, problem: e.message });
      } else publish({ dot: 'waiting', dotDetail: (e as Error).message });
    }
    finally { discoveryBusy = false; }
  }
  dot.on('loaded', () => { if (status.dot === 'waiting') void discover(); });
  const discoveryTimer = setInterval(() => { if (status.dot === 'waiting') void discover(); }, config.dot.pollIntervalMs);
  app.on('will-quit', () => clearInterval(discoveryTimer));

  async function loginWeixin(): Promise<void> {
    await bridge.pause();
    qrController?.abort(); const controller = qrController = new AbortController();
    publish({ weixin: 'waiting', qr: undefined, weixinDetail: '正在获取二维码…', problem: undefined });
    try {
      const qr = await weixin.request('/ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(config.weixin.botType), { local_token_list: [] }, { baseUrl: config.weixin.baseUrl, anonymous: true, signal: controller.signal });
      publish({ qr: await QRCode.toDataURL(qr.qrcode_img_content, { width: 230, margin: 1 }), weixinDetail: '用微信扫一扫，再在手机上确认' });
      let baseUrl = config.weixin.baseUrl;
      while (!controller.signal.aborted) {
        const query = new URLSearchParams({ qrcode: qr.qrcode });
        if (verifyCode) { query.set('verify_code', verifyCode); verifyCode = ''; }
        const value = await weixin.request('/ilink/bot/get_qrcode_status?' + query, undefined, { baseUrl, anonymous: true, signal: controller.signal, timeout: config.weixin.longPollTimeoutMs }).catch(e => {
          if (e.name === 'TimeoutError') return { status: 'wait' }; throw e;
        });
        if (value.status === 'confirmed') {
          if (!value.bot_token || !value.ilink_user_id || !value.ilink_bot_id) throw new Error('微信没有返回完整登录信息，请重新扫码。');
          const account = { token: value.bot_token, userId: value.ilink_user_id, botId: value.ilink_bot_id, baseUrl: value.baseurl || baseUrl };
          await store.connectWeixin(account);
          weixin.account = account;
          publish({ qr: undefined, verifyRequired: false, weixinDetail: '正在同步微信…' });
          await bridge.primeWeixin(controller.signal);
          publish({ weixin: 'ready', weixinDetail: '微信已连接', detail: '微信已准备好。' });
          return;
        }
        if (value.status === 'expired') throw new Error('二维码已过期，请点击重新扫码。');
        if (value.status === 'verify_code_blocked') throw new Error('配对码尝试次数过多，请稍后重新扫码。');
        if (value.status === 'need_verifycode') publish({ verifyRequired: true, weixinDetail: '请输入手机上显示的配对码' });
        if (value.status === 'scaned') publish({ weixinDetail: '已扫码，请在手机上确认' });
        if (value.status === 'scaned_but_redirect' && value.redirect_host) baseUrl = `https://${value.redirect_host}`;
        if (value.status === 'binded_redirect') throw new Error('这个微信已绑定，请在手机上选择重新连接后再扫码。');
        await delay(config.weixin.retryDelayMs, undefined, { signal: controller.signal });
      }
    } catch (e) { if (!controller.signal.aborted) publish({ weixin: 'error', weixinDetail: (e as Error).message, qr: undefined }); }
  }
  async function action(name: string, value?: string): Promise<void> {
    try {
      if (name === 'weixin') { void loginWeixin(); return; }
      if (name === 'verify') { verifyCode = value?.trim() ?? ''; return; }
      if (name === 'dot') {
        await bridge.pause(); publish({ dot: 'waiting', dotDetail: '请在浏览器中完成 ChatGPT 登录', problem: undefined });
        const manual = await dot.login();
        publish({ finishLogin: manual, dotDetail: status.extension ? '打开 Chrome 扩展，点击「连接 dot」' : manual ? '登录后，点击下方「登录完成」' : '请在 ChatGPT 窗口完成登录' });
        if (!manual) await discover();
      }
      if (name === 'finish-login') { await dot.finishLogin(); publish({ finishLogin: false }); await discover(); }
      if (name === 'show-dot') await dot.showConversation();
      if (name === 'discover') await discover();
      if (name === 'extension') {
        if (!dot.window) {
          publish({ dot: 'waiting', dotDetail: '打开 Chrome 扩展，点击「连接 dot」' });
          await dot.open(false);
        }
        const directory = app.isPackaged ? join(process.resourcesPath, 'chrome-extension') : join(app.getAppPath(), 'dist', 'extension');
        await shell.openPath(directory);
        publish({ detail: '在 Chrome 扩展页打开「开发者模式」，点击「加载已解压的扩展」，选择这个文件夹。' });
      }
      if (name === 'start') { publish({ problem: undefined }); await bridge.start(); }
      if (name === 'pause') await bridge.pause();
      if (name === 'received' || name === 'retry') await bridge.resolveUncertain(name === 'retry');
      if (name === 'download') await shell.openExternal(config.updates.releaseUrl);
      if (name === 'quit') app.quit();
    } catch (e) { publish({ problem: (e as Error).message }); show(); }
  }
  ipcMain.handle('status', () => status);
  ipcMain.handle('action', (event, name, value) => {
    if (event.sender !== window.webContents) return;
    return action(name, value);
  });
  ipcMain.on('resize', (event, height) => {
    if (event.sender !== window.webContents || !Number.isFinite(height)) return;
    const display = screen.getDisplayMatching(window.getBounds());
    const frameHeight = window.getBounds().height - window.getContentBounds().height;
    const maxHeight = Math.min(config.desktop.maxContentHeight, display.workArea.height - frameHeight);
    window.setContentSize(config.desktop.windowWidth, Math.max(config.desktop.minContentHeight, Math.min(Math.ceil(height), maxHeight)));
    const bounds = window.getBounds();
    if (bounds.y + bounds.height > display.workArea.y + display.workArea.height) window.setPosition(bounds.x, Math.max(display.workArea.y, display.workArea.y + display.workArea.height - bounds.height));
  });
  await window.loadFile(join(__dirname, 'index.html'));
  publish({});
  void fetch(config.updates.apiUrl, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(config.updates.timeoutMs) })
    .then(r => r.ok ? r.json() : []).then(releases => {
      const newer = Array.isArray(releases) && releases.find(r => !r.draft && valid(r.tag_name) && gt(r.tag_name, app.getVersion()));
      if (newer) publish({ updateUrl: config.updates.releaseUrl });
    }).catch(() => {});
  if (store.data.dot) {
    publish({ dot: 'waiting', dotDetail: '正在恢复 ChatGPT 登录…' });
    try { await dot.open(false); }
    catch (e) { publish({ dot: 'error', dotDetail: (e as Error).message }); show(); }
  }
}
