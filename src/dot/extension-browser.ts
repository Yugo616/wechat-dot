import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app } from 'electron';
import { DotBrowser } from './browser';
import { ExtensionLink } from './extension-link';
import { prepareExtension } from './extension-runtime';
import { contentType } from '../media';
import type { Config } from '../config';

export class ExtensionBrowser extends DotBrowser {
  private readonly link: ExtensionLink;
  private bodies = new Map<string, string>();
  private closing?: Promise<void>;
  private readonly token = randomBytes(32).toString('hex');
  private get managed(): boolean { return this.config.browser !== 'extension'; }
  constructor(config: Config['dot']) {
    super(config);
    const id = createHash('sha256').update(Buffer.from(config.extension.publicKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
    this.link = new ExtensionLink({ ...config.extension, ...(this.managed ? { port: 0, token: this.token } : {}), origin: `chrome-extension://${id}` }, config.requestTimeoutMs);
    this.link.on('connected', () => this.emit('loaded'));
    this.link.on('disconnected', () => {
      if (!this.closing) void this.dispose().finally(() => this.emit('closed'));
    });
    this.link.on('network', (method, params) => {
      if (method === 'Page.closed') { if (!this.closing) void this.dispose().finally(() => this.emit('closed')); return; }
      if (method === 'Network.responseData') {
        this.bodies.set(params.requestId, params.body);
        this.emit('network', 'Network.loadingFinished', { requestId: params.requestId });
        this.bodies.delete(params.requestId);
      } else this.emit('network', method, params);
    });
  }
  private async prepareConnection(): Promise<void> {
    const directory = join(app.getPath('userData'), 'Browser Connection');
    const source = app.isPackaged ? join(process.resourcesPath, 'browser-connection') : join(app.getAppPath(), 'dist', 'extension');
    await prepareExtension(source, directory, this.config, { port: this.link.port, token: this.token }, this.lifetime.signal);
  }
  protected override async loginArguments(): Promise<string[]> {
    return [`--load-extension=${join(app.getPath('userData'), 'Browser Connection')}`, ...this.config.backgroundArguments];
  }
  private async openManaged(): Promise<void> {
    await this.prepareConnection();
    this.lifetime.signal.throwIfAborted();
    if (!await this.hasOwnedBrowser()) await super.login();
    this.lifetime.signal.throwIfAborted();
  }
  override async login(): Promise<void> {
    await this.link.start();
    if (this.managed) { await this.openManaged(); this.manualLogin = true; }
  }
  override async finishLogin(): Promise<boolean> {
    await this.link.waitForConnection(this.lifetime.signal);
    this.manualLogin = false;
    return true;
  }
  override async open(show: boolean): Promise<void> {
    await this.link.start();
    if (this.managed) { await this.openManaged(); this.manualLogin = false; }
    await this.link.waitForConnection(this.lifetime.signal);
    if (show) await this.show();
  }
  override run(action: string, args: any = {}): Promise<any> { return this.link.request('run', { action, args }); }
  override async command(method: string, params: any = {}): Promise<any> {
    if (method !== 'Network.getResponseBody') throw new Error('Chrome 扩展不提供调试命令。');
    const body = this.bodies.get(params.requestId); this.bodies.delete(params.requestId);
    if (body === undefined) throw new Error('发送结果已失效，请打开 dot 核对。');
    return { body, base64Encoded: false };
  }
  override url(): Promise<string> { return this.run('url'); }
  override navigate(url: string): Promise<void> { return this.link.request('navigate', { url }); }
  override insertText(text: string): Promise<void> { return this.run('insert', { text, composerSelectors: this.config.composerSelectors }); }
  override async setFiles(paths: string[]): Promise<void> {
    const files = await Promise.all(paths.map(async path => {
      const bytes = await readFile(path), name = basename(path);
      return { name, base64: bytes.toString('base64'), mime: contentType(bytes, name) };
    }));
    await this.run('set-files', { files, fileInputSelectors: this.config.fileInputSelectors });
  }
  override show(): Promise<void> { return this.link.request('show'); }
  override async hide(): Promise<void> { if (this.managed && this.link.connected) await this.link.request('hide'); }
  override dispose(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      this.lifetime.abort();
      this.manualLogin = false;
      try { if (this.managed) await this.stopManualBrowser(); }
      finally {
        try { await this.link.stop(); }
        finally { await super.dispose(); this.bodies.clear(); }
      }
    });
  }
}
