import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { gt, valid } from 'semver';
import { loadConfig } from './config';
import { StateStore } from './state';
import { WeixinClient } from './weixin/client';
import { DotClient } from './dot/client';
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
    weixinDetail: store.data.weixin ? '微信已登录' : '用手机微信扫码', dotDetail: '登录你自己的 ChatGPT', detail: '连接两个账号，就可以开始了。', version: app.getVersion() };
  const window = new BrowserWindow({ width: 920, height: 690, minWidth: 750, minHeight: 640, title: 'WeChat Dot', backgroundColor: '#f6f7f3',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  const trayIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'tray.png'));
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  const tray = new Tray(trayIcon); tray.setToolTip('WeChat Dot');
  const show = () => { window.show(); window.focus(); };
  function publish(patch: Partial<AppStatus>): void {
    status = { ...status, ...patch };
    if (!window.isDestroyed()) window.webContents.send('status', status);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: status.running ? '正在连接' : '未连接', enabled: false },
      { label: '打开 WeChat Dot', click: show },
      { label: status.running ? '暂停连接' : '开始连接', click: () => { void action(status.running ? 'pause' : 'start'); } },
      { type: 'separator' }, { label: '退出', click: () => app.quit() }
    ]));
  }
  const bridge = new Bridge(store, weixin, dot, config, publish);
  window.on('close', e => { if (!quitting) { e.preventDefault(); window.hide(); } });
  app.on('second-instance', show); app.on('activate', show);
  app.on('before-quit', e => {
    if (quitting) return;
    e.preventDefault(); quitting = true; qrController?.abort();
    void dot.dispose().finally(() => app.quit());
  });
  dot.on('problem', e => publish({ detail: e.message }));

  async function discover(): Promise<void> {
    if (discoveryBusy || !dot.window) return;
    discoveryBusy = true;
    try {
      const profile = await dot.discover();
      const previous = store.data.dot;
      if (previous && (previous.roomId !== profile.roomId || previous.userId !== profile.userId)) {
        await bridge.pause();
        await store.update(s => { s.dotCursor = undefined; s.inbound = []; s.outbound = []; });
      }
      await store.update(s => { s.dot = profile; });
      publish({ dot: 'ready', dotName: profile.name, dotDetail: '已找到你的 dot', detail: '账号已准备好，点击开始连接。' });
      if (store.data.enabled && store.data.weixin && !status.running) await bridge.start();
    } catch (e) { publish({ dot: 'waiting', dotDetail: (e as Error).message }); }
    finally { discoveryBusy = false; }
  }
  dot.on('loaded', () => { if (status.dot !== 'ready') void discover(); });
  const discoveryTimer = setInterval(() => { if (status.dot === 'waiting') void discover(); }, config.dot.pollIntervalMs);
  app.on('will-quit', () => clearInterval(discoveryTimer));

  async function loginWeixin(): Promise<void> {
    await bridge.pause();
    qrController?.abort(); const controller = qrController = new AbortController();
    publish({ weixin: 'waiting', qr: undefined, weixinDetail: '正在获取二维码…' });
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
          await store.update(s => {
            if (s.weixin?.userId !== account.userId || s.weixin?.botId !== account.botId) {
              s.weixinCursor = ''; s.weixinPrimed = false; s.contextToken = undefined;
              s.dotCursor = undefined; s.inbound = []; s.outbound = [];
            }
            s.weixin = account;
          });
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
        await bridge.pause(); publish({ dot: 'waiting', dotDetail: '请在浏览器中完成 ChatGPT 登录' });
        const manual = await dot.login();
        publish({ finishLogin: manual, dotDetail: manual ? '登录后，点击下方「登录完成」' : '请在 ChatGPT 窗口完成登录' });
        if (!manual) await discover();
      }
      if (name === 'finish-login') { await dot.finishLogin(); publish({ finishLogin: false }); await discover(); }
      if (name === 'show-dot') await dot.showConversation();
      if (name === 'discover') await discover();
      if (name === 'start') await bridge.start();
      if (name === 'pause') await bridge.pause();
      if (name === 'received' || name === 'retry') await bridge.resolveUncertain(name === 'retry');
      if (name === 'download') await shell.openExternal(config.updates.releaseUrl);
      if (name === 'quit') app.quit();
    } catch (e) { publish({ detail: (e as Error).message }); }
  }
  ipcMain.handle('status', () => status);
  ipcMain.handle('action', (event, name, value) => {
    if (event.sender !== window.webContents) return;
    return action(name, value);
  });
  await window.loadFile(join(__dirname, 'index.html'));
  publish({});
  void fetch(config.updates.apiUrl, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(config.updates.timeoutMs) })
    .then(r => r.ok ? r.json() : []).then(releases => {
      const newer = Array.isArray(releases) && releases.find(r => !r.draft && valid(r.tag_name) && gt(r.tag_name, app.getVersion()));
      if (newer) publish({ updateUrl: config.updates.releaseUrl });
    }).catch(() => {});
  if (store.data.dot) { publish({ dot: 'waiting', dotDetail: '正在恢复 ChatGPT 登录…' }); await dot.open(false); }
}
