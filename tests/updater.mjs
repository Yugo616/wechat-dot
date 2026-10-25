import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractAll, extractFile, createPackage } from '@electron/asar';
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js';
import assert from 'node:assert/strict';

const exec = promisify(execFile), mac = process.platform === 'darwin';
const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
const native = process.env.WECHAT_DOT_UPDATE_NATIVE === '1';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'wechat-dot-updater-'));
const cache = join(mac ? join(homedir(), 'Library/Caches') : process.env.LOCALAPPDATA, basename(root));
const data = join(root, 'data'), apps = join(root, 'apps');
const defaultExecutable = mac ? join('release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'WeChat Dot.app/Contents/MacOS/WeChat Dot') : 'release/win-unpacked/WeChat Dot.exe';
const sourceExe = resolve(process.env.WECHAT_DOT_EXECUTABLE || defaultExecutable);
const target = join(apps, mac ? 'WeChat Dot.app' : 'WeChat Dot');
const executable = mac ? join(target, 'Contents/MacOS/WeChat Dot') : join(target, 'WeChat Dot.exe');
const resources = mac ? join(target, 'Contents/Resources') : join(target, 'resources');
const fileName = `wechat-dot-${pkg.version}-${mac ? 'mac' : 'win'}-${process.arch}.${mac ? 'zip' : 'exe'}`;
const asset = resolve('release', fileName), blockmap = `${asset}.blockmap`;
const oldName = fileName.replace(pkg.version, '0.9.9');
let desktop, server, transferred = 0, ranged = 0, full = 0;
const requested = [];
async function waitFor(check, message, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(message);
}
async function launch() {
  desktop = await electron.launch({ executablePath: executable, args: [], env: { ...process.env, WECHAT_DOT_DATA: data }, timeout: 60000 });
  desktop.process().stderr.on('data', b => console.log(String(b).trim()));
  const page = await desktop.firstWindow({ timeout: 30000 });
  await page.getByRole('button', { name: '检查更新', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.wechatDot.status())).version, '0.9.9');
  return page;
}
try {
  await mkdir(apps); await mkdir(data);
  if (!mac && process.env.WECHAT_DOT_LEGACY_INSTALLER) {
    // NSIS preserves Start-menu shortcuts during updates. Install the old version at
    // this path so its registered shortcuts match the application being upgraded.
    await exec(resolve(process.env.WECHAT_DOT_LEGACY_INSTALLER), ['/S', `/D=${target}`]);
    const shortcut = await exec('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; $link = Join-Path ([Environment]::GetFolderPath("Programs")) ($env:WECHAT_DOT_FIXTURE_NAME + ".lnk"); (New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath'], { env: { ...shellEnv, WECHAT_DOT_FIXTURE_NAME: pkg.build.productName } });
    assert.equal((await realpath(shortcut.stdout.trim())).toLowerCase(), (await realpath(executable)).toLowerCase(), 'Previous installer must register this fixture as its launch target');
  } else await cp(mac ? resolve(sourceExe, '../../..') : dirname(sourceExe), target, { recursive: true, verbatimSymlinks: true });
  const unpacked = join(root, 'unpacked');
  extractAll(join(resources, 'app.asar'), unpacked);
  const oldPackage = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8')); oldPackage.version = '0.9.9';
  await writeFile(join(unpacked, 'package.json'), JSON.stringify(oldPackage));
  await createPackage(unpacked, join(resources, 'app.asar'));
  const configFile = join(resources, 'app-update.yml');
  await writeFile(configFile, (await readFile(configFile, 'utf8')).replace(/updaterCacheDirName:.*/, `updaterCacheDirName: ${basename(root)}`));
  const initial = { version: 1, weixinCursor: 'keep-cursor', inbound: [{ id: 'keep-job', phase: 'pending', message: { message_id: 'keep-job' } }], outbound: [], enabled: false, exitAction: 'minimize' };
  await writeFile(join(data, 'state.json'), JSON.stringify(initial));
  const size = (await stat(asset)).size;
  const sha512 = await new Promise((resolve, reject) => {
    const hash = createHash('sha512'); createReadStream(asset).on('data', b => hash.update(b)).on('end', () => resolve(hash.digest('base64'))).on('error', reject);
  });
  const info = { version: pkg.version, files: [{ url: fileName, sha512, size }], path: fileName, sha512, releaseDate: new Date().toISOString() };
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requested.push(url.pathname);
    if (url.pathname.endsWith('.atom')) return res.end(`<feed><entry><title>Update fixture</title><link href="http://localhost/fixture/wechat-dot/releases/tag/v${pkg.version}"/><content>Fixture</content></entry></feed>`);
    if (url.pathname.endsWith('/latest')) return res.end(JSON.stringify({ tag_name: `v${pkg.version}` }));
    if (url.pathname.endsWith('.yml')) return res.end(JSON.stringify(info));
    let path;
    if (url.pathname.endsWith(`/${fileName}`)) path = asset;
    else if (url.pathname.endsWith(`/${fileName}.blockmap`)) path = blockmap;
    else if (url.pathname.endsWith(`/${oldName}.blockmap`)) path = join(root, 'old.blockmap');
    else { res.statusCode = 404; return res.end(); }
    try {
      const length = (await stat(path)).size;
      if (req.headers.range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
        if (!match) { res.statusCode = 416; return res.end(); }
        const start = Number(match[1]), end = Number(match[2]);
        if (path === asset) { ranged++; transferred += end - start + 1; }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
        createReadStream(path, { start, end }).pipe(res);
      } else {
        if (path === asset) { full++; transferred += length; }
        res.writeHead(200, { 'Content-Length': length, 'Accept-Ranges': 'bytes' }); createReadStream(path).pipe(res);
      }
    } catch { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`;
  await writeFile(join(data, 'config.json'), JSON.stringify({ updates: { feed: { provider: 'github', owner: 'fixture', repo: 'wechat-dot', host, protocol: 'http' } } }));
  let page = await launch();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '重启更新', exact: true }).waitFor({ timeout: 90000 });
  assert.ok(full > 0, 'First update should work without a previous installer cache');
  assert.equal((await page.evaluate(() => window.wechatDot.status())).running, false);
  await desktop.close(); desktop = undefined;

  await rm(cache, { recursive: true, force: true }); await mkdir(cache);
  const oldBinary = join(cache, mac ? 'update.zip' : 'installer.exe');
  await cp(asset, oldBinary); await appendFile(oldBinary, Buffer.alloc(32768, 17));
  await buildBlockMap(oldBinary, 'gzip', join(root, 'old.blockmap'));
  transferred = ranged = full = 0; requested.length = 0;
  page = await launch();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  await page.getByRole('button', { name: '重启更新', exact: true }).waitFor({ timeout: 90000 });
  assert.ok(requested.some(p => p.includes('/download/v0.9.9/')), 'Old block map must be fetched from its own release');
  assert.ok(ranged > 0 && full === 0 && transferred < size / 2, `Expected differential transfer, got ranged=${ranged} full=${full} ${transferred}/${size}`);
  console.log(`PASS: GitHub provider downloaded ${transferred} of ${size} bytes through real range requests.`);
  const previousProcess = desktop.process();
  await page.getByRole('button', { name: '重启更新', exact: true }).click();
  await waitFor(() => previousProcess.exitCode !== null, 'Old app did not exit for installation'); desktop = undefined;
  await waitFor(async () => {
    try {
      const metadata = native ? await readFile(join(resources, 'native/build-info.json'), 'utf8') : extractFile(join(resources, 'app.asar'), 'package.json').toString();
      return JSON.parse(metadata).version === pkg.version;
    } catch { return false; }
  }, 'Installed app did not become the new version', 90000);
  if (mac) await waitFor(async () => !(await readdir(apps)).some(n => n.startsWith('.wechat-dot-update-')), 'New app did not start and acknowledge update cleanup');
  else await waitFor(async () => {
    const result = await exec('powershell.exe', ['-NoProfile', '-Command', '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:WECHAT_DOT_FIXTURE_EXE } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p.MainWindowTitle) { $p.Id } }'], { env: { ...shellEnv, WECHAT_DOT_FIXTURE_EXE: await realpath(executable) } });
    return Boolean(result.stdout.trim());
  }, 'Updated Windows app did not open its window');
  assert.deepEqual(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')), initial);
  console.log('PASS: update installed, restarted, and preserved paused state, saved cursor, pending message and exit preference.');
} catch (error) {
  console.error('Update fixture failed in', root, error);
  if (!mac) {
    const diagnostic = await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "WeChat Dot.exe" -or $_.CommandLine -like "*wechat-dot-updater-*" } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json'], { env: shellEnv }).catch(error => ({ stdout: String(error) }));
    console.error('Windows update processes:', diagnostic.stdout);
  }
  if (mac) for (const name of await readdir(apps)) {
    if (!name.startsWith('.wechat-dot-update-')) continue;
    const folder = join(apps, name);
    console.error('Remaining stage', await readdir(folder), await readFile(join(folder, 'receipt.json'), 'utf8').catch(() => '(already removed)'));
  }
  throw error;
} finally {
  if (desktop) await desktop.close().catch(() => {});
  if (mac) {
    const processes = await exec('/bin/ps', ['-axo', 'pid=,command=']);
    const owned = [], canonical = await realpath(executable);
    for (const line of processes.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)/.exec(line);
      if (match && match[2].startsWith(canonical)) {
        owned.push(Number(match[1]));
        try { process.kill(Number(match[1]), 'SIGTERM'); } catch {}
      }
    }
    await waitFor(() => owned.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'Fixture app did not finish quitting');
  } else await exec('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:WECHAT_DOT_FIXTURE_EXE } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }'], { env: { ...shellEnv, WECHAT_DOT_FIXTURE_EXE: await realpath(executable) } });
  if (server) { server.closeAllConnections(); server.close(); }
  await rm(root, { recursive: true, force: true, maxRetries: 3 }); await rm(cache, { recursive: true, force: true, maxRetries: 3 });
}
