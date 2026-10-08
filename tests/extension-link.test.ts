import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ExtensionLink } from '../src/dot/extension-link';

test('local extension connection returns page results and stops pending work on disconnect', async t => {
  const link = new ExtensionLink({ port: 0, origin: 'chrome-extension://fixture', heartbeatMs: 20000, maxPayloadBytes: 1048576 }, 500);
  await link.start(); t.after(() => link.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { origin: 'chrome-extension://fixture' });
  await once(socket, 'open'); t.after(() => socket.close());
  socket.on('message', raw => {
    const request = JSON.parse(String(raw));
    if (request.action === 'url') socket.send(JSON.stringify({ id: request.id, result: 'https://example.test/dot' }));
  });
  assert.equal(await link.request('url'), 'https://example.test/dot');
  const pending = link.request('request');
  const rejected = assert.rejects(pending, /扩展已断开/);
  socket.close();
  await rejected;
});

test('a webpage cannot connect to the local extension port', async t => {
  const link = new ExtensionLink({ port: 0, origin: 'chrome-extension://fixture', heartbeatMs: 20000, maxPayloadBytes: 1048576 }, 500);
  await link.start(); t.after(() => link.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { origin: 'https://example.test' });
  await assert.rejects(once(socket, 'open'), /401/);
  assert.equal(link.connected, false);
});
