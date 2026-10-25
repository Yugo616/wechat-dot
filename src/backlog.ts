import { connectionKey, type StateStore } from './state';
import type { BacklogSelection, BacklogSnapshot, BridgeState, InboundJob, OutboundJob } from './types';

export function isHeld(job: InboundJob | OutboundJob): boolean {
  return job.phase === 'done' && Boolean(job.expired) && !job.dismissed && !('dotMessageId' in job && job.dotMessageId);
}
export function countBacklog(state: BridgeState): number {
  return state.inbound.filter(isHeld).length + state.outbound.filter(isHeld).length;
}
export function backlogSnapshot(state: BridgeState): BacklogSnapshot {
  return { connection: connectionKey(state) ?? '', items: [
    ...state.inbound.filter(isHeld).map(job => ({ key: `inbound:${job.id}`, direction: 'inbound' as const,
      text: job.prepared?.text || job.text || (job.message.item_list ?? []).map(item => item.text_item?.text || item.voice_item?.text || (item.image_item ? '[图片]' : item.file_item ? `[文件] ${item.file_item.file_name ?? ''}` : item.voice_item ? '[语音]' : '')).filter(Boolean).join('\n') || '[附件]',
      timestamp: job.message.create_time_ms || job.queuedAt, partial: false })),
    ...state.outbound.filter(isHeld).map(job => ({ key: `outbound:${job.id}`, direction: 'outbound' as const,
      text: [job.message.text, ...job.message.attachments.map(file => `[文件] ${file.name}`)].filter(Boolean).join('\n') || '等待 dot 完成回复',
      timestamp: Date.parse(job.message.createdAt) || job.queuedAt, partial: job.part > 0 }))
  ].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)) };
}

export function discardHeldContent(job: InboundJob | OutboundJob): void {
  if ('part' in job) {
    job.message = { ...job.message, text: '', attachments: [] };
    delete job.media; delete job.contentErrors;
  } else if (!job.composing) {
    delete job.message.item_list; delete job.prepared; delete job.text; delete job.lastError;
  }
}

export async function manageBacklog(store: StateStore, action: 'restore' | 'clear', selection: BacklogSelection, now = Date.now()): Promise<number> {
  if (!selection || !Array.isArray(selection.keys) || !selection.keys.every(key => typeof key === 'string') || !['restore', 'clear'].includes(action)) throw new Error('暂存列表已变化，请重新打开。');
  const selected = new Set(selection.keys);
  let changed = 0;
  await store.update(state => {
    if (!selection.connection || selection.connection !== connectionKey(state)) throw new Error('账号连接已切换，请重新打开暂存消息。');
    for (const direction of ['inbound', 'outbound'] as const) for (const job of state[direction]) {
      if (!isHeld(job) || !selected.has(`${direction}:${job.id}`)) continue;
      if (action === 'clear') {
        job.dismissed = true;
        discardHeldContent(job);
      } else {
        job.restoredAt = now;
        delete job.expired; delete job.dismissed;
        if ('part' in job) {
          job.phase = 'pending';
          if (!job.message.complete) {
            state.dotPending = [...new Set([...(state.dotPending ?? []), job.id])];
            (state.dotPendingSince ??= {})[job.id] = now;
          }
        } else {
          job.phase = job.resumePhase ?? (job.requestId || job.beforeCursor !== undefined ? 'sending' : 'pending');
          delete job.resumePhase; delete job.lastError;
        }
      }
      changed++;
    }
  });
  return changed;
}
