import type { DotAttachment, DotMessage } from '../types';

export function messageBaseline(items: any[], members: Set<string>): { cursor: string; pending: string[] } {
  return { cursor: items.at(-1)?.id ?? '', pending: items.filter(raw => normalizeDotMessage(raw, members)?.complete === false).map(raw => raw.id) };
}

export function normalizeDotMessage(raw: any, dotMembers: Set<string>): DotMessage | null {
  if (!raw?.id || raw.deleted_at || raw.deletedAt) return null;
  const projected = Array.isArray(raw.raw_messages);
  if (!projected && !dotMembers.has(raw.account_user_id)) return null;
  const parts = projected ? raw.raw_messages.filter((m: any) =>
    m.author?.role === 'assistant' && m.channel !== 'analysis' &&
    !m.metadata?.is_hidden && !m.metadata?.hidden && !m.metadata?.is_visually_hidden_from_conversation &&
    (!m.recipient || m.recipient === 'all')
  ).flatMap((m: any) => (m.content?.parts ?? []).filter((p: unknown) => typeof p === 'string')) : [raw.content?.text ?? ''];
  const source = projected ? raw.attachments : raw.content?.attachments;
  const attachments: DotAttachment[] = (source ?? []).flatMap((a: any): DotAttachment[] => {
    if (a.type === 'file') return [{ id: a.file_id ?? a.file?.id ?? a.attachment_id,
      name: a.file?.name ?? a.name ?? '附件', mime: a.file?.mime_type ?? a.mime_type ?? 'application/octet-stream' }];
    if (a.type === 'media' && a.image_url) return [{ id: a.attachment_id ?? a.image_url,
      name: a.name ?? '图片', mime: a.mime_type ?? 'application/octet-stream', url: a.image_url }];
    return [];
  }).filter((a: DotAttachment) => !!a.id);
  const needsAction = raw.content?.elicitation || source?.some((a: any) => a.type === 'widget');
  let text = parts.join('\n\n').trim();
  if (needsAction && !text) text = 'dot 有一项操作需要你在 ChatGPT 中处理。';
  const unfinished = ['in_progress', 'pending', 'generating'].includes(raw.generation?.status) || source?.some((a: any) => a.generating);
  return { id: raw.id, text, createdAt: raw.created_at ?? '', complete: !unfinished, attachments };
}

export async function collectNewMessages(cursor: string, pageSize: number, getPage: (after: string, limit: number, before?: string) => Promise<any>): Promise<any[]> {
  const result: any[] = [];
  const visited = new Set<string>();
  if (!cursor) {
    let before: string | undefined;
    do {
      const page = await getPage('', pageSize, before);
      if (!Array.isArray(page.items)) throw new Error('dot 消息格式已变化，请检查更新。');
      result.unshift(...page.items);
      before = page.prev_cursor ?? undefined;
      if (!before || visited.has(before)) break;
      visited.add(before);
    } while (before);
    return [...new Map(result.map(item => [item.id, item])).values()];
  }
  while (!visited.has(cursor)) {
    visited.add(cursor);
    const page = await getPage(cursor, pageSize);
    if (!Array.isArray(page.items)) throw new Error('dot 消息格式已变化，请检查更新。');
    result.push(...page.items);
    const next = page.next_cursor ?? (page.items.length >= pageSize ? page.items.at(-1)?.id : null);
    if (!next || page.items.length === 0) break;
    cursor = next;
  }
  return [...new Map(result.map(item => [item.id, item])).values()];
}
