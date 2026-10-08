import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state';
import { acceptWeixin, acceptDot, nextInbound, splitText } from '../src/queue';

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-dot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); await store.load();
  await store.update(s => { s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; });
  return store;
}
test('incoming batch is durable, unique, and restricted to the connected owner', async t => {
  const store = await setup(t);
  const msg = { message_id: 'in-1', message_type: 1, message_state: 2, from_user_id: 'owner', context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '你好' } }] };
  await acceptWeixin(store, [msg, msg, { ...msg, message_id: 'in-2', from_user_id: 'someone-else' }], 'cursor-2');
  const reopened = new StateStore(store.directory); await reopened.load();
  assert.equal(reopened.data.inbound.length, 1);
  assert.equal(reopened.data.weixinCursor, 'cursor-2');
  assert.equal(reopened.data.contextToken, 'ctx');
});
test('unfinished dot response holds the cursor and is queued only after completion', async t => {
  const store = await setup(t);
  const raw = (id: string, status: string) => ({ id, raw_messages: [{ author: { role: 'assistant' }, content: { parts: ['回复'] } }], generation: { status } });
  await acceptDot(store, [raw('d1', 'in_progress'), raw('d2', 'finished')], new Set());
  assert.equal(store.data.outbound.length, 0);
  assert.equal(store.data.dotCursor, undefined);
  await acceptDot(store, [raw('d1', 'finished'), raw('d2', 'finished')], new Set());
  await acceptDot(store, [raw('d2', 'finished')], new Set());
  assert.deepEqual(store.data.outbound.map(j => j.id), ['d1', 'd2']);
  assert.equal(store.data.dotCursor, 'd2');
});
test('a reply already generating at first connection completes without replaying older history', async t => {
  const store = await setup(t);
  await store.update(s => { s.dotCursor = 'latest-old'; s.dotPending = ['generating']; });
  const raw = (id: string, status: string) => ({ id, account_user_id: 'dot', content: { text: id }, generation: { status } });
  const members = new Set(['dot']);
  await acceptDot(store, [raw('generating', 'in_progress'), raw('new', 'completed')], members);
  assert.equal(store.data.dotCursor, 'latest-old');
  const restarted = new StateStore(store.directory); await restarted.load();
  await acceptDot(restarted, [raw('generating', 'completed')], members);
  assert.equal(restarted.data.dotCursor, 'latest-old', 'Finishing a baseline reply must not rewind the history cursor');
  assert.deepEqual(restarted.data.dotPending, []);
  await acceptDot(restarted, [raw('new', 'completed')], members);
  assert.deepEqual(restarted.data.outbound.map(j => j.id), ['generating', 'new']);
  assert.equal(restarted.data.dotCursor, 'new');
});
test('an interrupted native send is reconciled before another message is submitted', async t => {
  const store = await setup(t);
  await store.update(s => { s.inbound = [{ id: 'one', phase: 'sending', message: {} }, { id: 'two', phase: 'pending', message: {} }]; });
  assert.equal(nextInbound(store.data)?.id, 'one');
  assert.equal(nextInbound(store.data)?.phase, 'sending');
});
test('long replies are split without cutting a unicode character', () => {
  const text = '你好😀世界😀再见';
  const parts = splitText(text, 4);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(s => Array.from(s).length <= 4));
});
