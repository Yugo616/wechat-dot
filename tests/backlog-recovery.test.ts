import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import defaults from '../config/defaults.json';
import { StateStore } from '../src/state';
import { Bridge } from '../src/bridge';
import { MediaStore } from '../src/media';
import { acceptDot, acceptWeixin, expireBacklog } from '../src/queue';
import type { InboundJob, OutboundJob } from '../src/types';

const now = Date.now(), old = now - defaults.storage.maxBacklogAgeMs * 2;
const question = (id: string): InboundJob => ({ id, phase: 'pending', message: { message_id: id, from_user_id: 'owner', message_type: 1, create_time_ms: old, item_list: [{ text_item: { text: id } }] } });
const reply = (id: string): OutboundJob => ({ id, phase: 'pending', part: 0, message: { id, text: id, createdAt: new Date(old).toISOString(), complete: true, attachments: [] } });
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-dot-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); await store.load();
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', token: 'fixture-token', baseUrl: '' };
    s.dot = { id: 'dot', name: 'Dot', userId: 'user', accountId: 'account', roomId: 'room', url: '' };
    s.weixinPrimed = true; s.weixinCursor = 'wx-position'; s.dotCursor = 'dot-position'; s.contextToken = 'current-context';
  });
  return store;
}
async function api() {
  const module = await import('../src/backlog.js').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  });
  assert.ok(module?.backlogSnapshot && module?.manageBacklog, 'Held messages need a persistent snapshot and restore/clear operations');
  return module;
}

test('held count includes earlier sessions, rather than only this start', async t => {
  const store = await setup(t);
  await store.update(s => { s.inbound = [{ ...question('question'), phase: 'done', expired: true }]; s.outbound = [{ ...reply('reply'), phase: 'done', expired: true }]; });
  const status: any = {};
  const bridge = new Bridge(store, { updates: async () => ({}) } as any, { profile: store.data.dot, members: new Set(), messages: async () => [] } as any, defaults, p => Object.assign(status, p));
  try { await bridge.start(); assert.equal(status.skippedMessages, 2); }
  finally { await bridge.pause(); }
});

test('restored questions and replies have a new retry window without changing source timestamps', async t => {
  const store = await setup(t);
  await store.update(s => { s.inbound = [{ ...question('q'), restoredAt: now } as any]; s.outbound = [{ ...reply('r'), restoredAt: now } as any]; });
  assert.equal(await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now + 1), 0);
  assert.equal(store.data.inbound[0].phase, 'pending');
  assert.equal(store.data.inbound[0].message.create_time_ms, old);
  assert.equal(await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now + defaults.storage.maxBacklogAgeMs), 2);
});

test('selected recovery is durable, idempotent and cannot restore unselected or already delivered messages', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.inbound = [question('one'), question('two')]; s.outbound = [reply('three'), { ...reply('delivered'), phase: 'done' }]; });
  await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now);
  const snapshot = backlogSnapshot(store.data);
  assert.deepEqual(snapshot.items.map(j => j.key), ['inbound:one', 'inbound:two', 'outbound:three']);
  const selection = { connection: snapshot.connection, keys: ['inbound:two', 'outbound:three', 'outbound:delivered', 'inbound:two'] };
  assert.equal(await manageBacklog(store, 'restore', selection, now), 2);
  assert.equal(await manageBacklog(store, 'restore', selection, now), 0);
  const saved = new StateStore(store.directory); await saved.load();
  assert.deepEqual(backlogSnapshot(saved.data).items.map(j => j.key), ['inbound:one']);
  assert.equal(saved.data.inbound[1].phase, 'pending');
  assert.equal(saved.data.outbound[0].phase, 'pending');
  assert.equal(saved.data.outbound[1].phase, 'done');
  assert.equal(saved.data.enabled, false);
  assert.equal(saved.data.dotCursor, 'dot-position');
});

test('clearing only the displayed held items removes their content and survives duplicate receipt/restart', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  const original = question('held').message;
  await store.update(s => { s.inbound = [question('held')]; s.outbound = [reply('held')]; });
  await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now);
  const snapshot = backlogSnapshot(store.data);
  await store.update(s => { s.inbound.push({ ...question('new'), message: { ...question('new').message, create_time_ms: now } }); });
  const selection = { connection: snapshot.connection, keys: snapshot.items.map(j => j.key) };
  assert.equal(await manageBacklog(store, 'clear', selection), 2);
  const saved = new StateStore(store.directory); await saved.load();
  assert.deepEqual(backlogSnapshot(saved.data).items, []);
  assert.equal(saved.data.inbound[1].phase, 'pending');
  assert.equal(saved.data.inbound[0].message.item_list, undefined);
  assert.equal(saved.data.outbound[0].message.text, '');
  await acceptWeixin(saved, [original], 'wx-position');
  await acceptDot(saved, [{ id: 'held', account_user_id: 'member', created_at: new Date(old).toISOString(), content: { text: 'Must not reappear' } }], new Set(['member']));
  assert.deepEqual(backlogSnapshot(saved.data).items, []);
  assert.equal(saved.data.inbound.length, 2);
  assert.equal(saved.data.outbound.length, 1);
  assert.equal(saved.data.contextToken, 'current-context');
});

test('a stale list cannot restore or clear messages from another account', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.inbound = [{ ...question('same-id'), phase: 'done', expired: true }]; });
  const snapshot = backlogSnapshot(store.data);
  await store.connectDot({ ...store.data.dot!, roomId: 'other-room' });
  await store.update(s => { s.inbound = [{ ...question('same-id'), phase: 'done', expired: true }]; });
  for (const action of ['restore', 'clear'] as const) await assert.rejects(manageBacklog(store, action, { connection: snapshot.connection, keys: ['inbound:same-id'] }), /账号|连接/);
  assert.equal(store.data.inbound[0].expired, true);
});

test('a restored partial reply only sends its remaining part with its existing receipt', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.outbound = [{ ...reply('partial'), part: 1, message: { ...reply('partial').message, text: 'ABCD' } }]; });
  await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now);
  await manageBacklog(store, 'restore', { connection: backlogSnapshot(store.data).connection, keys: ['outbound:partial'] }, now);
  const sent: string[] = [];
  const bridge = new Bridge(store, { send: async (items: any[], context: string) => { assert.equal(context, 'current-context'); sent.push(items[0].text_item.text); } } as any, {} as any, { ...defaults, weixin: { ...defaults.weixin, maxTextLength: 2 } }, () => {});
  await (bridge as any).deliver(new AbortController().signal);
  assert.deepEqual(sent, ['CD']); assert.equal(store.data.outbound[0].part, 2);
  await (bridge as any).deliver(new AbortController().signal);
  assert.deepEqual(sent, ['CD']);
});

test('restoring an uncertain submission reconciles the original request instead of submitting twice', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.inbound = [{ ...question('uncertain'), phase: 'sending', requestId: 'request-1', beforeCursor: 'before' }]; });
  await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now);
  await manageBacklog(store, 'restore', { connection: backlogSnapshot(store.data).connection, keys: ['inbound:uncertain'] }, now);
  const bridge = new Bridge(store, {} as any, { findRequest: async (id: string, before: string) => { assert.equal(id, 'request-1'); assert.equal(before, 'before'); return 'existing-receipt'; }, send: () => assert.fail('Must reconcile first') } as any, defaults, () => {});
  await (bridge as any).submit();
  assert.equal(store.data.inbound[0].dotMessageId, 'existing-receipt');
  assert.equal(store.data.inbound[0].phase, 'done');
});

test('restored unfinished replies wait for refreshed complete content without moving the new-message cursor backwards', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.outbound = [{ ...reply('unfinished'), message: { ...reply('unfinished').message, complete: false, text: 'fragment' } }]; });
  await expireBacklog(store, defaults.storage.maxBacklogAgeMs, now);
  await manageBacklog(store, 'restore', { connection: backlogSnapshot(store.data).connection, keys: ['outbound:unfinished'] }, now);
  const sent: string[] = [];
  const bridge = new Bridge(store, { send: async (items: any[]) => sent.push(items[0].text_item.text) } as any, {} as any, defaults, () => {});
  await (bridge as any).deliver(new AbortController().signal);
  assert.deepEqual(sent, []);
  assert.deepEqual(store.data.dotPending, ['unfinished']);
  await acceptDot(store, [{ id: 'unfinished', account_user_id: 'member', created_at: new Date(old).toISOString(), content: { text: 'complete reply' }, generation: { status: 'completed' } }], new Set(['member']));
  assert.equal(store.data.dotCursor, 'dot-position');
  await (bridge as any).deliver(new AbortController().signal);
  assert.deepEqual(sent, ['complete reply']);
  assert.deepEqual(store.data.dotPending, []);
});

test('held attachment caches survive cleanup and can be restored later', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  const media = new MediaStore(store.directory, defaults.storage);
  const file = await media.save('cached', 'report.txt', Buffer.from('report'));
  await utimes(file.path, new Date(0), new Date(0));
  await store.update(s => { s.inbound = [{ ...question('file'), phase: 'done', expired: true, prepared: { text: 'file', files: [file] } }]; });
  const bridge = new Bridge(store, { updates: async () => ({}) } as any, { profile: store.data.dot, messages: async () => [], members: new Set() } as any, defaults, () => {});
  try { await bridge.start(); assert.equal((await readFile(file.path)).toString(), 'report'); }
  finally { await bridge.pause(); }
  await manageBacklog(store, 'restore', { connection: backlogSnapshot(store.data).connection, keys: ['inbound:file'] }, now);
  assert.equal(store.data.inbound[0].prepared?.files[0].path, file.path);
});

test('clearing an owned draft keeps enough data to clean only that draft', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  await store.update(s => { s.inbound = [{ ...question('draft'), phase: 'done', expired: true, composing: true, prepared: { text: 'owned', files: [] } }]; });
  await manageBacklog(store, 'clear', { connection: backlogSnapshot(store.data).connection, keys: ['inbound:draft'] });
  const bridge = new Bridge(store, {} as any, { clearDraft: async (text: string) => assert.equal(text, 'owned') } as any, defaults, () => {});
  await (bridge as any).submit();
  assert.deepEqual(backlogSnapshot(store.data).items, []);
  assert.equal(store.data.inbound[0].composing, undefined);
});

test('empty unchanged polls do not rewrite the state file', async t => {
  const store = await setup(t), path = join(store.directory, 'state.json');
  await utimes(path, new Date(1000), new Date(1000));
  const before = (await stat(path)).mtimeMs;
  await acceptWeixin(store, [], 'wx-position');
  await acceptDot(store, [], new Set());
  assert.equal((await stat(path)).mtimeMs, before);
});

test('restored legacy attachments are fetched again when the old cache is already gone', async t => {
  const { backlogSnapshot, manageBacklog } = await api(), store = await setup(t);
  const gone = { path: join(store.directory, 'gone.txt'), name: 'gone.txt', mime: 'text/plain' };
  await store.update(s => {
    s.inbound = [{ ...question('input-file'), phase: 'done', expired: true, prepared: { text: 'input-file', files: [gone] }, message: { ...question('input-file').message, item_list: [{ file_item: { file_name: 'gone.txt', media: {} } }] } }];
    s.outbound = [{ ...reply('output-file'), phase: 'done', expired: true, media: { 0: { file: gone } }, message: { ...reply('output-file').message, text: '', attachments: [{ id: 'file', name: 'gone.txt', mime: 'text/plain' }] } }];
  });
  const snapshot = backlogSnapshot(store.data);
  await manageBacklog(store, 'restore', { connection: snapshot.connection, keys: snapshot.items.map(j => j.key) }, now);
  const media = new MediaStore(store.directory, defaults.storage);
  let received = 0, downloaded = 0;
  const bridge = new Bridge(store, { send: async () => {} } as any, {
    send: async (_: string, files: any[]) => { assert.equal((await readFile(files[0].path)).toString(), 'restored input'); return 'confirmed'; },
    download: async () => { downloaded++; return media.save('output-file', 'gone.txt', Buffer.from('restored output')); }
  } as any, defaults, () => {});
  (bridge as any).weixinMedia.download = async () => { received++; return media.save('input-file', 'gone.txt', Buffer.from('restored input')); };
  (bridge as any).weixinMedia.upload = async (file: any) => { assert.equal((await readFile(file.path)).toString(), 'restored output'); return { type: 4 }; };
  await (bridge as any).submit();
  await (bridge as any).deliver(new AbortController().signal);
  assert.equal(received, 1); assert.equal(downloaded, 1);
});
