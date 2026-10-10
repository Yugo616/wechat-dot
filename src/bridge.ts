import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { Config } from './config';
import type { AppStatus, DotAttachment, InboundJob, LocalFile, WeixinItem } from './types';
import { StateStore } from './state';
import { WeixinClient, WeixinExpiredError } from './weixin/client';
import { DotClient } from './dot/client';
import { DotAccessError } from './dot/errors';
import { acceptDot, acceptWeixin, nextInbound, splitText } from './queue';
import { MediaStore } from './media';
import { WeixinMedia } from './weixin/media';
import { silkToWav } from './weixin/voice';

export class Bridge {
  private controller?: AbortController;
  private tasks?: Promise<void>;
  private starting?: Promise<void>;
  private readonly media: MediaStore;
  private readonly weixinMedia: WeixinMedia;
  constructor(readonly store: StateStore, readonly weixin: WeixinClient, readonly dot: DotClient, readonly config: Config, readonly status: (patch: Partial<AppStatus>) => void) {
    this.media = new MediaStore(store.directory, config.storage);
    this.weixinMedia = new WeixinMedia(weixin, this.media);
  }
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
      const keep = new Set([this.store.data, ...Object.values(this.store.data.savedConnections ?? {})].flatMap(s => [
        ...s.inbound.filter(j => j.phase !== 'done').flatMap(j => j.prepared?.files.map(f => f.path) ?? []),
        ...s.outbound.filter(j => j.phase !== 'done').flatMap(j => Object.values(j.media ?? {}).map(m => m.file.path))
      ]));
      await this.media.cleanup(keep);
      await this.primeWeixin(controller.signal);
      if (this.store.data.dotCursor === undefined) {
        const baseline = await this.dot.baseline();
        await this.store.update(s => { s.dotCursor = baseline.cursor; s.dotPending = baseline.pending; });
      }
      if (controller.signal.aborted) return;
      await this.store.update(s => { s.enabled = true; });
      if (controller.signal.aborted) return;
      this.status({ running: true, detail: '现在可以在微信里聊天了。', needsReview: false, problem: undefined });
      this.tasks = Promise.all([this.receive(controller.signal), this.pump(controller.signal)]).then(() => {});
    })();
    try { await this.starting; }
    catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof DotAccessError) await this.stopForAccess(e);
        this.controller = undefined;
        throw e;
      }
    }
    finally { this.starting = undefined; }
  }
  async pause(): Promise<void> {
    this.controller?.abort();
    await this.starting?.catch(() => {});
    await this.tasks;
    this.controller = undefined;
    await this.store.update(s => { s.enabled = false; });
    this.status({ running: false, detail: '连接已暂停。', problem: undefined });
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
        const messages = await this.dot.messages(this.store.data.dotCursor ?? '', this.store.data.dotPending);
        if (signal.aborted) break;
        await acceptDot(this.store, messages, this.dot.members);
        await this.deliver(signal);
        if (!signal.aborted) await this.submit();
        this.status({ dot: 'ready', dotDetail: this.dot.profile?.name ?? 'dot 已连接', updatedAt: new Date().toISOString(), problem: undefined });
      } catch (e) {
        if (signal.aborted) break;
        if (e instanceof DotAccessError) { await this.stopForAccess(e); break; }
        this.status({ problem: (e as Error).message, needsReview: nextInbound(this.store.data)?.phase === 'sending' });
      }
      await delay(this.config.dot.pollIntervalMs, undefined, { signal }).catch(() => {});
    }
  }
  private async stopForAccess(error: DotAccessError): Promise<void> {
    this.controller?.abort();
    await this.store.update(s => { s.enabled = false; });
    this.status({ running: false, dot: 'error', dotDetail: error.message, problem: error.message,
      needsReview: nextInbound(this.store.data)?.phase === 'sending' });
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
      throw new Error(job.lastError ?? '上一条消息的发送结果尚未确认。请打开 ChatGPT 核对，再选择「已收到」或「重试」。');
    }
    const { text, files } = job.prepared ?? await this.prepare(job);
    if (!text && !files.length) throw new Error('这条消息没有可发送的文字、图片或文件，请重新发送。');
    const id = await this.dot.send(text, files, async requestId => {
      await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.requestId = requestId; });
    }, async () => {
      await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; j.phase = 'sending'; j.text = text; j.beforeCursor = s.dotCursor; });
    }, {
      resume: !!job.composing,
      begin: () => this.store.update(s => { s.inbound.find(j => j.id === job.id)!.composing = true; }),
      reset: () => this.store.update(s => { delete s.inbound.find(j => j.id === job.id)!.composing; }),
      notSubmitted: () => this.store.update(s => { s.inbound.find(j => j.id === job.id)!.phase = 'pending'; })
    }).catch(async error => {
      await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.lastError = (error as Error).message; });
      throw error;
    });
    await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; j.phase = 'done'; j.dotMessageId = id; delete j.composing; delete j.lastError; });
    this.status({ detail: '消息已送到 dot，等它回复。', needsReview: false });
  }
  private async prepare(job: InboundJob): Promise<{ text: string; files: LocalFile[] }> {
    const texts: string[] = [], files: LocalFile[] = [];
    for (const [index, item] of (job.message.item_list ?? []).entries()) {
      if (item.text_item?.text) texts.push(item.text_item.text);
      const key = `${this.store.data.weixin?.botId}:${job.id}:${index}`;
      if (item.image_item || item.file_item) {
        this.status({ detail: '正在接收微信附件…' });
        files.push(await this.weixinMedia.download(item, key));
      }
      if (item.voice_item) {
        if (item.voice_item.text?.trim()) texts.push(item.voice_item.text.trim());
        else {
          this.status({ detail: '正在识别语音…' });
          const voice = await this.weixinMedia.download(item, key);
          const wav = await silkToWav(await this.media.read(voice), this.config.weixin.voiceSampleRate);
          const file = await this.media.save(key, '语音.wav', wav, 'audio/wav');
          texts.push(await this.dot.transcribe(file));
        }
      }
    }
    const prepared = { text: texts.join('\n'), files };
    await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.prepared = prepared; });
    return prepared;
  }
  private async deliver(signal: AbortSignal): Promise<void> {
    if (!this.store.data.contextToken) return;
    for (const job of this.store.data.outbound.filter(j => j.phase !== 'done')) {
      const parts: Array<{ text?: string; attachment?: DotAttachment }> = [
        ...splitText(job.message.text, this.config.weixin.maxTextLength).map(text => ({ text })),
        ...job.message.attachments.map(attachment => ({ attachment }))
      ];
      for (let i = job.part; i < parts.length; i++) {
        if (signal.aborted) return;
        const clientId = createHash('sha256').update(`${this.store.data.weixin!.botId}:${job.id}:${i}`).digest('hex');
        let item: WeixinItem;
        if (parts[i].attachment) {
          this.status({ detail: '正在把 dot 的附件发到微信…' });
          let cached = this.store.data.outbound.find(j => j.id === job.id)!.media?.[i];
          if (!cached) {
            const file = await this.dot.download(parts[i].attachment!, this.media);
            await this.store.update(s => { (s.outbound.find(j => j.id === job.id)!.media ??= {})[i] = { file }; });
            cached = { file };
          }
          item = cached.item ?? await this.weixinMedia.upload(cached.file);
          if (!cached.item) await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.media![i].item = item; });
        } else item = { type: 1, text_item: { text: parts[i].text! } };
        if (signal.aborted) return;
        await this.weixin.send([item], this.store.data.contextToken!, clientId);
        await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.part = i + 1; });
      }
      await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.phase = 'done'; });
      this.status({ detail: 'dot 的回复已送到微信。' });
    }
  }
  async resolveUncertain(retry: boolean): Promise<void> {
    await this.pause();
    await this.store.update(s => { const job = nextInbound(s); if (job?.phase === 'sending') { job.phase = retry ? 'pending' : 'done'; delete job.lastError; if (retry) delete job.requestId; } });
    this.status({ needsReview: false });
    await this.start();
  }
}
