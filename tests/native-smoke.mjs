import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-native-smoke-'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
let executable = process.env.WECHAT_DOT_EXECUTABLE && resolve(process.env.WECHAT_DOT_EXECUTABLE);
const initial = { version: 1, enabled: false, weixinCursor: 'keep', inbound: [], outbound: [], exitAction: 'minimize' };
await writeFile(join(data, 'state.json'), JSON.stringify(initial));
let child;
async function waitFor(check, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (!await check()) { if (Date.now() > until) throw new Error(message); await new Promise(r => setTimeout(r, 100)); }
}
try {
  if (!executable) {
    const app = join(data, `${pkg.build.productName}.app`);
    const exec = promisify(execFile);
    await exec('/usr/bin/ditto', ['-x', '-k', resolve('release', `wechat-dot-${pkg.version}-mac-${process.arch}.zip`), data]);
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    executable = join(app, 'Contents/MacOS', pkg.build.productName);
  }
  executable = await realpath(executable);
  for (let run = 0; run < 2; run++) {
    let output = '';
    child = spawn(executable, [], { env: { ...process.env, WECHAT_DOT_DATA: data, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    await waitFor(() => { if (child.exitCode !== null) throw new Error(output); return output.includes('WeChat Dot interface connected'); }, 'Native WebView did not connect to its bundled backend').catch(error => { throw new Error(`${error.message}\n${output}`); });
    const pid = child.pid, exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    if (process.platform === 'darwin') await waitFor(async () => {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'command=']);
      return !stdout.split('\n').some(line => line.includes('/native/backend.cjs {') && line.includes(`"pid":${pid},`));
    }, 'Native backend outlived its parent');
    assert.deepEqual(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')), initial);
  }
  console.log('PASS: packaged system WebView connects to bundled backend without installed Node; parent exit and paused restart preserve state.');
} finally { if (child?.exitCode === null && child?.signalCode === null) child.kill(); await rm(data, { recursive: true, force: true }); }
