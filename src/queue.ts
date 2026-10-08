import type { StateStore } from './state';
import type { BridgeState, WeixinMessage } from './types';
import { normalizeDotMessage } from './dot/protocol';
export async function acceptWeixin(store: StateStore, messages: WeixinMessage[], cursor?: string): Promise<void> {
  await store.update(s => {
    const known = new Set(s.inbound.map(j => j.id));
    for (const message of messages) {
      if (!message.message_id || message.from_user_id !== s.weixin?.userId || message.message_type !== 1 || (message.message_state != null && message.message_state !== 2)) continue;
      if (message.context_token) s.contextToken = message.context_token;
      if (known.has(message.message_id)) continue;
      s.inbound.push({ id: message.message_id, phase: 'pending', message });
      known.add(message.message_id);
    }
    if (cursor !== undefined) s.weixinCursor = cursor;
  });
}
export async function acceptDot(store: StateStore, messages: any[], members: Set<string>): Promise<void> {
  await store.update(s => {
    const known = new Set(s.outbound.map(j => j.id));
    for (const raw of messages) {
      const message = normalizeDotMessage(raw, members);
      if (message && !message.complete) break;
      if (message && (message.text || message.attachments.length) && !known.has(message.id)) {
        s.outbound.push({ id: message.id, message, phase: 'pending', part: 0 });
        known.add(message.id);
      }
      if (s.dotPending?.includes(raw.id)) s.dotPending = s.dotPending.filter(id => id !== raw.id);
      else if (raw.id) s.dotCursor = raw.id;
    }
  });
}
export function nextInbound(state: BridgeState) { return state.inbound.find(j => j.phase !== 'done'); }
export function splitText(text: string, limit: number): string[] {
  if (limit <= 0) throw new Error('微信文字长度配置须大于 0。');
  const chars = Array.from(text), result: string[] = [];
  for (let i = 0; i < chars.length; i += limit) result.push(chars.slice(i, i + limit).join(''));
  return result;
}
