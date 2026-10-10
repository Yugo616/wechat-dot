import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDotMessage, collectNewMessages, messageBaseline } from '../src/dot/protocol';

test('dot participant messages are recognized even when the room uses a user-shaped envelope', () => {
  const result = normalizeDotMessage({ id: 'd1', account_user_id: 'agent-member', created_at: '2026-10-08T01:00:00Z', content: { text: '完成了', attachments: [{ type: 'file', file_id: 'f1', file: { name: '报告.pdf', mime_type: 'application/pdf' } }] } }, new Set(['agent-member']));
  assert.equal(result?.text, '完成了'); assert.equal(result?.attachments[0].name, '报告.pdf');
  assert.equal(normalizeDotMessage({ id: 'u1', account_user_id: 'owner', content: { text: 'hi' } }, new Set(['agent-member'])), null);
});

test('projected reply excludes analysis, hidden parts and incomplete generations', () => {
  const raw = { id: 'd2', created_at: '2026-10-08T01:00:00Z', generation: { status: 'in_progress' }, raw_messages: [
    { author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['private'] } },
    { author: { role: 'assistant' }, channel: 'final', content: { content_type: 'text', parts: ['answer'] } },
    { author: { role: 'assistant' }, metadata: { is_visually_hidden_from_conversation: true }, content: { content_type: 'text', parts: ['hidden'] } }
  ], attachments: [] };
  assert.equal(normalizeDotMessage(raw, new Set())?.complete, false);
  const result = normalizeDotMessage({ ...raw, generation: { status: 'completed' } }, new Set());
  assert.equal(result?.text, 'answer'); assert.equal(result?.complete, true);
});

test('generated image URLs remain attached and wait for generation to finish', () => {
  const raw = { id: 'image-message', raw_messages: [], attachments: [{ type: 'media', attachment_id: 'image-1', image_url: 'https://example.test/image.png', generating: true }] };
  const pending = normalizeDotMessage(raw, new Set());
  assert.equal(pending?.complete, false);
  assert.equal(pending?.attachments[0]?.url, raw.attachments[0].image_url);
  assert.equal(normalizeDotMessage({ ...raw, attachments: [{ ...raw.attachments[0], generating: false }] }, new Set())?.complete, true);
});

test('history drains every page after the cursor instead of dropping burst messages', async () => {
  const pages: Record<string, any> = { start: { items: [{ id: '1' }, { id: '2' }], next_cursor: '2' }, '2': { items: [{ id: '3' }], next_cursor: null } };
  const items = await collectNewMessages('start', 2, async after => pages[after]);
  assert.deepEqual(items.map(m => m.id), ['1', '2', '3']);
});


test('an initially empty room does not drop an entire page of new messages', async () => {
  const result = await collectNewMessages('', 2, async (after, limit, before) => {
    if (!before) return { items: [{ id: '3' }, { id: '4' }], prev_cursor: '3' };
    return { items: [{ id: '1' }, { id: '2' }], prev_cursor: null };
  });
  assert.deepEqual(result.map(m => m.id), ['1', '2', '3', '4']);
});
test('first connection retains unfinished replies and skips completed history', () => {
  const items = [
    { id: 'older', account_user_id: 'dot', content: { text: 'old' } },
    { id: 'unfinished', account_user_id: 'dot', generation: { status: 'in_progress' } },
    { id: 'latest', account_user_id: 'dot', content: { text: 'also old' } }
  ];
  assert.deepEqual(messageBaseline(items, new Set(['dot'])), { cursor: 'latest', pending: ['unfinished'] });
});
