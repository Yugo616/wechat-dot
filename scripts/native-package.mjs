import { build, Platform, Arch } from 'electron-builder';
import { mkdir, mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const mac = process.platform === 'darwin';
const exec = promisify(execFile);
let source, staging;
try {
if (mac) {
  staging = await mkdtemp(join(tmpdir(), 'wechat-dot-package-'));
  source = join(staging, `${pkg.build.productName}.app`);
  await exec('/usr/bin/ditto', ['--norsrc', '--noextattr', resolve('src-tauri/target/release/bundle/macos', `${pkg.build.productName}.app`), source]);
  // The linker signs only the executable; seal the completed app before archiving it.
  await exec('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', source]);
  await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
}
else {
  source = resolve('.cache/native-prepackaged');
  await rm(source, { recursive: true, force: true });
  await mkdir(join(source, 'resources'), { recursive: true });
  await cp(resolve('src-tauri/target/release', `${pkg.build.productName}.exe`), join(source, `${pkg.build.productName}.exe`));
  await cp('dist/native', join(source, 'resources/native'), { recursive: true });
  const config = JSON.parse(await readFile('config/windows-runtime.json', 'utf8'));
  const response = await fetch(config.bootstrapperUrl, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`WebView2 bootstrapper download: ${response.status}`);
  const file = join(source, 'resources/MicrosoftEdgeWebview2Setup.exe');
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  // Windows PowerShell must load its own modules when npm was started by PowerShell 7.
  const shellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference = "Stop"; $s = Get-AuthenticodeSignature -LiteralPath $env:WECHAT_DOT_BOOTSTRAPPER; if ($s.Status -ne "Valid" -or $s.SignerCertificate.Subject -notmatch "Microsoft Corporation") { throw "Invalid Microsoft bootstrapper signature" }'], { env: { ...shellEnv, WECHAT_DOT_BOOTSTRAPPER: file } });
  await writeFile('dist/webview-runtime.nsh', `!define WEBVIEW_CLIENT_ID "${config.clientId}"\n`);
}
// A newly sealed bundle can retain source timestamps. Never reuse an older archive.
for (const ext of mac ? ['dmg', 'zip'] : ['exe']) {
  const name = pkg.build.artifactName.replace('${version}', pkg.version).replace('${os}', mac ? 'mac' : 'win').replace('${arch}', process.arch).replace('${ext}', ext);
  await rm(join(pkg.build.directories.output, name), { force: true });
}
await build({ prepackaged: source, targets: (mac ? Platform.MAC : Platform.WINDOWS).createTarget(undefined, process.arch === 'arm64' ? Arch.arm64 : Arch.x64), publish: 'never' });
await import('./update-feed.mjs');
} finally { if (staging) await rm(staging, { recursive: true, force: true }); }
