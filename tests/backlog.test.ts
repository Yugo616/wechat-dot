import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import defaults from '../config/defaults.json';
import { StateStore } from '../src/state';
import { Bridge } from '../src/bridge';
import { acceptDot, acceptWeixin } from '../src/queue';
import { connectionSummary } from '../src/status';

const windowMs = 10 * 60 * 1000;
const config = { ...defaults, storage: { ...defaults.storage, maxBacklogAgeMs: windowMs }, weixin: { ...defaults.weixin, retryDelayMs: 10 }, dot: { ...defaults.dot, pollIntervalMs: 10 } };
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Expected progress was blocked'); await delay(5); }
}
async function setup(t: any) {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-backlog-'));
  const store = new StateStore(path); await store.load();
  t.after(() => rm(path, { recursive: true, force: true }));
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' };
    s.weixinPrimed = true; s.dotCursor = 'original-position'; s.contextToken = 'context';
  });
  return store;
}
const inbound = (id: string, at: number) => ({ id, phase: 'pending' as const, message: { message_id: id, from_user_id: 'owner', message_type: 1, create_time_ms: at, item_list: [{ text_item: { text: id } }] } });
const outbound = (id: string, at: number) => ({ id, phase: 'pending' as const, part: 0, message: { id, text: id, createdAt: new Date(at).toISOString(), complete: true, attachments: [] as any[] } });
const quietDot = { profile: { id: 'dot' }, members: new Set<string>(), messages: async () => [] };
const quietWeixin = { updates: async (_: string, signal: AbortSignal) => { await delay(1000, undefined, { signal }); return {}; } };

test('restart skips expired questions and remaining reply parts, resumes recent work, and retains deduplication', async t => {
  const store = await setup(t), now = Date.now();
  const oldReply = outbound('old-reply', now - windowMs - 1000);
  oldReply.part = 1; oldReply.message.attachments.push({ id: 'file', name: 'old.txt', mime: 'text/plain' });
  await store.update(s => { s.inbound = [inbound('old-question', now - windowMs - 1000), inbound('new-question', now)]; s.outbound = [oldReply, outbound('new-reply', now)]; });
  const sent: string[] = [], status: any = {};
  const dot = { ...quietDot, send: async (text: string) => { sent.push(text); return 'confirmed'; }, download: async () => { assert.fail('Expired attachment must not download'); } };
  const weixin = { ...quietWeixin, send: async (items: any[]) => { sent.push(items[0].text_item.text); } };
  const bridge = new Bridge(store, weixin as any, dot as any, config, patch => Object.assign(status, patch));
  try {
    await bridge.start();
    await until(() => store.data.inbound.every(j => j.phase === 'done') && store.data.outbound.every(j => j.phase === 'done'));
    assert.deepEqual(sent.sort(), ['new-question', 'new-reply']);
    assert.equal(status.skippedMessages, 2);
    assert.equal(store.data.dotCursor, 'original-position');
  } finally { await bridge.pause(); }
  const restarted = new StateStore(store.directory); await restarted.load();
  await acceptWeixin(restarted, [store.data.inbound[0].message], 'next');
  assert.equal(restarted.data.inbound.length, 2);
  assert.equal(restarted.data.inbound[0].phase, 'done');
});

test('an expired unfinished dot reply cannot hold newer replies behind it after reconnect', async t => {
  const store = await setup(t), now = Date.now();
  const raw = (id: string, at: number, status: string) => ({ id, created_at: new Date(at).toISOString(), account_user_id: 'dot', content: { text: id }, generation: { status } });
  await store.update(s => { s.dotPending = ['expired']; });
  await acceptDot(store, [raw('expired', now - windowMs - 1000, 'in_progress'), raw('fresh', now, 'completed')], new Set(['dot']));
  assert.equal(store.data.dotCursor, 'fresh');
  assert.deepEqual(store.data.dotPending, []);
  assert.deepEqual(store.data.outbound.filter(j => j.phase !== 'done').map(j => j.id), ['fresh']);
  await acceptDot(store, [raw('expired', now - windowMs - 1000, 'completed')], new Set(['dot']));
  assert.equal(store.data.outbound.filter(j => j.id === 'expired').length, 1);
  assert.equal(store.data.outbound.find(j => j.id === 'expired')?.phase, 'done');
});

test('an attachment waiting for the network does not block fresh text or the next WeChat question', async t => {
  const store = await setup(t), now = Date.now();
  const attachment = outbound('with-file', now); attachment.message.attachments.push({ id: 'file', name: 'report.txt', mime: 'text/plain' });
  await store.update(s => { s.outbound = [attachment, outbound('fresh-text', now)]; s.inbound = [inbound('fresh-question', now)]; });
  let release!: () => void, started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const dot = { ...quietDot, send: async (text: string) => { sent.push(text); return 'confirmed'; }, download: async (_: unknown, media: any) => { started = true; await held; return media.save('file', 'report.txt', Buffer.from('data')); } };
  const bridge = new Bridge(store, { ...quietWeixin, send: async (items: any[]) => { sent.push(items[0].text_item?.text ?? 'file'); } } as any, dot as any, config, () => {});
  (bridge as any).weixinMedia.upload = async () => ({ type: 4 });
  try {
    await bridge.start();
    await until(() => started);
    await until(() => sent.includes('fresh-question') && sent.includes('fresh-text'));
    assert.equal(store.data.outbound[0].phase, 'pending');
    assert.deepEqual(sent.filter(s => s !== 'fresh-question'), ['with-file', 'fresh-text']);
  } finally { release(); await bridge.pause(); }
});

test('an unsent question that expires while composing is discarded before clicking Send', async t => {
  const store = await setup(t);
  await store.update(s => { s.inbound = [inbound('expires-during-upload', Date.now()), inbound('next', Date.now())]; });
  let clicked = 0, cleared = 0;
  const dot = {
    send: async (_: string, __: unknown, ___: unknown, beforeSubmit: () => Promise<void>, preparation: any) => {
      await preparation.begin();
      if (!cleared) await store.update(s => { s.inbound[0].message.create_time_ms = Date.now() - windowMs - 1000; });
      await beforeSubmit(); clicked++; return 'confirmed';
    },
    clearDraft: async () => { cleared++; }
  };
  const bridge = new Bridge(store, {} as any, dot as any, config, () => {});
  await (bridge as any).submit();
  assert.equal(clicked, 0);
  await (bridge as any).submit();
  assert.equal(cleared, 1);
  assert.equal(clicked, 1);
  assert.equal(store.data.inbound[0].phase, 'done');
  assert.equal(store.data.inbound[0].dotMessageId, undefined);
});

test('retry status counts actual attempts and keeps attachment failures visible during successful polls', async t => {
  const store = await setup(t), job = outbound('file', Date.now());
  job.message.text = ''; job.message.attachments.push({ id: 'file', name: 'report.txt', mime: 'text/plain' });
  await store.update(s => { s.outbound = [job]; });
  let attempts = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const status: any = {}, snapshots: any[] = [];
  const dot = { ...quietDot, download: async (_: unknown, media: any) => { attempts++; if (attempts === 1) throw new Error('Failed to fetch'); await held; return media.save('file', 'report.txt', Buffer.from('data')); } };
  const bridge = new Bridge(store, { ...quietWeixin, send: async () => {} } as any, dot as any, config, patch => { Object.assign(status, patch); snapshots.push(structuredClone(status)); });
  (bridge as any).weixinMedia.upload = async () => ({ type: 4 });
  try {
    await bridge.start();
    await until(() => attempts === 2);
    await delay(30);
    assert.equal(status.retries?.mediaSend?.attempt, 2);
    assert.equal(status.retries?.mediaSend?.nextRetryAt, undefined);
    assert.ok(snapshots.some(s => s.retries?.mediaSend?.attempt === 1 && s.retries.mediaSend.nextRetryAt > 0));
    release();
    await until(() => store.data.outbound[0].phase === 'done' && !status.retries?.mediaSend);
  } finally { release(); await bridge.pause(); }
  assert.deepEqual(status.retries, {});
});

test('retry countdown uses the next attempt time and switches to in-progress without a fake countdown', () => {
  const status: any = { weixin: 'ready', dot: 'ready', running: true, version: 'test', detail: '', retries: { mediaSend: { attempt: 3, nextRetryAt: Date.now() + 4100 } } };
  assert.match(connectionSummary(status).detail, /附件.*第 3 次.*5 秒后/);
  delete status.retries.mediaSend.nextRetryAt;
  assert.match(connectionSummary(status).detail, /附件.*正在第 3 次尝试/);
  assert.doesNotMatch(connectionSummary(status).detail, /秒后/);
});

test('pausing during the final expiry check prevents a subsequent WeChat send', async t => {
  const store = await setup(t);
  await store.update(s => { s.outbound = [outbound('recent', Date.now())]; });
  const controller = new AbortController();
  let sends = 0, checks = 0;
  const bridge = new Bridge(store, { send: async () => { sends++; } } as any, {} as any, config, () => {});
  const expire = (bridge as any).expire.bind(bridge);
  (bridge as any).expire = async () => { await expire(); if (++checks === 3) controller.abort(); };
  await (bridge as any).deliver(controller.signal);
  assert.equal(sends, 0);
  assert.equal(store.data.outbound[0].part, 0);
});

test('a pause after saving the pre-click state keeps a known unsent question retryable', async t => {
  const store = await setup(t), controller = new AbortController();
  await store.update(s => { s.inbound = [inbound('recent', Date.now())]; });
  let clicks = 0;
  const update = store.update.bind(store);
  store.update = async change => { await update(change); if (store.data.inbound[0].phase === 'sending') controller.abort(); };
  const dot = { send: async (_: unknown, __: unknown, ___: unknown, beforeSubmit: () => Promise<void>, preparation: any) => { await preparation.begin(); await beforeSubmit(); clicks++; return 'confirmed'; } };
  const bridge = new Bridge(store, {} as any, dot as any, config, () => {});
  await assert.rejects((bridge as any).submit(controller.signal), { name: 'AbortError' });
  assert.equal(clicks, 0);
  assert.equal(store.data.inbound[0].phase, 'pending');
  assert.equal(store.data.inbound[0].composing, true);
});
