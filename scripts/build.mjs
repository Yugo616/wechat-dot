import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'silk-wasm', 'qrcode'] });
await build({ entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['src/ui/app.ts'], outfile: 'dist/ui.js', bundle: true, platform: 'browser', target: 'chrome140' });
await Promise.all(['index.html', 'style.css'].map(file => copyFile(`src/ui/${file}`, `dist/${file}`)));
