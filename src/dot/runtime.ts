import { access, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import extract from 'extract-zip';
import type { Config } from '../config';

type RuntimeConfig = Config['dot']['runtime'];
type Options = { signal: AbortSignal; progress?: (message: string) => void; fetch?: (url: string, init: RequestInit) => Promise<Response>; platform?: string; arch?: string };
const installations = new Map<string, Promise<string>>();

export async function configureWindowsBrowser(directory: string, timeout: number,
  execute: (file: string, args: string[], options: { windowsHide: boolean; timeout: number }) => Promise<unknown> = promisify(execFile)): Promise<void> {
  try { await execute(join(directory, 'setup.exe'), [`--configure-browser-in-directory=${directory}`], { windowsHide: true, timeout }); }
  catch (error) {
    // Chromium installer::CONFIGURE_APP_CONTAINER_SANDBOX_SUCCESS is 78, not zero.
    if ((error as { code?: number }).code !== 78) throw error;
  }
}

// Only Google's separate Chrome for Testing application lives here. Never resolve the user's browser.
export async function ensureBrowser(config: RuntimeConfig, root: string, options: Options): Promise<string> {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const target = config.platforms[`${platform}-${arch}` as keyof typeof config.platforms];
  if (!target) throw new Error('当前系统还没有可用的专用浏览器，请检查更新。');
  const directory = join(root, `${target.platform}-${config.version}`);
  const executable = join(directory, target.executable);
  options.signal.throwIfAborted();
  try { await access(join(directory, '.ready')); await access(executable); return executable; } catch {}
  const pending = installations.get(directory);
  if (pending) { await pending.catch(() => {}); options.signal.throwIfAborted(); return ensureBrowser(config, root, options); }
  const task = install(); installations.set(directory, task);
  try { return await task; } finally { if (installations.get(directory) === task) installations.delete(directory); }

  async function install(): Promise<string> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(root, '.download-'));
    const archive = join(staging, target.archive), unpacked = join(staging, 'unpacked');
    try {
      options.progress?.('正在准备专用浏览器，首次需要下载…');
      const url = `${config.baseUrl}/${config.version}/${target.platform}/${target.archive}`;
      const signal = AbortSignal.any([options.signal, AbortSignal.timeout(config.downloadTimeoutMs)]);
      const response = await (options.fetch ?? fetch)(url, { signal });
      if (!response.ok) throw new Error(`专用浏览器下载失败（HTTP ${response.status}）`);
      if (!response.body) throw new Error('专用浏览器下载中断，正在重试。');
      const file = await open(archive, 'w', 0o600);
      let received = 0, previous = -1;
      const total = Number(response.headers.get('content-length'));
      try {
        for await (const bytes of response.body as any as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted(); await file.writeFile(bytes); received += bytes.length;
          const percent = total ? Math.min(100, Math.floor(received * 100 / total)) : 0;
          if (percent !== previous) { previous = percent; options.progress?.(total ? `正在下载专用浏览器… ${percent}%` : '正在下载专用浏览器…'); }
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally { await file.close(); }
      signal.throwIfAborted();
      if (total && received !== total) throw new Error('专用浏览器下载中断，正在重试。');
      options.progress?.('正在安装专用浏览器…');
      await extract(archive, { dir: unpacked });
      options.signal.throwIfAborted();
      const stagedExecutable = join(unpacked, target.executable);
      await access(stagedExecutable);
      // Chrome's own installer grants its sandbox access to the downloaded binaries on Windows.
      if (platform === 'win32') await configureWindowsBrowser(dirname(stagedExecutable), config.setupTimeoutMs);
      options.signal.throwIfAborted();
      await writeFile(join(unpacked, '.ready'), config.version);
      await rm(directory, { recursive: true, force: true });
      await rename(unpacked, directory);
      return executable;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
