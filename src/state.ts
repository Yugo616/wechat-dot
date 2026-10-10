import type { BridgeState, ConnectionProgress, DotProfile, WeixinAccount } from './types';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sameDotConnection } from './dot/profile';
export const emptyState = (): BridgeState => ({ version: 1, weixinCursor: '', inbound: [], outbound: [], enabled: false });
function binding(s: BridgeState): string | undefined {
  if (!s.weixin || !s.dot) return;
  return createHash('sha256').update(JSON.stringify([s.weixin.userId, s.weixin.botId, s.dot.userId, s.dot.accountId, s.dot.roomId])).digest('hex');
}
function progress(s: ConnectionProgress): ConnectionProgress {
  const { weixinCursor, weixinPrimed, dotCursor, dotPending, contextToken, weixinSendError, inbound, outbound } = s;
  return { weixinCursor, weixinPrimed, dotCursor, dotPending, contextToken, weixinSendError, inbound, outbound };
}
export class StateStore {
  data: BridgeState = emptyState();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async connectWeixin(account: WeixinAccount): Promise<void> {
    await this.connect(s => {
      if (!s.dot && s.weixin && (s.weixin.userId !== account.userId || s.weixin.botId !== account.botId)) {
        s.weixinCursor = ''; s.weixinPrimed = false; delete s.contextToken;
      }
      s.weixin = account;
    });
  }
  async connectDot(profile: DotProfile): Promise<void> {
    await this.connect(s => {
      if (!profile.accountId && s.dot?.accountId && sameDotConnection(s.dot, profile)) profile = { ...profile, accountId: s.dot.accountId };
      if (!profile.accountId) {
        const known = Object.entries(s.savedConnections ?? {}).filter(([key, saved]) =>
          saved.dot && sameDotConnection(saved.dot, profile) && key === binding({ ...s, dot: saved.dot }));
        const accounts = [...new Set(known.map(([, saved]) => saved.dot!.accountId).filter(Boolean))];
        if (accounts.length === 1) profile = { ...profile, accountId: accounts[0] };
        else if (accounts.length > 1) throw new Error('这个 dot 有多个账号连接记录，请在 Chrome 中确认账号后重新识别。');
      }
      const same = s.dot && sameDotConnection(s.dot, profile);
      s.dot = { ...profile, accountId: profile.accountId || (same ? s.dot!.accountId : '') };
      return same;
    });
  }
  private async connect(change: (state: BridgeState) => boolean | void): Promise<void> {
    await this.update(s => {
      const previous = binding(s), saved = { ...progress(s), dot: s.dot };
      const same = change(s);
      const next = binding(s);
      if (!same && previous && next && previous !== next) {
        s.savedConnections ??= {};
        s.savedConnections[previous] = saved;
        Object.assign(s, s.savedConnections[next] ? progress(s.savedConnections[next]) : { weixinCursor: '', weixinPrimed: false, dotCursor: undefined, dotPending: [], contextToken: undefined, weixinSendError: undefined, inbound: [], outbound: [] });
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
