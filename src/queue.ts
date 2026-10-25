import type { StateStore } from './state';
import type { BridgeState, WeixinMessage } from './types';
import { normalizeDotMessage } from './dot/protocol';
import defaults from '../config/defaults.json';

function messageTime(created: string | number | undefined, queuedAt: number): number {
  const time = typeof created === 'string' ? Date.parse(created) : created;
  return time && Number.isFinite(time) ? Math.min(time, queuedAt) : queuedAt;
}
export async function expireBacklog(store: StateStore, maxAgeMs: number, now = Date.now()): Promise<number> {
  const time = (job: BridgeState['inbound'][number] | BridgeState['outbound'][number]) =>
    job.restoredAt ?? messageTime('part' in job ? job.message.createdAt : job.message.create_time_ms, job.queuedAt ?? now);
  const pending = [...store.data.inbound, ...store.data.outbound].filter(j => j.phase !== 'done');
  if (!pending.some(j => j.queuedAt === undefined || now - time(j) >= maxAgeMs)) return 0;
  let skipped = 0;
  await store.update(s => {
    for (const job of [...s.inbound, ...s.outbound]) {
      if (job.phase === 'done') continue;
      job.queuedAt ??= now;
      if (now - time(job) < maxAgeMs) continue;
      if (!('part' in job)) job.resumePhase = job.phase;
      else if (s.dotPending?.includes(job.id)) {
        s.dotPending = s.dotPending.filter(id => id !== job.id);
        if (s.dotPendingSince) delete s.dotPendingSince[job.id];
      }
      job.phase = 'done'; job.expired = true; skipped++;
      // Keep the receipt and any owned draft, so reconnecting cannot replay it.
    }
  });
  return skipped;
}
export async function acceptWeixin(store: StateStore, messages: WeixinMessage[], cursor?: string): Promise<void> {
  if (!messages.length && (cursor === undefined || cursor === store.data.weixinCursor)) return;
  await store.update(s => {
    const known = new Set(s.inbound.map(j => j.id));
    for (const message of messages) {
      if (!message.message_id || message.from_user_id !== s.weixin?.userId || message.message_type !== 1 || (message.message_state != null && message.message_state !== 2)) continue;
      if (known.has(message.message_id)) continue;
      if (message.context_token) { s.contextToken = message.context_token; delete s.weixinSendError; }
      s.inbound.push({ id: message.message_id, phase: 'pending', message, queuedAt: Date.now() });
      known.add(message.message_id);
    }
    if (cursor !== undefined) s.weixinCursor = cursor;
  });
}
export async function acceptDot(store: StateStore, messages: any[], members: Set<string>, maxAgeMs = defaults.storage.maxBacklogAgeMs): Promise<number> {
  if (!messages.length) return 0;
  let skipped = 0;
  await store.update(s => {
    const now = Date.now();
    const known = new Set(s.outbound.map(j => j.id));
    for (const raw of messages) {
      const alreadyKnown = known.has(raw.id);
      const message = normalizeDotMessage(raw, members);
      const restored = s.outbound.find(job => job.id === raw.id && job.restoredAt !== undefined && job.phase !== 'done' && !job.message.complete);
      if (restored && message) {
        restored.message = message;
        if (!message.complete) continue;
      }
      const seenAt = s.dotPendingSince?.[raw.id] ?? now;
      const expired = message && now - messageTime(message.createdAt, seenAt) >= maxAgeMs;
      if (message && !message.complete && !expired && !known.has(message.id)) {
        (s.dotPendingSince ??= {})[raw.id] = seenAt;
        break;
      }
      if (message && (expired || message.text || message.attachments.length) && !known.has(message.id)) {
        s.outbound.push({ id: message.id, message, phase: expired ? 'done' : 'pending', part: 0, queuedAt: seenAt, ...(expired ? { expired: true } : {}) });
        if (expired) skipped++;
        known.add(message.id);
      }
      if (s.dotPendingSince) delete s.dotPendingSince[raw.id];
      if (s.dotPending?.includes(raw.id)) s.dotPending = s.dotPending.filter(id => id !== raw.id);
      else if (raw.id && !alreadyKnown) s.dotCursor = raw.id;
    }
  });
  return skipped;
}
export function nextInbound(state: BridgeState) { return state.inbound.find(j => j.phase !== 'done'); }
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('微信文字长度配置须大于 0。');
  const chars = Array.from(text), result: string[] = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}
