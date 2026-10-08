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
