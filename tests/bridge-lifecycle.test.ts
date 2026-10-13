import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import defaults from '../config/defaults.json';
import { StateStore } from '../src/state';
import { Bridge } from '../src/bridge';
import { DotAccessError } from '../src/dot/errors';
import { MediaStore } from '../src/media';
import { WeixinExpiredError } from '../src/weixin/client';

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) assert.fail('Expected state was not reached'); await delay(5); }
}

test('temporary network failures recover both directions without re-login or duplicate sends', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-network-'));
  const store = new StateStore(path); await store.load();
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; s.weixinPrimed = true; s.dotCursor = 'cursor'; s.contextToken = 'context';
    s.inbound = [{ id: 'question', phase: 'pending', message: { item_list: [{ text_item: { text: 'hello' } }] } }];
    s.outbound = [{ id: 'reply', phase: 'pending', part: 0, message: { id: 'reply', text: 'answer', attachments: [], complete: true, createdAt: '' } }];
  });
  let weixinOffline = true, dotOffline = true, received = 0, polled = 0, sentToDot = 0, sentToWeixin = 0;
  const status: any = {}, changes: any[] = [];
  const weixin = { updates: async () => { received++; if (weixinOffline) throw new TypeError('fetch failed'); return {}; }, send: async () => { sentToWeixin++; } };
  const dot = { profile: { id: 'dot' }, members: new Set(), messages: async () => { polled++; if (dotOffline) throw new Error('Failed to fetch'); return []; }, send: async () => { sentToDot++; return 'confirmed'; } };
  const config = { ...defaults, weixin: { ...defaults.weixin, retryDelayMs: 10 }, dot: { ...defaults.dot, pollIntervalMs: 10 } };
  const bridge = new Bridge(store, weixin as any, dot as any, config, patch => { Object.assign(status, patch); changes.push({ ...status }); });
  t.after(async () => { await bridge.pause(); await rm(path, { recursive: true, force: true }); });
  await bridge.start();
  await until(() => received >= 2 && polled >= 2);
  assert.match(status.weixinRetry ?? '', /自动重试/);
  assert.match(status.dotRetry ?? '', /无需.*登录/);
  assert.equal(status.problem, undefined);
  assert.equal(status.weixin, 'ready', 'A network failure must not invalidate the saved login');
  assert.equal(status.running, true);
  weixinOffline = false;
  await until(() => status.weixinRetry === undefined);
  assert.ok(status.dotRetry, 'A successful WeChat poll cannot clear the dot connection failure');
  dotOffline = false;
  await until(() => store.data.inbound[0].phase === 'done' && store.data.outbound[0].phase === 'done' && status.dotRetry === undefined);
  assert.equal(sentToDot, 1); assert.equal(sentToWeixin, 1);
  assert.equal(store.data.enabled, true);
  assert.equal(status.problem, undefined);
  assert.ok(changes.every(s => !s.needsReview));
  dotOffline = true;
  await until(() => Boolean(status.dotRetry));
  await bridge.pause();
  assert.equal(status.dotRetry, undefined, 'Pausing must stop claiming that automatic reconnection is running');
  assert.equal(status.weixinRetry, undefined);
});

test('an unconfirmed send has a clear next action after the network recovers', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-uncertain-network-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => { s.inbound = [{ id: 'uncertain', phase: 'sending', requestId: 'request', lastError: 'Failed to fetch', message: {} }]; });
  const bridge = new Bridge(store, {} as any, { findRequest: async () => undefined } as any, defaults, () => {});
  await assert.rejects((bridge as any).submit(), /核对.*已收到.*重试/);
  assert.equal(store.data.inbound[0].phase, 'sending');
});

for (const item of [{ type: 99 }, { type: 4, file_item: { file_name: 'missing.txt' } }]) test(`unusable inbound content (${item.type}) does not block a later valid message`, async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-invalid-content-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => { s.inbound = [
    { id: 'invalid', phase: 'pending', message: { item_list: [item] } },
    { id: 'valid', phase: 'pending', message: { item_list: [{ text_item: { text: 'hello' } }] } }
  ]; });
  const sent: string[] = [], status: any = {};
  const dot = { send: async (text: string) => { sent.push(text); return 'confirmed'; } };
  const bridge = new Bridge(store, { config: defaults.weixin } as any, dot as any, defaults, patch => Object.assign(status, patch));
  await (bridge as any).submit();
  assert.equal(store.data.inbound[0].phase, 'done');
  assert.ok(store.data.inbound[0].lastError, 'Keep the reason without pretending that dot received the content');
  assert.equal(store.data.inbound[0].dotMessageId, undefined);
  assert.match(status.detail, /已跳过/);
  await (bridge as any).submit();
  assert.deepEqual(sent, ['hello']);
  assert.equal(store.data.inbound[1].phase, 'done');
});

test('an oversized outbound file becomes a saved explanation and later replies still arrive', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-large-file-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => {
    s.weixin = { botId: 'bot', userId: 'owner', token: '', baseUrl: '' }; s.contextToken = 'context';
    s.outbound = [
      { id: 'large', phase: 'pending', part: 0, message: { id: 'large', text: '', complete: true, createdAt: '', attachments: [{ id: 'file', name: 'large.zip', mime: 'application/zip' }] } },
      { id: 'next', phase: 'pending', part: 0, message: { id: 'next', text: 'next reply', complete: true, createdAt: '', attachments: [] } }
    ];
  });
  let downloads = 0, failSend = true;
  const sent: string[] = [];
  const dot = { download: async (_: any, media: MediaStore) => { downloads++; media.checkSize(defaults.storage.maxMediaBytes + 1); } };
  const weixin = { send: async (items: any[]) => { if (failSend) throw new Error('fetch failed'); sent.push(items[0].text_item.text); } };
  const bridge = new Bridge(store, weixin as any, dot as any, defaults, () => {});
  await assert.rejects((bridge as any).deliver(new AbortController().signal), /fetch failed/);
  assert.equal(store.data.outbound[0].phase, 'pending');
  failSend = false;
  await (bridge as any).deliver(new AbortController().signal);
  assert.equal(downloads, 1, 'A retry should use the saved explanation without downloading the invalid file again');
  assert.match(sent[0], /附件.*无法转发[\s\S]*大小限制/);
  assert.equal(sent[1], 'next reply');
  assert.ok(store.data.outbound.every(j => j.phase === 'done'));
});

for (const source of ['receive', 'send']) test(`expired WeChat login stops ${source} retries and preserves the pending reply`, async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-weixin-expired-'));
  const store = new StateStore(path); await store.load();
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; s.weixinPrimed = true; s.dotCursor = 'cursor'; s.contextToken = 'context';
    s.outbound = [{ id: 'reply', phase: 'pending', part: 0, message: { id: 'reply', text: 'answer', attachments: [], complete: true, createdAt: '' } }];
  });
  let attempts = 0; const status: any = {};
  const weixin = {
    updates: async (_: string, signal: AbortSignal) => { if (source === 'receive') { attempts++; throw new WeixinExpiredError(); } await delay(1000, undefined, { signal }); return {}; },
    send: async () => { attempts++; throw new WeixinExpiredError(); }
  };
  const dot = { profile: { id: 'dot' }, members: new Set(), messages: async () => [] };
  const bridge = new Bridge(store, weixin as any, dot as any, { ...defaults, dot: { ...defaults.dot, pollIntervalMs: 10 } }, patch => Object.assign(status, patch));
  t.after(async () => { await bridge.pause(); await rm(path, { recursive: true, force: true }); });
  await bridge.start();
  await until(() => status.weixin === 'error');
  assert.equal(status.running, false);
  assert.equal(store.data.enabled, false);
  assert.match(status.weixinDetail, /重新扫码/);
  assert.equal(store.data.outbound[0].phase, 'pending');
  await delay(40); assert.equal(attempts, 1);
});

test('two Start clicks create one polling loop; pause while starting leaves it stopped', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-lifecycle-')); t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => { s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; s.weixinPrimed = true; });
  let count = 0;
  const weixin = { updates: async (_cursor: string, signal: AbortSignal) => { count++; await delay(1000, undefined, { signal }); return {}; } };
  const dot = { profile: { id: 'dot' }, baseline: async () => { await delay(30); return { cursor: 'latest', pending: [] }; }, messages: async () => [], members: new Set() };
  const bridge = new Bridge(store, weixin as any, dot as any, defaults, () => {});
  const first = bridge.start(); const second = bridge.start();
  await Promise.all([first, second]); await delay(10); await bridge.pause();
  assert.equal(count, 1);
  const restarting = bridge.start(); const pausing = bridge.pause();
  await Promise.all([restarting, pausing]);
  assert.equal(store.data.enabled, false);
});

test('access denied during startup disables automatic resume and preserves queued messages', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-denied-')); t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' };
    s.weixinPrimed = true; s.enabled = true;
    s.inbound = [{ id: 'queued', phase: 'pending', message: {} }];
  });
  const updates: any[] = [];
  const dot = { profile: { id: 'dot' }, baseline: async () => { throw new DotAccessError(403); } };
  const bridge = new Bridge(store, {} as any, dot as any, defaults, patch => updates.push(patch));
  await assert.rejects(bridge.start(), DotAccessError);
  const reopened = new StateStore(path); await reopened.load();
  assert.equal(reopened.data.enabled, false);
  assert.deepEqual(reopened.data.inbound, [{ id: 'queued', phase: 'pending', message: {} }]);
  assert.equal(updates.at(-1).dot, 'error');
  assert.equal(updates.at(-1).running, false);
  await bridge.pause();
});

test('resolving a checked message leaves restart to the common login-check flow', async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-resolve-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  await store.update(s => { s.inbound = [{ id: 'uncertain', phase: 'sending', message: {}, lastError: 'connection lost' }]; });
  const bridge = new Bridge(store, {} as any, {} as any, defaults, () => {});
  await bridge.resolveUncertain(false);
  assert.equal(store.data.inbound[0].phase, 'done');
  assert.equal(store.data.enabled, false);
});

for (const failAt of ['upload', 'send']) test(`restart retains downloaded attachments after ${failAt} failure and source expiry`, async t => {
  const path = await mkdtemp(join(tmpdir(), 'wechat-dot-outbound-')); t.after(() => rm(path, { recursive: true, force: true }));
  const store = new StateStore(path); await store.load();
  const file = await new MediaStore(path, defaults.storage).save('reply', '报告.txt', Buffer.from('retained bytes'));
  const old = new Date(0); await utimes(file.path, old, old);
  await store.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', baseUrl: '', token: '' }; s.weixinPrimed = true; s.dotCursor = 'cursor'; s.contextToken = 'context';
    s.outbound = [{ id: 'reply', part: 0, phase: 'pending', message: { id: 'reply', text: '', complete: true, createdAt: '', attachments: [{ id: 'file', name: '报告.txt', mime: 'text/plain', url: 'https://example.invalid/expired' }] } }];
  });
  let downloads = 0, uploads = 0, sends = 0;
  const item = { type: 4, file_item: { file_name: file.name } };
  const dot = { profile: { id: 'dot' }, members: new Set(), messages: async () => [], download: async () => { if (downloads++) throw Error('source expired'); return file; } };
  const weixin = { updates: async (_cursor: string, signal: AbortSignal) => { await delay(1000, undefined, { signal }); return {}; }, send: async () => { sends++; throw Error('send interrupted'); } };
  const first = new Bridge(store, weixin as any, dot as any, defaults, () => {});
  (first as any).weixinMedia.upload = async () => { uploads++; if (failAt === 'upload') throw Error('upload interrupted'); return item; };
  await assert.rejects((first as any).deliver(new AbortController().signal), /interrupted/);
  const reopened = new StateStore(path); await reopened.load();
  const second = new Bridge(reopened, { ...weixin, send: async (items: unknown[]) => { sends++; assert.deepEqual(items, [item]); } } as any, dot as any, { ...defaults, dot: { ...defaults.dot, pollIntervalMs: 10 } }, () => {});
  (second as any).weixinMedia.upload = async () => { uploads++; assert.equal(failAt, 'upload'); assert.equal((await readFile(file.path)).toString(), 'retained bytes'); return item; };
  await second.start();
  try {
    for (let n = 0; n < 100 && reopened.data.outbound[0].phase !== 'done'; n++) await delay(10);
    assert.equal(reopened.data.outbound[0].phase, 'done');
    assert.equal(downloads, 1);
    assert.equal(uploads, failAt === 'upload' ? 2 : 1);
    assert.equal(sends, failAt === 'send' ? 2 : 1);
    assert.equal((await readFile(file.path)).toString(), 'retained bytes');
  } finally { await second.pause(); }
});
