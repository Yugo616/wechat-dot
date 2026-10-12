import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const exec = promisify(execFile);

export async function removeMacStage(directory: string): Promise<void> {
  // Electron's patched fs treats app.asar as a directory; bundle deletion needs the real filesystem.
  const fs = process.versions.electron ? await import('original-fs') : await import('node:fs');
  await fs.promises.rm(directory, { recursive: true, force: true });
}

export async function stageMacUpdate(zip: string, installedApp: string, bundleId: string, version: string): Promise<{ app: string; directory: string }> {
  const parent = dirname(installedApp);
  await access(parent, constants.W_OK).catch(() => { throw new Error('请先把 WeChat Dot 移到可写的「应用程序」文件夹，再重试更新。'); });
  const directory = await mkdtemp(join(parent, '.wechat-dot-update-'));
  try {
    await exec('/usr/bin/ditto', ['-x', '-k', zip, directory]);
    const entries = (await readdir(directory)).filter(name => name.endsWith('.app'));
    if (entries.length !== 1) throw new Error('更新包缺少应用程序，请重新检查更新。');
    const app = join(directory, entries[0]), plist = join(app, 'Contents', 'Info.plist');
    const field = async (key: string) => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
    if (await field('CFBundleIdentifier') !== bundleId || await field('CFBundleShortVersionString') !== version) throw new Error('更新包与当前应用或版本不匹配。');
    return { app, directory };
  } catch (error) { await removeMacStage(directory); throw error; }
}

// Arguments are passed separately; app paths and user names are never shell source.
const installScript = `#!/bin/sh
set -eu
parent="$1"; target="$2"; staged="$3"; backup="$4"
count=0
while kill -0 "$parent" 2>/dev/null; do
  count=$((count + 1))
  if [ "$count" -ge 120 ]; then exit 1; fi
  sleep 0.5
done
mv "$target" "$backup"
if ! mv "$staged" "$target"; then
  mv "$backup" "$target"
  /usr/bin/open -n "$target" --env "WECHAT_DOT_DATA=$6"
  exit 1
fi
touch "$5"
/usr/bin/open -n "$target" --env "WECHAT_DOT_DATA=$6"
`;

export async function scheduleMacInstall(staged: { app: string; directory: string }, installedApp: string, version: string, userData: string): Promise<void> {
  const script = join(staged.directory, 'install.sh');
  await writeFile(join(staged.directory, 'receipt.json'), JSON.stringify({ target: installedApp, version, pid: process.pid }), { mode: 0o600 });
  await writeFile(script, installScript, { mode: 0o700 });
  const child = spawn('/bin/sh', [script, String(process.pid), installedApp, staged.app, join(staged.directory, basename(installedApp) + '.previous'), join(staged.directory, 'installed'), userData], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export async function finishMacInstall(installedApp: string, version: string): Promise<void> {
  installedApp = await realpath(installedApp);
  const parent = dirname(installedApp);
  for (const name of await readdir(parent)) {
    if (!name.startsWith('.wechat-dot-update-')) continue;
    const directory = join(parent, name);
    try {
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
      if (typeof receipt.target !== 'string' || await realpath(receipt.target) !== installedApp) continue;
      const installed = await access(join(directory, 'installed')).then(() => true, () => false);
      if (installed && receipt.version === version) await removeMacStage(directory);
      else if (!installed && Number.isSafeInteger(receipt.pid) && receipt.pid > 0) {
        let alive = true; try { process.kill(receipt.pid, 0); } catch { alive = false; }
        if (!alive) await removeMacStage(directory);
      }
    } catch { /* An unrelated or incomplete directory can be left for its owner. */ }
  }
}
