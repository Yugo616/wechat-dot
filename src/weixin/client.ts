import type { Config } from '../config';
import type { WeixinAccount, WeixinItem, WeixinMessage } from '../types';
import { randomBytes } from 'node:crypto';
import { parseWeixinJson } from './json';

export class WeixinExpiredError extends Error {
  constructor() { super('微信登录已过期，请重新扫码。'); }
}

// Wire format adapted from Tencent's MIT-licensed openclaw-weixin. See THIRD_PARTY_NOTICES.md.
export class WeixinClient {
  constructor(readonly config: Config['weixin'], readonly version: string, public account?: WeixinAccount) {}
  async request<T = any>(endpoint: string, body?: unknown, options: { baseUrl?: string; signal?: AbortSignal; timeout?: number; anonymous?: boolean } = {}): Promise<T> {
    const version = this.config.channelVersion.split('.').map(Number);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token',
      'iLink-App-Id': this.config.appId,
      'iLink-App-ClientVersion': String((version[0] << 16) | (version[1] << 8) | version[2]),
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')
    };
    if (this.account && !options.anonymous) headers.Authorization = `Bearer ${this.account.token}`;
    const timeout = AbortSignal.timeout(options.timeout ?? this.config.requestTimeoutMs);
    const response = await fetch(new URL(endpoint, options.baseUrl ?? this.account?.baseUrl ?? this.config.baseUrl), {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify({ ...body as object, base_info: { channel_version: this.config.channelVersion, bot_agent: `WeChatDot/${this.version}` } }),
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    });
    if (!response.ok) throw new Error(`微信连接失败（HTTP ${response.status}），请稍后重试。`);
    const data = parseWeixinJson<any>(await response.text());
    if (data.ret === -14 || data.errcode === -14) throw new WeixinExpiredError();
    if ((data.ret && data.ret !== 0) || (data.errcode && data.errcode !== 0)) throw new Error(`微信：${data.errmsg || data.errcode || data.ret}`);
    return data as T;
  }
  async updates(cursor: string, signal?: AbortSignal): Promise<{ msgs?: WeixinMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number }> {
    try {
      return await this.request('/ilink/bot/getupdates', { get_updates_buf: cursor }, { signal, timeout: this.config.longPollTimeoutMs });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError') return {};
      throw error;
    }
  }
  async send(items: WeixinItem[], context: string, clientId: string): Promise<void> {
    if (!this.account) throw new Error('请先扫码连接微信。');
    await this.request('/ilink/bot/sendmessage', { msg: {
      from_user_id: '', to_user_id: this.account.userId, client_id: clientId,
      message_type: 2, message_state: 2, item_list: items, context_token: context
    } });
  }
}
