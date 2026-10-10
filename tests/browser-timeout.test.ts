import test from 'node:test';
import assert from 'node:assert/strict';
import defaults from '../config/defaults.json';
import { DotBrowser } from '../src/dot/browser';

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
