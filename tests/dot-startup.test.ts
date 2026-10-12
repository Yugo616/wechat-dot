import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotClient } from '../src/dot/client';
import { StateStore } from '../src/state';
import { acceptDot } from '../src/queue';
import defaults from '../config/defaults.json';

function setup() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let opened = false, opens = 0, reads = 0, closes = 0;
  const start = async () => { opens++; await ready; opened = true; browser.emit('loaded'); };
  const browser = Object.assign(new EventEmitter(), {
    manualLogin: false,
    open: start, login: start,
    url: async () => { reads++; return opened ? 'https://fixture.test/' : 'about:blank'; },
    show: async () => { assert.equal(opened, true); },
    dispose: async () => { closes++; opened = false; },
    run: async (_action: string, args: { url: string }) => {
      const path = new URL(args.url, 'https://fixture.test').pathname;
      const value = path === defaults.dot.sessionPath ? { accessToken: 'fixture', user: { id: 'owner' } }
        : path.endsWith(defaults.dot.primaryPath) ? { selection: { available: true, thread_id: 'thread' }, profile: { id: 'dot', messaging_room_id: 'room' } }
        : { members: [] };
      return { status: 200, text: JSON.stringify(value) };
    }
  });
  const client = new DotClient({ ...defaults.dot, homeUrl: 'https://fixture.test/' });
  (client as any).createBrowser = () => browser;
  return { client, browser, release, counts: () => ({ opens, reads, closes, opened }) };
}

test('discovery waits for an in-progress browser open, including a loaded event', async () => {
  const fixture = setup();
  const opening = fixture.client.open(false);
  const discovering = fixture.client.discover().catch(e => e);
  let loadedDiscovery: Promise<unknown> | undefined;
  fixture.client.on('loaded', () => { loadedDiscovery = fixture.client.discover(); });
  await setImmediate();
  const earlyReads = fixture.counts().reads;
  fixture.release();
  await opening;
  const profile = await discovering;
  await loadedDiscovery;
  assert.equal(earlyReads, 0, 'Do not inspect the previous blank document during startup');
  assert.equal(profile.roomId, 'room');
  assert.equal(fixture.counts().opens, 1);
});

test('first login also waits for its browser before inspecting the page', async () => {
  const fixture = setup();
  const login = fixture.client.login();
  await setImmediate();
  const discovering = fixture.client.discover().catch(e => e);
  await setImmediate();
  const earlyReads = fixture.counts().reads;
  fixture.release();
  assert.equal(await login, false);
  assert.equal((await discovering).roomId, 'room');
  assert.equal(earlyReads, 0);
  assert.equal(fixture.counts().opens, 1);
});

test('closing can interrupt a stalled startup and cleans up any late browser', async () => {
  const fixture = setup();
  const opening = fixture.client.open(false).catch(e => e);
  await setImmediate();
  let closed = false;
  const closing = fixture.client.dispose().then(() => { closed = true; });
  await setImmediate();
  const closedPromptly = closed;
  fixture.release();
  await Promise.all([opening, closing]);
  assert.equal(closedPromptly, true, 'Closing must not wait for a stalled page load');
  assert.equal(fixture.counts().opened, false, 'A late browser open must not survive disposal');
  assert.equal(fixture.client.window, undefined);
});

test('a failed browser open can be retried', async () => {
  const fixture = setup();
  const open = fixture.browser.open;
  fixture.browser.open = async () => { throw Error('startup failed'); };
  await assert.rejects(fixture.client.open(false), /startup failed/);
  fixture.browser.open = open;
  fixture.release();
  await fixture.client.open(false);
  assert.equal((await fixture.client.discover()).roomId, 'room');
});

test('a disconnected browser clears the live session and notifies its owner', async () => {
  const fixture = setup();
  fixture.release();
  await fixture.client.discover();
  let disconnected = 0;
  fixture.client.on('closed', () => { disconnected++; });
  fixture.browser.emit('closed');
  assert.equal(fixture.client.profile, undefined, 'A closed browser is not a live dot session');
  assert.equal(fixture.client.window, undefined);
  assert.equal(disconnected, 1);
  assert.equal((await fixture.client.discover()).roomId, 'room');
  assert.equal(fixture.counts().opens, 2, 'The saved login can be reopened');
});

test('intentional disposal does not request automatic recovery', async () => {
  const fixture = setup();
  fixture.release();
  await fixture.client.discover();
  let disconnected = 0;
  fixture.client.on('closed', () => { disconnected++; });
  await fixture.client.dispose();
  fixture.browser.emit('closed');
  assert.equal(disconnected, 0);
  assert.equal(fixture.client.profile, undefined);
});

test('disconnecting preserves a reply already waiting to be saved', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wechat-dot-disconnect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore(directory); await store.load();
  const fixture = setup(); fixture.release(); await fixture.client.discover();
  fixture.client.members.add('dot-member');
  const saving = acceptDot(store, [{ id: 'fresh-reply', account_user_id: 'dot-member', content: { text: '保留这条回复' } }], fixture.client.members);
  fixture.browser.emit('closed');
  await saving;
  assert.equal(store.data.outbound[0]?.message.text, '保留这条回复');
  assert.equal(store.data.dotCursor, 'fresh-reply');
});
