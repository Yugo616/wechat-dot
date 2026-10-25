import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeClient } from './native-client.mjs';

const pkg = JSON.parse(await readFile('package.json', 'utf8')), mac = process.platform === 'darwin';
const root = await mkdtemp(join(tmpdir(), 'wechat-dot-native-install-')), apps = join(root, 'apps'), data = join(root, 'data');
const target = join(apps, mac ? 'WeChat Dot.app' : 'WeChat Dot');
const resources = join(target, mac ? 'Contents/Resources/native' : 'resources/native');
const executable = join(target, mac ? 'Contents/MacOS/WeChat Dot' : 'WeChat Dot.exe');
const file = `wechat-dot-${pkg.version}-${mac ? 'mac' : 'win'}-${process.arch}.${mac ? 'zip' : 'exe'}`, asset = resolve('release', file);
const exec = promisify(execFile);
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
let client, parent, server, quitRequested = false;
async function waitFor(check, message) {
  const end = Date.now() + 90000;
  while (!await check()) { if (Date.now() > end) throw new Error(message + '\n' + client?.log()); await new Promise(r => setTimeout(r, 100)); }
}
try {
  await mkdir(apps); await mkdir(data);
  await cp(mac ? resolve('src-tauri/target/release/bundle/macos/WeChat Dot.app') : resolve('.cache/native-prepackaged'), target, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(resources, 'app-update.yml'), JSON.stringify({ updaterCacheDirName: 'updates' }));
  const initial = { version: 1, enabled: false, weixinCursor: 'keep', inbound: [{ id: 'held', phase: 'done', expired: true, message: { message_id: 'held' } }], outbound: [], exitAction: 'minimize' };
  await writeFile(join(data, 'state.json'), JSON.stringify(initial));
  const size = (await stat(asset)).size;
  const sha512 = await new Promise((resolve, reject) => { const hash = createHash('sha512'); createReadStream(asset).on('data', b => hash.update(b)).on('end', () => resolve(hash.digest('base64'))).on('error', reject); });
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path.endsWith('.yml')) return res.end(JSON.stringify({ version: pkg.version, files: [{ url: file, sha512, size }], path: file, sha512 }));
    if (!path.endsWith('/' + file)) { res.statusCode = 404; return res.end(); }
    res.writeHead(200, { 'Content-Length': size }); createReadStream(asset).pipe(res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(join(data, 'config.json'), JSON.stringify({ updates: { feed: { provider: 'generic', url: `http://127.0.0.1:${server.address().port}/` } } }));
  // Stand in for the native window process so the real Mac installer must wait for its PID.
  parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 180000)'], { stdio: 'ignore' });
  const host = { name: pkg.build.productName, version: '0.9.9', isPackaged: true, appDirectory: resources, resourcesDirectory: resources, userDirectory: data, cacheDirectory: join(root, 'cache'), executablePath: executable, pid: parent.pid };
  client = nativeClient(host, { env: { WECHAT_DOT_DATA: data }, onEvent: value => { if (value.event === 'quit') quitRequested = true; } });
  console.log('Checking native update download');
  await client.request('action', 'check-update');
  assert.equal((await client.request('status')).update.phase, 'ready', client.log());
  console.log('Installing native update');
  await client.request('action', 'install-update');
  assert.ok(quitRequested, client.log());
  await client.close(); const parentExit = once(parent, 'exit'); parent.kill(); await parentExit; parent = undefined;
  console.log('Waiting for the updated native window');
  if (mac) await waitFor(async () => !(await readdir(apps)).some(name => name.startsWith('.wechat-dot-update-')), 'Native app did not restart and acknowledge installation');
  else await waitFor(async () => {
    const result = await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:WECHAT_DOT_FIXTURE_EXE } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p.MainWindowTitle) { $p.Id } }'], { env: { ...shellEnv, WECHAT_DOT_FIXTURE_EXE: await realpath(executable) } });
    return Boolean(result.stdout.trim());
  }, 'Native NSIS update did not reopen its installed application');
  assert.equal(JSON.parse(await readFile(join(resources, 'build-info.json'), 'utf8')).version, pkg.version);
  assert.deepEqual(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')), initial);
  console.log('PASS: native updater installs the real package, restarts at a custom path and preserves paused state, held queue and exit preference.');
} catch (error) {
  console.error('Native install failed:', error, client?.log()); throw error;
} finally {
  await client?.close(); parent?.kill();
  if (mac) {
    const canonical = await realpath(executable);
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,command=']);
    const owned = stdout.split('\n').map(line => /^\s*(\d+)\s+(.*)/.exec(line)).filter(m => m && m[2].startsWith(canonical)).map(m => Number(m[1]));
    for (const pid of owned) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await waitFor(() => owned.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'Updated fixture did not quit');
  } else await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:WECHAT_DOT_FIXTURE_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }'], { env: { ...shellEnv, WECHAT_DOT_FIXTURE_EXE: await realpath(executable) } });
  server?.closeAllConnections(); server?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
