import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildExtension(directory, override) {
  const defaults = JSON.parse(await readFile('config/defaults.json', 'utf8'));
  if (override) defaults.dot = { ...defaults.dot, ...override };
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const origin = new URL(defaults.dot.homeUrl).origin;
  await mkdir(directory, { recursive: true });
  await build({ entryPoints: ['src/extension/background.ts', 'src/extension/monitor.ts', 'src/extension/content.ts', 'src/extension/popup.ts'],
    outdir: directory, bundle: true, platform: 'browser', format: 'iife', target: 'chrome116',
    plugins: [{ name: 'extension-config', setup(build) { build.onLoad({ filter: /config[\\/]defaults\.json$/ }, () => ({ contents: JSON.stringify(defaults), loader: 'json' })); } }] });
  await Promise.all(['popup.html', 'popup.css'].map(file => copyFile(join('src/extension', file), join(directory, file))));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'WeChat Dot', version: pkg.version.split('-')[0], version_name: pkg.version,
    description: '连接这台电脑上的微信与自己的 dot。', key: defaults.dot.extension.publicKey, minimum_chrome_version: '116',
    permissions: ['scripting', 'storage', 'alarms'], host_permissions: [origin + '/*'],
    background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' },
    content_scripts: [
      { matches: [origin + '/*'], js: ['monitor.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: [origin + '/*'], js: ['content.js'], run_at: 'document_start' }
    ] }, null, 2) + '\n');
}
