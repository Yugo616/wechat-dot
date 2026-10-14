import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import defaults from '../config/defaults.json';

test('bundled connection observes the configured upload and message endpoints', async () => {
  const built = await build({ entryPoints: ['src/extension/monitor.ts'], bundle: true, write: false, platform: 'browser', format: 'iife' });
  const events: any[] = [];
  const window = { fetch: async () => new Response('{"id":"confirmed"}'), postMessage: (event: any) => events.push(event) };
  runInNewContext(built.outputFiles[0].text, {
    window, location: new URL('https://example.test/dots/home'), URL, Request, Headers, crypto,
    wechatDotConfig: { ...defaults.dot, filesPath: '/messaging/rooms/{roomId}/attachments/{fileId}', messagesPath: '/messaging/rooms/{roomId}/posts' }
  });
  for (const path of ['/messaging/rooms/room/attachments', '/messaging/rooms/room/posts']) {
    events.length = 0;
    await (window.fetch as typeof fetch)(`https://example.test/backend-api${path}`, { method: 'POST', body: '{}' });
    await setImmediate();
    assert.deepEqual(events.map(event => event.method), ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.responseData']);
    assert.equal(events.at(-1).params.body, '{"id":"confirmed"}');
  }
  events.length = 0;
  await (window.fetch as typeof fetch)('https://example.test/backend-api/unrelated', { method: 'POST' });
  assert.equal(events.length, 0);
});
