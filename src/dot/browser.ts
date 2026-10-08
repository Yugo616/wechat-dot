import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config';

// The full browser owns an independent profile. Electron remains the desktop shell.
export class DotBrowser extends EventEmitter {
  private embedded?: BrowserWindow;
  private socket?: WebSocket;
  private sessionId?: string;
  private targetId?: string;
  private child?: ChildProcess;
  manualLogin = false;
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly config: Config['dot']) { super(); }
  async login(): Promise<void> {
    const executable = await this.executable();
    if (!executable) { await this.open(true); return; }
    this.manualLogin = true;
    const directory = join(app.getPath('userData'), 'ChatGPT Browser');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.child = spawn(executable, [`--user-data-dir=${directory}`, '--no-first-run', '--no-default-browser-check', '--new-window', this.config.homeUrl], { stdio: 'ignore' });
    this.child.on('error', e => this.emit('problem', new Error(`浏览器启动失败：${e.message}`)));
  }
  private async executable(): Promise<string | undefined> {
    if (this.config.browser === 'embedded') return;
    const roots: Record<string, string | undefined> = { home: homedir(), programFiles: process.env.ProgramFiles, programFilesX86: process.env['ProgramFiles(x86)'], localAppData: process.env.LOCALAPPDATA };
    const paths = this.config.browserExecutables[process.platform as keyof typeof this.config.browserExecutables] ?? [];
    for (const template of paths) {
      if ([...template.matchAll(/\{(\w+)\}/g)].some(m => !roots[m[1]])) continue;
      const path = template.replace(/\{(\w+)\}/g, (_m, key) => roots[key]!);
      try { await access(path); return path; } catch {}
    }
  }
  async open(show: boolean): Promise<void> {
    const executable = await this.executable();
    if (!executable) {
      if (this.config.browser === 'external') throw new Error('没有找到 Chrome 或 Edge，请安装其中一个后重新登录。');
      this.embedded = new BrowserWindow({ width: 1060, height: 780, show, title: '登录 ChatGPT · WeChat Dot', webPreferences: { partition: 'persist:chatgpt', nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      const page = this.embedded.webContents;
      this.embedded.on('close', e => { e.preventDefault(); this.embedded?.hide(); });
      page.setWindowOpenHandler(({ url }) => ({ action: /^https?:/.test(url) ? 'allow' : 'deny', overrideBrowserWindowOptions: { webPreferences: { partition: 'persist:chatgpt', nodeIntegration: false, contextIsolation: true, sandbox: true } } }));
      await this.embedded.loadURL('about:blank');
      page.debugger.attach('1.3');
      page.debugger.on('message', (_event, method, params) => this.emit('network', method, params));
      await page.debugger.sendCommand('Network.enable');
      page.on('did-finish-load', () => this.emit('loaded'));
      await this.embedded.loadURL(this.config.homeUrl);
      return;
    }
    const directory = join(app.getPath('userData'), 'ChatGPT Browser');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const portFile = join(directory, 'DevToolsActivePort');
    await rm(portFile, { force: true });
    const child = this.child = spawn(executable, [`--user-data-dir=${directory}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', `--app=${this.config.homeUrl}`], { stdio: 'ignore' });
    let failed: Error | undefined;
    child.on('error', e => { failed = e; });
    const end = Date.now() + this.config.requestTimeoutMs;
    let port: string | undefined, endpoint: string | undefined;
    while (!port) {
      if (failed) throw new Error(`浏览器启动失败：${failed.message}`);
      if (Date.now() > end) throw new Error('浏览器启动超时，请关闭 WeChat Dot 的登录窗口后重试。');
      try { [port, endpoint] = (await readFile(portFile, 'utf8')).trim().split('\n'); } catch { await delay(100); }
    }
    const socket = this.socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('无法连接登录浏览器，请重试。')), { once: true });
    });
    socket.addEventListener('message', event => {
      const data = JSON.parse(String(event.data));
      if (data.id) {
        const pending = this.pending.get(data.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error.message)); else pending.resolve(data.result);
      } else if (data.sessionId === this.sessionId) {
        this.emit('network', data.method, data.params);
        if (data.method === 'Page.loadEventFired') this.emit('loaded');
      }
    });
    socket.addEventListener('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('ChatGPT 浏览器已关闭，请重新登录。')); }
      this.pending.clear(); this.emit('closed');
    });
    const targets = await this.command('Target.getTargets', {}, true);
    const target = targets.targetInfos.find((t: any) => t.type === 'page' && t.url.startsWith(new URL(this.config.homeUrl).origin)) ?? targets.targetInfos.find((t: any) => t.type === 'page');
    if (!target) throw new Error('浏览器未打开 ChatGPT 页面，请重试。');
    this.targetId = target.targetId;
    this.sessionId = (await this.command('Target.attachToTarget', { targetId: this.targetId, flatten: true }, true)).sessionId;
    await this.command('Network.enable'); await this.command('Page.enable');
    this.emit('loaded');
    if (show) await this.show();
  }
  command(method: string, params: object = {}, root = false): Promise<any> {
    if (this.embedded) return this.embedded.webContents.debugger.sendCommand(method, params);
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== WebSocket.OPEN) { reject(new Error('ChatGPT 浏览器已关闭，请重新登录。')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ChatGPT 页面响应超时，请打开登录窗口检查。')); }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(!root && this.sessionId ? { sessionId: this.sessionId } : {}) }));
    });
  }
  async evaluate(expression: string): Promise<any> {
    if (this.embedded) return this.embedded.webContents.executeJavaScript(expression);
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error('ChatGPT 页面未就绪，请先完成登录。');
    return result.result?.value;
  }
  async navigate(url: string): Promise<void> {
    if (this.embedded) { await this.embedded.loadURL(url); return; }
    await this.command('Page.navigate', { url });
    const end = Date.now() + this.config.requestTimeoutMs;
    while (Date.now() < end) {
      if (await this.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`)) return;
      await delay(100);
    }
    throw new Error('ChatGPT 页面加载超时，请打开窗口检查。');
  }
  url(): Promise<string> { return this.evaluate('location.href'); }
  async insertText(text: string): Promise<void> { await this.command('Input.insertText', { text }); }
  async show(): Promise<void> {
    if (this.embedded) { this.embedded.show(); return; }
    const { windowId } = await this.command('Browser.getWindowForTarget', { targetId: this.targetId }, true);
    await this.command('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, true);
    await this.command('Page.bringToFront');
  }
  async dispose(): Promise<void> {
    this.embedded?.destroy(); this.embedded = undefined;
    if (this.socket?.readyState === WebSocket.OPEN) await this.command('Browser.close', {}, true).catch(() => {});
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      const child = this.child;
      const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (process.platform === 'win32' && child.pid) {
        // Windows SIGTERM ends only the launcher; the browser processes still hold the profile.
        await new Promise<void>(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T'], { windowsHide: true }, () => resolve()));
      } else child.kill('SIGTERM');
      await Promise.race([stopped, delay(this.config.requestTimeoutMs)]);
    }
    this.socket?.close(); this.socket = undefined; this.child = undefined;
  }
}
