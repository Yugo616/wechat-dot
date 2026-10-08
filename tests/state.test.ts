import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state';

test('cursor and unprocessed messages survive a restart together', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-dot-state-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); await store.load();
  await store.update(s => { s.weixinCursor = 'cursor-2'; s.inbound.push({ id: 'm1', message: { message_id: 'm1' }, phase: 'pending' }); });
  const reopened = new StateStore(dir); await reopened.load();
  assert.equal(reopened.data.weixinCursor, 'cursor-2');
  assert.equal(reopened.data.inbound[0].id, 'm1');
});

test('concurrent updates keep both changes and never publish partial JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wechat-dot-state-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(dir); await store.load();
  await Promise.all([store.update(s => { s.contextToken = 'context'; }), store.update(s => { s.dotCursor = 'd2'; })]);
  const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.contextToken, 'context'); assert.equal(saved.dotCursor, 'd2');
});

test('switching away and back restores uncertain work only for the original pair', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-pairs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  const wx = { token: 'fake', userId: 'wx-owner', botId: 'bot', baseUrl: '' };
  const a = { id: 'a', name: 'A', roomId: 'room-a', userId: 'user-a', accountId: 'account-a', url: '' };
  const b = { ...a, id: 'b', userId: 'user-b', accountId: 'account-b', roomId: 'room-b' };
  await store.connectWeixin(wx); await store.connectDot(a);
  await store.update(s => { s.dotCursor = 'cursor-a'; s.inbound = [{ id: 'uncertain', phase: 'sending', requestId: 'req-a', message: {} }]; });
  await store.connectDot(b);
  assert.equal(store.data.inbound.length, 0);
  assert.equal(store.data.dotCursor, undefined);
  await store.connectDot(a);
  assert.equal(store.data.inbound[0].requestId, 'req-a');
  assert.equal(store.data.dotCursor, 'cursor-a');
  const reopened = new StateStore(directory); await reopened.load();
  assert.equal(reopened.data.inbound[0].phase, 'sending');
});
