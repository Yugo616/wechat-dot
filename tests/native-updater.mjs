import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js';
import { nativeClient } from './native-client.mjs';
const root = await mkdtemp(join(tmpdir(), 'wechat-dot-native-update-'));
const mac = process.platform === 'darwin', version = '1.2.0';
const file = `wechat-dot-${version}-${mac ? 'mac' : 'win'}-${process.arch}.${mac ? 'zip' : 'exe'}`;
const asset = join(root, file), cache = join(root, 'cache', 'updates'), data = join(root, 'data');
let client, server, full = 0, ranged = 0, transferred = 0, corrupt = false;
const bytes = randomBytes(2 * 1024 * 1024), sha512 = createHash('sha512').update(bytes).digest('base64');
const host = { name: 'WeChat Dot', version: '0.9.9', isPackaged: true, appDirectory: resolve('dist/native'), resourcesDirectory: root, userDirectory: data, cacheDirectory: join(root, 'cache'), executablePath: process.execPath, pid: process.pid };
try {
  await mkdir(data); await mkdir(cache, { recursive: true });
  await writeFile(asset, bytes); await buildBlockMap(asset, 'gzip', asset + '.blockmap');
  await writeFile(join(root, 'app-update.yml'), JSON.stringify({ updaterCacheDirName: 'updates' }));
  const initial = { version: 1, enabled: false, weixinCursor: 'keep', inbound: [{ id: 'held', phase: 'done', expired: true, message: { message_id: 'held' } }], outbound: [], exitAction: 'minimize' };
  await writeFile(join(data, 'state.json'), JSON.stringify(initial));
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path.endsWith('.yml')) return res.end(JSON.stringify({ version, files: [{ url: file, sha512, size: bytes.length }], path: file, sha512 }));
    let content;
    if (path.endsWith(`/${file}`)) content = corrupt ? Buffer.alloc(bytes.length) : bytes;
    else if (path.endsWith(`/${file}.blockmap`)) content = await readFile(asset + '.blockmap');
    else if (path.endsWith('.blockmap')) content = await readFile(join(root, 'old.blockmap')).catch(() => undefined);
    else { res.writeHead(404); return res.end(); }
    if (!content) { res.writeHead(404); return res.end(); }
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range); assert.ok(match);
      const start = Number(match[1]), end = Number(match[2]); ranged++; transferred += end - start + 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': end - start + 1 }); res.end(content.subarray(start, end + 1));
    } else { if (path.endsWith(`/${file}`)) full++; res.writeHead(200, { 'Content-Length': content.length }); res.end(content); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(join(data, 'config.json'), JSON.stringify({ updates: { feed: { provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` } } }));
  client = nativeClient(host); await client.request('action', 'check-update');
  assert.equal((await client.request('status')).update.phase, 'ready', client.log()); assert.equal(full, 1);
  await client.close();
  await rm(cache, { recursive: true, force: true }); await mkdir(cache);
  const previous = join(cache, mac ? 'update.zip' : 'installer.exe');
  await cp(asset, previous); await appendFile(previous, Buffer.alloc(32768, 17));
  await buildBlockMap(previous, 'gzip', join(root, 'old.blockmap'));
  full = ranged = transferred = 0;
  client = nativeClient(host); await client.request('action', 'check-update');
  assert.equal((await client.request('status')).update.phase, 'ready', client.log());
  assert.ok(ranged > 0 && full === 0 && transferred < bytes.length / 2, client.log());
  await client.close();
  await rm(cache, { recursive: true, force: true }); corrupt = true;
  client = nativeClient(host); await client.request('action', 'check-update');
  assert.equal((await client.request('status')).update.phase, 'error', 'Corrupted updates must never be installable');
  await client.close();
  assert.deepEqual(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')), initial);
  console.log('PASS: native full/differential download, checksum rejection and unchanged paused state/held message.');
} finally { await client?.close(); server?.closeAllConnections(); server?.close(); await rm(root, { recursive: true, force: true }); }
