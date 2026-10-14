import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import defaults from '../config/defaults.json';
export type Config = typeof defaults;
export async function loadConfig(appDirectory: string, userDirectory: string): Promise<Config> {
  const base: Config = JSON.parse(await readFile(join(appDirectory, 'config', 'defaults.json'), 'utf8'));
  let custom: Partial<Config> = {};
  try { custom = JSON.parse(await readFile(join(userDirectory, 'config.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('config.json 格式有误，请检查配置。'); }
  const storage = { ...base.storage, ...custom.storage };
  const dot = { ...base.dot, ...custom.dot };
  dot.extension = { ...base.dot.extension, ...custom.dot?.extension };
  // A downloaded file is returned as base64 plus JSON metadata over the local connection.
  dot.extension.maxPayloadBytes = Math.max(dot.extension.maxPayloadBytes, Math.ceil(storage.maxMediaBytes * 4 / 3) + 65536);
  return {
    desktop: { ...base.desktop, ...custom.desktop },
    weixin: { ...base.weixin, ...custom.weixin }, dot,
    storage, updates: { ...base.updates, ...custom.updates }
  };
}
