import { createHash } from 'node:crypto';
import { DotBrowser } from './browser';
import { ExtensionLink } from './extension-link';
import type { Config } from '../config';

export class ExtensionBrowser extends DotBrowser {
  private readonly link: ExtensionLink;
  private bodies = new Map<string, string>();
  constructor(config: Config['dot']) {
    super(config);
    const id = createHash('sha256').update(Buffer.from(config.extension.publicKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
    this.link = new ExtensionLink({ ...config.extension, origin: `chrome-extension://${id}` }, config.requestTimeoutMs);
    this.link.on('connected', () => this.emit('loaded'));
    this.link.on('network', (method, params) => {
      if (method === 'Network.responseData') {
        this.bodies.set(params.requestId, params.body);
        this.emit('network', 'Network.loadingFinished', { requestId: params.requestId });
      } else this.emit('network', method, params);
    });
  }
  override async login(): Promise<void> { await this.open(false); }
  override async open(show: boolean): Promise<void> { await this.link.start(); if (show) await this.show(); }
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
  override show(): Promise<void> { return this.link.request('show'); }
  override async hide(): Promise<void> {}
  override async dispose(): Promise<void> { await this.link.stop(); this.bodies.clear(); }
}
