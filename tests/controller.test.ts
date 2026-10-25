import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state';

async function controller(t: any, directory?: string) {
  const module = await import('../src/controller.js').catch((error: any) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  });
  assert.ok(module?.createController, 'Desktop behavior must run without Electron');
  const data = directory ?? await mkdtemp(join(tmpdir(), 'wechat-dot-controller-'));
  const events: { name: string; value?: unknown }[] = [];
  const engine = Object.assign(new EventEmitter(), { checkForUpdates: async () => {}, downloadUpdate: async () => [], quitAndInstall: () => {}, setFeedURL: () => {} });
  const core = await module.createController({
    appDirectory: process.cwd(), userDirectory: data, resourcesDirectory: join(process.cwd(), 'dist'),
    executablePath: process.execPath, version: '1.2.0', isPackaged: false,
    createUpdater: () => engine as any,
    publish: (value: any) => events.push({ name: 'status', value }),
    show: () => { events.push({ name: 'show' }); }, hide: () => { events.push({ name: 'hide' }); }, quit: () => { events.push({ name: 'quit' }); },
    openPath: async () => {}, openExternal: async () => {}
  });
  t.after(async () => { await core.close(); if (!directory) await rm(data, { recursive: true, force: true }); });
  return { core, data, events };
}

test('new desktop starts paused and exit choice persists without forwarding', async t => {
  const { core, data, events } = await controller(t);
  await core.start();
  assert.equal(core.status().version, '1.2.0');
  assert.equal(core.status().running, false);
  assert.equal(core.status().weixin, 'idle');
  assert.ok(events.some(e => e.name === 'show'));
  await core.action('request-exit'); assert.equal(core.status().exitPrompt, true);
  await core.action('exit-minimize', 'remember');
  assert.equal(events.at(-1)?.name, 'hide');
  await core.close();
  const next = await controller(t, data); await next.core.start();
  assert.equal(next.core.status().exitAction, 'minimize');
  await next.core.action('request-exit');
  assert.equal(next.events.at(-1)?.name, 'hide');
  assert.equal(next.core.status().running, false);
  await next.core.close();
});

test('shared desktop restores and clears the visible held list without starting a paused account', async t => {
  const data = await mkdtemp(join(tmpdir(), 'wechat-dot-controller-backlog-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const saved = new StateStore(data); await saved.load();
  await saved.update(s => {
    s.weixin = { userId: 'owner', botId: 'bot', token: 'fixture', baseUrl: '' };
    s.dot = { id: 'dot', name: 'Dot', userId: 'user', accountId: 'account', roomId: 'room', url: '' };
    s.dotCursor = 'last-seen'; s.enabled = false;
    s.inbound = ['restore', 'clear'].map(id => ({ id, phase: 'done', expired: true, message: { message_id: id, message_type: 1, from_user_id: 'owner', item_list: [{ text_item: { text: id } }] } }));
  });
  const { core } = await controller(t, data); await core.start();
  const snapshot = core.backlog(); assert.equal(snapshot.items.length, 2);
  await core.manageBacklog('restore', { connection: snapshot.connection, keys: ['inbound:restore'] });
  assert.equal(core.status().skippedMessages, 1);
  await core.manageBacklog('clear', { connection: snapshot.connection, keys: ['inbound:clear'] });
  assert.equal(core.status().skippedMessages, 0); assert.equal(core.status().running, false);
  await core.close(); await saved.load();
  assert.equal(saved.data.enabled, false); assert.equal(saved.data.dotCursor, 'last-seen');
  assert.equal(saved.data.inbound[0].phase, 'pending'); assert.equal(saved.data.inbound[1].dismissed, true);
});
