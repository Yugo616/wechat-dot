import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ExtensionLink } from '../src/dot/extension-link';
import { MessageContentError } from '../src/errors';
import { loadConfig } from '../src/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

test('local extension connection returns page results and stops pending work on disconnect', async t => {
  const link = new ExtensionLink({ port: 0, origin: 'chrome-extension://fixture', heartbeatMs: 20000, maxPayloadBytes: 1048576 }, 500);
  await link.start(); t.after(() => link.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { origin: 'chrome-extension://fixture' });
  await once(socket, 'open'); t.after(() => socket.close());
  socket.on('message', raw => {
    const request = JSON.parse(String(raw));
    if (request.action === 'url') socket.send(JSON.stringify({ id: request.id, result: 'https://example.test/dot' }));
    if (request.action === 'oversize') socket.send(JSON.stringify({ id: request.id, error: '附件超过大小限制', errorName: 'MessageContentError' }));
    if (request.action === 'timeout') socket.send(JSON.stringify({ id: request.id, error: 'timed out', errorName: 'TimeoutError' }));
  });
  assert.equal(await link.request('url'), 'https://example.test/dot');
  await assert.rejects(link.request('oversize'), MessageContentError);
  await assert.rejects(link.request('timeout'), { name: 'TimeoutError' });
  const pending = link.request('request');
  const rejected = assert.rejects(pending, /浏览器已断开/);
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

test('an old connection in another browser cannot take over the managed browser', async t => {
  const token = randomBytes(32).toString('hex');
  const link = new ExtensionLink({ port: 0, token, origin: 'chrome-extension://fixture', heartbeatMs: 20000, maxPayloadBytes: 1048576 }, 500);
  await link.start(); t.after(() => link.stop());
  for (const path of ['', '/connect/old-session']) {
    const socket = new WebSocket(`ws://127.0.0.1:${link.port}${path}`, { origin: 'chrome-extension://fixture' });
    await assert.rejects(once(socket, 'open'), /401/);
    assert.equal(link.connected, false);
  }
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}/connect/${token}`, { origin: 'chrome-extension://fixture' });
  t.after(() => socket.close());
  await once(socket, 'open');
  assert.equal(link.connected, true);
});

test('startup waits for the bundled connection and cancellation stops that wait', async t => {
  const link = new ExtensionLink({ port: 0, origin: 'chrome-extension://fixture', heartbeatMs: 20000, maxPayloadBytes: 1048576 }, 500);
  await link.start(); t.after(() => link.stop());
  const controller = new AbortController();
  const waiting = link.waitForConnection(controller.signal);
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort(); await rejected;
  const connected = link.waitForConnection(new AbortController().signal);
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { origin: 'chrome-extension://fixture' });
  t.after(() => socket.close());
  await once(socket, 'open');
  await connected;
  assert.equal(link.connected, true);
  await link.waitForConnection(new AbortController().signal);
});

test('the default connection can return an attachment at the configured media limit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-link-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig(process.cwd(), directory);
  const link = new ExtensionLink({ ...config.dot.extension, port: 0, origin: 'chrome-extension://fixture' }, 10000);
  await link.start(); t.after(() => link.stop());
  const socket = new WebSocket(`ws://127.0.0.1:${link.port}`, { origin: 'chrome-extension://fixture' });
  socket.on('error', () => {});
  await once(socket, 'open'); t.after(() => socket.close());
  socket.on('message', raw => {
    const request = JSON.parse(String(raw));
    socket.send(JSON.stringify({ id: request.id, result: { base64: Buffer.alloc(config.storage.maxMediaBytes).toString('base64') } }));
  });
  const result = await link.request('download');
  assert.equal(Buffer.from(result.base64, 'base64').length, 26214400);
});
