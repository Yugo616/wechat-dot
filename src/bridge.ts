import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { Config } from './config';
import type { AppStatus, BridgeTask, DotAttachment, InboundJob, LocalFile, RetryStatus, WeixinItem } from './types';
import { StateStore } from './state';
import { WeixinClient, WeixinExpiredError, WeixinSendRejectedError } from './weixin/client';
import { DotClient } from './dot/client';
import { DotAccessError } from './dot/errors';
import { acceptDot, acceptWeixin, expireBacklog, nextInbound, splitText } from './queue';
import { MediaStore, MessageContentError } from './media';
import { WeixinMedia } from './weixin/media';
import { silkToWav } from './weixin/voice';
import { connectionRetry } from './status';

class ExpiredMessageError extends Error {}

export class Bridge {
  private controller?: AbortController;
  private tasks?: Promise<void>;
  private starting?: Promise<void>;
  private skippedMessages = 0;
  private failures = new Map<BridgeTask, { error: Error; retry?: RetryStatus }>();
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
      this.skippedMessages = 0;
      this.status({ detail: '正在同步收取位置…', skippedMessages: 0 });
      await this.primeWeixin(controller.signal);
      if (this.store.data.dotCursor === undefined) {
        const baseline = await this.dot.baseline();
        await this.store.update(s => { s.dotCursor = baseline.cursor; s.dotPending = baseline.pending; });
      }
      if (controller.signal.aborted) return;
      await this.expire();
      const keep = new Set([this.store.data, ...Object.values(this.store.data.savedConnections ?? {})].flatMap(s => [
        ...s.inbound.filter(j => j.phase !== 'done' || j.composing).flatMap(j => j.prepared?.files.map(f => f.path) ?? []),
        ...s.outbound.filter(j => j.phase !== 'done').flatMap(j => Object.values(j.media ?? {}).map(m => m.file.path))
      ]));
      await this.media.cleanup(keep);
      if (controller.signal.aborted) return;
      await this.store.update(s => { s.enabled = true; });
      if (controller.signal.aborted) return;
      this.failures.clear();
      this.status({ running: true, detail: '现在可以在微信里聊天了。', needsReview: false, problem: undefined, weixinRetry: undefined, dotRetry: undefined, retries: {} });
      const signal = controller.signal, interval = this.config.dot.pollIntervalMs;
      this.tasks = Promise.all([
        this.loop('weixinReceive', this.config.weixin.retryDelayMs, signal, async () => {
          const page = await this.weixin.updates(this.store.data.weixinCursor, signal);
          if (signal.aborted) return;
          await acceptWeixin(this.store, page.msgs ?? [], page.get_updates_buf);
          this.status({ weixin: 'ready', weixinDetail: '扫码绑定已保存', weixinSendError: this.store.data.weixinSendError });
        }),
        this.loop('dotReceive', interval, signal, async () => {
          const messages = await this.dot.messages(this.store.data.dotCursor ?? '', this.store.data.dotPending);
          if (signal.aborted) return;
          this.skipped(await acceptDot(this.store, messages, this.dot.members, this.config.storage.maxBacklogAgeMs));
          this.status({ dot: 'ready', dotDetail: this.dot.profile?.name ?? '我的 dot', updatedAt: new Date().toISOString() });
        }),
        this.loop('dotSend', interval, signal, () => this.submit(signal)),
        this.loop('textSend', interval, signal, () => this.deliver(signal, 'text')),
        this.loop('mediaSend', interval, signal, () => this.deliver(signal, 'media'))
      ]).then(() => {});
    })();
    try { await this.starting; }
    catch (e) {
      if (!controller.signal.aborted) {
        if (e instanceof DotAccessError || e instanceof WeixinExpiredError) await this.stopForAccess(e);
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
    this.failures.clear();
    this.status({ running: false, detail: '点击开始转发，即可在微信里聊天。', problem: undefined, weixinRetry: undefined, dotRetry: undefined, retries: {} });
  }
  private skipped(count: number): void {
    if (!count) return;
    this.skippedMessages += count;
    this.status({ skippedMessages: this.skippedMessages });
  }
  private async expire(): Promise<void> {
    this.skipped(await expireBacklog(this.store, this.config.storage.maxBacklogAgeMs));
  }
  private publishFailures(): void {
    const retries: AppStatus['retries'] = {};
    let problem: string | undefined, weixinRetry: string | undefined, dotRetry: string | undefined;
    for (const [task, failure] of this.failures) {
      if (failure.retry) {
        retries[task] = { ...failure.retry };
        const text = connectionRetry(failure.error) ?? '附件暂未送达，正在自动重试。新的文字消息可以继续收发。';
        if (task === 'weixinReceive' || task === 'textSend') weixinRetry = text;
        else dotRetry = text;
      } else problem ??= failure.error.message;
    }
    this.status({ retries, problem, weixinRetry, dotRetry, needsReview: Boolean(this.failures.get('dotSend') && !this.failures.get('dotSend')!.retry && nextInbound(this.store.data)?.phase === 'sending') });
  }
  private async loop(task: BridgeTask, interval: number, signal: AbortSignal, operation: () => Promise<void>): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.expire();
        if (signal.aborted) break;
        const previous = this.failures.get(task);
        if (previous?.retry) {
          previous.retry = { attempt: previous.retry.attempt + 1 };
          this.publishFailures();
        }
        await operation();
        if (signal.aborted) break;
        if (this.failures.delete(task)) this.publishFailures();
      } catch (e) {
        if (signal.aborted) break;
        if (e instanceof DotAccessError || e instanceof WeixinExpiredError) { await this.stopForAccess(e); break; }
        const retryable = connectionRetry(e) || task === 'mediaSend' || /会自动重试/.test((e as Error).message);
        this.failures.set(task, { error: e as Error, retry: retryable ? { attempt: this.failures.get(task)?.retry?.attempt ?? 1, nextRetryAt: Date.now() + interval } : undefined });
        if (task === 'weixinReceive') this.status({ weixin: retryable ? 'ready' : 'error', weixinDetail: retryable ? '扫码绑定已保存' : (e as Error).message });
        this.publishFailures();
      }
      await delay(interval, undefined, { signal }).catch(() => {});
    }
  }
  private async stopForAccess(error: DotAccessError | WeixinExpiredError): Promise<void> {
    this.controller?.abort();
    await this.store.update(s => { s.enabled = false; });
    this.failures.clear();
    this.status({ running: false, ...(error instanceof WeixinExpiredError ? { weixin: 'error', weixinDetail: error.message } : { dot: 'error', dotDetail: error.message }), problem: error.message, weixinRetry: undefined, dotRetry: undefined, retries: {},
      needsReview: nextInbound(this.store.data)?.phase === 'sending' });
  }
  private async submit(signal?: AbortSignal): Promise<void> {
    await this.expire();
    for (const expired of this.store.data.inbound.filter(j => j.expired && j.composing)) {
      await this.dot.clearDraft(expired.prepared?.text ?? expired.text ?? '', expired.prepared?.files ?? []);
      await this.store.update(s => { delete s.inbound.find(j => j.id === expired.id)!.composing; });
    }
    signal?.throwIfAborted();
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
    let prepared: { text: string; files: LocalFile[] };
    try {
      prepared = job.prepared ?? await this.prepare(job);
      if (!prepared.text.trim() && !prepared.files.length) throw new MessageContentError('这条消息没有可发送的文字、图片或文件，请改发文字、图片或文件。');
    } catch (error) {
      if (!(error instanceof MessageContentError)) throw error;
      const detail = `已跳过这条消息：${error.message}`;
      await this.store.update(s => {
        const pending = s.inbound.find(j => j.id === job.id)!;
        pending.phase = 'done'; pending.lastError = error.message;
        const id = `input-error:${job.id}`;
        if (!s.outbound.some(j => j.id === id)) s.outbound.push({ id, phase: 'pending', part: 0, message: { id, text: `WeChat Dot：${detail}`, attachments: [], complete: true, createdAt: new Date().toISOString() } });
      });
      this.status({ detail, needsReview: false });
      return;
    }
    await this.expire();
    signal?.throwIfAborted();
    if (this.store.data.inbound.find(j => j.id === job.id)!.expired) return;
    const { text, files } = prepared;
    const id = await this.dot.send(text, files, async requestId => {
      await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.requestId = requestId; });
    }, async () => {
      signal?.throwIfAborted();
      await this.expire();
      signal?.throwIfAborted();
      if (this.store.data.inbound.find(j => j.id === job.id)!.expired) throw new ExpiredMessageError();
      await this.store.update(s => { signal?.throwIfAborted(); const j = s.inbound.find(j => j.id === job.id)!; if (j.expired) throw new ExpiredMessageError(); j.phase = 'sending'; j.text = text; j.beforeCursor = s.dotCursor; });
      if (signal?.aborted) {
        await this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; if (!j.expired) j.phase = 'pending'; });
        signal.throwIfAborted();
      }
    }, {
      resume: !!job.composing,
      begin: () => this.store.update(s => { s.inbound.find(j => j.id === job.id)!.composing = true; }),
      reset: () => this.store.update(s => { delete s.inbound.find(j => j.id === job.id)!.composing; }),
      notSubmitted: () => this.store.update(s => { const j = s.inbound.find(j => j.id === job.id)!; if (!j.expired) j.phase = 'pending'; })
    }).catch(async error => {
      if (error instanceof ExpiredMessageError) return undefined;
      await this.store.update(s => { s.inbound.find(j => j.id === job.id)!.lastError = (error as Error).message; });
      throw error;
    });
    if (!id) return;
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
  private async deliver(signal: AbortSignal, kind: 'text' | 'media' | 'all' = 'all'): Promise<void> {
    await this.expire();
    if (!this.store.data.contextToken || this.store.data.weixinSendError) return;
    for (const job of this.store.data.outbound.filter(j => j.phase !== 'done')) {
      const parts: Array<{ text?: string; attachment?: DotAttachment }> = [
        ...splitText(job.message.text, this.config.weixin.maxTextLength).map(text => ({ text })),
        ...job.message.attachments.map(attachment => ({ attachment }))
      ];
      const textCount = parts.length - job.message.attachments.length;
      if (kind === 'media' && job.part < textCount) continue;
      for (let i = job.part; i < parts.length; i++) {
        if (signal.aborted) return;
        if (kind === 'text' && i >= textCount) break;
        await this.expire();
        if (signal.aborted) return;
        if (this.store.data.outbound.find(j => j.id === job.id)!.phase === 'done') break;
        const clientId = createHash('sha256').update(`${this.store.data.weixin!.botId}:${job.id}:${i}`).digest('hex');
        let item: WeixinItem;
        if (parts[i].attachment) {
          this.status({ detail: '正在把 dot 的附件发到微信…' });
          let contentError = this.store.data.outbound.find(j => j.id === job.id)!.contentErrors?.[i];
          try {
            if (contentError) throw new MessageContentError(contentError);
            let cached = this.store.data.outbound.find(j => j.id === job.id)!.media?.[i];
            if (!cached) {
              const file = await this.dot.download(parts[i].attachment!, this.media);
              await this.store.update(s => { (s.outbound.find(j => j.id === job.id)!.media ??= {})[i] = { file }; });
              cached = { file };
            }
            item = cached.item ?? await this.weixinMedia.upload(cached.file);
            if (!cached.item) await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.media![i].item = item; });
          } catch (error) {
            if (!(error instanceof MessageContentError)) throw error;
            contentError = error.message;
            await this.store.update(s => { (s.outbound.find(j => j.id === job.id)!.contentErrors ??= {})[i] = contentError!; });
            item = { type: 1, text_item: { text: `WeChat Dot：附件「${parts[i].attachment!.name}」无法转发。${contentError}\n可在 dot 中查看原文件。` } };
          }
        } else item = { type: 1, text_item: { text: parts[i].text! } };
        if (signal.aborted) return;
        await this.expire();
        if (signal.aborted) return;
        if (this.store.data.outbound.find(j => j.id === job.id)!.phase === 'done') break;
        if (this.store.data.weixinSendError) return;
        const context = this.store.data.contextToken!;
        const lastContextMessageId = this.store.data.inbound.filter(j => j.message.context_token).at(-1)?.id;
        try { await this.weixin.send([item], context, clientId); }
        catch (error) {
          if (!(error instanceof WeixinSendRejectedError)) throw error;
          await this.store.update(s => {
            if (s.contextToken === context && s.inbound.filter(j => j.message.context_token).at(-1)?.id === lastContextMessageId) s.weixinSendError = error.message;
          });
          this.status({ weixinSendError: this.store.data.weixinSendError });
          return;
        }
        await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.part = i + 1; });
      }
      if (this.store.data.outbound.find(j => j.id === job.id)!.part >= parts.length) {
        await this.store.update(s => { s.outbound.find(j => j.id === job.id)!.phase = 'done'; });
        this.status({ detail: 'dot 的回复已送到微信。' });
      }
    }
  }
  async resolveUncertain(retry: boolean): Promise<void> {
    await this.store.update(s => { const job = nextInbound(s); if (job?.phase === 'sending') { job.phase = retry ? 'pending' : 'done'; delete job.lastError; if (retry) delete job.requestId; } });
    this.status({ needsReview: false });
  }
}
