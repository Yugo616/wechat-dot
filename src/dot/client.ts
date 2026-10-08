import { DotBrowser } from './browser';
import { EventEmitter } from 'node:events';
import type { Config } from '../config';
import type { DotProfile, LocalFile } from '../types';
import { collectNewMessages, messageBaseline } from './protocol';
import { DotAccessError } from './errors';
import { ExtensionBrowser } from './extension-browser';
import { sameDotConnection } from './profile';

export class DotClient extends EventEmitter {
  window?: DotBrowser;
  profile?: DotProfile;
  members = new Set<string>();
  private headers: Record<string, string> = {};
  private prefix: string;
  private posts = new Map<string, { requestId: string; text: string }>();
  private pending?: { text: string; resolve: (id: string) => void; reject: (e: Error) => void; onRequest: (id: string) => Promise<void> };
  constructor(readonly config: Config['dot']) { super(); this.prefix = config.apiPrefixes[0]; }
  private createBrowser(): DotBrowser { return this.config.browser === 'extension' ? new ExtensionBrowser(this.config) : new DotBrowser(this.config); }

  async login(): Promise<boolean> {
    await this.dispose(); this.profile = undefined;
    const browser = this.window = this.createBrowser();
    this.listen(browser);
    await browser.login();
    return browser.manualLogin;
  }
  async finishLogin(): Promise<void> { if (this.window?.manualLogin) { await this.dispose(); await this.open(false); } }
  private listen(browser: DotBrowser): void {
    browser.on('network', (method, params) => { void this.observe(method, params).catch(e => this.emit('problem', e)); });
    browser.on('loaded', () => this.emit('loaded'));
    browser.on('problem', e => this.emit('problem', e));
    browser.on('closed', () => { if (this.window === browser) this.window = undefined; });
  }

  async open(show = true): Promise<void> {
    if (this.window) { if (show) await this.window.show(); return; }
    const browser = this.window = this.createBrowser();
    this.listen(browser);
    try { await browser.open(show); } catch (e) { this.window = undefined; await browser.dispose(); throw e; }
  }

  private async observe(method: string, p: any): Promise<void> {
    if (method === 'Network.requestWillBeSent') {
      const request = p.request, url = new URL(request.url);
      if (url.origin !== new URL(this.config.homeUrl).origin) return;
      const prefix = this.config.apiPrefixes.find(prefix => url.pathname.startsWith(`${prefix}/`));
      if (!prefix) return;
      this.prefix = prefix;
      for (const [key, value] of Object.entries(request.headers)) {
        if (['authorization', 'chatgpt-account-id'].includes(key.toLowerCase())) this.headers[key.toLowerCase()] = String(value);
      }
      if (request.method === 'POST' && this.profile && url.pathname === this.prefix + this.path(this.config.messagesPath)) {
        const body = JSON.parse(request.postData ?? '{}');
        const id = body.request_id ?? body.idempotency_token;
        if (id && this.pending && body.content?.text === this.pending.text) {
          this.posts.set(p.requestId, { requestId: id, text: body.content.text });
          await this.pending.onRequest(id);
        }
      }
    } else if (method === 'Network.loadingFinished' && this.posts.has(p.requestId)) {
      const post = this.posts.get(p.requestId)!;
      this.posts.delete(p.requestId);
      const result = await this.window!.command('Network.getResponseBody', { requestId: p.requestId });
      const data = JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body);
      const id = data.id ?? data.message?.id;
      if (!id) this.pending?.reject(new Error('ChatGPT 没有确认发送结果，请打开 ChatGPT 核对这一条消息。'));
      else if (this.pending?.text === post.text) this.pending.resolve(id);
    } else if (method === 'Network.webSocketFrameReceived' || method === 'Network.eventSourceMessageReceived') {
      this.emit('update');
    }
  }

  path(template: string, fileId = ''): string {
    return template.replace('{roomId}', encodeURIComponent(this.profile?.roomId ?? '')).replace('{fileId}', encodeURIComponent(fileId));
  }
  async api(path: string): Promise<any> {
    if (!this.window) throw new Error('请先登录 ChatGPT。');
    const url = new URL(this.prefix + path, this.config.homeUrl).href;
    const result = await this.window.run('request', { url, headers: this.headers, timeoutMs: this.config.requestTimeoutMs });
    if (result.status === 401 || result.status === 403) throw new DotAccessError(result.status);
    if (result.status >= 400) throw new Error(`ChatGPT 请求失败（HTTP ${result.status}），请打开 ChatGPT 检查。`);
    try { return JSON.parse(result.text); } catch { throw new Error('ChatGPT 页面尚未就绪，请完成登录。'); }
  }
  async discover(): Promise<DotProfile> {
    if (this.window?.manualLogin) throw new Error('在 Chrome 中登录后，点击「登录完成，识别 dot」。');
    await this.open(false);
    if (new URL(await this.window!.url()).origin !== new URL(this.config.homeUrl).origin) throw new Error('请在浏览器中完成 ChatGPT 登录。');
    const session = await this.window!.run('request', { url: this.config.sessionPath, timeoutMs: this.config.requestTimeoutMs });
    if (session.status === 401 || session.status === 403) throw new DotAccessError(session.status);
    const login = JSON.parse(session.text);
    if (!login.accessToken) { delete this.headers.authorization; throw new DotAccessError(401); }
    this.headers.authorization = `Bearer ${login.accessToken}`;
    const primary = await this.api(this.config.primaryPath);
    const selection = primary.selection;
    if (!selection?.available || !selection.thread_id) throw new Error('这个账号还没有可用的 dot，请先在 ChatGPT 中打开自己的 dot。');
    const profile = primary.profile ?? await this.api(this.config.profilePath.replace('{threadId}', encodeURIComponent(selection.thread_id)));
    const roomId = profile.messaging_room_id ?? selection.messaging_room_id;
    if (!roomId) throw new Error('请先在 ChatGPT 中和自己的 dot 说一句话，再点击重新识别。');
    const found: DotProfile = { id: profile.id ?? selection.aeon_id, name: profile.display_name || '我的 dot', roomId,
      accountId: this.headers['chatgpt-account-id'] ?? login.account?.id ?? '', userId: login.user?.id ?? '',
      url: new URL(this.config.conversationPath.replace('{threadId}', encodeURIComponent(selection.thread_id)), this.config.homeUrl).href };
    if (this.profile && !sameDotConnection(this.profile, found)) throw new Error('ChatGPT 账号或 dot 已切换，请暂停连接后重新登录。');
    found.accountId ||= this.profile?.accountId ?? '';
    this.profile = found;
    const room = await this.api(this.path(this.config.roomPath));
    this.members = new Set((room.members ?? []).filter((m: any) => m.aeon_id === found.id).map((m: any) => m.account_user_id));
    return found;
  }
  async showConversation(): Promise<void> {
    await this.open();
    if (this.profile && await this.window!.url() !== this.profile.url) await this.window!.navigate(this.profile.url);
  }
  async baseline(): Promise<{ cursor: string; pending: string[] }> {
    const page = await this.api(`${this.path(this.config.messagesPath)}?limit=${this.config.historyPageSize}`);
    if (!Array.isArray(page.items)) throw new Error('dot 消息接口已变化，请检查更新。');
    return messageBaseline(page.items, this.members);
  }
  async messages(after: string, pending: string[] = []): Promise<any[]> {
    const unfinished = await Promise.all(pending.map(async id => {
      const page = await this.api(`${this.path(this.config.messagesPath)}?${new URLSearchParams({ around: id, limit: String(this.config.historyPageSize) })}`);
      if (!Array.isArray(page.items)) throw new Error('dot 消息接口已变化，请检查更新。');
      return page.items.filter((m: any) => m.id === id);
    }));
    const newer = await collectNewMessages(after, this.config.historyPageSize, (cursor, limit, before) => this.api(`${this.path(this.config.messagesPath)}?${new URLSearchParams({ ...(cursor ? { after: cursor } : {}), ...(before ? { before } : {}), limit: String(limit) })}`));
    return [...unfinished.flat(), ...newer];
  }
  async findRequest(requestId: string, after: string): Promise<string | undefined> {
    return (await this.messages(after)).find(m => m.request_id === requestId)?.id;
  }
  async send(text: string, files: LocalFile[], onRequest: (id: string) => Promise<void>, beforeSubmit: () => Promise<void>): Promise<string> {
    if (files.length) throw new Error('附件功能正在接入，请先用文字测试连接。');
    if (!this.profile || !this.window) throw new Error('请先连接 dot。');
    if (this.pending) throw new Error('上一条消息仍在发送。');
    await this.discover();
    const page = this.window;
    if (await page.url() !== this.profile.url) await this.window.navigate(this.profile.url);
    const ready = await page.run('composer', { composerSelectors: this.config.composerSelectors, attachmentSelectors: this.config.draftAttachmentSelectors });
    if (ready === 'attachment') throw new Error('ChatGPT 输入框里有附件或正在上传的文件，请先处理完再继续。');
    if (ready !== 'ready') throw new Error(ready === 'draft' ? 'ChatGPT 输入框里有未发送内容，请先发送或清空，再继续连接。' : '找不到 dot 输入框，请打开 ChatGPT，等页面加载完成后重试。');
    await beforeSubmit();
    await page.insertText(text);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = new Promise<string>((resolve, reject) => {
        this.pending = { text, resolve, reject, onRequest };
        timer = setTimeout(() => reject(new Error('ChatGPT 发送结果还未确认，请打开 ChatGPT 核对这一条消息。')), this.config.sendTimeoutMs);
      });
      const clicked = await page.run('send', { sendSelectors: this.config.sendSelectors });
      if (!clicked) this.pending!.reject(new Error('ChatGPT 发送按钮尚未就绪，请在 ChatGPT 中检查。'));
      return await result;
    } finally { clearTimeout(timer); this.pending = undefined; }
  }
  async dispose(): Promise<void> { const browser = this.window; this.window = undefined; this.headers = {}; await browser?.dispose(); }
}
