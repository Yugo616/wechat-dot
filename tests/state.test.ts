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

test('changing WeChat before selecting a dot clears the previous account progress', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-first-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  const first = { token: 'first-login', userId: 'first-owner', botId: 'first-bot', baseUrl: '' };
  await store.connectWeixin(first);
  await store.update(s => { s.weixinPrimed = true; s.weixinCursor = 'first-cursor'; s.contextToken = 'first-context'; });
  await store.connectWeixin({ ...first, token: 'refreshed-login' });
  assert.equal(store.data.weixinCursor, 'first-cursor', 'Logging in to the same account should keep its progress');
  await store.connectWeixin({ ...first, token: 'second-login', userId: 'second-owner', botId: 'second-bot' });
  assert.equal(store.data.weixinPrimed, false);
  assert.equal(store.data.weixinCursor, '');
  assert.equal(store.data.contextToken, undefined);
  const reopened = new StateStore(directory); await reopened.load();
  assert.equal(reopened.data.weixin?.userId, 'second-owner');
  assert.equal(reopened.data.contextToken, undefined);
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

test('learning an optional account ID keeps the same user and room progress through restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-account-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  const dot = { id: 'dot', name: 'Dot', roomId: 'room', userId: 'user', accountId: '', url: '' };
  await store.connectWeixin({ token: 'fake', userId: 'wx-owner', botId: 'bot', baseUrl: '' });
  await store.connectDot(dot);
  await store.update(s => { s.enabled = true; s.dotCursor = 'cursor'; s.inbound = [{ id: 'pending', phase: 'pending', message: {} }]; });
  await store.connectDot({ ...dot, accountId: 'account' });
  assert.equal(store.data.enabled, true);
  assert.equal(store.data.inbound[0]?.id, 'pending');
  const reopened = new StateStore(directory); await reopened.load();
  await reopened.connectDot(dot);
  assert.equal(reopened.data.dot?.accountId, 'account');
  assert.equal(reopened.data.dotCursor, 'cursor');
  assert.equal(reopened.data.inbound[0]?.id, 'pending');
  await reopened.connectDot({ ...dot, accountId: 'different-account' });
  assert.equal(reopened.data.enabled, false);
  assert.equal(reopened.data.inbound.length, 0);
});

test('returning to a saved room without account metadata restores its pending work before startup', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-return-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  const a = { id: 'a', name: 'A', roomId: 'room-a', userId: 'user-a', accountId: 'account-a', url: '' };
  const b = { ...a, id: 'b', roomId: 'room-b', userId: 'user-b', accountId: 'account-b' };
  await store.connectWeixin({ token: 'fake', userId: 'wx-owner', botId: 'bot', baseUrl: '' });
  await store.connectDot(a);
  await store.update(s => { s.dotCursor = 'cursor-a'; s.inbound = [{ id: 'uncertain', phase: 'sending', requestId: 'native-a', message: {} }]; });
  await store.connectDot(b);
  const reopened = new StateStore(directory); await reopened.load();
  await reopened.connectDot({ ...a, accountId: '' });
  assert.equal(reopened.data.dot?.accountId, 'account-a');
  assert.equal(reopened.data.dotCursor, 'cursor-a');
  assert.equal(reopened.data.inbound[0]?.requestId, 'native-a');
  await reopened.connectDot(a);
  assert.equal(reopened.data.inbound[0]?.phase, 'sending');
});
