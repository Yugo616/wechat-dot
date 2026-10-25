import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const directory = resolve('dist/native');
assert.ok(await access(join(directory, 'backend.cjs')).then(() => true, () => false), 'Native backend must be built without an Electron dependency');
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-native-'));
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
let child, output = '';
async function launch() {
  const host = { appDirectory: directory, resourcesDirectory: directory, userDirectory: data, cacheDirectory: join(data, 'cache'), executablePath: process.execPath, version, name: 'WeChat Dot', isPackaged: false, pid: process.pid };
  child = spawn(process.execPath, [join(directory, 'backend.cjs'), JSON.stringify(host)], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', bytes => { output += bytes; });
  let id = 0; const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if (value.id !== undefined) { const p = pending.get(value.id); if (p) { pending.delete(value.id); value.error ? p.reject(new Error(value.error)) : p.resolve(value.result); } }
  });
  const request = (method, args = []) => new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: key, method, args }) + '\n');
  });
  return request;
}
try {
  let request = await launch();
  const first = await request('status'); assert.equal(first.version, version); assert.equal(first.running, false);
  const [snapshot, state] = await Promise.all([request('backlog'), request('status')]);
  assert.deepEqual(snapshot.items, []); assert.equal(state.dot, 'idle');
  await assert.rejects(request('unrecognized'), /不支持|未知/);
  await request('action', ['request-exit']); assert.equal((await request('status')).exitPrompt, true);
  await request('action', ['exit-minimize', 'remember']);
  const exited = once(child, 'exit'); child.stdin.end();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Backend stayed alive after its parent pipe closed')), 5000).unref())]);
  request = await launch();
  assert.equal((await request('status')).exitAction, 'minimize');
  assert.equal((await request('status')).running, false);
  const closed = once(child, 'exit'); await request('shutdown'); await closed;
  request = await launch(); await request('status');
  const disconnected = once(child, 'exit'); child.stdout.destroy(); child.stdin.end();
  const [code] = await disconnected;
  assert.equal(code, 0, 'Losing both parent pipes must finish state cleanup without an EPIPE crash');
  assert.equal(JSON.parse(await readFile(join(data, 'state.json'), 'utf8')).enabled, false);
  console.log('PASS: bundled Node backend RPC, concurrent commands, unknown-command rejection, saved preferences, paused restart and parent-exit cleanup.');
} catch (error) { console.error(output); throw error; }
finally { if (child?.exitCode === null) child.kill(); await rm(data, { recursive: true, force: true }); }
