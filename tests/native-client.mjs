import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
export function nativeClient(host, options = {}) {
  const root = resolve('dist/native');
  const child = spawn(options.node ?? join(root, process.platform === 'win32' ? 'node.exe' : 'node'), [join(root, 'backend.cjs'), JSON.stringify(host)], { env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let id = 0, log = ''; const pending = new Map();
  child.stderr.on('data', bytes => { log += bytes; });
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if (value.event) options.onEvent?.(value);
    if (value.id !== undefined) { const promise = pending.get(value.id); if (promise) { pending.delete(value.id); value.error ? promise.reject(new Error(value.error)) : promise.resolve(value.result); } }
  });
  child.on('exit', () => { for (const promise of pending.values()) promise.reject(new Error(log || 'Backend exited')); pending.clear(); });
  return { child, log: () => log,
    request(method, ...args) { return new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); child.stdin.write(JSON.stringify({ id: key, method, args }) + '\n'); }); },
    async close() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  };
}
