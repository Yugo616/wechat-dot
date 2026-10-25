import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, screen, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';
import { NsisUpdater } from 'electron-updater';
import { MacDownloadUpdater } from './updates/mac-download';
import { loadConfig } from './config';
import { createController, type DesktopController } from './controller';
import { configureRuntime } from './runtime';
import { connectionSummary } from './status';

// Electron is retained as a development/test host for the shared desktop logic.
app.setName('WeChat Dot');
if (process.env.WECHAT_DOT_DATA) app.setPath('userData', process.env.WECHAT_DOT_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else void run().catch(e => { console.error(e.message); app.quit(); });

async function run(): Promise<void> {
  await app.whenReady();
  const config = await loadConfig(app.getAppPath(), app.getPath('userData'));
  configureRuntime({ userDirectory: app.getPath('userData'),
    extensionDirectory: app.isPackaged ? join(process.resourcesPath, 'browser-connection') : join(app.getAppPath(), 'dist', 'extension'),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init), createEmbeddedWindow: options => new BrowserWindow(options) });
  const window = new BrowserWindow({ width: config.desktop.windowWidth, height: config.desktop.minContentHeight, useContentSize: true,
    show: false, resizable: false, maximizable: false, fullscreenable: false, title: 'WeChat Dot', backgroundColor: '#fafaf8',
    icon: join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.setMenuBarVisibility(false);
  if (process.platform === 'darwin') { app.dock?.setIcon(join(app.getAppPath(), 'assets', 'icon.png')); void app.dock?.hide(); }
  const trayIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'tray.png'));
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  const tray = new Tray(trayIcon); tray.setToolTip('WeChat Dot');
  const show = () => { window.show(); window.focus(); };
  let quitting = false;
  let core: DesktopController | undefined;
  const action = (name: string) => { void core?.action(name); };
  core = await createController({
    appDirectory: app.getAppPath(), userDirectory: app.getPath('userData'), resourcesDirectory: process.resourcesPath,
    executablePath: process.execPath, version: app.getVersion(), isPackaged: app.isPackaged,
    show, hide: () => window.hide(), quit: () => app.quit(), openPath: shell.openPath, openExternal: shell.openExternal,
    createUpdater: () => {
      if (process.platform === 'darwin') return new MacDownloadUpdater();
      const updater = new NsisUpdater(); updater.installDirectory = dirname(process.execPath); return updater;
    },
    publish: status => {
      if (!window.isDestroyed()) window.webContents.send('status', status);
      const { title } = connectionSummary(status);
      tray.setToolTip(`WeChat Dot · ${title}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: title, enabled: false }, { label: '打开 WeChat Dot', click: show },
        { label: status.running || status.connecting ? '暂停转发' : '开始转发', enabled: status.running || status.connecting || (status.weixin === 'ready' && status.dot === 'ready'), click: () => action(status.running || status.connecting ? 'pause' : 'start') },
        { type: 'separator' }, { label: '打开专用窗口', enabled: status.dot === 'ready', click: () => action('show-dot') },
        { label: '重新登录', submenu: [ { label: '微信', click: () => { show(); action('weixin'); } }, { label: 'ChatGPT', click: () => { show(); action('dot'); } } ] },
        { label: status.update?.phase === 'ready' ? '重启更新' : '检查更新', click: () => { show(); action(status.update?.phase === 'ready' ? 'install-update' : 'check-update'); } },
        ...(status.exitAction ? [{ label: '恢复退出询问', click: () => action('reset-exit') }] : []),
        { type: 'separator' }, { label: '退出后台', click: () => app.quit() }
      ]));
    }
  }, config);
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  app.on('second-instance', show); app.on('activate', show);
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void core!.close().finally(() => app.quit());
  });
  ipcMain.handle('status', () => core!.status());
  ipcMain.handle('backlog', event => event.sender === window.webContents ? core!.backlog() : undefined);
  ipcMain.handle('manage-backlog', (event, operation, selection) => event.sender === window.webContents ? core!.manageBacklog(operation, selection) : undefined);
  ipcMain.handle('action', (event, name, value) => event.sender === window.webContents ? core!.action(name, value) : undefined);
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
  await core.start();
}
