import { DotBrowser } from './browser';
import { EventEmitter } from 'node:events';
import type { Config } from '../config';
import type { DotProfile, LocalFile } from '../types';
import { collectNewMessages } from './protocol';

export class DotClient extends EventEmitter {
  window?: DotBrowser;
  profile?: DotProfile;
  members = new Set<string>();
  private headers: Record<string, string> = {};
  private prefix: string;
  private posts = new Map<string, { requestId: string; text: string }>();
  private pending?: { text: string; resolve: (id: string) => void; reject: (e: Error) => void; onRequest: (id: string) => Promise<void> };
  constructor(readonly config: Config['dot']) { super(); this.prefix = config.apiPrefixes[0]; }

  async login(): Promise<boolean> {
    await this.dispose(); this.profile = undefined;
    const browser = this.window = new DotBrowser(this.config);
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
    const browser = this.window = new DotBrowser(this.config);
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
    const result = await this.window.evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(url)}, {credentials:'include',headers:${JSON.stringify(this.headers)},signal:AbortSignal.timeout(${this.config.requestTimeoutMs})});
      return {status:r.status, text:await r.text()};
    })()`);
    if (result.status === 401 || result.status === 403) throw new Error('请打开 ChatGPT，完成登录或页面上的验证。');
    if (result.status >= 400) throw new Error(`ChatGPT 请求失败（HTTP ${result.status}），请打开 ChatGPT 检查。`);
    try { return JSON.parse(result.text); } catch { throw new Error('ChatGPT 页面尚未就绪，请完成登录。'); }
  }
  async discover(): Promise<DotProfile> {
    if (this.window?.manualLogin) throw new Error('在 Chrome 中登录后，点击「登录完成，识别 dot」。');
    await this.open(false);
    if (new URL(await this.window!.url()).origin !== new URL(this.config.homeUrl).origin) throw new Error('请在浏览器中完成 ChatGPT 登录。');
    const login = await this.window!.evaluate(`fetch(${JSON.stringify(this.config.sessionPath)}, {credentials:'include'}).then(r=>r.json())`);
    if (login.accessToken) this.headers.authorization = `Bearer ${login.accessToken}`;
    if (!this.headers.authorization) throw new Error('请在 ChatGPT 窗口完成登录。');
    const primary = await this.api(this.config.primaryPath);
    const selection = primary.selection;
    if (!selection?.available || !selection.thread_id) throw new Error('这个账号还没有可用的 dot，请先在 ChatGPT 中打开自己的 dot。');
    const profile = primary.profile ?? await this.api(this.config.profilePath.replace('{threadId}', encodeURIComponent(selection.thread_id)));
    const roomId = profile.messaging_room_id ?? selection.messaging_room_id;
    if (!roomId) throw new Error('请先在 ChatGPT 中和自己的 dot 说一句话，再点击重新识别。');
    const found: DotProfile = { id: profile.id ?? selection.aeon_id, name: profile.display_name || '我的 dot', roomId,
      accountId: this.headers['chatgpt-account-id'] ?? login.account?.id ?? '', userId: login.user?.id ?? '',
      url: new URL(this.config.conversationPath.replace('{threadId}', encodeURIComponent(selection.thread_id)), this.config.homeUrl).href };
    if (this.profile && (this.profile.roomId !== found.roomId || this.profile.userId !== found.userId)) throw new Error('ChatGPT 账号或 dot 已切换，请暂停连接后重新登录。');
    this.profile = found;
    const room = await this.api(this.path(this.config.roomPath));
    this.members = new Set((room.members ?? []).filter((m: any) => m.aeon_id === found.id).map((m: any) => m.account_user_id));
    return found;
  }
  async showConversation(): Promise<void> {
    await this.open();
    if (this.profile && await this.window!.url() !== this.profile.url) await this.window!.navigate(this.profile.url);
  }
  async latest(): Promise<string> {
    const page = await this.api(`${this.path(this.config.messagesPath)}?limit=1`);
    if (!Array.isArray(page.items)) throw new Error('dot 消息接口已变化，请检查更新。');
    return page.items.at(-1)?.id ?? '';
  }
  async messages(after: string): Promise<any[]> {
    return collectNewMessages(after, this.config.historyPageSize, (cursor, limit, before) => this.api(`${this.path(this.config.messagesPath)}?${new URLSearchParams({ ...(cursor ? { after: cursor } : {}), ...(before ? { before } : {}), limit: String(limit) })}`));
  }
  async findRequest(requestId: string, after: string): Promise<string | undefined> {
    return (await this.messages(after)).find(m => m.request_id === requestId)?.id;
  }
  async send(text: string, files: LocalFile[], onRequest: (id: string) => Promise<void>): Promise<string> {
    if (files.length) throw new Error('附件功能正在接入，请先用文字测试连接。');
    if (!this.profile || !this.window) throw new Error('请先连接 dot。');
    if (this.pending) throw new Error('上一条消息仍在发送。');
    const page = this.window;
    if (await page.url() !== this.profile.url) await this.window.navigate(this.profile.url);
    const selectors = JSON.stringify(this.config.composerSelectors);
    const ready = await page.evaluate(`(() => {
      const e = ${selectors}.map(s=>document.querySelector(s)).find(e=>e && e.getBoundingClientRect().height>0);
      if(!e) return 'missing';
      if((e.value ?? e.innerText ?? '').trim()) return 'draft';
      e.focus(); return 'ready';
    })()`);
    if (ready !== 'ready') throw new Error(ready === 'draft' ? 'ChatGPT 输入框里有未发送内容，请先发送或清空，再继续连接。' : '找不到 dot 输入框，请打开 ChatGPT，等页面加载完成后重试。');
    await page.insertText(text);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = new Promise<string>((resolve, reject) => {
        this.pending = { text, resolve, reject, onRequest };
        timer = setTimeout(() => reject(new Error('ChatGPT 发送结果还未确认，请打开 ChatGPT 核对这一条消息。')), this.config.sendTimeoutMs);
      });
      const clicked = await page.evaluate(`(() => {
        const e = ${JSON.stringify(this.config.sendSelectors)}.map(s=>document.querySelector(s)).find(e=>e && !e.disabled && e.getBoundingClientRect().height>0);
        if(!e) return false; e.click(); return true;
      })()`);
      if (!clicked) this.pending!.reject(new Error('ChatGPT 发送按钮尚未就绪，请在 ChatGPT 中检查。'));
      return await result;
    } finally { clearTimeout(timer); this.pending = undefined; }
  }
  async dispose(): Promise<void> { const browser = this.window; this.window = undefined; this.headers = {}; await browser?.dispose(); }
}
