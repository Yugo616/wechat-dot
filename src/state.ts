import type { BridgeState, ConnectionProgress, DotProfile, WeixinAccount } from './types';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const emptyState = (): BridgeState => ({ version: 1, weixinCursor: '', inbound: [], outbound: [], enabled: false });
function binding(s: BridgeState): string | undefined {
  if (!s.weixin || !s.dot) return;
  return createHash('sha256').update(JSON.stringify([s.weixin.userId, s.weixin.botId, s.dot.userId, s.dot.accountId, s.dot.roomId])).digest('hex');
}
function progress(s: BridgeState): ConnectionProgress {
  const { weixinCursor, weixinPrimed, dotCursor, dotPending, contextToken, inbound, outbound } = s;
  return { weixinCursor, weixinPrimed, dotCursor, dotPending, contextToken, inbound, outbound };
}
export class StateStore {
  data: BridgeState = emptyState();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async connectWeixin(account: WeixinAccount): Promise<void> { await this.connect(s => { s.weixin = account; }); }
  async connectDot(profile: DotProfile): Promise<void> { await this.connect(s => { s.dot = profile; }); }
  private async connect(change: (state: BridgeState) => void): Promise<void> {
    await this.update(s => {
      const previous = binding(s), saved = progress(s);
      change(s);
      const next = binding(s);
      if (previous && next && previous !== next) {
        s.savedConnections ??= {};
        s.savedConnections[previous] = saved;
        Object.assign(s, s.savedConnections[next] ?? { weixinCursor: '', weixinPrimed: false, dotCursor: undefined, dotPending: [], contextToken: undefined, inbound: [], outbound: [] });
        delete s.savedConnections[next];
        s.enabled = false;
      }
    });
  }
  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const value = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.inbound) || !Array.isArray(value.outbound)) throw new Error('连接记录格式不兼容，请保留数据并更新程序。');
      this.data = { ...emptyState(), ...value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  async update(change: (state: BridgeState) => void): Promise<void> {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.data);
      change(next);
      const target = join(this.directory, 'state.json');
      await writeFile(`${target}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${target}.tmp`, target);
      this.data = next;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
}
