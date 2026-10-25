import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { AppUpdater } from 'electron-updater';
import { UpdateController } from './updates/controller';
import { finishMacInstall, removeMacStage, scheduleMacInstall, stageMacUpdate } from './updates/mac-install';
import { loadConfig, type Config } from './config';
import { connectionKey, StateStore } from './state';
import { backlogSnapshot, countBacklog } from './backlog';
import { WeixinClient, WeixinExpiredError } from './weixin/client';
import { DotClient } from './dot/client';
import { DotAccessError } from './dot/errors';
import { sameDotConnection } from './dot/profile';
import { Bridge } from './bridge';
import type { AppStatus, BacklogSelection } from './types';
import { connectionRetry, problemText } from './status';

export interface DesktopHost {
  appDirectory: string; userDirectory: string; resourcesDirectory: string;
  executablePath: string; version: string; isPackaged: boolean; pid?: number;
  createUpdater(config: Config): AppUpdater;
  publish(status: AppStatus): void;
  show(): void; hide(): void; quit(): void;
  openPath(path: string): Promise<unknown>; openExternal(url: string): Promise<unknown>;
}

export async function createController(host: DesktopHost, suppliedConfig?: Config) {
  const config = suppliedConfig ?? await loadConfig(host.appDirectory, host.userDirectory);
  const store = new StateStore(host.userDirectory); await store.load();
  const weixin = new WeixinClient(config.weixin, host.version, store.data.weixin);
  const dot = new DotClient(config.dot);
  const engine = host.createUpdater(config);
  engine.autoDownload = false; engine.autoInstallOnAppQuit = false;
  engine.allowPrerelease = false; engine.allowDowngrade = false;
  engine.setFeedURL(config.updates.feed as Parameters<typeof engine.setFeedURL>[0]);
  if (process.platform === 'darwin') { engine.channel = `latest-${process.arch}`; engine.allowDowngrade = false; }
  const updates = new UpdateController(engine, update => publish({ update }), async (file, version) => {
    if (!host.isPackaged) throw new Error('请在已安装的 WeChat Dot 中更新。');
    const installedApp = process.platform === 'darwin' ? join(host.executablePath, '../../..') : '';
    const staged = process.platform === 'darwin' ? await stageMacUpdate(file, installedApp, config.desktop.appId, version) : undefined;
    const resume = store.data.enabled;
    let scheduled = false;
    try {
      quitting = true; discoveryGeneration++; qrController?.abort();
      await bridge.pause(); await dot.dispose(); await store.update(s => { s.enabled = resume; });
      if (staged) { await scheduleMacInstall(staged, installedApp, version, host.userDirectory, host.pid); scheduled = true; host.quit(); }
      else engine.quitAndInstall(true, true);
    } catch (error) {
      quitting = false;
      if (staged && !scheduled) await removeMacStage(staged.directory).catch(console.warn);
      if (resume) await action('start');
      throw error;
    }
  });
  let quitting = false, qrController: AbortController | undefined, verifyCode = '';
  let discovery: Promise<void> | undefined, discoveryGeneration = 0;
  let weixinLogin: Promise<void> | undefined;
  let dotLogin: Promise<void> | undefined;
  let resumeAfterLogin = false;
  const resumeInBackground = Boolean(store.data.enabled && store.data.weixin && store.data.dot);
  let status: AppStatus = { weixin: store.data.weixin ? 'ready' : 'idle', dot: store.data.dot ? 'ready' : 'idle', running: false,
    weixinDetail: store.data.weixin ? '扫码绑定已保存' : '用手机微信扫码', dotDetail: store.data.dot?.name ?? '在浏览器中登录 ChatGPT', dotName: store.data.dot?.name,
    detail: store.data.dot && store.data.weixin ? '点击开始转发，即可在微信里聊天。' : '先扫码绑定微信，再登录 ChatGPT。', version: host.version, extension: config.dot.browser === 'extension', exitAction: store.data.exitAction };
  const show = () => host.show();
  function publish(patch: Partial<AppStatus>): void {
    const wasRunning = status.running;
    const hadAccessError = status.dot === 'error' || status.weixin === 'error';
    if (patch.dot === 'error' || patch.weixin === 'error') resumeAfterLogin ||= Boolean(status.running || status.connecting);
    if (patch.running) resumeAfterLogin = false;
    status = { ...status, ...patch, weixinSendError: store.data.weixinSendError, skippedMessages: countBacklog(store.data), backlogConnection: connectionKey(store.data) ?? '' };
    if (patch.running || patch.dot === 'error' || patch.weixin === 'error') status.connecting = false;
    host.publish(status);
    if (status.running && !wasRunning) {
      host.hide();
      void dot.window?.hide().catch(() => {});
    }
    if ((status.dot === 'error' || status.weixin === 'error') && !hadAccessError) show();
  }
  const bridge = new Bridge(store, weixin, dot, config, publish);
  dot.on('problem', e => {
    const retry = connectionRetry(e);
    publish(retry && (status.running || status.connecting) ? { dotRetry: retry, problem: undefined } : { problem: retry ? '网络暂时不可用，请稍后重试。' : e.message });
  });
  dot.on('progress', dotDetail => { if (!quitting) publish({ dotDetail, dotRetry: undefined }); });

  function discover(): Promise<void> {
    if (discovery) return discovery;
    const generation = discoveryGeneration;
    discovery = Promise.resolve().then(async () => { try {
      const profile = await dot.discover();
      if (quitting || generation !== discoveryGeneration) return;
      const previous = store.data.dot;
      if (previous && !sameDotConnection(previous, profile)) {
        publish({ connecting: false });
        await bridge.pause();
      }
      await store.connectDot(profile);
      if (quitting || generation !== discoveryGeneration) return;
      dot.profile = store.data.dot;
      publish({ dot: 'ready', dotName: profile.name, dotDetail: profile.name, detail: status.running ? '现在可以在微信里聊天了。' : '点击开始转发，即可在微信里聊天。', problem: undefined, dotRetry: undefined });
      if (status.connecting && status.weixin === 'ready' && store.data.weixin && !status.running) await bridge.start();
    } catch (e) {
      if (quitting || generation !== discoveryGeneration) return;
      if (e instanceof DotAccessError) {
        await bridge.pause();
        publish({ dot: 'error', connecting: false, dotDetail: e.message, problem: e.message });
      } else if (e instanceof WeixinExpiredError) {
        await bridge.pause();
        publish({ weixin: 'error', connecting: false, weixinDetail: e.message, problem: e.message });
      } else {
        const retry = connectionRetry(e);
        publish({ dot: 'waiting', dotDetail: retry ? '正在自动重试…' : problemText(e), dotRetry: retry, problem: retry ? undefined : problemText(e) });
      }
    } }).finally(() => { discovery = undefined; });
    return discovery;
  }
  async function pause(): Promise<void> {
    discoveryGeneration++;
    resumeAfterLogin = false; qrController?.abort(); qrController = undefined;
    publish({ running: false, connecting: false, qr: undefined, verifyRequired: false,
      ...(status.weixin === 'waiting' ? { weixin: store.data.weixin ? 'ready' as const : 'idle' as const, weixinDetail: store.data.weixin ? '扫码绑定已保存' : '用手机微信扫码' } : {}),
      ...(status.dot === 'waiting' && !status.finishLogin ? { dot: store.data.dot ? 'ready' as const : 'idle' as const, dotDetail: store.data.dot?.name ?? '在浏览器中登录 ChatGPT' } : {}) });
    await bridge.pause();
    if (dotLogin || dot.isOpening) await dot.dispose();
  }
  dot.on('closed', () => {
    if (quitting || status.finishLogin) return;
    const generation = ++discoveryGeneration;
    const resume = Boolean(status.running || status.connecting);
    publish({ running: false, connecting: resume, dot: store.data.dot ? 'ready' : 'idle',
      dotDetail: resume ? '正在恢复 ChatGPT…' : store.data.dot?.name ?? '在浏览器中登录 ChatGPT', problem: undefined });
    void (async () => {
      await bridge.pause();
      await discovery;
      if (generation === discoveryGeneration && status.connecting) {
        publish({ dot: 'waiting' });
        await discover();
      }
    })().catch(e => publish({ problem: e.message }));
  });
  const autoDiscover = () => { if (status.dot === 'waiting' && !status.finishLogin && !dotLogin) void discover(); };
  dot.on('loaded', autoDiscover);
  const discoveryTimer = setInterval(autoDiscover, config.dot.pollIntervalMs);

  function loginWeixin(resume = false): Promise<void> {
    if (weixinLogin) return weixinLogin;
    const operation = weixinLogin = performWeixinLogin(resume).finally(() => { if (weixinLogin === operation) weixinLogin = undefined; });
    return operation;
  }
  async function performWeixinLogin(resume: boolean): Promise<void> {
    const previous = store.data.weixin;
    const stopping = pause(), generation = discoveryGeneration;
    await stopping;
    if (quitting || generation !== discoveryGeneration) return;
    qrController?.abort(); const controller = qrController = new AbortController();
    publish({ weixin: 'waiting', connecting: resume, qr: undefined, weixinDetail: '正在获取二维码…', problem: undefined });
    async function retry<T>(request: () => Promise<T>): Promise<T> {
      while (true) {
        controller.signal.throwIfAborted();
        try { const result = await request(); controller.signal.throwIfAborted(); publish({ weixinRetry: undefined }); return result; }
        catch (error) {
          if (controller.signal.aborted || !connectionRetry(error)) throw error;
          publish({ weixinRetry: connectionRetry(error) });
          await delay(config.weixin.retryDelayMs, undefined, { signal: controller.signal });
        }
      }
    }
    try {
      while (!controller.signal.aborted) {
        verifyCode = '';
        const qr = await retry(() => weixin.request('/ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(config.weixin.botType), { local_token_list: [] }, { baseUrl: config.weixin.baseUrl, anonymous: true, signal: controller.signal }));
        const image = await QRCode.toDataURL(qr.qrcode_img_content, { width: 230, margin: 1 });
        controller.signal.throwIfAborted();
        publish({ qr: image, weixinDetail: '用微信扫一扫，再在手机上确认' });
        let baseUrl = config.weixin.baseUrl;
        while (!controller.signal.aborted) {
          const query = new URLSearchParams({ qrcode: qr.qrcode });
          if (verifyCode) { query.set('verify_code', verifyCode); verifyCode = ''; }
          const value = await retry(() => weixin.request('/ilink/bot/get_qrcode_status?' + query, undefined, { baseUrl, anonymous: true, signal: controller.signal, timeout: config.weixin.longPollTimeoutMs }).catch(e => {
            if (e.name === 'TimeoutError') return { status: 'wait' }; throw e;
          }));
          if (value.status === 'confirmed') {
            if (!value.bot_token || !value.ilink_user_id || !value.ilink_bot_id) throw new Error('微信没有返回完整登录信息，请重新扫码。');
            const account = { token: value.bot_token, userId: value.ilink_user_id, botId: value.ilink_bot_id, baseUrl: value.baseurl || baseUrl };
            controller.signal.throwIfAborted();
            await store.connectWeixin(account);
            weixin.account = store.data.weixin;
            controller.signal.throwIfAborted();
            if (previous && (previous.botId !== account.botId || previous.userId !== account.userId)) publish({ connecting: false });
            publish({ qr: undefined, verifyRequired: false, weixinDetail: '正在同步微信…' });
            await retry(() => bridge.primeWeixin(controller.signal));
            publish({ weixin: 'ready', weixinDetail: '扫码绑定已保存', detail: store.data.dot ? '点击开始转发，即可在微信里聊天。' : '微信已绑定，请登录 ChatGPT。' });
            if (resume && status.connecting && store.data.dot) { publish({ dot: 'waiting' }); await discover(); }
            return;
          }
          if (value.status === 'expired') { publish({ qr: undefined, verifyRequired: false, weixinDetail: '正在自动刷新二维码…' }); break; }
          if (value.status === 'verify_code_blocked') throw new Error('配对码尝试次数过多，请稍后重新扫码。');
          if (value.status === 'need_verifycode') publish({ verifyRequired: true, weixinDetail: '请输入手机上显示的配对码' });
          if (value.status === 'scaned') publish({ weixinDetail: '已扫码，请在手机上确认' });
          if (value.status === 'scaned_but_redirect' && value.redirect_host) baseUrl = `https://${value.redirect_host}`;
          if (value.status === 'binded_redirect') throw new Error('这个微信已绑定，请在手机上选择重新连接后再扫码。');
          await delay(config.weixin.retryDelayMs, undefined, { signal: controller.signal });
        }
      }
    } catch (e) { if (!controller.signal.aborted) publish({ weixin: 'error', weixinDetail: problemText(e, '微信连接未完成，请点击「重连微信」。'), qr: undefined, weixinRetry: undefined }); }
  }
  function loginDot(resume: boolean): Promise<void> {
    if (dotLogin) return dotLogin;
    const operation = dotLogin = performDotLogin(resume).finally(() => { if (dotLogin === operation) dotLogin = undefined; });
    return operation;
  }
  async function performDotLogin(resume: boolean): Promise<void> {
    const stopping = pause(), generation = discoveryGeneration;
    await stopping;
    if (quitting || generation !== discoveryGeneration) return;
    publish({ dot: 'waiting', connecting: resume, finishLogin: false, dotDetail: '正在打开登录窗口…', problem: undefined });
    let manual: boolean;
    while (true) {
      try { manual = await dot.login(); break; }
      catch (error) {
        if (quitting || generation !== discoveryGeneration) return;
        const retry = connectionRetry(error);
        if (!retry) throw error;
        publish({ dotRetry: retry, dotDetail: '专用浏览器准备未完成，正在自动重试…' });
        await delay(config.dot.pollIntervalMs);
        if (quitting || generation !== discoveryGeneration) return;
      }
    }
    if (quitting || generation !== discoveryGeneration) { await dot.dispose(); return; }
    publish({ finishLogin: manual, dotDetail: status.extension ? '打开 Chrome 扩展，点击「连接 dot」' : manual ? '登录后，点击下方「登录完成」' : '请在 ChatGPT 窗口完成登录' });
    if (!manual) await discover();
  }
  async function action(name: string, value?: string): Promise<void> {
    try {
      if (name === 'weixin' || name === 'recover-weixin') { await loginWeixin(name === 'recover-weixin' && Boolean(resumeAfterLogin || status.running || status.connecting)); return; }
      if (name === 'verify') { verifyCode = value?.trim() ?? ''; return; }
      if (name === 'dot' || name === 'recover-dot') {
        const resume = name === 'recover-dot' && Boolean(resumeAfterLogin || status.running || status.connecting);
        await loginDot(resume);
      }
      if (name === 'finish-login') { await dotLogin; await dot.finishLogin(); publish({ finishLogin: false }); await discover(); }
      if (name === 'show-dot') await dot.showConversation();
      if (name === 'discover') await discover();
      if (name === 'extension') {
        if (!dot.window) {
          publish({ dot: 'waiting', dotDetail: '打开 Chrome 扩展，点击「连接 dot」' });
          await dot.open(false);
        }
        const directory = host.isPackaged ? join(host.resourcesDirectory, 'browser-connection') : join(host.appDirectory, 'dist', 'extension');
        await host.openPath(directory);
        publish({ detail: '在 Chrome 扩展页打开「开发者模式」，点击「加载已解压的扩展」，选择这个文件夹。' });
      }
      if (name === 'start' && !status.running) {
        publish({ connecting: true, dot: 'waiting', dotDetail: '正在检查已保存的登录…', detail: '正在准备转发…', problem: undefined });
        await discover();
      }
      if (name === 'pause') await pause();
      if (name === 'received' || name === 'retry') {
        await pause();
        await bridge.resolveUncertain(name === 'retry');
        await action('start');
      }
      if (name === 'download') await host.openExternal(config.updates.releaseUrl);
      if (name === 'check-update') await updates.check();
      if (name === 'install-update') await updates.install();
      if (name === 'request-exit') {
        if (store.data.exitAction === 'minimize') host.hide();
        else if (store.data.exitAction === 'quit') host.quit();
        else { publish({ exitPrompt: true }); show(); }
      }
      if (name === 'cancel-exit') publish({ exitPrompt: false });
      if (name === 'reset-exit') { await store.update(s => { delete s.exitAction; }); publish({ exitAction: undefined }); }
      if (name === 'exit-minimize' || name === 'exit-quit') {
        const choice = name === 'exit-minimize' ? 'minimize' : 'quit';
        if (value === 'remember') await store.update(s => { s.exitAction = choice; });
        publish({ exitPrompt: false, exitAction: store.data.exitAction });
        if (choice === 'minimize') host.hide(); else host.quit();
      }
      if (name === 'quit') host.quit();
    } catch (e) {
      const retry = connectionRetry(e);
      if (retry && (!status.finishLogin || (name === 'finish-login' && !dot.window?.manualLogin)) && ['start', 'discover', 'finish-login', 'show-dot', 'recover-dot'].includes(name)) publish({ dot: 'waiting', finishLogin: false, dotRetry: retry, problem: undefined });
      else publish({ problem: problemText(e) });
      show();
    }
  }
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      quitting = true; discoveryGeneration++; qrController?.abort(); clearInterval(discoveryTimer);
      const resume = store.data.enabled;
      await bridge.pause(); await dot.dispose();
      await store.update(s => { s.enabled = resume; });
    })();
  }
  return {
    config, status: () => status, action, close,
    backlog: () => backlogSnapshot(store.data),
    manageBacklog: async (operation: 'restore' | 'clear', selection: BacklogSelection) => {
      const changed = await bridge.manageBacklog(operation, selection);
      return { changed, snapshot: backlogSnapshot(store.data) };
    },
    async start() {
      publish({});
      if (!resumeInBackground) show();
      if (host.isPackaged && process.platform === 'darwin') void finishMacInstall(join(host.executablePath, '../../..'), host.version).catch(console.warn);
      if (resumeInBackground) {
        publish({ connecting: true, dot: 'waiting', dotDetail: '正在恢复 ChatGPT…' });
        await discover();
      }
    }
  };
}
export type DesktopController = Awaited<ReturnType<typeof createController>>;
