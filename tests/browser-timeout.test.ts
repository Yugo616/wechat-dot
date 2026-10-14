import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import defaults from '../config/defaults.json';
import { DotBrowser } from '../src/dot/browser';

test('disposing during browser preparation cannot open a late login window', async () => {
  const browser = new DotBrowser(defaults.dot);
  let resolve!: (path: string) => void;
  (browser as any).executable = () => new Promise<string>(r => { resolve = r; });
  const opening = browser.login();
  await browser.dispose(); resolve(process.execPath);
  await assert.rejects(opening, e => (e as Error).name === 'AbortError');
  assert.equal((browser as any).child, undefined);
});

test('closing an embedded page settles a pending command so reconnect can drain the old loop', async () => {
  const browser = new DotBrowser(defaults.dot);
  const window = Object.assign(new EventEmitter(), { webContents: { executeJavaScript: () => new Promise(() => {}), debugger: { sendCommand: () => new Promise(() => {}) } } });
  (browser as any).embedded = window;
  const pending = browser.evaluate('fetch("/pending-request")');
  window.emit('closed');
  let timer: ReturnType<typeof setTimeout>;
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('command still pending')), 50); })]), /浏览器已断开/);
    assert.equal(window.listenerCount('closed'), 0);
  } finally { clearTimeout(timer!); }
});

test('a slow page request keeps its own timeout while ordinary browser commands remain bounded', async () => {
  const browser = new DotBrowser({ ...defaults.dot, requestTimeoutMs: 20 });
  const internal = browser as any;
  internal.socket = { readyState: WebSocket.OPEN, send(raw: string) {
    const { id } = JSON.parse(raw);
    setTimeout(() => {
      const pending = internal.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer); internal.pending.delete(id);
      pending.resolve({ result: { value: { ok: true, value: { status: 200 } } } });
    }, 60);
  } };
  assert.deepEqual(await browser.run('request', { timeoutMs: 100 }), { status: 200 });
  await assert.rejects(browser.command('Page.getFrameTree'), /超时/);
});

test('browser startup waits for its requested page instead of attaching an initial blank tab', async () => {
  const browser = new DotBrowser({ ...defaults.dot, homeUrl: 'https://fixture.test/', requestTimeoutMs: 1000, composerPollIntervalMs: 1 });
  let polls = 0;
  browser.command = async () => ({ targetInfos: ++polls === 1
    ? [{ type: 'page', targetId: 'startup', url: 'about:blank' }]
    : [{ type: 'page', targetId: 'startup', url: 'about:blank' }, { type: 'page', targetId: 'conversation', url: 'https://fixture.test/' }] });
  assert.equal(await (browser as any).pageTarget(), 'conversation');
  assert.equal(polls, 2);
});

test('browser startup reports a timeout if only another page is present', async () => {
  const browser = new DotBrowser({ ...defaults.dot, homeUrl: 'https://fixture.test/', requestTimeoutMs: 10, composerPollIntervalMs: 1 });
  browser.command = async () => ({ targetInfos: [{ type: 'page', targetId: 'other', url: 'https://another.test/' }] });
  await assert.rejects((browser as any).pageTarget(), /页面启动超时/);
});

test('reusing a browser restores its closed conversation page', async () => {
  const browser = new DotBrowser({ ...defaults.dot, homeUrl: 'https://fixture.test/', requestTimeoutMs: 10, composerPollIntervalMs: 1 });
  browser.command = async (method, params) => {
    if (method === 'Target.createTarget') {
      assert.deepEqual(params, { url: 'https://fixture.test/' });
      return { targetId: 'restored' };
    }
    return { targetInfos: [{ type: 'page', targetId: 'other', url: 'about:blank' }] };
  };
  assert.equal(await (browser as any).pageTarget(true), 'restored');
});
