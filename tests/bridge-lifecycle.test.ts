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
