import { AppUpdater } from 'electron-updater';
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater';
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import type { AppAdapter } from 'electron-updater/out/AppAdapter';
import { access, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

// Use electron-updater's block maps and checksum verification, then our bundle installer.
// Unsigned builds use bundle replacement instead of Squirrel.Mac installation.
export class MacDownloadUpdater extends AppUpdater {
  declare protected httpExecutor: ElectronHttpExecutor;
  constructor(app?: AppAdapter, executor?: ElectronHttpExecutor) { super(undefined, app); if (executor) this.httpExecutor = executor; }
  protected async doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { info, provider } = options.updateInfoAndProvider;
    const files = provider.resolveFiles(info);
    const fileInfo = files.find(file => file.url.pathname.endsWith(`-mac-${process.arch}.zip`));
    if (!fileInfo) throw new Error('这个版本没有适合当前 Mac 的更新包。');
    return this.executeDownload({
      fileExtension: 'zip', fileInfo, downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        const previous = join(this.downloadedUpdateHelper!.cacheDir, 'update.zip');
        const cached = await access(previous).then(() => true, () => false);
        const full = !cached || options.disableDifferentialDownload ||
          await this.differentialDownloadInstaller(fileInfo, options, destination, provider, 'update.zip');
        if (full) await this.httpExecutor!.download(fileInfo.url, destination, downloadOptions);
      },
      done: async event => {
        await copyFile(event.downloadedFile, join(this.downloadedUpdateHelper!.cacheDir, 'update.zip'));
        this.dispatchUpdateDownloaded(event);
      }
    });
  }
  quitAndInstall(): void { throw new Error('请点击 WeChat Dot 中的「重启更新」。'); }
}
