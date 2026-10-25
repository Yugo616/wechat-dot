import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { HttpExecutor, configureRequestOptions, configureRequestUrl, type DownloadOptions } from 'builder-util-runtime';
import { NsisUpdater } from 'electron-updater';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import { MacDownloadUpdater } from '../updates/mac-download';

export class NodeUpdateExecutor extends HttpExecutor<ReturnType<typeof httpRequest>> {
  createRequest(options: RequestOptions, callback: (response: any) => void) {
    return (options.protocol === 'http:' ? httpRequest : httpsRequest)(options, callback);
  }
  download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const request: RequestOptions = { headers: options.headers ?? undefined };
      configureRequestUrl(url, request); configureRequestOptions(request);
      this.doDownload(request, { destination, options, onCancel, responseHandler: null,
        callback: error => error ? reject(error) : resolve(destination) }, 0);
    });
  }
}
class NativeNsisUpdater extends NsisUpdater {
  declare protected httpExecutor: ElectronHttpExecutor;
  constructor(adapter: AppAdapter, executor: ElectronHttpExecutor, private executable: string) {
    super(undefined, adapter); this.httpExecutor = executor; this.disableWebInstaller = true;
  }
  override async quitAndInstall(silent = true, forceRun = true): Promise<void> {
    const file = this.installerPath;
    if (!file) throw new Error('更新包未下载完成，请重新检查更新。');
    const args = ['--updated', ...(silent ? ['/S'] : []), ...(forceRun ? ['--force-run'] : []), `/D=${dirname(this.executable)}`];
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); this.app.quit();
  }
}
export interface NativeHostInfo {
  name: string; version: string; isPackaged: boolean; appDirectory: string; userDirectory: string;
  resourcesDirectory: string; cacheDirectory: string; executablePath: string; pid: number;
}
export function createNativeUpdater(host: NativeHostInfo, quit: () => void) {
  const adapter: AppAdapter = {
    version: host.version, name: host.name, isPackaged: host.isPackaged,
    userDataPath: host.userDirectory, baseCachePath: host.cacheDirectory,
    appUpdateConfigPath: join(host.resourcesDirectory, 'app-update.yml'),
    whenReady: async () => {}, relaunch: () => {}, quit, onQuit: handler => process.once('exit', handler)
  };
  const executor = new NodeUpdateExecutor() as unknown as ElectronHttpExecutor;
  return process.platform === 'darwin' ? new MacDownloadUpdater(adapter, executor) : new NativeNsisUpdater(adapter, executor, host.executablePath);
}
