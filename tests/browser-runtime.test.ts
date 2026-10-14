import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import defaults from '../config/defaults.json';
import { ensureBrowser, configureWindowsBrowser } from '../src/dot/runtime';
import { connectionRetry } from '../src/status';

async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'dot-runtime-'));
  const archive = await readFile(join(__dirname, 'fixtures/browser.zip'));
  let requests = 0, interrupted = false;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/fixture/mac-arm64/chrome.zip');
    res.writeHead(200, { 'Content-Length': archive.length });
    if (interrupted) { res.flushHeaders(); res.write(archive.subarray(0, 10)); }
    else res.end(archive);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  const config = { ...defaults.dot.runtime, version: 'fixture', baseUrl: `http://127.0.0.1:${address.port}`,
    platforms: { ...defaults.dot.runtime.platforms, 'darwin-arm64': { platform: 'mac-arm64', archive: 'chrome.zip', executable: 'fixture-bin' } } };
  const controller = new AbortController();
  const options = { signal: controller.signal, platform: 'darwin', arch: 'arm64' };
  return { root, config, controller, options, requests: () => requests, interrupt: (value: boolean) => { interrupted = value; } };
}

test('independent runtime installs once, reuses offline, and leaves unrelated files intact', async t => {
  const f = await setup(t);
  await writeFile(join(f.root, 'personal-profile'), 'unchanged');
  const progress: string[] = [];
  const [first, second] = await Promise.all([
    ensureBrowser(f.config, f.root, { ...f.options, progress: s => progress.push(s) }),
    ensureBrowser(f.config, f.root, { ...f.options, progress: s => progress.push(s) })
  ]);
  assert.equal(first, second); assert.equal(f.requests(), 1);
  assert.equal(await readFile(first, 'utf8'), 'fixture browser');
  assert.equal(await readFile(join(f.root, 'personal-profile'), 'utf8'), 'unchanged');
  assert.ok(progress.some(s => s.includes('100%')));
  const cached = await ensureBrowser({ ...f.config, baseUrl: 'http://invalid.test' }, f.root, f.options);
  assert.equal(cached, first); assert.equal(f.requests(), 1);
});

test('cancelled download leaves no runnable partial installation and can retry', async t => {
  const f = await setup(t); f.interrupt(true);
  await assert.rejects(ensureBrowser(f.config, f.root, { ...f.options, progress: message => {
    if (message.includes('下载专用浏览器')) f.controller.abort();
  } }), e => (e as Error).name === 'AbortError');
  assert.deepEqual(await readdir(f.root), []);
  f.interrupt(false);
  const file = await ensureBrowser(f.config, f.root, { ...f.options, signal: new AbortController().signal });
  assert.equal(await readFile(file, 'utf8'), 'fixture browser'); assert.equal(f.requests(), 2);
});

test('unsupported architecture does not fall back to the personal browser', async t => {
  const f = await setup(t);
  await assert.rejects(ensureBrowser(f.config, f.root, { ...f.options, arch: 'unsupported' }), /检查更新/);
  assert.equal(f.requests(), 0);
});

test('Chrome Windows setup uses exit 78 for successful sandbox configuration', async () => {
  await configureWindowsBrowser('fixture', 1000, async () => { throw Object.assign(new Error('setup'), { code: 78 }); });
  await assert.rejects(configureWindowsBrowser('fixture', 1000, async () => { throw Object.assign(new Error('failed'), { code: 79 }); }), /failed/);
  await assert.rejects(configureWindowsBrowser('fixture', 1000, async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }), /missing/);
});

test('timeout after response headers retains the reason needed for automatic retry', async t => {
  const f = await setup(t);
  await assert.rejects(ensureBrowser({ ...f.config, downloadTimeoutMs: 20 }, f.root, {
    ...f.options,
    fetch: async (_url, init) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1]));
      // Electron's IncomingMessage is destroyed without the AbortSignal's reason.
      init.signal!.addEventListener('abort', () => controller.error(new DOMException('stream aborted', 'AbortError')), { once: true });
    } }))
  }), error => (error as Error).name === 'TimeoutError' && Boolean(connectionRetry(error)));
  assert.deepEqual(await readdir(f.root), []);
});
