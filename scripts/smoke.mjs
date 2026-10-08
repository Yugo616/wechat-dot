import { _electron as electron } from 'playwright-core';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const data = await mkdtemp(join(tmpdir(), 'wechat-dot-smoke-'));
let desktop;
try {
  desktop = await electron.launch({ ...(process.env.WECHAT_DOT_EXECUTABLE ? { executablePath: process.env.WECHAT_DOT_EXECUTABLE, args: [] } : { args: ['.'] }), env: { ...process.env, WECHAT_DOT_DATA: data }, timeout: 60000 });
  const page = await desktop.firstWindow();
  await page.getByRole('heading', { name: 'WeChat Dot', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /开始连接/ }).isDisabled(), true);
  const extension = await desktop.evaluate(({ app }) => app.isPackaged ? `${process.resourcesPath}/chrome-extension` : `${app.getAppPath()}/dist/extension`);
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'WeChat Dot');
  await Promise.all(['background.js', 'monitor.js', 'content.js', 'popup.html'].map(file => readFile(join(extension, file))));
  await page.screenshot({ path: 'assets/screenshot.png', scale: 'css' });
  console.log('PASS: desktop launches with a fresh profile; connect waits for both accounts; Chrome extension files are included.');
} finally { if (desktop) await desktop.close(); await rm(data, { recursive: true, force: true }); }
