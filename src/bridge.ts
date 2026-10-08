import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { Config } from './config';
import type { AppStatus } from './types';
import { StateStore } from './state';
import { WeixinClient, WeixinExpiredError } from './weixin/client';
import { DotClient } from './dot/client';
import { acceptDot, acceptWeixin, nextInbound, splitText } from './queue';

export class Bridge {
  private controller?: AbortController;
  private tasks?: Promise<void>;
  private starting?: Promise<void>;
  constructor(readonly store: StateStore, readonly weixin: WeixinClient, readonly dot: DotClient, readonly config: Config, readonly status: (patch: Partial<AppStatus>) => void) {}
  async primeWeixin(signal?: AbortSignal): Promise<void> {
    if (this.store.data.weixinPrimed) return;
    let cursor = this.store.data.weixinCursor;
    while (true) {
      const page = await this.weixin.request<any>('/ilink/bot/getupdates', { get_updates_buf: cursor }, { signal, timeout: this.config.weixin.longPollTimeoutMs }).catch(e => {
        if (e.name === 'TimeoutError') return {}; throw e;
      });
      signal?.throwIfAborted();
      const previous = cursor; cursor = page.get_updates_buf ?? cursor;
      await this.store.update(s => {
        s.weixinCursor = cursor;
        for (const msg of page.msgs ?? []) if (msg.from_user_id === s.weixin?.userId && msg.context_token) s.contextToken = msg.context_token;
      });
      if (!page.msgs?.length || cursor === previous) break;
    }
    await this.store.update(s => { s.weixinPrimed = true; });
  }
  async start(): Promise<void> {
    if (this.controller?.signal.aborted) await this.pause();
    if (this.controller) return this.starting;
    if (!this.store.data.weixin || !this.dot.profile) throw new Error('请先连接微信和 dot。');
    const controller = this.controller = new AbortController();
    this.starting = (async () => {
      this.status({ detail: '正在同步收取位置…' });
      await this.primeWeixin(controller.signal);
      if (this.store.data.dotCursor === undefined) {
        const latest = await this.dot.latest();
        await this.store.update(s => { s.dotCursor = latest; });
      }
      if (controller.signal.aborted) return;
      await this.store.update(s => { s.enabled = true; });
      if (controller.signal.aborted) return;
      this.status({ running: true, detail: '已连接。去微信里给 dot 发一句话吧。', needsReview: false });
      this.tasks = Promise.all([this.receive(controller.signal), this.pump(controller.signal)]).then(() => {});
    })();
    try { await this.starting; }
    catch (e) { if (!controller.signal.aborted) { this.controller = undefined; throw e; } }
    finally { this.starting = undefined; }
  }
  async pause(): Promise<void> {
    this.controller?.abort();
    await this.starting?.catch(() => {});
    await this.tasks;
    this.controller = undefined;
    await this.store.update(s => { s.enabled = false; });
    this.status({ running: false, detail: '连接已暂停。' });
  }
  private async receive(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const page = await this.weixin.updates(this.store.data.weixinCursor, signal);
        if (signal.aborted) break;
        await acceptWeixin(this.store, page.msgs ?? [], page.get_updates_buf);
        this.status({ weixin: 'ready', weixinDetail: '微信已连接' });
      } catch (e) {
        if (signal.aborted) break;
        this.status({ weixin: 'error', weixinDetail: (e as Error).message });
        if (e instanceof WeixinExpiredError) { this.controller?.abort(); this.status({ running: false }); break; }
      }
      await delay(this.config.weixin.retryDelayMs, undefined, { signal }).catch(() => {});
    }
  }
  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const messages = await this.dot.messages(this.store.data.dotCursor ?? '');
        if (signal.aborted) break;
        await acceptDot(this.store, messages, this.dot.members);
        await this.deliver(signal);
        if (!signal.aborted) await this.submit();
        this.status({ dot: 'ready', dotDetail: 'dot 已连接', updatedAt: new Date().toISOString() });
      } catch (e) {
        if (signal.aborted) break;
        this.status({ detail: (e as Error).message, needsReview: nextInbound(this.store.data)?.phase === 'sending' });
      }
      await delay(this.config.dot.pollIntervalMs, undefined, { signal }).catch(() => {});
    }
  }
  private async submit(): Promise<void> {
    const job = nextInbound(this.store.data);
    if (!job) return;
    if (job.phase === 'sending') {
      const found = job.requestId && await this.dot.findRequest(job.requestId, job.beforeCursor ?? '');
      if (found) {
        await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; j.phase = 'done'; j.dotMessageId = found; });
        this.status({ needsReview: false, detail: '消息已送到 dot。' }); return;
      }
      throw new Error('上一条消息的发送结果尚未确认。请打开 ChatGPT 核对，再选择「已收到」或「重试」。');
    }
    const text = (job.message.item_list ?? []).map(i => i.text_item?.text ?? i.voice_item?.text ?? '').filter(Boolean).join('\n');
    if (!text) throw new Error('这条消息含有附件，请等媒体功能接入后重试。');
    await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; j.phase = 'sending'; j.text = text; j.beforeCursor = s.dotCursor; });
    const id = await this.dot.send(text, [], async requestId => {
      await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.requestId = requestId; });
    });
    await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; j.phase = 'done'; j.dotMessageId = id; });
    this.status({ detail: '消息已送到 dot，等它回复。', needsReview: false });
  }
  private async deliver(signal: AbortSignal): Promise<void> {
    if (!this.store.data.contextToken) return;
    for (const job of this.store.data.outbound.filter(j => j.phase !== 'done')) {
      const parts = splitText(job.message.text, this.config.weixin.maxTextLength);
      if (job.message.attachments.length) throw new Error('dot 回复中含有附件，媒体功能接入后会继续发送。');
      for (let i = job.part; i < parts.length; i++) {
        if (signal.aborted) return;
        const clientId = createHash('sha256').update(`${this.store.data.weixin!.botId}:${job.id}:${i}`).digest('hex');
        await this.weixin.send([{ type: 1, text_item: { text: parts[i] } }], this.store.data.contextToken!, clientId);
        await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.part = i + 1; });
      }
      await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.phase = 'done'; });
      this.status({ detail: 'dot 的回复已送到微信。' });
    }
  }
  async resolveUncertain(retry: boolean): Promise<void> {
    await this.pause();
    await this.store.update(s => { const job = nextInbound(s); if (job?.phase === 'sending') { job.phase = retry ? 'pending' : 'done'; if (retry) delete job.requestId; } });
    this.status({ needsReview: false });
    await this.start();
  }
}
