import type { BridgeState } from './types';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const emptyState = (): BridgeState => ({ version: 1, weixinCursor: '', inbound: [], outbound: [], enabled: false });
export class StateStore {
  data: BridgeState = emptyState();
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
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
