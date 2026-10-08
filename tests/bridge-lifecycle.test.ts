import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import defaults from '../config/defaults.json';
import { StateStore } from '../src/state';
import { Bridge } from '../src/bridge';
import { DotAccessError } from '../src/dot/errors';

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
