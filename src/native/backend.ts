import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createController } from '../controller';
import { configureRuntime } from '../runtime';
import { createNativeUpdater, type NativeHostInfo } from './updater';
import { connectionSummary } from '../status';

let parentGone = false;
const send = (value: unknown) => { if (!parentGone) process.stdout.write(JSON.stringify(value) + '\n'); };
// stdout belongs to the parent protocol. Dependency logs go to stderr.
console.log = console.info = console.warn = console.debug = console.error.bind(console);
const host: NativeHostInfo = JSON.parse(process.argv[2]);
configureRuntime({ userDirectory: host.userDirectory, extensionDirectory: join(host.resourcesDirectory, 'browser-connection'), fetch: globalThis.fetch });
const event = (name: string, value?: unknown) => { send({ event: name, value }); };
const ready = createController({ ...host,
  createUpdater: () => createNativeUpdater(host, () => event('quit')),
  show: () => event('show'), hide: () => event('hide'), quit: () => event('quit'),
  openPath: async path => event('open-path', path), openExternal: async url => event('open-url', url),
  publish: status => event('status', { ...status, summaryTitle: connectionSummary(status).title })
});
let closing: Promise<void> | undefined;
async function close() { await (closing ??= ready.then(core => core.close())); }
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void (async () => {
  let id: number | undefined;
  try {
    const request = JSON.parse(line); id = request.id;
    const core = await ready;
    const args = Array.isArray(request.args) ? request.args : [];
    let result: unknown;
    switch (request.method) {
      case 'status': result = core.status(); break;
      case 'backlog': result = core.backlog(); break;
      case 'manage-backlog': result = await core.manageBacklog(args[0], args[1]); break;
      case 'action': result = await core.action(args[0], args[1]); break;
      case 'resize': if (Number.isFinite(args[0])) event('resize', { ...core.config.desktop, height: args[0], viewportHeight: args[1] }); break;
      case 'shutdown': await close(); send({ id, result: null }); process.exit(0); break;
      default: throw new Error('不支持的程序操作。');
    }
    send({ id, result: result ?? null });
  } catch (error) { send({ id, error: (error as Error).message }); }
})().catch(error => console.error(error)); });
const disconnect = () => { parentGone = true; void close().finally(() => process.exit(0)); };
lines.on('close', disconnect);
process.stdout.on('error', disconnect);
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void close().finally(() => process.exit(0)); });
void ready.then(core => core.start()).catch(error => { console.error(error); process.exit(1); });
